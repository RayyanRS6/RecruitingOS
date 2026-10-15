import type { ApplyMode, ChatItem, ChatPlan, ChatReading, ChatSection, PolicyLevel, RolePacket, ScreeningFunnel, ScreeningQuestion, ScreenProgress, ScreenTranscriptEntry, TapAnswer, TapFormat } from "@ros/contracts";
import { screenAnswersSent } from "./screen-answers";

/**
 * Applying and the screening conversation in one visit (plan Wave E; founder decision B1/Q15). The pure rules: which
 * flow a role uses, who still counts as applying, which questions can be answered by tapping and the words a tap is
 * recorded as, and the per-role figures of how the conversation goes. No model and no database here.
 */

/**
 * A role's own setting wins; otherwise the company's default; otherwise "form now, conversation later". The one-visit
 * flow runs on pilot roles first (founder decision B1/Q15, and the counsel item on notice timing): ITS switches it on for
 * a role or a company, and it becomes everyone's default only by a later decision.
 */
export function resolveApplyMode(role: { applyMode?: string | null }, settings: { applyFlowDefault?: string | null } | null | undefined): ApplyMode {
  if (role.applyMode === "one_visit" || role.applyMode === "form_then_screen") return role.applyMode;
  return settings?.applyFlowDefault === "one_visit" ? "one_visit" : "form_then_screen";
}

/** What a company's roles follow when ITS has not set a default for it (see `resolveApplyMode`). */
export const APPLY_FLOW_FALLBACK: ApplyMode = "form_then_screen";

/**
 * Whether the owner's rule for `application.invite_screen` lets the conversation start with the application. "Ask me
 * first" (approval) and "Only a person" (human_only) keep the later path: the owner decides who is invited.
 */
export function oneVisitPolicyAllows(level: PolicyLevel): boolean {
  return level === "auto" || level === "auto_notify";
}

/**
 * "Still applying" (E6): offered the conversation in the visit that sent the application, and not yet finished, sent
 * without it, handed to a person or closed. Until then nothing about them reaches the owner's alerts.
 */
export function isStillApplying(screen: { status: string; invitedVia?: string | null } | null | undefined): boolean {
  return !!screen && screen.invitedVia === "apply" && ["invited", "reminded", "in_progress", "paused"].includes(screen.status);
}

