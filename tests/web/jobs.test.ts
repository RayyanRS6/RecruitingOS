import { describe, expect, it } from "vitest";
import { ROLE_ACTION_BLOCKED, draftStillNeeds, roleActions, type ClosingDateView, type FormQuestion, type IntakeDraftSummary } from "../../packages/contracts/src/index";
import {
  applyByOf, closingDateLine, closingDateProblem, countWords, draftRow, formQuestionFacts, headerActions, jobFacts, jobHref, jobRow, jobTabFrom, jobTabs, placeWords, postBox, postPlaceholder,
  recordFacts, shareRefresh, statusTone,
} from "../../apps/web/src/jobs";
import { jobCounts, jobPacket, jobSummary } from "./job-fixture";

/**
 * The Jobs page and a job's own page (its header, its Job tab and its Share tab): what each lays out from what the API
 * sends. Every status word, count and allowed action is the API's (`roleActions`, used here as the API uses it).
 */
const now = new Date(2026, 10, 18, 15, 0);

describe("where a job opens, and its status", () => {
  it("opens a published job on its Candidates, and a draft on the job itself", () => {
    for (const status of ["open", "paused", "closed"] as const) expect(jobHref(jobSummary("r1", status)), status).toBe("/roles/r1/talent");
    expect(jobHref(jobSummary("r1", "draft"))).toBe("/roles/r1");
    // a job closed before it was ever published has no candidates to open
    expect(jobHref(jobSummary("r1", "closed", { openedAt: null }))).toBe("/roles/r1");
  });

  it("colours the status dot green only for an open job; the word beside it is the API's", () => {
    expect((["draft", "open", "paused", "closed"] as const).map(statusTone)).toEqual(["neutral", "good", "caution", "neutral"]);
  });
});

describe("a row of the Jobs page", () => {
  it("shows the title, the API's status word, where the job is, when it was published, how long it has been open and its people tab by tab", () => {
    const row = jobRow(jobSummary("r1", "open", { openedAt: new Date(2026, 10, 10, 9).toISOString(), counts: jobCounts({ new: 3, shortlisted: 2, interviewed: 1, hired: 1, not_selected: 4 }) }), now);
    expect(row).toEqual({ id: "r1", title: "Dental Assistant", href: "/roles/r1/talent", statusLabel: "Open", tone: "good", facts: ["Irvine, CA", "Published Nov 10", "8 days open"], counts: ["11 applicants", "3 new", "2 shortlisted", "1 interviewed", "1 hired"] });
  });

  it("says where the job is in the API's own words, and nothing for a job that names no place", () => {
    const openedAt = new Date(2026, 10, 10, 9).toISOString();
    expect(jobRow(jobSummary("r1", "open", { openedAt, place: "Remote, US" }), now).facts).toEqual(["Remote, US", "Published Nov 10", "8 days open"]);
    expect(jobRow(jobSummary("r1", "open", { openedAt, place: null }), now).facts).toEqual(["Published Nov 10", "8 days open"]);
  });

  it("says a job opened today, one day, and the day to apply by", () => {
    expect(jobRow(jobSummary("r1", "open", { daysOpen: 0 }), now).facts).toContain("Opened today");
    expect(jobRow(jobSummary("r1", "open", { daysOpen: 1 }), now).facts).toContain("1 day open");
    expect(jobRow(jobSummary("r1", "open", { closesOn: "2026-11-30" }), now).facts.at(-1)).toBe("Apply by November 30, 2026");
  });

  it("shows a draft with the day it was created and no counts, and a closed job with the day it closed", () => {
    const draft = jobRow(jobSummary("r1", "draft", { createdAt: new Date(2026, 10, 8, 9).toISOString() }), now);
    expect(draft).toMatchObject({ href: "/roles/r1", statusLabel: "Draft", tone: "neutral", facts: ["Irvine, CA", "Created Nov 8"], counts: [] });
    const closed = jobRow(jobSummary("r1", "closed", { openedAt: new Date(2026, 10, 10, 9).toISOString(), closedAt: new Date(2026, 10, 17, 9).toISOString(), closesOn: "2026-11-30" }), now);
    expect(closed.facts).toEqual(["Irvine, CA", "Published Nov 10", "Closed Nov 17"]);
  });

  it("counts everyone who applied, each tab that has someone, and the people the plan keeps locked", () => {
    expect(countWords(jobCounts())).toEqual(["No applicants yet"]);
    expect(countWords(jobCounts({ new: 1 }))).toEqual(["1 applicant", "1 new"]);
    expect(countWords(jobCounts({ new: 2 }, 3))).toEqual(["5 applicants", "2 new", "3 locked"]);
    // Not selected is not said on the row: the total already counts them
    expect(countWords(jobCounts({ not_selected: 4 }))).toEqual(["4 applicants"]);
  });
});

