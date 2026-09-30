import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { BookOnBehalf, CancelInterview, InterviewOutcome, InterviewerAvailabilityInput, RecordDecision, RequestInterview, RescheduleInterview } from "@ros/contracts";
import { STAGE_LABEL, assertCan, audit, availabilityFor, calendarConnectionFor, can, defaultSchedulingWindow, emit, notify, publicConnection, scopeAllows, transition, upsertAvailability } from "@ros/core";
import { applications, approvalRequests, candidates, companies, events, interviewParticipants, interviews, jobs, memberships, rolePackets, roles, users, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { sendDeclineAfterHumanDecision } from "../services/application-actions";
import { cancelInterviewInTx } from "../services/interview-cancel";
import { interviewBriefFor } from "../services/interviewer-view";

/**
 * Interviews (docs/07 §Interviews and calendars; slice 5 step 9). A person approves every interview (policy
 * `interview.request` never drops below approval); the workflow does the scheduling; these routes let people see,
 * re-offer, cancel, record what happened, and book on a candidate's behalf. Nothing here returns a credential.
 * Who may do what comes from the permission matrix (packages/core/src/permissions.ts): `interview.request` to approve a
 * round, `interview.manage` to re-offer, cancel, book on behalf or record an outcome for any interview, and
 * `interview.decide` to record the decision afterwards. An interviewer records the outcome of their own interview only.
 */

async function summary(tx: Parameters<Parameters<typeof withTenant>[2]>[0], row: typeof interviews.$inferSelect) {
  const [app] = await tx.select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId, stage: applications.stage }).from(applications).where(eq(applications.id, row.applicationId)).limit(1);
  const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName, location: candidates.location }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const parts = await tx.select({ userId: interviewParticipants.userId, status: interviewParticipants.status, name: users.name, email: users.email }).from(interviewParticipants).innerJoin(users, eq(users.id, interviewParticipants.userId)).where(eq(interviewParticipants.interviewId, row.id));
  return {
    id: row.id, applicationId: row.applicationId, roleId: app.roleId, roleTitle: role?.title ?? null, roundKey: row.roundKey, title: row.title, format: row.format, durationMinutes: row.durationMinutes, status: row.status,
    startsAt: row.startsAt, endsAt: row.endsAt, timezone: row.timezone, meetingUrl: row.meetingUrl, linkSource: row.linkSource, attempt: row.attempt, offeredSlots: row.offeredSlots, selectedSlot: row.selectedSlot,
    candidateAvailability: row.candidateAvailability, schedulingWindow: row.schedulingWindow, rescheduleCountCandidate: row.rescheduleCountCandidate, outcome: row.outcome, decision: row.decision, decisionNote: row.decisionNote,
    reminders: row.reminders, cancelReason: row.cancelReason, scheduleTokenExpiresAt: row.scheduleTokenExpiresAt, createdAt: row.createdAt, createdBy: row.createdBy,
    candidate: { firstName: cand?.firstName ?? "", lastName: cand?.lastName ?? "", timezone: cand?.location?.timezone ?? null, stage: app.stage, stageLabel: STAGE_LABEL[app.stage] },
    participants: parts.map((p) => ({ userId: p.userId, name: p.name, email: p.email, status: p.status })),
    calendarRefs: Object.fromEntries(Object.entries((row.calendarRefs ?? {}) as Record<string, { provider: string; eventId: string; htmlLink: string | null; meetingUrl: string | null }>).map(([uid, r]) => [uid, { provider: r.provider, eventId: r.eventId, htmlLink: r.htmlLink, meetingUrl: r.meetingUrl }])),
  };
}

