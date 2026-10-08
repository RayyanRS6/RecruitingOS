import { and, desc, eq, sql } from "drizzle-orm";
import { isCompanyVerified, type AutoActionLine, type AutoActionsOnOpen, type BoardChoice, type BoardChoiceView, type ClosingDateView, type PostingTaskKind, type PostingTaskView, type PublishingState, type RolePacket, type SharePlace, type ShareView } from "@ros/contracts";
import { BOARD_CHANNELS, BOARD_NAME, SHARE_PLACES, chosenBoards, closingDateRequired, closingDateView, isPostingTask, postingTaskLabel, publishChannelsFor, resolvePolicy, zipRecruiterOffered, type ApplicationLinkRow, type PostingRow, type PostingTaskRow } from "@ros/core";
import { approvalRequests, companies, workflowRuns, type Tx } from "@ros/db";

/**
 * What the role page and the screen right after approval show about publishing (plan Wave D, items D2, D6, D7, D8,
 * D9): where publishing stands, the board ticks, the closing date, the share block and what starts on its own once the
 * job is live. Data only; the routes in routes/roles.ts and routes/postings.ts serve it.
 */
type RoleRow = { id: string; companyId: string; status: string; acceptingApplications: boolean; applicationsClosedReason: string | null; applicationsCloseOn: string | null; publishChannels: string[] | null; currentPacketVersion: number | null };
type CompanyRow = { name: string; settings: typeof companies.$inferSelect.settings; timezone: string };

/** Where the team changes the rules these lines come from. */
export const AI_RULES_HREF = "/setup#setup-rules";

/** The confirmation email is the same for every company (routes/policies.ts lists it as fixed), so it is not looked up. */
const CONFIRMATION_LINE: AutoActionLine = { actionType: "message.send_templated", level: "auto", text: "Every applicant gets an email confirming their application, sent on its own in the approved wording." };

/**
 * One plain line per action that can start on its own once the job is live (D9): the confirmation email every
 * applicant gets (the same for every company, routes/policies.ts lists it as fixed), and the invitation to a short
 * screening conversation, from the company's rules for this role. The invitation follows the assistant's reading of
 * each application (application-intake.ts), and the line says so: the AI's part is never hidden (docs/01).
 */
export async function autoActionsOnOpen(tx: Tx, companyId: string, roleId: string): Promise<AutoActionsOnOpen> {
  const invite = await resolvePolicy(tx, companyId, roleId, "application.invite_screen");
  const reading = "When the assistant's reading of an application suggests a good fit,";
  const inviteText: Record<string, string> = {
    auto: `${reading} the applicant is invited to a short screening conversation on their own. A person still makes every decision.`,
    auto_notify: `${reading} the applicant is invited to a short screening conversation on their own, and you are told each time.`,
    approval: `${reading} the invitation to a short screening conversation waits for your approval.`,
    human_only: "Only a person invites applicants to the screening conversation.",
  };
  const lines: AutoActionLine[] = [
    CONFIRMATION_LINE,
    { actionType: "application.invite_screen", level: invite.level, text: inviteText[invite.level] },
  ];
  return { lines, changeHref: AI_RULES_HREF };
}

/** The board ticks (Q11): what is chosen, what is offered, and why ZipRecruiter is not when the company has no plan of its own. */
export function boardChoices(role: Pick<RoleRow, "publishChannels">, packet: Pick<RolePacket, "sourcing"> | null, settings: unknown): BoardChoiceView[] {
  const chosen: readonly string[] = packet ? chosenBoards(role, packet, settings) : (role.publishChannels ?? []);
  const named: readonly string[] = packet?.sourcing.channels ?? [];
  return BOARD_CHANNELS.map((b) => {
    const available = b !== "ziprecruiter" || zipRecruiterOffered(settings);
    return { channel: b as BoardChoice, name: BOARD_NAME[b], chosen: available && chosen.includes(b), available, reason: available ? null : "ZipRecruiter needs your company's own paid ZipRecruiter plan. Say you have one in Setup to offer it.", inRolePlan: named.includes(b) };
  });
}

/** The role's closing date as every page reads it (Q12). */
export function closingDateFor(role: RoleRow, company: Pick<CompanyRow, "timezone"> | null, packet: Pick<RolePacket, "identity"> | null, now: Date): ClosingDateView {
  const requiredByLaw = !!packet && closingDateRequired({ jobLocations: packet.identity.locations, remotePolicy: packet.identity.remotePolicy });
  return closingDateView({ role, timeZone: company?.timezone, requiredByLaw, now });
}

/**
 * Where publishing stands (D2), for a screen that polls: not open yet (or waiting for approval to take effect), waiting
 * for the ITS company check, preparing the channels, or ready (with address checks still running).
 */
