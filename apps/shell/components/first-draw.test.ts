import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * One clean first draw (Wave S2, slice K6). The browser's first draw of a page (hydration) must be exactly the server's,
 * or React throws the page away and draws it again. The server is only ever handed the session; the browser may already
 * hold the rail's jobs list, read in the background before the page is taken over. Both draws use the same "not the
 * browser's yet" answer (useIsClient), so a draw from the session alone (the server's) must equal a draw from the
 * session plus the jobs list (the browser's first), on Candidates, the job page and Home.
 */
const nav = vi.hoisted(() => ({ search: "", params: { id: "r1" } as Record<string, string>, path: "/roles/r1/talent" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { People } = await import("@ros/web/src/pages/People");
const { RoleDetail } = await import("@ros/web/src/pages/RoleDetail");
const { Home } = await import("@ros/web/src/pages/Home");
const { Roles } = await import("@ros/web/src/pages/Roles");
const { useIsClient } = await import("@ros/web/src/components/use-is-client");

const me = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "openai" } };
// Two live jobs, so a job picker or a job's title would show if the list leaked into the first draw.
const jobs = [
  { id: "r1", title: "Dental Hygienist", status: "open", openedAt: "2026-10-01T00:00:00Z", createdAt: "2026-09-30T00:00:00Z", counts: { total: 6, waiting_on_you: 2 }, stageCounts: { new: 3 }, needsYou: 2, daysOpen: 13 },
  { id: "r2", title: "Office Manager", status: "open", openedAt: "2026-10-05T00:00:00Z", createdAt: "2026-10-04T00:00:00Z", counts: { total: 1 }, stageCounts: { new: 1 }, needsYou: 0, daysOpen: 9 },
];

/** The server's query cache (Providers.tsx seeds the session, nothing else), or the browser's once the rail's list is in. */
function cache(railListIn: boolean): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  if (railListIn) qc.setQueryData(["roles"], jobs);
  return qc;
}
const draw = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
/** The server's draw and the browser's first draw of one page. */
const both = (page: () => ReactNode) => ({ server: draw(cache(false), page()), browser: draw(cache(true), page()) });

afterEach(() => {
  vi.useRealTimers();
  nav.search = "";
  nav.params = { id: "r1" };
  nav.path = "/roles/r1/talent";
});

describe("the first draw matches the server's", () => {
  it("is not the browser's yet while the page is drawn on the server or taken over", () => {
    function Probe() { return createElement("span", null, useIsClient() ? "browser" : "first draw"); }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>first draw</span>");
  });

  it("Candidates (/roles/:id/talent): 'Candidates' on both sides, even when the rail's jobs list came first", () => {
    const { server, browser } = both(() => createElement(People));
    expect(browser).toBe(server);
    expect(server).toMatch(/<h1>Candidates<\/h1>/);
    // the job header has no "Job · company" eyebrow any more (fewer words, 23 Oct 2026), on either side
    expect(server).not.toContain("Job · Bright Dental");
    // nothing from the jobs list: no job title, no job picker, no Live pill, no More menu waiting on the job's status
    expect(browser).not.toContain("Dental Hygienist");
    expect(browser).not.toContain("Switch job");
    expect(browser).not.toContain('class="dot pulse"');
    expect(browser).not.toContain('aria-label="More for this job"');
    // the job's tab strip is there on both sides (its id is in the address)
    expect(server).toContain('<nav aria-label="Job sections">');
  });

  it("Candidates with a person opened from a link: the panel waits on both sides too", () => {
    nav.search = "open=a1";
    const { server, browser } = both(() => createElement(People));
    expect(browser).toBe(server);
    expect(browser).not.toContain("Dental Hygienist");
  });

  it("Candidates without a job in the address (/talent): the same loading view on both sides", () => {
    nav.params = {};
    nav.path = "/talent";
    const { server, browser } = both(() => createElement(People));
    expect(browser).toBe(server);
    expect(server).toContain('aria-label="Loading"');
    expect(browser).not.toContain("No jobs yet");
    expect(browser).not.toContain("Dental Hygienist");
  });

  it("the job page (/roles/:id): its skeleton on both sides, whatever the rail holds", () => {
    nav.path = "/roles/r1";
    const { server, browser } = both(() => createElement(RoleDetail));
    expect(browser).toBe(server);
    expect(server).toContain('aria-label="Loading"');
  });

  it("Home: the same greeting (by the hour in UTC) and no 'Your jobs' yet on both sides", () => {
    // 20:30 in UTC: evening by the hosted server's clock, whatever the clock of the machine running this test says
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T20:30:00.000Z") });
    nav.params = {};
    nav.path = "/";
    const { server, browser } = both(() => createElement(Home));
    expect(browser).toBe(server);
    expect(server).toMatch(/<h1>Good evening, Dana<\/h1>/);
    expect(browser).not.toContain("Your jobs");
    expect(browser).not.toContain("Dental Hygienist");
  });

  it("Jobs (/roles): the same loading view on both sides, with no counts, rows or 'No jobs yet'", () => {
    nav.params = {};
    nav.path = "/roles";
    const { server, browser } = both(() => createElement(Roles));
    expect(browser).toBe(server);
    expect(server).toMatch(/<h1>Jobs<\/h1>/);
    expect(server).toContain('aria-label="Loading"');
    expect(browser).not.toContain("Dental Hygienist");
    expect(browser).not.toContain("No jobs yet");
    expect(browser).not.toContain('aria-label="Show jobs"');
  });
});
