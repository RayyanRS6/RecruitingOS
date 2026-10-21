import { describe, expect, it } from "vitest";
import {
  activityWords, aiStatusWords, exactMoney, exactWhen, money, planStatusWords, planWords, plainCode, privacyStatusWords, runStatusWords, severityWords, STEP_STATUS_WORDS, trialWords, verificationWords, whenWords, workflowWords,
} from "../../apps/web/src/pages/admin/admin-words";

/** The ITS console's plain words (redesign spec 3.3), one file every console section imports (Wave S6, S6-0). */
describe("the console's plain words", () => {
  it("names statuses, severities and verification in plain words", () => {
    expect(["running", "waiting", "failed", "completed"].map(runStatusWords)).toEqual(["Running", "Waiting", "Failed", "Done"]);
    expect(["critical", "warning", "info"].map(severityWords)).toEqual(["Urgent", "Check soon", "For your information"]);
    expect(["received", "in_progress", "awaiting_counsel", "fulfilled", "declined"].map(privacyStatusWords)).toEqual(["New", "In progress", "Waiting for counsel", "Done", "Declined"]);
    expect(["pending", "verified_by_link", "verified_manual", "failed"].map(verificationWords)).toEqual(["Not checked yet", "Verified", "Verified", "Could not verify"]);
  });

  it("names plans and workflows, and never shows an unknown code raw", () => {
    expect(planWords("design_partner")).toBe("Design Partner");
    expect(planStatusWords("design_partner")).toBe("Design Partner pilot");
    expect(planStatusWords("trial")).toBe("Trial");
    expect(workflowWords("application_intake")).toBe("Reading a new application");
    expect(workflowWords("screen")).toBe("AI interview");
    // a key nobody mapped yet reads as words, never with underscores
    expect(workflowWords("candidate_follow_up")).toBe("Candidate follow up");
    expect(runStatusWords("cancelled")).toBe("Cancelled");
    expect(plainCode("in_progress")).toBe("in progress");
    // a code that happens to name an object property is still just a code
    expect(workflowWords("constructor")).toBe("Constructor");
  });

  it("writes money to the cent, and says so when it is under a cent", () => {
    expect(money(4.1)).toBe("$4.10");
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(0)).toBe("$0.00");
    expect(money(0.004)).toBe("less than $0.01");
    expect(money(0.006)).toBe("$0.01");
    expect(exactMoney(0.04)).toBe("$0.0400");
    expect(exactMoney(0.0123, 5)).toBe("$0.01230");
  });

  it("says today, yesterday and days ago for the last week, then the date", () => {
    const now = new Date(2026, 9, 15, 15, 0);
    expect(whenWords(new Date(2026, 9, 15, 9, 0).toISOString(), now)).toBe("today");
    expect(whenWords(new Date(2026, 9, 14, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(whenWords(new Date(2026, 9, 13, 8, 0).toISOString(), now)).toBe("2 days ago");
    expect(whenWords(new Date(2026, 9, 3, 8, 0).toISOString(), now)).toBe("Oct 3");
    expect(whenWords(new Date(2025, 11, 30, 8, 0).toISOString(), now)).toBe("Dec 30, 2025");
    expect(whenWords(null, now)).toBe("");
    expect(exactWhen(new Date(2026, 9, 14, 15, 10).toISOString())).toBe("Oct 14, 2026, 3:10 PM");
  });

  it("keeps the console's churn rule: quiet after 7 days, no activity after 14 or never", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    expect(activityWords(ago(2), now)).toEqual({ state: "active", label: "active", tone: "good" });
    expect(activityWords(ago(9), now)).toEqual({ state: "quiet", label: "quiet 9d", tone: "caution" });
    expect(activityWords(ago(20), now)).toEqual({ state: "none", label: "no activity 20d", tone: "critical" });
    expect(activityWords(null, now).state).toBe("none");
    // never active reads in words, never as "no activity 999d"
    expect(activityWords(null, now)).toEqual({ state: "none", label: "never active", tone: "critical" });
  });

  it("names AI-run and step statuses the same on every screen", () => {
    expect(["ok", "refused", "error", "invalid_output"].map(aiStatusWords)).toEqual(["OK", "Refused", "Provider error", "Answer not usable"]);
    expect(STEP_STATUS_WORDS).toEqual({ ok: "done", error: "failed" });
  });

  it("says where a Trial customer's 30 days stand, on the company's calendar (founder decision L-02 B)", () => {
    const standing = { started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 20, endingSoon: false, ended: false, extendedDays: 0 };
    expect(trialWords(standing, "America/Los_Angeles")).toBe("ends Oct 31");
    expect(trialWords({ ...standing, endingSoon: true, daysLeft: 3 }, "America/Los_Angeles")).toBe("ends Oct 31");
    expect(trialWords({ ...standing, ended: true, daysLeft: 0 }, "America/Los_Angeles")).toBe("ended Oct 31, paused");
    expect(trialWords({ ...standing, started: false, startedAt: null, endsAt: null, daysLeft: null })).toBe("starts at the ITS check");
    expect(trialWords(null)).toBe("");
  });
});
