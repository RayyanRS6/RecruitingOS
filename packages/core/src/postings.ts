import { and, desc, eq, inArray } from "drizzle-orm";
import { formatPayRange, type Actor, type Location, type PostingTaskKind, type RolePacket } from "@ros/contracts";
import { companies, postings, recruiterEscalations, roles, type Queryable } from "@ros/db";
import { jobNoticesFor, payShown, type NoticeOverrides } from "./compliance";
import { emit } from "./events";
import { notify } from "./notifications";
import { POSTING_TASK_KINDS, boardPostingOf, cancelPostingTasks, notDoneTaskIds, openPostingTask, resolvePostingTasks } from "./posting-tasks";

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

/**
 * Every allowed move. Anything not listed is refused; `closed` is terminal (the publish workflow re-prepares a re-opened
 * role's rows). A live listing that moved to a new address goes back to `posted_manually`: the new address is not live
 * until it is checked.
 */
export const POSTING_TRANSITIONS: Record<PostingState, readonly PostingState[]> = {
  draft: ["approved", "closed"],
  approved: ["ready_to_post", "submitted_integration", "closed"],
  ready_to_post: ["posted_manually", "submitted_integration", "paused", "failed", "closed"],
  posted_manually: ["live_verified", "failed", "paused", "closed"],
  submitted_integration: ["live_verified", "failed", "paused", "closed"],
  live_verified: ["posted_manually", "paused", "closed", "failed"],
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
export type PostingPatch = Partial<Pick<typeof postings.$inferInsert, "externalUrl" | "externalId" | "instructions" | "steps" | "error" | "publishedAt" | "publicUrlRecordedAt" | "verifiedAt" | "verifiedBy" | "verificationNote" | "verificationError" | "verificationAttempts" | "closureRequired" | "closureConfirmedAt" | "closureConfirmedBy" | "boardVersion">>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Which channels a role uses (founder decision Q11, plan D6).                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** Every open role has these, whatever was ticked: its job page is the careers page and the Google listing. */
export const ALWAYS_CHANNELS: readonly PostingChannel[] = ["careers_page", "google_jobs", "email_in"];

/** ZipRecruiter needs the company's own paid plan, so it is offered only when the company says it has one. */
export function zipRecruiterOffered(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as { zipRecruiterPlan?: unknown }).zipRecruiterPlan === true;
}

/** The boards the role plan names (`packet.sourcing.channels`), ZipRecruiter only for a company with its own plan. */
export function defaultBoards(packet: Pick<RolePacket, "sourcing">, settings: unknown): BoardChannel[] {
  const named = packet.sourcing.channels as readonly string[];
  return BOARD_CHANNELS.filter((b) => named.includes(b) && (b !== "ziprecruiter" || zipRecruiterOffered(settings)));
}

/** The boards a role uses: what a person ticked, else the role plan's; never ZipRecruiter without the company's plan. */
export function chosenBoards(role: { publishChannels: string[] | null }, packet: Pick<RolePacket, "sourcing">, settings: unknown): BoardChannel[] {
  if (!role.publishChannels) return defaultBoards(packet, settings);
  return BOARD_CHANNELS.filter((b) => role.publishChannels!.includes(b) && (b !== "ziprecruiter" || zipRecruiterOffered(settings)));
}

/** Every channel the publish workflow prepares for the role, in the order the Posting tab lists them. */
export function publishChannelsFor(role: { publishChannels: string[] | null }, packet: Pick<RolePacket, "sourcing">, settings: unknown): PostingChannel[] {
  const boards: readonly string[] = chosenBoards(role, packet, settings);
  return POSTING_CHANNELS.filter((c) => ALWAYS_CHANNELS.includes(c) || boards.includes(c));
}

