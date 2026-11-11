import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, MatchScore, RolePacket } from "@ros/contracts";
import { COMPARE_MAX, cellFigures, criterionCell, mixedScores, orderCandidates, orderLine, scoreSummary, skillTag, togglePick, versionNotes, type CompareCandidateView } from "../../apps/web/src/pages/compare/compare-view";
import { matchScore, type ScoredReading } from "../../packages/core/src/match-score";

/**
 * The comparison view (docs/spec/21 F10; founder decision B2): up to five people side by side, each one's match score
 * on top and one line per must-have and skill with % met and the points it cost, in the order chosen unless the
 * highest score first is asked for. Scores come from the real function in packages/core.
 */
const packet = {
  requirements: { mustHaves: [{ key: "rdh", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] }, { key: "perio", text: "Perio charting", rationale: "work", evidencedBy: ["resume"] }] },
  competencies: [
    { key: "chairside", name: "Chairside skill", definition: "d", weight: 5, evaluatedIn: "both", indicators: ["x"] },
    { key: "patients", name: "Patient care", definition: "d", weight: 3, evaluatedIn: "both", indicators: ["x"] },
    { key: "software", name: "Dental software", definition: "d", weight: 1, evaluatedIn: "screen", indicators: ["x"] },
  ],
} as unknown as Pick<RolePacket, "requirements" | "competencies">;

