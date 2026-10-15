import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { BookOnBehalf, CancelInterview, InterviewOutcome, InterviewerAvailabilityInput, RecordInterviewDecision, RequestInterviewWithLine, RescheduleInterview, type Actor, type CandidateNotice, type HireFollowUp, type InterviewDraft, type InterviewFollowUpRef, type OfferedSlot } from "@ros/contracts";
import { HELD_REASON, checkPersonalLine, clashesWithBookings, participantsOf, sendInterviewMoved, type InvitationNote } from "@ros/agents";
import { CANCEL_STAGES, OUTCOME_STATEMENT, OutcomeError, STAGE_LABEL, activeFollowUpsFor, assertCan, audit, availabilityFor, calendarConnectionFor, can, defaultSchedulingWindow, emit, formatInZone, freshSchedulingWindow, inCancelled, interviewFollowUpRef, notify, openFollowUp, openFollowUpOf, publicConnection, recordApplicationOutcome, resolveOpenFollowUp, scopeAllows, slotStillAhead, transition, upsertAvailability, type FollowUpView } from "@ros/core";
import { applications, candidates, companies, events, interviewParticipants, interviews, jobs, memberships, rolePackets, roles, users, withTenant, workflowRuns, type Tx } from "@ros/db";
import type { Container } from "../container";
import { cancelNewTimesRuns } from "@ros/workflows";
import { actorOf, applicationScopeGuard, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { TERMINAL_STAGES } from "../services/application-actions";
import { cancelInterviewInTx } from "../services/interview-cancel";
import { INTERVIEW_FROM, OPEN_INTERVIEW, createApprovedInterview } from "../services/interview-create";
import { exitCleanup } from "../services/exit-cleanup";
import { interviewBriefFor } from "../services/interviewer-view";
import { hireFollowUp } from "../services/hire-sheet";
import { settleOutsideOffer, tellRecruiterAboutOutcome } from "../services/offers";
import { staffScopeOf } from "../services/staff-scope";

/**
 * Interviews (docs/07 §Interviews and calendars; slice 5 step 9). A person approves every interview (policy
 * `interview.request` never drops below approval); the workflow does the scheduling; these routes let people see,
 * re-offer, cancel, record what happened, and book on a candidate's behalf. Nothing here returns a credential.
 * Who may do what comes from the permission matrix (packages/core/src/permissions.ts): `interview.request` to approve a
 * round, `interview.manage` to re-offer, cancel, book on behalf or record an outcome for any interview, and
 * `interview.decide` to record the decision afterwards. An interviewer records the outcome of their own interview only.
 */

/**
 * `followUp`: the candidate is under Cancelled, why, and where their new times stand (the Interviews page offers "Send new
 * times" from it). A list passes `followUps`, read once for the whole page (`followUpsOf`), instead of one read per row.
 */
type Q = Parameters<Parameters<typeof withTenant>[2]>[0];
type InterviewRow = typeof interviews.$inferSelect;

async function summary(tx: Q, row: InterviewRow, followUps?: Map<string, FollowUpView>) {
  const [one] = await summaries(tx, [row], followUps);
  return one;
}

/**
 * The page's rows for a list of interviews in a fixed number of reads, whatever its length (audit 06, bug 100: no
 * longer four reads per row): applications, candidates, roles and participants each read once for the whole list.
 */
async function summaries(tx: Q, rows: readonly InterviewRow[], followUps?: Map<string, FollowUpView>) {
  if (!rows.length) return [];
  const appIds = [...new Set(rows.map((r) => r.applicationId))];
  const apps = new Map((await tx.select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId, stage: applications.stage }).from(applications).where(inArray(applications.id, appIds))).map((a) => [a.id, a]));
  const candIds = [...new Set([...apps.values()].map((a) => a.candidateId))];
  const roleIds = [...new Set([...apps.values()].map((a) => a.roleId))];
  const cands = new Map((candIds.length ? await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName, location: candidates.location }).from(candidates).where(inArray(candidates.id, candIds)) : []).map((x) => [x.id, x]));
  const titles = new Map((roleIds.length ? await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, roleIds)) : []).map((x) => [x.id, x.title]));
  const partRows = await tx.select({ interviewId: interviewParticipants.interviewId, userId: interviewParticipants.userId, status: interviewParticipants.status, name: users.name, email: users.email }).from(interviewParticipants).innerJoin(users, eq(users.id, interviewParticipants.userId)).where(inArray(interviewParticipants.interviewId, rows.map((r) => r.id)));
  const partsOf = new Map<string, typeof partRows>();
  for (const p of partRows) partsOf.set(p.interviewId, [...(partsOf.get(p.interviewId) ?? []), p]);
  const views = followUps ?? (await activeFollowUpsFor(tx, appIds));
  return rows.map((row) => summaryOf(row, apps.get(row.applicationId)!, cands.get(apps.get(row.applicationId)!.candidateId), titles.get(apps.get(row.applicationId)!.roleId), partsOf.get(row.id) ?? [], views));
}

