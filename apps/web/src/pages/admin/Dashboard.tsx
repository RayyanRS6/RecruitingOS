"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@ros/ui";
import { useSearchParams } from "../../nav";
import { Companies } from "./companies";
import { PrivacySection } from "./privacy";
import { SystemSection } from "./system";

/**
 * The admin dashboard, for platform administrators only: three sections, each its own address and its own link in the
 * rail. Companies (/admin) is the requests to accept or decline, the list, and one company with its plan and its jobs;
 * Privacy requests (/admin/privacy); System (/admin/system). A section with several parts keeps the part chosen in the
 * address (`?view=`), so a link, a reload or the back button lands on the same part; choosing another part drops
 * `?open=` (a drawer belongs to its part). The rail and the guard (app/(app)/admin/layout.tsx) are the shell's; the
 * API records every call.
 */
export type DashboardSection = "companies" | "privacy" | "system";

/** Each section's title, in the rail's order. */
export const DASHBOARD_SECTIONS: Record<DashboardSection, string> = {
  companies: "Companies",
  privacy: "Privacy requests",
  system: "System",
};

/** The address after choosing a part: `?view=` set, a drawer's `?open=` dropped, everything else kept. */
export function viewSearch(search: string, view: string): string {
  const next = new URLSearchParams(search);
  next.set("view", view);
  next.delete("open");
  return `?${next.toString()}`;
}

export function Dashboard({ section }: { section: DashboardSection }) {
  const [params] = useSearchParams();
  const wanted = params.get("view");
  const [view, setView] = useState<string | null>(wanted);
  // A link followed while the section is open changes only the query string: follow it.
  useEffect(() => {
    setView(wanted);
  }, [wanted]);
  const onView = (next: string) => {
    setView(next);
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${viewSearch(window.location.search, next)}${window.location.hash}`);
    } catch {
      // the part still changes on screen; only the address is not updated
    }
  };
  return (
    <div className="min-w-0">
      <PageHeader title={DASHBOARD_SECTIONS[section]} />
      {section === "companies" ? <Companies /> : section === "privacy" ? <PrivacySection view={view} onView={onView} /> : <SystemSection view={view} onView={onView} />}
    </div>
  );
}
