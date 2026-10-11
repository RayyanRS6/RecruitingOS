import { describe, expect, it } from "vitest";
import { NOTIFY_GROUPS } from "@ros/contracts";
import { digestCadencesDue, digestTimeZone, digestWindow, lastDigestAt, nextDigestAt } from "./notify-digest";
import { alertHeadline, alertLink, interviewIdFromHref, renderAlertEmail, renderDigestEmail, roleIdFromHref } from "./notify-email";
import { NOTIFY_ALWAYS, NOTIFY_GROUP_INFO, belongsInDigest, cadencesFor, notifyGroupOf, resolveNotifyCadence } from "./notify-groups";

/**
 * Email alerts (plan B3): which group an update belongs to, how a person's settings resolve, the kinds nobody can turn
 * off, when the morning summaries fall in each company's time zone, and the words of the emails, which never carry a
 * candidate's name or details.
 */
describe("notification preferences", () => {
  it("sorts every kind into a group, new kinds by their first word", () => {
    expect(notifyGroupOf("approval.requested")).toBe("approvals");
    expect(notifyGroupOf("message.approval_requested")).toBe("approvals");
    expect(notifyGroupOf("candidate.recommended")).toBe("candidates");
    expect(notifyGroupOf("application.ready")).toBe("candidates");
    expect(notifyGroupOf("interview.decision")).toBe("interviews");
    expect(notifyGroupOf("calendar.needs_attention")).toBe("interviews");
    expect(notifyGroupOf("stuck.candidates_waiting")).toBe("stuck");
    expect(notifyGroupOf("volume.high")).toBe("stuck");
    expect(notifyGroupOf("recruiter.resolved")).toBe("recruiter");
    expect(notifyGroupOf("message.sent")).toBe("messages");
    expect(notifyGroupOf("candidate.unreachable")).toBe("messages");
    expect(notifyGroupOf("company.verified")).toBe("account");
    // kinds added later land somewhere sensible
    expect(notifyGroupOf("recruiter.replied")).toBe("recruiter");
    expect(notifyGroupOf("interview.moved_by_robot")).toBe("interviews");
    expect(notifyGroupOf("something.brand_new")).toBe("account");
  });

  it("uses the product's defaults until a person chooses: what waits on you at once, the rest in the morning", () => {
    expect(cadencesFor({})).toEqual({ approvals: "immediate", candidates: "daily", interviews: "immediate", stuck: "daily", recruiter: "immediate", messages: "daily", account: "immediate" });
    expect(resolveNotifyCadence("approval.requested", {})).toEqual({ group: "approvals", cadence: "immediate", always: false, emailNow: true });
    expect(resolveNotifyCadence("candidate.recommended", {})).toEqual({ group: "candidates", cadence: "daily", always: false, emailNow: false });
    for (const g of NOTIFY_GROUPS) expect(NOTIFY_GROUP_INFO[g].label.length).toBeGreaterThan(3);
  });

  it("follows a person's own choice for each group, and only that group", () => {
    const mine = { candidates: "immediate", approvals: "off", interviews: "weekly" } as const;
    expect(resolveNotifyCadence("candidate.recommended", mine)).toMatchObject({ cadence: "immediate", emailNow: true });
    expect(resolveNotifyCadence("approval.requested", mine)).toMatchObject({ cadence: "off", emailNow: false });
    expect(resolveNotifyCadence("interview.decision", mine)).toMatchObject({ cadence: "weekly", emailNow: false });
    expect(resolveNotifyCadence("recruiter.resolved", mine)).toMatchObject({ cadence: "immediate", emailNow: true });
    expect(cadencesFor(mine)).toMatchObject({ candidates: "immediate", approvals: "off", interviews: "weekly", stuck: "daily" });
  });

  it("describes each group by what is really sorted into it", () => {
    // calendar updates go with interviews, so that is where turning them off works
    expect(notifyGroupOf("calendar.needs_attention")).toBe("interviews");
    expect(NOTIFY_GROUP_INFO.interviews.description).toContain("calendar");
    expect(NOTIFY_GROUP_INFO.account.description).not.toContain("calendar");
    // a recruiter writing back is in the recruiter group, and its description says so
    expect(notifyGroupOf("recruiter.replied")).toBe("recruiter");
    expect(NOTIFY_GROUP_INFO.recruiter.description).toContain("wrote to you");
  });

  it("never sends an email of its own for an update the people involved already got one for, or a test", () => {
    expect(resolveNotifyCadence("interview.confirmed", {})).toMatchObject({ group: "interviews", cadence: "immediate", emailNow: false });
    expect(resolveNotifyCadence("test.named", { account: "immediate" })).toMatchObject({ emailNow: false });
    // it still counts in a summary for someone who gets interviews daily
    expect(belongsInDigest("interview.confirmed", { interviews: "daily" }, ["daily"])).toBe(true);
  });

  it("puts an update in a summary only when its group's cadence is due", () => {
    expect(belongsInDigest("candidate.recommended", {}, ["daily"])).toBe(true);
    expect(belongsInDigest("candidate.recommended", { candidates: "weekly" }, ["daily"])).toBe(false);
    expect(belongsInDigest("candidate.recommended", { candidates: "weekly" }, ["daily", "weekly"])).toBe(true);
    expect(belongsInDigest("candidate.recommended", { candidates: "off" }, ["daily", "weekly"])).toBe(false);
    expect(belongsInDigest("approval.requested", {}, ["daily", "weekly"])).toBe(false);
  });
});

