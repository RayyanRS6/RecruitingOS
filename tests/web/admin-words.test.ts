import { describe, expect, it } from "vitest";
import { aiStatusWords, codeWords, exactMoney, exactWhen, money, plainCode, privacyStatusWords, reasonReady, severityWords, trialWords, verificationWords, whenWords, workflowWords } from "../../apps/web/src/pages/admin/admin-words";
import { partOf } from "../../apps/web/src/pages/admin/admin-api";

/** The admin dashboard's plain words, one file every section of it imports. */
describe("the dashboard's plain words", () => {
  it("names severities, privacy statuses and verification in plain words", () => {
    expect(["critical", "warning", "info"].map(severityWords)).toEqual(["Urgent", "Check soon", "For your information"]);
    expect(["received", "in_progress", "awaiting_counsel", "fulfilled", "declined"].map(privacyStatusWords)).toEqual(["New", "In progress", "Waiting for counsel", "Done", "Declined"]);
    expect(["pending", "verified_by_link", "verified_manual", "failed"].map(verificationWords)).toEqual(["Not checked yet", "Verified", "Verified", "Could not verify"]);
  });

  it("names the workflows that remain, and never shows an unknown code raw", () => {
    expect(workflowWords("application_intake")).toBe("Reading a new application");
    expect(workflowWords("screen")).toBe("AI interview");
    expect(workflowWords("role_closing_date")).toBe("Closing date");
    // a key nobody mapped reads as words, never with underscores
    expect(workflowWords("candidate_follow_up")).toBe("Candidate follow up");
    expect(plainCode("in_progress")).toBe("in progress");
    expect(codeWords("intake.turn")).toBe("Intake turn");
    expect(codeWords("read_resume")).toBe("Read resume");
    expect(codeWords(null)).toBe("");
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
    // a plain space before PM, whatever the runtime's own formatting puts there
    expect(exactWhen(new Date(2026, 9, 14, 15, 10).toISOString())).toBe("Oct 14, 2026, 3:10 PM");
  });

  it("names how an AI run that was not OK ended", () => {
    expect(["ok", "running", "refused", "error", "invalid_output"].map(aiStatusWords)).toEqual(["OK", "Running", "Refused", "Provider error", "Answer not usable"]);
  });

  it("says where a company's trial stands, on the company's calendar; nothing off the Trial plan or before it started", () => {
    const standing = { started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 20, endingSoon: false, ended: false, extendedDays: 0 };
    expect(trialWords(standing, "America/Los_Angeles")).toBe("ends Oct 31");
    expect(trialWords({ ...standing, endingSoon: true, daysLeft: 3 }, "America/Los_Angeles")).toBe("ends Oct 31");
    expect(trialWords({ ...standing, ended: true, daysLeft: 0 }, "America/Los_Angeles")).toBe("ended Oct 31, paused");
    expect(trialWords({ ...standing, started: false, startedAt: null, endsAt: null, daysLeft: null })).toBe("");
    expect(trialWords(null)).toBe("");
  });

  it("needs a reason of five characters or more with a change", () => {
    expect(reasonReady("why")).toBe(false);
    expect(reasonReady("  Owner asked  ")).toBe(true);
  });
});

describe("a section's parts", () => {
  it("shows the part the address names, and the first part for one it does not know", () => {
    const parts = [{ id: "health", label: "Health" }, { id: "costs", label: "Costs" }];
    expect(partOf(parts, "costs")).toBe("costs");
    expect(partOf(parts, null)).toBe("health");
    expect(partOf(parts, "workflows")).toBe("health");
  });
});
