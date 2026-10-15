import { describe, expect, it } from "vitest";
import type { ScreenTurn } from "@ros/contracts";
import { TRACE_CHARS, clipDeep, clipText, traceOutcome, traceTranscript, traceTurn } from "./diagnostics";

/** The full record a failing case keeps in the result file (Wave S9): every text cut, the shape and the decisions kept. */
describe("a failing case's record", () => {
  const long = "a".repeat(TRACE_CHARS + 50);

  it("cuts each text to TRACE_CHARS and keeps the shape of what the model returned", () => {
    expect(clipText("short")).toBe("short");
    expect(clipText(long)).toBe(`${"a".repeat(TRACE_CHARS)}…`);
    expect(clipDeep({ answers: [{ questionKey: "wq_a", answer: long, quotes: [long], note: null, status: "answered" }], n: 3, ok: true })).toEqual({ answers: [{ questionKey: "wq_a", answer: `${"a".repeat(TRACE_CHARS)}…`, quotes: [`${"a".repeat(TRACE_CHARS)}…`], note: null, status: "answered" }], n: 3, ok: true });
  });

  it("keeps the chat as role and text, with the question an entry is about and how it came", () => {
    expect(traceTranscript([{ role: "assistant", content: "Which days can you work?", questionKey: "availability" }, { role: "candidate", content: long }, { role: "system", content: "Skipped this question.", questionKey: "wq_more", source: "skip" }])).toEqual([
      { role: "assistant", text: "Which days can you work?", questionKey: "availability" },
      { role: "candidate", text: `${"a".repeat(TRACE_CHARS)}…` },
      { role: "system", text: "Skipped this question.", questionKey: "wq_more", source: "skip" },
    ]);
  });

  it("keeps a turn's decisions and its message", () => {
    const t: ScreenTurn = { messageToCandidate: long, questionKey: null, answerRecorded: { questionKey: "pay", answer: "What does it pay?", complete: true }, followUpReason: "asked about pay", candidateAskedAbout: "pay", sentiment: "confused", done: false, humanRequested: true };
    expect(traceTurn(t)).toEqual({ questionKey: null, answerRecorded: { questionKey: "pay", answer: "What does it pay?", complete: true }, followUpReason: "asked about pay", candidateAskedAbout: "pay", sentiment: "confused", done: false, humanRequested: true, message: `${"a".repeat(TRACE_CHARS)}…` });
    expect(traceTurn({ ...t, reading: "vague" }).reading).toBe("vague");
  });

  it("keeps what a call returned, or why it returned nothing usable", () => {
    expect(traceOutcome({ ok: true, output: { line: "Thanks" } })).toEqual({ output: { line: "Thanks" } });
    expect(traceOutcome({ ok: false, reason: "invalid", error: "no valid output" })).toEqual({ failed: "invalid: no valid output" });
  });
});
