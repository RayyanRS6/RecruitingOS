import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plans on screen, as the server first draws them from answers shaped like the API's: the one Upgrade and its sheet,
 * the room alert, and a person past the plan's candidates per job as one card. Companies read the AI help as words or a
 * percentage, never dollars. Nothing here names anyone locked. (Settings' Plan and Team sections, Home's notices and
 * the candidate panel are drawn in their own tests; the admin dashboard's plan, in dollars, in admin-companies-ui.test.ts.)
 */
const nav = vi.hoisted(() => ({ search: "", path: "/", params: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Upgrade, UpgradeSheet } = await import("@ros/web/src/components/Upgrade");
const { LockedCandidates, LockedCard } = await import("@ros/web/src/components/LockedCandidates");
const { RoomAlert } = await import("@ros/web/src/components/RoomAlert");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const me = (role: string) => ({ user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", ai: { provider: "fake" } });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function client(data: Array<[readonly unknown[], unknown]> = [], who: unknown = me("owner")) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], who);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));

const plans = {
  requestedAt: null,
  plans: [
    { key: "free", name: "Free", monthlyUsd: 0, activeRoles: 1, jobsTotal: 1, candidatesPerJob: 5, seats: 2, aiHelp: "Included, up to a limit", current: true },
    { key: "basic", name: "Basic", monthlyUsd: 49, activeRoles: 3, jobsTotal: null, candidatesPerJob: 25, seats: 3, aiHelp: "About 600 candidates a month", current: false },
    { key: "pro", name: "Pro", monthlyUsd: 149, activeRoles: 10, jobsTotal: null, candidatesPerJob: 100, seats: 10, aiHelp: "About 1,800", current: false },
    { key: "ultra", name: "Ultra", monthlyUsd: 399, activeRoles: 30, jobsTotal: null, candidatesPerJob: null, seats: null, aiHelp: "About 6,000", current: false },
  ],
};

beforeEach(() => {
  nav.search = "";
  nav.path = "/";
  nav.params = {};
});

describe("the one Upgrade and its sheet", () => {
  const sheet = (data: unknown = plans) => render(client([[["plans"], data]]), createElement(UpgradeSheet, { onClose: () => undefined }));

  it("shows the four plans side by side, the current one marked, with prices, the numbers and the AI help in words", () => {
    const html = sheet();
    const words = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Upgrade"');
    expect(html).toContain("@xl:grid-cols-4");
    expect(words).toContain("Free Your plan $0");
    expect(words).toContain("Basic $49 a month Jobs 3 at a time Candidates per job 25 People 3 AI help About 600 candidates a month");
    expect(words).toContain("Pro $149 a month");
    expect(words).toContain("Ultra $399 a month Jobs 30 at a time Candidates per job No limit People No limit AI help About 6,000");
    expect(words).toContain("Jobs 1 Candidates per job 5 People 2 AI help Included, up to a limit");
    // Free costs nothing and the company is on it: no radio to choose it; one for each of the others, the next one up chosen
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="basic"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain('value="free"');
  });

  it("asks one thing, with one plain line about money; nothing about access or urgency", () => {
    const html = sheet();
    const words = text(html);
    expect(words).toContain("A note for ITS (optional)");
    expect(words).toContain("Ask ITS to upgrade");
    expect(words).toContain("No card is charged. ITS will contact you, and nothing changes until then.");
    for (const not of ["will see", "every candidate", "access", "How urgent", "What do you want help with", "$10", "cents"]) expect(words, not).not.toContain(not);
  });

  it("on the last plan nothing below is chosen for them, and they can still talk with ITS, in words that do not send them to a plan that is not there", () => {
    const html = sheet({ requestedAt: null, plans: plans.plans.map((p) => ({ ...p, current: p.key === "ultra" })) });
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('aria-label="Your plan"');
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Ask ITS about our plan<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Ask ITS about our plan/);
    expect(text(html)).not.toContain("Ask ITS to upgrade");
  });

  it("on a plan not in the list (the pilot, Trial, a retired one) Free is not chosen for them: they pick one, or ask with none picked", () => {
    const html = sheet({ requestedAt: null, plans: plans.plans.map((p) => ({ ...p, current: false })) });
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Ask ITS to upgrade<\/button>/);
  });

  it("with a request already sent: says the day it went, and asks nothing more", () => {
    const html = sheet({ ...plans, requestedAt: "2026-11-18T12:00:00Z" });
    const words = text(html);
    expect(words).toContain("Request sent on November 18, 2026. No card is charged. ITS will contact you, and nothing changes until then.");
    expect(words).not.toContain("Ask ITS to upgrade");
    expect(words).not.toContain("A note for ITS");
    expect(html).not.toContain('type="radio"');
  });

  it("the button is the same for everyone on the team, and the sheet stays closed until pressed; with a request sent, its day stands in the button's place", () => {
    const button = (who: unknown) => render(client([], who), createElement(Upgrade, {}));
    const html = button(me("owner"));
    expect(html).toMatch(/<button type="button" class="btn secondary"[^>]*>.*Upgrade<\/button>/);
    expect(html).not.toContain('role="dialog"');
    for (const role of ["admin", "hiring_manager"]) expect(button(me(role)), role).toContain(">Upgrade<");
    expect(render(client([[["plans"], { ...plans, requestedAt: "2026-11-18T12:00:00Z" }]]), createElement(Upgrade, {}))).toBe('<span class="small muted">Request sent on November 18, 2026</span>');
    // a page that already knows a request is open (Settings reads it with the plan) says the day without asking again
    expect(render(client(), createElement(Upgrade, { requestedAt: "2026-11-18T12:00:00Z" }))).toBe('<span class="small muted">Request sent on November 18, 2026</span>');
    expect(render(client(), createElement(Upgrade, { requestedAt: null, label: "Talk to ITS" }))).toContain(">Talk to ITS<");
  });

  it("the room alert: no roles to close and the plan's words, with the request the room carries", () => {
    const room = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", ask: { label: "Upgrade", reason: "We would like to post more jobs." }, upgrade: true };
    const html = render(client(), createElement(RoomAlert, { room }));
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more.");
    expect(html).toContain(">Upgrade<");
    expect(html).not.toContain("Talk to ITS");
    // a plan with places at a time keeps its own words and names the jobs holding them, each a link; the button says
    // the words of the room's own request
    const full = { ok: false, limit: 2, used: 2, holding: [{ roleId: "r1", title: "Front Desk", status: "open" }], message: "Your plan includes 2 jobs at a time.", ask: { label: "Talk to ITS about more jobs", reason: "We would like to open more jobs than our plan includes. Can we talk about adding more?" } };
    const held = render(client(), createElement(RoomAlert, { room: full }));
    expect(text(held)).toContain("Your plan includes 2 jobs at a time. Front Desk");
    expect(held).toContain('<a href="/roles/r1">Front Desk</a>');
    expect(held).toContain(">Talk to ITS about more jobs<");
    expect(held).not.toContain(">Upgrade<");
    // a room that carries no request offers none: the words and the jobs alone
    const none = render(client(), createElement(RoomAlert, { room: { ...full, ask: null } }));
    expect(text(none)).toContain("Your plan includes 2 jobs at a time. Front Desk");
    expect(none).not.toContain("<button");
  });

  it("the room alert on the last plan, with no AI help left for a new job: no Upgrade, but Talk to ITS, which opens the same sheet", () => {
    const words = "Your plan's AI help is used up. Talk with ITS, or wait until your AI help starts again on Friday, December 4.";
    const room = { ok: false, limit: 30, used: 2, holding: [], message: words, ask: { label: "Talk to ITS", reason: "We would like more AI help." }, upgrade: true, aiHelp: true, nothingAbove: true };
    const html = render(client(), createElement(RoomAlert, { room }));
    expect(text(html)).toContain(words);
    expect(html).toContain(">Talk to ITS<");
    expect(html).not.toContain(">Upgrade<");
    // the words are the request's own, never worked out here from what ran out: the same room whose request says Upgrade says Upgrade
    expect(render(client(), createElement(RoomAlert, { room: { ...room, ask: { ...room.ask, label: "Upgrade" } } }))).toContain(">Upgrade<");
  });
});

describe("a person past the plan's candidates per job", () => {
  const cards = [{ position: 6, appliedAt: daysAgo(0) }, { position: 7, appliedAt: daysAgo(2) }];

  it("one card each after the list: a lock, the word, when they applied, the line and the Upgrade; never a name, initials, a score, a stage or a source", () => {
    const html = render(client(), createElement(LockedCandidates, { locked: { count: 2, cards } }));
    const words = text(html);
    expect(html.match(/class="locked-card /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Locked candidates"');
    expect(words).toContain("Locked Applied today · Upgrade to view more candidates. Upgrade");
    expect(words).toContain("Locked Applied 2 days ago · Upgrade to view more candidates. Upgrade");
    // what a card is built from has nothing else in it
    for (const not of ["avatar", "score", "careers", "candidate-name", "stage"]) expect(html, not).not.toContain(not);
  });

  it("a group folds into one line, and nothing shows with nobody locked", () => {
    const many = { count: 9, cards: Array.from({ length: 9 }, (_, i) => ({ position: i + 6, appliedAt: daysAgo(i) })) };
    const html = render(client(), createElement(LockedCandidates, { locked: many }));
    expect(html.match(/class="locked-card /g)).toHaveLength(4);
    expect(text(html)).toContain("6 more candidates are locked Upgrade to view more candidates. Upgrade");
    expect(render(client(), createElement(LockedCandidates, { locked: { count: 0, cards: [] } }))).toBe("");
    expect(render(client(), createElement(LockedCandidates, { locked: undefined }))).toBe("");
  });

  it("a direct link to them shows the same card, with no name and no way to read them", () => {
    const html = render(client(), createElement(LockedCard));
    expect(html).toContain('aria-label="Locked candidate"');
    expect(text(html)).toContain("Locked Upgrade to view more candidates. Upgrade");
    expect(html.match(/class="locked-card /g)).toHaveLength(1);
  });
});