type Req = EvidenceAssessment["requirementFindings"][number];
type Comp = EvidenceAssessment["competencyFindings"][number];
const must = (key: string, met: Req["met"], quote?: string): Req => ({ requirementKey: key, met, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const skill = (key: string, finding: Comp["finding"], quote?: string): Comp => ({ competencyKey: key, finding, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const reading = (req: Req[], comp: Comp[] = []): ScoredReading => ({ kind: "triage", confidence: "high", packetVersion: 1, createdAt: "2026-10-01T10:00:00Z", result: { requirementFindings: req, competencyFindings: comp } });

const person = (id: string, name: string, r: ScoredReading | null, over: Partial<CompareCandidateView> = {}): CompareCandidateView => ({
  applicationId: id,
  name,
  stage: "triaged",
  stageLabel: "Ready for your review",
  group: "waiting_on_you",
  mustHaves: {},
  competencies: {},
  screen: null,
  resume: null,
  unknownCount: 0,
  open: `/roles/r1/talent?open=${id}`,
  score: r ? matchScore({ resume: r, screen: null }, packet) : null,
  readingVersion: null,
  ...over,
});

const ana = person("a", "Ana", reading([must("rdh", "yes", "RDH"), must("perio", "partially", "some perio")], [skill("chairside", "evidenced", "x"), skill("software", "contradicted", "never used it")]));
const ben = person("b", "Ben", reading([must("rdh", "no", "My license lapsed"), must("perio", "yes", "daily perio")]));
const cy = person("c", "Cy", null, { mustHaves: { rdh: { met: "yes", quote: "RDH" } } });

describe("the comparison view", () => {
  it("keeps the order chosen, or puts the highest score first with no score last", () => {
    expect(orderCandidates([cy, ben, ana], "chosen").map((c) => c.name)).toEqual(["Cy", "Ben", "Ana"]);
    expect(orderCandidates([cy, ben, ana], "score").map((c) => c.name)).toEqual(["Ana", "Ben", "Cy"]);
    // the order as chosen has no line (the switch shows it); "Highest score first" says how it ranks and that people decide
    expect(orderLine(1)).toMatch(/^1 person, the highest match score first\. A score helps you read; it never decides\.$/);
  });

  it("tops each column with the score, its one verdict word, what it rests on and any missing must-have", () => {
    expect(scoreSummary(ana)).toMatchObject({ score: 64, verdict: "Potential match", coverage: "Based on 4 of 5 requirements", basis: "Résumé only: no AI interview" });
    // two must-haves judged, one shown missing by their own words: 4 of the 14 points, under the cap of 54
    expect(scoreSummary(ben)).toMatchObject({ score: 29, verdict: "Missing a must-have", missing: ["Missing must-have: Active CA RDH license"] });
    expect(scoreSummary(cy)).toEqual({ score: null, verdict: null, coverage: "No AI review yet", basis: null, missing: [] });
    // an older answer without the word: the band's
    const { fit: _fit, ...older } = ana.score!;
    expect(scoreSummary({ ...ana, score: older as MatchScore }).verdict).toBe(ana.score!.bandLabel);
  });

  it("says beside each score whether the AI interview is in it, so a résumé-only number is never read as an interviewed one (R20-9)", () => {
    const resume = reading([must("rdh", "yes", "RDH"), must("perio", "partially", "some perio")]);
    const waiting = person("d", "Dee", null, { score: matchScore({ resume, screen: null }, packet, { interview: "not_done_yet" }) });
    const interviewed = person("e", "Eli", null, { score: matchScore({ resume, screen: { ...resume, kind: "screen", createdAt: "2026-10-02T10:00:00Z" } }, packet) });
    expect(scoreSummary(waiting).basis).toBe("Résumé only: AI interview not done yet");
    expect(scoreSummary(interviewed).basis).toBe("From the résumé and the AI interview");
    // the same number either way: only the label differs
    expect(waiting.score!.score).toBe(matchScore({ resume, screen: null }, packet)!.score);
  });

  it("puts final numbers first under 'Highest score first', then anyone whose AI interview is still coming, as Sort: Score does", () => {
    // Kit: a résumé that shows everything, her AI interview still to come; Ivo: interviewed, one skill against him
    const all = reading([must("rdh", "yes", "RDH"), must("perio", "yes", "daily perio")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "x"), skill("software", "evidenced", "x")]);
    const kit = person("k", "Kit", null, { score: matchScore({ resume: all, screen: null }, packet, { interview: "not_done_yet" }) });
    const scorecard: ScoredReading = { ...all, kind: "screen", createdAt: "2026-10-02T10:00:00Z", result: { requirementFindings: all.result.requirementFindings, competencyFindings: [skill("chairside", "contradicted", "I rush"), skill("patients", "evidenced", "x"), skill("software", "evidenced", "x")] } };
    const ivo = person("i", "Ivo", null, { score: matchScore({ resume: all, screen: scorecard }, packet) });
    expect(kit.score!.score).toBeGreaterThan(ivo.score!.score!);
    expect(ivo.score!.interview).toBe("done");
    expect(orderCandidates([kit, cy, ivo], "score").map((c) => c.name)).toEqual(["Ivo", "Kit", "Cy"]);
    // a link that closed unsent is a final number: it ranks by itself, with the interviewed, not below them
    const closed = person("l", "Lia", null, { score: matchScore({ resume: all, screen: null }, packet, { interview: "not_done" }) });
    expect(orderCandidates([ivo, closed], "score").map((c) => c.name)).toEqual(["Lia", "Ivo"]);
    // within each kind, the highest first; an older answer that does not say counts as final
    const { interview: _left, basis: _out, ...olderScore } = ivo.score!;
    const older = person("o", "Ola", null, { score: { ...olderScore, score: 70 } as MatchScore });
    expect(orderCandidates([kit, older, ivo], "score").map((c) => c.name)).toEqual(["Ivo", "Ola", "Kit"]);
    expect(orderCandidates([ben, ana], "score").map((c) => c.name)).toEqual(["Ana", "Ben"]);
    // the line says why a lower number can come first, only when both kinds are compared
    expect(mixedScores([kit, ivo])).toBe(true);
    expect(mixedScores([closed, ivo])).toBe(false);
    expect(mixedScores([ana, ben, cy])).toBe(false);
    expect(orderLine(2, true)).toBe("2 people, the highest match score first, anyone whose AI interview is still coming after them. A score helps you read; it never decides.");
  });

  it("shows, per requirement, what was found, how much was met and the points it cost", () => {
    const perio = criterionCell(ana, "perio", true);
    expect(perio).toMatchObject({ state: "judged", words: "Partly shown", pctMet: 50, mustHave: true, quote: "some perio" });
    if (perio.state === "judged") expect(cellFigures(perio)).toBe(`50% met · ${perio.pointsLost} points lost`);
    const rdh = criterionCell(ana, "rdh", true);
    if (rdh.state === "judged") expect(cellFigures(rdh)).toBe("100% met · full marks");
    expect(criterionCell(ana, "software", false)).toMatchObject({ state: "judged", words: "Goes against it", pctMet: 0 });
    // a skill the evidence says nothing about earns nothing so far, and the cell says so, never as a no
    expect(criterionCell(ana, "patients", false)).toEqual({ state: "unknown", words: "Not known yet, no points so far" });
  });

  it("falls back to the finding's words when there is no score to read it from, and says when there is nothing", () => {
    expect(criterionCell(cy, "rdh", true)).toEqual({ state: "raw", words: "Shown", quote: "RDH" });
    expect(criterionCell(cy, "perio", true)).toEqual({ state: "none", words: "No evidence yet" });
  });

  it("tags each skill row by how much it counts, from whichever column's score knows it", () => {
    expect(skillTag([cy, ana], "chairside")).toBe("Essential");
    expect(skillTag([cy, ana], "patients")).toBe("Important");
    expect(skillTag([cy], "patients")).toBeNull();
  });

  it("names the people read against an earlier version of the role (plan F4)", () => {
    const old = person("d", "Dee", null, { readingVersion: { readAgainst: 1, current: 2, label: "Read against version 1 of the role; the role is now on version 2." } });
    expect(versionNotes([ana, old])).toEqual(["Dee: Read against version 1 of the role; the role is now on version 2."]);
  });

  it("lets five people be ticked at most", () => {
    let picked: string[] = [];
    for (const id of ["1", "2", "3", "4", "5", "6"]) picked = togglePick(picked, id, true);
    expect(picked).toEqual(["1", "2", "3", "4", "5"]);
    expect(picked.length).toBe(COMPARE_MAX);
    expect(togglePick(picked, "3", false)).toEqual(["1", "2", "4", "5"]);
    expect(togglePick(["1"], "1", true)).toEqual(["1"]);
  });
});
