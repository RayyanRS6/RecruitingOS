import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, ScreenAssessment } from "@ros/contracts";
// A complete, valid job (not exported by @ros/agents): read by path, as suites.ts reads core.
import { samplePacket } from "../../agents/src/fixtures/sample-packet";
import {
  CONSISTENCY_READS, SCORE_PACKET, biasPairDifferences, biasPairs, consistencyCases, consistencyDifferences, credentialCases, credentialFailures, fairnessRuleCases, formAnswersFor, scoreCaseFailures, scoreCases, scoreOf, scorecardDifferences,
  screenAssessCases, sentInterview, shownLicenceFailures, triageEdgeCases,
} from "./suites";

/**
 * The parts of the eval suites that call no model: the CV score's rules, the checks that compare readings by the score
 * the code works out from them, the licence check, the scorecard's checks, and the fairness rules in code. They run with
 * the unit tests; the suites that call a model run with `pnpm eval`.
 */
describe("score.rules", () => {
  for (const c of scoreCases) {
    it(c.id, () => {
      expect(scoreCaseFailures(c)).toEqual([]);
    });
  }

  it("names a score that broke a rule", () => {
    const [first] = scoreCases;
    expect(scoreCaseFailures({ ...first!, expect: { score: 90, band: "high", shown: 1, held: true, missing: ["perio"] } })).toEqual([
      "score 100, expected 90",
      "band very_high, expected high",
      "2 of 2 must-haves shown, expected 1 of 2",
      "the score was not held at 54",
      'missing must-haves "", expected "perio"',
    ]);
  });
});

/** One reading of the score's job: the licence as given, perio shown, and one of its three skills shown. */
const reading = (licence: "yes" | "partially" | "no" | "unknown", quoted = true): EvidenceAssessment => ({
  summary: "Experienced hygienist.",
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Chairside assisting" } }],
  requirementFindings: [{ requirementKey: "rdh_license", met: licence, ...(quoted ? { evidence: { source: "resume" as const, quote: "RDH license CA active" } } : {}) }, { requirementKey: "perio", met: "yes", evidence: { source: "resume", quote: "Periodontal charting" } }],
});

describe("triage.bias_pairs reads the CV score", () => {
  const pair = biasPairs[0]!;

  it("passes a pair that reads and scores the same", () => {
    expect(biasPairDifferences(pair, reading("yes"), reading("yes"), SCORE_PACKET)).toEqual([]);
  });

  it("names a pair whose score moved with the cue, as well as the finding behind it", () => {
    // both must-haves and the Essential skill shown: 11 of 14 points; the licence not held: 7 of 14
    expect(biasPairDifferences(pair, reading("yes"), reading("no"), SCORE_PACKET)).toEqual([
      "must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:no",
      "resume score differs: 79 vs 50",
      "band differs: high vs low",
      "must-haves shown differs: 2 of 2 vs 1 of 2",
      "missing must-haves differs: none vs rdh_license",
    ]);
    // partly shown counts half: the finding differs, and so does the score
    const partly = biasPairDifferences(pair, reading("yes"), reading("partially"), SCORE_PACKET);
    expect(partly).toContain("must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:partially");
    expect(partly).toContain("resume score differs: 79 vs 64");
  });

  it("names a reading whose own words name the cue", () => {
    const named = { ...reading("yes"), summary: "Emily Walsh is an experienced hygienist." };
    expect(biasPairDifferences(pair, named, reading("yes"), SCORE_PACKET)).toEqual(['the reading names "Emily Walsh"']);
  });

  it("still compares the readings alone when no job is given", () => {
    expect(biasPairDifferences(pair, reading("yes"), reading("partially"))).toEqual(["must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:partially"]);
  });
});

