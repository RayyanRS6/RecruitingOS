import { describe, expect, it } from "vitest";
import type { RolePacket } from "@ros/contracts";
import { addCalendarDays, applyByLabel, closingDateProblem, closingDateView, closingMoment, companyToday, defaultClosingDate } from "./closing-date";
import { PAY_TRANSPARENCY_CANDIDATES, PAY_TRANSPARENCY_JURISDICTIONS, benefitsDescriptionFor, closingDateRequired, jobJurisdictions, postingLegalCheck } from "./compliance";
import { chosenBoards, defaultBoards, publishChannelsFor, showsOldVersion, zipRecruiterOffered } from "./postings";
import { boardPostingOf, isPostingTask, postingTaskLabel } from "./posting-tasks";

/**
 * Approving and publishing (plan Wave D), the pure parts: the boards a role uses (Q11), the closing date in the
 * company's own time zone (Q12), the legal check before approval (D5) and the ITS posting task words (D3).
 */
describe("the boards a role uses (founder decision Q11, plan D6)", () => {
  const packet = (channels: string[]) => ({ sourcing: { channels } }) as unknown as Pick<RolePacket, "sourcing">;

  it("defaults to the boards the role plan names, ZipRecruiter only with the company's own plan; the careers page, Google and email always", () => {
    expect(defaultBoards(packet(["careers_page", "google_jobs", "indeed", "referrals"]), {})).toEqual(["indeed"]);
    expect(defaultBoards(packet(["linkedin_basic", "indeed", "ziprecruiter"]), {})).toEqual(["linkedin_basic", "indeed"]);
    expect(defaultBoards(packet(["linkedin_basic", "indeed", "ziprecruiter"]), { zipRecruiterPlan: true })).toEqual(["linkedin_basic", "indeed", "ziprecruiter"]);
    expect(zipRecruiterOffered({ zipRecruiterPlan: "yes" })).toBe(false);
    expect(publishChannelsFor({ publishChannels: null }, packet(["indeed"]), {})).toEqual(["careers_page", "google_jobs", "email_in", "indeed"]);
  });

  it("a person's ticks win over the role plan, in the Posting tab's order, and never bring ZipRecruiter without the plan", () => {
    expect(chosenBoards({ publishChannels: ["indeed", "linkedin_basic"] }, packet(["indeed"]), {})).toEqual(["linkedin_basic", "indeed"]);
    expect(chosenBoards({ publishChannels: [] }, packet(["indeed"]), {})).toEqual([]);
    expect(chosenBoards({ publishChannels: ["ziprecruiter"] }, packet([]), {})).toEqual([]);
    expect(chosenBoards({ publishChannels: ["ziprecruiter", "careers_page"] }, packet([]), { zipRecruiterPlan: true })).toEqual(["ziprecruiter"]);
    expect(publishChannelsFor({ publishChannels: [] }, packet(["indeed"]), {})).toEqual(["careers_page", "google_jobs", "email_in"]);
  });

  it("says which board listings still show an older version", () => {
    expect(showsOldVersion({ channel: "indeed", status: "live_verified", boardVersion: 1 }, 2)).toBe(true);
    expect(showsOldVersion({ channel: "indeed", status: "live_verified", boardVersion: 2 }, 2)).toBe(false);
    expect(showsOldVersion({ channel: "indeed", status: "ready_to_post", boardVersion: 1 }, 2)).toBe(false); // not up anywhere
    expect(showsOldVersion({ channel: "indeed", status: "live_verified", boardVersion: null }, 2)).toBe(false); // unknown
    expect(showsOldVersion({ channel: "careers_page", status: "live_verified", boardVersion: 1 }, 2)).toBe(false); // the job page itself
  });
});

describe("ITS posting tasks (plan D3)", () => {
  it("ITS posts unless the company chose to post itself; the task words name the board", () => {
    expect(boardPostingOf({})).toBe("its");
    expect(boardPostingOf(null)).toBe("its");
    expect(boardPostingOf({ boardPosting: "self" })).toBe("self");
    expect(isPostingTask("post_job")).toBe(true);
    expect(isPostingTask("take_down_job")).toBe(true);
    expect(isPostingTask("review")).toBe(false);
    expect(postingTaskLabel("post_job", "Indeed")).toBe("Post the job on Indeed");
    expect(postingTaskLabel("update_job", "LinkedIn")).toBe("Update the job on LinkedIn");
    expect(postingTaskLabel("take_down_job", "ZipRecruiter")).toBe("Take the job down from ZipRecruiter");
  });
});

