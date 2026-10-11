import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, PostingTaskKind } from "@ros/contracts";
import { events, recruiterEscalations, type Queryable } from "@ros/db";
import { createEscalation, recordEscalationAnswer } from "./escalations";
import { emit } from "./events";

/**
 * ITS posting tasks (plan D3; founder decision: ITS posts on the boards, from the customer's own accounts). One task
 * per board and per job: post it, bring it up to date after an approved edit, or take it down. A task is a recruiter
 * request of its own kind in the ITS queue, with the posting it is about.
 *
 * Posting work needs the job ad and nothing about candidates, so a posting task never grants access to the customer's
 * records: claiming it opens the job ad, the board's own apply link and the posting's state, and the recruiter records
 * the public address, confirms an update or confirms a take-down from the queue (apps/api routes/approvals-escalations-
 * events.ts). That is safer than a reduced staff grant: nothing about applicants is in reach at all. Tasks settle on
 * their own when the work shows: a post task when the listing is checked live (or someone confirms it), an update when
 * the board is confirmed up to date, a take-down when someone ticks the board off. Whoever does it, ITS or the team.
 */
export const POSTING_TASK_KINDS: readonly PostingTaskKind[] = ["post_job", "update_job", "take_down_job"];

export function isPostingTask(kind: string): kind is PostingTaskKind {
  return (POSTING_TASK_KINDS as readonly string[]).includes(kind);
}

/** A request still waiting on someone. */
const OPEN = ["open", "claimed", "in_progress"];

/** Who posts on the boards for a company: ITS by default, the team itself once it chose to ("self"). */
export function boardPostingOf(settings: unknown): "its" | "self" {
  const v = settings && typeof settings === "object" ? (settings as { boardPosting?: unknown }).boardPosting : undefined;
  return v === "self" ? "self" : "its";
}

/** What a task asks, in a few words: "Post the job on LinkedIn". */
export function postingTaskLabel(kind: PostingTaskKind, board: string): string {
  if (kind === "post_job") return `Post the job on ${board}`;
  if (kind === "update_job") return `Update the job on ${board}`;
  return `Take the job down from ${board}`;
}

function question(kind: PostingTaskKind, input: { board: string; roleTitle: string; companyName: string }): string {
  const job = `"${input.roleTitle}" at ${input.companyName}`;
  if (kind === "post_job") return `Post ${job} on ${input.board} from ${input.companyName}'s own account, with the board's own apply link from the posting package, then record the public address here. The task closes once the address is checked.`;
  if (kind === "update_job") return `A new version of ${job} was approved. Update the ${input.board} listing from ${input.companyName}'s own account with the new posting package, then confirm it here.`;
  return `${job} no longer takes applications through ${input.board}. Take the listing down from ${input.companyName}'s own account, then confirm it here.`;
}

/**
 * Opens a task for a posting unless one of the same kind is already waiting. Must run inside the caller's tenant
 * transaction. The context names the job and the board only; the template summary adds the board's name.
 */
export async function openPostingTask(
  q: Queryable,
  input: { companyId: string; roleId: string; postingId: string; channel: string; board: string; kind: PostingTaskKind; roleTitle: string; companyName: string; vertical?: string | null; actor: Actor; now?: Date },
): Promise<{ id: string; created: boolean }> {
  const [existing] = await q.select({ id: recruiterEscalations.id }).from(recruiterEscalations).where(and(eq(recruiterEscalations.postingId, input.postingId), eq(recruiterEscalations.kind, input.kind), inArray(recruiterEscalations.status, OPEN))).limit(1);
  if (existing) return { id: existing.id, created: false };
  const created = await createEscalation(q, {
    companyId: input.companyId,
    roleId: input.roleId,
    kind: input.kind,
    question: question(input.kind, input),
    requestedBy: input.actor,
    now: input.now,
    postingId: input.postingId,
    summary: `${postingTaskLabel(input.kind, input.board)} from the customer's own account.`,
    // The industry goes with it (as with any request), so the right recruiter picks it up; nothing about candidates does.
    context: { capturedAt: (input.now ?? new Date()).toISOString(), company: { id: input.companyId, name: input.companyName, vertical: input.vertical ?? null }, postingTask: { kind: input.kind, postingId: input.postingId, channel: input.channel, board: input.board, roleId: input.roleId, roleTitle: input.roleTitle } },
  });
  return { id: created.id, created: true };
}

