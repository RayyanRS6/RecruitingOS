"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "../nav";
import { Alert, Button, Eyebrow, Field } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { VERTICALS, ZONE_CHOICES, browserTimeZone, snapTimeZone, verticalHint } from "../company-setup";
import { browserStorage } from "../start-hire";
import { clearAllQuickStarts } from "./new-role/quick-start";

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
    clearAllQuickStarts(browserStorage());
    qc.clear();
    nav("/login", { replace: true });
  };
  return (
    // The application card of screenshot 5, alone on the page's glow: what this is, then the form, Sign out at the top.
    <main className="mx-auto w-full max-w-[620px] px-4 py-10 sm:py-16">
      <div className="rounded-[20px] border border-line bg-surface px-5 py-7 shadow-sm motion-safe:animate-enter sm:px-9 sm:py-9">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Eyebrow>Getting started</Eyebrow>
            <h1 className="mt-2 text-[30px] sm:text-[34px]">Tell us about your company</h1>
          </div>
          <Button variant="quiet" size="sm" loading={leaving} onClick={signOut}>Sign out</Button>
        </div>
        <p className="mt-3 max-w-[56ch] text-[15px] text-ink-2">Two minutes. This shapes every role you open: how it is drafted, the notices candidates see, and where jobs get posted.</p>
        <form onSubmit={submit} className="stack mt-7 gap-5 border-t border-line pt-7">
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
          <div className="grid gap-5 sm:grid-cols-2">
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
          {/* the one main action, at the end of the form: a pill on the right, the full width on a phone */}
          <div className="flex justify-end pt-1 max-sm:[&>.btn]:w-full">
            <Button type="submit" variant="primary" loading={busy} iconEnd="arrow-right">Create my hiring workspace</Button>
          </div>
        </form>
      </div>
    </main>
  );
}
