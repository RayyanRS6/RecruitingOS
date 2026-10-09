import type { ApplyMode, PolicyLevel, RolePacket, ScreeningFunnel, ScreeningQuestion, ScreenProgress, ScreenTranscriptEntry, TapAnswer, TapFormat } from "@ros/contracts";
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
