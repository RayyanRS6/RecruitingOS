"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Segmented, Skeleton, Table } from "@ros/ui";
import { api, ApiError, type MyCalendar } from "../api/client";
import { useSearchParams } from "../nav";
import { LEVELS, allowedLevels, type PolicyLevel } from "../policy-levels";
import { ACCESS_DAYS, accessChip } from "../recruiter-access";
import { toast } from "../toast";
import { TeamCard } from "./TeamCard";

type BusinessHours = { days: number[]; start: string; end: string };
type CompanySettings = { website?: string; logoUrl?: string; benefitsSummary?: string; careersPage?: { enabled: boolean; intro?: string }; businessHours?: BusinessHours; notices?: Record<string, { version: string; text: string }>; pilot?: { startedAt: string; endsAt: string; extendedUntil?: string } };
type Company ={ id: string; name: string; slug: string; vertical: string; sizeBand: string; timezone: string; planKey: string; status: string; plan?: { key: string; name: string; limits: Record<string, number | null> } | null; usage?: Record<string, { used: number; limit: number | null }>; locations: Array<{ city?: string; region?: string; country?: string }>; settings: CompanySettings; integrations: Array<{ kind: string; provider: string; status: string }>; ai: { provider: string } };
/** minLevel and maxLevel: the floor and ceiling the API holds the action to; only the levels between them are offered. */
type PolicyRow ={ group: string; actionType: string; level: PolicyLevel; approverRoles: string[]; source: string; locked: boolean; defaultLevel: string; minLevel?: PolicyLevel | null; maxLevel?: PolicyLevel | null };

