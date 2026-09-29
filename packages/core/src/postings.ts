import { eq } from "drizzle-orm";
import { formatPayRange, type Actor, type RolePacket } from "@ros/contracts";
import { postings, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * The posting state machine (docs/spec/20 items 11 and 12). A posting is one role on one channel. It is never called
 * live until its public URL was fetched and matched, or a person recorded that they checked it themselves. Every
 * change of state goes through `transitionPosting`, which refuses anything the table below does not list and records
 * the fact as a `posting.<state>` event. The publish workflow is the one origin of rows: it may insert a row at the
 * state a channel's adapter reports and may bring a closed row of a re-opened role back to ready_to_post.
 */
export const POSTING_STATES = ["draft", "approved", "ready_to_post", "posted_manually", "submitted_integration", "live_verified", "paused", "failed", "closed"] as const;
export type PostingState = (typeof POSTING_STATES)[number];

export const POSTING_STATE_LABEL: Record<PostingState, string> = {
  draft: "Draft",
  approved: "Approved",
  ready_to_post: "Ready to post",
  posted_manually: "Posted",
  submitted_integration: "Submitted",
  live_verified: "Live and verified",
  paused: "Paused",
  failed: "Failed",
  closed: "Closed",
};

export const POSTING_CHANNELS = ["careers_page", "google_jobs", "email_in", "linkedin_basic", "indeed", "ziprecruiter"] as const;
export type PostingChannel = (typeof POSTING_CHANNELS)[number];
/** The manual boards: ITS posts by hand under the customer's own account, each with its own tracked link. */
export const BOARD_CHANNELS = ["linkedin_basic", "indeed", "ziprecruiter"] as const;
export type BoardChannel = (typeof BOARD_CHANNELS)[number];
export const BOARD_NAME: Record<BoardChannel, string> = { linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };
export const CHANNEL_NAME: Record<PostingChannel, string> = { careers_page: "Careers page", google_jobs: "Google for Jobs", email_in: "Applications by email", ...BOARD_NAME };

export function isBoardChannel(channel: string): channel is BoardChannel {
  return (BOARD_CHANNELS as readonly string[]).includes(channel);
}

export function isPostingState(value: string): value is PostingState {
  return (POSTING_STATES as readonly string[]).includes(value);
}

/** Every allowed move. Anything not listed is refused; `closed` is terminal (the publish workflow re-prepares a re-opened role's rows). */
export const POSTING_TRANSITIONS: Record<PostingState, readonly PostingState[]> = {
  draft: ["approved", "closed"],
  approved: ["ready_to_post", "submitted_integration", "closed"],
  ready_to_post: ["posted_manually", "submitted_integration", "paused", "failed", "closed"],
  posted_manually: ["live_verified", "failed", "paused", "closed"],
  submitted_integration: ["live_verified", "failed", "paused", "closed"],
  live_verified: ["paused", "closed", "failed"],
  paused: ["ready_to_post", "posted_manually", "live_verified", "closed"],
  failed: ["ready_to_post", "posted_manually", "submitted_integration", "closed"],
  closed: [],
};

/** The states in which a board is up on the outside (or was, and is only paused): closing the role names these for manual removal. */
export const BOARD_UP_STATES: readonly PostingState[] = ["posted_manually", "live_verified", "paused"];

/** The worker job that fetches a posting's public URL (payload `{ postingId, companyId }`; registered in the API container). */
export const POSTING_VERIFY_JOB_KIND = "posting.verify";
/** How many fetches a posting gets before it is marked failed; the job retries with the queue's backoff in between. */
export const POSTING_VERIFY_MAX_ATTEMPTS = 3;

export function canTransitionPosting(from: string, to: string): boolean {
  if (!isPostingState(from) || !isPostingState(to)) return false;
  return POSTING_TRANSITIONS[from].includes(to);
}

export class PostingTransitionError extends Error {
  readonly code = "posting_transition";
  constructor(public readonly from: string, public readonly to: string) {
    super(`A posting cannot move from "${labelOf(from)}" to "${labelOf(to)}".`);
  }
}

export class PostingNotFoundError extends Error {
  readonly code = "not_found";
  constructor(public readonly postingId: string) {
    super("Posting not found.");
  }
}

function labelOf(state: string): string {
  return isPostingState(state) ? POSTING_STATE_LABEL[state] : state;
}

export function assertPostingTransition(from: string, to: string): void {
  if (!canTransitionPosting(from, to)) throw new PostingTransitionError(from, to);
}

export type PostingRow = typeof postings.$inferSelect;
export type PostingPatch = Partial<Pick<typeof postings.$inferInsert, "externalUrl" | "externalId" | "instructions" | "steps" | "error" | "publishedAt" | "publicUrlRecordedAt" | "verifiedAt" | "verifiedBy" | "verificationNote" | "verificationError" | "verificationAttempts" | "closureRequired" | "closureConfirmedAt" | "closureConfirmedBy">>;

/**
 * Moves a posting and records the fact. Sets the timestamp columns that belong to the target state (paused_at,
 * closed_at, verified_at with verified_by defaulting to the actor) and applies `patch` on top. Must run inside the
 * caller's tenant transaction.
 */
export async function transitionPosting(
  q: Queryable,
  input: { postingId: string; to: PostingState; actor: Actor; now?: Date; patch?: PostingPatch; reason?: string | null; payload?: Record<string, unknown>; correlationId?: string | null },
): Promise<{ row: PostingRow; from: PostingState; to: PostingState }> {
  const [row] = await q.select().from(postings).where(eq(postings.id, input.postingId)).limit(1);
  if (!row) throw new PostingNotFoundError(input.postingId);
  const from = row.status as PostingState;
  assertPostingTransition(from, input.to);
  const now = (input.now ?? new Date()).toISOString();
  const patch: Partial<typeof postings.$inferInsert> = { status: input.to, ...(input.patch ?? {}) };
  if (input.to === "paused") patch.pausedAt = now;
  if (from === "paused" && input.to !== "paused") patch.pausedAt = null;
  if (input.to === "closed") patch.closedAt = now;
  if (input.to === "live_verified") {
    patch.verifiedAt = input.patch?.verifiedAt ?? now;
    patch.verifiedBy = input.patch?.verifiedBy ?? input.actor;
    patch.verificationError = input.patch?.verificationError ?? null;
    patch.publishedAt = input.patch?.publishedAt ?? row.publishedAt ?? now;
  }
  if (input.to === "posted_manually" && !input.patch?.publicUrlRecordedAt && !row.publicUrlRecordedAt) patch.publicUrlRecordedAt = now;
  const [updated] = await q.update(postings).set(patch).where(eq(postings.id, row.id)).returning();
  await emit(q, {
    type: `posting.${input.to}`,
    companyId: row.companyId,
    actor: input.actor,
    subject: { type: "posting", id: row.id },
    payload: { channel: row.channel, roleId: row.roleId, from, to: input.to, url: updated.externalUrl ?? null, reason: input.reason ?? null, ...(input.payload ?? {}) },
    correlationId: input.correlationId ?? null,
  });
  return { row: updated, from, to: input.to };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The posting package (docs/spec/20 item 9): everything a person needs to post the job on a board by hand.      */
/* ------------------------------------------------------------------------------------------------------------ */

export const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  temporary: "Temporary",
  per_diem: "Per diem",
  internship: "Internship",
};

export type PostingPackageInput = {
  packet: RolePacket;
  /** The client company: always named as the hiring employer (item 20). */
  companyName: string;
  jobUrl: string;
  /** The board's own tracked apply link, or the plain apply page when there is no board. */
  applyUrl: string;
  intakeAddress?: string | null;
  /** The board this package is for, for the heading; optional. */
  boardName?: string | null;
};

export type PostingPackage = { text: string; fields: Record<string, string> };

export function locationLine(packet: RolePacket): string {
  const places = packet.identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean);
  const where = places.length ? [...new Set(places)].join("; ") : "Location on request";
  const remote = packet.identity.remotePolicy === "remote" ? " (remote)" : packet.identity.remotePolicy === "hybrid" ? " (hybrid)" : "";
  return `${where}${remote}`;
}

