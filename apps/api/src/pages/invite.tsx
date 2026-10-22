/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { CARD_PAGE_CSS } from "./signin-link";

/**
 * The page an emailed team invitation opens. Opening it signs nobody in: it names the company and the role, and offers
 * the ways to sign in with the invited address (Google, Microsoft, and an emailed link only where the deployment allows
 * one). The invitation itself rides in a sealed cookie the sign-in reads; the token in the link never becomes a session.
 */
export type InvitePageProps = {
  productName: string;
  state: "pending" | "expired" | "revoked" | "accepted" | "unknown" | "sent";
  companyName: string | null;
  email: string | null;
  roleWords: string | null;
  providers: Array<{ key: string; label: string }>;
  /** `${APP_BASE_URL}/api/v1/auth/start`; the provider key is appended. */
  startBase: string;
  magicLink: boolean;
  /** Where the "email me a link" form posts. */
  emailAction: string;
  token: string;
  loginHref: string;
};

export function renderInvitePage(p: InvitePageProps) {
  return <InvitePage {...p} />;
}

export const InvitePage: FC<InvitePageProps> = (p) => {
  if (p.state === "sent") {
    return (
      <Layout title={`Check your email · ${p.productName}`} extraCss={CARD_PAGE_CSS}>
        <p class="eyebrow">{p.productName}</p>
        <h1>Check your email</h1>
        <p>We sent a sign-in link to {p.email}. It works for 15 minutes. Open it on this device to finish joining {p.companyName}.</p>
        <p class="assure"><small>Nothing happens until you press the button in that email.</small></p>
      </Layout>
    );
  }
  if (p.state !== "pending") {
    const title = p.state === "expired" ? "This invitation has expired" : p.state === "revoked" ? "This invitation was withdrawn" : p.state === "accepted" ? "This invitation was already used" : "This invitation link is not valid";
    return (
      <Layout title={`${title} · ${p.productName}`} extraCss={CARD_PAGE_CSS}>
        <p class="eyebrow">{p.productName}</p>
        <h1>{title}</h1>
        {p.state === "expired" ? <p>Invitation links work for seven days. Ask the person who invited you to send a new one.</p> : null}
        {p.state === "revoked" ? <p>The person who sent it took it back. If you think that is a mistake, ask them for a new one.</p> : null}
        {p.state === "accepted" ? <p>You already joined{p.companyName ? ` ${p.companyName}` : ""}. Sign in to continue.</p> : null}
        {p.state === "unknown" ? <p>Check that you opened the whole link from the email, or ask the person who invited you to send it again.</p> : null}
        <div class="card"><p><a class="btn" href={p.loginHref}>Go to sign-in</a></p></div>
      </Layout>
    );
  }
  return (
    <Layout title={`Join ${p.companyName} · ${p.productName}`} extraCss={CARD_PAGE_CSS}>
      <p class="eyebrow">{p.productName}</p>
      <h1>Join {p.companyName}</h1>
      <p>You were invited to help {p.companyName} hire on {p.productName}, as {p.roleWords}.</p>
      <p>Sign in with the address the invitation was sent to: <strong>{p.email}</strong>. The invitation belongs to that address.</p>
      <div class="card">
        {p.providers.map((prov) => (
          <p><a class="btn" href={`${p.startBase}/${prov.key}`}>Continue with {prov.label}</a></p>
        ))}
        {p.magicLink ? (
          <form method="post" action={p.emailAction}>
            <input type="hidden" name="token" value={p.token} />
            <p><button class="btn secondary" type="submit">Email me a sign-in link instead</button></p>
          </form>
        ) : null}
        <p class="assure"><small>The invitation works for seven days. If you were not expecting it, close this page; nothing happens until you sign in.</small></p>
      </div>
    </Layout>
  );
};
