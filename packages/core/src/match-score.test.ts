import { describe, expect, it } from "vitest";
import { CHAT_WRAP_KEY, CHAT_WRAP_QUESTION, EARLIER_VERSION_LINE, MISSING_MUST_HAVE_CAP, type EvidenceAssessment, type ScreenAssessment } from "@ros/contracts";
import { cvScoreFromReading, interviewScoreFromScorecard, sameRequirements } from "./match-score";

const skill = (key: string, name: string, importance: "essential" | "important" | "helpful") => ({ key, name, definition: "", importance, indicators: [] as string[] });
/** Two must-haves (4 points each), an Essential skill (3) and a Helpful one (1): 12 points in all. */
const packet = {
  requirements: { mustHaves: [{ key: "mh_license", text: "Active RDA license" }, { key: "mh_xray", text: "X-ray certification" }], niceToHaves: [] },
  competencies: [skill("c_chairside", "Chairside assisting", "essential"), skill("c_dentrix", "Dentrix", "helpful"), skill("c_license", "active RDA license.", "important")],
};
const quoted = (quote: string, source: "resume" | "application" = "resume") => ({ source, quote });
type Reading = Pick<EvidenceAssessment, "requirementFindings" | "competencyFindings">;

describe("the CV score of one reading", () => {
  const reading: Reading = {
    requirementFindings: [
      { requirementKey: "mh_license", met: "yes", evidence: quoted(" RDA license #4471, active through 2027 ") },
      // said to be met, with a quote the code did not find in their words
      { requirementKey: "mh_xray", met: "yes", evidence: { source: "resume", quote: "Certified in radiography", unquoted: true } },
    ],
    competencyFindings: [{ competencyKey: "c_chairside", finding: "evidenced", evidence: quoted("Yes.", "application") }, { competencyKey: "c_other", finding: "evidenced", evidence: quoted("Not a skill of this job") }],
  };

  it("lists every must-have, then every skill counted, in the job's order, with the finding and its checked quote", () => {
    const score = cvScoreFromReading(reading, packet);
    expect(score.requirements.map((r) => [r.key, r.label, r.mustHave, r.importance, r.finding, r.quote, r.source])).toEqual([
      ["mh_license", "Active RDA license", true, null, "shown", "RDA license #4471, active through 2027", "resume"],
      ["mh_xray", "X-ray certification", true, null, "partly", null, null],
      ["c_chairside", "Chairside assisting", false, "essential", "shown", "Yes.", "application"],
      ["c_dentrix", "Dentrix", false, "helpful", "not_shown", null, null],
    ]);
    // 4 + 2 + 3 + 0 of 12 points; the skill named like a must-have is counted once, as the must-have
    expect(score).toMatchObject({ score: 75, band: "high", bandLabel: "High", noScore: null, held: false, mustHaves: { shown: 1, total: 2 }, mustHaveLine: "1 of 2 must-haves shown", missingLine: null, earlierVersion: false });
    expect(score.requirements.map((r) => r.weightPct)).toEqual([33, 33, 25, 8]);
  });

  it("holds the number at the cap when their own words show a must-have is not met, and only then", () => {
    const all = (license: Reading["requirementFindings"][number]): Reading => ({
      requirementFindings: [license, { requirementKey: "mh_xray", met: "yes", evidence: quoted("X-ray certified 2022") }],
      competencyFindings: [{ competencyKey: "c_chairside", finding: "evidenced", evidence: quoted("Four years chairside") }, { competencyKey: "c_dentrix", finding: "evidenced", evidence: quoted("Dentrix daily") }],
    });
    const notMet = cvScoreFromReading(all({ requirementKey: "mh_license", met: "no", evidence: quoted("No.", "application") }), packet);
    expect(notMet).toMatchObject({ score: MISSING_MUST_HAVE_CAP, held: true, band: "low", missingLine: "Missing a must-have: Active RDA license", mustHaves: { shown: 1, total: 2 } });
    expect(notMet.missingMustHaves).toEqual([{ key: "mh_license", label: "Active RDA license", quote: "No." }]);
    // "not met" with nothing of theirs quoted is not known: it earns nothing and holds nothing
    const unknown = cvScoreFromReading(all({ requirementKey: "mh_license", met: "no" }), packet);
    expect(unknown).toMatchObject({ score: 67, held: false, missingLine: null });
    expect(unknown.requirements[0]).toMatchObject({ finding: "not_shown", quote: null });
  });

  it("can never read 100 beside a must-have that is not shown: every must-have of the job is in the number", () => {
    // one must-have nothing was said about, the job's one skill shown in full: 3 of 7 points, never 100
    const job = { requirements: { mustHaves: [{ key: "mh_practical", text: "Passes our practical test" }], niceToHaves: [] }, competencies: [skill("c_chairside", "Chairside assisting", "essential")] };
    expect(cvScoreFromReading({ requirementFindings: [], competencyFindings: [{ competencyKey: "c_chairside", finding: "evidenced", evidence: quoted("Four years chairside") }] }, job)).toMatchObject({ score: 43, mustHaves: { shown: 0, total: 1 }, mustHaveLine: "0 of 1 must-have shown" });
    // and over every combination of findings on the two must-haves and the two counted skills
    const mets = ["yes", "partially", "no", "unknown"] as const;
    const finds = ["evidenced", "partially_evidenced", "contradicted", "not_evidenced"] as const;
    for (const licence of mets) for (const xray of mets) for (const chairside of finds) for (const dentrix of finds) {
      const score = cvScoreFromReading({
        requirementFindings: [{ requirementKey: "mh_license", met: licence, evidence: quoted("their words") }, { requirementKey: "mh_xray", met: xray, evidence: quoted("their words") }],
        competencyFindings: [{ competencyKey: "c_chairside", finding: chairside, evidence: quoted("their words") }, { competencyKey: "c_dentrix", finding: dentrix, evidence: quoted("their words") }],
      }, packet);
      const everyMustHaveShown = licence === "yes" && xray === "yes";
      expect(score.mustHaves, `${licence} ${xray}`).toEqual({ shown: [licence, xray].filter((m) => m === "yes").length, total: 2 });
      if (score.score === 100) expect(everyMustHaveShown, `${licence} ${xray} ${chairside} ${dentrix}`).toBe(true);
      if (!everyMustHaveShown) expect(score.score, `${licence} ${xray} ${chairside} ${dentrix}`).toBeLessThan(100);
    }
  });

  it("scores a reading that found nothing as zero, and says when it was read against an earlier version of the job", () => {
    expect(cvScoreFromReading({ requirementFindings: [], competencyFindings: [] }, packet)).toMatchObject({ score: 0, band: "low", mustHaveLine: "0 of 2 must-haves shown", earlierVersion: false, earlierVersionLine: null });
    expect(cvScoreFromReading(reading, packet, { earlierVersion: true })).toMatchObject({ score: 75, earlierVersion: true, earlierVersionLine: EARLIER_VERSION_LINE });
  });
});

