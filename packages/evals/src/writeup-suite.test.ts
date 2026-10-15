import { describe, expect, it } from "vitest";
import { WriteupModelOutput, screenWriteupPrompt, type StructuredRequest } from "@ros/ai";
import { fakeScreenWriteup } from "@ros/agents";
import { writeupCaseFailures, writeupCases, writeupContextOf, writeupModelFailures } from "./writeup-suite";

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
});
