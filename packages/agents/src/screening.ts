import { and, desc, eq, inArray } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, SCREEN_PERSON_ROUTE_STATUSES, type Actor, type ReviewItem, type RolePacket, type ScreenAssessment, type ScreenChannel, type ScreeningQuestion, type ScreenInvitedVia, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn, type TapAnswer, type TapFormat } from "@ros/contracts";
import { runPromptDetached, screenAssessPrompt, screenTurnPrompt, type AiRuntime, type RunOutcome, type ScreenContext } from "@ros/ai";
import { createEscalation, emit, entitlements, humanResponseExpectation, isOneVisitFlow, jobNoticesFor, loadBusinessCalendar, noticesFor, notify, payShown, tapAnswerText, tapFormatFor, transition } from "@ros/core";
import { applications, assessments, candidates, companies, randomToken, rolePackets, roles, screens, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { deliverSms, recordInbound, sendPersonRequestedNote } from "./coordinator";
import { FOCUS_INTRO, answersOf, focusedPacket, isFocusKey, withFocusAnswer, type FocusQuestion } from "./screen-focus";
import { applyEvidenceRules } from "./triage";

/**
 * The Screening agent (docs/05). Conversation turns run when the candidate writes (web chat or SMS); the durable
 * `screen` workflow owns the invite, reminders, expiry, the scorecard, and the recommendation.
 * Progress lives in code (`screens.progress`), so a restart, a channel switch, or a model failure never loses the thread.
 *
 * Every model call happens with no database transaction open: a turn is a short transaction that records what the
 * candidate said, the model call, and a second short transaction that records the reply.
 *
 * Wave E (the conversation offered with the application): the introduction and every packet question are shown in the
 * packet's own words, the model only records answers and decides follow-ups; a skip or a tapped answer is handled in
 * code before the model (E11, E12); the candidate checks their answers before sending (E10); an outage pauses the
 * conversation instead of handing it over (E5); and the plan's allowance counts a conversation at its first answer (E9).
 */

export type ScreenDeps = {
  ai: AiRuntime;
  integrations: Integrations;
  appBaseUrl: string;
  /** Wakes the `screen` workflow (`screen:<id>:started`, `screen:<id>:completed`, `screen:<id>:human`, `screen:<id>:paused`). */
  signal?: (q: Queryable, input: { companyId: string; key: string; payload?: Record<string, unknown> }) => Promise<unknown>;
  /**
   * Called in the same transaction once a candidate withdraws from inside the conversation (a CONFIRM by text or on the
   * web page): the app ends the rest of their part in the process, as every exit does (plan A9).
   */
  onWithdrawn?: (q: Queryable, input: { companyId: string; applicationId: string; actor: Actor }) => Promise<unknown>;
  /**
   * The time the conversation's own stamps are written in (started, last answer, paused, sent): the workflow engine's
   * clock, so the run that reminds, closes and retries reads the same time the turns wrote. The real time when absent.
   */
  clock?: () => Date;
};

function nowOf(deps: Pick<ScreenDeps, "clock">): Date {
  return deps.clock?.() ?? new Date();
}

export type ScreenRow = typeof screens.$inferSelect;

const ACTIVE_STATUSES = new Set<string>(SCREEN_ACTIVE_STATUSES);
const MAX_FOLLOW_UPS = 2;
export const EMPTY_SCREEN_PROGRESS: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };

/** What the conversation says once every question is answered, when the candidate checks their answers before sending (E10). */
export const REVIEW_MESSAGE = "That is every question. Check your answers below: you can change any of them. When they look right, press Send.";

/**
 * The transcript's notes of "Skip this question" (E11): a question skipped with no answer, and a skip pressed during a
 * follow-up to an answer already given, which moves on and keeps that answer.
 */
export const SKIPPED_MESSAGE = "Skipped this question.";
export const MOVED_ON_MESSAGE = "Moved on to the next question; the answer given is kept.";

/**
 * How many replies the model has written in this conversation. Each call that worked writes exactly one, carrying its
 * run; a reply worked out in code (the first question, a skip, a tap, a command) carries none, and a call that failed
 * writes none (two failures in a row pause the conversation or hand it to a person).
 */
export function modelTurnsUsed(transcript: readonly ScreenTranscriptEntry[]): number {
  return transcript.filter((t) => t.role === "assistant" && !!t.aiRunId).length;
}

/**
 * The most model calls one conversation may make: for every question the ask and two follow-ups (MAX_FOLLOW_UPS), plus
 * five for the candidate's own questions. `packet` is the conversation's own (with the open questions it starts with).
 * A candidate answering normally stays well under it; a conversation that only ever chats never reaches the end of
 * the questions, so without a cap it would call the model for as long as the link lasts.
 */
export function modelTurnCap(packet: Pick<RolePacket, "screening">): number {
  return 3 * packet.screening.questions.length + 5;
}

/** What the conversation says when it reaches that cap on the web in the one-visit flow: the candidate checks their answers next (E10). */
export const TURN_CAP_REVIEW_MESSAGE = "We have covered as much as we can in this conversation. Check your answers below: you can change any of them and answer any question still open. When they look right, press Send.";
/**
 * What happens next, in every closing line of the conversation: people decide, and the candidate hears either way. Never
 * a time: decisions are private with no deadline (founder decision B6), so nothing could keep a promise of "a few days"
 * (the decision log of 14 September 2026 bans it in candidate copy).
 */
export const SCREEN_NEXT_LINE = "People on the hiring team review your answers and make every decision; you will hear from them either way.";
/** The reply to anything said after the screening is complete (by text, or on the conversation page). */
export const SCREEN_COMPLETE_MESSAGE = `Thanks, this screening is complete. ${SCREEN_NEXT_LINE} Reply HUMAN to reach a person.`;
/** ...and where the conversation closes instead (an invitation by text, or on the web outside the one-visit flow). */
export const TURN_CAP_CLOSE_MESSAGE = "Thank you for your time. That is as much as we can cover in this conversation. People on the hiring team review what you shared and make every decision; you will hear from them either way. Reply HUMAN at any time to reach a person.";

/** What the conversation says when the assistant stops working part-way (E5). */
export function pausedMessage(companyName: string): string {
  return `Sorry, our assistant has stopped working for the moment. Your answers so far are saved. We will email you a link to finish as soon as it is working again, usually within a few hours. If you would rather not wait, you can ask for a person from ${companyName} instead.`;
}

/**
 * `focusQuestions` ("Ask about this in a screen"): asked before the packet's own questions; fixed on the row at creation.
 * `invitedVia` "apply" and `flow` "one_visit": the conversation offered in the same visit as the application (E1).
 */
export async function createScreen(q: Queryable, input: { companyId: string; applicationId: string; channel: ScreenChannel; workflowRunId?: string | null; expiresAt: string; now: Date; focusQuestions?: FocusQuestion[] | null; invitedVia?: ScreenInvitedVia | null; flow?: "one_visit" | null }): Promise<ScreenRow> {
  const existing = await q.select().from(screens).where(and(eq(screens.applicationId, input.applicationId), inArray(screens.status, [...SCREEN_PERSON_ROUTE_STATUSES]))).limit(1);
  if (existing[0]) return existing[0];
  let progress: ScreenProgress = input.focusQuestions?.length ? { ...EMPTY_SCREEN_PROGRESS, focusQuestions: input.focusQuestions } : EMPTY_SCREEN_PROGRESS;
  if (input.flow) progress = { ...progress, flow: input.flow };
  const [row] = await q
    .insert(screens)
    .values({ companyId: input.companyId, applicationId: input.applicationId, channel: input.channel, status: "invited", token: randomToken(24), invitedAt: input.now.toISOString(), expiresAt: input.expiresAt, workflowRunId: input.workflowRunId ?? null, progress, invitedVia: input.invitedVia ?? null })
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
  // A screen that opens with the assessment's open questions sees them as its first questions everywhere the packet is read.
  return b ? { ...b, packet: focusedPacket(b.packet, screen.progress), screen } : null;
}
export type ScreenBundle = NonNullable<Awaited<ReturnType<typeof loadScreenBundle>>>;

