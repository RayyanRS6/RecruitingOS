import { describe, expect, it } from "vitest";
import { CV_NO_SCORE_LABEL, EARLIER_VERSION_LINE, FINDING_CREDIT, INTERVIEW_NO_SCORE_LABEL, MATCH_SCORE_BANDS, MATCH_WEIGHT, MISSING_MUST_HAVE_CAP, SCORE_FINDING_LABEL, ScoreFinding, byCvScore, byInterviewScore, cvScoreOf, cvScoreSummary, importanceOf, interviewScoreOf, interviewScoreSummary, interviewSum, matchBand, matchWeightOf, noCvScore, noInterviewScore, questionFinding, repeatsMustHave, requirementFinding, skillFinding, skillsInScore, weighRequirements, type Importance, type ScoredRequirement, type WeighedRequirement } from "./score";

const must = (key: string, finding: ScoreFinding, quote: string | null = null): ScoredRequirement => ({ key, label: `Must ${key}`, mustHave: true, importance: null, finding, quote, source: quote ? "resume" : null });
const skill = (key: string, importance: Importance, finding: ScoreFinding, quote: string | null = null): ScoredRequirement => ({ key, label: `Skill ${key}`, mustHave: false, importance, finding, quote, source: quote ? "resume" : null });
const weighed = (r: ScoredRequirement): WeighedRequirement => ({ weight: matchWeightOf(r), finding: r.finding, mustHave: r.mustHave });

