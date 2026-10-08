import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, RolePacket } from "@ros/contracts";
import { COMPARE_MAX, cellFigures, criterionCell, orderCandidates, orderLine, scoreSummary, skillTag, togglePick, versionNotes, type CompareCandidateView } from "../../apps/web/src/pages/compare/compare-view";
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
    expect(orderLine("chosen", 3)).toBe("3 people, in the order you chose them.");
    expect(orderLine("score", 1)).toMatch(/^1 person, the highest match score first\. A score helps you read; it never decides\.$/);
  });

  it("tops each column with the score, its band, what it rests on and any missing must-have", () => {
    expect(scoreSummary(ana)).toMatchObject({ score: ana.score!.score, band: ana.score!.bandLabel, coverage: "Based on 4 of 5 requirements" });
    // two must-haves judged, one shown missing by their own words: half the points, already under the cap of 54
    expect(scoreSummary(ben)).toMatchObject({ score: 50, missing: ["Missing must-have: Active CA RDH license"] });
    expect(scoreSummary(cy)).toEqual({ score: null, band: null, coverage: "No reading yet", missing: [] });
  });

  it("shows, per requirement, what was found, how much was met and the points it cost", () => {
    const perio = criterionCell(ana, "perio", true);
    expect(perio).toMatchObject({ state: "judged", words: "Partly shown", pctMet: 50, mustHave: true, quote: "some perio" });
    if (perio.state === "judged") expect(cellFigures(perio)).toBe(`50% met · ${perio.pointsLost} points lost`);
    const rdh = criterionCell(ana, "rdh", true);
    if (rdh.state === "judged") expect(cellFigures(rdh)).toBe("100% met · full marks");
    expect(criterionCell(ana, "software", false)).toMatchObject({ state: "judged", words: "Goes against it", pctMet: 0 });
    // a skill the evidence says nothing about is left out of the score, and the cell says so
    expect(criterionCell(ana, "patients", false)).toEqual({ state: "unknown", words: "Not known yet, left out of the score" });
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
