import { eq } from "drizzle-orm";
import type { ScreenProgress, ScreenTranscriptEntry, ScreenWriteup, TapAnswer } from "@ros/contracts";
import { candidateFacing, routeDeadline, runPromptDetached, screenWriteupPrompt } from "@ros/ai";
import { redactProtected, settleWriteup, withWrittenAnswer } from "@ros/agents";
import { emit } from "@ros/core";
import { applications, screens, unconfirmedScreens, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { conversationEdit, conversationView, type ConversationRef } from "./apply-conversation";

/**
 * The write-up on Review & send (Wave S7, slice S7-D; contract in scratchpad kanvis-2/s7-contracts.md, section 2c), for
 * both kinds of conversation alike (a screen, or a repeat submission's detached copy), so the two never read or behave
 * differently:
 * - `ensureWriteup`: once the chat is over and the candidate is checking it (phase "review"), one answer per written
 *   question in their own words (`screen.writeup` on Haiku 5.5, held to the rules in code by `settleWriteup`; without
 *   the model, their own replies as they wrote them). Written once: a second press, or two at once, keeps the first.
 *   The model is called with no transaction open.
 * - `editWrittenAnswer`: the candidate changes one of them, through the existing change (`conversationEdit`: the new
 *   words added to the transcript, so every quote check covers them); a company's written question the chat never
 *   asked (added to the job after it started) is changed the same way here. Either way the write-up then holds exactly
 *   what was saved, marked theirs.
 * Nothing here reaches the team before Send: the write-up lives on the conversation's progress, which the team cannot
 * read until then (`teamScreenView`), and the AI run is withheld from the ITS console the same way.
 */

type Loaded = { status: string; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress; candidateId: string | null; workflowRunId: string | null };

/** The conversation behind a link, either kind. `lock`: the row is held until the transaction ends. */
async function loadConversation(tx: Tx, ref: ConversationRef, opts: { lock?: boolean } = {}): Promise<Loaded | null> {
  if (ref.kind === "screen") {
    const rows = opts.lock ? await tx.select().from(screens).where(eq(screens.id, ref.id)).limit(1).for("update") : await tx.select().from(screens).where(eq(screens.id, ref.id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const [app] = await tx.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, row.applicationId)).limit(1);
    return { status: row.status, transcript: row.transcript, answers: row.answers, progress: row.progress, candidateId: app?.candidateId ?? null, workflowRunId: row.workflowRunId };
  }
  const rows = opts.lock ? await tx.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id)).limit(1).for("update") : await tx.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id)).limit(1);
  const row = rows[0];
  if (!row || row.discardedAt) return null;
  return { status: row.status, transcript: row.transcript, answers: row.answers, progress: row.progress, candidateId: null, workflowRunId: null };
}

/** Whether the candidate is checking their answers before sending: the only time the write-up is written or changed. */
const checking = (c: Loaded) => c.status === "in_progress" && c.progress.phase === "review";

async function saveProgress(tx: Tx, ref: ConversationRef, set: { progress: ScreenProgress; answers?: Record<string, string>; transcript?: ScreenTranscriptEntry[]; lastCandidateMessageAt?: string }): Promise<void> {
  if (ref.kind === "screen") await tx.update(screens).set(set).where(eq(screens.id, ref.id));
  else await tx.update(unconfirmedScreens).set(set).where(eq(unconfirmedScreens.id, ref.id));
}

export type WriteupOutcome = "written" | "kept" | "not_ready";

/**
 * Writes the write-up of a chat the candidate is checking, if it has none (`POST /c/screen/:token/review`, and the
 * chat's end may call it too). "kept": it already had one; "not_ready": not being checked now, or no written questions.
 */