/**
 * Moves a posting and records the fact. Sets the timestamp columns that belong to the target state (paused_at,
 * closed_at, verified_at with verified_by defaulting to the actor) and applies `patch` on top. Must run inside the
 * caller's tenant transaction.
 *
 * A board's ITS posting tasks follow its moves (plan D3, packages/core/src/posting-tasks.ts): a listing checked live
 * settles its "post" task, a closed listing withdraws the post and update tasks, and a listing closed while still up
 * gets a "take it down" task when ITS posts for the company. A board posted for the first time records the packet
 * version it shows (`board_version`), so an approved edit can say which boards still show the old one.
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
  if (input.to === "posted_manually" && isBoardChannel(row.channel) && input.patch?.boardVersion === undefined && (from === "ready_to_post" || row.boardVersion === null)) {
    const [role] = await q.select({ version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, row.roleId)).limit(1);
    patch.boardVersion = role?.version ?? null;
  }
  const [updated] = await q.update(postings).set(patch).where(eq(postings.id, row.id)).returning();
  await emit(q, {
    type: `posting.${input.to}`,
    companyId: row.companyId,
    actor: input.actor,
    subject: { type: "posting", id: row.id },
    payload: { channel: row.channel, roleId: row.roleId, from, to: input.to, url: updated.externalUrl ?? null, reason: input.reason ?? null, ...(input.payload ?? {}) },
    correlationId: input.correlationId ?? null,
  });
  if (isBoardChannel(row.channel)) await settleBoardTasks(q, updated, input.to, input.actor, input.now ?? new Date());
  return { row: updated, from, to: input.to };
}

/** The ITS posting tasks a board's move settles, withdraws or opens (see `transitionPosting`). */
async function settleBoardTasks(q: Queryable, posting: PostingRow, to: PostingState, actor: Actor, now: Date): Promise<void> {
  const board = BOARD_NAME[posting.channel as BoardChannel];
  if (to === "live_verified") {
    await resolvePostingTasks(q, { companyId: posting.companyId, postingId: posting.id, kinds: ["post_job"], resolution: `${board} listing is live and was checked: ${posting.externalUrl ?? "address recorded"}.`, actor, now });
    return;
  }
  if (to !== "closed") return;
  await cancelPostingTasks(q, { companyId: posting.companyId, postingId: posting.id, kinds: ["post_job", "update_job"], reason: `The ${board} listing was closed before this was done.`, actor, now });
  if (!posting.closureRequired || posting.closureConfirmedAt) return;
  const [company] = await q.select({ name: companies.name, vertical: companies.vertical, settings: companies.settings }).from(companies).where(eq(companies.id, posting.companyId)).limit(1);
  if (!company || boardPostingOf(company.settings) !== "its") return;
  const [role] = await q.select({ title: roles.title }).from(roles).where(eq(roles.id, posting.roleId)).limit(1);
  await openPostingTask(q, { companyId: posting.companyId, roleId: posting.roleId, postingId: posting.id, channel: posting.channel, board, kind: "take_down_job", roleTitle: role?.title ?? "the role", companyName: company.name, vertical: company.vertical, actor, now });
}

/**
 * "Taken down from the board": a person (the team, or the ITS recruiter from the queue) confirms a listing that was up
 * when it closed is gone. Ticking it twice changes nothing; the take-down task settles with it.
 */
export async function confirmBoardRemoved(q: Queryable, input: { posting: PostingRow; actor: Actor; now?: Date }): Promise<PostingRow> {
  const p = input.posting;
  if (p.closureConfirmedAt) return p;
  const now = input.now ?? new Date();
  const [row] = await q.update(postings).set({ closureConfirmedAt: now.toISOString(), closureConfirmedBy: input.actor }).where(eq(postings.id, p.id)).returning();
  await emit(q, { type: "posting.closure_confirmed", companyId: p.companyId, actor: input.actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: p.roleId, url: p.externalUrl } });
  if (isBoardChannel(p.channel)) await resolvePostingTasks(q, { companyId: p.companyId, postingId: p.id, kinds: ["take_down_job"], resolution: `${BOARD_NAME[p.channel]} listing was taken down${input.actor.name ? `, confirmed by ${input.actor.name}` : ""}.`, actor: input.actor, now });
  return row;
}