describe("a draft's row", () => {
  /** A draft with no pay yet and no must-have: two essentials missing, and nothing to confirm. */
  const draft = (over: Partial<IntakeDraftSummary> = {}): IntakeDraftSummary => ({ id: "s1", status: "active", title: "Front Desk Lead", startedBy: { userId: "u1", name: "A Teammate" }, mine: true, createdAt: "", updatedAt: new Date(2026, 10, 16, 9).toISOString(), ownerMessages: 2, hasDraft: false, missing: ["compensation_range", "must_haves"], payConfirmed: false, ...over });

  it("continues in the job builder, says when it last changed and how much is still needed", () => {
    expect(draftRow(draft(), now)).toEqual({ id: "s1", title: "Front Desk Lead", href: "/roles/new?session=s1", facts: ["Last changed Nov 16", "2 things still needed"] });
    expect(draftRow(draft({ missing: ["must_haves"], payConfirmed: true }), now).facts.at(-1)).toBe("1 thing still needed");
    expect(draftRow(draft({ missing: [], payConfirmed: true, hasDraft: true }), now).facts.at(-1)).toBe("Written");
    expect(draftRow(draft({ missing: [], payConfirmed: true, hasDraft: false }), now).facts).toEqual(["Last changed Nov 16"]);
  });

  it("counts pay that is stated and that nobody has confirmed as still needed, as the builder lists it when the draft is opened", () => {
    // a pasted ad stated the pay, and every essential is in: the row no longer reads as ready while the builder asks for the pay to be confirmed
    expect(draftRow(draft({ missing: [], payConfirmed: false }), now).facts).toEqual(["Last changed Nov 16", "1 thing still needed"]);
    expect(draftRow(draft({ missing: ["must_haves"], payConfirmed: false }), now).facts.at(-1)).toBe("2 things still needed");
    // pay that is missing altogether is one thing, not two
    expect(draftRow(draft({ missing: ["compensation_range"], payConfirmed: false }), now).facts.at(-1)).toBe("1 thing still needed");
    // the row counts what the contracts' one answer lists, whatever the draft
    for (const d of [draft(), draft({ missing: [], payConfirmed: false }), draft({ missing: ["schedule"], payConfirmed: true })]) {
      const n = draftStillNeeds(d).length;
      expect(draftRow(d, now).facts.at(-1)).toBe(`${n} ${n === 1 ? "thing" : "things"} still needed`);
    }
  });

  it("names who started a teammate's draft, and calls a draft with no title yet Untitled job", () => {
    expect(draftRow(draft({ mine: false }), now).facts[0]).toBe("Started by A Teammate");
    expect(draftRow(draft({ mine: false, startedBy: { userId: null, name: null } }), now).facts[0]).toBe("Started by someone on your team");
    expect(draftRow(draft({ title: null }), now).title).toBe("Untitled job");
    expect(draftRow(draft({ title: "  " }), now).title).toBe("Untitled job");
  });
});

