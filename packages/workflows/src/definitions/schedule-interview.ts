import { and, eq, inArray, isNull } from "drizzle-orm";
import type { MembershipRole } from "@ros/contracts";
import { can, computeSlots, createEscalation, emit, freshSchedulingWindow, holidaysBetween, loadBusinessCalendar, missingAvailability, newTimesOffered, noCommonTimesNoticeKey, notify, openFollowUpOf, roleTakenOver, slotStillAhead, slotStillFree, transition } from "@ros/core";
import { applications, candidates, communications, companies, interviewFollowups, interviewParticipants, interviews, memberships, rolePackets, roles } from "@ros/db";
import { AUTO_TIMES_TAKEN_OVER, HELD_REASON, composeInterviewerBrief, constraintsFor, createInterviewEvents, participantsOf, queueCommunication, redactBriefPay, renderInterviewerBriefText, sendInterviewConfirmation, sendInterviewReminder, sendSlotsOffered, sendSlotsReminder, type InvitationNote } from "@ros/agents";
import { randomToken } from "@ros/db";
import { newTimesStoppedByTakeover, stopPreparedNewTimes, withdrawNewTimesInterview, type NewTimesOfferKind, type NewTimesVia } from "../new-times-reopen";
import type { StepContext, WorkflowDefinition } from "../types";

/**
 * `invitationNote`: a personal line for the invitation (founder decision Q28), written by the person who approved the
 * interview or suggested by the assistant and kept by them (`aiHelped`; the email then says so). The interview request
 * route checks it (`checkPersonalLine`) and puts it here; the first attempt's invitation carries it.
 *
 * `offerKind`, `followUpId` and `via`: the interview carries new times for someone under Cancelled (founder decisions
 * 2A and 4A), set when the automatic set or a person reopens it, or a person approves a new one for them. The times
 * email then uses the new-times opening, and counts as sent for the follow-up only once it is on its way.
 *
 * Recovery (F2, 15 Oct 2026):
 * - `rescheduled`: the team moved the interview; the times email uses the "new times" opening.
 * - `freshWindow`: times are worked out again after a wait (availability that arrived late, no common times, "none of
 *   these work"): over a fresh window from tomorrow, as long as the old one, never the old dates.
 * - `otherTimes`: the candidate said none of the offered times work; times that differ go out as a new attempt, so the
 *   candidate gets a new email (`variant` "other_times").
 * - `collisions`: chosen times that were taken by booking time, in this run; the third brings in a recruiter.
 * - `bookPick`: a time was picked (by the candidate, or for them) while no run waited for a pick; this run books it.
 * - `rejected`: the start times the candidate said none of worked; never offered to them again as "other times".
 * - `availabilityWaits`, `availabilityEscalated`: how many 48-hour waits passed with a required interviewer's hours
 *   still missing (the owner is reminded at each), and whether a recruiter was brought in (after the second).
 * - `noNewTimesTold`: the owner was told once that no time other than the rejected ones is free yet.
 * - `noCommonTimesKey`: the key (core `noCommonTimesNoticeKey`) the last "No common times" notice went out under; the
 *   notice goes again only when the key changes (audit 06-interviews, bug 105).
 * - `heldForCheck`: the times email waits for the ITS company check; its link is kept when the run resumes.
 */
type State = { interviewId: string; applicationId: string; roleId: string; roundKey: string; attempt: number; remindedAt?: string; offeredAt?: string; invitationNote?: InvitationNote | null; offerKind?: NewTimesOfferKind; followUpId?: string; via?: NewTimesVia; rescheduled?: boolean; freshWindow?: boolean; otherTimes?: boolean; variant?: "other_times"; collisions?: number; bookPick?: boolean; rejected?: string[]; availabilityWaits?: number; availabilityEscalated?: boolean; noNewTimesTold?: boolean; noCommonTimesKey?: string; heldForCheck?: boolean };

const OFFER_WAIT_HOURS = 48;
const REMIND_WAIT_HOURS = 48;
const TOKEN_DAYS = 14;
const AVAILABILITY_WAIT_HOURS = 48;
/** Chosen times taken by booking time before a recruiter is asked to arrange it (real collisions only, never reschedules). */
const MAX_COLLISIONS = 3;

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

