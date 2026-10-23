/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { CARD_PAGE_CSS } from "./signin-link";

/**
 * The staff second-factor step, server-rendered like the candidate pages: no JavaScript, the same design tokens, and the
 * per-request nonce. The secret shown at enrolment comes from the identity service and is never written anywhere by
 * this application. Its own look (`CARD_PAGE_CSS`): the six-digit code in a wide monospace box, the QR code on a white
 * tile, the setup key in a key cap.
 */
const CodeForm: FC<{ action: string; cancelAction: string; error?: string | null; label: string; button: string; cancelLabel?: string }> = (p) => (
  <>
  <form method="post" action={p.action}>
    {p.error ? <div class="err" role="alert">{p.error}</div> : null}
    <label for="code" class="flush">{p.label}</label>
    <input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength={6} required autofocus />
    <button class="btn" type="submit">{p.button}</button>
  </form>
  <form method="post" action={p.cancelAction}><button class="btn secondary" type="submit">{p.cancelLabel ?? "Cancel and return to sign-in"}</button></form>
  </>
);

function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Enrolment: the two numbered steps carry the page (fewer words, 23 October 2026). Why a backup matters is said on the
 * offer just before it (`BackupOfferPage`), and the QR code's alt text says it is to scan, so the steps need no preamble.
 */
export const EnrolPage: FC<{ secret: string; uri: string; qrSvg: string | null; backup: boolean; error?: string | null; action: string; cancelAction: string }> = (p) => (
  <Layout title={p.backup ? "Add a backup authenticator" : "Set up your authenticator app"} extraCss={CARD_PAGE_CSS}>
    <h1>{p.backup ? "Add a backup authenticator" : "Set up your authenticator app"}</h1>
    <div class="card">
      <h2>1. Add the account to your app</h2>
      {p.qrSvg ? <p><img class="qr" alt="QR code to scan with your authenticator app" width={200} height={200} src={`data:image/svg+xml;utf8,${encodeURIComponent(p.qrSvg)}`} /></p> : <p class="notice">The QR code is shown only once. If you have not added the account yet, type the setup key by hand.</p>}
      <p>Setup key: <code id="setup-key">{grouped(p.secret)}</code></p>
      <p><small>Time-based, six digits, 30 seconds. Manual entry link: <a href={p.uri}>open in an authenticator app</a>.</small></p>
    </div>
    <div class="card">
      <h2>2. Enter the code the app shows</h2>
      <CodeForm action={p.action} cancelAction={p.cancelAction} error={p.error} label="Six-digit code" button={p.backup ? "Confirm backup authenticator" : "Confirm and sign in"} cancelLabel={p.backup ? "Not now, continue to the app" : undefined} />
    </div>
  </Layout>
);

export const VerifyPage: FC<{ productName: string; error?: string | null; action: string; cancelAction: string }> = (p) => (
  <Layout title="Enter your code" extraCss={CARD_PAGE_CSS}>
    <h1>Enter your code</h1>
    <p>Open your authenticator app and enter the code it shows for {p.productName}.</p>
    <div class="card">
      <CodeForm action={p.action} cancelAction={p.cancelAction} error={p.error} label="Six-digit code" button="Sign in" />
    </div>
    <p class="notice">Lost every authenticator? Ask the platform owner to reset your second factor; you will set it up again at your next sign-in.</p>
  </Layout>
);

/** One choice after sign-in: add a backup now, or "Not now", which ends the step and continues to the app. */
export const BackupOfferPage: FC<{ backupHref: string; skipAction: string }> = (p) => (
  <Layout title="Add a backup authenticator?" extraCss={CARD_PAGE_CSS}>
    <h1>You are signed in.</h1>
    <p>You have one authenticator. If that phone is lost, only the platform owner can reset your second factor. A backup authenticator on another device avoids that.</p>
    <div class="actions">
      <a class="btn" href={p.backupHref}>Add a backup authenticator</a>
      <form method="post" action={p.skipAction}>
        <button class="btn secondary" type="submit">Not now</button>
      </form>
    </div>
  </Layout>
);
