import type { ScreenProgress, ScreenTranscriptEntry } from "@ros/contracts";

/**
 * Where a screen's answers live. The packet's own answers are in `screens.answers`; an answer to one of the open
 * questions a screen started with ("Ask about this in a screen", docs/spec/21 section 7) is kept beside that question
 * in `screens.progress.focusQuestions`; the candidate page's "x of N answered" counts both places through here.
 * Every reader of what a candidate said in a screen (the scorecard, the interviewer's brief, the recruiter's context,
 * the owner's card) and every path that exports or removes it (an access request, an anonymization) goes through here,
 * so the second place is never forgotten.
 */
export type ScreenAnswerSource = { answers: Record<string, string>; progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined };

/** Every recorded answer by question key: the open questions' answers first, then the packet's own. */
export function screenAnswersOf(screen: ScreenAnswerSource): Record<string, string> {
  const focus: Record<string, string> = {};
  for (const f of screen.progress?.focusQuestions ?? []) if (f.answer) focus[f.key] = f.answer;
  return { ...focus, ...screen.answers };
}

/** The open questions a screen started with, in the words the candidate was asked, keyed like their answers. */
export function openingQuestionsOf(progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): Array<{ key: string; question: string }> {
  return (progress?.focusQuestions ?? []).map((f) => ({ key: f.key, question: f.question }));
}

/** The progress with every answer to an open question removed. The questions stay: they are the assistant's words, not the candidate's. */
export function withoutFocusAnswers(progress: ScreenProgress): ScreenProgress {
  if (!progress.focusQuestions) return progress;
  return { ...progress, focusQuestions: progress.focusQuestions.map((f) => ({ key: f.key, question: f.question, ...(f.whyItMatters ? { whyItMatters: f.whyItMatters } : {}) })) };
}

/**
 * The progress with everything the candidate said taken out, for an anonymization and for a repeat submission's words
 * wiped after seven days: the answers to the open questions (`withoutFocusAnswers`) and the written-up answers of Review
 * & send (Wave S7, `writeup`), which are their words condensed, and what was typed in the visit for the chat to name
 * (`typedFacts`: their CV lines and form answers). The chat's plan stays: keys and states, nothing they said.
 */
