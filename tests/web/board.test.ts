import { describe, expect, it } from "vitest";
import type { BoardCard, BoardPlacement, BoardView, MatchScore, PoolSummary } from "../../apps/web/src/api/client";
import {
  ASK_INTRO, ASK_SOON, BOARD_COLUMNS, DECLINE_CHOICES, GROUP_WORDS, NEEDS_EYE_WARNING, NO_DECLINE_HERE, POOL_CARD_NOTE, RECRUITER_CHECK, REVIEW_FOOT, REVIEW_SUB, SORT_TEXT,
  answerPath, appliedToast, applyLabel, batchItems, boardOrder, boardPersonPath, boardSearch, cardChip, cardFacts, confidenceChip, countsLine, evidenceLines, headerCounts, extraWarnings, groupCount, initialReview, isTicked,
  lookedAtLine, modeFrom, needsReason, poolCardView, previewByPerson, previewItems, readyCounts, readyLine, reasonLine, reviewRows, rowWarnings, scoreText, snapshotOf, snapshotPlace,
  sortedText, summarySentences, tickable, togglePick, type ReviewState,
} from "../../apps/web/src/pages/board/board-model";

/**
 * The pool board's pure pieces (plan F6-F10; founder decisions B2, B4, B5, B6): the board's words and cards, Review and
 * apply's groups, ticks, reasons and counter, the one-click questions, Today's pool card and the board a recruiter is
 * asked to check. The board only suggests: everything here keeps decisions private and says that nobody is emailed.
 */
let n = 0;
function score(value: number | null, over: Partial<MatchScore> = {}): MatchScore {
  const band = value === null ? null : value >= 85 ? "very_high" : value >= 70 ? "high" : value >= 55 ? "medium" : "low";
  return { score: value, band, bandLabel: null, coverage: { known: 3, total: 4, words: "Based on 3 of 4 requirements" }, breakdown: [], unknown: [], fullMarks: 3, missingMustHave: [], capped: false, confidence: "high", basedOn: "resume", packetVersion: 1, ...over };
}
function placed(column: BoardPlacement["column"], over: Partial<BoardPlacement> = {}): BoardPlacement {
  return { column, state: "suggested", doneLabel: null, confident: true, needsYourEye: null, reason: "Match score 91: every requirement judged so far is met.", nextStep: { kind: "interview", label: "Interview", reason: "Strong evidence on every must-have." }, suggestedAction: column, declineReason: null, ...over };
}
function card(name: string, placement: BoardPlacement, s: MatchScore | null = score(90), over: Partial<BoardCard> = {}): BoardCard {
  n += 1;
  const applicationId = `a${n}`;
  return {
    applicationId, name, appliedAt: "2026-10-01T10:00:00.000Z", waitingDays: 2, stage: "triaged", stageLabel: "Ready for your review", ownerStage: "new", ownerStageLabel: "New", mark: null,
    score: s, mustHaves: null, confidence: "high", reading: "Strong match",
    strengths: [{ claim: "Active CA RDH license", quote: "RDH license CA active", source: "resume", unquoted: false }, { claim: "Periodontal charting", quote: null, source: "screen", unquoted: true }, { claim: "A third strength", quote: "x", source: "resume", unquoted: false }],
    gap: { claim: "Patient communication: partly shown", quote: "explains findings", source: "resume", unquoted: false },
    placement, readingVersion: null, facts: { openScreen: false, invitedAutomatically: false, suggestionWaiting: false, stillApplying: false, lowConfidence: false, needsCloserLook: false },
    open: `/roles/r1/talent?open=${applicationId}`, ...over,
  };
}
const summary = (over: Partial<PoolSummary> = {}): PoolSummary => ({
  total: 5, counts: { shortlist: 2, longlist: 2, not_moving_forward: 1 }, toSort: 4, done: 1, stillApplying: 0, showEveryMustHave: 2, mostMissing: null, longestWaiting: null, nextSteps: [], mustHaves: [], stricter: null,
  sentences: ["5 people on the board: 2 on the shortlist, 2 on the longlist, 1 not moving forward.", "2 of 5 show every must-have.", "The must-have shown least often is \"Periodontal charting\": 3 of 5 don't show it.", "Ana Holt has waited longest: 4 days."],
  ...over,
});

