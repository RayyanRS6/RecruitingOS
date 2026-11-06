import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@ros/api/src/app";
import { createContainer, type Container } from "@ros/api/src/container";
import { signInAdmin, signInWithIdentity } from "@ros/api/src/test-helpers";
import { installShellForTests } from "../lib/container";

/**
 * The company step by invitation (SIGNUP_MODE=invite, GATE-V2): someone the API will not let open a company gets one
 * line where the form was, naming the ITS inbox to ask, and keeps Sign out; whoever may (an address on the list, a
 * platform administrator, anyone while sign-up is open) gets the form as before. The page's server asks the API's
 * public configuration (GET /api/v1/auth/config) in-process with the person's own cookie, so the answer is theirs.
 *
 * By approval (SIGNUP_MODE=approval, 6 November 2026) the same form sends a request, and the person reads where it stands:
 * waiting or declined, in the same card, from any signed-in address. The email line is there only when the email really
 * left. The waiting screen's every-30-seconds look is proved in tests/web/access-approval.test.ts and, in a real browser,
 * in tests/e2e/specs/access-approval.spec.ts.
 */
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => (jar.cookie ? [{ name: jar.cookie.slice(0, jar.cookie.indexOf("=")), value: jar.cookie.slice(jar.cookie.indexOf("=") + 1) }] : []) }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/setup/company",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
  redirect: (to: string) => {
    throw new Error(`redirect to ${to}`);
  },
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { CompanySetup } = await import("@ros/web/src/pages/CompanySetup");
const page = await import("../app/(session)/setup/company/page");
const appLayout = await import("../app/(app)/layout");
const companyLayout = await import("../app/(app)/(company)/layout");
const adminLayout = await import("../app/(app)/admin/layout");
const recruiterLayout = await import("../app/(app)/recruiter/layout");
const login = await import("../app/(public)/login/page");

const draw = (node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));
/** The words as read, tags dropped (the line's address is a link inside the sentence). */
const words = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const title = (html: string) => words(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "");

describe("the company step by invitation", () => {
  it("someone who may not open a company gets one line instead of the form, with the ITS inbox to ask, and can still sign out", () => {
    const html = draw(createElement(CompanySetup, { signup: { allowed: false, contact: "recruiting@its.example" } }));
    expect(title(html)).toBe("Recruiting OS is by invitation for now");
    expect(words(html)).toContain("Ask ITS for an invitation: recruiting@its.example.");
    expect(html).toContain("<a href=\"mailto:recruiting@its.example\">recruiting@its.example</a>");
    for (const tag of ["<form", "<input", "<select", "<textarea"]) expect(html, tag).not.toContain(tag);
    expect(words(html)).not.toContain("Tell us about your company");
    expect(words(html)).not.toContain("Create my hiring workspace");
    // whoever signed in with the wrong account still has the way out
    expect(words(html)).toContain("Sign out");
  });

  // The live smoke test of 4 Nov 2026: beside a long title the button gave way and "Sign out" broke onto two lines.
  it("keeps Sign out on one line beside the title, however long the title: the button never gives way, the title wraps", () => {
    for (const signup of [{ allowed: false, contact: "recruiting@its.example" }, { allowed: true, contact: "recruiting@its.example" }]) {
      const html = draw(createElement(CompanySetup, { signup }));
      expect(html, String(signup.allowed)).toMatch(/<h1 class="[^"]*\bmin-w-0\b[^"]*">/);
      expect(html, String(signup.allowed)).toMatch(/<button[^>]*class="btn quiet sm[^"]*\bshrink-0\b[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Sign out(?:(?!<\/button>)[\s\S])*<\/button>/);
    }
  });

  it("with no inbox to name, the line still says whom to ask", () => {
    const html = draw(createElement(CompanySetup, { signup: { allowed: false, contact: null } }));
    expect(words(html)).toContain("Ask ITS for an invitation.");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("<form");
  });

  it("someone who may (on the list, an administrator, open sign-up) or an unanswered question: the form as before", () => {
    for (const signup of [{ allowed: true, contact: "recruiting@its.example" }, null, undefined]) {
      const html = draw(createElement(CompanySetup, { signup }));
      expect(title(html), String(signup)).toBe("Tell us about your company");
      expect(html, String(signup)).toContain("<form");
      expect(words(html), String(signup)).toContain("Create my hiring workspace");
      expect(words(html), String(signup)).not.toContain("by invitation");
    }
  });
});

