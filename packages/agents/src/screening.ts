import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, RolePacket, ScreenChannel, ScreenProgress, ScreenTranscriptEntry, ScreenTurn } from "@ros/contracts";
import { runPromptDetached, screenAssessPrompt, screenTurnPrompt, type AiRuntime, type RunOutcome, type ScreenContext } from "@ros/ai";
import { createEscalation, emit, humanResponseExpectation, loadBusinessCalendar, notify, transition } from "@ros/core";
import { applications, assessments, candidates, companies, randomToken, rolePackets, roles, screens, withTenant, type Db, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { deliverSms, recordInbound } from "./coordinator";

/**
 * The Screening agent (docs/05). Conversation turns run when the candidate writes (web chat or SMS); the durable
 * `screen` workflow owns the invite, reminders, expiry, the scorecard, and the recommendation.
 * Progress lives in code (`screens.progress`), so a restart, a channel switch, or a model failure never loses the thread.
 *
 * Every model call happens with no database transaction open: a turn is a short transaction that records what the
 * candidate said, the model call, and a second short transaction that records the reply.
 */

export type ScreenDeps = {
  ai: AiRuntime;
  integrations: Integrations;
  appBaseUrl: string;
  /** Wakes the `screen` workflow (`screen:<id>:started`, `screen:<id>:completed`, `screen:<id>:human`). */
  signal?: (q: Queryable, input: { companyId: string; key: string; payload?: Record<string, unknown> }) => Promise<unknown>;
};

export type ScreenRow = typeof screens.$inferSelect;

const ACTIVE_STATUSES = new Set(["invited", "reminded", "in_progress"]);
const MAX_FOLLOW_UPS = 2;
export const EMPTY_SCREEN_PROGRESS: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };

export async function createScreen(q: Queryable, input: { companyId: string; applicationId: string; channel: ScreenChannel; workflowRunId?: string | null; expiresAt: string; now: Date }): Promise<ScreenRow> {
  const existing = await q.select().from(screens).where(and(eq(screens.applicationId, input.applicationId), inArray(screens.status, ["invited", "reminded", "in_progress"]))).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await q
    .insert(screens)
    .values({ companyId: input.companyId, applicationId: input.applicationId, channel: input.channel, status: "invited", token: randomToken(24), invitedAt: input.now.toISOString(), expiresAt: input.expiresAt, workflowRunId: input.workflowRunId ?? null })
    .returning();
  return row;
}

/** Everything the prompts need about the application, whether or not a screen row exists yet. */
export async function loadApplicationBundle(q: Queryable, applicationId: string) {
  const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) return null;
  const triage = app.latestAssessmentId ? (await q.select().from(assessments).where(eq(assessments.id, app.latestAssessmentId)).limit(1))[0] : undefined;
  return { app, candidate, role, company, packet: pv.packet, triageUnknowns: triage?.result.unknowns.map((u) => u.question) ?? [] };
}
type ApplicationBundle = NonNullable<Awaited<ReturnType<typeof loadApplicationBundle>>>;

export async function loadScreenBundle(q: Queryable, screenId: string) {
  const [screen] = await q.select().from(screens).where(eq(screens.id, screenId)).limit(1);
  if (!screen) return null;
  const b = await loadApplicationBundle(q, screen.applicationId);
  return b ? { ...b, screen } : null;
}
type ScreenBundle = NonNullable<Awaited<ReturnType<typeof loadScreenBundle>>>;

type ConversationState = Pick<ScreenRow, "channel" | "progress" | "answers" | "transcript">;

function contextOf(b: ApplicationBundle, screen: ConversationState, latest: string | null): ScreenContext {
  return {
    company: { name: b.company.name },
    packet: b.packet,
    candidate: { firstName: b.candidate.firstName },
    channel: screen.channel as ScreenChannel,
    progress: screen.progress,
    answers: screen.answers,
    transcript: screen.transcript,
    focusUnknowns: b.triageUnknowns,
    latestCandidateMessage: latest,
  };
}

