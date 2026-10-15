import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

/**
 * Known-bugs row 120 (Wave S5, C3): an email application that could not be imported is listed on the ITS console's
 * Failures tab with who sent it, the job, why it failed, the email itself one click away, and "Try again" once the job
 * takes applications again.
 */
(globalThis as { React?: typeof React }).React = React;
const { Failures, failedEmailLine } = await import("@ros/web/src/pages/Admin");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const now = new Date().toISOString();
const admin = { user: { id: "u1", email: "admin@its.test", name: "Admin", platformRole: "platform_admin" }, auth: { provider: "azure", aal: "aal2", mfaVerifiedAt: now }, memberships: [], activeCompanyId: null, staffAccess: null, ai: { provider: "fake" } };
const ready = { id: "in1", receivedAt: now, companyName: "Bright Dental", roleTitle: "Dental Assistant", from: "noreply@indeed.com", subject: "New applicant: Ezra Lind", error: "role is not accepting applications", hasResume: true, canRetry: true, text: "Ezra Lind applied via Indeed." };
const waiting = { ...ready, id: "in2", subject: "New applicant: Ada Moss", hasResume: false, canRetry: false, roleTitle: null, companyName: null, from: null };

function render(rows: unknown[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], admin);
  qc.setQueryData(["admin", "failures"], { failedRuns: [], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] });
  qc.setQueryData(["admin", "suppressions"], []);
  qc.setQueryData(["admin", "csp"], { mode: "report-only", reports: [] });
  qc.setQueryData(["admin", "failed-email-applications"], rows);
  return text(renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Failures) as ReactNode)));
}

describe("failed email applications on the console's Failures tab", () => {
  it("lists each one with its job, the reason, the email behind Show the email, and Try again when the job takes applications", () => {
    const words = render([ready, waiting]);
    expect(words).toContain("Email applications that could not be imported (2)");
    expect(words).toContain("New applicant: Ezra Lind");
    expect(words).toContain("noreply@indeed.com · Dental Assistant at Bright Dental · résumé attached");
    expect(words).toContain("Why: role is not accepting applications");
    expect(words).toContain("Show the email Ezra Lind applied via Indeed.");
    expect(words).toContain("Try again");
    expect(words).toContain("Unknown sender · a job that no longer takes email · no résumé");
    expect(words).toContain("The job is not taking applications right now.");
  });

  it("says None when nothing failed", () => {
    expect(render([])).toContain("Email applications that could not be imported (0) None.");
  });

  it("words the line for each kind of row", () => {
    expect(failedEmailLine({ ...ready, companyName: null })).toBe("noreply@indeed.com · Dental Assistant · résumé attached");
  });
});
