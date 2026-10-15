"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Chip, ErrorState, Field, numHead, Skeleton, Table, Tabs } from "@ros/ui";
import { api, ApiError, type Me } from "../../api/client";
import { toast } from "../../toast";
import { adminKeys, type AlertRow, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { aiStatusWords, exactWhen, firstUpper, plainCode, severityWords, whenWords, wordFor, workflowWords } from "./admin-words";
import { RunDrawer, type RunRow } from "./system";

/*
 * The console's Problems section (redesign spec 3.2, Wave S6 S6-D): what was the Failures tab, in four parts, each its
 * own `?view=` with a count on its tab. Alerts that need a person; failed work (workflow runs, background tasks, AI runs
 * that were not OK, credentials left after a disconnect); email (addresses we must not send to, and email applications
 * that could not be imported); and content-security reports. Rows, not tables, except the suppressed addresses (five
 * columns). Every action the Failures tab had is in its part, with the same words and toasts.
 */

type Pending = { id: string; provider: string; kind: string; status: string; lastError: string | null; disconnectedAt: string | null };
type Suppression = { id: string; address: string; reason: string; source: string; active: boolean; count: number; firstAt: string; lastAt: string; details: Record<string, unknown> };
/** A failed workflow run: GET /admin/failures sends the whole run row, the same row System › Workflows lists. */
type FailedRun = RunRow;
type FailedJob = { id: number; kind: string; lastError: string | null; attempts?: number; createdAt?: string };
type FailedAi = { id: string; task: string; status: string; error: string | null; createdAt: string; model?: string };
type FailuresAnswer = { failedRuns: FailedRun[]; failedJobs: FailedJob[]; failedAi: FailedAi[]; alerts: AlertRow[]; pendingDeletions: Pending[] };
type CspReport = { id: string; mode: string; surface: string; documentPath: string; violatedDirective: string; blockedOrigin: string | null; sourceFile: string | null; count: number; lastAt: string; reviewedAt: string | null; disposition: string | null };
type CspAnswer = { mode: string; reports: CspReport[] };

/** What a part says when it has nothing in it (redesign spec 3.2). */
export const PROBLEMS_EMPTY = "None. When something goes wrong, it shows here and on the Overview.";

/**
 * An alert this administrator may not acknowledge (21 Sep, item 2): one about a platform role they changed, or one that
 * concerns them, is for another administrator. The API refuses it (second_person_required), so no button is offered.
 */
export function ackIsForAnother(a: Pick<AlertRow, "kind" | "details" | "target">, myUserId: string | null | undefined): boolean {
  return !!myUserId && a.kind.startsWith("platform_role.") && (a.details?.actorId === myUserId || a.target?.id === myUserId);
}
/** Screening-chat notices: they belong to the customer (Customers › Running low), and Overview gives each its own row. */
export const SCREENING_ALERT_KINDS: ReadonlySet<string> = new Set(["billing.screens_warning", "billing.screens_used_up"]);
/** An alert that waits for a person: open, and not a screening-chat notice. Overview and the Alerts tab count the same ones. */
export function needsAPerson(a: Pick<AlertRow, "status" | "kind">): boolean {
  return a.status === "open" && !SCREENING_ALERT_KINDS.has(a.kind);
}
export const ACK_FOR_ANOTHER ="Another administrator acknowledges this one, because it is about a platform role you changed or one that concerns you.";
/** What Resolve says: the alert is closed for good, and the problem raises a new one if it comes back. */
export const RESOLVED_TOAST = { title: "Resolved.", detail: "If it happens again, a new alert is raised." };

/**
 * What "Retry deletion" says. Only the worker may read a stored credential, so the retry is queued for it and is rarely
 * done by the time the answer comes back; the alert closes on its own once the credential is gone.
 */
export function retryDeletionToast(r: { queued?: boolean; deleted?: boolean }): { title: string; detail?: string } {
  if (r.deleted) return { title: "Credential deleted.", detail: "The alert closes on its own." };
  return { title: "Deletion queued.", detail: "It runs in the background in a moment. The alert closes once the credential is gone." };
}

/** Why an address is on the do-not-send list, in plain words. */
const SUPPRESSION_WORDS: Readonly<Record<string, string>> = { hard_bounce: "Bounced", spam_complaint: "Spam complaint", soft_bounce_repeated: "Bounced several times", manual: "Added by hand", subscription_change: "Unsubscribed" };
/** Who put an address on the list (packages/core/src/email-suppression.ts). */
const SUPPRESSION_SOURCE_WORDS: Readonly<Record<string, string>> = { postmark: "Reported by the email provider", admin: "Added by an administrator" };
/** Which pages a content-security report came from. */
const CSP_SURFACE_WORDS: Readonly<Record<string, string>> = { candidate: "Candidate pages", app: "Staff app" };
/** The content-security policy's mode (CSP_MODE). */
const CSP_MODE_WORDS: Readonly<Record<string, string>> = { "report-only": "Report only: browsers tell us, nothing is blocked yet", enforce: "Enforced: the policy blocks what it does not allow" };

/** The chip tone for an alert's severity: urgent in red, for your information in grey, the rest amber. */
function severityTone(severity: string): "critical" | "caution" | "neutral" {
  return severity === "critical" ? "critical" : severity === "info" ? "neutral" : "caution";
}

const timesWord = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

// ---- what the section reads (one query each, under the console's shared keys so Overview reuses the answers) ----

function useFailures() {
  return useQuery({ queryKey: adminKeys.failures, queryFn: () => api.get<FailuresAnswer>("/api/v1/admin/failures", reason), refetchInterval: 15000 });
}
function useSuppressions() {
  return useQuery({ queryKey: adminKeys.suppressions, queryFn: () => api.get<Suppression[]>("/api/v1/admin/email-suppressions", reason) });
}
function useCsp() {
  return useQuery({ queryKey: adminKeys.csp, queryFn: () => api.get<CspAnswer>("/api/v1/admin/csp-reports", reason) });
}
function useFailedEmail() {
  return useQuery({ queryKey: adminKeys.failedEmailApplications, queryFn: () => api.get<FailedEmailRow[]>("/api/v1/admin/failed-email-applications", reason) });
}

/** "Retry deletion" on an alert and "Retry" on a credential left after a disconnect: the same call. */
function useRetryDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) => api.post<{ queued?: boolean; deleted?: boolean }>(`/api/v1/admin/integrations/${integrationId}/retry-deletion`, {}, reason),
    onSuccess: (r) => { const t = retryDeletionToast(r); toast(t.title, t.detail); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: adminKeys.alerts }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the deletion. Try again in a moment."),
  });
}