describe("the company step's page asks the API, with the person's own cookie", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const open = async () => (await page.default()) as ReactElement<{ signup: unknown }>;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: "@pilot-partner.test", EMAIL_REPLY_TO: "recruiting@its.example" } });
    installShellForTests(container);
    app = createApp(container);
  });
  afterAll(async () => {
    jar.cookie = "";
    await container.close();
  });

  it("a stranger is told it is by invitation, with the ITS inbox", async () => {
    jar.cookie = await signInWithIdentity(app, container, { email: "sam@stranger.test", provider: "google", aal2: false });
    const element = await open();
    expect(element.props.signup).toEqual({ mode: "invite", allowed: false, contact: "recruiting@its.example" });
    expect(words(draw(element))).toContain("Ask ITS for an invitation: recruiting@its.example.");
  });

  it("an address at a listed domain gets the form", async () => {
    jar.cookie = await signInWithIdentity(app, container, { email: "pat@pilot-partner.test", provider: "google", aal2: false });
    const element = await open();
    expect(element.props.signup).toEqual({ mode: "invite", allowed: true, contact: "recruiting@its.example" });
    expect(draw(element)).toContain("<form");
  });

  it("someone signed out is still sent to sign in", async () => {
    jar.cookie = "";
    await expect(page.default()).rejects.toThrow("redirect to /login");
  });
});

