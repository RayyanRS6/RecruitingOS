import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { SCREEN_PERSON_ROUTE_STATUSES, type Actor, type RolePacket } from "@ros/contracts";
import { createScreen, sendAcknowledgment, sendScreenInvite, type AcknowledgedInterview } from "@ros/agents";
import { emit, entitlements, evaluateEligibility, notify, transition } from "@ros/core";
import { applications, assessments, communications, events, screens, workflowRuns, type Tx, type candidates, type companies, type roles } from "@ros/db";
import type { Integrations, SendResult } from "@ros/integrations";
import type { WorkflowEngine } from "./engine";

/**
 * Every applicant's AI interview and the one email (20 October 2026, R20-4, R20-5, R20-10, R20-11). No approval, no
 * "likely fit" gate, no recommendation or consistency check: once the résumé is read (the intake's `ready`, usually a
 * minute after Send) or at the latest ten minutes after applying, the interview is created on the web and the one email
 * carries its link. Only these stop it: the application left the process (the neutral thank-you), a "No" to a must-have
 * question on the form (the neutral thank-you; "Keep them in" sends the link), and the month's AI interviews used up
 * (the email says the link follows; Q17). A gap seen only in the résumé reading never stops it. Shared by the `screen`
 * run and, for an emailed-in applicant, the intake's first step.
 */

/** The intake signals `readingSettledSignal(applicationId)` when the reading is done, could not be done, or the application is held. */
export const READING_SETTLED_EVENT = "reading.settled";
export const readingSettledSignal = (applicationId: string): string => `${applicationId}:${READING_SETTLED_EVENT}`;
/** The one email goes once the reading is done, and at the latest this long after applying (R20-5). */
export const READING_WAIT_MINUTES = 10;
/** The interview's link stays open five days: one reminder after 48 hours, closed 72 hours after that. */
export const INTERVIEW_LINK_HOURS = 48 + 72;
const HOUR = 3_600_000;

type Bundle = { app: typeof applications.$inferSelect; candidate: typeof candidates.$inferSelect; role: typeof roles.$inferSelect; company: typeof companies.$inferSelect; packet: RolePacket };
type Deps = { integrations: Integrations; jobsBaseUrl: string };
type At = { now: Date; actor: Actor; correlationId: string | null; workflowRunId: string | null };

/**
 * What became of the offer: `invited` (the interview exists and its link is on its way); `left` (the application left the
 * process or a person moved it on: the neutral thank-you went); `has_screen` (a person sent a link meanwhile: the one email
 * points to it, never a second interview); `held` (a must-have "No": the neutral thank-you went); `used_up` (the email
 * said the link follows).
 */
export type InterviewOffer = { kind: "invited"; screenId: string; token: string; email: SendResult } | { kind: "left" } | { kind: "has_screen" } | { kind: "held" } | { kind: "used_up"; used: number; limit: number | null };

/** Where the interview is offered from; `ineligible` is held for a person. Anything else has left the process or moved on. */
const OFFER_STAGES: readonly string[] = ["applied", "received", "eligible", "triaged"];
/** Where a person's own link puts the application (invited, in the chat) while the interview's run still waited. */
const LINK_STAGES: readonly string[] = ["screen_invited", "screening"];
const ENDED_RUN: readonly string[] = ["completed", "failed", "cancelled"];

/** The interview's address, on the job-page host like the page they applied on. */
export function interviewUrl(jobsBaseUrl: string, token: string): string {
  return `${jobsBaseUrl}/c/screen/${token}`;
}

/**
 * Offers the AI interview with the application, in the caller's transaction (see the module note). A still `received`
 * application (the ten-minute fallback ran before the intake's eligibility step) is checked here with the pure
 * `evaluateEligibility` first, so the fallback never skips a must-have question; a pass is recorded as the intake would.
 */