// Ana and Ben on the shortlist (Ben needs your eye), Cleo on the longlist, Dev held on an eligibility answer, Eve
// already sorted by a person, Finn not moving forward with a must-have their own words show is missing.
const ana = card("Ana Holt", placed("shortlist"), score(91));
const ben = card("Ben Ortiz", placed("longlist", { confident: false, needsYourEye: "The assistant was not confident about this reading; read it yourself.", nextStep: { kind: "read_yourself", label: "Read it yourself", reason: "The assistant was not confident; your own read counts most here." } }), score(78));
const cleo = card("Cleo Park", placed("longlist", { reason: "Match score 62: Periodontal charting partly shown.", nextStep: { kind: "keep_as_backup", label: "Keep as backup", reason: "Match score 62." } }), score(62));
const dev = card("Dev Rao", placed("longlist", { confident: false, needsYourEye: "Held on an eligibility answer: keep them in or decline from their page.", suggestedAction: null, nextStep: { kind: "check_eligibility", label: "Check eligibility", reason: "Only a person can keep them in or decline them." } }), score(80));
const eve = card("Eve Lund", placed("shortlist", { state: "done", doneLabel: "Shortlist", confident: false, reason: "Already sorted by a person: Shortlist.", nextStep: null, suggestedAction: null }), score(88));
const finn = card("Finn Moss", placed("not_moving_forward", { reason: "Missing must-have: Active CA RDH license.", nextStep: { kind: "not_moving_forward", label: "Not moving forward", reason: "Their own words show they do not meet Active CA RDH license." }, declineReason: { reason: "not_a_match_skills", note: "Missing must-have: Active CA RDH license. Their own words: \"RDH license CA expired in 2021\"" } }), score(40, { missingMustHave: [{ key: "mh_1", label: "Active CA RDH license", quote: "RDH license CA expired in 2021" }], capped: true }));
const waiting = card("Gus Webb", placed("longlist", { state: "waiting", doneLabel: "Being read", confident: false, reason: "Their application is being read; check back soon.", nextStep: null, suggestedAction: null }), null);
const board: BoardView = { role: { id: "r1", title: "Dental Hygienist", status: "open", currentPacketVersion: 1 }, columns: { shortlist: [ana, eve], longlist: [ben, cleo, dev, waiting], not_moving_forward: [finn] }, stillApplying: [], summary: summary(), generatedAt: "2026-10-09T10:42:00.000Z" };

describe("the board's address and strip", () => {
  it("opens the board from ?view=board and Review and apply from &review=1, keeping the rest of the address", () => {
    expect(modeFrom(new URLSearchParams("view=board"))).toBe("board");
    expect(modeFrom(new URLSearchParams("view=list"))).toBe("list");
    expect(modeFrom(new URLSearchParams(""))).toBe("list");
    expect(boardSearch("open=a1", { mode: "board" })).toBe("?open=a1&view=board");
    expect(boardSearch("view=board&open=a1", { review: true })).toBe("?view=board&open=a1&review=1");
    expect(boardSearch("view=board&review=1", { review: false })).toBe("?view=board");
    // back to the list drops the board and its window
    expect(boardSearch("view=board&review=1&open=a1", { mode: "list" })).toBe("?open=a1");
    expect(boardSearch("view=board", { mode: "list" })).toBe("");
  });

  it("says what sorting does, that nothing moves until applied, and that nothing is sent", () => {
    expect(SORT_TEXT).toMatch(/finished applying/);
    expect(SORT_TEXT).toMatch(/explains every call/);
    expect(SORT_TEXT).toMatch(/nothing is sent to anyone/);
    expect(sortedText("2026-10-09T10:42:00.000Z")).toMatch(/^Sorted at \d{1,2}:\d{2}\s?(AM|PM) by fixed rules from the checked evidence/);
    expect(sortedText(null)).toMatch(/^Sorted by fixed rules/);
    expect(sortedText("not a date")).toMatch(/^Sorted by fixed rules/);
  });
});

