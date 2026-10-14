import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  CANCELLED_REASON_LABEL,
  NEW_TIMES_SETTING_DEFAULT,
  NEW_TIMES_WORKING_DAYS,
  titleMidSentence,
  type Actor,
  type ApplicationStage,
  type AutoNewTimesReason,
  type AutoNewTimesState,
  type CancelNext,
  type CancelledReason,
  type CancelledView,
  type FollowUpKind,
  type FollowUpResolution,
  type InterviewFollowUpRef,
  type NewTimesProgress,
} from "@ros/contracts";
import { applicationMarks, applications, candidates, communications, companies, interviewFollowups, interviews, takeovers, workflowRuns, type CompanySettings, type Queryable } from "@ros/db";
import { zonedParts } from "./business-hours";
import { emit } from "./events";
import { notify } from "./notifications";

/**
 * The Cancelled column (founder decisions 1A to 4A, 9 October 2026). This module owns `interview_followups`: who is in the
 * column and why, the one automatic set of new times and its state machine, and how someone leaves. Only two things put
 * someone here: the candidate's own cancel of a booked interview (with their choice: new times later, or no longer
 * interested) and the team recording that the candidate did not show. The automatic set only reopens an interview a
 * person already approved (`MIN_LEVELS["interview.request"]` stays "approval"), and counts as sent only once the email
 * with the times is on its way. It never imports ./stages or ./marks, which import it.
 */

/** The only internal stages where Cancelled can show: a booked interview cancelled, or one they did not come to. */
export const CANCEL_STAGES: readonly ApplicationStage[] = ["interview_recommended", "interview_complete"];

export type FollowUpRow = typeof interviewFollowups.$inferSelect;
/** The least the stage strip needs (`ownerStage`, `groupFor`). `interviewOpen`: an interview of theirs is being set up or offered. */
export type FollowUpStrip = { reason: CancelledReason; autoState: AutoNewTimesState; interviewOpen: boolean };
/** An open follow-up with where its new times stand (`activeFollowUpsFor`). */
export type FollowUpView = FollowUpStrip & {
  id: string; applicationId: string; kind: FollowUpKind; choice: CancelNext | null; autoReason: AutoNewTimesReason | null;
  autoDueAt: string | null; autoWorkingDays: number | null; autoSentAt: string | null; interviewId: string; interviewAttempt: number;
  currentInterviewId: string | null; times: NewTimesProgress; lastSentAt: string | null; lastSentVia: "auto" | "person" | "batch" | null; since: string;
};
/**
 * How the automatic set starts: armed for its day, or not armed and why. `day`: the promised day in the company's
 * calendar (YYYY-MM-DD), recorded with the entry so the history names the day the candidate was told.
 */
export type FollowUpEntryAuto = { state: "waiting"; dueAt: string; workingDays: number; day?: string } | { state: "none"; reason: AutoNewTimesReason };
/** What a candidate page may promise about new times (`candidateNewTimesPromise`). */
export type NewTimesPromise = "date" | "soon" | "team" | "not_interested" | "neutral";

export class FollowUpError extends Error {
  constructor(public readonly code: "not_found" | "illegal_move" | "not_in_cancel_stage", message: string) {
    super(message);
  }
}

/** Times in ISO form whatever the driver hands back, so every page reads them the same way. */
const iso = (value: string) => new Date(value).toISOString();
const isoOrNull = (value: string | null) => (value ? iso(value) : null);

/** Interview statuses with times being worked out or offered. */
const OPEN_INTERVIEW = ["proposed", "scheduling"];
/** A slots email on its way, or gone. Held waits for the ITS check; any other status never reached them. */
const EMAIL_OUT = new Set(["queued", "sending", "sent", "delivered"]);
/** Where the new times stand while an interview is open, first match wins. */
const OPEN_TIMES: readonly NewTimesProgress[] = ["out", "held", "not_reached", "preparing"];
const PENDING_AUTO: readonly AutoNewTimesState[] = ["waiting", "waiting_check", "preparing"];

export function followUpReason(r: { kind: string; choice: string | null }): CancelledReason {
  if (r.kind === "candidate_no_show") return "no_show";
  return r.choice === "new_times" ? "asked_new_times" : "not_interested";
}

/** Someone is under Cancelled only with an open follow-up and while recommended for interview or interview done. */
export function inCancelled(stage: ApplicationStage, f: FollowUpStrip | null | undefined): f is FollowUpStrip {
  return !!f && CANCEL_STAGES.includes(stage);
}

