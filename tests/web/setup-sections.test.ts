import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canSeeActivity, canStartHire } from "../../apps/web/src/roles";
import { SETTINGS_TABS, defaultTab, leadAndRest, settingsHref, settingsLanding, setupSections, tabFrom, tabOfSection } from "../../apps/web/src/setup-sections";

/**
 * Settings in five tabs (Wave S1, 14 Oct 2026): every card on the page keeps its id and belongs to one tab, in the
 * page's order; a role sees only its cards (the shortcut for those who can start a hire, the audit history for those
 * who see activity); and the old links into the page (a card's #hash, the calendar coming back, `?tab=`) land on the
 * card's tab.
 */
const page = readFileSync(new URL("../../apps/web/src/pages/Setup.tsx", import.meta.url), "utf8");
const everyone = { mayStartHire: true, seesAudit: true };

describe("Settings' tabs and cards", () => {
  it("names every card on the page, in the page's order", () => {
    const onPage = [...page.matchAll(/<Section id="([^"]+)"/g)].map((m) => m[1]);
    expect(onPage).toEqual(setupSections(everyone).map((s) => s.id));
    expect(new Set(onPage).size).toBe(onPage.length);
  });

  it("puts each card on its tab: Company, Team, Notifications, Hiring rules, Security", () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(["Company", "Team", "Notifications", "Hiring rules", "Security"]);
    const on = (tab: string) => setupSections(everyone).filter((s) => s.tab === tab).map((s) => s.id);
    expect(on("company")).toEqual(["setup-company", "setup-profile"]);
    expect(on("team")).toEqual(["setup-team"]);
    expect(on("notifications")).toEqual(["setup-notifications", "setup-availability", "setup-shortcut"]);
    expect(on("rules")).toEqual(["setup-rules", "setup-boards", "setup-new-times"]);
    expect(on("security")).toEqual(["setup-sessions", "setup-recruiters", "setup-services", "setup-audit"]);
    // the tabs are drawn from the list, each panel with the strip's ids; they run down the side (the kit's vertical tabs)
    expect(page).toContain("<Tabs items={tabs.map((t) => ({ id: t.id, label: t.label }))} label=\"Settings\" value={active} onChange={pick} idBase={TABS_ID} orientation=\"vertical\" />");
    for (const t of SETTINGS_TABS) expect(page).toContain(`{panel("${t.id}", `);
  });

  it("leaves out what a role does not see, and every tab keeps a card for everyone", () => {
    const ids = (role: string) => setupSections({ mayStartHire: canStartHire(role), seesAudit: canSeeActivity(role) }).map((s) => s.id);
    expect(ids("owner")).toContain("setup-shortcut");
    expect(ids("owner")).toContain("setup-audit");
    expect(ids("hr")).not.toContain("setup-shortcut");
    expect(ids("hr")).toContain("setup-audit");
    expect(ids("interviewer")).not.toContain("setup-shortcut");
    expect(ids("interviewer")).not.toContain("setup-audit");
    for (const role of ["owner", "hr", "interviewer"]) {
      const tabs = new Set(setupSections({ mayStartHire: canStartHire(role), seesAudit: canSeeActivity(role) }).map((s) => s.tab));
      expect([...tabs]).toEqual(SETTINGS_TABS.map((t) => t.id));
    }
  });

  it("has 'When a candidate cancels' right after the job boards, for everyone (founder decision 3A: only owners and admins change it)", () => {
    const menu = setupSections({ mayStartHire: false, seesAudit: false });
    const at = menu.findIndex((s) => s.id === "setup-new-times");
    expect(menu[at]).toEqual({ id: "setup-new-times", label: "When a candidate cancels", tab: "rules" });
    expect(menu[at - 1].id).toBe("setup-boards");
    expect(page).toContain('<Section id="setup-new-times"><NewTimesCard company={c} canEdit={canChangeCompany(myRole)}');
  });

  it("uses plain names, never an id", () => {
    for (const s of [...setupSections(everyone), ...SETTINGS_TABS]) {
      expect(s.label).not.toMatch(/[-_]/);
      expect(s.label.length).toBeLessThanOrEqual(24);
    }
    // the page is called Settings now, and no side menu of anchors is left
    expect(page).toContain('title="Settings"');
    expect(page).not.toContain("section-menu");
  });
});

