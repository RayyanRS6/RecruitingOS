import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SIGN_IN_REFUSAL } from "@ros/contracts";
import { DEFAULT_SIGN_IN_POLICY, SignInRefused, evaluateSignIn, identityForSignIn, type IdentityLike } from "../../../packages/core/src/identity";
import { InvitationRefused } from "../../../packages/core/src/invitations";

/**
 * The sign-in page's error line (Words on screen: errors stay). The sign-in callback and the staff second-factor step
 * send a refused sign-in back to /login?error=<code>; each refusal the identity checks make (packages/core identity.ts)
 * shows the server's own words, which say what to do, never the general "Sign-in failed. Try again.", which for most of
 * them would be wrong advice: trying again cannot work. The page and the server read one table of code to sentence
 * (`SIGN_IN_REFUSAL` in packages/contracts), so neither can say something the other does not.
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

/** The page's markup with ?error=<code>. */
const pageFor = (code: string) => {
  search.query = `error=${encodeURIComponent(code)}`;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Login)));
};
/** The page's words with ?error=<code>, tags dropped. */
const wordsFor = (code: string) => pageFor(code).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** The product's name as the page's heading writes it ("OS" sits in a span of its own). */
const productName = () => pageFor("").match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]!.replace(/<[^>]+>/g, "").trim();

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
    evaluateSignIn({ ...person, emailVerified: false }, null, DEFAULT_SIGN_IN_POLICY),
    // staff, through Microsoft, and no second factor yet
    evaluateSignIn({ ...person, email: "ivy@identifiedtalent.com", provider: "azure", providers: ["azure"] }, null, DEFAULT_SIGN_IN_POLICY),
  ]) {
    if (refused.ok) throw new Error("expected a refusal");
    out[refused.code] = refused.message;
  }
  return out;
}

describe("the sign-in page's error line", () => {
  it("shows the server's own words for each refusal of the identity checks", () => {
    const refusals = serverWords();
    expect(Object.keys(refusals).sort()).toEqual(["email_invalid", "email_unverified", "mfa_required", "provider_mismatch", "provider_not_allowed", "staff_provider_linked", "staff_provider_required"]);
    for (const [code, message] of Object.entries(refusals)) {
      const words = wordsFor(code);
      expect(words, code).toContain(message);
      expect(words, code).not.toContain("Sign-in failed. Try again.");
    }
  });

  // The page and the server each kept a sentence for these until 25 November 2026, and the two had drifted apart.
  it("shows, for an account linked to another identity and for an invitation that cannot be honoured, the words the server's refusal carries", () => {
    const refused = [new SignInRefused("identity_mismatch"), new InvitationRefused("invite_email_mismatch"), new InvitationRefused("invite_expired"), new InvitationRefused("invite_seats_full")];
    for (const refusal of refused) {
      const words = wordsFor(refusal.code);
      expect(refusal.message, refusal.code).toBe(SIGN_IN_REFUSAL[refusal.code]);
      expect(words, refusal.code).toContain(refusal.message);
      expect(words, refusal.code).not.toContain("Sign-in failed. Try again.");
    }
    // each says what to do next, and the full company's says to open the link again: the sign-in dropped it
    expect(wordsFor("invite_seats_full")).toContain("Ask the person who invited you to upgrade, then open the invitation link again.");
    expect(wordsFor("identity_mismatch")).toContain("Sign in with the account you used before, or contact ITS support to change it.");
  });

  it("has a sentence of its own for every code a refused sign-in comes back with", () => {
    for (const [code, sentence] of Object.entries(SIGN_IN_REFUSAL)) {
      const words = wordsFor(code);
      expect(words, code).toContain(sentence);
      expect(words, code).not.toContain("Sign-in failed. Try again.");
    }
  });

  it("says what a person at another company can do when Microsoft or the identity service turns the sign-in down, naming the product as the heading does", () => {
    // The sign-in callback maps each refusal the identity service brings back to one of these (apps/api/src/routes/auth.ts).
    const product = productName();
    expect(product).toMatch(/\w/);
    const said: Record<string, string> = {
      microsoft_needs_approval: `Your company's IT has to approve ${product} once before you can sign in with Microsoft. Ask them, or continue with Google.`,
      microsoft_declined: `The Microsoft sign-in did not finish. Start again and press Accept. If your IT has to approve ${product} first, try again once they have.`,
      microsoft_no_email: "Microsoft did not share an email address for this account. Ask your IT to check it, or continue with Google.",
      // A work account's address is the company's to fix, so the line says who can, and the other way in.
      email_unverified: "Your email address is not verified with the sign-in provider. Ask your IT to check the email address on your account, or use the other sign-in button.",
    };
    for (const [code, sentence] of Object.entries(said)) {
      const words = wordsFor(code);
      expect(words, code).toContain(sentence);
      expect(words, code).not.toContain("Sign-in failed. Try again.");
    }
  });

  it("falls back to the general line for a code it does not know", () => {
    expect(wordsFor("something_new")).toContain("Sign-in failed. Try again.");
  });
});