describe("the board", () => {
  it("names the columns in our words, with a line under each", () => {
    expect(BOARD_COLUMNS.map((c) => `${c.title}: ${c.sub}`)).toEqual(["Shortlist: Good evidence on the must-haves", "Longlist: Some evidence, or more to find out", "Not moving forward: A must-have shown missing, or a low score on what is known"]);
  });

  it("counts each column in the header line: the people still to sort, then everyone already sorted or decided", () => {
    expect(countsLine({ shortlist: 3, longlist: 1, not_moving_forward: 2 })).toBe("3 shortlist · 1 longlist · 2 not moving forward");
    expect(countsLine({})).toBe("0 shortlist · 0 longlist · 0 not moving forward");
    expect(headerCounts({ counts: { shortlist: 2, longlist: 1, not_moving_forward: 1 }, done: 3 })).toBe("To sort: 2 shortlist · 1 longlist · 1 not moving forward · 3 already sorted or decided");
    expect(headerCounts({ counts: { shortlist: 1 } })).toBe("To sort: 1 shortlist · 0 longlist · 0 not moving forward");
  });

  it("shows the reading's own confidence as a chip of its own, amber only when low", () => {
    expect(confidenceChip({ confidence: "high" })).toMatchObject({ label: "High confidence", tone: "neutral" });
    expect(confidenceChip({ confidence: "low" })).toMatchObject({ label: "Low confidence", tone: "caution" });
    expect(confidenceChip({ confidence: null })).toBeNull();
  });

  it("lists the small facts under a card: the must-have line, what the score rests on, an older version, what happened", () => {
    const mustHaves = { total: 4, shown: 3, partly: 0, notShown: 0, unknown: 1, gaps: [], words: "Must-haves: 3 of 4 shown, 1 not yet known" };
    const readingVersion = { readAgainst: 1, current: 2, label: "Read against version 1 of the role; the role is now on version 2." };
    const facts = { openScreen: true, invitedAutomatically: true, suggestionWaiting: true, stillApplying: false, lowConfidence: false, needsCloserLook: false };
    expect(cardFacts({ mustHaves, score: score(80, { basedOn: "resume_and_screen" }), readingVersion, facts })).toEqual([
      "Must-haves: 3 of 4 shown, 1 not yet known",
      "From the résumé and the screening conversation",
      "Read against version 1 of the role; the role is now on version 2.",
      "Invited to the screening conversation automatically",
      "A suggestion is waiting for you",
    ]);
    expect(cardFacts({ mustHaves: null, score: score(80), readingVersion: null, facts: { ...facts, invitedAutomatically: false, suggestionWaiting: false } })).toEqual(["From the résumé reading", "Screening conversation open"]);
    expect(cardFacts(ana)).toEqual(["From the résumé reading"]);
  });

  it("writes the score as the band's word and the number, coloured like the badge", () => {
    expect(scoreText(91)).toMatchObject({ text: "Very high · 91", tone: "good" });
    expect(scoreText(78)).toMatchObject({ text: "High · 78", tone: "good" });
    expect(scoreText(62)).toMatchObject({ text: "Medium · 62", tone: "caution" });
    expect(scoreText(40)).toMatchObject({ text: "Low · 40", tone: "neutral", label: "Match score 40 out of 100 (low)" });
    expect(scoreText(null)).toEqual({ text: "No score yet", tone: "neutral", label: "No match score yet" });
  });

  it("gives each card one state chip: Done, Being read, a red missing must-have, Needs your eye, or Ready to apply (never green)", () => {
    expect(cardChip(ana)).toEqual({ label: "Ready to apply", tone: "neutral", title: "Review and apply starts with them ticked." });
    expect(cardChip(ben)).toMatchObject({ label: "Needs your eye", tone: "caution" });
    expect(cardChip(finn)).toEqual({ label: "Missing must-have: Active CA RDH license", tone: "critical" });
    expect(cardChip(eve)).toEqual({ label: "Done", tone: "neutral", title: "Shortlist", done: true });
    expect(cardChip(waiting)).toEqual({ label: "Being read", tone: "neutral" });
    const two = card("Two Gaps", placed("not_moving_forward"), score(30, { missingMustHave: [{ key: "a", label: "A", quote: "q" }, { key: "b", label: "B", quote: "q" }] }));
    expect(cardChip(two).label).toBe("Missing must-have: A and 1 more");
    // red is for a missing must-have only
    for (const c of [ana, ben, eve, waiting, cleo, dev]) expect(cardChip(c).tone).not.toBe("critical");
  });

  it("says why a card sits where it does, what needs your eye first", () => {
    expect(reasonLine(ana)).toBe("Match score 91: every requirement judged so far is met.");
    expect(reasonLine(ben)).toBe("The assistant was not confident about this reading; read it yourself.");
    expect(reasonLine(eve)).toBe("Already sorted by a person: Shortlist.");
  });

  it("shows two strengths and the gap, each with where it came from, and says when nothing was quoted", () => {
    expect(evidenceLines(ana)).toEqual([
      { kind: "strength", text: "Active CA RDH license", source: "résumé", quoted: true },
      { kind: "strength", text: "Periodontal charting", source: "screening conversation", quoted: false },
      { kind: "gap", text: "Patient communication: partly shown", source: "résumé", quoted: true },
    ]);
    expect(evidenceLines({ strengths: [], gap: null })).toEqual([]);
  });

  it("orders everyone column by column for the panel's next and previous, and narrows to an answer's people", () => {
    expect(boardOrder(board)).toEqual([ana, eve, ben, cleo, dev, waiting, finn].map((c) => c.applicationId));
    expect(boardOrder(board, new Set([finn.applicationId, ana.applicationId]))).toEqual([ana.applicationId, finn.applicationId]);
  });

  it("puts two plain sentences in the summary, after the counts and without the 'stricter' note", () => {
    expect(summarySentences(summary())).toEqual(["2 of 5 show every must-have.", "The must-have shown least often is \"Periodontal charting\": 3 of 5 don't show it."]);
    const stricter = { key: "mh_2", label: "Periodontal charting", notShowing: 4, of: 5, words: "\"Periodontal charting\" is not shown by 4 of 5 people.", editPath: "/roles/r1?tab=requirements&edit=must-haves" };
    expect(summarySentences(summary({ sentences: ["5 people on the board.", stricter.words, "Ana Holt has waited longest: 4 days."], stricter }))).toEqual(["Ana Holt has waited longest: 4 days."]);
    expect(summarySentences(summary({ sentences: ["Nobody to sort yet."] }))).toEqual(["Nobody to sort yet."]);
  });

  it("asks a recruiter to check the board in plain words", () => {
    expect(RECRUITER_CHECK).toMatch(/check how the board sorted/);
  });
});