type ConversationState = Pick<ScreenRow, "channel" | "progress" | "answers" | "transcript">;

/** The model's view of the conversation. Exported for a repeat submission's detached conversation, which has no application of its own. */
type CompanyRow = typeof companies.$inferSelect;

export function screenContextOf(input: { companyName: string; companyLocations: CompanyRow["locations"]; noticeOverrides: CompanyRow["settings"]["notices"]; packet: RolePacket; firstName: string; focusUnknowns: string[] }, screen: ConversationState, latest: string | null): ScreenContext {
  return {
    company: { name: input.companyName },
    packet: input.packet,
    candidate: { firstName: input.firstName },
    channel: screen.channel as ScreenChannel,
    progress: screen.progress,
    answers: answersOf(screen),
    transcript: screen.transcript,
    focusUnknowns: input.focusUnknowns,
    latestCandidateMessage: latest,
    // The same pay rule as the job page the candidate applied from.
    payShown: payShown(input.packet.compensation, jobNoticesFor({ jobLocations: input.packet.identity.locations, companyLocations: input.companyLocations, overrides: input.noticeOverrides })),
  };
}

function contextOf(b: ApplicationBundle, screen: ConversationState, latest: string | null): ScreenContext {
  return screenContextOf({ companyName: b.company.name, companyLocations: b.company.locations, noticeOverrides: b.company.settings.notices, packet: b.packet, firstName: b.candidate.firstName, focusUnknowns: b.triageUnknowns }, screen, latest);
}