export async function offerInterview(q: Tx, deps: Deps, b: Bundle, at: At): Promise<InterviewOffer> {
  const { app, candidate, role, company, packet } = b;
  const minutes = packet.screening.maxMinutes;
  const ack = (interview: AcknowledgedInterview) => acknowledgeOnce(q, deps, b, interview, at);
  // Looked at before the stage: a link a person sent while the résumé was read moved the stage on (invited, in the chat),
  // and the one email then points to that link instead of thanking them without it.
  const [latest] = await q.select({ token: screens.token, status: screens.status }).from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt)).limit(1);
  const open = !!latest && (SCREEN_PERSON_ROUTE_STATUSES as readonly string[]).includes(latest.status);
  if (latest && (OFFER_STAGES.includes(app.stage) || app.stage === "ineligible" || (open && LINK_STAGES.includes(app.stage)))) {
    await ack(open ? { kind: "link", url: interviewUrl(deps.jobsBaseUrl, latest.token), minutes } : { kind: "none" });
    return { kind: "has_screen" };
  }
  if (app.stage !== "ineligible" && !OFFER_STAGES.includes(app.stage)) {
    await ack({ kind: "none" });
    return { kind: "left" };
  }
  if (app.stage === "ineligible") {
    await ack({ kind: "none" });
    return { kind: "held" };
  }
  if (app.stage === "applied" || app.stage === "received") {
    const result = evaluateEligibility(packet.requirements.eligibility, (app.answers.eligibility ?? {}) as Record<string, unknown>, at.now);
    if (!result.passed) {
      // The intake's `eligibility` step holds it for a person when it gets there, with the team's notice.
      await ack({ kind: "none" });
      return { kind: "held" };
    }
    await q.update(applications).set({ eligibility: result }).where(eq(applications.id, app.id));
    await emit(q, { type: "eligibility.evaluated", companyId: company.id, actor: at.actor, subject: { type: "application", id: app.id }, payload: { passed: true, failed: [], unverifiable: result.unverifiable.map((u) => u.key), at: "interview" }, correlationId: at.correlationId });
    if (app.stage === "applied") await transition(q, { applicationId: app.id, companyId: company.id, to: "received", by: "system", actor: at.actor, correlationId: at.correlationId });
    await transition(q, { applicationId: app.id, companyId: company.id, to: "eligible", by: "system", actor: at.actor, correlationId: at.correlationId });
  }
  const ent = await entitlements.check(q, company.id, entitlements.TEXT_SCREENS, 1);
  if (!ent.ok) {
    if (company.planKey !== "design_partner") {
      await ack({ kind: "follows", minutes });
      return { kind: "used_up", used: ent.used, limit: ent.limit };
    }
    await overDesignPartnerAllowance(q, { companyId: company.id, applicationId: app.id, name: `${candidate.firstName} ${candidate.lastName}`, ent, planKey: company.planKey, actor: at.actor, correlationId: at.correlationId });
  }
  const scr = await createScreen(q, { companyId: company.id, applicationId: app.id, channel: "web", workflowRunId: at.workflowRunId, expiresAt: new Date(at.now.getTime() + INTERVIEW_LINK_HOURS * HOUR).toISOString(), now: at.now, invitedVia: "with_application", flow: "one_visit" });
  // The one email, or, when it went before the interview existed (held, then kept in; used up, then topped up), the link in one of its own.
  const email = (await ack({ kind: "link", url: interviewUrl(deps.jobsBaseUrl, scr.token), minutes }))
    ?? (await sendScreenInvite(q, deps.integrations, { application: app, candidate, role, company, packet, actor: at.actor, correlationId: at.correlationId, appBaseUrl: deps.jobsBaseUrl, screen: { id: scr.id, token: scr.token, channel: "web" } })).email;
  await transition(q, { applicationId: app.id, companyId: company.id, to: "screen_invited", by: "system", actor: at.actor, correlationId: at.correlationId });
  await emit(q, { type: "screen.invited", companyId: company.id, actor: at.actor, subject: { type: "screen", id: scr.id }, payload: { channel: "web", applicationId: app.id, invitedBy: "system", invitedVia: "with_application" }, correlationId: at.correlationId });
  return { kind: "invited", screenId: scr.id, token: scr.token, email };
}

/**
 * The one email, once per application (its `ack:` key); null when it went already. Someone the company had before this
 * application (known-bugs row 17) is told it was sent using their address.
 */