describe("whether two versions of a job ask for the same things", () => {
  it("compares the must-haves and the counted skills, worded and weighted the same, and nothing else", () => {
    expect(sameRequirements(packet, packet)).toBe(true);
    const reworded = { ...packet, competencies: packet.competencies.map((c) => ({ ...c, definition: "What it means here", indicators: ["charts"] })), requirements: { ...packet.requirements, mustHaves: packet.requirements.mustHaves.map((m) => ({ ...m, text: ` ${m.text} `, rationale: "Required by the state" })), niceToHaves: [{ key: "n1", text: "Spanish" }] } };
    expect(sameRequirements(packet, reworded)).toBe(true);
    // a skill named exactly like a must-have was never counted: dropping it changes nothing
    expect(sameRequirements(packet, { ...packet, competencies: packet.competencies.slice(0, 2) })).toBe(true);
    expect(sameRequirements(packet, { ...packet, competencies: [skill("c_chairside", "Chairside assisting", "important"), packet.competencies[1]] })).toBe(false);
    expect(sameRequirements(packet, { ...packet, competencies: [packet.competencies[0]] })).toBe(false);
    expect(sameRequirements(packet, { ...packet, requirements: { ...packet.requirements, mustHaves: [{ key: "mh_license", text: "Active RDA license in California" }, packet.requirements.mustHaves[1]] } })).toBe(false);
    expect(sameRequirements(packet, { ...packet, requirements: { ...packet.requirements, mustHaves: [packet.requirements.mustHaves[0]] } })).toBe(false);
  });

  it("reads a version stored with a skill's older 1-5 weight as the importance the weight stands for", () => {
    const older = { ...packet, competencies: [{ key: "c_chairside", name: "Chairside assisting", definition: "", weight: 5, indicators: [] }, { key: "c_dentrix", name: "Dentrix", definition: "", weight: 2, indicators: [] }] } as unknown as typeof packet;
    expect(sameRequirements(packet, older)).toBe(true);
    const reading = { requirementFindings: [], competencyFindings: [{ competencyKey: "c_chairside", finding: "evidenced" as const, evidence: quoted("Four years chairside") }] };
    // 3 of 12 points either way: Essential weighs 3 and Helpful 1
    expect(cvScoreFromReading(reading, older).score).toBe(cvScoreFromReading(reading, packet).score);
    expect(cvScoreFromReading(reading, older).requirements.map((r) => r.importance)).toEqual([null, null, "essential", "helpful"]);
  });
});