/** Closes the waiting tasks of these kinds for a posting as done, with what happened; the answer is kept on the thread. */
export async function resolvePostingTasks(q: Queryable, input: { companyId: string; postingId: string; kinds: readonly PostingTaskKind[]; resolution: string; actor: Actor; now?: Date }): Promise<number> {
  const now = input.now ?? new Date();
  const waiting = await q.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.postingId, input.postingId), inArray(recruiterEscalations.kind, [...input.kinds]), inArray(recruiterEscalations.status, OPEN)));
  for (const e of waiting) {
    await q.update(recruiterEscalations).set({ status: "resolved", resolvedAt: now.toISOString(), resolution: input.resolution, firstResponseAt: e.firstResponseAt ?? now.toISOString() }).where(eq(recruiterEscalations.id, e.id));
    await recordEscalationAnswer(q, { escalation: e, author: input.actor, body: input.resolution, now });
    await emit(q, { type: "recruiter.resolved", companyId: e.companyId, actor: input.actor, subject: { type: "escalation", id: e.id }, payload: { resolution: input.resolution, postingTask: e.kind, postingId: input.postingId } });
  }
  return waiting.length;
}

/** Withdraws the waiting tasks of these kinds for a posting: the work no longer applies (the listing was closed). */
export async function cancelPostingTasks(q: Queryable, input: { companyId: string; postingId: string; kinds: readonly PostingTaskKind[]; reason: string; actor: Actor; now?: Date }): Promise<number> {
  const now = input.now ?? new Date();
  const waiting = await q.select({ id: recruiterEscalations.id, kind: recruiterEscalations.kind }).from(recruiterEscalations).where(and(eq(recruiterEscalations.postingId, input.postingId), inArray(recruiterEscalations.kind, [...input.kinds]), inArray(recruiterEscalations.status, OPEN)));
  for (const e of waiting) {
    await q.update(recruiterEscalations).set({ status: "cancelled", resolvedAt: now.toISOString(), resolution: input.reason }).where(eq(recruiterEscalations.id, e.id));
    await emit(q, { type: "recruiter.resolved", companyId: input.companyId, actor: input.actor, subject: { type: "escalation", id: e.id }, payload: { cancelled: true, reason: input.reason, postingTask: e.kind, postingId: input.postingId } });
  }
  return waiting.length;
}

/**
 * The posting tasks among these that the recruiter closed as not possible ("Cannot do it?" in the queue): the fact is the
 * `recruiter.resolved` event's `notDone`, recorded when it was closed, so a board the team posted later still shows who
 * did what.
 */
export async function notDoneTaskIds(q: Queryable, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const rows = await q.select({ subjectId: events.subjectId, payload: events.payload }).from(events).where(and(eq(events.type, "recruiter.resolved"), eq(events.subjectType, "escalation"), inArray(events.subjectId, taskIds)));
  return new Set(rows.filter((e) => (e.payload as { notDone?: unknown }).notDone === true).map((e) => e.subjectId));
}

export type PostingTaskRow = { id: string; postingId: string | null; kind: string; status: string; assignedToUserId: string | null; createdAt: string; resolvedAt: string | null; recruiterName: string | null; notDone: boolean; note: string | null };

/**
 * Every posting task of a role, newest first (the Posting tab shows the latest per posting), with the name of the
 * recruiter who took it. Recruiters are not members, so the company cannot read their user rows; the name comes from the
 * company's own record of the claim (`recruiter.claimed`), read in the same transaction. A task the recruiter closed as
 * not possible says so (`notDone`), with their words (`note`).
 */
export async function postingTasksForRole(q: Queryable, roleId: string): Promise<PostingTaskRow[]> {
  const rows = await q
    .select({ id: recruiterEscalations.id, postingId: recruiterEscalations.postingId, kind: recruiterEscalations.kind, status: recruiterEscalations.status, assignedToUserId: recruiterEscalations.assignedToUserId, createdAt: recruiterEscalations.createdAt, resolvedAt: recruiterEscalations.resolvedAt, resolution: recruiterEscalations.resolution })
    .from(recruiterEscalations)
    .where(and(eq(recruiterEscalations.roleId, roleId), inArray(recruiterEscalations.kind, [...POSTING_TASK_KINDS])))
    .orderBy(desc(recruiterEscalations.createdAt));
  const claimedIds = rows.filter((r) => r.assignedToUserId).map((r) => r.id);
  const claims = claimedIds.length ? await q.select({ subjectId: events.subjectId, actor: events.actor }).from(events).where(and(eq(events.type, "recruiter.claimed"), eq(events.subjectType, "escalation"), inArray(events.subjectId, claimedIds))).orderBy(desc(events.id)) : [];
  const notDone = await notDoneTaskIds(q, rows.filter((r) => r.status === "resolved").map((r) => r.id));
  return rows.map(({ resolution, ...r }) => ({ ...r, recruiterName: r.assignedToUserId ? claims.find((c) => c.subjectId === r.id && c.actor.id === r.assignedToUserId)?.actor.name ?? null : null, notDone: notDone.has(r.id), note: notDone.has(r.id) ? resolution : null }));
}
