import { eq } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, type Actor, type ChatCounter, type ReviewItem, type ScreenStatus, type TapAnswer, type TapFormat } from "@ros/contracts";
import { chatCounter, tapFormatFor } from "@ros/core";
import { answerWithdrawPrompt, chatFactsOf, currentQuestion, editScreenAnswer, loadScreenBundle, optOutOfScreen, reviewItems, runScreenTurn, screenIntro, startScreenConversation, submitScreenAnswers, withdrawPending, type ScreenDeps, type ScreenIntro, type TurnResult } from "@ros/agents";
import { applications, screens, withTenant, type Db, type Tx } from "@ros/db";
import type { Container } from "../container";
import { recordWithdrawal, withdrawApplication } from "./applications";

/**
 * The AI interview as the candidate's pages use it: the link opens one interview, and every form on those pages comes
 * through here to the chat engine (packages/agents, `screening.ts`).
 */

/** The actor of what a candidate does through their own link before the page knows more than the link. */
const WEB_ACTOR: Actor = { kind: "candidate", id: "web" };

/**
 * What the chat engine needs from the app: the model, email, the public host candidate links use, the wake-up of the
 * interview's workflow run, and the withdrawal a candidate confirms inside the chat (the same one the status page does).
 */
export function screenDeps(container: Container): ScreenDeps {
  return {
    ai: container.ai,
    integrations: container.integrations,
    appBaseUrl: container.env.JOBS_BASE_URL,
    signal: (q, input) => container.engine.signal(q, input),
    withdraw: async (q, input) => {
      await withdrawApplication(q as Tx, container, { applicationId: input.applicationId, via: "ai_interview" });
    },
    clock: () => container.engine.clock(),
  };
}

/** The AI interview a link opens. */
export type ConversationRef = { id: string; companyId: string; applicationId: string; token: string };

/** Null for an unknown link. */
export async function findConversation(db: Db, token: string): Promise<ConversationRef | null> {
  if (!token || token.length > 100) return null;
  const [s] = await db.select({ id: screens.id, companyId: screens.companyId, applicationId: screens.applicationId }).from(screens).where(eq(screens.token, token)).limit(1);
  return s ? { ...s, token } : null;
}

/**
 * Everything the AI interview's pages show:
 * - `phase`: `intro` (the fixed introduction with Start and "I'd rather talk to a person", before the first question),
 *   `conversation`, `review` ("check your answers"), or `closed` (`status` says how: sent, the link closed, they chose
 *   not to do it, or it was cancelled).
 * - `current`: the question being asked, the tap answer it offers, and whether it already has an answer (the assistant is
 *   following up: skipping then moves on and keeps it). `review`: one line per question.
 * - `counter`: the header's "2 of 4 required"; never the questions in advance.
 * - `formAnswers`: their answers on the application form, as the chat read them.
 * There is deliberately no status link here, and never a score.
 */
export type ConversationView = {
  token: string;
  status: ScreenStatus;
  phase: "intro" | "conversation" | "review" | "closed";
  companyName: string;
  roleTitle: string;
  firstName: string;
  intro: ScreenIntro;
  transcript: Array<{ role: "assistant" | "candidate" | "system"; content: string; questionKey?: string }>;
  current: { key: string; question: string; tap: TapFormat | null; answered: boolean } | null;
  review: ReviewItem[] | null;
  withdrawPending: boolean;
  counter: ChatCounter | null;
  formAnswers: string[];
};

export async function conversationView(db: Db, ref: ConversationRef): Promise<ConversationView | null> {
  return withTenant(db, ref.companyId, async (tx) => {
    const b = await loadScreenBundle(tx, ref.id);
    if (!b) return null;
    const { screen, packet } = b;
    const status = screen.status as ScreenStatus;
    const open = SCREEN_ACTIVE_STATUSES.includes(status);
    const phase = !open ? "closed" : screen.progress.phase === "review" ? "review" : screen.progress.chat ? "conversation" : "intro";
    const q = phase === "conversation" ? currentQuestion(packet, screen.progress) : null;
    return {
      token: ref.token,
      status,
      phase,
      companyName: b.company.name,
      roleTitle: b.rolePacket.identity.title,
      firstName: b.candidate.firstName,
      intro: screenIntro({ companyName: b.company.name, firstName: b.candidate.firstName, packet: b.rolePacket, noticeOverrides: b.company.settings.notices }),
      transcript: screen.transcript.map((t) => ({ role: t.role, content: t.content, ...(t.questionKey ? { questionKey: t.questionKey } : {}) })),
      current: q ? { key: q.key, question: q.question, tap: tapFormatFor(q, packet.compensation), answered: screen.answers[q.key] !== undefined } : null,
      review: phase === "review" ? reviewItems(screen, b.rolePacket) : null,
      withdrawPending: open && withdrawPending(screen.transcript),
      counter: chatCounter(screen.progress.chat),
      formAnswers: chatFactsOf(b.rolePacket, b.app).formAnswers,
    };
  });
}