export function payLine(packet: RolePacket): string {
  const c = packet.compensation;
  if (!c.discloseRange) return "Not disclosed publicly";
  return `${formatPayRange(c)} (${c.basis === "hourly" ? "hourly" : "salary"}, ${c.currency})`;
}

/** Assembles the package as fields and as one copyable text block. Pure: the caller supplies the URLs. */
export function postingPackage(input: PostingPackageInput): PostingPackage {
  const p = input.packet;
  const questions = p.screening.questions.map((q, i) => `${i + 1}. ${q.question}`);
  const fields: Record<string, string> = {
    title: p.identity.title,
    employer: input.companyName,
    location: locationLine(p),
    employmentType: EMPLOYMENT_TYPE_LABEL[p.identity.employmentType] ?? p.identity.employmentType,
    pay: payLine(p),
    description: p.description.publicJobDescription,
    screeningQuestions: questions.join("\n"),
    applyUrl: input.applyUrl,
    intakeAddress: input.intakeAddress ?? "",
    jobUrl: input.jobUrl,
  };
  if (p.identity.schedule) fields.schedule = p.identity.schedule;
  const heading = input.boardName ? `Posting package for ${input.boardName}` : "Posting package";
  const lines = [
    heading,
    "",
    `Title: ${fields.title}`,
    `Employer: ${fields.employer}`,
    `Location: ${fields.location}`,
    `Employment type: ${fields.employmentType}`,
    ...(fields.schedule ? [`Schedule: ${fields.schedule}`] : []),
    `Pay: ${fields.pay}`,
    "",
    "Description:",
    fields.description,
    "",
    "Screening questions (asked by Recruiting OS after the application; add them to the board only if it insists on its own):",
    ...questions,
    "",
    `Apply link (use this as the application method): ${fields.applyUrl}`,
    ...(input.intakeAddress ? [`If the board asks where to send applications instead: ${input.intakeAddress}`] : []),
    `Job page: ${fields.jobUrl}`,
  ];
  return { text: lines.join("\n"), fields };
}