describe("updates nobody can turn off", () => {
  const everythingOff = Object.fromEntries(NOTIFY_GROUPS.map((g) => [g, "off"]));

  it("are a recruiter given access, ITS confirming the company or taking it back, a candidate asking for a person, and an eligibility hold waiting", () => {
    expect([...NOTIFY_ALWAYS.keys()].sort()).toEqual(["application.ineligible_hold", "application.ineligible_review_due", "company.unverified", "company.verified", "recruiter.access_granted", "recruiter.claimed", "screen.human_requested"]);
    for (const a of NOTIFY_ALWAYS.values()) {
      expect(a.label.length).toBeGreaterThan(10);
      expect(a.why.length).toBeGreaterThan(10);
    }
  });

  it("go out at once even when every group is off, and are never held for a summary", () => {
    for (const kind of NOTIFY_ALWAYS.keys()) {
      expect(resolveNotifyCadence(kind, everythingOff)).toMatchObject({ cadence: "immediate", always: true, emailNow: true });
      expect(belongsInDigest(kind, {}, ["daily", "weekly"])).toBe(false);
    }
    // the group they belong to is still turned off for everything else in it
    expect(resolveNotifyCadence("candidate.recommended", everythingOff)).toMatchObject({ emailNow: false });
  });
});

describe("summary times in each company's time zone", () => {
  const at = (iso: string) => new Date(iso);
  // Thursday 8 October 2026, 11:30 UTC
  const now = at("2026-10-08T11:30:00Z");

  it("falls at 8:00 local time, wherever the company is", () => {
    // Los Angeles (UTC-7 in October): 04:30 local, so the last summary was yesterday's and the next is today's
    expect(lastDigestAt(now, "America/Los_Angeles").toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(nextDigestAt(now, "America/Los_Angeles").toISOString()).toBe("2026-10-08T15:00:00.000Z");
    // New York (UTC-4): 07:30 local
    expect(lastDigestAt(now, "America/New_York").toISOString()).toBe("2026-10-07T12:00:00.000Z");
    expect(nextDigestAt(now, "America/New_York").toISOString()).toBe("2026-10-08T12:00:00.000Z");
    // London (UTC+1): 12:30 local, so today's has gone out
    expect(lastDigestAt(now, "Europe/London").toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(nextDigestAt(now, "Europe/London").toISOString()).toBe("2026-10-09T07:00:00.000Z");
    // Tokyo (UTC+9): 20:30 local
    expect(lastDigestAt(now, "Asia/Tokyo").toISOString()).toBe("2026-10-07T23:00:00.000Z");
    expect(nextDigestAt(now, "Asia/Tokyo").toISOString()).toBe("2026-10-08T23:00:00.000Z");
  });

  it("counts exactly 8:00 as the summary's own time: the last one is now, the next one tomorrow", () => {
    const eight = at("2026-10-08T15:00:00Z");
    expect(lastDigestAt(eight, "America/Los_Angeles").toISOString()).toBe(eight.toISOString());
    expect(nextDigestAt(eight, "America/Los_Angeles").toISOString()).toBe("2026-10-09T15:00:00.000Z");
  });

  it("covers the local day before the summary: 7:59 is in this morning's, 8:01 waits for tomorrow's", () => {
    const w = digestWindow(at("2026-10-08T15:00:00Z"), "America/Los_Angeles", "daily");
    expect(w).toEqual({ from: at("2026-10-07T15:00:00Z"), to: at("2026-10-08T15:00:00Z") });
    const inside = (iso: string) => at(iso) >= w.from && at(iso) < w.to;
    expect(inside("2026-10-08T14:59:00Z")).toBe(true);
    expect(inside("2026-10-08T15:01:00Z")).toBe(false);
    // the same instants belong to different summaries in New York
    const ny = digestWindow(at("2026-10-08T12:00:00Z"), "America/New_York", "daily");
    expect(at("2026-10-08T14:59:00Z") >= ny.to).toBe(true);
  });

  it("keeps 8:00 across a daylight-saving change: the day is 25 hours long in November and 23 in March", () => {
    const fallBack = digestWindow(at("2026-11-01T16:00:00Z"), "America/Los_Angeles", "daily");
    expect(fallBack.from.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect((fallBack.to.getTime() - fallBack.from.getTime()) / 3_600_000).toBe(25);
    expect(nextDigestAt(at("2026-10-31T16:00:00Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-01T16:00:00.000Z");
    const springForward = digestWindow(at("2027-03-14T15:00:00Z"), "America/Los_Angeles", "daily");
    expect(springForward.from.toISOString()).toBe("2027-03-13T16:00:00.000Z");
    expect((springForward.to.getTime() - springForward.from.getTime()) / 3_600_000).toBe(23);
  });

  it("sends the weekly summary on Monday morning in the company's own zone, covering the week before", () => {
    // Monday 12 October 2026, 8:00 in Los Angeles
    expect(digestCadencesDue(at("2026-10-12T15:00:00Z"), "America/Los_Angeles")).toEqual(["daily", "weekly"]);
    expect(digestCadencesDue(at("2026-10-13T15:00:00Z"), "America/Los_Angeles")).toEqual(["daily"]);
    // Monday 8:00 in Tokyo is still Sunday in UTC; it is Monday where the company is
    expect(digestCadencesDue(at("2026-10-11T23:00:00Z"), "Asia/Tokyo")).toEqual(["daily", "weekly"]);
    expect(digestCadencesDue(at("2026-10-11T23:00:00Z"), "America/Los_Angeles")).toEqual(["daily"]);
    expect(digestWindow(at("2026-10-12T15:00:00Z"), "America/Los_Angeles", "weekly")).toEqual({ from: at("2026-10-05T15:00:00Z"), to: at("2026-10-12T15:00:00Z") });
  });

  it("falls back to the business time zone for a zone the runtime does not know", () => {
    expect(digestTimeZone("Not/AZone")).toBe("America/Los_Angeles");
    expect(digestTimeZone(null)).toBe("America/Los_Angeles");
    expect(nextDigestAt(now, "Not/AZone").toISOString()).toBe("2026-10-08T15:00:00.000Z");
  });
});

describe("the words of an email alert", () => {
  const roleId = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b";
  const appId = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c";
  // what the in-app update says, which no email may repeat
  const update = { title: "Maria Reyes is ready to interview", body: "Strong screen. Maria (maria.reyes@example.com, 555-0100) has 6 years at Coastal Family Dentistry." };
  const leaks = ["Maria", "Reyes", "maria.reyes@example.com", "555-0100", "Coastal Family Dentistry", update.title, "Strong screen"];

  it("says what happened, where and for which role, and links to it, and nothing about the candidate", () => {
    const email = renderAlertEmail({ kind: "candidate.recommended", recipientName: "Dana Whitfield", companyName: "Harbor Dental Group", roleTitle: "Dental Hygienist", link: alertLink("https://app.example.test", `/roles/${roleId}/talent?open=${appId}`), appBaseUrl: "https://app.example.test" });
    expect(email.subject).toBe("A candidate is ready for your decision: Dental Hygienist");
    expect(email.text).toContain("Hi Dana,");
    expect(email.text).toContain("Company: Harbor Dental Group");
    expect(email.text).toContain("Role: Dental Hygienist");
    expect(email.text).toContain(`Open it: https://app.example.test/roles/${roleId}/talent?open=${appId}`);
    expect(email.text).toContain("https://app.example.test/setup#setup-notifications");
    expect(email.text).toContain("Candidate names and details are never put in emails");
    for (const leak of leaks) {
      expect(email.subject).not.toContain(leak);
      expect(email.text).not.toContain(leak);
    }
  });

  it("says why an always-sent update cannot be turned off", () => {
    const email = renderAlertEmail({ kind: "screen.human_requested", recipientName: null, companyName: "Harbor Dental Group", roleTitle: null, link: "https://app.example.test/updates", appBaseUrl: "https://app.example.test" });
    expect(email.subject).toBe("A candidate asked to talk to a person");
    expect(email.text.startsWith("Hi,")).toBe(true);
    expect(email.text).toContain("This email is always sent");
    expect(email.text).not.toContain("Role:");
  });

  it("has a headline for every kind, its group's when it has none of its own", () => {
    expect(alertHeadline("recruiter.claimed")).toBe("An ITS recruiter now has access to your hiring");
    expect(alertHeadline("interview.something_new")).toBe("There is news about an interview");
    expect(alertHeadline("whatever.else")).toBe("There is news about your account");
  });

  it("links only into the app", () => {
    expect(alertLink("https://app.example.test/", "/interviews/x")).toBe("https://app.example.test/interviews/x");
    expect(alertLink("https://app.example.test", "https://elsewhere.example/phish")).toBe("https://app.example.test/updates");
    expect(alertLink("https://app.example.test", "//elsewhere.example")).toBe("https://app.example.test/updates");
    expect(alertLink("https://app.example.test", null)).toBe("https://app.example.test/updates");
    expect(roleIdFromHref(`/roles/${roleId}/talent?open=${appId}`)).toBe(roleId);
    expect(roleIdFromHref(`/roles/${roleId}?tab=posting`)).toBe(roleId);
    expect(roleIdFromHref("/roles/not-an-id")).toBeNull();
    expect(roleIdFromHref("/talent")).toBeNull();
    expect(interviewIdFromHref(`/interviews/${appId}`)).toBe(appId);
  });

  it("summarises by group and role with counts, never a title or a name", () => {
    const other = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a7d";
    const email = renderDigestEmail({
      recipientName: "Dana Whitfield",
      companyName: "Harbor Dental Group",
      appBaseUrl: "https://app.example.test",
      weekly: false,
      items: [
        { kind: "candidate.recommended", roleId, roleTitle: "Dental Hygienist" },
        { kind: "application.needs_review", roleId, roleTitle: "Dental Hygienist" },
        { kind: "application.ready", roleId: other, roleTitle: "Front Desk Coordinator" },
        { kind: "stuck.no_applicants", roleId: other, roleTitle: "Front Desk Coordinator" },
        { kind: "company.verified", roleId: null, roleTitle: null },
      ],
    });
    expect(email.subject).toBe("Harbor Dental Group: your daily summary (5 new updates)");
    expect(email.text).toContain("Candidates: 3");
    expect(email.text).toContain(`- Dental Hygienist: 2  https://app.example.test/roles/${roleId}/talent`);
    expect(email.text).toContain(`- Front Desk Coordinator: 1  https://app.example.test/roles/${other}/talent`);
    expect(email.text).toContain("Roles that need attention: 1");
    expect(email.text).toContain(`- Front Desk Coordinator: 1  https://app.example.test/roles/${other}`);
    expect(email.text).toContain("Your account: 1");
    expect(email.text).toContain("- Not about one role: 1  https://app.example.test/updates");
    expect(email.text.indexOf("Candidates: 3")).toBeLessThan(email.text.indexOf("Roles that need attention: 1"));
    for (const leak of leaks) expect(email.text).not.toContain(leak);
    expect(renderDigestEmail({ recipientName: null, companyName: "Harbor Dental Group", appBaseUrl: "https://app.example.test", weekly: true, items: [{ kind: "message.sent", roleId: null, roleTitle: null }] }).subject).toBe("Harbor Dental Group: your weekly summary (1 new update)");
  });
});
