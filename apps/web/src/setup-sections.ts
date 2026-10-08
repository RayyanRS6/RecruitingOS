/**
 * Setup's section menu (plan I1): the cards in the order the page shows them, each with the id the menu jumps to and
 * the name it shows. A card the person cannot use is left out of the menu as it is left off the page.
 */
export function setupSections(viewer: { mayStartHire: boolean; seesAudit: boolean }): Array<{ id: string; label: string }> {
  return [
    { id: "setup-company", label: "Company" },
    { id: "setup-team", label: "Team" },
    { id: "setup-recruiters", label: "Recruiter access" },
    { id: "setup-sessions", label: "Your sessions" },
    { id: "setup-availability", label: "Your availability" },
    { id: "setup-notifications", label: "Email alerts" },
    ...(viewer.mayStartHire ? [{ id: "setup-shortcut", label: "Keyboard shortcut" }] : []),
    { id: "setup-services", label: "Connected services" },
    { id: "setup-rules", label: "What the AI may do" },
    ...(viewer.seesAudit ? [{ id: "setup-audit", label: "Audit history" }] : []),
  ];
}
