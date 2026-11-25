import { describe, expect, it } from "vitest";
import { MembershipRole, isOwnerOrAdmin } from "@ros/contracts";
import { dedupeKey, normalizePhone } from "./dedupe";
import { can } from "./permissions";
import { noticesFor, resolveJurisdictions } from "./compliance";
import { ENDED_RUN } from "./workflow-runs";

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
    for (const p of ["company.read", "role.read", "role.create", "packet.edit", "role.publish", "application.read", "application.act", "plan.request"] as const) {
      for (const role of ["owner", "admin", "hiring_manager"] as const) expect(can(role, p), `${role} ${p}`).toBe(true);
    }
    for (const p of ["role.manage", "company.update", "members.manage"] as const) {
      expect(can("owner", p), p).toBe(true);
      expect(can("admin", p), p).toBe(true);
      expect(can("hiring_manager", p), p).toBe(false);
    }
    // nobody without a team role may do any of it: someone signed out, or a role the product no longer has
    expect(can(null, "role.read")).toBe(false);
    expect(can(undefined, "company.read")).toBe(false);
    expect(can("recruiter" as never, "application.read")).toBe(false);
  });

  it("gives the three managing permissions to exactly the roles the contracts call an owner or an admin", () => {
    for (const role of MembershipRole.options) {
      for (const p of ["role.manage", "company.update", "members.manage"] as const) expect(can(role, p), `${role} ${p}`).toBe(isOwnerOrAdmin(role));
    }
  });
});

describe("a workflow run that has ended", () => {
  it("is completed, failed or cancelled, the one list the engine and every other reader share", () => {
    expect([...ENDED_RUN]).toEqual(["completed", "failed", "cancelled"]);
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
