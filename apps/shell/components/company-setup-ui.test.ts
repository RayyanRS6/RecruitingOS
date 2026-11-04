import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@ros/api/src/app";
import { createContainer, type Container } from "@ros/api/src/container";
import { signInWithIdentity } from "@ros/api/src/test-helpers";
import { installShellForTests } from "../lib/container";

/**
 * The company step by invitation (SIGNUP_MODE=invite, GATE-V2): someone the API will not let open a company gets one
 * line where the form was, naming the ITS inbox to ask, and keeps Sign out; whoever may (an address on the list, a
 * platform administrator, anyone while sign-up is open) gets the form as before. The page's server asks the API's
 * public configuration (GET /api/v1/auth/config) in-process with the person's own cookie, so the answer is theirs.
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