describe("a job's header and tabs", () => {
  it("lists Candidates first, then Job and Share, each its own address; Candidates carries how many applied once known", () => {
    expect(jobTabs("r1", jobCounts({ new: 3, hired: 1 }))).toEqual([
      { id: "candidates", label: "Candidates", href: "/roles/r1/talent", count: 4 },
      { id: "job", label: "Job", href: "/roles/r1" },
      { id: "share", label: "Share", href: "/roles/r1?tab=share" },
    ]);
    expect(jobTabs("r1", null)[0]).toEqual({ id: "candidates", label: "Candidates", href: "/roles/r1/talent" });
  });

  it("opens Share for ?tab=share and the Job tab for anything else, so an older link still lands", () => {
    expect(jobTabFrom("share")).toBe("share");
    for (const other of [null, undefined, "", "job", "posting", "report", "activity", "plan"]) expect(jobTabFrom(other)).toBe("job");
  });

  it("says where, the work arrangement, the type and the pay in one line, with the day to apply by", () => {
    expect(jobFacts(jobPacket())).toEqual(["Irvine, CA", "On site", "Full time", "$24–$28 an hour"]);
    expect(jobFacts(jobPacket(), "Apply by Monday, November 30, 2026").at(-1)).toBe("Apply by Monday, November 30, 2026");
    expect(jobFacts(null)).toEqual([]);
    expect(placeWords({ city: "Irvine", region: "CA", country: "US" })).toBe("Irvine, CA");
    expect(placeWords({ label: "Remote, US", country: "US" })).toBe("Remote, US");
    expect(placeWords({ region: "CA", country: "US" })).toBe("CA");
    expect(placeWords(undefined)).toBe("");
  });

  it("carries the API's Apply by line while a date is set and the job is not closed", () => {
    const closing = { closesOn: "2026-11-30", applyBy: "Apply by Monday, November 30, 2026" };
    expect(applyByOf(closing, "open")).toBe("Apply by Monday, November 30, 2026");
    expect(applyByOf(closing, "closed")).toBeNull();
    expect(applyByOf({ closesOn: null, applyBy: null }, "open")).toBeNull();
    expect(applyByOf({ closesOn: "2026-11-30", applyBy: null }, "paused")).toBe("Apply by November 30, 2026");
    expect(applyByOf(null, "open")).toBeNull();
  });

  it("lays the API's actions out: Publish job and Edit as buttons, the rest in one menu, in the API's order", () => {
    const open = headerActions(roleActions({ status: "open", role: "owner", trialEnded: false }));
    expect(open.publish).toBeNull();
    expect(open.edit).toMatchObject({ action: "edit", label: "Edit", allowed: true });
    expect(open.menu.map((a) => a.label)).toEqual(["Pause", "Closing date", "Close job"]);
    const paused = headerActions(roleActions({ status: "paused", role: "admin", trialEnded: false }));
    expect(paused.menu.map((a) => a.label)).toEqual(["Resume", "Closing date", "Close job"]);
    const draft = headerActions(roleActions({ status: "draft", role: "hiring_manager", trialEnded: false }));
    expect(draft.publish).toMatchObject({ label: "Publish job", allowed: true });
  });

  it("keeps an action the person may not take in the menu, greyed, with the API's reason; one the API does not list is not drawn", () => {
    const member = headerActions(roleActions({ status: "open", role: "hiring_manager", trialEnded: false }));
    expect(member.menu.map((a) => [a.label, a.allowed, a.reason])).toEqual([["Pause", false, ROLE_ACTION_BLOCKED.ownerOrAdmin], ["Closing date", false, ROLE_ACTION_BLOCKED.ownerOrAdmin], ["Close job", false, ROLE_ACTION_BLOCKED.ownerOrAdmin]]);
    // a closed job: nothing in the menu at all, and Edit greyed with why
    const closed = headerActions(roleActions({ status: "closed", role: "owner", trialEnded: false }));
    expect(closed.menu).toEqual([]);
    expect(closed.publish).toBeNull();
    expect(closed.edit).toMatchObject({ allowed: false, reason: ROLE_ACTION_BLOCKED.closed });
    // a trial that ended holds Publish and Resume, in the API's words
    expect(headerActions(roleActions({ status: "draft", role: "owner", trialEnded: true })).publish).toMatchObject({ allowed: false, reason: ROLE_ACTION_BLOCKED.trialEnded });
    expect(headerActions([])).toEqual({ publish: null, edit: null, menu: [] });
  });
});

