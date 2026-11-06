"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SignupConfig, SignupRequest } from "@ros/contracts";
import { useNavigate } from "../nav";
import { Alert, Button, Field } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { ACCESS_LOOK_MS, VERTICALS, ZONE_CHOICES, browserTimeZone, lookAtAccess, snapTimeZone, verticalHint } from "../company-setup";
import { focusLost } from "../focus-after";
import { browserStorage } from "../start-hire";
import { clearAllQuickStarts } from "./new-role/quick-start";

const SIZE_BANDS = ["1-19", "20-49", "50-99", "100-199", "200-499", "500+"];

/**
 * Who may create a company (GATE-V2) and this person's own request if they sent one: the `signup` part of
 * GET /api/v1/auth/config, as the page's server asked it.
 */
export type SignupAnswer = Pick<SignupConfig, "allowed" | "door" | "request"> & { contact: string | null };

const WAITING_TITLE = "Your request has been sent";
const DECLINED_TITLE = "We can't offer access right now";

/**
 * Sign-up's one short form. Nothing is guessed for the owner: the state and the size start empty, and the time zone
 * starts from their own computer (it sets interview times and the hours candidates may be texted, so a wrong one is a
 * compliance problem). Someone who signed in with the wrong account can sign out from here.
 *
 * By invitation (SIGNUP_MODE=invite, GATE-V2), someone the API will not let open a company (`signup.allowed` false) gets
 * one line where the form was: ask ITS for an invitation, at the inbox job pages already print. Without an answer the form
 * shows as before, and the API still refuses whoever it should.
 *
 * By approval (SIGNUP_MODE=approval), the same form sends a request (`signup.door` "request"), and the API's answer, not
 * the door, decides what follows: nothing opens until ITS accepts, so the page stays and says so. A person with a request
 * always lands here whatever address they open (the shell's layouts send anyone with no active company here), and reads
 * the same screen: waiting or declined, in the same card, with Sign out. While they read it the page looks again every 30
 * seconds, and goes Home by itself once there is an active company. A look that fails changes nothing (`lookAtAccess`).
 */
