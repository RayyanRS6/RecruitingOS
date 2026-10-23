import { describe, expect, it } from "vitest";
import type { ApplicationSummary } from "../../apps/web/src/api/client";
import { AI_INTERVIEW_CHIPS, ORDERS, READING, READING_FILTERS, ROW_CHIP_LIMIT, SAFETY_NET_NOTE, aiInterviewAlert, aiInterviewChipLabel, aiInterviewCounts, aiInterviewGroupFrom, appliedWhen, applyView, defaultView, emptyText, fold, jobCardFacts, matchesQuery, orderRows, readingCounts, readingOf, resumeOnlyChip, rowChips, scoreBasis, scoreRank, scoreTitle, stageSummary, stripItems, stripParts, waitingOnYouCount, waitingText, type TalentView } from "../../apps/web/src/talent-list";

/**
 * The Candidates list (plan A3; founder decisions B2, B3 and B6; Wave S1): the stage strip and its "More stages", the
 * chips on a row, the filters, search and the four orders, and the one line on each job of the Jobs page. The AI
 * review's words only ever filter; the match score, worked out by code from the checked findings, can order the list.
 */
let n = 0;
function row(over: Partial<ApplicationSummary> & { name?: string; overall?: string } = {}): ApplicationSummary {
  n += 1;
  const { name, overall, ...rest } = over;
  return {
    id: `a${n}`, stage: "triaged", stageLabel: "Ready for your review", group: "waiting_on_you", source: "careers_page", createdAt: "2026-10-01T10:00:00.000Z", eligibility: null,
    ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [], stageMoves: [], toldState: null, cancelled: null,
    candidate: { id: `c${n}`, name: name ?? `Person ${n}`, email: `person${n}@example.com`, phone: null, locationText: null },
    extractionSummary: null,
    assessment: overall ? { overall, confidence: "medium", summary: "", strengths: [], concerns: [] } : null,
    evidence: { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] },
    appliedAt: "2026-10-01T10:00:00.000Z", stageChangedAt: "2026-10-01T10:00:00.000Z", daysInStage: 0, candidateToldAt: null, decisionMessageWaiting: false,
    ...rest,
  };
}
const view = (over: Partial<TalentView> = {}): TalentView => ({ stage: "all", waiting: false, reading: "any", query: "", order: "newest", internalStage: null, told: null, cancelledReason: null, aiInterview: null, ...over });
const params = (q: string) => new URLSearchParams(q);

describe("the reading chip", () => {
  it("reads the latest reading: a closer look first, then a proven missing must-have, then the overall reading", () => {
    expect(readingOf(row({ overall: "strong" }))).toBe("strong");
    expect(readingOf(row({ overall: "potential" }))).toBe("potential");
    expect(readingOf(row({ overall: "weak" }))).toBe("weak");
    expect(readingOf(row({ overall: "unknown" }))).toBe("insufficient");
    expect(readingOf(row({}))).toBe("none");
    const missing = row({ overall: "strong" });
    missing.evidence = { ...missing.evidence!, hasProvenMiss: true };
    expect(readingOf(missing)).toBe("missing_must_have");
    const closer = row({ overall: "strong" });
    closer.evidence = { ...closer.evidence!, needsCloserLook: true, hasProvenMiss: true };
    expect(readingOf(closer)).toBe("closer_look");
  });

  it("is red only for a missing must-have, and never uses the match score's words", () => {
    for (const [k, r] of Object.entries(READING)) expect(r.tone === "critical", k).toBe(k === "missing_must_have");
    for (const r of Object.values(READING)) expect(r.label).not.toMatch(/^(Very high|High|Medium|Low)$/);
  });
});

