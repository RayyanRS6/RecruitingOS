"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@ros/ui";
import { useSearchParams } from "../../nav";
import { CustomersSection } from "./customers";
import { Overview } from "./Overview";
import { PrivacySection } from "./privacy";
import { ProblemsSection } from "./problems";
import { SystemSection } from "./system";

/**
 * The ITS console's frame (redesign spec 3.1). Five sections, each its own address and its own link under Console in the
 * rail: Overview (/admin), Customers, Privacy requests, Problems, System and settings. A section shows its title and,
 * where it has several parts, its part tabs; the part chosen is `?view=` in the address, so a link, a reload or the
 * back button lands on the same part. Choosing another part drops `?open=` and `?tab=` (a drawer belongs to its part).
 * The rail (AppShell) and the guard (app/(app)/admin/layout.tsx) are the shell's; every read is audited by the API.
 * The title stands alone (founder's fewer-words rule, 23 Oct 2026): no eyebrow over it and no line describing the page;
 * the rail already says this is the console and the part tabs say what each section holds.
 */
export type ConsoleSection = "overview" | "customers" | "privacy" | "problems" | "system";

/** Each section's title, in the rail's order (Overview draws its own greeting instead). */
export const CONSOLE_SECTIONS: Record<Exclude<ConsoleSection, "overview">, string> = {
  customers: "Customers",
  privacy: "Privacy requests",
  problems: "Problems",
  system: "System and settings",
};

/** The address after choosing a part: `?view=` set, a drawer's `?open=`/`?tab=` dropped, everything else kept. */
export function viewSearch(search: string, view: string): string {
  const next = new URLSearchParams(search);
  next.set("view", view);
  next.delete("open");
  next.delete("tab");
  return `?${next.toString()}`;
}

export function Console({ section }: { section: ConsoleSection }) {
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

  if (section === "overview") return <Overview />;
  // The header keeps its own space below it (the kit's page header); the section's part tabs follow as underline tabs.
  return (
    <div className="min-w-0">
      <PageHeader title={CONSOLE_SECTIONS[section]} />
      {section === "customers" ? <CustomersSection view={view} onView={onView} /> : section === "privacy" ? <PrivacySection view={view} onView={onView} /> : section === "problems" ? <ProblemsSection view={view} onView={onView} /> : <SystemSection view={view} onView={onView} />}
    </div>
  );
}
