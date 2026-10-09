import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../lib/session";

/**
 * The signed-in frame's rail (Wave DS), rendered as the server first sends it: the company chip, "Start a hire" only for
 * the roles that may start one, the roles under Roles, the fold to icons on a role's pages, and Sign out always there.
 */
const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

// The shell's tsconfig leaves JSX to Next.js ("preserve"), so under the test runner it compiles to React.createElement.
(globalThis as { React?: typeof React }).React = React;
const { AppShell } = await import("./AppShell");

const company = { companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental" };
function meAs(role: string | null, extra: Partial<Me> = {}): Me {
  return {
    user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" },
    auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null },
    memberships: role ? [{ ...company, role }] : [],
    activeCompanyId: role ? "co1" : null,
    staffAccess: null,
    ai: { provider: "openai" },
    ...extra,
  };
}
const roles = [
  { id: "r-open", title: "Dental Hygienist", status: "open", openedAt: "2026-10-01T00:00:00Z", counts: { total: 6 }, needsYou: 0, daysOpen: 3 },
  { id: "r-draft", title: "Front Desk Lead", status: "draft", openedAt: null, counts: { total: 0 }, needsYou: 0, daysOpen: null },
  { id: "r-closed", title: "Office Manager", status: "closed", openedAt: null, counts: { total: 2 }, needsYou: 0, daysOpen: null },
];

function renderWith(me: Me, seed: { roles?: unknown } = {}): { html: string; qc: QueryClient } {
  const qc = new QueryClient();
  if (seed.roles) qc.setQueryData(["roles"], seed.roles);
  // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(AppShell, { me, children: createElement("p", null, "page") })));
  return { html, qc };
}
const render = (me: Me, seed: { roles?: unknown } = {}) => renderWith(me, seed).html;
/** Whether the rail's roles query may fetch: its observer options as the shell set them during the render. */
function rolesQueryEnabled(qc: QueryClient): boolean | undefined {
  const query = qc.getQueryCache().find({ queryKey: ["roles"] });
  return (query?.options as { enabled?: boolean } | undefined)?.enabled;
}

describe("the rail", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("shows an owner the company chip, Start a hire with its N hint, the roles in progress and Sign out", () => {
    const html = render(meAs("owner"), { roles });
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain("Bright Dental");
    expect(html).toContain("Owner");
    expect(html).toContain('aria-label="Company setup"');
    expect(html).toMatch(/<a href="\/roles\/new"[^>]*aria-label="Start a hire"[^>]*aria-keyshortcuts="N"/);
    expect(html).toContain('<kbd class="kbd" aria-hidden="true">N</kbd>');
    // the open role with a green dot and its count, the draft with a grey dot, never the closed one
    expect(html).toContain('href="/roles/r-open"');
    expect(html).toContain('<span class="dot good" aria-hidden="true"></span><span class="rail-sub-title">Dental Hygienist</span>');
    expect(html).toContain(", open, 6 applicants");
    expect(html).toContain('<span class="dot" aria-hidden="true"></span><span class="rail-sub-title">Front Desk Lead</span>');
    // the draft says so in a word too: the dot's colour never carries the status alone
    expect(html).toContain('<span class="rail-sub-title">Front Desk Lead</span><span class="rail-count rail-tag" aria-hidden="true">Draft</span>');
    expect(html).not.toContain("Office Manager");
    expect(html).toContain("All roles");
    for (const link of ["Today", "Roles", "Talent", "Interviews", "Setup"]) expect(html, link).toContain(`</svg>${link}</a>`);
    expect(html).toContain("dana@bright.test");
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain('aria-expanded="false" aria-controls="rail-links"');
    expect(html).not.toContain("AI:");
    expect(html).not.toContain('data-rail="compact"');
  });

  it("offers Start a hire only to the roles that may start one", () => {
    for (const role of ["owner", "admin", "hiring_manager", "recruiter"]) expect(render(meAs(role)), role).toContain('aria-label="Start a hire"');
    for (const role of ["hr", "interviewer"]) expect(render(meAs(role)), role).not.toContain('aria-label="Start a hire"');
  });

  it("shows an interviewer the roles the API gives them (only the ones they interview for), without counts and without Talent", () => {
    const theirs = [{ ...roles[0], counts: { total: 0 }, countsHidden: true, needsYou: 0 }];
    const html = render(meAs("interviewer"), { roles: theirs });
    expect(html).toContain("Dental Hygienist");
    expect(html).toContain(", open</span>");
    // no count: the word "Open" stands beside the green dot instead
    expect(html).toContain('<span class="rail-count rail-tag" aria-hidden="true">Open</span>');
    expect(html).not.toMatch(/<span class="rail-count" aria-hidden="true">\d/);
    expect(html).not.toContain("applicant");
    expect(html).not.toContain(">Talent</a>");
    expect(html).toContain("Interviewer");
  });

  it("reads the company's roles for a member, and never for an ITS recruiter inside a customer under a grant", () => {
    expect(rolesQueryEnabled(renderWith(meAs("owner")).qc)).toBe(true);
    // Every request a recruiter makes under a grant is recorded for the customer as a page they opened: the rail makes
    // none, and lists nothing even when another page left the customer's roles in the cache.
    const staff = meAs(null, {
      user: { id: "s1", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" },
      activeCompanyId: "co1",
      staffAccess: { grantId: "g1", kind: "escalation", purpose: "Review these candidates", expiresAt: "2026-10-20T00:00:00Z", companyName: "Bright Dental", scope: { escalationId: "e1", roleId: "r-open", applicationId: null } },
    });
    const { html, qc } = renderWith(staff, { roles });
    expect(rolesQueryEnabled(qc)).toBe(false);
    expect(html).not.toContain("rail-sub");
    expect(html).not.toContain("Dental Hygienist");
    expect(html).toContain("ITS recruiter, limited access");
    expect(html).toContain("Every page you open is recorded for the customer.");
    expect(html).not.toContain('aria-label="Start a hire"');
  });

  it("folds to icons on a role's own pages, and in the job builder", () => {
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).toContain('<div class="shell" data-rail="compact">');
    nav.path = "/roles/new";
    expect(render(meAs("owner"), { roles })).toContain('<div class="shell" data-rail="compact">');
    nav.path = "/roles";
    expect(render(meAs("owner"), { roles })).not.toContain('data-rail="compact"');
  });

  it("gives ITS staff without a company the queue and Sign out, and no company chip", () => {
    const html = render(meAs(null, { user: { id: "s1", email: "nadine@identifiedtalent.com", name: "Nadine", platformRole: "its_recruiter" } }));
    expect(html).toContain("ITS staff");
    expect(html).not.toContain("rail-org");
    expect(html).not.toContain('aria-label="Start a hire"');
    expect(html).toContain('href="/recruiter/queue"');
    expect(html).toContain(">Sign out</button>");
  });
});