describe("triage.consistency compares repeated readings of one CV", () => {
  it("passes readings that agree every time", () => {
    expect(consistencyDifferences([reading("yes"), reading("yes"), reading("yes")], SCORE_PACKET)).toEqual([]);
    expect(CONSISTENCY_READS).toBeGreaterThanOrEqual(3);
    expect(consistencyCases.length).toBeGreaterThanOrEqual(3);
  });

  it("names a reading whose findings or score moved, against the first", () => {
    expect(consistencyDifferences([reading("yes"), reading("yes"), reading("no")], SCORE_PACKET)).toEqual([
      "reading 3: must-have findings perio:yes, rdh_license:no, reading 1: perio:yes, rdh_license:yes",
      "reading 3: resume score 50, reading 1: 79",
      "reading 3: band low, reading 1: high",
      "reading 3: must-haves shown 1 of 2, reading 1: 2 of 2",
      "reading 3: missing must-haves rdh_license, reading 1: none",
    ]);
    // a must-have partly shown moves the finding and the score: it counts half
    const partly = consistencyDifferences([reading("yes"), reading("partially")], SCORE_PACKET);
    expect(partly).toContain("reading 2: must-have findings perio:yes, rdh_license:partially, reading 1: perio:yes, rdh_license:yes");
    expect(partly).toContain("reading 2: resume score 64, reading 1: 79");
    expect(consistencyDifferences([], SCORE_PACKET)).toEqual(["no reading"]);
  });
});

describe("triage.edge_cases", () => {
  const gap = triageEdgeCases.find((c) => c.id === "employment_gap")!;

  it("passes a reading that holds nothing against the gap", () => {
    const fair = reading("yes");
    expect(gap.expect(fair, scoreOf(fair, SCORE_PACKET))).toEqual([]);
    // not shown is not "not met": nothing is held against them
    const unknown = reading("unknown", false);
    expect(gap.expect(unknown, scoreOf(unknown, SCORE_PACKET))).toEqual([]);
  });

  it("names a must-have read as not met, and a concern that names the gap", () => {
    const held = { ...reading("no"), concerns: [{ claim: "A gap in employment between 2017 and 2021", evidence: { source: "resume" as const } }] };
    expect(gap.expect(held, scoreOf(held, SCORE_PACKET))).toEqual(['an employment gap: the must-have "Active CA RDH license" was read as not met', "an employment gap is named as a concern: A gap in employment between 2017 and 2021"]);
  });

  it("has a case for each path that must never count on its own", () => {
    expect(triageEdgeCases.map((c) => c.id)).toEqual(["employment_gap", "career_changer", "skills_without_degree", "ai_generated_boilerplate"]);
  });
});

describe("triage.credentials", () => {
  it("names a licence read other than the licence rule says, and expects every kind of case", () => {
    const keys = new Set(["rdh_license"]);
    expect(credentialFailures(reading("unknown", false), keys, "unknown")).toEqual([]);
    expect(credentialFailures(reading("no"), keys, "unknown")).toEqual(['rdh_license: read "no", expected "unknown"']);
    expect(credentialFailures(reading("no"), new Set(), "no")).toEqual(["the job has no licence must-have to read"]);
    expect(new Set(credentialCases.map((c) => c.expect))).toEqual(new Set(["unknown", "no", "yes"]));
    expect(credentialCases.find((c) => c.id === "lapsed")?.resume).toContain("RDH license CA expired in 2021; renewal not started");
  });

  it("answers the job's own questions on the form as someone who meets them", () => {
    const role = { formQuestions: [{ kind: "yes_no", key: "lic", question: "Do you hold a CA RDH license?", required: true }, { kind: "choice", key: "shift", question: "Which shift do you prefer?", options: ["Mornings", "Evenings"], required: true }, { kind: "number", key: "years", question: "How many years?", required: false }] } as never;
    expect(formAnswersFor(role)).toEqual({ lic: "yes", shift: "Mornings", years: "5" });
    // someone whose CV says the licence is lapsed, pending or not held says so on the form too
    expect(formAnswersFor(role, { licenceHeld: false })).toEqual({ lic: "no", shift: "Mornings", years: "5" });
    expect(credentialCases.filter((c) => c.expect === "yes").map((c) => c.id)).toEqual(["active"]);
    expect(consistencyCases.map((c) => [c.id, c.licenceHeld])).toEqual([["experienced_hygienist", true], ["lapsed_license", false], ["assistant_not_yet_hygienist", false]]);
  });
});

describe("triage.fairness_rules, with no model", () => {
  for (const c of fairnessRuleCases) {
    it(c.id, () => {
      expect(c.failures()).toEqual([]);
    });
  }
});

