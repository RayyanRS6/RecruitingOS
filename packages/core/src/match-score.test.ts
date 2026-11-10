import { describe, expect, it } from "vitest";
import { MATCH_FIT_LABEL, MATCH_SCORE_BANDS, MISSING_MUST_HAVE_CAP, importanceOf, matchBand, matchWeightOf, previewMatch, scoreRank, type EvidenceAssessment, type MatchCriterion, type MatchFit, type MatchScore, type RolePacket, type WeighableRequirement } from "@ros/contracts";
import { interviewInScore } from "./ai-interview";
import { coverageWords, matchScore, mustHaveSummary, readingPair, readingVersion, scoredSkill, type ScoredReading } from "./match-score";

/**
 * The match score (founder decision B2; the owner, 6 November 2026): worked out by code from the stored, quote-checked
 * findings, as the points earned over the points of every requirement. Must-haves count most, skills by their importance,
 * what nothing was said about earns nothing and is never read as a no, and a must-have shown not met (a verified quote
 * only) holds the score below the amber band.
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
    // lost: chairside 3/14 = 21.43, perio 4/14*50 = 14.29, patients 2/14 = 14.29, software 1/14 = 7.14 → 100 - 57.14 = 43
    expect(s.score).toBe(43);
    expect(s.band).toBe("low");
    expect(s.breakdown.map((c) => [c.key, c.weightPct, c.pctMet, c.pointsLost])).toEqual([["chairside", 21, 0, 21], ["perio", 29, 50, 14], ["patients", 14, 0, 14], ["software", 7, 0, 7], ["rdh_license", 29, 100, 0]]);
    expect(s.breakdown[1]).toMatchObject({ label: "Perio charting experience", mustHave: true, importance: null, finding: "Partly shown", quote: "some perio", source: "resume" });
    expect(s.breakdown[1]).not.toHaveProperty("countedPct");
    expect(s.breakdown.find((c) => c.key === "software")).toMatchObject({ finding: "Goes against it", importance: "helpful" });
    expect(s.fullMarks).toBe(1);
  });

  it("counts a partly shown requirement at half, however strong the rest, and above saying nothing about it (6 November 2026)", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "partially_evidenced", "assisted"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet)!;
    // rdh 4, perio 2 of 4, chairside 1.5 of 3, patients 2, software 0: 9.5 of 14
    expect(s.score).toBe(68);
    // the same two requirements with nothing said about them: 6 of 14
    expect(matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")])), packet)!.score).toBe(43);
    expect(s.breakdown.map((c) => [c.key, c.weightPct, c.pctMet, c.pointsLost])).toEqual([["perio", 29, 50, 14], ["chairside", 21, 50, 11], ["software", 7, 0, 7], ["rdh_license", 29, 100, 0], ["patients", 14, 100, 0]]);
    expect(s.breakdown.find((c) => c.key === "perio")).toMatchObject({ finding: "Partly shown", pctMet: 50 });
    expect(s.breakdown[0]).not.toHaveProperty("countedPct");
    expect(s.coverage.known).toBe(5);
  });

  /**
   * The fairness run of 15 Oct 2026 (triage.bias_pairs zip_code and earlier_rejection): twin résumés whose readings
   * differed only in one skill, "not evidenced" in one and "partially evidenced" in the other from the same quote,
   * scored 94 and 83. The twin with some evidence must never score below the twin with none. They no longer score the same
   * (6 November 2026): partly is half, so that twin is ahead by half the skill's share. The real-model run measures the flips.
   */
  it("never scores a twin with some evidence below the twin with none (fairness run, 15 Oct 2026)", () => {
    const musts = [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Periodontal charting, scaling and root planing")];
    const others = [skill("patients", "evidenced", "Patient education"), skill("software", "contradicted", "I have never used dental software")];
    const none = matchScore(pair(reading("triage", musts, [skill("chairside", "not_evidenced"), ...others])), packet)!;
    const some = matchScore(pair(reading("triage", musts, [skill("chairside", "partially_evidenced", "Periodontal charting, scaling and root planing"), ...others])), packet)!;
    // 10 of 14, and 11.5 of 14
    expect(none.score).toBe(71);
    expect(some.score).toBe(82);
    expect(some.score!).toBeGreaterThanOrEqual(none.score!);
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

  /**
   * The release review (11 November 2026): the property above read one résumé against must-haves the résumé can speak to,
   * so it could not see a must-have checked only in the team's own interviews, nor an AI interview's scorecard beside the
   * résumé. Partly showing such a must-have scored a cook 85 against 100 for saying nothing about it.
   */
  it("stays monotonic with must-haves checked only in the team's own interviews, and with a scorecard beside the résumé", () => {
    const rand = seeded(20261111);
    type Level = "no" | "unknown" | "partly" | "yes";
    const ORDER: Level[] = ["no", "unknown", "partly", "yes"];
    const pickLevel = (): Level => ORDER[Math.floor(rand() * ORDER.length)]!;
    const MUST: Record<Level, (k: string) => Req> = { no: (k) => must(k, "no", `I have never done ${k}`), unknown: (k) => must(k, "unknown"), partly: (k) => must(k, "partially", `some ${k} work`), yes: (k) => must(k, "yes", `${k} every day`) };
    const SKILL: Record<Level, (k: string) => Comp> = { no: (k) => skill(k, "contradicted", `I avoid ${k}`), unknown: (k) => skill(k, "not_evidenced"), partly: (k) => skill(k, "partially_evidenced", `some ${k}`), yes: (k) => skill(k, "evidenced", `${k} daily`) };
    let checked = 0;
    let ownOnlyMoves = 0;
    for (let n = 0; n < 300; n++) {
      const mustKeys = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `m${i}`);
      const skillKeys = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => `s${i}`);
      // the first must-have, and now and then another, is checked only in the team's own interviews
      const ownOnly = new Set(mustKeys.filter((_, i) => i === 0 || rand() < 0.3));
      const role = {
        requirements: { mustHaves: mustKeys.map((key) => ({ key, text: `Must ${key}`, rationale: "r", evidencedBy: ownOnly.has(key) ? ["interview"] : ["resume", "screen"] })) },
        competencies: skillKeys.map((key) => ({ key, name: `Skill ${key}`, definition: "d", weight: 1 + Math.floor(rand() * 5), evaluatedIn: "both", indicators: ["x"] })),
      } as unknown as Pick<RolePacket, "requirements" | "competencies">;
      const keys = [...mustKeys, ...skillKeys];
      const resume = new Map<string, Level>(keys.map((k) => [k, pickLevel()]));
      const card = rand() < 0.6 ? new Map<string, Level>(keys.map((k) => [k, pickLevel()])) : null;
      const readingOf = (kind: "triage" | "screen", ls: Map<string, Level>) => reading(kind, mustKeys.map((k) => MUST[ls.get(k)!](k)), skillKeys.map((k) => SKILL[ls.get(k)!](k)), kind === "screen" ? { createdAt: "2026-10-02T10:00:00Z" } : {});
      const scoreOf = (r: Map<string, Level>, s: Map<string, Level> | null) => matchScore(pair(readingOf("triage", r), s ? readingOf("screen", s) : null), role)!.score;
      const before = scoreOf(resume, card);
      for (const which of ["resume", "screen"] as const) {
        const ls = which === "resume" ? resume : card;
        if (!ls) continue;
        for (const key of keys) {
          for (const up of ORDER.slice(ORDER.indexOf(ls.get(key)!) + 1)) {
            const moved = new Map(ls).set(key, up);
            const after = which === "resume" ? scoreOf(moved, card) : scoreOf(resume, moved);
            if (before === null || after === null) continue;
            expect(after, `${which} ${JSON.stringify([...ls])}${which === "resume" && card ? ` with the scorecard ${JSON.stringify([...card])}` : ""}: ${key}${ownOnly.has(key) ? " (only in their own interviews)" : ""} ${ls.get(key)} → ${up}`).toBeGreaterThanOrEqual(before);
            checked += 1;
            if (ownOnly.has(key)) ownOnlyMoves += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
    expect(ownOnlyMoves).toBeGreaterThan(300);
  });

  it("gives a requirement nothing was said about no points, never calls it not met, and shows it as coverage", () => {
    const s = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm")])), packet)!;
    // 6 of 14 points, with 8 still open
    expect(s.score).toBe(43);
    expect(s.openPoints).toBe(57);
    expect(s.coverage).toEqual({ known: 2, total: 5, words: "Based on 2 of 5 requirements" });
    expect(s.unknown.map((u) => [u.key, u.mustHave, u.weightPct, u.pointsLost])).toEqual([["perio", true, 29, 29], ["chairside", false, 21, 21], ["software", false, 7, 7]]);
    // not a "no": no hold, nothing missing, and nothing in the breakdown says "not met"
    expect(s).toMatchObject({ capped: false, missingMustHave: [] });
    expect(s.breakdown.map((c) => c.key)).toEqual(["rdh_license", "patients"]);
  });

  /**
   * The owner's own case (6 November 2026): "why everyone has the score of 100???". A job with one must-have and three
   * skills; a software engineer's CV for an office job, with one skill shown and one partly, or two shown; the must-have and
   * the third skill not mentioned. It read "100/100, Very high, Low confidence, 0 of 1 must-haves shown". It reads low now, in
   * one word, whichever skills they are.
   */
  describe("the owner's own case: one must-have and three skills, two of the four not known", () => {
    const skills = (names: Array<[string, number]>) => names.map(([key, weight]) => ({ key, name: key, definition: "d", weight, evaluatedIn: "both", indicators: ["x"] }));
    const job = (weights: [number, number, number]) => ({ requirements: { mustHaves: [{ key: "office", text: "Runs an office", rationale: "r", evidencedBy: ["resume", "screen"] }] }, competencies: skills([["a", weights[0]], ["b", weights[1]], ["c", weights[2]]]) }) as unknown as Pick<RolePacket, "requirements" | "competencies">;
    const rayyan = (over: Partial<ScoredReading> = {}) => reading("triage", [must("office", "unknown")], [skill("a", "evidenced", "wrote the scheduling tool"), skill("b", "evidenced", "handled the support queue"), skill("c", "not_evidenced")], { confidence: "low", ...over });

    it("reads low with \"Not enough evidence\", never 100, whatever the importance of the two skills shown", () => {
      // Essential, Important, Helpful: must-have 4 + 3 + 2 + 1 = 10 points
      const m = matchScore(pair(rayyan()), job([5, 3, 1]))!;
      expect(m).toMatchObject({ score: 50, band: "low", fit: "insufficient", capped: false, missingMustHave: [], confidence: "low" });
      expect(MATCH_FIT_LABEL[m.fit]).toBe("Not enough evidence");
      expect(m.coverage.words).toBe("Based on 2 of 4 requirements");
      expect(m.unknown.map((u) => u.key)).toEqual(["office", "c"]);
      // whichever two of the three skills were shown: 3 + 2, 3 + 1 or 2 + 1 of 10 points
      for (const [weights, score] of [[[5, 3, 1], 50], [[5, 1, 3], 40], [[3, 1, 5], 30]] as const) {
        expect(matchScore(pair(rayyan()), job(weights as unknown as [number, number, number]))).toMatchObject({ score, band: "low", fit: "insufficient" });
      }
    });

    it("rises when the AI interview shows the rest, so doing it is what lifts them", () => {
      const interview = reading("screen", [must("office", "yes", "I ran the office for six years")], [skill("c", "evidenced", "I keep the records")], { createdAt: "2026-10-02T10:00:00Z" });
      expect(matchScore(pair(rayyan(), interview), job([5, 3, 1]))).toMatchObject({ score: 100, band: "very_high", fit: "strong", openPoints: 0, interview: "done" });
    });
  });

  it("counts a must-have as missing only on a verified quote, and then holds the score at 54 and names it", () => {
    const unverified = matchScore(pair(reading("triage", [must("rdh_license", "no"), must("perio", "yes", "perio")])), packet)!;
    expect(unverified.missingMustHave).toEqual([]);
    // left out, but marked so the board asks a person to look (plan F6)
    expect(unverified.unknown.find((u) => u.key === "rdh_license")).toEqual({ key: "rdh_license", label: "Active CA RDH license", mustHave: true, importance: null, weightPct: 29, pointsLost: 29, unquotedNo: true });
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
    // rdh 4, perio 4, chairside 3 of the 14 points; patients and software not known yet
    expect(s).toMatchObject({ basedOn: "resume_and_screen", confidence: "high", score: 79 });
  });

  it("never lets doing the AI interview cost points: its checked no wins, otherwise the better checked finding, the AI interview's on a tie", () => {
    const one = { ...packet, requirements: { ...packet.requirements, mustHaves: [packet.requirements.mustHaves[0]!] }, competencies: [] };
    const cv = (met: Req["met"]) => reading("triage", [must("rdh_license", met, "the résumé's words")]);
    const said = (met: Req["met"]) => reading("screen", [must("rdh_license", met, "my own words")], [], { createdAt: "2026-10-02T10:00:00Z" });
    const found = (a: Req["met"], b: Req["met"]) => { const c = matchScore(pair(cv(a), said(b)), one)!.breakdown[0]; return [c.source, c.pctMet]; };
    // a short answer read as "partly" never replaces the résumé's "yes"
    expect(found("yes", "partially")).toEqual(["resume", 100]);
    // the better of the two
    expect(found("partially", "yes")).toEqual(["screen", 100]);
    expect(found("no", "yes")).toEqual(["screen", 100]);
    expect(found("no", "partially")).toEqual(["screen", 50]);
    // the AI interview's own "no" wins, whatever the résumé says: their own latest words
    expect(found("yes", "no")).toEqual(["screen", 0]);
    expect(matchScore(pair(cv("yes"), said("no")), one)!.missingMustHave).toEqual([{ key: "rdh_license", label: "Active CA RDH license", quote: "my own words" }]);
    // a tie is the AI interview's
    expect(found("yes", "yes")).toEqual(["screen", 100]);
    expect(found("partially", "partially")).toEqual(["screen", 50]);
    expect(found("no", "no")).toEqual(["screen", 0]);
    // the must-have line reads the same findings
    expect(mustHaveSummary(pair(cv("yes"), said("partially")), one)!.words).toBe("Must-haves: 1 of 1 shown");
    // a scorecard that says nothing leaves the résumé's number where it was; one that adds anything can only lift it
    const resume = reading("triage", [must("rdh_license", "yes", "RDH license")], [skill("chairside", "evidenced", "x"), skill("patients", "partially_evidenced", "y")]);
    const without = matchScore(pair(resume), packet)!.score!;
    expect(matchScore(pair(resume, reading("screen", [], [], { createdAt: "2026-10-02T10:00:00Z" })), packet)!.score).toBe(without);
    const addsAnything = reading("screen", [must("rdh_license", "partially", "licensed once")], [skill("chairside", "partially_evidenced", "some"), skill("software", "partially_evidenced", "some")], { createdAt: "2026-10-02T10:00:00Z" });
    expect(matchScore(pair(resume, addsAnything), packet)!.score!).toBeGreaterThan(without);
  });

  it("keeps a must-have checked only in the team's own interviews out of the sum whatever a reading found, and counts only their own quoted no", () => {
    const role = { ...packet, requirements: { mustHaves: [...packet.requirements.mustHaves, { key: "panel", text: "A strong teaching demo", rationale: "r", evidencedBy: ["interview"] }] } } as unknown as Pick<RolePacket, "requirements" | "competencies">;
    const shown = [must("rdh_license", "yes", "RDH license"), must("perio", "yes", "perio")];
    const skillsShown = [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")];
    const m = matchScore(pair(reading("triage", shown, skillsShown)), role)!;
    expect(m).toMatchObject({ score: 100, fit: "strong", openPoints: 0 });
    expect(m.coverage.total).toBe(5);
    expect(m.unknown).toEqual([]);
    // the must-have line still says it is not known: nobody has asked yet
    expect(mustHaveSummary(pair(reading("triage", shown, skillsShown)), role)!.words).toBe("Must-haves: 2 of 3 shown, 1 not yet known");
    // a reading that speaks to it leaves the number where it was: showing part of it, or all of it, never costs points
    // (the release review, 11 November 2026: counted once known, "I taught once" took this 100 down to 89)
    for (const finding of [must("panel", "partially", "I taught once"), must("panel", "yes", "I taught for six years"), must("panel", "yes")]) {
      const known = matchScore(pair(reading("triage", [...shown, finding], skillsShown)), role)!;
      expect(known, finding.met).toMatchObject({ score: 100, missingMustHave: [], capped: false });
      expect(known.coverage.total, finding.met).toBe(5);
      expect([...known.breakdown, ...known.unknown].map((c) => c.key), finding.met).not.toContain("panel");
    }
    // only their own quoted no counts, as for any must-have: it earns nothing, holds the score at 54 and is named
    expect(matchScore(pair(reading("triage", [...shown, must("panel", "no", "I have never taught")], skillsShown)), role)).toMatchObject({ score: 54, capped: true, fit: "missing_must_have", missingMustHave: [{ key: "panel", label: "A strong teaching demo", quote: "I have never taught" }] });
    // a "no" with nothing quoted is not known, like any other
    expect(matchScore(pair(reading("triage", [...shown, must("panel", "no")], skillsShown)), role)).toMatchObject({ score: 100, missingMustHave: [] });
    // a must-have the AI interview or the résumé can speak to stays in the sum
    const asked = { ...packet, requirements: { mustHaves: [...packet.requirements.mustHaves, { key: "panel", text: "A strong teaching demo", rationale: "r", evidencedBy: ["resume", "interview"] }] } } as unknown as Pick<RolePacket, "requirements" | "competencies">;
    expect(matchScore(pair(reading("triage", shown, skillsShown)), asked)).toMatchObject({ score: 78, fit: "potential", coverage: { total: 6 } });
  });

  it("gives the worked examples of the study: a thin CV reads low and the AI interview lifts it; a wrong trade stays low", () => {
    const office = {
      requirements: { mustHaves: [{ key: "m1", text: "Running an office", rationale: "r", evidencedBy: ["resume", "screen"] }, { key: "m2", text: "QuickBooks or similar", rationale: "r", evidencedBy: ["resume", "screen"] }] },
      competencies: [["s1", 5], ["s2", 3], ["s3", 3], ["s4", 1]].map(([key, weight]) => ({ key, name: key, definition: "d", weight, evaluatedIn: "both", indicators: ["x"] })),
    } as unknown as Pick<RolePacket, "requirements" | "competencies">;
    const of = (mustHaves: Req["met"][], found: Comp["finding"][]) => reading("triage", mustHaves.map((met, i) => must(`m${i + 1}`, met, met === "unknown" ? undefined : "their words")), found.map((f, i) => skill(`s${i + 1}`, f, f === "not_evidenced" ? undefined : "their words")));
    const scored = (r: ScoredReading) => { const m = matchScore(pair(r), office)!; return [m.score, m.fit]; };
    const E = "evidenced" as const, P = "partially_evidenced" as const, N = "not_evidenced" as const;
    expect(scored(of(["yes", "yes"], [E, E, E, E]))).toEqual([100, "strong"]); // Ana, a clear fit
    expect(scored(of(["yes", "yes"], [E, E, E, N]))).toEqual([94, "strong"]); // Ben, after answering well
    expect(scored(of(["yes", "unknown"], [P, N, N, N]))).toEqual([34, "insufficient"]); // Ben before: his résumé alone
    expect(scored(of(["yes", "yes"], [E, P, E, N]))).toEqual([88, "strong"]); // Cara, a good CV and no AI interview
    expect(scored(of(["unknown", "unknown"], [N, N, E, P]))).toEqual([16, "insufficient"]); // Dev, the wrong trade
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
    // the unquoted claims count half (61 of 100), above nothing said about them (21) and below the same claims quoted
    const silent = matchScore(pair(reading("triage", [must("rdh_license", "unknown"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")])), packet)!;
    expect(bare.score).toBe(61);
    expect(silent.score).toBe(21);
    // and an unquoted claim always counts half, below the same claim quoted
    const against = [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "contradicted", "I avoid patients"), skill("software", "contradicted", "never used dental software")];
    const scoreWith = (rdh: Req) => matchScore(pair(reading("triage", [rdh, must("perio", "yes", "Perio charting daily")], against)), packet)!.score!;
    expect([scoreWith(must("rdh_license", "unknown")), scoreWith(must("rdh_license", "yes")), scoreWith(must("rdh_license", "yes", "RDH license CA active"))]).toEqual([29, 43, 57]);
    // nothing checked at all: unquoted claims alone are half of what they are worth, here 4 of 14
    expect(matchScore(pair(reading("triage", [must("rdh_license", "yes"), must("perio", "yes")])), packet)!.score).toBe(29);
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

/**
 * One verdict word beside the number (the owner, 6 November 2026), from the same numbers as the score, so "Not enough
 * evidence" beside 100/100 can never happen again. The words each band can show are the study's table.
 */
describe("the one verdict word (fit)", () => {
  const one = (found: Partial<Record<"rdh_license" | "perio" | "chairside" | "patients" | "software", "yes" | "partly" | "no" | "unknown">>) => {
    const req = (k: "rdh_license" | "perio") => must(k, found[k] === "yes" ? "yes" : found[k] === "partly" ? "partially" : found[k] === "no" ? "no" : "unknown", found[k] && found[k] !== "unknown" ? "their words" : undefined);
    const comp = (k: "chairside" | "patients" | "software") => skill(k, found[k] === "yes" ? "evidenced" : found[k] === "partly" ? "partially_evidenced" : found[k] === "no" ? "contradicted" : "not_evidenced", found[k] && found[k] !== "unknown" ? "their words" : undefined);
    return matchScore(pair(reading("triage", [req("rdh_license"), req("perio")], [comp("chairside"), comp("patients"), comp("software")])), packet)!;
  };

  it("says Missing a must-have whenever their own words show one, at 54 or under", () => {
    expect(one({ rdh_license: "no", perio: "yes", chairside: "yes", patients: "yes", software: "yes" })).toMatchObject({ score: 54, fit: "missing_must_have" });
    expect(one({ rdh_license: "no" })).toMatchObject({ score: 0, fit: "missing_must_have" });
  });

  it("says Not enough evidence with no number, or a low number with a must-have not known or half the points open", () => {
    expect(one({})).toMatchObject({ score: null, fit: "insufficient" });
    expect(one({ rdh_license: "yes" })).toMatchObject({ score: 29, fit: "insufficient" });
    // every must-have known, but half the points still open
    const thin = one({ rdh_license: "yes", perio: "no", chairside: "unknown", patients: "unknown", software: "unknown" });
    expect(thin.fit).toBe("missing_must_have");
    const open = matchScore(pair(reading("triage", [must("rdh_license", "partially", "x"), must("perio", "partially", "y")], [skill("chairside", "not_evidenced")])), { ...packet, requirements: packet.requirements, competencies: [...packet.competencies, { key: "extra", name: "Extra", definition: "d", weight: 5, evaluatedIn: "both", indicators: ["x"] }] } as unknown as Pick<RolePacket, "requirements" | "competencies">)!;
    expect(open.openPoints).toBeGreaterThanOrEqual(50);
    expect(open).toMatchObject({ band: "low", fit: "insufficient" });
  });

  it("says Weak match for a low number once the must-haves are known and most of the points are spoken to", () => {
    expect(one({ rdh_license: "partly", perio: "partly", chairside: "no", patients: "no", software: "no" })).toMatchObject({ score: 29, openPoints: 0, fit: "weak" });
    // a skill against them and two partly: every must-have known, with under half the points open
    expect(one({ rdh_license: "partly", perio: "yes", chairside: "no", patients: "unknown", software: "unknown" })).toMatchObject({ band: "low", fit: "weak" });
  });

  it("says Strong match from 70 only with every must-have fully shown, and Potential match otherwise from 55", () => {
    expect(one({ rdh_license: "yes", perio: "yes", chairside: "yes", patients: "unknown", software: "unknown" })).toMatchObject({ score: 79, fit: "strong" });
    expect(one({ rdh_license: "yes", perio: "yes", chairside: "yes", patients: "yes", software: "yes" })).toMatchObject({ score: 100, fit: "strong" });
    // high, but a must-have only partly shown, or not known
    expect(one({ rdh_license: "yes", perio: "partly", chairside: "yes", patients: "yes", software: "yes" })).toMatchObject({ score: 86, fit: "potential" });
    expect(one({ rdh_license: "yes", perio: "unknown", chairside: "yes", patients: "yes", software: "yes" })).toMatchObject({ score: 71, fit: "potential" });
    // medium, every must-have shown
    expect(one({ rdh_license: "yes", perio: "yes", chairside: "unknown", patients: "unknown", software: "unknown" })).toMatchObject({ score: 57, fit: "potential" });
    // no must-haves at all: the number decides
    const noMusts = { ...packet, requirements: { mustHaves: [] }, competencies: packet.competencies } as unknown as Pick<RolePacket, "requirements" | "competencies">;
    expect(matchScore(pair(reading("triage", [], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y")])), noMusts)).toMatchObject({ score: 83, fit: "strong" });
  });

  it("can never put a word beside a band it disagrees with, over many random cases", () => {
    const rand = seeded(20261106);
    const allowed: Record<NonNullable<MatchScore["band"]>, MatchFit[]> = { low: ["missing_must_have", "insufficient", "weak"], medium: ["potential"], high: ["strong", "potential"], very_high: ["strong", "potential"] };
    const levels = ["yes", "partly", "no", "unknown"] as const;
    const pick = () => levels[Math.floor(rand() * levels.length)]!;
    let scored = 0;
    for (let n = 0; n < 2000; n++) {
      const m = one({ rdh_license: pick(), perio: pick(), chairside: pick(), patients: pick(), software: pick() });
      if (m.band === null) { expect(m.fit).toBe("insufficient"); continue; }
      scored += 1;
      expect(allowed[m.band], JSON.stringify([m.score, m.band, m.fit])).toContain(m.fit);
      if (m.fit === "missing_must_have") expect(m.score!).toBeLessThanOrEqual(MISSING_MUST_HAVE_CAP);
    }
    expect(scored).toBeGreaterThan(1500);
  });

  it("is in the same words as the list's filter, and the band's words stay apart", () => {
    expect(MATCH_FIT_LABEL).toEqual({ strong: "Strong match", potential: "Potential match", weak: "Weak match", missing_must_have: "Missing a must-have", insufficient: "Not enough evidence" });
    for (const word of Object.values(MATCH_FIT_LABEL)) expect(MATCH_SCORE_BANDS.map((b) => b.label)).not.toContain(word);
  });
});

/** "Sort: Score" (6 November 2026): final numbers first, then the interview still coming, then no score. */
describe("the groups of Sort: Score", () => {
  it("ranks a final number first, an AI interview still coming next, and no score last", () => {
    for (const interview of ["done", "not_done", "none", null, undefined] as const) expect(scoreRank({ score: 16, interview }), String(interview)).toBe(0);
    for (const interview of ["not_done_yet", "being_scored", "not_scored"] as const) expect(scoreRank({ score: 88, interview }), interview).toBe(1);
    expect(scoreRank({ score: null, interview: "done" })).toBe(2);
    expect(scoreRank({ interview: "not_done_yet" })).toBe(2);
  });
});

describe("whether the AI interview is in the score (20 October 2026, R20-9)", () => {
  const resume = reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "partially_evidenced", "assisted")]);
  const scorecard = reading("screen", [must("perio", "yes", "I chart perio every day")], [], { createdAt: "2026-10-02T10:00:00Z" });
  const words = (s: MatchScore) => [s.interview, s.basis];

  it("labels a résumé-only score by where the AI interview stands, in one neutral wording for every way it closed unsent", () => {
    expect(words(matchScore(pair(resume), packet)!)).toEqual(["none", "Résumé only: no AI interview"]);
    expect(words(matchScore(pair(resume), packet, { interview: "not_done_yet" })!)).toEqual(["not_done_yet", "Résumé only: AI interview not done yet"]);
    expect(words(matchScore(pair(resume), packet, { interview: "being_scored" })!)).toEqual(["being_scored", "Résumé only for now: AI interview done, being scored"]);
    expect(words(matchScore(pair(resume), packet, { interview: "not_done" })!)).toEqual(["not_done", "Résumé only: no AI interview"]);
    expect(words(matchScore(pair(resume), packet, { interview: "not_scored" })!)).toEqual(["not_scored", "Résumé only: AI interview done, not scored"]);
    // a caller's "done" with no scorecard among the readings is still being scored
    expect(matchScore(pair(resume), packet, { interview: "done" })!.interview).toBe("being_scored");
  });

  it("says both once the scorecard is in, whatever the caller read from the screens", () => {
    for (const given of [undefined, "not_done_yet", "being_scored", "not_done", "none"] as const) {
      expect(words(matchScore(pair(resume, scorecard), packet, { interview: given })!), String(given)).toEqual(["done", "From the résumé and the AI interview"]);
    }
    expect(words(matchScore(pair(null, scorecard), packet)!)).toEqual(["done", "From the AI interview"]);
    // done even when every counted finding came from the résumé: the label says what was read, `basedOn` which reading counted
    const silent = reading("screen", [], [], { createdAt: "2026-10-02T10:00:00Z" });
    expect(matchScore(pair(resume, silent), packet)).toMatchObject({ interview: "done", basedOn: "resume" });
  });

  it("never changes the number, the breakdown or what it rests on: only the label", () => {
    const bare = matchScore(pair(resume), packet)!;
    for (const interview of ["not_done_yet", "being_scored", "not_done", "none", "done"] as const) {
      const { interview: _i, basis: _b, ...rest } = matchScore(pair(resume), packet, { interview })!;
      const { interview: _bi, basis: _bb, ...bareRest } = bare;
      expect(rest, interview).toEqual(bareRest);
    }
    const both = matchScore(pair(resume, scorecard), packet)!;
    expect(matchScore(pair(resume, scorecard), packet, { interview: "not_done" })).toEqual(both);
  });
});

describe("interviewInScore: where the AI interview stands, from the screens in any order", () => {
  it("reads a sent one first, then an open one, then a closed one, and the stage when there is none yet", () => {
    expect(interviewInScore([{ status: "expired" }, { status: "completed" }, { status: "invited" }])).toBe("being_scored");
    expect(interviewInScore([{ status: "invited" }, { status: "completed" }])).toBe("being_scored");
    // a sent one whose scorecard waits for the company's AI credit is not "being scored" for ever, read from the screen or as a caller selected it alone
    expect(interviewInScore([{ status: "completed", progress: { scoreWaitsForCredit: "2026-11-05T10:00:00Z" } }])).toBe("not_scored");
    expect(interviewInScore([{ status: "expired" }, { status: "completed", scoreWaitsForCredit: "2026-11-05T10:00:00Z" }])).toBe("not_scored");
    expect(interviewInScore([{ status: "completed", scoreWaitsForCredit: null }])).toBe("being_scored");
    for (const open of ["invited", "reminded", "in_progress", "paused", "human_requested"]) expect(interviewInScore([{ status: "expired" }, { status: open }]), open).toBe("not_done_yet");
    for (const closed of ["expired", "unfinished", "declined_by_candidate", "abandoned", "cancelled"]) expect(interviewInScore([{ status: closed }]), closed).toBe("not_done");
    expect(interviewInScore([], "eligible")).toBe("not_done_yet");
    expect(interviewInScore([], "received")).toBe("not_done_yet");
    expect(interviewInScore([], "triaged")).toBe("none");
    expect(interviewInScore([], "ineligible")).toBe("none");
    expect(interviewInScore([])).toBe("none");
  });

  it("reads an AI interview that never came because the month's allowance stayed used up (Q17) as not done, never as 'never offered'", () => {
    // the screen run moved them from Getting the AI interview ready to New after sixty days, with no screen made
    expect(interviewInScore([], "triaged", { allowanceLapsed: true })).toBe("not_done");
    expect(interviewInScore([], "triaged", { allowanceLapsed: false })).toBe("none");
    // a later link a person sent wins: its own status says where it stands
    expect(interviewInScore([{ status: "invited" }], "screen_invited", { allowanceLapsed: true })).toBe("not_done_yet");
    expect(interviewInScore([{ status: "completed" }], "screen_complete", { allowanceLapsed: true })).toBe("being_scored");
  });

  it("gives the same answer whatever order the screens come in (the list loads them unordered)", () => {
    const screens = [{ status: "cancelled" }, { status: "reminded" }, { status: "expired" }];
    expect(interviewInScore([...screens].reverse())).toBe(interviewInScore(screens));
    expect(interviewInScore([screens[1]!, screens[0]!, screens[2]!])).toBe("not_done_yet");
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
    // software now Essential (3), of 16 points: must-haves 4 + 4, chairside 3, patients 2
    expect(s.score).toBe(19);
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
  const weighted = (key: string, mustHave: boolean, weight: number) => (c: WeighableRequirement) => (c.key === key && c.mustHave === mustHave ? weight : matchWeightOf(c));

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
    expect(cases.map(([p, role]) => matchScore(p, role)!.score)).toEqual([100, 43, 68, 43, 82, 43, 29, MISSING_MUST_HAVE_CAP, 0, null, 79, 100, 50, 61, 43, 29, 100, 75, 19]);
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
    // must-haves 4 + 4, chairside now 1, patients 2, software 1: 12 in all. Lost: chairside 1/12 = 8.33, perio 4/12 × 50 =
    // 16.67, patients 2/12 = 16.67, software 1/12 = 8.33, 50 in all.
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
    expect(previewMatch({ breakdown: [], unknown: [] }, matchWeightOf)).toEqual({ score: null, band: null, capped: false });
  });

  it("counts what nothing was said about at no points, like the real score, and leaves it out of the sum at a weight of 0", () => {
    const m = matchScore(pair(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "unknown")], [skill("chairside", "not_evidenced"), skill("patients", "evidenced", "calm")])), packet)!;
    expect(m.score).toBe(43);
    expect(previewMatch(m, matchWeightOf)).toEqual({ score: 43, band: "low", capped: false });
    // perio left out: 6 of 10
    expect(previewMatch(m, weighted("perio", true, 0))).toEqual({ score: 60, band: "medium", capped: false });
    // only what nobody spoke to is left in: nothing known, so no score
    expect(previewMatch(m, (c) => (c.key === "rdh_license" || c.key === "patients" ? 0 : matchWeightOf(c)))).toEqual({ score: null, band: null, capped: false });
  });

  it("gives the same score whatever the order of the breakdown", () => {
    const m = matchScore(pair(reading("triage", [must("rdh_license", "partially", "a"), must("perio", "yes", "b")], [skill("software", "partially_evidenced", "c"), skill("chairside", "contradicted", "d"), skill("patients", "partially_evidenced", "e")])), packet)!;
    const weightOf = weighted("patients", false, 3);
    const want = previewMatch(m, weightOf);
    const b = m.breakdown;
    for (const order of [[...b].reverse(), [...b.slice(2), ...b.slice(0, 2)], [b[1], b[3], b[0], b[4], b[2]]]) {
      expect(previewMatch({ breakdown: order as MatchCriterion[], unknown: m.unknown }, weightOf)).toEqual(want);
      expect(previewMatch({ breakdown: order as MatchCriterion[], unknown: m.unknown }, matchWeightOf).score).toBe(m.score);
    }
  });
});