/** Owner-side reschedule or cancellation: the current run ends on its own once the attempt changes; a new run starts for a reschedule. */
async function supersede(c: Context<Vars>, input: { interviewId: string; mode: "reschedule" | "cancel"; reason: string | null; window?: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean } | null; byCandidate?: boolean }) {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const now = container.engine.clock();
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [iv] = await tx.select().from(interviews).where(and(eq(interviews.id, input.interviewId), eq(interviews.companyId, t.companyId))).limit(1);
    if (!iv) throw new HttpError(404, "not_found", "Interview not found.");
    if (["cancelled", "completed", "no_show"].includes(iv.status)) throw new HttpError(409, "interview_not_schedulable", `This interview is ${iv.status}.`);
    const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
    const [app] = await tx.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
    const actor = actorOf(c);
    if (input.mode === "cancel") {
      // The one cancellation path (services/interview-cancel.ts): it also queues the calendar events' removal.
      await cancelInterviewInTx(tx, container, { companyId: t.companyId, interview: iv, actor, by: t.role, reason: input.reason, byCandidate: input.byCandidate, now });
      return iv.id;
    }
    const window = { ...iv.schedulingWindow, ...(input.window ?? {}) };
    if (!window.fromDate || !window.toDate) Object.assign(window, defaultSchedulingWindow(now, (await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, t.companyId)).limit(1))[0].timezone));
    await tx.update(interviews).set({ status: "scheduling", attempt: iv.attempt + 1, selectedSlot: null, offeredSlots: [], startsAt: null, endsAt: null, scheduleToken: null, scheduleTokenExpiresAt: null, schedulingWindow: window, rescheduleCountCandidate: input.byCandidate ? iv.rescheduleCountCandidate + 1 : iv.rescheduleCountCandidate, reminders: {}, meetingUrl: iv.linkSource === "pasted" ? iv.meetingUrl : null }).where(eq(interviews.id, iv.id));
    // The booked time is gone, so the interviewers are back to invited until the workflow books the next one.
    await tx.update(interviewParticipants).set({ status: "invited" }).where(eq(interviewParticipants.interviewId, iv.id));
    await emit(tx, { type: "interview.rescheduled", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: !!input.byCandidate, attempt: iv.attempt + 1, hadEvents } });
    if (app.stage === "interview_scheduled") await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by: t.role, actor, reason: "interview being rescheduled" });
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: t.companyId, subject: { type: "interview", id: iv.id }, state: { interviewId: iv.id, applicationId: iv.applicationId, roleId: app.roleId, roundKey: iv.roundKey, attempt: iv.attempt + 1 }, idempotencyKey: `schedule:${iv.id}:${iv.attempt + 1}`, actor });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId: t.companyId, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    return iv.id;
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
  const status = c.req.query("status");
  const mine = c.req.query("mine") === "1" || t.role === "interviewer";
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const conds = [eq(interviews.companyId, t.companyId)];
    if (status) conds.push(eq(interviews.status, status));
    if (from) conds.push(gte(interviews.startsAt, from));
    if (to) conds.push(lte(interviews.startsAt, to));
    let list = await tx.select().from(interviews).where(and(...conds)).orderBy(desc(interviews.createdAt)).limit(300);
    if (mine) {
      const ids = (await tx.select({ id: interviewParticipants.interviewId }).from(interviewParticipants).where(eq(interviewParticipants.userId, t.userId))).map((r) => r.id);
      list = list.filter((r) => ids.includes(r.id));
    }
    if (t.staff?.scope.roleId) {
      const appIds = (await tx.select({ id: applications.id }).from(applications).where(eq(applications.roleId, t.staff.scope.roleId))).map((a) => a.id);
      list = list.filter((r) => appIds.includes(r.applicationId));
    }
    // a grant about one candidate shows that candidate's interviews only, the same limit as the role's applications list
    if (t.staff?.scope.applicationId) list = list.filter((r) => r.applicationId === t.staff!.scope.applicationId);
    const out = [];
    for (const r of list) out.push(await summary(tx, r));
    return out;
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
  const id = await supersede(c, { interviewId: c.req.param("id"), mode: "reschedule", reason: body.reason ?? null, window: body.window ?? null });
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, id)))[0]));
  return c.json(row);
});

