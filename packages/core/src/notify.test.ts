import { describe, expect, it } from "vitest";
import { ALWAYS_EMAILED, ALWAYS_EMAILED_LINE, NotificationKind, emailsUpdate } from "@ros/contracts";
import { alertHeadline, alertLink, renderAlertEmail, roleIdFromHref } from "./notify-email";

/**
 * Emails about updates: who is emailed (one switch per person, account notices always), and the words of the email,
 * which never carry a candidate's name or details.
 */
describe("who is emailed about an update", () => {
  it("follows the person's one switch, and always emails an account notice", () => {
    expect(emailsUpdate("screen.completed", true)).toBe(true);
    expect(emailsUpdate("screen.completed", false)).toBe(false);
    expect(emailsUpdate("candidate.withdrawn", false)).toBe(false);
    for (const kind of ALWAYS_EMAILED) {
      expect(emailsUpdate(kind, false), kind).toBe(true);
      expect(emailsUpdate(kind, true), kind).toBe(true);
    }
  });
});

describe("the words of an email about an update", () => {
  const roleId = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a5b";
  const appId = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c";
  // what the in-app update says, which no email may repeat
  const update = { title: "Maria Reyes finished the AI interview", body: "Maria (maria.reyes@example.com, 555-0100) has 6 years at Coastal Family Dentistry." };
  const leaks = ["Maria", "Reyes", "maria.reyes@example.com", "555-0100", "Coastal Family Dentistry", update.title];

  it("says what happened, where and for which job, and links to it, and nothing about the candidate", () => {
    const email = renderAlertEmail({ kind: "screen.completed", recipientName: "Dana Whitfield", companyName: "Harbor Dental Group", roleTitle: "Dental Hygienist", link: alertLink("https://app.example.test", `/roles/${roleId}/talent?open=${appId}`), appBaseUrl: "https://app.example.test" });
    expect(email.subject).toBe("A candidate finished the AI interview: Dental Hygienist");
    expect(email.text).toContain("Hi Dana,");
    expect(email.text).toContain("Company: Harbor Dental Group");
    expect(email.text).toContain("Job: Dental Hygienist");
    expect(email.text).toContain(`Open it: https://app.example.test/roles/${roleId}/talent?open=${appId}`);
    expect(email.text).toContain('You get this email because "Email me updates" is on. Turn it off in Settings: https://app.example.test/setup');
    expect(email.text).toContain("Candidate names and details are never put in emails");
    for (const leak of leaks) {
      expect(email.subject).not.toContain(leak);
      expect(email.text).not.toContain(leak);
    }
  });

  it("says an account notice is always emailed, and offers no switch for it", () => {
    const email = renderAlertEmail({ kind: "company.plan_changed", recipientName: null, companyName: "Harbor Dental Group", roleTitle: null, link: "https://app.example.test/updates", appBaseUrl: "https://app.example.test" });
    expect(email.subject).toBe("ITS changed your plan");
    expect(email.text.startsWith("Hi,")).toBe(true);
    expect(email.text).toContain(ALWAYS_EMAILED_LINE);
    expect(email.text).not.toContain("Turn it off");
    expect(email.text).not.toContain("Job:");
  });

  it("has a headline of its own for every kind of update made now, and a plain one for any other", () => {
    const headlines = NotificationKind.options.map((kind) => alertHeadline(kind));
    for (const h of headlines) expect(h).not.toBe("There is an update for you");
    expect(new Set(headlines).size).toBe(headlines.length);
    expect(alertHeadline("company.plan_changed")).toBe("ITS changed your plan");
    expect(alertHeadline("whatever.else")).toBe("There is an update for you");
  });

  it("links only into the app", () => {
    expect(alertLink("https://app.example.test/", `/roles/${roleId}`)).toBe(`https://app.example.test/roles/${roleId}`);
    expect(alertLink("https://app.example.test", "https://elsewhere.example/phish")).toBe("https://app.example.test/updates");
    expect(alertLink("https://app.example.test", "//elsewhere.example")).toBe("https://app.example.test/updates");
    expect(alertLink("https://app.example.test", null)).toBe("https://app.example.test/updates");
    expect(roleIdFromHref(`/roles/${roleId}/talent?open=${appId}`)).toBe(roleId);
    expect(roleIdFromHref(`/roles/${roleId}?tab=share`)).toBe(roleId);
    expect(roleIdFromHref("/roles/not-an-id")).toBeNull();
    expect(roleIdFromHref("/talent")).toBeNull();
  });
});
