import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { candidateScoreShown, type ApplicationStage, type CandidateScoreView, type RolePacket, type ScreenProgress, type ScreenTranscriptEntry, type WriteupAnswer } from "@ros/contracts";
import { DECISION_STAGES, applicationAnswerSentences, candidateScoreView, candidateStep, interviewInScore, matchScore, openingQuestionsOf, readingPair, screenAnswersOf, screenAnswersSent, unsentScreenReadings, writtenQuestionsOf } from "@ros/core";
import { chatPacket } from "@ros/agents";
import { applications, assessments, rolePackets, roles, screens, type Tx } from "@ros/db";

/**
 * What the candidate's application record shows beyond its steps (Wave S7, slice S7-E; spec-s7-apply-flow.md steps 8, 9
 * and 11): the match score after sending (founder decision S7-1, behind the ITS switch), the answers they sent read back
 * (S7-2), and their other applications at the same company. Everything is read in the company's transaction and only
 * from what the team may see: never a reading of a chat they did not send, never the team's notes, never a private
 * decision.
 */

type AppRow = typeof applications.$inferSelect;
type ScreenRow = typeof screens.$inferSelect;

/** How long after sending the record says the score is being worked out (with a "Check again" link) while the reading is written. */
export const REVIEWING_WINDOW_MS = 10 * 60_000;
/** Kept for readers of the earlier contract: the record no longer reloads itself (a timed reload loses what a candidate types). */
export const REVIEWING_REFRESH_SECONDS = 15;

/**
 * Where the match score stands on the record:
 * - `off`: ITS switched the score off for this company (or it never shows, see below): nothing is said about it.
 * - `after_chat`: a screening chat is open or paused: the score waits until they send it (a reading of an unsent chat
 *   never counts). A chat a private decision cancelled reads the same as before, so nothing hints at the decision.
 * - `reviewing`: sent a moment ago and the reading is not written yet: "Working out your match score…", with "Check again".
 * - `not_ready`: no score after the reviewing window (the reading failed, or a résumé could not be read).
 * - `ready`: the score and its breakdown (`view`).
 */
export type RecordScore = { state: "off" | "after_chat" | "reviewing" | "not_ready" | "ready"; view: CandidateScoreView | null };

const OPEN_SCREEN = ["invited", "reminded", "in_progress", "paused"];

/** The packet of a version of the role, or null. */
export async function packetOf(tx: Tx, roleId: string, version: number): Promise<RolePacket | null> {
  const [row] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, version))).limit(1);
  return row?.packet ?? null;
}

/**
 * The record's score (founder decision S7-1): the team's own match score (core/match-score.ts) as the candidate sees it
 * (`candidateScoreView`: only the job page's must-haves named, everything else folded into one line), from the readings
 * the team may see, against the version of the role they were read against. `hiddenDecision`: a private decision the
 * candidate was not told (founder decision B6); a chat it cancelled still reads as waiting for the chat.
 */
export async function recordScoreFor(tx: Tx, input: { app: AppRow; companySettings: unknown; screens: readonly ScreenRow[]; hiddenDecision: boolean; now: Date }): Promise<RecordScore> {
  if (!candidateScoreShown(input.companySettings)) return { state: "off", view: null };
  const { app } = input;
  const last = input.screens[0];
  const chatOpen = !!last && (OPEN_SCREEN.includes(last.status) || (input.hiddenDecision && last.status === "cancelled"));
  if (chatOpen) return { state: "after_chat", view: null };
  const rows = await tx.select().from(assessments).where(eq(assessments.applicationId, app.id)).orderBy(desc(assessments.createdAt));
  const hidden = unsentScreenReadings(input.screens, rows);
  const own = rows.filter((r) => !hidden.has(r.id));
  const latest = own.find((r) => r.id === app.latestAssessmentId) ?? own[0] ?? null;
  const readAgainst = latest?.packetVersion ?? app.packetVersion;
  const packet = (await packetOf(tx, app.roleId, readAgainst)) ?? (readAgainst !== app.packetVersion ? await packetOf(tx, app.roleId, app.packetVersion) : null);
  // Labelled with where their AI interview stands (R20-9): "From your résumé only" until its scorecard is in.
  const match = packet && own.length ? matchScore(readingPair(own), packet, { packetVersion: readAgainst, interview: interviewInScore(input.screens, app.stage) }) : null;
  const view = packet ? candidateScoreView(match, packet) : null;
  // A chat sent a moment ago whose scorecard is not written yet: the score is about to change, so it waits for it.
  const sent = last && screenAnswersSent(last) ? last : null;
  const scorecardDue = !!sent && !sent.assessmentId;
  const since = Date.parse(sent?.completedAt ?? app.createdAt);
  const recent = input.now.getTime() - since < REVIEWING_WINDOW_MS;
  if ((scorecardDue || !view) && recent) return { state: "reviewing", view: null };
  return view ? { state: "ready", view } : { state: "not_ready", view: null };
}