export function CompanySetup({ signup }: { signup?: SignupAnswer | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", ownerName: "", vertical: "consumer", sizeBand: "", city: "", region: "", timezone: "", website: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // This person's own request: as the server read it for the page, then as the form's answer and each look found it.
  const [request, setRequest] = useState<SignupRequest | null>(signup?.request ?? null);
  const [contact, setContact] = useState(signup?.contact ?? null);
  // The zone taken from the computer, so the field can say it is a guess to check while it is still the one chosen.
  const [guessedZone, setGuessedZone] = useState("");
  // The computer's own zone is read after the first render: the server that renders the page first has its own clock.
  useEffect(() => {
    const zone = snapTimeZone(browserTimeZone());
    if (zone) {
      setGuessedZone(zone);
      setForm((f) => (f.timezone ? f : { ...f, timezone: zone }));
    }
  }, []);
  const look = async () => {
    const standing = await lookAtAccess((path) => api.get(path));
    if (standing?.home) {
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } else if (standing) {
      setRequest(standing.request);
      setContact(standing.contact);
    }
    return standing;
  };
  const hasRequest = !!request;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one timer for as long as there is a request; `look` only reads what never changes
  useEffect(() => {
    if (!hasRequest) return;
    const timer = setInterval(() => void look().catch(() => undefined), ACCESS_LOOK_MS);
    return () => clearInterval(timer);
  }, [hasRequest]);
  // The screen changed under the person: when that dropped their focus (the form's button went) the new title takes it,
  // which a screen reader says; when it did not (Sign out has it), the title is said from the status line instead.
  const heading = useRef<HTMLHeadingElement>(null);
  const standingDrawn = useRef(request?.status);
  const [said, setSaid] = useState("");
  const title = request ? (request.status === "declined" ? DECLINED_TITLE : WAITING_TITLE) : signup && !signup.allowed ? "Recruiting OS is by invitation for now" : "Tell us about your company";
  useEffect(() => {
    if (request?.status === standingDrawn.current) return;
    standingDrawn.current = request?.status;
    if (focusLost(document.activeElement, document.body)) heading.current?.focus({ preventScroll: true });
    else setSaid(title);
  }, [request?.status, title]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answer = await api.post<{ accessRequest?: SignupRequest } | null>("/api/v1/companies", { name: form.name, ownerName: form.ownerName || undefined, vertical: form.vertical, sizeBand: form.sizeBand, timezone: form.timezone, website: form.website || undefined, locations: [{ city: form.city, region: form.region.toUpperCase(), country: "US" }] });
      if (answer?.accessRequest) {
        setRequest(answer.accessRequest);
        return;
      }
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/", { replace: true });
    } catch (err) {
      // Sent already (from another tab, say): where that request stands is the answer, not an error.
      if (err instanceof ApiError && err.code === "another_company_needs_its" && (await look())) return;
      setError(err instanceof ApiError ? err.message : signup?.door === "request" ? "Could not send your request." : "Could not create the company.");
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
  const byInvitation = signup && !signup.allowed && !request ? signup : null;
  return (
    // The application card of screenshot 5, alone on the page's glow: the title with Sign out beside it, then the form.
    <main className="mx-auto w-full max-w-[620px] px-4 py-10 sm:py-16">
      <div className="rounded-[20px] border border-line bg-surface px-5 py-7 shadow-sm motion-safe:animate-enter sm:px-9 sm:py-9">
        <div className="flex items-start justify-between gap-4">
          <h1 ref={heading} className="min-w-0 text-[30px] focus:outline-none sm:text-[34px]" tabIndex={request ? -1 : undefined}>{title}</h1>
          <Button variant="quiet" size="sm" loading={leaving} onClick={signOut} className="shrink-0">Sign out</Button>
        </div>
        <span className="sr-only" role="status">{said}</span>
        {request?.status === "requested" ? (
          // a long name or address breaks anywhere rather than pushing the card wider than a phone
          <div className="stack mt-7 gap-3 border-t border-line pt-7 wrap-anywhere">
            <p>Please wait for approval.</p>
            <p className="font-semibold">{request.companyName}</p>
            {/* no claim about email unless it really left: `emailedAt` is set only then, and email may not be live yet */}
            <p>{request.emailedAt ? `We sent a copy to ${request.email}, and we will email you when it is decided.` : "Keep this page open, or sign in again later to check."}</p>
          </div>
        ) : request ? (
          <p className="mt-7 border-t border-line pt-7 wrap-anywhere">
            Questions?{" "}{contact ? <a href={`mailto:${contact}`}>{contact}</a> : "Ask ITS."}
          </p>
        ) : byInvitation ? (
          // a long address breaks anywhere rather than pushing the card wider than a phone
          <p className="mt-7 border-t border-line pt-7 wrap-anywhere">
            Ask ITS for an invitation{byInvitation.contact ? <>: <a href={`mailto:${byInvitation.contact}`}>{byInvitation.contact}</a></> : null}.
          </p>
        ) : (
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
              {/* two letters: the box takes no more, and its example shows the form */}
              <Field label="State" htmlFor="region"><input id="region" className="input" required minLength={2} maxLength={2} placeholder="TX" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></Field>
            </div>
            {/* the zone sets the hours candidates may be texted, so a pre-filled guess says so until the owner changes it */}
            <Field label="Time zone" htmlFor="timezone" hint={guessedZone && form.timezone === guessedZone ? "We started from your computer's setting." : undefined}>
              <select id="timezone" className="select" required value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                <option value="" disabled>Choose a time zone</option>
                {ZONE_CHOICES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
              </select>
            </Field>
            <Field label="Website (optional)" htmlFor="web"><input id="web" className="input" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
            {error ? <Alert tone="critical">{error}</Alert> : null}
            {/* the one main action, at the end of the form: a pill on the right, the full width on a phone */}
            <div className="flex justify-end pt-1">
              <Button type="submit" variant="primary" loading={busy} iconEnd="arrow-right" className="max-sm:w-full">{signup?.door === "request" ? "Send my request" : "Create my hiring workspace"}</Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
