import { describe, expect, it } from "vitest";
import { activeCompanyOf, RAIL_ROLE_LIMIT, railCompact, railListsRoles, railRoles, teamRoleWord } from "../../apps/web/src/rail";
import { ROLE_STATUS, roleStatus } from "../../apps/web/src/role-status";

/**
 * The left rail (Wave DS): which roles are listed under Roles and how they read to a screen reader, when the rail folds
 * to icons, and the words for the signed-in person's role in the company chip.
 */
const role = (id: string, status: string, total = 0, createdAt = "2026-10-01T00:00:00Z") => ({ id, title: `Role ${id}`, status, createdAt, counts: { total } });

describe("the roles under Roles", () => {
  it("lists open roles first with their applicants, then paused, waiting and drafts; never filled or closed ones", () => {
    const list = railRoles([role("d", "draft"), role("c", "closed", 9), role("p", "paused", 4), role("o", "open", 6), role("f", "filled", 3), role("w", "pending_approval")], { role: "owner" });
    expect(list.map((r) => r.id)).toEqual(["o", "p", "w", "d"]);
    expect(list[0]).toEqual({ id: "o", title: "Role o", live: true, applicants: 6, statusWord: "open, 6 applicants", tag: null });
    // a paused or draft role gets the grey dot and no count, and a word in its place, so the colour never says it alone
    expect(list.slice(1).every((r) => !r.live && r.applicants === null)).toBe(true);
    expect(list.map((r) => r.tag)).toEqual([null, "Paused", "Waiting", "Draft"]);
    expect(list.map((r) => r.statusWord)).toEqual(["open, 6 applicants", "paused", "waiting for approval", "draft"]);
    expect(railRoles([role("o", "open", 1)], { role: "owner" })[0].statusWord).toBe("open, 1 applicant");
  });

  it("puts the newest first within a status and stops at eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => role(`r${i}`, "open", i, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    const list = railRoles(many, { role: "admin" });
    expect(list).toHaveLength(RAIL_ROLE_LIMIT);
    expect(list[0].id).toBe("r11");
    expect(list.at(-1)!.id).toBe("r4");
  });

  it("never counts applicants for an interviewer, whose list the API already limits to the roles they interview for", () => {
    const fromApi = [{ ...role("b", "open"), countsHidden: true }];
    // with no count, the open role says "Open" beside its green dot: an interviewer's paused role reads "Paused"
    expect(railRoles(fromApi, { role: "interviewer" })).toEqual([{ id: "b", title: "Role b", live: true, applicants: null, statusWord: "open", tag: "Open" }]);
    expect(railRoles([{ ...role("p", "paused"), countsHidden: true }], { role: "interviewer" })[0].tag).toBe("Paused");
    // a count is never shown to an interviewer, and never from a list that says its counts were left out
    expect(railRoles([role("a", "open", 5)], { role: "interviewer" })[0].applicants).toBeNull();
    expect(railRoles(fromApi, { role: "owner" })[0].applicants).toBeNull();
  });

  it("is empty when there is nothing in progress", () => {
    expect(railRoles([], { role: "owner" })).toEqual([]);
    expect(railRoles([role("c", "closed")], { role: "owner" })).toEqual([]);
  });
});

describe("the rail's shape", () => {
  it("folds to icons on a role's own pages only", () => {
    expect(railCompact("/roles/9f1c")).toBe(true);
    expect(railCompact("/roles/9f1c/talent")).toBe(true);
    expect(railCompact("/roles")).toBe(false);
    expect(railCompact("/roles/")).toBe(false);
    expect(railCompact("/")).toBe(false);
    expect(railCompact("/talent")).toBe(false);
    expect(railCompact(null)).toBe(false);
  });

  it("lists the company's roles only for a member, never for an ITS recruiter under a grant", () => {
    const member = { activeCompanyId: "co1", memberships: [{ companyId: "co1", companyName: "Bright Dental", role: "owner" }], staffAccess: null };
    const staff = { activeCompanyId: "co1", memberships: [], staffAccess: { companyName: "Bright Dental" } };
    const elsewhere = { activeCompanyId: "co2", memberships: [{ companyId: "co1", companyName: "Bright Dental", role: "owner" }], staffAccess: null };
    expect(railListsRoles(member)).toBe(true);
    expect(railListsRoles(staff)).toBe(false);
    expect(railListsRoles(elsewhere)).toBe(false);
    expect(railListsRoles({ activeCompanyId: null, memberships: [], staffAccess: null })).toBe(false);
    expect(railListsRoles(null)).toBe(false);
    expect(activeCompanyOf(member)).toEqual({ name: "Bright Dental", role: "owner", member: true });
    expect(activeCompanyOf(staff)).toEqual({ name: "Bright Dental", role: null, member: false });
    expect(activeCompanyOf(undefined)).toEqual({ name: null, role: null, member: false });
  });

  it("names the person's role in plain words, and an ITS recruiter's limited access", () => {
    expect(teamRoleWord("owner", false)).toBe("Owner");
    expect(teamRoleWord("hiring_manager", false)).toBe("Hiring manager");
    expect(teamRoleWord("hr", false)).toBe("HR");
    expect(teamRoleWord(null, true)).toBe("ITS recruiter, limited access");
    expect(teamRoleWord(null, false)).toBeNull();
  });
});

describe("a role's status pill", () => {
  it("has a word for every status, green only for open and filled, never a raw status name", () => {
    for (const [status, s] of Object.entries(ROLE_STATUS)) {
      expect(s.label, status).not.toMatch(/_/);
      expect(s.tone === "good", status).toBe(status === "open" || status === "filled");
    }
    expect(roleStatus("pending_approval").label).toBe("Waiting for approval");
    expect(roleStatus("something_new")).toEqual({ label: "something new", tone: "neutral" });
  });
});
