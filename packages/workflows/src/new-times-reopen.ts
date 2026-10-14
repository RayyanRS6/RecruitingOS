import { and, eq, inArray, ne } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { createEscalation, emit, freshSchedulingWindow, notify, notifyNewTimesNotSent, setAutoState, setCurrentInterview, type FollowUpRow } from "@ros/core";
import { applications, candidates, communications, companies, interviewParticipants, interviews, memberships, roles, workflowRuns, type Queryable } from "@ros/db";
import type { SlotsVariant } from "@ros/agents";
import type { WorkflowEngine } from "./engine";

/** Which new-times opening the reopened interview's times email uses (packages/agents interview-messages.ts). */
export type NewTimesOfferKind = Extract<SlotsVariant, "new_times_asked" | "new_times_team">;
export type NewTimesVia = "auto" | "person" | "batch";
/** Why an interview could not be reopened for new times. `not_reopenable`: a no-show's missed interview; the caller creates a new one. */
export type ReopenRefusal = "not_reopenable" | "times_out" | "interview_changed" | "team_acted" | "no_interviewers";
export type ReopenResult = { ok: true; interviewId: string; attempt: number; runId: string } | { ok: false; reason: ReopenRefusal };

/** Interviews with times being worked out, offered or booked: an application has one at a time. */
const OPEN_INTERVIEW = ["proposed", "scheduling", "scheduled"];
const TOKEN_DAYS = 14;