/** Screening stays within the job. Anything about a protected characteristic the candidate volunteers is kept out of recorded answers (the transcript itself is the record). */
export function redactProtected(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const protectedPattern = /\b(i am|i'm|im)\s+\d{2}\b|\b\d{2}\s+years? old\b|\bmy (kids?|children|son|daughter|husband|wife|spouse)\b|\bpregnan|\bmaternity\b|\bchurch\b|\bmosque\b|\bsynagogue\b|\breligio|\bdisabilit|\bwheelchair\b|\bmy (illness|condition|diagnosis)\b|\bimmigra|\bcitizen(ship)?\b|\bvisa\b|\bnational(ity)?\b|\bdivorc|\bmarried\b|\bsingle mom\b|\bsingle dad\b/i;
  const kept = sentences.filter((s) => !protectedPattern.test(s));
  return kept.length ? kept.join(" ") : "(answer recorded; personal details omitted)";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Questions, taps and the introduction                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** The question the candidate is being asked now. */
export function currentQuestion(packet: RolePacket, progress: Pick<ScreenProgress, "currentQuestionKey">): ScreeningQuestion | null {
  return progress.currentQuestionKey ? packet.screening.questions.find((q) => q.key === progress.currentQuestionKey) ?? null : null;
}

/** The next question in the packet's order that was not asked, answered or skipped. */
export function nextQuestion(packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>): ScreeningQuestion | null {
  const asked = new Set(progress.askedKeys);
  const declined = new Set(progress.declined ?? []);
  return packet.screening.questions.find((q) => !asked.has(q.key) && !(q.key in answers) && !declined.has(q.key)) ?? null;
}

/** The tap answer the current question offers, if any (E12). */
export function currentTapFormat(packet: RolePacket, progress: Pick<ScreenProgress, "currentQuestionKey">): TapFormat | null {
  const q = currentQuestion(packet, progress);
  return q ? tapFormatFor(q, packet.compensation) : null;
}

/** The words a tap on the current question is recorded as, or null when it does not fit it. */
export function tapWords(packet: RolePacket, progress: Pick<ScreenProgress, "currentQuestionKey">, tap: TapAnswer, now: Date = new Date()): string | null {
  const format = currentTapFormat(packet, progress);
  return format ? tapAnswerText(format, tap, now) : null;
}

/**
 * The fixed introduction shown before the conversation starts (E2): the AI notice, the disclosure in the hiring team's
 * words (docs/legal-drafts/03), the packet's line about reaching a person, and how many questions and minutes. Nothing
 * here is written by the model.
 */
export type ScreenIntro = { title: string; disclosure: string; aiNotice: { version: string; text: string } | null; packetDisclosure: string; humanAlternative: string; questions: number; minutes: number };

/**
 * `focus`: the conversation starts with the résumé reading's open questions ("Ask about this in a screen"), and the
 * introduction says so. The packet is the one the screen reads (`loadScreenBundle`), with those questions counted.
 */
export function screenIntro(input: { companyName: string; firstName: string; packet: RolePacket; noticeOverrides?: CompanyRow["settings"]["notices"]; focus?: boolean }): ScreenIntro {
  const { packet, companyName } = input;
  const n = packet.screening.questions.length;
  const notice = noticesFor(["*"], input.noticeOverrides).find((x) => x.key === "ai_use");
  return {
    title: `A few questions about the ${packet.identity.title} role`,
    disclosure: `Hi ${input.firstName}, this is ${companyName}'s hiring assistant, a software program. It will ask you ${n} short questions about the ${packet.identity.title} role, one at a time.${input.focus ? ` ${FOCUS_INTRO}` : ""} Your answers go to the hiring team, and people on the team make every decision. You can ask for a person at any time.`,
    aiNotice: notice ? { version: notice.version, text: notice.text } : null,
    packetDisclosure: packet.communication.disclosureText,
    humanAlternative: packet.communication.humanAlternativeText,
    questions: n,
    minutes: packet.screening.maxMinutes,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The opening message                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export type ScreenOpening = { message: string; aiRunId: string | null } | { error: string };

/**
 * Phase one of the opening of a conversation by text: the model call, made with no transaction open, while the workflow
 * decides to invite. Null when the application is gone or the screen already has its opening, in which case nothing
 * needs the model. A conversation on the web never comes here (plan E2): it opens with the fixed introduction and the
 * first question in the packet's words (`startScreenConversation`), however it was offered.
 */
export async function prepareScreenOpening(db: Db, ai: AiRuntime, input: { companyId: string; applicationId: string; channel: ScreenChannel; workflowRunId?: string | null; screen?: ConversationState | null; /** Before the row exists: the open questions the screen will start with. */ focusQuestions?: FocusQuestion[] | null }): Promise<RunOutcome<ScreenTurn> | null> {
  if (input.screen?.transcript.some((t) => t.role === "assistant")) return null;
  const b = await withTenant(db, input.companyId, (q) => loadApplicationBundle(q, input.applicationId));
  if (!b) return null;
  const state: ConversationState = input.screen ?? { channel: input.channel, progress: input.focusQuestions?.length ? { ...EMPTY_SCREEN_PROGRESS, focusQuestions: input.focusQuestions } : EMPTY_SCREEN_PROGRESS, answers: {}, transcript: [] };
  const focused = { ...b, packet: focusedPacket(b.packet, state.progress) };
  return runPromptDetached(db, ai, screenTurnPrompt, contextOf(focused, state, null), { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { applicationId: input.applicationId, turn: 0 } });
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
  const turn = enforceTurnRules(out.output, focusedPacket(input.packet, fresh.progress), fresh.progress, answersOf(fresh));
  const entry: ScreenTranscriptEntry = { role: "assistant", content: turn.messageToCandidate, at: new Date().toISOString(), questionKey: turn.questionKey ?? undefined, channel: fresh.channel as ScreenChannel, aiRunId: out.runId };
  const progress = advanceProgress(fresh.progress, turn);
  await q.update(screens).set({ transcript: [...fresh.transcript, entry], progress }).where(eq(screens.id, fresh.id));
  return { message: turn.messageToCandidate, aiRunId: out.runId };
}

/**
 * "Start" on the introduction (E2): the first question appears in the packet's own words, with no model call, and the
 * conversation counts as started. Idempotent: a second press (a reload, a double click) changes nothing. Every
 * conversation on the web opens this way, whether it was offered with the application or invited by email later.
 */
export async function startScreenConversation(q: Queryable, deps: ScreenDeps, input: { screenId: string; actor: Actor }): Promise<{ ok: boolean; message: string | null }> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !ACTIVE_STATUSES.has(b.screen.status)) return { ok: false, message: null };
  const { screen, app, company, packet, candidate } = b;
  const opened = screen.transcript.find((t) => t.role === "assistant");
  if (opened) return { ok: true, message: opened.content };
  const first = nextQuestion(packet, screen.progress, answersOf(screen));
  if (!first) return { ok: false, message: null };
  const now = nowOf(deps).toISOString();
  const entry: ScreenTranscriptEntry = { role: "assistant", content: first.question, at: now, questionKey: first.key, channel: screen.channel as ScreenChannel, source: "system" };
  const progress = advanceProgress(screen.progress, { ...SILENT_TURN, messageToCandidate: first.question, questionKey: first.key });
  await q.update(screens).set({ status: "in_progress", startedAt: screen.startedAt ?? now, lastCandidateMessageAt: now, transcript: [...screen.transcript, entry], progress }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.started", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { channel: screen.channel, via: "start_button" }, correlationId: screen.workflowRunId });
  const [cur] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
  if (cur?.stage === "screen_invited") await transition(q, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:started` });
  return { ok: true, message: first.question };
}

/** A turn with nothing in it, for the steps code takes on its own (the first question, a skip, a tap). */
const SILENT_TURN: ScreenTurn = { messageToCandidate: " ", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

/* ------------------------------------------------------------------------------------------------------------ */
/* Conversation turns                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

export type TurnResult =
  | { kind: "reply"; message: string; done: boolean; humanRequested: boolean; withdrawn?: boolean; /** Every question answered: the candidate checks their answers next (E10). */ review?: boolean; /** The assistant stopped working; the candidate will be emailed (E5). */ paused?: boolean }
  | { kind: "closed"; message: string }
  | { kind: "error"; message: string };

/**
 * One thing the candidate did: a typed `message`, or (on the web) `skip` the current question (E11) or a `tap` answer
 * to it (E12). A skip or a tap never reaches the model.
 */
export type TurnInput = { screenId: string; message: string; channel: ScreenChannel; actor: Actor; providerMessageId?: string | null; skip?: boolean; tap?: TapAnswer | null };

/** What counting a conversation did to the allowance, for the ITS alert after the transaction (E9, Q17). */
export type AllowanceNote = { crossing: entitlements.AllowanceCrossing; companyId: string; companyName: string };

/** What the first transaction of a turn leaves for the model call and the second transaction. */
export type BegunTurn = ({ kind: "done"; result: TurnResult } | { kind: "pending"; b: ScreenBundle; transcript: ScreenTranscriptEntry[]; ctx: ScreenContext }) & { allowance?: AllowanceNote | null };

/** The holding answer to a conversation that is not open, by its status. */
function closedMessage(status: string, companyName: string): string {
  if (status === "completed") return SCREEN_COMPLETE_MESSAGE;
  if (status === "human_requested") return "A person from the hiring team will follow up with you shortly.";
  if (status === "paused") return `This conversation is paused while we fix a problem on our end. Your answers are saved, and we will email you a link to finish. If you would rather talk to a person from ${companyName}, reply HUMAN.`;
  return "This screening has closed. Reply HUMAN if you would like a person to follow up.";
}

/**
 * Counts the conversation at its first answer (E9) and, when that crossed 80% of the plan's allowance or used it up,
 * tells the owner in the app (Q17). ITS is told after the transaction (`flagAllowance`).
 */
export async function countConversation(q: Queryable, input: { companyId: string; companyName: string; screenId: string }): Promise<AllowanceNote> {
  const crossing = await entitlements.recordScreenStart(q, input.companyId, { screenId: input.screenId });
  if (crossing.crossed) {
    const usedUp = crossing.crossed === "used_up";
    await emit(q, { type: usedUp ? "entitlement.exceeded" : "entitlement.warning", companyId: input.companyId, actor: { kind: "system", id: "allowance" }, subject: { type: "company", id: input.companyId }, payload: { key: entitlements.TEXT_SCREENS, used: crossing.used, limit: crossing.limit } });
    await notify(q, {
      companyId: input.companyId,
      kind: "entitlement.text_screens",
      title: usedUp ? "This month's screening conversations are used up" : "80% of this month's screening conversations used",
      body: usedUp
        ? `${crossing.used} of ${crossing.limit} used. Applications are still accepted and anyone part-way through finishes. New applicants get the conversation link by email once more are added, so everyone for a role has the same process. ITS has been told.`
        : `${crossing.used} of ${crossing.limit} used. Nothing has stopped. ITS has been told and can add more before they run out.`,
      action: { label: "See usage", href: "/setup" },
    });
  }
  return { crossing, companyId: input.companyId, companyName: input.companyName };
}

/** ITS's alert for a crossing, platform side, after the counting transaction committed. */
export async function flagAllowance(db: Db, note: AllowanceNote | null | undefined): Promise<void> {
  if (!note?.crossing.crossed) return;
  await withPlatform(db, (tx) => entitlements.flagScreenAllowance(tx, { companyId: note.companyId, companyName: note.companyName, crossing: note.crossing })).catch((err) => console.warn(`[screening] could not raise the allowance alert: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * The first transaction of a turn: records what the candidate said, marks the conversation started, and answers the
 * keyword commands (HUMAN, WITHDRAW) that never go through the model, a skip, and a tapped answer. Everything else is
 * left for the model.
 */
export async function beginScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput): Promise<BegunTurn> {
  // The screen row is locked before anything is read, as `submitScreenAnswers` does: two first answers at the same moment
  // (two quick texts, a double Send) take turns, so the conversation is counted once (`countedAt`) and neither turn
  // writes over the other's transcript. The lock lasts this short transaction only, never the model call.
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  let b = await loadScreenBundle(q, input.screenId);
  if (!b) return { kind: "done", result: { kind: "error", message: "This conversation is no longer available." } };
  // An answer posted on the web before Start (an old page, a reload): the first question is put first, as Start does,
  // so the answer is read against it (E2).
  if (input.channel === "web" && ACTIVE_STATUSES.has(b.screen.status) && !b.screen.transcript.some((t) => t.role === "assistant")) {
    await startScreenConversation(q, deps, { screenId: b.screen.id, actor: input.actor });
    b = (await loadScreenBundle(q, input.screenId)) ?? b;
  }
  const { screen, app, candidate, company, packet } = b;
  const now = nowOf(deps).toISOString();
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  const current = screen.progress.currentQuestionKey;
  if ((input.skip || input.tap) && (!current || !ACTIVE_STATUSES.has(screen.status) || screen.progress.phase === "review")) return { kind: "done", result: { kind: "error", message: "There is no question to answer here right now." } };
  // A tap is recorded as fixed words worked out in code (E12); one that does not fit the question is refused before anything is written.
  const tapped = input.tap ? tapWords(packet, screen.progress, input.tap) : null;
  if (input.tap && !tapped) return { kind: "done", result: { kind: "error", message: "That answer does not fit this question. Please type it instead." } };
  const said = input.skip ? null : tapped ?? input.message;
  if (said !== null) await recordInbound(q, { companyId: company.id, candidateId: candidate.id, applicationId: app.id, channel: input.channel, text: said, from: input.channel === "sms" ? candidate.phone : null, provider: input.channel === "sms" ? deps.integrations.sms.id : null, providerMessageId: input.providerMessageId ?? null, actor: candidateActor, correlationId: screen.workflowRunId });

  if (!ACTIVE_STATUSES.has(screen.status)) {
    const msg = closedMessage(screen.status, company.name);
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_closed:${screen.id}:${now}`, templateKey: "screen_closed", disclosureIncluded: false });
    return { kind: "done", result: { kind: "closed", message: msg } };
  }
  // Checking answers (E10): changes go through the page's own forms, not the conversation.
  if (screen.progress.phase === "review") return { kind: "done", result: { kind: "reply", message: REVIEW_MESSAGE, done: false, humanRequested: false, review: true } };

  // A skip while the assistant follows up on an answer already given moves on and keeps that answer (E11): only a
  // question with no answer at all is skipped, and only that counts as unknown in the scorecard.
  const movesOn = !!input.skip && !!current && answersOf(screen)[current] !== undefined;
  const entry: ScreenTranscriptEntry = input.skip
    ? movesOn
      ? { role: "system", content: MOVED_ON_MESSAGE, at: now, channel: input.channel, questionKey: current ?? undefined, source: "system" }
      : { role: "system", content: SKIPPED_MESSAGE, at: now, channel: input.channel, questionKey: current ?? undefined, source: "skip" }
    : tapped
      ? { role: "candidate", content: tapped, at: now, channel: input.channel, questionKey: current ?? undefined, source: "tap" }
      : { role: "candidate", content: input.message, at: now, channel: input.channel };
  const transcript: ScreenTranscriptEntry[] = [...screen.transcript, entry];
  // Keyword commands never go through the model, and only a message that is the command itself counts (Wave 0 item
  // 0.7): "Representative at a phone store for two years" is an answer; "HUMAN" asks for a person. WITHDRAW asks first.
  const command = said !== null && !tapped ? screenCommand(input.message, withdrawPending(screen.transcript)) : null;
  // E9: the plan's allowance counts a conversation at its first answer, never at the invitation, a command or a skip.
  const allowance = said !== null && command === null && !screen.progress.countedAt ? await countConversation(q, { companyId: company.id, companyName: company.name, screenId: screen.id }) : null;
  const progress: ScreenProgress = allowance ? { ...screen.progress, countedAt: now } : screen.progress;
  const started = screen.status !== "in_progress";
  if (started) {
    await q.update(screens).set({ status: "in_progress", startedAt: screen.startedAt ?? now, transcript, progress, lastCandidateMessageAt: now }).where(eq(screens.id, screen.id));
    await emit(q, { type: "screen.started", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: screen.id }, payload: { channel: input.channel }, correlationId: screen.workflowRunId });
    if (app.stage === "screen_invited") await transition(q, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
    await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:started` });
  } else {
    await q.update(screens).set({ transcript, progress, lastCandidateMessageAt: now }).where(eq(screens.id, screen.id));
  }

  if (command === "confirm_withdraw" || command === "keep_application") {
    const msg = await answerWithdrawPrompt(q, deps, { screenId: screen.id, confirm: command === "confirm_withdraw", channel: input.channel, actor: input.actor });
    if (msg === null) return { kind: "done", result: { kind: "closed", message: "This screening has closed. Reply HUMAN if you would like a person to follow up." } };
    return { kind: "done", result: { kind: "reply", message: msg, done: command === "confirm_withdraw", humanRequested: false, ...(command === "confirm_withdraw" ? { withdrawn: true } : {}) } };
  }
  if (command === "human") {
    const msg = `Understood. A person from ${company.name} will follow up with you ${humanResponseExpectation(nowOf(deps), await loadBusinessCalendar(q))}. Thank you for your patience.`;
    await requestHuman(q, deps, { screenId: screen.id, reason: "candidate asked for a person", actor: input.actor, reply: msg, replyChannel: input.channel });
    return { kind: "done", result: { kind: "reply", message: msg, done: false, humanRequested: true } };
  }
  if (command === "withdraw") {
    // Nothing is withdrawn yet: the candidate is asked once, and the answer to that question decides.
    const msg = input.channel === "sms"
      ? `Do you want to withdraw your application for ${packet.identity.title}? Reply CONFIRM to withdraw. To keep your application, just reply with your answer.`
      : `Do you want to withdraw your application for ${packet.identity.title}? Press "Yes, withdraw my application" below to confirm. To keep your application, just type your answer.`;
    await q.update(screens).set({ transcript: [...transcript, { role: "assistant", content: msg, at: now, channel: input.channel, questionKey: WITHDRAW_CONFIRM_KEY }] }).where(eq(screens.id, screen.id));
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_withdraw_ask:${screen.id}:${transcript.length}`, templateKey: "screen_withdraw_ask", disclosureIncluded: false });
    return { kind: "done", result: { kind: "reply", message: msg, done: false, humanRequested: false } };
  }
  if (input.skip || tapped) {
    const result = await answerInCode(q, deps, { ...b, screen: { ...screen, transcript, progress } }, { channel: input.channel, actor: input.actor, words: tapped, key: current! });
    return { kind: "done", result, allowance };
  }
  // A conversation cannot call the model for ever (`modelTurnCap`): at the cap it ends without another call.
  if (modelTurnsUsed(transcript) >= modelTurnCap(packet)) {
    const result = await endAtTurnCap(q, deps, { ...b, screen: { ...screen, transcript, progress } }, { channel: input.channel, actor: input.actor });
    return { kind: "done", result, allowance };
  }

  const fresh = (await q.select().from(screens).where(eq(screens.id, screen.id)).limit(1))[0];
  return { kind: "pending", b: { ...b, screen: fresh }, transcript, ctx: contextOf(b, { ...fresh, transcript }, input.message), allowance };
}

/**
 * A skip (E11, `words` null) or a tapped answer (E12), recorded in code: the skipped question is noted as declined (it
 * counts as unknown in the scorecard, never against the candidate), unless it already has an answer, in which case the
 * skip only ends the follow-up and the answer stays; a tap is the answer, word for word. Then the next question, in the
 * packet's own words, or the end of the questions.
 */
async function answerInCode(q: Queryable, deps: ScreenDeps, b: ScreenBundle, input: { channel: ScreenChannel; actor: Actor; words: string | null; key: string }): Promise<TurnResult> {
  const { screen, company, packet, candidate } = b;
  const answers = { ...screen.answers };
  let progress: ScreenProgress = screen.progress;
  if (input.words === null) {
    const kept = answersOf({ answers, progress })[input.key] !== undefined;
    if (!kept) progress = { ...progress, declined: [...new Set([...(progress.declined ?? []), input.key])] };
    await emit(q, { type: "screen.question_skipped", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: input.key, answerKept: kept }, correlationId: screen.workflowRunId });
  } else {
    if (isFocusKey(input.key)) progress = withFocusAnswer(progress, input.key, input.words);
    else answers[input.key] = input.words;
    if (progress.declined?.includes(input.key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== input.key) };
    await emit(q, { type: "screen.answer_tapped", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: input.key }, correlationId: screen.workflowRunId });
  }
  const next = nextQuestion(packet, progress, answersOf({ answers, progress }));
  const lead = input.words === null ? "No problem." : "Thanks.";
  if (next) {
    const message = `${lead} Next: ${next.question}`;
    progress = advanceProgress(progress, { ...SILENT_TURN, messageToCandidate: message, questionKey: next.key });
    return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers, progress, message, questionKey: next.key, done: false });
  }
  progress = advanceProgress(progress, { ...SILENT_TURN, done: true });
  const message = `${lead} That is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.`;
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers, progress, message, questionKey: null, done: true });
}

/**
 * The conversation reached `modelTurnCap` with the candidate's latest message already recorded: it ends the way the end
 * of the questions does, in code, without calling the model again. On the web in the one-visit flow the candidate
 * checks their answers next (E10), where they can change any of them, answer one still open, and press Send, none of
 * which calls the model; any other conversation closes with what was said, and the scorecard reads only that.
 * Recorded as `screen.turn_cap_reached`.
 */
async function endAtTurnCap(q: Queryable, deps: ScreenDeps, b: ScreenBundle, input: { channel: ScreenChannel; actor: Actor }): Promise<TurnResult> {
  const { screen, company, packet } = b;
  const progress = advanceProgress(screen.progress, { ...SILENT_TURN, done: true });
  const review = isOneVisitFlow(progress) && input.channel === "web";
  await emit(q, { type: "screen.turn_cap_reached", companyId: company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: screen.id }, payload: { modelTurns: modelTurnsUsed(screen.transcript), cap: modelTurnCap(packet), ending: review ? "review" : "closed", channel: input.channel }, correlationId: screen.workflowRunId });
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers: screen.answers, progress, message: TURN_CAP_CLOSE_MESSAGE, reviewMessage: TURN_CAP_REVIEW_MESSAGE, questionKey: null, done: true });
}

/**
 * Writes the assistant's reply and the recorded answers, sends it by text on that channel, and settles the end of the
 * questions: a conversation offered with the application goes to "check your answers" (E10), saying `reviewMessage`
 * (REVIEW_MESSAGE unless given); any other closes.
 */
async function writeReply(q: Queryable, deps: ScreenDeps, b: ScreenBundle, s: { channel: ScreenChannel; actor: Actor; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress; message: string; questionKey: string | null; done: boolean; aiRunId?: string; reviewMessage?: string }): Promise<TurnResult> {
  const { screen, app, candidate, company, packet } = b;
  const review = s.done && isOneVisitFlow(s.progress) && s.channel === "web";
  const message = review ? s.reviewMessage ?? REVIEW_MESSAGE : s.message;
  const progress: ScreenProgress = review ? { ...s.progress, phase: "review", currentQuestionKey: null } : s.progress;
  const reply: ScreenTranscriptEntry = { role: "assistant", content: message, at: nowOf(deps).toISOString(), questionKey: s.questionKey ?? undefined, channel: s.channel, aiRunId: s.aiRunId };
  const transcript = [...s.transcript, reply];
  await q.update(screens).set({ transcript, answers: s.answers, progress }).where(eq(screens.id, screen.id));
  if (s.channel === "sms") {
    await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: s.aiRunId ? { kind: "agent", id: "screening", runId: s.aiRunId } : s.actor, text: message, idempotencyKey: `screen_turn:${screen.id}:${transcript.length}`, templateKey: "screen_turn", disclosureIncluded: false, aiRunId: s.aiRunId ?? null, correlationId: screen.workflowRunId });
  }
  if (s.done && !review) await completeScreen(q, deps, b, { answers: s.answers, progress, channel: s.channel, actor: s.actor });
  return { kind: "reply", message, done: s.done && !review, humanRequested: false, ...(review ? { review: true } : {}) };
}

/** The conversation is complete: recorded, the candidate moves to "screen complete", and the workflow writes the scorecard. */
async function completeScreen(q: Queryable, deps: ScreenDeps, b: ScreenBundle, s: { answers: Record<string, string>; progress: ScreenProgress; channel: ScreenChannel; actor: Actor; via?: string }): Promise<void> {
  const { screen, app, candidate, company, packet } = b;
  const now = nowOf(deps).toISOString();
  await q.update(screens).set({ status: "completed", completedAt: now }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.completed", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionsAnswered: Object.keys(answersOf({ answers: s.answers, progress: s.progress })).length, questions: packet.screening.questions.length, skipped: s.progress.declined?.length ?? 0, channel: s.channel, ...(s.via ? { via: s.via } : {}) }, correlationId: screen.workflowRunId });
  const [cur] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
  if (cur && ["screening", "screen_invited"].includes(cur.stage)) await transition(q, { applicationId: app.id, companyId: company.id, to: "screen_complete", by: "system", actor: s.actor, correlationId: screen.workflowRunId });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed` });
}

/** The marker on the assistant's "do you want to withdraw?" message: while it is the latest assistant message, the next reply decides. */
export const WITHDRAW_CONFIRM_KEY = "withdraw_confirm";

export type ScreenCommand = "human" | "withdraw" | "confirm_withdraw" | "keep_application";

/**
 * The keyword commands of a screening conversation (Wave 0 item 0.7). Only a message that is the command itself counts,
 * so an answer that happens to start with "Representative" or "Withdraw" is recorded as an answer. The plain request
 * "talk to a person" counts wherever it appears. While a withdrawal waits for confirmation, CONFIRM (or YES, or
 * WITHDRAW again) confirms it and NO keeps the application; anything else is an ordinary answer and the question lapses.
 */
export function screenCommand(message: string, pendingWithdraw = false): ScreenCommand | null {
  const m = message.trim();
  if (pendingWithdraw) {
    if (/^(confirm|yes|y|withdraw)[.!]?$/i.test(m)) return "confirm_withdraw";
    if (/^(no|nope|keep|keep going|keep it|keep my application)[.!]?$/i.test(m)) return "keep_application";
  }
  if (/^(human|person|a person|a human|agent|representative)[.!]?$/i.test(m) || /\b(talk|speak) (to|with) a (real )?(person|human)\b/i.test(m)) return "human";
  if (/^withdraw( my application)?[.!]?$/i.test(m)) return "withdraw";
  return null;
}

/** Whether the conversation is waiting for the candidate to confirm a withdrawal: the latest assistant message asked. */
export function withdrawPending(transcript: ScreenTranscriptEntry[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) if (transcript[i].role === "assistant") return transcript[i].questionKey === WITHDRAW_CONFIRM_KEY;
  return false;
}

/**
 * The candidate's answer to "do you want to withdraw?": a CONFIRM reply or the web page's button withdraws the
 * application (the conversation closes, the team is told, the workflow wakes); NO or the page's other button keeps it
 * and picks up where the conversation was. A screen that is no longer active is left alone (null). Returns the message
 * the candidate is shown, which also goes by text on that channel.
 */
export async function answerWithdrawPrompt(q: Queryable, deps: ScreenDeps, input: { screenId: string; confirm: boolean; channel: ScreenChannel; actor: Actor }): Promise<string | null> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !ACTIVE_STATUSES.has(b.screen.status)) return null;
  const { screen, app, candidate, company, packet } = b;
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  const at = nowOf(deps).toISOString();
  if (!input.confirm) {
    const current = screen.progress.currentQuestionKey ? packet.screening.questions.find((x) => x.key === screen.progress.currentQuestionKey) : undefined;
    const msg = `No problem, your application stays active.${current ? ` Here is where we were: ${current.question}` : ""}`;
    await q.update(screens).set({ transcript: [...screen.transcript, { role: "assistant", content: msg, at, channel: input.channel }] }).where(eq(screens.id, screen.id));
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_withdraw_kept:${screen.id}:${screen.transcript.length}`, templateKey: "screen_withdraw_kept", disclosureIncluded: false });
    return msg;
  }
  // A withdrawn application cannot be reopened, so the reply promises nothing about changing their mind (plan A1).
  const msg = withdrawnMessage(packet.identity.title);
  await q.update(screens).set({ status: "abandoned", transcript: [...screen.transcript, { role: "assistant", content: msg, at, channel: input.channel }] }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.abandoned", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: screen.id }, payload: { reason: "withdrawn" }, correlationId: screen.workflowRunId });
  await transition(q, { applicationId: app.id, companyId: company.id, to: "withdrawn", by: "candidate", actor: candidateActor, reason: "candidate withdrew during screening", correlationId: screen.workflowRunId });
  await emit(q, { type: "application.withdrawn", companyId: company.id, actor: candidateActor, subject: { type: "application", id: app.id }, payload: { during: "screen", channel: input.channel }, correlationId: screen.workflowRunId });
  await deps.onWithdrawn?.(q, { companyId: company.id, applicationId: app.id, actor: candidateActor });
  await notify(q, { companyId: company.id, kind: "candidate.withdrawn", title: `${candidate.firstName} ${candidate.lastName} withdrew`, body: `They withdrew from ${packet.identity.title} during the screening conversation, and confirmed it.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
  if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: msg, idempotencyKey: `screen_withdrawn:${screen.id}`, templateKey: "screen_withdrawn", disclosureIncluded: false });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed`, payload: { withdrawn: true } });
  return msg;
}

/** What the conversation says once a withdrawal is confirmed. A repeat submission's detached conversation says the same. */
export function withdrawnMessage(roleTitle: string): string {
  return `Understood, we have withdrawn your application for ${roleTitle}. Thank you for your time.`;
}

/**
 * The second transaction of a turn: checks the model's turn against the packet's rules, records the answer, sends the
 * reply, and hands over to a person or closes the conversation when the turn says so. On a model failure the candidate
 * gets an honest holding message; two failures in a row hand the conversation to a person, or, for the conversation
 * offered with the application, pause it until the assistant works again (E5). A paused conversation retried by the
 * workflow resumes here.
 */
export async function finishScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput, pending: Extract<BegunTurn, { kind: "pending" }>, out: RunOutcome<ScreenTurn>): Promise<TurnResult> {
  const { app, candidate, company, packet } = pending.b;
  const screen = pending.b.screen;
  const [fresh] = await q.select().from(screens).where(eq(screens.id, screen.id)).limit(1);
  if (!fresh) return { kind: "error", message: "This conversation is no longer available." };
  const b: ScreenBundle = { ...pending.b, screen: fresh };
  if (!out.ok) {
    // A retry of a paused conversation that failed again: it stays paused, and the workflow tries later.
    if (fresh.status === "paused") return { kind: "error", message: pausedMessage(company.name) };
    const failures = (fresh.progress.failures ?? 0) + 1;
    await q.update(screens).set({ progress: { ...fresh.progress, failures } }).where(eq(screens.id, screen.id));
    await emit(q, { type: "ai.run_failed", companyId: company.id, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: screen.id }, payload: { reason: out.reason, error: out.error, failures }, correlationId: screen.workflowRunId });
    if (failures >= 2) {
      if (isOneVisitFlow(fresh.progress) && input.channel === "web") return pauseScreen(q, deps, { ...b, screen: { ...fresh, progress: { ...fresh.progress, failures } } }, { reason: out.error });
      const msg = `Sorry, we are having trouble on our end. A person from ${company.name} will pick this up and follow up with you ${humanResponseExpectation(nowOf(deps), await loadBusinessCalendar(q))}.`;
      await requestHuman(q, deps, { screenId: screen.id, reason: `assistant failed twice (${out.error})`, actor: input.actor, reply: msg, replyChannel: input.channel });
      return { kind: "reply", message: msg, done: false, humanRequested: true };
    }
    const holding = "Sorry, something went wrong on our end. Please send that again in a minute.";
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: pending.b.role, company, packet, actor: input.actor, text: holding, idempotencyKey: `screen_holding:${screen.id}:${pending.transcript.length}`, templateKey: "screen_holding", disclosureIncluded: false });
    return { kind: "error", message: holding };
  }

  let turn = enforceTurnRules(out.output, packet, fresh.progress, answersOf(fresh));
  // The model never states a response time; the accurate business-hours expectation is appended in code (founder decision F12).
  if (turn.humanRequested && !/business/i.test(turn.messageToCandidate)) turn = { ...turn, messageToCandidate: `${turn.messageToCandidate} You can expect to hear from a person ${humanResponseExpectation(nowOf(deps), await loadBusinessCalendar(q))}.` };
  const answers = { ...fresh.answers };
  let progress = advanceProgress(fresh.progress, turn);
  if (turn.answerRecorded) {
    const recorded = redactProtected(turn.answerRecorded.answer);
    // An answer to one of the open questions the screen started with is kept beside that question; the packet's own answers stay in `answers`.
    if (isFocusKey(turn.answerRecorded.questionKey)) progress = withFocusAnswer(progress, turn.answerRecorded.questionKey, recorded);
    else answers[turn.answerRecorded.questionKey] = recorded;
  }
  if (fresh.status === "paused") {
    // The workflow's retry succeeded: the conversation is open again and the candidate is emailed to finish (E5).
    progress = { ...progress, pausedAt: undefined };
    await q.update(screens).set({ status: "in_progress" }).where(eq(screens.id, screen.id));
    await emit(q, { type: "screen.resumed", companyId: company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: screen.id }, payload: { pausedAt: fresh.progress.pausedAt ?? null }, correlationId: screen.workflowRunId });
  }
  if (turn.humanRequested) {
    const reply: ScreenTranscriptEntry = { role: "assistant", content: turn.messageToCandidate, at: nowOf(deps).toISOString(), channel: input.channel, aiRunId: out.runId };
    await q.update(screens).set({ transcript: [...fresh.transcript, reply], answers, progress }).where(eq(screens.id, screen.id));
    if (input.channel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: pending.b.role, company, packet, actor: { kind: "agent", id: "screening", runId: out.runId }, text: turn.messageToCandidate, idempotencyKey: `screen_turn:${screen.id}:${fresh.transcript.length + 1}`, templateKey: "screen_turn", disclosureIncluded: false, aiRunId: out.runId, correlationId: screen.workflowRunId });
    // A turn retried after an outage (E5) that hands over is told by the hand-over email instead: one email, not two.
    await requestHuman(q, deps, { screenId: screen.id, reason: turn.sentiment === "distressed" || turn.sentiment === "frustrated" ? `candidate sounded ${turn.sentiment}` : "candidate asked for a person", actor: input.actor, reply: null, replyChannel: input.channel, confirmByEmail: fresh.status !== "paused" });
    return { kind: "reply", message: turn.messageToCandidate, done: false, humanRequested: true };
  }
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: fresh.transcript, answers, progress, message: turn.messageToCandidate, questionKey: turn.questionKey, done: turn.done, aiRunId: out.runId });
}

/**
 * The assistant failed twice in the conversation offered with the application (E5): the conversation pauses with the
 * candidate's answers kept, the candidate is told they will get an email to finish, and the workflow retries until the
 * assistant works again. The person route stays open throughout.
 */
async function pauseScreen(q: Queryable, deps: ScreenDeps, b: ScreenBundle, input: { reason: string }): Promise<TurnResult> {
  const { screen, company } = b;
  const now = nowOf(deps).toISOString();
  const msg = pausedMessage(company.name);
  await q.update(screens).set({ status: "paused", progress: { ...screen.progress, pausedAt: now }, transcript: [...screen.transcript, { role: "assistant", content: msg, at: now, channel: "web" }] }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.paused", companyId: company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: screen.id }, payload: { reason: input.reason }, correlationId: screen.workflowRunId });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:paused` });
  return { kind: "reply", message: msg, done: false, humanRequested: false, paused: true };
}

