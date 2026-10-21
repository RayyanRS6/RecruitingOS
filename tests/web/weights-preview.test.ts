import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, MatchScore } from "@ros/contracts";
import type { BoardCard, BoardView, RolePacket } from "../../apps/web/src/api/client";
import { canTryWeights } from "../../apps/web/src/roles";
import { READ_FROM_NOW_ON } from "../../apps/web/src/skills-form";
import { INTERVIEW_ONLY_LINE, LEAVE_OUT_HINT, LEVEL_WEIGHT, PREVIEW_LABEL, USE_WEIGHTS_LINE, WEIGHT_LEVEL_LABEL, changeWords, changedRows, focusFor, jobLevels, movedWords, placeWords, previewOrder, previewStatus, scoreWords, unscoredWords, weightFieldId, weightRows } from "../../apps/web/src/weights-preview";
import { matchScore, type ScoredReading } from "../../packages/core/src/match-score";

/**
 * "Try different weights" (founder decision L-07 A, preview only): the rows to weigh, the order the weights give, the
 * words around it and who may open it. The scores come from the real function in packages/core, so the preview is
 * checked against what GET /roles/:id/board sends.
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
    { key: "manner", name: "Chairside manner", definition: "d", weight: 5, evaluatedIn: "interview", indicators: ["x"] },
  ],
} as unknown as RolePacket;

type Req = EvidenceAssessment["requirementFindings"][number];
type Comp = EvidenceAssessment["competencyFindings"][number];
const must = (key: string, met: Req["met"], quote?: string): Req => ({ requirementKey: key, met, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const skill = (key: string, finding: Comp["finding"], quote?: string): Comp => ({ competencyKey: key, finding, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });
const reading = (requirementFindings: Req[], competencyFindings: Comp[] = []): ScoredReading => ({ kind: "triage", confidence: "medium", packetVersion: 2, createdAt: "2026-10-01T10:00:00Z", result: { requirementFindings, competencyFindings, confidence: "medium" } });
const scoreOf = (r: ScoredReading, role: unknown = packet) => matchScore({ resume: r, screen: null }, role as Parameters<typeof matchScore>[1])!;

const yes = [must("rdh_license", "yes", "RDH license CA active"), must("perio", "yes", "Perio charting daily")];
// 100: everything shown
const ada = scoreOf(reading(yes, [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")]));
// 79: chairside (Essential) goes against her
const fay = scoreOf(reading(yes, [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")]));
// 86: patient care (Important) goes against him
const gus = scoreOf(reading(yes, [skill("chairside", "evidenced", "x"), skill("patients", "contradicted", "I avoid patients"), skill("software", "evidenced", "z")]));
// 54: the licence shown not met in her own words holds the score
const cy = scoreOf(reading([must("rdh_license", "no", "My RDH license lapsed in 2021"), must("perio", "yes", "perio")], [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")]));
// 43: perio partly shown, every skill going against him
const ben = scoreOf(reading([must("rdh_license", "yes", "RDH license"), must("perio", "partially", "some perio")], [skill("chairside", "contradicted", "I never work chairside"), skill("patients", "contradicted", "I avoid patients"), skill("software", "contradicted", "never used dental software")]));

const card = (applicationId: string, name: string, score: MatchScore | null, over: Record<string, unknown> = {}): BoardCard => ({ applicationId, name, ownerStage: "new", ownerStageLabel: "New", score, readingVersion: null, ...over }) as unknown as BoardCard;
const boardOf = (cards: BoardCard[], noAiInterview: BoardCard[] = []): Pick<BoardView, "columns" | "noAiInterview"> => ({ columns: { shortlist: cards.slice(0, 1), longlist: cards.slice(1, 3), not_moving_forward: cards.slice(3) }, noAiInterview });
const pool = boardOf([card("a1", "Ada Pool", ada), card("a2", "Fay Pool", fay), card("a3", "Gus Pool", gus), card("a4", "Cy Pool", cy), card("a5", "Ben Pool", ben)]);
const rows = weightRows(packet);
const at = (changes: Record<string, string>) => ({ ...jobLevels(rows), ...changes }) as ReturnType<typeof jobLevels>;

describe("the rows to weigh", () => {
  it("lists the must-haves first with two choices, then the scored skills with four; a skill checked only in your own interviews is left out", () => {
    expect(rows.map((r) => [r.id, r.label, r.level, r.choices.length])).toEqual([
      ["m:rdh_license", "Active CA RDH license", "must_have", 2],
      ["m:perio", "Perio charting experience", "must_have", 2],
      ["s:chairside", "Chairside skill", "essential", 4],
      ["s:patients", "Patient care", "important", 4],
      ["s:software", "Dental software", "helpful", 4],
    ]);
    expect(rows[0].choices.map((c) => WEIGHT_LEVEL_LABEL[c])).toEqual(["Must-have", "Leave out of the score"]);
    expect(rows[2].choices.map((c) => WEIGHT_LEVEL_LABEL[c])).toEqual(["Essential", "Important", "Helpful", "Leave out of the score"]);
    expect(rows.map((r) => r.key)).not.toContain("manner");
    // "your own" interviews (R20-9), so it is never read as "the AI interview does not count"
    expect(INTERVIEW_ONLY_LINE).toMatch(/only in your own interviews/);
    expect(LEAVE_OUT_HINT).toMatch(/only in your own interviews/);
    // the real score's own weights; left out counts nothing
    expect(LEVEL_WEIGHT).toEqual({ must_have: 4, essential: 3, important: 2, helpful: 1, off: 0 });
  });

  it("keeps a must-have and a skill with the same key apart", () => {
    const twin = { requirements: { mustHaves: [{ key: "perio", text: "Perio charting experience" }] }, competencies: [{ key: "perio", name: "Perio skill", weight: 3, evaluatedIn: "both" }] } as unknown as RolePacket;
    const both = weightRows(twin);
    expect(both.map((r) => r.id)).toEqual(["m:perio", "s:perio"]);
    expect(both.map(weightFieldId)).toEqual(["weights-m-perio", "weights-s-perio"]);
    expect(changedRows(both, { "m:perio": "must_have", "s:perio": "helpful" }).map((r) => r.id)).toEqual(["s:perio"]);
  });
});

describe("the order the weights give", () => {
  it("with the job's own weights, gives everyone their real score and the order of today", () => {
    expect([ada, fay, gus, cy, ben].map((m) => m.score)).toEqual([100, 79, 86, 54, 43]);
    const order = previewOrder(pool, rows, jobLevels(rows));
    expect(order.rows.map((p) => [p.name, p.rank, p.now, p.preview, p.moved])).toEqual([["Ada Pool", 1, 100, 100, 0], ["Gus Pool", 2, 86, 86, 0], ["Fay Pool", 3, 79, 79, 0], ["Cy Pool", 4, 54, 54, 0], ["Ben Pool", 5, 43, 43, 0]]);
    expect(order).toMatchObject({ moved: 0, unscored: 0 });
    expect(order.rows[0]).toMatchObject({ applicationId: "a1", place: "New", readAgainst: null, resumeOnly: true });
    expect(previewStatus(changedRows(rows, jobLevels(rows)).length, order)).toBe("These are the job's own weights: this is the order today.");
  });

  it("re-orders two people when chairside counts Helpful instead of Essential, and says how far each moved", () => {
    const levels = at({ "s:chairside": "helpful" });
    const order = previewOrder(pool, rows, levels);
    expect(order.rows.map((p) => [p.name, p.preview, p.now, p.moved])).toEqual([["Ada Pool", 100, 100, 0], ["Fay Pool", 92, 79, 1], ["Gus Pool", 83, 86, -1], ["Cy Pool", 54, 54, 0], ["Ben Pool", 50, 43, 0]]);
    expect(order.rows.map((p) => movedWords(p.moved))).toEqual(["", "Up 1 place", "Down 1 place", "", ""]);
    expect(order.moved).toBe(2);
    expect(previewStatus(changedRows(rows, levels).length, order)).toBe("With these weights, 2 people change place.");
    expect(scoreWords(order.rows[1])).toBe("Preview 92 · now 79");
    // the real scores are untouched
    expect([fay.score, gus.score]).toEqual([79, 86]);
  });

  it("lifts a held score when the must-have shown not met is left out", () => {
    const order = previewOrder(pool, rows, at({ "m:rdh_license": "off" }));
    const cyRow = order.rows.find((p) => p.name === "Cy Pool")!;
    expect(cyRow).toMatchObject({ now: 54, preview: 100, rank: 2, moved: 2 });
    expect(movedWords(cyRow.moved)).toBe("Up 2 places");
    expect(previewStatus(1, order)).toBe(`With these weights, ${order.moved} people change place.`);
  });

  it("keeps a reading from an earlier version on that version's weights, and names the version", () => {
    // version 1 had a radiography must-have (gone since) and counted chairside Helpful (it is Essential now)
    const v1 = { requirements: { mustHaves: [{ key: "xray", text: "Radiography certificate", rationale: "r", evidencedBy: ["resume"] }, packet.requirements.mustHaves[0]] }, competencies: [{ ...packet.competencies[0], weight: 1 }] };
    const old = scoreOf(reading([must("xray", "yes", "Radiography certificate, 2019"), must("rdh_license", "yes", "RDH license CA active")], [skill("chairside", "contradicted", "I never work chairside")]), v1);
    // must-haves 4 + 4 met, chairside (Helpful then, 1) against him: 8 of 9
    expect(old.score).toBe(89);
    const board = boardOf([card("a1", "Ada Pool", ada), card("a6", "Hal Pool", old, { readingVersion: { readAgainst: 1, current: 2, label: "Read against version 1 of the role; the role is now on version 2." } })]);
    const hal = (levels: ReturnType<typeof jobLevels>) => previewOrder(board, rows, levels).rows.find((p) => p.name === "Hal Pool");
    // the job's own weights give his real score back, though chairside counts Essential on the job today
    expect(hal(jobLevels(rows))).toMatchObject({ preview: 89, now: 89, moved: 0, readAgainst: 1 });
    // the radiography must-have keeps its own weight (4 against chairside's 1): with the licence left out, 4 of 5
    expect(hal(at({ "m:rdh_license": "off" }))).toMatchObject({ preview: 80 });
    // a change to a requirement he was read against applies to him too: chairside left out
    expect(hal(at({ "s:chairside": "off" }))).toMatchObject({ preview: 100 });
  });

  it("counts the people with no score apart, takes in those without an AI interview yet, and breaks a tie by name", () => {
    const nothing = scoreOf(reading([must("rdh_license", "unknown")]));
    expect(nothing.score).toBeNull();
    const board = boardOf([card("z1", "Zed Pool", gus), card("b1", "Abe Pool", gus), card("n1", "Nia Pool", null), card("n2", "Noa Pool", nothing)], [card("s1", "Sam Pool", ada)]);
    const order = previewOrder(board, rows, jobLevels(rows));
    expect(order.rows.map((p) => [p.name, p.rank])).toEqual([["Sam Pool", 1], ["Abe Pool", 2], ["Zed Pool", 3]]);
    expect(order.unscored).toBe(2);
    expect(unscoredWords(order.unscored)).toBe("2 people have no match score yet, so they are not in this order.");
    expect(unscoredWords(1)).toBe("1 person has no match score yet, so they are not in this order.");
    expect(unscoredWords(0)).toBe("");
  });

  it("marks a score with no AI interview in it yet 'résumé only' on its row; the number and the order are unchanged (R20-9)", () => {
    const resume = reading(yes, [skill("chairside", "evidenced", "x"), skill("patients", "evidenced", "y"), skill("software", "evidenced", "z")]);
    const waiting = matchScore({ resume, screen: null }, packet as unknown as Parameters<typeof matchScore>[1], { interview: "not_done_yet" })!;
    const interviewed = matchScore({ resume, screen: { ...resume, kind: "screen", createdAt: "2026-10-02T10:00:00Z" } }, packet as unknown as Parameters<typeof matchScore>[1])!;
    const board = boardOf([card("i1", "Ivy Pool", interviewed), card("w1", "Wes Pool", waiting, { ownerStageLabel: "Invited (not started)" })]);
    const order = previewOrder(board, rows, jobLevels(rows));
    const of = (name: string) => order.rows.find((p) => p.name === name)!;
    expect(of("Ivy Pool")).toMatchObject({ resumeOnly: false, now: 100 });
    expect(of("Wes Pool")).toMatchObject({ resumeOnly: true, now: 100, preview: 100 });
    expect(placeWords(of("Wes Pool"))).toBe("Invited (not started) · résumé only");
    expect(placeWords(of("Ivy Pool"))).toBe("New");
    expect(placeWords({ place: "New", resumeOnly: true, readAgainst: 1 })).toBe("New · résumé only · Read against version 1");
    // an older answer without the label is not marked
    expect(previewOrder(boardOf([card("o1", "Oz Pool", { ...ada, interview: undefined } as unknown as MatchScore)]), rows, jobLevels(rows)).rows[0]!.resumeOnly).toBe(false);
  });

  it("puts a person whose every judged requirement is left out last, with no preview number", () => {
    const order = previewOrder(boardOf([card("a1", "Ada Pool", ada)]), rows, Object.fromEntries(rows.map((r) => [r.id, "off" as const])));
    expect(order.rows[0]).toMatchObject({ preview: null, now: 100 });
    expect(scoreWords(order.rows[0])).toBe("No score with these weights · now 100");
  });
});

describe("the words around the preview", () => {
  it("says each change, and opens the editor where it changed", () => {
    const levels = at({ "s:chairside": "helpful", "m:perio": "off" });
    expect(changeWords(rows, levels)).toEqual(["Perio charting experience: from Must-have to left out of the score", "Chairside skill: from Essential to Helpful"]);
    expect(focusFor(rows, levels)).toBe("skills");
    expect(focusFor(rows, at({ "m:perio": "off" }))).toBe("must-haves");
    expect(changeWords(rows, jobLevels(rows))).toEqual([]);
  });

  it("says where the order stands, one person or many", () => {
    expect(previewStatus(1, { moved: 0 })).toBe("With these weights, nobody changes place.");
    expect(previewStatus(1, { moved: 1 })).toBe("With these weights, 1 person changes place.");
    expect(previewStatus(0, { moved: 3 })).toBe("These are the job's own weights: this is the order today.");
    expect([2, 1, 0, -1, -3].map(movedWords)).toEqual(["Up 2 places", "Up 1 place", "", "Down 1 place", "Down 3 places"]);
  });

  it("says nothing is saved, and that saving in the editor counts for people read from now on", () => {
    expect(PREVIEW_LABEL).toBe("Preview — nothing is saved; candidates and the team never see these numbers.");
    expect(USE_WEIGHTS_LINE).toContain(READ_FROM_NOW_ON);
    expect(USE_WEIGHTS_LINE).toMatch(/^"Use these weights" opens the job's editor; saving there makes a new version of the job\./);
  });
});

describe("who may try different weights (roles.ts canTryWeights)", () => {
  it("is whoever may edit the job and read its applicants, never on a grant about one candidate", () => {
    expect(["owner", "admin", "hiring_manager", "recruiter", "hr", "interviewer", null, undefined].map((r) => canTryWeights(r))).toEqual([true, true, true, true, false, false, false, false]);
    expect(canTryWeights("recruiter", { applicationId: "app-1" })).toBe(false);
    expect(canTryWeights("recruiter", { applicationId: null })).toBe(true);
    expect(canTryWeights("owner", null)).toBe(true);
  });
});
