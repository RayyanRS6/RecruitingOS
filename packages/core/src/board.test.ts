import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, MatchScore, MustHaveSummary } from "@ros/contracts";
import { boardPlacement, declineReasonFor, type PlacementInput } from "./board";
import type { AssessmentLike } from "./evidence";

/**
 * The board's placement (plan F6): every rule, in our words. Pure over the score and the evidence view, so the board,
 * the list and Review and apply always agree.
 */
const result: EvidenceAssessment = { overall: "potential", confidence: "medium", summary: "s", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], recommendation: "screen", rationale: "r" };
const triage: AssessmentLike = { kind: "triage", overall: "potential", confidence: "medium", result };
/** A résumé reading that itself suggests holding back: it agrees with a low score. */
const holding: AssessmentLike = { kind: "triage", overall: "weak", confidence: "medium", result: { ...result, overall: "weak", recommendation: "hold" } };
const screen: AssessmentLike = { kind: "screen", overall: "strong", confidence: "high", result: { ...result, recommendation: "interview" } as unknown as EvidenceAssessment };

const score = (n: number | null, over: Partial<MatchScore> = {}): MatchScore => ({
  score: n,
  band: n === null ? null : n >= 85 ? "very_high" : n >= 70 ? "high" : n >= 55 ? "medium" : "low",
  bandLabel: null,
  coverage: { known: 4, total: 4, words: "Based on all 4 requirements" },
  breakdown: [{ key: "perio", label: "Perio charting", mustHave: true, importance: null, weightPct: 40, pctMet: 50, pointsLost: n === null ? 0 : 100 - n, finding: "Partly shown", source: "resume", quote: "some perio", unquoted: false }],
  unknown: [],
  fullMarks: 1,
  missingMustHave: [],
  capped: false,
  confidence: "medium",
  basedOn: "resume",
  packetVersion: 1,
  ...over,
});
const musts: MustHaveSummary = { total: 2, shown: 2, partly: 0, notShown: 0, unknown: 0, gaps: [], words: "Must-haves: 2 of 2 shown" };
const quiet = { needsCloserLook: false, assessmentUnavailable: false, lowConfidence: false, reason: null };
const place = (over: Partial<PlacementInput>) => boardPlacement({ stage: "triaged", base: "new", stageLabel: "Ready for your review", latest: triage, evidence: quiet, match: score(80), mustHaves: musts, ...over });

