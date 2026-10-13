import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@ros/ai";
import type { EvidenceAssessment } from "@ros/contracts";
import { applyEvidenceRules, combineOutcomes, combineReadings, credentialMustHaves, shownNotHeld } from "./triage";

/**
 * The fairness run on Haiku 5.5 (14 Oct 2026): one résumé read three times scored 83, 71 and 67, and an expired licence
 * was "unknown" in two readings of three although each quoted "expired". Three readings and their middle answer, and the
 * expired-credential rule in code, make the same application read and score the same each time. The review of the
 * first version (PR #38) found the rule overturning "yes" on "never lapsed" and a skipped finding letting one "no" win:
 * both are pinned here.
 */
const RESUME = "Casey Morgan, RDH\nRegistered Dental Hygienist at Bayside Dental 2016 - 2021\nRDH license CA expired in 2021; renewal not started\nScaling and root planing, patient education";

type Met = EvidenceAssessment["requirementFindings"][number]["met"];
type Found = EvidenceAssessment["competencyFindings"][number]["finding"];

const reading = (licence: Met | null, perio: Met, chairside: Found, over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  overall: "potential",
  confidence: "medium",
  summary: `licence ${licence}, perio ${perio}, chairside ${chairside}`,
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [{ competencyKey: "chairside", finding: chairside, evidence: { source: "resume", quote: "Scaling and root planing" } }],
  requirementFindings: [
    ...(licence === null ? [] : [{ requirementKey: "licence", met: licence, ...(licence === "unknown" ? {} : { evidence: { source: "resume" as const, quote: "RDH license CA expired in 2021" } }) }]),
    { requirementKey: "perio", met: perio, evidence: { source: "resume", quote: "Scaling and root planing" } },
  ],
  anomalies: [],
  recommendation: "screen",
  rationale: "r",
  ...over,
});

const metOf = (a: EvidenceAssessment, key: string) => a.requirementFindings.find((f) => f.requirementKey === key)?.met;
const decided = (a: EvidenceAssessment) => ({ overall: a.overall, recommendation: a.recommendation, confidence: a.confidence, met: a.requirementFindings.map((f) => `${f.requirementKey}:${f.met}`), found: a.competencyFindings.map((f) => `${f.competencyKey}:${f.finding}`), summary: a.summary });

describe("three readings of the same application", () => {
  it("keep the middle answer of each finding, with the evidence of a reading that gave it", () => {
    const out = combineReadings([reading("no", "yes", "evidenced"), reading("no", "partially", "partially_evidenced"), reading("no", "yes", "evidenced")]);
    expect(metOf(out, "perio")).toBe("yes");
    expect(out.competencyFindings).toEqual([{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Scaling and root planing" } }]);
    // all three different: the middle on the order no, unknown, partially, yes
    expect(metOf(combineReadings([reading("no", "yes", "evidenced"), reading("no", "unknown", "evidenced"), reading("no", "partially", "evidenced")]), "perio")).toBe("partially");
  });

  it("count a finding a reading left out as unknown, so one reading's 'no' never outvotes two that said nothing", () => {
    const out = combineReadings([reading("no", "yes", "evidenced"), reading(null, "yes", "evidenced"), reading(null, "yes", "evidenced")]);
    expect(metOf(out, "licence")).toBe("unknown");
    expect(out.requirementFindings.find((f) => f.requirementKey === "licence")).toEqual({ requirementKey: "licence", met: "unknown" });
    // one "yes" and two silent: unknown too; two "yes" and one silent: yes
    expect(metOf(combineReadings([reading("yes", "yes", "evidenced"), reading(null, "yes", "evidenced"), reading(null, "yes", "evidenced")]), "licence")).toBe("unknown");
    expect(metOf(combineReadings([reading("yes", "yes", "evidenced"), reading("yes", "yes", "evidenced"), reading(null, "yes", "evidenced")]), "licence")).toBe("yes");
    // a key written twice in one reading still counts once
    const twice = reading("no", "yes", "evidenced");
    twice.requirementFindings.push({ requirementKey: "licence", met: "no", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } });
    expect(metOf(combineReadings([twice, reading("yes", "yes", "evidenced"), reading("yes", "yes", "evidenced")]), "licence")).toBe("yes");
  });

  it("take the overall reading and the confidence as their middle, and the recommendation and words from one reading", () => {
    const split = [
      reading("no", "yes", "evidenced", { overall: "weak", confidence: "low", recommendation: "hold", summary: "weak one" }),
      reading("no", "yes", "evidenced", { overall: "potential", confidence: "medium", recommendation: "screen", summary: "potential one" }),
      reading("no", "yes", "evidenced", { overall: "strong", confidence: "high", recommendation: "screen", summary: "strong one" }),
    ];
    expect(decided(combineReadings(split))).toMatchObject({ overall: "potential", confidence: "medium", recommendation: "screen", summary: "potential one" });
    // "unknown" only when most readings say so
    expect(combineReadings([split[0]!, reading("no", "yes", "evidenced", { overall: "unknown", recommendation: "review_manually" }), split[2]!]).overall).toBe("strong");
    expect(combineReadings([reading("no", "yes", "evidenced", { overall: "unknown" }), reading("no", "yes", "evidenced", { overall: "unknown" }), split[2]!]).overall).toBe("unknown");
  });

  it("read exactly the same whatever order the readings come back in", () => {
    const a = reading("no", "yes", "evidenced", { overall: "strong", confidence: "high", summary: "a" });
    const b = reading("unknown", "partially", "partially_evidenced", { overall: "weak", confidence: "low", recommendation: "hold", summary: "b" });
    const c = reading("no", "yes", "partially_evidenced", { overall: "potential", summary: "c" });
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]].map((o) => decided(combineReadings(o)));
    for (const o of orders) expect(o).toEqual(orders[0]);
    expect(orders[0]).toMatchObject({ overall: "potential", met: ["licence:no", "perio:yes"], found: ["chairside:partially_evidenced"] });
  });

  it("use the first reading when fewer than three came back, saying so, and fail on an outage so the step is retried", () => {
    const sources = { resume: RESUME };
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    const invalid: RunOutcome<EvidenceAssessment> = { ok: false, runId: "r8", model: "m", reason: "invalid", error: "no valid output" };
    const outage: RunOutcome<EvidenceAssessment> = { ok: false, runId: "r9", model: "m", reason: "error", error: "provider error: 529" };
    const two = combineOutcomes([invalid, ok(reading("no", "yes", "evidenced"), "r2"), ok(reading("no", "partially", "evidenced"), "r3")], sources);
    expect(two).toMatchObject({ ok: true, runId: "r2" });
    if (two.ok) {
      expect(metOf(two.output, "perio")).toBe("yes");
      expect(two.output.confidenceReasons).toContain("the assistant could read this application 2 times instead of 3");
    }
    expect(combineOutcomes([invalid, outage, invalid], sources)).toBe(outage);
    expect(combineOutcomes([invalid, invalid, invalid], sources)).toBe(invalid);
  });
});