interviewRoutes.post("/:id/cancel", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = CancelInterview.parse(await c.req.json());
  const id = await supersede(c, { interviewId: c.req.param("id"), mode: "cancel", reason: body.reason });
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, id)))[0]));
  return c.json(row);
});

/**
 * "Did it take place?" from a participant or someone who manages interviews; a no-show is recorded, never held against
 * anyone automatically. Either answer ends the interview, so a candidate still at "Interviewing" moves to "Interview
 * done: decision needed" right away instead of waiting for the workflow's closing timer, and the hiring team is asked
 * "How did it go?" just as the timer would have asked; the decision stays a person's.
 */
interviewRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = InterviewOutcome.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const [iv] = await tx.select().from(interviews).where(and(eq(interviews.id, c.req.param("id")), eq(interviews.companyId, t.companyId))).limit(1);
    if (!iv) throw new HttpError(404, "not_found", "Interview not found.");
    const parts = await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
    if (!can(t.role, "interview.manage") && !parts.some((p) => p.userId === t.userId)) throw new HttpError(403, "forbidden", "Only a participant or someone who manages interviews can record what happened.");
    if (!["scheduled", "completed"].includes(iv.status)) throw new HttpError(409, "interview_not_schedulable", `This interview is ${iv.status}.`);
    const status = body.outcome === "happened" ? "completed" : "no_show";
    const actor = actorOf(c);
    const [u] = await tx.update(interviews).set({ outcome: body.outcome, status }).where(eq(interviews.id, iv.id)).returning();
    await emit(tx, { type: "interview.outcome_recorded", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { outcome: body.outcome } });
    const [app] = await tx.select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId, stage: applications.stage }).from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
    if (app?.stage === "interview_scheduled") {
      // The workflow's closing step (an hour after the end) would move the candidate, record that the interview is over
      // and ask the hiring team for their decision; it finds the interview already ended and stops, so all three happen here.
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_complete", by: t.role, actor, reason: body.outcome === "happened" ? "interview took place" : `interview ${body.outcome.replace(/_/g, " ")}` });
      await emit(tx, { type: "interview.completed", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { attempt: iv.attempt, via: "outcome" } });
      const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const name = `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "the candidate";
      await notify(tx, { companyId: t.companyId, kind: "interview.decision", title: `How did it go with ${name}?`, body: `${iv.title} is over. Next round, finalist, or not moving forward: your call, recorded with your reason.`, action: { label: "Decide", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    }
    return summary(tx, u);
  });
  return c.json(row);
});

/** The owner picks a time for the candidate after a phone call; recorded as a human action. */
interviewRoutes.post("/:id/book-on-behalf", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = BookOnBehalf.parse(await c.req.json());
  const container = c.get("container");
  const id = await withTenant(container.db, t.companyId, async (tx) => {
    const [iv] = await tx.select().from(interviews).where(and(eq(interviews.id, c.req.param("id")), eq(interviews.companyId, t.companyId))).limit(1);
    if (!iv) throw new HttpError(404, "not_found", "Interview not found.");
    if (iv.status !== "scheduling") throw new HttpError(409, "interview_not_schedulable", "Times are not being offered right now.");
    const slot = iv.offeredSlots.find((s) => s.id === body.slotId);
    if (!slot) throw new HttpError(400, "slot_unknown", "That time is not one of the offered slots.");
    await tx.update(interviews).set({ selectedSlot: slot }).where(eq(interviews.id, iv.id));
    await emit(tx, { type: "interview.slot_selected", companyId: t.companyId, actor: actorOf(c), subject: { type: "interview", id: iv.id }, payload: { slotId: slot.id, onBehalf: true, note: body.note ?? null } });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "candidate.viewed", target: { type: "interview", id: iv.id }, reason: `booked on the candidate's behalf: ${body.note ?? "no note"}` });
    await container.engine.signal(tx, { companyId: t.companyId, key: `${iv.id}:interview.slot_selected`, payload: { slotId: slot.id, onBehalf: true } });
    return iv.id;
  });
  await container.kick();
  const row = await withTenant(container.db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, id)))[0]));
  return c.json(row);
});

