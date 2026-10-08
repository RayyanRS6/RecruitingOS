import type { EscalationThreadEntry, RecruiterRequestView } from "@ros/contracts";

/**
 * "Your recruiter requests" on Today (plan B4 and B5), the pure parts: what state a request is in, in words; which ones
 * the list shows first; who asked; when the reply is due; and what a person may do with it now. The page is
 * components/RecruiterRequests.tsx; the API is GET /api/v1/escalations/mine.
 */

/** An answered or cancelled request stays in the list this many days; older ones fold under "Older requests". */
export const RECENT_DAYS = 14;

export type RequestState = "waiting" | "working" | "answered" | "cancelled";

export function requestState(status: string): RequestState {
  if (status === "resolved") return "answered";
  if (status === "cancelled") return "cancelled";
  if (status === "claimed" || status === "in_progress") return "working";
  return "waiting";
}

export const STATE_WORDS: Record<RequestState, string> = { waiting: "Waiting for a recruiter", working: "A recruiter is on it", answered: "Answered", cancelled: "Cancelled" };

const closedAt = (r: RecruiterRequestView) => Date.parse(r.resolvedAt ?? r.createdAt);
const dueAt = (r: RecruiterRequestView) => (r.slaDueAt ? Date.parse(r.slaDueAt) : Number.POSITIVE_INFINITY);

/**
 * The order the list reads in: open requests first, the soonest reply-by time on top; then the ones answered (or
 * cancelled) in the last RECENT_DAYS days, newest first. Anything older goes under "Older requests".
 */
