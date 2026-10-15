import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The ITS console's Privacy requests section (apps/web/src/pages/admin/privacy.tsx) as the server first draws it from
 * answers shaped like the API's (redesign spec 3.2, Wave S6 slice S6-F): the Open and Closed parts, five columns each,
 * the Sort chip, the button that records a request from the privacy mailbox, and the request drawer that `?open=` opens.
 */
const address = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/privacy",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(address.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { PRIVACY_SORTS, PrivacySection, privacyDaysLeft, sortRequests } = await import("@ros/web/src/pages/admin/privacy");

const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
/** The markup from one table's opening tag on, so a name said earlier on the page (a heading, the toolbar) does not count. */
const from = (html: string, start: string | RegExp) => {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
};
const headings = (html: string) => [...from(html, "<thead>").split("</thead>")[0].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [], activeCompanyId: null, staffAccess: null, ai: { provider: "fake" } };

function client(data: Array<[unknown[], unknown]> = [], me: unknown = admin) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}

type Req = ReturnType<typeof request>;
const request = (id: string, companyName: string, createdAt: string, slaDueAt: string, status = "received", extra: Record<string, unknown> = {}) => ({ id, companyId: "co1", companyName, candidateId: null as string | null, applicationId: null, kind: "access", details: null as string | null, requesterEmail: "maria@example.com", channel: "email", verificationStatus: "pending", verificationNote: null, status, slaDueAt, assignedTo: null as string | null, notes: [] as Array<{ at: string; by: string; text: string }>, counselEscalatedAt: null, counselDecision: null, counselNote: null, resolution: null as string | null, resolvedAt: status === "fulfilled" || status === "declined" ? daysAgo(1) : null, confirmationSentAt: null as string | null, escalationId: null, createdAt, ...extra });
// d1 came in last (the API lists newest first) and is due last; d2 is overdue; d3 is done
const data = (): Req[] => [request("d1", "Avon Dental", daysAgo(5), daysAgo(-10)), request("d2", "Cara Dental", daysAgo(40), daysAgo(1)), request("d3", "Bright Dental", daysAgo(9), daysAgo(-3), "fulfilled")];
const section = (view: string | null) => createElement(PrivacySection, { view, onView: () => undefined });