/** A small seeded generator, so the property tests try the same cases every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the one band table", () => {
  it("cuts at 85, 70 and 55, with one word per band", () => {
    expect(MATCH_SCORE_BANDS).toEqual([{ band: "very_high", min: 85, label: "Very high" }, { band: "high", min: 70, label: "High" }, { band: "medium", min: 55, label: "Medium" }, { band: "low", min: 0, label: "Low" }]);
    expect([100, 85, 84, 70, 69, 55, 54, 0].map((n) => matchBand(n)?.label)).toEqual(["Very high", "Very high", "High", "High", "Medium", "Medium", "Low", "Low"]);
  });

  it("has no band without a number, and reads a number outside 0 to 100 as its nearest end", () => {
    for (const none of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(matchBand(none)).toBeNull();
    expect(matchBand(130)).toEqual({ band: "very_high", label: "Very high" });
    expect(matchBand(-4)).toEqual({ band: "low", label: "Low" });
    expect(matchBand(84.6)?.band).toBe("very_high");
  });
});

describe("the one set of finding words", () => {
  it("is shown, partly shown, not met and not shown yet, worth all, half, nothing and nothing", () => {
    expect(ScoreFinding.options.map((f) => [f, SCORE_FINDING_LABEL[f], FINDING_CREDIT[f]])).toEqual([["shown", "Shown", 100], ["partly", "Partly shown", 50], ["not_met", "Not met", 0], ["not_shown", "Not shown yet", 0]]);
  });

  it("reads a must-have as shown only with a checked quote, and as not met only with one", () => {
    expect(requirementFinding("yes", true)).toBe("shown");
    expect(requirementFinding("yes", false)).toBe("partly");
    expect(requirementFinding("partially", true)).toBe("partly");
    expect(requirementFinding("partially", false)).toBe("partly");
    expect(requirementFinding("no", true)).toBe("not_met");
    expect(requirementFinding("no", false)).toBe("not_shown");
    expect(requirementFinding("unknown", true)).toBe("not_shown");
  });

  it("reads a skill by the same rule", () => {
    expect(skillFinding("evidenced", true)).toBe("shown");
    expect(skillFinding("evidenced", false)).toBe("partly");
    expect(skillFinding("partially_evidenced", false)).toBe("partly");
    expect(skillFinding("contradicted", true)).toBe("not_met");
    expect(skillFinding("contradicted", false)).toBe("not_shown");
    expect(skillFinding("not_evidenced", true)).toBe("not_shown");
  });

  it("reads an interview question from whether the answer met the job's standard", () => {
    expect((["yes", "partially", "no", "unknown"] as const).map(questionFinding)).toEqual(["shown", "partly", "not_met", "not_shown"]);
  });
});

describe("the CV score's sums", () => {
  it("weighs a must-have 4 and a skill 3, 2 or 1 by its importance", () => {
    expect(MATCH_WEIGHT).toEqual({ must_have: 4, essential: 3, important: 2, helpful: 1 });
    expect([must("a", "shown"), skill("b", "essential", "shown"), skill("c", "important", "shown"), skill("d", "helpful", "shown")].map(matchWeightOf)).toEqual([4, 3, 2, 1]);
  });

  it("is the points earned over the points of every requirement: shown all, partly half, anything else nothing", () => {
    // 4 + 2 of 4 + 1.5 of 3 + 2 + 0 of 1: 9.5 of 14
    const items = [must("m1", "shown"), must("m2", "partly"), skill("s1", "essential", "partly"), skill("s2", "important", "shown"), skill("s3", "helpful", "not_met")];
    expect(weighRequirements(items.map(weighed))).toMatchObject({ score: 68, held: false });
    expect(weighRequirements([must("m1", "shown"), skill("s1", "helpful", "shown")].map(weighed)).score).toBe(100);
    // nothing shown is a number too: a CV that was read and shows nothing scores 0, never "no score"
    expect(weighRequirements([must("m1", "not_shown"), skill("s1", "helpful", "not_shown")].map(weighed)).score).toBe(0);
  });

  it("gives each requirement its share of the score and the points it lost", () => {
    const { parts } = weighRequirements([must("m1", "shown"), skill("s1", "helpful", "not_met")].map(weighed));
    expect(parts).toEqual([{ share: 80, lost: 0 }, { share: 20, lost: 20 }]);
  });

  it("has no number only when the job lists no requirement", () => {
    expect(weighRequirements([])).toEqual({ score: null, held: false, parts: [] });
    expect(weighRequirements([{ weight: 0, finding: "shown", mustHave: false }]).score).toBeNull();
  });

  it("holds the number at 54 when a must-have is shown not met, and only then", () => {
    expect(MISSING_MUST_HAVE_CAP).toBe(54);
    // 10 of 14 would be 71
    const strong = [must("m1", "not_met"), must("m2", "shown"), skill("s1", "essential", "shown"), skill("s2", "important", "shown"), skill("s3", "helpful", "shown")];
    expect(weighRequirements(strong.map(weighed))).toMatchObject({ score: 54, held: true });
    // a skill shown not met never holds it
    expect(weighRequirements([must("m1", "shown"), must("m2", "shown"), skill("s1", "helpful", "not_met")].map(weighed))).toMatchObject({ score: 89, held: false });
    // a must-have nothing was said about is not a no
    expect(weighRequirements([must("m1", "not_shown"), must("m2", "shown"), skill("s1", "essential", "shown"), skill("s2", "important", "shown"), skill("s3", "helpful", "shown")].map(weighed))).toMatchObject({ score: 71, held: false });
    // already under 54: nothing was held
    expect(weighRequirements([must("m1", "not_met"), must("m2", "not_shown"), skill("s1", "helpful", "shown")].map(weighed))).toMatchObject({ score: 11, held: false });
  });

  it("never lowers the score when any one finding moves up: not met, not shown, partly, shown", () => {
    const rand = seeded(20261118);
    const ORDER: ScoreFinding[] = ["not_met", "not_shown", "partly", "shown"];
    const IMPORTANCE: Importance[] = ["essential", "important", "helpful"];
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    let checked = 0;
    for (let n = 0; n < 600; n++) {
      const items: ScoredRequirement[] = [
        ...Array.from({ length: Math.floor(rand() * 5) }, (_, i) => must(`m${i}`, pick(ORDER))),
        ...Array.from({ length: Math.floor(rand() * 7) }, (_, i) => skill(`s${i}`, pick(IMPORTANCE), pick(ORDER))),
      ];
      const before = weighRequirements(items.map(weighed)).score;
      const fullBefore = cvScoreOf(items);
      expect(fullBefore.score).toBe(before);
      // the must-have line and the number come from one list: a full score always shows every must-have
      if (before === 100) expect(fullBefore.mustHaves.shown).toBe(fullBefore.mustHaves.total);
      if (fullBefore.mustHaves.shown < fullBefore.mustHaves.total) expect(before).not.toBe(100);
      items.forEach((item, at) => {
        for (const up of ORDER.slice(ORDER.indexOf(item.finding) + 1)) {
          const moved = items.map((x, i) => (i === at ? { ...x, finding: up } : x));
          const after = weighRequirements(moved.map(weighed)).score;
          expect(after ?? -1, `${JSON.stringify(items.map((x) => [x.key, x.finding]))}: ${item.key} ${item.finding} to ${up}`).toBeGreaterThanOrEqual(before ?? -1);
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("the CV score as the team reads it", () => {
  it("carries the number, its band, the must-have line and the breakdown, all from one list", () => {
    // 4 + 0 of 4 + 1.5 of 3 + 1: 6.5 of 12
    const s = cvScoreOf([must("m1", "shown", "RDH license, California"), must("m2", "not_shown"), skill("s1", "essential", "partly"), skill("s2", "helpful", "shown", "Dentrix daily")]);
    expect(s).toMatchObject({ score: 54, band: "low", bandLabel: "Low", noScore: null, noScoreLabel: null, mustHaves: { shown: 1, total: 2 }, mustHaveLine: "1 of 2 must-haves shown", held: false, missingMustHaves: [], missingLine: null, earlierVersion: false, earlierVersionLine: null });
    expect(s.requirements.map((r) => [r.key, r.weightPct, r.finding, r.findingLabel, r.quote])).toEqual([["m1", 33, "shown", "Shown", "RDH license, California"], ["m2", 33, "not_shown", "Not shown yet", null], ["s1", 25, "partly", "Partly shown", null], ["s2", 8, "shown", "Shown", "Dentrix daily"]]);
    expect(s.requirements[0]).toMatchObject({ label: "Must m1", mustHave: true, importance: null, source: "resume" });
  });

  it("can never say 100 beside a must-have that is not shown", () => {
    const s = cvScoreOf([must("m1", "not_shown"), skill("s1", "essential", "shown")]);
    expect(s.score).toBe(43);
    expect(s.mustHaveLine).toBe("0 of 1 must-have shown");
    expect(cvScoreOf([must("m1", "shown"), skill("s1", "essential", "shown")])).toMatchObject({ score: 100, mustHaveLine: "1 of 1 must-have shown" });
  });

  it("names the must-have that is shown not met, whether or not it held the number", () => {
    const held = cvScoreOf([must("rda", "not_met", "I have never held a license"), must("m2", "shown"), skill("s1", "essential", "shown"), skill("s2", "important", "shown"), skill("s3", "helpful", "shown")]);
    expect(held).toMatchObject({ score: 54, held: true, missingLine: "Missing a must-have: Must rda", missingMustHaves: [{ key: "rda", label: "Must rda", quote: "I have never held a license" }] });
    const low = cvScoreOf([must("rda", "not_met", "no license"), must("x", "not_met", "never"), skill("s1", "helpful", "shown")]);
    expect(low).toMatchObject({ score: 11, held: false, missingLine: "Missing a must-have: Must rda; Must x" });
  });

  it("says so when it was scored against an earlier version of the job", () => {
    expect(cvScoreOf([must("m1", "shown")], { earlierVersion: true })).toMatchObject({ score: 100, earlierVersion: true, earlierVersionLine: EARLIER_VERSION_LINE });
    expect(EARLIER_VERSION_LINE).toBe("Scored against an earlier version of the job");
  });

  it("says why there is no number when there is none", () => {
    expect(CV_NO_SCORE_LABEL).toEqual({ being_read: "Reading the CV", unreadable: "CV could not be read", not_scored: "Not scored yet", ai_used_up: "Not scored: your plan's AI help is used up", locked: "Locked" });
    expect(noCvScore("unreadable")).toEqual({ score: null, band: null, bandLabel: null, noScore: "unreadable", noScoreLabel: "CV could not be read", mustHaves: { shown: 0, total: 0 }, mustHaveLine: null, held: false, missingMustHaves: [], missingLine: null, requirements: [], earlierVersion: false, earlierVersionLine: null });
    // a reading of a job with no requirement has nothing to weigh
    expect(cvScoreOf([])).toMatchObject({ score: null, noScore: "not_scored", noScoreLabel: "Not scored yet", mustHaveLine: null });
  });

  it("gives a row the number or the reason, and the two lines", () => {
    expect(cvScoreSummary(cvScoreOf([must("m1", "shown"), must("m2", "partly")]))).toEqual({ score: 75, band: "high", bandLabel: "High", noScore: null, noScoreLabel: null, mustHaveLine: "1 of 2 must-haves shown", missingLine: null, earlierVersion: false });
    expect(cvScoreSummary(noCvScore("being_read"))).toEqual({ score: null, band: null, bandLabel: null, noScore: "being_read", noScoreLabel: "Reading the CV", mustHaveLine: null, missingLine: null, earlierVersion: false });
  });
});

describe("the interview score", () => {
  it("counts each question once: answered to the job's standard all, partly half, otherwise nothing", () => {
    expect(interviewSum(["shown", "partly", "not_met", "not_shown"])).toBe(38);
    expect(interviewSum(["shown", "shown"])).toBe(100);
    expect(interviewSum(["not_shown"])).toBe(0);
    expect(interviewSum([])).toBeNull();
  });

  it("carries the number, the same band words and the per-question table", () => {
    const s = interviewScoreOf([
      { key: "q1", question: "Tell me about a busy day.", finding: "shown", quote: "We saw 40 patients", note: "Gave a concrete day." },
      { key: "q2", question: "How do you handle a late patient?", finding: "shown", quote: "I call ahead", note: null },
      { key: "mh_2", question: "Active RDA license", finding: "partly", quote: null, note: "Said it is being renewed." },
    ]);
    expect(s).toMatchObject({ score: 83, band: "high", bandLabel: "High", noScore: null, noScoreLabel: null, answered: { met: 2, total: 3 }, answeredLine: "2 of 3 questions answered to the job's standard" });
    expect(s.questions.map((q) => [q.key, q.finding, q.findingLabel])).toEqual([["q1", "shown", "Shown"], ["q2", "shown", "Shown"], ["mh_2", "partly", "Partly shown"]]);
    expect(interviewScoreOf([{ key: "q1", question: "One?", finding: "shown", quote: null, note: null }]).answeredLine).toBe("1 of 1 question answered to the job's standard");
  });

  it("says why a sent interview has no number", () => {
    expect(INTERVIEW_NO_SCORE_LABEL).toEqual({ being_scored: "Scoring the AI interview", not_scored: "AI interview could not be scored", ai_used_up: "Not scored: your plan's AI help is used up" });
    expect(noInterviewScore("being_scored")).toEqual({ score: null, band: null, bandLabel: null, noScore: "being_scored", noScoreLabel: "Scoring the AI interview", answered: { met: 0, total: 0 }, answeredLine: null, questions: [] });
    expect(interviewScoreOf([])).toMatchObject({ score: null, noScore: "not_scored" });
    expect(interviewScoreSummary(noInterviewScore("ai_used_up"))).toEqual({ score: null, band: null, bandLabel: null, noScore: "ai_used_up", noScoreLabel: "Not scored: your plan's AI help is used up", answeredLine: null });
  });

  it("is never part of the CV score, nor the CV score of it", () => {
    const cv = cvScoreOf([must("m1", "partly")]);
    const interview = interviewScoreOf([{ key: "q1", question: "One?", finding: "shown", quote: null, note: null }]);
    expect(cv.score).toBe(50);
    expect(interview.score).toBe(100);
    expect(Object.keys(cv)).not.toContain("questions");
    expect(Object.keys(interview)).not.toContain("requirements");
  });
});

describe("the order of a list", () => {
  const row = (id: string, cv: number | null, appliedAt: string, interview?: number | null) => ({ id, cvScore: { score: cv }, interviewScore: interview === undefined ? null : { score: interview }, appliedAt });

  it("is the CV score, highest first, people with no score last, then who applied first", () => {
    const rows = [row("late80", 80, "2026-11-03T10:00:00.000Z"), row("none", null, "2026-11-01T10:00:00.000Z"), row("top", 95, "2026-11-04T10:00:00.000Z"), row("early80", 80, "2026-11-02T10:00:00.000Z"), row("none2", null, "2026-11-01T09:00:00.000Z"), row("zero", 0, "2026-11-05T10:00:00.000Z")];
    expect([...rows].sort(byCvScore).map((r) => r.id)).toEqual(["top", "early80", "late80", "zero", "none2", "none"]);
  });

  it("is the interview score on the Interviewed tab, then the CV score, then who applied first", () => {
    const rows = [row("i70cv50", 50, "2026-11-01T10:00:00.000Z", 70), row("i70cv90", 90, "2026-11-02T10:00:00.000Z", 70), row("unscored", 99, "2026-11-01T08:00:00.000Z", null), row("i90", 10, "2026-11-03T10:00:00.000Z", 90), row("unscored2", 99, "2026-11-01T07:00:00.000Z", null)];
    expect([...rows].sort(byInterviewScore).map((r) => r.id)).toEqual(["i90", "i70cv90", "i70cv50", "unscored2", "unscored"]);
  });
});

describe("which skills the CV score counts", () => {
  it("counts a skill named exactly like a must-have once, as the must-have", () => {
    const packet = { requirements: { mustHaves: [{ text: "Digital radiography" }, { text: "C#" }] }, competencies: [{ name: "digital  radiography." }, { name: "Digital radiography and intraoral scanning" }, { name: "C++" }, { name: "Patient care" }] };
    expect(skillsInScore(packet).map((c) => c.name)).toEqual(["Digital radiography and intraoral scanning", "C++", "Patient care"]);
    expect(repeatsMustHave({ name: "DIGITAL RADIOGRAPHY" }, packet.requirements.mustHaves)).toBe(true);
    expect(repeatsMustHave({ name: "" }, packet.requirements.mustHaves)).toBe(false);
  });

  it("reads the importance a person picked, or the one an older weight stands for", () => {
    expect(importanceOf({ importance: "helpful", weight: 5 })).toBe("helpful");
    expect([5, 4, 3, 2, 1].map((weight) => importanceOf({ weight }))).toEqual(["essential", "important", "important", "helpful", "helpful"]);
    expect(importanceOf({})).toBe("important");
  });
});