/** A promised automatic set: nothing waits on the team before its day. */
export function followUpParked(f: Pick<FollowUpStrip, "autoState">): boolean {
  return f.autoState === "waiting" || f.autoState === "waiting_check";
}

/** Something is already happening for them (a promised set, or times being prepared or out), so they do not wait on the team. */
export function followUpInMotion(f: FollowUpStrip): boolean {
  return followUpParked(f) || f.interviewOpen;
}

/**
 * The strip's view of a row read with a left join (the roles list counts in SQL): null when there is no open follow-up.
 * `interviewOpen` is the same condition `activeFollowUpsFor` uses: an interview of theirs is proposed or scheduling.
 */
export function followUpStripOf(r: { kind: string | null; choice: string | null; autoState: string | null; interviewOpen: boolean | null }): FollowUpStrip | null {
  if (!r.kind) return null;
  return { reason: followUpReason({ kind: r.kind, choice: r.choice }), autoState: (r.autoState ?? "none") as AutoNewTimesState, interviewOpen: !!r.interviewOpen };
}

function timesFrom(email: string | null): NewTimesProgress {
  if (email === null) return "preparing";
  if (email === "held") return "held";
  return EMAIL_OUT.has(email) ? "out" : "not_reached";
}

function viewOf(r: FollowUpRow, times: NewTimesProgress): FollowUpView {
  return {
    id: r.id, applicationId: r.applicationId, kind: r.kind, choice: r.choice, reason: followUpReason(r), autoState: r.autoState, autoReason: r.autoReason,
    autoDueAt: isoOrNull(r.autoDueAt), autoWorkingDays: r.autoWorkingDays, autoSentAt: isoOrNull(r.autoSentAt), interviewId: r.interviewId, interviewAttempt: r.interviewAttempt,
    currentInterviewId: r.currentInterviewId, times, interviewOpen: OPEN_TIMES.includes(times), lastSentAt: isoOrNull(r.lastSentAt), lastSentVia: r.lastSentVia, since: iso(r.createdAt),
  };
}

/**
 * The open follow-up of each application, with where its new times stand, in two queries. `times` comes from the slots
 * email of an interview being set up or offered (the key `sendSlotsOffered` uses): on its way or gone, `out`; held for the
 * ITS check, `held`; failed or withdrawn, `not_reached`; none yet, `preparing`. With no such interview, `expired` when the
 * interview that carried their new times lapsed without a pick, otherwise `none`.
 */
export async function activeFollowUpsFor(q: Queryable, applicationIds: string[]): Promise<Map<string, FollowUpView>> {
  const out = new Map<string, FollowUpView>();
  if (!applicationIds.length) return out;
  const rows = await q.select().from(interviewFollowups).where(and(inArray(interviewFollowups.applicationId, applicationIds), isNull(interviewFollowups.resolvedAt)));
  if (!rows.length) return out;
  const ivs = await q
    .select({ applicationId: interviews.applicationId, id: interviews.id, status: interviews.status, attempt: interviews.attempt, email: communications.status })
    .from(interviews)
    .leftJoin(communications, sql`${communications.idempotencyKey} = 'slots:' || ${interviews.id}::text || ':' || ${interviews.attempt}::text`)
    .where(inArray(interviews.applicationId, rows.map((r) => r.applicationId)));
  for (const r of rows) {
    const mine = ivs.filter((i) => i.applicationId === r.applicationId);
    const open = mine.filter((i) => OPEN_INTERVIEW.includes(i.status)).map((i) => timesFrom(i.email));
    const first = OPEN_TIMES.find((t) => open.includes(t));
    const current = r.currentInterviewId ? mine.find((i) => i.id === r.currentInterviewId) : undefined;
    out.set(r.applicationId, viewOf(r, first ?? (current?.status === "offer_expired" ? "expired" : "none")));
  }
  return out;
}