describe("Review and apply", () => {
  const { rows, left } = reviewRows(board, { mayDecline: true });
  const byName = (name: string) => rows.find((r) => r.name === name)!;

  it("lists everyone the board placed and nobody has sorted, column by column; never the done or the being-read", () => {
    expect(rows.map((r) => `${r.column}:${r.name}`)).toEqual(["shortlist:Ana Holt", "longlist:Ben Ortiz", "longlist:Cleo Park", "longlist:Dev Rao", "not_moving_forward:Finn Moss"]);
    expect(left).toBe(0);
  });

  it("ticks the confident ones; anyone who needs your eye starts unticked, and an eligibility hold cannot be ticked here", () => {
    expect(byName("Ana Holt").ticked).toBe(true);
    expect(byName("Cleo Park").ticked).toBe(true);
    expect(byName("Finn Moss").ticked).toBe(true);
    expect(byName("Ben Ortiz").ticked).toBe(false);
    expect(byName("Dev Rao")).toMatchObject({ ticked: false, action: null, locked: "Held on an eligibility answer: keep them in or decline from their page." });
    const state = { ...initialReview(rows), refused: {} };
    expect(tickable(byName("Dev Rao"), state)).toBe(false);
  });

  it("keeps a decline out of reach of a role that cannot decline, with the reason", () => {
    const hr = reviewRows(board, { mayDecline: false }).rows.find((r) => r.name === "Finn Moss")!;
    expect(hr).toMatchObject({ ticked: false, locked: NO_DECLINE_HERE });
  });

  it("counts what is ready live, by group, and labels the button", () => {
    const state: ReviewState = { ...initialReview(rows), refused: {} };
    const c = readyCounts(rows, state);
    expect(c).toEqual({ shortlist: 1, longlist: 1, not_moving_forward: 1, total: 3 });
    expect(readyLine(c)).toBe("3 decisions ready (1 shortlist · 1 longlist · 1 not moving forward)");
    expect(applyLabel(3)).toBe("Apply 3 decisions");
    expect(applyLabel(1)).toBe("Apply 1 decision");
    expect(groupCount(rows, "longlist", state)).toEqual({ ticked: 1, total: 3 });
    // ticking Ben in, Ana out
    const changed: ReviewState = { ...state, ticks: { ...state.ticks, [byName("Ben Ortiz").applicationId]: true, [byName("Ana Holt").applicationId]: false } };
    expect(readyLine(readyCounts(rows, changed))).toBe("3 decisions ready (0 shortlist · 2 longlist · 1 not moving forward)");
    expect(readyLine(readyCounts(rows, { ticks: {}, reasons: {}, refused: {} }))).toBe("0 decisions ready (0 shortlist · 0 longlist · 0 not moving forward)");
  });

  it("sends the ticked people, each not-moving-forward with its reason, pre-filled from their evidence or changed here", () => {
    const state: ReviewState = { ...initialReview(rows), refused: {} };
    expect(batchItems(rows, state)).toEqual([
      { applicationId: byName("Ana Holt").applicationId, action: "shortlist" },
      { applicationId: byName("Cleo Park").applicationId, action: "longlist" },
      { applicationId: byName("Finn Moss").applicationId, action: "not_moving_forward", reason: "not_a_match_skills" },
    ]);
    const changed: ReviewState = { ...state, reasons: { [byName("Finn Moss").applicationId]: "not_a_match_experience" } };
    expect(batchItems(rows, changed).at(-1)).toEqual({ applicationId: byName("Finn Moss").applicationId, action: "not_moving_forward", reason: "not_a_match_experience" });
  });

  it("waits for a reason before a not-moving-forward with none can be applied", () => {
    const bare = card("No Reason", placed("not_moving_forward", { declineReason: null }), score(30));
    const view: BoardView = { ...board, columns: { shortlist: [], longlist: [], not_moving_forward: [bare] } };
    const only = reviewRows(view, { mayDecline: true }).rows;
    const state: ReviewState = { ...initialReview(only), refused: {} };
    expect(needsReason(only[0], state)).toBe(true);
    expect(isTicked(only[0], state)).toBe(false);
    expect(batchItems(only, state)).toEqual([]);
    const chosen: ReviewState = { ...state, reasons: { [bare.applicationId]: "location_or_schedule" } };
    expect(isTicked(only[0], chosen)).toBe(true);
    expect(batchItems(only, chosen)).toEqual([{ applicationId: bare.applicationId, action: "not_moving_forward", reason: "location_or_schedule" }]);
  });

  it("asks the preview about everyone with something to apply, and leaves out whoever it refuses", () => {
    expect(previewItems(rows).map((i) => i.action)).toEqual(["shortlist", "longlist", "longlist", "not_moving_forward"]);
    expect(previewItems(rows).at(-1)).toMatchObject({ reason: "not_a_match_skills" });
    const preview = { items: [
      { applicationId: byName("Ana Holt").applicationId, name: "Ana Holt", score: 91, band: "very_high" as const, placement: "shortlist" as const, suggested: "shortlist" as const, action: "shortlist" as const, allowed: false, refusedReason: "They have an interview in motion.", warnings: [], reason: null },
      { applicationId: byName("Finn Moss").applicationId, name: "Finn Moss", score: 40, band: "low" as const, placement: "not_moving_forward" as const, suggested: "not_moving_forward" as const, action: "not_moving_forward" as const, allowed: true, refusedReason: null, warnings: ["Their open screening conversation is closed; they are not told why."], reason: { reason: "not_a_match_skills", label: "Skills not a match", note: "Missing must-have." } },
    ] };
    const { refused, warnings } = previewByPerson(preview);
    expect(refused).toEqual({ [byName("Ana Holt").applicationId]: "They have an interview in motion." });
    const state: ReviewState = { ...initialReview(rows), refused };
    expect(readyCounts(rows, state).total).toBe(2);
    expect(batchItems(rows, state).map((i) => i.applicationId)).not.toContain(byName("Ana Holt").applicationId);
    expect(extraWarnings(byName("Finn Moss"), warnings[byName("Finn Moss").applicationId])).toEqual(["Their open screening conversation is closed; they are not told why."]);
    expect(previewByPerson(null)).toEqual({ refused: {}, warnings: {} });
  });

  it("warns in red for a missing must-have and in amber when the board needs your eye, without repeating the reason", () => {
    expect(rowWarnings(byName("Finn Moss"))).toEqual([{ text: "Missing must-have: Active CA RDH license", tone: "critical" }]);
    expect(rowWarnings(byName("Ben Ortiz"))).toEqual([{ text: NEEDS_EYE_WARNING, tone: "caution" }]);
    expect(rowWarnings(byName("Ana Holt"))).toEqual([]);
    expect(rowWarnings(byName("Dev Rao"))).toEqual([]);
    const ben = byName("Ben Ortiz");
    expect(extraWarnings(ben, [ben.needsYourEye!, "The board suggested Longlist.", "Missing must-have: X."])).toEqual([]);
  });

  it("takes at most 50 people at a time and says how many wait", () => {
    const many = Array.from({ length: 53 }, (_, i) => card(`Person ${i}`, placed("longlist"), score(60)));
    const r = reviewRows({ columns: { shortlist: [], longlist: many, not_moving_forward: [] } }, { mayDecline: true });
    expect(r.rows).toHaveLength(50);
    expect(r.left).toBe(3);
  });

  it("says where each group goes and that it is private, and the footer says nobody is emailed", () => {
    expect(GROUP_WORDS.shortlist).toBe("Added to your Shortlist. Private, the candidate is not told.");
    expect(GROUP_WORDS.longlist).toMatch(/Private, no email\.$/);
    // nobody is emailed now, and the safety net (Q27) is named rather than promising that nothing ever goes by itself
    expect(GROUP_WORDS.not_moving_forward).toBe("Filed privately. Nobody is emailed now; you will be reminded to send the decision message from the Talent page. If nobody tells them within 5 working days, the standard message goes by itself (if your settings ask for approval or keep these messages with a person, an ITS recruiter is brought in instead and nothing is sent).");
    expect(REVIEW_SUB).toBe("Untick anyone you want to decide yourself, change a reason if needed, then apply. Unticked people stay where they are.");
    expect(REVIEW_FOOT).toBe("This files people into your pipeline privately. Nobody is emailed.");
  });

  it("offers the fixed reasons in the team's words, never closing the role", () => {
    expect(DECLINE_CHOICES.map((c) => c.id)).toContain("not_a_match_skills");
    expect(DECLINE_CHOICES.map((c) => c.id)).not.toContain("role_closed");
    expect(DECLINE_CHOICES.find((c) => c.id === "not_a_match_experience")?.label).toBe("Experience not a match");
  });

  it("toasts how many were applied, privately, and how many could not be", () => {
    expect(appliedToast({ applied: 4, refused: 0 })).toEqual({ title: "Applied 4 decisions", detail: "Filed privately. Nobody was emailed." });
    expect(appliedToast({ applied: 1, refused: 2 })).toEqual({ title: "Applied 1 decision", detail: "Filed privately. Nobody was emailed. 2 people could not be applied; each says why." });
    expect(appliedToast({ applied: 0, refused: 3 })).toEqual({ title: "Nothing was applied", detail: "Each person says why. Nobody was emailed." });
  });
});

