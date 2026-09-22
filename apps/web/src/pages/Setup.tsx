"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Segmented, Skeleton, Table } from "@ros/ui";
import { api, ApiError, type MyCalendar } from "../api/client";
import { useSearchParams } from "../nav";
import { toast } from "../toast";

type Company = { id: string; name: string; slug: string; vertical: string; sizeBand: string; planKey: string; status: string; plan?: { key: string; name: string; limits: Record<string, number | null> } | null; usage?: Record<string, { used: number; limit: number | null }>; locations: Array<{ city?: string; region?: string }>; settings: { website?: string; pilot?: { startedAt: string; endsAt: string; extendedUntil?: string } }; integrations: Array<{ kind: string; provider: string; status: string }>; ai: { provider: string } };
type Member = { userId: string; role: string; status: string; email: string; name: string | null; calendar: { provider: string; status: string; email: string | null } | null; availability: { timezone: string; windows: number } | null; schedulable: boolean };
type PolicyRow = { group: string; actionType: string; level: "auto" | "auto_notify" | "approval" | "human_only"; approverRoles: string[]; source: string; locked: boolean; defaultLevel: string };

const LEVELS = [
  { value: "auto", label: "Do it" },
  { value: "auto_notify", label: "Do it and tell me" },
  { value: "approval", label: "Ask me first" },
  { value: "human_only", label: "Only a person" },
] as const;