function summaryOf(
  row: InterviewRow,
  app: Pick<typeof applications.$inferSelect, "id" | "roleId" | "candidateId" | "stage">,
  cand: Pick<typeof candidates.$inferSelect, "firstName" | "lastName" | "location"> | undefined,
  roleTitle: string | undefined,
  parts: ReadonlyArray<{ userId: string; status: (typeof interviewParticipants.$inferSelect)["status"]; name: string | null; email: string }>,
  followUps: Map<string, FollowUpView>,
) {
  const view = followUps.get(app.id);
  const followUp: InterviewFollowUpRef | null = view && inCancelled(app.stage, view) ? interviewFollowUpRef(view) : null;
  const role = roleTitle === undefined ? undefined : { title: roleTitle };
  return {
    id: row.id, applicationId: row.applicationId, roleId: app.roleId, roleTitle: role?.title ?? null, roundKey: row.roundKey, title: row.title, format: row.format, durationMinutes: row.durationMinutes, status: row.status,
    startsAt: row.startsAt, endsAt: row.endsAt, timezone: row.timezone, meetingUrl: row.meetingUrl, linkSource: row.linkSource, attempt: row.attempt, offeredSlots: row.offeredSlots, selectedSlot: row.selectedSlot,
    candidateAvailability: row.candidateAvailability, schedulingWindow: row.schedulingWindow, rescheduleCountCandidate: row.rescheduleCountCandidate, outcome: row.outcome, decision: row.decision, decisionNote: row.decisionNote,
    reminders: row.reminders, cancelReason: row.cancelReason, scheduleTokenExpiresAt: row.scheduleTokenExpiresAt, createdAt: row.createdAt, createdBy: row.createdBy,
    candidate: { firstName: cand?.firstName ?? "", lastName: cand?.lastName ?? "", timezone: cand?.location?.timezone ?? null, stage: app.stage, stageLabel: STAGE_LABEL[app.stage] },
    participants: parts.map((p) => ({ userId: p.userId, name: p.name, email: p.email, status: p.status })),
    calendarRefs: Object.fromEntries(Object.entries((row.calendarRefs ?? {}) as Record<string, { provider: string; eventId: string; htmlLink: string | null; meetingUrl: string | null }>).map(([uid, r]) => [uid, { provider: r.provider, eventId: r.eventId, htmlLink: r.htmlLink, meetingUrl: r.meetingUrl }])),
    followUp,
  };
}

/**
 * The interview, read again once its application is locked. Every path that changes an interview and its application
 * takes the application first (a team cancel, the candidate's own cancel, a booking, a send of new times), so two changes
 * at the same moment take turns instead of deadlocking, and the interview read here is the one the other left behind.
 */
async function lockedInterview(tx: Tx, input: { companyId: string; interviewId: string }): Promise<{ iv: typeof interviews.$inferSelect; app: typeof applications.$inferSelect }> {
  const [found] = await tx.select({ applicationId: interviews.applicationId }).from(interviews).where(and(eq(interviews.id, input.interviewId), eq(interviews.companyId, input.companyId))).limit(1);
  if (!found) throw new HttpError(404, "not_found", "Interview not found.");
  const [app] = await tx.select().from(applications).where(eq(applications.id, found.applicationId)).limit(1).for("update");
  // the interview row too, after the application (the order every path takes): what it holds now is what this request acts on
  const [iv] = await tx.select().from(interviews).where(eq(interviews.id, input.interviewId)).limit(1).for("update");
  if (!app || !iv) throw new HttpError(404, "not_found", "Interview not found.");
  return { iv, app };
}

/**
 * Owner-side reschedule or cancellation: the current run ends on its own once the attempt changes; a new run starts for a
 * reschedule. Rescheduling the interview that carries new times for someone under Cancelled ("Offer new times" on it)
 * keeps carrying them, as the team's "Send new times" does: the email uses the new-times opening and counts for their
 * follow-up once it is on its way (one automatic set, ever, stays counted).
 */
async function supersede(c: Context<Vars>, input: { interviewId: string; mode: "reschedule" | "cancel"; reason: string | null; window?: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean } | null; byCandidate?: boolean }) {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const now = container.engine.clock();
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const { iv, app } = await lockedInterview(tx, { companyId: t.companyId, interviewId: input.interviewId });
    if (["cancelled", "completed", "no_show"].includes(iv.status)) throw new HttpError(409, "interview_not_schedulable", `This interview is ${iv.status}.`);
    const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
    const actor = actorOf(c);
    if (input.mode === "cancel") {
      // The one cancellation path (services/interview-cancel.ts): it also queues the calendar events' removal, and says
      // whether the candidate was told (only someone who had a booked time or times to pick from is).
      const done = await cancelInterviewInTx(tx, container, { companyId: t.companyId, interview: iv, actor, by: t.role, reason: input.reason, byCandidate: input.byCandidate, now });
      return { id: iv.id, candidateTold: done.candidateTold };
    }
    // A fresh window from tomorrow, as long as the old one, never the old dates (which may have passed); dates the
    // person sent win. "Offer times again" after an offer lapsed comes here too.
    const [company] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const sent = Object.fromEntries(Object.entries(input.window ?? {}).filter(([k, v]) => v !== undefined && (k !== "businessDaysOnly" || !!(input.window?.fromDate || input.window?.toDate))));
    const fresh = freshSchedulingWindow(iv.schedulingWindow, now, company.timezone);
    // Only one end sent: the other is worked out from it, keeping the fresh window's length, so the window never ends
    // before it starts (which would leave no times at all).
    const lengthMs = Date.parse(`${fresh.toDate}T00:00:00Z`) - Date.parse(`${fresh.fromDate}T00:00:00Z`);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    if (sent.fromDate && !sent.toDate) sent.toDate = day(Date.parse(`${sent.fromDate}T00:00:00Z`) + lengthMs);
    if (sent.toDate && !sent.fromDate) sent.fromDate = Date.parse(`${sent.toDate}T00:00:00Z`) < Date.parse(`${fresh.fromDate}T00:00:00Z`) ? sent.toDate : fresh.fromDate;
    const window = { ...fresh, ...sent };
    const booked = iv.status === "scheduled" && !!iv.startsAt;
    await tx.update(interviews).set({ status: "scheduling", attempt: iv.attempt + 1, selectedSlot: null, offeredSlots: [], startsAt: null, endsAt: null, scheduleToken: null, scheduleTokenExpiresAt: null, schedulingWindow: window, rescheduleCountCandidate: input.byCandidate ? iv.rescheduleCountCandidate + 1 : iv.rescheduleCountCandidate, reminders: {}, meetingUrl: iv.linkSource === "pasted" ? iv.meetingUrl : null }).where(eq(interviews.id, iv.id));
    // The booked time is gone, so the interviewers are back to invited until the workflow books the next one.
    await tx.update(interviewParticipants).set({ status: "invited" }).where(eq(interviewParticipants.interviewId, iv.id));
    // The interview carrying new times for someone under Cancelled: the new times are a person's, as with "Send new times".
    const followUp = await openFollowUpOf(tx, app.id, { lock: true });
    const carried = followUp?.currentInterviewId === iv.id ? { offerKind: followUp.choice === "new_times" ? ("new_times_asked" as const) : ("new_times_team" as const), followUpId: followUp.id, via: "person" as const } : null;
    // Times the candidate already knew about (booked, or offered to pick from): the next email says these are new times.
    const knew = booked || (iv.status === "scheduling" && iv.offeredSlots.length > 0) || iv.status === "offer_expired";
    // A booked time the team moved: the candidate is told at once that it is off, with a calendar file that removes it.
    let candidateTold = false;
    if (booked) {
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
      const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
      if (cand && role && pv) {
        const parts = await participantsOf(tx, iv.id);
        const sentMoved = await sendInterviewMoved(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, appBaseUrl: container.env.APP_BASE_URL, interview: iv, interviewerFirstNames: parts.map((p) => p.firstName), candidateTimezone: iv.schedulingWindow.candidateTimezone ?? cand.location?.timezone ?? company.timezone, companyTimezone: company.timezone, reason: input.reason });
        // told only when the message is on its way: not when it failed (no address), nor while it waits for the ITS check
        candidateTold = sentMoved.status !== "failed" && !(sentMoved.status === "pending" && (sentMoved as { reason?: string }).reason === HELD_REASON);
      }
    }
    await emit(tx, { type: "interview.rescheduled", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: !!input.byCandidate, attempt: iv.attempt + 1, hadEvents, wasBooked: booked, candidateTold, ...(carried ? { newTimes: true, via: carried.via, followUpId: carried.followUpId } : {}) } });
    if (app.stage === "interview_scheduled") await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by: t.role, actor, reason: "interview being rescheduled" });
    // The other interviewers on it hear that it moved (the person who moved it knows).
    const others = (await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id))).map((p) => p.userId).filter((id) => id !== t.userId);
    if (others.length) {
      const [who] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const name = `${who?.firstName ?? ""} ${who?.lastName ?? ""}`.trim() || "the candidate";
      await notify(tx, { companyId: t.companyId, kind: "interview.rescheduled", title: `Interview moved: ${name}, ${iv.title}`, body: booked ? `The time on ${formatInZone(iv.startsAt!, company.timezone)} is off.${hadEvents ? " The calendar event is being removed." : ""} New times are being offered; you will be told when one is booked.` : "New times are being offered; you will be told when one is booked.", action: { label: "Open the interview", href: `/interviews/${iv.id}` }, userIds: others });
    }
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: t.companyId, subject: { type: "interview", id: iv.id }, state: { interviewId: iv.id, applicationId: iv.applicationId, roleId: app.roleId, roundKey: iv.roundKey, attempt: iv.attempt + 1, ...(knew ? { rescheduled: true } : {}), ...(carried ?? {}) }, idempotencyKey: `schedule:${iv.id}:${iv.attempt + 1}`, actor });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId: t.companyId, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    return { id: iv.id, candidateTold: booked ? candidateTold : null };
  });
  await container.kick();
  return result;
}