describe("the view the page opens on", () => {
  it("is 'waiting on you', longest wait first, when anyone waits; everyone, newest first, when nobody does", () => {
    expect(defaultView(params(""), { byGroup: { waiting_on_you: 2, in_process: 0, not_moving_forward: 0, hired: 0 } })).toEqual(view({ waiting: true, order: "waiting" }));
    expect(defaultView(params(""), { byGroup: { waiting_on_you: 0, in_process: 3, not_moving_forward: 0, hired: 0 } })).toEqual(view());
    expect(defaultView(params(""), null)).toEqual(view());
  });

  it("follows a link instead: a strip column, a step from Today, the people not told yet", () => {
    const counts = { byGroup: { waiting_on_you: 2, in_process: 0, not_moving_forward: 0, hired: 0 } };
    expect(defaultView(params("ownerStage=on_hold"), counts)).toEqual(view({ stage: "on_hold" }));
    expect(defaultView(params("stage=ineligible"), counts)).toEqual(view({ internalStage: "ineligible" }));
    expect(defaultView(params("ownerStage=not_moving_forward&told=not_told"), counts)).toEqual(view({ stage: "not_moving_forward", told: "not_told" }));
    expect(defaultView(params("order=name"), counts)).toEqual(view({ waiting: true, order: "name" }));
    // anything unknown in the address is ignored
    expect(defaultView(params("ownerStage=hidden&told=maybe"), null)).toEqual(view());
  });
});

