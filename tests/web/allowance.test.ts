import { describe, expect, it } from "vitest";
import { allowanceAlerts, allowanceChip } from "../../apps/web/src/allowance";

/**
 * The alerts about a company's monthly AI interviews as the admin console reads them: 80% of the plan's allowance, and
 * used up. (A company reads its own standing in Settings' Plan section and in Home's notices, in the server's words.)
 */
describe("the ITS console", () => {
  const alert = (kind: string, companyId: string | null, createdAt: string, details: Record<string, unknown> = {}, status = "open") => ({ kind, companyId, status, details, createdAt });

  it("keeps the most serious allowance alert for each company, and ignores the rest", () => {
    const map = allowanceAlerts([
      alert("billing.screens_warning", "co1", "2026-10-01T10:00:00.000Z", { used: 40, limit: 50 }),
      alert("billing.screens_used_up", "co1", "2026-10-05T10:00:00.000Z", { used: 50, limit: 50 }, "acknowledged"),
      alert("billing.screens_warning", "co2", "2026-10-03T10:00:00.000Z", { used: 120, limit: 150 }),
      alert("billing.screens_warning", "co3", "2026-10-03T10:00:00.000Z", {}, "resolved"),
      alert("billing.ai_credit_warning", "co4", "2026-10-03T10:00:00.000Z"),
      alert("billing.screens_warning", null, "2026-10-03T10:00:00.000Z"),
    ]);
    expect([...map.keys()].sort()).toEqual(["co1", "co2"]);
    expect(map.get("co1")).toEqual({ companyId: "co1", level: "used_up", used: 50, limit: 50, since: "2026-10-05T10:00:00.000Z" });
    const [first, second] = [map.get("co1"), map.get("co2")];
    expect(first && allowanceChip(first)).toBe("AI interviews used up (50 of 50)");
    expect(second && allowanceChip(second)).toBe("80% of AI interviews used (120 of 150)");
    expect(allowanceChip({ level: "warning", used: null, limit: null })).toBe("80% of AI interviews used");
  });
});
