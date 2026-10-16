import { describe, expect, it } from "vitest";
import { MATCH_SCORE_BANDS, MISSING_MUST_HAVE_CAP, importanceOf, matchBand, matchWeightOf, previewMatch, type EvidenceAssessment, type MatchCriterion, type MatchScore, type RolePacket } from "@ros/contracts";
import { coverageWords, matchScore, mustHaveSummary, readingPair, readingVersion, scoredSkill, type ScoredReading } from "./match-score";

/**
 * The match score (founder decision B2): worked out by code from the stored, quote-checked findings. Must-haves count
 * most, skills by their importance, the unknown is set aside, and a must-have shown not met (a verified quote only)
 * holds the score below the amber band.
 */
const packet = {
  requirements: {
    mustHaves: [
      { key: "rdh_license", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] },
      { key: "perio", text: "Perio charting experience", rationale: "the work", evidencedBy: ["resume"] },
    ],
  },
  competencies: [
    { key: "chairside", name: "Chairside skill", definition: "d", weight: 5, evaluatedIn: "both", indicators: ["x"] },
    { key: "patients", name: "Patient care", definition: "d", weight: 4, evaluatedIn: "both", indicators: ["x"] },
    { key: "software", name: "Dental software", definition: "d", weight: 2, evaluatedIn: "screen", indicators: ["x"] },
  ],
} as unknown as Pick<RolePacket, "requirements" | "competencies">;

type Req = EvidenceAssessment["requirementFindings"][number];
type Comp = EvidenceAssessment["competencyFindings"][number];
const q = (quote: string) => ({ source: "resume" as const, quote });
const must = (key: string, met: Req["met"], quote?: string): Req => ({ requirementKey: key, met, ...(quote ? { evidence: q(quote) } : {}) });
const skill = (key: string, finding: Comp["finding"], quote?: string): Comp => ({ competencyKey: key, finding, ...(quote ? { evidence: q(quote) } : {}) });
const reading = (kind: "triage" | "screen", requirementFindings: Req[], competencyFindings: Comp[] = [], over: Partial<ScoredReading> = {}): ScoredReading => ({ kind, confidence: "medium", packetVersion: 1, createdAt: "2026-10-01T10:00:00Z", result: { requirementFindings, competencyFindings, confidence: "medium" }, ...over });
const pair = (resume: ScoredReading | null, screen: ScoredReading | null = null) => ({ resume, screen });