/** Whether a board that is up still shows an older packet version than the role runs on (plan D2, D4). */
export function showsOldVersion(posting: Pick<PostingRow, "channel" | "status" | "boardVersion">, currentVersion: number | null): boolean {
  return isBoardChannel(posting.channel) && BOARD_UP_STATES.includes(posting.status as PostingState) && posting.boardVersion !== null && currentVersion !== null && posting.boardVersion < currentVersion;
}

type TaskPosting = Pick<PostingRow, "channel" | "status" | "externalUrl" | "boardVersion" | "closureRequired" | "closureConfirmedAt">;

/**
 * Whether the work an ITS posting task asks for shows on the posting itself (plan D3): the listing's address recorded,
 * the listing showing the current version, the listing confirmed taken down. Whoever did it, ITS or the team.
 */
export function postingTaskWorkDone(kind: string, posting: TaskPosting, currentVersion: number | null): boolean {
  if (kind === "post_job") return posting.status === "closed" || (["posted_manually", "live_verified", "paused"].includes(posting.status) && !!posting.externalUrl);
  if (kind === "update_job") return !showsOldVersion(posting, currentVersion);
  return !posting.closureRequired || !!posting.closureConfirmedAt;
}

/** The posting task a board needs now, if any: post it (an open role), bring it up to date, or take it down. */
export function postingTaskNeeded(posting: TaskPosting, role: { status: string; currentPacketVersion: number | null }): PostingTaskKind | null {
  if (!isBoardChannel(posting.channel)) return null;
  if (posting.status === "closed") return posting.closureRequired && !posting.closureConfirmedAt ? "take_down_job" : null;
  if (posting.status === "ready_to_post" && role.status === "open") return "post_job";
  if ((role.status === "open" || role.status === "paused") && showsOldVersion(posting, role.currentPacketVersion)) return "update_job";
  return null;
}

/**
 * Opens the posting tasks a company whose boards ITS posts is missing (plan D3): a board waiting to be posted, still
 * showing an earlier version, or still up after it closed, whose latest task of that kind is missing or was withdrawn.
 * Run when the code that opens these tasks first ships (boards prepared before had none) and when a company hands its
 * boards to ITS. A task the recruiter closed as not possible is not opened again here: the team was told, and can ask
 * again from the Posting tab. Must run inside the company's tenant transaction. Returns the tasks it opened.
 */
export async function openMissingPostingTasks(q: Queryable, input: { companyId: string; actor: Actor; now?: Date }): Promise<Array<{ roleId: string; roleTitle: string; board: string; kind: PostingTaskKind }>> {
  const [company] = await q.select({ name: companies.name, vertical: companies.vertical, settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company || boardPostingOf(company.settings) !== "its") return [];
  const boards = await q.select().from(postings).where(and(eq(postings.companyId, input.companyId), inArray(postings.channel, [...BOARD_CHANNELS])));
  if (!boards.length) return [];
  const roleRows = await q.select({ id: roles.id, title: roles.title, status: roles.status, currentPacketVersion: roles.currentPacketVersion }).from(roles).where(inArray(roles.id, [...new Set(boards.map((p) => p.roleId))]));
  const tasks = await q.select({ postingId: recruiterEscalations.postingId, kind: recruiterEscalations.kind, status: recruiterEscalations.status }).from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, input.companyId), inArray(recruiterEscalations.kind, [...POSTING_TASK_KINDS]))).orderBy(desc(recruiterEscalations.createdAt));
  const opened: Array<{ roleId: string; roleTitle: string; board: string; kind: PostingTaskKind }> = [];
  for (const p of boards) {
    const role = roleRows.find((r) => r.id === p.roleId);
    const kind = role ? postingTaskNeeded(p, role) : null;
    if (!role || !kind) continue;
    const latest = tasks.find((t) => t.postingId === p.id && t.kind === kind);
    if (latest && latest.status !== "cancelled") continue;
    const board = BOARD_NAME[p.channel as BoardChannel];
    const task = await openPostingTask(q, { companyId: input.companyId, roleId: role.id, postingId: p.id, channel: p.channel, board, kind, roleTitle: role.title, companyName: company.name, vertical: company.vertical, actor: input.actor, now: input.now });
    if (task.created) opened.push({ roleId: role.id, roleTitle: role.title, board, kind });
  }
  return opened;
}