describe("the scorecard's checks, with no model", () => {
  // the sample job's first must-have names a certificate, so the chat asks about it when the CV does not show it
  const packet = samplePacket();
  const interview = sentInterview(packet, { gaps: ["mh_xray"] });
  type QuestionFinding = ScreenAssessment["questionFindings"][number];
  const card = (meets: (key: string) => QuestionFinding["meetsModelAnswer"]): ScreenAssessment => ({
    summary: "s",
    strengths: [],
    concerns: [],
    unknowns: [],
    questionFindings: (interview.screen.progress.chat?.items ?? []).map((i) => ({ questionKey: i.key, answered: true, finding: "f", meetsModelAnswer: meets(i.key), evidence: { source: "screen" as const, quote: interview.screen.answers[i.key] ?? "" } })),
  });

  it("builds a sent interview as the chat does: the job's questions, then the must-haves the CV did not show", () => {
    expect(interview.screen.progress.chat?.items.map((i) => [i.key, i.kind])).toEqual([["recent", "question"], ["nervous", "question"], ["available", "question"], ["pay", "question"], ["mh_xray", "gap"]]);
    expect(Object.keys(interview.screen.answers)).toEqual(["recent", "nervous", "available", "pay", "mh_xray"]);
    expect(interview.screen.transcript.filter((t) => t.role === "candidate")).toHaveLength(5);
    // a skip leaves no answer, and the plan says so
    const skipped = sentInterview(packet, { reply: (q) => (q.key === "pay" ? null : undefined) });
    expect(skipped.screen.answers.pay).toBeUndefined();
    expect(skipped.screen.progress.declined).toEqual(["pay"]);
    expect(skipped.screen.transcript.some((t) => t.source === "skip" && t.questionKey === "pay")).toBe(true);
  });

  it("screen.consistency names a question read differently, and the interview score that moved with it", () => {
    expect(scorecardDifferences(card(() => "yes"), card(() => "yes"), interview)).toEqual([]);
    // five questions asked: all met is 100; one of them not met is 80
    expect(scorecardDifferences(card(() => "yes"), card((key) => (key === "pay" ? "no" : "yes")), interview)).toEqual([
      "read 2: question findings recent:yes, nervous:yes, available:yes, pay:no, mh_xray:yes, read 1: recent:yes, nervous:yes, available:yes, pay:yes, mh_xray:yes",
      "read 2: interview score 80, read 1: 100",
      "read 2: band high, read 1: very_high",
    ]);
  });

  it("screen.assess names the licence question's finding when it is not what the licence rule gives", () => {
    expect(shownLicenceFailures(card(() => "yes"), interview, "yes", { quoted: true })).toEqual([]);
    expect(shownLicenceFailures(card(() => "no"), interview, "unknown")).toEqual([expect.stringMatching(/^mh_xray: shown "no", expected "unknown" \(quote ".+"\)$/)]);
    expect(shownLicenceFailures({ ...card(() => "yes"), questionFindings: [] }, interview, "yes")).toEqual(["mh_xray: the scorecard has no finding for the question about it"]);
    const unquoted = card(() => "yes");
    expect(shownLicenceFailures({ ...unquoted, questionFindings: unquoted.questionFindings.map(({ evidence: _evidence, ...f }) => f) }, interview, "yes", { quoted: true })).toEqual(['mh_xray: shown "yes" with none of their words quoted']);
  });

  it("screen.assess has a case for the skip, a finding for every question, each licence answer and whose words are quoted", () => {
    expect(screenAssessCases.map((c) => c.id)).toEqual(["skipped_question_stays_unknown", "one_finding_for_every_question_asked", "licence_lapsed_in_the_chat", "licence_not_held_said_plainly", "licence_held_in_their_own_words", "recorded_answers_are_not_the_candidate"]);
    // the case with a question nobody answered: asked, no answer, no reply in the chat
    const unanswered = screenAssessCases.find((c) => c.id === "one_finding_for_every_question_asked")!.build(packet);
    const last = unanswered.screen.progress.chat?.items.at(-1)?.key ?? "";
    expect(last).toBe("mh_chairside");
    expect(unanswered.screen.answers[last]).toBeUndefined();
    expect(unanswered.screen.transcript.at(-1)).toMatchObject({ role: "assistant", questionKey: last });
  });
});