/**
 * ITS staff acting under a scoped grant reach only the interviews of the role or candidate the grant names, on every
 * route that takes an interview id (the detail carries the interviewer's brief: evidence, strengths, concerns, screen
 * answers). The same refusal as the application and role guards. Members are unaffected.
 */
const interviewScopeGuard: MiddlewareHandler<Vars> = async (c, next) => {
  const t = c.get("tenant");
  const id = c.req.param("id");
  if (t?.staff && id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const scope = { roleId: t.staff.scope.roleId, applicationId: t.staff.scope.applicationId };
    const [row] = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select({ applicationId: interviews.applicationId, roleId: applications.roleId }).from(interviews).innerJoin(applications, eq(applications.id, interviews.applicationId)).where(and(eq(interviews.id, id), eq(interviews.companyId, t.companyId))).limit(1));
    if (row && !scopeAllows(scope, { roleId: row.roleId, applicationId: row.applicationId })) throw new HttpError(403, "staff_scope", "Your access is limited to the role and candidate of the escalation you accepted.");
  }
  await next();
};

export const interviewRoutes = new Hono<Vars>();
interviewRoutes.use("/:id", interviewScopeGuard);
interviewRoutes.use("/:id/*", interviewScopeGuard);

interviewRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const filter = c.req.query("status");
  const mine = c.req.query("mine") === "1" || t.role === "interviewer";
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    // Every limit is part of the query (audit 06, bug 100): an interviewer's own interviews and a grant's role or
    // candidate are chosen by the database, never filtered from the newest few hundred, so none is missed.
    const conds = [eq(interviews.companyId, t.companyId)];
    if (filter) conds.push(eq(interviews.status, filter));
    if (from) conds.push(gte(interviews.startsAt, from));
    if (to) conds.push(lte(interviews.startsAt, to));
    if (mine) conds.push(inArray(interviews.id, tx.select({ id: interviewParticipants.interviewId }).from(interviewParticipants).where(eq(interviewParticipants.userId, t.userId))));
    if (t.staff?.scope.roleId) conds.push(inArray(interviews.applicationId, tx.select({ id: applications.id }).from(applications).where(eq(applications.roleId, t.staff.scope.roleId))));
    // a grant about one candidate shows that candidate's interviews only, the same limit as the role's applications list
    if (t.staff?.scope.applicationId) conds.push(eq(interviews.applicationId, t.staff.scope.applicationId));
    const list = await tx.select().from(interviews).where(and(...conds)).orderBy(desc(interviews.createdAt));
    return summaries(tx, list);
  });
  return c.json(rows);
});

interviewRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [iv] = await tx.select().from(interviews).where(and(eq(interviews.id, c.req.param("id")), eq(interviews.companyId, t.companyId))).limit(1);
    if (!iv) return null;
    const s = await summary(tx, iv);
    if (t.role === "interviewer" && !s.participants.some((p) => p.userId === t.userId)) return null;
    const timeline = await tx.select().from(events).where(and(eq(events.subjectType, "interview"), eq(events.subjectId, iv.id))).orderBy(desc(events.occurredAt)).limit(100);
    const sources = [];
    for (const p of s.participants) {
      const conn = await calendarConnectionFor(tx, t.companyId, p.userId);
      const avail = await availabilityFor(tx, t.companyId, p.userId);
      sources.push({ userId: p.userId, source: conn && conn.status === "live" ? "calendar" : avail?.windows.length ? "declared" : "none", calendarStatus: conn?.status ?? null });
    }
    // The interviewer's brief (F7): the round, what it covers, what the evidence says so far; pay only for roles that may see it.
    const brief = await interviewBriefFor(tx, { interview: iv, viewerRole: t.role });
    return { ...s, timeline, availabilitySources: sources, brief };
  });
  if (!row) throw new HttpError(404, "not_found", "Interview not found.");
  return c.json(row);
});

interviewRoutes.post("/:id/reschedule", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = RescheduleInterview.parse(await c.req.json().catch(() => ({})));
  const { id, candidateTold } = await supersede(c, { interviewId: c.req.param("id"), mode: "reschedule", reason: body.reason ?? null, window: body.window ?? null });
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, id)))[0]));
  // `candidateTold`: a booked time moved, and the candidate was told it is off (null when nothing was booked).
  return c.json({ ...row, candidateTold });
});

/** `candidateTold` says whether the candidate was sent the cancellation, so the page's confirmation says exactly that. */
interviewRoutes.post("/:id/cancel", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = CancelInterview.parse(await c.req.json());
  const { id, candidateTold } = await supersede(c, { interviewId: c.req.param("id"), mode: "cancel", reason: body.reason });
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, id)))[0]));
  return c.json({ ...row, candidateTold: !!candidateTold, interviewersTold: row.participants.length > 0 });
});

/**
 * "Did it take place?" from a participant or someone who manages interviews; a no-show is recorded, never held against
 * anyone automatically. Either answer ends the interview, so a candidate still at "Interviewing" moves to "Interview
 * done: decision needed" right away instead of waiting for the workflow's closing timer, and the hiring team is asked
 * "How did it go?" just as the timer would have asked; the decision stays a person's. A candidate who did not come goes
 * under Cancelled as a no-show (founder decision 4A), and the team is told that instead: nothing goes to them
 * automatically, ever; a person sends new times for the same round, or decides.
 */
interviewRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = InterviewOutcome.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const { iv } = await lockedInterview(tx, { companyId: t.companyId, interviewId: c.req.param("id") });
    const parts = await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
    if (!can(t.role, "interview.manage") && !parts.some((p) => p.userId === t.userId)) throw new HttpError(403, "forbidden", "Only a participant or someone who manages interviews can record what happened.");
    if (!["scheduled", "completed"].includes(iv.status)) throw new HttpError(409, "interview_not_schedulable", `This interview is ${iv.status}.`);
    // Answered once, as the screen asks it once (audit 06, bug 98): a "took place" is never overwritten later, as a no-show never was.
    if (iv.outcome) throw new HttpError(409, "already_recorded", "What happened at this interview is already recorded.");
    const ended = body.outcome === "happened" ? "completed" : "no_show";
    const actor = actorOf(c);
    const now = container.engine.clock();
    const [u] = await tx.update(interviews).set({ outcome: body.outcome, status: ended }).where(and(eq(interviews.id, iv.id), isNull(interviews.outcome))).returning();
    if (!u) throw new HttpError(409, "already_recorded", "What happened at this interview is already recorded.");
    await emit(tx, { type: "interview.outcome_recorded", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { outcome: body.outcome } });
    const [app] = await tx.select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId, stage: applications.stage }).from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
    const [cand] = app ? await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1) : [];
    const name = `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "the candidate";
    const moved = app?.stage === "interview_scheduled";
    if (app && moved) {
      // The workflow's closing step (an hour after the end) would move the candidate, record that the interview is over
      // and ask the hiring team for their decision; it finds the interview already ended and stops, so all three happen here.
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_complete", by: t.role, actor, reason: body.outcome === "happened" ? "interview took place" : `interview ${body.outcome.replace(/_/g, " ")}` });
      await emit(tx, { type: "interview.completed", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { attempt: iv.attempt, via: "outcome" } });
    }
    // The candidate did not come: under Cancelled as a no-show, opened after the move above (a person's move resolves the
    // column). Also when it is recorded after the interview closed. Never for an interviewer's no-show.
    let noShowOpened = false;
    if (app && body.outcome === "no_show_candidate") {
      const [fresh] = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
      const [role] = await tx.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
      if (fresh && CANCEL_STAGES.includes(fresh.stage) && !iv.decision && role && !["closed", "filled"].includes(role.status)) {
        const opened = await openFollowUp(tx, { companyId: t.companyId, applicationId: app.id, interviewId: iv.id, interviewAttempt: iv.attempt, kind: "candidate_no_show", choice: null, auto: { state: "none", reason: "no_show" }, actor, now });
        noShowOpened = opened.created;
      }
    }
    if (app && noShowOpened) await notify(tx, { companyId: t.companyId, kind: "interview.no_show", title: `${name} did not come to the interview`, body: `${iv.title}. They are under Cancelled as a no-show. Nothing goes to them automatically: send new times for the same round, or decide.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    // Our side missed it (founder decision L-12): the approval card offers the same round again, and its invitation says sorry.
    else if (app && body.outcome === "no_show_interviewer" && INTERVIEW_FROM.includes(moved ? "interview_complete" : app.stage)) await notify(tx, { companyId: t.companyId, kind: "interview.decision", title: `${name}'s interview did not happen`, body: `Our interviewer missed ${iv.title}. Approve the same round again from their page; the new invitation says sorry. You can pick another round instead.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}&step=interview` } });
    else if (app && moved) await notify(tx, { companyId: t.companyId, kind: "interview.decision", title: `How did it go with ${name}?`, body: `${iv.title} is over. Next round, finalist, or not moving forward: your call, recorded with your reason.`, action: { label: "Decide", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    return summary(tx, u);
  });
  return c.json(row);
});

/** Steps of a scheduling run that book a picked time when they run next (each looks for a pick first). */
const BOOKS_A_PICK = ["offer_slots", "after_offer", "remind", "expire_offer", "book"];