describe("boardPlacement", () => {
  it("puts a high or very high score read with confidence on the Shortlist, ticked, with a next step", () => {
    const p = place({ match: score(80) });
    expect(p).toMatchObject({ column: "shortlist", state: "suggested", confident: true, needsYourEye: null, suggestedAction: "shortlist", declineReason: null });
    expect(p.reason).toBe("Match score 80: Perio charting partly shown.");
    expect(p.nextStep).toMatchObject({ kind: "phone_call", label: "Short phone call" });
    // after the screening conversation, or very high with high confidence: an interview
    expect(place({ match: score(90), latest: screen }).nextStep).toMatchObject({ kind: "interview", label: "Interview" });
    expect(place({ match: score(92, { confidence: "high" }) }).nextStep?.kind).toBe("interview");
  });

  it("puts a medium score on the Longlist, ticked, to keep as backup or to ask for more detail", () => {
    expect(place({ match: score(62) })).toMatchObject({ column: "longlist", confident: true, suggestedAction: "longlist", nextStep: { kind: "keep_as_backup", label: "Keep as backup" } });
    const asking = place({ match: score(62, { unknown: [{ key: "license", label: "Active CA RDH license", mustHave: true, importance: null }] }) });
    expect(asking.nextStep).toMatchObject({ kind: "ask_more", label: "Ask for more detail", reason: "Their application does not say whether they have Active CA RDH license." });
  });

  it("puts a low score, or a must-have shown missing by their own words, under Not moving forward with a reason from their evidence", () => {
    const weak = place({ latest: holding, match: score(40) });
    expect(weak).toMatchObject({ column: "not_moving_forward", confident: true, suggestedAction: "not_moving_forward", nextStep: { kind: "not_moving_forward" } });
    expect(weak.declineReason).toEqual({ reason: "not_a_match_skills", note: "Match score 40/100. Cost the most: Perio charting (partly shown)." });
    const missing = place({ latest: holding, match: score(54, { capped: true, missingMustHave: [{ key: "license", label: "Active CA RDH license", quote: "My license lapsed" }] }) });
    expect(missing).toMatchObject({ column: "not_moving_forward", reason: "Missing must-have: Active CA RDH license." });
    expect(missing.declineReason).toEqual({ reason: "not_a_match_skills", note: 'Missing must-have: Active CA RDH license. Their own words: "My license lapsed"' });
    expect(declineReasonFor(score(30, { missingMustHave: [{ key: "y", label: "Two years of hygiene experience", quote: "six months" }] }))?.reason).toBe("not_a_match_experience");
  });

  it("sends anyone who needs a closer look, read with low confidence, with nothing to score or an unknown must-have to the Longlist, unticked, with the reason", () => {
    const closer = place({ match: score(90), evidence: { ...quiet, needsCloserLook: true, reason: "The reading says Strong match, but..." } });
    expect(closer).toMatchObject({ column: "longlist", confident: false, needsYourEye: "The reading says Strong match, but...", nextStep: { kind: "read_yourself" } });
    expect(place({ match: score(30), evidence: { ...quiet, lowConfidence: true } })).toMatchObject({ column: "longlist", confident: false, needsYourEye: expect.stringContaining("not confident") });
    expect(place({ match: score(null) })).toMatchObject({ column: "longlist", confident: false, needsYourEye: expect.stringContaining("Nothing to score yet") });
    expect(place({ match: score(88, { unknown: [{ key: "license", label: "Active CA RDH license", mustHave: true, importance: null }] }) })).toMatchObject({ column: "longlist", confident: false, needsYourEye: "A must-have is not yet known: Active CA RDH license.", nextStep: { kind: "ask_more" } });
    // a scorecard that left too much open
    expect(place({ latest: { ...screen, overall: "unknown", result: { ...result, recommendation: "hold" } as unknown as EvidenceAssessment } })).toMatchObject({ column: "longlist", confident: false });
  });

  it("never starts a decline ticked on a low score from too little evidence: must-haves not known, or under half the requirements", () => {
    const unknownLicense = { key: "license", label: "Active CA RDH license", mustHave: true, importance: null } as const;
    const thin = place({ latest: holding, match: score(50, { coverage: { known: 1, total: 4, words: "Based on 1 of 4 requirements" }, unknown: [unknownLicense] }) });
    expect(thin).toMatchObject({ column: "longlist", confident: false, suggestedAction: "longlist", declineReason: null, nextStep: { kind: "ask_more", reason: "Their application does not say whether they have Active CA RDH license." } });
    expect(thin.needsYourEye).toBe("A must-have is not yet known: Active CA RDH license. A low score without them is not enough to go on.");
    // every must-have known, but only one of four requirements judged
    const little = place({ latest: holding, match: score(0, { coverage: { known: 1, total: 4, words: "Based on 1 of 4 requirements" } }) });
    expect(little).toMatchObject({ column: "longlist", confident: false, needsYourEye: "Only 1 of 4 requirements could be judged; a low score from so little is not enough to go on." });
    // half the requirements known and every must-have known: the low score stands
    expect(place({ latest: holding, match: score(40, { coverage: { known: 2, total: 4, words: "Based on 2 of 4 requirements" } }) }).column).toBe("not_moving_forward");
    // a must-have shown missing by their own words stands even on little evidence
    expect(place({ latest: holding, match: score(54, { coverage: { known: 1, total: 4, words: "x" }, unknown: [unknownLicense], missingMustHave: [{ key: "perio", label: "Perio charting", quote: "never charted" }] }) })).toMatchObject({ column: "not_moving_forward", confident: true });
  });

  it("asks a person to look when the reading and the score disagree, either way", () => {
    const forward = place({ latest: triage, match: score(40) });
    expect(forward).toMatchObject({ column: "longlist", confident: false, needsYourEye: "The assistant suggested a screening chat, but the score puts them lower. Read before deciding.", nextStep: { kind: "read_yourself", reason: "The AI review and the score disagree; your own read decides." } });
    expect(place({ latest: { ...screen, overall: "potential" }, match: score(40) }).needsYourEye).toContain("suggested an interview");
    const back = place({ latest: holding, match: score(90) });
    expect(back).toMatchObject({ column: "longlist", confident: false, needsYourEye: "The assistant suggested holding back, but the score puts them higher. Read before deciding." });
    const declined = { ...screen, overall: "weak", result: { ...result, recommendation: "decline_recommended" } as unknown as EvidenceAssessment };
    expect(place({ latest: declined, match: score(90) }).needsYourEye).toContain("suggested not moving forward");
    // a medium score is not either end: the Longlist stands, ticked
    expect(place({ latest: triage, match: score(62) })).toMatchObject({ column: "longlist", confident: true });
  });

  it("never starts a decline ticked while the screening conversation is still open, whose answers count most", () => {
    const open = place({ latest: holding, match: score(40), openScreen: true });
    expect(open).toMatchObject({ column: "longlist", confident: false, needsYourEye: "Their screening chat is still open, and its answers count most. Wait for it, or read it yourself before deciding.", nextStep: { kind: "ask_more" } });
    // once the scorecard is the reading, the open-screen rule no longer applies
    const card = { ...screen, overall: "weak", result: { ...result, recommendation: "decline_recommended" } as unknown as EvidenceAssessment };
    expect(place({ latest: card, match: score(40), openScreen: true }).column).toBe("not_moving_forward");
  });

  it("never starts a decline ticked on a reading made against a version of the role whose must-haves have changed since", () => {
    const old = place({ latest: holding, match: score(54, { missingMustHave: [{ key: "license", label: "Active CA RDH license", quote: "lapsed" }] }), readingVersion: { readAgainst: 1, mustHavesChanged: true } });
    expect(old).toMatchObject({ column: "longlist", confident: false, needsYourEye: "Read against version 1 of the role, and the must-haves have changed since. Check them against the role as it is now." });
    // an older version whose must-haves are the same: the decline stands
    expect(place({ latest: holding, match: score(40), readingVersion: { readAgainst: 1, mustHavesChanged: false } }).column).toBe("not_moving_forward");
  });

  it("asks a person to look at an unreadable résumé, a must-have said missing with nothing quoted, or a reading that says too little at a later stage, whatever the score", () => {
    expect(place({ latest: holding, match: score(40), evidence: { ...quiet, resumeUnreadable: true } })).toMatchObject({ column: "longlist", confident: false, needsYourEye: "The résumé could not be read; the written answers were used. Open the file yourself before deciding." });
    // the screening conversation's reading carries the score: the unreadable file matters less
    expect(place({ latest: screen, match: score(90, { basedOn: "screen" }), evidence: { ...quiet, resumeUnreadable: true } }).column).toBe("shortlist");
    const said = place({ latest: holding, match: score(30, { unknown: [{ key: "license", label: "Active CA RDH license", mustHave: true, importance: null, unquotedNo: true }] }) });
    expect(said).toMatchObject({ column: "longlist", confident: false, nextStep: { kind: "read_yourself", reason: "Check for yourself whether they have Active CA RDH license." } });
    expect(said.needsYourEye).toBe("The assistant says Active CA RDH license is not met but quoted nothing from the candidate's own words, so it does not count either way.");
    const unsure = { ...triage, result: { ...result, recommendation: "review_manually" as const } };
    expect(place({ stage: "screen_invited", latest: unsure, match: score(30) })).toMatchObject({ column: "longlist", confident: false, needsYourEye: "The assistant could not say enough from the application to go on." });
  });

  it("holds an eligibility answer for a person, with nothing to apply", () => {
    expect(place({ stage: "ineligible" })).toMatchObject({ column: "longlist", confident: false, suggestedAction: null, nextStep: { kind: "check_eligibility", label: "Check eligibility" } });
  });

  it("with no reading: being read, or unavailable (Longlist, unticked)", () => {
    expect(place({ stage: "received", latest: null, match: null, mustHaves: null })).toMatchObject({ state: "waiting", suggestedAction: null });
    expect(place({ latest: null, match: null, mustHaves: null, evidence: { ...quiet, assessmentUnavailable: true } })).toMatchObject({ column: "longlist", state: "suggested", confident: false, suggestedAction: "longlist", nextStep: { kind: "read_yourself" } });
  });

  it("shows people still applying, already decided, already marked or past this step where they are, as done", () => {
    expect(place({ stillApplying: true })).toMatchObject({ column: null, state: "waiting", doneLabel: "Still applying", suggestedAction: null });
    expect(place({ stage: "rejected", base: "not_moving_forward", stageLabel: "Not moving forward" })).toMatchObject({ column: "not_moving_forward", state: "done", doneLabel: "Not moving forward", suggestedAction: null });
    expect(place({ stage: "interview_scheduled", base: "interviewing" })).toMatchObject({ column: "shortlist", state: "done", doneLabel: "Interviewing" });
    expect(place({ stage: "hired", base: "hired" })).toMatchObject({ column: "shortlist", state: "done", doneLabel: "Hired" });
    expect(place({ mark: { mark: "shortlist" }, match: score(30) })).toMatchObject({ column: "shortlist", state: "done", doneLabel: "Shortlist" });
    expect(place({ mark: { mark: "on_hold", remindAt: "2026-11-01T15:00:00Z" } })).toMatchObject({ column: "longlist", state: "done", doneLabel: "On hold" });
    expect(place({ mark: { mark: "not_a_fit_for_now" } })).toMatchObject({ column: "not_moving_forward", state: "done", doneLabel: "Not a fit for now" });
  });

  it("is deterministic: the same facts always give the same placement", () => {
    const input: PlacementInput = { stage: "triaged", base: "new", stageLabel: "x", latest: triage, evidence: quiet, match: score(66), mustHaves: musts };
    expect(boardPlacement(input)).toEqual(boardPlacement(structuredClone(input)));
  });
});
