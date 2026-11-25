import { describe, expect, it } from "vitest";
import type { ScreenTurn } from "@ros/contracts";
import type { ChatTurn } from "@ros/agents";
import { TRACE_CHARS, clipDeep, clipText, traceOutcome, traceTranscript, traceTurn } from "./diagnostics";

/** The full record a failing case keeps in the result file: every text cut, the shape and the decisions kept. */
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

  it("keeps a turn's decisions and its message, and on a turn after the code's rules the answer the code recorded", () => {
    // the model's own turn: it returns no record of an answer, so the record keeps none
    const t: ScreenTurn = { messageToCandidate: long, questionKey: null, followUpReason: "asked about pay", candidateAskedAbout: "pay", sentiment: "confused", done: false, humanRequested: true };
    expect(traceTurn(t)).toEqual({ questionKey: null, followUpReason: "asked about pay", candidateAskedAbout: "pay", sentiment: "confused", done: false, humanRequested: true, message: `${"a".repeat(TRACE_CHARS)}…` });
    expect(traceTurn({ ...t, reading: "vague" }).reading).toBe("vague");
    // the turn after the rules: what the code recorded from the candidate's replies, its words cut like any other, or that it recorded nothing
    const held: ChatTurn = { ...t, answerRecorded: { questionKey: "pay", answer: long, complete: true } };
    expect(traceTurn(held).answerRecorded).toEqual({ questionKey: "pay", answer: `${"a".repeat(TRACE_CHARS)}…`, complete: true });
    expect(traceTurn({ ...t, answerRecorded: null })).toMatchObject({ answerRecorded: null });
  });

  it("keeps what a call returned, or why it returned nothing usable", () => {
    expect(traceOutcome({ ok: true, output: { line: "Thanks" } })).toEqual({ output: { line: "Thanks" } });
    expect(traceOutcome({ ok: false, reason: "invalid", error: "no valid output" })).toEqual({ failed: "invalid: no valid output" });
  });
});