/** Retry a failed workflow run from its row (its drawer, System's RunDrawer, has its own Retry). */
function useRetryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason),
    onSuccess: () => { toast("Retried."); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: ["admin", "runs"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the run. Try again in a moment."),
  });
}

/**
 * How many things each part lists, for the counts on its tab; a part whose answers have not come yet has no count.
 * Alerts counts those that wait for a person (as Overview does; acknowledged ones and screening-chat notices are still
 * listed, folded). Security counts the reports nobody has reviewed yet (a reviewed one is not a problem).
 */
export function problemCounts(d: { failures?: FailuresAnswer; suppressions?: Suppression[]; failedEmail?: FailedEmailRow[]; csp?: CspAnswer }): Record<string, number | undefined> {
  const f = d.failures;
  return {
    alerts: f ? f.alerts.filter(needsAPerson).length : undefined,
    failed: f ? f.failedRuns.length + f.failedJobs.length + f.failedAi.length + f.pendingDeletions.length : undefined,
    email: d.suppressions && d.failedEmail ? d.suppressions.length + d.failedEmail.length : undefined,
    security: d.csp ? d.csp.reports.filter((r) => !r.reviewedAt).length : undefined,
  };
}

// ---- the row every part draws ----

const LIST: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
const ROW: CSSProperties = { display: "grid", gap: 4, padding: "10px 0", borderTop: "1px solid var(--line)" };

