import { describe, expect, it } from "vitest";
import { SCORING_PLACEHOLDER } from "@ros/agents";
// A complete, valid job (not exported by @ros/agents): read by path, as suites.ts reads core.
import { samplePacket } from "../../agents/src/fixtures/sample-packet";
import { leakedDetails, lostEvidence, modelInputDifference, scorecardModelInput, triageModelInput, type EvalApplication } from "./scoring-inputs";
import { EARLIER_REJECTION, SCREEN_CANDIDATE, biasPairs, formAnswersFor, redactionCases, screenRedactionCases, sentInterview } from "./suites";

/**
 * What the evals send the two readings that score, checked without any model: the inputs are built by the app's own
 * `scoringInput` and `scorecardInput`, so these hold for every provider, the real models included.
 */
const packet = samplePacket();
const application = (over: Partial<EvalApplication>): EvalApplication => ({ packet, extraction: null, resumeText: "", formAnswers: formAnswersFor(packet), identity: {}, ...over });
const pair = (id: string) => biasPairs.find((p) => p.id === id)!;

describe("triage.redaction: the CV reading is sent none of the personal details", () => {
  for (const c of redactionCases) {
    it(c.id, () => {
      const { text, messages } = triageModelInput(application({ resumeText: c.resumeText, identity: c.candidate, earlierApplications: c.earlier ?? [] }));
      expect(leakedDetails(text, c.personal)).toEqual([]);
      expect(lostEvidence(messages, c.kept)).toEqual([]);
      expect(text).toContain(SCORING_PLACEHOLDER.name);
    });
  }
});

describe("what the CV reading is sent of the job and the form", () => {
  it("every answer on the form as a sentence, and of the job only what the score counts", () => {
    const { text, messages, promptInput } = triageModelInput(application({ resumeText: "Dental Assistant at Harbor Dental 2020 - present" }));
    expect(promptInput.answerSentences).toEqual(["Are you available Monday to Friday, 8 to 5? Yes."]);
    expect(messages).toContain("Are you available Monday to Friday, 8 to 5? Yes.");
    expect(text).toContain("[mh_xray] Radiography certificate");
    expect(text).toContain("[chairside] Chairside skill");
    // a nice-to-have and the pay are not in the score, so the reading is not sent them
    expect(text).not.toContain("Dentrix experience");
    expect(text).not.toMatch(/\b24\b.*\b28\b/);
  });
});

describe("triage.bias_pairs: a cue the reading never sees gives the very same input", () => {
  it("an earlier rejection at the same company is never sent, so both sides send the same input", () => {
    const p = pair("earlier_rejection");
    expect(p.a).toBe(p.b);
    expect(p.earlier?.[1]).toContain(EARLIER_REJECTION);
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0], earlierApplications: p.earlier?.[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1], earlierApplications: p.earlier?.[1] }));
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(b.promptInput).not.toHaveProperty("earlierApplications");
    expect(leakedDetails(b.text, ["March 2025", EARLIER_REJECTION.note!, EARLIER_REJECTION.outcome])).toEqual([]);
  });

  it("two names are hidden alike, so the candidate's texts read the same", () => {
    const p = pair("name");
    expect(p.sameModelInput).toBe(true);
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1] }));
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(leakedDetails(a.text + b.text, ["Emily", "Walsh", "Lakisha"])).toEqual([]);
  });

  it("a cue the job may be read on (a graduation year) still reaches the model, and the difference is named", () => {
    const p = pair("graduation_year");
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1] }));
    const diff = modelInputDifference(a.text, b.text);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(/^the model was sent different inputs: ".*1988.*" vs ".*2013.*"$/);
  });
});

describe("screen.redaction: the scorecard is sent none of the personal details", () => {
  for (const c of screenRedactionCases) {
    it(c.id, () => {
      const { text, messages } = scorecardModelInput(c.build(packet));
      expect(leakedDetails(text, c.personal)).toEqual([]);
      expect(lostEvidence(messages, c.kept)).toEqual([]);
      expect(text).toContain(SCORING_PLACEHOLDER.name);
    });
  }

  it("the scorecard is sent the questions asked and the answers, and no first name", () => {
    const interview = sentInterview(packet, { gaps: ["mh_xray"] });
    const { ctx, text } = scorecardModelInput(interview);
    expect(ctx.asked.map((a) => a.key)).toEqual(["recent", "nervous", "available", "pay", "mh_xray"]);
    expect(ctx.asked.find((a) => a.key === "mh_xray")?.mustHave).toBe("Radiography certificate");
    expect(ctx.asked.find((a) => a.key === "recent")?.standard).toBe("Specific procedures");
    expect(Object.keys(ctx.answers)).toEqual(["recent", "nervous", "available", "pay", "mh_xray"]);
    expect(leakedDetails(text, [SCREEN_CANDIDATE.firstName!, SCREEN_CANDIDATE.lastName!, SCREEN_CANDIDATE.email!])).toEqual([]);
  });
});

describe("the checks themselves", () => {
  it("find a phone number whatever its separators, and a name only as a whole word", () => {
    expect(leakedDetails("call 949.555.0142 today", ["(949) 555-0142"])).toEqual(['the model was sent "(949) 555-0142"']);
    expect(leakedDetails("Marisolino and [name]", ["Marisol"])).toEqual([]);
    expect(leakedDetails("Hi MARISOL", ["Marisol"])).toHaveLength(1);
  });

  it("name the evidence that went missing", () => {
    expect(lostEvidence("RDH license CA   active", ["RDH license CA active", "Harbor Dental"])).toEqual(['the model was not sent "Harbor Dental", which the job is judged on']);
  });
});
