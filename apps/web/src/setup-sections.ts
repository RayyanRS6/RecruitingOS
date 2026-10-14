/**
 * Settings (the page at /setup) in five tabs (Wave S1, 14 Oct 2026): every card keeps the id old links jump to
 * ("/setup#setup-notifications" in emails, toasts and Home's cards), and each id belongs to one tab, so such a link opens
 * that tab and scrolls to the card. A card the person cannot use is left off its tab, as it is left off the page.
 */
export type SettingsTab = "company" | "team" | "notifications" | "rules" | "security";

/** The tabs, in the order the strip shows them. */
export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "company", label: "Company" },
  { id: "team", label: "Team" },
  { id: "notifications", label: "Notifications" },
  { id: "rules", label: "Hiring rules" },
  { id: "security", label: "Security" },
];

type Viewer = { mayStartHire: boolean; seesAudit: boolean };
export type SettingsSection = { id: string; label: string; tab: SettingsTab };

/** Every card, in the page's order; `only` names what a person needs to see the card. */
const SECTIONS: ReadonlyArray<SettingsSection & { only?: keyof Viewer }> = [
  { id: "setup-company", label: "Company", tab: "company" },
  { id: "setup-profile", label: "How candidates see you", tab: "company" },
  { id: "setup-team", label: "Team", tab: "team" },
  { id: "setup-notifications", label: "Email alerts", tab: "notifications" },
  { id: "setup-availability", label: "Your availability", tab: "notifications" },
  { id: "setup-shortcut", label: "Keyboard shortcut", tab: "notifications", only: "mayStartHire" },
  { id: "setup-rules", label: "What the AI may do", tab: "rules" },
  { id: "setup-boards", label: "Job boards", tab: "rules" },
  { id: "setup-new-times", label: "When a candidate cancels", tab: "rules" },
  { id: "setup-sessions", label: "Your sessions", tab: "security" },
  { id: "setup-recruiters", label: "Recruiter access", tab: "security" },
  { id: "setup-services", label: "Connected services", tab: "security" },
  { id: "setup-audit", label: "Audit history", tab: "security", only: "seesAudit" },
];

/** The cards this person sees, in the page's order, each with its tab. */
export function setupSections(viewer: Viewer): SettingsSection[] {
  return SECTIONS.filter((s) => !s.only || viewer[s.only]).map(({ id, label, tab }) => ({ id, label, tab }));
}

/** `?tab=` as a tab; anything else is no tab. */
export function tabFrom(value: string | null | undefined): SettingsTab | null {
  return SETTINGS_TABS.find((t) => t.id === value)?.id ?? null;
}

/** The tab a card sits on, from its id or an address's #hash ("#setup-notifications"); null for anything else. */
export function tabOfSection(idOrHash: string | null | undefined): { tab: SettingsTab; section: string } | null {
  const id = (idOrHash ?? "").replace(/^#/, "");
  const s = SECTIONS.find((x) => x.id === id);
  return s ? { tab: s.tab, section: s.id } : null;
}

/** Where /setup opens with nothing asked for: an interviewer on their own alerts and availability, everyone else on Company. */
export function defaultTab(role: string | null | undefined): SettingsTab {
  return role === "interviewer" ? "notifications" : "company";
}

/**
 * Where an address into Settings lands: a card's #hash first (the old links), then the calendar connection coming back
 * (`?calendar=`, shown on the availability card), then `?tab=`. Null when the address asks for nothing: the default tab.
 */
export function settingsLanding(at: { hash?: string | null; tab?: string | null; calendar?: string | null }): { tab: SettingsTab; section: string | null } | null {
  const fromHash = tabOfSection(at.hash);
  if (fromHash) return fromHash;
  if (at.calendar) return { tab: "notifications", section: "setup-availability" };
  const tab = tabFrom(at.tab);
  return tab ? { tab, section: null } : null;
}

/**
 * The address for a tab picked by hand: "/setup?tab=rules", keeping the rest of the query (a sign-in confirmation's
 * outcome stays on screen) but not the calendar's one-time answer, and no #hash, so the next old link is a change.
 */
export function settingsHref(tab: SettingsTab, search = ""): string {
  const q = new URLSearchParams(search);
  q.delete("calendar");
  q.set("tab", tab);
  return `/setup?${q.toString()}`;
}

/** An explanation split for a simple card: its first sentence on view, the rest under "How this works". */
export function leadAndRest(text: string): { lead: string; rest: string } {
  const m = /^(.+?[.!?])\s+(?=[A-Z"(])/.exec(text);
  return m ? { lead: m[1], rest: text.slice(m[0].length) } : { lead: text, rest: "" };
}
