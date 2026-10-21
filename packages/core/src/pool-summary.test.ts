import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, RolePacket } from "@ros/contracts";
import { boardPlacement } from "./board";
import type { AssessmentLike } from "./evidence";
import { matchScore, mustHaveSummary, type ScoredReading } from "./match-score";
import { PoolQuestionError, answerPoolQuestion, poolQuestions, poolSummary, type PoolPerson } from "./pool-summary";

/**
 * The pool summary and the one-click questions (plan F7, F10): fixed rules over the records, so the same people always
 * give the same words, and every name and number comes from the rows.
 */
const packet = {
  requirements: { mustHaves: [{ key: "license", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] }, { key: "perio", text: "Perio charting", rationale: "work", evidencedBy: ["resume"] }] },
  competencies: [{ key: "chairside", name: "Chairside skill", definition: "d", weight: 3, evaluatedIn: "both", indicators: ["x"] }],
} as unknown as Pick<RolePacket, "requirements" | "competencies">;
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
type Req = EvidenceAssessment["requirementFindings"][number];
const f = (key: string, met: Req["met"], quote?: string): Req => ({ requirementKey: key, met, ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) });

function person(name: string, findings: Req[], over: { daysWaiting?: number; noAiInterview?: boolean; chairside?: "evidenced" | "partially_evidenced" | "not_evidenced"; confidence?: "low" | "medium"; weak?: boolean; stage?: "triaged" | "hired"; packet?: Pick<RolePacket, "requirements" | "competencies"> } = {}): PoolPerson {
  const readAgainst = over.packet ?? packet;
  const reading: ScoredReading = { kind: "triage", confidence: over.confidence ?? "medium", result: { requirementFindings: findings, competencyFindings: [{ competencyKey: "chairside", finding: over.chairside ?? "evidenced", evidence: { source: "resume", quote: "assisted chairside" } }], confidence: over.confidence ?? "medium" } };
  const pair = { resume: reading, screen: null };
  const match = matchScore(pair, readAgainst);
  const mustHaves = mustHaveSummary(pair, readAgainst);
  // A Weak reading suggests holding back, so it agrees with a low score; otherwise the reading suggests a screen.
  const overall = over.weak ? "weak" : "potential";
  const latest: AssessmentLike = { kind: "triage", overall, confidence: over.confidence ?? "medium", result: { overall, confidence: "medium", summary: "s", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: findings, anomalies: [], recommendation: over.weak ? "hold" : "screen", rationale: "r" } };
  const hired = over.stage === "hired";
  const placement = boardPlacement({ stage: over.noAiInterview ? "screen_invited" : over.stage ?? "triaged", base: hired ? "hired" : over.noAiInterview ? "no_ai_interview" : "new", stageLabel: hired ? "Hired" : "Ready for your review", latest, evidence: { needsCloserLook: false, assessmentUnavailable: false, lowConfidence: over.confidence === "low", reason: null }, match, mustHaves });
  return { applicationId: `app-${name.toLowerCase()}`, name, waitingSince: new Date(NOW.getTime() - (over.daysWaiting ?? 1) * DAY).toISOString(), noAiInterview: !!over.noAiInterview, placement, match, mustHaves };
}

const ada = person("Ada Moss", [f("license", "yes", "RDH license CA active"), f("perio", "yes", "Perio charting daily")], { daysWaiting: 2 });
const ben = person("Ben Ortiz", [f("license", "partially", "RDH license pending"), f("perio", "partially", "some perio")], { daysWaiting: 9 });
const cy = person("Cy Park", [f("license", "no", "My RDH license lapsed in 2021"), f("perio", "yes", "perio")], { daysWaiting: 4, weak: true });
const dee = person("Dee Lu", [f("license", "unknown"), f("perio", "unknown")], { daysWaiting: 3, chairside: "not_evidenced" });
const eve = person("Eve Kim", [f("license", "yes", "licensed"), f("perio", "unknown")], { daysWaiting: 1 });
const fay = person("Fay Ng", [f("license", "yes", "a")], { noAiInterview: true });
const people = [ada, ben, cy, dee, eve, fay];