describe("a credential the candidate's own words show is not held", () => {
  it("is read from expired, lapsed, inactive, revoked, suspended or not renewed, never when negated or held again", () => {
    for (const q of ["RDH license CA expired in 2021; renewal not started", "License lapsed 2019", "RDH (inactive)", "License revoked", "BLS not renewed"]) expect(shownNotHeld(q), q).toBe(true);
    for (const q of [
      "RDH license CA active", "License lapsed in 2019, renewed in 2020", "Current RDH license", "RDH license valid through 2027", "Licence reinstated after it lapsed",
      "it has never lapsed or been suspended", "CA RDH license #12345, not expired", "non-expired California RDH license", "License never suspended or revoked",
      "RDH license lapsed briefly in 2019 and is currently in good standing", "License inactive 2018-2019, reactivated 2020", "My license hasn't expired",
    ]) expect(shownNotHeld(q), q).toBe(false);
  });

  it("settles only an 'unknown' credential must-have on a verified quote from the candidate", () => {
    const credentials = credentialMustHaves({ requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] }, { key: "perio", text: "Periodontal therapy", rationale: "work", evidencedBy: ["resume"] }], niceToHaves: [], eligibility: [] } });
    expect([...credentials]).toEqual(["licence"]);
    const inResume = (e: { quote?: string; source: string }) => (e.source === "resume" ? RESUME.includes(e.quote ?? "") : null);
    const quoted = (key: string, met: Met, quote: string, source: "resume" | "recruiter_note" = "resume") => reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: key, met, evidence: { source, quote } }] });
    expect(metOf(applyEvidenceRules(quoted("licence", "unknown", "RDH license CA expired in 2021"), inResume, { credentials }), "licence")).toBe("no");
    // never overturns a "yes" or a "partially"
    expect(metOf(applyEvidenceRules(quoted("licence", "yes", "RDH license CA expired in 2021"), inResume, { credentials }), "licence")).toBe("yes");
    expect(metOf(applyEvidenceRules(quoted("licence", "partially", "RDH license CA expired in 2021"), inResume, { credentials }), "licence")).toBe("partially");
    // only a credential must-have, and only when the caller names the credentials (the screen scorecard does not)
    expect(metOf(applyEvidenceRules(quoted("perio", "unknown", "RDH license CA expired in 2021"), inResume, { credentials }), "perio")).toBe("unknown");
    expect(metOf(applyEvidenceRules(quoted("licence", "unknown", "RDH license CA expired in 2021"), inResume), "licence")).toBe("unknown");
    // never on a recruiter's note, never on a quote that is not in the résumé
    expect(metOf(applyEvidenceRules(quoted("licence", "unknown", "said the licence expired", "recruiter_note"), () => true, { credentials }), "licence")).toBe("unknown");
    expect(metOf(applyEvidenceRules(quoted("licence", "unknown", "license expired in 2010"), inResume, { credentials }), "licence")).toBe("unknown");
  });
});