describe("the job record on the Job tab", () => {
  it("lists the facts as label and value, leaving out what is not set", () => {
    expect(recordFacts(jobPacket(), { shown: true, requiredByLaw: false })).toEqual([
      { label: "Where", value: "Irvine, CA" },
      { label: "Work arrangement", value: "On site" },
      { label: "Type", value: "Full time" },
      { label: "Schedule", value: "Weekdays, 8 to 5" },
      { label: "Department", value: "Clinical" },
      { label: "Pay", value: "$24–$28 an hour" },
      { label: "Pay on the job page", value: "Shown" },
      { label: "Benefits", value: "Health, dental and paid time off" },
    ]);
  });

  it("says when the pay is not shown, and when the law shows it whatever was chosen", () => {
    const hidden = jobPacket({ compensation: { basis: "hourly", min: 24, max: 28, discloseRange: false } });
    const value = (rows: Array<{ label: string; value: string }>) => rows.find((r) => r.label === "Pay on the job page")?.value;
    expect(value(recordFacts(hidden, { shown: false, requiredByLaw: false }))).toBe("Not shown");
    expect(value(recordFacts(hidden, { shown: true, requiredByLaw: true }))).toBe("Shown: the law where this job is requires it");
    // a draft says what was chosen
    expect(value(recordFacts(hidden))).toBe("Not shown");
    expect(recordFacts(hidden).some((r) => r.label === "Benefits")).toBe(false);
  });

  it("says a draft's pay is not set yet", () => {
    const { compensation: _pay, ...noPay } = jobPacket();
    const rows = recordFacts(noPay as never);
    expect(rows.find((r) => r.label === "Pay")?.value).toBe("Not set yet");
    expect(rows.some((r) => r.label === "Pay on the job page")).toBe(false);
  });

  it("says in a few words how each screening question is answered", () => {
    const [yesNo, choice, number] = jobPacket().formQuestions as FormQuestion[];
    expect(formQuestionFacts(yesNo)).toBe("Yes or no");
    expect(formQuestionFacts(choice)).toBe("Choice: Days · Evenings · optional");
    expect(formQuestionFacts(number)).toBe("Number (years)");
  });
});

describe("the closing date", () => {
  const view = (over: Partial<ClosingDateView>): ClosingDateView => ({ closesOn: null, closesAt: null, applyBy: null, timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false, ...over });

  it("is said in one line: none, the day to apply by, or that it has passed and applications stopped", () => {
    expect(closingDateLine(view({}))).toBe("No closing date");
    expect(closingDateLine(view({ closesOn: "2026-11-30", applyBy: "Apply by Monday, November 30, 2026" }))).toBe("Apply by Monday, November 30, 2026");
    expect(closingDateLine(view({ closesOn: "2026-11-30" }))).toBe("Apply by November 30, 2026");
    expect(closingDateLine(view({ closesOn: "2026-11-10", passed: true, applicationsClosedByDate: true }))).toBe("The closing date, November 10, 2026, has passed. New applications have stopped.");
  });

  it("takes today or a later day, on the company's calendar", () => {
    // 9:30 in the evening of 18 November in Los Angeles, already the 19th in New York and on a device set to UTC
    const lateEvening = new Date("2026-11-19T05:30:00.000Z");
    const pacific = "America/Los_Angeles";
    expect(closingDateProblem("2026-11-18", pacific, lateEvening)).toBeNull();
    expect(closingDateProblem("2026-12-01", pacific, lateEvening)).toBeNull();
    expect(closingDateProblem("2026-11-17", pacific, lateEvening)).toBe("Choose today or a later date.");
    expect(closingDateProblem("", pacific, lateEvening)).toBe("Choose a date.");
    // the company's zone decides what "today" is, never the device's: the same moment, a company in New York
    expect(closingDateProblem("2026-11-18", "America/New_York", lateEvening)).toBe("Choose today or a later date.");
    expect(closingDateProblem("2026-11-19", "America/New_York", lateEvening)).toBeNull();
  });
});

describe("the Share tab", () => {
  it("asks again every few seconds only while the posts are being written", () => {
    expect(shareRefresh({ state: "writing" })).toBe(4000);
    for (const state of ["ready", "no_ai", "failed", null] as const) expect(shareRefresh({ state })).toBe(false);
    expect(shareRefresh(undefined)).toBe(false);
  });

  it("keeps what a person types in a post's box until they save it, and offers Save only for words that differ", () => {
    const post = { text: "We are hiring a dental assistant." };
    expect(postBox(post, undefined)).toEqual({ text: "We are hiring a dental assistant.", dirty: false, empty: false });
    expect(postBox(post, "We are hiring a dental assistant.  ")).toMatchObject({ dirty: false });
    expect(postBox(post, "Join our practice.")).toEqual({ text: "Join our practice.", dirty: true, empty: false });
    // nothing to copy from an empty box
    expect(postBox(post, "  ")).toEqual({ text: "  ", dirty: true, empty: true });
    expect(postBox({ text: null }, undefined)).toEqual({ text: "", dirty: false, empty: true });
  });

  it("says in an empty box that the post is on its way, or that it is the person's to write", () => {
    expect(postPlaceholder("writing")).toBe("Being written…");
    for (const state of ["ready", "no_ai", "failed", null] as const) expect(postPlaceholder(state)).toBe("Write your post here");
  });
});