/**
 * Where a picked time goes: "workflow" (a run books it), "direct" (booked straight away by a new run), "taken" (it
 * clashes with another interview booked meanwhile), "stale" (it has passed, or starts within the hour). For the last
 * two nothing is written and the caller says so plainly.
 */
export type PickRoute = "workflow" | "direct" | "taken" | "stale";

/**
 * The scheduling run working on this interview's current attempt, found by what it is about and the attempt in its
 * state, not by its idempotency key: a run moves the attempt itself (a collision, other times after "none of these
 * work") and keeps its original key. Newest first; null when none is still going.
 */
export async function currentScheduleRun(tx: Tx, iv: Pick<typeof interviews.$inferSelect, "id" | "attempt">) {
  const [run] = await tx
    .select({ id: workflowRuns.id, status: workflowRuns.status, currentStep: workflowRuns.currentStep, state: workflowRuns.state, wait: workflowRuns.wait })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowKey, "schedule_interview"), sql`${workflowRuns.subject}->>'id' = ${iv.id}`, sql`(${workflowRuns.state}->>'attempt')::int = ${iv.attempt}`, notInArray(workflowRuns.status, ["completed", "failed", "cancelled"])))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1);
  return run ?? null;
}

/**
 * Decides where a picked time goes (the candidate's pick, or "Book this for them"), inside the transaction that records
 * it, after the run was signalled. A time that has passed, or starts within the hour, is refused ("stale"). The current
 * attempt's run books it when it waits for the pick (the signal woke it) or is about to (its next step looks for a pick,
 * or it waits for the ITS check on new times); a wake of an older attempt's run counts for nothing. Otherwise nothing
 * would book it (after "none of these work", during "no common times", after the collisions escalation), so it is booked
 * straight away (`bookPickNow`), unless the time clashes with another interview booked for one of the interviewers
 * since. A pick is never silently lost.
 */
export async function routePick(tx: Tx, input: { iv: typeof interviews.$inferSelect; slot: OfferedSlot; woken: number; now?: Date }): Promise<PickRoute> {
  if (!slotStillAhead(input.slot, input.now ?? new Date())) return "stale";
  const run = await currentScheduleRun(tx, input.iv);
  const key = `${input.iv.id}:interview.slot_selected`;
  const keys = (run?.wait as { keys?: unknown } | null)?.keys;
  const wokenNow = input.woken > 0 && run?.status === "waiting" && Array.isArray(keys) && keys.includes(key);
  if (wokenNow) return "workflow";
  if (run && ((run.status === "waiting" && run.currentStep === "offer_slots") || (run.status === "running" && BOOKS_A_PICK.includes(run.currentStep ?? "")))) return "workflow";
  const userIds = (await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, input.iv.id))).map((p) => p.userId);
  if (await clashesWithBookings(tx, { companyId: input.iv.companyId, interviewId: input.iv.id, userIds, slot: input.slot })) return "taken";
  return "direct";
}

/**
 * Books a picked time straight away (`routePick` said "direct"): a new attempt, so a run still waiting on this interview
 * ends at its next step, and a new run that starts at the booking (`bookPick`). The booking step re-checks every
 * calendar, then books, confirms and reminds as usual; a time taken there is re-offered as any collision is. The new run
 * carries what the old one carried (new times for someone under Cancelled, the personal line, the "new times" opening,
 * the collisions counted so far). Call after the pick is written, holding the interview's lock. False when the
 * interview moved on meanwhile: the caller rolls back and asks again.
 */
export async function bookPickNow(tx: Tx, container: Container, input: { iv: typeof interviews.$inferSelect; roleId: string; actor: Actor }): Promise<boolean> {
  const { iv } = input;
  const run = await currentScheduleRun(tx, iv);
  const [moved] = await tx.update(interviews).set({ attempt: iv.attempt + 1 }).where(and(eq(interviews.id, iv.id), eq(interviews.attempt, iv.attempt), eq(interviews.status, "scheduling"))).returning({ id: interviews.id });
  if (!moved) return false;
  const before = (run?.state ?? {}) as Record<string, unknown>;
  const keep = Object.fromEntries(["invitationNote", "offerKind", "followUpId", "via", "rescheduled", "offeredAt", "collisions", "variant"].filter((k) => before[k] !== undefined && before[k] !== null).map((k) => [k, before[k]]));
  await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: iv.companyId, subject: { type: "interview", id: iv.id }, state: { ...keep, interviewId: iv.id, applicationId: iv.applicationId, roleId: input.roleId, roundKey: iv.roundKey, attempt: iv.attempt + 1, bookPick: true }, idempotencyKey: `schedule:${iv.id}:${iv.attempt + 1}`, actor: input.actor });
  return true;
}

/**
 * The owner picks a time for the candidate after a phone call; recorded as a human action and audited as a booking.
 * Booked by the run that waits for a pick, or straight away when none does (`routePick`); a time that clashes with
 * another interview booked since is refused with a plain message. `booking` says which ("workflow" or "direct").
 */