export function Setup() {
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<Company>("/api/v1/companies/current") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { id: string }; activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> }>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? "";
  // policy.manage in packages/core/src/permissions.ts: owners and admins change the rules; everyone else reads them.
  const canManagePolicy = ["owner", "admin"].includes(myRole);
  const policies = useQuery({ queryKey: ["policies"], queryFn: () => api.get<PolicyRow[]>("/api/v1/policies") });
  // "Confirm it's you" (A12): a rule or notice change from an older session is refused until the person signs in again.
  const [reauthNeeded, setReauthNeeded] = useState(false);
  const [params] = useSearchParams();
  const reauthOutcome = params.get("reauth");
  const setPolicy = useMutation({
    mutationFn: (p: { actionType: string; level: string; approverRoles: string[] }) => api.put("/api/v1/policies", p),
    onSuccess: () => { toast("Saved."); setReauthNeeded(false); qc.invalidateQueries({ queryKey: ["policies"] }); qc.invalidateQueries({ queryKey: ["audit-history"] }); },
    onError: (e) => { if (e instanceof ApiError && e.code === "reauth_required") { setReauthNeeded(true); toast("Confirm it's you first, then change the rule again."); } else toast(e instanceof ApiError ? e.message : "Could not save."); },
  });

  if (company.isLoading) return <Skeleton lines={5} />;
  if (company.error || !company.data) return <ErrorState message="Could not load settings." onRetry={() => company.refetch()} />;
  const c = company.data;
  const groups = [...new Set((policies.data ?? []).map((p) => p.group))];

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><h1>Setup</h1><p>Your company, your team, what is connected, and what the AI may do on its own.</p></div></div>

      {reauthOutcome === "ok" ? <Alert tone="info">Thanks, that is confirmed. You can change the rules and the candidate notices for the next ten minutes.</Alert> : reauthOutcome === "mismatch" ? <Alert tone="critical">That sign-in was a different account. Confirm with the account you are signed in as.</Alert> : reauthOutcome === "failed" ? <Alert tone="critical">The confirmation did not complete. Try again.</Alert> : null}
      {reauthNeeded ? <ReauthPrompt /> : null}

      <div className="grid-2">
        <CompanyCard company={c} canEdit={["owner", "admin"].includes(myRole)} onReauthRequired={() => setReauthNeeded(true)} />
        <TeamCard myRole={myRole} myUserId={me.data?.user.id ?? ""} />
      </div>

      <RecruiterAccess canRevoke={["owner", "admin"].includes(myRole)} />

      <YourSessions />

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
        <p className="small muted" style={{ marginBottom: 10 }}>Four levels for every action. Some decisions always stay with a person, and some always wait for a person's approval (approving a role, offers, interviews); those offer only the choices allowed. Changes are recorded.</p>
        {!canManagePolicy && myRole ? <Alert tone="info">Only owners and admins change these rules. You can see what applies; ask one of them if something should work differently.</Alert> : null}
        {policies.isLoading ? <Skeleton lines={6} /> : groups.map((g) => (
          <div key={g} style={{ marginBottom: 14 }}>
            <h3 style={{ marginBottom: 6 }}>{g}</h3>
            <div className="stack" style={{ gap: 6 }}>
              {policies.data!.filter((p) => p.group === g).map((p) => (
                <div key={p.actionType} className="row" style={{ justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                  <div><span>{actionLabel(p.actionType)}</span>{p.locked ? <Chip>always a person</Chip> : p.minLevel === "approval" ? <Chip>a person approves</Chip> : p.source !== "default" ? <Chip tone="accent">customized</Chip> : null}</div>
                  {canManagePolicy ? (
                    <Segmented value={p.level} onChange={(v) => setPolicy.mutate({ actionType: p.actionType, level: v, approverRoles: p.approverRoles })} options={allowedLevels(p)} ariaLabel={actionLabel(p.actionType)} />
                  ) : <Chip tone="neutral">{LEVELS.find((l) => l.value === p.level)?.label ?? p.level}</Chip>}
                </div>
              ))}
            </div>
          </div>
        ))}
        {setPolicy.error ? <Alert tone="critical">{setPolicy.error instanceof ApiError ? setPolicy.error.message : "Could not save."}</Alert> : null}
      </Card>

      <AuditHistory />
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
    "role_packet.approve": "Approve a drafted role, pay included", "posting.sponsor_spend": "Spend on sponsored ads within budget",
    "application.triage": "Read and assess applicants (information only)", "application.hold_ineligible": "Hold an applicant who answers no to an eligibility question, and remind you (never declines)", "application.reject_ineligible": "Decline an applicant held on an eligibility answer",
    "application.reject_on_assessment": "Decline a candidate on judgment", "application.invite_screen": "Invite an applicant to a screen", "screen.conduct": "Run a screening conversation",
    "application.recommend_interview": "Recommend who to interview", "message.send_templated": "Send confirmations and reminders", "message.send_freeform": "Send a message a team member wrote to a candidate (set to approval or only a person, an owner or admin reads it first; their own go at once)",
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
              <div className="row">{c.status !== "live" ? <a className="btn secondary sm" href="/api/v1/integrations/calendar/google/connect">Reconnect</a> : null}<Button size="sm" variant="quiet" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button></div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small muted">Not connected. With a calendar, times are offered from your real free time; without one, your declared hours below are used.</span>
              {q.data?.providers.some((p) => p.key === "google" && p.status !== "not_connected") ? <a className="btn primary sm" href="/api/v1/integrations/calendar/google/connect">Connect Google Calendar</a> : <span className="small muted">Google Calendar is not configured for this deployment yet.</span>}
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
      <p className="small muted">A recruiter gets access when your team asks for one, and also when the system brings one in on its own: a candidate asks for a person, or something gets stuck. A request about one candidate or one role gives access to that alone; all of your hiring only when someone on your team chose that. Access ends a day after the request is resolved, or after {ACCESS_DAYS} days at most, and you are told when a recruiter starts. Every page they open is recorded in your activity. {canRevoke ? "You can end it at any time." : "Owners and admins can end it at any time."}</p>
      {q.isLoading ? <Skeleton lines={2} /> : active.length === 0 ? <p className="small muted" style={{ marginTop: 8 }}>No recruiter has access right now.</p> : (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {active.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 6, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span><strong>{g.recruiterName ?? g.recruiterEmail}</strong> <span className="small muted">· {g.purpose}</span></span>
                <Chip tone="accent">{accessChip(g)}</Chip>
              </div>
              <span className="small muted">Ends {new Date(g.expiresAt).toLocaleString()}{g.escalationId ? ", or a day after the request is resolved if that is sooner" : ""}.</span>
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

type AuditRow = { id: string; action: string; description: string; actor: { kind: string; name: string | null }; reason: string | null; at: string; details: Record<string, unknown> };
const ACTION_LABEL: Record<string, string> = { "staff.access_granted": "Access granted", "staff.access_ended": "Access ended", "staff.access_revoked": "Access ended by your team", "admin.break_glass": "Emergency access by an ITS administrator" };
const ACCESS_ACTIONS = "staff.access_granted,staff.access_ended,staff.access_revoked,admin.break_glass";

/** The customer's own record of recruiter access: who acted, when, and why. */
function AccessHistory() {
  const q = useQuery({ queryKey: ["staff-audit"], queryFn: () => api.get<AuditRow[]>(`/api/v1/companies/current/audit?limit=20&actions=${ACCESS_ACTIONS}`), retry: false });
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

/**
 * Everything the team may see of the audit ledger (A9): recruiter access, team changes, rule and company changes,
 * candidate views, outcomes, exports; in plain words, newest first, and as a spreadsheet. Hidden for roles without
 * events.read (the API answers 403).
 */
function AuditHistory() {
  const [everyPage, setEveryPage] = useState(false);
  const path = `/api/v1/companies/current/audit?limit=50${everyPage ? "" : "&exclude=staff.tenant_accessed"}`;
  const q = useQuery({ queryKey: ["audit-history", everyPage], queryFn: () => api.get<AuditRow[]>(path), retry: false });
  if (q.error) return null;
  return (
    <Card title="Audit history" aside={<a className="btn secondary sm" href="/api/v1/companies/current/audit.csv">Download as a spreadsheet</a>}>
      <p className="small muted">Who did what in your workspace: recruiter access, team changes, rule changes, company changes, candidate records opened, outcomes and downloads. The last 50 are shown; the spreadsheet has everything, and downloading it is recorded too.</p>
      <label className="small" style={{ display: "block", margin: "8px 0" }}><input type="checkbox" checked={everyPage} onChange={(e) => setEveryPage(e.target.checked)} /> Include every page an ITS recruiter opened</label>
      {q.isLoading ? <Skeleton lines={4} /> : !q.data?.length ? <p className="small muted">Nothing recorded yet.</p> : (
        <Table head={["When", "What happened", "Who"]} label="Audit history">
          {q.data.map((r) => <tr key={r.id}><td className="small" style={{ whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleString()}</td><td>{r.description}</td><td className="small">{r.actor.name ?? r.actor.kind}</td></tr>)}
        </Table>
      )}
    </Card>
  );
}

type SessionRow = { id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; addressHash: string | null; userAgent: string | null; provider: string; current: boolean };

/** Where the person is signed in (A11): every open session, the current one marked, with "Sign out everywhere else". */
function YourSessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionRow[]>("/api/v1/auth/sessions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const revokeOthers = useMutation({ mutationFn: () => api.post<{ sessionsEnded: number }>("/api/v1/auth/sessions/revoke-all"), onSuccess: (r) => { toast(r.sessionsEnded === 0 ? "No other sessions were open." : `Signed out ${r.sessionsEnded === 1 ? "one other session" : `${r.sessionsEnded} other sessions`}.`); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not sign out.") });
  const revokeOne = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/auth/sessions/${id}/revoke`), onSuccess: () => { toast("Signed out."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not sign out.") });
  const rows = q.data ?? [];
  const browser = (ua: string | null) => (!ua ? "unknown device" : /iphone|ipad/i.test(ua) ? "iPhone or iPad" : /android/i.test(ua) ? "Android" : /macintosh/i.test(ua) ? "Mac" : /windows/i.test(ua) ? "Windows" : /node|vitest/i.test(ua) ? "a test client" : "a browser");
  const PROVIDER: Record<string, string> = { google: "Google", azure: "Microsoft", magic_link: "email link", email: "email link" };
  return (
    <Card title="Your sessions" aside={rows.length > 1 ? <Button size="sm" variant="secondary" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out everywhere else</Button> : null}>
      <p className="small muted">Every place you are signed in. If you see one you do not recognise, sign it out; the address is shown only as a short code, never in full.</p>
      {q.isLoading ? <Skeleton lines={2} /> : q.error ? <p className="small muted">Could not load your sessions.</p> : (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          {rows.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="small">{s.current ? <Chip tone="good">this one</Chip> : null} {browser(s.userAgent)} · signed in with {PROVIDER[s.provider] ?? s.provider} · {s.lastSeenAt ? `last seen ${new Date(s.lastSeenAt).toLocaleString()}` : `opened ${new Date(s.createdAt).toLocaleString()}`}{s.addressHash ? ` · address ${s.addressHash.slice(0, 6)}` : ""}</span>
              {s.current ? null : <Button size="sm" variant="quiet" loading={revokeOne.isPending} onClick={() => revokeOne.mutate(s.id)}>Sign out</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Sends the person through their sign-in provider again; they come straight back here with the confirmation recorded. */
function ReauthPrompt() {
  const start = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/v1/auth/reauth/start", { returnTo: "/setup" }),
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not start the confirmation."),
  });
  return (
    <Alert tone="caution">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span><strong>Confirm it's you.</strong> Changing the rules or the candidate notices needs a fresh sign-in. You will come straight back here.</span>
        <Button size="sm" variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Confirm with my sign-in</Button>
      </div>
    </Alert>
  );
}

type NoticeView = { key: string; version: string; text: string; overridden: boolean; defaultText: string; defaultVersion: string };
const NOTICE_LABEL: Record<string, string> = { ai_use: "How we use AI (shown on the job page and the apply form)", privacy: "How we handle information (shown on the apply form and the privacy page)", pay_transparency: "Pay range notice (states that require it)", adverse_decision_explanation: "Decision review notice (states that require it)" };
/** The same notices named briefly, for the read view's one-line summary. */
const NOTICE_SHORT: Record<string, string> = { ai_use: "AI notice", privacy: "privacy notice", pay_transparency: "pay range notice", adverse_decision_explanation: "decision review notice" };
const SIZE_BANDS = ["1-19", "20-49", "50-99", "100-199", "200-499", "500+"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** What the company card sends: only what the person may change; the plan, pilot and allowances are never in it. */
type CompanyForm = { name: string; website: string; logoUrl: string; timezone: string; sizeBand: string; locations: string; intro: string; benefits: string; hoursOn: boolean; days: number[]; start: string; end: string; notices: Record<string, string> };

function formOf(c: Company, notices: NoticeView[]): CompanyForm {
  return {
    name: c.name, website: c.settings.website ?? "", logoUrl: c.settings.logoUrl ?? "", timezone: c.timezone, sizeBand: c.sizeBand,
    locations: c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("\n"),
    intro: c.settings.careersPage?.intro ?? "", benefits: c.settings.benefitsSummary ?? "",
    hoursOn: !!c.settings.businessHours, days: c.settings.businessHours?.days ?? [1, 2, 3, 4, 5], start: c.settings.businessHours?.start ?? "09:00", end: c.settings.businessHours?.end ?? "17:00",
    notices: Object.fromEntries(notices.map((n) => [n.key, n.overridden ? n.text : ""])),
  };
}

function parseLocations(text: string): Array<{ city: string; region: string; country: string }> {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [city, region] = line.split(",").map((p) => p.trim()); return { city: city ?? "", region: (region ?? "").toUpperCase().slice(0, 2), country: "US" }; }).filter((l) => l.city);
}

/**
 * The company's own details (A8, J16): name, website, logo, time zone, size, locations, careers-page intro, benefits,
 * contact hours and the wording of the candidate notices. Owners and admins edit; everyone else reads. A reworded
 * notice gets a new version (the date) and needs a fresh sign-in.
 */
function CompanyCard({ company: c, canEdit, onReauthRequired }: { company: Company; canEdit: boolean; onReauthRequired: () => void }) {
  const qc = useQueryClient();
  const notices = useQuery({ queryKey: ["company", "notices"], queryFn: () => api.get<NoticeView[]>("/api/v1/companies/current/notices") });
  const [form, setForm] = useState<CompanyForm | null>(null);
  const [editing, setEditing] = useState(false);
  const shownNotices = (notices.data ?? []).filter((n) => NOTICE_LABEL[n.key]);
  const save = useMutation({
    mutationFn: (f: CompanyForm) => {
      const changedNotices: Record<string, { text: string } | null> = {};
      for (const n of shownNotices) {
        const typed = (f.notices[n.key] ?? "").trim();
        if (n.overridden && !typed) changedNotices[n.key] = null;
        else if (typed && typed !== (n.overridden ? n.text : "")) changedNotices[n.key] = { text: typed };
      }
      return api.patch<Company & { changed: string[] }>("/api/v1/companies/current", {
        name: f.name.trim(), timezone: f.timezone, sizeBand: f.sizeBand, locations: parseLocations(f.locations),
        settings: { website: f.website.trim(), logoUrl: f.logoUrl.trim(), benefitsSummary: f.benefits.trim(), careersPage: { intro: f.intro.trim() }, businessHours: f.hoursOn ? { days: f.days, start: f.start, end: f.end } : null, ...(Object.keys(changedNotices).length ? { notices: changedNotices } : {}) },
      });
    },
    onSuccess: async (r) => {
      toast(r.changed.length ? `Saved: ${r.changed.map(fieldLabel).join(", ")}.` : "Nothing changed.");
      setEditing(false); setForm(null);
      await qc.invalidateQueries({ queryKey: ["company"] }); await qc.invalidateQueries({ queryKey: ["audit-history"] });
    },
    onError: (e) => { if (e instanceof ApiError && e.code === "reauth_required") { onReauthRequired(); toast("Confirm it's you first, then save again."); } else toast(e instanceof ApiError ? e.message : "Could not save."); },
  });
  const f = form ?? (notices.data ? formOf(c, notices.data) : null);
  const set = (patch: Partial<CompanyForm>) => setForm({ ...(f ?? formOf(c, notices.data ?? [])), ...patch });
  const hours = c.settings.businessHours;
  return (
    <Card title="Company" aside={canEdit && !editing ? <Button size="sm" variant="secondary" onClick={() => { setForm(formOf(c, notices.data ?? [])); setEditing(true); }}>Edit</Button> : null}>
      {!editing || !f ? (
        <dl className="kv">
          <dt>Name</dt><dd>{c.name}</dd>
          <dt>Careers page</dt><dd><a href={`/careers/${c.slug}`} target="_blank" rel="noreferrer">/careers/{c.slug}</a></dd>
          <dt>Website</dt><dd>{c.settings.website || <span className="muted">not set</span>}</dd>
          <dt>Vertical</dt><dd>{c.vertical}</dd>
          <dt>Size</dt><dd>{c.sizeBand} employees</dd>
          <dt>Time zone</dt><dd>{c.timezone}</dd>
          <dt>Locations</dt><dd>{c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ")}</dd>
          <dt>Contact hours</dt><dd>{hours ? `${hours.days.map((d) => DAY_SHORT[d]).join(", ")} ${hours.start} to ${hours.end}` : "Any day, 8:00 to 21:00 local time (the legal default for texts)"}</dd>
          <dt>Notices</dt><dd className="small">{shownNotices.some((n) => n.overridden) ? shownNotices.filter((n) => n.overridden).map((n) => `${NOTICE_SHORT[n.key] ?? n.key} reworded (version ${n.version})`).join("; ") : "Standard wording"}</dd>
          <dt>Plan</dt><dd><Chip tone="accent">{c.plan?.name ?? c.planKey}</Chip>{c.settings.pilot ? <span className="small muted"> · pilot until {new Date(c.settings.pilot.extendedUntil ?? c.settings.pilot.endsAt).toLocaleDateString()}; roles in progress are never cut off</span> : null}</dd>
          {c.usage ? <><dt>Usage</dt><dd className="small">{Object.entries(c.usage).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v.used}${v.limit === null ? "" : ` of ${v.limit}`}`).join(" · ")}</dd></> : null}
        </dl>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <Field label="Company name" htmlFor="co-name"><input id="co-name" className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="Website" htmlFor="co-web" hint="Shown to candidates and search engines"><input id="co-web" className="input" placeholder="acme.com" value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
            <Field label="Logo address (https)" htmlFor="co-logo" hint="Optional; used on job pages"><input id="co-logo" className="input" placeholder="https://acme.com/logo.png" value={f.logoUrl} onChange={(e) => set({ logoUrl: e.target.value })} /></Field>
            <Field label="Time zone" htmlFor="co-tz"><select id="co-tz" className="select" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })}>{[...new Set([f.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
            <Field label="Size" htmlFor="co-size"><select id="co-size" className="select" value={f.sizeBand} onChange={(e) => set({ sizeBand: e.target.value })}>{SIZE_BANDS.map((s) => <option key={s} value={s}>{s} employees</option>)}</select></Field>
          </div>
          <Field label="Locations (one per line, as City, ST)" htmlFor="co-loc"><textarea id="co-loc" className="input" rows={2} value={f.locations} onChange={(e) => set({ locations: e.target.value })} /></Field>
          <Field label="Careers page introduction" htmlFor="co-intro" hint="The first line candidates read on your careers page"><textarea id="co-intro" className="input" rows={2} maxLength={1000} value={f.intro} onChange={(e) => set({ intro: e.target.value })} /></Field>
          <Field label="Benefits summary" htmlFor="co-ben" hint="Used when drafting job descriptions"><textarea id="co-ben" className="input" rows={2} maxLength={2000} value={f.benefits} onChange={(e) => set({ benefits: e.target.value })} /></Field>
          <div>
            <h3 style={{ marginBottom: 6 }}>Contact hours</h3>
            <p className="small muted">When candidates may be texted. The law already keeps texts between 8:00 and 21:00 local time; your hours can only narrow that.</p>
            <label className="small" style={{ display: "block", margin: "6px 0" }}><input type="checkbox" checked={f.hoursOn} onChange={(e) => set({ hoursOn: e.target.checked })} /> Set our own contact hours</label>
            {f.hoursOn ? (
              <div className="row small" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => <label key={d}><input type="checkbox" checked={f.days.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...f.days, d].sort() : f.days.filter((x) => x !== d) })} /> {DAY_SHORT[d]}</label>)}
                <input aria-label="Contact hours start" className="input" type="time" style={{ width: 130 }} value={f.start} onChange={(e) => set({ start: e.target.value })} />
                <span>to</span>
                <input aria-label="Contact hours end" className="input" type="time" style={{ width: 130 }} value={f.end} onChange={(e) => set({ end: e.target.value })} />
              </div>
            ) : null}
          </div>
          <div>
            <h3 style={{ marginBottom: 6 }}>Candidate notices</h3>
            <p className="small muted">Leave a box empty to use the standard wording. A reworded notice gets a new version (today's date), which is recorded with every application from then on. Changing a notice needs a fresh sign-in.</p>
            {shownNotices.map((n) => (
              <Field key={n.key} label={NOTICE_LABEL[n.key]} htmlFor={`co-n-${n.key}`} hint={n.overridden ? `Reworded (version ${n.version}). Clear the box to go back to the standard text.` : `Standard text (version ${n.defaultVersion}): ${n.defaultText}`}>
                <textarea id={`co-n-${n.key}`} className="input" rows={3} maxLength={4000} placeholder={n.defaultText} value={f.notices[n.key] ?? ""} onChange={(e) => set({ notices: { ...f.notices, [n.key]: e.target.value } })} />
              </Field>
            ))}
          </div>
          <p className="small muted">The plan, the pilot term and the allowances are set by Identified Talent Solutions; ask them to change those.</p>
          <div className="row"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(f)}>Save changes</Button><Button variant="quiet" onClick={() => { setEditing(false); setForm(null); }}>Cancel</Button></div>
        </div>
      )}
    </Card>
  );
}

function fieldLabel(f: string): string {
  return ({ name: "name", website: "website", timezone: "time zone", sizeBand: "size", locations: "locations", logoUrl: "logo", benefitsSummary: "benefits summary", careersPage: "careers page intro", businessHours: "contact hours", notices: "candidate notices" } as Record<string, string>)[f] ?? f;
}