/** A date as the console reads it ("today", "3 days ago", "Oct 3"), the exact time on hover. */
function When({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  return <time dateTime={at} title={exactWhen(at)}>{whenWords(at)}</time>;
}

/**
 * One problem: a chip (severity, kind), its title and when, then a sentence, one quieter line of details and its
 * buttons. Row text in the page's ink; the details line small and grey (redesign spec 3.3).
 */
function ProblemRow(props: { lead?: ReactNode; title: ReactNode; at?: string | null; body?: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <li className="problem-row" style={ROW}>
      <div className="row">
        {props.lead}
        <strong>{props.title}</strong>
        {props.at ? <span className="small muted">· <When at={props.at} /></span> : null}
      </div>
      {props.body ? <p style={{ margin: 0 }}>{props.body}</p> : null}
      {props.detail ? <p className="small muted" style={{ margin: 0 }}>{props.detail}</p> : null}
      {props.children}
    </li>
  );
}

function Empty() {
  return <p className="muted" style={{ margin: "8px 0 0" }}>{PROBLEMS_EMPTY}</p>;
}

// ---- Alerts ----

/** Alerts that need a person: Acknowledge (unless it is for another administrator), Resolve, Retry deletion. */
function AlertsPart() {
  const qc = useQueryClient();
  // Who is signed in: an alert about their own platform role change is acknowledged by another administrator.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const q = useFailures();
  // Overview reads the alerts on their own key, so both answers are read again after a change.
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/acknowledge`, {}, reason), onSuccess: () => { toast("Acknowledged."); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: adminKeys.alerts }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not acknowledge the alert. Try again in a moment.") });
  // Resolve (Wave S2 F1): the problem is dealt with; the alert leaves this list and a new one is raised if it comes back.
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/resolve`, {}, reason), onSuccess: () => { toast(RESOLVED_TOAST.title, RESOLVED_TOAST.detail); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: adminKeys.alerts }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not resolve the alert. Try again in a moment.") });
  const retry = useRetryDeletion();
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the alerts." onRetry={() => q.refetch()} />;
  // Those that wait for a person first (the tab's count, and Overview's); acknowledged ones and screening-chat notices
  // stay one click away, folded, with every button they had.
  const needing = q.data.alerts.filter(needsAPerson);
  const others = q.data.alerts.filter((a) => !needsAPerson(a));
  const row = (a: AlertRow) => {
    const credential = a.kind === "secret.delete_failed" ? a.target : null;
    return (
      <ProblemRow key={a.id} lead={<Chip tone={severityTone(a.severity)}>{severityWords(a.severity)}</Chip>} title={a.title} at={a.createdAt} body={a.body}>
        <div className="row">
          {a.status === "acknowledged" ? <Chip tone="neutral">Acknowledged</Chip> : null}
          {ackIsForAnother(a, me.data?.user.id) ? (a.status === "open" ? <span className="small muted">{ACK_FOR_ANOTHER}</span> : null) : (
            <>
              {a.status === "open" ? <Button size="sm" variant="secondary" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>Acknowledge</Button> : null}
              <Button size="sm" variant="quiet" loading={resolve.isPending && resolve.variables === a.id} onClick={() => resolve.mutate(a.id)}>Resolve</Button>
            </>
          )}
          {credential ? <Button size="sm" variant="primary" loading={retry.isPending && retry.variables === credential.id} onClick={() => retry.mutate(credential.id)}>Retry deletion</Button> : null}
        </div>
      </ProblemRow>
    );
  };
  return (
    <Card title={`Alerts that need a person (${needing.length})`}>
      {needing.length ? <ul style={LIST}>{needing.map(row)}</ul> : <Empty />}
      {others.length ? (
        <details className="more">
          <summary>{`Acknowledged and screening-chat notices (${others.length})`}</summary>
          <ul style={LIST}>{others.map(row)}</ul>
        </details>
      ) : null}
    </Card>
  );
}

// ---- Failed work ----