export function Setup() {
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<Company>("/api/v1/companies/current") });
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Member[]>("/api/v1/companies/current/members") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { id: string }; activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> }>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? "";
  const policies = useQuery({ queryKey: ["policies"], queryFn: () => api.get<PolicyRow[]>("/api/v1/policies") });
  const [invite, setInvite] = useState({ email: "", role: "hiring_manager" });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const sendInvite = useMutation({
    mutationFn: () => api.post<{ ok: boolean; devLink?: string }>("/api/v1/companies/current/invites", invite),
    onSuccess: (r) => { toast("Invitation sent."); setInviteLink(r.devLink ?? null); setInvite({ email: "", role: "hiring_manager" }); qc.invalidateQueries({ queryKey: ["members"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not invite."),
  });
  const setPolicy = useMutation({
    mutationFn: (p: { actionType: string; level: string; approverRoles: string[] }) => api.put("/api/v1/policies", p),
    onSuccess: () => { toast("Saved."); qc.invalidateQueries({ queryKey: ["policies"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save."),
  });

  if (company.isLoading) return <Skeleton lines={5} />;
  if (company.error || !company.data) return <ErrorState message="Could not load settings." onRetry={() => company.refetch()} />;
  const c = company.data;
  const groups = [...new Set((policies.data ?? []).map((p) => p.group))];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><h1>Setup</h1><p>Your company, your team, what is connected, and what the AI may do on its own.</p></div></div>

      <div className="grid-2">
        <Card title="Company">
          <dl className="kv">
            <dt>Name</dt><dd>{c.name}</dd>
            <dt>Careers page</dt><dd><a href={`/careers/${c.slug}`} target="_blank" rel="noreferrer">/careers/{c.slug}</a></dd>
            <dt>Vertical</dt><dd>{c.vertical}</dd>
            <dt>Size</dt><dd>{c.sizeBand} employees</dd>
            <dt>Locations</dt><dd>{c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ")}</dd>
            <dt>Plan</dt><dd><Chip tone="accent">{c.plan?.name ?? c.planKey}</Chip>{c.settings.pilot ? <span className="small muted"> · pilot until {new Date(c.settings.pilot.extendedUntil ?? c.settings.pilot.endsAt).toLocaleDateString()}; roles in progress are never cut off</span> : null}</dd>
            {c.usage ? <><dt>Usage</dt><dd className="small">{Object.entries(c.usage).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v.used}${v.limit === null ? "" : ` of ${v.limit}`}`).join(" · ")}</dd></> : null}
          </dl>
        </Card>
        <Card title="Team">
          {members.data ? (
            <div className="stack" style={{ gap: 6 }}>
              {members.data.map((m) => <div key={m.userId} className="row" style={{ justifyContent: "space-between" }}><span>{m.name ?? m.email} <span className="muted small">{m.email}</span></span><span className="row"><Chip tone={m.schedulable ? "good" : "caution"}>{m.calendar?.status === "live" ? `${m.calendar.provider} calendar` : m.availability ? "hours declared" : "no availability"}</Chip><Chip>{m.role.replace("_", " ")}</Chip></span></div>)}
            </div>
          ) : <Skeleton lines={2} />}
          <form className="row" style={{ marginTop: 12, alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); sendInvite.mutate(); }}>
            <Field label="Invite by email" htmlFor="inv"><input id="inv" className="input" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Role" htmlFor="invrole"><select id="invrole" className="select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{["admin", "hiring_manager", "interviewer", "hr", "recruiter"].map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}</select></Field>
            <Button type="submit" variant="primary" loading={sendInvite.isPending}>Invite</Button>
          </form>
          {inviteLink ? <p className="small muted" style={{ marginTop: 8 }}>Development mode: <a href={inviteLink}>invitation link</a></p> : null}
          <p className="small muted" style={{ marginTop: 8 }}>Interviewers never see pay. Hiring managers can approve roles and decide on candidates. Admins can change these rules.</p>
        </Card>
      </div>

      <RecruiterAccess canRevoke={["owner", "admin"].includes(myRole)} />

      <MyAvailability />

      <Card title="Connected services">
        <Table head={["What", "Provider", "Status", "What it takes"]}>
          {c.integrations.map((i) => (
            <tr key={`${i.kind}-${i.provider}`}>
              <td>{i.kind}</td>
              <td>{i.provider}</td>
              <td><Chip tone={i.status === "live" ? "good" : i.status === "fake" ? "caution" : i.status === "manual_action_required" ? "needs" : i.status === "awaiting_verification" ? "accent" : "neutral"}>{SERVICE_STATE_LABEL[i.status] ?? i.status.replace(/_/g, " ")}</Chip></td>
              <td className="small muted">{explainStatus(i)}</td>
            </tr>
          ))}
        </Table>
        <p className="small muted" style={{ marginTop: 8 }}>AI provider: <strong>{c.ai.provider}</strong>{c.ai.provider === "fake" ? " (deterministic stand-in for development; production refuses to start with it)" : ""}.</p>
      </Card>

      <Card title="What the AI may do on its own">
        <p className="small muted" style={{ marginBottom: 10 }}>Four levels for every action. Some decisions always stay with a person and cannot be changed. Changes are recorded.</p>
        {policies.isLoading ? <Skeleton lines={6} /> : groups.map((g) => (
          <div key={g} style={{ marginBottom: 14 }}>
            <h3 style={{ marginBottom: 6 }}>{g}</h3>
            <div className="stack" style={{ gap: 6 }}>
              {policies.data!.filter((p) => p.group === g).map((p) => (
                <div key={p.actionType} className="row" style={{ justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                  <div><span>{actionLabel(p.actionType)}</span>{p.locked ? <Chip>always a person</Chip> : p.source !== "default" ? <Chip tone="accent">customized</Chip> : null}</div>
                  <Segmented value={p.level} onChange={(v) => setPolicy.mutate({ actionType: p.actionType, level: v, approverRoles: p.approverRoles })} options={p.locked ? [{ value: "human_only", label: "Only a person" }] : [...LEVELS]} ariaLabel={p.actionType} />
                </div>
              ))}
            </div>
          </div>
        ))}
        {setPolicy.error ? <Alert tone="critical">{setPolicy.error instanceof ApiError ? setPolicy.error.message : "Could not save."}</Alert> : null}
      </Card>
    </div>
  );
}

/** Only verified states are shown (founder decision F4). */
const SERVICE_STATE_LABEL: Record<string, string> = { live: "Connected and working", awaiting_verification: "Submitted, awaiting verification", manual_action_required: "Manual action required", not_connected: "Not connected", fake: "Development stand-in", disabled: "Disabled" };

function explainStatus(i: { kind: string; provider: string; status: string }): string {
  if (i.status === "fake") return "Development stand-in: records what it would send. Never used in production.";
  if (i.provider === "careers_page") return "Served by the product; every open role has a public page and apply form.";
  if (i.provider === "google_jobs") return "Valid JobPosting data is on every job page. Google indexes it on its own schedule; confirm in Search Console.";
  if (i.provider === "email_in") return i.status === "live" ? "Forward application emails to each role's intake address." : "The inbound mail domain is not configured yet, so forwarded applications cannot arrive. Share the apply link directly.";
  if (i.provider === "indeed") return "Not connected to Indeed. Post from your own Indeed account with the apply link, or forward applications to the intake address once email-in is connected.";
  if (i.provider === "ziprecruiter") return "Not connected to ZipRecruiter. Post from your own account with the apply link.";
  if (i.provider === "linkedin_basic") return "Not connected to LinkedIn. Post a free listing from your company page with the apply link.";
  if (i.provider === "postmark") return i.status === "live" ? "Candidate email is sent from the dedicated ITS domain." : "The sending domain is not configured; candidate email is not being sent.";
  if (i.provider === "twilio" || i.provider === "fake-sms") return "Text messaging is off until carrier registration and counsel review are complete. Screening runs by web chat from an email link.";
  if (i.kind === "secrets") return i.status === "live" ? "Connected credentials are kept in the managed key vault." : "Development stand-in; production uses the managed key vault.";
  if (i.kind === "comp") return i.status === "live" ? "Public wage data from the Bureau of Labor Statistics." : "Wage benchmarks unavailable; playbook ranges are used and cited.";
  return "";
}

function actionLabel(a: string): string {
  return ({
    "role_packet.approve": "Approve a drafted role", "role.publish": "Post an approved role", "posting.sponsor_spend": "Spend on sponsored ads within budget",
    "application.triage": "Read and assess applicants (information only)", "application.hold_ineligible": "Hold an applicant who answers no to an eligibility question, and remind you (never declines)", "application.reject_ineligible": "Decline an applicant held on an eligibility answer",
    "application.reject_on_assessment": "Decline a candidate on judgment", "application.invite_screen": "Invite an applicant to a screen", "screen.conduct": "Run a screening conversation",
    "application.recommend_interview": "Recommend who to interview", "message.send_templated": "Send confirmations and reminders", "message.send_freeform": "Answer a candidate's question",
    "disposition.send": "Send a decline message after your decision", "interview.request": "Advance someone to an interview", "interview.schedule": "Book interviews on calendars",
    "interview.reschedule": "Reschedule an interview", "interview.record": "Record an interview (with consent)", "scorecard.draft": "Draft scorecards for interviewers",
    "debrief.recommend": "Recommend a finalist", "candidate.hire_decision": "Decide who to hire", "offer.draft": "Draft an offer", "offer.send": "Send an offer",
    "offer.negotiate": "Negotiate an offer", "offer.revise": "Revise an offer", "reference.request": "Request references", "background_check.order": "Order a background check",
    "background_check.adverse_action": "Act on a background check", "employee.create_in_hris": "Create the new hire in payroll/HR", "welcome.send": "Send welcome and start reminders",
    "checkin.request": "Ask how the hire is going at 30/60/90 days", "intervention.nudge": "Nudge when a role is stuck", "intervention.offer_recruiter": "Offer a recruiter when stuck",
    "sourcing.search_internal": "Search your own talent pool", "sourcing.enrich_external": "Look up outside candidates (uses credits)", "outreach.send": "Reach out to outside candidates",
    "policy.change": "Change these rules", "knockout_rule.change": "Change eligibility rules", "notice_text.change": "Change candidate notices", "data.delete": "Delete candidate data", "data.export": "Export data",
  } as Record<string, string>)[a] ?? a;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York"];
const API_BASE = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? "";

/** My availability (docs/04 /setup/availability): a calendar connection, or declared windows, or both (windows constrain the calendar). */
function MyAvailability() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ["me", "calendar"], queryFn: () => api.get<MyCalendar>("/api/v1/me/calendar") });
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [windows, setWindows] = useState<Record<number, { on: boolean; start: string; end: string }>>(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: d >= 1 && d <= 5, start: "09:00", end: "17:00" }])));
  const [bufferMinutes, setBuffer] = useState(15);
  const [maxPerDay, setMax] = useState(3);
  const [loaded, setLoaded] = useState(false);
  if (q.data && !loaded) {
    setLoaded(true);
    if (q.data.availability) {
      setTimezone(q.data.availability.timezone);
      setBuffer(q.data.availability.bufferMinutes);
      setMax(q.data.availability.maxPerDay);
      const next = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: false, start: "09:00", end: "17:00" }])) as Record<number, { on: boolean; start: string; end: string }>;
      for (const w of q.data.availability.windows) next[w.day] = { on: true, start: w.start, end: w.end };
      setWindows(next);
    }
  }
  const save = useMutation({
    mutationFn: () => api.put("/api/v1/me/availability", { timezone, windows: Object.entries(windows).filter(([, w]) => w.on).map(([d, w]) => ({ day: Number(d), start: w.start, end: w.end })), bufferMinutes, maxPerDay }),
    onSuccess: async () => { toast("Availability saved. Any interview waiting on it moves ahead."); await qc.invalidateQueries({ queryKey: ["me", "calendar"] }); await qc.invalidateQueries({ queryKey: ["members"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save."),
  });
  const disconnect = useMutation({ mutationFn: () => api.post("/api/v1/integrations/calendar/google/disconnect", { reason: "disconnected from Setup" }), onSuccess: async () => { toast("Disconnected. The credential is being deleted."); await qc.invalidateQueries({ queryKey: ["me", "calendar"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not disconnect.") });
  const c = q.data?.connection;
  const calParam = params.get("calendar");
  return (
    <Card title="My availability for interviews">
      {calParam === "connected" ? <Alert tone="info">Calendar connected. Interviews now use your real free time.</Alert> : calParam && calParam !== "connected" ? <Alert tone="critical">The calendar connection did not complete ({calParam.replace(/_/g, " ")}). Try again.</Alert> : null}
      <div className="stack" style={{ gap: 12 }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Calendar</h3>
          {q.isLoading ? <Skeleton lines={2} /> : c && c.status !== "not_connected" ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>{c.provider} · {c.externalAccountId} <Chip tone={c.status === "live" ? "good" : "needs"}>{c.status === "live" ? "connected" : c.status.replace(/_/g, " ")}</Chip>{c.lastError ? <span className="small muted"> {c.lastError}</span> : null}</span>
              <div className="row">{c.status !== "live" ? <a className="btn secondary sm" href={`${API_BASE}/api/v1/integrations/calendar/google/connect`}>Reconnect</a> : null}<Button size="sm" variant="quiet" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button></div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small muted">Not connected. With a calendar, times are offered from your real free time; without one, your declared hours below are used.</span>
              {q.data?.providers.some((p) => p.key === "google" && p.status !== "not_connected") ? <a className="btn primary sm" href={`${API_BASE}/api/v1/integrations/calendar/google/connect`}>Connect Google Calendar</a> : <span className="small muted">Google Calendar is not configured for this deployment yet.</span>}
            </div>
          )}
          <p className="small muted" style={{ marginTop: 6 }}>We ask only for events on your calendar and free/busy times. Disconnecting deletes the credential; you can see when that is done.</p>
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Declared hours</h3>
          <Field label="Time zone" htmlFor="av-tz"><select id="av-tz" className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{[...new Set([timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
          <div className="stack" style={{ gap: 4 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <div key={d} className="row small" style={{ gap: 8, alignItems: "center" }}>
                <label style={{ width: 110 }}><input type="checkbox" checked={windows[d].on} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], on: e.target.checked } })} /> {DAY_NAMES[d]}</label>
                <input aria-label={`${DAY_NAMES[d]} start`} className="input" type="time" style={{ width: 130 }} disabled={!windows[d].on} value={windows[d].start} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], start: e.target.value } })} />
                <span>to</span>
                <input aria-label={`${DAY_NAMES[d]} end`} className="input" type="time" style={{ width: 130 }} disabled={!windows[d].on} value={windows[d].end} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], end: e.target.value } })} />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Field label="Buffer between interviews (minutes)" htmlFor="av-buf"><input id="av-buf" className="input" type="number" min={0} max={120} value={bufferMinutes} onChange={(e) => setBuffer(Number(e.target.value))} /></Field>
            <Field label="Most interviews per day" htmlFor="av-max"><input id="av-max" className="input" type="number" min={1} max={12} value={maxPerDay} onChange={(e) => setMax(Number(e.target.value))} /></Field>
          </div>
          <div style={{ marginTop: 8 }}><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save availability</Button></div>
        </div>
      </div>
    </Card>
  );
}

type Grant = { id: string; kind: string; purpose: string; escalationId: string | null; roleId: string | null; roleTitle: string | null; applicationId: string | null; startsAt: string; expiresAt: string; endedAt: string | null; revokedAt: string | null; revokeReason: string | null; recruiterName: string | null; recruiterEmail: string; active: boolean };

/** ITS recruiter access (founder decision F10; item 1 of 21 Sep): visible to everyone on the team; owners and admins can end it now. */
function RecruiterAccess({ canRevoke }: { canRevoke: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["staff-access"], queryFn: () => api.get<Grant[]>("/api/v1/companies/current/staff-access"), refetchInterval: 20000 });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<{ recruiterNotified: boolean }>(`/api/v1/companies/current/staff-access/${id}/revoke`, { reason, confirm: true }),
    onSuccess: async (r) => { toast(r.recruiterNotified ? "Access ended. The recruiter has been told and your activity log records it." : "Access ended and recorded. The email to the recruiter failed; ITS has been alerted to tell them another way."); setConfirming(null); setReason(""); await qc.invalidateQueries({ queryKey: ["staff-access"] }); await qc.invalidateQueries({ queryKey: ["staff-audit"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not end the access."),
  });
  const active = (q.data ?? []).filter((g) => g.active);
  const past = (q.data ?? []).filter((g) => !g.active).slice(0, 10);
  return (
    <Card title="ITS recruiter access">
      <p className="small muted">A recruiter gets access only when you ask for one, only to that request's role and candidate, for at most 14 days. Every page they open is recorded in your activity. {canRevoke ? "You can end it at any time." : "Owners and admins can end it at any time."}</p>
      {q.isLoading ? <Skeleton lines={2} /> : active.length === 0 ? <p className="small muted" style={{ marginTop: 8 }}>No recruiter has access right now.</p> : (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {active.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 6, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span><strong>{g.recruiterName ?? g.recruiterEmail}</strong> <span className="small muted">· {g.purpose}</span></span>
                <Chip tone="accent">{g.applicationId ? "one candidate" : g.roleTitle ? `role: ${g.roleTitle}` : "whole company"}</Chip>
              </div>
              <span className="small muted">Ends {new Date(g.expiresAt).toLocaleString()}{g.escalationId ? " or when the request is resolved" : ""}.</span>
              {canRevoke ? (
                confirming === g.id ? (
                  <div className="stack" style={{ gap: 6 }}>
                    <Field label="Why you are ending it (the recruiter sees this)" htmlFor={`rv-${g.id}`}><input id={`rv-${g.id}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                    <div className="row"><Button size="sm" variant="destructive" disabled={reason.trim().length < 5} loading={revoke.isPending} onClick={() => revoke.mutate(g.id)}>End access now</Button><Button size="sm" variant="quiet" onClick={() => { setConfirming(null); setReason(""); }}>Keep it</Button></div>
                  </div>
                ) : <div className="row"><Button size="sm" variant="secondary" onClick={() => { setConfirming(g.id); setReason(""); }}>End this recruiter's access</Button></div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <AccessHistory />
      {past.length ? <details style={{ marginTop: 10 }}><summary className="small">Past access ({past.length})</summary><ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>{past.map((g) => <li key={g.id}>{g.recruiterName ?? g.recruiterEmail} · {g.purpose} · {g.revokedAt ? `ended early: ${g.revokeReason ?? "released"}` : `ended ${g.endedAt ? new Date(g.endedAt).toLocaleDateString() : "at expiry"}`}</li>)}</ul></details> : null}
    </Card>
  );
}

type AuditRow = { id: string; action: string; actor: { kind: string; name: string | null }; reason: string | null; at: string; details: { scope?: { roleId?: string | null; applicationId?: string | null } | null } };
const ACTION_LABEL: Record<string, string> = { "staff.access_granted": "Access granted", "staff.access_ended": "Access ended", "staff.access_revoked": "Access ended by your team", "admin.break_glass": "Emergency access by an ITS administrator" };

/** The customer's own record of recruiter access: who acted, when, and why. */
function AccessHistory() {
  const q = useQuery({ queryKey: ["staff-audit"], queryFn: () => api.get<AuditRow[]>("/api/v1/companies/current/audit?limit=20"), retry: false });
  if (q.error || !q.data?.length) return null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary className="small">Access history ({q.data.length})</summary>
      <ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>
        {q.data.map((r) => <li key={r.id}>{new Date(r.at).toLocaleString()} · {ACTION_LABEL[r.action] ?? r.action} · by {r.actor.name ?? r.actor.kind}{r.reason ? ` · ${r.reason}` : ""}</li>)}
      </ul>
    </details>
  );
}
