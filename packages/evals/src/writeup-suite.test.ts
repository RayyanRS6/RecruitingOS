import { describe, expect, it } from "vitest";
import { WriteupModelOutput, screenWriteupPrompt, type StructuredRequest } from "@ros/ai";
import { fakeScreenWriteup } from "@ros/agents";
import { writeupCaseFailures, writeupCaseNotes, writeupCases, writeupContextOf, writeupModelFailures } from "./writeup-suite";

/**
 * The write-up suite (`screen.writeup`, Wave S7) without a model: every case passes on the fake provider (the code
 * draft, the candidate's own replies), and the suite names a model answer that invents, mixes a note in, turns a no
 * into a yes or keeps a protected detail, while the app's own checks keep none of it.
 */
const fakeRun = (id: string) => {
  const wc = writeupCases.find((x) => x.id === id);
  if (!wc) throw new Error(`no case ${id}`);
  const ctx = writeupContextOf(wc);
  const req = { task: "screen.writeup", messages: screenWriteupPrompt.messages(ctx), system: screenWriteupPrompt.system(ctx), schema: WriteupModelOutput } as unknown as StructuredRequest<unknown>;
  return { wc, output: WriteupModelOutput.parse(fakeScreenWriteup(req)) };
};

describe("screen.writeup cases on the fake provider", () => {
  it("has the cases the contract asks for", () => {
    expect(writeupCases.map((c) => c.id)).toEqual(expect.arrayContaining(["no_experience_stays_no", "missing_example_noted_apart", "protected_detail_left_out", "skipped_question"]));
    for (const c of writeupCases) expect(c.provenance).toBe("synthetic");
  });
  for (const c of writeupCases) {
    it(c.id, () => {
      const { wc, output } = fakeRun(c.id);
      expect(writeupCaseFailures(wc, output)).toEqual([]);
    });
  }
  it("still passes with no model at all (the app's draft)", () => {
    for (const c of writeupCases) expect(writeupCaseFailures(c, null).filter((f) => f !== "the model gave no usable answer"), c.id).toEqual([]);
  });
});

describe("the suite names what a model must never write, and the app keeps none of it", () => {
  const scripted = (id: string, answers: Array<{ questionKey: string; answer: string; status?: "answered" | "partly" | "not_given"; quotes?: string[]; note?: string | null }>) => {
    const { wc, output } = fakeRun(id);
    const byKey = new Map(answers.map((x) => [x.questionKey, x]));
    const out: WriteupModelOutput = { answers: output.answers.map((x) => { const s = byKey.get(x.questionKey); return s ? { ...x, status: s.status ?? "answered", quotes: s.quotes ?? x.quotes, note: s.note ?? null, answer: s.answer } : x; }) };
    const all = writeupCaseFailures(wc, out);
    return { model: writeupModelFailures(wc, out), kept: all.filter((f) => !f.startsWith("model:")) };
  };

  it("an invented tool", () => {
    const r = scripted("plain_answers", [{ questionKey: "wq_patients", answer: "I see nine patients a day and chart in Dentrix, Eaglesoft, Open Dental and Curve." }]);
    expect(r.model.some((f) => f.includes("something they did not write"))).toBe(true);
    expect(r.kept).toEqual([]);
  });

  it("a no turned into a yes", () => {
    const r = scripted("no_experience_stays_no", [{ questionKey: "wq_arduino", answer: "Yes, I have.", quotes: ["No, I haven't."] }]);
    expect(r.model.some((f) => f.includes("turned"))).toBe(true);
    expect(r.kept).toEqual([]);
  });

  it("the assistant's note inside the answer, or the answer about the candidate", () => {
    const inside = scripted("missing_example_noted_apart", [{ questionKey: "wq_debug", status: "partly", answer: "It was very technical, but I handled it well. No specific fault was given.", note: "No specific fault was given." }]);
    expect(inside.model.some((f) => f.includes("note inside"))).toBe(true);
    expect(inside.kept).toEqual([]);
    const third = scripted("plain_answers", [{ questionKey: "wq_why", answer: "The candidate likes knowing patients by name." }]);
    expect(third.model.some((f) => f.includes("not in their voice"))).toBe(true);
    expect(third.kept).toEqual([]);
  });

  it("a protected detail", () => {
    const r = scripted("protected_detail_left_out", [{ questionKey: "wq_start", answer: "I can start on the 3rd; my kids are in school until three, so Monday to Thursday works best.", quotes: ["I can start on the 3rd."] }]);
    expect(r.model.some((f) => f.includes("protected detail"))).toBe(true);
    expect(r.kept).toEqual([]);
  });

  // Wave S9: what the real model wrote on 15 Oct 2026 (a short reply filled out with the question's words, and the
  // conversation written up instead of the answer), each named and none kept; and the answers prompt v2 asks for pass.
  it("a short reply filled out with the question's words, or the conversation written up", () => {
    const real: Array<[string, string, string]> = [
      ["no_experience_stays_no", "wq_arduino", "No, I have not built a hardware project with Arduino."],
      ["no_experience_stays_no", "wq_class", "No, I have never taught a class, so I have no example of teaching twenty students."],
      ["missing_example_noted_apart", "wq_debug", "I said it was very technical, but that I handled it well. When asked to walk through one specific fault, I said no, not really."],
      ["skipped_question", "wq_patients", "I usually see about eight patients in a day."],
    ];
    for (const [id, key, answer] of real) {
      const r = scripted(id, [{ questionKey: key, answer }]);
      expect(r.model.some((f) => f.includes(`${key} says something they did not write`)), `${id} ${key}`).toBe(true);
      expect(r.kept, `${id} ${key}`).toEqual([]);
    }
  });

  it("short replies kept short, and a missing example noted apart, pass", () => {
    expect(scripted("no_experience_stays_no", [{ questionKey: "wq_arduino", answer: "No, I haven't." }, { questionKey: "wq_class", answer: "I have never taught a class." }])).toEqual({ model: [], kept: [] });
    expect(scripted("skipped_question", [{ questionKey: "wq_patients", answer: "About eight." }])).toEqual({ model: [], kept: [] });
    expect(scripted("missing_example_noted_apart", [{ questionKey: "wq_debug", status: "partly", answer: "It was very technical, but I handled it well.", note: "No specific fault was described." }])).toEqual({ model: [], kept: [] });
  });

  it("the result file's notes name the words that were not theirs and why an answer was not kept", () => {
    const { wc, output } = fakeRun("skipped_question");
    const notes = writeupCaseNotes(wc, { answers: output.answers.map((x) => (x.questionKey === "wq_patients" ? { ...x, answer: "I usually see about eight patients in a day." } : x)) });
    expect(notes[0]).toBe(`prompt: screen.writeup v${screenWriteupPrompt.version}; skipped: ["wq_more"]`);
    expect(notes.some((n) => n.startsWith("model wq_patients:") && n.includes("not theirs: usually, patients (from the question or the assistant's lines: usually, patients)"))).toBe(true);
    expect(notes).toContain('shown wq_patients: answered "About eight." note=- | REPLACED by their words: words they did not write');
    expect(notes).toContain('shown wq_more: skipped "" note=- | a skip on record');
    expect(writeupCaseNotes(wc, null, "invalid: no valid output")).toContain("no usable answer from the model: invalid: no valid output");
  });
});
