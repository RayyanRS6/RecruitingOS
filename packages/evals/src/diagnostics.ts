import type { ScreenTurn } from "@ros/contracts";

/**
 * The full record a failing case keeps in the result file, so it can be diagnosed next time without running it again
 * (Wave S9, spec rule 5; the real-model run of 15 Oct 2026 kept only the failures' one-line reasons). The chat the model
 * was given, and what the model returned before the code's checks: each turn, each scorecard reading, or the write-up;
 * with the turn after the code's rules where the code decides what is recorded, and the scorecard the team would see.
 * Only failing cases carry it, so the file stays small; every case is synthetic, and the fairness run keeps the file as
 * its "fairness-results" download for 90 days. The short `notes` stay what the run's page shows (summary.ts).
 */
export type CaseDiagnostics = {
  /** The chat in order, each message cut to TRACE_CHARS. */
  transcript?: TraceMessage[];
  /** Each turn as the model returned it and as the code's rules left it; `move`: the step the chat plan took (chat.*). */
  turns?: Array<{ model: TraceTurn; afterRules: TraceTurn; move?: string | null }>;
  /** The answers the code recorded, by question, at the end of the conversation. */
  answers?: Record<string, string>;
  /** The scorecard's readings as the model wrote them (on the scoring view, placeholders and all), or why one gave nothing. */
  readings?: Array<TraceOutput & { label: string }>;
  /** The scorecard the team would see: the readings through the code's checks, combined into the middle answer. */
  shown?: Array<TraceOutput & { label: string }>;
  /**
   * The role a scorecard was read against (Wave S9 round 3): the job draft is compiled afresh on each run, and which
   * question is about which skill, and each skill's definition, decide how its answers are read. The triage suites
   * (Wave S9 round 4) record the compiled golden packet a résumé was read against, which changes every run: each skill's
   * `importance` and `indicators` too, as the résumé reading is shown them (no questions: the reading is asked none).
   */
  role?: { questions: Array<{ key: string; kind: string; skill?: string; text: string }>; skills: Array<{ key: string; name: string; definition: string; evaluatedIn?: string; importance?: string; indicators?: string[] }> };
  /** The write-up as the model wrote it, or why the call gave nothing usable. */
  writeup?: TraceOutput;
};

/** How much of one message or one text the record keeps: enough to read what was said, never a whole document. */
export const TRACE_CHARS = 400;

/** `source`: how the entry came (a tapped answer, a change on the check page, a skip), when the record says. */
export type TraceMessage = { role: string; text: string; questionKey?: string; source?: string };

/** A turn's fields that decide what happens next, and the message itself. */
export type TraceTurn = {
  questionKey: string | null;
  answerRecorded: ScreenTurn["answerRecorded"];
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

export function traceTurn(t: ScreenTurn): TraceTurn {
  return {
    questionKey: t.questionKey,
    answerRecorded: t.answerRecorded ? { ...t.answerRecorded, answer: clipText(t.answerRecorded.answer) } : null,
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