/** A newer attempt took over, or the interview is over or cancelled: this run has nothing more to do. */
function superseded(b: Bundle, ctx: StepContext<State>): boolean {
  return b.iv.attempt !== ctx.state.attempt || ["cancelled", "completed", "no_show"].includes(b.iv.status);
}
/** The candidate left the process (declined, withdrew, hired, talent pool) or the role closed (plan A9): nothing more goes to them. */
function leftProcess(b: Bundle): boolean {
  return ["hired", "withdrawn", "rejected", "declined", "talent_pool"].includes(b.app.stage) || ["closed", "filled"].includes(b.role.status);
}
function stale(b: Bundle, ctx: StepContext<State>): boolean {
  return superseded(b, ctx) || leftProcess(b);
}
function candidateTz(b: Bundle): string {
  return b.iv.schedulingWindow.candidateTimezone ?? b.candidate.location?.timezone ?? b.company.timezone;
}
function messageInput(b: Bundle, ctx: StepContext<State>) {
  return { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet!, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.appBaseUrl, interview: b.iv, interviewerFirstNames: b.participants.map((p) => p.firstName), candidateTimezone: candidateTz(b), companyTimezone: b.company.timezone };
}
type Window = { fromDate: string; toDate: string; businessDaysOnly: boolean };
function windowOf(b: Bundle): Window {
  const w = b.iv.schedulingWindow;
  return { fromDate: w.fromDate!, toDate: w.toDate!, businessDaysOnly: w.businessDaysOnly ?? true };
}
/** A window of the slot's own days, a day either side: where its busy time is read at booking. */
function aroundSlot(slot: { startsAt: string; endsAt: string }, businessDaysOnly: boolean): Window {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { fromDate: day(Date.parse(slot.startsAt) - 86_400_000), toDate: day(Date.parse(slot.endsAt) + 86_400_000), businessDaysOnly };
}
function rangeOf(w: { fromDate: string; toDate: string }) {
  return { start: `${w.fromDate}T00:00:00.000Z`, end: new Date(Date.parse(`${w.toDate}T00:00:00.000Z`) + 2 * 86_400_000).toISOString() };
}
async function gatherConstraints(b: Bundle, ctx: StepContext<State>, window: Window = windowOf(b)) {
  const range = rangeOf(window);
  const out = [];
  for (const p of b.participants) out.push(await constraintsFor(ctx.q, ctx.services.integrations, { companyId: ctx.companyId, interviewId: b.iv.id, participant: p, range, companyTimezone: b.company.timezone, actor: ctx.actor }));
  return out;
}
function hoursFromNow(ctx: StepContext<State>, h: number): string {
  return new Date(ctx.now.getTime() + h * 3600_000).toISOString();
}
/**
 * Locks the application before this step changes the interview and moves the stage: every path that changes both takes
 * the application first (a team cancel, the candidate's own cancel, a send of new times). False when the interview
 * changed while this step waited for the lock (cancelled, or a newer attempt), so the step ends instead.
 */
async function stillOursAfterLock(ctx: StepContext<State>, b: Bundle): Promise<boolean> {
  await ctx.q.select({ id: applications.id }).from(applications).where(eq(applications.id, b.app.id)).limit(1).for("update");
  const [current] = await ctx.q.select({ status: interviews.status, attempt: interviews.attempt }).from(interviews).where(eq(interviews.id, b.iv.id)).limit(1);
  return !!current && current.status === b.iv.status && current.attempt === ctx.state.attempt;
}

/**
 * The one automatic set of new times, checked again just before its email is written (founder questions 7 and 8), under
 * the application's and the follow-up's locks (the order every path takes them). A set stopped while it was being
 * prepared (the candidate replied asking for a person or saying no) sends nothing; an ITS recruiter who took the role over
 * since stops it here, and the team is told and the recruiter brought in. That includes a takeover that began while its
 * email waited for the ITS check: the outbox withdrew the email when ITS confirmed the company (`AUTO_TIMES_TAKEN_OVER`).
 * Either way the interview goes back to cancelled and this run ends; so does an interview that changed while this step
 * waited for the lock. False when the email goes as usual, which includes a set already sent being offered again (after
 * "none of these work", or a picked time that was taken) and a times email already on its way.
 */
async function automaticSetStops(ctx: StepContext<State>, b: Bundle): Promise<boolean> {
  if (!(await stillOursAfterLock(ctx, b))) return true;
  const [f] = await ctx.q.select().from(interviewFollowups).where(eq(interviewFollowups.id, ctx.state.followUpId!)).limit(1).for("update");
  if (!f || f.resolvedAt || f.currentInterviewId !== b.iv.id) return false;
  if (f.autoState === "not_sent" && (f.autoReason === "candidate_replied" || f.autoReason === "takeover")) {
    await withdrawNewTimesInterview(ctx.q, { followUp: f, reason: f.autoReason, actor: ctx.actor });
    return true;
  }
  if (f.autoState !== "preparing") return false;
  const [email] = await ctx.q.select({ status: communications.status, error: communications.error }).from(communications).where(eq(communications.idempotencyKey, `slots:${b.iv.id}:${b.iv.attempt}`)).limit(1);
  const withdrawnForTakeover = email?.status === "cancelled" && email.error === AUTO_TIMES_TAKEN_OVER;
  if (!withdrawnForTakeover && !(await roleTakenOver(ctx.q, ctx.companyId, b.role.id))) return false;
  const stopped = await stopPreparedNewTimes(ctx.q, { followUp: f, reason: "takeover", actor: ctx.actor, now: ctx.now });
  if (!stopped) return false;
  await newTimesStoppedByTakeover(ctx.q, { followUp: stopped, actor: ctx.actor, now: ctx.now, workflowRunId: ctx.run.id });
  return true;
}

