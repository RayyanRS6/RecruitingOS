"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "../nav";
import { Alert, Button, Card, ErrorState, Eyebrow, Field, Skeleton } from "@ros/ui";
import { api, ApiError } from "../api/client";

const ERRORS: Record<string, string> = {
  invite_email_mismatch: "That invitation was sent to a different email address. Sign in with the address the invitation was sent to, or continue without it.",
  invite_expired: "That invitation has expired or was withdrawn. Ask the person who invited you for a new one, then sign in as usual.",
  mfa_expired: "The second-factor step timed out. Sign in again.",
  mfa_failed: "The code was wrong too many times. Sign in again.",
  mfa_unavailable: "The second-factor service is not available right now. Try again in a few minutes.",
  expired: "That sign-in link is invalid or has expired. Request a new one.",
  signin_incomplete: "The sign-in did not complete. Start again.",
  staff_provider_required: "ITS staff sign in with their Microsoft 365 account.",
  mfa_required: "ITS staff need a second factor. Finish multi-factor sign-in with Microsoft and try again.",
  email_unverified: "Your email address is not verified with the sign-in provider. Verify it and try again.",
  exchange_failed: "The sign-in could not be completed. Try again.",
  identity_mismatch: "This email address is already linked to a different Google or Microsoft account. Sign in with the account you used before, or contact ITS support to change it.",
};

/**
 * Sign-in is delegated to the managed identity service (D19): Google or Microsoft through a PKCE flow that starts and
 * ends on the API, so no token ever touches this page. The email link stays only where the deployment enables it; the
 * link itself opens a one-button page on the API, so this page has nothing to consume.
 */
export function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const config = useQuery({ queryKey: ["auth", "config"], queryFn: () => api.get<{ mode: string; providers: Array<{ key: string; label: string }>; magicLink: boolean }>("/api/v1/auth/config") });
  const [email, setEmail] = useState("");
  const errParam = params.get("error");
  const send = useMutation({
    mutationFn: () => api.post<{ ok: boolean; devLink?: string }>("/api/v1/auth/magic-link", { email }),
  });
  // The invitation the browser still carries after "sent to a different address": dropped on request, so the person can sign in as themselves.
  const forgetInvite = useMutation({
    mutationFn: () => api.post("/api/v1/auth/invite/forget"),
    onSuccess: () => navigate("/login", { replace: true }),
  });
  // A failed "Continue without the invitation" says so in the same alert, instead of leaving the person stuck with no answer.
  const forgetError = forgetInvite.error ? (forgetInvite.error instanceof ApiError ? forgetInvite.error.message : "Could not clear the invitation. Try again.") : null;
  const base = send.error ? (send.error instanceof ApiError ? send.error.message : "Could not send the link.") : errParam ? ERRORS[errParam] ?? "Sign-in failed. Try again." : null;
  const error = forgetError ? (base ? `${base} ${forgetError}` : forgetError) : base;
  return (
    <main className="main" style={{ maxWidth: 480, margin: "8vh auto" }}>
      <Eyebrow>Sign in</Eyebrow>
      <h1 style={{ margin: "6px 0" }}>Recruiting OS</h1>
      <p className="muted" style={{ marginBottom: 20 }}>A recruiting department for companies too small to have one.</p>
      <Card>
        <div className="stack">
          {error ? <Alert tone="critical">{error}</Alert> : null}
          {errParam === "invite_email_mismatch" ? <div><Button variant="quiet" size="sm" loading={forgetInvite.isPending} onClick={() => forgetInvite.mutate()}>Continue without the invitation</Button></div> : null}
          {/* The sign-in choices come from the server; if they cannot be loaded, say so and offer a retry instead of an empty card. */}
          {config.isLoading ? <Skeleton lines={2} /> : config.error ? <ErrorState message="We could not load the sign-in options. Check your connection and try again." onRetry={() => config.refetch()} /> : null}
          {config.data?.providers.length ? (
            <div className="stack" style={{ gap: 8 }}>
              {config.data.providers.map((p) => (
                <a key={p.key} className="btn primary" href={`/api/v1/auth/start/${p.key}`} style={{ textAlign: "center", textDecoration: "none" }}>Continue with {p.label}</a>
              ))}
              {config.data.mode === "fake_identity" ? <p className="small muted">Development: the provider buttons open a fake sign-in page; nothing leaves this machine.</p> : null}
            </div>
          ) : null}
          {config.data?.magicLink ? (
            send.data ? (
              <div className="stack">
                <Alert tone="info">Check your email for a sign-in link. It works for 15 minutes.</Alert>
                {send.data.devLink ? <p className="small">Development mode: <a href={send.data.devLink}>open the sign-in link</a></p> : null}
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); send.mutate(); }} className="stack">
                <Field label="Or use your work email" htmlFor="email" hint="No password. We email you a link.">
                  <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Button type="submit" variant="secondary" loading={send.isPending}>Email me a sign-in link</Button>
              </form>
            )
          ) : null}
          {config.data?.providers.length ? (
            <details className="small muted">
              <summary>ITS staff</summary>
              <p style={{ marginTop: 6 }}>Sign in with Microsoft and your second factor.</p>
            </details>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