export function withoutCandidateWords(progress: ScreenProgress): ScreenProgress {
  const out = withoutFocusAnswers(progress);
  if (!out.writeup && !out.typedFacts) return out;
  const { writeup: _writeup, typedFacts: _typedFacts, ...rest } = out;
  return rest;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* "Hide them until they send" (founder decision, 9 October 2026; counsel register item 20)                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Whether the hiring team (and an ITS recruiter working for it) may see what the candidate said in a screening
 * conversation: only once the candidate sent it. For the conversation offered with the application that is Send on
 * "Check your answers", pressed by the candidate: nothing sends it for them, so someone who answered everything and never
 * pressed Send closes as unfinished like anyone else who did not send; for a conversation from an emailed invitation,
 * its normal end. Until then nothing they said, nor anything worked out from it (a reading, a score, a skip, how far they
 * got), reaches the team; and a conversation that closed without it (stopped part-way, did not press Send, sent the
 * application without it, asked for a person, withdrew, finished by a recruiter's call) stays that way for good. A
 * recruiter's own call notes are never the candidate's words and are always shown. The candidate's own access to their
 * data is unchanged.
 */
export function screenAnswersSent(screen: { status: string; progress?: Pick<ScreenProgress, "completedBy"> | null }): boolean {
  return screen.status === "completed" && screen.progress?.completedBy !== "recruiter_call";
}

/** A recruiter's notes from a call (E3): never the candidate's own words, so never hidden with them. */
export function isRecruiterNoteEntry(t: Pick<ScreenTranscriptEntry, "role" | "source">): boolean {
  return t.role === "recruiter" || t.source === "recruiter_call";
}

/**
 * What is left of the progress of a conversation the team may not read: how it was offered, which list it asks (Wave
 * S8, `asks`: a recruiter's call notes are filed under the questions it asks), a pause, and the open questions without
 * their answers.
 */
function unsentProgress(p: ScreenProgress | null | undefined): ScreenProgress {
  const out: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };
  if (p?.flow) out.flow = p.flow;
  if (p?.asks) out.asks = p.asks;
  if (p?.pausedAt) out.pausedAt = p.pausedAt;
  if (p?.completedBy) out.completedBy = p.completedBy;
  if (p?.focusQuestions) out.focusQuestions = withoutFocusAnswers(p).focusQuestions;
  return out;
}

/**
 * A screening conversation as the team may see it (`screenAnswersSent`): the whole of it once sent; otherwise no
 * answer, no transcript line but a recruiter's call notes, and nothing about how far they got. `answersShared` says
 * which, so the page can say why there is nothing to read yet.
 */
export function teamScreenView<T extends { status: string; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress }>(screen: T): T & { answersShared: boolean } {
  if (screenAnswersSent(screen)) return { ...screen, answersShared: true };
  return { ...screen, answersShared: false, transcript: screen.transcript.filter(isRecruiterNoteEntry), answers: {}, progress: unsentProgress(screen.progress) };
}

/** What a reading needs to say whether it was written from a conversation nobody sent. */
export type ReadingLike = { id: string; kind: string; result?: unknown };

/**
 * A reading that says itself it was written from a conversation the candidate did not send: before 9 October 2026 a
 * conversation closed part-way or sent without it was read for what it had, and every such scorecard carries an
 * "incomplete_screen" anomaly (no reading written since does: `assessScreen` reads only a sent conversation). However
 * the reading is reached later (its screen finished on a recruiter's call, which unlinks it; a request's older
 * snapshot), it stays hidden.
 */
export function isUnsentConversationReading(r: Pick<ReadingLike, "kind" | "result">): boolean {
  if (r.kind !== "screen") return false;
  const anomalies = (r.result as { anomalies?: unknown } | null | undefined)?.anomalies;
  return Array.isArray(anomalies) && anomalies.some((a) => (a as { kind?: unknown } | null)?.kind === "incomplete_screen");
}

/**
 * Readings written from a conversation the candidate never sent: before 9 October 2026 a conversation closed part-way
 * or sent without it was read for what it had. Its scorecard is never shown and never counts towards a score: the
 * reading and the match score use the résumé and the application alone. Found two ways: a screen that is not complete
 * still points at it, or the reading says so itself (`isUnsentConversationReading`; pass the readings, so one a
 * recruiter's call notes unlinked from its screen stays hidden). (A conversation finished on a recruiter's call is read
 * from the notes alone, so that scorecard stays.)
 */
export function unsentScreenReadings(screens: ReadonlyArray<{ status: string; assessmentId: string | null }>, readings: readonly ReadingLike[] = []): Set<string> {
  const hidden = new Set(screens.filter((s) => s.assessmentId && s.status !== "completed").map((s) => s.assessmentId!));
  for (const r of readings) if (isUnsentConversationReading(r)) hidden.add(r.id);
  return hidden;
}

/**
 * The messages of a screening conversation that carry the candidate's words, the assistant's answers to them, or how far
 * the candidate got: the assistant's replies by text, and the two reminders to come back to it ("you stopped part-way",
 * "you answered every question but have not pressed Send"). Each is keyed `<template>:<screenId>[:...]`.
 */
const CONVERSATION_TEMPLATES: ReadonlySet<string> = new Set(["screen_turn", "screen_idle_reminder", "screen_review_reminder"]);

/**
 * Whether a message belongs to a screening conversation, and to which one when it says: what the candidate typed or
 * texted in it (recorded with the screen's id since 9 October 2026; before that, any web message from them was one),
 * the assistant's replies by text, and the reminders that say how far they got. Null for every other message (an email
 * reply, a team member's message, the invitation, a note that the conversation closed).
 */
export function conversationMessageOf(m: { direction: string; channel: string; templateKey?: string | null; tags?: Record<string, string> | null; idempotencyKey?: string | null }): { screenId: string | null } | null {
  if (m.tags?.screenId) return { screenId: m.tags.screenId };
  if (m.direction === "inbound" && m.channel === "web") return { screenId: null };
  if (m.direction === "outbound" && m.templateKey && CONVERSATION_TEMPLATES.has(m.templateKey)) return { screenId: m.idempotencyKey?.split(":")[1] ?? null };
  return null;
}

/**
 * The messages the team may see: a conversation's own messages only once its answers were sent. A message that does
 * not say which conversation it belongs to is held back while any conversation of the application is unsent.
 */
export function withoutUnsentConversation<M extends { direction: string; channel: string; templateKey?: string | null; tags?: Record<string, string> | null; idempotencyKey?: string | null }>(messages: readonly M[], screens: ReadonlyArray<{ id: string; status: string; progress?: Pick<ScreenProgress, "completedBy"> | null }>): M[] {
  const sent = new Map(screens.map((s) => [s.id, screenAnswersSent(s)]));
  const anyUnsent = screens.some((s) => !screenAnswersSent(s));
  return messages.filter((m) => {
    const conv = conversationMessageOf(m);
    if (!conv) return true;
    if (conv.screenId && sent.has(conv.screenId)) return sent.get(conv.screenId)!;
    return !anyUnsent;
  });
}

/** History entries that are about single answers (a skip, a tap, a change): never shown for a conversation that was not sent. */
const ANSWER_EVENTS: ReadonlySet<string> = new Set(["screen.question_skipped", "screen.answer_tapped", "screen.answer_edited", "screen.turn_cap_reached"]);
/** Event details that say how far someone got or what they did with a question. */
const ANSWER_DETAILS = ["answered", "questionsAnswered", "skipped", "stoppedAt", "questionKey", "answerKept", "tapped", "modelTurns"];
/** Event details that come from a reading of the conversation: never shown for one that was not read for the team. */
const READING_DETAILS = ["assessmentId", "recommendation", "confidence", "overall", "incomplete"];
const NO_READINGS: ReadonlySet<string> = new Set();

/**
 * History entries as the team may see them (a candidate's own, their screens', or the company's activity list): for a
 * conversation that was not sent, nothing about single answers, no count of what was answered, and no reading of how
 * the candidate sounded; and nothing about a reading the team may not see (`hiddenReadings`, from
 * `unsentScreenReadings`): no "scorecard written", no "assessed" with its recommendation, no flag or suggestion about
 * it. A conversation finished on a recruiter's call keeps the entry for its scorecard, which is read from the notes.
 */
export function withoutUnsentScreenEvents<E extends { type: string; subjectType: string; subjectId: string; payload: Record<string, unknown> }>(events: readonly E[], screens: ReadonlyArray<{ id: string; status: string; progress?: Pick<ScreenProgress, "completedBy"> | null }>, hiddenReadings: ReadonlySet<string> = NO_READINGS): E[] {
  const unsent = new Set(screens.filter((s) => !screenAnswersSent(s)).map((s) => s.id));
  // Not complete: never read for the team, so nothing from a reading of it either (one written before 9 October 2026).
  const unread = new Set(screens.filter((s) => s.status !== "completed").map((s) => s.id));
  const out: E[] = [];
  for (const e of events) {
    const reading = e.payload?.assessmentId;
    if (typeof reading === "string" && hiddenReadings.has(reading)) continue;
    if (e.subjectType !== "screen" || !unsent.has(e.subjectId)) { out.push(e); continue; }
    if (ANSWER_EVENTS.has(e.type)) continue;
    if (unread.has(e.subjectId) && e.type === "screen.assessed") continue;
    const payload = { ...e.payload };
    for (const k of ANSWER_DETAILS) delete payload[k];
    if (unread.has(e.subjectId)) for (const k of READING_DETAILS) delete payload[k];
    if (typeof payload.reason === "string") payload.reason = withoutSentimentWords(payload.reason);
    out.push({ ...e, payload });
  }
  return out;
}

/**
 * Why a conversation went to a person when the assistant handed it over during the conversation, whether the candidate
 * asked in their own words or the assistant judged they needed one: said the same either way, since what the assistant
 * made of words the candidate never sent stays with the AI run's record (9 October 2026).
 */
export const HANDED_TO_A_PERSON = "the assistant handed the conversation to a person";

/**
 * A hand-over reason written before 9 October 2026 ("candidate sounded distressed"), in the words used since: how the
 * candidate sounded is the assistant's reading of words they never sent. For the reason on a history entry and the
 * recruiter request's question, wherever the team or a recruiter reads them.
 */
export function withoutSentimentWords(text: string): string {
  return text.replace(/candidate sounded [a-z]+/gi, HANDED_TO_A_PERSON);
}

/** What the ITS operations console shows instead of an AI run's output about a conversation the candidate has not sent. */
export const WITHHELD_RUN_OUTPUT: Readonly<Record<string, string>> = { withheld: "This AI run is about a screening chat the candidate has not sent, so what it read and wrote is not shown here." };

/**
 * An AI run as the ITS operations console shows it (founder decision of 9 October 2026: the console is not the hiring
 * team, but nobody at ITS reads answers the candidate never sent either): a run about a conversation that was not sent
 * (its `inputRef.screenId`) keeps its timings, tokens, status and error, and its output is withheld. The scorecard of a
 * conversation finished on a recruiter's call is read from the notes alone, and is shown. A run about a repeat
 * submission's detached conversation (`inputRef.unconfirmedScreenId`: its turns, its write-up) is withheld the same way
 * until the address owner confirmed it (`unconfirmed`, read with the screens); one not found is withheld too.
 */
export function withoutUnsentRunOutput<R extends { task: string; inputRef: Record<string, unknown> | null; structuredOutput: Record<string, unknown> | null }>(run: R, screens: ReadonlyArray<{ id: string; status: string; progress?: Pick<ScreenProgress, "completedBy"> | null }>, unconfirmed: ReadonlyArray<{ id: string; confirmation: string | null }> = []): R {
  const detachedId = run.inputRef?.unconfirmedScreenId;
  if (typeof detachedId === "string" && run.structuredOutput) {
    const row = unconfirmed.find((u) => u.id === detachedId);
    return row?.confirmation === "confirmed" ? run : { ...run, structuredOutput: { ...WITHHELD_RUN_OUTPUT } };
  }
  const screenId = run.inputRef?.screenId;
  if (typeof screenId !== "string" || !run.structuredOutput) return run;
  const s = screens.find((x) => x.id === screenId);
  if (!s || screenAnswersSent(s)) return run;
  if (run.task === "screen.assess" && s.status === "completed") return run;
  return { ...run, structuredOutput: { ...WITHHELD_RUN_OUTPUT } };
}

/**
 * An escalation's context as a recruiter may read it, for a context captured before 9 October 2026 or while a
 * conversation was under way: each captured conversation the team could not read then shows a recruiter's notes alone,
 * and the candidate's web messages go with it; a reading written from a conversation nobody sent is dropped
 * (`isUnsentConversationReading`), and so, in a context captured before 9 October 2026 (its screens do not say
 * `answersShared`) with nothing shown, are the history entries about a screening scorecard. Hand-over reasons are said
 * in today's words (`withoutSentimentWords`).
 */
export function withoutUnsentInContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ctx };
  if (Array.isArray(ctx.assessments)) out.assessments = (ctx.assessments as Array<{ kind?: unknown; result?: unknown }>).filter((a) => !isUnsentConversationReading({ kind: String(a?.kind ?? ""), result: a?.result }));
  const screens = Array.isArray(ctx.screens) ? (ctx.screens as Array<Record<string, unknown>>) : null;
  if (!screens) return out;
  const legacy = !screens.some((s) => typeof s.answersShared === "boolean");
  const shown = (s: Record<string, unknown>) => (typeof s.answersShared === "boolean" ? s.answersShared : s.status === "completed");
  const anyHidden = screens.some((s) => !shown(s));
  out.screens = screens.map((s) => (shown(s) ? s : { ...s, answersShared: false, answers: {}, transcript: Array.isArray(s.transcript) ? (s.transcript as ScreenTranscriptEntry[]).filter(isRecruiterNoteEntry) : [] }));
  if (anyHidden && Array.isArray(ctx.communications)) out.communications = (ctx.communications as Array<{ direction?: string; channel?: string }>).filter((m) => !(m.direction === "inbound" && m.channel === "web"));
  if (Array.isArray(ctx.timeline)) {
    const noneShown = !screens.some((s) => shown(s) && s.status === "completed");
    out.timeline = (ctx.timeline as Array<{ type?: string; payload?: Record<string, unknown> }>)
      .filter((t) => !(t?.type === "screen.assessed" && t.payload?.incomplete === true))
      .filter((t) => !(legacy && anyHidden && noneShown && t?.type === "assessment.created" && t.payload?.kind === "screen"))
      .map((t) => (typeof t?.payload?.reason === "string" ? { ...t, payload: { ...t.payload, reason: withoutSentimentWords(t.payload.reason) } } : t));
  }
  return out;
}