/**
 * True when this candidate's interview just before this one was the same round and our interviewer missed it
 * (outcome `no_show_interviewer`): the first offer of the round again then says sorry (founder decision L-12).
 */
async function missedByUsBefore(ctx: StepContext<State>, b: Bundle): Promise<boolean> {
  const earlier = await ctx.q.select({ id: interviews.id, roundKey: interviews.roundKey, outcome: interviews.outcome, createdAt: interviews.createdAt }).from(interviews).where(eq(interviews.applicationId, b.app.id));
  const before = earlier.filter((r) => r.id !== b.iv.id && new Date(r.createdAt).getTime() <= new Date(b.iv.createdAt).getTime()).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0];
  return !!before && before.roundKey === b.iv.roundKey && before.outcome === "no_show_interviewer";
}

/**
 * An interview our interviewer missed is settled once a new interview for the candidate is approved: it is marked
 * "new times sent" (as a missed interview is when new times go after a candidate's no-show), so the decision card stops
 * asking about it and the next decision lands on the interview that takes place.
 */
async function settleMissedByUs(ctx: StepContext<State>, b: Bundle): Promise<void> {
  const missed = await ctx.q.select({ id: interviews.id, createdAt: interviews.createdAt }).from(interviews).where(and(eq(interviews.applicationId, b.app.id), eq(interviews.status, "no_show"), eq(interviews.outcome, "no_show_interviewer"), isNull(interviews.decision)));
  for (const m of missed) {
    if (m.id === b.iv.id || new Date(m.createdAt).getTime() > new Date(b.iv.createdAt).getTime()) continue;
    await ctx.q.update(interviews).set({ decision: "new_times", decisionNote: "A new interview was approved after our interviewer missed this one" }).where(and(eq(interviews.id, m.id), isNull(interviews.decision)));
  }
}