/** Withdraws every waiting posting task of a company: it now posts on the boards itself, so the work is the team's. */
export async function withdrawPostingTasks(q: Queryable, input: { companyId: string; reason: string; actor: Actor; now?: Date }): Promise<number> {
  const waiting = await q.select({ postingId: recruiterEscalations.postingId }).from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, input.companyId), inArray(recruiterEscalations.kind, [...POSTING_TASK_KINDS]), inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"])));
  let n = 0;
  for (const postingId of new Set(waiting.map((w) => w.postingId).filter((x): x is string => !!x))) n += await cancelPostingTasks(q, { companyId: input.companyId, postingId, kinds: POSTING_TASK_KINDS, reason: input.reason, actor: input.actor, now: input.now });
  return n;
}

/**
 * The boards whose latest ITS posting task the recruiter closed as not possible, while the work still waits (plan D3):
 * the team is told, with the recruiter's words, and can ask again or do it from its own account. One query per kind of
 * row, for the whole company or one role.
 */
export async function unfinishedPostingTasks(q: Queryable, input: { companyId: string; roleId?: string }): Promise<Array<{ taskId: string; roleId: string; postingId: string; channel: string; kind: PostingTaskKind; note: string | null }>> {
  const rows = await q.select({ id: recruiterEscalations.id, postingId: recruiterEscalations.postingId, roleId: recruiterEscalations.roleId, kind: recruiterEscalations.kind, status: recruiterEscalations.status, resolution: recruiterEscalations.resolution }).from(recruiterEscalations)
    .where(and(eq(recruiterEscalations.companyId, input.companyId), inArray(recruiterEscalations.kind, [...POSTING_TASK_KINDS]), ...(input.roleId ? [eq(recruiterEscalations.roleId, input.roleId)] : [])))
    .orderBy(desc(recruiterEscalations.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.postingId && !latest.has(r.postingId)) latest.set(r.postingId, r);
  const resolved = [...latest.values()].filter((r) => r.status === "resolved");
  if (!resolved.length) return [];
  const notDone = await notDoneTaskIds(q, resolved.map((r) => r.id));
  const candidates = resolved.filter((r) => notDone.has(r.id));
  if (!candidates.length) return [];
  const posts = await q.select().from(postings).where(inArray(postings.id, candidates.map((r) => r.postingId!)));
  const roleRows = await q.select({ id: roles.id, currentPacketVersion: roles.currentPacketVersion }).from(roles).where(inArray(roles.id, [...new Set(posts.map((p) => p.roleId))]));
  const out: Array<{ taskId: string; roleId: string; postingId: string; channel: string; kind: PostingTaskKind; note: string | null }> = [];
  for (const r of candidates) {
    const p = posts.find((x) => x.id === r.postingId);
    if (!p || postingTaskWorkDone(r.kind, p, roleRows.find((x) => x.id === p.roleId)?.currentPacketVersion ?? null)) continue;
    out.push({ taskId: r.id, roleId: p.roleId, postingId: p.id, channel: p.channel, kind: r.kind as PostingTaskKind, note: r.resolution });
  }
  return out;
}

/**
 * "The board shows the new version now": the listing's version moves to the role's current one, the update task
 * settles, and the caller queues a fresh check of the address (the title may have changed).
 */
export async function confirmBoardUpdated(q: Queryable, input: { posting: PostingRow; version: number; actor: Actor; note?: string | null; now?: Date }): Promise<PostingRow> {
  const p = input.posting;
  const now = input.now ?? new Date();
  const [row] = await q.update(postings).set({ boardVersion: input.version }).where(eq(postings.id, p.id)).returning();
  await emit(q, { type: "posting.updated", companyId: p.companyId, actor: input.actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: p.roleId, version: input.version, from: p.boardVersion, note: input.note ?? null } });
  if (isBoardChannel(p.channel)) await resolvePostingTasks(q, { companyId: p.companyId, postingId: p.id, kinds: ["update_job"], resolution: `${BOARD_NAME[p.channel]} listing now shows version ${input.version}${input.note ? ` (${input.note})` : ""}.`, actor: input.actor, now });
  return row;
}