/** A conversation offered with the application (E1): the fixed introduction, check-your-answers, and pause on an outage. */
export function isOneVisitFlow(progress: Pick<ScreenProgress, "flow"> | null | undefined): boolean {
  return progress?.flow === "one_visit";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The Kanvis-style chat's plan (Wave S7; the contracts in s7-contracts.md, section 2b)                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The chat's closing question ("Wrapping up"): asked after every item, in code's words, and never an item of the plan
 * (it is not counted). Its answer is the candidate's own words like any other.
 */
export const CHAT_WRAP_KEY = "wrap_up";
/** At most this many "About your experience" items (the résumé reading's open questions first, then the gaps). */
export const CHAT_GAP_LIMIT = 4;

/**
 * The plan when the chat starts (fixed in code; the model never writes it): the gaps first (`About your experience`),
 * then the written questions (`Required questions`), in order. The chat begins in the first section that has an item;
 * with neither it goes straight to "Wrapping up".
 */
export function buildChatPlan(input: { gaps: string[]; written: Array<{ key: string; required: boolean }>; at: string }): ChatPlan {
  const seen = new Set<string>();
  const items: ChatItem[] = [];
  for (const key of input.gaps) {
    if (seen.has(key) || key === CHAT_WRAP_KEY || items.length >= CHAT_GAP_LIMIT) continue;
    seen.add(key);
    items.push({ key, kind: "gap", required: false, state: "open", step: "direct", pushes: 0 });
  }
  for (const w of input.written) {
    if (seen.has(w.key) || w.key === CHAT_WRAP_KEY || items.length >= 20) continue;
    seen.add(w.key);
    items.push({ key: w.key, kind: "written", required: w.required, state: "open", step: "direct", pushes: 0 });
  }
  const section: ChatSection = items.some((i) => i.kind === "gap") ? "experience" : items.length ? "required" : "wrapping_up";
  return { v: 1, section, items, current: null, builtAt: input.at };
}

/** An item that needs nothing more: covered, settled as not known, or skipped. */
export function chatItemSettled(item: Pick<ChatItem, "state">): boolean {
  return item.state === "covered" || item.state === "unknown" || item.state === "skipped";
}

/**
 * What the chat does next with the item being asked, from how the latest reply reads (`ChatReading`). A concrete reply
 * covers it, and so does any reply to a yes-or-no question (`ladder` false). A vague one gets one push for specifics,
 * then counts as covered (the team reads the words). "No" / "I haven't" climbs the ladder: the analog ("not done
 * that? something similar from your own work"), then, for a gap, the smaller version ("even a small moment?"), then
 * the item is settled as not known: never a "no" for a skill, and never held against anyone.
 */
export type ChatMove = "push" | "analog" | "smaller" | "covered" | "unknown";
export function chatNextMove(item: Pick<ChatItem, "kind" | "step" | "pushes">, reading: ChatReading, ladder: boolean): ChatMove {
  // A yes-or-no question (no ladder) takes its answer as it is, a bare "Yes" included.
  if (reading === "concrete" || !ladder) return "covered";
  if (reading === "vague") return item.pushes < 1 ? "push" : "covered";
  if (item.step === "direct") return "analog";
  if (item.step === "analog" && item.kind === "gap") return "smaller";
  return "unknown";
}

/** Whether a move keeps asking about the same item (a follow-up) rather than moving on. */
export function chatMoveStays(move: ChatMove): boolean {
  return move === "push" || move === "analog" || move === "smaller";
}

const NOT_DONE = /^(?:no|nope|nah|not really|not yet|never|none|i haven['’]?t|i have not|i have never|i['’]?ve never|i don['’]?t|i do not|i didn['’]?t|i did not)\b[^.!?]{0,40}[.!]?$/i;
/** Words that turn a "no" into an answer ("No, but at my last job I…"). */
const BUT = /\b(?:but|however|though|although|similar|instead|except|once|when)\b/i;

/** A plain "No" / "I haven't" (short, and nothing more): the reply that climbs the ladder, whatever the model read. */
export function saysNotDone(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length > 0 && t.length <= 60 && NOT_DONE.test(t) && !BUT.test(t);
}

/**
 * The plan after a turn, kept in step with the progress the code already keeps: the item being asked is `asking`; one
 * asked and passed is `covered` (or stays `unknown` when the ladder settled it so); a skipped one is `skipped`; the rest
 * are `open`. `move`: the step the turn took on the item it was about (a push, the analog, the smaller version, or
 * settling it). The section follows the item being asked; once every item is settled, or on the closing question, it
 * is "Wrapping up".
 */
export function syncChatPlan(plan: ChatPlan, progress: Pick<ScreenProgress, "askedKeys" | "currentQuestionKey" | "declined">, move?: { key: string; move: ChatMove } | null): ChatPlan {
  const asked = new Set(progress.askedKeys);
  const declined = new Set(progress.declined ?? []);
  const current = progress.currentQuestionKey;
  const items = plan.items.map((item): ChatItem => {
    let next: ChatItem = item;
    if (move && move.key === item.key) {
      if (move.move === "push") next = { ...next, pushes: 1 };
      else if (move.move === "analog") next = { ...next, step: "analog" };
      else if (move.move === "smaller") next = { ...next, step: "smaller" };
      else if (move.move === "unknown") next = { ...next, state: "unknown" };
      else next = { ...next, state: "covered" };
    }
    if (declined.has(item.key)) return { ...next, state: "skipped" };
    if (current === item.key) return { ...next, state: next.state === "unknown" ? "unknown" : "asking" };
    if (asked.has(item.key)) return { ...next, state: next.state === "unknown" ? "unknown" : "covered" };
    return { ...next, state: next.state === "unknown" ? "unknown" : "open" };
  });
  // An item settled as not known while it is still the current question (the move came with this turn) stays so.
  const at = items.find((i) => i.key === current) ?? null;
  const section: ChatSection = at ? (at.kind === "gap" ? "experience" : "required") : current === CHAT_WRAP_KEY || items.every(chatItemSettled) ? "wrapping_up" : items.find((i) => !chatItemSettled(i))?.kind === "gap" ? "experience" : "required";
  return { ...plan, items, section, current: at ? at.key : null };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Tap answers (E12)                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

export const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const YES_NO = /^(do|does|are|is|can|could|will|would|have|has|did)\b/i;
const OPEN_ENDED = /\b(what|which|when|how|why|where|tell me|describe|walk me)\b/i;
const START = /\b(start|begin|starting|earliest)\b/i;
const DAYS = /\b(days?|weekends?|weekdays?|which shifts?|schedule)\b/i;

/**
 * The tap answer a question offers, or null for a free answer only. Worked out from the question's kind and its wording:
 * pay questions take a range; "when could you start" a date; "which days" the days of the week; a question that can only
 * be answered yes or no (an eligibility check, or one that starts "Do you", "Are you", "Can you" and asks nothing open)
 * two buttons. Skills, examples and motivation are always typed: they need the candidate's own words.
 */
export function tapFormatFor(question: Pick<ScreeningQuestion, "kind" | "question">, compensation: Pick<RolePacket["compensation"], "basis" | "currency">): TapFormat | null {
  const text = question.question.trim();
  if (question.kind === "compensation") return { kind: "pay_range", basis: compensation.basis, currency: compensation.currency || "USD" };
  if (!["availability", "logistics", "eligibility"].includes(question.kind)) return null;
  const asksStart = START.test(text) && /\b(when|date|how soon|earliest)\b/i.test(text);
  const asksDays = question.kind === "availability" && DAYS.test(text) && /\b(which|what)\b/i.test(text);
  // A question that asks two things ("which days, and when could you start?") is answered in the candidate's own words.
  if (asksStart && asksDays) return null;
  if (asksStart) return { kind: "start_date" };
  if (asksDays) return { kind: "days", options: [...WEEK_DAYS] };
  if (YES_NO.test(text) && !OPEN_ENDED.test(text.replace(/^\S+\s/, ""))) return { kind: "yes_no" };
  return question.kind === "eligibility" ? { kind: "yes_no" } : null;
}

function money(n: number, currency: string): string {
  const whole = Number.isInteger(n);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${s}` : `${s} ${currency}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The words a tap is recorded as: the candidate's answer, verbatim in the transcript and in the answers, so the
 * scorecard quotes it like anything they typed. Null when the tap does not fit the question (a stale page, a forged post).
 */
export function tapAnswerText(format: TapFormat, answer: TapAnswer, now: Date = new Date()): string | null {
  if (format.kind !== answer.kind) return null;
  switch (answer.kind) {
    case "yes_no":
      return answer.choice === "yes" ? "Yes" : "No";
    case "days": {
      const picked = WEEK_DAYS.filter((d) => answer.days.some((x) => x.toLowerCase() === d.toLowerCase()));
      return picked.length ? `I can work ${joinWords([...picked])}.` : null;
    }
    case "start_date": {
      const t = Date.parse(`${answer.date}T12:00:00Z`);
      if (Number.isNaN(t) || t < now.getTime() - 2 * 86_400_000 || t > now.getTime() + 2 * 365 * 86_400_000) return null;
      return `I can start on ${new Date(t).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })}.`;
    }
    case "pay_range": {
      if (format.kind !== "pay_range") return null;
      const per = format.basis === "hourly" ? "an hour" : "a year";
      if (answer.max !== undefined && answer.max < answer.min) return null;
      return answer.max !== undefined && answer.max !== answer.min ? `I'm looking for ${money(answer.min, format.currency)} to ${money(answer.max, format.currency)} ${per}.` : `I'm looking for ${money(answer.min, format.currency)} ${per}.`;
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* How the conversation goes for a role (E13)                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

export type FunnelScreen = { status: string; invitedVia?: string | null; startedAt: string | null; completedAt: string | null; progress: ScreenProgress; transcript: ScreenTranscriptEntry[] };

/**
 * The figures from a role's screens (the latest per application). Counts only: never a name, an answer, or anything
 * worked out from a conversation nobody sent (founder decision of 9 October 2026): no skip, no time taken, and no
 * question where someone stopped. Every conversation that stopped was, by definition, never sent, so where people stop
 * is not counted at all; even a count could point at the one person the team sees "Didn't finish the conversation" on.
 */
export function screeningFunnel(rows: FunnelScreen[], questions: Array<{ key: string; question: string }>): ScreeningFunnel {
  const started = rows.filter((r) => r.startedAt);
  const finished = rows.filter((r) => r.status === "completed");
  // The time to finish, from conversations the candidates sent: one finished on a recruiter's call is timed from words
  // the candidate typed and never sent.
  const minutes = finished
    .filter((r) => screenAnswersSent(r))
    .map((r) => {
      const first = r.transcript.find((t) => t.role === "candidate")?.at ?? r.startedAt;
      const end = r.progress.submittedAt ?? r.completedAt;
      return first && end ? (Date.parse(end) - Date.parse(first)) / 60_000 : null;
    })
    .filter((m): m is number => m !== null && m >= 0)
    .sort((a, b) => a - b);
  const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2) : null;
  // Skips are counted from conversations the candidates sent: what someone did with a question they never sent stays
  // theirs (founder decision of 9 October 2026), even in a count.
  const skippedCount = new Map<string, number>();
  for (const r of rows) if (screenAnswersSent(r)) for (const k of r.progress.declined ?? []) skippedCount.set(k, (skippedCount.get(k) ?? 0) + 1);
  const label = (key: string) => questions.find((q) => q.key === key)?.question ?? key;
  return {
    offered: rows.length,
    started: started.length,
    finished: finished.length,
    unfinished: rows.filter((r) => r.status === "unfinished").length,
    stillApplying: rows.filter((r) => isStillApplying(r)).length,
    medianMinutes: median === null ? null : Math.round(median * 10) / 10,
    personChosen: { contactMe: rows.filter((r) => r.status === "human_requested").length, sendWithout: rows.filter((r) => r.status === "declined_by_candidate").length },
    skipped: [...skippedCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, question: label(key), count })),
  };
}
