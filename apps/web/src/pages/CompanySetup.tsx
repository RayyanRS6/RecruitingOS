"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "../nav";
import { Alert, Button, Card, Field } from "@ros/ui";
import { api, ApiError } from "../api/client";

/** The launch wedge first (docs/FOUNDER-CONTEXT.md §06): consumer, beauty, e-commerce, creative and marketing, tech-enabled services. */
const VERTICALS = [
  ["consumer", "Consumer brand or beauty"],
  ["ecommerce", "Retail or e-commerce"],
  ["marketing", "Marketing, advertising or creative agency"],
  ["saas", "Software or tech-enabled services"],
  ["professional_services", "Professional services"],
  ["dental", "Dental practice or group"],
  ["veterinary", "Veterinary"],
  ["trades", "HVAC, plumbing, electrical"],
  ["home_care", "Home care"],
  ["restaurant", "Restaurant group"],
  ["dealership", "Dealership"],
  ["other", "Something else"],
];

export function CompanySetup() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", ownerName: "", vertical: "consumer", sizeBand: "50-99", city: "", region: "CA", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/companies", { name: form.name, ownerName: form.ownerName || undefined, vertical: form.vertical, sizeBand: form.sizeBand, website: form.website || undefined, locations: [{ city: form.city, region: form.region.toUpperCase(), country: "US" }] });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the company.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="main" style={{ maxWidth: 560, margin: "6vh auto" }}>
      <h1>Tell us about your company</h1>
      <p className="muted" style={{ margin: "6px 0 18px" }}>Two minutes. This shapes every role you open: the playbook we start from, the notices candidates see, and where jobs get posted.</p>
      <Card>
        <form onSubmit={submit} className="stack">
          <Field label="Company name" htmlFor="name"><input id="name" className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Your name" htmlFor="owner"><input id="owner" className="input" value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} /></Field>
          <Field label="What kind of business" htmlFor="vertical" hint="We use a vertical playbook to draft roles, screening questions, and pay ranges.">
            <select id="vertical" className="select" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value })}>
              {VERTICALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="How many employees" htmlFor="size">
            <select id="size" className="select" value={form.sizeBand} onChange={(e) => setForm({ ...form, sizeBand: e.target.value })}>
              {["1-19", "20-49", "50-99", "100-199", "200-499", "500+"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <div className="grid-2">
            <Field label="City" htmlFor="city"><input id="city" className="input" required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label="State" htmlFor="region" hint="Two letters"><input id="region" className="input" required maxLength={2} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
          </div>
          <Field label="Website (optional)" htmlFor="web"><input id="web" className="input" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
          {error ? <Alert tone="critical">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={busy}>Create my hiring workspace</Button>
        </form>
      </Card>
    </main>
  );
}