describe("the company step by approval: the person's screens", () => {
  const contact = "recruiting@its.example";
  const request = (over: Record<string, unknown> = {}) => ({ status: "requested" as const, companyName: "Harbor Dental", email: "sam@stranger.test", emailedAt: "2026-11-06T10:00:00.000Z", ...over });

  it("the form's main button says what it does for someone whose door is a request, and the direct door keeps its own words", () => {
    const asks = draw(createElement(CompanySetup, { signup: { allowed: true, contact, door: "request" } }));
    expect(title(asks)).toBe("Tell us about your company");
    expect(asks).toContain("<form");
    expect(words(asks)).toContain("Send my request");
    expect(words(asks)).not.toContain("Create my hiring workspace");
    const direct = draw(createElement(CompanySetup, { signup: { allowed: true, contact, door: "direct" } }));
    expect(words(direct)).toContain("Create my hiring workspace");
    expect(words(direct)).not.toContain("Send my request");
  });

  it("waiting: the brief's words, the company's name, Sign out beside the title, and no form", () => {
    const html = draw(createElement(CompanySetup, { signup: { allowed: false, contact, door: "request", request: request() } }));
    expect(title(html)).toBe("Your request has been sent");
    expect(words(html)).toContain("Please wait for approval.");
    expect(words(html)).toContain("Harbor Dental");
    for (const tag of ["<form", "<input", "<select", "<textarea"]) expect(html, tag).not.toContain(tag);
    expect(words(html)).not.toContain("by invitation");
    expect(words(html)).not.toContain("Tell us about your company");
    // the same card and the same way out as the form
    expect(html).toContain("rounded-[20px] border border-line bg-surface");
    expect(html).toMatch(/<h1 class="[^"]*\bmin-w-0\b[^"]*" tabindex="-1">/);
    expect(html).toMatch(/<button[^>]*class="btn quiet sm[^"]*\bshrink-0\b[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Sign out(?:(?!<\/button>)[\s\S])*<\/button>/);
  });

  it("waiting: the line about email shows only when the email really left, and the other line only when it did not", () => {
    const left = words(draw(createElement(CompanySetup, { signup: { allowed: false, contact, request: request() } })));
    expect(left).toContain("We sent a copy to sam@stranger.test, and we will email you when it is decided.");
    expect(left).not.toContain("Keep this page open");
    const stayed = words(draw(createElement(CompanySetup, { signup: { allowed: false, contact, request: request({ emailedAt: null }) } })));
    expect(stayed).toContain("Keep this page open, or sign in again later to check.");
    // nothing on the screen claims an email: not the copy, not the address, not that one is coming
    expect(stayed).not.toMatch(/sent a copy|we will email|sam@stranger\.test/i);
  });

  it("declined: a polite title and the same mailto as the by-invitation line, with no claim about email and no way to ask again", () => {
    const html = draw(createElement(CompanySetup, { signup: { allowed: false, contact, door: "request", request: request({ status: "declined" }) } }));
    expect(title(html)).toBe("We can't offer access right now");
    expect(words(html)).toContain(`Questions? ${contact}`);
    expect(html).toContain(`<a href="mailto:${contact}">${contact}</a>`);
    expect(words(html)).toContain("Sign out");
    for (const tag of ["<form", "<input", "<select", "<textarea"]) expect(html, tag).not.toContain(tag);
    expect(words(html)).not.toMatch(/sent a copy|we will email|we emailed|Please wait|sam@stranger\.test|Harbor Dental/i);
    // with no inbox to name, the line still says whom to ask
    const noInbox = draw(createElement(CompanySetup, { signup: { allowed: false, contact: null, request: request({ status: "declined" }) } }));
    expect(words(noInbox)).toContain("Questions? Ask ITS.");
    expect(noInbox).not.toContain("mailto:");
  });

  it("a very long name or address breaks anywhere rather than pushing the card wider than a phone", () => {
    const long = "H".repeat(120);
    const waiting = draw(createElement(CompanySetup, { signup: { allowed: false, contact, request: request({ companyName: long, email: `${long}@stranger.test` }) } }));
    expect(waiting).toMatch(/<div class="[^"]*\bwrap-anywhere\b[^"]*">(?:(?!<\/div>)[\s\S])*H{120}/);
    expect(draw(createElement(CompanySetup, { signup: { allowed: false, contact: `${long}@its.example`, request: request({ status: "declined" }) } }))).toMatch(/<p class="[^"]*\bwrap-anywhere\b[^"]*">Questions\?/);
  });

  it("what a person typed is drawn as text: markup in a company's name stays words", () => {
    const html = draw(createElement(CompanySetup, { signup: { allowed: false, contact, request: request({ companyName: "<img src=x onerror=alert(1)>" }) } }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("a person with a request lands on the same screen from any signed-in address", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const open = async () => (await page.default()) as ReactElement<{ signup: { door?: string; request?: { status: string; companyName: string; email: string; emailedAt: string | null } } }>;
  const send = (cookie: string, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: JSON.stringify(body) });
  const form = { name: "Harbor Dental", ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", website: "https://asker.example", locations: [{ city: "Austin", region: "TX", country: "US" }] };
  /** Where each kind of signed-in address sends this person, or "stays" when it draws. */
  const landsOn = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "stays";
    } catch (e) {
      return String((e as Error).message);
    }
  };
  const everyDoor = async () => ({
    company: await landsOn(() => companyLayout.default({ children: null })),
    admin: await landsOn(() => adminLayout.default({ children: null })),
    recruiter: await landsOn(() => recruiterLayout.default({ children: null })),
    login: await landsOn(() => login.default({ searchParams: Promise.resolve({}) })),
    setup: await landsOn(() => page.default()),
  });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: "approval", COMPANY_CHECK: "its", EMAIL_REPLY_TO: "recruiting@its.example" } });
    installShellForTests(container);
    app = createApp(container);
  });
  afterAll(async () => {
    jar.cookie = "";
    await container.close();
  });

  it("from the form to the waiting screen to the declined one to Home, whatever address they open on the way", async () => {
    const stranger = await signInWithIdentity(app, container, { email: "sam@stranger.test", provider: "google", aal2: false });
    jar.cookie = stranger;
    // before asking: the form, with the request's words, and the shell sends them nowhere else
    const before = await open();
    expect(before.props.signup.door).toBe("request");
    expect(before.props.signup.request).toBeUndefined();
    expect(words(draw(before))).toContain("Send my request");

    const sent = await send(stranger, "/api/v1/companies", form);
    expect(sent.status, await sent.clone().text()).toBe(201);
    const company = (await sent.json()) as { id: string };

    // waiting: signed in, with no active company, every address lands on the company step (the admin's by way of the
    // recruiter queue, whose own layout sends them on) and the frame around them holds no error
    const waiting = await open();
    expect(waiting.props.signup.request).toMatchObject({ status: "requested", companyName: "Harbor Dental", email: "sam@stranger.test" });
    expect(title(draw(waiting))).toBe("Your request has been sent");
    expect(await everyDoor()).toEqual({ company: "redirect to /setup/company", admin: "redirect to /recruiter/queue", recruiter: "redirect to /setup/company", login: "redirect to /setup/company", setup: "stays" });
    expect(await landsOn(() => appLayout.default({ children: null }))).toBe("stays");

    // signing out and in again: a new session, the same screen
    jar.cookie = await signInWithIdentity(app, container, { email: "sam@stranger.test", provider: "google", aal2: false });
    expect(title(draw(await open()))).toBe("Your request has been sent");

    // declined: the same doors, the declined screen
    const admin = await signInAdmin(app, container, "ada@identifiedtalent.com", "Ada Admin");
    expect((await send(admin, `/api/v1/admin/customers/${company.id}/access`, { decision: "decline", confirm: true })).status).toBe(200);
    expect(title(draw(await open()))).toBe("We can't offer access right now");
    expect(await everyDoor()).toEqual({ company: "redirect to /setup/company", admin: "redirect to /recruiter/queue", recruiter: "redirect to /setup/company", login: "redirect to /setup/company", setup: "stays" });

    // accepting later is the undo: Home, from the company step and from sign-in, and owner routes draw
    expect((await send(admin, `/api/v1/admin/customers/${company.id}/access`, { decision: "accept", confirm: true })).status).toBe(200);
    expect(await everyDoor()).toEqual({ company: "stays", admin: "redirect to /", recruiter: "redirect to /", login: "redirect to /", setup: "redirect to /" });
  });

  it("someone with no session is sent to sign in, and an expired one does not loop", async () => {
    jar.cookie = "ros_session=not-a-session";
    expect(await everyDoor()).toEqual({ company: "redirect to /login", admin: "redirect to /login", recruiter: "redirect to /login", login: "stays", setup: "redirect to /login" });
  });
});
