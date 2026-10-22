/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "./layout";

/**
 * The reassurance line (October 2026 redesign, the job page of the reference screens: "We never sell your
 * application…"): a small outlined shield drawn by CSS (one clip-path with a hole, no image) beside a card's last small
 * print (`p.assure`) and beside the closing line that is only the privacy link ("How we handle your information"). The
 * other closing lines ("Still nothing?…", "Prefer email?…") are not reassurances and carry no shield. Decorative: the
 * words say it. Shared by the conversation pages (SCREEN_CSS) and `CARD_PAGE_CSS`.
 */
export const FOOT_CSS = `
.assure, .foot:has(> a[href="/privacy"]:only-child) { position: relative; padding-left: 22px; }
.assure::before, .foot:has(> a[href="/privacy"]:only-child)::before { content: ""; position: absolute; top: 4px; left: 0; width: 12px; height: 14px; background: var(--ink-3); clip-path: polygon(evenodd, 50% 0, 100% 16%, 100% 50%, 86% 76%, 50% 100%, 14% 76%, 0 50%, 0 16%, 50% 0, 50% 11.5%, 12.5% 23.5%, 12.5% 47.5%, 24% 69%, 50% 86.5%, 76% 69%, 87.5% 47.5%, 87.5% 23.5%, 50% 11.5%); }
`;

/**
 * The single-card pages' own styles (sign-in link, team invitation, second factor, "Lost your link?", reusing details,
 * applying for another role, the privacy request), passed as a page's `extraCss` on top of the candidate stylesheet,
 * which draws the card, the labels above the fields and the buttons: the reassurance line, the honeypot field kept off
 * screen (a class, not a style attribute), the second factor's wide monospace code box, its setup key in a key cap and
 * its QR code on a larger white tile (the white itself comes from the candidate stylesheet's `.qr`: a code needs a light
 * ground to scan, in both themes), and a list of cards drawn as rows
 * of one list. Tokens only, no button rules, no motion. (The verify page must not name the setup key anywhere, so the
 * key cap is styled by where it sits, not by its id.)
 */
export const CARD_PAGE_CSS = `${FOOT_CSS}
.trap { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
input.code { display: block; width: 100%; max-width: 360px; min-height: 56px; padding: 10px 14px; font-family: var(--mono); font-size: 26px; font-weight: 400; letter-spacing: 0.4em; text-align: center; font-variant-numeric: tabular-nums; }
.qr { display: block; box-sizing: content-box; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-card); }
.card p > code { display: inline-block; padding: 3px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--ink); font-family: var(--mono); font-size: 15px; letter-spacing: 0.06em; overflow-wrap: anywhere; }
ul.roles { display: block; margin: 14px 0; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); list-style: none; }
ul.roles > li.card { margin: 0; padding: 14px 18px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
ul.roles > li.card + li.card { border-top: 1px solid var(--line); }
ul.roles > li.card > p { margin: 0; }
ul.roles > li.card > p + p { margin-top: 2px; }
ul.roles > li.card > form { margin-top: 10px; }
ul.roles > li.card > details { margin-top: 4px; }
`;

/**
 * The page an emailed sign-in or invitation link opens. Opening the link changes nothing: mail scanners and link
 * previews fetch links, and a single-use link must survive that. The person presses the button, which posts the token
 * and opens the session with a top-level redirect (the reliable way to set a cookie from a link).
 */
type Props = { token: string; productName: string; action: string; invite: boolean };

/** Renders the page for a route file that has no JSX of its own. */
export function renderSignInLinkPage(p: Props) {
  return <SignInLinkPage {...p} />;
}

export const SignInLinkPage: FC<Props> = (p) => (
  <Layout title={p.invite ? `Join your team on ${p.productName}` : `Sign in to ${p.productName}`} extraCss={CARD_PAGE_CSS}>
    <p class="eyebrow">{p.productName}</p>
    <h1>{p.invite ? "Accept your invitation" : "Sign in"}</h1>
    <p>{p.invite ? "Press the button to join the workspace you were invited to." : "Press the button to finish signing in. The link works once."}</p>
    <div class="card">
      <form method="post" action={p.action}>
        <input type="hidden" name="token" value={p.token} />
        <p><button class="btn" type="submit">Continue to {p.productName}</button></p>
      </form>
      <p class="assure"><small>If you did not request this link, close this page; nothing happens until the button is pressed.</small></p>
    </div>
  </Layout>
);