/**
 * After an edit to a running role is approved (plan D4): every board listing that is up still shows the earlier
 * version. Each is recorded as needing an update (`posting.update_required`); when ITS posts for the company it gets an
 * "update the job" task per board, otherwise the team is told which boards to update from its own accounts. The careers
 * page and Google show the job page itself, so they are always current. Returns the boards still showing the old one.
 */
export async function markBoardsOutdated(q: Queryable, input: { companyId: string; roleId: string; previousVersion: number | null; newVersion: number; actor: Actor; now?: Date }): Promise<BoardChannel[]> {
  const now = input.now ?? new Date();
  const posts = await q.select().from(postings).where(eq(postings.roleId, input.roleId));
  const stale: PostingRow[] = [];
  for (const p of posts) {
    if (!isBoardChannel(p.channel) || !BOARD_UP_STATES.includes(p.status as PostingState)) continue;
    // A listing posted before versions were recorded showed the version this edit replaces.
    const shown = p.boardVersion ?? input.previousVersion;
    if (p.boardVersion === null && shown !== null) await q.update(postings).set({ boardVersion: shown }).where(eq(postings.id, p.id));
    if (shown === null || shown >= input.newVersion) continue;
    stale.push(p);
    await emit(q, { type: "posting.update_required", companyId: input.companyId, actor: input.actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: input.roleId, shows: shown, current: input.newVersion } });
  }
  if (!stale.length) return [];
  const [company] = await q.select({ name: companies.name, vertical: companies.vertical, settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const [role] = await q.select({ title: roles.title }).from(roles).where(eq(roles.id, input.roleId)).limit(1);
  const boards = stale.map((p) => BOARD_NAME[p.channel as BoardChannel]);
  if (company && boardPostingOf(company.settings) === "its") {
    for (const p of stale) await openPostingTask(q, { companyId: input.companyId, roleId: input.roleId, postingId: p.id, channel: p.channel, board: BOARD_NAME[p.channel as BoardChannel], kind: "update_job", roleTitle: role?.title ?? "the role", companyName: company.name, vertical: company.vertical, actor: input.actor, now });
  } else {
    await notify(q, {
      companyId: input.companyId,
      kind: "stuck.boards_outdated",
      title: `${role?.title ?? "A role"}: ${boards.join(", ")} still ${boards.length === 1 ? "shows" : "show"} the earlier version`,
      body: `Version ${input.newVersion} is live on your careers page. Update the listing on ${boards.join(" and ")} from your own account with the new posting package, then confirm it on the Share tab.`,
      action: { label: "Open the Share tab", href: `/roles/${input.roleId}?tab=posting` },
      roles: ["owner", "admin"],
    });
  }
  return stale.map((p) => p.channel as BoardChannel);
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
  /** The company's locations and notice wording, so the pay line follows the same rule as the job page; optional. */
  companyLocations?: Location[];
  noticeOverrides?: NoticeOverrides;
};

export type PostingPackage = { text: string; fields: Record<string, string> };

export function locationLine(packet: RolePacket): string {
  const places = packet.identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean);
  const where = places.length ? [...new Set(places)].join("; ") : "Location on request";
  const remote = packet.identity.remotePolicy === "remote" ? " (remote)" : packet.identity.remotePolicy === "hybrid" ? " (hybrid)" : "";
  return `${where}${remote}`;
}

/** The pay as a board posting states it: shown exactly when the job page shows it (`payShown`), so no board omits a range the law requires. */
export function payLine(packet: RolePacket, company: { locations?: Location[]; noticeOverrides?: NoticeOverrides } = {}): string {
  const c = packet.compensation;
  if (!payShown(c, jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.noticeOverrides }))) return "Not disclosed publicly";
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
    pay: payLine(p, { locations: input.companyLocations, noticeOverrides: input.noticeOverrides }),
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