/** Screening stays within the job. Anything about a protected characteristic the candidate volunteers is kept out of recorded answers (the transcript itself is the record). */
export function redactProtected(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const protectedPattern = /\b(i am|i'm|im)\s+\d{2}\b|\b\d{2}\s+years? old\b|\bmy (kids?|children|son|daughter|husband|wife|spouse)\b|\bpregnan|\bmaternity\b|\bchurch\b|\bmosque\b|\bsynagogue\b|\breligio|\bdisabilit|\bwheelchair\b|\bmy (illness|condition|diagnosis)\b|\bimmigra|\bcitizen(ship)?\b|\bvisa\b|\bnational(ity)?\b|\bdivorc|\bmarried\b|\bsingle mom\b|\bsingle dad\b/i;
  const kept = sentences.filter((s) => !protectedPattern.test(s));
  return kept.length ? kept.join(" ") : "(answer recorded; personal details omitted)";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The opening message                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export type ScreenOpening = { message: string; aiRunId: string | null } | { error: string };

/**
 * Phase one of the opening: the model call, made with no transaction open. Works before the screen row exists (the
 * workflow calls it while deciding to invite) and after (the web page opens an invited screen). Null when the
 * application is gone or the screen already has its opening, in which case nothing needs the model.
 */
export async function prepareScreenOpening(db: Db, ai: AiRuntime, input: { companyId: string; applicationId: string; channel: ScreenChannel; workflowRunId?: string | null; screen?: ConversationState | null }): Promise<RunOutcome<ScreenTurn> | null> {
  if (input.screen?.transcript.some((t) => t.role === "assistant")) return null;
  const b = await withTenant(db, input.companyId, (q) => loadApplicationBundle(q, input.applicationId));
  if (!b) return null;
  const state: ConversationState = input.screen ?? { channel: input.channel, progress: EMPTY_SCREEN_PROGRESS, answers: {}, transcript: [] };
  return runPromptDetached(db, ai, screenTurnPrompt, contextOf(b, state, null), { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { applicationId: input.applicationId, turn: 0 } });
}

/** Phase two of the opening: writes the first assistant message onto the screen, unless one is already there. */
export async function applyScreenOpening(q: Queryable, input: { companyId: string; screenId: string; packet: RolePacket; out: RunOutcome<ScreenTurn> | null }): Promise<ScreenOpening> {
  const [fresh] = await q.select().from(screens).where(eq(screens.id, input.screenId)).limit(1);
  if (!fresh) return { error: "screen not found" };
  const first = fresh.transcript.find((t) => t.role === "assistant");
  if (first) return { message: first.content, aiRunId: first.aiRunId ?? null };
  if (!input.out) return { error: "no opening was prepared" };
  const out = input.out;
  if (!out.ok) {
    await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: fresh.id }, payload: { reason: out.reason, error: out.error, turn: 0 } });
    return { error: out.error };
  }
  const turn = enforceTurnRules(out.output, input.packet, fresh.progress, fresh.answers);
  const entry: ScreenTranscriptEntry = { role: "assistant", content: turn.messageToCandidate, at: new Date().toISOString(), questionKey: turn.questionKey ?? undefined, channel: fresh.channel as ScreenChannel, aiRunId: out.runId };
  const progress = advanceProgress(fresh.progress, turn);
  await q.update(screens).set({ transcript: [...fresh.transcript, entry], progress }).where(eq(screens.id, fresh.id));
  return { message: turn.messageToCandidate, aiRunId: out.runId };
}