interviewRoutes.post("/:id/book-on-behalf", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = BookOnBehalf.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const done = await withTenant(container.db, t.companyId, async (tx) => {
    // the application, then the interview itself, locked: a new set of times or a booking committed meanwhile is seen
    const { iv, app } = await lockedInterview(tx, { companyId: t.companyId, interviewId: c.req.param("id") });
    if (iv.status !== "scheduling") throw new HttpError(409, "interview_not_schedulable", "Times are not being offered right now.");
    const slot = iv.offeredSlots.find((s) => s.id === body.slotId);
    if (!slot) throw new HttpError(400, "slot_unknown", "That time is not one of the offered slots.");
    const woken = await container.engine.signal(tx, { companyId: t.companyId, key: `${iv.id}:interview.slot_selected`, payload: { slotId: slot.id, onBehalf: true } });
    const route = await routePick(tx, { iv, slot, woken, now: container.engine.clock() });
    if (route === "stale") throw new HttpError(409, "slot_unknown", "That time has passed or starts within the hour. Choose a later one.");
    if (route === "taken") throw new HttpError(409, "slot_taken", "That time is no longer free: an interviewer was booked for another interview then. Choose another time.");
    const [picked] = await tx.update(interviews).set({ selectedSlot: slot }).where(and(eq(interviews.id, iv.id), eq(interviews.attempt, iv.attempt), eq(interviews.status, "scheduling"))).returning({ id: interviews.id });
    if (!picked) throw new HttpError(409, "interview_not_schedulable", "The times changed a moment ago. Open the interview again and choose from the new ones.");
    await emit(tx, { type: "interview.slot_selected", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { slotId: slot.id, onBehalf: true, note: body.note ?? null, booking: route } });
    await audit(tx, { companyId: t.companyId, actor, action: "interview.booked_on_behalf", target: { type: "interview", id: iv.id }, reason: `booked on the candidate's behalf: ${body.note ?? "no note"}`, details: { applicationId: iv.applicationId, slotId: slot.id, startsAt: slot.startsAt } });
    // a direct booking that finds the interview moved on rolls the whole pick back, never a pick nothing books
    if (route === "direct" && !(await bookPickNow(tx, container, { iv, roleId: app.roleId, actor }))) throw new HttpError(409, "interview_not_schedulable", "The times changed a moment ago. Open the interview again and choose from the new ones.");
    return { id: iv.id, booking: route, resignal: route === "workflow" && woken === 0 };
  });
  // A run that was mid-step when the pick was written (it read no pick, and now waits): told again after the commit.
  if (done.resignal) await withTenant(container.db, t.companyId, (tx) => container.engine.signal(tx, { companyId: t.companyId, key: `${done.id}:interview.slot_selected`, payload: { slotId: body.slotId, onBehalf: true } }));
  await container.kick();
  const row = await withTenant(container.db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, done.id)))[0]));
  return c.json({ ...row, booking: done.booking });
});

/** Routes under /applications/:id that create interviews and record decisions. */
export const applicationInterviewRoutes = new Hono<Vars>();
applicationInterviewRoutes.use("/:id/*", applicationScopeGuard);

applicationInterviewRoutes.post("/:id/interviews", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.request");
  const body = RequestInterviewWithLine.parse(await c.req.json());
  const container = c.get("container");
  const now = container.engine.clock();
  // A personal line on the invitation (Q28), the person's own or one the assistant suggested and they kept: checked like
  // a decision message's line, and refused with what to take out. The invitation says so when the assistant helped.
  let invitationNote: InvitationNote | null = null;
  if (body.invitationLine) {
    const checked = checkPersonalLine(body.invitationLine.text);
    if (!checked.ok) throw new HttpError(400, "personal_line_refused", checked.message, { problems: checked.problems });
    invitationNote = { text: checked.text, aiHelped: body.invitationLine.aiHelped, senderName: actorOf(c).name ?? "A member of the hiring team" };
  }
  // The approval itself (services/interview-create.ts): the same for someone under Cancelled, whose new times it carries.
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const made = await createApprovedInterview(tx, container, { companyId: t.companyId, applicationId: c.req.param("id"), roundKey: body.roundKey, interviewerUserIds: body.interviewerUserIds, linkSource: body.linkSource, meetingUrl: body.meetingUrl ?? null, window: body.window ?? null, note: body.note ?? null, invitationNote, suggestionRunId: body.invitationLine?.suggestionRunId ?? null, actor: actorOf(c), by: t.role, approvedBy: t.userId, now, via: "person" });
    return made.interviewId;
  });
  await container.kick();
  const row = await withTenant(container.db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, result)))[0]));
  return c.json(row, 201);
});

/**
 * The interview approval card filled in (plan H4): the next round of the approved plan (the first, or the one after the
 * newest interview that is over), the plan's interviewers who are still active members (the role's current plan when it
 * still has the round, as the page's own defaults do), the calendar link and the company's scheduling window. Null when
 * no interview can be approved now (their step, or one already being set up) or the plan has no round left. Posting it
 * to `requestPath` is the one approval; nothing is approved here. A round that did not take place is not over, so the
 * card proposes the same round again: the candidate did not come (founder decision 4A), or our interviewer missed it
 * (founder decision L-12, 15 Oct 2026; `sameRoundAgain`, and the new invitation says sorry). The owner can still pick
 * another round on the card.
 */
export async function interviewDraftFor(tx: Tx, input: { app: Pick<typeof applications.$inferSelect, "id" | "roleId" | "companyId" | "packetVersion" | "stage">; now: Date }): Promise<(InterviewDraft & { sameRoundAgain?: "missed_by_us" }) | null> {
  const { app } = input;
  if (!INTERVIEW_FROM.includes(app.stage)) return null;
  if ((await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, OPEN_INTERVIEW))).limit(1)).length) return null;
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  const plan = pv?.packet.interviews.plan ?? [];
  if (!plan.length) return null;
  // The newest interview that ended, whichever way: one our interviewer missed asks for the same round again, unless a
  // person decided to move on from it (a "next round" moves on as before; "new times" only says the round was offered again).
  const [latest] = await tx.select({ roundKey: interviews.roundKey, status: interviews.status, outcome: interviews.outcome, decision: interviews.decision }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["completed", "no_show"]))).orderBy(desc(interviews.createdAt)).limit(1);
  const missedByUs = latest?.status === "no_show" && latest.outcome === "no_show_interviewer" && (!latest.decision || latest.decision === "new_times") ? plan.find((r) => r.key === latest.roundKey) ?? null : null;
  const over = or(eq(interviews.status, "completed"), and(eq(interviews.status, "no_show"), sql`${interviews.outcome} IS DISTINCT FROM 'no_show_candidate'`, sql`(${interviews.outcome} IS DISTINCT FROM 'no_show_interviewer' OR (${interviews.decision} IS NOT NULL AND ${interviews.decision} <> 'new_times'))`));
  const [done] = await tx.select({ roundKey: interviews.roundKey }).from(interviews).where(and(eq(interviews.applicationId, app.id), over)).orderBy(desc(interviews.createdAt)).limit(1);
  const idx = done ? plan.findIndex((r) => r.key === done.roundKey) : -1;
  const round = missedByUs ?? (done ? plan[idx + 1] : plan[0]);
  if (!round) return null;
  const [role] = await tx.select({ currentPacketVersion: roles.currentPacketVersion }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [current] = role?.currentPacketVersion && role.currentPacketVersion !== app.packetVersion ? await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, role.currentPacketVersion))).limit(1) : [];
  const ids = current?.packet.interviews.plan.find((r) => r.key === round.key)?.interviewerUserIds ?? round.interviewerUserIds ?? [];
  const active = ids.length ? new Set((await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, app.companyId), eq(memberships.status, "active"), inArray(memberships.userId, ids)))).map((m) => m.userId)) : new Set<string>();
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
  return {
    applicationId: app.id, roleId: app.roleId, roundKey: round.key, roundTitle: round.title, durationMinutes: round.durationMinutes, format: round.format,
    interviewerUserIds: [...new Set(ids)].filter((id) => active.has(id)), linkSource: "calendar", window: defaultSchedulingWindow(input.now, company?.timezone ?? "America/Los_Angeles"),
    requestPath: `/api/v1/applications/${app.id}/interviews`, nextRound: !missedByUs && !!done,
    ...(missedByUs ? { sameRoundAgain: "missed_by_us" as const } : {}),
  };
}

