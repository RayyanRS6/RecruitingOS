import { and, desc, eq, inArray } from "drizzle-orm";
import { CHAT_SECTION_LABEL, SCREEN_ACTIVE_STATUSES, SCREEN_PERSON_ROUTE_STATUSES, type Actor, type ReviewItem, type RolePacket, type ScreenAssessment, type ScreenChannel, type ScreeningQuestion, type ScreenInvitedVia, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn, type TapAnswer, type TapFormat } from "@ros/contracts";
import { runPromptDetached, screenAssessPrompt, screenTurnPrompt, type AiRuntime, type ChatPromptContext, type RunOutcome, type ScreenContext } from "@ros/ai";
import { CHAT_GAP_LIMIT, CHAT_WRAP_KEY, HANDED_TO_A_PERSON, applicationAnswerSentences, buildChatPlan, chatMoveStays, chatNextMove, createEscalation, emit, entitlements, humanResponseExpectation, isOneVisitFlow, jobNoticesFor, loadBusinessCalendar, noticesFor, notify, payShown, saysNotDone, scoredSkill, screeningStoppedSummary, syncChatPlan, tapAnswerText, tapEcho, tapFormatFor, teamScreenView, transition, writtenQuestionsOf, type ChatMove } from "@ros/core";
import { aiRuns, applications, assessments, candidates, companies, documents, randomToken, rolePackets, roles, screens, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { deliverSms, recordInbound, sendPersonRequestedNote } from "./coordinator";
import { FOCUS_INTRO, answersOf, focusedPacket, isFocusKey, unfairQuestion, unplannedChatPacket, withFocusAnswer, type FocusQuestion } from "./screen-focus";
import { PLACEHOLDER, SCORING_VIEW_VERSION, restoreQuotes, scoringView, withoutPlaceholders, type ScoringIdentity, type ScoringView } from "./scoring-view";
import { TRIAGE_READINGS, answerInContext, applyEvidenceRules, closedAnswer, combineRunOutcomes, credentialFinding, credentialMustHaves, findingSubjects, jobWords, linkReadingRuns, plainlyNotHeld, sentenceAround, shownNotHeld, withoutInterviewSkills } from "./triage";

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
export function modelTurnCap(packet: Pick<RolePacket, "screening">, progress?: Pick<ScreenProgress, "chat"> | null): number {
  // A Kanvis-style chat's item can take four replies (the ask, one push, the analog, the smaller version).
  return (progress?.chat ? 4 : 3) * packet.screening.questions.length + 5;
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
 * The progress a new screen starts with: the open questions it opens with, and (Wave S8) `asks` "written", so a chat
 * without a plan asks the company's written questions (`chatPacket`) while one created before keeps the list it began
 * with. The opening by text is prepared from the same before the row exists (`prepareScreenOpening`).
 */
export function newScreenProgress(focusQuestions?: FocusQuestion[] | null): ScreenProgress {
  return { ...EMPTY_SCREEN_PROGRESS, ...(focusQuestions?.length ? { focusQuestions } : {}), asks: "written" };
}

/**
 * `focusQuestions` ("Ask about this in a screen"): asked before the packet's own questions; fixed on the row at creation.
 * `invitedVia` "apply" and `flow` "one_visit": the conversation offered in the same visit as the application (E1).
 */
export async function createScreen(q: Queryable, input: { companyId: string; applicationId: string; channel: ScreenChannel; workflowRunId?: string | null; expiresAt: string; now: Date; focusQuestions?: FocusQuestion[] | null; invitedVia?: ScreenInvitedVia | null; flow?: "one_visit" | null }): Promise<ScreenRow> {
  const existing = await q.select().from(screens).where(and(eq(screens.applicationId, input.applicationId), inArray(screens.status, [...SCREEN_PERSON_ROUTE_STATUSES]))).limit(1);
  if (existing[0]) return existing[0];
  let progress = newScreenProgress(input.focusQuestions);
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
  // The reading's open questions steer the chat's follow-ups: only those that pass the code's fairness check (`unfairQuestion`).
  // Wave S7: what the reading found for each must-have (the chat asks about the ones the CV does not show) and the
  // candidate's own CV lines and form answers (the chat names the CV and never asks again what the form asked).
  const triageMet = triage ? Object.fromEntries(triage.result.requirementFindings.map((f) => [f.requirementKey, f.met])) : null;
  return { app, candidate, role, company, packet: pv.packet, triageUnknowns: triage?.result.unknowns.map((u) => u.question).filter((q) => !unfairQuestion(q)) ?? [], triageMet, chatFacts: chatFactsOf(pv.packet, app) };
}
type ApplicationBundle = NonNullable<Awaited<ReturnType<typeof loadApplicationBundle>>>;

/**
 * `packet`: the questions as this conversation asks them (`chatPacket`: the résumé reading's open questions first, or,
 * in a Kanvis-style chat, its plan's items and the closing question). `rolePacket`: the job's own packet version.
 */
export async function loadScreenBundle(q: Queryable, screenId: string) {
  const [screen] = await q.select().from(screens).where(eq(screens.id, screenId)).limit(1);
  if (!screen) return null;
  const b = await loadApplicationBundle(q, screen.applicationId);
  if (!b) return null;
  // The AI interview made with an application sent from the apply form reads only what that visit gave (`visitChatFacts`).
  const visit = screen.invitedVia === "with_application" && fromApplyForm(b.app) ? { chatFacts: await visitChatFacts(q, b.packet, b.app), triageMet: null, triageUnknowns: [] as string[] } : {};
  // A screen that opens with the assessment's open questions sees them as its first questions everywhere the packet is read.
  return { ...b, ...visit, packet: chatPacket(b.packet, screen.progress), rolePacket: b.packet, screen };
}

/** Sent from the apply form (its own acknowledgment of the notices, `answers.acknowledgment`): a waiting room may open its interview. */
function fromApplyForm(app: Pick<ApplicationRow, "answers">): boolean {
  return !!(app.answers as { acknowledgment?: unknown } | null)?.acknowledgment;
}

/**
 * 21 October 2026 (Q14, founder: "same page, confirm by email"): the AI interview made with an application sent from the
 * apply form is made from what that visit gave, the same inputs a returning address's detached interview has
 * (apps/api services/apply-conversation.ts, `openDetached`), so that, given the same typing, both open with the same
 * words, questions and counter, and nothing tells whether an address applied before: the CV's lines from the form's own
 * reading of the résumé sent (`formReadExtraction`), the form's words, and the must-haves those lines do not show by the
 * CV-word rule (`chatGaps` with no reading), never the fit check's findings or open questions, which only an application
 * of its own has. The fit check still decides fit and the score (R20-2). An emailed-in or added application keeps the
 * reading of its own (no waiting room opens it).
 */
export async function visitChatFacts(q: Queryable, packet: RolePacket, app: Pick<ApplicationRow, "extraction" | "answers" | "resumeDocumentId">): Promise<ChatFacts> {
  return chatFactsOf(packet, { answers: app.answers, extraction: await formReadExtraction(q, app) });
}

/**
 * The résumé reading the visit's interview may name: the application's, only when it is the apply form's own reading of
 * the file sent (tied to the document, `purpose` "apply_form"), the only reading a repeat's upload ever gets; none when
 * the intake had to read the file itself (sent inside the form without script, or a form reading that failed).
 */
async function formReadExtraction(q: Queryable, app: Pick<ApplicationRow, "extraction" | "resumeDocumentId">): Promise<ApplicationRow["extraction"]> {
  if (!app.extraction || !app.resumeDocumentId) return null;
  const [doc] = await q.select({ runId: documents.extractedByAiRunId }).from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
  const [run] = doc?.runId ? await q.select({ inputRef: aiRuns.inputRef }).from(aiRuns).where(eq(aiRuns.id, doc.runId)).limit(1) : [];
  return (run?.inputRef as { purpose?: unknown } | null | undefined)?.purpose === "apply_form" ? app.extraction : null;
}
export type ScreenBundle = NonNullable<Awaited<ReturnType<typeof loadScreenBundle>>>;

type ConversationState = Pick<ScreenRow, "channel" | "progress" | "answers" | "transcript">;

/** The model's view of the conversation. Exported for a repeat submission's detached conversation, which has no application of its own. */
type CompanyRow = typeof companies.$inferSelect;

/**
 * `facts` (Wave S7): the candidate's CV lines and form answers, for a Kanvis-style chat (`progress.chat`); none for a
 * repeat submission's detached chat, where nothing about the person on file reaches the model.
 */
export function screenContextOf(input: { companyName: string; companyLocations: CompanyRow["locations"]; noticeOverrides: CompanyRow["settings"]["notices"]; packet: RolePacket; firstName: string; focusUnknowns: string[]; facts?: ChatFacts | null }, screen: ConversationState, latest: string | null): ScreenContext {
  return {
    chat: screen.progress.chat ? chatPromptOf(input.packet, screen.progress, input.facts ?? null) : null,
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

function contextOf(b: ApplicationBundle & { screen?: Pick<ScreenRow, "invitedVia"> }, screen: ConversationState, latest: string | null): ScreenContext {
  return screenContextOf({ companyName: b.company.name, companyLocations: b.company.locations, noticeOverrides: b.company.settings.notices, packet: b.packet, firstName: b.candidate.firstName, focusUnknowns: b.triageUnknowns, facts: chatFactsFor(b.chatFacts, screen.progress, b.screen?.invitedVia ?? null) }, screen, latest);
}

/**
 * What a chat may name about the candidate (Wave S7). A repeat submission's detached chat: only what was typed in its
 * visit (`typedFacts`). A chat offered with the application: the application's own CV and form answers only when the
 * visit passed what was typed (`ownFacts`), so that, given the same typing, the two read alike and a chat never shows
 * whether an address applied before. Any other chat (its link was emailed to the address on file): the application's.
 */
export function chatFactsFor(appFacts: ChatFacts | null, progress: Pick<ScreenProgress, "typedFacts" | "ownFacts">, invitedVia: string | null): ChatFacts | null {
  if (progress.typedFacts) return progress.typedFacts;
  // The form's answers are what this visit typed either way (a repeat submission's chat gets the same from its form).
  if (invitedVia === "apply" && !progress.ownFacts) return appFacts ? { cv: [], formAnswers: appFacts.formAnswers } : null;
  return appFacts;
}

/** Screening stays within the job. Anything about a protected characteristic the candidate volunteers is kept out of recorded answers (the transcript itself is the record). */
export function redactProtected(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const protectedPattern = /\b(i am|i'm|im)\s+\d{2}\b|\b\d{2}\s+years? old\b|\bmy (kids?|children|son|daughter|husband|wife|spouse)\b|\bi(?: have|'ve) (?:a |an |one |two |three |four |five |\d+ )?(?:little |young |small )?(kids?|children|sons?|daughters?|baby|toddlers?)\b|\bpregnan|\bmaternity\b|\bpaternity\b|\bchurch\b|\bmosque\b|\bsynagogue\b|\breligio|\bdisabilit|\bwheelchair\b|\bmy (illness|condition|diagnosis)\b|\bimmigra|\bcitizen(ship)?\b|\bvisa\b|\bnational(ity)?\b|\bdivorc|\bmarried\b|\bsingle (?:mom|mum|dad|mother|father|parent)\b/i;
  // Parenthood, military service, national origin and faith in the ways people mention them ("As a mom of three", "I'm
  // a veteran", "I moved here from Mexico"), kept apart so each list stays readable.
  const familyPattern = /\b(?:mom|mum|mother|dad|father) of (?:one|two|three|four|five|six|\d+|twins)\b|\bas a (?:working |stay[- ]at[- ]home |new |young )?(?:mom|mum|mother|dad|father|parent|grandparent|grandmother|grandfather)\b|\bi(?:'m| am) a (?:working |new |young )?(?:mom|mum|mother|dad|father|parent|grandparent)\b|\bmy (?:kid|kiddo|grandchild|grandchildren|grandkids|baby|newborn|toddler|family planning)s?\b/i;
  const servicePattern = /\bveterans?\b|\b(?:served|serving|enlisted|deployed) (?:in|with) the (?:military|army|navy|air force|marines|marine corps|armed forces|national guard|coast guard)\b|\bmy (?:military|army|navy|air force|marine corps) (?:service|days|years|career|time)\b|\b(?:honorable|dishonorable|medical) discharge\b/i;
  // "moved here from <Place>": the place is a capitalised name, so this one reads case as written ("from a clinic" is work)
  const movedFrom = /\b[Mm]oved (?:[Hh]ere|to (?:the )?(?:US|U\.S\.|USA|United States|States|America|this country)) from (?!(?:A|An|The|My|Our|Another)\b)\p{Lu}[\p{L}'’-]+/u;
  const originPattern = /\bborn (?:and raised )?in\b|\bmy (?:home ?country|accent|visa|green card|native (?:language|country|tongue)|first language|mother tongue)\b|\bgreen card\b|\b(?:i|we) (?:came|emigrated|immigrated) (?:here |to (?:the )?(?:us|u\.s\.|usa|united states|america) )?from\b/i;
  const faithPattern = /\bmy (?:faith|religion|temple|parish|congregation|pastor|imam|rabbi)\b|\b(?:i|we) (?:pray|worship)\b/i;
  const touches = (s: string) => protectedPattern.test(s) || familyPattern.test(s) || servicePattern.test(s) || movedFrom.test(s) || originPattern.test(s) || faithPattern.test(s);
  const kept = sentences.filter((s) => !touches(s));
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
export function screenIntro(input: { companyName: string; firstName: string; packet: RolePacket; noticeOverrides?: CompanyRow["settings"]["notices"]; focus?: boolean; /** The chat runs in sections (`withChatPlan`): it asks the company's written questions. */ chat?: boolean }): ScreenIntro {
  const { packet, companyName } = input;
  // A Kanvis-style chat whose company wrote its own questions (Wave S7) asks those; every other conversation asks the
  // questions of the packet it reads (`chatPacket`: the résumé reading's open questions first, then the company's
  // written questions on a chat created since Wave S8, or the job's screening questions).
  const written = input.chat ? packet.companyQuestions?.written?.length ?? 0 : 0;
  const n = written ? written + packet.screening.questions.filter((q) => isFocusKey(q.key)).length : packet.screening.questions.length;
  const notice = noticesFor(["*"], input.noticeOverrides).find((x) => x.key === "ai_use");
  return {
    title: `A few questions about the ${packet.identity.title} role`,
    disclosure: `Hi ${input.firstName}, this is ${companyName}'s hiring assistant, a software program. It will ask you ${n} short questions about the ${packet.identity.title} role, one at a time.${input.focus ? ` ${FOCUS_INTRO}` : ""} Your answers go to the hiring team once you send them, and people on the team make every decision. You can ask for a person at any time.`,
    aiNotice: notice ? { version: notice.version, text: notice.text } : null,
    packetDisclosure: packet.communication.disclosureText,
    humanAlternative: packet.communication.humanAlternativeText,
    questions: n,
    minutes: packet.screening.maxMinutes,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The Kanvis-style chat (Wave S7; spec-s7-apply-flow.md step 6, the contracts in s7-contracts.md section 2b)       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The chat offered with the application on the web runs in sections (founder decision S7-3): "About your experience"
 * (the job's must-haves the CV does not show, and the résumé reading's open questions the team asked for), "Required
 * questions" (the company's written questions, or a job's own screening questions when it set none) and "Wrapping
 * up" (one closing question). Its plan (`progress.chat`) is fixed in code when the chat starts and moved on in code after
 * each turn; the model reads each reply (`reading`) and writes the words, and the code holds every turn to the rules:
 * one neutral restatement and one question, one push for specifics, the analog and the smaller version, "No" settled as
 * not known with a calm line, no filler, no inference, the closing question, and the fairness check on every question.
 * Every other conversation (by email later, by text) runs without a plan, as it did; since Wave S8 it asks the
 * company's written questions too (`unplannedChatPacket`), and one from before keeps the list it began with.
 */

type ApplicationRow = typeof applications.$inferSelect;

/** What the chat may know about the candidate: their own CV lines, and their form answers as sentences. */
export type ChatFacts = { cv: string[]; formAnswers: string[] };

const line = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The CV's positions, licences, certificates and skills as a few plain lines (the candidate's own information: the chat
 * names it). Shared by the application's chat (`chatFactsOf`) and the apply form's reading of the CV in the same visit
 * (apps/api services/apply-details.ts, `ResumeReading.cvLines`), so both read alike.
 */
export function cvLinesOf(x: ApplicationRow["extraction"] | null | undefined): string[] {
  const cv: string[] = [];
  for (const p of (x?.positions ?? []).slice(0, 4)) cv.push(line(`${p.title}${p.employer ? ` at ${p.employer}` : ""}${p.startDate ? ` (${p.startDate}${p.current ? " to now" : p.endDate ? ` to ${p.endDate}` : ""})` : ""}${p.summary ? `: ${p.summary}` : ""}`));
  for (const l of (x?.licenses ?? []).slice(0, 3)) cv.push(line(`Licence: ${l.name}${l.jurisdiction ? ` (${l.jurisdiction})` : ""}`));
  for (const c of (x?.certifications ?? []).slice(0, 3)) cv.push(line(`Certification: ${c.name}`));
  if (x?.skills?.length) cv.push(line(`Skills: ${x.skills.slice(0, 12).join(", ")}`, 300));
  return cv;
}

/** The form's own words about their work as CV lines: the summary they checked, and the no-résumé answers. */
export function answerCvLines(answers: { workSummary?: string | null; noResume?: Record<string, unknown> | null } | null | undefined): string[] {
  const cv: string[] = [];
  if (answers?.workSummary) cv.push(line(`Summary of their work: ${answers.workSummary}`, 400));
  for (const v of Object.values(answers?.noResume ?? {}).slice(0, 4)) if (typeof v === "string" && v.trim()) cv.push(line(`Their own words about their work: ${v}`, 300));
  return cv;
}

/** Wave S8: the most facts from earlier chats a reuse form lists, and so the most one application keeps (`answers.kept`). */
export const KEPT_FACTS_MAX = 8;
/** The longest a chat's facts list is (`ScreenProgress.typedFacts` holds at most 20 lines). */
const CHAT_FACT_LINES = 20;

/**
 * What the chat reads of the facts from earlier chats the candidate kept on the form (Wave S8): each one as their own
 * words, in the wording the form's answers about their work already use (`answerCvLines`), so the chat names them,
 * never as a résumé line, and never asks again what they settle (`chatGaps` reads these lines). Nothing about an
 * earlier chat, job or application.
 */
export function keptFactLines(facts: ReadonlyArray<{ text: string }>): string[] {
  return facts.slice(0, KEPT_FACTS_MAX).map((f) => `Their own words about their work: ${f.text}`.replace(/\s+/g, " ").trim().slice(0, 300));
}

/** The facts with the kept ones added after the CV's lines; the kept ones keep their place within the limit. */
export function chatFactsWithKept(facts: ChatFacts, kept: ReadonlyArray<{ text: string }>): ChatFacts {
  const lines = keptFactLines(kept);
  if (!lines.length) return facts;
  return { cv: [...facts.cv.slice(0, CHAT_FACT_LINES - lines.length), ...lines], formAnswers: facts.formAnswers };
}

/**
 * The candidate's CV as a few plain lines (their own information: the chat names it), and the form's answers as
 * sentences; with the facts from earlier chats they kept on the form (Wave S8, `answers.kept`), so a chat whose link
 * was emailed later reads them as the chat in the visit does.
 */
export function chatFactsOf(packet: RolePacket, app: Pick<ApplicationRow, "extraction" | "answers">): ChatFacts {
  const answers = app.answers ?? {};
  const facts = { cv: [...cvLinesOf(app.extraction), ...answerCvLines(answers)], formAnswers: applicationAnswerSentences(packet, answers).map((s) => s.sentence) };
  return chatFactsWithKept(facts, Array.isArray(answers.kept) ? answers.kept : []);
}

/** The closing question, in code's words (the model may say it its own way, with the first name). */
export const CHAT_WRAP_QUESTION = "Is there anything else you would like the hiring team to know before we finish?";
/** Said when "No" settles an item as not known: calm, and never a guess about what they can do. */
export const CHAT_CALM_LINE = "Understood, thanks for saying so.";
/** The question the code asks when the model's follow-up has none: one push, the analog, the smaller version. */
export const CHAT_LADDER_QUESTION: Readonly<Record<"push" | "analog" | "smaller", string>> = {
  push: "Could you tell me about one specific time: what you did, and what came of it?",
  analog: "Not done that exactly? Tell me about something similar from your own work.",
  smaller: "Even a small moment counts: was there a time, even with just a few people, when you did something like it?",
};

/** What the chat says about a must-have the CV does not show: always true, whether or not it is on the CV in other words. */
export function gapQuestion(text: string): string {
  return `This is one of the things the job needs: ${text.trim().replace(/[.!?]+$/, "")}. What can you tell me about it from your own work?`;
}

/** What the chat says at its end, after the close: what happens next, and that nothing is sent before Send. */
export function chatNextLine(companyName: string): string {
  return `Next, check what you are sending and change anything you like, then press Send. Nothing goes to ${companyName} until you do.`;
}

/** The chat's last message: its close (one concrete thing from the chat, or a plain thank-you) and what happens next. */
export function chatClosingMessage(closing: string | null | undefined, companyName: string): string {
  const said = closing?.trim();
  return said ? `${said}\n\n${chatNextLine(companyName)}` : chatNextLine(companyName);
}

/**
 * The questions as a Kanvis-style chat asks them, for every reader of the packet (the turn rules, the page, the
 * scorecard): the plan's items in order (an open question from the résumé reading as it was; a must-have as
 * `gapQuestion`; a company question as written, its private note given to the models as the model answer; a job's own
 * screening question as it is), then the closing question. Without a plan (`unplannedChatPacket`): the résumé reading's
 * open questions first, then on a chat created since Wave S8 the company's written questions mapped the same way, or
 * the packet's own (`focusedPacket`), as before. Reading it twice gives the same.
 */
export function chatPacket(packet: RolePacket, progress: Pick<ScreenProgress, "focusQuestions" | "chat" | "asks"> | null | undefined): RolePacket {
  const plan = progress?.chat;
  if (!plan) return unplannedChatPacket(packet, progress);
  const focused = focusedPacket(packet, progress);
  const own = new Map(focused.screening.questions.filter((q) => q.key !== CHAT_WRAP_KEY).map((q) => [q.key, q]));
  const written = new Map((packet.companyQuestions?.written ?? []).map((w) => [w.key, w]));
  const must = new Map((packet.requirements?.mustHaves ?? []).map((m) => [m.key, m]));
  const questions: ScreeningQuestion[] = [];
  for (const item of plan.items) {
    const w = item.kind === "written" ? written.get(item.key) : undefined;
    const m = item.kind === "gap" && !isFocusKey(item.key) ? must.get(item.key) : undefined;
    const q = w ? { key: w.key, question: w.question, kind: "behavioral" as const, ...(w.lookFor ? { modelAnswer: w.lookFor } : {}) } : m ? { key: m.key, question: gapQuestion(m.text), kind: "skills" as const } : own.get(item.key);
    if (q) questions.push(q);
  }
  questions.push({ key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION, kind: "motivation" });
  return { ...packet, screening: { ...packet.screening, questions } };
}

/** Whether "No" climbs the ladder for an item: a gap, or an open question; a yes-or-no question takes "No" as its answer. */
function ladderApplies(kind: "gap" | "written", q: Pick<ScreeningQuestion, "kind"> | undefined): boolean {
  return kind === "gap" || (!!q && (q.kind === "skills" || q.kind === "behavioral"));
}

/** Words that say what a line is about ("Do you have experience with...?" says nothing): the same list the scorecard uses. */
function sameTopic(a: string, b: string): boolean {
  const wa = new Set(topicWords(a));
  const wb = new Set(topicWords(b));
  if (!wa.size || !wb.size) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared >= Math.min(2, wa.size);
}

/**
 * "About your experience": the résumé reading's open questions the team asked for (`focusQuestions`), then the job's
 * must-haves the CV does not show, at most `CHAT_GAP_LIMIT`. With a reading: those it found partly or not at all (a
 * must-have the candidate's own words already settle, either way, is left alone); before the reading has run (the
 * one-visit flow can start first), those whose words are not in the CV; with no CV to read, none (the chat starts at
 * the required questions). Never one checked in the interviews only, one the form already asked about, or one that is
 * also a written question.
 */
export function chatGaps(input: { packet: RolePacket; progress: Pick<ScreenProgress, "focusQuestions">; triageMet: Record<string, string> | null; facts: ChatFacts | null; written: string[] }): string[] {
  const focus = (input.progress.focusQuestions ?? []).map((f) => f.key);
  const asked = input.facts?.formAnswers ?? [];
  const cv = (input.facts?.cv ?? []).join("\n").toLowerCase();
  const gaps = (input.packet.requirements?.mustHaves ?? []).filter((m) => {
    if (input.written.includes(m.key) || focus.includes(m.key)) return false;
    if (!m.evidencedBy.some((e) => e !== "interview")) return false;
    if (asked.some((a) => sameTopic(m.text, a))) return false;
    if (input.triageMet) {
      const met = input.triageMet[m.key];
      return met === undefined || met === "unknown" || met === "partially";
    }
    const words = topicWords(m.text);
    return !!cv && words.filter((w) => cv.includes(w)).length < Math.ceil(words.length / 2);
  });
  return [...focus, ...gaps.map((m) => m.key)].slice(0, CHAT_GAP_LIMIT);
}

/**
 * The plan for a chat that starts now (the chat offered with the application, on the web), on the progress it starts
 * from; the progress as it was for any other conversation, or one that has a plan already.
 */
export function withChatPlan(rolePacket: RolePacket, progress: ScreenProgress, input: { channel: string; gaps: string[]; at: string }): ScreenProgress {
  if (progress.chat || input.channel !== "web" || !isOneVisitFlow(progress)) return progress;
  const written = writtenQuestionsOf(rolePacket).map((w) => ({ key: w.key, required: w.required }));
  return { ...progress, chat: buildChatPlan({ gaps: input.gaps, written, at: input.at }) };
}

/**
 * The chat's first message, in code (no model at Start, plan E2): the first name, one line from the CV when there is
 * one, then the first item's question word for word. A repeat submission's detached chat greets the typed name only.
 */
export function chatOpening(input: { firstName: string; cv: string[]; question: string }): string {
  const first = input.firstName.trim() || "there";
  const work = input.cv[0]?.split(":")[0]?.trim().replace(/[.!?]+$/, "");
  // Only a position from the résumé is named; the form's own words about their work are not a résumé line.
  const said = work && !/^(licence|certification|skills|summary|their own words)/i.test(work) ? `Your resume shows your work as ${work}.` : "Thanks for applying.";
  return `Hi ${first}. ${said}\n\n${input.question}`;
}

/** The chat's state as the model sees it: the plan, each item's question and ladder, the private notes, the CV and the form. */
function chatPromptOf(packet: RolePacket, progress: ScreenProgress, facts: ChatFacts | null): ChatPromptContext | null {
  const plan = progress.chat;
  if (!plan) return null;
  const qs = new Map(packet.screening.questions.map((q) => [q.key, q]));
  const lookFor = new Map((packet.companyQuestions?.written ?? []).flatMap((w) => (w.lookFor ? [[w.key, w.lookFor] as const] : [])));
  return {
    section: plan.section,
    sectionLabel: CHAT_SECTION_LABEL[plan.section],
    current: progress.currentQuestionKey,
    items: plan.items.map((i) => {
      const q = qs.get(i.key);
      const note = lookFor.get(i.key);
      return { key: i.key, kind: i.kind, required: i.required, state: i.state, step: i.step, pushes: i.pushes, question: q?.question ?? i.key, ladder: ladderApplies(i.kind, q), ...(note ? { lookFor: note } : {}) };
    }),
    wrap: { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION },
    cv: facts?.cv ?? [],
    formAnswers: facts?.formAnswers ?? [],
  };
}

const FILLER = /^(?:(?:ok(?:ay)?|great|good|excellent|awesome|perfect|wonderful|fantastic|amazing|nice|cool|brilliant|lovely|thanks?|thank you|got it|i see|noted|sure|understood|right|alright)(?: so much| very much| for (?:sharing|that|explaining|telling me)(?: that)?)?|that['’]?s (?:great|good|helpful|really helpful|very helpful|good to know|wonderful|impressive|excellent|fantastic|amazing|interesting|clear)|good to know|that helps|love (?:that|it))[.!]*$/i;
const PRAISE = /\b(?:great|excellent|impressive|amazing|fantastic|wonderful|brilliant|outstanding|strong|solid|clear(?:ly)?|well done|nicely|good job|good work)\b/i;
const INFERENCE = /^(?:it sounds like|it seems|it looks like|that suggests|this suggests|clearly|obviously|you must|you clearly|you obviously|i can tell|that shows|this shows|so it was|so that was|it must have)\b|\b(?:which|that|this) (?:shows|proves|demonstrates)\b|\byou(?:'re| are) clearly\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * One neutral restatement and one question (spec step 6): the first question the model wrote, and before it at most one
 * sentence (two when the candidate asked something and it is being answered), with filler, inference and, in "About
 * your experience", praise left out. `calm`: the restatement is the calm line instead (an item settled as not known).
 * `question`: asked when the model wrote none. Never adds words of the model's.
 */
export function shapeChatMessage(text: string, opts: { experience: boolean; calm: boolean; question: string | null; answering: boolean }): string {
  const question = firstQuestion(text) ?? opts.question;
  const lead = chatLead(text, opts);
  if (!question) return lead || text.trim();
  return lead ? `${lead}\n\n${question}` : question;
}

const ASKS = /\?["”’)]*$/;
/** How a candidate's question to the assistant opens, after a few lead-in words ("Ok, so what…", "Before I go on, what…"). */
const ASKS_THEM = /^(?:(?:ok(?:ay)?|so|and|but|also|sorry|hi|hello|hey|thanks|one (?:more )?question|quick question|(?:i was |i'm |just )?wondering|before i (?:go on|answer|continue))[,:.!]?\s+)*(?:what|how|when|where|why|who|which|whose|is|isn't|are|aren't|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has)\b/i;
/**
 * A sentence of the candidate's that asks the assistant something: it ends in "?" and opens as a question does ("What
 * does it pay?", "Is it full time?"), or is only question marks. An answer said with a rising "?" ("Around $50 an
 * hour?", "I'm looking for $52 an hour, is that ok?", "5 years, why?") is still an answer (Wave S9 review).
 */
const asksAssistant = (s: string) => ASKS.test(s) && (ASKS_THEM.test(s.replace(/[’‘]/g, "'")) || !/[\p{L}\p{N}]/u.test(s));
/** A request that asks as a question does ("Tell me about…", "Walk me through…"). */
const REQUEST = /^(?:please\s+)?(?:tell me|describe|walk me through|talk me through|share|give me|explain)\b/i;
const asksAt = (sentences: string[]) => sentences.findIndex((s) => ASKS.test(s) || REQUEST.test(s));

/**
 * The first question the model wrote ("Not done that exactly? Tell me about something similar." is one: a question
 * with the request that follows it), or null. Anything after it is left out.
 */
function firstQuestion(text: string): string | null {
  const sentences = sentencesOf(text);
  const at = asksAt(sentences);
  if (at < 0) return null;
  let end = at + 1;
  if (ASKS.test(sentences[at])) while (end < sentences.length && REQUEST.test(sentences[end]) && !/\?/.test(sentences[end])) end += 1;
  return sentences.slice(at, end).join(" ");
}

/** The restatement: at most one sentence before the first question (two while answering the candidate), without filler, inference or (in "About your experience") praise; the calm line instead when `calm`. */
function chatLead(text: string, opts: { experience: boolean; calm: boolean; answering: boolean }): string {
  if (opts.calm) return CHAT_CALM_LINE;
  const sentences = sentencesOf(text);
  const at = asksAt(sentences);
  // A restatement never repeats anything personal the candidate volunteered (their kids, their age…): it is not recorded either.
  const before = (at >= 0 ? sentences.slice(0, at) : sentences).filter((s) => !FILLER.test(s) && !INFERENCE.test(s) && !(opts.experience && PRAISE.test(s)) && !/\?/.test(s) && redactProtected(s) === s);
  return before.slice(0, opts.answering ? 2 : 1).join(" ");
}

/**
 * A close: the model's sentences that are not questions, at most two, without inference, filler, anything personal,
 * what happens next (the code says it) or any time (decisions are private with no deadline, founder decision B6); null
 * when none are left.
 */
function shapeClosing(text: string): string | null {
  const kept = sentencesOf(text).filter((s) => !/\?/.test(s) && !INFERENCE.test(s) && !FILLER.test(s) && redactProtected(s) === s && !/\b(?:press send|next screen|review your answers|check your answers|what happens next|hear back|within|few days|next week|soon|shortly)\b/i.test(s));
  return kept.length ? kept.slice(0, 2).join(" ") : null;
}

/** Whether the words share a run of five with a private note: a note is never said to a candidate, even in part. */
function echoesNote(text: string, note: string | undefined): boolean {
  if (!note) return false;
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const n = words(note);
  if (n.length < 5) return false;
  const grams = new Set(n.slice(0, -4).map((_, i) => n.slice(i, i + 5).join(" ")));
  const t = words(text);
  return t.slice(0, -4).some((_, i) => grams.has(t.slice(i, i + 5).join(" ")));
}

/**
 * The candidate's replies about an item since it was asked: their words, in order, for the answer recorded when it
 * settles. A keyword command ("WITHDRAW", "HUMAN", a "CONFIRM" to a withdrawal) is not an answer.
 */
function replyListSince(transcript: ReadonlyArray<ScreenTranscriptEntry>, key: string): string[] {
  let at = -1;
  for (let i = transcript.length - 1; i >= 0 && at < 0; i--) if (transcript[i].role === "assistant" && transcript[i].questionKey === key) at = i;
  const words: string[] = [];
  let pending = false;
  for (const t of transcript.slice(at + 1)) {
    if (t.role === "assistant") pending = t.questionKey === WITHDRAW_CONFIRM_KEY;
    if (t.role !== "candidate" || t.source === "edit" || !t.content.trim() || screenCommand(t.content, pending) !== null) continue;
    words.push(t.content.trim());
  }
  return words;
}

const BARE_YES = /^(?:yes|yeah|yep|yup|ya|sure|i have|i do|i did|i can|of course|definitely|absolutely)[.!]*$/i;
/** A reply with nothing in it yet for an open question: a bare "yes", or a plain "No" / "I haven't" (`saysNotDone`). */
function bareReply(text: string): boolean {
  return BARE_YES.test(text.trim()) || saysNotDone(text);
}

/** What the conversation adds for a confused candidate when the model did not offer a person (Wave S9). */
export const CONFUSED_OFFER = "If you would rather talk to a person, reply HUMAN.";

/** Whether a message asks something: a question, or a request that asks as one does ("Tell me about…"). */
function asksSomething(text: string): boolean {
  return asksAt(sentencesOf(text)) >= 0;
}

/**
 * Whether a candidate's message only asks the assistant something ("Before I go on, what does this pay per hour?",
 * "Ok. What are the hours?"): a question they asked is never their answer (Wave S9).
 */
export function onlyQuestions(text: string | null | undefined): boolean {
  const sentences = sentencesOf(text ?? "");
  return sentences.some(asksAssistant) && sentences.every((s) => asksAssistant(s) || FILLER.test(s));
}

const CONFUSED = /^(?:(?:sorry|um+|uh+|hm+|eh|huh)\s+)*(?:what do you mean(?: by that)?|what does that mean|what is that|what|huh|sorry|pardon|come again|i (?:do not|don't|dont) (?:understand|get it|follow)(?: (?:that|the question|you|what you mean))?|i(?:'m| am) (?:confused|lost|not sure what you mean)|confused|not sure what you mean)$/;

/**
 * Whether a reply only says the candidate did not follow ("???", "What do you mean?", "Sorry, I don't understand"): such a
 * reply gets help and the offer of a person, and is never recorded as an answer, whatever the model read (Wave S9).
 * Narrow on purpose: "What do you mean by perio charting?" asks about the question, and the model reads it.
 */
export function seemsConfused(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 60) return false;
  const plain = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[?!.,…]+/g, " ").replace(/\s+/g, " ").trim();
  return plain ? CONFUSED.test(plain) : raw.includes("?");
}

/** A sentence as compared with another: case, spacing and the closing mark left out. */
const sentenceKey = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").replace(/[.!?…"”’)]+$/, "").trim();

/**
 * The recorded answer held to the candidate's latest message (Wave S9): a question they asked in it is never part of
 * the answer (that sentence is left out), and a turn that answers their question records only words of that message
 * that are not a question (an answer given in the same message, "Yes, active in CA. What does it pay?"). Null when
 * nothing is left.
 */
function answerAgainstLatest(t: ScreenTurn, latest: string): ScreenTurn["answerRecorded"] {
  const a = t.answerRecorded;
  if (!a) return null;
  const said = sentencesOf(latest);
  const asked = new Set(said.filter(asksAssistant).map(sentenceKey));
  const statements = said.filter((s) => !asksAssistant(s) && !FILLER.test(s)).map(sentenceKey).join(" ");
  const all = sentencesOf(a.answer);
  const kept = all.filter((s) => !asked.has(sentenceKey(s)));
  if (t.candidateAskedAbout && !kept.every((s) => statements.includes(sentenceKey(s)))) return null;
  if (!kept.length) return null;
  return kept.length === all.length ? a : { ...a, answer: kept.join(" ") };
}

/**
 * What the candidate wrote about a question since it was asked, in a chat without a plan (Wave S9): `all` their replies
 * as they sent them, and `usable` without what is never an answer (a reply that only shows confusion or only asks the
 * assistant something, and a question they asked inside a longer reply). Null when the question was never asked.
 */
function answerSince(transcript: ReadonlyArray<ScreenTranscriptEntry>, key: string): { all: string; usable: string } | null {
  if (!transcript.some((t) => t.role === "assistant" && t.questionKey === key)) return null;
  const replies = replyListSince(transcript, key);
  return { all: replies.join(" "), usable: usableReplies(replies).join(" ") };
}

/** Replies without what is never an answer: one that only shows confusion or only asks the assistant something, and a question asked inside a longer one (Wave S9). */
function usableReplies(replies: ReadonlyArray<string>): string[] {
  return replies.filter((r) => !seemsConfused(r) && !onlyQuestions(r)).map((r) => (sentencesOf(r).some(asksAssistant) ? sentencesOf(r).filter((s) => !asksAssistant(s)).join(" ") : r)).filter(Boolean);
}

/**
 * The code's rules for a turn of a Kanvis-style chat, after the model answered (on top of `enforceTurnRules`: known
 * keys, skips, the fairness check). The ladder: how the latest reply reads (a plain "No" climbs the ladder whatever the
 * model read), and what comes next (`chatNextMove`): a follow-up the ladder allows passes, one it does not is replaced
 * by the next question; moving on early is fine (less pressing, never more). When the item settles, the candidate's
 * replies about it are its answer, except a gap settled as not known, which records nothing (never a "no" for a
 * skill). The closing question is followed by the close; a close before the end goes on to what is left. Every message
 * is one restatement and one question (`shapeChatMessage`), and never echoes a private note. Returns the turn and the
 * step taken on the item, for the plan (`advanceProgress`).
 */
export function enforceChatTurn(raw: ScreenTurn, packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>, input: { transcript: ReadonlyArray<ScreenTranscriptEntry>; latest: string | null }): { turn: ScreenTurn; move: { key: string; move: ChatMove } | null } {
  const plan = progress.chat;
  let t = enforceTurnRules(raw, packet, progress, answers, { chat: true, transcript: input.transcript, latest: input.latest });
  if (!plan || t.humanRequested) return { turn: t, move: null };
  const current = progress.currentQuestionKey;
  const item = plan.items.find((i) => i.key === current) ?? null;
  const q = (key: string | null | undefined) => (key ? packet.screening.questions.find((x) => x.key === key) : undefined);
  const lookFor = new Map((packet.companyQuestions?.written ?? []).flatMap((w) => (w.lookFor ? [[w.key, w.lookFor] as const] : [])));
  const declined = new Set(progress.declined ?? []);
  const remaining = packet.screening.questions.filter((x) => x.key !== current && !progress.askedKeys.includes(x.key) && !(x.key in answers) && !declined.has(x.key));
  // A message the code put together here (the model's restatement, then the next question in code's words) is final.
  let composed = false;
  const moveOn = (lead: string, recorded: ScreenTurn["answerRecorded"]): ScreenTurn => {
    const next = remaining[0];
    composed = true;
    return next ? { ...t, questionKey: next.key, followUpReason: null, done: false, answerRecorded: recorded, messageToCandidate: lead ? `${lead}\n\n${next.question}` : next.question } : { ...t, questionKey: null, followUpReason: null, done: true, answerRecorded: recorded, messageToCandidate: lead };
  };
  // A question the candidate asked, or a reply that only shows confusion, is not a reply to the item (Wave S9).
  const replied = input.latest !== null && !t.candidateAskedAbout && t.sentiment !== "confused" && !onlyQuestions(input.latest);
  let move: { key: string; move: ChatMove } | null = null;
  let calm = false;
  let ladderQuestion: string | null = null;

  if (current === CHAT_WRAP_KEY && replied) {
    // The closing question was answered: the close follows, whatever the model wanted to ask next.
    const own = (input.latest ?? "").trim();
    t = { ...t, done: true, questionKey: null, followUpReason: null, answerRecorded: t.answerRecorded ?? (own ? { questionKey: CHAT_WRAP_KEY, answer: own, complete: true } : null) };
  } else if (item && replied) {
    const ladder = ladderApplies(item.kind, q(item.key));
    const modelStays = !!t.followUpReason && !t.questionKey && !t.done;
    const reading = ladder && saysNotDone(input.latest) ? "not_done" : t.reading === "not_done" && !ladder ? "concrete" : (t.reading ?? (modelStays ? "vague" : "concrete"));
    const expected = chatNextMove(item, reading, ladder);
    // Their replies about the item, without a confused reply or a question of their own on the way (Wave S9 review):
    // neither is ever part of the answer, and neither keeps a bare "yes" on the push from reading as one.
    const replies = usableReplies(replyListSince(input.transcript, item.key));
    const said = replies.join(" ");
    const answerFor = (m: ChatMove): ScreenTurn["answerRecorded"] => (m === "unknown" && item.kind === "gap" ? null : t.answerRecorded ?? (said ? { questionKey: item.key, answer: redactProtected(said), complete: m === "covered" } : null));
    if (chatMoveStays(expected) && modelStays) {
      move = { key: item.key, move: expected };
      ladderQuestion = CHAT_LADDER_QUESTION[expected as "push" | "analog" | "smaller"];
      // The item is still being asked (the push, the analog, the smaller version): while their replies are only a bare
      // "yes" or a plain "No" nothing is recorded (Wave S9: the real model recorded a bare "yes" on the push), so neither
      // ever stands as the answer, a "No" never as a "no" for a skill; it settles with every reply as its answer
      // (`answerFor`). Words with something in them are kept as they stand, so "Keep my answer and move on" keeps them (E11).
      t = { ...t, answerRecorded: replies.every(bareReply) ? null : t.answerRecorded ?? { questionKey: item.key, answer: redactProtected(said), complete: false } };
    } else if (chatMoveStays(expected)) {
      // The model moved on early: fine, the item settles as it stands.
      const settled: ChatMove = reading === "not_done" ? "unknown" : "covered";
      move = { key: item.key, move: settled };
      calm = settled === "unknown";
      t = { ...t, answerRecorded: answerFor(settled) };
    } else {
      move = { key: item.key, move: expected };
      calm = expected === "unknown";
      if (modelStays || (!t.questionKey && !t.done)) t = moveOn(chatLead(t.messageToCandidate, { experience: plan.section === "experience", calm, answering: false }), answerFor(expected));
      else t = { ...t, answerRecorded: answerFor(expected) };
    }
    if (move.move === "unknown" && item.kind === "gap" && t.answerRecorded?.questionKey === item.key) t = { ...t, answerRecorded: null };
  }

  // A close before the end goes on to what is left: the plan is the code's (and the model's words saying it was the end are not said).
  if (t.done && current !== CHAT_WRAP_KEY && remaining.length) {
    const next = remaining[0];
    composed = true;
    t = { ...t, done: false, questionKey: next.key, followUpReason: null, messageToCandidate: calm ? `${CHAT_CALM_LINE}\n\n${next.question}` : next.question };
  }
  // A private note is never said, even in part, whichever question it belongs to: the model is given every note.
  const notes = [...lookFor.values()];
  const echoesAny = (text: string) => notes.some((n) => echoesNote(text, n));
  if (t.done) {
    const closing = shapeClosing(t.messageToCandidate) ?? "";
    return { turn: { ...t, messageToCandidate: echoesAny(closing) ? "" : closing }, move };
  }
  const asking = t.questionKey ? q(t.questionKey) : undefined;
  let message = composed ? t.messageToCandidate : shapeChatMessage(t.messageToCandidate, { experience: plan.section === "experience", calm, question: ladderQuestion ?? asking?.question ?? (item ? q(item.key)?.question ?? null : null), answering: !!t.candidateAskedAbout });
  // The question goes back to its own words (the packet's, which never carry a note).
  if (echoesAny(message)) message = shapeChatMessage("", { experience: false, calm, question: asking?.question ?? q(current)?.question ?? CHAT_WRAP_QUESTION, answering: false });
  // A confused candidate gets the question again and the offer of a person (Wave S9), after the one question.
  if (t.sentiment === "confused" && !/\bHUMAN\b/.test(message)) message = `${message}\n\n${CONFUSED_OFFER}`;
  return { turn: { ...t, messageToCandidate: message }, move };
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
  // Before the row exists, the progress `createScreen` will give it, so the opening asks what the chat will (Wave S8).
  const state: ConversationState = input.screen ?? { channel: input.channel, progress: newScreenProgress(input.focusQuestions), answers: {}, transcript: [] };
  const asked = { ...b, packet: chatPacket(b.packet, state.progress) };
  return runPromptDetached(db, ai, screenTurnPrompt, contextOf(asked, state, null), { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { applicationId: input.applicationId, turn: 0 } });
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
  const turn = enforceTurnRules(out.output, chatPacket(input.packet, fresh.progress), fresh.progress, answersOf(fresh), { transcript: fresh.transcript, latest: null });
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
  const { screen, app, company, candidate } = b;
  const opened = screen.transcript.find((t) => t.role === "assistant");
  if (opened) return { ok: true, message: opened.content };
  const now = nowOf(deps).toISOString();
  // Wave S7: the chat offered with the application gets its plan now. Its gaps come from the CV the visit gave, read in
  // code, as a repeat submission's do (`chatFactsFor`; since 21 Oct every form applicant's AI interview too,
  // `visitChatFacts`, which leaves `triageMet` out); one whose link a person sent reads the résumé reading.
  const facts = chatFactsFor(b.chatFacts, screen.progress, screen.invitedVia);
  const triageMet = screen.invitedVia === "apply" ? null : b.triageMet;
  const planned = withChatPlan(b.rolePacket, screen.progress, { channel: screen.channel, at: now, gaps: chatGaps({ packet: b.rolePacket, progress: screen.progress, triageMet, facts, written: writtenQuestionsOf(b.rolePacket).map((w) => w.key) }) });
  const packet = planned.chat ? chatPacket(b.rolePacket, planned) : b.packet;
  const first = nextQuestion(packet, planned, answersOf(screen));
  if (!first) return { ok: false, message: null };
  const content = planned.chat ? chatOpening({ firstName: candidate.firstName, cv: facts?.cv ?? [], question: first.question }) : first.question;
  const entry: ScreenTranscriptEntry = { role: "assistant", content, at: now, questionKey: first.key, channel: screen.channel as ScreenChannel, source: "system" };
  const progress = advanceProgress(planned, { ...SILENT_TURN, messageToCandidate: content, questionKey: first.key });
  await q.update(screens).set({ status: "in_progress", startedAt: screen.startedAt ?? now, lastCandidateMessageAt: now, transcript: [...screen.transcript, entry], progress }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.started", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { channel: screen.channel, via: "start_button" }, correlationId: screen.workflowRunId });
  const [cur] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
  if (cur?.stage === "screen_invited") await transition(q, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:started` });
  return { ok: true, message: content };
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
      title: usedUp ? "This month's AI interviews are used up" : "80% of this month's AI interviews used",
      body: usedUp
        ? `${crossing.used} of ${crossing.limit} used. Applications are still accepted and anyone part-way through finishes. New applicants get the AI interview link by email once more are added, so everyone for a role has the same process. ITS has been told.`
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
  // Kept with the conversation's id: the team sees it only once the conversation's answers are sent (9 October 2026).
  if (said !== null) await recordInbound(q, { companyId: company.id, candidateId: candidate.id, applicationId: app.id, channel: input.channel, text: said, from: input.channel === "sms" ? candidate.phone : null, provider: input.channel === "sms" ? deps.integrations.sms.id : null, providerMessageId: input.providerMessageId ?? null, actor: candidateActor, correlationId: screen.workflowRunId, screenId: screen.id });

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
  if (modelTurnsUsed(transcript) >= modelTurnCap(packet, progress)) {
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
  const kept = input.words === null && answersOf({ answers, progress })[input.key] !== undefined;
  if (input.words === null) {
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
    // The Kanvis-style chat says it in its own shape: one line, then the next question.
    const message = progress.chat ? `${chatCodeLead(input.words, kept)}\n\n${next.question}` : `${lead} Next: ${next.question}`;
    progress = advanceProgress(progress, { ...SILENT_TURN, messageToCandidate: message, questionKey: next.key });
    return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers, progress, message, questionKey: next.key, done: false });
  }
  progress = advanceProgress(progress, { ...SILENT_TURN, done: true });
  const message = `${lead} That is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.`;
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers, progress, message, questionKey: null, done: true, closing: `Thank you, ${candidate.firstName}.` });
}

/**
 * The chat's line before the next question when a skip or a tap moved it on, in code: neutral, never praise. A tap is
 * said back in the assistant's voice (`tapEcho`: "Noted: $18 to $20 an hour.", "Noted: you could start on Monday,
 * November 16, 2026."; 22 Oct 2026 try-out), never in the candidate's own "I'm looking for …". `kept`: the skip ended a
 * follow-up on an answer already given, which stays.
 */
export function chatCodeLead(tapped: string | null, kept = false): string {
  if (tapped !== null) {
    const echo = tapEcho(tapped);
    return echo ? `Noted: ${echo}.` : "Noted.";
  }
  return kept ? "No problem, your answer is kept." : "No problem, we can leave that one.";
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
  await emit(q, { type: "screen.turn_cap_reached", companyId: company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: screen.id }, payload: { modelTurns: modelTurnsUsed(screen.transcript), cap: modelTurnCap(packet, progress), ending: review ? "review" : "closed", channel: input.channel }, correlationId: screen.workflowRunId });
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: screen.transcript, answers: screen.answers, progress, message: TURN_CAP_CLOSE_MESSAGE, reviewMessage: TURN_CAP_REVIEW_MESSAGE, questionKey: null, done: true, closing: CHAT_CAP_CLOSING });
}

/** The Kanvis-style chat's close when it reached `modelTurnCap` (what happens next follows it, `chatClosingMessage`). */
export const CHAT_CAP_CLOSING = "We have covered as much as we can in this chat.";

/**
 * Writes the assistant's reply and the recorded answers, sends it by text on that channel, and settles the end of the
 * questions: a conversation offered with the application goes to "check your answers" (E10), saying `reviewMessage`
 * (REVIEW_MESSAGE unless given); any other closes. A Kanvis-style chat ends on its close (`closing`: one concrete thing
 * from the chat, or a thank-you) and what happens next, and the page offers "Review and send".
 */
async function writeReply(q: Queryable, deps: ScreenDeps, b: ScreenBundle, s: { channel: ScreenChannel; actor: Actor; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress; message: string; questionKey: string | null; done: boolean; aiRunId?: string; reviewMessage?: string; closing?: string | null }): Promise<TurnResult> {
  const { screen, app, candidate, company, packet } = b;
  const review = s.done && isOneVisitFlow(s.progress) && s.channel === "web";
  // A chat that ends off the web (the candidate went on by text) closes with what happens next in the usual words.
  const closedByText = s.done && !!s.progress.chat && s.closing !== undefined;
  const message = review ? (s.progress.chat ? chatClosingMessage(s.closing, company.name) : s.reviewMessage ?? REVIEW_MESSAGE) : closedByText ? `${s.closing ?? ""} ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.`.trim() : s.message;
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
  await notify(q, { companyId: company.id, kind: "candidate.withdrawn", title: `${candidate.firstName} ${candidate.lastName} withdrew`, body: `They withdrew from ${packet.identity.title} during the AI interview, and confirmed it.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
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

  // A Kanvis-style chat is held to its own rules too (Wave S7), and the step it took moves its plan on.
  const enforced = fresh.progress.chat ? enforceChatTurn(out.output, packet, fresh.progress, answersOf(fresh), { transcript: fresh.transcript, latest: input.message }) : { turn: enforceTurnRules(out.output, packet, fresh.progress, answersOf(fresh), { transcript: fresh.transcript, latest: input.message }), move: null };
  let turn = enforced.turn;
  // The model never states a response time; the accurate business-hours expectation is appended in code (founder decision F12).
  if (turn.humanRequested && !/business/i.test(turn.messageToCandidate)) turn = { ...turn, messageToCandidate: `${turn.messageToCandidate} You can expect to hear from a person ${humanResponseExpectation(nowOf(deps), await loadBusinessCalendar(q))}.` };
  const answers = { ...fresh.answers };
  let progress = advanceProgress(fresh.progress, turn, enforced.move);
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
    // One reason for every hand-over the assistant makes in the conversation, whether they asked for a person in their
    // own words or it judged they needed one: either comes from words they have not sent, so the team and the recruiter
    // never learn which, nor how the candidate sounded (9 October 2026). The AI run keeps its own reading.
    await requestHuman(q, deps, { screenId: screen.id, reason: HANDED_TO_A_PERSON, actor: input.actor, reply: null, replyChannel: input.channel, confirmByEmail: fresh.status !== "paused" });
    return { kind: "reply", message: turn.messageToCandidate, done: false, humanRequested: true };
  }
  return writeReply(q, deps, b, { channel: input.channel, actor: input.actor, transcript: fresh.transcript, answers, progress, message: turn.messageToCandidate, questionKey: turn.questionKey, done: turn.done, aiRunId: out.runId, closing: turn.done ? turn.messageToCandidate : null });
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
  await createEscalation(q, { companyId: company.id, roleId: app.roleId, applicationId: app.id, kind: "candidate_issue", summaryOrigin: byCandidate ? "candidate" : "system", summary: byCandidate ? undefined : screeningStoppedSummary(!!app.roleId), question: `${candidate.firstName} ${candidate.lastName} needs a person during the ${packet.identity.title} screening (${input.reason}). Please reach out by ${candidate.phone ? "phone or " : ""}email and finish the screen.`, requestedBy: input.actor, workflowRunId: screen.workflowRunId });
  // Their answers so far were never sent, so neither the team nor the recruiter reads them (9 October 2026): the
  // recruiter calls and adds notes from the call.
  await notify(q, { companyId: company.id, kind: "screen.human_requested", title: `${candidate.firstName} asked for a person`, body: `During the ${packet.identity.title} screening. A recruiter will contact them and add notes from the call. Anything they typed before asking was not sent, so it stays private. You can also reply to them directly.`, action: { label: "Open the candidate", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
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
 * closes as declined, the application goes on to the team as "ready for your review", and the choice is counted. Any
 * answers given so far were never sent, so the team never sees them and nothing is read from them (founder decision of
 * 9 October 2026, "hide them until they send"); the team hears about it once, now, in the same words whatever was
 * answered. Null when the conversation is no longer open.
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
  if (cur && ["screen_invited", "screening"].includes(cur.stage)) await transition(q, { applicationId: app.id, companyId: company.id, to: "triaged", by: "system", actor: input.actor, reason: "sent without the AI interview", correlationId: screen.workflowRunId });
  await notify(q, { companyId: company.id, kind: "screen.declined_by_candidate", title: `${candidate.firstName} ${candidate.lastName} sent their application without the AI interview`, body: `They chose not to do the AI interview for ${packet.identity.title}, which is never held against them. Their application is ready for your review.`, action: { label: "Review", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
  await deps.signal?.(q, { companyId: company.id, key: `screen:${screen.id}:completed`, payload: { declined: true } });
  return { message: msg };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Check your answers (E10)                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The "check your answers" page: every question in order with its answer, and how it came to be. A Kanvis-style chat's
 * page lists its written questions (the company's own, or the job's screening questions), and every other answer the
 * chat recorded and will send (about the CV, and the closing question), so the candidate can check and change all of
 * what goes to the team; an item about the CV settled as not known recorded nothing and is not listed.
 */
export function reviewItems(screen: Pick<ScreenRow, "answers" | "progress">, packet: RolePacket): ReviewItem[] {
  const answers = answersOf(screen);
  const declined = new Set(screen.progress.declined ?? []);
  const edits = screen.progress.edits ?? {};
  const plan = screen.progress.chat;
  const written = new Set((plan?.items ?? []).filter((i) => i.kind === "written").map((i) => i.key));
  const questions = chatPacket(packet, screen.progress).screening.questions.filter((q) => !plan || written.has(q.key) || answers[q.key] !== undefined);
  return questions.map((q) => {
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
  if (b?.screen.status !== "in_progress" || b.screen.progress.phase !== "review") return { ok: false, error: "These answers can no longer be changed." };
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
 * "Send" on the "check your answers" page (E10), pressed by the candidate: the conversation is complete, the team sees
 * the answers from now on, and the team's scorecard follows. Nothing else calls it: answers nobody pressed Send on are
 * never sent for the candidate (founder decision of 9 October 2026; before it, `via: "review_timeout"` sent them after
 * the reminder, and the history still reads such an entry). The row is locked first, so two presses at once complete it
 * once.
 */
export async function submitScreenAnswers(q: Queryable, deps: ScreenDeps, input: { screenId: string; actor: Actor }): Promise<{ ok: boolean }> {
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return { ok: false };
  if (b.screen.status === "completed") return { ok: true };
  if (b.screen.status !== "in_progress" || b.screen.progress.phase !== "review") return { ok: false };
  const progress: ScreenProgress = { ...b.screen.progress, submittedAt: nowOf(deps).toISOString() };
  await q.update(screens).set({ progress }).where(eq(screens.id, b.screen.id));
  await completeScreen(q, deps, { ...b, screen: { ...b.screen, progress } }, { answers: b.screen.answers, progress, channel: b.screen.channel as ScreenChannel, actor: input.actor, via: "review" });
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The rules the model is held to                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The rules the packet sets that the model must not break: one question at a time, two follow-ups at most, a bounded
 * conversation, skipped questions left alone, and every packet question asked in the packet's own words (the model
 * writes the acknowledgment; the question is added here when it did not write it word for word), and no private note
 * said (`withoutPrivateNotes`, Wave S8). `chat` (a Kanvis-style chat, Wave S7): the follow-ups, the end of the questions,
 * the notes and the shape of each message are `enforceChatTurn`'s, and the model asks each item in its own words.
 *
 * Wave S9 (the first real-model run, 15 Oct 2026): what the candidate wrote decides what is recorded, and the code, not
 * the model's labels, decides what kind of turn it is. `latest`: the candidate's message the turn answers (null when the
 * assistant opens the conversation; left out when not known); `transcript`: the conversation with it. A reply that only
 * asks the assistant something or only shows confusion is never an answer, nor is a question asked inside a longer one; a
 * confused candidate gets the question again and the offer of a person; the question being asked, asked again, and any
 * other turn that stays on it and asks something, is a follow-up (so the two-follow-up cap holds whatever the model
 * labelled). Without a plan, also: an acknowledgment that asks nothing moves on, a close before every question was asked
 * goes on to the next, a recorded answer is the candidate's own words, and a question that settles with nothing recorded
 * (the model moved on, the cap, the fairness check) keeps what they said about it.
 */
export function enforceTurnRules(turn: ScreenTurn, packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>, opts: { chat?: boolean; transcript?: ReadonlyArray<ScreenTranscriptEntry>; latest?: string | null } = {}): ScreenTurn {
  const keys = packet.screening.questions.map((q) => q.key);
  const questionOf = (key: string | null | undefined) => (key ? packet.screening.questions.find((x) => x.key === key) : undefined);
  let t: ScreenTurn = { ...turn };
  // How an answer was recorded is the code's to say (E10): the model only ever answers.
  if (t.answerRecorded) t = { ...t, answerRecorded: { questionKey: t.answerRecorded.questionKey, answer: t.answerRecorded.answer, complete: t.answerRecorded.complete } };
  if (t.questionKey && !keys.includes(t.questionKey)) t = { ...t, questionKey: null };
  if (t.answerRecorded && !keys.includes(t.answerRecorded.questionKey)) t = { ...t, answerRecorded: null };
  const declined = new Set(progress.declined ?? []);
  // A skipped question is not asked again.
  if (t.questionKey && declined.has(t.questionKey)) t = { ...t, questionKey: null };
  const asked = new Set(progress.askedKeys);
  const current = progress.currentQuestionKey;
  const reply = typeof opts.latest === "string" ? opts.latest : null;
  // What the candidate wrote decides what is recorded (Wave S9).
  if (reply !== null && t.sentiment !== "distressed" && t.sentiment !== "frustrated" && seemsConfused(reply)) {
    // A first confusion gets help and the offer of a person (founder rule), never a hand-over they did not ask for; one
    // right after another may be handed over (docs/05).
    if (t.humanRequested && progress.confusedTurns < 1 && current) t = { ...t, humanRequested: false, done: false, questionKey: null, messageToCandidate: `No problem. ${questionOf(current)?.question ?? ""}`.trim() };
    if (!t.humanRequested) t = { ...t, sentiment: "confused" };
  }
  if (t.sentiment === "confused" || (reply !== null && onlyQuestions(reply))) t = { ...t, answerRecorded: null };
  else if (reply !== null && t.answerRecorded) t = { ...t, answerRecorded: answerAgainstLatest(t, reply) };
  const remaining = keys.filter((k) => !asked.has(k) && !(k in answers) && !declined.has(k) && k !== t.answerRecorded?.questionKey);
  const stays = () => !t.humanRequested && !t.done && !t.questionKey;
  if (!t.humanRequested && current) {
    if (t.sentiment === "confused") {
      // A confused candidate gets help with the same question, never a move on or a close: a follow-up that asks it again.
      if (t.done || (t.questionKey && t.questionKey !== current)) t = { ...t, done: false, questionKey: null, messageToCandidate: `No problem. ${questionOf(current)?.question ?? ""}`.trim() };
      t = { ...t, questionKey: null, followUpReason: t.followUpReason ?? "the candidate seemed confused" };
    } else if (t.questionKey === current && asked.has(current) && !t.done) {
      // The question being asked, asked again (in other words, or after answering the candidate's own question): not a move.
      t = { ...t, questionKey: null, followUpReason: t.candidateAskedAbout ? t.followUpReason : t.followUpReason ?? "asked again" };
    }
  }
  if (!opts.chat && stays() && t.sentiment !== "confused") {
    // A packet question written out in full is the move to it, even when the model left its key out.
    const named = packet.screening.questions.find((q) => q.key !== current && remaining.includes(q.key) && t.messageToCandidate.includes(q.question));
    if (named) t = { ...t, questionKey: named.key, followUpReason: null };
  }
  // A turn that stays on the question being asked and asks something about it is a follow-up, labelled or not.
  if (reply !== null && current && stays() && !t.followUpReason && !t.candidateAskedAbout && !onlyQuestions(reply) && asksSomething(t.messageToCandidate)) t = { ...t, followUpReason: "asked for more" };
  if (!opts.chat && !t.humanRequested) {
    const next = remaining[0];
    // Whether the question being asked has an answer: the model recorded one on this turn, or on an earlier one.
    const answered = !!current && (t.answerRecorded?.questionKey === current || current in answers);
    if (opts.latest === null && !t.questionKey && !t.done && next) t = { ...t, questionKey: next };
    // An acknowledgment that asks nothing is the move on the model is asked to write (the code adds the next question),
    // once the question has an answer; before that ("One sec, let me check my notes." / "Sure, take your time.") it is
    // the question asked again, never a move on or a close with that line as the answer (Wave S9 review). After the
    // candidate's own question, the question being asked goes back to them instead (below).
    else if (reply !== null && current && stays() && !t.followUpReason && !t.candidateAskedAbout && !onlyQuestions(reply) && !asksSomething(t.messageToCandidate)) t = answered ? (next ? { ...t, questionKey: next } : { ...t, done: true, messageToCandidate: `Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.` }) : { ...t, followUpReason: "asked again" };
    // A close before every question was asked goes on to the next one, as a planned chat's does (`enforceChatTurn`); before
    // the question being asked has an answer, back to it ("I'm no longer interested, thanks" is never its answer).
    if (t.done && next) t = current && !answered ? { ...t, done: false, questionKey: null, followUpReason: "asked again", messageToCandidate: "Thanks." } : { ...t, done: false, questionKey: next, followUpReason: null, messageToCandidate: "Thanks." };
  }
  const isFollowUp = !!t.followUpReason && !t.questionKey && !t.done && !t.humanRequested;
  if (!opts.chat && isFollowUp && current && (progress.followUps[current] ?? 0) >= MAX_FOLLOW_UPS) {
    // Enough follow-ups: move on with the next packet question, or close. What they said is kept (below).
    const next = remaining[0];
    if (next) {
      const q = packet.screening.questions.find((x) => x.key === next)!;
      t = { ...t, messageToCandidate: `${t.sentiment === "confused" ? "No problem." : "Thanks, that helps."} Next: ${q.question}`, questionKey: next, followUpReason: null };
    } else {
      t = { ...t, done: true, followUpReason: null, questionKey: null, messageToCandidate: `Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.` };
    }
  }
  // Every question answered, skipped or asked, and the model asked nothing more: close politely. (How many times a
  // conversation may call the model at all is `modelTurnCap`, checked before each call.)
  const candidateTurns = Object.keys(answers).length + declined.size + (t.answerRecorded ? 1 : 0);
  if (!opts.chat && !t.done && !t.humanRequested && candidateTurns >= keys.length && remaining.length === 0 && !t.questionKey) {
    t = { ...t, done: true, followUpReason: null };
  }
  // The code's fairness check on what the model wrote to the candidate (known bug 29): a follow-up or an acknowledgment
  // that touches a protected trait never reaches them. The packet's own questions passed the check when the job was
  // approved, so only the model's words around them are read. On a hit the conversation moves on as the follow-up cap
  // does: the next question in the packet's words, or the close.
  const modelWords = packet.screening.questions.reduce((s, q) => s.split(q.question).join(" "), t.messageToCandidate);
  if (unfairQuestion(modelWords)) {
    if (t.humanRequested) t = { ...t, messageToCandidate: "Understood. A person from the hiring team will follow up with you.", followUpReason: null };
    else if (t.questionKey && !t.done) t = { ...t, messageToCandidate: "Thanks.", followUpReason: null };
    else {
      const next = t.done ? undefined : remaining[0];
      t = next
        ? { ...t, messageToCandidate: "Thanks.", questionKey: next, followUpReason: null }
        : { ...t, done: true, questionKey: null, followUpReason: null, messageToCandidate: `Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.` };
    }
  }
  // The answers of a chat without a plan are the candidate's own words (Wave S9), as the scorecard and "Your answers"
  // read them. A question that settles (the model moved on or closed, the follow-up cap or the fairness check moved on)
  // is answered by every reply about it since it was asked, word for word and in order, never a question they asked nor
  // a reply that only shows confusion; the model's copy stays only where it left out something personal more finely
  // than the code does. Before that, a copy the model reworded is what they wrote instead.
  const theirs = !opts.chat && opts.transcript && current && !t.humanRequested ? answerSince(opts.transcript, current) : null;
  if (theirs && current) {
    const own = theirs.usable ? redactProtected(theirs.usable) : "";
    const recorded = t.answerRecorded?.questionKey === current ? t.answerRecorded : null;
    const modelsAreTheirs = !!recorded && saidByCandidate(recorded.answer, theirs.all);
    const settles = t.done || (!!t.questionKey && t.questionKey !== current);
    if (settles && own && !(modelsAreTheirs && own !== theirs.usable)) t = { ...t, answerRecorded: { questionKey: current, answer: own, complete: recorded?.complete ?? false } };
    else if (recorded && !modelsAreTheirs) t = { ...t, answerRecorded: own ? { ...recorded, answer: own } : null };
  }
  if (t.answerRecorded && !t.answerRecorded.answer.trim()) t = { ...t, answerRecorded: null };
  // A chat without a plan gives the model each written question's private note as its model answer (Wave S8): the note
  // is never said to the candidate either, even in part, as `enforceChatTurn` holds a planned chat to it.
  if (!opts.chat) t = withoutPrivateNotes(t, packet, current);
  // The packet's question in the packet's own words (plan E2): added after the model's acknowledgment when it is not there.
  // (A Kanvis-style chat asks in the model's words; `enforceChatTurn` adds the item's question only when there is none.)
  if (!opts.chat && t.questionKey && !t.done && !t.humanRequested) {
    const q = packet.screening.questions.find((x) => x.key === t.questionKey)!;
    if (!t.messageToCandidate.includes(q.question)) t = { ...t, messageToCandidate: `${t.messageToCandidate.trim()} ${q.question}`.trim() };
  }
  // Staying on the question (a follow-up, the answer to their own question) with nothing asked: the question again, in its own words.
  const again = !opts.chat && !t.questionKey && !t.done && !t.humanRequested && !asksSomething(t.messageToCandidate) ? questionOf(current) : undefined;
  if (again) t = { ...t, messageToCandidate: `${t.messageToCandidate.trim()} ${again.question}`.trim() };
  // A confused candidate is offered a person (Wave S9; a planned chat adds it after its one question, `enforceChatTurn`).
  if (!opts.chat && t.sentiment === "confused" && !t.done && !t.humanRequested && !/\bHUMAN\b/.test(t.messageToCandidate)) t = { ...t, messageToCandidate: `${t.messageToCandidate.trim()} ${CONFUSED_OFFER}` };
  return t;
}

/**
 * A turn of a chat without a plan, with no private note in it (Wave S8; `echoesNote`, the check a planned chat has). The
 * model's sentences that echo a note are left out; a question in the packet's own words is the company's to ask and is
 * not the model's words. Moving on to a question (the opening by text among them, whose disclosure stays) keeps the rest,
 * or says "Thanks." before the question; a follow-up keeps the rest when it still asks something, or goes back to the
 * question in its own words, as a planned chat's does; a hand-over and a close say the code's words instead, as the
 * fairness check does.
 */
function withoutPrivateNotes(t: ScreenTurn, packet: RolePacket, current: string | null): ScreenTurn {
  const notes = (packet.companyQuestions?.written ?? []).flatMap((w) => (w.lookFor ? [w.lookFor] : []));
  if (!notes.length) return t;
  const modelWords = (text: string) => packet.screening.questions.reduce((s, q) => s.split(q.question).join(" "), text);
  const echoes = (text: string) => notes.some((n) => echoesNote(modelWords(text), n));
  if (!echoes(t.messageToCandidate)) return t;
  if (t.humanRequested) return { ...t, messageToCandidate: "Understood. A person from the hiring team will follow up with you." };
  if (t.done) return { ...t, messageToCandidate: `Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.` };
  // The packet's questions come out whole before the split: a question of several sentences, one of which shares words
  // with its own note, would otherwise lose that sentence and be asked again after what is left of it. Moving on adds
  // the question back below, and a follow-up goes back to it.
  const kept = sentencesOf(modelWords(t.messageToCandidate)).filter((s) => !echoes(s)).join(" ");
  const keeps = !!kept && !echoes(kept);
  if (t.questionKey) return { ...t, messageToCandidate: keeps ? kept : "Thanks." };
  const asking = current ? packet.screening.questions.find((q) => q.key === current)?.question : undefined;
  return { ...t, messageToCandidate: keeps && /\?/.test(kept) ? kept : asking ?? "Thanks." };
}

/**
 * The progress after a turn. A Kanvis-style chat's plan moves on with it (`syncChatPlan`): `move` is the step the turn
 * took on the item it was about (`enforceChatTurn`).
 */
export function advanceProgress(progress: ScreenProgress, turn: ScreenTurn, move?: { key: string; move: ChatMove } | null): ScreenProgress {
  const askedKeys = turn.questionKey && !progress.askedKeys.includes(turn.questionKey) ? [...progress.askedKeys, turn.questionKey] : progress.askedKeys;
  const followUps = { ...progress.followUps };
  if (turn.followUpReason && !turn.questionKey && progress.currentQuestionKey) followUps[progress.currentQuestionKey] = (followUps[progress.currentQuestionKey] ?? 0) + 1;
  const currentQuestionKey = turn.done || turn.humanRequested ? null : turn.questionKey ?? progress.currentQuestionKey;
  return {
    // What the turn does not touch (the flow, skips, edits, the allowance count, a pause) carries over.
    ...progress,
    askedKeys,
    currentQuestionKey,
    followUps,
    confusedTurns: turn.sentiment === "confused" ? progress.confusedTurns + 1 : 0,
    failures: 0,
    ...(progress.chat ? { chat: syncChatPlan(progress.chat, { askedKeys, currentQuestionKey, declined: progress.declined }, move) } : {}),
  };
}

/** A chat's plan after something done in code (a skip, an answer changed): in step with the progress as it is now. */
export function syncedChat(progress: ScreenProgress): ScreenProgress {
  return progress.chat ? { ...progress, chat: syncChatPlan(progress.chat, progress) } : progress;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The scorecard                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What the candidate said, for the quote check: their own messages as they sent them (typed, tapped, or changed on
 * "check your answers"). Never a recruiter's notes, and never the answers as the assistant recorded them: those are the
 * model's words about what was said, which can be a paraphrase (known bug 13), so a quote of one counts only where the
 * candidate's own messages have it (`saidByCandidate`).
 */
export function candidateWordsOf(screen: Pick<ScreenRow, "transcript" | "answers" | "progress">): string {
  return screen.transcript.filter((t) => t.role === "candidate").map((t) => t.content).join("\n");
}

/**
 * Whether a quote is the candidate's own words (`candidateText` from `candidateWordsOf`): found as it is, or, for a whole
 * answer the assistant put together (their words over two messages after a follow-up, or with a personal sentence left
 * out), every sentence of it found in what they sent.
 */
export function saidByCandidate(quote: string, candidateText: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(candidateText);
  const q = norm(quote);
  if (!q || src.includes(q)) return true;
  const sentences = quote.split(/(?<=[.!?])\s+/).map(norm).filter(Boolean);
  return sentences.length > 1 && sentences.every((s) => src.includes(s));
}

/** A recruiter's call notes (E3), checked as their own source. */
export function recruiterNotesOf(screen: Pick<ScreenRow, "transcript">): string {
  return screen.transcript.filter((t) => t.role === "recruiter").map((t) => t.content).join("\n");
}

/**
 * What the scorecard is given (founder decision D-04 = C): the conversation and the recorded answers as the scoring view
 * shows them (the candidate's name, email, phone, street address and links replaced by placeholders, in every line,
 * a recruiter's call notes included), and no first name. The conversation itself (`screen.turn`) still greets the
 * candidate by name: it talks to them. Returns the scoring view too, to map quotes back and count what was hidden.
 */
export function scorecardInput(ctx: ScreenContext, identity: ScoringIdentity): { ctx: ScreenContext; view: ScoringView } {
  // the job's own words are never hidden as a single name (a candidate called Austin keeps "Austin, TX")
  const view = scoringView({ ...identity, keep: [...(identity.keep ?? []), ...jobWords(ctx.packet)] });
  const transcript = ctx.transcript.map((t) => ({ ...t, content: view.text(t.content) }));
  const answers = Object.fromEntries(Object.entries(ctx.answers).map(([k, v]) => [k, view.text(v)]));
  const latestCandidateMessage = ctx.latestCandidateMessage === null ? null : view.text(ctx.latestCandidateMessage);
  // The progress carries the candidate's own answers to the focus questions (screen-focus.ts withFocusAnswer): the same
  // view, so no name, email, phone, street or link reaches the model through it either.
  const progress = ctx.progress.focusQuestions ? { ...ctx.progress, focusQuestions: ctx.progress.focusQuestions.map((f) => (typeof f.answer === "string" ? { ...f, answer: view.text(f.answer) } : f)) } : ctx.progress;
  return { ctx: { ...ctx, candidate: { firstName: PLACEHOLDER.name }, transcript, answers, latestCandidateMessage, progress }, view };
}

/**
 * The scorecard for a screen, called with no transaction open. Quotes are verified against the transcript in code.
 * Only a complete conversation is read ("hide them until they send", founder decision of 9 October 2026): one the
 * candidate did not send (stopped part-way, never pressed Send, sent the application without it) is never read, and its
 * reading is the résumé's. One a
 * recruiter finished from a call is read from the notes alone (`teamScreenView`): whatever the candidate typed before
 * asking for a person was never sent, so the model never sees it and no quote of it passes the check.
 *
 * Read `SCORECARD_READINGS` times side by side, like the résumé (known bugs 20 and 106: one reading overrode the
 * résumé's findings and moved the score run to run), and the middle answer of each finding kept (`scorecardReadings`).
 * A reading lost to an outage is asked once more; one still lost fails the step, which the engine retries. Every run is
 * linked to the one the stored scorecard keeps (`linkReadingRuns`).
 */
export async function assessScreen(db: Db, ai: AiRuntime, input: { companyId: string; screenId: string; workflowRunId?: string | null }): Promise<RunOutcome<ScreenAssessment>> {
  const b = await withTenant(db, input.companyId, (q) => loadScreenBundle(q, input.screenId));
  if (!b) throw new Error("screen not found");
  if (b.screen.status !== "completed") throw new Error(`a conversation the candidate did not send is never read (it is ${b.screen.status})`);
  const screen = teamScreenView(b.screen);
  const { ctx, view } = scorecardInput({ ...contextOf(b, screen, null), incomplete: null }, { firstName: b.candidate.firstName, lastName: b.candidate.lastName, email: b.candidate.email, phone: b.candidate.phone, fullName: b.app.extraction?.fullName ?? null, keep: jobWords(null, b.app.extraction) });
  const read = (reading: number) => runPromptDetached(db, ai, screenAssessPrompt, ctx, { companyId: b.company.id, workflowRunId: input.workflowRunId ?? b.screen.workflowRunId, inputRef: { screenId: b.screen.id, turns: screen.transcript.length, scoringView: SCORING_VIEW_VERSION, hidden: view.counts(), reading } });
  const runs = await Promise.all(Array.from({ length: SCORECARD_READINGS }, (_, i) => read(i + 1)));
  const settled = await Promise.all(runs.map((r, i) => (!r.ok && r.reason === "error" ? read(i + 1) : r)));
  const outage = settled.find((r) => !r.ok && r.reason === "error");
  if (outage) return outage;
  const out = scorecardReadings(settled, view, screen, b.packet);
  await linkReadingRuns(db, b.company.id, out, settled);
  return out;
}

/** How many times a screening chat is read for its scorecard: as many as the résumé (`TRIAGE_READINGS`). */
export const SCORECARD_READINGS = TRIAGE_READINGS;

/** The role as the scorecard's checks read it: its must-haves and skills, and its screening questions when given. */
type ScorecardPacket = Pick<RolePacket, "requirements" | "competencies"> & Partial<Pick<RolePacket, "screening">>;

/**
 * The scorecard readings as the team sees them: each through `scorecardOutcome` (quotes mapped back and checked, the
 * licence rule, skills read only from answers about them), then the middle answer of each finding (`combineReadings`),
 * with the words, answers, pay, availability and recommendation of the reading closest to it. Fewer than three usable
 * readings: the first, saying so. With the `packet`, an interview or a strong one is then settled from those findings in
 * code (`settledScreenRecommendation`); `incomplete`: a conversation that was not finished, never a strong interview.
 */
export function scorecardReadings(readings: ReadonlyArray<RunOutcome<ScreenAssessment>>, view: Pick<ScoringView, "restore">, screen: Pick<ScreenRow, "transcript" | "answers" | "progress">, packet?: ScorecardPacket | null, opts: { incomplete?: boolean } = {}): RunOutcome<ScreenAssessment> {
  const checked = readings.map((r) => (r.ok ? { ...r, output: scorecardOutcome(r.output, view, screen, packet) } : r));
  const out = combineRunOutcomes(checked, (r) => r, "this AI interview", SCORECARD_READINGS);
  if (!out.ok || !packet) return out;
  return { ...out, output: withSettledRecommendation(out.output, checked.flatMap((r) => (r.ok ? [r.output] : [])), packet, opts) };
}

/**
 * The scorecard as the team sees it, from the model's answer. Quotes are checked against the candidate's ORIGINAL words:
 * one written around a placeholder is mapped back first; and the model's own words (summary, claims) keep no
 * placeholder: "[name]" reads "the candidate". With the `packet`, the licence rule holds for its credential must-haves
 * (`credentialFinding`), skills checked in the interviews only are left out, and with its screening questions a skill the
 * chat never asked about is not read from the answers to its other questions (`withAskedSkills`). Shared with the
 * fairness evals (packages/evals), so they check exactly what the app does after the model has answered.
 */
export function scorecardOutcome(output: ScreenAssessment, view: Pick<ScoringView, "restore">, screen: Pick<ScreenRow, "transcript" | "answers" | "progress">, packet?: ScorecardPacket | null): ScreenAssessment {
  const candidateText = candidateWordsOf(screen);
  const recruiterNotes = recruiterNotesOf(screen);
  const restored = withoutPlaceholders(restoreQuotes(output, view, (source) => (source === "recruiter_note" ? [recruiterNotes, candidateText] : [candidateText, recruiterNotes])));
  const verified = verifyScreenQuotes(packet ? withoutInterviewSkills(restored, packet) : restored, candidateText, { recruiterNotes, declined: screen.progress.declined ?? [], answered: Object.keys(answersOf(screen)), transcript: screen.transcript, ...(packet ? { credentials: credentialMustHaves(packet), subjects: findingSubjects(packet) } : {}) });
  const checked = packet?.screening ? withAskedSkills(verified, packet.screening.questions, screen.transcript, new Set(packet.competencies.map((c) => c.key))) : verified;
  // "incomplete_screen" marks a reading of a conversation nobody sent, written before 9 October 2026, which stays hidden
  // (`isUnsentConversationReading` in @ros/core): never on a reading of a sent one, whatever the model wrote.
  return { ...checked, anomalies: checked.anomalies.filter((a) => a.kind !== "incomplete_screen") };
}

/**
 * The scorecard's evidence rules (plan 0.9): every quote must be the candidate's own words from the transcript or the
 * recorded answers. Strengths, concerns, competency and must-have findings go through the same rules as a résumé
 * reading (`applyEvidenceRules`: drop or strip, "no" only on a verified quote, "no quote" marks, confidence step-down);
 * answer findings and eligibility confirmations lose a quote that is not there. A recruiter's call notes (E3) are their
 * own source, `recruiter_note`: checked against the notes, never taken as the candidate's words, never a must-have
 * "no". A question the candidate skipped (E11) is unknown, whatever the model wrote, unless it has an answer on record
 * (`answered`: given before the skip, or added on "check your answers"), whose words are kept. `credentials`: the
 * must-haves the licence rule holds to (`credentialFinding`), as in the résumé reading, read from the whole message a
 * quote sits in. With the `transcript` and the findings' `subjects`, a short answer ("Yes", "No, I don't") that is the
 * whole of a message is read with the closed question it replies to, when that question is about the finding
 * (`screenAnswerOf`): "Yes" to "Do you hold a California RDH license?" is evidence, and a bare "No" to it says plainly
 * the licence is not held. A credential the candidate answered only that way is settled from their answer in code,
 * whatever the model wrote, and added when it left the credential out (`plainCredentialAnswers`, Wave S9).
 */
export function verifyScreenQuotes(a: ScreenAssessment, candidateText: string, opts: { recruiterNotes?: string; declined?: string[]; answered?: string[]; credentials?: ReadonlySet<string>; transcript?: ReadonlyArray<Pick<ScreenTranscriptEntry, "role" | "content"> & Partial<Pick<ScreenTranscriptEntry, "questionKey">>>; subjects?: ReadonlyMap<string, string> } = {}): ScreenAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const notes = norm(opts.recruiterNotes ?? "");
  const answered = new Set(opts.answered ?? []);
  const declined = new Set((opts.declined ?? []).filter((k) => !answered.has(k)));
  const ok = (quote?: string, source?: string) => !quote?.trim() || (source === "recruiter_note" ? !!notes && notes.includes(norm(quote)) : saidByCandidate(quote, candidateText));
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
  const transcript = opts.transcript ?? [];
  const evidenced = applyEvidenceRules({ ...a, questionFindings, eligibilityConfirmations }, (e) => (e.source === "recruiter_note" ? (notes?.includes(norm(e.quote ?? "")) ? null : false) : saidByCandidate(e.quote ?? "", candidateText)), {
    credentials: opts.credentials,
    ...(opts.subjects ? { subjects: opts.subjects } : {}),
    lineOf: (e) => sentenceAround(e.quote ?? "", candidateText),
    answerOf: (e, subject) => screenAnswerOf(e.quote ?? "", subject, transcript),
  });
  const checked = opts.credentials && opts.subjects ? withPlainCredentialAnswers(evidenced, plainCredentialAnswers(transcript, opts.credentials, opts.subjects)) : evidenced;
  if (!stripped) return checked;
  return { ...checked, anomalies: [...checked.anomalies, { kind: "unverified_quote", detail: `${stripped} answer quote${stripped === 1 ? "" : "s"} not found in the transcript; discarded` }] };
}

/** Words too common to say what a question is about ("Do you have experience with...?"). */
const PLAIN_WORDS = new Set(["the", "and", "you", "your", "are", "have", "has", "had", "with", "for", "any", "this", "that", "what", "how", "did", "does", "can", "will", "would", "about", "from", "years", "year", "experience", "work", "working", "able", "ability", "skills", "skill", "knowledge"]);
const topicWords = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !PLAIN_WORDS.has(w));
/** What a finding or a question is about, for the scorecard: `topicWords`, with "licence" and "license" one word (a packet may spell it either way). */
const findingWords = (s: string): string[] => topicWords(s.replace(/licen[cs]/gi, "licens"));

/**
 * A short quote read with the question it answers (`answerInContext`), for the evidence rules: only when the quote is
 * the whole of one of the candidate's messages, and the assistant's question just before it shares a word with what the
 * finding is about (`subject`), so a "Yes" to "Can you work Saturdays?" is never read as a "yes" to a licence. Where
 * the same answer replied to several such questions, the one closest to the subject (then the latest). Else null.
 */
export function screenAnswerOf(quote: string, subject: string | null, transcript: ReadonlyArray<Pick<ScreenTranscriptEntry, "role" | "content">>): string | null {
  if (!subject) return null;
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'’ ]+/gu, " ").replace(/\s+/g, " ").trim();
  const q = plain(quote);
  const about = new Set(findingWords(subject));
  if (!q || !about.size) return null;
  let best: string | null = null;
  let bestShared = 0;
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i]!;
    if (t.role !== "candidate" || plain(t.content) !== q) continue;
    let j = i - 1;
    while (j >= 0 && transcript[j]!.role !== "assistant") j -= 1;
    if (j < 0) continue;
    const question = transcript[j]!.content;
    const shared = new Set(findingWords(question).filter((w) => about.has(w))).size;
    const read = shared > 0 ? answerInContext(question, t.content) : null;
    if (read && shared >= bestShared) {
      best = read;
      bestShared = shared;
    }
  }
  return best;
}

type MustHaveMet = ScreenAssessment["requirementFindings"][number]["met"];
type ChatLine = Pick<ScreenTranscriptEntry, "role" | "content"> & Partial<Pick<ScreenTranscriptEntry, "questionKey">>;

/** Words that say a credential is held, but not which one: in "Active CA RDH license" only "rdh" says which. */
const CREDENTIAL_GENERIC = new Set(["hold", "holds", "held", "active", "current", "currently", "valid", "state", "must", "license", "licenses", "licensed", "licensure", "certificate", "certificates", "certification", "certified", "registration", "registered", "permit", "permits", "credential", "credentials"]);
/** The kinds of credential a line names (licence, certificate, permit, registration), spelling aside. */
const credentialKinds = (s: string): Set<string> => new Set((s.toLowerCase().match(/licen[cs]|certif|permit|regist|credential/g) ?? []).map((k) => k.replace("licenc", "licens")));
/** The words of a line that say which credential it is about. */
const credentialWords = (s: string): Set<string> => new Set(findingWords(s).filter((w) => !CREDENTIAL_GENERIC.has(w)));
/** Words naming an everyday licence or permit that is not a job's professional one: driving, a forklift, food or alcohol service, a firearm, security work. */
const OTHER_CREDENTIAL = /\b(?:driv(?:e|er|ers|ing)|vehicle|car|truck|forklift|cdl|commercial|food|handler|alcohol|liquor|firearms?|gun|security)\b/i;

/**
 * The credential must-have an assistant's question is most about: the one sharing the most words that say which
 * credential it is (never only "license" or "active"), and never one of another kind (a question about a licence is
 * never about a permit). When it shares no such word with any, the only must-have of the kind it names ("Do you hold a
 * California RDH license?" and "Active CA dental hygienist license": the only licence). Null when none fits, or two fit
 * as well.
 */
function credentialAsked(question: string, keys: readonly string[], subjects: ReadonlyMap<string, string>): string | null {
  const words = credentialWords(question);
  const kinds = credentialKinds(question);
  const sameKind = (key: string) => [...credentialKinds(subjects.get(key) ?? "")].some((k) => kinds.has(k));
  let best: string | null = null;
  let bestShared = 0;
  let tie = false;
  for (const key of keys) {
    if (kinds.size && credentialKinds(subjects.get(key) ?? "").size && !sameKind(key)) continue;
    const shared = [...credentialWords(subjects.get(key) ?? "")].filter((w) => words.has(w)).length;
    if (shared > bestShared) {
      best = key;
      bestShared = shared;
      tie = false;
    } else if (shared > 0 && shared === bestShared) tie = true;
  }
  if (tie) return null;
  if (best) return best;
  // A question about an everyday credential of another kind ("Do you have a valid driver's license?") is never about
  // the only licence the job needs (Wave S9 review): one that is itself a driver's licence matched above, by its words.
  const ofKind = kinds.size && !OTHER_CREDENTIAL.test(question) ? keys.filter(sameKind) : [];
  return ofKind.length === 1 ? ofKind[0]! : null;
}

/**
 * A whole plain yes or no and nothing more ("Yes", "Yes, I do.", "No, I don't", "I do"). Anything with another word in
 * it ("Yes, lapsed", "No, pending", "Yes, in Nevada") is the model's to read, so the licence rule reads those words
 * (Wave S9 review: a short reply was taken as plain, and its other word was lost).
 */
const PLAIN_YES_NO = /^(?:(?:yes|yeah|yep|yup|correct)(?:[,.!]*\s*i (?:do|have|am|hold))?|(?:no|nope)(?:[,.!]*\s*(?:i (?:do not|don't|have not|haven't|am not)|i'm not))?|i (?:do|have|am|hold|do not|don't|have not|haven't|am not)|i'm not)[.!]*$/i;

/** Whether a candidate's line speaks of a credential: its kind, or a word that says which one. */
function mentionsCredential(line: string, subject: string): boolean {
  const kinds = credentialKinds(subject);
  const words = credentialWords(subject);
  return [...credentialKinds(line)].some((k) => kinds.has(k)) || [...credentialWords(line)].some((w) => words.has(w));
}

/**
 * Wave S9 (the first real-model run of the scorecard, 15 Oct 2026): the credential must-haves the candidate answered
 * with a plain yes or no to the assistant's closed question about it ("Do you hold ...?", "Are you licensed ...?") and
 * nothing more, read in code whatever each reading wrote, so the same chat always gives the same finding (the founder's
 * licence rule, spec-s5): a plain "Yes" is "yes", a plain "No" says plainly it is not held, "no" (a "No" to "Do you have
 * an active ...?" is unclear: "unknown"), with their message as the quote. The real model read a bare "Yes" to the
 * licence question as "unknown" (a lone "yes" is not a quote, its prompt said). Left to the model when, while that
 * question was asked (until the assistant moves on to another of the packet's questions, or wherever they changed that
 * answer), they said anything more than questions or confusion; when their plain answers disagree; or when anything they
 * said elsewhere about the credential is lapsed or pending, or goes against their answer. A question settles only the
 * credential it is most about (`credentialAsked`), so a "Yes" to the licence question never settles a permit too.
 */
export function plainCredentialAnswers(transcript: ReadonlyArray<ChatLine>, credentials: ReadonlySet<string>, subjects: ReadonlyMap<string, string>): Map<string, { met: MustHaveMet; quote: string }> {
  const keys = [...credentials].filter((k) => !!subjects.get(k)).sort();
  const out = new Map<string, { met: MustHaveMet; quote: string }>();
  for (const key of keys) {
    const subject = subjects.get(key) ?? "";
    const plain: Array<{ quote: string; held: boolean; statement: string }> = [];
    /** Anything else they said while it was asked: the model reads it, with its quote checked. */
    const more: string[] = [];
    const seen = new Set<number>();
    const askedAs = new Map<string, string>();
    const read = (t: ChatLine, j: number, question: string) => {
      if (seen.has(j)) return;
      seen.add(j);
      if (onlyQuestions(t.content) || seemsConfused(t.content)) return;
      const closed = PLAIN_YES_NO.test(t.content.trim().replace(/[’‘]/g, "'")) && credentialAsked(question, keys, subjects) === key ? closedAnswer(question, t.content) : null;
      if (closed) plain.push({ quote: t.content.trim(), ...closed });
      else more.push(t.content);
    };
    for (let i = 0; i < transcript.length; i++) {
      const asked = transcript[i]!;
      if (asked.role !== "assistant" || credentialAsked(asked.content, keys, subjects) !== key) continue;
      if (asked.questionKey) askedAs.set(asked.questionKey, asked.content);
      // every reply while it was asked: a reply goes with the assistant's message just before it
      let question = asked.content;
      for (let j = i + 1; j < transcript.length; j++) {
        const t = transcript[j]!;
        if (t.role === "assistant") {
          if (t.questionKey && t.questionKey !== asked.questionKey) break;
          question = t.content;
        } else if (t.role === "candidate") read(t, j, question);
      }
    }
    // an answer to it given or changed later (a tap, or a change on "check your answers") names the question it answers
    for (let j = 0; j < transcript.length; j++) {
      const t = transcript[j]!;
      const question = t.role === "candidate" && t.questionKey ? askedAs.get(t.questionKey) : undefined;
      if (question !== undefined) read(t, j, question);
    }
    if (more.length || !plain.length || plain.some((p) => p.held !== plain[0]!.held)) continue;
    const held = plain[0]!.held;
    const answers = new Set(plain.map((p) => p.quote));
    const elsewhere = transcript.filter((t) => t.role === "candidate" && !answers.has(t.content.trim()) && mentionsCredential(t.content, subject));
    if (elsewhere.some((t) => shownNotHeld(t.content, subject) || (held ? plainlyNotHeld(t.content, subject) : !plainlyNotHeld(t.content, subject)))) continue;
    const last = plain.at(-1)!;
    out.set(key, { met: credentialFinding(held ? "yes" : "no", last.statement, subject), quote: last.quote });
  }
  return out;
}

/**
 * A reading with the credentials the candidate answered plainly (`plainCredentialAnswers`) settled from their answer: the
 * finding's answer with their message as its quote, added where the reading left it out, and the reasons say so. A
 * finding that already says the same with a quote of theirs is kept as written.
 */
function withPlainCredentialAnswers(a: ScreenAssessment, plain: ReadonlyMap<string, { met: MustHaveMet; quote: string }>): ScreenAssessment {
  if (!plain.size) return a;
  let settled = 0;
  const finding = (key: string, p: { met: MustHaveMet; quote: string }): ScreenAssessment["requirementFindings"][number] => ({ requirementKey: key, met: p.met, evidence: { source: "screen", quote: p.quote } });
  const requirementFindings = a.requirementFindings.map((f): ScreenAssessment["requirementFindings"][number] => {
    const p = plain.get(f.requirementKey);
    if (!p || (f.met === p.met && f.evidence?.source === "screen" && f.evidence.quote && !f.evidence.unquoted)) return f;
    settled += 1;
    return finding(f.requirementKey, p);
  });
  for (const [key, p] of plain) {
    if (a.requirementFindings.some((f) => f.requirementKey === key)) continue;
    settled += 1;
    requirementFindings.push(finding(key, p));
  }
  if (!settled) return a;
  const reasons = [...(a.confidenceReasons ?? []), `${settled === 1 ? "a licence or certificate is" : `${settled} licences or certificates are`} read from the candidate's plain yes or no to the question about it`];
  return { ...a, requirementFindings, confidenceReasons: reasons.slice(-6) };
}

/** Kinds of screening question about pay, the schedule or eligibility: their answers are logistics, never a skill shown. */
const LOGISTICS_KINDS: ReadonlySet<string> = new Set(["compensation", "availability", "eligibility", "logistics"]);
/** What a skill's finding says when its only words answered another question (`withAskedSkills`). */
export const NOT_ASKED_NOTE = "Not asked about in this chat: the words quoted for it answered another question, and are read for that question.";

/**
 * Each answer is read for the question it answers (Wave S9 round 3, real-model run 38784488452). A skill that no question
 * asked in this chat is about (one the packet lists with it, other than a question about pay, the schedule or
 * eligibility) is never read from the answers to questions about another skill, nor from answers about pay, the schedule
 * or eligibility: a finding whose quote is found only there is "not evidenced", and its note says why. The same chat
 * read twice gave reliability "partly evidenced" three readings out of three, then "not evidenced" three out of three,
 * from "when I run behind I tell the front desk", the answer to the question about efficiency: a skill nobody asked
 * about was scored on another question's answer half the time. Reading it that way goes beyond what the candidate was
 * asked (no inference), and a borrowed "partly" would also replace the résumé's checked finding in the match score.
 * Left as the model read it: a skill a question was asked about, a finding quoting nothing or a recruiter's notes, and
 * a quote found in none of the candidate's messages. A reply goes with the question it names, or else with the last
 * question the assistant asked (a follow-up stays on its question). With `skills` (the role's skill keys), a question
 * naming a skill the role does not have (a job draft can rename its skills) is about no skill.
 */
export function withAskedSkills(a: ScreenAssessment, questions: ReadonlyArray<Pick<ScreeningQuestion, "key" | "kind" | "competencyKey">>, transcript: ReadonlyArray<ChatLine>, skills?: ReadonlySet<string>): ScreenAssessment {
  type Question = (typeof questions)[number];
  const byKey = new Map<string, Question>(questions.map((q) => [q.key, q]));
  const skillOf = (q: Question | undefined) => (q?.competencyKey && (!skills || skills.has(q.competencyKey)) ? q.competencyKey : null);
  const asked = new Set<string>();
  const replies: Array<{ text: string; question: Question | undefined }> = [];
  let current: string | undefined;
  for (const t of transcript) {
    if (t.role === "assistant" && t.questionKey) {
      current = t.questionKey;
      const q = byKey.get(t.questionKey);
      const skill = skillOf(q);
      if (q && skill && !LOGISTICS_KINDS.has(q.kind)) asked.add(skill);
    } else if (t.role === "candidate") replies.push({ text: t.content, question: byKey.get(t.questionKey ?? current ?? "") });
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const another = (q: Question | undefined, skill: string) => !!q && (LOGISTICS_KINDS.has(q.kind) || (skillOf(q) ?? skill) !== skill);
  let changed = 0;
  const competencyFindings = a.competencyFindings.map((f): ScreenAssessment["competencyFindings"][number] => {
    const quote = f.evidence?.source === "screen" ? (f.evidence.quote ?? "") : "";
    if (!norm(quote) || asked.has(f.competencyKey)) return f;
    // the messages holding the quote, or a sentence of one the reading put together from several (its full stop aside)
    const parts = [quote, ...quote.split(/(?<=[.!?])\s+/)].map((s) => norm(s).replace(/[.!?…]+$/, "")).filter(Boolean);
    const from = replies.filter((r) => parts.some((p) => norm(r.text).includes(p)));
    if (!from.length || !from.every((r) => another(r.question, f.competencyKey))) return f;
    changed += 1;
    return { competencyKey: f.competencyKey, finding: "not_evidenced", note: NOT_ASKED_NOTE };
  });
  return changed ? { ...a, competencyFindings } : a;
}

const shownByQuote = (e: { quote?: string; unquoted?: boolean } | undefined) => !!e?.quote?.trim() && !e.unquoted;

/**
 * The recommendation between an interview and a strong one, worked out in code from the scorecard's settled findings by
 * the prompt's own rule (Wave S9 round 3), so it moves only when a finding moves, as the résumé reading's has since Wave
 * S7: the same chat read twice was "strong_interview" in one read and "interview" in the other. "strong_interview" when
 * every must-have the chat was to confirm is "yes" with a checked quote, none is shown not met, more than half of the
 * skills it reads are evidenced with a checked quote, something is shown at all, the pay asked is not above the range
 * and the availability fits the schedule; otherwise "interview". Never "strong_interview" for a conversation that was
 * not finished (`incomplete`). "hold" and "decline_recommended" are the readings' own: a person decides either way.
 */
export function settledScreenRecommendation(reading: ScreenAssessment, packet: Pick<RolePacket, "requirements" | "competencies">, opts: { incomplete?: boolean } = {}): ScreenAssessment["recommendation"] {
  if (reading.recommendation !== "strong_interview" && reading.recommendation !== "interview") return reading.recommendation;
  if (opts.incomplete) return "interview";
  const screened = packet.requirements.mustHaves.filter((m) => m.evidencedBy.includes("screen"));
  const musts = screened.every((m) => reading.requirementFindings.some((f) => f.requirementKey === m.key && f.met === "yes" && shownByQuote(f.evidence)));
  const notMet = reading.requirementFindings.some((f) => f.met === "no" && shownByQuote(f.evidence));
  const skills = packet.competencies.filter(scoredSkill);
  const shown = skills.filter((c) => reading.competencyFindings.some((f) => f.competencyKey === c.key && f.finding === "evidenced" && shownByQuote(f.evidence))).length;
  const most = shown * 2 > skills.length;
  const fits = reading.compensationExpectation.withinRange !== "above" && reading.availability.matchesSchedule !== "no" && reading.availability.matchesSchedule !== "partially";
  return musts && !notMet && (skills.length === 0 || most) && (screened.length > 0 || shown > 0) && fits ? "strong_interview" : "interview";
}

/**
 * The combined scorecard with its settled recommendation (`settledScreenRecommendation`). When that is not what the kept
 * reading recommended, its words (summary, rationale, strengths, concerns, answers, pay and availability) come from the
 * reading that recommended it and agrees most with the settled findings, so the words never argue with the label; the
 * findings, the overall reading and the confidence stay the combined ones. With fewer readings than asked for, or none
 * that recommended it, only the label changes.
 */
function withSettledRecommendation(kept: ScreenAssessment, readings: readonly ScreenAssessment[], packet: Pick<RolePacket, "requirements" | "competencies">, opts: { incomplete?: boolean }): ScreenAssessment {
  const recommendation = settledScreenRecommendation(kept, packet, opts);
  if (recommendation === kept.recommendation) return kept;
  const agreement = (r: ScreenAssessment) => (r.overall === kept.overall ? 1000 : 0) + kept.requirementFindings.filter((k) => r.requirementFindings.some((f) => f.requirementKey === k.requirementKey && f.met === k.met)).length * 10 + kept.competencyFindings.filter((k) => r.competencyFindings.some((f) => f.competencyKey === k.competencyKey && f.finding === k.finding)).length;
  const words = readings.length >= SCORECARD_READINGS ? readings.filter((r) => r.recommendation === recommendation).sort((x, y) => agreement(y) - agreement(x) || JSON.stringify(x).localeCompare(JSON.stringify(y)))[0] : undefined;
  return { ...(words ?? kept), overall: kept.overall, confidence: kept.confidence, requirementFindings: kept.requirementFindings, competencyFindings: kept.competencyFindings, recommendation };
}

/** The most recent screen for an application, if any. */
export async function latestScreen(q: Queryable, applicationId: string): Promise<ScreenRow | null> {
  const rows = await q.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  return rows[0] ?? null;
}