/** "Start" on the introduction: the first question, in the job's own words. */
export async function conversationStart(container: Container, ref: ConversationRef): Promise<boolean> {
  const r = await withTenant(container.db, ref.companyId, (tx) => startScreenConversation(tx, screenDeps(container), { screenId: ref.id, actor: WEB_ACTOR }));
  await container.kick();
  return r.ok;
}

/** One thing the candidate did on the page: typed a `message`, pressed "Skip this question" or tapped an answer. */
export type TurnAction = { message?: string | null; skip?: boolean; tap?: TapAnswer | null };

/** A turn of the chat. An empty message with no skip or tap is refused before anything is written. */
export async function conversationTurn(container: Container, ref: ConversationRef, input: TurnAction): Promise<TurnResult> {
  const message = (input.message ?? "").trim().slice(0, 2000);
  if (!message && !input.skip && !input.tap) return { kind: "error", message: "Please type an answer first." };
  const r = await runScreenTurn(container.db, ref.companyId, screenDeps(container), { screenId: ref.id, message, actor: WEB_ACTOR, skip: !!input.skip, tap: input.tap ?? null });
  if (r.kind === "reply" && r.withdrawn) await recordWithdrawn(container, ref);
  await container.kick();
  return r;
}

/** "I'd rather talk to a person": the candidate chose not to do the AI interview, and the team is told. Null when the interview is no longer open. */
export async function conversationPerson(container: Container, ref: ConversationRef): Promise<{ message: string } | null> {
  const out = await withTenant(container.db, ref.companyId, (tx) => optOutOfScreen(tx, screenDeps(container), { screenId: ref.id }));
  await container.kick();
  return out;
}

/** The answer to "do you want to withdraw?" on the page. Null when the interview is no longer open. */
export async function conversationWithdraw(container: Container, ref: ConversationRef, confirm: boolean): Promise<string | null> {
  const msg = await withTenant(container.db, ref.companyId, (tx) => answerWithdrawPrompt(tx, screenDeps(container), { screenId: ref.id, confirm, actor: WEB_ACTOR }));
  if (msg !== null && confirm) await recordWithdrawn(container, ref);
  await container.kick();
  return msg;
}

/** A withdrawal confirmed in the chat is, once its transaction has committed, also a recorded request with a confirmation email, as from the status page. */
async function recordWithdrawn(container: Container, ref: ConversationRef): Promise<void> {
  const [app] = await withTenant(container.db, ref.companyId, (tx) => tx.select({ id: applications.id, companyId: applications.companyId, candidateId: applications.candidateId, stage: applications.stage }).from(applications).where(eq(applications.id, ref.applicationId)).limit(1));
  if (app?.stage === "withdrawn") await recordWithdrawal(container, app, "ai_interview");
}

/** An answer changed on the "check your answers" page: typed `text`, or a `tap`. */
export async function conversationEdit(container: Container, ref: ConversationRef, input: { questionKey: string; text?: string | null; tap?: TapAnswer | null }): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  return withTenant(container.db, ref.companyId, (tx) => editScreenAnswer(tx, { screenId: ref.id, questionKey: input.questionKey, text: input.text, tap: input.tap, now: container.engine.clock() }));
}

/** "Send my answers" on the "check your answers" page. */
export async function conversationSubmit(container: Container, ref: ConversationRef): Promise<boolean> {
  const ok = await withTenant(container.db, ref.companyId, async (tx) => (await submitScreenAnswers(tx, screenDeps(container), { screenId: ref.id, actor: WEB_ACTOR })).ok);
  await container.kick();
  return ok;
}