async function acknowledgeOnce(q: Tx, deps: Deps, b: Bundle, interview: AcknowledgedInterview, at: At): Promise<SendResult | null> {
  const [sent] = await q.select({ id: communications.id }).from(communications).where(eq(communications.idempotencyKey, `ack:${b.app.id}`)).limit(1);
  if (sent) return null;
  const knownAddress = (await q.select({ id: applications.id }).from(applications).where(and(eq(applications.candidateId, b.candidate.id), ne(applications.id, b.app.id))).limit(1)).length > 0;
  const res = await sendAcknowledgment(q, deps.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: at.actor, correlationId: at.correlationId, appBaseUrl: deps.jobsBaseUrl, interview, ...(knownAddress ? { knownAddress } : {}) });
  await emit(q, { type: "application.acknowledged", companyId: b.company.id, actor: at.actor, subject: { type: "application", id: b.app.id }, payload: { channel: "email", status: res.status, interview: interview.kind }, correlationId: at.correlationId });
  return res;
}

/** Founder decision F8: a Design Partner's allowance never interrupts a candidate; the owner and ITS are told. */
export async function overDesignPartnerAllowance(q: Tx, input: { companyId: string; applicationId: string; name: string; ent: { used: number; limit: number | null }; planKey: string; actor: Actor; correlationId: string | null }): Promise<void> {
  await emit(q, { type: "entitlement.exceeded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { key: entitlements.TEXT_SCREENS, limit: input.ent.limit, used: input.ent.used, plan: input.planKey }, correlationId: input.correlationId });
  await notify(q, { companyId: input.companyId, kind: "entitlement.text_screens", title: "Over the pilot's included AI interviews", body: `${input.name} gets the AI interview anyway: the Design Partner pilot never interrupts a candidate in progress. ITS has been told so the allowance can be reviewed.`, action: { label: "See usage", href: "/setup" } });
}

/**
 * Whether the résumé reading is settled, read from what is stored (a signal sent before anyone waited is not kept): the
 * reading is written, no intake is still on (the first, or one "Review anyway" reopened) or the one on reads nothing by
 * AI, or the application moved on (held on a must-have answer, invited, decided, left).
 */
export async function readingSettled(q: Tx, app: { id: string; stage: string }): Promise<boolean> {
  if (!["applied", "received", "eligible"].includes(app.stage)) return true;
  const [triage] = await q.select({ id: assessments.id }).from(assessments).where(and(eq(assessments.applicationId, app.id), eq(assessments.kind, "triage"))).limit(1);
  if (triage) return true;
  const on = await q.select({ state: workflowRuns.state }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "application_intake"), notInArray(workflowRuns.status, [...ENDED_RUN]), sql`${workflowRuns.subject}->>'id' = ${app.id}`));
  return on.every((run) => !!(run.state as { noAiReading?: boolean }).noAiReading);
}

/**
 * The application's intake run still on (the first, or one reopened) that goes on to the reading by itself or once woken
 * by `heldDecisionSignal`, if any; never one waiting on a person's approval, which no wake moves.
 */
export async function intakeOn(q: Tx, applicationId: string): Promise<string | null> {
  const on = await q.select({ id: workflowRuns.id, wait: workflowRuns.wait }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "application_intake"), notInArray(workflowRuns.status, [...ENDED_RUN]), sql`${workflowRuns.subject}->>'id' = ${applicationId}`));
  return on.find((r) => r.wait?.kind !== "human")?.id ?? null;
}

/** A `screen` run that is every applicant's AI interview: waiting for the reading or more interviews (`mode`), or made with an emailed-in applicant's one email (`invitedVia`). */
const AUTOMATIC = sql`(${workflowRuns.state}->>'mode' = 'with_application' or ${workflowRuns.state}->>'invitedVia' = 'with_application')`;

/** Every applicant's AI interview run is still on for this application, under any key (`screen:<id>`, or one started again). */
export async function interviewRunOn(q: Tx, applicationId: string): Promise<boolean> {
  const [row] = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "screen"), notInArray(workflowRuns.status, [...ENDED_RUN]), sql`${workflowRuns.subject}->>'id' = ${applicationId}`, AUTOMATIC)).limit(1);
  return !!row;
}

