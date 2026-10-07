import { describe, expect, it } from "vitest";
import type { ApplicationSummary } from "../../apps/web/src/api/client";
import { READING, appliedWhen, applyView, defaultView, emptyText, fold, matchesQuery, orderRows, readingCounts, readingOf, stageSummary, stripItems, waitingText, type TalentView } from "../../apps/web/src/talent-list";

/**
 * The Talent list (plan A3; founder decisions B3 and B6): the stage strip, the reading chip, the filters, search and the
 * three orders. Readings only ever filter; no order uses an AI reading.
 */
let n = 0;
function row(over: Partial<ApplicationSummary> & { name?: string; overall?: string } = {}): ApplicationSummary {
  n += 1;
  const { name, overall, ...rest } = over;
  return {
    id: `a${n}`, stage: "triaged", stageLabel: "Ready for your review", group: "waiting_on_you", source: "careers_page", createdAt: "2026-10-01T10:00:00.000Z", eligibility: null,
    ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [], stageMoves: [], toldState: null,
    candidate: { id: `c${n}`, name: name ?? `Person ${n}`, email: `person${n}@example.com`, phone: null, locationText: null },
    extractionSummary: null,
    assessment: overall ? { overall, confidence: "medium", summary: "", strengths: [], concerns: [] } : null,
    evidence: { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] },
    appliedAt: "2026-10-01T10:00:00.000Z", stageChangedAt: "2026-10-01T10:00:00.000Z", daysInStage: 0, candidateToldAt: null, decisionMessageWaiting: false,
    ...rest,
  };
}
const view = (over: Partial<TalentView> = {}): TalentView => ({ stage: "all", waiting: false, reading: "any", query: "", order: "newest", internalStage: null, told: null, ...over });
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

  it("counts each reading within the column and the waiting toggle", () => {
    expect(readingCounts(all, { stage: "all", waiting: false })).toEqual({ any: 4, strong: 1, potential: 1, missing_must_have: 0, closer_look: 0 });
    expect(readingCounts(all, { stage: "shortlist", waiting: false })).toEqual({ any: 1, strong: 0, potential: 0, missing_must_have: 0, closer_look: 0 });
  });
});

describe("the strip and the row's words", () => {
  it("lists everyone, then every stage in order, with its count", () => {
    const items = stripItems({ total: 6, byOwnerStage: { new: 2, longlist: 0, shortlist: 1, interviewing: 1, on_hold: 1, offer: 0, hired: 0, not_moving_forward: 1 } });
    expect(items.map((i) => `${i.label} ${i.count}`)).toEqual(["All 6", "New 2", "Longlist 0", "Shortlist 1", "Interviewing 1", "On hold 1", "Offer 0", "Hired 0", "Not moving forward 1"]);
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
  });
});
