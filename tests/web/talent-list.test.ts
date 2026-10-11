import { describe, expect, it } from "vitest";
import type { ApplicationSummary } from "../../apps/web/src/api/client";
import { ORDERS, READING, appliedWhen, applyView, defaultView, emptyText, fold, isStillApplying, matchesQuery, orderRows, readingCounts, readingOf, stageSummary, stillApplyingCount, stripItems, waitingOnYouCount, waitingText, type TalentView } from "../../apps/web/src/talent-list";

/**
 * The Talent list (plan A3; founder decisions B2, B3 and B6): the stage strip, the reading chip, the filters, search and
 * the four orders. The AI reading's words only ever filter; the match score, worked out by code from the checked
 * findings, can order the list.
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
const view = (over: Partial<TalentView> = {}): TalentView => ({ stage: "all", waiting: false, applying: false, reading: "any", query: "", order: "newest", internalStage: null, told: null, cancelledReason: null, ...over });
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
    const items = stripItems({ total: 8, byOwnerStage: { new: 2, longlist: 0, shortlist: 1, interviewing: 1, cancelled: 2, on_hold: 1, offer: 0, hired: 0, not_moving_forward: 1 } });
    expect(items.map((i) => `${i.label} ${i.count}`)).toEqual(["All 8", "New 2", "Longlist 0", "Shortlist 1", "Interviewing 1", "Cancelled 2", "On hold 1", "Offer 0", "Hired 0", "Not moving forward 1"]);
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

  it("explains an empty list for the view chosen", () => {
    expect(emptyText(view(), 0).title).toBe("Nobody has applied yet");
    expect(emptyText(view({ query: "zed" }), 3).body).toMatch(/Nobody here matches "zed"/);
    expect(emptyText(view({ waiting: true }), 3).title).toBe("Nobody is waiting on you");
    expect(emptyText(view({ stage: "offer" }), 3).title).toBe("Nobody here");
    expect(emptyText(view({ applying: true }), 3)).toMatchObject({ title: "Nobody is still applying", body: expect.stringContaining('Turn off "Still applying"') });
  });
});

describe("still applying (plan E6)", () => {
  // Sofia sent the form and is answering the screening questions in the same visit; her hold ended meanwhile, so the
  // API puts her in "waiting on you", which the page never shows while she is still applying.
  const sofia = row({ name: "Sofia Lind", stage: "screen_invited", group: "in_process", stillApplying: true });
  const theo = row({ name: "Theo Park", stage: "screening", group: "waiting_on_you", stillApplying: true, daysInStage: 2 });
  const maria = row({ name: "Maria Reyes", overall: "strong", group: "waiting_on_you", daysInStage: 3 });
  const older = row({ name: "Old Answer" }); // an answer from before Wave E has no stillApplying at all
  const all = [sofia, theo, maria, older];
  const counts = { total: 4, byOwnerStage: { new: 4, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0 }, byGroup: { waiting_on_you: 3, in_process: 1, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0 };

  it("is read from the row, and an older answer without it is not still applying", () => {
    expect(isStillApplying(sofia)).toBe(true);
    expect(isStillApplying(older)).toBe(false);
  });

  it("counts them beside the strip: the API's count, or the rows' when an older answer has none", () => {
    expect(stillApplyingCount({ ...counts, stillApplying: 2 }, all)).toBe(2);
    expect(stillApplyingCount({ ...counts, stillApplying: undefined }, all)).toBe(2);
    expect(stillApplyingCount(null, [])).toBe(0);
  });

  it("never counts or shows them as waiting on you, whatever their group says", () => {
    expect(waitingOnYouCount(counts, all)).toBe(2); // Maria and the older answer; never Theo
    expect(waitingOnYouCount(null, all)).toBe(0);
    expect(applyView(all, view({ waiting: true })).map((a) => a.id).sort()).toEqual([maria.id, older.id].sort());
    expect(waitingText(theo)).toBeNull();
    expect(waitingText(maria)).toBe("Waiting on you 3 days");
    expect(readingCounts(all, { stage: "all", waiting: true }).any).toBe(2);
  });

  it("keeps them in their stage column, and shows only them when the count beside the strip is pressed", () => {
    expect(applyView(all, view({ stage: "new" }))).toHaveLength(4);
    expect(applyView(all, view({ applying: true })).map((a) => a.id).sort()).toEqual([sofia.id, theo.id].sort());
    expect(readingCounts(all, { stage: "all", waiting: false, applying: true }).any).toBe(2);
  });

  it("opens on them from a link (the role report's 'See who is still applying'), never on 'waiting on you'", () => {
    expect(defaultView(params("applying=1"), { byGroup: { waiting_on_you: 2, in_process: 0, not_moving_forward: 0, hired: 0 } })).toEqual(view({ applying: true }));
    expect(defaultView(params(""), { byGroup: { waiting_on_you: 0, in_process: 2, not_moving_forward: 0, hired: 0 } }).applying).toBe(false);
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