describe("filters, search and order", () => {
  const maria = row({ name: "María Reyes", overall: "strong", appliedAt: "2026-10-05T10:00:00.000Z", stageChangedAt: "2026-10-06T10:00:00.000Z", source: "indeed" });
  const ben = row({ name: "Ben Ortiz", overall: "potential", appliedAt: "2026-10-07T10:00:00.000Z", stageChangedAt: "2026-10-02T10:00:00.000Z" });
  const ana = row({ name: "Ana Holt", ownerStage: "shortlist", ownerStageLabel: "Shortlist", group: "in_process", appliedAt: "2026-10-03T10:00:00.000Z", stageChangedAt: "2026-10-03T10:00:00.000Z" });
  const cleo = row({ name: "Cleo Park", stage: "rejected", ownerStage: "not_moving_forward", ownerStageLabel: "Not moving forward", group: "not_moving_forward", toldState: "not_told", appliedAt: "2026-10-01T10:00:00.000Z" });
  const all = [maria, ben, ana, cleo];

  it("narrows by the strip's column, the waiting toggle, the reading, a step and the told state", () => {
    expect(applyView(all, view({ stage: "shortlist" })).map((a) => a.id)).toEqual([ana.id]);
    expect(applyView(all, view({ waiting: true })).map((a) => a.id).sort()).toEqual([maria.id, ben.id].sort());
    expect(applyView(all, view({ reading: "strong" })).map((a) => a.id)).toEqual([maria.id]);
    expect(applyView(all, view({ internalStage: "rejected" })).map((a) => a.id)).toEqual([cleo.id]);
    expect(applyView(all, view({ told: "not_told" })).map((a) => a.id)).toEqual([cleo.id]);
  });

  it("searches names without accents, email addresses and where people came from", () => {
    expect(fold("María")).toBe("maria");
    expect(matchesQuery(maria, "maria")).toBe(true);
    expect(matchesQuery(maria, "INDEED")).toBe(true);
    expect(matchesQuery(maria, maria.candidate!.email!)).toBe(true);
    expect(matchesQuery(maria, "ortiz")).toBe(false);
    expect(matchesQuery(maria, "   ")).toBe(true);
    expect(applyView(all, view({ query: "ben" })).map((a) => a.id)).toEqual([ben.id]);
  });

  it("orders newest first, by the longest wait, or by name; never by a reading", () => {
    expect(orderRows(all, "newest").map((a) => a.candidate?.name)).toEqual(["Ben Ortiz", "María Reyes", "Ana Holt", "Cleo Park"]);
    expect(orderRows([maria, ben, ana], "waiting").map((a) => a.candidate?.name)).toEqual(["Ben Ortiz", "Ana Holt", "María Reyes"]);
    expect(orderRows(all, "name").map((a) => a.candidate?.name)).toEqual(["Ana Holt", "Ben Ortiz", "Cleo Park", "María Reyes"]);
    // a strong reading does not move anyone up
    const weakFirst = [row({ name: "Zed", overall: "weak", appliedAt: "2026-10-08T00:00:00.000Z" }), row({ name: "Amy", overall: "strong", appliedAt: "2026-10-01T00:00:00.000Z" })];
    expect(orderRows(weakFirst, "newest").map((a) => a.candidate?.name)).toEqual(["Zed", "Amy"]);
  });

  it("orders by the match score, highest first, people with no score yet last and newest first among equals (B2)", () => {
    const high = row({ name: "High", score: 91, appliedAt: "2026-10-01T10:00:00.000Z" });
    const mid = row({ name: "Mid", score: 62, appliedAt: "2026-10-05T10:00:00.000Z" });
    const tieOld = row({ name: "Tie old", score: 62, appliedAt: "2026-10-02T10:00:00.000Z" });
    const none = row({ name: "None", score: null, appliedAt: "2026-10-08T10:00:00.000Z" });
    const older = row({ name: "Older answer", appliedAt: "2026-10-09T10:00:00.000Z" }); // an answer from before the score has none at all
    expect(orderRows([none, tieOld, older, mid, high], "score").map((a) => a.candidate?.name)).toEqual(["High", "Mid", "Tie old", "Older answer", "None"]);
    expect(applyView([none, high], view({ order: "score" })).map((a) => a.candidate?.name)).toEqual(["High", "None"]);
  });

  it("orders like with like (R20-9): scores that count the AI interview first, then résumé-only ones, each highest first, no score last", () => {
    const interviewed = row({ name: "Interviewed 86", score: 86, interview: "done", basis: "From the résumé and the AI interview" });
    const interviewedLow = row({ name: "Interviewed 58", score: 58, interview: "done", basis: "From the résumé and the AI interview" });
    // a résumé that speaks to 2 of 7 requirements can score 100: it still comes after anyone interviewed
    const thin = row({ name: "Résumé 100", score: 100, interview: "not_done_yet", basis: "Résumé only: AI interview not done yet" });
    const closed = row({ name: "Résumé 70", score: 70, interview: "not_done", basis: "Résumé only: no AI interview" });
    const scoring = row({ name: "Résumé 90", score: 90, interview: "being_scored", basis: "Résumé only for now: AI interview done, being scored" });
    const none = row({ name: "No score", score: null, interview: null, basis: null });
    expect(orderRows([none, closed, interviewedLow, thin, scoring, interviewed], "score").map((a) => a.candidate?.name)).toEqual(["Interviewed 86", "Interviewed 58", "Résumé 100", "Résumé 90", "Résumé 70", "No score"]);
    // an older answer that does not say ranks with the interviewed, as before
    const older = row({ name: "Older 80", score: 80 });
    expect(orderRows([thin, older], "score").map((a) => a.candidate?.name)).toEqual(["Older 80", "Résumé 100"]);
    expect(scoreRank(interviewed)).toBe(0);
    expect(scoreRank(closed)).toBe(1);
    expect(scoreRank(none)).toBe(2);
  });

  it("marks a résumé-only score beside the badge, and says what it rests on on hover (R20-9)", () => {
    const coverage = { known: 3, total: 4, words: "Based on 3 of 4 requirements" };
    expect(resumeOnlyChip(row({ score: 72, interview: "not_done_yet", basis: "Résumé only: AI interview not done yet" }))).toEqual({ label: "Résumé only", title: "Résumé only: AI interview not done yet" });
    expect(resumeOnlyChip(row({ score: 72, interview: "none", basis: "Résumé only: no AI interview" }))).toMatchObject({ label: "Résumé only" });
    expect(resumeOnlyChip(row({ score: 72, interview: "done", basis: "From the résumé and the AI interview" }))).toBeNull();
    expect(resumeOnlyChip(row({ score: null, interview: "not_done_yet" }))).toBeNull();
    expect(resumeOnlyChip(row({ score: 72 }))).toBeNull();
    expect(scoreTitle(row({ coverage, basis: "Résumé only: AI interview not done yet" }))).toBe("Based on 3 of 4 requirements. Résumé only: AI interview not done yet");
    expect(scoreTitle(row({ coverage }))).toBe("Based on 3 of 4 requirements");
    expect(scoreTitle(row({}))).toBeUndefined();
    // the same label wherever the score shows; an older answer says which reading it came from
    expect(scoreBasis({ basis: "Résumé only: no AI interview", basedOn: "resume" })).toBe("Résumé only: no AI interview");
    expect(scoreBasis({ basedOn: "resume_and_screen" })).toBe("From the résumé and the AI interview");
    expect(scoreBasis(null)).toBeNull();
  });

  it("offers Score, Newest, Waiting longest and Name, and opens on the score from a link", () => {
    expect(ORDERS.map((o) => o.label)).toEqual(["Score", "Newest first", "Waiting longest", "Name"]);
    expect(defaultView(params("order=score"), null)).toEqual(view({ order: "score" }));
  });

  it("counts each reading within the column and the waiting toggle", () => {
    expect(readingCounts(all, { stage: "all", waiting: false })).toEqual({ any: 4, strong: 1, potential: 1, missing_must_have: 0, closer_look: 0 });
    expect(readingCounts(all, { stage: "shortlist", waiting: false })).toEqual({ any: 1, strong: 0, potential: 0, missing_must_have: 0, closer_look: 0 });
  });
});