/**
 * Of these applications, the ones whose AI interview is still being prepared: its run is on and has made no interview
 * yet (waiting for the reading, for more interviews, or for "Keep them in"). A person's own link would race it, so
 * "Send a new AI interview link" waits (`ApplicationFacts.interviewPreparing`).
 */
export async function interviewsBeingPrepared(q: Tx, applicationIds: string[]): Promise<Set<string>> {
  if (!applicationIds.length) return new Set();
  const rows = await q.select({ applicationId: sql<string>`${workflowRuns.subject}->>'id'` }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "screen"), notInArray(workflowRuns.status, [...ENDED_RUN]), inArray(sql`${workflowRuns.subject}->>'id'`, applicationIds), sql`${workflowRuns.state}->>'mode' = 'with_application'`, sql`${workflowRuns.state}->>'screenId' is null`));
  return new Set(rows.map((r) => r.applicationId));
}

/**
 * Of these applications, the ones whose AI interview waits only for more AI interviews this month (Q17, R20-11: its run
 * is on and records since when it waits), so "Getting the AI interview ready" can say that, not that a reading runs.
 */
export async function interviewsWaitingForMore(q: Tx, applicationIds: string[]): Promise<Set<string>> {
  if (!applicationIds.length) return new Set();
  const rows = await q.select({ applicationId: sql<string>`${workflowRuns.subject}->>'id'` }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "screen"), notInArray(workflowRuns.status, [...ENDED_RUN]), inArray(sql`${workflowRuns.subject}->>'id'`, applicationIds), sql`${workflowRuns.state}->>'waitingForAllowance' is not null`));
  return new Set(rows.map((r) => r.applicationId));
}

/**
 * Of these applications, the ones whose AI interview never came because the month's AI interviews stayed used up for
 * the whole wait (Q17: the run's `screen.allowance_lapsed`). Offered, unlike an application from before 20 October
 * 2026, so their résumé-only score is kept apart like one whose link closed (`interviewInScore`, R20-9).
 */
export async function interviewsLapsedOnAllowance(q: Tx, applicationIds: readonly string[]): Promise<Set<string>> {
  if (!applicationIds.length) return new Set();
  const rows = await q.select({ applicationId: events.subjectId }).from(events).where(and(eq(events.subjectType, "application"), inArray(events.subjectId, [...applicationIds]), eq(events.type, "screen.allowance_lapsed")));
  return new Set(rows.map((r) => r.applicationId));
}

/**
 * Starts every applicant's AI interview run for an application that has no interview and no such run on, at a stage
 * where it is offered (or held on a must-have answer): a decision taken back or reopened ("Review anyway"), "Keep them
 * in" after the run gave up, an intake or a waiting suggestion from before 20 October 2026. `cutShort`: only when such a
 * run existed before (taking back a decision restores what the decision stopped, nothing more). Under `screen:<id>` when
 * that key was never used, else a key of its own; it waits for the reading like the first, and since the one email went
 * already, the link goes in an email of its own. True when a run was started.
 */
export async function startInterviewAgain(q: Tx, engine: Pick<WorkflowEngine, "start">, input: { companyId: string; applicationId: string; actor: Actor; now: Date; cutShort?: boolean }): Promise<boolean> {
  const [app] = await q.select({ id: applications.id, roleId: applications.roleId, stage: applications.stage }).from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app || (app.stage !== "ineligible" && !OFFER_STAGES.includes(app.stage))) return false;
  const [scr] = await q.select({ id: screens.id }).from(screens).where(eq(screens.applicationId, app.id)).limit(1);
  if (scr || (await interviewRunOn(q, app.id))) return false;
  const first = `screen:${app.id}`;
  const [used] = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, first)).limit(1);
  if (input.cutShort) {
    const [before] = used ? [used] : await q.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "screen"), sql`${workflowRuns.subject}->>'id' = ${app.id}`, AUTOMATIC)).limit(1);
    if (!before) return false;
  }
  const state = { applicationId: app.id, roleId: app.roleId, invitedBy: "system", flow: "one_visit", channel: "web", mode: "with_application" };
  await engine.start(q, { workflowKey: "screen", companyId: input.companyId, subject: { type: "application", id: app.id }, state, idempotencyKey: used ? `${first}:again:${input.now.getTime()}` : first, actor: input.actor });
  return true;
}