describe("one-click questions", () => {
  it("asks for the must-have or the people the question is about", () => {
    expect(answerPath("r1", { kind: "missing_must_have", mustHaveKey: null })).toBe("/api/v1/roles/r1/questions/missing_must_have");
    expect(answerPath("r1", { kind: "strongest_evidence", mustHaveKey: "mh 1" })).toBe("/api/v1/roles/r1/questions/strongest_evidence?mustHave=mh+1");
    expect(answerPath("r1", { kind: "compare", mustHaveKey: null }, ["a1", "a2"])).toBe("/api/v1/roles/r1/questions/compare?ids=a1%2Ca2");
    expect(answerPath("r1", { kind: "overlooked", mustHaveKey: null }, ["a1"])).toBe("/api/v1/roles/r1/questions/overlooked");
  });

  it("says what it looked at, and that nothing new was asked of the AI", () => {
    expect(lookedAtLine({ people: 6, resumeReadings: 6, screenReadings: 2, requirements: ["A", "B"], words: "" })).toBe("Looked at: 6 people (6 résumé readings and 2 screening conversations), against 2 must-haves. Nothing new was asked of the AI.");
    expect(lookedAtLine({ people: 1, resumeReadings: 1, screenReadings: 0, requirements: ["Active CA RDH license"], words: "" })).toBe("Looked at: 1 person (1 résumé reading), against \"Active CA RDH license\". Nothing new was asked of the AI.");
    expect(lookedAtLine({ people: 0, resumeReadings: 0, screenReadings: 0, requirements: [], words: "" })).toBe("Looked at: 0 people. Nothing new was asked of the AI.");
  });

  it("compares up to five people", () => {
    let picked: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) picked = togglePick(picked, id, true);
    expect(picked).toEqual(["a", "b", "c", "d", "e"]);
    expect(togglePick(picked, "a", true)).toEqual(picked);
    expect(togglePick(picked, "c", false)).toEqual(["a", "b", "d", "e"]);
  });

  it("says plainly where answers come from, and that typing a question is not available yet", () => {
    expect(ASK_INTRO).toBe("Answers come from the checked findings already on file for everyone who finished applying. Pick a question; each answer says what it looked at.");
    expect(ASK_SOON).toBe("Typing your own question is not available yet. Pick a question above, or bring in a recruiter.");
  });
});

