import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@ros/ai";
import type { EvidenceAssessment } from "@ros/contracts";
import { applyEvidenceRules, assessmentSources, combineOutcomes, combineReadings, credentialFinding, credentialMustHaves, findingSubjects, plainlyNotHeld, readingsOutcome, settledOverall, settledRecommendation, shownNotHeld, verifyAssessmentQuotes } from "./triage";

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

/**
 * Wave S7 (fairness run of 15 Oct 2026, triage.consistency assistant_not_yet_hygienist and triage.credentials lapsed):
 * the licence finding was steady, but the overall reading moved between "potential" and "unknown" from one set of
 * readings to the next. The résumé reading's overall is now worked out in code from its settled findings.
 */
describe("the overall reading, worked out from the settled findings (Wave S7)", () => {
  const PACKET = {
    requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume" as const] }, { key: "perio", text: "Periodontal therapy", rationale: "work", evidencedBy: ["resume" as const] }], niceToHaves: [], eligibility: [] },
    competencies: [{ key: "chairside", name: "Chairside skill", definition: "d", weight: 5, evaluatedIn: "both" as const, indicators: ["x"] }],
  } as unknown as Parameters<typeof settledOverall>[1];
  const ASSISTANT = "Riley Chen\nCosta Mesa, CA\nDental Assistant at Sunrise Family Dentistry 2020 - present\nChairside assisting, sterilization, X-rays, Dentrix scheduling\nEnrolled in a dental hygiene program, graduating 2027";
  const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
  const view = { restore: (s: string) => s };
  const assistantReading = (overall: EvidenceAssessment["overall"], recommendation: EvidenceAssessment["recommendation"]): EvidenceAssessment =>
    reading(null, "unknown", "partially_evidenced", {
      overall,
      recommendation,
      requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "resume", quote: "Enrolled in a dental hygiene program, graduating 2027" } }, { requirementKey: "perio", met: "unknown" }],
      competencyFindings: [{ competencyKey: "chairside", finding: "partially_evidenced", evidence: { source: "resume", quote: "Chairside assisting, sterilization, X-rays" } }],
    });
  const read = (overalls: Array<[EvidenceAssessment["overall"], EvidenceAssessment["recommendation"]]>) => {
    const out = readingsOutcome(overalls.map(([o, r], i) => ok(assistantReading(o, r), `r${i}`)), view, { packet: PACKET as never, resumeText: ASSISTANT, applicationAnswers: { eligibility: {} } });
    if (!out.ok) throw new Error("expected readings");
    return out.output;
  };

  it("gives the same overall reading and recommendation whatever each reading said overall", () => {
    const first = read([["potential", "screen"], ["unknown", "review_manually"], ["unknown", "review_manually"]]);
    const second = read([["potential", "screen"], ["potential", "screen"], ["unknown", "review_manually"]]);
    const third = read([["strong", "screen"], ["weak", "hold"], ["unknown", "review_manually"]]);
    // the licence is in training (the licence rule: unknown), perio unknown, chairside partly shown: potential
    for (const out of [first, second, third]) {
      expect(out.requirementFindings.map((f) => `${f.requirementKey}:${f.met}`)).toEqual(["licence:unknown", "perio:unknown"]);
      expect(out.overall).toBe("potential");
    }
    // the recommendation goes with it (the prompt's rule), and the words come from a reading that said the same
    for (const out of [first, second, third]) expect(out.recommendation).toBe("screen");
    expect(first.summary).toBe(assistantReading("potential", "screen").summary);
    expect(read([["weak", "hold"], ["weak", "hold"], ["weak", "hold"]])).toMatchObject({ overall: "potential", recommendation: "screen" });
  });

  it("asks a person to look, never a screening chat, when an eligibility answer did not match and no one kept them in", () => {
    const failed = { evaluatedAt: "2026-10-15T10:00:00Z", passed: false, failedRules: [{ key: "schedule", question: "Can you work Saturdays?", answer: "no", reason: "answered no" }], unverifiable: [] };
    const input = { packet: PACKET as never, resumeText: ASSISTANT, applicationAnswers: { eligibility: {} }, eligibility: failed };
    const runs = [ok(assistantReading("potential", "screen"), "r1"), ok(assistantReading("potential", "screen"), "r2"), ok(assistantReading("potential", "screen"), "r3")];
    const held = readingsOutcome(runs, view, input);
    expect(held.ok && held.output.recommendation).toBe("review_manually");
    const kept = readingsOutcome(runs, view, { ...input, eligibilityKeptIn: true });
    expect(kept.ok && kept.output.recommendation).toBe("screen");
  });

  it("is the same whatever order the readings come back in, and with fewer readings", () => {
    const a = assistantReading("potential", "screen");
    const b = assistantReading("unknown", "review_manually");
    const c = assistantReading("strong", "screen");
    const orders = [[a, b, c], [c, b, a], [b, a, c]].map((o) => readingsOutcome(o.map((x, i) => ok(x, `r${i}`)), view, { packet: PACKET as never, resumeText: ASSISTANT, applicationAnswers: { eligibility: {} } }));
    const decidedOf = (r: RunOutcome<EvidenceAssessment>) => (r.ok ? decided(r.output) : null);
    for (const o of orders) expect(decidedOf(o)).toEqual(decidedOf(orders[0]!));
    const invalid: RunOutcome<EvidenceAssessment> = { ok: false, runId: "rx", model: "m", reason: "invalid", error: "no valid output" };
    const one = readingsOutcome([invalid, ok(b, "r1"), invalid], view, { packet: PACKET as never, resumeText: ASSISTANT, applicationAnswers: { eligibility: {} } });
    expect(one.ok && one.output.overall).toBe("potential");
  });

  it("follows the prompt's own definitions, read from the findings as the match score reads them", () => {
    const f = (licence: Met, perio: Met, chairside: Found, quoted = true) => ({
      requirementFindings: [
        { requirementKey: "licence", met: licence, ...(quoted && licence !== "unknown" ? { evidence: { source: "resume" as const, quote: licence === "no" ? "I do not hold a CA RDH license" : "RDH license CA active" } } : {}) },
        { requirementKey: "perio", met: perio, ...(perio !== "unknown" ? { evidence: { source: "resume" as const, quote: "Periodontal therapy daily" } } : {}) },
      ],
      competencyFindings: [{ competencyKey: "chairside", finding: chairside, ...(chairside !== "not_evidenced" ? { evidence: { source: "resume" as const, quote: "Chairside assisting daily" } } : {}) }],
    });
    const work = { hasWork: true };
    expect(settledOverall(f("yes", "yes", "evidenced"), PACKET, work)).toBe("strong");
    // a "yes" with nothing quoted is partly shown, as in the score: potential, never strong
    expect(settledOverall(f("yes", "yes", "evidenced", false), PACKET, work)).toBe("potential");
    expect(settledOverall(f("yes", "partially", "evidenced"), PACKET, work)).toBe("potential");
    expect(settledOverall(f("yes", "unknown", "evidenced"), PACKET, work)).toBe("potential");
    // too few skills shown, or an essential one against them: potential
    expect(settledOverall(f("yes", "yes", "partially_evidenced"), PACKET, work)).toBe("potential");
    expect(settledOverall(f("yes", "yes", "contradicted"), PACKET, work)).toBe("potential");
    // weak only on a must-have their own words show is not met
    expect(settledOverall(f("no", "yes", "evidenced"), PACKET, work)).toBe("weak");
    expect(settledOverall(f("no", "yes", "evidenced", false), PACKET, work)).toBe("potential");
    // nothing either way, or a skill against them alone: the readings' own judgement of the work is all there is
    // ("thin but relevant", or not this kind of work), as its middle; never strong on no findings
    expect(settledOverall(f("unknown", "unknown", "not_evidenced"), PACKET, work)).toBe("unknown");
    expect(settledOverall(f("unknown", "unknown", "contradicted"), PACKET, work)).toBe("unknown");
    const silent = f("unknown", "unknown", "not_evidenced");
    expect(settledOverall(silent, PACKET, { hasWork: true, said: ["potential", "potential", "unknown"] })).toBe("potential");
    expect(settledOverall(silent, PACKET, { hasWork: true, said: ["potential", "unknown", "unknown"] })).toBe("unknown");
    expect(settledOverall(silent, PACKET, { hasWork: true, said: ["strong", "strong", "strong"] })).toBe("potential");
    expect(settledOverall(f("unknown", "unknown", "contradicted"), PACKET, { hasWork: true, said: ["weak", "weak", "potential"] })).toBe("weak");
    // the findings decide whenever they say anything: what the readings said makes no difference then
    expect(settledOverall(f("yes", "unknown", "evidenced"), PACKET, { hasWork: true, said: ["unknown", "unknown", "weak"] })).toBe("potential");
    // no résumé text and no written description: unknown, whatever an answer on the form shows
    expect(settledOverall(f("yes", "yes", "evidenced"), PACKET, { hasWork: false })).toBe("unknown");
  });

  it("gives the recommendation that goes with it, by the prompt's rule", () => {
    expect(settledRecommendation("unknown", { eligible: true })).toBe("review_manually");
    expect(settledRecommendation("weak", { eligible: true })).toBe("hold");
    expect(settledRecommendation("potential", { eligible: true })).toBe("screen");
    expect(settledRecommendation("strong", { eligible: true })).toBe("screen");
    expect(settledRecommendation("strong", { eligible: false })).toBe("review_manually");
    expect(settledRecommendation("weak", { eligible: false })).toBe("hold");
  });

  it("leaves the scorecard's overall reading as the middle of its readings (no settlement given)", () => {
    expect(combineReadings([reading("no", "yes", "evidenced", { overall: "weak" }), reading("no", "yes", "evidenced", { overall: "strong" }), reading("no", "yes", "evidenced", { overall: "strong" })]).overall).toBe("strong");
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

  it("reads pending, applied for, in training and not yet as not in force too", () => {
    for (const q of ["CA RDH license pending: board exam passed", "Applied for my RDH license in May", "Enrolled in a dental hygiene program, graduating 2027", "Not yet licensed", "RDH trainee"]) expect(shownNotHeld(q), q).toBe(true);
    // "currently" alone no longer says it is held ("currently enrolled"); "currently licensed" does
    expect(shownNotHeld("Currently enrolled in an RDH program")).toBe(true);
    expect(shownNotHeld("Currently licensed in CA; renewal due 2027")).toBe(false);
  });

  it("is 'not held' plainly only when the candidate says so, with nothing pending, lapsed or held about it", () => {
    for (const q of ["I do not hold a California RDH license", "I don't have an RDH license", "Not licensed in California", "No RDH license", "I have no hygiene license", "Never held a license", "Unlicensed"]) expect(plainlyNotHeld(q), q).toBe(true);
    for (const q of ["RDH license CA expired in 2021", "I do not have my license yet", "I don't hold it yet: exam in May", "No RDH license; application pending", "I do not hold an active CA license", "Enrolled in a dental hygiene program, graduating 2027", "RDH license CA active"]) expect(plainlyNotHeld(q), q).toBe(false);
  });

  /**
   * The founder's licence rule (15 Oct 2026): a credential must-have is "no" only when the candidate's own words say
   * plainly they do not hold it; lapsed, expired, pending or unclear is "unknown", whatever the model answered, so every
   * reading of the same CV gives the same finding and score.
   */
  it("holds a credential must-have to the licence rule, whatever the model answered", () => {
    const credentials = credentialMustHaves({ requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] }, { key: "perio", text: "Periodontal therapy", rationale: "work", evidencedBy: ["resume"] }], niceToHaves: [], eligibility: [] } });
    expect([...credentials]).toEqual(["licence"]);
    const text = `${RESUME}\nI do not hold a Nevada RDH license\nRDH license CA active`;
    const inResume = (e: { quote?: string; source: string }) => (e.source === "resume" ? text.includes(e.quote ?? "") : null);
    const quoted = (key: string, met: Met, quote: string, source: "resume" | "recruiter_note" = "resume") => reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: key, met, evidence: { source, quote } }] });
    const lapsed = "RDH license CA expired in 2021; renewal not started";
    // lapsed: "unknown" from every answer the model could give, so three readings always agree
    for (const met of ["no", "unknown", "partially", "yes"] as const) expect(metOf(applyEvidenceRules(quoted("licence", met, lapsed), inResume, { credentials }), "licence"), met).toBe("unknown");
    // said plainly: a "no" stands
    expect(metOf(applyEvidenceRules(quoted("licence", "no", "I do not hold a Nevada RDH license"), inResume, { credentials }), "licence")).toBe("no");
    // held: a "yes" stands
    expect(metOf(applyEvidenceRules(quoted("licence", "yes", "RDH license CA active"), inResume, { credentials }), "licence")).toBe("yes");
    // the reason says why, without stepping the confidence down (nothing was invented)
    const settled = applyEvidenceRules(quoted("licence", "no", lapsed), inResume, { credentials });
    expect(settled.confidence).toBe("medium");
    expect(settled.confidenceReasons?.at(-1)).toMatch(/lapsed, pending or unclear in the candidate's words, so not known yet/);
    // only a credential must-have, and only when the caller names the credentials
    expect(metOf(applyEvidenceRules(quoted("perio", "no", lapsed), inResume, { credentials }), "perio")).toBe("no");
    expect(metOf(applyEvidenceRules(quoted("licence", "no", lapsed), inResume), "licence")).toBe("no");
    // a recruiter's note never makes a "no", and a lapsed licence in it is not a "yes" either
    expect(metOf(applyEvidenceRules(quoted("licence", "no", "said the licence expired", "recruiter_note"), () => null, { credentials }), "licence")).toBe("unknown");
    expect(metOf(applyEvidenceRules(quoted("licence", "yes", "said the licence expired last year", "recruiter_note"), () => null, { credentials }), "licence")).toBe("unknown");
    // a quote that is not in the résumé is no evidence at all
    expect(metOf(applyEvidenceRules(quoted("licence", "no", "I do not hold any license"), inResume, { credentials }), "licence")).toBe("unknown");
  });

  it("reads the candidate's whole line, never only the part the model quoted (review of Wave S5)", () => {
    const packet = { requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume" as const] }], niceToHaves: [], eligibility: [] } };
    const credentials = credentialMustHaves(packet);
    const subjects = findingSubjects(packet);
    const sources = { resume: `${RESUME}\nI do not hold a CA RDH license` };
    const said = (met: Met, quote: string) => reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met, evidence: { source: "resume", quote } }] });
    // a "yes" quoting only "RDH license CA" from the expired line is read with the whole line: unknown
    expect(metOf(verifyAssessmentQuotes(said("yes", "RDH license CA"), sources, credentials, subjects), "licence")).toBe("unknown");
    // an "unknown" quoting the plain words is "no": the finding rests on the words, not on the model's answer
    for (const met of ["unknown", "no", "partially", "yes"] as const) expect(metOf(verifyAssessmentQuotes(said(met, "I do not hold a CA RDH license"), sources, credentials, subjects), "licence"), met).toBe("no");
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    const middle = (mets: Met[]) => {
      const out = combineOutcomes(mets.map((m, i) => ok(said(m, "I do not hold a CA RDH license"), `r${i}`)), sources, credentials, subjects);
      if (!out.ok) throw new Error("expected readings");
      return metOf(out.output, "licence");
    };
    expect(middle(["no", "unknown", "unknown"])).toBe("no");
    expect(middle(["no", "no", "unknown"])).toBe("no");
  });

  it("does not read a renewal or another qualification as the licence's state", () => {
    expect(credentialFinding("yes", "RDH license CA #12345, renewal expected 2026")).toBe("yes");
    expect(credentialFinding("yes", "RDH license CA #12345; renewal in progress", "Active CA RDH license")).toBe("yes");
    expect(credentialFinding("yes", "Enrolled in a dental hygiene program")).toBe("unknown");
    expect(credentialFinding("yes", "Enrolled in a dental hygiene program", "Active CA RDH license")).toBe("unknown");
    expect(credentialFinding("yes", "RDH license CA; studying for local anesthesia permit", "Active CA RDH license")).toBe("yes");
    // the licence's own state still counts on a line that also names another
    expect(credentialFinding("yes", "RDH license CA expired 2021; BLS current", "Active CA RDH license")).toBe("unknown");
    expect(credentialFinding("no", "RDH license CA; not licensed in Nevada", "Active CA RDH license")).toBe("unknown");
  });

  it("never takes a self-reported eligibility box as a quote (the answers only, not their field names)", () => {
    const input = { resumeText: null, applicationAnswers: { eligibility: { rdh_license: "yes", work_authorization: "I am authorised to work in the US" } } };
    const sources = assessmentSources(input);
    expect(sources.application).not.toContain("rdh_license");
    const out = verifyAssessmentQuotes(reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "application", quote: 'rdh_license":"yes' } }] }), sources);
    expect(out.requirementFindings[0]).toMatchObject({ met: "partially", evidence: { source: "application", unquoted: true } });
    expect(sources.application).toContain("I am authorised to work in the US");
  });

  it("makes the lapsed licence of the fairness run read the same in all three readings", () => {
    const credentials = new Set(["licence"]);
    const sources = { resume: RESUME };
    const lapsedReading = (met: Met) => reading(met, "partially", "partially_evidenced", { requirementFindings: [{ requirementKey: "licence", met, ...(met === "unknown" ? {} : { evidence: { source: "resume" as const, quote: "RDH license CA expired in 2021; renewal not started" } }) }] });
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    // the run of 14 Oct 2026: "no", "no", "unknown" in one application, "unknown" three times in the next
    const first = combineOutcomes([ok(lapsedReading("no"), "r1"), ok(lapsedReading("no"), "r2"), ok(lapsedReading("unknown"), "r3")], sources, credentials);
    const second = combineOutcomes([ok(lapsedReading("unknown"), "r4"), ok(lapsedReading("unknown"), "r5"), ok(lapsedReading("unknown"), "r6")], sources, credentials);
    if (!first.ok || !second.ok) throw new Error("expected readings");
    expect(metOf(first.output, "licence")).toBe("unknown");
    expect(metOf(second.output, "licence")).toBe("unknown");
  });
});