/** The open follow-up of an application, locked for the caller's transaction when `lock` is set. */
export async function openFollowUpOf(q: Queryable, applicationId: string, opts: { lock?: boolean } = {}): Promise<FollowUpRow | null> {
  const query = q.select().from(interviewFollowups).where(and(eq(interviewFollowups.applicationId, applicationId), isNull(interviewFollowups.resolvedAt))).limit(1);
  const [row] = opts.lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The automatic sets already promised a day (waiting for it, or for the ITS check), locked: Setup asks about them before switching off. */
export async function pendingNewTimesRows(q: Queryable, companyId: string, opts: { lock?: boolean } = {}): Promise<FollowUpRow[]> {
  const query = q.select().from(interviewFollowups).where(and(eq(interviewFollowups.companyId, companyId), isNull(interviewFollowups.resolvedAt), inArray(interviewFollowups.autoState, ["waiting", "waiting_check"])));
  const rows = opts.lock ? await query.for("update") : await query;
  return rows;
}

function autoPayload(r: FollowUpRow) {
  return { state: r.autoState, reason: r.autoReason, dueAt: isoOrNull(r.autoDueAt), workingDays: r.autoWorkingDays };
}

/**
 * Puts someone under Cancelled. Idempotent per entry (interview and attempt): the same cancel pressed twice, or a step
 * run again, returns the row already written and writes nothing. Otherwise an open row of another entry is resolved as
 * superseded, the active private mark ends (a hold included: the candidate's own cancel ends it, founder decision 1A),
 * and the row is written and recorded as `application.moved_to_cancelled`. Callers move the stage first (`transition`),
 * then call this; the application must be recommended for interview or interview done.
 */
export async function openFollowUp(
  q: Queryable,
  input: { companyId: string; applicationId: string; interviewId: string; interviewAttempt: number; kind: FollowUpKind; choice: CancelNext | null; auto: FollowUpEntryAuto; actor: Actor; now?: Date },
): Promise<{ row: FollowUpRow; created: boolean }> {
  const now = input.now ?? new Date();
  const entry = and(eq(interviewFollowups.companyId, input.companyId), eq(interviewFollowups.interviewId, input.interviewId), eq(interviewFollowups.interviewAttempt, input.interviewAttempt));
  const [existing] = await q.select().from(interviewFollowups).where(entry).limit(1).for("update");
  if (existing) return { row: existing, created: false };
  const [app] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app || !CANCEL_STAGES.includes(app.stage)) throw new FollowUpError("not_in_cancel_stage", `application ${input.applicationId} is not recommended for interview or interview done`);
  await resolveOpenFollowUp(q, { companyId: input.companyId, applicationId: input.applicationId, actor: input.actor, how: "superseded", now });
  // A Cancelled entry and a private mark never coexist; as `endMarkOnMove` in stages.ts, without importing it.
  const cleared = await q.update(applicationMarks).set({ clearedAt: now.toISOString(), clearedBy: input.actor, clearReason: "moved to Cancelled" }).where(and(eq(applicationMarks.applicationId, input.applicationId), isNull(applicationMarks.clearedAt))).returning({ id: applicationMarks.id, mark: applicationMarks.mark });
  for (const m of cleared) await emit(q, { type: "application.mark_cleared", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { markId: m.id, mark: m.mark, reason: "moved_on", to: "cancelled" } });
  const waiting = input.auto.state === "waiting" ? input.auto : null;
  const [row] = await q
    .insert(interviewFollowups)
    .values({
      companyId: input.companyId, applicationId: input.applicationId, interviewId: input.interviewId, interviewAttempt: input.interviewAttempt, kind: input.kind, choice: input.choice,
      autoState: input.auto.state, autoReason: input.auto.state === "none" ? input.auto.reason : null, autoDueAt: waiting?.dueAt ?? null, autoWorkingDays: waiting?.workingDays ?? null,
      createdBy: input.actor, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    })
    .onConflictDoNothing({ target: [interviewFollowups.companyId, interviewFollowups.interviewId, interviewFollowups.interviewAttempt] })
    .returning();
  if (!row) {
    // a concurrent first call won: theirs is the entry
    const [won] = await q.select().from(interviewFollowups).where(entry).limit(1);
    return { row: won, created: false };
  }
  await emit(q, { type: "application.moved_to_cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { followUpId: row.id, interviewId: input.interviewId, reason: followUpReason(row), auto: { ...autoPayload(row), ...(waiting?.day ? { dueDay: waiting.day } : {}) } } });
  return { row, created: true };
}

/**
 * Takes someone out of the column (`rebooked`, `moved_by_team`, `team_cancelled`, `left_process`, `superseded`). A set
 * still pending (waiting, waiting for the ITS check, or being prepared) does not go: `left_process` for leaving,
 * `interview_changed` for a new entry, `team_acted` otherwise. Its timer run is never cancelled here: it re-checks when it
 * wakes, and a decision taken back can restore the set (`restoreFollowUpAfterUndo`). Idempotent; null when nobody is in
 * the column.
 */
export async function resolveOpenFollowUp(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; how: FollowUpResolution; now?: Date }): Promise<FollowUpRow | null> {
  const now = input.now ?? new Date();
  const open = await openFollowUpOf(q, input.applicationId, { lock: true });
  if (!open) return null;
  const autoStopped = PENDING_AUTO.includes(open.autoState);
  if (autoStopped) {
    const reason: AutoNewTimesReason = input.how === "left_process" ? "left_process" : input.how === "superseded" ? "interview_changed" : "team_acted";
    await setAutoState(q, { followUpId: open.id, to: "not_sent", reason, actor: input.actor, now });
  }
  const [row] = await q.update(interviewFollowups).set({ resolvedAt: now.toISOString(), resolvedHow: input.how, resolvedBy: input.actor }).where(and(eq(interviewFollowups.id, open.id), isNull(interviewFollowups.resolvedAt))).returning();
  if (!row) return null;
  await emit(q, { type: "application.left_cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { followUpId: row.id, how: input.how, autoStopped } });
  return row;
}

/**
 * A person took back a private decision (declined, talent pool) before the candidate was told (plan G1), to a stage where
 * Cancelled shows: someone who was under Cancelled goes back there with the same row and choice. A set that was pending
 * comes back to `waiting` when its day is still ahead, its timer run still waits and automatic times are still on in
 * Setup; otherwise it stays not sent (`left_process`) and the team decides. Switching automatic times off asked only about
 * the sets promised then, and this one was not among them (the decision had stopped it), so it never comes back once they
 * are off. The setting is read under a share lock on the company row, as a cancel reads it, so switching off and an
 * undo take turns. Nothing else re-opens a resolved row. Null when they were not under Cancelled.
 */
export async function restoreFollowUpAfterUndo(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; now?: Date }): Promise<FollowUpRow | null> {
  const now = input.now ?? new Date();
  const [newest] = await q.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, input.applicationId)).orderBy(desc(interviewFollowups.createdAt), desc(interviewFollowups.id)).limit(1).for("update");
  if (!newest || newest.resolvedHow !== "left_process") return null;
  // Nothing else can have opened a row while they were declined: `openFollowUp` needs a stage in CANCEL_STAGES.
  const [reopened] = await q.update(interviewFollowups).set({ resolvedAt: null, resolvedHow: null, resolvedBy: null }).where(and(eq(interviewFollowups.id, newest.id), eq(interviewFollowups.resolvedHow, "left_process"))).returning();
  if (!reopened) return null;
  let row = reopened;
  const dayAhead = !!row.autoDueAt && Date.parse(iso(row.autoDueAt)) > now.getTime();
  if (row.autoState === "not_sent" && row.autoReason === "left_process" && dayAhead && row.autoRunId) {
    const [company] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, row.companyId)).limit(1).for("share");
    const [run] = await q.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, row.autoRunId)).limit(1);
    if (newTimesSettingOf(company?.settings).auto && run?.status === "waiting") row = await moveAutoState(q, { followUpId: row.id, to: "waiting", actor: input.actor, now }, { restore: true });
  }
  await emit(q, { type: "application.moved_to_cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { followUpId: row.id, interviewId: row.interviewId, reason: followUpReason(row), restored: true, auto: autoPayload(row) } });
  return row;
}

/**
 * The automatic set's state machine (`auto_state`), and the reasons a set may end not sent from each state. `none` and
 * `sent` are final; `not_sent` is final except for the one move back to `waiting` after a decision was taken back.
 */
const AUTO_MOVES: Record<AutoNewTimesState, readonly AutoNewTimesState[]> = {
  none: [],
  waiting: ["waiting_check", "preparing", "not_sent"],
  waiting_check: ["preparing", "not_sent"],
  preparing: ["sent", "not_sent"],
  sent: [],
  not_sent: [],
};
const NOT_SENT_WHILE_PARKED: readonly AutoNewTimesReason[] = ["stopped_by_team", "switched_off", "team_acted", "candidate_replied", "left_process", "details_deleted", "interview_changed", "takeover", "no_interviewers", "no_email", "company_not_checked"];
// While it is being prepared, a reply asking for a person or saying no, and an ITS recruiter taking the role over, stop it
// too, as long as its email has not left (founder questions 7 and 8; `stopPreparedNewTimes` in packages/workflows).
const NOT_SENT_WHILE_PREPARING: readonly AutoNewTimesReason[] = ["no_email", "team_acted", "left_process", "interview_changed", "candidate_replied", "takeover"];

function moveAllowed(from: AutoNewTimesState, to: AutoNewTimesState, reason: AutoNewTimesReason | null): boolean {
  if (!AUTO_MOVES[from].includes(to)) return false;
  if (to !== "not_sent") return true;
  if (!reason) return false;
  return from === "preparing" ? NOT_SENT_WHILE_PREPARING.includes(reason) : NOT_SENT_WHILE_PARKED.includes(reason);
}

export type AutoStateMove = {
  followUpId: string; to: AutoNewTimesState; reason?: AutoNewTimesReason | null; actor: Actor; now?: Date;
  extra?: { autoDueAt?: string; autoWorkingDays?: number; autoRunId?: string | null; autoSentAt?: string };
};

/**
 * The only writer of `auto_state`. Allows exactly the moves of the state machine and throws (`illegal_move`) on any other;
 * a move to `not_sent` needs a reason that state allows and is recorded as `interview.new_times_not_sent`. `auto_reason`
 * explains `none` and `not_sent` only. `extra` carries the due moment, the number of days, the timer run and when it went.
 */
export async function setAutoState(q: Queryable, input: AutoStateMove): Promise<FollowUpRow> {
  return moveAutoState(q, input, { restore: false });
}

async function moveAutoState(q: Queryable, input: AutoStateMove, opts: { restore: boolean }): Promise<FollowUpRow> {
  const now = input.now ?? new Date();
  const [row] = await q.select().from(interviewFollowups).where(eq(interviewFollowups.id, input.followUpId)).limit(1).for("update");
  if (!row) throw new FollowUpError("not_found", `follow-up ${input.followUpId} not found`);
  const from = row.autoState;
  const reason = input.to === "not_sent" ? (input.reason ?? null) : null;
  const allowed = opts.restore ? from === "not_sent" && row.autoReason === "left_process" && input.to === "waiting" : moveAllowed(from, input.to, reason);
  if (!allowed) throw new FollowUpError("illegal_move", `automatic new times cannot go from ${from} to ${input.to}${input.reason ? ` (${input.reason})` : ""}`);
  const autoSentAt = input.extra?.autoSentAt ?? (input.to === "sent" ? now.toISOString() : undefined);
  const [updated] = await q
    .update(interviewFollowups)
    .set({ autoState: input.to, autoReason: reason, ...input.extra, ...(autoSentAt ? { autoSentAt } : {}) })
    .where(and(eq(interviewFollowups.id, row.id), eq(interviewFollowups.autoState, from)))
    .returning();
  if (!updated) throw new FollowUpError("illegal_move", `automatic new times changed from ${from} a moment ago`);
  if (input.to === "not_sent") await emit(q, { type: "interview.new_times_not_sent", companyId: row.companyId, actor: input.actor, subject: { type: "application", id: row.applicationId }, payload: { followUpId: row.id, reason, from } });
  return updated;
}

/** The timer run that will send the automatic set (`armNewTimes` in packages/workflows). Not a state change. */
export async function recordAutoRun(q: Queryable, input: { followUpId: string; runId: string }): Promise<void> {
  await q.update(interviewFollowups).set({ autoRunId: input.runId }).where(eq(interviewFollowups.id, input.followUpId));
}

/** The interview that carries their new times, once a person or the automatic set reopened or created it. */
export async function setCurrentInterview(q: Queryable, input: { followUpId: string; interviewId: string }): Promise<void> {
  await q.update(interviewFollowups).set({ currentInterviewId: input.interviewId }).where(eq(interviewFollowups.id, input.followUpId));
}

/**
 * Counts one set of new times as sent: how many, when, how and by whom. Only `newTimesOffered` calls it, when the email
 * with the times is on its way, never at the click. `offerKey` is that email's key, so the same offer counts once.
 */
export async function recordTimesSent(q: Queryable, input: { followUpId: string; via: "auto" | "person" | "batch"; actor: Actor; now?: Date; offerKey?: string }): Promise<FollowUpRow> {
  const now = input.now ?? new Date();
  const [row] = await q
    .update(interviewFollowups)
    .set({ timesSentCount: sql`${interviewFollowups.timesSentCount} + 1`, lastSentAt: now.toISOString(), lastSentVia: input.via, lastSentBy: input.actor, ...(input.offerKey ? { lastOfferKey: input.offerKey } : {}) })
    .where(eq(interviewFollowups.id, input.followUpId))
    .returning();
  if (!row) throw new FollowUpError("not_found", `follow-up ${input.followUpId} not found`);
  return row;
}

/**
 * Called by `schedule_interview`'s `offer_slots` step right after the slots email of an interview carrying new times was
 * written. Acts only while the row is open and that interview is the one carrying them. `queued` (on its way): counted
 * once per offer, an automatic set becomes `sent`, `interview.new_times_sent` is recorded, and the team hears about an
 * automatic one. `held` (waiting for the ITS check): nothing yet. `failed`: an automatic set being prepared ends not sent
 * (`no_email`) and the team hears. Null when it does not apply.
 *
 * `reoffer`: the same scheduling run offering again on a new attempt, because the time the candidate picked was taken
 * by booking time. Those times were already counted for this interview: only the key moves, so one set is counted and
 * the team told once.
 */
export async function newTimesOffered(
  q: Queryable,
  input: { followUpId: string; interviewId: string; attempt: number; outcome: "queued" | "held" | "failed"; via: "auto" | "person" | "batch"; actor: Actor; now?: Date; reoffer?: boolean },
): Promise<{ row: FollowUpRow; counted: boolean } | null> {
  const now = input.now ?? new Date();
  const [row] = await q.select().from(interviewFollowups).where(eq(interviewFollowups.id, input.followUpId)).limit(1).for("update");
  if (!row || row.resolvedAt || row.currentInterviewId !== input.interviewId) return null;
  if (input.outcome === "held") return { row, counted: false };
  if (input.outcome === "failed") {
    if (row.autoState !== "preparing") return { row, counted: false };
    const ended = await setAutoState(q, { followUpId: row.id, to: "not_sent", reason: "no_email", actor: input.actor, now });
    await notifyNewTimesNotSent(q, { followUp: ended, reason: "no_email" });
    return { row: ended, counted: false };
  }
  const offerKey = `slots:${input.interviewId}:${input.attempt}`;
  if (row.lastOfferKey === offerKey) return { row, counted: false };
  if (input.reoffer && row.lastOfferKey?.startsWith(`slots:${input.interviewId}:`)) {
    const [moved] = await q.update(interviewFollowups).set({ lastOfferKey: offerKey }).where(eq(interviewFollowups.id, row.id)).returning();
    return { row: moved ?? row, counted: false };
  }
  let counted = await recordTimesSent(q, { followUpId: row.id, via: input.via, actor: input.actor, now, offerKey });
  if (counted.autoState === "preparing") counted = await setAutoState(q, { followUpId: row.id, to: "sent", actor: input.actor, now, extra: { autoSentAt: now.toISOString() } });
  await emit(q, { type: "interview.new_times_sent", companyId: row.companyId, actor: input.actor, subject: { type: "application", id: row.applicationId }, payload: { followUpId: row.id, interviewId: input.interviewId, attempt: input.attempt, via: input.via } });
  if (input.via === "auto") await notifyNewTimesSent(q, counted);
  return { row: counted, counted: true };
}

/**
 * Of these times emails (keyed `slots:<interview>:<attempt>`), the ones of an automatic set still being prepared for a
 * role an ITS recruiter has taken over since (founder question 7: no automatic set during a takeover). The outbox
 * withdraws them before a release or a send, so one held for the ITS check never leaves when ITS confirms the company;
 * the set's own run then ends it and brings the recruiter in (`stopPreparedNewTimes` in packages/workflows). A person's
 * send or re-offer is theirs and is never among them, nor is a time someone booked for the candidate on their behalf,
 * nor a set already sent.
 */
export async function autoTimesUnderTakeover(q: Queryable, emailKeys: readonly string[]): Promise<Set<string>> {
  const runKeys = emailKeys.filter((k) => k.startsWith("slots:")).map((k) => `schedule:${k.slice("slots:".length)}`);
  if (!runKeys.length) return new Set();
  const rows = await q
    .select({ key: workflowRuns.idempotencyKey })
    .from(workflowRuns)
    .innerJoin(interviewFollowups, sql`${interviewFollowups.id}::text = ${workflowRuns.state}->>'followUpId'`)
    .innerJoin(interviews, and(eq(interviews.id, interviewFollowups.currentInterviewId), sql`${interviews.id}::text = ${workflowRuns.state}->>'interviewId'`, sql`coalesce(${interviews.selectedSlot}, 'null'::jsonb) = 'null'::jsonb`))
    .innerJoin(applications, eq(applications.id, interviewFollowups.applicationId))
    .innerJoin(takeovers, and(eq(takeovers.companyId, applications.companyId), eq(takeovers.roleId, applications.roleId), eq(takeovers.status, "active")))
    .where(and(inArray(workflowRuns.idempotencyKey, runKeys), sql`${workflowRuns.state}->>'via' = 'auto'`, eq(interviewFollowups.autoState, "preparing"), isNull(interviewFollowups.resolvedAt)));
  return new Set(rows.map((r) => `slots:${(r.key ?? "").slice("schedule:".length)}`));
}

/** Who the team's notice is about, in their words: the candidate's name, the interview's title, the role and the company's zone. */
async function aboutFollowUp(q: Queryable, f: FollowUpRow): Promise<{ first: string; full: string; title: string; href: string; timeZone: string } | null> {
  const [a] = await q
    .select({ roleId: applications.roleId, first: candidates.firstName, last: candidates.lastName, timeZone: companies.timezone })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(companies, eq(companies.id, applications.companyId))
    .where(eq(applications.id, f.applicationId))
    .limit(1);
  if (!a) return null;
  const [iv] = await q.select({ title: interviews.title }).from(interviews).where(eq(interviews.id, f.currentInterviewId ?? f.interviewId)).limit(1);
  return { first: a.first, full: `${a.first} ${a.last}`.trim(), title: iv?.title ?? "interview", href: `/roles/${a.roleId}/talent?open=${f.applicationId}`, timeZone: a.timeZone };
}

/** "Thursday, October 15" in the company's zone. */
function dayWords(at: string, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

async function notifyNewTimesSent(q: Queryable, f: FollowUpRow): Promise<void> {
  const who = await aboutFollowUp(q, f);
  if (!who) return;
  await notify(q, {
    companyId: f.companyId,
    kind: "interview.new_times_sent",
    title: `New times went to ${who.full}`,
    body: `${who.first} cancelled the ${titleMidSentence(who.title)} and asked for new times. They went out today. This was their one automatic set; if ${who.first} does not pick a time, they stay under Cancelled for you to decide.`,
    action: { label: "Open the candidate", href: who.href },
  });
}

/**
 * Tells the team an automatic set did not go, with why (the reasons the team needs to act on: no email, the interview
 * changed, a recruiter takeover, nobody left to interview, the ITS check). Also used by the timer run.
 */
export async function notifyNewTimesNotSent(q: Queryable, input: { followUp: FollowUpRow; reason: AutoNewTimesReason }): Promise<void> {
  const f = input.followUp;
  const who = await aboutFollowUp(q, f);
  if (!who) return;
  const due = f.autoDueAt ? `, due ${dayWords(iso(f.autoDueAt), who.timeZone)}` : "";
  const why = autoReasonText(input.reason, { state: "not_sent" });
  // Before ITS confirms the company the team's send is refused too, so the notice never invites one until then.
  const next = input.reason === "company_not_checked" ? "you can send new times once ITS confirms your company, or decide" : "send new times when you are ready, or decide";
  await notify(q, {
    companyId: f.companyId,
    kind: "interview.new_times_not_sent",
    title: `New times for ${who.full} were not sent`,
    body: `${who.first} asked for new times${due}.${why ? ` ${why}` : ""} They are under Cancelled: ${next}.`,
    action: { label: "Open the candidate", href: who.href },
  });
}

/**
 * What a candidate page may promise about new times. `date`: the automatic set waits for its day. `soon`: it waits for the
 * ITS check, or its times are being worked out. `team`: they asked, nothing automatic is pending, and nobody stopped it.
 * `not_interested`: they said so. `neutral` for everything else, which promises nothing and reveals nothing (founder
 * decision B6): the application closed (declined privately, withdrawn, role closed), the row resolved, or the team stopped
 * the automatic set.
 */
export function candidateNewTimesPromise(row: Pick<FollowUpRow, "choice" | "autoState" | "autoReason" | "resolvedAt">, ctx: { applicationClosed: boolean }): NewTimesPromise {
  if (ctx.applicationClosed || row.resolvedAt) return "neutral";
  if (row.autoState === "waiting") return "date";
  if (row.autoState === "waiting_check" || row.autoState === "preparing") return "soon";
  if (row.choice === "not_interested") return "not_interested";
  if (row.choice === "new_times" && row.autoReason !== "stopped_by_team") return "team";
  return "neutral";
}

/** The company's setting (founder decision 3A): on after 3 working days when never saved; the days kept within 1 to 10. */
export function newTimesSettingOf(settings: CompanySettings | null | undefined): { auto: boolean; workingDays: number } {
  const s = settings?.newTimesAfterCancel;
  const auto = typeof s?.auto === "boolean" ? s.auto : NEW_TIMES_SETTING_DEFAULT.auto;
  const n = typeof s?.workingDays === "number" && Number.isFinite(s.workingDays) ? Math.round(s.workingDays) : NEW_TIMES_SETTING_DEFAULT.workingDays;
  return { auto, workingDays: Math.min(NEW_TIMES_WORKING_DAYS.max, Math.max(NEW_TIMES_WORKING_DAYS.min, n)) };
}

const REASON_TEXT: Partial<Record<AutoNewTimesReason, string>> = {
  switched_off: "Automatic new times are off in Settings.",
  already_used: "They already had their one automatic set of new times.",
  reschedules_used: "They had already moved this interview twice, so a person arranges the next time.",
  takeover: "An ITS recruiter is running this role, so nothing was sent automatically.",
  was_on_hold: "You had put them on hold, so nothing goes automatically.",
  stopped_by_team: "Someone on your team stopped the automatic new times.",
  team_acted: "Your team took it from there.",
  candidate_replied: "They replied to us, so nothing went automatically: read their reply first.",
  company_not_checked: "ITS had not confirmed your company in time, so nothing was sent automatically.",
  no_interviewers: "Nobody who ran the interview is still on your team.",
  no_email: "We have no email address for them, or the email did not reach them.",
  interview_changed: "The interview changed in the meantime.",
};

/**
 * Why no automatic set went, in one sentence for the team, or null when nothing needs saying (they did not ask, did not
 * come, their details were deleted, or they left the process). `switched_off` reads differently once a set was stopped
 * by switching it off; `left_process` on an open row means a decision was taken back.
 */
export function autoReasonText(reason: string | null | undefined, ctx: { state?: AutoNewTimesState; resolved?: boolean } = {}): string | null {
  if (!reason) return null;
  if (reason === "switched_off" && ctx.state === "not_sent") return "Automatic new times were switched off in Settings.";
  if (reason === "left_process") return ctx.resolved ? null : "Nothing went automatically while a decision was in place.";
  return REASON_TEXT[reason as AutoNewTimesReason] ?? null;
}

/** "Thu, Oct 15" and "Oct 15" in the company's zone. */
function shortDay(at: string, timeZone: string, weekday: boolean): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, ...(weekday ? { weekday: "short" as const } : {}), month: "short", day: "numeric" });
}

