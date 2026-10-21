import { describe, expect, it } from "vitest";
import { ALLOWANCE_ASK, allowanceAlerts, allowanceChip, allowanceLevel, screeningAllowanceWarning } from "../../apps/web/src/allowance";

/**
 * The plan's monthly screening conversations (founder decision Q17): the owner and ITS are warned at 80%; when they run
 * out nothing is refused, and new applicants get the conversation link by email once more are added.
 */
describe("where the month's conversations stand", () => {
  it("warns at 80% (the same line as the API's), and says used up at the limit", () => {
    expect(allowanceLevel(39, 50)).toBeNull();
    expect(allowanceLevel(40, 50)).toBe("warning");
    expect(allowanceLevel(49, 50)).toBe("warning");
    expect(allowanceLevel(50, 50)).toBe("used_up");
    expect(allowanceLevel(51, 50)).toBe("used_up");
    // 80% of 25 is 20; of 3 it rounds up to 3, which is the limit itself
    expect(allowanceLevel(20, 25)).toBe("warning");
    expect(allowanceLevel(2, 3)).toBeNull();
    // no limit, or none set, is never a warning
    expect(allowanceLevel(1000, null)).toBeNull();
    expect(allowanceLevel(5, 0)).toBeNull();
  });
});

describe("Today's card for owners", () => {
  it("is nothing under 80%, or with no screening conversations in the plan", () => {
    expect(screeningAllowanceWarning({ text_screens: { used: 10, limit: 150 } })).toBeNull();
    expect(screeningAllowanceWarning({ active_roles: { used: 3, limit: 3 } })).toBeNull();
    expect(screeningAllowanceWarning(undefined)).toBeNull();
  });

  it("at 80% says nothing has stopped, and that ITS knows", () => {
    const w = screeningAllowanceWarning({ text_screens: { used: 120, limit: 150 } });
    expect(w).toMatchObject({ level: "warning", used: 120, limit: 150, title: "120 of this month's 150 AI interviews used" });
    expect(w?.body).toMatch(/^Nothing has stopped\./);
    expect(w?.body).toMatch(/ITS has been told/);
  });

  it("used up, says applications are still accepted and the link follows by email, so everyone gets the same steps", () => {
    const w = screeningAllowanceWarning({ text_screens: { used: 150, limit: 150 } }, "starter");
    expect(w?.title).toBe("This month's AI interviews are used up");
    expect(w?.body).toMatch(/Applications are still accepted/);
    expect(w?.body).toMatch(/chat link by email as soon as more are added/);
    expect(w?.body).toMatch(/same steps/);
  });

  it("for a Design Partner pilot, says the conversation keeps being offered", () => {
    expect(screeningAllowanceWarning({ text_screens: { used: 25, limit: 25 } }, "design_partner")?.body).toMatch(/Your pilot keeps offering the chat to everyone/);
  });

  it("asks ITS about the plan, never a counted recruiter request", () => {
    expect(ALLOWANCE_ASK).toMatchObject({ kind: "ask", about: "all", topic: "plan" });
  });
});

describe("the ITS console", () => {
  const alert = (kind: string, companyId: string | null, createdAt: string, details: Record<string, unknown> = {}, status = "open") => ({ kind, companyId, status, details, createdAt });

  it("keeps the most serious allowance alert for each company, and ignores the rest", () => {
    const map = allowanceAlerts([
      alert("billing.screens_warning", "co1", "2026-10-01T10:00:00.000Z", { used: 40, limit: 50 }),
      alert("billing.screens_used_up", "co1", "2026-10-05T10:00:00.000Z", { used: 50, limit: 50 }, "acknowledged"),
      alert("billing.screens_warning", "co2", "2026-10-03T10:00:00.000Z", { used: 120, limit: 150 }),
      alert("billing.screens_warning", "co3", "2026-10-03T10:00:00.000Z", {}, "resolved"),
      alert("billing.recruiter_asks_over", "co4", "2026-10-03T10:00:00.000Z"),
      alert("billing.screens_warning", null, "2026-10-03T10:00:00.000Z"),
    ]);
    expect([...map.keys()].sort()).toEqual(["co1", "co2"]);
    expect(map.get("co1")).toEqual({ companyId: "co1", level: "used_up", used: 50, limit: 50, since: "2026-10-05T10:00:00.000Z" });
    expect(allowanceChip(map.get("co1")!)).toBe("AI interviews used up (50 of 50)");
    expect(allowanceChip(map.get("co2")!)).toBe("80% of AI interviews used (120 of 150)");
    expect(allowanceChip({ level: "warning", used: null, limit: null })).toBe("80% of AI interviews used");
  });
});
