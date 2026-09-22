/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "./layout";

/**
 * The staff second-factor step, server-rendered like the candidate pages: no JavaScript, the same design tokens, and the
 * per-request nonce. The secret shown at enrolment comes from the identity service and is never written anywhere by
 * this application.
 */
const CodeForm: FC<{ action: string; cancelAction: string; error?: string | null; label: string; button: string }> = (p) => (
  <form method="post" action={p.action}>
    {p.error ? <div class="err" role="alert">{p.error}</div> : null}
    <label for="code">{p.label}</label>
    <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength={6} required autofocus />
    <p><button class="btn" type="submit">{p.button}</button></p>
    <p><small>Codes change every 30 seconds. Enter the one showing now.</small></p>
    <p><small><a href={p.cancelAction}>Cancel and return to sign-in</a></small></p>
  </form>
);

function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export const EnrolPage: FC<{ productName: string; secret: string; uri: string; qrSvg: string | null; backup: boolean; error?: string | null; action: string; cancelAction: string }> = (p) => (
  <Layout title={p.backup ? "Add a backup authenticator" : "Set up your authenticator app"}>
    <h1>{p.backup ? "Add a backup authenticator" : "Set up your authenticator app"}</h1>
    <p>
      {p.backup
        ? "A second authenticator, on another phone or in a second app, is your way back in if the first one is lost. The identity service issues no recovery codes."
        : `ITS staff sign in to ${p.productName} with Microsoft and a code from an authenticator app. Add the account to your app now; you will type a code from it at every sign-in.`}
    </p>
    <div class="card">
      <h2>1. Add the account to your app</h2>
      {p.qrSvg ? <p><img alt="QR code to scan with your authenticator app" width={180} height={180} src={`data:image/svg+xml;utf8,${encodeURIComponent(p.qrSvg)}`} /></p> : null}
      <p>Scan the code, or enter this key by hand:</p>
      <p>Setup key: <code id="setup-key">{grouped(p.secret)}</code></p>
      <p><small>Time-based, six digits, 30 seconds. Manual entry link: <a href={p.uri}>open in an authenticator app</a>.</small></p>
    </div>
    <div class="card">
      <h2>2. Enter the code the app shows</h2>
      <CodeForm action={p.action} cancelAction={p.cancelAction} error={p.error} label="Six-digit code" button={p.backup ? "Confirm backup authenticator" : "Confirm and sign in"} />
    </div>
  </Layout>
);

export const VerifyPage: FC<{ productName: string; error?: string | null; action: string; cancelAction: string }> = (p) => (
  <Layout title="Enter your code">
    <h1>Enter your code</h1>
    <p>Open your authenticator app and enter the code it shows for {p.productName}.</p>
    <div class="card">
      <CodeForm action={p.action} cancelAction={p.cancelAction} error={p.error} label="Six-digit code" button="Sign in" />
    </div>
    <p class="notice">Lost every authenticator? Ask the platform owner to reset your second factor; you will set it up again at your next sign-in.</p>
  </Layout>
);

export const BackupOfferPage: FC<{ backupHref: string; skipAction: string; continueHref: string }> = (p) => (
  <Layout title="Add a backup authenticator?">
    <h1>You are signed in.</h1>
    <p>You have one authenticator. If that phone is lost, only the platform owner can reset your second factor. A backup authenticator on another device avoids that.</p>
    <div class="card">
      <p><a class="btn" href={p.backupHref}>Add a backup authenticator</a></p>
      <form method="post" action={p.skipAction}>
        <p><button class="btn" type="submit" style="background:var(--bg2);color:var(--accent-ink);border:1px solid var(--line)">Not now</button></p>
      </form>
      <p><small>You can add one at any later sign-in from this same screen. <a href={p.continueHref}>Continue to the app</a>.</small></p>
    </div>
  </Layout>
);
