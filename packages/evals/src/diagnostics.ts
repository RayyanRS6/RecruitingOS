import type { ScreenTurn } from "@ros/contracts";
import type { RecordedAnswer } from "@ros/agents";

/**
 * The full record a failing case keeps in the result file, so it can be diagnosed without running it again. The chat the
 * model was given, and what the model returned before the code's checks: each turn, or each reading of a CV or of a
 * scorecard; with the turn after the code's rules where the code decides what is recorded, and the reading or scorecard
 * the team would see. Only failing cases carry it, so the file stays small; every case is synthetic, and the fairness
 * run keeps the file as its "fairness-results" download for 90 days. The short `notes` stay what the run's page shows
 * (summary.ts).
 */
export type CaseDiagnostics = {
  /** The chat in order, each message cut to TRACE_CHARS. */
  transcript?: TraceMessage[];
  /** Each turn as the model returned it and as the code's rules left it; `move`: the step the chat plan took (chat.*). */
  turns?: Array<{ model: TraceTurn; afterRules: TraceTurn; move?: string | null }>;
  /** The answers the code recorded, by question, at the end of the conversation. */
  answers?: Record<string, string>;
  /** The readings as the model wrote them (on the scoring view, placeholders and all), or why one gave nothing. */
  readings?: Array<TraceOutput & { label: string }>;
  /** What the team would see: the readings through the code's checks, combined into the middle answer. */
  shown?: Array<TraceOutput & { label: string }>;
  /**
   * The job a case was read against (the one the job builder wrote in the run or, in the suites that compare readings,
   * one of the two written by hand): the questions its AI interview asked (a
   * must-have the chat asked about among them), its must-haves, and each skill with its importance, definition and
   * indicators, as the CV reading is shown them.
   */
  role?: { questions: Array<{ key: string; kind: string; text: string }>; mustHaves: Array<{ key: string; text: string }>; skills: Array<{ key: string; name: string; definition: string; importance: string; indicators: string[] }> };
};

/** How much of one message or one text the record keeps: enough to read what was said, never a whole document. */
export const TRACE_CHARS = 400;

/** `source`: how the entry came (a tapped answer, a change on the check page, a skip), when the record says. */
export type TraceMessage = { role: string; text: string; questionKey?: string; source?: string };

/**
 * A turn's fields that decide what happens next, and the message itself. `answerRecorded`: the answer the code recorded
 * from the candidate's own replies, on a turn after the code's rules only (the model returns no record of an answer).
 */
export type TraceTurn = {
  questionKey: string | null;
  answerRecorded?: RecordedAnswer | null;
  followUpReason: string | null;
  candidateAskedAbout: ScreenTurn["candidateAskedAbout"];
  sentiment: ScreenTurn["sentiment"];
  done: boolean;
  humanRequested: boolean;
  reading?: ScreenTurn["reading"];
  message: string;
};

/** A model call for the record: what it returned, its texts cut, or why it returned nothing usable. */
export type TraceOutput = { output?: unknown; failed?: string };

export const clipText = (s: string, n = TRACE_CHARS): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A model's output for the record: its shape kept, every text in it cut to TRACE_CHARS. */
export function clipDeep(v: unknown): unknown {
  if (typeof v === "string") return clipText(v);
  if (Array.isArray(v)) return v.map(clipDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]));
  return v;
}

/** The chat as role and text (and the question an entry is about, and how it came, when the record says). */
export function traceTranscript(entries: ReadonlyArray<{ role: string; content: string; questionKey?: string; source?: string }>): TraceMessage[] {
  return entries.map((t) => ({ role: t.role, text: clipText(t.content), ...(t.questionKey ? { questionKey: t.questionKey } : {}), ...(t.source ? { source: t.source } : {}) }));
}

/** A turn for the record: the model's own (`ScreenTurn`), or the turn after the code's rules (with what the code recorded). */
export function traceTurn(t: ScreenTurn & { answerRecorded?: RecordedAnswer | null }): TraceTurn {
  return {
    questionKey: t.questionKey,
    ...(t.answerRecorded !== undefined ? { answerRecorded: t.answerRecorded ? { ...t.answerRecorded, answer: clipText(t.answerRecorded.answer) } : null } : {}),
    followUpReason: t.followUpReason === null ? null : clipText(t.followUpReason),
    candidateAskedAbout: t.candidateAskedAbout,
    sentiment: t.sentiment,
    done: t.done,
    humanRequested: t.humanRequested,
    ...(t.reading !== undefined ? { reading: t.reading } : {}),
    message: clipText(t.messageToCandidate),
  };
}

/** A model call's outcome (`runPrompt`) for the record. */
export function traceOutcome(r: { ok: true; output: unknown } | { ok: false; reason: string; error: string }): TraceOutput {
  return r.ok ? { output: clipDeep(r.output) } : { failed: `${r.reason}: ${clipText(r.error)}` };
}
