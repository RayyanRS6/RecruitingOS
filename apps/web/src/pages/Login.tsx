"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "../nav";
import { Alert, Button, Card, Field } from "@ros/ui";
import { api, ApiError } from "../api/client";

const API_BASE = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? "";
const ERRORS: Record<string, string> = {
  expired: "That sign-in link is invalid or has expired. Request a new one.",
  signin_incomplete: "The sign-in did not complete. Start again.",
  staff_provider_required: "ITS staff sign in with their Microsoft 365 account.",
  mfa_required: "ITS staff need a second factor. Finish multi-factor sign-in with Microsoft and try again.",
  email_unverified: "Your email address is not verified with the sign-in provider. Verify it and try again.",
  exchange_failed: "The sign-in could not be completed. Try again.",
};

/**
 * Sign-in is delegated to the managed identity service (D19): Google or Microsoft through a PKCE flow that starts and
 * ends on the API, so no token ever touches this page. The email link stays only where the deployment enables it.
 */
export function Login() {
  const [params] = useSearchParams();
  const config = useQuery({ queryKey: ["auth", "config"], queryFn: () => api.get<{ mode: string; providers: Array<{ key: string; label: string }>; magicLink: boolean }>("/api/v1/auth/config") });
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const errParam = params.get("error");
  const [error, setError] = useState<string | null>(errParam ? ERRORS[errParam] ?? "Sign-in failed. Try again." : null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await api.post<{ ok: boolean; devLink?: string }>("/api/v1/auth/magic-link", { email }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the link.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="main" style={{ maxWidth: 480, margin: "8vh auto" }}>
      <h1 style={{ marginBottom: 6 }}>Recruiting OS</h1>
      <p className="muted" style={{ marginBottom: 20 }}>A recruiting department for companies too small to have one.</p>
      <Card>
        <div className="stack">
          {error ? <Alert tone="critical">{error}</Alert> : null}
          {config.data?.providers.length ? (
            <div className="stack" style={{ gap: 8 }}>
              {config.data.providers.map((p) => (
                <a key={p.key} className="btn primary" href={`${API_BASE}/api/v1/auth/start/${p.key}`} style={{ textAlign: "center", textDecoration: "none" }}>Continue with {p.label}</a>
              ))}
              {config.data.mode === "fake_identity" ? <p className="small muted">Development: the provider buttons open a fake sign-in page; nothing leaves this machine.</p> : null}
              <p className="small muted">ITS staff: use Microsoft with your second factor.</p>
            </div>
          ) : null}
          {config.data?.magicLink ? (
            sent ? (
              <div className="stack">
                <Alert tone="info">Check your email for a sign-in link. It works for 15 minutes.</Alert>
                {sent.devLink ? <p className="small">Development mode: <a href={sent.devLink}>open the sign-in link</a></p> : null}
              </div>
            ) : (
              <form onSubmit={submit} className="stack">
                <Field label="Or use your work email" htmlFor="email" hint="No password. We email you a link.">
                  <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Button type="submit" variant="secondary" loading={busy}>Email me a sign-in link</Button>
              </form>
            )
          ) : null}
        </div>
      </Card>
    </main>
  );
}

export function LoginConsume() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const consumed = useRef(false);
  useEffect(() => {
    const token = params.get("token");
    if (!token) { setError("Missing token."); return; }
    if (consumed.current) return; // React StrictMode runs effects twice in development; the link is single-use
    consumed.current = true;
    api.post<{ ok: boolean; activeCompanyId: string | null }>("/api/v1/auth/magic-link/consume", { token })
      .then(async (r) => {
        // Wait for the session to be re-read before leaving, or the app shell bounces back to /login.
        await qc.refetchQueries({ queryKey: ["me"] });
        nav(r.activeCompanyId ? "/" : "/setup/company", { replace: true });
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "This link is not valid."));
  }, [params, nav, qc]);
  return (
    <main className="main" style={{ maxWidth: 480, margin: "8vh auto" }}>
      <Card>{error ? <div className="stack"><Alert tone="critical">{error}</Alert><Button onClick={() => nav("/login")}>Request a new link</Button></div> : <p>Signing you in…</p>}</Card>
    </main>
  );
}