/** The first assistant message (disclosure and the first question) for an existing screen. Idempotent: generated once per screen. */
export async function openScreen(db: Db, companyId: string, deps: ScreenDeps, input: { screenId: string; actor: Actor }): Promise<ScreenOpening> {
  const b = await withTenant(db, companyId, (q) => loadScreenBundle(q, input.screenId));
  if (!b) return { error: "screen not found" };
  const first = b.screen.transcript.find((t) => t.role === "assistant");
  if (first) return { message: first.content, aiRunId: first.aiRunId ?? null };
  const out = await prepareScreenOpening(db, deps.ai, { companyId, applicationId: b.app.id, channel: b.screen.channel as ScreenChannel, workflowRunId: b.screen.workflowRunId, screen: b.screen });
  return withTenant(db, companyId, (q) => applyScreenOpening(q, { companyId, screenId: b.screen.id, packet: b.packet, out }));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Conversation turns                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

export type TurnResult =
  | { kind: "reply"; message: string; done: boolean; humanRequested: boolean; withdrawn?: boolean }
  | { kind: "closed"; message: string }
  | { kind: "error"; message: string };

export type TurnInput = { screenId: string; message: string; channel: ScreenChannel; actor: Actor; providerMessageId?: string | null };

/** What the first transaction of a turn leaves for the model call and the second transaction. */
export type BegunTurn = { kind: "done"; result: TurnResult } | { kind: "pending"; b: ScreenBundle; transcript: ScreenTranscriptEntry[]; ctx: ScreenContext };

/**
 * The first transaction of a turn: records what the candidate said, marks the conversation started, and answers the
 * keyword commands (HUMAN, WITHDRAW) that never go through the model. Everything else is left for the model.
 */
export async function beginScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput): Promise<BegunTurn> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return { kind: "done", result: { kind: "error", message: "This conversation is no longer available." } };
  const { screen, app, candidate, company, packet } = b;
  const now = new Date().toISOString();
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  await recordInbound(q, { companyId: company.id, candidateId: candidate.id, applicationId: app.id, channel: input.channel, text: input.message, from: input.channel === "sms" ? candidate.phone : null, provider: input.channel === "sms" ? deps.integrations.sms.id : null, providerMessageId: input.providerMessageId ?? null, actor: candidateActor, correlationId: screen.workflowRunId });

  if (!ACTIVE_STATUSES.has(screen.status)) {
    const msg = screen.status === "completed" ? "Thanks, this screening is complete. The hiring team is reviewing and you will hear back within a few days. Reply HUMAN to reach a person." : screen.status === "human_requested" ? "A person from the hiring team will follow up with you shortly." : "This screening has closed. Reply HUMAN if you would like a person to follow up.";
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_closed:${screen.id}:${now}`, templateKey: "screen_closed", disclosureIncluded: false });
    return { kind: "done", result: { kind: "closed", message: msg } };
  }

  const transcript: ScreenTranscriptEntry[] = [...screen.transcript, { role: "candidate", content: input.message, at: now, channel: input.channel }];
  const started = screen.status !== "in_progress";
  if (started) {
    await q.update(screens).set({ status: "in_progress", startedAt: screen.startedAt ?? now, transcript, lastCandidateMessageAt: now }).where(eq(screens.id, screen.id));
    await emit(q, { type: "screen.started", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: screen.id }, payload: { channel: input.channel }, correlationId: screen.workflowRunId });
    if (app.stage === "screen_invited") await transition(q, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
    await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:started` });
  } else {
    await q.update(screens).set({ transcript, lastCandidateMessageAt: now }).where(eq(screens.id, screen.id));
  }

  // Keyword commands never go through the model.
  if (/^\s*(human|person|agent|representative)\b/i.test(input.message) || /\b(talk|speak) to a (real )?(person|human)\b/i.test(input.message)) {
    const msg = `Understood. A person from ${company.name} will follow up with you ${humanResponseExpectation(new Date(), await loadBusinessCalendar(q))}. Thank you for your patience.`;
    await requestHuman(q, deps, { screenId: screen.id, reason: "candidate asked for a person", actor: input.actor, reply: msg, replyChannel: input.channel });
    return { kind: "done", result: { kind: "reply", message: msg, done: false, humanRequested: true } };
  }
  if (/^\s*withdraw\b/i.test(input.message)) {
    const msg = `Understood, we have withdrawn your application for ${packet.identity.title}. Thank you for your time, and reply to any of our emails if you change your mind.`;
    await q.update(screens).set({ status: "abandoned", transcript: [...transcript, { role: "assistant", content: msg, at: new Date().toISOString(), channel: input.channel }] }).where(eq(screens.id, screen.id));
    await emit(q, { type: "screen.abandoned", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: screen.id }, payload: { reason: "withdrawn" }, correlationId: screen.workflowRunId });
    await transition(q, { applicationId: app.id, companyId: company.id, to: "withdrawn", by: "candidate", actor: candidateActor, reason: "candidate withdrew during screening", correlationId: screen.workflowRunId });
    await emit(q, { type: "application.withdrawn", companyId: company.id, actor: candidateActor, subject: { type: "application", id: app.id }, payload: { during: "screen" }, correlationId: screen.workflowRunId });
    await notify(q, { companyId: company.id, kind: "candidate.withdrawn", title: `${candidate.firstName} ${candidate.lastName} withdrew`, body: `They withdrew from ${packet.identity.title} during the screening conversation.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_withdrawn:${screen.id}`, templateKey: "screen_withdrawn", disclosureIncluded: false });
    await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed`, payload: { withdrawn: true } });
    return { kind: "done", result: { kind: "reply", message: msg, done: true, humanRequested: false, withdrawn: true } };
  }

  const fresh = (await q.select().from(screens).where(eq(screens.id, screen.id)).limit(1))[0];
  return { kind: "pending", b: { ...b, screen: fresh }, transcript, ctx: contextOf(b, { ...fresh, transcript }, input.message) };
}

/**
 * The second transaction of a turn: checks the model's turn against the packet's rules, records the answer, sends the
 * reply, and hands over to a person or closes the conversation when the turn says so. On a model failure the candidate
 * gets an honest holding message; two failures in a row hand the conversation to a person.
 */
export async function finishScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput, pending: Extract<BegunTurn, { kind: "pending" }>, out: RunOutcome<ScreenTurn>): Promise<TurnResult> {
  const { app, candidate, company, packet } = pending.b;
  const screen = pending.b.screen;
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  const [fresh] = await q.select().from(screens).where(eq(screens.id, screen.id)).limit(1);
  if (!fresh) return { kind: "error", message: "This conversation is no longer available." };
  if (!out.ok) {
    const failures = (fresh.progress.failures ?? 0) + 1;
    await q.update(screens).set({ progress: { ...fresh.progress, failures } }).where(eq(screens.id, screen.id));
    await emit(q, { type: "ai.run_failed", companyId: company.id, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: screen.id }, payload: { reason: out.reason, error: out.error, failures }, correlationId: screen.workflowRunId });
    if (failures >= 2) {
      const msg = `Sorry, we are having trouble on our end. A person from ${company.name} will pick this up and follow up with you ${humanResponseExpectation(new Date(), await loadBusinessCalendar(q))}.`;
      await requestHuman(q, deps, { screenId: screen.id, reason: `assistant failed twice (${out.error})`, actor: input.actor, reply: msg, replyChannel: input.channel });
      return { kind: "reply", message: msg, done: false, humanRequested: true };
    }
    const holding = "Sorry, something went wrong on our end. Please send that again in a minute.";
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: pending.b.role, company, packet, actor: input.actor, text: holding, idempotencyKey: `screen_holding:${screen.id}:${pending.transcript.length}`, templateKey: "screen_holding", disclosureIncluded: false });
    return { kind: "error", message: holding };
  }

  let turn = enforceTurnRules(out.output, packet, fresh.progress, fresh.answers);
  // The model never states a response time; the accurate business-hours expectation is appended in code (founder decision F12).
  if (turn.humanRequested && !/business/i.test(turn.messageToCandidate)) turn = { ...turn, messageToCandidate: `${turn.messageToCandidate} You can expect to hear from a person ${humanResponseExpectation(new Date(), await loadBusinessCalendar(q))}.` };
  const answers = { ...fresh.answers };
  if (turn.answerRecorded) answers[turn.answerRecorded.questionKey] = redactProtected(turn.answerRecorded.answer);
  const progress = advanceProgress(fresh.progress, turn);
  const reply: ScreenTranscriptEntry = { role: "assistant", content: turn.messageToCandidate, at: new Date().toISOString(), questionKey: turn.questionKey ?? undefined, channel: input.channel, aiRunId: out.runId };
  const transcript = [...fresh.transcript, reply];
  await q.update(screens).set({ transcript, answers, progress }).where(eq(screens.id, screen.id));

  if (input.channel === "sms") {
    await deliverSms(q, deps.integrations, { application: app, candidate, role: pending.b.role, company, packet, actor: { kind: "agent", id: "screening", runId: out.runId }, text: turn.messageToCandidate, idempotencyKey: `screen_turn:${screen.id}:${transcript.length}`, templateKey: "screen_turn", disclosureIncluded: false, aiRunId: out.runId, correlationId: screen.workflowRunId });
  }

  if (turn.humanRequested) {
    await requestHuman(q, deps, { screenId: screen.id, reason: turn.sentiment === "distressed" || turn.sentiment === "frustrated" ? `candidate sounded ${turn.sentiment}` : "candidate asked for a person", actor: input.actor, reply: null, replyChannel: input.channel });
    return { kind: "reply", message: turn.messageToCandidate, done: false, humanRequested: true };
  }
  if (turn.done) {
    await q.update(screens).set({ status: "completed", completedAt: new Date().toISOString() }).where(eq(screens.id, screen.id));
    await emit(q, { type: "screen.completed", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: screen.id }, payload: { questionsAnswered: Object.keys(answers).length, questions: packet.screening.questions.length, channel: input.channel }, correlationId: screen.workflowRunId });
    await transition(q, { applicationId: app.id, companyId: company.id, to: "screen_complete", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
    await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed` });
  }
  return { kind: "reply", message: turn.messageToCandidate, done: turn.done, humanRequested: false };
}