/**
 * GET /applications/:id/interview-draft: the approval card filled in, for those who approve interviews. 409 with the
 * reason when no interview can be approved now, 404 when the plan has no round left.
 */
applicationInterviewRoutes.get("/:id/interview-draft", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.request");
  const container = c.get("container");
  const draft = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(and(eq(applications.id, c.req.param("id")), eq(applications.companyId, t.companyId))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    if (!INTERVIEW_FROM.includes(app.stage)) throw new HttpError(409, "interview_not_schedulable", `A candidate at "${STAGE_LABEL[app.stage]}" cannot be moved to an interview from here.`);
    if ((await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, OPEN_INTERVIEW))).limit(1)).length) throw new HttpError(409, "interview_open", "An interview is already being scheduled for this candidate. Reschedule or cancel it first.");
    return interviewDraftFor(tx, { app, now: container.engine.clock() });
  });
  if (!draft) throw new HttpError(404, "no_round", "The interview plan has no round left for this candidate.");
  return c.json(draft);
});

/**
 * The human decision after an interview (HARD human-only in spirit: there is no automated path to any of these). It is
 * recorded on the newest interview that is over and still undecided, so a second decision never overwrites the first
 * one's, and a "not moving forward" is filed privately like every decline (founder decision B6): the decision is not sent
 * until a person sends the decision message. `candidateNotice` ("not_told") and `dispositionSent` (false) say so on the
 * page. An interview still to come is called off, and a candidate who held a booked time or was offered times is told
 * at once, with no reason, that it is off (`interviewOffNotes`). "Hired" is the hire sheet (plan H1): the outcome
 * service records it with the start date (`hireDate`, and `offerAcceptedAt` if given), for those who record outcomes,
 * and the answer carries the backups to keep warm and closing the role (`hire`).
 */
applicationInterviewRoutes.post("/:id/decision", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.decide");
  const body = RecordInterviewDecision.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    // Locked first, as every path that changes an interview and its application takes it (a send of new times marks a
    // missed interview decided), so two at the same moment take turns. A decision recorded meanwhile is never overwritten.
    const [app] = await tx.select().from(applications).where(and(eq(applications.id, c.req.param("id")), eq(applications.companyId, t.companyId))).limit(1).for("update");
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    const [last] = await tx.select().from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["completed", "no_show"]), isNull(interviews.decision))).orderBy(desc(interviews.createdAt)).limit(1);
    // The same rule as the screen (audit 06, bug 99): a decision after an interview needs a finished interview still
    // undecided, for someone still in the process. Other moves have their own actions (the stage button, the hire sheet).
    if (!last) throw new HttpError(409, "no_interview_to_decide", "No finished interview is waiting for a decision.");
    if (TERMINAL_STAGES.includes(app.stage)) throw new HttpError(409, "no_interview_to_decide", `A candidate at "${STAGE_LABEL[app.stage]}" has no interview decision to record.`);
    const [decided] = await tx.update(interviews).set({ decision: body.decision, decisionNote: body.note ?? null }).where(and(eq(interviews.id, last.id), isNull(interviews.decision))).returning({ id: interviews.id });
    if (!decided) throw new HttpError(409, "decision_changed", "Something changed a moment ago. Refresh to see where they are now.");
    let stage = app.stage;
    let nextRoundKey: string | null = null;
    let dispositionSent: boolean | undefined;
    let candidateNotice: CandidateNotice | undefined;
    let interviewsCancelled = 0;
    let interviewOffNotes = 0;
    let hired: { outcomeId: string; roleId: string; hire: HireFollowUp } | null = null;
    if (body.decision === "not_moving_forward") {
      if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
      assertCan(t.role, "application.reject");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by: t.role, actor, reason: body.reason, payload: { note: body.note ?? null } });
      await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "application.rejected", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true, afterInterview: true, candidateTold: false } });
      const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId: app.id, reason: `declined after an interview: ${body.reason}`, actor, candidateEmail: "private_decision" });
      interviewsCancelled = cleaned.interviewsCancelled;
      interviewOffNotes = cleaned.candidateNotes;
      candidateNotice = "not_told";
      dispositionSent = false;
      stage = "rejected";
    } else if (body.decision === "finalist") {
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "finalist", by: t.role, actor, reason: body.note ?? "finalist after interview" });
      stage = "finalist";
    } else if (body.decision === "next_round") {
      const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
      const plan = pv?.packet.interviews.plan ?? [];
      // The round after the one just held; a round no longer in the plan has no "next" (never silently the first round).
      const idx = plan.findIndex((r) => r.key === last.roundKey);
      nextRoundKey = idx >= 0 ? plan[idx + 1]?.key ?? null : null;
      if (!nextRoundKey) throw new HttpError(409, "no_next_round", "The interview plan has no further round; choose finalist or not moving forward.");
      // No stage moves, but a person moved them on: out of Cancelled, and an automatic set waiting for its day does not go.
      // The other decisions move the stage, and the move takes them out (packages/core stages.ts).
      await resolveOpenFollowUp(tx, { companyId: t.companyId, applicationId: app.id, actor, how: "moved_by_team", now: container.engine.clock() });
      await cancelNewTimesRuns(tx, container.engine, { companyId: t.companyId, applicationId: app.id, actor, reason: "decided: next round" });
    } else if (body.decision === "hired") {
      // The offer was made and accepted outside the app (founder decision Q29): recorded as an outcome, like the hire
      // sheet's, so the hire has its start date and the same record whichever card it came from.
      assertCan(t.role, "outcome.record");
      if (!body.hireDate) throw new HttpError(400, "hire_date_required", "Enter the start date you agreed with them.");
      const now = container.engine.clock();
      const r = await recordApplicationOutcome(tx, { companyId: t.companyId, applicationId: app.id, outcome: "hired_externally", by: t.role, actor, hireDate: body.hireDate, offerAcceptedAt: body.offerAcceptedAt, note: body.note, now }).catch((e: unknown) => {
        if (e instanceof OutcomeError) throw new HttpError(e.code === "not_found" ? 404 : ["already_recorded", "not_active"].includes(e.code) ? 409 : 400, e.code, e.message);
        throw e;
      });
      await settleOutsideOffer(tx, { applicationId: app.id, companyId: t.companyId, outcome: "hired_externally", actor, now });
      hired = { outcomeId: r.row.id, roleId: r.roleId, hire: await hireFollowUp(tx, { roleId: r.roleId, hiredApplicationId: app.id, startDate: r.row.hireDate, role: t.role, scope: staffScopeOf(t) }) };
      stage = "hired";
    }
    await emit(tx, { type: "interview.decision_recorded", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { decision: body.decision, interviewId: last.id, note: body.note ?? null, nextRoundKey } });
    await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.decision", decision: body.decision } });
    return { out: { ok: true, stage, nextRoundKey, ...(dispositionSent === undefined ? {} : { dispositionSent, candidateNotice, interviewsCancelled, interviewOffNotes }), ...(hired ? { outcomeId: hired.outcomeId, hire: hired.hire, statement: OUTCOME_STATEMENT } : {}) }, hired };
  });
  if (result.hired) await tellRecruiterAboutOutcome(container, t.companyId, result.hired.roleId, c.req.param("id") ?? null, `${actor.name ?? "The customer"} recorded a hire (offer accepted outside the platform).`, `outcome:${result.hired.outcomeId}`);
  await container.kick();
  return c.json(result.out);
});

