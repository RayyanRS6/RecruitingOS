import { and, desc, eq, inArray } from "drizzle-orm";
import { CHAT_SECTION_LABEL, CHAT_WRAP_KEY, CHAT_WRAP_QUESTION, SCREEN_ACTIVE_STATUSES, TEXT_SCREENS, appPaths, hasCheckedQuote, readStoredPacket, requirementFinding, type Actor, type ChatItem, type ChatPlan, type EvidenceAssessment, type ReviewItem, type RolePacket, type ScreenAssessment, type ScreeningQuestion, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn, type TapAnswer, type TapFormat } from "@ros/contracts";
import { outOfCredit, runPromptDetached, runPromptsDetached, screenAssessPrompt, screenTurnPrompt, type AiRuntime, type ChatPromptContext, type RunMeta, type RunOutcome, type ScorecardContext, type ScreenContext } from "@ros/ai";
import { REACH_A_PERSON_LINE, buildChatPlan, chatMoveStays, chatNextMove, emit, entitlements, errorForLog, formAnswerSentences, formAnswersOf, jobNoticesFor, noticesFor, notify, payShown, saysNotDone, screenAnswersSent, syncChatPlan, tapAnswerText, tapEcho, tapFormatFor, transition, type ChatMove } from "@ros/core";
import { applications, assessments, candidates, companies, randomToken, rolePackets, roles, screens, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import { resumeAsWeWriteIt } from "./assistant-words";
import type { Integrations } from "@ros/integrations";
import { unfairQuestion } from "./fair-question";
import { SCORING_VIEW_VERSION, restoreQuotes, scoringView, withoutPlaceholders, type ScoringView } from "./scoring-view";
import { TRIAGE_READINGS, checkedClaims, credentialFinding, jobWords, linkReadingRuns, middle, namesCredential, sentenceAround } from "./triage";

/**
 * The AI interview ("screen" in code): a web chat a shortlisted candidate does from an emailed link. This file is the
 * chat itself and its scorecard; the durable `screen` workflow owns the invitation, the reminder and the closing of the
 * link.
 *
 * One engine. The plan (`ScreenProgress.chat`) is fixed in code when the candidate presses Start: the job's interview
 * questions, then up to four must-haves the stored CV reading did not find shown, then one closing question. The model
 * reads each reply and writes the words; the code holds every turn to the rules (`enforceChatTurn`), keeps where the chat
 * stands (`screens.progress`), and answers a skip, a tapped answer and the keyword commands without the model. After the
 * last question the candidate checks their own answers, may change any, and presses "Send my answers": nothing reaches
 * the hiring team before that press, and nothing at all when they never press it.
 *
 * Every model call happens with no database transaction open: a turn is a short transaction that records what the
 * candidate said, the model call, and a second short transaction that records the reply.
 */

export type ScreenDeps = {
  ai: AiRuntime;
  integrations: Integrations;
  appBaseUrl: string;
  /** Wakes the interview's `screen` workflow run (`screen:<id>:changed`): the answers were sent, or the candidate chose not to do it. */
  signal: (q: Queryable, input: { companyId: string; key: string }) => Promise<unknown>;
  /**
   * Withdraws the application, in the same transaction, once the candidate confirmed it inside the chat: the stage, the
   * update to the team and the closing of whatever is still open are the app's, the same as from the status page.
   */
  withdraw: (q: Queryable, input: { companyId: string; applicationId: string; actor: Actor }) => Promise<unknown>;
  /** The time the chat's own stamps are written in: the workflow engine's clock, so the run that reminds and closes reads the same time. */
  clock?: () => Date;
};

function nowOf(deps: Pick<ScreenDeps, "clock">): Date {
  return deps.clock?.() ?? new Date();
}

export type ScreenRow = typeof screens.$inferSelect;
type ApplicationRow = typeof applications.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

const ACTIVE_STATUSES = new Set<string>(SCREEN_ACTIVE_STATUSES);
export const EMPTY_SCREEN_PROGRESS: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };

/** The key of the signal that wakes an interview's workflow run. */
export function screenSignalKey(screenId: string): string {
  return `screen:${screenId}:changed`;
}

/** What the chat answers once the candidate is checking their answers: changes go through that page's own forms. */
export const REVIEW_MESSAGE = "That is every question. Check your answers below: you can change any of them. When they look right, press Send my answers.";
/** The transcript's notes of "Skip this question": a question skipped with no answer, and a skip pressed during a follow-up to an answer already given, which moves on and keeps that answer. */
export const SKIPPED_MESSAGE = "Skipped this question.";
export const MOVED_ON_MESSAGE = "Moved on to the next question; the answer given is kept.";
/** What a turn says when the model could not be reached: nothing was recorded, and the candidate sends it again. */
export const TURN_FAILED_MESSAGE = "Sorry, that did not go through. Please send it again.";
/** The chat's close when it reached `modelTurnCap` (what happens next follows it, `chatClosingMessage`). */
export const CHAT_CAP_CLOSING = "We have covered as much as we can in this chat.";
/** What the chat offers a confused candidate after the question, and anyone who asks for a person: the choice is theirs to make on the page. */
export const PERSON_OFFER = "If you would rather talk to a person than do this interview, choose \"I'd rather talk to a person\" on this page.";
/** What the chat answers someone who asks for a person: how to choose one, and that they may carry on instead. Nothing closes. */
export const PERSON_REPLY = `No problem. ${PERSON_OFFER} To carry on here instead, just send your answer.`;

/**
 * How many replies the model has written in this chat. Each call that worked writes exactly one, carrying its run; a
 * reply worked out in code (the first question, a skip, a tap, a command) carries none, and a call that failed writes none.
 */
export function modelTurnsUsed(transcript: readonly ScreenTranscriptEntry[]): number {
  return transcript.filter((t) => t.role === "assistant" && !!t.aiRunId).length;
}

/**
 * The most model calls one chat may make: for every question four replies (the ask, one push, the analog, the smaller
 * version), plus five for the candidate's own questions. `packet` is the chat's own (`chatPacket`). A candidate
 * answering normally stays well under it; a chat that only ever talks never reaches the end of the questions, so without
 * a cap it would call the model for as long as the link lasts.
 */
export function modelTurnCap(packet: Pick<RolePacket, "screening">): number {
  return 4 * packet.screening.questions.length + 5;
}

/**
 * A new AI interview for an application: its link is open until `expiresAt`. `packetVersion`: the job's version at this
 * moment, which the interview asks about to its end, whatever is edited later. One open interview per application: an
 * open one is returned as it is, with the version it was made with.
 */
export async function createScreen(q: Queryable, input: { companyId: string; applicationId: string; packetVersion: number; workflowRunId?: string | null; expiresAt: string; now: Date }): Promise<ScreenRow> {
  const [open] = await q.select().from(screens).where(and(eq(screens.applicationId, input.applicationId), inArray(screens.status, [...SCREEN_ACTIVE_STATUSES]))).limit(1);
  if (open) return open;
  const [row] = await q
    .insert(screens)
    .values({ companyId: input.companyId, applicationId: input.applicationId, packetVersion: input.packetVersion, status: "invited", token: randomToken(24), invitedAt: input.now.toISOString(), expiresAt: input.expiresAt, workflowRunId: input.workflowRunId ?? null, progress: EMPTY_SCREEN_PROGRESS })
    .returning();
  return row;
}

/** The most recent AI interview of an application, if any. */
export async function latestScreen(q: Queryable, applicationId: string): Promise<ScreenRow | null> {
  const rows = await q.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  return rows[0] ?? null;
}

/** The job version an AI interview asks about: the one it was made with; for a row stored without one, the version the person applied to. */
export function screenPacketVersion(screen: Pick<ScreenRow, "packetVersion">, app: Pick<ApplicationRow, "packetVersion">): number {
  return screen.packetVersion ?? app.packetVersion;
}

/**
 * Everything the chat and its scorecard read about one AI interview. `rolePacket`: the job version the interview was
 * made with (`packetVersion`), which is the job as it was when the person was shortlisted or sent a new link, not as
 * it is now. `packet`: the same with the questions this chat asks (`chatPacket`). `appliedPacket`: the version the
 * person applied to, whose form they answered. `reading`: the CV reading that says which of the interview's must-haves
 * the CV shows: their newest one against that version, else their newest one (a must-have it has no finding for is
 * asked about). Null when the CV was never read.
 */
export async function loadScreenBundle(q: Queryable, screenId: string) {
  const [screen] = await q.select().from(screens).where(eq(screens.id, screenId)).limit(1);
  if (!screen) return null;
  const [app] = await q.select().from(applications).where(eq(applications.id, screen.applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const packetVersion = screenPacketVersion(screen, app);
  const stored = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), inArray(rolePackets.version, [packetVersion, app.packetVersion])));
  // A version stored before the form had one list of questions is read with it filled in, as the parser reads it.
  const versions = stored.map((v) => ({ ...v, packet: readStoredPacket(v.packet) }));
  const pv = versions.find((v) => v.version === packetVersion);
  if (!candidate || !role || !company || !pv) return null;
  const readings = await q.select({ packetVersion: assessments.packetVersion, result: assessments.result }).from(assessments).where(and(eq(assessments.applicationId, app.id), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt), desc(assessments.id));
  const read = readings.find((r) => r.packetVersion === packetVersion) ?? readings[0];
  const reading = (read?.result as Pick<EvidenceAssessment, "requirementFindings"> | undefined) ?? null;
  return { screen, app, candidate, role, company, packetVersion, rolePacket: pv.packet, appliedPacket: versions.find((v) => v.version === app.packetVersion)?.packet ?? pv.packet, packet: chatPacket(pv.packet, screen.progress), reading };
}
export type ScreenBundle = NonNullable<Awaited<ReturnType<typeof loadScreenBundle>>>;

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

/** The next question in the chat's order that was not asked, answered or skipped. */
export function nextQuestion(packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>): ScreeningQuestion | null {
  const asked = new Set(progress.askedKeys);
  const declined = new Set(progress.declined ?? []);
  return packet.screening.questions.find((q) => !asked.has(q.key) && !(q.key in answers) && !declined.has(q.key)) ?? null;
}

/** The tap answer the current question offers, if any. */
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
 * The fixed introduction shown before the chat starts: the AI notice, the disclosure in the hiring team's words, how to
 * reach a person, and about how many minutes it takes. Of the job record it reads the title and the minutes, and none
 * of its sentences: the record's own lines about AI and about reaching a person (`communication`) were written by the
 * model that wrote the job and are never shown. How to reach a person is the code's line (`REACH_A_PERSON_LINE`), the
 * same for every job; the AI notice is the versioned one (`noticesFor`). Nothing here is written by a model.
 */
export type ScreenIntro = { title: string; disclosure: string; aiNotice: { version: string; text: string } | null; humanAlternative: string; minutes: number };