/** One candidate message in, one assistant message out, with the model called between two short transactions. */
export async function runScreenTurn(db: Db, companyId: string, deps: ScreenDeps, input: TurnInput): Promise<TurnResult> {
  const begun = await withTenant(db, companyId, (q) => beginScreenTurn(q, deps, input));
  if (begun.kind === "done") {
    await flagAllowance(db, begun.allowance);
    return begun.result;
  }
  const out = await runPromptDetached(db, deps.ai, screenTurnPrompt, begun.ctx, { companyId, workflowRunId: begun.b.screen.workflowRunId, inputRef: { screenId: input.screenId, turn: begun.transcript.length } });
  const result = await withTenant(db, companyId, (q) => finishScreenTurn(q, deps, input, begun, out));
  await flagAllowance(db, begun.allowance);
  return result;
}

/**
 * The candidate asked for a person (or the assistant could not continue): a recruiter gets the whole context with a
 * 4-hour SLA. A request the candidate made is counted (Q16: ITS covers it; it never uses the company's recruiter requests).
 * The candidate also gets an email that says when to expect the person, from the business hours (plan G8), unless a
 * text already said so, or the caller answers them itself (`confirmByEmail: false`: the reply to their email does).
 */
export async function requestHuman(q: Queryable, deps: ScreenDeps, input: { screenId: string; reason: string; actor: Actor; reply: string | null; replyChannel: ScreenChannel; confirmByEmail?: boolean }): Promise<void> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return;
  const { screen, app, candidate, company, packet } = b;
  const now = nowOf(deps).toISOString();
  const transcript = input.reply ? [...screen.transcript, { role: "assistant" as const, content: input.reply, at: now, channel: input.replyChannel }] : screen.transcript;
  const byCandidate = !/failed|error/i.test(input.reason);
  await q.update(screens).set({ status: "human_requested", humanRequestedAt: now, transcript }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.human_requested", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { reason: input.reason }, correlationId: screen.workflowRunId });
  if (byCandidate) await entitlements.record(q, company.id, entitlements.PERSON_REQUESTS, 1, "request", { screenId: screen.id, choice: "contact_me" });
  await createEscalation(q, { companyId: company.id, roleId: app.roleId, applicationId: app.id, kind: "candidate_issue", summaryOrigin: byCandidate ? "candidate" : "system", question: `${candidate.firstName} ${candidate.lastName} needs a person during the ${packet.identity.title} screening (${input.reason}). Please reach out by ${candidate.phone ? "phone or " : ""}email and finish the screen.`, requestedBy: input.actor, workflowRunId: screen.workflowRunId });
  await notify(q, { companyId: company.id, kind: "screen.human_requested", title: `${candidate.firstName} asked for a person`, body: `During the ${packet.identity.title} screening. A recruiter has the conversation; you can also reply directly.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
  if (input.reply && input.replyChannel === "sms") await deliverSms(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, text: input.reply, idempotencyKey: `screen_human:${screen.id}`, templateKey: "screen_human", disclosureIncluded: false });
  const textSaidWhen = !!input.reply && input.replyChannel === "sms";
  if (byCandidate && input.confirmByEmail !== false && !textSaidWhen && candidate.email) {
    const expectation = humanResponseExpectation(nowOf(deps), await loadBusinessCalendar(q, nowOf(deps)));
    await sendPersonRequestedNote(q, deps.integrations, { application: app, candidate, role: b.role, company, packet, actor: input.actor, correlationId: screen.workflowRunId, expectation, key: screen.id });
  }
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:human` });
}

