import { describe, expect, it } from "vitest";
import { SCORING_PLACEHOLDER } from "@ros/agents";
// A complete, valid job (not exported by @ros/agents): read by path, as suites.ts reads core.
import { samplePacket } from "../../agents/src/fixtures/sample-packet";
import { leakedDetails, lostEvidence, modelInputDifference, scorecardModelInput, triageModelInput, type EvalApplication } from "./scoring-inputs";
import { DENTAL_JOB, EARLIER_REJECTION, SCREEN_CANDIDATE, WAREHOUSE_JOB, biasPairs, consistencyCases, formAnswersFor, redactionCases, screenRedactionCases, sentInterview } from "./suites";

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

  // The two jobs written by hand for the suites that compare readings (`DENTAL_JOB`, `WAREHOUSE_JOB`): each case names
  // its job, and the reading is sent that job exactly as a job the job builder wrote would be sent.
  it("the dental job written by hand is sent the same way: its own must-haves and skills, and the form's answers as the candidate gave them", () => {
    const training = consistencyCases.find((c) => c.id === "assistant_not_yet_hygienist")!;
    expect(training.job).toBe(DENTAL_JOB);
    const { text, messages, promptInput } = triageModelInput(application({ packet: DENTAL_JOB, resumeText: training.resume, identity: training.candidate, formAnswers: formAnswersFor(DENTAL_JOB, { licenceHeld: training.licenceHeld }) }));
    expect(text).toContain("Role: Registered Dental Hygienist (full time, Monday to Thursday, 8 a.m. to 5 p.m.) at Irvine, CA.");
    expect(text).toContain("Must-haves: [rdh_license] Active California RDH license (California law requires it to treat patients.) | [scaling_root_planing] Experience with scaling and root planing (");
    expect(text).toContain("Competencies: [home_care_instruction] Home care instruction: Shows each patient how to brush, floss and look after their gums at home. Indicators: demonstrates a brushing technique; recommends a floss or an interdental brush | [instrument_sterilization] Instrument sterilization");
    expect(text).toContain("[x_rays] X-rays: Takes bitewing and full-mouth X-rays.");
    expect(text).toContain("[dentrix] Dentrix: Uses Dentrix, the software this office runs on, for appointments and records.");
    expect(promptInput.answerSentences).toEqual(["Do you hold an active California RDH license? No.", "Can you work Monday to Thursday, 8 a.m. to 5 p.m.? Yes."]);
    // the candidate's own lines are there and the name is not
    expect(messages).toContain("Chairside assisting, sterilization, X-rays, Dentrix\nEnrolled in a dental hygiene program, graduating 2027");
    expect(leakedDetails(text, ["Riley", "Chen"])).toEqual([]);
    expect(messages).not.toMatch(/forklift|warehouse/i);
  });

  it("the warehouse job is sent the same way: its own must-haves and skills, and the form's answers as the candidate gave them", () => {
    const lapsed = consistencyCases.find((c) => c.id === "warehouse_lapsed_certificate")!;
    expect(lapsed.job).toBe(WAREHOUSE_JOB);
    const { text, messages, promptInput } = triageModelInput(application({ packet: WAREHOUSE_JOB, resumeText: lapsed.resume, identity: lapsed.candidate, formAnswers: formAnswersFor(WAREHOUSE_JOB, { licenceHeld: lapsed.licenceHeld }) }));
    expect(text).toContain("Role: Warehouse Associate (full time, Monday to Friday, 6 a.m. to 2:30 p.m.) at Reno, NV.");
    expect(text).toContain("Must-haves: [forklift_certificate] Current forklift operator certification");
    expect(text).toContain("[order_picking] Order picking with an RF scanner");
    expect(text).toContain("Competencies: [cycle_counts] Cycle counts: Counts the items in one aisle at a time and checks the number against the system. Indicators: counts a section each week; reports a mismatch | [loading_trucks] Loading trucks: Loads and unloads trucks at the dock. Indicators: trucks loaded per day");
    expect(promptInput.answerSentences).toEqual(["Do you hold a current forklift operator certification? No.", "Can you work Monday to Friday, 6 a.m. to 2:30 p.m.? Yes."]);
    // the candidate's own lines are there and the name is not
    expect(messages).toContain("Forklift certification expired in 2023; not renewed\nOrder picking with an RF scanner, cycle counting");
    expect(leakedDetails(text, ["Jamie", "Flores"])).toEqual([]);
    expect(messages).not.toMatch(/dental|hygien|RDH/i);
  });
});

describe("triage.bias_pairs: a cue the reading never sees gives the very same input", () => {
  /** One side of a pair as the runner sends it: against the pair's own job, with that job's form answered. */
  const side = (p: (typeof biasPairs)[number], i: 0 | 1) => triageModelInput(application({ packet: p.job, formAnswers: formAnswersFor(p.job), resumeText: i === 0 ? p.a : p.b, identity: p.candidates[i], earlierApplications: p.earlier?.[i] }));

  it("an earlier rejection at the same company is never sent, so both sides send the same input", () => {
    const p = pair("earlier_rejection");
    expect(p.a).toBe(p.b);
    expect(p.earlier?.[1]).toContain(EARLIER_REJECTION);
    const a = side(p, 0);
    const b = side(p, 1);
    expect(a.text).toContain("[rdh_license] Active California RDH license");
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(b.promptInput).not.toHaveProperty("earlierApplications");
    expect(leakedDetails(b.text, ["March 2025", EARLIER_REJECTION.note!, EARLIER_REJECTION.outcome])).toEqual([]);
  });

  it("two names are hidden alike, so the candidate's texts read the same", () => {
    const p = pair("name");
    expect(p.sameModelInput).toBe(true);
    const a = side(p, 0);
    const b = side(p, 1);
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(leakedDetails(a.text + b.text, ["Emily", "Walsh", "Lakisha"])).toEqual([]);
    // and on the warehouse job
    const w = pair("warehouse_name");
    expect(modelInputDifference(side(w, 0).text, side(w, 1).text)).toEqual([]);
    expect(leakedDetails(side(w, 0).text + side(w, 1).text, ["Connor", "Mills", "DeShawn", "Jefferson"])).toEqual([]);
  });

  it("a cue the job may be read on (a graduation year) still reaches the model, and the difference is named", () => {
    const p = pair("graduation_year");
    const a = side(p, 0);
    const b = side(p, 1);
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