export function screenIntro(input: { companyName: string; firstName: string; packet: RolePacket; noticeOverrides?: CompanyRow["settings"]["notices"] }): ScreenIntro {
  const { packet, companyName } = input;
  const notice = noticesFor(["*"], input.noticeOverrides).find((x) => x.key === "ai_use");
  return {
    title: `A few questions about the ${packet.identity.title} role`,
    disclosure: `Hi ${input.firstName}, this is ${companyName}'s hiring assistant, a software program. It will ask you a few short questions about the ${packet.identity.title} role, one at a time. Your answers go to the hiring team only when you press Send my answers, and people on the team make every decision. You can ask for a person at any time.`,
    aiNotice: notice ? { version: notice.version, text: notice.text } : null,
    humanAlternative: REACH_A_PERSON_LINE,
    minutes: packet.screening.maxMinutes,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The plan, and what the chat may know about the candidate                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the chat may know about the candidate: their own CV lines, and their form answers as sentences. */
export type ChatFacts = { cv: string[]; formAnswers: string[] };

const line = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The CV's positions, licences, certificates and skills as a few plain lines (the candidate's own information: the chat names it). */
export function cvLinesOf(x: ApplicationRow["extraction"] | null | undefined): string[] {
  const cv: string[] = [];
  for (const p of (x?.positions ?? []).slice(0, 4)) cv.push(line(`${p.title}${p.employer ? ` at ${p.employer}` : ""}${p.startDate ? ` (${p.startDate}${p.current ? " to now" : p.endDate ? ` to ${p.endDate}` : ""})` : ""}${p.summary ? `: ${p.summary}` : ""}`));
  for (const l of (x?.licenses ?? []).slice(0, 3)) cv.push(line(`Licence: ${l.name}${l.jurisdiction ? ` (${l.jurisdiction})` : ""}`));
  for (const c of (x?.certifications ?? []).slice(0, 3)) cv.push(line(`Certification: ${c.name}`));
  if (x?.skills?.length) cv.push(line(`Skills: ${x.skills.slice(0, 12).join(", ")}`, 300));
  return cv;
}

/** The candidate's CV as a few plain lines, and every answer they gave on the application form as a sentence, so the chat never asks one again. */
export function chatFactsOf(packet: Pick<RolePacket, "formQuestions">, app: Pick<ApplicationRow, "extraction" | "answers">): ChatFacts {
  return { cv: cvLinesOf(app.extraction), formAnswers: formAnswerSentences(packet.formQuestions, formAnswersOf(app.answers)).map((s) => s.sentence) };
}

/** Said when "No" settles an item as not known: calm, and never a guess about what they can do. */
export const CHAT_CALM_LINE = "Understood, thanks for saying so.";
/** The question the code asks when the model's follow-up has none: one push, the analog, the smaller version. */
export const CHAT_LADDER_QUESTION: Readonly<Record<"push" | "analog" | "smaller", string>> = {
  push: "Could you tell me about one specific time: what you did, and what came of it?",
  analog: "Not done that exactly? Tell me about something similar from your own work.",
  smaller: "Even a small moment counts: was there a time, even with just a few people, when you did something like it?",
};

/**
 * What the chat says about a must-have the CV does not show: always true, whether or not it is on the CV in other words.
 * A licence, certificate, permit or registration (`namesCredential`, the scorecard's own test for one) is held or it is
 * not, so it is asked as a plain yes or no, once (`ladderApplies`); anything else is asked about from their own work.
 */
export function gapQuestion(text: string): string {
  const need = text.trim().replace(/[.!?]+$/, "");
  return namesCredential(text) ? `This is one of the things the job needs: ${need}. Do you have it?` : `This is one of the things the job needs: ${need}. What can you tell me about it from your own work?`;
}

/** What the chat says at its end, after the close: what happens next, and that nothing is sent before the candidate sends it. */
export function chatNextLine(companyName: string): string {
  return `Next, check what you are sending and change anything you like, then press Send my answers. Nothing goes to ${companyName} until you do.`;
}

/** The chat's last message: its close (one concrete thing from the chat, or a plain thank-you) and what happens next. */
export function chatClosingMessage(closing: string | null | undefined, companyName: string): string {
  const said = closing?.trim();
  return said ? `${said}\n\n${chatNextLine(companyName)}` : chatNextLine(companyName);
}

/**
 * The must-haves the chat asks about, in the job's order: those the stored CV reading did not find shown (a "yes" on a
 * checked quote is shown; anything else is not). Without a reading none is shown. The plan takes at most
 * `CHAT_GAP_LIMIT` of them (`buildChatPlan`).
 */
export function chatGaps(packet: Pick<RolePacket, "requirements">, reading: Pick<EvidenceAssessment, "requirementFindings"> | null | undefined): string[] {
  return packet.requirements.mustHaves
    .filter((m) => {
      const found = reading?.requirementFindings?.find((f) => f.requirementKey === m.key);
      return requirementFinding(found?.met ?? "unknown", hasCheckedQuote(found?.evidence)) !== "shown";
    })
    .map((m) => m.key);
}

/** The plan of a chat that starts at `at`: the job's interview questions, then the must-haves to ask about (`chatGaps`). */
export function chatPlanFor(packet: RolePacket, reading: Pick<EvidenceAssessment, "requirementFindings"> | null | undefined, at: string): ChatPlan {
  return buildChatPlan({ questions: packet.screening.questions.map((q) => q.key), gaps: chatGaps(packet, reading), at });
}

/**
 * The questions as the chat asks them, for every reader of the job record (the turn rules, the pages, the scorecard):
 * the plan's items in order (one of the job's interview questions as it is; a must-have as `gapQuestion`), then the
 * closing question. Before the chat has a plan, the job record as it is. Reading it twice gives the same.
 */
export function chatPacket(packet: RolePacket, progress: Pick<ScreenProgress, "chat"> | null | undefined): RolePacket {
  const plan = progress?.chat;
  if (!plan) return packet;
  const own = new Map(packet.screening.questions.map((q) => [q.key, q]));
  const must = new Map(packet.requirements.mustHaves.map((m) => [m.key, m]));
  const questions: ScreeningQuestion[] = [];
  for (const item of plan.items) {
    const m = item.kind === "gap" ? must.get(item.key) : undefined;
    const q = m ? { key: m.key, question: gapQuestion(m.text), kind: "skills" as const } : own.get(item.key);
    if (q) questions.push(q);
  }
  questions.push({ key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION, kind: "motivation" });
  return { ...packet, screening: { ...packet.screening, questions } };
}

/**
 * Whether "No" climbs the ladder for an item, and a vague reply gets its one push: a must-have, or an open question of
 * the job's. A yes-or-no question takes its answer as it is, and so does a must-have that names a licence, certificate,
 * permit or registration (`namesCredential`): they hold it or they do not, so the chat asks about it once and never for
 * "something similar" or "a small moment" of it. `packet`: the chat's own (`chatPacket`), which keeps the job's must-haves.
 */
function ladderApplies(packet: Pick<RolePacket, "requirements" | "screening">, item: Pick<ChatItem, "key" | "kind">): boolean {
  if (item.kind === "gap") return !namesCredential(packet.requirements.mustHaves.find((m) => m.key === item.key)?.text ?? "");
  const q = packet.screening.questions.find((x) => x.key === item.key);
  return !!q && (q.kind === "skills" || q.kind === "behavioral");
}

/**
 * The chat's first message, in code (no model at Start): the first name, one line from the CV when there is one, then
 * the first item's question word for word.
 */
export function chatOpening(input: { firstName: string; cv: string[]; question: string }): string {
  const first = input.firstName.trim() || "there";
  const work = input.cv[0]?.split(":")[0]?.trim().replace(/[.!?]+$/, "");
  // Only a position from the CV is named: a licence, a certificate or the skills line is not their work.
  const said = work && !/^(licence|certification|skills)/i.test(work) ? `Your resume shows your work as ${work}.` : "Thanks for applying.";
  return `Hi ${first}. ${said}\n\n${input.question}`;
}

/** The chat's state as the model sees it: the plan, each item's question, its ladder and the job's standard for it, the CV and the form. `packet`: the chat's own (`chatPacket`). */
export function chatPromptOf(packet: RolePacket, plan: ChatPlan, current: string | null, facts: ChatFacts): ChatPromptContext {
  const qs = new Map(packet.screening.questions.map((q) => [q.key, q]));
  return {
    section: plan.section,
    sectionLabel: CHAT_SECTION_LABEL[plan.section],
    current,
    items: plan.items.map((i) => {
      const q = qs.get(i.key);
      return { key: i.key, kind: i.kind, required: i.required, state: i.state, step: i.step, pushes: i.pushes, question: q?.question ?? i.key, ladder: ladderApplies(packet, i), ...(q?.modelAnswer ? { modelAnswer: q.modelAnswer } : {}) };
    }),
    wrap: { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION },
    cv: facts.cv,
    formAnswers: facts.formAnswers,
  };
}

/** What one turn of the chat is given (`screenTurnPrompt`). `packet`: the chat's own (`chatPacket`). */
function turnContext(b: ScreenBundle, plan: ChatPlan, screen: Pick<ScreenRow, "progress" | "answers" | "transcript">, latest: string): ScreenContext {
  return {
    company: { name: b.company.name },
    packet: b.rolePacket,
    candidate: { firstName: b.candidate.firstName },
    progress: screen.progress,
    answers: screen.answers,
    transcript: screen.transcript,
    latestCandidateMessage: latest,
    // The same pay rule as the job page the candidate applied from.
    payShown: payShown(b.rolePacket.compensation, jobNoticesFor({ jobLocations: b.rolePacket.identity.locations, companyLocations: b.company.locations, overrides: b.company.settings.notices })),
    chat: chatPromptOf(b.packet, plan, screen.progress.currentQuestionKey, chatFactsOf(b.appliedPacket, b.app)),
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The shape of a message: one restatement, one question                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

const FILLER = /^(?:(?:ok(?:ay)?|great|good|excellent|awesome|perfect|wonderful|fantastic|amazing|nice|cool|brilliant|lovely|thanks?|thank you|got it|i see|noted|sure|understood|right|alright)(?:,? (?:thanks?|thank you))?(?: so much| very much| for (?:sharing|that|explaining|telling me)(?: that)?(?: with me)?)?|that['’]?s (?:great|good|helpful|really helpful|very helpful|good to know|wonderful|impressive|excellent|fantastic|amazing|interesting|clear)|good to know|that helps|love (?:that|it))[.!]*$/i;
const PRAISE = /\b(?:great|excellent|impressive|amazing|fantastic|wonderful|brilliant|outstanding|strong|solid|clear(?:ly)?|well done|nicely|good job|good work)\b/i;
const INFERENCE = /^(?:it sounds like|it seems|it looks like|that suggests|this suggests|clearly|obviously|you must|you clearly|you obviously|i can tell|that shows|this shows|so it was|so that was|it must have)\b|\b(?:which|that|this) (?:shows|proves|demonstrates)\b|\byou(?:'re| are) clearly\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Anything personal, said of themselves or said back to them as a comment on it: "You have two kids, so mornings suit
 * you." reads as "I have two kids…". Without the comment it may be a scene ("You have two toddlers fighting over a toy.",
 * "You are 15 minutes late."), which stays. `redactProtected` itself stays as it is for what is recorded, where the words
 * are the candidate's.
 */
function personal(s: string): boolean {
  if (redactProtected(s) !== s) return true;
  if (!/\b(?:so|since|because|given)\b/i.test(s)) return false;
  const asTheirs = s.replace(/\byou(?:['’]re| are)\b/gi, "I am").replace(/\byou(?:['’]ve| have)\b/gi, "I have").replace(/\byour\b/gi, "my");
  return redactProtected(asTheirs) !== asTheirs;
}

/**
 * One neutral restatement and one question: the question the model wrote, with what sets it up, and before
 * it at most one sentence (two when the candidate asked something and it is being answered), with filler, inference,
 * judgement and, in "About your experience", praise left out (`chatParts`). `calm`: the restatement is the calm line instead (an item
 * settled as not known). `question`: asked when the model wrote none. `known`: the job's own question for the item being
 * asked, kept whole when the model wrote it word for word. `next`: the job's words for the question this message moves
 * on to, asked instead when all the model wrote is its last sentence (`onlyItsEnd`). `notes`: the job's private standards (`modelAnswer`).
 * Never adds words of the model's, and the restatement never repeats a sentence of the question.
 */
export function shapeChatMessage(text: string, opts: { experience: boolean; calm: boolean; question: string | null; answering: boolean; known?: string | null; next?: string | null; notes?: readonly string[] }): string {
  const parts = chatParts(text, opts);
  const question = parts.question && !(opts.next && onlyItsEnd(parts.question, opts.next)) ? parts.question : (opts.next ?? opts.question);
  const lead = opts.calm ? CHAT_CALM_LINE : parts.lead.filter((s) => !says(question, s)).join(" ");
  if (!question) return lead || text.trim();
  return lead ? `${lead}\n\n${question}` : question;
}

const ASKS = /\?["”’)]*$/;
/** How a candidate's question to the assistant opens, after a few lead-in words ("Ok, so what…", "Before I go on, what…"). */
const ASKS_THEM = /^(?:(?:ok(?:ay)?|so|and|but|also|sorry|hi|hello|hey|thanks|one (?:more )?question|quick question|(?:i was |i'm |just )?wondering|before i (?:go on|answer|continue))[,:.!]?\s+)*(?:what|how|when|where|why|who|which|whose|is|isn't|are|aren't|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has)\b/i;
/**
 * A sentence of the candidate's that asks the assistant something: it ends in "?" and opens as a question does ("What
 * does it pay?", "Is it full time?"), or is only question marks. An answer said with a rising "?" ("Around $50 an
 * hour?", "I'm looking for $52 an hour, is that ok?", "5 years, why?") is still an answer.
 */
const asksAssistant = (s: string) => ASKS.test(s) && (ASKS_THEM.test(s.replace(/[’‘]/g, "'")) || !/[\p{L}\p{N}]/u.test(s));
/**
 * How a request or a scene may open: a lead-in word or two ("Now, …") and how the candidate is addressed (one word and a
 * comma: "Test, …"). "Then", "First", "Finally" and "Lastly" are not among them: "First, explain the problem to the
 * customer" is a step they told us about, and it is the restatement.
 */
const LEAD_INS = "(?:(?:please|now|next|so|and|also)[,:]?\\s+)*";
const OPENING = `^${LEAD_INS}(?:(?!(?:then|first|finally|lastly)\\b)[\\p{L}'’-]+,\\s+)?${LEAD_INS}`;
/**
 * What can only be a request of ours: it is said to them ("Tell us about…", "Give an example of…"). "Let's talk about pay."
 * and "I'd like to hear about…" are not among them: they are how a model moves from one thing to the next, and the
 * question follows, or the code adds it.
 */
const SAID_TO_THEM = "tell (?:me|us)|walk (?:me|us) through|talk (?:me|us) through|give (?:me|us)|give (?:an|one|a)\\s+(?:\\w+\\s+)?example";
const ASKS_THEM_DIRECTLY = new RegExp(`${OPENING}(?:${SAID_TO_THEM})\\b`, "iu");
/** A request, which asks by itself as a question does: those, and the ones that can also be a step they told us about ("Describe…", "Share…", "Explain…"). */
const REQUEST = new RegExp(`${OPENING}(?:${SAID_TO_THEM}|describe|share|explain)\\b`, "iu");
/** A sentence that sets the scene ("Think of a busy day.", "Test, picture a class of twenty."): it asks nothing by itself. */
const SETS_UP = new RegExp(`${OPENING}(?:think (?:of|about|back)|imagine|picture|suppose|consider|recall|remember|let['’]s say)\\b`, "iu");
const asksAt = (sentences: string[]) => sentences.findIndex((s) => ASKS.test(s) || REQUEST.test(s));
/**
 * Whether a message asks without a question mark, as the shaping reads one: a sentence of it is a `REQUEST`, so "Think of
 * a time…" alone does not. The eval reads messages with this (packages/evals, chat-suite.ts), so the two never drift.
 */
export const asksByRequest = (text: string): boolean => sentencesOf(text).some((s) => REQUEST.test(s));
/** The requests a question keeps after it ("Not done that exactly? Tell me about something similar."); a question followed by "Tell us…" is two asks. */
const KEPT_AFTER_A_QUESTION = /^(?:please\s+)?(?:tell me|describe|walk me through|talk me through|share|give me|explain)\b/i;
/**
 * What a question after a request asks when it is a second ask: pay, days, hours, starting. Any other question stays with
 * the request ("Describe a busy day. How do you decide what comes first?"): cutting it would lose the real question, and
 * the team would read an answer to half of it, which is worse than two asks.
 */
const ASKS_ANOTHER_THING = /\b(?:pay|paid|salary|wages?|hourly|benefits?|commute|relocat\w*|weekends?|shifts?|availab\w+|start date)\b|\b(?:what|which) (?:days|hours)\b|\bcan you (?:start|begin|work)\b/i;
/** A question about what happened there, which stays even in those words ("How many hours did it take?"). */
const FOLLOWS_ON = /\b(?:did|was|were|happened|came of|changed|went|turn(?:ed)? out)\b|\b(?:it|that|them|this|there)\?["”’)]*$/i;

/**
 * The first question the model wrote, from where it starts, with none of its words lost. A
 * question keeps the request that follows it ("Not done that exactly? Tell me about something similar."). A request keeps
 * what it leads through: a scene (`keeps` decides, as for any setup), another request, and the question it leads to ("Tell
 * us about another day. Think of a mistake you made. What happened?"), unless that asks for something else and is not the
 * job's own, `known`. Anything after it is left out.
 */
function firstQuestion(sentences: string[], at: number, known: string | null | undefined, keeps: (s: string) => boolean): string {
  if (ASKS.test(sentences[at])) {
    let end = at + 1;
    while (end < sentences.length && KEPT_AFTER_A_QUESTION.test(sentences[end]) && !/\?/.test(sentences[end])) end += 1;
    return sentences.slice(at, end).join(" ");
  }
  const belongs = (s: string) => !ASKS_ANOTHER_THING.test(s) || FOLLOWS_ON.test(s) || sentencesOf(known ?? "").some((x) => plainKey(x) === plainKey(s));
  const ask = [sentences[at]];
  let scenes: string[] = [];
  for (const s of sentences.slice(at + 1)) {
    const asks = ASKS.test(s);
    if (!asks && SETS_UP.test(s)) {
      scenes.push(s);
      continue;
    }
    if (!(asks || REQUEST.test(s)) || !belongs(s)) break;
    ask.push(...scenes.filter(keeps), s);
    if (asks) break;
    scenes = [];
  }
  return ask.join(" ");
}

/**
 * Where the first question of a message starts, among all its sentences, or -1: the first asking sentence of the first
 * paragraph that asks. A first paragraph with no question mark gives way to a later paragraph that asks: its request is
 * then a step they told us about ("Share the plan with the team each morning.\n\nWhich tool do you use?"). The one
 * exception: when it ends with a request said to them and the next paragraph goes straight on (it asks, or sets a scene
 * first), the two are one ask, from that request ("You keep a list. Tell me about one specific time.\n\nWhat did you do?").
 */
function questionAt(paragraphs: string[][]): number {
  const asks = (p: string[]) => asksAt(p) >= 0;
  const first = paragraphs.findIndex(asks);
  const later = first === 0 && !paragraphs[0].some((s) => ASKS.test(s)) ? paragraphs.findIndex((p, i) => i > 0 && asks(p)) : -1;
  if (later === 1) {
    const ends = paragraphs[0].length - 1;
    const goesOn = paragraphs[1].slice(0, asksAt(paragraphs[1])).every((s) => SETS_UP.test(s));
    if (ASKS_THEM_DIRECTLY.test(paragraphs[0][ends]) && goesOn) return ends;
  }
  const own = later > 0 ? later : first;
  return own < 0 ? -1 : paragraphs.slice(0, own).flat().length + asksAt(paragraphs[own]);
}

/** Where the job's own question of two or more sentences stands in the model's sentences, word for word (commas aside), next to each other. */
function wordForWord(sentences: string[], known: string | null | undefined): { from: number; to: number } | null {
  const job = sentencesOf(known ?? "").map(plainKey);
  if (job.length < 2) return null;
  const said = sentences.map(plainKey);
  const from = said.findIndex((_, i) => job.every((k, j) => said[i + j] === k));
  return from < 0 ? null : { from, to: from + job.length };
}

/**
 * Whether all the model wrote for a new question is the last sentence of the job's own, which has more (the live smoke
 * test of 4 Nov 2026: "What did you do, and how did it turn out?", with nothing to say what about), commas aside. Only
 * that exact case: "What did you do next?" or "How did that go?" is the short check the prompt asks for on an item
 * already answered, or the model's own words, and stands.
 */
function onlyItsEnd(written: string, jobQuestion: string): boolean {
  const job = sentencesOf(jobQuestion);
  return job.length >= 2 && plainKey(written) === plainKey(job[job.length - 1]);
}

/** Whether a text already says this sentence (`sentenceKey`). */
const says = (text: string | null, s: string) => sentencesOf(text ?? "").some((x) => sentenceKey(x) === sentenceKey(s));

/**
 * A sentence that judges the candidate, or hints at what the team wants ("You seem very organized.", "A good answer
 * says…", "We look for someone who…", "There were no major issues."). A team in a scene can want things: only a person
 * they want counts ("The team wants a new rota by Friday." stays).
 */
const JUDGES = /^(?:you seem|you clearly|you obviously|sounds like|that sounds|that seems|that looks|that must)\b|\b(?:good|great|strong|best|ideal|perfect|right) answers?\b|\bwe(?:['’]re| are)? (?:want|look(?:ing)? for)\b|\b(?:team|company|employer|manager)(?:['’]s| is)? (?:wants?|look(?:s|ing)? for) (?:someone|people|a person)\b|\b(?:straightforward|easy) for you\b|\bno major (?:issues|hurdles)\b/i;
/** Opens with praise, whatever it goes on to say ("Good work.", "Great work on that."). "Strong", "solid" and "clear" are left out: "A strong wind…" is about the wind. */
const OPENS_WITH_PRAISE = /^(?:great|excellent|impressive|amazing|fantastic|wonderful|brilliant|outstanding|well done|nicely|(?:good|nice) (?:job|work))\b/i;
/** A promise of a time: the code says what happens next, and decisions have no deadline. "The team will be in touch." names no time, and stays. */
const PROMISES_A_TIME = /\b(?:will|['’]ll)\b.*\b(?:within|few (?:hours|days|weeks)|next week|soon|shortly|by (?:monday|tuesday|wednesday|thursday|friday))\b/i;
const ABOUT_THEM = /^(?:you|your|that|this|it)\b/i;
const JUDGING_WORD = /\b(?:good|nice|fun|capable|organi[sz]ed)\b/i;
/** Judging only in a short remark ("You handled that well.", "It went smoothly."): a scene can say them ("You have a customer who does not speak English well."). */
const MILD_JUDGING_WORD = /\b(?:well|perfect|smart|useful|easy|smooth(?:ly)?|straightforward)\b/i;
const SHORT_REMARK = 8;
/** Said whoever it is about. A scene that opens with a word of praise keeps it: "Great, think of a time…" is still the scene. */
const hints = (s: string) => JUDGES.test(s) || (OPENS_WITH_PRAISE.test(s) && !SETS_UP.test(s)) || PROMISES_A_TIME.test(s);
/**
 * A sentence that judges them or hints at what the team wants. A sentence about anything else keeps its words: "A strong
 * wind knocks out the power during class." stays.
 */
const judges = (s: string) => hints(s) || (ABOUT_THEM.test(s) && (PRAISE.test(s) || JUDGING_WORD.test(s) || (MILD_JUDGING_WORD.test(s) && s.split(/\s+/).length <= SHORT_REMARK)));

/**
 * A message's restatement and question, by its paragraphs: the model is asked for the restatement, a blank line, then the
 * question, and it writes that.
 *
 * The question: the job's own (`known`) when the model wrote all of it word for word, never cut, filtered or capped; or
 * else the first one the model wrote (`questionAt`, `firstQuestion`).
 *
 * What is before it, wherever it stands, without filler, inference, judgement (`judges`; while answering the candidate's
 * own question only `hints`, since "That is well within the range." may be the answer), (in "About your experience")
 * praise or anything personal (`personal`), which is not recorded either. With earlier paragraphs: those are the
 * restatement (at most one sentence, two while answering the candidate, never a request said to them), and what is in the
 * question's own paragraph sets it up. All in one paragraph: the first sentence is the restatement, a second one in one
 * breath is left out, and only a sentence that opens as a scene does (`SETS_UP`) sets the question up. Two sentences of
 * setup at most, never one that says a private standard in part (`echoesNotePart`), says the calm line, or repeats the
 * message. With no question, a scene is not kept: it sets up nothing.
 */
function chatParts(text: string, opts: { experience: boolean; answering: boolean; known?: string | null; notes?: readonly string[] }): { lead: string[]; question: string | null } {
  // A sentence said twice in a row counts once ("Tell us about it.\n\nTell us about it. What did you do?").
  let previous = "";
  const once = (s: string) => {
    const same = sentenceKey(s) === previous;
    previous = sentenceKey(s);
    return !same;
  };
  const paragraphs = text.split(/\n+/).map((p) => sentencesOf(p).filter(once)).filter((p) => p.length);
  const sentences = paragraphs.flat();
  const usable = (s: string) => !FILLER.test(s) && !INFERENCE.test(s) && !(opts.answering ? hints(s) : judges(s)) && !(opts.experience && PRAISE.test(s)) && !/\?/.test(s) && !personal(s);
  const restates = opts.answering ? 2 : 1;
  const run = wordForWord(sentences, opts.known);
  const at = run ? run.from : questionAt(paragraphs);
  if (at < 0) return { lead: sentences.filter((s) => usable(s) && !SETS_UP.test(s)).slice(0, restates), question: null };
  let from = 0;
  for (const p of paragraphs) {
    if (from + p.length > at) break;
    from += p.length;
  }
  const own = sentences.slice(from, at).filter(usable);
  const noNote = (s: string) => !(opts.notes ?? []).some((n) => echoesNotePart(s, n));
  const question = run ? sentences.slice(run.from, run.to).join(" ") : firstQuestion(sentences, at, opts.known, (s) => usable(s) && noNote(s));
  const lead = (from > 0 ? sentences.slice(0, from).filter((s) => usable(s) && !ASKS_THEM_DIRECTLY.test(s)) : own.filter((s) => !SETS_UP.test(s))).slice(0, restates);
  const said = [...lead, question, CHAT_CALM_LINE].join(" ");
  const setsUp = (s: string) => noNote(s) && !says(said, s);
  const setup = (from > 0 ? own : own.filter((s) => SETS_UP.test(s))).filter(setsUp).slice(-2);
  return { lead, question: [...setup, question].join(" ") };
}

/** The restatement alone, for a message whose question is the code's (a request is no restatement beside it): the calm line instead when `calm`. */
function chatLead(text: string, opts: { experience: boolean; calm: boolean; answering: boolean; known?: string | null }): string {
  return opts.calm ? CHAT_CALM_LINE : chatParts(text, opts).lead.filter((s) => !REQUEST.test(s)).join(" ");
}

/**
 * A close: the model's sentences that are not questions, at most two, without inference, filler, anything personal,
 * what happens next (the code says it) or any time (decisions are private with no deadline); null
 * when none are left.
 */
function shapeClosing(text: string): string | null {
  const kept = sentencesOf(text).filter((s) => !/\?/.test(s) && !INFERENCE.test(s) && !FILLER.test(s) && !personal(s) && !/\b(?:press send|next screen|review your answers|check your answers|what happens next|hear back|within|few days|next week|soon|shortly)\b/i.test(s));
  return kept.length ? kept.slice(0, 2).join(" ") : null;
}

const noteWords = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
/** Whether the words share a run of `size` with a note's words. */
function sharesRun(text: string, n: string[], size: number): boolean {
  const grams = new Set(n.slice(0, n.length - size + 1).map((_, i) => n.slice(i, i + size).join(" ")));
  const t = noteWords(text);
  return t.some((_, i) => i + size <= t.length && grams.has(t.slice(i, i + size).join(" ")));
}

/**
 * Whether the words share five in a row with a private note (a question's `modelAnswer`): a note is never said to a candidate. A whole message is held
 * to this, since a candidate's own words or the job's can share a shorter run with a note by chance.
 */
function echoesNote(text: string, note: string | undefined): boolean {
  if (!note) return false;
  const n = noteWords(note);
  return n.length >= 5 && sharesRun(text, n, 5);
}

/** The stricter check on a sentence the model chose to add before its question: three in a row, or the whole of a shorter note (two words or more). */
function echoesNotePart(text: string, note: string | undefined): boolean {
  if (!note) return false;
  const n = noteWords(note);
  return n.length >= 2 && sharesRun(text, n, Math.min(3, n.length));
}

/**
 * The candidate's replies about an item since it was asked: their words, in order, for the answer recorded when it
 * settles. A keyword command ("WITHDRAW", "PERSON", a "CONFIRM" to a withdrawal) is not an answer.
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

/** Whether a message asks something: a question, or a request that asks as one does ("Tell me about…"). */
function asksSomething(text: string): boolean {
  return asksAt(sentencesOf(text)) >= 0;
}

/**
 * Whether a candidate's message only asks the assistant something ("Before I go on, what does this pay per hour?",
 * "Ok. What are the hours?"): a question they asked is never their answer.
 */
export function onlyQuestions(text: string | null | undefined): boolean {
  const sentences = sentencesOf(text ?? "");
  return sentences.some(asksAssistant) && sentences.every((s) => asksAssistant(s) || FILLER.test(s));
}

const CONFUSED = /^(?:(?:sorry|um+|uh+|hm+|eh|huh)\s+)*(?:what do you mean(?: by that)?|what does that mean|what is that|what|huh|sorry|pardon|come again|i (?:do not|don't|dont) (?:understand|get it|follow)(?: (?:that|the question|you|what you mean))?|i(?:'m| am) (?:confused|lost|not sure what you mean)|confused|not sure what you mean)$/;

/**
 * Whether a reply only says the candidate did not follow ("???", "What do you mean?", "Sorry, I don't understand"): such a
 * reply gets help and the offer of a person, and is never recorded as an answer, whatever the model read.
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
/** The same, commas aside: the real model adds them to a job's words ("What did you do, and how did it turn out?"). */
const plainKey = (s: string) => sentenceKey(s).replace(/,/g, "");

/**
 * The recorded answer held to the candidate's latest message: a question they asked in it is never part of
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

/** Replies without what is never an answer: one that only shows confusion or only asks the assistant something, and a question asked inside a longer one. */
function usableReplies(replies: ReadonlyArray<string>): string[] {
  return replies.filter((r) => !seemsConfused(r) && !onlyQuestions(r)).map((r) => (sentencesOf(r).some(asksAssistant) ? sentencesOf(r).filter((s) => !asksAssistant(s)).join(" ") : r)).filter(Boolean);
}

/** A message without the job's own questions in it: the words the model wrote around them. */
function modelWordsOf(packet: RolePacket, text: string): string {
  return packet.screening.questions.reduce((s, x) => s.split(x.question).join(" "), text);
}

/**
 * The code's rules for a turn, after the model answered. What the candidate wrote decides what is recorded, and the
 * code, not the model's labels, decides what kind of turn it is:
 * - only this chat's own questions count, and a skipped one is never asked again;
 * - a turn that asks for a person closes nothing: the candidate is shown how to choose one on the page, and the question
 *   stays (choosing not to do the interview is theirs to do, never the model's to read into their words);
 * - a reply that only asks the assistant something, or only shows confusion, is never an answer, nor is a question asked
 *   inside a longer reply; a confused candidate gets the same question again and is shown how to choose a person;
 * - the model's own words never touch a protected trait (`unfairQuestion`): on a hit the chat moves on in the job's words;
 * - the ladder: how the latest reply reads (a plain "No" climbs it whatever the model read) and what comes next
 *   (`chatNextMove`): a follow-up the ladder allows passes, one it does not is replaced by the next question; moving on
 *   early is fine (less pressing, never more). When the item settles, the candidate's replies about it are its answer,
 *   except a must-have settled as not known, which records nothing (never a "no" for a skill). A yes-or-no question,
 *   and a must-have that names a licence, certificate, permit or registration, have no ladder (`ladderApplies`): any
 *   reply is the answer, a "No" included, and nothing "similar" is asked for;
 * - the closing question is followed by the close; a close before the end goes on to what is left;
 * - every message is one restatement and one question (`shapeChatMessage`), and never says the job's private standard
 *   for a question (`modelAnswer`), even in part.
 * Returns the turn and the step taken on the item, for the plan (`advanceProgress`).
 */
export function enforceChatTurn(raw: ScreenTurn, packet: RolePacket, progress: ScreenProgress, answers: Record<string, string>, input: { transcript: ReadonlyArray<ScreenTranscriptEntry>; latest: string }): { turn: ScreenTurn; move: { key: string; move: ChatMove } | null } {
  const plan = progress.chat;
  const keys = packet.screening.questions.map((x) => x.key);
  const q = (key: string | null | undefined) => (key ? packet.screening.questions.find((x) => x.key === key) : undefined);
  const declined = new Set(progress.declined ?? []);
  const asked = new Set(progress.askedKeys);
  const current = progress.currentQuestionKey;
  const reply = input.latest;
  let t: ScreenTurn = { ...raw };
  // How an answer was recorded is the code's to say: the model only ever answers.
  if (t.answerRecorded) t = { ...t, answerRecorded: { questionKey: t.answerRecorded.questionKey, answer: t.answerRecorded.answer, complete: t.answerRecorded.complete } };
  if (t.questionKey && (!keys.includes(t.questionKey) || declined.has(t.questionKey))) t = { ...t, questionKey: null };
  if (t.answerRecorded && !keys.includes(t.answerRecorded.questionKey)) t = { ...t, answerRecorded: null };
  if (t.humanRequested) return { turn: { ...t, humanRequested: false, done: false, questionKey: null, followUpReason: "shown how to choose a person", answerRecorded: null, messageToCandidate: PERSON_REPLY }, move: null };

  if (t.sentiment !== "distressed" && t.sentiment !== "frustrated" && seemsConfused(reply)) t = { ...t, sentiment: "confused" };
  if (t.sentiment === "confused" || onlyQuestions(reply)) t = { ...t, answerRecorded: null };
  else if (t.answerRecorded) t = { ...t, answerRecorded: answerAgainstLatest(t, reply) };
  if (t.answerRecorded && !t.answerRecorded.answer.trim()) t = { ...t, answerRecorded: null };
  if (current && t.sentiment === "confused") {
    // A confused candidate gets help with the same question, never a move on or a close.
    if (t.done || (t.questionKey && t.questionKey !== current)) t = { ...t, done: false, messageToCandidate: `No problem. ${q(current)?.question ?? ""}`.trim() };
    t = { ...t, questionKey: null, followUpReason: t.followUpReason ?? "the candidate seemed confused" };
  } else if (current && t.questionKey === current && asked.has(current) && !t.done) {
    // The question being asked, asked again (in other words, or after answering the candidate's own question): not a move.
    t = { ...t, questionKey: null, followUpReason: t.candidateAskedAbout ? t.followUpReason : t.followUpReason ?? "asked again" };
  }
  // A turn that stays on the question being asked and asks something about it is a follow-up, labelled or not.
  if (current && !t.done && !t.questionKey && !t.followUpReason && !t.candidateAskedAbout && !onlyQuestions(reply) && asksSomething(t.messageToCandidate)) t = { ...t, followUpReason: "asked for more" };
  const remaining = packet.screening.questions.filter((x) => x.key !== current && !asked.has(x.key) && !(x.key in answers) && !declined.has(x.key));
  if (unfairQuestion(modelWordsOf(packet, t.messageToCandidate))) {
    if (t.questionKey && !t.done) t = { ...t, messageToCandidate: "", followUpReason: null };
    else {
      const next = t.done ? undefined : remaining[0];
      t = next ? { ...t, messageToCandidate: "", questionKey: next.key, followUpReason: null } : { ...t, done: true, questionKey: null, followUpReason: null, messageToCandidate: "" };
    }
  }

  const item = plan?.items.find((i) => i.key === current) ?? null;
  const experience = plan?.section === "experience";
  // A message the code put together here (the model's restatement, then the next question in the job's words) is final.
  let composed = false;
  const moveOn = (lead: string, recorded: ScreenTurn["answerRecorded"]): ScreenTurn => {
    const next = remaining[0];
    composed = true;
    return next ? { ...t, questionKey: next.key, followUpReason: null, done: false, answerRecorded: recorded, messageToCandidate: lead ? `${lead}\n\n${next.question}` : next.question } : { ...t, questionKey: null, followUpReason: null, done: true, answerRecorded: recorded, messageToCandidate: lead };
  };
  // A question the candidate asked, or a reply that only shows confusion, is not a reply to the item.
  const replied = !t.candidateAskedAbout && t.sentiment !== "confused" && !onlyQuestions(reply);
  let move: { key: string; move: ChatMove } | null = null;
  let calm = false;
  let ladderQuestion: string | null = null;

  if (current === CHAT_WRAP_KEY && replied) {
    // The closing question was answered: the close follows, whatever the model wanted to ask next.
    const own = reply.trim();
    t = { ...t, done: true, questionKey: null, followUpReason: null, answerRecorded: t.answerRecorded ?? (own ? { questionKey: CHAT_WRAP_KEY, answer: own, complete: true } : null) };
  } else if (item && replied) {
    const ladder = ladderApplies(packet, item);
    const modelStays = !!t.followUpReason && !t.questionKey && !t.done;
    const reading = ladder && saysNotDone(reply) ? "not_done" : t.reading === "not_done" && !ladder ? "concrete" : (t.reading ?? (modelStays ? "vague" : "concrete"));
    const expected = chatNextMove(item, reading, ladder);
    // Their replies about the item, without a confused reply or a question of their own on the way: neither is ever part
    // of the answer, and neither keeps a bare "yes" on the push from reading as one.
    const replies = usableReplies(replyListSince(input.transcript, item.key));
    const said = replies.join(" ");
    // The model's record of the answer stands only as their own words: their replies about the item, whole or with a
    // sentence left out (`saidByCandidate`). Anything else written in their name (a rewording, two replies joined its
    // own way, "… | …") gives way to the replies as they sent them.
    const theirOwn = (a: ScreenTurn["answerRecorded"]): ScreenTurn["answerRecorded"] => (a && a.questionKey === item.key && said && !saidByCandidate(a.answer, replies.join("\n")) ? { ...a, answer: redactProtected(said) } : a);
    const answerFor = (m: ChatMove): ScreenTurn["answerRecorded"] => (m === "unknown" && item.kind === "gap" ? null : theirOwn(t.answerRecorded) ?? (said ? { questionKey: item.key, answer: redactProtected(said), complete: m === "covered" } : null));
    if (chatMoveStays(expected) && modelStays) {
      move = { key: item.key, move: expected };
      ladderQuestion = CHAT_LADDER_QUESTION[expected as "push" | "analog" | "smaller"];
      // The item is still being asked (the push, the analog, the smaller version): while their replies are only a bare
      // "yes" or a plain "No" nothing is recorded, so neither ever stands as the answer, a "No" never as a "no" for a
      // skill; it settles with every reply as its answer (`answerFor`). Words with something in them are kept as they
      // stand, so "Skip this question" on a follow-up keeps them.
      t = { ...t, answerRecorded: replies.every(bareReply) ? null : theirOwn(t.answerRecorded) ?? { questionKey: item.key, answer: redactProtected(said), complete: false } };
    } else if (chatMoveStays(expected)) {
      // The model moved on early: fine, the item settles as it stands.
      const settled: ChatMove = reading === "not_done" ? "unknown" : "covered";
      move = { key: item.key, move: settled };
      calm = settled === "unknown";
      t = { ...t, answerRecorded: answerFor(settled) };
    } else {
      move = { key: item.key, move: expected };
      calm = expected === "unknown";
      if (modelStays || (!t.questionKey && !t.done)) t = moveOn(chatLead(t.messageToCandidate, { experience, calm, answering: false, known: q(item.key)?.question }), answerFor(expected));
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
  // Five words in a row of a private standard are never said, whichever question it belongs to: the model is given every one.
  const notes = packet.screening.questions.flatMap((x) => (x.modelAnswer ? [x.modelAnswer] : []));
  const echoesAny = (text: string) => notes.some((n) => echoesNote(modelWordsOf(packet, text), n));
  if (t.done) {
    const closing = shapeClosing(t.messageToCandidate) ?? "";
    return { turn: { ...t, messageToCandidate: echoesAny(closing) ? "" : resumeAsWeWriteIt(closing) }, move };
  }
  const asking = t.questionKey ? q(t.questionKey) : undefined;
  let message = composed ? t.messageToCandidate : shapeChatMessage(t.messageToCandidate, { experience, calm, question: ladderQuestion ?? asking?.question ?? (item ? q(item.key)?.question ?? null : null), answering: !!t.candidateAskedAbout, known: asking?.question ?? q(current)?.question, next: asking && asking.key !== current ? asking.question : null, notes });
  // The question goes back to its own words (the job's, which are the company's to ask).
  if (echoesAny(message)) message = shapeChatMessage("", { experience: false, calm, question: asking?.question ?? q(current)?.question ?? CHAT_WRAP_QUESTION, answering: false });
  if (t.sentiment === "confused") message = `${message}\n\n${PERSON_OFFER}`;
  // The models write "résumé"; every page says "resume", and so does the assistant.
  return { turn: { ...t, messageToCandidate: resumeAsWeWriteIt(message) }, move };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Start                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** A turn with nothing in it, for the steps code takes on its own (the first question, a skip, a tap). */
const SILENT_TURN: ScreenTurn = { messageToCandidate: " ", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

/**
 * "Start" on the introduction: the chat gets its plan, the first question appears in the job's own words with no model
 * call, and the application moves to "AI interview started". A second press (a reload, a double click) changes nothing.
 */
export async function startScreenConversation(q: Queryable, deps: Pick<ScreenDeps, "clock">, input: { screenId: string; actor: Actor }): Promise<{ ok: boolean; message: string | null }> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !ACTIVE_STATUSES.has(b.screen.status)) return { ok: false, message: null };
  const { screen, app, company, candidate } = b;
  const opened = screen.transcript.find((t) => t.role === "assistant");
  if (opened) return { ok: true, message: opened.content };
  const now = nowOf(deps).toISOString();
  const planned: ScreenProgress = { ...screen.progress, chat: chatPlanFor(b.rolePacket, b.reading, now) };
  const first = nextQuestion(chatPacket(b.rolePacket, planned), planned, screen.answers);
  if (!first) return { ok: false, message: null };
  const content = chatOpening({ firstName: candidate.firstName, cv: cvLinesOf(app.extraction), question: first.question });
  const entry: ScreenTranscriptEntry = { role: "assistant", content, at: now, questionKey: first.key, source: "system" };
  const progress = advanceProgress(planned, { ...SILENT_TURN, messageToCandidate: content, questionKey: first.key });
  await q.update(screens).set({ status: "in_progress", startedAt: screen.startedAt ?? now, transcript: [...screen.transcript, entry], progress }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.started", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { applicationId: app.id }, correlationId: screen.workflowRunId });
  if (app.stage === "screen_invited") await transition(q, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
  return { ok: true, message: content };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Turns                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** `review`: every question is answered or skipped, and the candidate checks their answers next. */
export type TurnResult = { kind: "reply"; message: string; review: boolean; withdrawn: boolean } | { kind: "closed"; message: string } | { kind: "error"; message: string };

/** One thing the candidate did: a typed `message`, or `skip` the current question, or a `tap` answer to it. A skip or a tap never reaches the model. */
export type TurnInput = { screenId: string; message: string; actor: Actor; skip?: boolean; tap?: TapAnswer | null };

/** What counting an interview did to the plan's allowance, for the administrators' alert after the transaction. */
export type AllowanceNote = { crossing: entitlements.AllowanceCrossing; companyId: string; companyName: string };

/** What the first transaction of a turn leaves for the model call and the second transaction. */
export type BegunTurn = ({ kind: "done"; result: TurnResult } | { kind: "pending"; b: ScreenBundle; ctx: ScreenContext }) & { allowance?: AllowanceNote | null };

const turnReply = (message: string, more: { review?: boolean; withdrawn?: boolean } = {}): TurnResult => ({ kind: "reply", message, review: !!more.review, withdrawn: !!more.withdrawn });

/** What an AI interview that is no longer open answers, by where it stands. */
export function closedMessage(status: string): string {
  if (status === "completed") return "Thanks, your answers are sent. People on the hiring team review them and make every decision.";
  if (status === "declined_by_candidate") return "The hiring team has been told you chose not to do the AI interview.";
  return "This AI interview has closed.";
}

/**
 * Counts the interview against the plan's AI interviews at the candidate's first answer, never at the invitation, and
 * when that crossed 80% of the month's allowance or used it up, tells the team in the app. The administrators are told
 * after the transaction (`flagAllowance`). Someone who has started is never cut off.
 */
export async function countConversation(q: Queryable, input: { companyId: string; companyName: string; screenId: string }): Promise<AllowanceNote> {
  const crossing = await entitlements.recordScreenStart(q, input.companyId, { screenId: input.screenId });
  if (crossing.crossed) {
    const usedUp = crossing.crossed === "used_up";
    await emit(q, { type: usedUp ? "entitlement.exceeded" : "entitlement.warning", companyId: input.companyId, actor: { kind: "system", id: "allowance" }, subject: { type: "company", id: input.companyId }, payload: { key: TEXT_SCREENS, used: crossing.used, limit: crossing.limit } });
    await notify(q, {
      companyId: input.companyId,
      kind: "entitlement.text_screens",
      title: usedUp ? "This month's AI interviews are used up" : "80% of this month's AI interviews used",
      body: usedUp
        ? `${crossing.used} of ${crossing.limit} used. Anyone already invited can still do theirs. Nobody new can be shortlisted for an AI interview until the allowance starts again or the plan changes.`
        : `${crossing.used} of ${crossing.limit} used. Nothing has stopped.`,
      action: { label: "See usage", href: appPaths.settings },
    });
  }
  return { crossing, companyId: input.companyId, companyName: input.companyName };
}

/** The administrators' alert for a crossing, platform side, after the counting transaction committed. */
export async function flagAllowance(db: Db, note: AllowanceNote | null | undefined): Promise<void> {
  if (!note?.crossing.crossed) return;
  await withPlatform(db, (tx) => entitlements.flagScreenAllowance(tx, { companyId: note.companyId, companyName: note.companyName, crossing: note.crossing })).catch((err) => console.warn(`[screening] could not raise the allowance alert: ${errorForLog(err)}`));
}

/**
 * The first transaction of a turn: records what the candidate said, and answers without the model whatever needs none:
 * the keyword commands (a person, WITHDRAW), a skip, a tapped answer, and the end at the turn cap. Everything else is
 * left for the model.
 */
export async function beginScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput): Promise<BegunTurn> {
  // The row is locked before anything is read: two first answers at the same moment (a double Send) take turns, so the
  // interview is counted once and neither turn writes over the other's transcript. The lock lasts this short
  // transaction only, never the model call.
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  let b = await loadScreenBundle(q, input.screenId);
  if (!b) return { kind: "done", result: { kind: "error", message: "This conversation is no longer available." } };
  if (!ACTIVE_STATUSES.has(b.screen.status)) return { kind: "done", result: { kind: "closed", message: closedMessage(b.screen.status) } };
  // An answer posted before Start (an old page, a reload): the first question is put first, as Start does, so the answer is read against it.
  if (!b.screen.progress.chat) {
    await startScreenConversation(q, deps, { screenId: b.screen.id, actor: input.actor });
    b = (await loadScreenBundle(q, input.screenId)) ?? b;
  }
  const { screen, company, packet } = b;
  const plan = screen.progress.chat;
  const current = screen.progress.currentQuestionKey;
  // Checking answers: changes go through that page's own forms, not the chat.
  if (screen.progress.phase === "review") return { kind: "done", result: turnReply(REVIEW_MESSAGE, { review: true }) };
  if (!plan || ((input.skip || input.tap) && !current)) return { kind: "done", result: { kind: "error", message: "There is no question to answer here right now." } };
  // A tap is recorded as fixed words worked out in code; one that does not fit the question is refused before anything is written.
  const tapped = input.tap ? tapWords(packet, screen.progress, input.tap, nowOf(deps)) : null;
  if (input.tap && !tapped) return { kind: "done", result: { kind: "error", message: "That answer does not fit this question. Please type it instead." } };
  const now = nowOf(deps).toISOString();
  const said = input.skip ? null : tapped ?? input.message;

  // A skip while the assistant follows up on an answer already given moves on and keeps that answer: only a question
  // with no answer at all is skipped, and only that counts as not known in the scorecard.
  const movesOn = !!input.skip && !!current && screen.answers[current] !== undefined;
  const entry: ScreenTranscriptEntry = input.skip
    ? movesOn
      ? { role: "system", content: MOVED_ON_MESSAGE, at: now, questionKey: current ?? undefined, source: "system" }
      : { role: "system", content: SKIPPED_MESSAGE, at: now, questionKey: current ?? undefined, source: "skip" }
    : tapped
      ? { role: "candidate", content: tapped, at: now, questionKey: current ?? undefined, source: "tap" }
      : { role: "candidate", content: input.message, at: now, source: "chat" };
  const transcript: ScreenTranscriptEntry[] = [...screen.transcript, entry];
  // Only a message that is the command itself counts: "Representative at a phone store for two years" is an answer.
  const command = said !== null && !tapped ? screenCommand(input.message, withdrawPending(screen.transcript)) : null;
  const allowance = said !== null && command === null && !screen.progress.countedAt ? await countConversation(q, { companyId: company.id, companyName: company.name, screenId: screen.id }) : null;
  const progress: ScreenProgress = allowance ? { ...screen.progress, countedAt: now } : screen.progress;
  await q.update(screens).set({ transcript, progress }).where(eq(screens.id, screen.id));
  const at = { ...b, screen: { ...screen, transcript, progress } };

  if (command === "confirm_withdraw" || command === "keep_application") {
    const msg = await answerWithdrawPrompt(q, deps, { screenId: screen.id, confirm: command === "confirm_withdraw", actor: input.actor });
    return { kind: "done", result: msg === null ? { kind: "closed", message: closedMessage("cancelled") } : turnReply(msg, { withdrawn: command === "confirm_withdraw" }) };
  }
  if (command === "person") {
    await q.update(screens).set({ transcript: [...transcript, { role: "assistant", content: PERSON_REPLY, at: now, source: "system" }] }).where(eq(screens.id, screen.id));
    return { kind: "done", result: turnReply(PERSON_REPLY) };
  }
  if (command === "withdraw") {
    // Nothing is withdrawn yet: the candidate is asked once, and the answer to that question decides.
    const msg = `Do you want to withdraw your application for ${b.rolePacket.identity.title}? Press "Yes, withdraw my application" below to confirm. To keep your application, just type your answer.`;
    await q.update(screens).set({ transcript: [...transcript, { role: "assistant", content: msg, at: now, questionKey: WITHDRAW_CONFIRM_KEY, source: "system" }] }).where(eq(screens.id, screen.id));
    return { kind: "done", result: turnReply(msg) };
  }
  if (input.skip || tapped) return { kind: "done", result: await answerInCode(q, deps, at, { words: tapped, key: current! }), allowance };
  // A chat cannot call the model for ever (`modelTurnCap`): at the cap it ends without another call.
  if (modelTurnsUsed(transcript) >= modelTurnCap(packet)) return { kind: "done", result: await endAtTurnCap(q, deps, at), allowance };
  return { kind: "pending", b: at, ctx: turnContext(b, plan, at.screen, input.message), allowance };
}

/**
 * A skip (`words` null) or a tapped answer, recorded in code: the skipped question is noted as skipped (not known in the
 * scorecard, never against the candidate), unless it already has an answer, in which case the skip only ends the
 * follow-up and the answer stays; a tap is the answer, word for word. Then the next question in the job's own words, or
 * the end of the questions.
 */
async function answerInCode(q: Queryable, deps: ScreenDeps, b: ScreenBundle, input: { words: string | null; key: string }): Promise<TurnResult> {
  const { screen, company, packet, candidate } = b;
  const answers = { ...screen.answers };
  let progress: ScreenProgress = screen.progress;
  const kept = input.words === null && answers[input.key] !== undefined;
  if (input.words === null) {
    if (!kept) progress = { ...progress, declined: [...new Set([...(progress.declined ?? []), input.key])] };
    await emit(q, { type: "screen.question_skipped", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: input.key, answerKept: kept }, correlationId: screen.workflowRunId });
  } else {
    answers[input.key] = input.words;
    if (progress.declined?.includes(input.key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== input.key) };
    await emit(q, { type: "screen.answer_tapped", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: input.key }, correlationId: screen.workflowRunId });
  }
  const next = nextQuestion(packet, progress, answers);
  if (!next) return writeReply(q, deps, b, { answers, progress: advanceProgress(progress, { ...SILENT_TURN, done: true }), message: "", questionKey: null, done: true, closing: `Thank you, ${candidate.firstName}.` });
  const message = `${chatCodeLead(input.words, kept)}\n\n${next.question}`;
  return writeReply(q, deps, b, { answers, progress: advanceProgress(progress, { ...SILENT_TURN, messageToCandidate: message, questionKey: next.key }), message, questionKey: next.key, done: false });
}

/**
 * The chat's line before the next question when a skip or a tap moved it on, in code: neutral, never praise. A tap is
 * said back in the assistant's voice (`tapEcho`: "Noted: $18 to $20 an hour.", "Noted: you could start on Monday,
 * November 16, 2026."), never in the candidate's own "I'm looking for …". `kept`: the skip ended a follow-up on an answer
 * already given, which stays.
 */
export function chatCodeLead(tapped: string | null, kept = false): string {
  if (tapped !== null) {
    const echo = tapEcho(tapped);
    return echo ? `Noted: ${echo}.` : "Noted.";
  }
  return kept ? "No problem, your answer is kept." : "No problem, we can leave that one.";
}

/**
 * A turn with no model, when the company's AI help is used up, worked out in code. Whatever the candidate typed, they
 * are never stuck and never told: no words about a plan, and they end on "check your answers" as any chat does.
 * - A reply that only asks something or only shows confusion (`onlyQuestions`, `seemsConfused`) is no answer: the
 *   question again in the job's own words, and how to choose a person.
 * - Any other reply is the answer to the current question: every usable reply since it was asked (the caller records it
 *   through `redactProtected`), then the next question in the job's own words, after a plain "Thanks.". A plain "No"
 *   about a must-have records nothing and settles it as not known, as its ladder does in the end: never a "no" for a
 *   skill. About a must-have that names a licence or a certificate it is the answer, as with the model (`ladderApplies`).
 * - No next question: the end of the questions (`done`).
 * Null with no current question: the caller ends the chat as it does at the turn cap.
 */
export function turnWithoutModel(input: { packet: RolePacket; progress: ScreenProgress; answers: Record<string, string>; transcript: ReadonlyArray<ScreenTranscriptEntry>; latest: string }): { turn: ScreenTurn; move: { key: string; move: ChatMove } | null } | null {
  const { packet, progress, answers, transcript, latest } = input;
  const current = progress.currentQuestionKey;
  const question = currentQuestion(packet, progress);
  if (!current || !question) return null;
  const said = usableReplies(replyListSince(transcript, current)).join(" ");
  if (!said || seemsConfused(latest) || onlyQuestions(latest)) {
    return { turn: { ...SILENT_TURN, messageToCandidate: `${question.question}\n\n${PERSON_OFFER}`, sentiment: seemsConfused(latest) ? "confused" : "fine" }, move: null };
  }
  const item = progress.chat?.items.find((i) => i.key === current) ?? null;
  const unknown = item?.kind === "gap" && ladderApplies(packet, item) && saysNotDone(latest);
  const answerRecorded: ScreenTurn["answerRecorded"] = unknown ? null : { questionKey: current, answer: said, complete: true };
  const move = item ? { key: current, move: (unknown ? "unknown" : "covered") as ChatMove } : null;
  // The question being asked is among those asked already, so this is the one after it.
  const next = nextQuestion(packet, progress, answers);
  if (!next) return { turn: { ...SILENT_TURN, messageToCandidate: "", answerRecorded, done: true }, move };
  return { turn: { ...SILENT_TURN, messageToCandidate: `${unknown ? CHAT_CALM_LINE : "Thanks."}\n\n${next.question}`, questionKey: next.key, answerRecorded }, move };
}

/**
 * The chat reached `modelTurnCap` with the candidate's latest message already recorded: it ends the way the end of the
 * questions does, in code, without calling the model again. The candidate checks their answers next, where they can
 * change any of them, answer one still open and press "Send my answers", none of which calls the model.
 */
async function endAtTurnCap(q: Queryable, deps: ScreenDeps, b: ScreenBundle): Promise<TurnResult> {
  const { screen, company, packet } = b;
  await emit(q, { type: "screen.turn_cap_reached", companyId: company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: screen.id }, payload: { modelTurns: modelTurnsUsed(screen.transcript), cap: modelTurnCap(packet) }, correlationId: screen.workflowRunId });
  return writeReply(q, deps, b, { answers: screen.answers, progress: advanceProgress(screen.progress, { ...SILENT_TURN, done: true }), message: "", questionKey: null, done: true, closing: CHAT_CAP_CLOSING });
}

/**
 * Writes the assistant's reply and the recorded answers. At the end of the questions (`done`) the chat says its close
 * (`closing`: one concrete thing from the chat, or a thank-you) and what happens next, and the candidate goes on to
 * "check your answers": nothing is sent until they press "Send my answers".
 */
async function writeReply(q: Queryable, deps: ScreenDeps, b: ScreenBundle, s: { answers: Record<string, string>; progress: ScreenProgress; message: string; questionKey: string | null; done: boolean; aiRunId?: string; closing?: string | null }): Promise<TurnResult> {
  const { screen, company } = b;
  const message = s.done ? chatClosingMessage(s.closing, company.name) : s.message;
  const progress: ScreenProgress = s.done ? { ...s.progress, phase: "review", currentQuestionKey: null } : s.progress;
  const said: ScreenTranscriptEntry = { role: "assistant", content: message, at: nowOf(deps).toISOString(), questionKey: s.questionKey ?? undefined, aiRunId: s.aiRunId, ...(s.aiRunId ? {} : { source: "system" as const }) };
  await q.update(screens).set({ transcript: [...screen.transcript, said], answers: s.answers, progress }).where(eq(screens.id, screen.id));
  return turnReply(message, { review: s.done });
}

/** The marker on the assistant's "do you want to withdraw?" message: while it is the latest assistant message, the next reply decides. */
export const WITHDRAW_CONFIRM_KEY = "withdraw_confirm";

export type ScreenCommand = "person" | "withdraw" | "confirm_withdraw" | "keep_application";

/**
 * The keyword commands of the chat. Only a message that is the command itself counts, so an answer that happens to
 * start with "Representative" or "Withdraw" is recorded as an answer. The plain request "talk to a person" counts
 * wherever it appears. While a withdrawal waits for confirmation, CONFIRM (or YES, or WITHDRAW again) confirms it and NO
 * keeps the application; anything else is an ordinary answer and the question lapses.
 */
export function screenCommand(message: string, pendingWithdraw = false): ScreenCommand | null {
  const m = message.trim();
  if (pendingWithdraw) {
    if (/^(confirm|yes|y|withdraw)[.!]?$/i.test(m)) return "confirm_withdraw";
    if (/^(no|nope|keep|keep going|keep it|keep my application)[.!]?$/i.test(m)) return "keep_application";
  }
  if (/^(human|person|a person|a human|agent|representative)[.!]?$/i.test(m) || /\b(talk|speak) (to|with) a (real )?(person|human)\b/i.test(m)) return "person";
  if (/^withdraw( my application)?[.!]?$/i.test(m)) return "withdraw";
  return null;
}

/** Whether the chat is waiting for the candidate to confirm a withdrawal: the latest assistant message asked. */
export function withdrawPending(transcript: ScreenTranscriptEntry[]): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) if (transcript[i].role === "assistant") return transcript[i].questionKey === WITHDRAW_CONFIRM_KEY;
  return false;
}

/** What the chat says once a withdrawal is confirmed. A withdrawn application cannot be reopened, so it promises nothing about changing their mind. */
export function withdrawnMessage(roleTitle: string): string {
  return `Understood, we have withdrawn your application for ${roleTitle}. Thank you for your time.`;
}

/**
 * The candidate's answer to "do you want to withdraw?": a CONFIRM reply or the page's button withdraws the application
 * (`deps.withdraw`: the interview closes with it); NO or the page's other button keeps it and picks up where the chat
 * was. An interview that is no longer open is left alone (null). Returns the message the candidate is shown.
 */
export async function answerWithdrawPrompt(q: Queryable, deps: ScreenDeps, input: { screenId: string; confirm: boolean; actor: Actor }): Promise<string | null> {
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !ACTIVE_STATUSES.has(b.screen.status)) return null;
  const { screen, app, candidate, company, packet } = b;
  const at = nowOf(deps).toISOString();
  const current = currentQuestion(packet, screen.progress);
  const msg = input.confirm ? withdrawnMessage(b.rolePacket.identity.title) : `No problem, your application stays active.${current ? ` Here is where we were: ${current.question}` : ""}`;
  await q.update(screens).set({ transcript: [...screen.transcript, { role: "assistant", content: msg, at, source: "system" }] }).where(eq(screens.id, screen.id));
  if (input.confirm) await deps.withdraw(q, { companyId: company.id, applicationId: app.id, actor: { kind: "candidate", id: candidate.id } });
  return msg;
}

/**
 * The second transaction of a turn: holds the model's turn to the rules, records the answer and writes the reply. When
 * the model could not be reached the candidate's message is taken back out of the record and they are asked to send it
 * again (`TURN_FAILED_MESSAGE`): nothing pauses and nobody is told. With no AI help left nothing failed: the chat
 * carries on in the job's own words (`turnWithoutModel`).
 */
export async function finishScreenTurn(q: Queryable, deps: ScreenDeps, input: TurnInput, pending: Extract<BegunTurn, { kind: "pending" }>, out: RunOutcome<ScreenTurn>): Promise<TurnResult> {
  const { candidate, company, packet } = pending.b;
  const [fresh] = await q.select().from(screens).where(eq(screens.id, pending.b.screen.id)).limit(1);
  if (!fresh) return { kind: "error", message: "This conversation is no longer available." };
  const b: ScreenBundle = { ...pending.b, screen: fresh };
  if (!out.ok && !outOfCredit(out)) {
    const last = fresh.transcript.at(-1);
    const transcript = last?.role === "candidate" && last.content === input.message ? fresh.transcript.slice(0, -1) : fresh.transcript;
    const failures = (fresh.progress.failures ?? 0) + 1;
    await q.update(screens).set({ transcript, progress: { ...fresh.progress, failures } }).where(eq(screens.id, fresh.id));
    await emit(q, { type: "ai.run_failed", companyId: company.id, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: fresh.id }, payload: { reason: out.reason, error: out.error, failures }, correlationId: fresh.workflowRunId });
    return { kind: "error", message: TURN_FAILED_MESSAGE };
  }
  const enforced = out.ok
    ? enforceChatTurn(out.output, packet, fresh.progress, fresh.answers, { transcript: fresh.transcript, latest: input.message })
    : turnWithoutModel({ packet, progress: fresh.progress, answers: fresh.answers, transcript: fresh.transcript, latest: input.message });
  if (!enforced) return endAtTurnCap(q, deps, b);
  const { turn } = enforced;
  const answers = { ...fresh.answers };
  if (turn.answerRecorded) answers[turn.answerRecorded.questionKey] = redactProtected(turn.answerRecorded.answer);
  // The run that wrote this turn: none when it was worked out in code, which counts toward no cap.
  const aiRunId = out.ok ? out.runId : undefined;
  const closing = !turn.done ? null : turn.messageToCandidate.trim() || `Thank you, ${candidate.firstName}.`;
  return writeReply(q, deps, b, { answers, progress: advanceProgress(fresh.progress, turn, enforced.move), message: turn.messageToCandidate, questionKey: turn.questionKey, done: turn.done, aiRunId, closing });
}

/** One candidate message in, one assistant message out, with the model called between two short transactions. */
export async function runScreenTurn(db: Db, companyId: string, deps: ScreenDeps, input: TurnInput): Promise<TurnResult> {
  const begun = await withTenant(db, companyId, (q) => beginScreenTurn(q, deps, input));
  if (begun.kind === "done") {
    await flagAllowance(db, begun.allowance);
    return begun.result;
  }
  const out = await runPromptDetached(db, deps.ai, screenTurnPrompt, begun.ctx, { companyId, workflowRunId: begun.b.screen.workflowRunId, inputRef: { screenId: input.screenId, turn: begun.b.screen.transcript.length } });
  const result = await withTenant(db, companyId, (q) => finishScreenTurn(q, deps, input, begun, out));
  await flagAllowance(db, begun.allowance);
  return result;
}

/**
 * "I'd rather talk to a person": the candidate chose not to do the AI interview. It closes as their choice
 * (`declined_by_candidate`), the team is told once, and the team decides from there: the application stays where it is.
 * Nothing they typed was sent, so the team reads none of it. No promise that anyone will call. Null when the interview
 * is no longer open.
 */
export async function optOutOfScreen(q: Queryable, deps: ScreenDeps, input: { screenId: string }): Promise<{ message: string } | null> {
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  const b = await loadScreenBundle(q, input.screenId);
  if (!b || !ACTIVE_STATUSES.has(b.screen.status)) return null;
  const { screen, app, candidate, company } = b;
  const now = nowOf(deps).toISOString();
  const title = b.rolePacket.identity.title;
  const message = `Thanks, ${candidate.firstName}. The hiring team at ${company.name} has been told that you would rather talk to a person than do the AI interview. Nothing you typed here was sent to them. People on the team make every decision.`;
  await q.update(screens).set({ status: "declined_by_candidate", completedAt: now, transcript: [...screen.transcript, { role: "assistant", content: message, at: now, source: "system" }] }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.declined_by_candidate", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { applicationId: app.id }, correlationId: screen.workflowRunId });
  await notify(q, { companyId: company.id, about: app.id, kind: "screen.declined_by_candidate", title: `${candidate.firstName} ${candidate.lastName} chose not to do the AI interview`, body: `They would rather talk to a person about ${title}. Nothing they typed in the interview was sent, so it stays private. What happens next is yours to decide.`, action: { label: "Open the candidate", href: appPaths.candidate(app.roleId, app.id) } });
  await deps.signal(q, { companyId: company.id, key: screenSignalKey(screen.id) });
  return { message };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Check your answers, and Send                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The "check your answers" page: each of the job's interview questions in order with its answer and how it came to be,
 * then every other answer the chat recorded and will send (about a must-have, and the closing question), so the
 * candidate checks and can change all of what goes to the team. A must-have settled as not known recorded nothing and
 * is not listed.
 */
export function reviewItems(screen: Pick<ScreenRow, "answers" | "progress">, packet: RolePacket): ReviewItem[] {
  const declined = new Set(screen.progress.declined ?? []);
  const edits = screen.progress.edits ?? {};
  const own = new Set((screen.progress.chat?.items ?? []).filter((i) => i.kind === "question").map((i) => i.key));
  return chatPacket(packet, screen.progress).screening.questions.filter((q) => own.has(q.key) || screen.answers[q.key] !== undefined).map((q) => {
    const answer = screen.answers[q.key] ?? null;
    const status = answer !== null ? ((edits[q.key] ?? 0) > 0 ? "edited" : "answered") : declined.has(q.key) ? "declined" : "unanswered";
    return { key: q.key, question: q.question, answer, status, tap: tapFormatFor(q, packet.compensation) };
  });
}

/**
 * An answer changed (or a skipped question answered) on the "check your answers" page. The new words are added to the
 * transcript, so the scorecard's quote check covers them, and the earlier answer stays in the record.
 */
export async function editScreenAnswer(q: Queryable, input: { screenId: string; questionKey: string; text?: string | null; tap?: TapAnswer | null; now?: Date }): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
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
  const progress = syncedChat({ ...screen.progress, edits: { ...(screen.progress.edits ?? {}), [question.key]: (screen.progress.edits?.[question.key] ?? 0) + 1 }, declined: screen.progress.declined?.filter((k) => k !== question.key) });
  const entry: ScreenTranscriptEntry = { role: "candidate", content: words, at: now.toISOString(), questionKey: question.key, source: "edit" };
  await q.update(screens).set({ transcript: [...screen.transcript, entry], answers: { ...screen.answers, [question.key]: recorded }, progress }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.answer_edited", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { questionKey: question.key, tapped: !!tapped }, correlationId: screen.workflowRunId });
  return { ok: true, answer: recorded };
}

/**
 * "Send my answers", pressed by the candidate on the "check your answers" page, and by nothing else: the interview is
 * complete, the team may read it from now on, the application moves to Interviewed at once, and the workflow writes the
 * scorecard. The row is locked first, so two presses at once send it once.
 */
export async function submitScreenAnswers(q: Queryable, deps: ScreenDeps, input: { screenId: string; actor: Actor }): Promise<{ ok: boolean }> {
  await q.select({ id: screens.id }).from(screens).where(eq(screens.id, input.screenId)).for("update");
  const b = await loadScreenBundle(q, input.screenId);
  if (!b) return { ok: false };
  const { screen, app, candidate, company, packet } = b;
  if (screen.status === "completed") return { ok: true };
  if (screen.status !== "in_progress" || screen.progress.phase !== "review") return { ok: false };
  const now = nowOf(deps).toISOString();
  await q.update(screens).set({ status: "completed", completedAt: now, progress: { ...screen.progress, submittedAt: now } }).where(eq(screens.id, screen.id));
  await emit(q, { type: "screen.completed", companyId: company.id, actor: { kind: "candidate", id: candidate.id }, subject: { type: "screen", id: screen.id }, payload: { applicationId: app.id, questionsAnswered: Object.keys(screen.answers).length, questions: packet.screening.questions.length, skipped: screen.progress.declined?.length ?? 0 }, correlationId: screen.workflowRunId });
  if (app.stage === "screen_invited" || app.stage === "screening") await transition(q, { applicationId: app.id, companyId: company.id, to: "screen_complete", by: "system", actor: input.actor, correlationId: screen.workflowRunId });
  await deps.signal(q, { companyId: company.id, key: screenSignalKey(screen.id) });
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Where the chat stands                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** The progress after a turn. The plan moves on with it (`syncChatPlan`): `move` is the step the turn took on the item it was about (`enforceChatTurn`). */
export function advanceProgress(progress: ScreenProgress, turn: ScreenTurn, move?: { key: string; move: ChatMove } | null): ScreenProgress {
  const askedKeys = turn.questionKey && !progress.askedKeys.includes(turn.questionKey) ? [...progress.askedKeys, turn.questionKey] : progress.askedKeys;
  const followUps = { ...progress.followUps };
  if (turn.followUpReason && !turn.questionKey && progress.currentQuestionKey) followUps[progress.currentQuestionKey] = (followUps[progress.currentQuestionKey] ?? 0) + 1;
  const currentQuestionKey = turn.done ? null : turn.questionKey ?? progress.currentQuestionKey;
  return {
    // What the turn does not touch (skips, edits, the allowance count) carries over.
    ...progress,
    askedKeys,
    currentQuestionKey,
    followUps,
    confusedTurns: turn.sentiment === "confused" ? progress.confusedTurns + 1 : 0,
    failures: 0,
    ...(progress.chat ? { chat: syncChatPlan(progress.chat, { askedKeys, currentQuestionKey, declined: progress.declined }, move) } : {}),
  };
}

/** The plan after something done in code (a skip, an answer changed): in step with the progress as it is now. */
export function syncedChat(progress: ScreenProgress): ScreenProgress {
  return progress.chat ? { ...progress, chat: syncChatPlan(progress.chat, progress) } : progress;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The scorecard                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** One question the interview asked, as the scorecard and the team's views take it. `mustHave`: the must-have it asked about. */
export type AskedQuestion = { key: string; question: string; standard?: string; mustHave?: string; skipped: boolean };

/**
 * The questions the interview asked, in the order of its plan: every one of the job's interview questions, and each
 * must-have the chat got to. Never the closing question. The interview score has one entry for each
 * (`interviewScoreFromScorecard` in @ros/core). `skipped`: the candidate pressed Skip and gave no answer since.
 */
export function askedQuestions(screen: Pick<ScreenRow, "progress" | "answers">, rolePacket: RolePacket): AskedQuestion[] {
  const plan = screen.progress.chat;
  if (!plan) return [];
  const asked = new Set(screen.progress.askedKeys);
  const declined = new Set(screen.progress.declined ?? []);
  const must = new Map(rolePacket.requirements.mustHaves.map((m) => [m.key, m.text]));
  const questions = new Map(chatPacket(rolePacket, screen.progress).screening.questions.map((q) => [q.key, q]));
  return plan.items.flatMap((item) => {
    const q = questions.get(item.key);
    if (!q || (item.kind === "gap" && !asked.has(item.key))) return [];
    return [{ key: q.key, question: q.question, ...(q.modelAnswer ? { standard: q.modelAnswer } : {}), ...(item.kind === "gap" ? { mustHave: must.get(item.key) ?? "" } : {}), skipped: declined.has(q.key) && screen.answers[q.key] === undefined }];
  });
}

/**
 * What the candidate said, for the quote check: their own messages as they sent them (typed, tapped, or changed on
 * "check your answers"). Never the answers as the assistant recorded them: those can leave a personal sentence out, so a
 * quote of one counts only where the candidate's own messages have it (`saidByCandidate`).
 */
export function candidateWordsOf(screen: Pick<ScreenRow, "transcript">): string {
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

/**
 * What the scorecard is given: the questions asked, and the conversation and the answers as the scoring view shows them
 * (the candidate's name, email, phone, street address and links replaced by placeholders in every line). Returns the
 * scoring view too, to map quotes back and count what was hidden.
 */
export function scorecardInput(b: Pick<ScreenBundle, "screen" | "candidate" | "company" | "rolePacket" | "app">): { ctx: ScorecardContext; view: ScoringView } {
  const { screen, candidate, rolePacket } = b;
  // the job's own words are never hidden as a single name (a candidate called Austin keeps "Austin, TX")
  const view = scoringView({ firstName: candidate.firstName, lastName: candidate.lastName, email: candidate.email, phone: candidate.phone, fullName: b.app.extraction?.fullName ?? null, keep: jobWords(rolePacket, b.app.extraction) });
  const ctx: ScorecardContext = {
    company: { name: b.company.name },
    packet: rolePacket,
    asked: askedQuestions(screen, rolePacket),
    transcript: screen.transcript.map((t) => ({ ...t, content: view.text(t.content) })),
    answers: Object.fromEntries(Object.entries(screen.answers).map(([k, v]) => [k, view.text(v)])),
  };
  return { ctx, view };
}

/** How many times a sent AI interview is read for its scorecard: as many as the CV (`TRIAGE_READINGS`). */
export const SCORECARD_READINGS = TRIAGE_READINGS;

/**
 * The scorecard of an AI interview, called with no transaction open. Only an interview the candidate sent is ever read.
 * It is read `SCORECARD_READINGS` times side by side and the middle answer of each question kept (`scorecardReadings`);
 * a reading lost to an outage is asked once more, and one still lost fails the step, which the engine retries. Every run
 * is linked to the one the stored scorecard keeps (`linkReadingRuns`). The readings ask the AI help together: with no
 * room for all of them none is made, and the caller waits for it.
 */
export async function assessScreen(db: Db, ai: AiRuntime, input: { companyId: string; screenId: string; workflowRunId?: string | null }): Promise<RunOutcome<ScreenAssessment>> {
  const b = await withTenant(db, input.companyId, (q) => loadScreenBundle(q, input.screenId));
  if (!b) throw new Error("screen not found");
  if (!screenAnswersSent(b.screen)) throw new Error(`an AI interview the candidate did not send is never read (it is ${b.screen.status})`);
  const { ctx, view } = scorecardInput(b);
  const meta = (reading: number): RunMeta => ({ companyId: b.company.id, workflowRunId: input.workflowRunId ?? b.screen.workflowRunId, inputRef: { screenId: b.screen.id, turns: b.screen.transcript.length, scoringView: SCORING_VIEW_VERSION, hidden: view.counts(), reading } });
  const runs = await runPromptsDetached(db, ai, screenAssessPrompt, ctx, Array.from({ length: SCORECARD_READINGS }, (_, i) => meta(i + 1)));
  const settled = await Promise.all(runs.map((r, i) => (!r.ok && r.reason === "error" ? runPromptDetached(db, ai, screenAssessPrompt, ctx, meta(i + 1)) : r)));
  const noCredit = settled.find(outOfCredit);
  if (noCredit) return noCredit;
  const outage = settled.find((r) => !r.ok && r.reason === "error");
  if (outage) return outage;
  const out = scorecardReadings(settled, view, b.screen, ctx.asked);
  await linkReadingRuns(db, b.company.id, out, settled);
  return out;
}

const MEETS_ORDER = ["no", "unknown", "partially", "yes"] as const;
type QuestionFinding = ScreenAssessment["questionFindings"][number];

/**
 * The scorecard readings as the team sees them: each through `scorecardOutcome` (one finding for each question asked,
 * quotes mapped back and checked), then, with all of them back, the middle answer for each question, with the finding of
 * a reading that gave it, and the words (summary, strengths, concerns, open questions) of the reading that agrees with
 * the most middle answers. Fewer usable readings: the first. The same whatever order they came back in.
 */
export function scorecardReadings(readings: ReadonlyArray<RunOutcome<ScreenAssessment>>, view: Pick<ScoringView, "restore">, screen: Pick<ScreenRow, "transcript" | "answers">, asked: readonly AskedQuestion[]): RunOutcome<ScreenAssessment> {
  const ok = readings.filter((r): r is Extract<RunOutcome<ScreenAssessment>, { ok: true }> => r.ok);
  if (!ok.length) return readings.find((r): r is Extract<RunOutcome<ScreenAssessment>, { ok: false }> => !r.ok && r.reason === "error") ?? readings[0]!;
  const cards = ok.map((r) => scorecardOutcome(r.output, view, screen, asked));
  if (cards.length < SCORECARD_READINGS) return { ...ok[0]!, output: cards[0]! };
  const of = (card: ScreenAssessment, key: string) => card.questionFindings.find((f) => f.questionKey === key);
  const meets = new Map(asked.map((a) => [a.key, middle(cards.map((c) => of(c, a.key)?.meetsModelAnswer ?? "unknown"), MEETS_ORDER)]));
  const agreement = (c: ScreenAssessment) => asked.filter((a) => (of(c, a.key)?.meetsModelAnswer ?? "unknown") === meets.get(a.key)).length;
  const ranked = [...cards].sort((x, y) => agreement(y) - agreement(x) || JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const questionFindings = asked.flatMap((a): QuestionFinding[] => {
    const found = ranked.map((c) => of(c, a.key)).find((f) => f?.meetsModelAnswer === meets.get(a.key));
    return found ? [found] : [];
  });
  return { ...ok[0]!, output: { ...ranked[0]!, questionFindings } };
}

/**
 * One scorecard as the team sees it, from the model's answer. Quotes are checked against the candidate's ORIGINAL words:
 * one written around a placeholder is mapped back first, and the model's own words keep no placeholder ("[name]" reads
 * "the candidate"). Then the evidence rules:
 * - one finding for each question asked and for nothing else (never the closing question): one the model left out is
 *   not known; whether a question was answered is read from the record, not from the model;
 * - a question the candidate skipped, or gave no answer to, is not known, whatever the model wrote;
 * - a quote that is not in what the candidate sent is taken off; "yes" with no checked quote counts as "partially", and
 *   "no" stands only on their own checked words, otherwise it is not known;
 * - the licence rule (`credentialFinding`), for a question about a must-have that names a licence, certificate, permit
 *   or registration, read from the candidate's line around the quote: "no" only when they say plainly they do not hold
 *   it, whatever the model answered; lapsed, expired, pending or unclear is not known;
 * - a strength or a concern whose quote is not theirs is dropped (`checkedClaims`).
 * Shared with the evals (packages/evals), so they check exactly what the app does after the model has answered.
 */
export function scorecardOutcome(output: ScreenAssessment, view: Pick<ScoringView, "restore">, screen: Pick<ScreenRow, "transcript" | "answers">, asked: readonly AskedQuestion[]): ScreenAssessment {
  const candidateText = candidateWordsOf(screen);
  const card = withoutPlaceholders(restoreQuotes(output, view, () => [candidateText]));
  const questionFindings = asked.map((a): QuestionFinding => {
    if (a.skipped) return { questionKey: a.key, answered: false, finding: "Skipped by the candidate.", meetsModelAnswer: "unknown" };
    const f = card.questionFindings.find((x) => x.questionKey === a.key);
    const answered = screen.answers[a.key] !== undefined;
    if (!f) return { questionKey: a.key, answered, finding: "", meetsModelAnswer: "unknown" };
    const quote = f.evidence?.quote?.trim() && saidByCandidate(f.evidence.quote, candidateText) ? f.evidence.quote : null;
    const read = f.meetsModelAnswer === "yes" && !quote ? "partially" : f.meetsModelAnswer === "no" && !quote ? "unknown" : f.meetsModelAnswer;
    const meets = quote && a.mustHave && namesCredential(a.mustHave) ? credentialFinding(read, sentenceAround(quote, candidateText) ?? quote, a.mustHave) : read;
    return { questionKey: a.key, answered, finding: f.finding, meetsModelAnswer: answered ? meets : "unknown", ...(quote ? { evidence: { source: "screen" as const, quote } } : {}) };
  });
  const inSource = (e: { quote?: string }) => saidByCandidate(e.quote ?? "", candidateText);
  return { ...card, strengths: checkedClaims(card.strengths, inSource), concerns: checkedClaims(card.concerns, inSource), questionFindings };
}
