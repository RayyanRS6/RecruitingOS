import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canSeeActivity, canStartHire } from "../../apps/web/src/roles";
import { setupSections } from "../../apps/web/src/setup-sections";

/**
 * Setup's section menu (plan I1): every card on the page has an id the menu jumps to, in the page's order, and the
 * menu leaves out the cards a role does not get (the shortcut for those who cannot start a hire, the audit history for
 * interviewers).
 */
const page = readFileSync(new URL("../../apps/web/src/pages/Setup.tsx", import.meta.url), "utf8");

describe("Setup's section menu", () => {
  it("names every card on the page, in the page's order", () => {
    const onPage = [...page.matchAll(/<Section id="([^"]+)"/g)].map((m) => m[1]);
    expect(onPage).toEqual(setupSections({ mayStartHire: true, seesAudit: true }).map((s) => s.id));
    expect(new Set(onPage).size).toBe(onPage.length);
  });

  it("leaves out what a role does not see", () => {
    const ids = (role: string) => setupSections({ mayStartHire: canStartHire(role), seesAudit: canSeeActivity(role) }).map((s) => s.id);
    expect(ids("owner")).toContain("setup-shortcut");
    expect(ids("owner")).toContain("setup-audit");
    expect(ids("hr")).not.toContain("setup-shortcut");
    expect(ids("hr")).toContain("setup-audit");
    expect(ids("interviewer")).not.toContain("setup-shortcut");
    expect(ids("interviewer")).not.toContain("setup-audit");
    // the cards everyone has stay in every menu
    for (const role of ["owner", "hr", "interviewer"]) expect(ids(role).slice(0, 8)).toEqual(["setup-company", "setup-team", "setup-profile", "setup-boards", "setup-new-times", "setup-recruiters", "setup-sessions", "setup-availability"]);
  });

  it("has 'When a candidate cancels' right after the job boards, for everyone (founder decision 3A: only owners and admins change it)", () => {
    const menu = setupSections({ mayStartHire: false, seesAudit: false });
    const at = menu.findIndex((s) => s.id === "setup-new-times");
    expect(menu[at]).toEqual({ id: "setup-new-times", label: "When a candidate cancels" });
    expect(menu[at - 1].id).toBe("setup-boards");
    expect(page).toContain('<Section id="setup-new-times"><NewTimesCard company={c} canEdit={canChangeCompany(myRole)}');
  });

  it("uses plain names, never an id", () => {
    for (const s of setupSections({ mayStartHire: true, seesAudit: true })) {
      expect(s.label).not.toMatch(/[-_]/);
      expect(s.label.length).toBeLessThanOrEqual(24);
    }
  });
});