describe("the strip and the row's words", () => {
  it("lists everyone, then every stage in order, with its count: Cancelled right after Interviewing (founder decision 1A)", () => {
    const items = stripItems({ total: 9, byOwnerStage: { no_ai_interview: 1, new: 2, longlist: 0, shortlist: 1, interviewing: 1, cancelled: 2, on_hold: 1, offer: 0, hired: 0, not_moving_forward: 1 } });
    // "No AI interview yet" first (R20-7): everyone starts there
    expect(items.map((i) => `${i.label} ${i.count}`)).toEqual(["All 9", "No AI interview yet 1", "New 2", "Longlist 0", "Shortlist 1", "Interviewing 1", "Cancelled 2", "On hold 1", "Offer 0", "Hired 0", "Not moving forward 1"]);
    expect(stripItems(null).every((i) => i.count === 0)).toBe(true);
    expect(stageSummary({ new: 2, shortlist: 1, hired: 0 }).map((s) => `${s.count} ${s.label}`)).toEqual(["2 New", "1 Shortlist"]);
    expect(stageSummary(undefined)).toEqual([]);
  });

  it("says when someone applied in calendar days", () => {
    const now = new Date(2026, 9, 8, 15, 0);
    expect(appliedWhen(new Date(2026, 9, 8, 9, 0).toISOString(), now)).toBe("Applied today");
    expect(appliedWhen(new Date(2026, 9, 7, 23, 0).toISOString(), now)).toBe("Applied yesterday");
    expect(appliedWhen(new Date(2026, 9, 4, 12, 0).toISOString(), now)).toBe("Applied 4 days ago");
    expect(appliedWhen(new Date(2026, 8, 12, 12, 0).toISOString(), now)).toBe("Applied Sep 12");
    expect(appliedWhen(new Date(2025, 11, 30, 12, 0).toISOString(), now)).toBe("Applied Dec 30, 2025");
    expect(appliedWhen("not a date", now)).toBe("Applied");
  });

  it("counts the wait only for the people who wait on you", () => {
    expect(waitingText({ group: "waiting_on_you", daysInStage: 0 })).toBe("Waiting on you since today");
    expect(waitingText({ group: "waiting_on_you", daysInStage: 1 })).toBe("Waiting on you 1 day");
    expect(waitingText({ group: "waiting_on_you", daysInStage: 5 })).toBe("Waiting on you 5 days");
    expect(waitingText({ group: "in_process", daysInStage: 9 })).toBeNull();
  });

  it("shows All, No AI interview yet, New, Shortlist, Interviewing, Hired and Not moving forward, and any stage someone is at; the rest wait under More stages (Wave S1)", () => {
    const counts = { total: 6, byOwnerStage: { no_ai_interview: 0, new: 2, longlist: 0, shortlist: 1, interviewing: 0, cancelled: 2, on_hold: 0, offer: 1, hired: 0, not_moving_forward: 0 } };
    const parts = stripParts(counts, "all");
    expect(parts.shown.map((i) => `${i.label} ${i.count}`)).toEqual(["All 6", "No AI interview yet 0", "New 2", "Shortlist 1", "Interviewing 0", "Cancelled 2", "Offer 1", "Hired 0", "Not moving forward 0"]);
    // still clickable from the menu, with their counts, in strip order
    expect(parts.more.map((i) => `${i.label} ${i.count}`)).toEqual(["Longlist 0", "On hold 0"]);
    // the column being shown stays on the strip even when nobody is in it (a link opened it, or someone just left it)
    expect(stripParts(counts, "on_hold").shown.map((i) => i.id)).toContain("on_hold");
    expect(stripParts(counts, "on_hold").more.map((i) => i.id)).toEqual(["longlist"]);
    // nothing is lost: the two parts together are the whole strip
    expect([...parts.shown, ...parts.more].map((i) => i.id).sort()).toEqual(stripItems(counts).map((i) => i.id).sort());
    expect(stripParts(null, "all").shown.map((i) => i.id)).toEqual(["all", "no_ai_interview", "new", "shortlist", "interviewing", "hired", "not_moving_forward"]);
  });

  const words = { onItsWay: "Message on its way", lowConfidence: "Low confidence: read it yourself" };
  it("lists a row's chips most pressing first; the page shows two and counts the rest", () => {
    expect(ROW_CHIP_LIMIT).toBe(2);
    const busy = row({ overall: "strong", tags: ["Check eligibility"], toldState: "not_told", evidence: { ...row().evidence!, lowConfidence: true } });
    expect(rowChips(busy, words).map((c) => c.label)).toEqual(["Check eligibility", "Not told yet", "Strong match", "Check"]);
    // "Check" is short on screen; its full words are its title (and what a screen reader hears)
    expect(rowChips(busy, words).at(-1)).toEqual({ key: "low", label: "Check", tone: "caution", title: "Low confidence: read it yourself", kind: "chip" });
    // "Not told yet" carries the day-5 safety net (founder decision D-03); a message waiting for approval does not
    expect(rowChips(busy, words).find((c) => c.key === "told")?.title).toBe(SAFETY_NET_NOTE);
    expect(rowChips(row({ toldState: "not_told", decisionMessageWaiting: true }), words).map((c) => [c.label, c.title])).toEqual([["Message waiting for approval", undefined]]);
    expect(rowChips(row({ toldState: "queued" }), words).map((c) => c.label)).toEqual(["Message on its way"]);
    // under "No AI interview yet" (R20-7): where they stand with it comes first, its plain label as the title
    const invited = { state: "invited" as const, group: "not_started" as const, label: "Invited (not started)", since: "2026-10-20T12:00:00.000Z", linkOpenUntil: "2026-10-25T12:00:00.000Z", lastEmailAt: "2026-10-20T12:00:00.000Z", canRemind: false, canResend: false };
    expect(rowChips(row({ ownerStage: "no_ai_interview", aiInterview: invited, overall: "potential" }), words).map((c) => [c.label, c.title])).toEqual([["Invited Oct 20 · link open until Oct 25", "Invited (not started)"], ["Potential match", undefined]]);
    // an AI interview view on anyone else (an older answer) says nothing
    expect(rowChips(row({ aiInterview: invited }), words)).toEqual([]);
    // a closer look already says it: no second "Check"
    const closer = row({ overall: "strong" });
    closer.evidence = { ...closer.evidence!, needsCloserLook: true, lowConfidence: true };
    expect(rowChips(closer, words).map((c) => c.label)).toEqual(["Needs a closer look"]);
    expect(rowChips(row({}), words)).toEqual([]);
  });

  it("says the safety net in one short line for lists that know neither the day nor the setting (D-03)", () => {
    expect(SAFETY_NET_NOTE).toBe("If nobody tells them within 5 working days, the standard message goes by itself (or an ITS recruiter is brought in, if your settings say so).");
  });

  it("calls the match filter's first choice All matches, never 'Any reading'", () => {
    expect(READING_FILTERS[0]).toEqual({ id: "any", label: "All matches" });
    expect(READING_FILTERS.map((f) => f.label).join(" ")).not.toMatch(/reading/i);
  });

  it("gives each job on the Jobs page one line: new, applicants, to review, days open", () => {
    const job = { counts: { total: 12, waiting_on_you: 3 }, stageCounts: { new: 5 } as never, countsHidden: false, daysOpen: 9 };
    expect(jobCardFacts(job)).toBe("5 new · 12 applicants · 3 to review · 9 days open");
    expect(jobCardFacts({ ...job, counts: { total: 1 }, stageCounts: { new: 1 } as never, daysOpen: 1 })).toBe("1 new · 1 applicant · 1 day open");
    expect(jobCardFacts({ counts: { total: 0 }, countsHidden: false, daysOpen: null })).toBe("Not posted yet");
    // a count of nothing is left out, as on Home: never "0 new"
    expect(jobCardFacts({ ...job, stageCounts: { new: 0 } as never })).toBe("12 applicants · 3 to review · 9 days open");
    expect(jobCardFacts({ ...job, stageCounts: null as never, counts: { total: 4 } })).toBe("4 applicants · 9 days open");
    // an interviewer's list has no counts
    expect(jobCardFacts({ ...job, countsHidden: true })).toBe("9 days open");
  });

  it("explains an empty list for the view chosen", () => {
    expect(emptyText(view(), 0).title).toBe("Nobody has applied yet");
    expect(emptyText(view(), 0).body).toContain("The Share tab has the job's links");
    expect(emptyText(view({ query: "zed" }), 3).body).toMatch(/Nobody here matches "zed"/);
    expect(emptyText(view({ waiting: true }), 3).title).toBe("Nobody is waiting on you");
    // a column the filters leave empty: the title alone (the page shows "Nothing matches these filters" in its place)
    expect(emptyText(view({ stage: "offer" }), 3)).toEqual({ title: "Nobody here" });
    expect(emptyText(view({ stage: "no_ai_interview" }), 3)).toEqual({ title: "Nobody here" });
    expect(emptyText(view({ stage: "no_ai_interview", aiInterview: "closed" }), 3).title).toBe("Nobody here");
  });
});

