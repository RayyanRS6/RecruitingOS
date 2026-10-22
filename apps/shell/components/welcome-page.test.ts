import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { cspHeaderName, cspMode } from "../lib/csp";
import { middleware } from "../middleware";

/**
 * The public welcome page (/welcome, October 2026 redesign, screenshot 2) as the server draws it, and the one change in
 * middleware.ts that sends someone without a session from the address of Home to it. The page is static: one main
 * heading, sections the header links to, every way in leading to the sign-in page (where an invitation is opened too),
 * and nothing to fill in, because there is no sign-up or pilot request behind it.
 */
(globalThis as { React?: typeof React }).React = React;
const page = await import("../app/(public)/welcome/page");
const html = renderToStaticMarkup(React.createElement(page.default));

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: /\shref="([^"]*)"/.exec(m[1])?.[1], name: text(m[2]) }));
const named = (name: string) => links.filter((l) => l.name === name);

describe("the public welcome page", () => {
  it("has one main heading, the hero's promise, and headings that never skip a level", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)![1])).toBe("Hiring, made more manageable.");
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i], `heading ${i + 1}`).toBeLessThanOrEqual(levels[i - 1] + 1);
    // How it works, For owners, the review section and the closing call to action
    expect(levels.filter((l) => l === 2)).toHaveLength(4);
  });

  it("every way in leads to the sign-in page", () => {
    // the header's and the footer's
    expect(named("Sign in").map((l) => l.href)).toEqual(["/login", "/login"]);
    expect(named("Have an invitation?").map((l) => l.href)).toEqual(["/login"]);
    // the hero's button and the closing card's
    expect(named("Open your invitation").map((l) => l.href)).toEqual(["/login", "/login"]);
    // nowhere else: the sign-in page, Home's address (the logo) or a section of this page
    for (const l of links) expect(["/login", "/", "#how-it-works", "#for-owners"], `${l.name} -> ${l.href}`).toContain(l.href);
  });

  it("the header's links land on sections that exist", () => {
    expect(named("How it works").length).toBeGreaterThanOrEqual(1);
    expect(named("For owners")).toHaveLength(1);
    for (const l of links.filter((x) => x.href?.startsWith("#"))) expect(html, l.href).toContain(` id="${l.href!.slice(1)}"`);
    expect(html).toMatch(/<section id="how-it-works" aria-labelledby="how-title"/);
    expect(html).toMatch(/<section id="for-owners" aria-labelledby="owners-title"/);
  });

  it("asks for nothing: no form, no field, no button", () => {
    for (const tag of ["<form", "<input", "<textarea", "<select", "<button"]) expect(html).not.toContain(tag);
  });

  it("promises only what the product does: no applicant AI opt-in, consent switch or optional AI review", () => {
    // there is no such choice for applicants (spec 0.3, no fake features): AI helps every review and a person decides
    expect(text(html)).not.toMatch(/opt in|opt-in|opted in|AI consent|remains optional|optional AI/i);
    expect(text(html)).toContain("never declined automatically");
  });

  it("is titled Recruiting OS, with a description", () => {
    expect(page.metadata.title).toBe("Recruiting OS");
    expect(String(page.metadata.description ?? "").length).toBeGreaterThan(40);
  });

  it("moves only for someone who allows motion, has no inline style, and hides its drawings from screen readers", () => {
    const animated = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).filter((c) => /animate-/.test(c));
    expect(animated.length).toBeGreaterThan(0);
    for (const c of animated) for (const name of c.split(" ").filter((n) => n.includes("animate-"))) expect(name, c).toMatch(/^motion-safe:animate-/);
    // the hero settles quickly: a 30 ms stagger, the last rise starting by 120 ms (redesign spec 4)
    const delays = [...html.matchAll(/\[animation-delay:(\d+)ms\]/g)].map((m) => Number(m[1]));
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(d % 30, `${d}ms`).toBe(0);
      expect(d, `${d}ms`).toBeLessThanOrEqual(120);
    }
    expect(html).not.toContain(" style=\"");
    const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg).toContain("aria-hidden=\"true\"");
    // one banner, one main, one footer; the two link lists are told apart by name
    for (const tag of ["<header", "<main", "<footer"]) expect(html.split(tag)).toHaveLength(2);
    expect(html).toContain("<nav aria-label=\"On this page\"");
    expect(html).toContain("<nav aria-label=\"Footer\"");
  });
});

describe("the address of Home for someone without a session (middleware.ts)", () => {
  const policyHeader = cspHeaderName(cspMode(process.env.CSP_MODE));

  it("sends a visitor with no session cookie from the bare address of Home to the welcome page, and the redirect still carries the policy", () => {
    const res = middleware(new NextRequest("https://app.test/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/welcome");
    expect(res.headers.get(policyHeader)).toContain("frame-ancestors 'none'");
  });

  it("a Home link from the app's emails (with a query) goes on to sign-in as before, not to the welcome page", () => {
    for (const address of ["https://app.test/?request=abc", "https://app.test/?start=1"]) {
      const res = middleware(new NextRequest(address));
      expect(res.headers.get("x-middleware-next"), address).toBe("1");
      expect(res.headers.get("location"), address).toBeNull();
      expect(res.headers.get(policyHeader), address).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    }
  });

  it("with a session cookie Home is unchanged, and every other page goes on as before", () => {
    const signedIn = middleware(new NextRequest("https://app.test/", { headers: { cookie: "ros_theme=dark; ros_session=abc" } }));
    expect(signedIn.headers.get("x-middleware-next")).toBe("1");
    expect(signedIn.headers.get("location")).toBeNull();
    expect(signedIn.headers.get(policyHeader)).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    // another cookie alone is not a session
    expect(middleware(new NextRequest("https://app.test/", { headers: { cookie: "ros_theme=dark" } })).headers.get("location")).toBe("https://app.test/welcome");
    // signed out, the welcome page, the sign-in page and the private pages pass through (those layouts send to sign-in)
    for (const path of ["/welcome", "/login", "/roles", "/setup"]) {
      const res = middleware(new NextRequest(`https://app.test${path}`));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get(policyHeader), path).toContain("frame-ancestors 'none'");
    }
  });
});
