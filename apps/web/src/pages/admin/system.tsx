"use client";

import { type CSSProperties, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminCompany, AdminCostRow, CspReports, EmailSuppression, GrantPlatformRole, PlatformRoleGrants, ReleaseSuppression, ReviewCspReport, RevokePlatformRole, RevokeSessions, SessionsRevoked, SuppressAddress } from "@ros/contracts";
import { Alert, Button, Card, Chip, ErrorState, Field, Icon, IconLabel, numHead, Segmented, Skeleton, Table, Tabs } from "@ros/ui";
import { api, errorWords } from "../../api/client";
import { toast } from "../../toast";
import { adminKeys, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { codeWords, exactMoney, exactWhen, money, reasonReady, whenWords, wordFor } from "./admin-words";
import { Health, NONE } from "./health";

/*
 * The dashboard's System section: what an operator still needs, in five parts, each its own `?view=`. Health (alerts,
 * failed work, the queue; health.tsx), Costs (AI spend), Email (the addresses nothing is sent to), Security reports and
 * Administrators. Codes read as words (admin-words.ts); the exact figures and times stay in tooltips.
 */

/** A toolbar over a list: a control on the left, a figure on the right, wrapping on a phone. */
const TOOLBAR = "flex flex-wrap items-center justify-between gap-3";
/**
 * A table row's first appearance: it rises in 30ms after the one above it (the eighth and later together; off for
 * reduced motion). Only for tables whose rows keep their order: a row that moves is put back in the page with the rows
 * it passes, and each of those would rise in again (so Costs, ordered by cost, has none).
 */
const ROW_ENTER = "motion-safe:animate-enter motion-safe:[animation-delay:calc(var(--i)*30ms)]";
const stagger = (i: number) => ({ "--i": Math.min(i, 7) }) as CSSProperties;

/** A date as the dashboard reads it ("today", "3 days ago", "Oct 3"), the exact time on hover. */
function When({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  return <time dateTime={at} title={exactWhen(at)}>{whenWords(at)}</time>;
}

/** A part with nothing in it: "None.", with a quiet tick. */
function Empty() {
  return (
    <p className="muted mt-2 flex items-center gap-2 text-[14px]">
      <Icon name="check-circle" size={16} className="text-good" />
      {NONE}
    </p>
  );
}

const timesWord = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Costs                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

type CostPeriod = "month" | "all";

/** The first day of this month on the reader's own calendar, as GET /admin/costs?since= takes it ("2026-10-01"). */
export function monthStart(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/** The query key of the spend since a date; the all-time answer keeps the plain key. Both start with adminKeys.costs. */
export const costsSinceKey = (since: string) => [...adminKeys.costs, "since", since];

/** A company's name from the list the dashboard already reads; spend with no company is the platform's own. */
function useCompanyNames(): (companyId: string | null) => string {
  const q = useQuery({ queryKey: adminKeys.companies, queryFn: () => api.get<AdminCompany[]>("/api/v1/admin/customers", reason) });
  const names = new Map((q.data ?? []).map((c) => [c.id, c.name]));
  return (companyId) => (companyId ? (names.get(companyId) ?? "A company no longer listed") : "The platform itself");
}

/** AI spend at list prices, by company, task and model, the largest first. `initialPeriod`: the spend it opens on (this month unless given). */
export function Costs({ initialPeriod = "month" }: { initialPeriod?: CostPeriod }) {
  const [period, setPeriod] = useState<CostPeriod>(initialPeriod);
  const since = period === "month" ? monthStart() : null;
  const q = useQuery({
    queryKey: since ? costsSinceKey(since) : adminKeys.costs,
    queryFn: () => api.get<AdminCostRow[]>(`/api/v1/admin/costs${since ? `?since=${since}` : ""}`, reason),
  });
  const companyName = useCompanyNames();
  const rows = q.data ? [...q.data].sort((a, b) => b.costUsd - a.costUsd) : undefined;
  const total = (rows ?? []).reduce((n, r) => n + r.costUsd, 0);
  return (
    <div className="stack gap-4">
      <div className={TOOLBAR}>
        <Segmented ariaLabel="Which spend" value={period} onChange={setPeriod} options={[{ value: "month", label: "This month" }, { value: "all", label: "All time" }]} />
        {/* "at list prices" rides on the exact figure's tooltip */}
        {rows ? <p className="text-[14px] text-ink-2">{period === "month" ? "Spent so far this month" : "Total AI spend recorded"}: <strong className="ml-1 font-display text-2xl font-bold tracking-[-0.02em] text-ink tabular-nums" title={`${exactMoney(total)} at list prices`}>{money(total)}</strong></p> : null}
      </div>
      {q.error ? <ErrorState message="Could not load costs." onRetry={() => q.refetch()} /> : (
        <>
          <Table
            head={["Company", "Task", "Model", numHead("Runs"), numHead("Cost")]}
            scroll
            loading={rows ? undefined : 4}
            empty={period === "month" ? (
              <span className="row justify-between gap-2.5">
                <span>No AI spend recorded this month.</span>
                <Button size="sm" variant="secondary" onClick={() => setPeriod("all")}>Show all time</Button>
              </span>
            ) : "No AI spend recorded yet."}
          >
            {(rows ?? []).map((r) => (
              <tr key={`${r.companyId ?? "platform"}-${r.task}-${r.model}`}>
                <td>{companyName(r.companyId)}</td>
                <td>{codeWords(r.task)}</td>
                <td className="small">{r.model}</td>
                <td className="num">{r.runs}</td>
                <td className="num"><span title={exactMoney(r.costUsd, 5)}>{money(r.costUsd)}</span></td>
              </tr>
            ))}
          </Table>
          {rows?.length ? (
            <details className="more">
              <summary>Details: tokens in and out</summary>
              <Table head={["Company", "Task", "Model", numHead("Tokens in"), numHead("Tokens out")]}>
                {rows.map((r) => (
                  <tr key={`${r.companyId ?? "platform"}-${r.task}-${r.model}`}>
                    <td>{companyName(r.companyId)}</td>
                    <td>{codeWords(r.task)}</td>
                    <td className="small">{r.model}</td>
                    <td className="num">{r.inputTokens}</td>
                    <td className="num">{r.outputTokens}</td>
                  </tr>
                ))}
              </Table>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Email                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Why an address is on the do-not-send list, in plain words. */
const SUPPRESSION_WORDS: Readonly<Record<string, string>> = { hard_bounce: "Bounced", spam_complaint: "Spam complaint", soft_bounce_repeated: "Bounced several times", manual: "Added by hand", subscription_change: "Unsubscribed" };
/** Who put an address on the list. */
const SUPPRESSION_SOURCE_WORDS: Readonly<Record<string, string>> = { postmark: "Reported by the email provider", admin: "Added by an administrator" };

/** The addresses nothing is sent to: Release with a reason (a spam complaint never), and a form to add one. */
export function Email() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adminKeys.suppressions, queryFn: () => api.get<EmailSuppression[]>("/api/v1/admin/email-suppressions", reason) });
  const [releaseReason, setReleaseReason] = useState("");
  const release = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/email-suppressions/${id}/release`, { reason: releaseReason.trim() } satisfies ReleaseSuppression, reason), onSuccess: () => { toast("Released. Email to that address is allowed again."); setReleaseReason(""); qc.invalidateQueries({ queryKey: adminKeys.suppressions }); }, onError: (e) => toast(errorWords(e, "Could not release.")) });
  const rows = q.data ?? [];
  return (
    // the rule for releasing one is in the reason field's own label; the source of each address is under it in the table
    <Card title={q.data ? `Email addresses we must not send to (${rows.length})` : "Email addresses we must not send to"}>
      {q.isLoading ? <Skeleton lines={3} /> : q.error ? <ErrorState message="Could not load the addresses we must not send to." onRetry={() => q.refetch()} /> : rows.length ? (
        <div className="stack gap-4">
          <div className="max-w-[520px]">
            <Field label="How you confirmed the address by another channel (required to release; the release is recorded with your reason)" htmlFor="rel-reason"><input id="rel-reason" className="input" value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} /></Field>
          </div>
          <Table head={["Address", "Reason", numHead("Times"), "Last", ""]} label="Email addresses we must not send to">
            {rows.map((s, i) => (
              <tr key={s.id} className={ROW_ENTER} style={stagger(i)}>
                <td><div className="font-semibold wrap-anywhere">{s.address}</div><div className="small muted">{wordFor(SUPPRESSION_SOURCE_WORDS, s.source)}</div></td>
                <td><Chip tone={s.reason === "spam_complaint" ? "critical" : "caution"}>{wordFor(SUPPRESSION_WORDS, s.reason)}</Chip></td>
                <td className="num">{s.count}</td>
                <td className="small nowrap text-ink-2"><When at={s.lastAt} /></td>
                <td className="text-right">{s.reason === "spam_complaint" ? <span className="small muted">Never released</span> : <Button size="sm" variant="quiet" ariaLabel={`Release ${s.address}`} disabled={!reasonReady(releaseReason)} loading={release.isPending && release.variables === s.id} onClick={() => release.mutate(s.id)}>Release</Button>}</td>
              </tr>
            ))}
          </Table>
          <p className="small muted flex items-start gap-2"><Icon name="shield" size={16} className="mt-0.5" />A spam complaint is never released from here: the person asked not to be emailed.</p>
        </div>
      ) : <Empty />}
      <StopEmailsToAddress />
    </Card>
  );
}

/**
 * "Stop emails to an address" (POST /admin/email-suppressions): someone asked by phone or in person not to be emailed,
 * or an address bounces where the provider does not report it. Why is required and kept with the address.
 */
function StopEmailsToAddress() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ address: "", reason: "" });
  const add = useMutation({ mutationFn: () => api.post("/api/v1/admin/email-suppressions", { address: form.address.trim(), reason: form.reason.trim() } satisfies SuppressAddress, reason), onSuccess: () => { toast(`Added. Nothing more will be emailed to ${form.address.trim()}.`); setForm({ address: "", reason: "" }); qc.invalidateQueries({ queryKey: adminKeys.suppressions }); }, onError: (e) => toast(errorWords(e, "Could not add the address.")) });
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.address.trim()) && reasonReady(form.reason);
  return (
    <div className="-mx-6 mt-6 border-t border-line px-6 pt-6 max-sm:-mx-4 max-sm:px-4">
      <div className="stack max-w-[520px] gap-3">
        <h3 className="eyebrow">Stop emails to an address</h3>
        <p className="small muted">For someone who asked, by phone or in person, not to be emailed. Every message to this address stops, for every company, until it is released.</p>
        <Field label="Email address" htmlFor="sup-address"><input id="sup-address" className="input" type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Why (required)" htmlFor="sup-reason"><input id="sup-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        <div className="row"><Button variant="secondary" disabled={!ready} loading={add.isPending} onClick={() => add.mutate()}>Add to the list</Button></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Security reports                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Which pages a content-security report came from. */
const CSP_SURFACE_WORDS: Readonly<Record<string, string>> = { candidate: "Candidate pages", app: "Staff app" };
/** The content-security policy's mode (CSP_MODE). */
const CSP_MODE_WORDS: Readonly<Record<string, string>> = { "report-only": "Report only: browsers tell us, nothing is blocked yet", enforce: "Enforced: the policy blocks what it does not allow" };

/** Content-security reports: the policy's mode, how many are not reviewed yet, and Mark reviewed with a note. */
export function Security() {
  const qc = useQueryClient();
  const csp = useQuery({ queryKey: adminKeys.csp, queryFn: () => api.get<CspReports>("/api/v1/admin/csp-reports", reason) });
  const [note, setNote] = useState<Record<string, string>>({});
  const review = useMutation({ mutationFn: (r: { id: string; disposition: string }) => api.post(`/api/v1/admin/csp-reports/${r.id}/review`, { disposition: r.disposition } satisfies ReviewCspReport, reason), onSuccess: () => { toast("Reviewed."); qc.invalidateQueries({ queryKey: adminKeys.csp }); }, onError: (e) => toast(errorWords(e, "Could not review.")) });
  const reports = csp.data?.reports ?? [];
  const unreviewed = reports.filter((r) => !r.reviewedAt).length;
  return (
    <Card title={csp.data ? `Content-security reports (${unreviewed} not reviewed yet)` : "Content-security reports"}>
      {/* the policy's mode, and the rule that goes with it folded under it */}
      {csp.data ? (
        <details className="more mb-4">
          <summary><Icon name="shield" size={16} className="text-primary" />Policy: {wordFor(CSP_MODE_WORDS, csp.data.mode || "report-only")}</summary>
          <p className="small muted max-w-[75ch]">Browsers report what the policy would block. Review every unexplained report before enforcement is switched on (docs/readiness/18). Paths and origins only; never candidate data.</p>
        </details>
      ) : null}
      {csp.isLoading ? <Skeleton lines={3} /> : csp.error ? <ErrorState message="Could not load the content-security reports." onRetry={() => csp.refetch()} /> : reports.length ? (
        <ul className="-mx-6 divide-y divide-line border-t border-line max-sm:-mx-4">
          {reports.slice(0, 50).map((r, i) => (
            <li key={r.id} className={`grid min-w-0 gap-1.5 px-6 py-4 last:pb-0 max-sm:px-4 ${ROW_ENTER}`} style={stagger(i)}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <Chip tone={r.reviewedAt ? "neutral" : "caution"}>{wordFor(CSP_SURFACE_WORDS, r.surface)}</Chip>
                <strong className="min-w-0 text-[15px] text-ink wrap-anywhere">{r.violatedDirective}</strong>
                <span className="small muted whitespace-nowrap">· <When at={r.lastAt} /></span>
              </div>
              <p className="small muted wrap-anywhere">{`${r.documentPath} · blocked ${r.blockedOrigin ?? "(none)"} · ${timesWord(r.count)}`}</p>
              <div className="mt-1 grid gap-2">
                {r.reviewedAt ? <span className="small muted">Reviewed: {r.disposition}</span> : r.disposition ? <span className="small muted">Recurred since it was reviewed ("{r.disposition}"); review again.</span> : null}
                {!r.reviewedAt ? (
                  <div className="flex flex-wrap items-center gap-2"><input className="input min-w-0 flex-[1_1_220px] sm:max-w-[360px]" aria-label={`What this report means: ${r.violatedDirective} on ${r.documentPath}`} placeholder="expected in dev / fix needed / policy change" value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} /><Button size="sm" variant="secondary" ariaLabel={`Mark reviewed: ${r.violatedDirective} on ${r.documentPath}`} disabled={(note[r.id] ?? "").trim().length < 3} loading={review.isPending && review.variables?.id === r.id} onClick={() => review.mutate({ id: r.id, disposition: note[r.id] })}>Mark reviewed</Button></div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty />}
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Administrators                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A platform role in words. Only an administrator can be granted; another code names a row already on the ledger. */
const PLATFORM_ROLE_WORDS: Readonly<Record<string, string>> = { platform_admin: "Platform administrator" };
const roleWords = (code: string) => wordFor(PLATFORM_ROLE_WORDS, code);

/**
 * The platform administrators: the ledger of named people. A grant or a revocation needs a reason and a confirmation,
 * and every other administrator is told; nobody can grant themselves anything, and the last administrator stays.
 */
export function Administrators() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adminKeys.platformRoles, queryFn: () => api.get<PlatformRoleGrants>("/api/v1/admin/platform-roles", reason) });
  const [form, setForm] = useState({ email: "", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; reason: string } | null>(null);
  const grant = useMutation({ mutationFn: () => api.post("/api/v1/admin/platform-roles", { email: form.email.trim(), reason: form.reason.trim(), role: "platform_admin", confirm: true } satisfies GrantPlatformRole, reason), onSuccess: () => { toast("Granted. Every other administrator has been told."); setForm({ email: "", reason: "" }); setConfirming(false); qc.invalidateQueries({ queryKey: adminKeys.platformRoles }); }, onError: (e) => toast(errorWords(e, "Could not grant.")) });
  const revoke = useMutation({ mutationFn: (r: { id: string; reason: string }) => api.post(`/api/v1/admin/platform-roles/${r.id}/revoke`, { reason: r.reason.trim(), confirm: true } satisfies RevokePlatformRole, reason), onSuccess: () => { toast("Revoked. Every other administrator has been told."); setRevoking(null); qc.invalidateQueries({ queryKey: adminKeys.platformRoles }); }, onError: (e) => toast(errorWords(e, "Could not revoke.")) });
  if (!q.data) return q.error ? <ErrorState message="Could not load the administrators." onRetry={() => q.refetch()} /> : <Skeleton lines={4} />;
  const active = q.data.grants.filter((g) => !g.revokedAt);
  const past = q.data.grants.filter((g) => g.revokedAt);
  return (
    <div className="stack gap-5">
      {q.data.bootstrap.ignored ? <Alert tone="caution">BOOTSTRAP_ADMIN_EMAILS is still set but administrators already exist. It grants nothing now; remove it from the environment.</Alert> : null}
      <Card title={`Platform administrators (${q.data.activeAdmins})`}>
        <Table head={["Person", "Role", "Granted", "Reason", ""]}>
          {active.map((g, i) => (
            <tr key={g.id} className={ROW_ENTER} style={stagger(i)}>
              <td><span className="font-semibold">{g.name ?? g.email}</span><div className="small muted wrap-anywhere">{g.email}</div></td>
              <td><Chip tone={g.role === "platform_admin" ? "accent" : "neutral"}>{roleWords(g.role)}</Chip></td>
              <td><span title={exactWhen(g.grantedAt)}>{new Date(g.grantedAt).toLocaleDateString()}</span><div className="small muted">by {g.grantedBy.name ?? g.grantedBy.id} · {codeWords(g.source).toLowerCase()}</div></td>
              <td className="small text-ink-2">{g.grantReason}</td>
              <td className="text-right">
                {revoking?.id === g.id ? (
                  <div className="stack min-w-[200px] gap-2 text-left">
                    <Field label="Reason for revoking" htmlFor={`rr-${g.id}`}><input id={`rr-${g.id}`} className="input" value={revoking.reason} onChange={(e) => setRevoking({ id: g.id, reason: e.target.value })} /></Field>
                    <div className="row"><Button size="sm" variant="destructive" disabled={!reasonReady(revoking.reason)} loading={revoke.isPending} onClick={() => revoke.mutate(revoking)}>Revoke now</Button><Button size="sm" variant="quiet" onClick={() => setRevoking(null)}>Cancel</Button></div>
                  </div>
                ) : <Button size="sm" variant="secondary" ariaLabel={`Revoke ${g.name ?? g.email}`} onClick={() => setRevoking({ id: g.id, reason: "" })}>Revoke</Button>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      {/* who is told: an eye beside the title (its words are its name and tooltip). The API's own errors say when the person
          has not signed in with Microsoft 365 and a second factor yet, or when someone tries to grant themselves the role. */}
      <Card title="Add a platform administrator" aside={<IconLabel icon="eye" label="Every other administrator is told, and another administrator must acknowledge the alert." />}>
        <div className="stack max-w-[520px] gap-4">
          <Field label="Staff email" htmlFor="pr-email"><input id="pr-email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Reason" htmlFor="pr-reason"><input id="pr-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className="row justify-between"><span>Make {form.email.trim()} a platform administrator?</span><span className="row"><Button size="sm" variant="primary" loading={grant.isPending} onClick={() => grant.mutate()}>Yes, grant it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant="primary" disabled={!form.email.includes("@") || !reasonReady(form.reason)} onClick={() => setConfirming(true)}>Grant</Button></div>}
        </div>
      </Card>
      <SignOutEverywhere />
      {past.length ? <Card title="Past administrators"><ul className="small list-disc space-y-1.5 pl-5 text-ink-2 marker:text-ink-3">{past.map((g) => <li key={g.id}>{g.email} · {roleWords(g.role)} · granted {new Date(g.grantedAt).toLocaleDateString()} by {g.grantedBy.name ?? g.grantedBy.id} · revoked {g.revokedAt ? new Date(g.revokedAt).toLocaleDateString() : ""} by {g.revokedBy?.name ?? g.revokedBy?.id}: {g.revokeReason}</li>)}</ul></Card> : null}
    </div>
  );
}

/**
 * "Sign someone out everywhere" (POST /admin/sessions/revoke): after a lost or stolen phone or laptop, or when someone
 * leaves, every session they have ends at once and they must sign in again. A reason and a confirmation.
 */
export function SignOutEverywhere() {
  const [form, setForm] = useState({ email: "", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const signOut = useMutation({
    mutationFn: () => api.post<SessionsRevoked>("/api/v1/admin/sessions/revoke", { email: form.email.trim(), reason: form.reason.trim(), confirm: true } satisfies RevokeSessions, reason),
    onSuccess: (r) => { toast(r.sessionsEnded ? `Signed out. ${r.sessionsEnded} session${r.sessionsEnded === 1 ? "" : "s"} ended.` : "Done. They had no open sessions."); setForm({ email: "", reason: "" }); setConfirming(false); },
    onError: (e) => toast(errorWords(e, "Could not sign them out.")),
  });
  return (
    <Card title="Sign someone out everywhere">
      {/* the one rule that changes what to do first; the confirmation says the rest */}
      <p className="small muted max-w-[75ch]">For a lost second-factor device, reset it in the identity service first.</p>
      <div className="stack mt-4 max-w-[520px] gap-4">
        <Field label="Email they sign in with" htmlFor="so-email"><input id="so-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Reason" htmlFor="so-reason"><input id="so-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        {confirming ? (
          <Alert tone="caution"><div className="row justify-between"><span>Sign {form.email.trim()} out of every device?</span><span className="row"><Button size="sm" variant="destructive" loading={signOut.isPending} onClick={() => signOut.mutate()}>Yes, sign them out</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
        ) : <div className="row"><Button variant="secondary" disabled={!form.email.includes("@") || !reasonReady(form.reason)} onClick={() => setConfirming(true)}>Sign out everywhere</Button></div>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The section                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The parts of System, each its own `?view=`. */
export const SYSTEM_PARTS: SectionPart[] = [
  { id: "health", label: "Health" },
  { id: "costs", label: "Costs" },
  { id: "email", label: "Email" },
  { id: "security", label: "Security reports" },
  { id: "admins", label: "Administrators" },
];

/** The System section (the contract in admin-api.ts): its five parts as underline tabs, and the chosen part. */
export function SystemSection({ view, onView }: SectionProps) {
  const part = partOf(SYSTEM_PARTS, view);
  return (
    <Tabs label="System" value={part} onChange={onView} items={SYSTEM_PARTS}>
      {part === "costs" ? <Costs /> : part === "email" ? <Email /> : part === "security" ? <Security /> : part === "admins" ? <Administrators /> : <Health />}
    </Tabs>
  );
}