describe("No AI interview yet (R20-7; it replaced plan E6's 'Still applying' toggle)", () => {
  const ai = (state: "being_read" | "invited" | "started" | "asked_person" | "link_expired" | "didnt_finish", over: Record<string, unknown> = {}) => {
    const group = state === "being_read" || state === "invited" ? "not_started" : state === "started" ? "started" : state === "asked_person" ? "asked_person" : "closed";
    const label = { being_read: "Getting the AI interview ready", invited: "Invited (not started)", started: "Started (not finished)", asked_person: "Asked for a person", link_expired: "Link expired", didnt_finish: "Didn't finish" }[state];
    return { state, group, label, since: null, linkOpenUntil: null, lastEmailAt: null, canRemind: false, canResend: group === "closed", ...over } as NonNullable<ApplicationSummary["aiInterview"]>;
  };
  // Sofia is invited; Theo started, and a hold that ended meanwhile put him in "waiting on you", which the page never shows here
  const sofia = row({ name: "Sofia Lind", stage: "screen_invited", ownerStage: "no_ai_interview", group: "in_process", aiInterview: ai("invited") });
  const theo = row({ name: "Theo Park", stage: "screening", ownerStage: "no_ai_interview", group: "waiting_on_you", daysInStage: 2, aiInterview: ai("started") });
  const uma = row({ name: "Uma Rao", stage: "screen_invited", ownerStage: "no_ai_interview", group: "in_process", aiInterview: ai("link_expired", { since: "2026-10-25T12:00:00.000Z" }) });
  const maria = row({ name: "Maria Reyes", overall: "strong", group: "waiting_on_you", daysInStage: 3 });
  const all = [sofia, theo, uma, maria];
  const counts = { total: 4, byOwnerStage: { no_ai_interview: 3, new: 1, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0 }, byGroup: { waiting_on_you: 2, in_process: 2, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0 };

  it("splits the column into four chips, counted by the API or, for an older answer, from the rows", () => {
    expect(AI_INTERVIEW_CHIPS.map((c) => c.label)).toEqual(["Not started", "Started", "Asked for a person", "Link closed"]);
    expect(aiInterviewCounts({ aiInterview: { not_started: 4, started: 1, asked_person: 0, closed: 2 } }, all)).toEqual({ not_started: 4, started: 1, asked_person: 0, closed: 2 });
    expect(aiInterviewCounts(null, all)).toEqual({ not_started: 1, started: 1, asked_person: 0, closed: 1 });
  });

  it("says where each stands in the row's chip, never how far anyone got", () => {
    expect(aiInterviewChipLabel(ai("invited", { since: "2026-10-20T12:00:00.000Z", linkOpenUntil: "2026-10-25T12:00:00.000Z" }))).toBe("Invited Oct 20 · link open until Oct 25");
    expect(aiInterviewChipLabel(ai("link_expired", { since: "2026-10-25T12:00:00.000Z" }))).toBe("Link expired Oct 25");
    expect(aiInterviewChipLabel(ai("started"))).toBe("Started (not finished)");
    expect(aiInterviewChipLabel(ai("didnt_finish"))).toBe("Didn't finish");
    expect(aiInterviewChipLabel(ai("asked_person"))).toBe("Asked for a person");
    expect(aiInterviewChipLabel(ai("being_read"))).toBe("Getting the AI interview ready");
  });

  it("filters the column by a chip, and says above it, in counts and plain words, that nothing there waits on you", () => {
    expect(applyView(all, view({ stage: "no_ai_interview" })).map((a) => a.id).sort()).toEqual([sofia.id, theo.id, uma.id].sort());
    expect(applyView(all, view({ stage: "no_ai_interview", aiInterview: "closed" })).map((a) => a.id)).toEqual([uma.id]);
    expect(readingCounts(all, { stage: "no_ai_interview", waiting: false, aiInterview: "started" }).any).toBe(1);
    const alert = aiInterviewAlert({ not_started: 1, started: 1, asked_person: 0, closed: 1 });
    expect(alert).toBe("1 not started · 1 started · 1 link closed. Everyone who applies gets the AI interview by email and moves to New once they send it. Nothing here waits on you; from a person's page you can send a reminder, a new link, or decline privately.");
    expect(alert).not.toMatch(/question|answered/);
  });

  it("never counts or shows them as waiting on you, whatever their group says", () => {
    expect(waitingOnYouCount(counts, all)).toBe(1); // Maria; never Theo
    expect(waitingOnYouCount(null, all)).toBe(0);
    expect(applyView(all, view({ waiting: true })).map((a) => a.id)).toEqual([maria.id]);
    expect(waitingText(theo)).toBeNull();
    expect(waitingText(maria)).toBe("Waiting on you 3 days");
  });

  it("opens on the column, or one chip of it, from a link (Home's line, an older 'still applying' link), never on 'waiting on you'", () => {
    const waiting = { byGroup: { waiting_on_you: 2, in_process: 0, not_moving_forward: 0, hired: 0 } };
    expect(defaultView(params("ownerStage=no_ai_interview&aiInterview=closed"), waiting)).toEqual(view({ stage: "no_ai_interview", aiInterview: "closed" }));
    expect(defaultView(params("aiInterview=started"), null)).toEqual(view({ stage: "no_ai_interview", aiInterview: "started" }));
    expect(defaultView(params("applying=1"), waiting)).toEqual(view({ stage: "no_ai_interview" }));
    // a chip belongs to that column: beside another it means nothing, and an unknown one is ignored
    expect(defaultView(params("ownerStage=new&aiInterview=closed"), null)).toEqual(view({ stage: "new" }));
    expect(aiInterviewGroupFrom("maybe")).toBeNull();
    expect(defaultView(params("ownerStage=no_ai_interview&aiInterview=maybe"), null)).toEqual(view({ stage: "no_ai_interview" }));
  });
});
describe("the Cancelled column (founder decisions 1A to 4A)", () => {
  const under = (reason: "asked_new_times" | "not_interested" | "no_show", over: Partial<ApplicationSummary> = {}) => row({
    stage: "interview_recommended", ownerStage: "cancelled", ownerStageLabel: reason === "no_show" ? "No-show" : reason === "not_interested" ? "No longer interested" : "Asked for new times", group: "waiting_on_you",
    cancelled: { id: `f${n}`, reason, label: "", since: "2026-10-09T21:00:00.000Z", interviewId: "iv1", auto: { state: "none", reason: null, reasonText: null, dueAt: null, dueDay: null, sentAt: null }, times: "none", lastSentAt: null, lastSentVia: null, status: "Waiting for you" },
    ...over,
  });
  const ana = under("asked_new_times", { candidate: { id: "c-ana", name: "Ana Lopez", email: "ana@example.com", phone: null, locationText: null } });
  const ben = under("not_interested", { candidate: { id: "c-ben", name: "Ben Ortiz", email: "ben@example.com", phone: null, locationText: null } });
  const cleo = under("no_show", { candidate: { id: "c-cleo", name: "Cleo Park", email: "cleo@example.com", phone: null, locationText: null } });
  const dana = row({ name: "Dana Reyes", ownerStage: "interviewing", ownerStageLabel: "Interviewing" });
  const all = [ana, ben, cleo, dana];

  it("opens on one reason from a link (Today's card, the role report), and ignores a reason that is not one", () => {
    expect(defaultView(params("ownerStage=cancelled&cancelled=no_show"), null)).toEqual(view({ stage: "cancelled", cancelledReason: "no_show" }));
    expect(defaultView(params("ownerStage=cancelled"), { byGroup: { waiting_on_you: 3, in_process: 0, not_moving_forward: 0, hired: 0 } })).toEqual(view({ stage: "cancelled" }));
    // a reason on its own opens the column it belongs to; beside another column it means nothing
    expect(defaultView(params("cancelled=asked_new_times"), null)).toEqual(view({ stage: "cancelled", cancelledReason: "asked_new_times" }));
    expect(defaultView(params("ownerStage=new&cancelled=no_show"), null)).toEqual(view({ stage: "new" }));
    expect(defaultView(params("ownerStage=cancelled&cancelled=maybe"), null)).toEqual(view({ stage: "cancelled" }));
  });

  it("shows the column, and one reason within it", () => {
    expect(applyView(all, view({ stage: "cancelled" })).map((a) => a.id).sort()).toEqual([ana.id, ben.id, cleo.id].sort());
    expect(applyView(all, view({ stage: "cancelled", cancelledReason: "no_show" })).map((a) => a.id)).toEqual([cleo.id]);
    expect(applyView(all, view({ stage: "cancelled", cancelledReason: "not_interested" })).map((a) => a.id)).toEqual([ben.id]);
    // someone not under Cancelled has no reason, so a reason never shows them
    expect(applyView(all, view({ cancelledReason: "asked_new_times" })).map((a) => a.id)).toEqual([ana.id]);
    expect(readingCounts(all, { stage: "cancelled", waiting: false, cancelledReason: "no_show" }).any).toBe(1);
  });

  it("says who shows there when nobody does, and falls back to the usual sentence with a reason chosen", () => {
    expect(emptyText(view({ stage: "cancelled" }), 4)).toEqual({ title: "Nobody is under Cancelled", body: "Candidates who cancel an interview, or do not come to one, show here with what they chose." });
    expect(emptyText(view({ stage: "cancelled", cancelledReason: "no_show" }), 4).title).toBe("Nobody here");
    expect(emptyText(view({ stage: "cancelled", query: "zed" }), 4).title).toBe("Nobody matches");
  });
});