/** Routes under /applications/:id that create interviews and record decisions. */
export const applicationInterviewRoutes = new Hono<Vars>();
applicationInterviewRoutes.use("/:id/*", applicationScopeGuard);

applicationInterviewRoutes.post("/:id/interviews", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.request");
  const body = RequestInterview.parse(await c.req.json());
  const container = c.get("container");
  const now = container.engine.clock();
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(and(eq(applications.id, c.req.param("id")), eq(applications.companyId, t.companyId))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    if (!["triaged", "screen_complete", "interview_recommended", "interview_complete", "eligible", "screen_invited", "screening"].includes(app.stage)) throw new HttpError(409, "interview_not_schedulable", `A candidate at "${STAGE_LABEL[app.stage]}" cannot be moved to an interview from here.`);
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    const round = pv?.packet.interviews.plan.find((r) => r.key === body.roundKey);
    if (!round) throw new HttpError(400, "round_unknown", "That round is not in the approved interview plan.");
    const members = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, t.companyId), eq(memberships.status, "active"), inArray(memberships.userId, body.interviewerUserIds)));
    if (members.length !== body.interviewerUserIds.length) throw new HttpError(400, "interviewer_unknown", "Every interviewer must be an active member of the company.");
    const open = await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["proposed", "scheduling", "scheduled"])));
    if (open.length) throw new HttpError(409, "interview_open", "An interview is already being scheduled for this candidate. Reschedule or cancel it first.");
    const [company] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const window = { ...defaultSchedulingWindow(now, company.timezone), ...(body.window ?? {}) };
    if (body.linkSource === "pasted" && !body.meetingUrl) throw new HttpError(400, "meeting_url_required", "Paste the meeting link, or let the calendar create one.");
    const actor = actorOf(c);
    const [iv] = await tx.insert(interviews).values({ companyId: t.companyId, applicationId: app.id, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status: "proposed", linkSource: body.linkSource, meetingUrl: body.linkSource === "pasted" ? body.meetingUrl ?? null : null, schedulingWindow: window, createdBy: actor, timezone: company.timezone }).returning();
    for (const uid of body.interviewerUserIds) await tx.insert(interviewParticipants).values({ companyId: t.companyId, interviewId: iv.id, userId: uid, role: "interviewer", status: "invited" });
    // Each interviewer is told the moment they are put on the interview ("invited"); the booking confirms them later.
    const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
    await notify(tx, { companyId: t.companyId, kind: "interview.assigned", title: `You are interviewing ${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim(), body: `${round.title} for ${role?.title ?? "a role"}, ${round.durationMinutes} minutes. Times are offered to the candidate from your calendar or declared hours; you will be told as soon as one is booked.`, action: { label: "Open the interview", href: `/interviews/${iv.id}` }, userIds: body.interviewerUserIds });
    // The human's click is the approval (policy interview.request, approval level, AC10.1). Any pending recommendation is resolved by it.
    const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.recommend_interview"), eq(approvalRequests.status, "pending")));
    for (const p of pending) await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: now.toISOString(), decisionNote: body.note ?? "interview requested" }).where(eq(approvalRequests.id, p.id));
    if (app.stage !== "interview_recommended" && app.stage !== "interview_complete") await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by: t.role, actor, reason: body.note ?? "interview approved" });
    await emit(tx, { type: "interview.requested", companyId: t.companyId, actor, subject: { type: "interview", id: iv.id }, payload: { applicationId: app.id, roundKey: round.key, interviewers: body.interviewerUserIds, linkSource: body.linkSource, window, approvedBy: t.userId } });
    await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.request", roundKey: round.key, note: body.note ?? null } });
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: t.companyId, subject: { type: "interview", id: iv.id }, state: { interviewId: iv.id, applicationId: app.id, roleId: app.roleId, roundKey: round.key, attempt: 1 }, idempotencyKey: `schedule:${iv.id}:1`, actor });
    return iv.id;
  });
  await container.kick();
  const row = await withTenant(container.db, t.companyId, async (tx) => summary(tx, (await tx.select().from(interviews).where(eq(interviews.id, result)))[0]));
  return c.json(row, 201);
});

/**
 * The human decision after an interview (HARD human-only in spirit: there is no automated path to any of these). It is
 * recorded on the newest interview that is over and still undecided, so a second decision never overwrites the first
 * one's, and a "not moving forward" sends the respectful message through the same gate as the actions route
 * (founder correction 6: candidate-facing decline only after the human decision). `dispositionSent` says whether it went.
 */
applicationInterviewRoutes.post("/:id/decision", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.decide");
  const body = RecordDecision.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(and(eq(applications.id, c.req.param("id")), eq(applications.companyId, t.companyId))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    const [last] = await tx.select().from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["completed", "no_show"]), isNull(interviews.decision))).orderBy(desc(interviews.createdAt)).limit(1);
    const actor = actorOf(c);
    if (last) await tx.update(interviews).set({ decision: body.decision, decisionNote: body.note ?? null }).where(eq(interviews.id, last.id));
    let stage = app.stage;
    let nextRoundKey: string | null = null;
    let dispositionSent: boolean | undefined;
    if (body.decision === "not_moving_forward") {
      if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
      assertCan(t.role, "application.reject");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by: t.role, actor, reason: body.reason, payload: { note: body.note ?? null } });
      await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "application.rejected", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true, afterInterview: true } });
      dispositionSent = await sendDeclineAfterHumanDecision(tx, container, { companyId: t.companyId, app, actor, reason: body.reason });
      stage = "rejected";
    } else if (body.decision === "finalist") {
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "finalist", by: t.role, actor, reason: body.note ?? "finalist after interview" });
      stage = "finalist";
    } else if (body.decision === "next_round") {
      const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
      const plan = pv?.packet.interviews.plan ?? [];
      const idx = last ? plan.findIndex((r) => r.key === last.roundKey) : -1;
      nextRoundKey = plan[idx + 1]?.key ?? null;
      if (!nextRoundKey) throw new HttpError(409, "no_next_round", "The interview plan has no further round; choose finalist or not moving forward.");
    } else if (body.decision === "hired") {
      throw new HttpError(409, "not_in_release", "Offers and hiring are not part of this release; mark the candidate a finalist.");
    }
    await emit(tx, { type: "interview.decision_recorded", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { decision: body.decision, interviewId: last?.id ?? null, note: body.note ?? null, nextRoundKey } });
    await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.decision", decision: body.decision } });
    return { ok: true, stage, nextRoundKey, ...(dispositionSent === undefined ? {} : { dispositionSent }) };
  });
  await container.kick();
  return c.json(result);
});

/** Interviews of one role. */
export const roleInterviewRoutes = new Hono<Vars>();
roleInterviewRoutes.use("/:id/*", roleScopeGuard);
roleInterviewRoutes.get("/:id/interviews", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const appIds = (await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.roleId, c.req.param("id")), eq(applications.companyId, t.companyId)))).map((a) => a.id);
    if (!appIds.length) return [];
    const list = await tx.select().from(interviews).where(inArray(interviews.applicationId, appIds)).orderBy(desc(interviews.createdAt));
    const out = [];
    for (const r of list) out.push(await summary(tx, r));
    return out;
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

meRoutes.put("/availability", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = InterviewerAvailabilityInput.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const r = await upsertAvailability(tx, { companyId: t.companyId, userId: t.userId, timezone: body.timezone, windows: body.windows, bufferMinutes: body.bufferMinutes, maxPerDay: body.maxPerDay, actor: actorOf(c) });
    await container.engine.signal(tx, { companyId: t.companyId, key: "availability.updated", payload: { userId: t.userId } });
    return r;
  });
  await container.kick();
  return c.json({ timezone: row.timezone, windows: row.windows, bufferMinutes: row.bufferMinutes, maxPerDay: row.maxPerDay, updatedAt: row.updatedAt });
});
