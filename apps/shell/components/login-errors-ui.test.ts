import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SIGN_IN_POLICY, evaluateSignIn, identityForSignIn, type IdentityLike } from "../../../packages/core/src/identity";

/**
 * The sign-in page's error line (Words on screen: errors stay). The sign-in callback and the staff second-factor step
 * send a refused sign-in back to /login?error=<code>; each refusal the identity checks make (packages/core identity.ts)
 * shows the server's own words, which say what to do, never the general "Sign-in failed. Try again.", which for most of
 * them would be wrong advice: trying again cannot work.
 */
const search = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(search.query),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Login } = await import("@ros/web/src/pages/Login");

/** The page's words with ?error=<code>, tags dropped. */
const wordsFor = (code: string) => {
  search.query = `error=${encodeURIComponent(code)}`;
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Login)));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
};

/** The message the server gives with a refusal, so the page and the server cannot drift apart. */
function serverWords(): Record<string, string> {
  const person: IdentityLike = { subject: "sub-1", email: "dana@brightline.test", emailVerified: true, name: "Dana", provider: "google", providers: ["google"], aal: "aal1", mfaVerifiedAt: null };
  const out: Record<string, string> = {};
  for (const refused of [
    identityForSignIn({ ...person, provider: "email", providers: ["email"] }, null),
    identityForSignIn(person, "azure"),
    identityForSignIn({ ...person, email: "" }, null),
    evaluateSignIn({ ...person, email: "ivy@identifiedtalent.com", provider: "azure", providers: ["azure", "google"], aal: "aal2" }, null, DEFAULT_SIGN_IN_POLICY),
    evaluateSignIn({ ...person, email: "ivy@identifiedtalent.com", provider: "google" }, null, DEFAULT_SIGN_IN_POLICY),
  ]) {
    if (refused.ok) throw new Error("expected a refusal");
    out[refused.code] = refused.message;
  }
  return out;
}

describe("the sign-in page's error line", () => {
  it("shows the server's own words for each refusal of the identity checks", () => {
    const refusals = serverWords();
    expect(Object.keys(refusals).sort()).toEqual(["email_invalid", "provider_mismatch", "provider_not_allowed", "staff_provider_linked", "staff_provider_required"]);
    for (const [code, message] of Object.entries(refusals)) {
      const words = wordsFor(code);
      expect(words, code).toContain(message);
      expect(words, code).not.toContain("Sign-in failed. Try again.");
    }
  });

  it("falls back to the general line for a code it does not know", () => {
    expect(wordsFor("something_new")).toContain("Sign-in failed. Try again.");
  });
});