/** The sentence the team's notices gain while the times being worked out are new times for someone under Cancelled. */
function newTimesSentence(b: Bundle, ctx: StepContext<State>): string {
  if (ctx.state.offerKind === "new_times_asked") return ` ${b.candidate.firstName} cancelled and asked for new times; they go out as soon as there are times to offer.`;
  if (ctx.state.offerKind === "new_times_team") return ` ${b.candidate.firstName} is waiting for new interview times from your team.`;
  return "";
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
      await settleMissedByUs(ctx, b);
      // A time picked while no run waited for a pick (routes/interviews.ts `routePick`): booked straight away, re-checked there.
      if (ctx.state.bookPick && b.iv.status === "scheduling" && b.iv.selectedSlot) return { kind: "next", step: "book", state: { bookPick: false } };
      const constraints = await gatherConstraints(b, ctx);
      // Every required interviewer needs availability: nobody is assumed free 9 to 5. Only an optional interviewer with
      // none is left out of the merge; for anyone else the owner is asked, and the interviewer too.
      const missing = missingAvailability(constraints);
      if (missing.length) {
        // Asked once at first; reminded at each 48-hour wait that passes with the hours still missing (never more often);
        // after the second, a recruiter is brought in, once, so the interview is never stuck with nobody hearing of it.
        const timerWake = ctx.wake?.kind === "timer";
        const waits = (ctx.state.availabilityWaits ?? 0) + (timerWake ? 1 : 0);
        const who = b.participants.filter((p) => missing.some((m) => m.userId === p.userId));
        if (!(await ctx.alreadyDone("prepare")) || timerWake) {
          const all = missing.length === constraints.length;
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_availability", title: all ? `Nobody's availability is known for ${b.candidate.firstName}'s interview` : `${who.map((p) => p.firstName).join(" and ")} ${who.length === 1 ? "has" : "have"} no availability for ${b.candidate.firstName}'s interview`, body: `${timerWake ? "Still waiting: " : ""}${who.map((p) => p.firstName).join(", ")} need to connect a calendar or declare hours before times can be offered.${all ? "" : " The other interviewers are ready."}${newTimesSentence(b, ctx)}`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.declare_availability", title: "Tell us when you can interview", body: `${b.candidate.firstName} ${b.candidate.lastName} is waiting for interview times for ${b.role.title}. Connect your calendar or declare your hours.`, action: { label: "My availability", href: "/setup" }, userIds: who.map((p) => p.userId) });
        }
        let escalated = !!ctx.state.availabilityEscalated;
        if (timerWake && waits >= 2 && !escalated) {
          await createEscalation(ctx.q, { companyId: ctx.companyId, roleId: b.role.id, applicationId: b.app.id, kind: "candidate_issue", question: `${b.candidate.firstName} ${b.candidate.lastName} has been waiting four days for interview times for ${b.role.title}: ${who.map((p) => p.firstName).join(" and ")} ${who.length === 1 ? "has" : "have"} not added any hours or connected a calendar. Please help the team arrange a time.`, requestedBy: ctx.actor, workflowRunId: ctx.run.id, summaryOrigin: "system" });
          escalated = true;
        }
        return { kind: "wait", wait: { kind: "event", eventTypes: ["availability.updated"], until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "waiting for an interviewer's availability" }, state: { freshWindow: true, availabilityWaits: waits, availabilityEscalated: escalated }, resumeStep: "prepare" };
      }
      return { kind: "next", step: "propose_slots", ...(ctx.state.availabilityWaits ? { state: { availabilityWaits: 0 } } : {}) };
    },

    async propose_slots(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      // After a wait the old dates may have passed: a fresh window from tomorrow, as long as the old one, saved on the interview.
      const fresh = ctx.state.freshWindow ? freshSchedulingWindow(b.iv.schedulingWindow, ctx.now, b.company.timezone) : null;
      const w = fresh ?? windowOf(b);
      const constraints = await gatherConstraints(b, ctx, w);
      if (missingAvailability(constraints).length) return { kind: "next", step: "prepare" };
      // Public holidays are left out like weekends (audit 06, bug 104): the business calendar's list, else the US federal one.
      const holidays = holidaysBetween(await loadBusinessCalendar(ctx.q, ctx.now), w.fromDate, w.toDate);
      const computed = computeSlots({ participants: constraints, durationMinutes: b.iv.durationMinutes, fromDate: w.fromDate, toDate: w.toDate, companyTimezone: b.company.timezone, businessDaysOnly: w.businessDaysOnly, holidays, now: ctx.now }).slots;
      // After "none of these work", the times the candidate turned down are never offered to them again as "other times".
      const rejected = new Set([...(ctx.state.rejected ?? []), ...(ctx.state.otherTimes ? b.iv.offeredSlots.map((s) => s.startsAt) : [])]);
      const offeredIds = new Set(b.iv.offeredSlots.map((s) => s.id));
      const slots = ctx.state.otherTimes ? computed.filter((s) => !rejected.has(s.startsAt) && !offeredIds.has(s.id)) : computed;
      if (!slots.length) {
        // After a wait, the times left on the interview are old (some may have passed): taken off, so the pick page says
        // new times are being got ready instead of offering them.
        if (fresh) await ctx.q.update(interviews).set({ schedulingWindow: fresh, offeredSlots: [], selectedSlot: null }).where(and(eq(interviews.id, b.iv.id), eq(interviews.attempt, ctx.state.attempt), inArray(interviews.status, ["proposed", "scheduling"])));
        if (ctx.state.otherTimes && computed.length) {
          // There are free times, but only the ones the candidate turned down: nothing new is emailed. The owner hears once.
          if (!ctx.state.noNewTimesTold) await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_slots", title: `No new times for ${b.candidate.firstName}'s interview yet`, body: `The only free times are the ones ${b.candidate.firstName} said do not work. Add hours or free some time; other times are emailed to them as soon as there are some.${newTimesSentence(b, ctx)}`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
          return { kind: "wait", wait: { kind: "event", eventTypes: ["window.updated", "availability.updated"], subjectId: b.iv.id, until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "the candidate asked for other times; none are free yet" }, state: { freshWindow: true, otherTimes: true, rejected: [...rejected], noNewTimesTold: true }, resumeStep: "propose_slots" };
        }
        // Told once per interview and window, then again only when something changes (an interviewer's hours, the
        // window's length, a new attempt): the 48-hour re-check alone finds the same answer and says nothing.
        const noticeKey = noCommonTimesNoticeKey({ interviewId: b.iv.id, attempt: ctx.state.attempt, durationMinutes: b.iv.durationMinutes, window: w, participants: constraints });
        if (ctx.state.noCommonTimesKey !== noticeKey) await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_slots", title: `No common times for ${b.candidate.firstName}'s interview`, body: `Between ${w.fromDate} and ${w.toDate} the interviewers have no shared free time of ${b.iv.durationMinutes} minutes. Add hours or free some time; we check again when an interviewer's hours change.${newTimesSentence(b, ctx)}`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["availability.updated", "window.updated"], subjectId: b.iv.id, until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "no common free time; waiting for availability or a wider window" }, state: { freshWindow: true, noCommonTimesKey: noticeKey, ...(ctx.state.otherTimes ? { rejected: [...rejected] } : {}) }, resumeStep: "propose_slots" };
      }
      // After "none of these work", times that differ from the ones turned down are a new offer: a new attempt, so the
      // candidate gets a new email (the times email is sent once per attempt).
      const again = !!ctx.state.otherTimes && (rejected.size > 0 || offeredIds.size > 0);
      const attempt = again ? b.iv.attempt + 1 : ctx.state.attempt;
      // Guarded: an interview cancelled or moved on while the times were worked out (a team cancel, new times stopped by a
      // reply) is never put back to "scheduling" here.
      const [proposed] = await ctx.q.update(interviews).set({ offeredSlots: slots, selectedSlot: null, status: "scheduling", ...(fresh ? { schedulingWindow: fresh } : {}), ...(again ? { attempt } : {}) }).where(and(eq(interviews.id, b.iv.id), eq(interviews.attempt, ctx.state.attempt), inArray(interviews.status, ["proposed", "scheduling"]))).returning({ id: interviews.id });
      if (!proposed) return { kind: "complete" };
      return { kind: "next", step: "offer_slots", state: { freshWindow: false, otherTimes: false, ...(again ? { attempt, variant: "other_times" as const } : {}) } };
    },

    async offer_slots(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (ctx.state.followUpId && ctx.state.via === "auto" && (await automaticSetStops(ctx, b))) return { kind: "complete" };
      if (!b.iv.scheduleToken) {
        await ctx.q.update(interviews).set({ scheduleToken: randomToken(24), scheduleTokenExpiresAt: new Date(ctx.now.getTime() + TOKEN_DAYS * 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
      } else if (!b.iv.scheduleTokenExpiresAt || Date.parse(b.iv.scheduleTokenExpiresAt) < ctx.now.getTime()) {
        // An email held for the ITS check already carries this link: it is kept and given more days, so the email
        // released now still opens the times. Otherwise a fresh link.
        await ctx.q.update(interviews).set({ ...(ctx.state.heldForCheck ? {} : { scheduleToken: randomToken(24) }), scheduleTokenExpiresAt: new Date(ctx.now.getTime() + TOKEN_DAYS * 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
      }
      const fresh = (await load(ctx))!;
      // Other times after "none of these work" say so, whatever the offer was; otherwise the offer's own opening. The
      // first offer of a round our interviewer missed opens with an apology (founder decision L-12).
      const chosen = ctx.state.variant ?? ctx.state.offerKind ?? (ctx.state.rescheduled ? "rescheduled" : "first");
      const variant = chosen === "first" && (await missedByUsBefore(ctx, fresh)) ? "missed_by_us" : chosen;
      const sent = await sendSlotsOffered(ctx.q, ctx.services.integrations, { ...messageInput(fresh, ctx), note: ctx.state.invitationNote ?? null, variant });
      if (sent.status === "failed" && sent.retryable) return { kind: "fail", error: `slots email failed: ${sent.error}`, retryable: true };
      const held = sent.status === "pending" && sent.reason === HELD_REASON;
      if (ctx.state.followUpId) {
        // New times for someone under Cancelled count as sent only once their email is on its way (`newTimesOffered`),
        // and once per interview: offering again after a picked time was taken (`offeredAt` is set) moves only the key.
        await newTimesOffered(ctx.q, { followUpId: ctx.state.followUpId, interviewId: fresh.iv.id, attempt: fresh.iv.attempt, outcome: sent.status === "failed" ? "failed" : held ? "held" : "queued", via: ctx.state.via ?? "person", actor: ctx.actor, now: ctx.now, reoffer: !!ctx.state.offeredAt });
      }
      // Held for the ITS check (founder decision B7), a first offer as much as new times (audit 06, bug 12): the
      // candidate cannot see these times, so the 48-hour offer clock does not start. When ITS confirms the company the
      // email is released, this step runs again, finds it on its way, and only then records the offer and starts the clock.
      if (held) {
        // The wait has no deadline (the times have not reached the candidate), so the team is told once, the first time
        // this offer is held (`heldForCheck` not yet set), that the times go out the moment ITS confirms the company.
        if (!ctx.state.heldForCheck) await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.no_availability", title: `${b.candidate.firstName}'s interview times are waiting`, body: `${b.candidate.firstName} ${b.candidate.lastName}'s interview times wait for ITS to confirm your company. They go out the moment it does; nothing else is needed from you.`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["company.verified"], subjectId: ctx.companyId, reason: ctx.state.followUpId ? "the new times wait for ITS to confirm the company" : "the interview times wait for ITS to confirm the company" }, state: { heldForCheck: true }, resumeStep: "offer_slots" };
      }
      if (sent.status === "failed") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.unreachable", title: `${b.candidate.firstName} ${b.candidate.lastName} cannot be reached by email`, body: "Offer the times by phone, or pick one on their behalf from the interview page.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
      }
      await emit(ctx.q, { type: "interview.slots_offered", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt, slots: fresh.iv.offeredSlots.length, expiresAt: fresh.iv.scheduleTokenExpiresAt }, correlationId: ctx.run.id });
      // A time picked while this step ran or waited (the new times' email held for the ITS check, a retry after a failed
      // send, or a pick committed while the email was being written): the pick is not lost; it is booked now.
      const [now] = await ctx.q.select({ selectedSlot: interviews.selectedSlot }).from(interviews).where(eq(interviews.id, b.iv.id)).limit(1);
      if (now?.selectedSlot) return { kind: "next", step: "book", state: { offeredAt: ctx.now.toISOString(), remindedAt: undefined, heldForCheck: false } };
      return { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected", "interview.none_work"], subjectId: b.iv.id, until: hoursFromNow(ctx, OFFER_WAIT_HOURS), reason: "waiting for the candidate to pick a time" }, state: { offeredAt: ctx.now.toISOString(), remindedAt: undefined, heldForCheck: false }, resumeStep: "after_offer" };
    },

    async after_offer(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (b.iv.selectedSlot) return { kind: "next", step: "book" };
      if (ctx.wake?.kind === "event" && ctx.wake.key?.endsWith("interview.none_work")) {
        const note = b.iv.candidateAvailability?.note ? ` They wrote: "${b.iv.candidateAvailability.note}"` : "";
        await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.none_work", title: `${b.candidate.firstName} asked for other interview times`, body: `None of the offered times worked.${note} Add hours or free some time; other times are emailed to them as soon as there are some.`, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
        // Woken by an interviewer saving their availability, or after two days; either way the times are worked out
        // again over a fresh window, and times that differ are emailed to the candidate (`otherTimes`).
        return { kind: "wait", wait: { kind: "event", eventTypes: ["window.updated", "availability.updated"], subjectId: b.iv.id, until: hoursFromNow(ctx, AVAILABILITY_WAIT_HOURS), reason: "the candidate asked for other times" }, state: { freshWindow: true, otherTimes: true, rejected: [...new Set([...(ctx.state.rejected ?? []), ...b.iv.offeredSlots.map((s) => s.startsAt)])] }, resumeStep: "propose_slots" };
      }
      if (ctx.wake?.kind === "event") {
        // A pick: book it. Any other event (a stray wake left from an earlier wait) changes nothing: the offer keeps its
        // own deadline, so the 48-hour clock is never reset and nothing is sent again.
        if (ctx.wake.key?.endsWith("interview.slot_selected")) return { kind: "next", step: "book" };
        const since = Date.parse(ctx.state.remindedAt ?? ctx.state.offeredAt ?? "");
        const until = Number.isFinite(since) ? since + (ctx.state.remindedAt ? REMIND_WAIT_HOURS : OFFER_WAIT_HOURS) * 3600_000 : Number.NaN;
        if (Number.isFinite(until) && until > ctx.now.getTime()) {
          return { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected", "interview.none_work"], subjectId: b.iv.id, until: new Date(until).toISOString(), reason: "waiting for the candidate to pick a time" }, resumeStep: "after_offer" };
        }
      }
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
      // a pick committed while the reminder was being written is booked now, not after another two days
      const [now] = await ctx.q.select({ selectedSlot: interviews.selectedSlot }).from(interviews).where(eq(interviews.id, b.iv.id)).limit(1);
      if (now?.selectedSlot) return { kind: "next", step: "book", state: { remindedAt: ctx.now.toISOString() } };
      return { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected", "interview.none_work"], subjectId: b.iv.id, until: hoursFromNow(ctx, REMIND_WAIT_HOURS), reason: "reminded; waiting for the candidate" }, state: { remindedAt: ctx.now.toISOString() }, resumeStep: "after_offer" };
    },

    async expire_offer(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      if (b.iv.selectedSlot) return { kind: "next", step: "book" };
      await ctx.q.update(interviews).set({ status: "offer_expired", scheduleToken: null, scheduleTokenExpiresAt: null }).where(eq(interviews.id, b.iv.id));
      await emit(ctx.q, { type: "interview.offer_expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      // New times for someone under Cancelled that lapsed: they stay there, and only a person sends again (one automatic set, ever).
      const followUp = await openFollowUpOf(ctx.q, b.app.id);
      const body = followUp?.currentInterviewId === b.iv.id ? "Four days passed with a reminder. They stay under Cancelled: send new times again, or decide." : "Four days passed with a reminder. Offer times again, decide, or bring in a recruiter.";
      await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.offer_expired", title: `${b.candidate.firstName} ${b.candidate.lastName} did not pick an interview time`, body, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
      return { kind: "complete" };
    },

    async book(ctx) {
      const b = await load(ctx);
      if (!b || stale(b, ctx)) return { kind: "complete" };
      const slot = b.iv.selectedSlot;
      if (!slot) return { kind: "next", step: "offer_slots" };
      // Never a booking nobody attends: with no interviewer left there is no constraint to check, so "free" would be meaningless.
      if (!b.participants.length) return { kind: "fail", error: "no interviewers on the interview", retryable: false };
      // A time that has passed (or starts within the hour) is never booked: new times are worked out over a fresh window
      // and offered again, as for a time that was taken, but it is not counted as a collision.
      if (!slotStillAhead(slot, ctx.now)) {
        await emit(ctx.q, { type: "interview.slot_taken", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, attempt: ctx.state.attempt, passed: true }, correlationId: ctx.run.id });
        const nextAttempt = b.iv.attempt + 1;
        const [moved] = await ctx.q.update(interviews).set({ selectedSlot: null, attempt: nextAttempt }).where(and(eq(interviews.id, b.iv.id), eq(interviews.attempt, ctx.state.attempt), eq(interviews.status, "scheduling"))).returning({ id: interviews.id });
        if (!moved) return { kind: "complete" };
        return { kind: "next", step: "propose_slots", state: { attempt: nextAttempt, freshWindow: true, variant: undefined } };
      }
      // Busy time is read around the slot itself (a day either side), not over the offer's window: a pick from an older
      // set of times may lie outside the window the interview carries now.
      const constraints = await gatherConstraints(b, ctx, aroundSlot(slot, windowOf(b).businessDaysOnly));
      if (!slotStillFree(slot, constraints)) {
        await emit(ctx.q, { type: "interview.slot_taken", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, attempt: ctx.state.attempt }, correlationId: ctx.run.id });
        const nextAttempt = b.iv.attempt + 1;
        // Only real collisions count toward bringing in a recruiter; reschedules, cancels and reopens move the attempt too.
        const collisions = (ctx.state.collisions ?? 0) + 1;
        // Guarded: a team reschedule committed meanwhile already moved the attempt; this run then ends instead of taking
        // the same attempt number as the new run.
        const [moved] = await ctx.q.update(interviews).set({ selectedSlot: null, attempt: nextAttempt }).where(and(eq(interviews.id, b.iv.id), eq(interviews.attempt, ctx.state.attempt), eq(interviews.status, "scheduling"))).returning({ id: interviews.id });
        if (!moved) return { kind: "complete" };
        if (collisions >= MAX_COLLISIONS) {
          await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.stuck", title: `Times keep colliding for ${b.candidate.firstName}'s interview`, body: "Three chosen times were taken by the time we booked them. A recruiter has been asked to sort it out with the candidate.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
          await createEscalation(ctx.q, { companyId: ctx.companyId, roleId: b.role.id, applicationId: b.app.id, kind: "candidate_issue", question: `${b.candidate.firstName} ${b.candidate.lastName} chose three interview times that were each taken by booking time (${b.role.title}). Please arrange a time directly.`, requestedBy: ctx.actor, workflowRunId: ctx.run.id, summaryOrigin: "system" });
          return { kind: "complete" };
        }
        // a fresh window too: the re-proposal never uses days that have passed
        return { kind: "next", step: "propose_slots", state: { attempt: nextAttempt, collisions, variant: undefined, freshWindow: true } };
      }
      // The application first, then the interview: the order a team cancel and a send of new times take them, so a
      // booking and a cancel at the same moment take turns. A cancel that got there first ends this run.
      if (!(await stillOursAfterLock(ctx, b))) return { kind: "complete" };
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
        // The interviewer's brief (F7, F8) rides with the confirmation: the round, what it covers, what the evidence says so far. Pay only for roles that may see it.
        const brief = b.packet ? await composeInterviewerBrief(ctx.q, { applicationId: b.app.id, candidateFirstName: b.candidate.firstName, packet: b.packet, roundKey: b.iv.roundKey }) : null;
        const memberRoles = new Map((await ctx.q.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(and(eq(memberships.companyId, ctx.companyId), inArray(memberships.userId, b.participants.map((p) => p.userId))))).map((m) => [m.userId, m.role as MembershipRole]));
        for (const p of b.participants) {
          const mine = brief ? (can(memberRoles.get(p.userId) ?? null, "compensation.read") ? brief : redactBriefPay(brief)) : null;
          // Team mail leaves through the outbox too: recorded here, sent after this step commits, never twice per attempt.
          await queueCommunication(ctx.q, ctx.services.integrations, { channel: "email", companyId: ctx.companyId, to: p.email, from: `${ctx.services.integrations.env.productName} <${ctx.services.integrations.env.fromAddress}>`, subject: `Interview booked: ${b.candidate.firstName} ${b.candidate.lastName} for ${b.role.title}`, text: `${b.iv.title} on ${new Date(b.iv.startsAt!).toLocaleString("en-US", { timeZone: b.company.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${b.company.timezone}).${b.iv.meetingUrl ? `\nJoin: ${b.iv.meetingUrl}` : ""}\n\nOpen: ${ctx.services.env.appBaseUrl}/interviews/${b.iv.id}${mine ? `\n\n${renderInterviewerBriefText(mine)}` : ""}`, templateKey: "interview_confirmed_interviewer", idempotencyKey: `iv_confirm_int:${b.iv.id}:${b.iv.attempt}:${p.userId}`, tags: { template: "interview_confirmed_interviewer" }, actor: ctx.actor, correlationId: ctx.run.id }, ctx.now);
        }
      }
      await emit(ctx.q, { type: "interview.confirmed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { startsAt: b.iv.startsAt, attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      return { kind: "next", step: "on_timer" };
    },

    async on_timer(ctx) {
      const b = await load(ctx);
      if (!b || superseded(b, ctx) || b.iv.status !== "scheduled" || !b.iv.startsAt || !b.iv.endsAt) return { kind: "complete" };
      const start = Date.parse(b.iv.startsAt);
      const end = Date.parse(b.iv.endsAt);
      const checkpoints: Array<{ key: "before24h" | "before2h" | "close"; at: number }> = [{ key: "before24h", at: start - 24 * 3600_000 }, { key: "before2h", at: start - 2 * 3600_000 }, { key: "close", at: end + 3600_000 }];
      // Someone who left the process gets no reminder. An interview still to come was cancelled when they left; one that
      // had already started is only closed, so the record says it ended.
      if (leftProcess(b)) {
        if (start > ctx.now.getTime()) return { kind: "complete" };
        const close = checkpoints[2].at;
        return close <= ctx.now.getTime() ? { kind: "next", step: "close" } : { kind: "wait", wait: { kind: "timer", until: new Date(close).toISOString(), reason: "next: close" }, resumeStep: "on_timer" };
      }
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
      if (!b || superseded(b, ctx) || b.iv.status !== "scheduled") return { kind: "complete" };
      if (!(await stillOursAfterLock(ctx, b))) return { kind: "complete" };
      await ctx.q.update(interviews).set({ status: "completed" }).where(eq(interviews.id, b.iv.id));
      if (b.app.stage === "interview_scheduled") await transition(ctx.q, { applicationId: b.app.id, companyId: ctx.companyId, to: "interview_complete", by: "system", actor: ctx.actor, reason: "interview ended", correlationId: ctx.run.id });
      await emit(ctx.q, { type: "interview.completed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "interview", id: b.iv.id }, payload: { attempt: ctx.state.attempt }, correlationId: ctx.run.id });
      await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.outcome", title: `Did the interview with ${b.candidate.firstName} ${b.candidate.lastName} take place?`, body: "Tell us if it happened or someone did not show; it keeps the record straight.", action: { label: "Record what happened", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
      // Someone already out of the process needs no decision.
      if (!leftProcess(b)) await notify(ctx.q, { companyId: ctx.companyId, kind: "interview.decision", title: `How did it go with ${b.candidate.firstName} ${b.candidate.lastName}?`, body: `${b.iv.title} is over. Next round, finalist, or not moving forward: your call, recorded with your reason.`, action: { label: "Decide", href: `/roles/${b.role.id}/talent?open=${b.app.id}` } });
      return { kind: "complete" };
    },
  },
};