/** Failed workflow runs (each opens its drawer, with Retry), failed background tasks, AI runs that were not OK, credentials left behind. */
function FailedWorkPart() {
  const q = useFailures();
  const retryDeletion = useRetryDeletion();
  const retryRun = useRetryRun();
  const [shownRun, setShownRun] = useState<FailedRun | null>(null);
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the failed work." onRetry={() => q.refetch()} />;
  const { failedRuns, failedJobs, failedAi, pendingDeletions } = q.data;
  if (!failedRuns.length && !failedJobs.length && !failedAi.length && !pendingDeletions.length) return <Card title="Failed work (0)"><Empty /></Card>;
  return (
    <div className="stack">
      {failedRuns.length ? (
        <Card title={`Failed workflow runs (${failedRuns.length})`}>
          <ul style={LIST}>
            {failedRuns.map((r) => (
              <ProblemRow key={r.id} lead={<Chip tone="critical">Failed</Chip>} title={<button type="button" className="btn quiet sm" onClick={() => setShownRun(r)}>{workflowWords(r.workflowKey)}</button>} at={r.updatedAt} detail={[r.currentStep ? `Step: ${plainCode(r.currentStep)}` : null, r.lastError ? r.lastError.slice(0, 160) : null].filter(Boolean).join(" · ")}>
                <div className="row">
                  <Button size="sm" variant="secondary" loading={retryRun.isPending && retryRun.variables === r.id} onClick={() => retryRun.mutate(r.id)}>Retry</Button>
                </div>
              </ProblemRow>
            ))}
          </ul>
        </Card>
      ) : null}
      {pendingDeletions.length ? (
        <Card title={`Credentials still in the store after disconnect (${pendingDeletions.length})`}>
          <ul style={LIST}>
            {pendingDeletions.map((p) => (
              <ProblemRow key={p.id} title={firstUpper(`${plainCode(p.provider)} ${plainCode(p.kind)}`)} at={p.disconnectedAt} detail={p.lastError}>
                <div className="row">
                  <Button size="sm" variant="quiet" loading={retryDeletion.isPending && retryDeletion.variables === p.id} onClick={() => retryDeletion.mutate(p.id)}>Retry</Button>
                </div>
              </ProblemRow>
            ))}
          </ul>
        </Card>
      ) : null}
      {failedJobs.length ? (
        <Card title={`Background tasks that failed (${failedJobs.length})`}>
          <ul style={LIST}>
            {failedJobs.map((j) => <ProblemRow key={j.id} title={firstUpper(plainCode(j.kind))} at={j.createdAt} detail={[j.attempts ? `Tried ${timesWord(j.attempts)}` : null, j.lastError].filter(Boolean).join(" · ")} />)}
          </ul>
        </Card>
      ) : null}
      {failedAi.length ? (
        <Card title={`AI runs that were not OK (${failedAi.length})`}>
          <ul style={LIST}>
            {failedAi.map((a) => <ProblemRow key={a.id} lead={<Chip tone="caution">{aiStatusWords(a.status)}</Chip>} title={firstUpper(plainCode(a.task))} at={a.createdAt} detail={[a.model, a.error].filter(Boolean).join(" · ")} />)}
          </ul>
        </Card>
      ) : null}
      {/* the same run drawer as System › Workflows: what went wrong, what happened, AI calls, who did what, raw state, Retry */}
      {shownRun ? <RunDrawer row={shownRun} onClose={() => setShownRun(null)} /> : null}
    </div>
  );
}

// ---- Email ----

/** Addresses we must not send to (Release with a reason; a spam complaint never), then email applications that did not import. */
function EmailPart() {
  return (
    <div className="stack">
      <Suppressions />
      <FailedEmailApplications />
    </div>
  );
}

