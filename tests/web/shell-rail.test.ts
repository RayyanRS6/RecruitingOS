import { describe, expect, it } from "vitest";
import { COMPANY_LINKS, activeCompanyOf, otherCompanies, railCompact, teamRoleWord, unreadBadge } from "../../apps/web/src/rail";

/**
 * The side rail's decisions: a company's four places, when the rail folds to icons, the words for the signed-in
 * person's role in the company chip, the companies they can switch to, and how the count of unread updates reads.
 */
describe("a company's places", () => {
  it("are Home, Jobs, Candidates and Settings, in that order, and nothing else", () => {
    expect(COMPANY_LINKS.map((l) => [l.label, l.to])).toEqual([["Home", "/"], ["Jobs", "/roles"], ["Candidates", "/talent"], ["Settings", "/setup"]]);
    // Home is the current link on Home alone; the others on every page under them
    expect(COMPANY_LINKS.map((l) => l.end)).toEqual([true, false, false, false]);
    for (const gone of ["Interviews", "Recruiter", "Updates", "Today"]) expect(COMPANY_LINKS.some((l) => (l.label as string) === gone), gone).toBe(false);
  });
});

describe("the rail's shape", () => {
  it("folds to icons on a job's own pages and in the job builder only", () => {
    expect(railCompact("/roles/9f1c")).toBe(true);
    expect(railCompact("/roles/9f1c/talent")).toBe(true);
    expect(railCompact("/roles/new")).toBe(true);
    expect(railCompact("/roles")).toBe(false);
    expect(railCompact("/roles/")).toBe(false);
    expect(railCompact("/")).toBe(false);
    expect(railCompact("/talent")).toBe(false);
    expect(railCompact("/setup")).toBe(false);
    expect(railCompact(null)).toBe(false);
  });

  it("knows the company the person is working in and their role in it", () => {
    const member = { activeCompanyId: "co1", memberships: [{ companyId: "co1", companyName: "Bright Dental", role: "owner" }] };
    const elsewhere = { activeCompanyId: "co2", memberships: [{ companyId: "co1", companyName: "Bright Dental", role: "owner" }] };
    expect(activeCompanyOf(member)).toEqual({ name: "Bright Dental", role: "owner", member: true });
    expect(activeCompanyOf(elsewhere)).toEqual({ name: null, role: null, member: false });
    expect(activeCompanyOf({ activeCompanyId: null, memberships: [] })).toEqual({ name: null, role: null, member: false });
    expect(activeCompanyOf(undefined)).toEqual({ name: null, role: null, member: false });
  });

  it("names the person's role in the three words Settings uses", () => {
    expect(teamRoleWord("owner")).toBe("Owner");
    expect(teamRoleWord("admin")).toBe("Admin");
    expect(teamRoleWord("hiring_manager")).toBe("Member");
    // a role that no longer exists has no word, never its raw name
    expect(teamRoleWord("interviewer")).toBeNull();
    expect(teamRoleWord(null)).toBeNull();
  });
});

describe("the company switcher's choices", () => {
  const m = (companyId: string, companyName: string, role = "owner") => ({ companyId, companyName, role });

  it("lists every other company the person works in, by name, and nothing for one company", () => {
    const me = { activeCompanyId: "c2", memberships: [m("c1", "Zephyr Dental", "admin"), m("c2", "Bright Dental"), m("c3", "Alpine Clinic", "hiring_manager")] };
    expect(otherCompanies(me)).toEqual([{ companyId: "c3", companyName: "Alpine Clinic", role: "hiring_manager" }, { companyId: "c1", companyName: "Zephyr Dental", role: "admin" }]);
    expect(otherCompanies({ activeCompanyId: "c2", memberships: [m("c2", "Bright Dental")] })).toEqual([]);
    expect(otherCompanies(null)).toEqual([]);
  });
});

describe("the count of unread updates", () => {
  it("draws the figure and says it in the link's name; nothing at zero or before it is known", () => {
    expect(unreadBadge(3)).toEqual({ text: "3", spoken: "Updates, 3 unread" });
    expect(unreadBadge(0)).toEqual({ text: null, spoken: "Updates" });
    expect(unreadBadge(undefined)).toEqual({ text: null, spoken: "Updates" });
    expect(unreadBadge(null)).toEqual({ text: null, spoken: "Updates" });
  });

  it("draws at most 99+, and still says the real number", () => {
    expect(unreadBadge(99)).toEqual({ text: "99", spoken: "Updates, 99 unread" });
    expect(unreadBadge(250)).toEqual({ text: "99+", spoken: "Updates, 250 unread" });
    expect(unreadBadge(-2)).toEqual({ text: null, spoken: "Updates" });
  });
});