describe("old links into Settings", () => {
  it("open the card's tab from its #hash, as emails, toasts and Home's cards link", () => {
    expect(settingsLanding({ hash: "#setup-notifications" })).toEqual({ tab: "notifications", section: "setup-notifications" });
    expect(settingsLanding({ hash: "#setup-availability" })).toEqual({ tab: "notifications", section: "setup-availability" });
    expect(settingsLanding({ hash: "#setup-company" })).toEqual({ tab: "company", section: "setup-company" });
    expect(settingsLanding({ hash: "#setup-profile" })).toEqual({ tab: "company", section: "setup-profile" });
    expect(settingsLanding({ hash: "#setup-team" })).toEqual({ tab: "team", section: "setup-team" });
    expect(settingsLanding({ hash: "#setup-rules" })).toEqual({ tab: "rules", section: "setup-rules" });
    expect(settingsLanding({ hash: "#setup-recruiters" })).toEqual({ tab: "security", section: "setup-recruiters" });
    // the hash wins over a tab named in the query
    expect(settingsLanding({ hash: "#setup-rules", tab: "team" })).toEqual({ tab: "rules", section: "setup-rules" });
    expect(tabOfSection("setup-audit")).toEqual({ tab: "security", section: "setup-audit" });
    expect(tabOfSection("#nothing")).toBeNull();
  });

  it("open My availability when the calendar connection comes back, and a tab from ?tab=", () => {
    expect(settingsLanding({ calendar: "connected" })).toEqual({ tab: "notifications", section: "setup-availability" });
    expect(settingsLanding({ calendar: "access_denied", tab: "team" })).toEqual({ tab: "notifications", section: "setup-availability" });
    expect(settingsLanding({ tab: "security" })).toEqual({ tab: "security", section: null });
    expect(settingsLanding({ tab: "nonsense" })).toBeNull();
    expect(settingsLanding({ hash: "", tab: null, calendar: null })).toBeNull();
    expect(tabFrom("rules")).toBe("rules");
    expect(tabFrom("setup-rules")).toBeNull();
  });

  it("open on Company with nothing asked for, or on alerts and availability for an interviewer", () => {
    expect(defaultTab("owner")).toBe("company");
    expect(defaultTab("hiring_manager")).toBe("company");
    expect(defaultTab("")).toBe("company");
    expect(defaultTab("interviewer")).toBe("notifications");
  });

  it("a tab picked by hand writes ?tab= and keeps a sign-in confirmation's outcome, not the calendar's or a hash", () => {
    expect(settingsHref("rules")).toBe("/setup?tab=rules");
    expect(settingsHref("team", "?tab=rules&reauth=ok")).toBe("/setup?tab=team&reauth=ok");
    expect(settingsHref("security", "?calendar=connected")).toBe("/setup?tab=security");
    // the page writes the address without a reload, and sends a confirmation back to the same tab
    expect(page).toContain('window.history.replaceState(null, "", settingsHref(next, window.location.search));');
    expect(page).toContain("<ReauthPrompt returnTo={settingsHref(active)} />");
    expect(page).toContain('window.addEventListener("hashchange", follow);');
  });
});

describe("a card's explanation, one line on view", () => {
  it("keeps the first sentence on view and the rest for How this works", () => {
    expect(leadAndRest("One. Two three. Four.")).toEqual({ lead: "One.", rest: "Two three. Four." });
    expect(leadAndRest("Only one sentence.")).toEqual({ lead: "Only one sentence.", rest: "" });
    expect(leadAndRest("Interviews at 8:00 a.m. work. Then more.")).toEqual({ lead: "Interviews at 8:00 a.m. work.", rest: "Then more." });
  });
});