/**
 * "Send without the conversation" (E3, Q16): the candidate would rather not answer the questions. The conversation
 * closes as declined (answers given so far are kept for the team), the application goes on to the team as "ready for
 * your review", and the choice is counted. The team hears about it once: now, or after the reading of what they did
 * answer. Null when the conversation is no longer open.
 */
export async function declineConversation(q: Queryable, deps: ScreenDeps, input: { screenId: string; actor: Actor }): Promise<{ message: string } | null> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !SCREEN_PERSON_ROUTE_STATUSES.includes(b.screen.status as (typeof SCREEN_PERSON_ROUTE_STATUSES)[number])) return null;
  const { screen, app, candidate, company, packet } = b;
  const now = nowOf(deps).toISOString();
  const msg = `Thanks. Your application has gone to the hiring team at ${company.name} without the conversation. People on the team review it and you will hear from them either way.`;
  const answered = Object.keys(answersOf(screen)).length;
  await q.update(screens).set({ status: "declined_by_candidate", completedAt: now, transcript: [...screen.transcript, { role: "assistant", content: msg, at: now, channel: screen.channel as ScreenChannel }] }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.declined_by_candidate", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { applicationId: app.id, answered, questions: packet.screening.questions.length }, correlationId: screen.workflowRunId });
  await entitlements.record(q, company.id, entitlements.PERSON_REQUESTS, 1, "request", { screenId: screen.id, choice: "send_without" });
  const [cur] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
  if (cur && ["screen_invited", "screening"].includes(cur.stage)) await transition(q, { applicationId: app.id, companyId: company.id, to: "triaged", by: "system", actor: input.actor, reason: "sent without the screening conversation", correlationId: screen.workflowRunId });
  if (!answered) await notify(q, { companyId: company.id, kind: "screen.declined_by_candidate", title: `${candidate.firstName} ${candidate.lastName} sent their application without the conversation`, body: `They chose not to answer the screening questions for ${packet.identity.title}. Their application is ready for your review.`, action: { label: "Review", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed`, payload: { declined: true } });
  return { message: msg };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Check your answers (E10)                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** The "check your answers" page: every question in order with its answer, and how it came to be. */
export function reviewItems(screen: Pick<ScreenRow, "answers" | "progress">, packet: RolePacket): ReviewItem[] {
  const answers = answersOf(screen);
  const declined = new Set(screen.progress.declined ?? []);
  const edits = screen.progress.edits ?? {};
  return focusedPacket(packet, screen.progress).screening.questions.map((q) => {
    const answer = answers[q.key] ?? null;
    const status = answer !== null ? ((edits[q.key] ?? 0) > 0 ? "edited" : "answered") : declined.has(q.key) ? "declined" : "unanswered";
    return { key: q.key, question: q.question, answer, status, tap: tapFormatFor(q, packet.compensation) };
  });
}

/**
 * An answer changed (or a skipped question answered) on the "check your answers" page (E10). The new words are added
 * to the transcript, so the scorecard's quote check covers them, and the earlier answer stays in the record.
 */
export async function editScreenAnswer(q: Queryable, input: { screenId: string; questionKey: string; text?: string | null; tap?: TapAnswer | null; actor: Actor; now?: Date }): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || b.screen.status !== "in_progress" || b.screen.progress.phase !== "review") return { ok: false, error: "These answers can no longer be changed." };
  const { screen, packet, company, candidate } = b;
  const question = packet.screening.questions.find((x) => x.key === input.questionKey);
  if (!question) return { ok: false, error: "That question is not part of this conversation." };
  const now = input.now ?? new Date();
  const typed = input.text?.trim().slice(0, 2000) ?? "";
  const tapped = input.tap ? tapWords(packet, { currentQuestionKey: question.key }, input.tap, now) : null;
  const words = tapped ?? typed;
  if (!words) return { ok: false, error: input.tap ? "That answer does not fit this question. Please type it instead." : "Please type an answer first." };
  const recorded = tapped ?? redactProtected(words);
  const answers = { ...screen.answers };
  let progress: ScreenProgress = { ...screen.progress, edits: { ...(screen.progress.edits ?? {}), [question.key]: (screen.progress.edits?.[question.key] ?? 0) + 1 } };
  if (isFocusKey(question.key)) progress = withFocusAnswer(progress, question.key, recorded);
  else answers[question.key] = recorded;
  if (progress.declined?.includes(question.key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== question.key) };
  const entry: ScreenTranscriptEntry = { role: "candidate", content: words, at: now.toISOString(), channel: "web", questionKey: question.key, source: "edit" };
  await q.update(screens).set({ transcript: [...screen.transcript, entry], answers, progress, lastCandidateMessageAt: now.toISOString() }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.answer_edited", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: question.key, tapped: !!tapped }, correlationId: screen.workflowRunId });
  return { ok: true, answer: recorded };
}

/**
 * "Send" on the "check your answers" page (E10): the conversation is complete and the team's scorecard follows. `via`
 * "review_timeout": nobody pressed Send, and the answers went as they were after the reminder said they would (E4). The
 * row is locked first, so two presses at once complete it once.
 */
export async function submitScreenAnswers(q: Queryable, deps: ScreenDeps, input: { screenId: string; actor: Actor; via?: "review" | "review_timeout" }): Promise<{ ok: boolean }> {
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return { ok: false };
  if (b.screen.status === "completed") return { ok: true };
  if (b.screen.status !== "in_progress" || b.screen.progress.phase !== "review") return { ok: false };
  const progress: ScreenProgress = { ...b.screen.progress, submittedAt: nowOf(deps).toISOString() };
  await q.update(screens).set({ progress }).where(eq(screens.id, b.screen.id));
  await completeScreen(q, deps, { ...b, screen: { ...b.screen, progress } }, { answers: b.screen.answers, progress, channel: b.screen.channel as ScreenChannel, actor: input.actor, via: input.via ?? "review" });
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The rules the model is held to                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The rules the packet sets that the model must not break: one question at a time, two follow-ups at most, a bounded
 * conversation, skipped questions left alone, and every packet question asked in the packet's own words (the model
 * writes the acknowledgment; the question is added here when it did not write it word for word).
 */
export function enforceTurnRules(turn: ScreenTurn, packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>): ScreenTurn {
  const keys = packet.screening.questions.map((q) => q.key);
  let t: ScreenTurn = { ...turn };
  // How an answer was recorded is the code's to say (E10): the model only ever answers.
  if (t.answerRecorded) t = { ...t, answerRecorded: { questionKey: t.answerRecorded.questionKey, answer: t.answerRecorded.answer, complete: t.answerRecorded.complete } };
  if (t.questionKey && !keys.includes(t.questionKey)) t = { ...t, questionKey: null };
  if (t.answerRecorded && !keys.includes(t.answerRecorded.questionKey)) t = { ...t, answerRecorded: null };
  const declined = new Set(progress.declined ?? []);
  // A skipped question is not asked again.
  if (t.questionKey && declined.has(t.questionKey)) t = { ...t, questionKey: null };
  const asked = new Set(progress.askedKeys);
  const remaining = keys.filter((k) => !asked.has(k) && !(k in answers) && !declined.has(k) && k !== t.answerRecorded?.questionKey);
  const current = progress.currentQuestionKey;
  const isFollowUp = !!t.followUpReason && !t.questionKey && !t.done && !t.humanRequested;
  if (isFollowUp && current && (progress.followUps[current] ?? 0) >= MAX_FOLLOW_UPS) {
    // Enough follow-ups: move on with the next packet question, or close.
    const next = remaining[0];
    if (next) {
      const q = packet.screening.questions.find((x) => x.key === next)!;
      t = { ...t, messageToCandidate: `Thanks, that helps. Next: ${q.question}`, questionKey: next, followUpReason: null, answerRecorded: t.answerRecorded ?? (current ? { questionKey: current, answer: "", complete: false } : null) };
    } else {
      t = { ...t, done: true, followUpReason: null, questionKey: null, messageToCandidate: `Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.` };
    }
  }
  // Every question answered, skipped or asked, and the model asked nothing more: close politely. (How many times a
  // conversation may call the model at all is `modelTurnCap`, checked before each call.)
  const candidateTurns = Object.keys(answers).length + declined.size + (t.answerRecorded ? 1 : 0);
  if (!t.done && !t.humanRequested && candidateTurns >= keys.length && remaining.length === 0 && !t.questionKey) {
    t = { ...t, done: true, followUpReason: null };
  }
  if (t.answerRecorded && !t.answerRecorded.answer.trim()) t = { ...t, answerRecorded: null };
  // The packet's question in the packet's own words (plan E2): added after the model's acknowledgment when it is not there.
  if (t.questionKey && !t.done && !t.humanRequested) {
    const q = packet.screening.questions.find((x) => x.key === t.questionKey)!;
    if (!t.messageToCandidate.includes(q.question)) t = { ...t, messageToCandidate: `${t.messageToCandidate.trim()} ${q.question}`.trim() };
  }
  return t;
}

export function advanceProgress(progress: ScreenProgress, turn: ScreenTurn): ScreenProgress {
  const askedKeys = turn.questionKey && !progress.askedKeys.includes(turn.questionKey) ? [...progress.askedKeys, turn.questionKey] : progress.askedKeys;
  const followUps = { ...progress.followUps };
  if (turn.followUpReason && !turn.questionKey && progress.currentQuestionKey) followUps[progress.currentQuestionKey] = (followUps[progress.currentQuestionKey] ?? 0) + 1;
  return {
    // What the turn does not touch (the flow, skips, edits, the allowance count, a pause) carries over.
    ...progress,
    askedKeys,
    currentQuestionKey: turn.done || turn.humanRequested ? null : turn.questionKey ?? progress.currentQuestionKey,
    followUps,
    confusedTurns: turn.sentiment === "confused" ? progress.confusedTurns + 1 : 0,
    failures: 0,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The scorecard                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the candidate said, for the quote check: their own messages (typed, tapped, edited) and the recorded answers. Never a recruiter's notes. */
export function candidateWordsOf(screen: Pick<ScreenRow, "transcript" | "answers" | "progress">): string {
  return `${screen.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n")}\n${Object.values(answersOf(screen)).join("\n")}`;
}

/** A recruiter's call notes (E3), checked as their own source. */
export function recruiterNotesOf(screen: Pick<ScreenRow, "transcript">): string {
  return screen.transcript.filter((t) => t.role === "recruiter").map((t) => t.content).join("\n");
}

/**
 * The scorecard for a screen, called with no transaction open. Quotes are verified against the transcript in code. A
 * conversation the candidate did not finish (closed after the reminder, or sent without finishing) is read for what it
 * has: flagged incomplete, and never "strong interview".
 */
export async function assessScreen(db: Db, ai: AiRuntime, input: { companyId: string; screenId: string; workflowRunId?: string | null }): Promise<RunOutcome<ScreenAssessment>> {
  const b = await withTenant(db, input.companyId, (q) => loadScreenBundle(q, input.screenId));
  if (!b) throw new Error("screen not found");
  const answered = Object.keys(answersOf(b.screen)).length;
  const total = b.packet.screening.questions.length;
  const reason = b.screen.status === "unfinished" ? "unfinished" : b.screen.status === "declined_by_candidate" ? "declined_by_candidate" : null;
  const ctx: ScreenContext = { ...contextOf(b, b.screen, null), incomplete: reason ? { reason, answered, total } : null };
  const out = await runPromptDetached(db, ai, screenAssessPrompt, ctx, { companyId: b.company.id, workflowRunId: input.workflowRunId ?? b.screen.workflowRunId, inputRef: { screenId: b.screen.id, turns: b.screen.transcript.length } });
  if (!out.ok) return out;
  let checked = verifyScreenQuotes(out.output, candidateWordsOf(b.screen), { recruiterNotes: recruiterNotesOf(b.screen), declined: b.screen.progress.declined ?? [], answered: Object.keys(answersOf(b.screen)) });
  if (reason) {
    checked = {
      ...checked,
      recommendation: checked.recommendation === "strong_interview" ? "interview" : checked.recommendation,
      anomalies: [...checked.anomalies, { kind: "incomplete_screen", detail: `${reason === "unfinished" ? "The candidate stopped part-way and did not come back" : "The candidate sent their application without finishing the conversation"}: ${answered} of ${total} questions answered.` }],
    };
  }
  return { ...out, output: checked };
}

/**
 * The scorecard's evidence rules (plan 0.9): every quote must be the candidate's own words from the transcript or the
 * recorded answers. Strengths, concerns, competency and must-have findings go through the same rules as a résumé
 * reading (`applyEvidenceRules`: drop or strip, "no" only on a verified quote, "no quote" marks, confidence step-down);
 * answer findings and eligibility confirmations lose a quote that is not there. A recruiter's call notes (E3) are their
 * own source, `recruiter_note`: checked against the notes, never taken as the candidate's words, never a must-have
 * "no". A question the candidate skipped (E11) is unknown, whatever the model wrote, unless it has an answer on record
 * (`answered`: given before the skip, or added on "check your answers"), whose words are kept.
 */
export function verifyScreenQuotes(a: ScreenAssessment, candidateText: string, opts: { recruiterNotes?: string; declined?: string[]; answered?: string[] } = {}): ScreenAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(candidateText);
  const notes = norm(opts.recruiterNotes ?? "");
  const answered = new Set(opts.answered ?? []);
  const declined = new Set((opts.declined ?? []).filter((k) => !answered.has(k)));
  const ok = (quote?: string, source?: string) => !quote?.trim() || (source === "recruiter_note" ? !!notes && notes.includes(norm(quote)) : src.includes(norm(quote)));
  let stripped = 0;
  const questionFindings = a.questionFindings.map((f) => {
    if (declined.has(f.questionKey)) return { questionKey: f.questionKey, answered: false, finding: "Skipped by the candidate: unknown.", meetsModelAnswer: "unknown" as const };
    if (ok(f.evidence?.quote, f.evidence?.source)) return f;
    stripped += 1;
    return { ...f, evidence: undefined };
  });
  const eligibilityConfirmations = a.eligibilityConfirmations.map((e) => {
    if (ok(e.quote)) return e;
    stripped += 1;
    return { ...e, quote: undefined };
  });
  // Every quote in a scorecard is checked against the words it names: the candidate's, or a recruiter's notes (which pass as not the candidate's own).
  const checked = applyEvidenceRules({ ...a, questionFindings, eligibilityConfirmations }, (e) => (e.source === "recruiter_note" ? (notes && notes.includes(norm(e.quote ?? "")) ? null : false) : src.includes(norm(e.quote ?? ""))));
  if (!stripped) return checked;
  return { ...checked, anomalies: [...checked.anomalies, { kind: "unverified_quote", detail: `${stripped} answer quote${stripped === 1 ? "" : "s"} not found in the transcript; discarded` }] };
}

/** The most recent screen for an application, if any. */
export async function latestScreen(q: Queryable, applicationId: string): Promise<ScreenRow | null> {
  const rows = await q.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  return rows[0] ?? null;
}