/** One candidate message in, one assistant message out, with the model called between two short transactions. */
export async function runScreenTurn(db: Db, companyId: string, deps: ScreenDeps, input: TurnInput): Promise<TurnResult> {
  const begun = await withTenant(db, companyId, (q) => beginScreenTurn(q, deps, input));
  if (begun.kind === "done") return begun.result;
  const out = await runPromptDetached(db, deps.ai, screenTurnPrompt, begun.ctx, { companyId, workflowRunId: begun.b.screen.workflowRunId, inputRef: { screenId: input.screenId, turn: begun.transcript.length } });
  return withTenant(db, companyId, (q) => finishScreenTurn(q, deps, input, begun, out));
}

/** The candidate asked for a person (or the assistant could not continue): a recruiter gets the whole context with a 4-hour SLA. */
export async function requestHuman(q: Queryable, deps: ScreenDeps, input: { screenId: string; reason: string; actor: Actor; reply: string | null; replyChannel: ScreenChannel }): Promise<void> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return;
  const { screen, app, candidate, company, packet } = b;
  const now = new Date().toISOString();
  const transcript = input.reply ? [...screen.transcript, { role: "assistant" as const, content: input.reply, at: now, channel: input.replyChannel }] : screen.transcript;
  await q.update(screens).set({ status: "human_requested", humanRequestedAt: now, transcript }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.human_requested", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { reason: input.reason }, correlationId: screen.workflowRunId });
  await createEscalation(q, { companyId: company.id, roleId: app.roleId, applicationId: app.id, kind: "candidate_issue", summaryOrigin: /failed|error/i.test(input.reason) ? "system" : "candidate", question: `${candidate.firstName} ${candidate.lastName} needs a person during the ${packet.identity.title} screening (${input.reason}). Please reach out by ${candidate.phone ? "phone or " : ""}email and finish the screen.`, requestedBy: input.actor, workflowRunId: screen.workflowRunId });
  await notify(q, { companyId: company.id, kind: "screen.human_requested", title: `${candidate.firstName} asked for a person`, body: `During the ${packet.identity.title} screening. A recruiter has the conversation; you can also reply directly.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
  if (input.reply && input.replyChannel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: input.reply, idempotencyKey: `screen_human:${screen.id}`, templateKey: "screen_human", disclosureIncluded: false });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:human` });
}

