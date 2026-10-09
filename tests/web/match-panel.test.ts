import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, RolePacket } from "@ros/contracts";
import type { ApplicationDetail } from "../../apps/web/src/api/client";
import { MATCH_PROMISE, cappedLine, competencyChip, confidenceChip, coverageLine, criterionTag, importanceTag, leftOut, matchBars, matchCardState, missingMustHaves, mustHaveLineOf, orderCompetencyFindings, orderRequirementFindings, quoteSummary, requirementChip, suggestedStepOf, versionNote } from "../../apps/web/src/pages/candidate-panel/match-view";
import { MATCH_SCORE_PROMISE, matchScore, type ScoredReading } from "../../packages/core/src/match-score";

/**
 * "Against your must-haves" on the candidate panel (founder decision B2; docs/spec/22 section 5): the words around the
 * score the API worked out, the bars costliest first with "N more at full marks", the red chip for a missing must-have,
 * what was left out, the version label (plan F4), and the evidence listed most serious first (plan F2). The scores here
 * come from the real function in packages/core, so the panel is tested against what the API sends.
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
const must = (key: string, met: Req["met"], quote?: string): Req => ({ requirementKey: key, met, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const skill = (key: string, finding: Comp["finding"], quote?: string): Comp => ({ competencyKey: key, finding, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const reading = (kind: "triage" | "screen", requirementFindings: Req[], competencyFindings: Comp[] = [], over: Partial<ScoredReading> = {}): ScoredReading => ({ kind, confidence: "medium", packetVersion: 1, createdAt: "2026-10-01T10:00:00Z", result: { requirementFindings, competencyFindings, confidence: "medium" }, ...over });
const score = (resume: ScoredReading | null, screen: ScoredReading | null = null) => matchScore({ resume, screen }, packet)!;

const detail = (over: Record<string, unknown> = {}): ApplicationDetail => ({ assessments: [], packetLabels: { mustHaves: [], competencies: [], questions: [] }, ...over }) as unknown as ApplicationDetail;

describe("the match card", () => {
  it("shows nothing for an answer from before the score existed", () => {
    expect(matchCardState(detail())).toEqual({ kind: "hidden" });
  });

  it("says plainly when there is no reading yet, or when the reading speaks to no requirement", () => {
    expect(matchCardState(detail({ matchScore: null }))).toMatchObject({ kind: "unread", text: expect.stringContaining("usually comes a minute or two") });
    const nothing = score(reading("triage", [must("rdh_license", "unknown")]));
    expect(matchCardState(detail({ matchScore: nothing, assessments: [{}] }))).toMatchObject({ kind: "nothing", text: "Nothing to score yet: the application does not speak to any requirement either way." });
  });

  it("shows the number the API worked out, with what it rests on and where it came from", () => {
    const m = score(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "partially_evidenced", "assisted"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")]), reading("screen", [must("perio", "partially", "I chart sometimes")], [], { createdAt: "2026-10-02T10:00:00Z" }));
    expect(matchCardState(detail({ matchScore: m }))).toMatchObject({ kind: "scored", score: m.score });
    expect(coverageLine(m)).toBe("Based on all 5 requirements, from the résumé reading and the screening conversation.");
    expect(coverageLine(score(reading("triage", [must("rdh_license", "yes", "RDH")])))).toBe("Based on 1 of 5 requirements, from the résumé reading.");
  });

  it("shows the must-have line and the step the board suggests, as on their board card", () => {
    expect(mustHaveLineOf(detail({ mustHaves: { total: 2, shown: 1, partly: 0, notShown: 0, unknown: 1, gaps: [], words: "Must-haves: 1 of 2 shown, 1 not yet known" } }))).toBe("Must-haves: 1 of 2 shown, 1 not yet known");
    expect(mustHaveLineOf(detail({ mustHaves: { total: 0, shown: 0, partly: 0, notShown: 0, unknown: 0, gaps: [], words: "This role lists no must-haves." } }))).toBeNull();
    expect(mustHaveLineOf(detail())).toBeNull();
    const placement = { column: "longlist", state: "suggested", doneLabel: null, confident: true, needsYourEye: null, reason: "Match score 62.", nextStep: { kind: "keep_as_backup", label: "Keep as backup", reason: "Match score 62." }, suggestedAction: "longlist", declineReason: null };
    expect(suggestedStepOf(detail({ placement }))).toEqual({ label: "Keep as backup", reason: "Match score 62.", needsYourEye: false });
    expect(suggestedStepOf(detail({ placement: { ...placement, confident: false, needsYourEye: "Their screening conversation is still open.", nextStep: { kind: "ask_more", label: "Ask for more detail", reason: "x" } } }))).toEqual({ label: "Ask for more detail", reason: "Their screening conversation is still open.", needsYourEye: true });
    // once a person has sorted or decided, nothing is suggested
    expect(suggestedStepOf(detail({ placement: { ...placement, state: "done", nextStep: null } }))).toBeNull();
    expect(suggestedStepOf(detail())).toBeNull();
  });

  it("keeps the confidence apart from the score, and asks for a closer read when it is low", () => {
    expect(confidenceChip("high")).toMatchObject({ label: "High confidence", tone: "neutral" });
    expect(confidenceChip("low")).toMatchObject({ label: "Low confidence", tone: "caution", title: expect.stringContaining("Read the evidence yourself") });
    expect(confidenceChip(null)).toBeNull();
  });

  it("lists the requirements that cost points first, costliest first, and folds the rest under 'N more at full marks'", () => {
    const m = score(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "partially_evidenced", "assisted"), skill("patients", "evidenced", "calm"), skill("software", "contradicted", "never used dental software")]));
    const bars = matchBars(m);
    expect(bars.costly.map((b) => [b.label, b.tag, b.pctMet, b.pointsLost])).toEqual([["Perio charting experience", "Must-have", 50, 14], ["Chairside skill", "Essential", 50, 11], ["Dental software", "Helpful", 0, 7]]);
    expect(bars.full.map((b) => b.label)).toEqual(["Active CA RDH license", "Patient care"]);
    expect(bars.foldedLabel).toBe("2 more at full marks");
    expect(quoteSummary(bars.costly[0])).toBe("Partly shown, from the résumé reading · see their words");
    expect(bars.costly[0].quote).toBe("some perio");
  });

  it("says when everything judged is at full marks, and says 'no quote' when nothing of theirs backs a finding", () => {
    const all = matchBars(score(reading("triage", [must("rdh_license", "yes", "RDH license"), must("perio", "yes")])));
    expect(all.costly).toEqual([]);
    expect(all.foldedLabel).toBe("All 2 at full marks");
    expect(quoteSummary(all.full.find((b) => b.key === "perio")!)).toBe("Shown, from the résumé reading · no quote");
    expect(matchBars(score(reading("triage", [must("rdh_license", "yes", "RDH")]))).foldedLabel).toBe("1 requirement at full marks");
    expect(matchBars(score(reading("triage", [must("perio", "partially", "some")]))).foldedLabel).toBeNull();
  });

  it("names a must-have their own words show is missing, with the quote, and says why the score is held down", () => {
    const m = score(reading("triage", [must("rdh_license", "no", "My license lapsed in 2022"), must("perio", "yes", "perio daily")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")]));
    expect(m.score).toBe(54);
    expect(missingMustHaves(m)).toEqual([{ key: "rdh_license", chip: "Missing must-have: Active CA RDH license", quote: "My license lapsed in 2022" }]);
    expect(cappedLine(m)).toBe("A must-have their own words show is not met holds the score at 54 at most.");
    expect(cappedLine(score(reading("triage", [must("perio", "yes", "perio")])))).toBeNull();
  });

  it("lists what the evidence says nothing about apart: left out, never counted against them", () => {
    const out = leftOut(score(reading("triage", [must("rdh_license", "yes", "RDH")], [skill("chairside", "not_evidenced")])))!;
    expect(out.heading).toBe("4 requirements not known yet");
    expect(out.items).toEqual([{ key: "perio", label: "Perio charting experience", tag: "Must-have" }, { key: "chairside", label: "Chairside skill", tag: "Essential" }, { key: "patients", label: "Patient care", tag: "Important" }, { key: "software", label: "Dental software", tag: "Helpful" }]);
    expect(out.note).toMatch(/never counted against them/);
    expect(leftOut(score(reading("triage", [must("rdh_license", "yes", "a"), must("perio", "yes", "b")], [skill("chairside", "evidenced", "c"), skill("patients", "evidenced", "d"), skill("software", "evidenced", "e")])))).toBeNull();
  });

  it("labels the version of the role the reading was made against (plan F4)", () => {
    const m = score(reading("triage", [must("perio", "yes", "perio")]));
    expect(versionNote(detail({ matchScore: m }), m)).toEqual({ text: "Read against version 1 of the role, the current one.", changed: false });
    const older = detail({ matchScore: m, readingVersion: { readAgainst: 1, current: 3, label: "Read against version 1 of the role; the role is now on version 3." } });
    expect(versionNote(older, m)).toEqual({ text: "Read against version 1 of the role; the role is now on version 3. The score uses the requirements as they were then.", changed: true });
    expect(versionNote(detail(), null)).toBeNull();
  });

  it("explains the score in the same words as the core promise", () => {
    expect(MATCH_PROMISE).toBe(MATCH_SCORE_PROMISE);
  });

  it("tags a skill by how much it counts and a must-have as a must-have", () => {
    expect(criterionTag({ mustHave: true, importance: null })).toBe("Must-have");
    expect(criterionTag({ mustHave: false, importance: "important" })).toBe("Important");
    expect(criterionTag({ mustHave: false, importance: null })).toBe("Skill");
    const skills = [{ key: "a", name: "A", importance: "essential" as const }, { key: "b", name: "B" }];
    expect(importanceTag(skills, "a")).toBe("Essential");
    expect(importanceTag(skills, "b")).toBeNull();
  });
});

describe("the evidence, most serious first (plan F2)", () => {
  const mustHaves = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }, { key: "e" }];

  it("puts a must-have shown not met first, then partly, then an unquoted 'no', then not known, then shown; equals keep the role's order", () => {
    const findings = [must("a", "yes", "q"), must("b", "unknown"), must("c", "no"), must("d", "partially", "q"), must("e", "no", "I do not have it")];
    expect(orderRequirementFindings(findings, mustHaves).map((f) => f.requirementKey)).toEqual(["e", "d", "c", "b", "a"]);
    const ties = [must("c", "yes", "q"), must("a", "yes", "q")];
    expect(orderRequirementFindings(ties, mustHaves).map((f) => f.requirementKey)).toEqual(["a", "c"]);
  });

  it("puts a skill that goes against them first, then by importance: Essential, Important, Helpful", () => {
    const skills = [{ key: "h", name: "H", importance: "helpful" as const }, { key: "e", name: "E", importance: "essential" as const }, { key: "i", name: "I", importance: "important" as const }];
    const findings = [skill("h", "partially_evidenced", "q"), skill("e", "evidenced", "q"), skill("i", "partially_evidenced", "q"), skill("e", "contradicted", "never")];
    expect(orderCompetencyFindings(findings, skills).map((f) => `${f.competencyKey}:${f.finding}`)).toEqual(["e:contradicted", "i:partially_evidenced", "h:partially_evidenced", "e:evidenced"]);
  });

  it("is red only for a must-have their own words show is missing; an unquoted 'no' is counted as not known and says so", () => {
    expect(requirementChip(must("a", "no", "I never did"))).toEqual({ words: "Not met", tone: "critical" });
    expect(requirementChip(must("a", "no"))).toEqual({ words: "Not met, but nothing quoted: counted as not known", tone: "neutral" });
    expect(requirementChip(must("a", "partially", "q"))).toEqual({ words: "Partly shown", tone: "caution" });
    expect(requirementChip(must("a", "yes", "q"))).toEqual({ words: "Shown", tone: "good" });
    expect(requirementChip(must("a", "unknown"))).toEqual({ words: "Not known yet", tone: "neutral" });
    expect(competencyChip(skill("s", "contradicted", "never"))).toEqual({ words: "Goes against it", tone: "neutral" });
    expect(competencyChip(skill("s", "contradicted"))).toMatchObject({ words: expect.stringContaining("counted as not known") });
    expect(competencyChip(skill("s", "not_evidenced"))).toEqual({ words: "Not shown yet", tone: "neutral" });
  });
});

describe("the panel's wiring", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("puts the match card on the Overview and keeps the score in the panel's header on every section", () => {
    expect(read("../../apps/web/src/pages/candidate-panel/sections.tsx")).toContain("<MatchCard a={a} />");
    const panel = read("../../apps/web/src/pages/candidate-panel/CandidatePanel.tsx");
    expect(panel).toContain("const score = a ? matchOf(a)?.score ?? null : null;");
    expect(panel).toContain('<ScoreBadge score={score} size="sm" />');
  });

  it("lists each reading's must-haves and skills most serious first, skills with their quotes, notes and importance", () => {
    const card = read("../../apps/web/src/pages/candidate-panel/assessment.tsx");
    expect(card).toContain("orderRequirementFindings(result.requirementFindings, labels.mustHaves)");
    expect(card).toContain("orderCompetencyFindings(result.competencyFindings, skills)");
    expect(card).toContain('{c.evidence?.quote ? <span className="small muted"> "{c.evidence.quote}"</span>');
    expect(card).toContain("{c.note ?");
    // "Something wrong?" reaches an ITS recruiter now (plan F11): the toast says what the API did, not a promise
    expect(card).toContain('toast(r.message ?? "Flagged and recorded.", "Nothing changes for the candidate.")');
    expect(card).not.toContain("improve the system");
    // choosing a kind asks first, saying what the recruiter will see and for how long; only an ITS recruiter's own flag goes at once
    expect(card).toContain('title="Ask an ITS recruiter to check this reading?"');
    expect(card).toContain("const choose = (k: string) => { if (staff) flag.mutate(k); else setKind(k); };");
    // a menu, not a dropdown: an arrow key only moves through the kinds; Enter or a click chooses (WCAG 3.2.2)
    expect(card).toContain('<Menu label="Something wrong?" ariaLabel="Something wrong with this assessment?"');
    expect(card).not.toContain("<select");
    expect(card).toContain(`export const FLAG_SHARE = \`This asks an ITS recruiter to check the reading. Once they pick it up they see \${accessWords("application")}. \${ACCESS_LIMITS}\`;`);
  });

  it("shows the bars costliest first with the full marks folded, and the confidence chip apart from the score", () => {
    const match = read("../../apps/web/src/pages/candidate-panel/match.tsx");
    expect(match).toContain("items={bars.costly.map(barItem)} folded={bars.full.map(barItem)}");
    expect(match).toContain('<ScoreBadge score={state.score} size="lg" showBand />');
    expect(match).toContain("<Chip tone={confidence.tone}>{confidence.label}</Chip>");
    expect(match).toContain('<Chip tone="critical" icon="alert">{x.chip}</Chip>');
  });
});