describe("poolSummary", () => {
  it("counts each column, the must-haves across the pool and who waited longest, from the rows alone", () => {
    const s = poolSummary(people, packet, { roleId: "role-1", now: NOW });
    expect(ada.placement.column).toBe("shortlist");
    expect(cy.placement.column).toBe("not_moving_forward");
    expect(s.counts).toEqual({ shortlist: 1, longlist: 3, not_moving_forward: 1 });
    expect(s).toMatchObject({ total: 5, noAiInterview: 1, stillApplying: 1, toSort: 5, done: 0, showEveryMustHave: 1, longestWaiting: { name: "Ben Ortiz", days: 9 } });
    expect(s.mustHaves).toEqual([
      { key: "license", label: "Active CA RDH license", shown: 2, partly: 1, notShown: 1, unknown: 1, total: 5 },
      { key: "perio", label: "Perio charting", shown: 2, partly: 1, notShown: 0, unknown: 2, total: 5 },
    ]);
    // ties go to the first must-have in the role's order
    expect(s.mostMissing).toEqual({ key: "license", label: "Active CA RDH license", notShowing: 2, of: 5 });
    expect(s.sentences).toEqual([
      "5 people on the board. To sort: 1 for the shortlist, 3 for the longlist, 1 not moving forward. 1 more is not on the board yet: no AI interview in their score.",
      "1 of 5 show every must-have.",
      'The must-have shown least often is "Active CA RDH license": 2 of 5 don\'t show it.',
      "Ben Ortiz has waited longest: 9 days.",
    ]);
    expect(s.stricter).toBeNull();
  });

  it("names up to three next steps, the shortlist first, then those who need a person's eye, then those to ask", () => {
    const s = poolSummary(people, packet, { roleId: "role-1", now: NOW });
    expect(s.nextSteps.map((n) => [n.name, n.kind])).toEqual([["Ada Moss", "phone_call"], ["Dee Lu", "ask_more"], ["Eve Kim", "ask_more"]]);
  });

  it("asks gently whether a must-have is stricter than needed when most people do not show it, and never declines anyone", () => {
    const pool = ["A", "B", "C", "D", "E", "F"].map((n, i) => person(`${n} Test`, [f("license", i < 2 ? "yes" : "unknown"), f("perio", "yes", "perio")]));
    const s = poolSummary(pool, packet, { roleId: "role-1", now: NOW });
    expect(s.stricter).toEqual({ key: "license", label: "Active CA RDH license", notShowing: 4, of: 6, words: '"Active CA RDH license" is not shown by 4 of 6 people. If it is stricter than the job needs, you could make it a nice-to-have in a new version of the role. Nobody is turned down because of this note.', editPath: "/roles/role-1?tab=requirements&edit=must-haves" });
    expect(s.sentences.at(-1)).toBe(s.stricter!.words);
  });

  it("counts the people still to sort by column, and never counts someone hired as on the shortlist", () => {
    const hal = person("Hal Webb", [f("license", "yes", "licensed"), f("perio", "yes", "perio")], { stage: "hired" });
    expect(hal.placement).toMatchObject({ column: "shortlist", state: "done" });
    const s = poolSummary([ada, cy, hal], packet, { roleId: "r", now: NOW });
    expect(s.counts).toEqual({ shortlist: 1, longlist: 0, not_moving_forward: 1 });
    expect(s).toMatchObject({ total: 3, done: 1, toSort: 2 });
    expect(s.sentences[0]).toBe("3 people on the board. To sort: 1 for the shortlist, 0 for the longlist, 1 not moving forward. 1 already sorted, moving forward or decided.");
  });

  it("leaves people read before a must-have was added out of its count, so it is not 'not shown' by them", () => {
    // version 1 had only the license; version 2 added perio charting. Six people were read against version 1.
    const v1 = { ...packet, requirements: { ...packet.requirements, mustHaves: [packet.requirements.mustHaves[0]] } } as Pick<RolePacket, "requirements" | "competencies">;
    const early = ["A", "B", "C", "D", "E", "F"].map((n) => person(`${n} Early`, [f("license", "yes", "licensed")], { packet: v1 }));
    const late = person("Gia Late", [f("license", "yes", "licensed"), f("perio", "yes", "perio")]);
    const s = poolSummary([...early, late], packet, { roleId: "r", now: NOW });
    expect(s.mustHaves.find((m) => m.key === "perio")).toEqual({ key: "perio", label: "Perio charting", shown: 1, partly: 0, notShown: 0, unknown: 0, total: 1 });
    expect(s.mustHaves.find((m) => m.key === "license")).toMatchObject({ shown: 7, total: 7 });
    expect(s.mostMissing).toBeNull();
    expect(s.stricter).toBeNull();
  });

  it("is deterministic whatever the order of the people", () => {
    expect(poolSummary([...people].reverse(), packet, { roleId: "r", now: NOW })).toEqual(poolSummary(people, packet, { roleId: "r", now: NOW }));
  });

  it("says so when there is nobody to sort", () => {
    expect(poolSummary([fay], packet, { roleId: "r", now: NOW }).sentences).toEqual(["Nobody to sort yet; 1 person is not on the board yet: no AI interview in their score."]);
    // one neutral line for the whole lane: some there sent theirs and are being scored, so it never says they have none
    const gus = person("Gus Ray", [f("license", "yes", "a")], { noAiInterview: true });
    expect(poolSummary([fay, gus, ada], packet, { roleId: "r", now: NOW }).sentences[0]).toMatch(/ 2 more are not on the board yet: no AI interview in their score\.$/);
  });
});