/** One answer from the chat as it was sent: the question in the company's words, the answer, and how it came to be. */
export type SentChatAnswer = { key: string; question: string; answer: string | null; mark: "skipped" | "changed" | "not_given" | null; note: string | null };
/** One line of the chat as it was sent, for the "word for word" fold: the assistant's and the candidate's own. */
export type SentChatLine = { who: "assistant" | "candidate"; text: string; at: string };
/** What the candidate sent (founder decision S7-2): the form's questions as sentences, and the chat they sent. */
export type SentAnswers = { questions: string[]; chat: { sentAt: string | null; answers: SentChatAnswer[]; lines: SentChatLine[] } | null };

/** A written-up answer as the record shows it: the candidate's own words; the assistant's note kept apart. */
function fromWriteup(q: { key: string; question: string }, w: WriteupAnswer | undefined): SentChatAnswer {
  if (!w) return { key: q.key, question: q.question, answer: null, mark: "not_given", note: null };
  const answer = w.answer.trim() || null;
  const mark = w.status === "skipped" ? "skipped" : w.by === "candidate" ? "changed" : !answer ? "not_given" : null;
  return { key: q.key, question: q.question, answer, mark, note: w.note?.trim() || null };
}

/**
 * The chat's answers as they were sent: the write-up (Review & send, Wave S7) when there is one, one answer per written
 * question; otherwise each question with the answer recorded in the chat, skipped and changed ones marked. The opening
 * questions a chat started with follow, with their answers. Never a recruiter's call notes.
 */
export function sentChatAnswers(packet: Pick<RolePacket, "screening" | "companyQuestions">, screen: { answers: Record<string, string>; progress: ScreenProgress }): SentChatAnswer[] {
  const written = writtenQuestionsOf(packet);
  const opening = openingQuestionsOf(screen.progress);
  const writeup = screen.progress.writeup;
  const recorded = screenAnswersOf(screen);
  const declined = new Set(screen.progress.declined ?? []);
  const edits = screen.progress.edits ?? {};
  const asRecorded = (q: { key: string; question: string }): SentChatAnswer => {
    const answer = recorded[q.key]?.trim() || null;
    const mark = declined.has(q.key) && !answer ? "skipped" : (edits[q.key] ?? 0) > 0 ? "changed" : !answer ? "not_given" : null;
    return { key: q.key, question: q.question, answer, mark, note: null };
  };
  const main = writeup ? written.map((q) => fromWriteup(q, writeup.answers.find((a) => a.questionKey === q.key))) : written.map(asRecorded);
  const seen = new Set(main.map((a) => a.key));
  const openingAnswers = opening.filter((q) => !seen.has(q.key)).map(asRecorded);
  for (const a of openingAnswers) seen.add(a.key);
  // A Kanvis-style chat also sent what it recorded about the CV and the closing answer: read back too, in the chat's order.
  const asked = screen.progress.chat ? chatPacket(packet as RolePacket, screen.progress).screening.questions : [];
  const chatAnswers = asked.filter((q) => !seen.has(q.key) && !!recorded[q.key]?.trim()).map(asRecorded);
  return [...main, ...openingAnswers, ...chatAnswers];
}

/** The chat's own lines: the assistant's and the candidate's, in order; system lines and a recruiter's notes left out. */
function chatLines(transcript: readonly ScreenTranscriptEntry[]): SentChatLine[] {
  return transcript.filter((t) => (t.role === "assistant" || t.role === "candidate") && t.content.trim()).map((t) => ({ who: t.role === "candidate" ? "candidate" : "assistant", text: t.content.trim(), at: t.at }));
}

