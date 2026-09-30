import { and, eq } from "drizzle-orm";
import { computeSlots, createEscalation, emit, notify, slotStillFree, transition } from "@ros/core";
import { applications, candidates, companies, interviewParticipants, interviews, rolePackets, roles } from "@ros/db";
import { constraintsFor, createInterviewEvents, participantsOf, queueCommunication, sendInterviewConfirmation, sendInterviewReminder, sendSlotsOffered, sendSlotsReminder } from "@ros/agents";
import { randomToken } from "@ros/db";
import type { StepContext, WorkflowDefinition } from "../types";

type State = { interviewId: string; applicationId: string; roleId: string; roundKey: string; attempt: number; remindedAt?: string; offeredAt?: string };

const OFFER_WAIT_HOURS = 48;
const REMIND_WAIT_HOURS = 48;
const TOKEN_DAYS = 14;
const AVAILABILITY_WAIT_HOURS = 48;
const MAX_BOOKING_ATTEMPTS = 3;

/**
 * docs/06 `schedule_interview` (slice 5 step 9). A person approved the round (policy `interview.request`); from here the
 * workflow proposes times, offers them to the candidate, books on every connected calendar, confirms with an
 * invitation, reminds, and closes. Every send is idempotent per interview and attempt; every step re-reads the
 * interview so a reschedule or cancellation from a route ends an old run cleanly.
 */
async function load(ctx: StepContext<State>) {
  const [iv] = await ctx.q.select().from(interviews).where(eq(interviews.id, ctx.state.interviewId)).limit(1);
  if (!iv) return null;
  const [app] = await ctx.q.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
  const [candidate] = await ctx.q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await ctx.q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await ctx.q.select().from(companies).where(eq(companies.id, iv.companyId)).limit(1);
  const [pv] = await ctx.q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  const participants = await participantsOf(ctx.q, iv.id);
  const round = pv?.packet.interviews.plan.find((r) => r.key === iv.roundKey) ?? null;
  return { iv, app, candidate, role, company, packet: pv?.packet ?? null, participants, round };
}
type Bundle = NonNullable<Awaited<ReturnType<typeof load>>>;

function stale(b: Bundle, ctx: StepContext<State>): boolean {
  return b.iv.attempt !== ctx.state.attempt || ["cancelled", "completed", "no_show"].includes(b.iv.status);
}
function candidateTz(b: Bundle): string {
  return b.iv.schedulingWindow.candidateTimezone ?? b.candidate.location?.timezone ?? b.company.timezone;
}
function messageInput(b: Bundle, ctx: StepContext<State>) {
  return { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet!, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.appBaseUrl, interview: b.iv, interviewerFirstNames: b.participants.map((p) => p.firstName), candidateTimezone: candidateTz(b), companyTimezone: b.company.timezone };
}
function windowOf(b: Bundle): { fromDate: string; toDate: string; businessDaysOnly: boolean } {
  const w = b.iv.schedulingWindow;
  return { fromDate: w.fromDate!, toDate: w.toDate!, businessDaysOnly: w.businessDaysOnly ?? true };
}
function rangeOf(w: { fromDate: string; toDate: string }) {
  return { start: `${w.fromDate}T00:00:00.000Z`, end: new Date(Date.parse(`${w.toDate}T00:00:00.000Z`) + 2 * 86_400_000).toISOString() };
}
async function gatherConstraints(b: Bundle, ctx: StepContext<State>) {
  const range = rangeOf(windowOf(b));
  const out = [];
  for (const p of b.participants) out.push(await constraintsFor(ctx.q, ctx.services.integrations, { companyId: ctx.companyId, interviewId: b.iv.id, participant: p, range, companyTimezone: b.company.timezone, actor: ctx.actor }));
  return out;
}
function hoursFromNow(ctx: StepContext<State>, h: number): string {
  return new Date(ctx.now.getTime() + h * 3600_000).toISOString();
}