describe("the closing date (founder decision Q12, plan D7)", () => {
  it("applications stop at the end of the closing day in the company's own time zone, across daylight saving", () => {
    // Pacific daylight time: midnight is 07:00 UTC the next day
    expect(closingMoment("2026-10-08", "America/Los_Angeles").toISOString()).toBe("2026-10-09T07:00:00.000Z");
    // the day daylight saving ends there (1 November 2026): the next midnight is standard time, 08:00 UTC
    expect(closingMoment("2026-11-01", "America/Los_Angeles").toISOString()).toBe("2026-11-02T08:00:00.000Z");
    // the day it starts (8 March 2026): the next midnight is daylight time again
    expect(closingMoment("2026-03-08", "America/Los_Angeles").toISOString()).toBe("2026-03-09T07:00:00.000Z");
    // the end of a month and of a year roll over
    expect(closingMoment("2026-12-31", "America/New_York").toISOString()).toBe("2027-01-01T05:00:00.000Z");
    // a zone east of UTC, with no daylight saving
    expect(closingMoment("2026-10-08", "Asia/Kolkata").toISOString()).toBe("2026-10-08T18:30:00.000Z");
    // an unknown zone falls back to the business default instead of failing
    expect(closingMoment("2026-10-08", "Mars/Olympus").toISOString()).toBe("2026-10-09T07:00:00.000Z");
  });

  it("today and the default date are the company's, not UTC's; a past date is refused", () => {
    const lateEvening = new Date("2026-10-09T05:30:00.000Z"); // 22:30 on 8 October in California
    expect(companyToday(lateEvening, "America/Los_Angeles")).toBe("2026-10-08");
    expect(companyToday(lateEvening, "UTC")).toBe("2026-10-09");
    expect(defaultClosingDate(lateEvening, "America/Los_Angeles")).toBe("2026-11-07");
    expect(addCalendarDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(closingDateProblem("2026-10-08", lateEvening, "America/Los_Angeles")).toBeNull();
    expect(closingDateProblem("2026-10-07", lateEvening, "America/Los_Angeles")).toMatch(/today or a later date/);
    expect(applyByLabel("2026-10-30")).toBe("Apply by Friday, October 30, 2026");
  });

  it("describes the date for the pages: the moment, the line, the default a Colorado role gets, and whether the date stopped applications", () => {
    const now = new Date("2026-10-08T19:00:00.000Z");
    const open = { applicationsCloseOn: "2026-10-30", acceptingApplications: true, applicationsClosedReason: null, status: "open" };
    expect(closingDateView({ role: open, timeZone: "America/Los_Angeles", requiredByLaw: false, now })).toEqual({ closesOn: "2026-10-30", closesAt: "2026-10-31T07:00:00.000Z", applyBy: "Apply by Friday, October 30, 2026", timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false });
    const none = closingDateView({ role: { ...open, applicationsCloseOn: null }, timeZone: "America/Denver", requiredByLaw: true, now });
    expect(none).toMatchObject({ closesOn: null, applyBy: null, defaultIfMissing: "2026-11-07", requiredByLaw: true });
    const stopped = closingDateView({ role: { ...open, applicationsCloseOn: "2026-10-01", acceptingApplications: false, applicationsClosedReason: "closing date" }, timeZone: "America/Los_Angeles", requiredByLaw: false, now });
    expect(stopped).toMatchObject({ passed: true, applicationsClosedByDate: true });
  });
});

describe("the legal check before approval (plan D5; counsel confirms the lists)", () => {
  const packet = (locations: Array<{ city?: string; region?: string }>, extra: { remotePolicy?: string; min?: number; max?: number; benefitsSummary?: string } = {}) => ({
    identity: { locations: locations.map((l) => ({ ...l, country: "US" })), remotePolicy: extra.remotePolicy ?? "onsite" },
    compensation: { min: extra.min ?? 60000, max: extra.max ?? 70000, benefitsSummary: extra.benefitsSummary },
  });
  const today = "2026-10-08";

  it("a California role needs the pay range only; a missing range blocks", () => {
    expect(postingLegalCheck({ packet: packet([{ city: "Irvine", region: "CA" }]), today }).items.map((i) => [i.key, i.met])).toEqual([["pay_range", true]]);
    const noPay = postingLegalCheck({ packet: packet([{ city: "Irvine", region: "CA" }], { min: 0, max: 0 }), today });
    expect(noPay.missing.map((m) => m.key)).toEqual(["pay_range"]);
    expect(noPay.missing[0].detail).toMatch(/California/);
    // a place without such a law asks nothing of the ad
    expect(postingLegalCheck({ packet: packet([{ city: "Austin", region: "TX" }]), today }).items).toEqual([]);
  });

  it("a Colorado role needs the benefits described (the role's own or the company's) and a closing date, which it gets by default", () => {
    const co = postingLegalCheck({ packet: packet([{ city: "Denver", region: "CO" }]), defaultClosesOn: "2026-11-07", today });
    expect(co.missing.map((m) => m.key)).toEqual(["benefits"]);
    expect(co.items.find((i) => i.key === "closing_date")).toMatchObject({ met: true, blocking: true });
    // dates in words, as everywhere else the product writes one
    expect(co.items.find((i) => i.key === "closing_date")!.detail).toMatch(/gets Saturday, November 7 as its closing date/);
    expect(postingLegalCheck({ packet: packet([{ city: "Denver", region: "CO" }], { benefitsSummary: "Health, dental, 401(k)." }), defaultClosesOn: "2026-11-07", today }).missing).toEqual([]);
    expect(postingLegalCheck({ packet: packet([{ city: "Denver", region: "CO" }]), companySettings: { benefitsSummary: "Health and dental." }, closesOn: "2026-10-31", today }).missing).toEqual([]);
    // a closing date in the past is missing again
    const past = postingLegalCheck({ packet: packet([{ city: "Denver", region: "CO" }]), companySettings: { benefitsSummary: "Health." }, closesOn: "2026-10-01", today });
    expect(past.missing.map((m) => m.key)).toEqual(["closing_date"]);
    expect(past.missing[0].detail).toMatch(/^The closing date, Thursday, October 1, has passed\./);
    expect(benefitsDescriptionFor({ benefitsSummary: "  " }, { benefitsSummary: "Company plan" })).toBe("Company plan");
    expect(benefitsDescriptionFor(null, null)).toBeNull();
  });

  it("a remote job answers to every place with a pay transparency law, and the places pending counsel never block", () => {
    const remote = postingLegalCheck({ packet: packet([{ city: "Austin", region: "TX" }], { remotePolicy: "remote" }), defaultClosesOn: "2026-11-07", today });
    expect(remote.remote).toBe(true);
    for (const j of PAY_TRANSPARENCY_JURISDICTIONS) expect(remote.jurisdictions).toContain(j);
    expect(remote.missing.map((m) => m.key)).toEqual(["benefits"]);
    expect(remote.items.find((i) => i.key === "benefits")!.detail).toMatch(/remote job could be done there/);
    expect(closingDateRequired({ jobLocations: [{ city: "Austin", region: "TX", country: "US" }], remotePolicy: "remote" })).toBe(true);
    expect(closingDateRequired({ jobLocations: [{ city: "Austin", region: "TX", country: "US" }], remotePolicy: "onsite" })).toBe(false);
    // Washington DC and Rhode Island are candidates for the list, pending counsel: named, never blocking, not in the notice
    expect(PAY_TRANSPARENCY_CANDIDATES.map((c) => c.jurisdiction)).toEqual(["US-DC", "US-RI"]);
    expect(PAY_TRANSPARENCY_CANDIDATES.every((c) => c.pendingCounsel)).toBe(true);
    expect(PAY_TRANSPARENCY_JURISDICTIONS).not.toContain("US-DC");
    const dc = postingLegalCheck({ packet: packet([{ city: "Washington", region: "DC" }], { min: 0, max: 0 }), today });
    expect(dc.items).toHaveLength(1);
    expect(dc.items[0]).toMatchObject({ key: "pay_range", met: false, blocking: false, pendingCounsel: ["US-DC"] });
    expect(dc.missing).toEqual([]);
    expect(jobJurisdictions({ jobLocations: [{ city: "Providence", region: "RI", country: "US" }] })).toEqual(["US-RI"]);
  });
});
