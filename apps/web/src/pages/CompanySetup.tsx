"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "../nav";
import { Alert, Button, Card, Eyebrow, Field } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { VERTICALS, ZONE_CHOICES, browserTimeZone, snapTimeZone, verticalHint } from "../company-setup";

const SIZE_BANDS = ["1-19", "20-49", "50-99", "100-199", "200-499", "500+"];

/**
 * Sign-up's one short form. Nothing is guessed for the owner: the state and the size start empty, and the time zone
 * starts from their own computer (it sets interview times and the hours candidates may be texted, so a wrong one is a
 * compliance problem). Someone who signed in with the wrong account can sign out from here.
 */
export function CompanySetup() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", ownerName: "", vertical: "consumer", sizeBand: "", city: "", region: "", timezone: "", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The computer's own zone is read after the first render: the server that renders the page first has its own clock.
  useEffect(() => {
    const zone = snapTimeZone(browserTimeZone());
    if (zone) setForm((f) => (f.timezone ? f : { ...f, timezone: zone }));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/companies", { name: form.name, ownerName: form.ownerName || undefined, vertical: form.vertical, sizeBand: form.sizeBand, timezone: form.timezone, website: form.website || undefined, locations: [{ city: form.city, region: form.region.toUpperCase(), country: "US" }] });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the company.");
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setLeaving(true);
    try {
      await api.post("/api/v1/auth/logout");
    } catch {
      // signed out already, or the session had ended: the sign-in page is where they are going either way
    }
    qc.clear();
    nav("/login", { replace: true });
  };
  return (
    <main className="main" style={{ maxWidth: 560, margin: "6vh auto" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <Eyebrow>Getting started</Eyebrow>
          <h1 style={{ marginTop: 6 }}>Tell us about your company</h1>
        </div>
        <Button variant="quiet" size="sm" loading={leaving} onClick={signOut}>Sign out</Button>
      </div>
      <p className="muted" style={{ margin: "6px 0 18px" }}>Two minutes. This shapes every role you open: how it is drafted, the notices candidates see, and where jobs get posted.</p>
      <Card>
        <form onSubmit={submit} className="stack">
          <Field label="Company name" htmlFor="name"><input id="name" className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Your name" htmlFor="owner"><input id="owner" className="input" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} /></Field>
          <Field label="What kind of business" htmlFor="vertical" hint={verticalHint(form.vertical)}>
            <select id="vertical" className="select" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value })}>
              {VERTICALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="How many employees" htmlFor="size">
            <select id="size" className="select" required value={form.sizeBand} onChange={(e) => setForm({ ...form, sizeBand: e.target.value })}>
              <option value="" disabled>Choose a size</option>
              {SIZE_BANDS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <div className="grid-2">
            <Field label="City" htmlFor="city"><input id="city" className="input" required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label="State" htmlFor="region" hint="Two letters, for example TX"><input id="region" className="input" required minLength={2} maxLength={2} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
          </div>
          <Field label="Time zone" htmlFor="timezone" hint="Interview times and the hours candidates may be texted use this. We started from your computer's setting.">
            <select id="timezone" className="select" required value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              <option value="" disabled>Choose a time zone</option>
              {ZONE_CHOICES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
            </select>
          </Field>
          <Field label="Website (optional)" htmlFor="web"><input id="web" className="input" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
          {error ? <Alert tone="critical">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={busy}>Create my hiring workspace</Button>
        </form>
      </Card>
    </main>
  );
}
