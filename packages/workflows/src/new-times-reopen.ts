import { and, eq, inArray, ne } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { defaultSchedulingWindow, emit, notify, setCurrentInterview, type FollowUpRow } from "@ros/core";
import { applications, candidates, companies, interviewParticipants, interviews, memberships, type Queryable } from "@ros/db";
import type { SlotsVariant } from "@ros/agents";
import type { WorkflowEngine } from "./engine";

/** Which new-times opening the reopened interview's times email uses (packages/agents interview-messages.ts). */
export type NewTimesOfferKind = Exclude<SlotsVariant, "first">;
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
  const window = { ...defaultSchedulingWindow(input.now, company?.timezone ?? "UTC"), ...(iv.schedulingWindow.candidateTimezone ? { candidateTimezone: iv.schedulingWindow.candidateTimezone } : {}) };
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
