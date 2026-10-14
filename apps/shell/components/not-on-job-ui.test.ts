import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * An interviewer opens only the jobs they interview for (the API answers any other job "not found"), and reads no
 * applicants. The job page and its Candidates page say so plainly, with the way to their own interviews, instead of a
 * failure to retry. Drawn as the server first draws them, from answers shaped like the API's.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { ApiError } = await import("@ros/web/src/api/client");
const { RoleDetail, notOnThisJob } = await import("@ros/web/src/pages/RoleDetail");
const { People } = await import("@ros/web/src/pages/People");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const meAs = (role: string) => ({ user: { id: "u1", email: "ivy@bright.test", name: "Ivy Interviewer", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
const job = {
  id: "r1", title: "Dental Hygienist", status: "open", acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, closingDate: null, proposedPacket: null, packetApproval: { pending: null, latest: null },
  packetVersions: [{ version: 1, status: "approved", source: "intake_session", createdAt: daysAgo(8), createdBy: { kind: "user", id: "u2", name: "Dana Whitfield" }, changeSummary: null }],
  counts: {}, boardsStillUp: [], boardsShowingOldVersion: [], whoPosts: "its", decisionMaker: null, pendingApprovals: [],
  currentPacket: { version: 1, status: "approved", packet: { identity: { locations: [{ city: "Irvine", region: "CA" }], employmentType: "full_time", remotePolicy: "onsite" }, compensation: { basis: "hourly", min: 0, max: 0, discloseRange: true } } },
};

function client(role: string, data: Array<[unknown[], unknown]> = []) {
  // A query that failed stays failed while the page is drawn (nothing is fetched on the server).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], meAs(role));
  qc.setQueryData(["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } });
  qc.setQueryData(["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), counts: { total: 0 }, countsHidden: true, needsYou: 0, daysOpen: 7 }]);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
function refused(qc: QueryClient, status = 404) {
  qc.getQueryCache().build(qc, { queryKey: ["role", "r1"] }).setState({ status: "error", error: new ApiError(status, "not_found", "Role not found."), fetchStatus: "idle" });
  return qc;
}

describe("an interviewer on a job they are not on", () => {
  it("is told so on the job page, with the way to their interviews, instead of a failure to retry", () => {
    const html = render(refused(client("interviewer")), createElement(RoleDetail));
    expect(text(html)).toContain("You are not on this job");
    expect(text(html)).toContain("You see the jobs you interview for. Your interviews are under Interviews.");
    expect(html).toContain('href="/interviews"');
    expect(text(html)).not.toContain("Could not load this job.");
    expect(text(html)).not.toContain("Try again");
  });

  it("is told so on its Candidates page too", () => {
    const html = render(refused(client("interviewer")), createElement(People));
    expect(text(html)).toContain("You are not on this job");
    expect(text(html)).not.toContain("Could not load the candidates.");
  });

  it("anyone else whose job did not load still gets the failure and Try again", () => {
    const html = render(refused(client("owner"), 500), createElement(RoleDetail));
    expect(text(html)).toContain("Could not load this job.");
    expect(text(html)).not.toContain("You are not on this job");
  });

  it("is a refusal (404 or 403) to an interviewer only", () => {
    expect(notOnThisJob(new ApiError(404, "not_found", "Role not found."), "interviewer")).toBe(true);
    expect(notOnThisJob(new ApiError(403, "forbidden", "No."), "interviewer")).toBe(true);
    expect(notOnThisJob(new ApiError(500, "internal", "Oops."), "interviewer")).toBe(false);
    expect(notOnThisJob(new ApiError(404, "not_found", "Role not found."), "owner")).toBe(false);
    expect(notOnThisJob(null, "interviewer")).toBe(false);
  });
});

describe("an interviewer on a job they interview for", () => {
  it("sees the job's header and, instead of the applicants, where the people they interview are", () => {
    const html = render(client("interviewer", [[["role", "r1"], job]]), createElement(People));
    expect(html).toMatch(/<h1>Dental Hygienist<\/h1>/);
    expect(text(html)).toContain("Candidates are for the hiring team");
    expect(text(html)).toContain("You see the people you interview under Interviews.");
    expect(html).toContain('href="/interviews"');
    expect(text(html)).not.toContain("Could not load the candidates.");
    expect(text(html)).not.toContain("You are not on this job");
  });
});