export async function ensureWriteup(container: Container, ref: ConversationRef): Promise<WriteupOutcome> {
  const deadlineAt = routeDeadline();
  // The questions are the ones the page shows (`ConversationView.written`), so the write-up and the page always agree.
  const view = await conversationView(container.db, ref);
  if (!view || view.phase !== "review") return "not_ready";
  if (view.writeup) return "kept";
  const questions = view.written;
  if (!questions.length) return "not_ready";
  const plan = await withTenant(container.db, ref.companyId, async (tx) => {
    const c = await loadConversation(tx, ref);
    if (!c || !checking(c)) return "not_ready" as const;
    if (c.progress.writeup) return "kept" as const;
    return { transcript: c.transcript, skipped: c.progress.declined ?? [], workflowRunId: c.workflowRunId };
  });
  if (typeof plan === "string") return plan;
  const out = await runPromptDetached(container.db, container.ai, screenWriteupPrompt, { company: { name: view.companyName }, roleTitle: view.roleTitle, questions, transcript: candidateFacing(plan.transcript), skipped: plan.skipped }, {
    companyId: ref.companyId,
    workflowRunId: plan.workflowRunId,
    inputRef: ref.kind === "screen" ? { screenId: ref.id, turns: plan.transcript.length } : { unconfirmedScreenId: ref.id, turns: plan.transcript.length },
    deadlineAt,
  });
  return withTenant(container.db, ref.companyId, async (tx) => {
    // Locked and read again: a second press waits here, then finds the first one's write-up and keeps it.
    const c = await loadConversation(tx, ref, { lock: true });
    if (!c || !checking(c)) return "not_ready";
    if (c.progress.writeup) return "kept";
    const writeup: ScreenWriteup = settleWriteup(out.ok ? out.output : null, { questions, transcript: c.transcript, declined: c.progress.declined ?? [] }, { at: container.engine.clock().toISOString(), aiRunId: out.ok ? out.runId : null, promptVersion: out.ok ? screenWriteupPrompt.version : null });
    await saveProgress(tx, ref, { progress: { ...c.progress, writeup } });
    return "written";
  });
}

export type WrittenEditResult = { ok: true; answer: string } | { ok: false; error: string };

/** What the existing change (`conversationEdit`, both kinds) says of a key its packet does not hold. */
const NOT_ASKED = "That question is not part of this conversation.";

/**
 * One written-up answer changed on Review & send: typed `text`, or a `tap` for a question that takes one. Only while the
 * candidate is checking a chat that has a write-up, and only for one of its questions.
 */
export async function editWrittenAnswer(container: Container, ref: ConversationRef, input: { questionKey: string; text?: string | null; tap?: TapAnswer | null }): Promise<WrittenEditResult> {
  const key = input.questionKey;
  const before = await withTenant(container.db, ref.companyId, (tx) => loadConversation(tx, ref));
  if (!before || !checking(before) || !before.progress.writeup) return { ok: false, error: "These answers can no longer be changed." };
  if (!before.progress.writeup.answers.some((a) => a.questionKey === key)) return { ok: false, error: NOT_ASKED };
  const now = container.engine.clock();
  // A question the conversation asks: the existing change, then the write-up holds what was saved.
  const out = await conversationEdit(container, ref, { questionKey: key, text: input.text ?? null, tap: input.tap ?? null });
  if (out.ok) {
    await withTenant(container.db, ref.companyId, async (tx) => {
      const c = await loadConversation(tx, ref, { lock: true });
      if (c?.progress.writeup) await saveProgress(tx, ref, { progress: { ...c.progress, writeup: withWrittenAnswer(c.progress.writeup, key, out.answer, now.toISOString()) } });
    });
    return out;
  }
  if (out.error !== NOT_ASKED) return out;
  // A company's written question the chat did not ask (added to the job after it started): the same change, made here.
  const typed = input.text?.trim().slice(0, 2000) ?? "";
  if (!typed) return { ok: false, error: input.tap ? "That answer does not fit this question. Please type it instead." : "Please type an answer first." };
  return withTenant(container.db, ref.companyId, async (tx) => {
    const c = await loadConversation(tx, ref, { lock: true });
    if (!c || !checking(c) || !c.progress.writeup) return { ok: false as const, error: "These answers can no longer be changed." };
    const at = now.toISOString();
    const recorded = redactProtected(typed);
    let progress: ScreenProgress = { ...c.progress, edits: { ...(c.progress.edits ?? {}), [key]: (c.progress.edits?.[key] ?? 0) + 1 }, writeup: withWrittenAnswer(c.progress.writeup, key, recorded, at) };
    if (progress.declined?.includes(key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== key) };
    const entry: ScreenTranscriptEntry = { role: "candidate", content: typed, at, channel: "web", questionKey: key, source: "edit" };
    await saveProgress(tx, ref, { progress, answers: { ...c.answers, [key]: recorded }, transcript: [...c.transcript, entry], lastCandidateMessageAt: at });
    // The same history entry as any other change; the team's history leaves it out until the chat is sent.
    if (ref.kind === "screen" && c.candidateId) await emit(tx, { type: "screen.answer_edited", companyId: ref.companyId, actor: { kind: "candidate", id: c.candidateId }, subject: { type: "screen", id: ref.id }, payload: { questionKey: key, tapped: false }, correlationId: c.workflowRunId });
    return { ok: true as const, answer: recorded };
  });
}