/** A small fixed-seed generator, so every run checks the same cases. */
function seeded(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("matchScore", () => {
  it("gives 100 when every requirement is met, based on all of them, and names the band in the badge's words", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet)!;
    expect(s).toMatchObject({ score: 100, band: "very_high", bandLabel: "Very high", capped: false, missingMustHave: [], unknown: [], fullMarks: 5, basedOn: "resume", packetVersion: 1, confidence: "medium" });
    expect(s.coverage).toEqual({ known: 5, total: 5, words: "Based on all 5 requirements" });
  });

  it("weighs must-haves most and skills by importance, and lists the costliest first with the points each lost", () => {
    // must-haves 4 each, chairside (5 = Essential) 3, patients (4 = Important) 2, software (2 = Helpful) 1: 14 in all
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "contradicted", "I avoid patients"), skill("software", "contradicted", "never used dental software")])), packet)!;
    // the rest (met or not met) is at 4/10 = 40%, under half: perio counts half
    // lost: chairside 3/14 = 21.43, perio 4/14*50 = 14.29, patients 2/14 = 14.29, software 1/14 = 7.14 → 100 - 57.14 = 43
    expect(s.score).toBe(43);
    expect(s.band).toBe("low");
    expect(s.breakdown.map((c) => [c.key, c.weightPct, c.pctMet, c.pointsLost])).toEqual([["chairside", 21, 0, 21], ["perio", 29, 50, 14], ["patients", 14, 0, 14], ["software", 7, 0, 7], ["rdh_license", 29, 100, 0]]);
    expect(s.breakdown[1]).toMatchObject({ label: "Perio charting experience", mustHave: true, importance: null, finding: "Partly shown", quote: "some perio", source: "resume" });
    expect(s.breakdown[1]).not.toHaveProperty("countedPct");
    expect(s.breakdown.find((c) => c.key === "software")).toMatchObject({ finding: "Goes against it", importance: "helpful" });
    expect(s.fullMarks).toBe(1);
  });

  it("counts a partly shown requirement at the rest's level when that is above half, so it never pulls the score down (Wave S7)", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "partially_evidenced", "assisted"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet)!;
    // the rest: rdh 4 met, patients 2 met, software 1 not met = 6/7 = 85.7%; perio and chairside count at 85.7% too
    expect(s.score).toBe(86);
    expect(s.score).toBe(matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet)!.score);
    expect(s.breakdown.map((c) => [c.key, c.weightPct, c.pctMet, c.pointsLost])).toEqual([["software", 7, 0, 7], ["perio", 29, 50, 4], ["chairside", 21, 50, 3], ["rdh_license", 29, 100, 0], ["patients", 14, 100, 0]]);
    // still "Partly shown" at 50%, with the share the score counted
    expect(s.breakdown.find((c) => c.key === "perio")).toMatchObject({ finding: "Partly shown", pctMet: 50, countedPct: 86 });
    expect(s.coverage.known).toBe(5);
  });

  /**
   * The fairness run of 15 Oct 2026 (triage.bias_pairs zip_code and earlier_rejection): twin résumés whose readings
   * differed only in one skill, "not evidenced" in one and "partially evidenced" in the other from the same quote,
   * scored 94 and 83. The twin with some evidence must never score below the twin with none.
   */
  it("never scores a twin with some evidence below the twin with none (fairness run, 15 Oct 2026)", () => {
    const musts = [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Periodontal charting, scaling and root planing")];
    const others = [skill("patients", "evidenced", "Patient education"), skill("software", "contradicted", "I have never used dental software")];
    const none = matchScore(pair(reading("triage", musts, [skill("chairside", "not_evidenced"), ...others])), packet)!;
    const some = matchScore(pair(reading("triage", musts, [skill("chairside", "partially_evidenced", "Periodontal charting, scaling and root planing"), ...others])), packet)!;
    // the rest: 10 of 11 = 90.9%; before Wave S7 the partly shown skill counted half and took the twin to 82
    expect(none.score).toBe(91);
    expect(some.score).toBe(91);
    expect(some.band).toBe(none.band);
  });

  it("is monotonic: moving any one requirement up (not met, not known, partly, met) never lowers the score", () => {
    const rand = seeded(20261015);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    type Level = "no" | "unknown" | "partly" | "yes" | "yes_unquoted";
    const ORDER: Level[] = ["no", "unknown", "partly", "yes"];
    const MUST: Record<Level, (k: string) => Req> = { no: (k) => must(k, "no", `I have never done ${k}`), unknown: (k) => must(k, "unknown"), partly: (k) => must(k, "partially", `some ${k} work`), yes: (k) => must(k, "yes", `${k} every day`), yes_unquoted: (k) => must(k, "yes") };
    const SKILL: Record<Level, (k: string) => Comp> = { no: (k) => skill(k, "contradicted", `I avoid ${k}`), unknown: (k) => skill(k, "not_evidenced"), partly: (k) => skill(k, "partially_evidenced", `some ${k}`), yes: (k) => skill(k, "evidenced", `${k} daily`), yes_unquoted: (k) => skill(k, "evidenced") };
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const mustKeys = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => `m${i}`);
      const skillKeys = Array.from({ length: Math.floor(rand() * 5) }, (_, i) => `s${i}`);
      const role = {
        requirements: { mustHaves: mustKeys.map((key) => ({ key, text: `Must ${key}`, rationale: "r", evidencedBy: ["resume"] })) },
        competencies: skillKeys.map((key) => ({ key, name: `Skill ${key}`, definition: "d", weight: 1 + Math.floor(rand() * 5), evaluatedIn: "both", indicators: ["x"] })),
      } as unknown as Pick<RolePacket, "requirements" | "competencies">;
      const levels = new Map<string, Level>([...mustKeys, ...skillKeys].map((k) => [k, pick<Level>(["no", "unknown", "partly", "yes", "yes_unquoted"])]));
      const scoreOf = (ls: Map<string, Level>) => matchScore(pair(reading("triage", mustKeys.map((k) => MUST[ls.get(k)!](k)), skillKeys.map((k) => SKILL[ls.get(k)!](k)))), role)!.score;
      const before = scoreOf(levels);
      for (const key of levels.keys()) {
        const at = levels.get(key)!;
        const from = at === "yes_unquoted" ? ORDER.indexOf("partly") : ORDER.indexOf(at);
        for (const up of ORDER.slice(from + 1)) {
          const after = scoreOf(new Map(levels).set(key, up));
          if (before !== null && after !== null) {
            expect(after, `${JSON.stringify([...levels])}: ${key} ${at} → ${up}`).toBeGreaterThanOrEqual(before);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("sets missing information aside: unknown requirements and not-evidenced skills are left out and shown as coverage", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm")])), packet)!;
    expect(s.score).toBe(100);
    expect(s.coverage).toEqual({ known: 2, total: 5, words: "Based on 2 of 5 requirements" });
    expect(s.unknown.map((u) => [u.key, u.mustHave])).toEqual([["perio", true], ["chairside", false], ["software", false]]);
  });

  it("counts a must-have as missing only on a verified quote, and then holds the score at 54 and names it", () => {
    const unverified = matchScore(pair(reading("triage", [must("rdh_license", "no"), must("perio", "yes", "perio")])), packet)!;
    expect(unverified.missingMustHave).toEqual([]);
    // left out, but marked so the board asks a person to look (plan F6)
    expect(unverified.unknown.find((u) => u.key === "rdh_license")).toEqual({ key: "rdh_license", label: "Active CA RDH license", mustHave: true, importance: null, unquotedNo: true });
    expect(matchScore(pair(reading("triage", [must("rdh_license", "unknown")])), packet)!.unknown.find((u) => u.key === "rdh_license")).not.toHaveProperty("unquotedNo");
    const flagged = matchScore(pair(reading("triage", [{ requirementKey: "rdh_license", met: "no", evidence: { source: "resume", unquoted: true } }, must("perio", "yes", "perio")])), packet)!;
    expect(flagged.missingMustHave).toEqual([]);
    const proven = matchScore(pair(reading("triage", [must("rdh_license", "no", "My RDH license lapsed in 2021"), must("perio", "yes", "perio")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet)!;
    expect(proven.missingMustHave).toEqual([{ key: "rdh_license", label: "Active CA RDH license", quote: "My RDH license lapsed in 2021" }]);
    expect(proven.score).toBe(MISSING_MUST_HAVE_CAP);
    expect(proven).toMatchObject({ capped: true, band: "low" });
    expect(proven.breakdown[0]).toMatchObject({ key: "rdh_license", finding: "Not met", pctMet: 0 });
  });

  it("does not raise a score already below the cap", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "no", "No license"), must("perio", "no", "Never charted perio")])), packet)!;
    expect(s).toMatchObject({ score: 0, capped: false, band: "low" });
    expect(s.missingMustHave.map((m) => m.key)).toEqual(["rdh_license", "perio"]);
  });

  it("has no score when nothing can be judged, and no result at all without a reading", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "unknown")])), packet)!;
    expect(s).toMatchObject({ score: null, band: null, bandLabel: null, breakdown: [], fullMarks: 0 });
    expect(s.coverage.words).toBe(coverageWords(0, 5));
    expect(matchScore(pair(null), packet)).toBeNull();
  });

  it("takes the screening conversation's finding where it has one, and the résumé's where it is silent", () => {
    const resume = reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "partially_evidenced", "assisted")], { createdAt: "2026-10-01T10:00:00Z", confidence: "low" });
    const screen = reading("screen", [must("perio", "yes", "I chart perio every day")], [skill("chairside", "evidenced", "I anticipate the next instrument")], { createdAt: "2026-10-02T10:00:00Z", confidence: "high" });
    const s = matchScore(pair(resume, screen), packet)!;
    expect(s.breakdown.find((c) => c.key === "perio")).toMatchObject({ source: "screen", quote: "I chart perio every day", pctMet: 100 });
    expect(s.breakdown.find((c) => c.key === "rdh_license")).toMatchObject({ source: "resume" });
    expect(s.breakdown.find((c) => c.key === "chairside")).toMatchObject({ source: "screen", pctMet: 100 });
    expect(s).toMatchObject({ basedOn: "resume_and_screen", confidence: "high", score: 100 });
  });

  it("ranks findings by evidence first: a scorecard 'yes' that lost its quote never replaces the résumé's checked one", () => {
    const one = { ...packet, requirements: { ...packet.requirements, mustHaves: [packet.requirements.mustHaves[0]!] }, competencies: [] };
    const resume = reading("triage", [must("rdh_license", "yes", "RDH license CA active")]);
    // the evidence rules marked the screen's bare "Yes" as no quote
    const bare = reading("screen", [{ requirementKey: "rdh_license", met: "yes", evidence: { source: "screen", unquoted: true } }]);
    const s = matchScore(pair(resume, bare), one)!;
    expect(s.score).toBe(100);
    expect(s.breakdown[0]).toMatchObject({ source: "resume", quote: "RDH license CA active", pctMet: 100 });
    expect(mustHaveSummary(pair(resume, bare), one)!.words).toBe("Must-haves: 1 of 1 shown");
    // a "Yes" read with the question it answers keeps its quote, and so counts in full from the screen
    const answered = reading("screen", [{ requirementKey: "rdh_license", met: "yes", evidence: { source: "screen", quote: "Yes" } }]);
    expect(matchScore(pair(resume, answered), one)!.breakdown[0]).toMatchObject({ source: "screen", pctMet: 100 });
    // with no checked finding anywhere, the unquoted screen finding still counts (partly)
    expect(matchScore(pair(reading("triage", [must("rdh_license", "unknown")]), bare), one)!.breakdown[0]).toMatchObject({ source: "screen", pctMet: 50, unquoted: true });
  });

  it("counts a 'yes' with nothing quoted as partly met, never above the checked evidence, and says 'no quote' (known bug 32)", () => {
    const all = [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")];
    const quoted = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")], all)), packet)!;
    expect(quoted.score).toBe(100);
    const bare = matchScore(pair(reading("triage", [must("rdh_license", "yes"), { requirementKey: "perio", met: "yes", evidence: { source: "resume", unquoted: true } }], [skill("chairside", "evidenced"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet)!;
    expect(bare.breakdown.find((c) => c.key === "rdh_license")).toMatchObject({ pctMet: 50, finding: "Partly shown", unquoted: true, quote: null });
    expect(bare.breakdown.find((c) => c.key === "chairside")).toMatchObject({ pctMet: 50, unquoted: true });
    expect(bare.fullMarks).toBe(2);
    // the unquoted claims score as if nothing were said: the score is what the checked evidence shows, no more
    const silent = matchScore(pair(reading("triage", [must("rdh_license", "unknown"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet)!;
    expect(bare.score).toBe(silent.score);
    // with weaker checked evidence an unquoted claim counts half, and still below the same claim quoted
    const against = [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "contradicted", "I avoid patients"), skill("software", "contradicted", "never used dental software")];
    const scoreWith = (rdh: Req) => matchScore(pair(reading("triage", [rdh, must("perio", "yes", "Perio charting daily")], against)), packet)!.score!;
    expect([scoreWith(must("rdh_license", "unknown")), scoreWith(must("rdh_license", "yes")), scoreWith(must("rdh_license", "yes", "RDH license CA active"))]).toEqual([40, 43, 57]);
    // nothing checked at all: unquoted claims alone are half
    expect(matchScore(pair(reading("triage", [must("rdh_license", "yes"), must("perio", "yes")])), packet)!.score).toBe(50);
    expect(mustHaveSummary(pair(reading("triage", [must("rdh_license", "yes"), must("perio", "yes", "Perio charting daily")])), packet)!.words).toBe("Must-haves: 1 of 2 shown, 1 partly");
  });

  it("leaves out a skill the role checks in the interviews only (known bug 18)", () => {
    const interview = { ...packet, competencies: packet.competencies.map((c) => (c.key === "software" ? { ...c, evaluatedIn: "interview" as const } : c)) };
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "contradicted", "never used dental software")])), interview)!;
    expect(s.score).toBe(100);
    expect(s.coverage.total).toBe(4);
    expect([...s.breakdown.map((b) => b.key), ...s.unknown.map((u) => u.key)]).not.toContain("software");
    expect(scoredSkill({ evaluatedIn: "interview" })).toBe(false);
    expect(scoredSkill({ evaluatedIn: "both" })).toBe(true);
  });

  it("is deterministic whatever the order of the findings", () => {
    const a = reading("triage", [must("rdh_license", "partially", "a"), must("perio", "yes", "b")], [skill("software", "partially_evidenced", "c"), skill("chairside", "evidenced", "d"), skill("patients", "partially_evidenced", "e")]);
    const b = reading("triage", [must("perio", "yes", "b"), must("rdh_license", "partially", "a")], [skill("patients", "partially_evidenced", "e"), skill("chairside", "evidenced", "d"), skill("software", "partially_evidenced", "c")]);
    expect(matchScore(pair(a), packet)).toEqual(matchScore(pair(b), packet));
  });
});

describe("the bands and importance", () => {
  it("uses the badge's cut-offs and words (packages/ui SCORE_BANDS), never the AI reading's", () => {
    expect(MATCH_SCORE_BANDS.map((b) => [b.band, b.min, b.label])).toEqual([["very_high", 85, "Very high"], ["high", 70, "High"], ["medium", 55, "Medium"], ["low", 0, "Low"]]);
    expect([85, 84, 70, 69, 55, 54, 0].map((n) => matchBand(n)?.band)).toEqual(["very_high", "high", "high", "medium", "medium", "low", "low"]);
    expect(matchBand(null)).toBeNull();
    for (const b of MATCH_SCORE_BANDS) expect(b.label).not.toMatch(/match|strong|potential|weak|evidence|fit/i);
  });

  it("reads Essential, Important and Helpful from the 1-5 weight unless a person picked one", () => {
    expect([5, 4, 3, 2, 1].map((weight) => importanceOf({ weight }))).toEqual(["essential", "important", "important", "helpful", "helpful"]);
    expect(importanceOf({ weight: 5, importance: "helpful" })).toBe("helpful");
    const picked = { ...packet, competencies: packet.competencies.map((c) => (c.key === "software" ? { ...c, importance: "essential" as const } : c)) };
    const s = matchScore(pair(reading("triage", [], [skill("software", "evidenced", "z"), skill("patients", "contradicted", "I avoid nervous patients")])), picked)!;
    // software now Essential (3) against patients Important (2): 3/5 met
    expect(s.score).toBe(60);
  });
});

describe("mustHaveSummary and the version label", () => {
  it("counts the must-haves shown, partly shown, not met (a verified quote) and not yet known", () => {
    const s = mustHaveSummary(pair(reading("triage", [must("rdh_license", "no", "License expired"), must("perio", "unknown")])), packet)!;
    expect(s).toEqual({ total: 2, shown: 0, partly: 0, notShown: 1, unknown: 1, gaps: [{ key: "rdh_license", text: "Active CA RDH license", quote: "License expired" }], words: "Must-haves: 0 of 2 shown, 1 not met, 1 not yet known" });
    expect(mustHaveSummary(pair(reading("triage", [must("rdh_license", "yes", "a"), must("perio", "partially", "b")])), packet)!.words).toBe("Must-haves: 1 of 2 shown, 1 partly");
    expect(mustHaveSummary(pair(null), packet)).toBeNull();
  });

  it("labels a reading made against an earlier version of the role", () => {
    expect(readingVersion(2, 3)).toEqual({ readAgainst: 2, current: 3, label: "Read against version 2 of the role; the role is now on version 3." });
    expect(readingVersion(3, 3)).toBeNull();
    expect(readingVersion(null, 3)).toBeNull();
    // with both versions it says whether the must-haves changed in between (added, removed or reworded)
    const v1 = { requirements: { mustHaves: [packet.requirements.mustHaves[0]] } } as Pick<RolePacket, "requirements">;
    expect(readingVersion(1, 2, { was: v1, now: packet })).toEqual({ readAgainst: 1, current: 2, label: "Read against version 1 of the role; the role is now on version 2. Its must-haves have changed since.", mustHavesChanged: true });
    expect(readingVersion(1, 2, { was: packet, now: packet })).toMatchObject({ mustHavesChanged: false, label: "Read against version 1 of the role; the role is now on version 2." });
  });

  it("picks the newest résumé reading and the newest scorecard", () => {
    const old = reading("triage", [], [], { createdAt: "2026-10-01T00:00:00Z" });
    const fresh = reading("triage", [], [], { createdAt: "2026-10-03T00:00:00Z" });
    const card = reading("screen", [], [], { createdAt: "2026-10-02T00:00:00Z" });
    expect(readingPair([old, card, fresh])).toEqual({ resume: fresh, screen: card });
    expect(readingPair([old])).toEqual({ resume: old, screen: null });
  });
});

/**
 * "Try different weights" (founder decision L-07 A, preview only): the job page works a person's score out again in
 * the browser, from the breakdown their stored score already carries, with the same sums (packages/contracts
 * weighRequirements). With the job's own weights it must give the real score back, to the point.
 */
describe("a preview with other weights (L-07 A)", () => {
  const same = (m: MatchScore) => {
    const p = previewMatch(m, matchWeightOf);
    return { score: p.score, capped: p.capped, band: p.band };
  };
  const real = (m: MatchScore) => ({ score: m.score, capped: m.capped, band: m.band });
  const one = { ...packet, requirements: { ...packet.requirements, mustHaves: [packet.requirements.mustHaves[0]!] }, competencies: [] };
  const interview = { ...packet, competencies: packet.competencies.map((c) => (c.key === "software" ? { ...c, evaluatedIn: "interview" as const } : c)) };
  const picked = { ...packet, competencies: packet.competencies.map((c) => (c.key === "software" ? { ...c, importance: "essential" as const } : c)) };
  const all = [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")];
  const against = [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "contradicted", "I avoid patients"), skill("software", "contradicted", "never used dental software")];
  // the worked case above (43): the licence met, perio partly shown, every skill going against the candidate
  const worked = () => matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], against)), packet)!;
  // the held case above (54): the licence shown not met in their own words, everything else met
  const held = () => matchScore(pair(reading("triage", [must("rdh_license", "no", "My RDH license lapsed in 2021"), must("perio", "yes", "perio")], all)), packet)!;
  const weighted = (key: string, mustHave: boolean, weight: number) => (c: MatchCriterion) => (c.key === key && c.mustHave === mustHave ? weight : matchWeightOf(c));

  it("gives back the real score, its band and the hold for every case in this file", () => {
    const cases: Array<[ReturnType<typeof pair>, Pick<RolePacket, "requirements" | "competencies">]> = [
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")], all)), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], against)), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "partially_evidenced", "assisted"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Periodontal charting, scaling and root planing")], [skill("chairside", "partially_evidenced", "Periodontal charting, scaling and root planing"), skill("patients", "evidenced", "Patient education"), skill("software", "contradicted", "I have never used dental software")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm")])), packet],
      [pair(reading("triage", [must("rdh_license", "no"), must("perio", "yes", "perio")])), packet],
      [pair(reading("triage", [must("rdh_license", "no", "My RDH license lapsed in 2021"), must("perio", "yes", "perio")], all)), packet],
      [pair(reading("triage", [must("rdh_license", "no", "No license"), must("perio", "no", "Never charted perio")])), packet],
      [pair(reading("triage", [must("rdh_license", "unknown")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "partially_evidenced", "assisted")], { confidence: "low" }), reading("screen", [must("perio", "yes", "I chart perio every day")], [skill("chairside", "evidenced", "I anticipate the next instrument")], { createdAt: "2026-10-02T10:00:00Z" })), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active")]), reading("screen", [{ requirementKey: "rdh_license", met: "yes", evidence: { source: "screen", unquoted: true } }])), one],
      [pair(reading("triage", [must("rdh_license", "unknown")]), reading("screen", [{ requirementKey: "rdh_license", met: "yes", evidence: { source: "screen", unquoted: true } }])), one],
      [pair(reading("triage", [must("rdh_license", "yes"), { requirementKey: "perio", met: "yes", evidence: { source: "resume", unquoted: true } }], [skill("chairside", "evidenced"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes"), must("perio", "yes", "Perio charting daily")], against)), packet],
      [pair(reading("triage", [must("rdh_license", "yes"), must("perio", "yes")])), packet],
      [pair(reading("triage", [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")], [...all.slice(0, 2), skill("software", "contradicted", "never used dental software")])), interview],
      [pair(reading("triage", [must("rdh_license", "partially", "a"), must("perio", "yes", "b")], [skill("software", "partially_evidenced", "c"), skill("chairside", "evidenced", "d"), skill("patients", "partially_evidenced", "e")])), packet],
      [pair(reading("triage", [], [skill("software", "evidenced", "z"), skill("patients", "contradicted", "I avoid nervous patients")])), picked],
    ];
    for (const [p, role] of cases) {
      const m = matchScore(p, role)!;
      expect(same(m), JSON.stringify(m.breakdown.map((c) => [c.key, c.pctMet]))).toEqual(real(m));
    }
    expect(cases.map(([p, role]) => matchScore(p, role)!.score)).toEqual([100, 43, 86, 86, 91, 100, 100, MISSING_MUST_HAVE_CAP, 0, null, 100, 100, 50, 100, 43, 50, 100, 100, 60]);
  });

  it("gives back the real score over 400 random cases, with screening chats, picked importances and interview-only skills", () => {
    const rand = seeded(20261016);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const MUST: Array<(k: string) => Req> = [(k) => must(k, "no", `I have never done ${k}`), (k) => must(k, "no"), (k) => must(k, "unknown"), (k) => must(k, "partially", `some ${k} work`), (k) => must(k, "yes", `${k} every day`), (k) => must(k, "yes")];
    const SKILL: Array<(k: string) => Comp> = [(k) => skill(k, "contradicted", `I avoid ${k}`), (k) => skill(k, "not_evidenced"), (k) => skill(k, "partially_evidenced", `some ${k}`), (k) => skill(k, "evidenced", `${k} daily`), (k) => skill(k, "evidenced")];
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const mustKeys = Array.from({ length: Math.floor(rand() * 5) }, (_, i) => `m${i}`);
      const skillKeys = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => `s${i}`);
      const role = {
        requirements: { mustHaves: mustKeys.map((key) => ({ key, text: `Must ${key}`, rationale: "r", evidencedBy: ["resume"] })) },
        competencies: skillKeys.map((key) => ({ key, name: `Skill ${key}`, definition: "d", weight: 1 + Math.floor(rand() * 5), evaluatedIn: pick(["both", "screen", "both", "interview"]), indicators: ["x"], ...(rand() < 0.3 ? { importance: pick(["essential", "important", "helpful"]) } : {}) })),
      } as unknown as Pick<RolePacket, "requirements" | "competencies">;
      const resume = reading("triage", mustKeys.map((k) => pick(MUST)(k)), skillKeys.map((k) => pick(SKILL)(k)));
      const screen = rand() < 0.4 ? reading("screen", mustKeys.filter(() => rand() < 0.5).map((k) => pick(MUST)(k)), skillKeys.filter(() => rand() < 0.5).map((k) => pick(SKILL)(k)), { createdAt: "2026-10-02T10:00:00Z" }) : null;
      const m = matchScore(pair(resume, screen), role)!;
      expect(same(m), JSON.stringify(m.breakdown.map((c) => [c.key, c.mustHave, c.importance, c.pctMet]))).toEqual(real(m));
      if (m.score !== null) checked += 1;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("works the case above out again with chairside counted Helpful instead of Essential: 50 instead of 43", () => {
    const m = worked();
    expect(m.score).toBe(43);
    // must-haves 4 + 4, chairside now 1, patients 2, software 1: 12 in all. The rest (met or not met) is at 4/8 = 50%,
    // so perio counts half. Lost: chairside 1/12 = 8.33, perio 4/12 × 50 = 16.67, patients 2/12 = 16.67,
    // software 1/12 = 8.33, 50 in all.
    expect(previewMatch(m, weighted("chairside", false, 1))).toEqual({ score: 50, band: "low", capped: false });
    // the real score is not touched
    expect(m.score).toBe(43);
  });

  it("lifts the hold when a must-have shown not met is left out of the score", () => {
    const m = held();
    expect(m).toMatchObject({ score: 54, capped: true });
    expect(previewMatch(m, weighted("rdh_license", true, 0))).toEqual({ score: 100, band: "very_high", capped: false });
    // left out as a skill key it is not: the must-have still holds the score
    expect(previewMatch(m, weighted("rdh_license", false, 0))).toEqual({ score: 54, band: "low", capped: true });
  });

  it("has no score when every judged requirement is left out, and ignores weights that are not numbers", () => {
    expect(previewMatch(worked(), () => 0)).toEqual({ score: null, band: null, capped: false });
    expect(previewMatch(worked(), () => Number.NaN)).toEqual({ score: null, band: null, capped: false });
    expect(previewMatch(worked(), () => -3)).toEqual({ score: null, band: null, capped: false });
    expect(previewMatch({ breakdown: [] }, matchWeightOf)).toEqual({ score: null, band: null, capped: false });
  });

  it("gives the same score whatever the order of the breakdown", () => {
    const m = matchScore(pair(reading("triage", [must("rdh_license", "partially", "a"), must("perio", "yes", "b")], [skill("software", "partially_evidenced", "c"), skill("chairside", "contradicted", "d"), skill("patients", "partially_evidenced", "e")])), packet)!;
    const weightOf = weighted("patients", false, 3);
    const want = previewMatch(m, weightOf);
    const b = m.breakdown;
    for (const order of [[...b].reverse(), [...b.slice(2), ...b.slice(0, 2)], [b[1], b[3], b[0], b[4], b[2]]]) {
      expect(previewMatch({ breakdown: order as MatchCriterion[] }, weightOf)).toEqual(want);
      expect(previewMatch({ breakdown: order as MatchCriterion[] }, matchWeightOf).score).toBe(m.score);
    }
  });
});