describe("the interview score of one scorecard", () => {
  const asked = [{ key: "q_nervous", question: "How do you settle a nervous patient?" }, { key: "q_room", question: "How do you turn a room over?" }, { key: "mh_xray", question: "X-ray certification" }, { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION }];
  const card: Pick<ScreenAssessment, "questionFindings"> = {
    questionFindings: [
      { questionKey: "q_room", answered: true, finding: " Names the steps but not the order. ", meetsModelAnswer: "partially", evidence: { source: "screen", quote: "I wipe everything down", unquoted: true } },
      { questionKey: "q_nervous", answered: true, finding: "Gives a real example with what they said.", meetsModelAnswer: "yes", evidence: { source: "screen", quote: " I tell them what each sound is before it starts " } },
      { questionKey: CHAT_WRAP_KEY, answered: true, finding: "Says they can start Monday.", meetsModelAnswer: "yes" },
    ],
  };

  it("lists each question the interview asked, in the order asked, and never the closing question", () => {
    const score = interviewScoreFromScorecard(card, asked);
    expect(score.questions.map((q) => [q.key, q.question, q.finding, q.findingLabel, q.quote, q.note])).toEqual([
      ["q_nervous", "How do you settle a nervous patient?", "shown", "Shown", "I tell them what each sound is before it starts", "Gives a real example with what they said."],
      ["q_room", "How do you turn a room over?", "partly", "Partly shown", null, "Names the steps but not the order."],
      // asked, and the scorecard says nothing about it: not shown, never a no
      ["mh_xray", "X-ray certification", "not_shown", "Not shown yet", null, null],
    ]);
    // 100 + 50 + 0 over three questions
    expect(score).toMatchObject({ score: 50, band: "low", noScore: null, answered: { met: 1, total: 3 }, answeredLine: "1 of 3 questions answered to the job's standard" });
  });

  it("has no number when the interview asked nothing that is scored", () => {
    expect(interviewScoreFromScorecard(card, [{ key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION }])).toMatchObject({ score: null, noScore: "not_scored", answeredLine: null, questions: [] });
    expect(interviewScoreFromScorecard({ questionFindings: [] }, asked.slice(0, 2))).toMatchObject({ score: 0, answered: { met: 0, total: 2 } });
  });
});