export const scheduleInterview: WorkflowDefinition<State> = {
  key: "schedule_interview",
  version: 1,
  initialStep: "prepare",
  maxAttempts: 5,
  escalationKind: "candidate_issue",
  steps: {
    async prepare(ctx) {
      const b = await load(ctx);
      if (!b) return { kind: "fail", error: "interview not found", retryable: false };
      if (stale(b, ctx)) return { kind: "complete" };
      if (!["proposed", "scheduling"].includes(b.iv.status)) return { kind: "fail", error: `interview is ${b.iv.status}; nothing to schedule`, retryable: false };
      if (!b.packet || !b.round) return { kind: "fail", error: "the interview round is not in the approved packet", retryable: false };
      if (!b.participants.length) return { kind: "fail", error: "no interviewers on the interview", retryable: false };
      const constraints = await gatherConstraints(b, ctx);
      if (constraints.every((c) => c.source === "none")) {
        if (!(await ctx.alreadyDone("prepare"))) {
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_availability", title: `Nobody's availability is known for ${b.candidate.firstName}'s interview`, body: `${b.participants.map((p) => p.firstName).join(", ")} need to connect a calendar or declare hours before times can be offered.`, action: { label: "Open Setup", href: "/setup" } });
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.declare_availability", title: "Tell us when you can interview", body: `${b.candidate.firstName} ${b.candidate.lastName} is waiting for interview times for ${b.role.title}. Connect your calendar or declare your hours.`, action: { label: "My availability", href: "/setup" }, userIds: b.participants.map((p) => p.userId) });
        }
        return { kind: "wait", wait: { kind: "event", eventTypes: ["availability.updated"], until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "waiting for an interviewer's availability" }, resumeStep: "prepare" };
      }
      return { kind: "next", step: "propose_slots" };
    },

    async propose_slots(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      const constraints = await gatherConstraints(b, ctx);
      const w = windowOf(b);
      const { slots } = computeSlots({ participants: constraints, durationMinutes: b.iv.durationMinutes, fromDate: w.fromDate, toDate: w.toDate, companyTimezone: b.company.timezone, businessDaysOnly: w.businessDaysOnly, now: ctx.now });
      if (!slots.length) {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_slots", title: `No common times for ${b.candidate.firstName}'s interview`, body: `Between ${w.fromDate} and ${w.toDate} the interviewers have no shared free time of ${b.iv.durationMinutes} minutes. Widen the window, change interviewers, or free some time.`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["availability.updated", "window.updated"], subjectId: b.iv.id, until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "no common free time; waiting for availability or a wider window" }, resumeStep: "propose_slots" };
      }
      await ctx.q.update(interviews).set({ offeredSlots: slots, selectedSlot: null, status: "scheduling" }).where(eq(interviews.id, b.iv.id));
      return { kind: "next", step: "offer_slots" };
    },

    async offer_slots(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (!b.iv.scheduleToken || !b.iv.scheduleTokenExpiresAt || Date.parse(b.iv.scheduleTokenExpiresAt) < ctx.now.getTime()) {
        await ctx.q.update(interviews).set({ scheduleToken: randomToken(24), scheduleTokenExpiresAt: new Date(ctx.now.getTime() + TOKEN_DAYS * 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
      }
      const fresh = (await load(ctx))!;
      const sent = await sendSlotsOffered(ctx.q, ctx.services.integrations, messageInput(fresh, ctx));
      if (sent.status === "failed" && sent.retryable) return { kind: "fail", error: `slots email failed: ${sent.error}`, retryable: true };
      if (sent.status === "failed") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.unreachable", title: `${b.candidate.firstName} ${b.candidate.lastName} cannot be reached by email`, body: "Offer the times by phone, or pick one on their behalf from the interview page.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
      }
      await emit(ctx.q, { type: "interview.slots_offered", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt, slots: fresh.iv.offeredSlots.length, expiresAt: fresh.iv.scheduleTokenExpiresAt }, correlationId: ctx.run.id });
      return { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected", "interview.none_work"], subjectId: b.iv.id, until: hoursFromNow(ctx, OFFER_WAIT_HOURS), reason: "waiting for the candidate to pick a time" }, state: { offeredAt: ctx.now.toISOString(), remindedAt: undefined }, resumeStep: "after_offer" };
    },

    async after_offer(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (b.iv.selectedSlot) return { kind: "next", step: "book" };
      if (ctx.wake?.kind === "event" && ctx.wake.key?.endsWith("interview.none_work")) {
        const note = b.iv.candidateAvailability?.note ? ` They wrote: "${b.iv.candidateAvailability.note}"` : "";
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.none_work", title: `${b.candidate.firstName} asked for other interview times`, body: `None of the offered times worked.${note} Widen the window or free some time; new times go out as soon as they exist.`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["window.updated", "availability.updated"], subjectId: b.iv.id, until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "the candidate asked for other times" }, resumeStep: "propose_slots" };
      }
      if (ctx.wake?.kind === "event") return { kind: "next", step: "book" };
      if (!ctx.state.remindedAt) return { kind: "next", step: "remind" };
      return { kind: "next", step: "expire_offer" };
    },

    async remind(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (b.iv.selectedSlot) return { kind: "next", step: "book" };
      const sent = await sendSlotsReminder(ctx.q, ctx.services.integrations, messageInput(b, ctx));
      if (sent.status === "failed" && sent.retryable) return { kind: "fail", error: `reminder failed: ${sent.error}`, retryable: true };
      await emit(ctx.q, { type: "interview.slots_reminded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      return { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected", "interview.none_work"], subjectId: b.iv.id, until: hoursFromNow(ctx, REMIND_WAIT_HOURS), reason: "reminded; waiting for the candidate" }, state: { remindedAt: ctx.now.toISOString() }, resumeStep: "after_offer" };
    },

    async expire_offer(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (b.iv.selectedSlot) return { kind: "next", step: "book" };
      await ctx.q.update(interviews).set({ status: "offer_expired", scheduleToken: null, scheduleTokenExpiresAt: null }).where(eq(interviews.id, b.iv.id));
      await emit(ctx.q, { type: "interview.offer_expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.offer_expired", title: `${b.candidate.firstName} ${b.candidate.lastName} did not pick an interview time`, body: "Four days passed with a reminder. Offer times again, decide, or bring in a recruiter.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
      return { kind: "complete" };
    },

    async book(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      const slot = b.iv.selectedSlot;
      if (!slot) return { kind: "next", step: "offer_slots" };
      const constraints = await gatherConstraints(b, ctx);
      if (!slotStillFree(slot, constraints)) {
        await emit(ctx.q, { type: "interview.slot_taken", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, attempt: ctx.state.attempt }, correlationId: ctx.run.id });
        const nextAttempt = b.iv.attempt + 1;
        await ctx.q.update(interviews).set({ selectedSlot: null, attempt: nextAttempt }).where(eq(interviews.id, b.iv.id));
        if (nextAttempt > MAX_BOOKING_ATTEMPTS) {
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.stuck", title: `Times keep colliding for ${b.candidate.firstName}'s interview`, body: "Three chosen times were taken by the time we booked them. A recruiter has been asked to sort it out with the candidate.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
          await createEscalation(ctx.q, { companyId: ctx.companyId, roleId: b.role.id, applicationId: b.app.id, kind: "candidate_issue", question: `${b.candidate.firstName} ${b.candidate.lastName} chose three interview times that were each taken by booking time (${b.role.title}). Please arrange a time directly.`, requestedBy: ctx.actor, workflowRunId: ctx.run.id, summaryOrigin: "system" });
          return { kind: "complete" };
        }
        return { kind: "next", step: "propose_slots", state: { attempt: nextAttempt } };
      }
      await ctx.q.update(interviews).set({ startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: b.company.timezone }).where(eq(interviews.id, b.iv.id));
      const fresh = (await load(ctx))!;
      const { refs, meetingUrl } = await createInterviewEvents(ctx.q, ctx.services.integrations, { interview: fresh.iv, participants: fresh.participants, candidate: fresh.candidate, roleTitle: fresh.role.title, companyName: fresh.company.name, companyTimezone: fresh.company.timezone, actor: ctx.actor, appBaseUrl: ctx.services.env.appBaseUrl });
      await ctx.q.update(interviews).set({ status: "scheduled", calendarRefs: refs, meetingUrl: meetingUrl ?? fresh.iv.meetingUrl, scheduleTokenExpiresAt: new Date(Date.parse(slot.endsAt) + 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
      // The interviewers were "invited" when the round was approved; a booked time confirms them (a reschedule invites them again).
      await ctx.q.update(interviewParticipants).set({ status: "confirmed" }).where(eq(interviewParticipants.interviewId, b.iv.id));
      if (fresh.app.stage !== "interview_scheduled") await transition(ctx.q, { applicationId: b.app.id, companyId: ctx.companyId, to: "interview_scheduled", by: "system", actor: ctx.actor, reason: "interview booked", correlationId: ctx.run.id });
      await emit(ctx.q, { type: "interview.booked", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, calendars: Object.keys(refs).length, attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      return { kind: "next", step: "confirm" };
    },

    async confirm(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx) || b.iv.status !== "scheduled") return { kind: "complete" };
      const sent = await sendInterviewConfirmation(ctx.q, ctx.services.integrations, { ...messageInput(b, ctx), roundPurpose: b.round?.purpose ?? "Come ready to talk about your experience." });
      if (sent.status === "failed" && sent.retryable) return { kind: "fail", error: `confirmation failed: ${sent.error}`, retryable: true };
      if (!(await ctx.alreadyDone("confirm"))) {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.confirmed", title: `Interview booked: ${b.candidate.firstName} ${b.candidate.lastName}, ${b.iv.title}`, body: `${new Date(b.iv.startsAt!).toLocaleString("en-US", { timeZone: b.company.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${b.company.timezone}).${b.iv.meetingUrl ? ` Join: ${b.iv.meetingUrl}` : ""}`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.confirmed", title: `Interview booked: ${b.candidate.firstName} ${b.candidate.lastName}, ${b.iv.title}`, body: `${new Date(b.iv.startsAt!).toLocaleString("en-US", { timeZone: b.company.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} with ${b.participants.map((p) => p.firstName).join(", ")}.`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        for (const p of b.participants) {
          // Team mail leaves through the outbox too: recorded here, sent after this step commits, never twice per attempt.
          await queueCommunication(ctx.q, ctx.services.integrations, { channel: "email", companyId: ctx.companyId, to: p.email, from: `${ctx.services.integrations.env.productName} <${ctx.services.integrations.env.fromAddress}>`, subject: `Interview booked: ${b.candidate.firstName} ${b.candidate.lastName} for ${b.role.title}`, text: `${b.iv.title} on ${new Date(b.iv.startsAt!).toLocaleString("en-US", { timeZone: b.company.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${b.company.timezone}).${b.iv.meetingUrl ? `\nJoin: ${b.iv.meetingUrl}` : ""}\n\nOpen: ${ctx.services.env.appBaseUrl}/interviews/${b.iv.id}`, templateKey: "interview_confirmed_interviewer", idempotencyKey: `iv_confirm_int:${b.iv.id}:${b.iv.attempt}:${p.userId}`, tags: { template: "interview_confirmed_interviewer" }, actor: ctx.actor, correlationId: ctx.run.id }, ctx.now);
        }
      }
      await emit(ctx.q, { type: "interview.confirmed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { startsAt: b.iv.startsAt, attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      return { kind: "next", step: "on_timer" };
    },

    async on_timer(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx) || b.iv.status !== "scheduled" || !b.iv.startsAt || !b.iv.endsAt) return { kind: "complete" };
      const start = Date.parse(b.iv.startsAt);
      const end = Date.parse(b.iv.endsAt);
      const checkpoints: Array<{ key: "before24h" | "before2h" | "close"; at: number }> = [{ key: "before24h", at: start - 24 * 3600_000 }, { key: "before2h", at: start - 2 * 3600_000 }, { key: "close", at: end + 3600_000 }];
      const reminders = { ...(b.iv.reminders ?? {}) };
      for (const cp of checkpoints) {
        if (cp.at > ctx.now.getTime() || reminders[cp.key]) continue;
        if (cp.key === "close") return { kind: "next", step: "close" };
        // a reminder inside the last hour before the start is noise; skip it
        if (start - ctx.now.getTime() < 45 * 60_000) { reminders[cp.key] = "skipped"; continue; }
        const sent = await sendInterviewReminder(ctx.q, ctx.services.integrations, { ...messageInput(b, ctx), which: cp.key });
        if (sent.status === "failed" && sent.retryable) return { kind: "fail", error: `reminder failed: ${sent.error}`, retryable: true };
        reminders[cp.key] = ctx.now.toISOString();
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.reminder", title: `${cp.key === "before24h" ? "Tomorrow" : "In two hours"}: ${b.candidate.firstName} ${b.candidate.lastName}, ${b.iv.title}`, body: b.iv.meetingUrl ? `Join: ${b.iv.meetingUrl}` : "See the interview page for details.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
        await emit(ctx.q, { type: "interview.reminder_sent", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { which: cp.key }, correlationId: ctx.run.id });
      }
      await ctx.q.update(interviews).set({ reminders }).where(eq(interviews.id, b.iv.id));
      const next = checkpoints.filter((cp) => !reminders[cp.key] && cp.at > ctx.now.getTime()).sort((a, c) => a.at - c.at)[0];
      if (!next) return { kind: "next", step: "close" };
      return { kind: "wait", wait: { kind: "timer", until: new Date(next.at).toISOString(), reason: `next: ${next.key}` }, resumeStep: "on_timer" };
    },

    async close(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx) || b.iv.status !== "scheduled") return { kind: "complete" };
      await ctx.q.update(interviews).set({ status: "completed" }).where(eq(interviews.id, b.iv.id));
      if (b.app.stage === "interview_scheduled") await transition(ctx.q, { applicationId: b.app.id, companyId: ctx.companyId, to: "interview_complete", by: "system", actor: ctx.actor, reason: "interview ended", correlationId: ctx.run.id });
      await emit(ctx.q, { type: "interview.completed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.outcome", title: `Did the interview with ${b.candidate.firstName} ${b.candidate.lastName} take place?`, body: "Tell us if it happened or someone did not show; it keeps the record straight.", action: { label: "Record what happened", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
      await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.decision", title: `How did it go with ${b.candidate.firstName} ${b.candidate.lastName}?`, body: `${b.iv.title} is over. Next round, finalist, or not moving forward: your call, recorded with your reason.`, action: { label: "Decide", href: `/roles/${b.role.id}/talent?open=${b.app.id}` } });
      return { kind: "complete" };
    },
  },
};
