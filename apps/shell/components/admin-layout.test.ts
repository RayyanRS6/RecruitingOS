import { existsSync, readFileSync } from "node:fs";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { describe, expect, it } from "vitest";
import config from "../next.config";

/**
 * The admin dashboard in the shell: its layout lets only platform administrators in, it has three pages and no others,
 * it is styled from the one stylesheet like every other page, and the addresses of the pages that are gone lead to the
 * nearest page that exists.
 */
const layout = readFileSync(new URL("../app/(app)/admin/layout.tsx", import.meta.url), "utf8");
const page = (path: string) => new URL(`../app/(app)/${path}/page.tsx`, import.meta.url);

describe("the dashboard's layout and pages", () => {
  it("sends anyone but a platform administrator away", () => {
    expect(layout).toContain("if (!me) redirect(\"/login\");");
    expect(layout).toContain("if (!isAdmin(me)) redirect(");
  });

  it("loads no stylesheet of its own", () => {
    expect(layout).not.toMatch(/import\s+"[^"]*\.css";/);
    expect(readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8")).not.toMatch(/import\s+"[^"]*\.css";/);
  });

  it("has Companies, Privacy requests and System, each drawing its section of the dashboard, and no page of the old console", () => {
    for (const [path, section] of [["admin", "companies"], ["admin/privacy", "privacy"], ["admin/system", "system"]]) {
      expect(readFileSync(page(path), "utf8"), path).toContain(`<Dashboard section="${section}" />`);
    }
    for (const gone of ["admin/customers", "admin/problems", "recruiter/queue", "(company)/interviews", "(company)/people", "(company)/roles/[id]/people"]) expect(existsSync(page(gone)), gone).toBe(false);
  });
});

describe("the addresses of pages that are gone", () => {
  /** Where a path is sent, by the regular expression a build writes for each rule to the routes manifest; null when no rule takes it. */
  const moved = async (path: string): Promise<string | null> => {
    for (const rule of (await config.redirects?.()) ?? []) {
      const built = buildCustomRoute("redirect", rule, ["/_next"]);
      const match = new RegExp(built.regex).exec(path);
      if (!match) continue;
      const names = [...rule.source.matchAll(/:(\w+)/g)].map((m) => m[1]);
      return rule.destination.replace(/:(\w+)/g, (_, name: string) => match[names.indexOf(name) + 1] ?? "");
    }
    return null;
  };

  it("lead to the nearest page that exists, never permanently", async () => {
    expect(await moved("/people")).toBe("/talent");
    expect(await moved("/roles/r1/people")).toBe("/roles/r1/talent");
    expect(await moved("/interviews")).toBe("/talent");
    expect(await moved("/interviews/i1")).toBe("/talent");
    expect(await moved("/recruiter/queue")).toBe("/");
    expect(await moved("/recruiter/queue/e1")).toBe("/");
    expect(await moved("/admin/customers")).toBe("/admin");
    expect(await moved("/admin/problems")).toBe("/admin/system");
    for (const rule of (await config.redirects?.()) ?? []) expect("permanent" in rule && rule.permanent, rule.source).toBe(false);
  });

  it("leave every page that exists alone", async () => {
    for (const path of ["/", "/roles", "/roles/new", "/roles/r1", "/roles/r1/talent", "/talent", "/setup", "/setup/company", "/updates", "/admin", "/admin/privacy", "/admin/system", "/login", "/welcome", "/peoples", "/interviewing"]) expect(await moved(path), path).toBeNull();
  });
});