/**
 * What the candidate sent, read back (founder decision S7-2): the form's questions in the one wording every reader uses
 * (`applicationAnswerSentences`), and the newest chat they sent (`screenAnswersSent`: completed by their own Send, never
 * one closed by a recruiter's call). Answers they did not send never show; nor does anything the team wrote.
 */
export function sentAnswersFor(input: { app: Pick<AppRow, "answers">; packet: RolePacket | null; screens: readonly ScreenRow[] }): SentAnswers {
  const { packet } = input;
  if (!packet) return { questions: [], chat: null };
  const questions = applicationAnswerSentences(packet, input.app.answers).map((s) => s.sentence);
  const sent = input.screens.find((s) => screenAnswersSent(s));
  const chat = sent ? { sentAt: sent.progress.submittedAt ?? sent.completedAt ?? null, answers: sentChatAnswers(packet, sent), lines: chatLines(sent.transcript) } : null;
  return { questions, chat };
}

/** Where another application at the same company stands, in the pills of the record (spec step 11). */
export type OtherApplicationState = "needs_you" | "waiting" | "closed";
export const OTHER_APPLICATION_LABEL: Record<OtherApplicationState, string> = { needs_you: "Needs you", waiting: "Waiting", closed: "Closed" };
/**
 * Another application at the company as the record lists it: never its private link nor its chat's (one forwarded link
 * must open only its own application; each other one is opened from its own email, or by "Lost your link?").
 */
export type OtherApplication = { id: string; roleTitle: string; appliedAt: string; state: OtherApplicationState };

/**
 * The state of another application, without a hint of a private decision: Closed only once the candidate knows it is
 * (told, or their own act: withdrawn, an offer, hired); Needs you while a screening chat waits for them; Waiting
 * otherwise. Marks and holds are never read.
 */
export function otherApplicationState(app: { stage: ApplicationStage; toldState: string }, openChat: boolean): OtherApplicationState {
  const step = candidateStep(app.stage, app.toldState);
  if (step === "decision" && !["offer_sent", "negotiation", "accepted", "onboarding"].includes(app.stage)) return "closed";
  return openChat ? "needs_you" : "waiting";
}

/**
 * The candidate's other applications at this company (spec step 11; D-01 revised: one record per person per company,
 * never across companies), newest first, each with its pill. No link to any of them is given here (`OtherApplication`).
 * A private decision (founder decision B6) cancels that application's open chat: its pill stays as it was before the
 * decision ("Needs you"), as the application's own page keeps a cancelled chat looking open, so nothing hints at it.
 */
export async function otherApplicationsFor(tx: Tx, input: { companyId: string; candidateId: string; exceptId: string }): Promise<OtherApplication[]> {
  const rows = await tx
    .select({ id: applications.id, stage: applications.stage, toldState: applications.toldState, createdAt: applications.createdAt, title: roles.title })
    .from(applications)
    .innerJoin(roles, eq(roles.id, applications.roleId))
    .where(and(eq(applications.companyId, input.companyId), eq(applications.candidateId, input.candidateId), ne(applications.id, input.exceptId)))
    .orderBy(desc(applications.createdAt));
  if (!rows.length) return [];
  const all = await tx.select({ applicationId: screens.applicationId, status: screens.status, createdAt: screens.createdAt }).from(screens).where(inArray(screens.applicationId, rows.map((r) => r.id))).orderBy(desc(screens.createdAt));
  return rows.map((r) => {
    const latest = all.find((s) => s.applicationId === r.id);
    const hiddenDecision = DECISION_STAGES.includes(r.stage) && candidateStep(r.stage, r.toldState) !== "decision";
    const openChat = !!latest && (OPEN_SCREEN.includes(latest.status) || (hiddenDecision && latest.status === "cancelled"));
    return { id: r.id, roleTitle: r.title, appliedAt: r.createdAt, state: otherApplicationState({ stage: r.stage, toldState: r.toldState }, openChat) };
  });
}

/** The application's screens, newest first, read once for the score and the read-back. */
export function screensOf(tx: Tx, applicationId: string): Promise<ScreenRow[]> {
  return tx.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt));
}