/** The row's line under Cancelled, first match wins. */
function statusLine(f: FollowUpView, timeZone: string): string {
  if (f.autoState === "waiting" && f.autoDueAt) return `New times go out automatically ${shortDay(f.autoDueAt, timeZone, true)}`;
  if (f.autoState === "waiting_check") return "New times wait for the ITS company check";
  switch (f.times) {
    case "preparing":
      return "Getting new times ready";
    case "held":
      return "New times wait for the ITS company check";
    case "out":
      return f.lastSentAt ? `New times sent ${shortDay(f.lastSentAt, timeZone, false)}, waiting for a pick` : "New times sent, waiting for a pick";
    case "not_reached":
      return "The new times email did not reach them";
    case "expired":
      return "Did not pick a new time";
    default:
      return "Waiting for you";
  }
}

/** What an interview summary carries about the person's follow-up (the Interviews page offers "Send new times" from it). */
export function interviewFollowUpRef(f: FollowUpView): InterviewFollowUpRef {
  return { id: f.id, reason: f.reason, times: f.times };
}

/** The team's view of someone under Cancelled (`CancelledView`), with days in the company's zone. */
export function cancelledView(f: FollowUpView, opts: { timeZone: string }): CancelledView {
  return {
    id: f.id,
    reason: f.reason,
    label: CANCELLED_REASON_LABEL[f.reason],
    since: f.since,
    interviewId: f.currentInterviewId ?? f.interviewId,
    auto: { state: f.autoState, reason: f.autoReason, reasonText: autoReasonText(f.autoReason, { state: f.autoState }), dueAt: f.autoDueAt, dueDay: f.autoDueAt ? zonedParts(new Date(f.autoDueAt), opts.timeZone).dayKey : null, sentAt: f.autoSentAt },
    times: f.times,
    lastSentAt: f.lastSentAt,
    lastSentVia: f.lastSentVia,
    status: statusLine(f, opts.timeZone),
  };
}
