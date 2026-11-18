import { and, desc, eq } from "drizzle-orm";
import type { RolePacket, ScreenTranscriptEntry } from "@ros/contracts";
import { formAnswerSentences, formAnswersOf, screenAnswersSent } from "@ros/core";
import { chatPacket } from "@ros/agents";
import { rolePackets, screens, type Tx, type applications } from "@ros/db";

/**
 * What the candidate's status page shows beyond its steps: the answers they sent, read back to them. Their own words
 * only: never a score, a finding, the team's notes or a private decision, and never answers they did not send.
 */

type AppRow = typeof applications.$inferSelect;
type ScreenRow = typeof screens.$inferSelect;

/** The job record of one version of a job, or null. */
export async function packetOf(tx: Tx, roleId: string, version: number): Promise<RolePacket | null> {
  const [row] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, version))).limit(1);
  return row?.packet ?? null;
}

/** One answer of the AI interview as it was sent: the question in the company's words, the answer, and how it came to be. */
export type SentChatAnswer = { key: string; question: string; answer: string | null; mark: "skipped" | "changed" | "not_given" | null };
/** One line of the chat as it was sent, for the "word for word" fold: the assistant's and the candidate's own. */
export type SentChatLine = { who: "assistant" | "candidate"; text: string; at: string };
/** What the candidate sent: the form's answers as sentences, and the AI interview they sent. */
export type SentAnswers = { questions: string[]; chat: { sentAt: string | null; answers: SentChatAnswer[]; lines: SentChatLine[] } | null };

/**
 * The AI interview's answers as they were sent: each of the job's interview questions with the answer recorded (skipped
 * and changed ones marked), then whatever else the chat recorded and sent (about a must-have, and the closing answer).
 */
export function sentChatAnswers(packet: RolePacket, screen: Pick<ScreenRow, "answers" | "progress">): SentChatAnswer[] {
  const declined = new Set(screen.progress.declined ?? []);
  const edits = screen.progress.edits ?? {};
  const own = new Set((screen.progress.chat?.items ?? []).filter((i) => i.kind === "question").map((i) => i.key));
  return chatPacket(packet, screen.progress).screening.questions.filter((q) => own.has(q.key) || !!screen.answers[q.key]?.trim()).map((q) => {
    const answer = screen.answers[q.key]?.trim() || null;
    return { key: q.key, question: q.question, answer, mark: declined.has(q.key) && !answer ? "skipped" : (edits[q.key] ?? 0) > 0 ? "changed" : !answer ? "not_given" : null };
  });
}

/** The chat's own lines: the assistant's and the candidate's, in order; the system's notes left out. */
function chatLines(transcript: readonly ScreenTranscriptEntry[]): SentChatLine[] {
  return transcript.filter((t) => (t.role === "assistant" || t.role === "candidate") && t.content.trim()).map((t) => ({ who: t.role === "candidate" ? "candidate" : "assistant", text: t.content.trim(), at: t.at }));
}

/** What the candidate sent, read back: the form's answers in the one wording every reader uses, and the newest AI interview they sent. */
export function sentAnswersFor(input: { app: Pick<AppRow, "answers">; packet: RolePacket | null; screens: readonly ScreenRow[] }): SentAnswers {
  const { packet } = input;
  if (!packet) return { questions: [], chat: null };
  const sent = input.screens.find((s) => screenAnswersSent(s));
  return {
    questions: formAnswerSentences(packet.formQuestions, formAnswersOf(input.app.answers)).map((s) => s.sentence),
    chat: sent ? { sentAt: sent.progress.submittedAt ?? sent.completedAt ?? null, answers: sentChatAnswers(packet, sent), lines: chatLines(sent.transcript) } : null,
  };
}

/** The application's AI interviews, newest first. */
export function screensOf(tx: Tx, applicationId: string): Promise<ScreenRow[]> {
  return tx.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt));
}