/** The rules the packet sets that the model must not break: one question at a time, two follow-ups at most, a bounded conversation. */
export function enforceTurnRules(turn: ScreenTurn, packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>): ScreenTurn {
  const keys = packet.screening.questions.map((q) => q.key);
  let t: ScreenTurn = { ...turn };
  if (t.questionKey && !keys.includes(t.questionKey)) t = { ...t, questionKey: null };
  if (t.answerRecorded && !keys.includes(t.answerRecorded.questionKey)) t = { ...t, answerRecorded: null };
  const asked = new Set(progress.askedKeys);
  const remaining = keys.filter((k) => !asked.has(k) && !(k in answers) && k !== t.answerRecorded?.questionKey);
  const current = progress.currentQuestionKey;
  const isFollowUp = !!t.followUpReason && !t.questionKey && !t.done && !t.humanRequested;
  if (isFollowUp && current && (progress.followUps[current] ?? 0) >= MAX_FOLLOW_UPS) {
    // Enough follow-ups: move on with the next packet question, or close.
    const next = remaining[0];
    if (next) {
      const q = packet.screening.questions.find((x) => x.key === next)!;
      t = { ...t, messageToCandidate: `Thanks, that helps. Next: ${q.question}`, questionKey: next, followUpReason: null, answerRecorded: t.answerRecorded ?? (current ? { questionKey: current, answer: "", complete: false } : null) };
    } else {
      t = { ...t, done: true, followUpReason: null, questionKey: null, messageToCandidate: `Thanks, that is everything I needed. The hiring team will review and you will hear back within a few days. Reply HUMAN at any time to reach a person.` };
    }
  }
  // A conversation cannot run forever: after four turns per question, close politely.
  const candidateTurns = Object.keys(answers).length + (t.answerRecorded ? 1 : 0);
  if (!t.done && !t.humanRequested && candidateTurns >= keys.length && remaining.length === 0 && !t.questionKey) {
    t = { ...t, done: true, followUpReason: null };
  }
  if (t.answerRecorded && !t.answerRecorded.answer.trim()) t = { ...t, answerRecorded: null };
  return t;
}