export async function publishingState(tx: Tx, input: { role: RoleRow; company: CompanyRow | null; packet: RolePacket | null; posts: PostingRow[] }): Promise<PublishingState> {
  const { role, company, packet, posts } = input;
  if (!["open", "paused"].includes(role.status)) {
    // Right after "Approve" the role is still pending until the approval workflow opens it.
    const [approved] = role.status === "pending_approval" ? await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "approved"))).orderBy(desc(approvalRequests.decidedAt)).limit(1) : [];
    if (approved) return { state: "preparing", pollAfterSeconds: 2, message: "Approved. Opening the role now.", checksPending: 0 };
    return { state: "not_open", pollAfterSeconds: null, message: role.status === "closed" ? "This role is closed." : "Nothing is public until the role is approved.", checksPending: 0 };
  }
  if (!company || !isCompanyVerified(company.settings)) return { state: "waiting_for_company_check", pollAfterSeconds: 60, message: "Your company is waiting for its one-time check by ITS. The job goes out on its channels right after that.", checksPending: 0 };
  const checksPending = posts.filter((p) => p.status === "posted_manually").length;
  // A paused role prepares nothing (a board ticked meanwhile is prepared when it resumes), so there is nothing to wait for.
  if (role.status === "paused") return { state: "ready", pollAfterSeconds: checksPending ? 10 : null, message: "The role is paused, so nothing new goes out. A board ticked meanwhile is prepared when you resume the role.", checksPending };
  const chosen = packet ? publishChannelsFor(role, packet, company.settings) : [];
  const missing = chosen.filter((c) => !posts.some((p) => p.channel === c));
  const [running] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, role.companyId), eq(workflowRuns.workflowKey, "publish_role"), eq(workflowRuns.status, "running"), sql`${workflowRuns.subject}->>'id' = ${role.id}`)).limit(1);
  if (missing.length || running) return { state: "preparing", pollAfterSeconds: 2, message: "Getting the job ready on its channels. This takes a moment.", checksPending: 0 };
  return { state: "ready", pollAfterSeconds: checksPending ? 10 : null, message: "Everything is prepared. Each channel shows where it stands; nothing is called live until its address has been checked.", checksPending };
}

/** The latest posting task of each posting, with the name of the recruiter who has it (a name only). */
export function postingTaskViews(rows: PostingTaskRow[], channelOf: (postingId: string) => string | null): Map<string, PostingTaskView> {
  const latest = new Map<string, PostingTaskRow>();
  for (const r of rows) if (r.postingId && !latest.has(r.postingId) && isPostingTask(r.kind)) latest.set(r.postingId, r);
  const out = new Map<string, PostingTaskView>();
  for (const [postingId, r] of latest) {
    const channel = channelOf(postingId);
    const board = channel && channel in BOARD_NAME ? BOARD_NAME[channel as keyof typeof BOARD_NAME] : "the board";
    out.set(postingId, { id: r.id, kind: r.kind as PostingTaskKind, status: r.status, label: postingTaskLabel(r.kind as PostingTaskKind, board), recruiterName: r.recruiterName, createdAt: r.createdAt, resolvedAt: r.resolvedAt, notDone: r.notDone, note: r.note });
  }
  return out;
}

/** "Bookkeeper in Irvine, CA". */
function jobWords(packet: Pick<RolePacket, "identity">): string {
  const l = packet.identity.locations[0];
  const place = l ? [l.city, l.region].filter(Boolean).join(", ") : "";
  return `${packet.identity.title}${packet.identity.remotePolicy === "remote" ? " (remote)" : place ? ` in ${place}` : ""}`;
}

/**
 * The text a share starts with (D8): the role plan's referral prompt when it has one, else a plain line in our own
 * words. Either way the person sees it in their own app before it is sent, and can change it there.
 */
export function shareText(packet: Pick<RolePacket, "identity" | "sourcing">, companyName: string, url: string): string {
  const prompt = packet.sourcing.referralPrompt?.trim();
  if (prompt) return `${prompt} ${url}`;
  return `${companyName} is hiring: ${jobWords(packet)}. Know someone who would be great at it? Here is the job: ${url}`;
}

/** The link a share place already has: the active one it created, reused so a second tap counts into the same row. */
export function sharePlaceLink(links: readonly ApplicationLinkRow[], place: SharePlace): ApplicationLinkRow | null {
  const p = SHARE_PLACES[place];
  return links.find((l) => !l.disabledAt && !l.postingId && l.source === p.source && l.label === p.label) ?? null;
}

/** The share block (D8): the job's address, the starting text and each ready-made place with its link once it has one. */
export function shareView(input: { packet: Pick<RolePacket, "identity" | "sourcing"> | null; companyName: string; jobUrl: string; links: readonly ApplicationLinkRow[]; linkUrl: (l: ApplicationLinkRow) => string }): ShareView {
  const places = (Object.keys(SHARE_PLACES) as SharePlace[]).map((place) => {
    const link = sharePlaceLink(input.links, place);
    return { place, label: SHARE_PLACES[place].label, link: link ? { id: link.id, url: input.linkUrl(link), visits: link.visits } : null };
  });
  return { jobUrl: input.jobUrl, text: input.packet ? shareText(input.packet, input.companyName, input.jobUrl) : input.jobUrl, places };
}