describe("the console's privacy requests", () => {
  it("lists the open requests in five columns, in the order they came until someone sorts, with Due a sortable heading", () => {
    address.search = "";
    const html = render(client([[["admin", "privacy"], data()]]), section(null));
    const open = from(html, /<section class="table-wrap scroll"/);
    expect(headings(html)).toEqual(["Customer", "What they asked", "Due", "Status", "Actions"]);
    expect(open).toContain('<th scope="col"><button type="button" class="th-sort">Due');
    // Received is no longer a column: it is the Sort chip's, and the line under what they asked
    expect(html.match(/class="th-sort"/g)).toHaveLength(1);
    expect(html).not.toContain("aria-sort");
    expect(open.indexOf("Avon Dental")).toBeLessThan(open.indexOf("Cara Dental"));
    expect(open).not.toContain("Bright Dental");
    expect(open).toContain('<span class="sr-only" role="status"></span>');
    // plain words, and the overdue one says so
    expect(open).toContain("Copy of their data");
    expect(open).toContain("Received 5 days ago · privacy mailbox");
    expect(open).toContain(">New<");
    expect(open).toContain("Not checked yet");
    expect(open).toContain(">overdue<");
    expect(open).toContain("10 days left");
    expect(open).not.toContain("_");
  });

  it("shows the parts as tabs with their counts, the Sort chip and the record button above the open list", () => {
    address.search = "";
    const html = render(client([[["admin", "privacy"], data()]]), section(null));
    expect(html).toMatch(/role="tablist" aria-label="Privacy requests"/);
    expect(html).toMatch(/aria-selected="true"[^>]*>.*?Open.*?<span class="count">2<\/span>/);
    expect(html).toMatch(/Closed.*?<span class="count">1<\/span>/);
    expect(html).toContain("2 open · 1 overdue");
    expect(html).toMatch(/aria-haspopup="menu"[^>]*>Sort: Received, newest first/);
    expect(html).toContain("Record a request from the privacy mailbox");
    // the form is in a dialog that the button opens, not on the page
    expect(html).not.toContain("Requester email");
  });

  it("sorts the open requests by when they came in or when they are due, both ways", () => {
    const rows = data().slice(0, 2).concat(request("d4", "Dee Dental", daysAgo(20), daysAgo(-2)));
    const ids = (sort: Parameters<typeof sortRequests>[1]) => sortRequests(rows, sort).map((r) => r.id);
    expect(ids(null)).toEqual(["d1", "d2", "d4"]);
    expect(ids({ key: "received", dir: "descending" })).toEqual(["d1", "d4", "d2"]);
    expect(ids({ key: "received", dir: "ascending" })).toEqual(["d2", "d4", "d1"]);
    expect(ids({ key: "due", dir: "ascending" })).toEqual(["d2", "d4", "d1"]);
    expect(ids({ key: "due", dir: "descending" })).toEqual(["d1", "d4", "d2"]);
    expect(PRIVACY_SORTS.map((s) => s.label)).toEqual(["Received, newest first", "Received, oldest first", "Due, soonest first", "Due, latest first"]);
    expect(privacyDaysLeft({ slaDueAt: daysAgo(1) })).toBeLessThan(0);
  });

  it("keeps the closed list plain, in the same five-column shape", () => {
    address.search = "";
    const html = render(client([[["admin", "privacy"], data()]]), section("closed"));
    expect(headings(html)).toEqual(["Customer", "What they asked", "Resolved", "Status", "Actions"]);
    expect(html).toContain('<th scope="col">Resolved</th>');
    expect(html).not.toContain("th-sort");
    expect(html).not.toContain("Sort:");
    const closed = from(html, "<tbody");
    expect(closed).toContain("Bright Dental");
    expect(closed).toContain(">Done<");
    expect(closed).toContain("yesterday");
    expect(closed).not.toContain("Avon Dental");
  });

  it("shows the open part for a part it does not know, and says when nothing is waiting", () => {
    address.search = "";
    expect(headings(render(client([[["admin", "privacy"], data()]]), section("nonsense")))).toContain("Due");
    const none = render(client([[["admin", "privacy"], []]]), section(null));
    expect(none).toContain("No open privacy requests.");
    expect(none).toContain("Nothing is waiting.");
  });

  it("opens the request drawer from the address, with where it stands first and every step", () => {
    address.search = "view=open&open=d2";
    const req = request("d2", "Cara Dental", daysAgo(40), daysAgo(1), "received", { kind: "delete", assignedTo: "s1", notes: [{ at: daysAgo(2), by: "Ada Admin", text: "Asked counsel." }] });
    const html = render(client([[["admin", "privacy"], [req]], [["admin", "privacy", "d2"], req]]), section(null));
    address.search = "";
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Deletion / anonymization · Cara Dental"');
    const drawer = from(html, 'role="dialog"');
    expect(drawer).toContain("from the privacy mailbox · reference d2");
    for (const words of ["<dt>Status</dt>", "<dt>Verified</dt>", "<dt>Assigned</dt>", "<dt>Due</dt>", "Not checked yet", ">overdue<", "You", "Assign to me", "Verify the requester", "Could not verify", "Asked counsel.", "Add note", "Send to counsel", "Counsel approved", "Counsel declined", "I confirm counsel approved this anonymization", "Fulfil and confirm to the requester", "Decline with this explanation"]) {
      expect(drawer, words).toContain(words);
    }
  });

  it("offers the export preview for a copy of their data, the plain correction fields, and sending the confirmation again", () => {
    address.search = "open=a1";
    const access = request("a1", "Avon Dental", daysAgo(3), daysAgo(-20), "in_progress", { verificationStatus: "verified_manual" });
    const accessHtml = render(client([[["admin", "privacy"], [access]], [["admin", "privacy", "a1"], access]]), section("open"));
    expect(accessHtml).toContain('href="/api/v1/admin/data-requests/a1/export"');
    expect(accessHtml).toContain("Nobody yet");

    address.search = "open=c1";
    const correct = request("c1", "Avon Dental", daysAgo(3), daysAgo(-20), "in_progress", { kind: "correct", verificationStatus: "verified_by_link" });
    const correctHtml = render(client([[["admin", "privacy"], [correct]], [["admin", "privacy", "c1"], correct]]), section(null));
    expect(correctHtml).toContain('<option value="locationText">Location</option>');

    address.search = "open=x1";
    const deleted = request("x1", "Avon Dental", daysAgo(30), daysAgo(-1), "fulfilled", { kind: "delete", verificationStatus: "verified_manual", resolution: "Anonymized." });
    const deletedHtml = render(client([[["admin", "privacy"], [deleted]], [["admin", "privacy", "x1"], deleted]]), section("closed"));
    address.search = "";
    expect(deletedHtml).toContain("The requester has not been told yet: the confirmation email did not go.");
    expect(deletedHtml).toContain("Send the confirmation again");
    expect(deletedHtml).not.toContain("Assign to me");
  });
});