describe("one-click questions", () => {
  const open = (id: string) => `/roles/role-1/talent?open=${id}`;
  it("offers the questions in plain words, one strongest-evidence question per must-have", () => {
    expect(poolQuestions(packet).map((q) => q.label)).toEqual(["Who is missing a must-have, and why?", 'Strongest evidence for "Active CA RDH license"', 'Strongest evidence for "Perio charting"', "Who might I be overlooking?", "Compare these"]);
  });

  it("answers who is missing a must-have with their own words, and does not count silence as missing", () => {
    const a = answerPoolQuestion("missing_must_have", people, packet, { now: NOW, open });
    expect(a.people.map((p) => [p.name, p.why])).toEqual([["Cy Park", "Missing must-have: Active CA RDH license."]]);
    expect(a.people[0].quotes).toEqual([{ criterion: "Active CA RDH license", quote: "My RDH license lapsed in 2021", source: "resume" }]);
    expect(a.answer).toBe("1 person shows, in their own words, that they do not meet a must-have. 2 more do not say either way; they are not counted as missing.");
    expect(a.applicationIds).toEqual(["app-cy park"]);
    expect(a.lookedAt).toMatchObject({ people: 5, resumeReadings: 5, screenReadings: 0, requirements: ["Active CA RDH license", "Perio charting"] });
    expect(a.lookedAt.words).toContain("No AI was asked anything new");
  });

  it("answers the strongest evidence for a must-have: shown before partly, quoted, then by score", () => {
    const a = answerPoolQuestion("strongest_evidence", people, packet, { mustHaveKey: "perio", now: NOW, open });
    expect(a.people.map((p) => p.name)).toEqual(["Ada Moss", "Cy Park", "Ben Ortiz"]);
    expect(a.people[0].quotes).toEqual([{ criterion: "Perio charting", quote: "Perio charting daily", source: "resume" }]);
    // each person's score comes with whether their AI interview is in it, and the label (R20-9)
    expect(a.people[0]).toMatchObject({ score: ada.match!.score, interview: "none", basis: "Résumé only: no AI interview" });
    expect(a.answer).toBe('2 people show "Perio charting" and 1 more shows it in part.');
    expect(() => answerPoolQuestion("strongest_evidence", people, packet, { mustHaveKey: "nope", now: NOW, open })).toThrow(PoolQuestionError);
  });

  it("answers who might be overlooked: good evidence off the shortlist, or a long wait", () => {
    const a = answerPoolQuestion("overlooked", people, packet, { now: NOW, open });
    expect(a.people.map((p) => p.name)).toEqual(["Ben Ortiz", "Eve Kim"]);
    // Ben shows both must-haves in part: they cost his score nothing (Wave S7), so the board asks for more instead
    expect(a.people[0].why).toBe("Good evidence, but on the Longlist: Their application only partly shows Active CA RDH license, Perio charting. Waiting 9 days with nothing decided.");
    expect(a.people[1].why).toContain("Good evidence, but on the Longlist: A must-have is not yet known: Perio charting.");
  });
});
