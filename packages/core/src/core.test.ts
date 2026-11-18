import { describe, expect, it } from "vitest";
import { dedupeKey, normalizePhone } from "./dedupe";
import { can } from "./permissions";
import { noticesFor, resolveJurisdictions } from "./compliance";

describe("dedupe", () => {
  it("normalizes gmail dots and plus suffixes", () => {
    expect(dedupeKey("Jane.Doe+jobs@Gmail.com", null)).toBe("email:janedoe@gmail.com");
    expect(dedupeKey("Jane.Doe+jobs@example.com", null)).toBe("email:jane.doe@example.com");
  });
  it("falls back to phone", () => {
    expect(dedupeKey(null, "(949) 555-0100")).toBe("phone:+19495550100");
    expect(normalizePhone("1 949 555 0100")).toBe("+19495550100");
  });
});

describe("permissions", () => {
  it("a member builds, edits and publishes jobs and acts on candidates; only an owner or an admin manages jobs, the company and its people", () => {
    for (const p of ["role.create", "packet.edit", "role.publish", "application.read", "application.act", "application.reject", "compensation.read", "plan.request"] as const) {
      for (const role of ["owner", "admin", "hiring_manager"] as const) expect(can(role, p), `${role} ${p}`).toBe(true);
    }
    for (const p of ["role.manage", "company.update", "members.manage"] as const) {
      expect(can("owner", p), p).toBe(true);
      expect(can("admin", p), p).toBe(true);
      expect(can("hiring_manager", p), p).toBe(false);
    }
    expect(can(null, "role.read")).toBe(false);
  });
});

describe("compliance", () => {
  it("resolves jurisdictions and picks notices", () => {
    const j = resolveJurisdictions([{ country: "US", region: "CA" }], "NV");
    expect(j).toEqual(["US-CA", "US-NV"]);
    const keys = noticesFor(j).map((n) => n.key);
    expect(keys).toContain("ai_use");
    expect(keys).toContain("pay_transparency");
    expect(keys).not.toContain("adverse_decision_explanation");
  });
});
