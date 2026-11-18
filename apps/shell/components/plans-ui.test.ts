import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plans on screen, as the server first draws them from answers shaped like the API's: the one Upgrade and its sheet,
 * the room alert, a person past the plan's candidates per job as one card, and the console's Change plan and customer
 * row. Customers read the AI help as words or a percentage, never dollars; ITS reads dollars. Nothing here names anyone
 * locked. (Settings' Plan and Team sections, Home's notices and the candidate panel are drawn in their own tests.)
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
const { CustomersSection, aiCreditDollars, planChangedToast, planLimitsLine, planPriceLine } = await import("@ros/web/src/pages/admin/customers");
const { attentionRows } = await import("@ros/web/src/pages/admin/Overview");
const { needsAPerson } = await import("@ros/web/src/pages/admin/problems");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const me = (role: string) => ({ user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", ai: { provider: "fake" } });
const admin = { ...me("owner"), user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, memberships: [], activeCompanyId: null };
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

  it("the room alert: no roles to close and the plan's words, with the Upgrade", () => {
    const room = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
    const html = render(client(), createElement(RoomAlert, { room, ask: null }));
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more.");
    expect(html).toContain(">Upgrade<");
    expect(html).not.toContain("Talk to ITS");
    // a plan with places at a time keeps its own words and names the jobs holding them, each a link; a request the
    // API's refusal carried is the one offered
    const full = { ok: false, limit: 2, used: 2, holding: [{ roleId: "r1", title: "Front Desk", status: "open" }], message: "Your plan includes 2 jobs at a time." };
    const held = render(client(), createElement(RoomAlert, { room: full, ask: { label: "Talk to ITS about more jobs", reason: "We would like to post more jobs." } }));
    expect(text(held)).toContain("Your plan includes 2 jobs at a time. Front Desk");
    expect(held).toContain('<a href="/roles/r1">Front Desk</a>');
    expect(held).toContain(">Talk to ITS about more jobs<");
  });

  it("the room alert on the last plan, with no AI help left for a new job: no Upgrade, but Talk to ITS, which opens the same sheet", () => {
    const words = "Your plan's AI help is used up. Talk with ITS, or wait until your AI help starts again on Friday, December 4.";
    const room = { ok: false, limit: 30, used: 2, holding: [], message: words, upgrade: true, aiHelp: true, nothingAbove: true };
    const html = render(client(), createElement(RoomAlert, { room, ask: null }));
    expect(text(html)).toContain(words);
    expect(html).toContain(">Talk to ITS<");
    expect(html).not.toContain(">Upgrade<");
    // with somewhere to go, the same room says Upgrade
    expect(render(client(), createElement(RoomAlert, { room: { ...room, nothingAbove: undefined }, ask: null }))).toContain(">Upgrade<");
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

describe("the console", () => {
  const customer = (over: Record<string, unknown> = {}) => ({ id: "co1", name: "Bright Dental", slug: "bright", vertical: "dental", sizeBand: "20-49", planKey: "free", status: "active", roles: 1, applications: 6, aiCostUsd: 1.2, lastActivityAt: daysAgo(1), createdAt: daysAgo(30), settings: {}, verifiedAt: daysAgo(29), verifiedBy: null, heldMessages: 0, applyFlowDefault: "form_then_screen", screeningConversations: { used: 4, limit: null }, aiCredit: { monthly: false, spentUsd: 1.2, limitUsd: 10, percent: 12, level: null, resetsAt: null }, lockedApplicants: 3, planRequestSince: daysAgo(1), ...over });
  const section = (search: string, rows: unknown[], plansAnswer: unknown = []) => {
    nav.search = search;
    nav.path = "/admin/customers";
    return render(client([[["admin", "customers"], rows], [["admin", "alerts"], []], [["admin", "plans"], plansAnswer]], admin), createElement(CustomersSection, { view: null, onView: () => undefined }));
  };
  const planRows = [
    { key: "free", name: "Free", prices: { monthlyUsd: 0 }, limits: { active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, seats: 2 } },
    { key: "basic", name: "Basic", prices: { monthlyUsd: 49 }, limits: { active_roles: 3, jobs_total: null, candidates_per_job: 25, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 2000, seats: 3 } },
    { key: "pro", name: "Pro", prices: { monthlyUsd: 149 }, limits: {} },
    { key: "ultra", name: "Ultra", prices: { monthlyUsd: 399 }, limits: {} },
    { key: "design_partner", name: "Design Partner", prices: { monthlyUsd: 0 }, limits: {} },
  ];

  it("a customer's row and Overview say the AI credit in dollars, how many are locked, and that it asked to upgrade", () => {
    const words = text(section("", [customer()]));
    expect(words).toContain("$1.20 of $10 AI credit");
    expect(words).toContain("3 locked");
    expect(words).toContain("Asked to upgrade");
    // unlimited chats on a plan the credit meters are not worth a line
    expect(words).not.toContain("chats this month");
    const overview = text(section("?open=co1", [customer()]));
    expect(overview).toContain("Plan Free · Active Change plan");
    expect(overview).toContain("$1.20 of $10 AI credit 3 locked Asked to upgrade");
    const used = text(section("", [customer({ aiCredit: { monthly: true, spentUsd: 20, limitUsd: 20, percent: 100, level: "used_up", resetsAt: "2026-12-05T12:00:00Z" } })]));
    expect(used).toContain("$20.00 of $20 AI credit this month, resets December 5");
    expect(used).toContain("AI credit used up");
  });

  it("Change plan lists the plans in the API's order with what each costs and includes; a retired plan the company is on stays chosen", () => {
    const html = section("?open=co1&tab=plan", [customer()], planRows);
    const words = text(html);
    expect([...html.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["free", "basic", "pro", "ultra", "design_partner"]);
    expect(words).toContain("$0 a month · 1 job ever · 5 candidates a job · $10 AI credit in all · 2 seats");
    const retired = section("?open=co1&tab=plan", [customer({ planKey: "growth" })], planRows);
    expect([...retired.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["free", "basic", "pro", "ultra", "design_partner", "growth"]);
    expect(retired).toMatch(/<option value="growth" selected="">Growth<\/option>/);
    // nothing to change it to is offered until another is picked
    expect(text(retired)).not.toContain("Why (required");
  });

  it("a plan's line, its price, its dollars and the toast", () => {
    // an older plan's limits
    expect(planLimitsLine({ active_roles: 3, text_screens: 300, voice_minutes: 0, sourcing_contacts: 0, seats: null })).toBe("3 active jobs · 300 AI interviews a month · unlimited seats");
    expect(planLimitsLine({ active_roles: 3, jobs_total: null, candidates_per_job: null, text_screens: 300, ai_credit_total_cents: null, ai_credit_monthly_cents: null, seats: null })).toBe("3 active jobs · 300 AI interviews a month · unlimited seats");
    expect(planLimitsLine({ active_roles: 30, jobs_total: null, candidates_per_job: null, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 20000, seats: null })).toBe("30 active jobs · $200 AI credit a month · unlimited seats");
    expect(planLimitsLine({})).toBe("");
    expect(planPriceLine({ monthlyUsd: 149 })).toBe("$149 a month");
    expect(planPriceLine(undefined)).toBeNull();
    expect(aiCreditDollars({ monthly: false, spentUsd: 9.87, limitUsd: 10, resetsAt: null })).toBe("$9.87 of $10 AI credit");
    expect(planChangedToast("Bright Dental", "Pro", false, 1).detail).toBe("The new limits apply at once. This month's usage stays; the reset date does not move. 1 locked candidate opens now.");
    expect(planChangedToast("Bright Dental", "Pro", false, 3).detail).toContain("3 locked candidates open now.");
    expect(planChangedToast("Bright Dental", "Pro").detail).toBe("The new limits apply at once. This month's usage stays; the reset date does not move.");
  });

  it("the toast after a move up from Free says AI help starts a new month today, the part ITS may be asked about; other allowances keep their dates", () => {
    expect(planChangedToast("Bright Dental", "Basic", false, 0, true).detail).toBe("The new limits apply at once. AI help starts a new month today; other allowances keep their dates.");
    expect(planChangedToast("Bright Dental", "Basic", false, 2, true).detail).toBe("The new limits apply at once. AI help starts a new month today; other allowances keep their dates. 2 locked candidates open now.");
    expect(planChangedToast("Bright Dental", "Basic", false, 0, true).detail).not.toContain("the reset date does not move");
  });

  it("Overview names a customer low on AI credit and one who asked to upgrade; those notices do not count as alerts waiting for a person", () => {
    const rows = attentionRows({ customers: [customer({ aiCredit: { monthly: false, spentUsd: 10, limitUsd: 10, percent: 100, level: "used_up", resetsAt: null } })] as never });
    expect(rows.map((r) => r.text)).toEqual(["Bright Dental has used all its AI credit", "1 customer asked to upgrade"]);
    expect(rows[0].action.href).toBe("/admin/customers?open=co1&tab=plan");
    expect(rows[1].action.href).toBe("/admin/customers?open=co1&tab=plan");
    for (const kind of ["billing.ai_credit_warning", "billing.ai_credit_used_up"]) expect(needsAPerson({ status: "open", kind })).toBe(false);
    expect(needsAPerson({ status: "open", kind: "ai.provider_outage" })).toBe(true);
  });
});