/** The interviewers of an interview who are still active members of the company. */
export async function activeInterviewersOf(q: Queryable, companyId: string, interviewId: string): Promise<string[]> {
  const rows = await q
    .select({ userId: interviewParticipants.userId })
    .from(interviewParticipants)
    .innerJoin(memberships, and(eq(memberships.userId, interviewParticipants.userId), eq(memberships.companyId, companyId), eq(memberships.status, "active")))
    .where(eq(interviewParticipants.interviewId, interviewId));
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * New times for someone under Cancelled (the Cancelled column, founder decisions 2A and 4A), by reopening the interview a
 * person already approved: the automatic set and the team's "Send new times" both come here. It never creates an
 * interview, so a person's approval stays the only way one starts (`MIN_LEVELS["interview.request"]`). The interview gets
 * a fresh scheduling window (the old one can be in the past) and a new attempt; its link is kept, so old links open the
 * new times; interviewers who left the team are taken off it; and `schedule_interview` starts again carrying the
 * follow-up, so its email uses the new-times opening and counts as sent only when it is on its way (`newTimesOffered`).
 * Call inside the caller's tenant transaction, holding the application's and the follow-up's locks.
 */
export async function reopenForNewTimes(q: Queryable, engine: WorkflowEngine, input: { followUp: FollowUpRow; actor: Actor; via: NewTimesVia; offerKind: NewTimesOfferKind; now: Date }): Promise<ReopenResult> {
  const f = input.followUp;
  if (f.kind === "candidate_no_show" && !f.currentInterviewId) return { ok: false, reason: "not_reopenable" };
  const [iv] = await q.select().from(interviews).where(eq(interviews.id, f.currentInterviewId ?? f.interviewId)).limit(1);
  if (!iv) return { ok: false, reason: "interview_changed" };
  if (iv.status === "no_show") return { ok: false, reason: "not_reopenable" };
  if (iv.status === "proposed" || iv.status === "scheduling") return { ok: false, reason: "times_out" };
  if (iv.status !== "cancelled" && iv.status !== "offer_expired") return { ok: false, reason: "interview_changed" };
  // The interview they cancelled, untouched since: anything else that changed it (a team cancel) bumped the attempt. Once
  // it has carried new times (`current_interview_id`), an open row with it cancelled can only come from a decision taken
  // back (the exit cancelled it; a team cancel would have taken them out of the column), and reopening it is right.
  if (iv.status === "cancelled" && iv.id === f.interviewId && !f.currentInterviewId && iv.attempt !== f.interviewAttempt) return { ok: false, reason: "interview_changed" };
  const [other] = await q.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, iv.applicationId), ne(interviews.id, iv.id), inArray(interviews.status, OPEN_INTERVIEW))).limit(1);
  if (other) return { ok: false, reason: "team_acted" };

  // Someone removed from the team comes off the interview, with their calendar reference, as a member removal does for
  // interviews still ahead (apps/api services/team.ts). With nobody left, a person chooses new interviewers.
  const parts = await q.select({ id: interviewParticipants.id, userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
  const stay = new Set(await activeInterviewersOf(q, iv.companyId, iv.id));
  if (!stay.size) return { ok: false, reason: "no_interviewers" };
  const gone = parts.filter((p) => !stay.has(p.userId));
  if (gone.length) await q.delete(interviewParticipants).where(inArray(interviewParticipants.id, gone.map((p) => p.id)));
  const refs = Object.fromEntries(Object.entries(iv.calendarRefs ?? {}).filter(([userId]) => !gone.some((p) => p.userId === userId)));

  const [company] = await q.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, iv.companyId)).limit(1);
  // A fresh window from tomorrow, as long as the one the interview had (the default when it had none); the candidate's zone is kept.
  const window = freshSchedulingWindow(iv.schedulingWindow, input.now, company?.timezone ?? "UTC");
  // Guarded: a person and the automatic set reopening at the same moment cannot both pass. The reason it was cancelled stays as history.
  const [fresh] = await q
    .update(interviews)
    .set({
      status: "scheduling", attempt: iv.attempt + 1, selectedSlot: null, offeredSlots: [], startsAt: null, endsAt: null, reminders: {}, calendarRefs: refs,
      meetingUrl: iv.linkSource === "pasted" ? iv.meetingUrl : null, schedulingWindow: window, scheduleTokenExpiresAt: new Date(input.now.getTime() + TOKEN_DAYS * 86_400_000).toISOString(),
    })
    .where(and(eq(interviews.id, iv.id), inArray(interviews.status, ["cancelled", "offer_expired"]), eq(interviews.attempt, iv.attempt)))
    .returning();
  if (!fresh) return { ok: false, reason: "interview_changed" };
  // Nothing is booked, so the interviewers are back to invited until the workflow books a time.
  await q.update(interviewParticipants).set({ status: "invited" }).where(eq(interviewParticipants.interviewId, iv.id));
  await emit(q, { type: "interview.rescheduled", companyId: iv.companyId, actor: input.actor, subject: { type: "interview", id: iv.id }, payload: { byCandidate: false, attempt: fresh.attempt, hadEvents: false, newTimes: true, via: input.via, followUpId: f.id } });

  const [app] = await q.select({ roleId: applications.roleId, candidateId: applications.candidateId }).from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
  const [cand] = await q.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const first = cand?.firstName || "The candidate";
  const full = `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "the candidate";
  await notify(q, {
    companyId: iv.companyId,
    kind: "interview.new_times",
    title: `New times are being set up for ${full}`,
    body: input.offerKind === "new_times_asked"
      ? `${iv.title}. ${first} cancelled and asked for new times; times are offered from your calendar or declared hours, and you will be told when one is booked.`
      : `${iv.title}. Your team is offering new times from your calendar or declared hours; you will be told when one is booked.`,
    action: { label: "Open the interview", href: `/interviews/${iv.id}` },
    userIds: [...stay],
  });
  const { runId } = await engine.start(q, {
    workflowKey: "schedule_interview",
    companyId: iv.companyId,
    subject: { type: "interview", id: iv.id },
    state: { interviewId: iv.id, applicationId: iv.applicationId, roleId: app.roleId, roundKey: iv.roundKey, attempt: fresh.attempt, offerKind: input.offerKind, followUpId: f.id, via: input.via },
    idempotencyKey: `schedule:${iv.id}:${fresh.attempt}`,
    actor: input.actor,
  });
  // The interview that carries their new times. Nothing counts as sent yet: that waits for the email (`newTimesOffered`).
  await setCurrentInterview(q, { followUpId: f.id, interviewId: iv.id });
  return { ok: true, interviewId: iv.id, attempt: fresh.attempt, runId };
}

/** Why the automatic set is stopped while it is being prepared: a reply asking for a person or saying no, or an ITS takeover. */
export type PreparedStopReason = "candidate_replied" | "takeover";
/** A times email in these states still waits (for the ITS check, or for the worker), so it can be withdrawn. */
const EMAIL_WAITING = ["held", "queued"];
/** A times email in these states never left: nothing reached the candidate. */
const EMAIL_NEVER_LEFT = ["failed", "cancelled"];
const STOPPED_BEFORE_SENT = "the new times were stopped before they went out";

/**
 * Withdraws the times email of an interview's attempt while it still waits: held for the ITS check, or queued once ITS
 * confirmed the company and not yet claimed by the worker. Guarded as the worker's claim is (queued to sending), so
 * whichever comes first wins. True when nothing of it left (withdrawn now, never written, or never sent); false when it
 * is on its way or gone, which cannot be called back.
 */
async function withdrawTimesEmail(q: Queryable, iv: { id: string; attempt: number; companyId: string; applicationId: string }, actor: Actor): Promise<boolean> {
  const key = `slots:${iv.id}:${iv.attempt}`;
  const [email] = await q.select({ status: communications.status }).from(communications).where(eq(communications.idempotencyKey, key)).limit(1);
  if (!email || EMAIL_NEVER_LEFT.includes(email.status)) return true;
  const withdrawn = await q.update(communications).set({ status: "cancelled", error: STOPPED_BEFORE_SENT }).where(and(eq(communications.idempotencyKey, key), inArray(communications.status, EMAIL_WAITING))).returning({ id: communications.id, correlationId: communications.correlationId });
  for (const m of withdrawn) await emit(q, { type: "message.cancelled", companyId: iv.companyId, actor, subject: { type: "communication", id: m.id }, payload: { template: "interview_slots", channel: "email", applicationId: iv.applicationId, reason: STOPPED_BEFORE_SENT }, correlationId: m.correlationId });
  return withdrawn.length > 0;
}

/**
 * Stops the one automatic set while it is being prepared, before its email has left (founder questions 7 and 8): the
 * candidate replied asking for a person or saying no, or an ITS recruiter took the role over. Its times email, held for
 * the ITS check or released and not yet sent, is withdrawn first; the set ends not sent with that reason and the interview
 * it reopened goes back to cancelled (`withdrawNewTimesInterview`), so nothing is offered. Left as they are (null): a
 * person's own re-offer of that interview ("Offer new times"), a time someone booked for the candidate on their behalf
 * (both are a person's acts, not the automatic set's), and an email already on its way, which cannot be called back.
 * Call holding the application's and the follow-up's locks.
 */
export async function stopPreparedNewTimes(q: Queryable, input: { followUp: FollowUpRow; reason: PreparedStopReason; actor: Actor; now: Date }): Promise<FollowUpRow | null> {
  const f = input.followUp;
  if (f.resolvedAt || f.autoState !== "preparing") return null;
  const [iv] = f.currentInterviewId ? await q.select().from(interviews).where(eq(interviews.id, f.currentInterviewId)).limit(1) : [];
  if (iv && (iv.status === "proposed" || iv.status === "scheduling")) {
    const [run] = await q.select({ state: workflowRuns.state }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `schedule:${iv.id}:${iv.attempt}`)).limit(1);
    if (run && (run.state as { via?: string }).via !== "auto") return null;
    if (iv.selectedSlot) return null;
    if (!(await withdrawTimesEmail(q, iv, input.actor))) return null;
  }
  const row = await setAutoState(q, { followUpId: f.id, to: "not_sent", reason: input.reason, actor: input.actor, now: input.now });
  await withdrawNewTimesInterview(q, { followUp: row, reason: input.reason, actor: input.actor });
  return row;
}

/**
 * The interview the automatic set reopened goes back to cancelled once the set was stopped before its email left
 * (`stopPreparedNewTimes`): a new attempt, so its scheduling run ends at its next step, and a times email that still
 * waits is withdrawn. Nothing goes to the candidate (they were offered nothing; their link says there is nothing to
 * pick), and they stay under Cancelled for a person. The interviewers, told new times were being set up, hear it is off.
 * False when the interview is not being set up (nothing to withdraw).
 */
export async function withdrawNewTimesInterview(q: Queryable, input: { followUp: FollowUpRow; reason: PreparedStopReason; actor: Actor }): Promise<boolean> {
  const f = input.followUp;
  if (!f.currentInterviewId) return false;
  const [iv] = await q.select().from(interviews).where(eq(interviews.id, f.currentInterviewId)).limit(1);
  if (!iv || (iv.status !== "proposed" && iv.status !== "scheduling")) return false;
  // The times worked out were never offered (their email had not left), so none are kept as "offered": a later decision
  // message never names this interview as one they knew about.
  const [off] = await q.update(interviews).set({ status: "cancelled", attempt: iv.attempt + 1, selectedSlot: null, offeredSlots: [] }).where(and(eq(interviews.id, iv.id), eq(interviews.attempt, iv.attempt), inArray(interviews.status, ["proposed", "scheduling"]))).returning({ id: interviews.id });
  if (!off) return false;
  await withdrawTimesEmail(q, iv, input.actor);
  await emit(q, { type: "interview.cancelled", companyId: iv.companyId, actor: input.actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: false, hadEvents: false, candidateTold: false, cause: "new_times_stopped", followUpId: f.id } });
  const parts = await q.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
  if (parts.length) {
    const [cand] = await q.select({ firstName: candidates.firstName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(applications.id, iv.applicationId)).limit(1);
    const first = cand?.firstName || "The candidate";
    const why = input.reason === "takeover" ? "An ITS recruiter is running this role now, so the new times did not go out" : `${first} replied to us before the new times went out, so they were stopped`;
    await notify(q, { companyId: iv.companyId, kind: "interview.cancelled", title: `Interview cancelled: ${iv.title}`, body: `${why}, and this interview is off. Nothing is booked on your calendar.`, action: { label: "Open interviews", href: "/interviews" }, userIds: parts.map((p) => p.userId) });
  }
  return true;
}

/**
 * The automatic set did not go because an ITS recruiter is running the role (founder question 7): the team is told why,
 * and ITS is asked to arrange the next time with the candidate, who asked for new times. The request goes to the ITS
 * queue like any other, and whoever picks it up may not be the recruiter running the role, so it says an ITS recruiter
 * is running it rather than "you".
 */
export async function newTimesStoppedByTakeover(q: Queryable, input: { followUp: FollowUpRow; actor: Actor; now: Date; workflowRunId?: string | null }): Promise<void> {
  const f = input.followUp;
  await notifyNewTimesNotSent(q, { followUp: f, reason: "takeover" });
  const [who] = await q.select({ first: candidates.firstName, last: candidates.lastName, roleId: applications.roleId, roleTitle: roles.title }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).innerJoin(roles, eq(roles.id, applications.roleId)).where(eq(applications.id, f.applicationId)).limit(1);
  if (!who) return;
  const name = `${who.first} ${who.last}`.trim() || "A candidate";
  await createEscalation(q, { companyId: f.companyId, roleId: who.roleId, applicationId: f.applicationId, kind: "candidate_issue", summaryOrigin: "system", question: `${name} cancelled their interview for ${who.roleTitle} and asked for new times. An ITS recruiter is running this role, so no times went to them automatically. Please arrange the next interview time with ${who.first || "them"}.`, requestedBy: input.actor, workflowRunId: input.workflowRunId ?? null, now: input.now });
}