/**
 * Interviews of one role, by the same limits as GET /interviews: an interviewer sees the interviews they are on (the
 * guard has already refused a role they do not interview for), and ITS staff under a grant about one candidate see that
 * candidate's interviews only (a grant for another role is refused by the guard).
 */
export const roleInterviewRoutes = new Hono<Vars>();
roleInterviewRoutes.use("/:id/*", roleScopeGuard);
roleInterviewRoutes.get("/:id/interviews", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const only = t.staff?.scope.applicationId ?? null;
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const appIds = (await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.roleId, c.req.param("id")), eq(applications.companyId, t.companyId), ...(only ? [eq(applications.id, only)] : [])))).map((a) => a.id);
    if (!appIds.length) return [];
    const conds = [inArray(interviews.applicationId, appIds)];
    if (t.role === "interviewer") conds.push(inArray(interviews.id, tx.select({ id: interviewParticipants.interviewId }).from(interviewParticipants).where(eq(interviewParticipants.userId, t.userId))));
    const list = await tx.select().from(interviews).where(and(...conds)).orderBy(desc(interviews.createdAt));
    return summaries(tx, list);
  });
  return c.json(rows);
});

/** The signed-in person's own scheduling readiness: calendar connection (no secrets) and declared availability. */
export const meRoutes = new Hono<Vars>();

meRoutes.get("/calendar", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const conn = await calendarConnectionFor(tx, t.companyId, t.userId);
    const avail = await availabilityFor(tx, t.companyId, t.userId);
    return { connection: conn ? publicConnection(conn) : null, availability: avail ? { timezone: avail.timezone, windows: avail.windows, bufferMinutes: avail.bufferMinutes, maxPerDay: avail.maxPerDay, updatedAt: avail.updatedAt } : null, providers: Object.values(c.get("container").integrations.calendars).map((p) => ({ key: p.provider, status: p.status })) };
  });
  return c.json(row);
});

/**
 * Someone's availability changed (hours saved, or a calendar connected): interviews waiting for anyone's availability
 * at all wait on the bare key; those waiting on "no common times" or "none of these work" wait on their own interview's
 * key, so each open interview this person is on is woken too.
 */
export async function signalAvailabilityChanged(tx: Tx, container: Container, input: { companyId: string; userId: string }): Promise<void> {
  await container.engine.signal(tx, { companyId: input.companyId, key: "availability.updated", payload: { userId: input.userId } });
  const open = await tx.select({ id: interviews.id }).from(interviews).innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id)).where(and(eq(interviews.companyId, input.companyId), eq(interviewParticipants.userId, input.userId), inArray(interviews.status, ["proposed", "scheduling"])));
  for (const iv of open) await container.engine.signal(tx, { companyId: input.companyId, key: `${iv.id}:availability.updated`, payload: { userId: input.userId } });
}

meRoutes.put("/availability", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = InterviewerAvailabilityInput.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const r = await upsertAvailability(tx, { companyId: t.companyId, userId: t.userId, timezone: body.timezone, windows: body.windows, bufferMinutes: body.bufferMinutes, maxPerDay: body.maxPerDay, actor: actorOf(c) });
    await signalAvailabilityChanged(tx, container, { companyId: t.companyId, userId: t.userId });
    return r;
  });
  await container.kick();
  return c.json({ timezone: row.timezone, windows: row.windows, bufferMinutes: row.bufferMinutes, maxPerDay: row.maxPerDay, updatedAt: row.updatedAt });
});