export function advanceProgress(progress: ScreenProgress, turn: ScreenTurn): ScreenProgress {
  const askedKeys = turn.questionKey && !progress.askedKeys.includes(turn.questionKey) ? [...progress.askedKeys, turn.questionKey] : progress.askedKeys;
  const followUps = { ...progress.followUps };
  if (turn.followUpReason && !turn.questionKey && progress.currentQuestionKey) followUps[progress.currentQuestionKey] = (followUps[progress.currentQuestionKey] ?? 0) + 1;
  return {
    askedKeys,
    currentQuestionKey: turn.done || turn.humanRequested ? null : turn.questionKey ?? progress.currentQuestionKey,
    followUps,
    confusedTurns: turn.sentiment === "confused" ? progress.confusedTurns + 1 : 0,
    failures: 0,
  };
}

/** The scorecard for a completed screen, called with no transaction open. Quotes are verified against the transcript in code. */
export async function assessScreen(db: Db, ai: AiRuntime, input: { companyId: string; screenId: string; workflowRunId?: string | null }): Promise<RunOutcome<import("@ros/contracts").ScreenAssessment>> {
  const b = await withTenant(db, input.companyId, (q) => loadScreenBundle(q, input.screenId));
  if (!b) throw new Error("screen not found");
  const ctx = contextOf(b, b.screen, null);
  const out = await runPromptDetached(db, ai, screenAssessPrompt, ctx, { companyId: b.company.id, workflowRunId: input.workflowRunId ?? b.screen.workflowRunId, inputRef: { screenId: b.screen.id, turns: b.screen.transcript.length } });
  if (!out.ok) return out;
  const candidateText = `${b.screen.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n")}\n${Object.values(b.screen.answers).join("\n")}`;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(candidateText);
  const ok = (quote?: string) => !quote || src.includes(norm(quote));
  let dropped = 0;
  const a = out.output;
  /** Keeps a finding whose quote is in the transcript; otherwise counts it and returns the stripped version. */
  const keepOrStrip = <T,>(grounded: boolean, item: T, stripped: () => T): T => {
    if (grounded) return item;
    dropped += 1;
    return stripped();
  };
  const verified = {
    ...a,
    strengths: a.strengths.filter((f) => { const g = ok(f.evidence.quote); if (!g) dropped += 1; return g; }),
    concerns: a.concerns.filter((f) => { const g = ok(f.evidence.quote); if (!g) dropped += 1; return g; }),
    questionFindings: a.questionFindings.map((f) => keepOrStrip(ok(f.evidence?.quote), f, () => ({ ...f, evidence: undefined }))),
    competencyFindings: a.competencyFindings.map((f) => keepOrStrip(ok(f.evidence?.quote), f, () => ({ ...f, evidence: undefined, finding: f.finding === "evidenced" ? ("partially_evidenced" as const) : f.finding }))),
    eligibilityConfirmations: a.eligibilityConfirmations.map((e) => keepOrStrip(ok(e.quote), e, () => ({ ...e, quote: undefined }))),
    anomalies: dropped ? [...a.anomalies, { kind: "unverified_quote", detail: `${dropped} quote${dropped === 1 ? "" : "s"} not found in the transcript; discarded` }] : a.anomalies,
  };
  return { ...out, output: verified };
}

/** The most recent screen for an application, if any. */
export async function latestScreen(q: Queryable, applicationId: string): Promise<ScreenRow | null> {
  const rows = await q.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  return rows[0] ?? null;
}
