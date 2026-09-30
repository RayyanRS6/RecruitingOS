/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "./layout";

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
  <Layout title={p.invite ? `Join your team on ${p.productName}` : `Sign in to ${p.productName}`}>
    <h1>{p.invite ? "Accept your invitation" : "Sign in"}</h1>
    <p>{p.invite ? "Press the button to join the workspace you were invited to." : "Press the button to finish signing in. The link works once."}</p>
    <div class="card">
      <form method="post" action={p.action}>
        <input type="hidden" name="token" value={p.token} />
        <p><button class="btn" type="submit">Continue to {p.productName}</button></p>
      </form>
      <p><small>If you did not request this link, close this page; nothing happens until the button is pressed.</small></p>
    </div>
  </Layout>
);