function Suppressions() {
  const qc = useQueryClient();
  const q = useSuppressions();
  const [releaseReason, setReleaseReason] = useState("");
  const release = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/email-suppressions/${id}/release`, { reason: releaseReason }, reason), onSuccess: () => { toast("Released. Email to that address is allowed again."); setReleaseReason(""); qc.invalidateQueries({ queryKey: adminKeys.suppressions }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not release.") });
  const rows = q.data ?? [];
  return (
    <Card title={q.isLoading ? "Email addresses we must not send to" : `Email addresses we must not send to (${rows.length})`}>
      <p className="small muted">Hard bounces, spam complaints and repeated soft bounces land here from the provider's webhooks. Release one only after confirming the address by another channel; the release is audited with your reason.</p>
      {q.isLoading ? <Skeleton lines={3} /> : q.error ? <ErrorState message="Could not load the addresses we must not send to." onRetry={() => q.refetch()} /> : rows.length ? (
        <>
          <Field label="How you confirmed the address (required to release)" htmlFor="rel-reason"><input id="rel-reason" className="input" value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} /></Field>
          <Table head={["Address", "Reason", numHead("Times"), "Last", ""]} label="Email addresses we must not send to">
            {rows.map((s) => (
              <tr key={s.id}>
                <td><div>{s.address}</div><div className="small muted">{wordFor(SUPPRESSION_SOURCE_WORDS, s.source)}</div></td>
                <td><Chip tone={s.reason === "spam_complaint" ? "critical" : "caution"}>{wordFor(SUPPRESSION_WORDS, s.reason)}</Chip></td>
                <td className="num">{s.count}</td>
                <td><When at={s.lastAt} /></td>
                <td>{s.reason === "spam_complaint" ? <span className="small muted">Never released</span> : <Button size="sm" variant="quiet" ariaLabel={`Release ${s.address}`} disabled={releaseReason.trim().length < 5} loading={release.isPending && release.variables === s.id} onClick={() => release.mutate(s.id)}>Release</Button>}</td>
              </tr>
            ))}
          </Table>
          <p className="small muted">A spam complaint is never released from here: the person asked not to be emailed.</p>
        </>
      ) : <Empty />}
    </Card>
  );
}

/** An email application that could not be imported, as GET /admin/failed-email-applications lists it. */
export type FailedEmailRow = { id: string; receivedAt: string; companyName: string | null; roleTitle: string | null; from: string | null; subject: string | null; error: string | null; hasResume: boolean; canRetry: boolean; text: string };

/** What the row says about where the email was going and what came with it, in one line. */
export function failedEmailLine(r: FailedEmailRow): string {
  const where = r.roleTitle ? `${r.roleTitle}${r.companyName ? ` at ${r.companyName}` : ""}` : r.companyName ?? "a job that no longer takes email";
  return `${r.from ?? "Unknown sender"} · ${where} · ${r.hasResume ? "résumé attached" : "no résumé"}`;
}

/**
 * Email applications that failed to import (known-bugs row 120): who sent it, for which job, why it failed, the email
 * itself one click away, and "Try again" once the job is taking applications.
 */
function FailedEmailApplications() {
  const qc = useQueryClient();
  const q = useFailedEmail();
  const retry = useMutation({
    mutationFn: (id: string) => api.post<{ ok: true; duplicate: boolean }>(`/api/v1/admin/failed-email-applications/${id}/retry`, {}, reason),
    onSuccess: (r) => { toast(r.duplicate ? "Done. This person had already applied, so nothing new was added." : "Done. The application is on the job now."); qc.invalidateQueries({ queryKey: adminKeys.failedEmailApplications }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not try it again. Try again in a moment."),
  });
  const rows = q.data ?? [];
  return (
    <Card title={q.isLoading ? "Email applications that could not be imported" : q.error ? "Email applications that could not be imported (could not load)" : `Email applications that could not be imported (${rows.length})`}>
      {q.isLoading ? <Skeleton lines={3} /> : q.error ? <ErrorState message="Could not load the email applications." onRetry={() => q.refetch()} /> : rows.length ? (
        <ul style={LIST}>
          {rows.map((r) => (
            <ProblemRow key={r.id} title={r.subject || "(no subject)"} at={r.receivedAt} body={failedEmailLine(r)} detail={`Why: ${r.error ?? "unknown"}`}>
              <details className="more">
                <summary>Show the email</summary>
                <p className="small" style={{ whiteSpace: "pre-wrap" }}>{r.text || "(no text)"}</p>
              </details>
              <div className="row">
                {r.canRetry ? <Button size="sm" variant="secondary" loading={retry.isPending && retry.variables === r.id} onClick={() => retry.mutate(r.id)}>Try again</Button> : <span className="small muted">The job is not taking applications right now.</span>}
              </div>
            </ProblemRow>
          ))}
        </ul>
      ) : <Empty />}
    </Card>
  );
}

// ---- Security reports ----

/** Content-security reports: the policy's mode, how many are not reviewed yet, and Mark reviewed with a note. */
function SecurityPart() {
  const qc = useQueryClient();
  const csp = useCsp();
  const [cspNote, setCspNote] = useState<Record<string, string>>({});
  const reviewCsp = useMutation({ mutationFn: (r: { id: string; disposition: string }) => api.post(`/api/v1/admin/csp-reports/${r.id}/review`, { disposition: r.disposition }, reason), onSuccess: () => { toast("Reviewed."); qc.invalidateQueries({ queryKey: adminKeys.csp }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not review.") });
  const reports = csp.data?.reports ?? [];
  const unreviewed = reports.filter((r) => !r.reviewedAt).length;
  return (
    <Card title={csp.data ? `Content-security reports (${unreviewed} not reviewed yet)` : "Content-security reports"}>
      {csp.data ? <p style={{ margin: "0 0 4px" }}>Policy: {wordFor(CSP_MODE_WORDS, csp.data.mode || "report-only")}</p> : null}
      <p className="small muted">Browsers report what the policy would block. Review every unexplained report before enforcement is switched on (docs/readiness/18). Paths and origins only; never candidate data.</p>
      {csp.isLoading ? <Skeleton lines={3} /> : csp.error ? <ErrorState message="Could not load the content-security reports." onRetry={() => csp.refetch()} /> : reports.length ? (
        <ul style={LIST}>
          {reports.slice(0, 50).map((r) => (
            <ProblemRow key={r.id} lead={<Chip tone={r.reviewedAt ? "neutral" : "caution"}>{wordFor(CSP_SURFACE_WORDS, r.surface)}</Chip>} title={r.violatedDirective} at={r.lastAt} detail={`${r.documentPath} · blocked ${r.blockedOrigin ?? "(none)"} · ${timesWord(r.count)}`}>
              {r.reviewedAt ? <span className="small muted">Reviewed: {r.disposition}</span> : r.disposition ? <span className="small muted">Recurred since it was reviewed ("{r.disposition}"); review again.</span> : null}
              {!r.reviewedAt ? (
                <div className="row"><input className="input" style={{ maxWidth: 360 }} aria-label={`What this report means: ${r.violatedDirective} on ${r.documentPath}`} placeholder="expected in dev / fix needed / policy change" value={cspNote[r.id] ?? ""} onChange={(e) => setCspNote({ ...cspNote, [r.id]: e.target.value })} /><Button size="sm" variant="secondary" ariaLabel={`Mark reviewed: ${r.violatedDirective} on ${r.documentPath}`} disabled={(cspNote[r.id] ?? "").trim().length < 3} loading={reviewCsp.isPending && reviewCsp.variables?.id === r.id} onClick={() => reviewCsp.mutate({ id: r.id, disposition: cspNote[r.id] })}>Mark reviewed</Button></div>
              ) : null}
            </ProblemRow>
          ))}
        </ul>
      ) : <Empty />}
    </Card>
  );
}

// ---- the section ----

/** The parts of Problems, each its own `?view=` (redesign spec 3.1). */
export const PROBLEMS_PARTS: SectionPart[] = [{ id: "alerts", label: "Alerts" }, { id: "failed", label: "Failed work" }, { id: "email", label: "Email" }, { id: "security", label: "Security reports" }];

/** The Problems section (the contract in admin-api.ts): the four parts as underline tabs with their counts, and the chosen part. */
export function ProblemsSection({ view, onView }: SectionProps) {
  const part = partOf(PROBLEMS_PARTS, view);
  const failures = useFailures();
  const suppressions = useSuppressions();
  const failedEmail = useFailedEmail();
  const csp = useCsp();
  const counts = problemCounts({ failures: failures.data, suppressions: suppressions.data, failedEmail: failedEmail.data, csp: csp.data });
  return (
    <Tabs label="Problems" value={part} onChange={onView} items={PROBLEMS_PARTS.map((p) => ({ ...p, count: counts[p.id] }))}>
      {part === "failed" ? <FailedWorkPart /> : part === "email" ? <EmailPart /> : part === "security" ? <SecurityPart /> : <AlertsPart />}
    </Tabs>
  );
}