describe("Today's pool card and the board a recruiter checks", () => {
  it("shows two sentences and up to three next steps naming people, each opening their panel over the board", () => {
    const steps = ["a", "b", "c", "d"].map((id) => ({ applicationId: id, name: `Person ${id}`, kind: "interview" as const, label: "Interview", reason: "Strong evidence." }));
    const v = poolCardView(summary({ nextSteps: steps }));
    expect(v.sentences).toHaveLength(2);
    expect(v.steps.map((s) => s.applicationId)).toEqual(["a", "b", "c"]);
    expect(boardPersonPath("r1", "a")).toBe("/roles/r1/talent?view=board&open=a");
    expect(POOL_CARD_NOTE).toBe("Nothing moves until you apply it, and nobody is emailed.");
  });

  it("reads the board snapshot from a request's context, and nothing else", () => {
    const snap = { capturedAt: "2026-10-09T10:00:00.000Z", summary: { sentences: ["2 people on the board."], counts: { shortlist: 1, longlist: 0, not_moving_forward: 1 } }, people: [{ applicationId: "a1", name: "Ana Holt", column: "shortlist", state: "suggested", score: 91, reason: "Match score 91.", needsYourEye: null, nextStep: "Interview" }, { applicationId: "a2", name: "Sofia Lind", column: null, state: "waiting", score: null, reason: "Still applying.", needsYourEye: null, nextStep: null }, { applicationId: "a3", name: "Eve Lund", column: "shortlist", state: "done", score: 88, reason: "Already sorted.", needsYourEye: null, nextStep: null }] };
    const read = snapshotOf({ company: {}, board: snap });
    expect(read?.people).toHaveLength(3);
    expect(snapshotPlace(read!.people[0])).toBe("Shortlist");
    expect(snapshotPlace(read!.people[1])).toBe("Still applying");
    expect(snapshotPlace(read!.people[2])).toBe("Shortlist (already sorted)");
    expect(snapshotOf({ company: {} })).toBeNull();
    expect(snapshotOf(undefined)).toBeNull();
    expect(snapshotOf({ board: { capturedAt: 1, people: [] } })).toBeNull();
  });
});

describe("the words", () => {
  it("never borrow another product's verdict words", () => {
    const words = [SORT_TEXT, ASK_INTRO, ASK_SOON, REVIEW_FOOT, REVIEW_SUB, POOL_CARD_NOTE, RECRUITER_CHECK, NEEDS_EYE_WARNING, NO_DECLINE_HERE, ...Object.values(GROUP_WORDS), ...BOARD_COLUMNS.flatMap((c) => [c.title, c.sub])].join(" ");
    expect(words).not.toMatch(/Clear fit|Worth a look|Likely no|\bSolid\b|Long shot|Kanvis/i);
  });
});