export function splitRequests(rows: readonly RecruiterRequestView[], now: Date): { current: RecruiterRequestView[]; older: RecruiterRequestView[] } {
  const open = rows.filter((r) => ["waiting", "working"].includes(requestState(r.status))).sort((a, b) => dueAt(a) - dueAt(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const closed = rows.filter((r) => !["waiting", "working"].includes(requestState(r.status))).sort((a, b) => closedAt(b) - closedAt(a));
  const since = now.getTime() - RECENT_DAYS * 86_400_000;
  return { current: [...open, ...closed.filter((r) => closedAt(r) >= since)], older: closed.filter((r) => closedAt(r) < since) };
}

/** What the request is about: one candidate (by name, while the record has one), one role, or all of the hiring. */
export function aboutWords(r: Pick<RecruiterRequestView, "scope" | "roleTitle" | "candidateName">): string {
  if (r.scope === "application") return r.candidateName ? `${r.candidateName}${r.roleTitle ? `, for ${r.roleTitle}` : ""}` : `A candidate${r.roleTitle ? ` for ${r.roleTitle}` : ""}`;
  if (r.scope === "role") return r.roleTitle ?? "One role";
  return "All of your hiring";
}

export function askedByWords(a: RecruiterRequestView["askedBy"]): string {
  switch (a.kind) {
    case "you": return "You asked";
    case "team": return a.name ? `${a.name} asked` : "Someone on your team asked";
    case "recruiter": return `${a.name ?? "An ITS recruiter"} (ITS recruiter) asked`;
    case "candidate": return "A candidate asked for a person";
    default: return "Brought in on its own when something got stuck";
  }
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The time line: when the reply is due, that the time has passed, or when it was answered. */
export function replyByWords(r: Pick<RecruiterRequestView, "status" | "slaDueAt" | "resolvedAt">, now: Date): string {
  const state = requestState(r.status);
  if (state === "answered") return r.resolvedAt ? `Answered ${when(r.resolvedAt)}` : "Answered";
  if (state === "cancelled") return "Cancelled";
  if (!r.slaDueAt) return "No reply-by time";
  return Date.parse(r.slaDueAt) < now.getTime() ? `The reply-by time (${when(r.slaDueAt)}) has passed` : `Reply by ${when(r.slaDueAt)}`;
}

/** Who picked it up, or that nobody has yet. */
export function pickedUpWords(r: Pick<RecruiterRequestView, "status" | "recruiterName">): string | null {
  if (r.recruiterName) return `Picked up by ${r.recruiterName} (ITS recruiter)`;
  return requestState(r.status) === "waiting" ? "Not picked up yet" : null;
}

/** The heading over one entry of the conversation. */
export function threadHeading(entry: EscalationThreadEntry): string {
  switch (entry.kind) {
    case "question": return entry.by ? `${entry.by} asked` : "The request";
    case "answer": return `${entry.by ?? "The recruiter"} answered`;
    case "reopen": return `${entry.by ?? "Your team"} reopened it`;
    default: return entry.side === "recruiter" ? `${entry.by ?? "The recruiter"} wrote` : `${entry.by ?? "Your team"} added a note`;
  }
}

/** The same heading in the recruiter queue, where the other side is "the customer" (their names stay with the company). */
export function queueThreadHeading(entry: EscalationThreadEntry): string {
  if (entry.side === "recruiter") return threadHeading(entry);
  return entry.kind === "question" ? "The customer asked" : entry.kind === "reopen" ? "The customer reopened it" : "The customer added a note";
}

/**
 * A role still being drafted, as a request about it carries it (plan C12; buildEscalationContext in
 * packages/core/src/escalations.ts): who started it, the whole conversation, what is known, and the draft beside it.
 */
export type HandedOverDraft = {
  id: string;
  status: string;
  startedBy: string | null;
  messages: Array<{ role: string; content: string; at: string; kind?: string }>;
  facts: Record<string, unknown>;
  missingFacts: string[];
  draftPacket: { identity?: { title?: string }; description?: { publicJobDescription?: string } } | null;
};

/**
 * Where "Open in the customer's workspace" goes: the draft in the job builder when the request is about one, the
 * role's candidates when it is about a role, and Today otherwise.
 */
export function workspaceHref(e: { roleId?: string | null; contextSnapshot?: Record<string, unknown> }): string {
  const draft = (e.contextSnapshot as { intakeSession?: { id?: unknown } | null } | undefined)?.intakeSession;
  if (draft && typeof draft.id === "string") return `/roles/new?session=${encodeURIComponent(draft.id)}`;
  return e.roleId ? `/roles/${e.roleId}/talent` : "/";
}

const PAY_PER: Record<string, string> = { hourly: "an hour", salary: "a year" };
const money = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US")}` : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** What the draft knows so far, one plain line each, for the recruiter to read before opening it. */
export function draftFactLines(facts: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | null) => {
    if (value) out.push({ label, value });
  };
  add("Job title", text(facts.title));
  add("Where", text(facts.locationText));
  const min = money(facts.compensationMin);
  const max = money(facts.compensationMax);
  add("Pay", min && max ? `${min}–${max}${PAY_PER[String(facts.compensationBasis)] ? ` ${PAY_PER[String(facts.compensationBasis)]}` : ""} (as discussed; check whether it was confirmed)` : null);
  add("Why they are hiring", text(facts.reasonDetail) ?? text(facts.reason)?.replace(/_/g, " ") ?? null);
  add("Final decision", text(facts.decisionMaker));
  add("Who interviews", list(facts.interviewers).join(", ") || null);
  add("Must-haves", list(facts.mustHaves).join("; ") || null);
  add("Deal-breakers", list(facts.dealBreakers).join("; ") || null);
  return out;
}

/** The newest answer, shown in full on the request itself. */
export function latestAnswer(thread: readonly EscalationThreadEntry[]): EscalationThreadEntry | null {
  return [...thread].reverse().find((e) => e.kind === "answer") ?? null;
}

/**
 * What a person may do with a request now: add a note while it is open, reopen it once answered. An ITS recruiter
 * inside the company does neither here; they answer from the recruiter queue.
 */
export function requestActions(r: Pick<RecruiterRequestView, "status">, opts: { staff: boolean }): { note: boolean; reopen: boolean } {
  if (opts.staff) return { note: false, reopen: false };
  const s = requestState(r.status);
  return { note: s === "waiting" || s === "working", reopen: s === "answered" };
}

/** The shortest reason a reopening takes (the API refuses less): the recruiter needs to know what is still missing. */
export const REOPEN_MIN = 5;

/**
 * What the reopen form says before anything is sent. The request goes back to the recruiter who answered when they can
 * still take it (they still work for ITS, and nobody here ended their access to it); otherwise to the ITS queue. The
 * reply after the reopen says which it was.
 */
export function reopenHint(recruiterName: string | null, access: string, days: number): string {
  const where = recruiterName ? `It goes back to ${recruiterName}, who answered, when they can still take it; otherwise to the ITS queue.` : "It goes back to the ITS queue.";
  return `Reopening sets a new reply-by time. ${where} Whoever has it then can see ${access} for up to ${days} days, or until a day after it is resolved again. That access is recorded in your activity, your team is told, and an owner or admin can end it in Setup.`;
}

/** Where a company stands against its plan's recruiter requests (Q33), as GET /admin/customers reports it. */
export type RecruiterAskStanding = { used: number; limit: number | null; over: boolean };

/** The admin console's line: "Recruiter requests: 2 of 1", or the count alone when the plan sets no number. */
export function recruiterAsksLine(s: RecruiterAskStanding | undefined): string {
  if (!s) return "Recruiter requests: none recorded";
  return s.limit === null ? `Recruiter requests: ${s.used}` : `Recruiter requests: ${s.used} of ${s.limit}`;
}

/** Shown beside a company that has asked for more than its plan includes: nothing was refused; billing is a conversation. */
export const RECRUITER_ASKS_OVER_CHIP = "Past its recruiter requests: talk about billing";
