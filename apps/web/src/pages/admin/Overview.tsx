"use client";

import { type CSSProperties, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Button, Card, ErrorState, Icon, IconChip, PageHeader, Skeleton, StatCell, StatStrip } from "@ros/ui";
import { api, type Me } from "../../api/client";
import { allowanceAlerts, allowanceChip } from "../../allowance";
import { useIsClient } from "../../components/use-is-client";
import { Link } from "../../nav";
import { firstName } from "../../today";
import { adminKeys, adminReason, type AlertRow, type CustomerRow, type DataRequest } from "./admin-api";
import { activityWords, money, planWords, severityWords } from "./admin-words";
import { customerOrder, waitingCustomers } from "./customers";
import { PRIVACY_DUE_SOON_DAYS } from "./privacy";
import { needsAPerson } from "./problems";
import { costsSinceKey, monthStartIn } from "./system";

/**
 * The console's landing page (redesign spec 3.2, "Overview"): a greeting with how many things need a person, then
 * "Needs attention", one row per open problem with one button that opens the exact place, most urgent first; a Customers
 * card whose search reaches any customer's drawer in one click; the month's AI spend with the top three customers; and
 * one line on the system. Each source is read on its own (the same queries as the sections, so one answer serves both),
 * and a source that fails says so on its own row with "Try again" while the others still show.
 */

type FailuresDto = { failedRuns: Array<{ id: string }>; failedJobs: Array<{ id: number; createdAt?: string }>; failedAi: Array<{ id: string; createdAt?: string }>; alerts: AlertRow[]; pendingDeletions: Array<{ id: string }> };
type CspDto = { mode: string; reports: Array<{ id: string; reviewedAt: string | null }> };
type EscalationPreview = { id: string; status: string; overdue: boolean; companyName: string };
type CostRow = { companyId: string | null; task: string; model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number };
type QueueDto = { queued: number; failed: number; oldestQueuedAt: string | null; waitingRuns: number; definitions: string[] };
type CalendarDto = { version: number | null; current: { timeZone: string } };

/** What Overview reads to build "Needs attention"; a source not (yet) read is left out. */
export type OverviewSources = { customers?: CustomerRow[]; alerts?: AlertRow[]; failures?: FailuresDto; privacy?: DataRequest[]; failedEmail?: Array<{ id: string }>; csp?: CspDto; escalations?: EscalationPreview[] };

/** One row of "Needs attention": one sentence, an optional quieter line, and the one button that opens the exact place. */
export type AttentionRow = { key: string; urgent: boolean; text: string; sub?: string; action: { label: string; href: string } };

const DAY = 86_400_000;
// A privacy request shows on Overview once it is due within PRIVACY_DUE_SOON_DAYS (privacy.tsx's own rule), or overdue.
const CLOSED_PRIVACY = new Set(["fulfilled", "declined"]);
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const NAMES_SHOWN = 3;
/** Background tasks and AI runs that failed count on Overview for this many days (failed workflow runs always do). */
export const FAILED_RECENT_DAYS = 7;
/** Up to this many customers running low on screening chats get a row each; more share one row. */
const LOW_ROWS_EACH = 3;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "Cara Dental, Zeta Dental and 2 more". */
function someNames(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}

/** How long a company has waited for the ITS check: "since today", "1 day", "5 days". */
export function waitedWords(createdAt: string, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(createdAt)) / DAY));
  return days === 0 ? "since today" : count(days, "day", "days");
}

/** When a privacy request is due: "overdue", "due within a day", "due in 3 days". */
export function dueWords(slaDueAt: string, now: number = Date.now()): string {
  const left = Date.parse(slaDueAt) - now;
  if (left < 0) return "overdue";
  const days = Math.ceil(left / DAY);
  return days <= 1 ? "due within a day" : `due in ${days} days`;
}

/**
 * "Needs attention", most urgent first (redesign spec 3.2): companies waiting for the ITS check (the longest waiting
 * first, B7); alerts that need a person (urgent first); privacy requests overdue or due within 5 days; failed work;
 * security reports not reviewed; email applications that could not be imported; credentials still stored after a
 * disconnect; recruiter requests past their reply-by time; customers at 80% or more of their screening chats.
 */
export function attentionRows(s: OverviewSources, now: number = Date.now()): AttentionRow[] {
  const rows: AttentionRow[] = [];
  const names = new Map((s.customers ?? []).map((c) => [c.id, c.name]));

  const waiting = waitingCustomers(s.customers ?? []);
  if (waiting.length) {
    rows.push({
      key: "waiting",
      urgent: true,
      text: `${count(waiting.length, "company waits", "companies wait")} for the ITS check`,
      sub: someNames(waiting.map((c) => `${c.name} (${waitedWords(c.createdAt, now)})`)),
      action: { label: "Review", href: `/admin/customers?open=${encodeURIComponent(waiting[0].id)}&tab=check` },
    });
  }

  const alerts = (s.alerts ?? []).filter(needsAPerson).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || b.createdAt.localeCompare(a.createdAt));
  if (alerts.length) {
    const bySeverity = [...new Set(alerts.map((a) => a.severity))].map((sev) => `${alerts.filter((a) => a.severity === sev).length} ${severityWords(sev)}`);
    rows.push({
      key: "alerts",
      urgent: alerts[0].severity === "critical",
      text: alerts.length === 1 ? `1 alert needs a person: “${alerts[0].title}”` : `${alerts.length} alerts need a person`,
      sub: alerts.length === 1 ? severityWords(alerts[0].severity) : bySeverity.join(" · "),
      action: { label: "Open", href: "/admin/problems?view=alerts" },
    });
  }

  const due = (s.privacy ?? []).filter((r) => !CLOSED_PRIVACY.has(r.status) && Date.parse(r.slaDueAt) - now <= PRIVACY_DUE_SOON_DAYS * DAY).sort((a, b) => a.slaDueAt.localeCompare(b.slaDueAt));
  if (due.length) {
    const overdue = due.filter((r) => Date.parse(r.slaDueAt) < now).length;
    const who = (r: DataRequest) => r.companyName ?? names.get(r.companyId) ?? null;
    const one = due[0];
    rows.push({
      key: "privacy",
      urgent: true,
      text: due.length === 1
        ? `1 privacy request is ${dueWords(one.slaDueAt, now)}${who(one) ? ` (${who(one)})` : ""}`
        : overdue === due.length
          ? `${due.length} privacy requests are overdue`
          : `${due.length} privacy requests are due within ${PRIVACY_DUE_SOON_DAYS} days${overdue ? `, ${overdue} of them overdue` : ""}`,
      sub: due.length === 1 ? undefined : someNames(due.map((r) => `${who(r) ?? "A customer"} (${dueWords(r.slaDueAt, now)})`)),
      action: { label: "Open", href: due.length === 1 ? `/admin/privacy?open=${encodeURIComponent(one.id)}` : "/admin/privacy" },
    });
  }

  if (s.failures) {
    // A failed workflow run waits for someone to press Retry, so it always counts. Background tasks and AI runs that were
    // not OK cannot be retried from the console (and a refusal is normal), so only those from the last week count:
    // older ones stay listed under Problems › Failed work without keeping Overview from ever reaching "Nothing needs you".
    const recent = (createdAt: string | undefined) => !createdAt || now - Date.parse(createdAt) <= FAILED_RECENT_DAYS * DAY;
    const kinds = [
      { n: s.failures.failedRuns.length, one: "workflow run", many: "workflow runs" },
      { n: s.failures.failedJobs.filter((j) => recent(j.createdAt)).length, one: "background job", many: "background jobs" },
      { n: s.failures.failedAi.filter((a) => recent(a.createdAt)).length, one: "AI run", many: "AI runs" },
    ].filter((k) => k.n > 0);
    const total = kinds.reduce((n, k) => n + k.n, 0);
    if (total) {
      rows.push({
        key: "failed",
        urgent: s.failures.failedRuns.length > 0,
        text: kinds.length === 1 ? `${count(kinds[0].n, kinds[0].one, kinds[0].many)} failed` : `${total} things failed`,
        sub: kinds.length === 1 ? undefined : kinds.map((k) => count(k.n, k.one, k.many)).join(" · "),
        action: { label: "Open", href: "/admin/problems?view=failed" },
      });
    }
  }

  const unreviewed = (s.csp?.reports ?? []).filter((r) => !r.reviewedAt).length;
  if (unreviewed) rows.push({ key: "security", urgent: false, text: `${count(unreviewed, "security report is", "security reports are")} not reviewed yet`, action: { label: "Open", href: "/admin/problems?view=security" } });

  const emails = s.failedEmail?.length ?? 0;
  if (emails) rows.push({ key: "email", urgent: false, text: `${count(emails, "email application", "email applications")} could not be imported`, action: { label: "Open", href: "/admin/problems?view=email" } });

  const stored = s.failures?.pendingDeletions.length ?? 0;
  if (stored) rows.push({ key: "credentials", urgent: true, text: `${count(stored, "credential is", "credentials are")} still stored after a disconnect`, action: { label: "Open", href: "/admin/problems?view=failed" } });

  const late = (s.escalations ?? []).filter((e) => e.overdue);
  if (late.length) {
    rows.push({
      key: "recruiter",
      urgent: false,
      text: `${count(late.length, "recruiter request is", "recruiter requests are")} overdue`,
      sub: someNames([...new Set(late.map((e) => e.companyName))]),
      action: { label: "Open", href: late.length === 1 ? `/recruiter/queue/${encodeURIComponent(late[0].id)}` : "/recruiter/queue?show=overdue" },
    });
  }

  const low = [...allowanceAlerts(s.alerts ?? []).values()].sort((a, b) => (a.level === b.level ? 0 : a.level === "used_up" ? -1 : 1));
  if (low.length > LOW_ROWS_EACH) {
    // many customers running low share one row, so the list stays short
    rows.push({
      key: "low",
      urgent: false,
      text: `${low.length} customers are running low on AI interviews`,
      sub: someNames(low.map((a) => names.get(a.companyId) ?? "A customer")),
      action: { label: "Open", href: "/admin/customers?show=low" },
    });
  } else {
    for (const a of low) {
      const company = names.get(a.companyId) ?? "A customer";
      rows.push({
        key: `low-${a.companyId}`,
        urgent: false,
        text: `${company} has used ${a.level === "used_up" ? "all its" : "80% of its"} AI interviews`,
        sub: allowanceChip(a),
        action: { label: "Open", href: `/admin/customers?show=low&open=${encodeURIComponent(a.companyId)}` },
      });
    }
  }
  return rows;
}

/** The first day of this month in the business calendar's time zone ("2026-10-01"); the reader's own month without one. */
export function monthStart(timeZone: string | null | undefined, now: Date = new Date()): string {
  // the same date System › Costs asks for, so both read one cached answer
  return monthStartIn(timeZone ?? undefined, now);
}

/** The month's spend in all, and the customers who spent most, by name. Spend with no customer (the platform's own) counts in the total only. */
export function costSummary(rows: readonly CostRow[], names: ReadonlyMap<string, string>, shown = 3): { total: number; top: Array<{ companyId: string; name: string; usd: number }> } {
  const byCompany = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.costUsd;
    if (r.companyId) byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + r.costUsd);
  }
  const ranked = [...byCompany.entries()].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1]).slice(0, shown);
  return { total, top: ranked.map(([companyId, usd]) => ({ companyId, name: names.get(companyId) ?? "A customer no longer listed", usd })) };
}

/** How a customer reads on the Customers card: its plan, then the ITS check or how recently it was active. */
export function customerLine(c: CustomerRow, now: number = Date.now()): string {
  if (!c.verifiedAt) return `Waiting for the ITS check (${waitedWords(c.createdAt, now)})`;
  const a = activityWords(c.lastActivityAt, now);
  const days = c.lastActivityAt ? Math.round((now - Date.parse(c.lastActivityAt)) / DAY) : null;
  const activity = a.state === "active" ? "Active" : days === null ? "No activity yet" : a.state === "quiet" ? `Quiet for ${days} days` : `No activity for ${days} days`;
  return `${planWords(c.planKey)} · ${activity}`;
}

/** Customers whose name or address matches what was typed, waiting ones first (B7), then by name. */
export function customerMatches(rows: readonly CustomerRow[], typed: string): CustomerRow[] {
  const t = typed.trim().toLowerCase();
  const hits = t ? rows.filter((c) => c.name.toLowerCase().includes(t) || c.slug.toLowerCase().includes(t)) : rows;
  return customerOrder(hits, (confirmed) => [...confirmed].sort((a, b) => a.name.localeCompare(b.name)));
}

/** The greeting by the reader's own clock once the page is theirs (the same rule as Home). */
function partOfDay(local: boolean): string {
  const now = new Date();
  const h = local ? now.getHours() : now.getUTCHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

const CUSTOMERS_SHOWN = 5;

export function Overview() {
  const why = adminReason("overview");
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const customers = useQuery({ queryKey: adminKeys.customers, queryFn: () => api.get<CustomerRow[]>("/api/v1/admin/customers", why) });
  const alerts = useQuery({ queryKey: adminKeys.alerts, queryFn: () => api.get<AlertRow[]>("/api/v1/admin/alerts", why) });
  const failures = useQuery({ queryKey: adminKeys.failures, queryFn: () => api.get<FailuresDto>("/api/v1/admin/failures", why) });
  const privacy = useQuery({ queryKey: adminKeys.privacy, queryFn: () => api.get<DataRequest[]>("/api/v1/admin/data-requests", why) });
  const failedEmail = useQuery({ queryKey: adminKeys.failedEmailApplications, queryFn: () => api.get<Array<{ id: string }>>("/api/v1/admin/failed-email-applications", why) });
  const csp = useQuery({ queryKey: adminKeys.csp, queryFn: () => api.get<CspDto>("/api/v1/admin/csp-reports", why) });
  // The recruiter queue's own list: `overdue` is worked out on business time by the API. Each read of it is recorded per
  // customer (as the queue list), so Overview keeps an answer for two minutes instead of reading it again on every visit.
  const escalations = useQuery({ queryKey: ["escalations"], queryFn: () => api.get<EscalationPreview[]>("/api/v1/escalations"), staleTime: 120_000 });
  const calendar = useQuery({ queryKey: adminKeys.calendar, queryFn: () => api.get<CalendarDto>("/api/v1/admin/calendar", why) });
  const queue = useQuery({ queryKey: adminKeys.queue, queryFn: () => api.get<QueueDto>("/api/v1/admin/queue", why), refetchInterval: 30_000 });
  // "This month" starts on the 1st in the business calendar's time zone; the costs wait for the calendar's answer.
  const since = monthStart(calendar.data?.current.timeZone);
  const costs = useQuery({ queryKey: costsSinceKey(since),queryFn: () => api.get<CostRow[]>(`/api/v1/admin/costs?since=${since}`, why), enabled: !calendar.isLoading });
  const isClient = useIsClient();

  const sources = [
    { key: "customers", thing: "the companies waiting for the ITS check", q: customers },
    { key: "alerts", thing: "alerts", q: alerts },
    { key: "privacy", thing: "privacy requests", q: privacy },
    { key: "failures", thing: "failed work", q: failures },
    { key: "csp", thing: "security reports", q: csp },
    { key: "email", thing: "email applications", q: failedEmail },
    { key: "escalations", thing: "recruiter requests", q: escalations },
  ].map(({ key, thing, q }) => ({ key, thing, loading: q.data === undefined && !q.error, failed: q.data === undefined && !!q.error, retry: () => void q.refetch() }));
  const rows = attentionRows({ customers: customers.data, alerts: alerts.data, failures: failures.data, privacy: privacy.data, failedEmail: failedEmail.data, csp: csp.data, escalations: escalations.data });
  const loading = sources.filter((s) => s.loading);
  const failed = sources.filter((s) => s.failed);
  const settled = loading.length === 0;
  const first = firstName(me.data?.user.name);

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="ITS · Console"
        title={`Good ${partOfDay(isClient)}${first ? `, ${first}` : ""}.`}
        sub={settled ? (rows.length ? `${count(rows.length, "thing needs", "things need")} you.` : failed.length ? "Some things could not be checked." : "Nothing needs you right now.") : undefined}
        actions={<Link to="/recruiter/queue" className="btn secondary">Open the recruiter queue</Link>}
      />

      <div className="stack gap-6">
        {/*
          Screenshot 7's row of stat cards, from figures this page already shows (the count beside "Needs attention", the
          customers, the companies waiting for the ITS check); a figure still loading shows a quiet bar, one that could not
          be read is left out. The last, tinted cell is the console's rule, moved up from the foot of the page.
        */}
        <StatStrip label="At a glance">
          <StatCell icon="alert" tone={settled && !rows.length ? "lavender" : "peach"} label="Needs attention" value={settled ? rows.length : PENDING} />
          {customers.data || !customers.error ? (
            <>
              <StatCell icon="building" label="Customers" value={customers.data ? customers.data.length : PENDING} />
              <StatCell icon="clock" label="Waiting for the ITS check" value={customers.data ? waitingCustomers(customers.data).length : PENDING} />
            </>
          ) : null}
          <StatCell icon="shield" tone="plum" highlight label="Every read in the console is recorded with a reason." value={null} />
        </StatStrip>

        {/* The wide list (screenshot 7): a header strip, then the kit's rows, edge to edge, each with its one button. */}
        <Card title={settled ? `Needs attention (${rows.length})` : "Needs attention"} className={LIST_CARD}>
          {loading.length === sources.length ? (
            <div className="px-5 py-5 sm:px-6">
              <Skeleton lines={3} />
            </div>
          ) : (
            <ul>
              {rows.map((r, i) => (
                <li key={r.key} className={ROW} style={enterDelay(i)}>
                  <span className="list-row-lead"><IconChip icon={r.urgent ? "alert" : "info"} tone={r.urgent ? "peach" : "lavender"} size="sm" /></span>
                  <span className="list-row-main">
                    <span className={ROW_TITLE}>{r.text}</span>
                    {r.sub ? <span className="list-row-meta">{r.sub}</span> : null}
                  </span>
                  <span className="list-row-end">
                    <Link to={r.action.href} className="btn secondary sm" aria-label={`${r.action.label}: ${r.text}`}>{r.action.label}</Link>
                  </span>
                </li>
              ))}
              {failed.map((s, i) => (
                <li key={`failed-${s.key}`} className={ROW} style={enterDelay(rows.length + i)}>
                  <span className="list-row-lead"><IconChip icon="alert" tone="peach" size="sm" /></span>
                  <span className="list-row-main">
                    <span className={ROW_TITLE}>{`Could not check ${s.thing}.`}</span>
                  </span>
                  <span className="list-row-end">
                    <Button size="sm" onClick={s.retry} ariaLabel={`Try again: ${s.thing}`}>Try again</Button>
                  </span>
                </li>
              ))}
              {loading.length ? (
                <li className={ROW}>
                  <span className="list-row-lead"><IconChip icon="clock" tone="neutral" size="sm" /></span>
                  <span className="list-row-main">
                    <span className="list-row-meta">{`Still checking ${someNames(loading.map((s) => s.thing))}…`}</span>
                  </span>
                </li>
              ) : null}
              {settled && !rows.length && !failed.length ? (
                <li className={ROW}>
                  <span className="list-row-lead"><IconChip icon="check-circle" tone="good" size="sm" /></span>
                  <span className="list-row-main">
                    <span className={ROW_TITLE}>Nothing needs you right now.</span>
                    <span className="list-row-meta">Everything below is up to date.</span>
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </Card>

        {/* Customers beside this month's costs (the "at a glance" side card); one column on a phone or a tablet. */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <CustomersCard rows={customers.data} error={!!customers.error} retry={() => void customers.refetch()} />
          <CostsCard rows={costs.data} error={!!costs.error && !costs.data} retry={() => void costs.refetch()} since={since} names={new Map((customers.data ?? []).map((c) => [c.id, c.name]))} />
        </div>

        {/* The system in one muted line, as the page's footer. */}
        <div className="mt-2 border-t border-line pt-5">
          <SystemLine queue={queue.data} queueFailed={!queue.data && !!queue.error} retryQueue={() => void queue.refetch()} calendar={calendar.data} calendarFailed={!calendar.data && !!calendar.error} retryCalendar={() => void calendar.refetch()} />
        </div>
      </div>
    </div>
  );
}

/** A card whose rows run edge to edge under a header strip (the kit's card title, given room and a line under it). */
const LIST_CARD = "overflow-hidden p-0 [&>.card-title]:m-0 [&>.card-title]:items-center [&>.card-title]:border-b [&>.card-title]:border-line [&>.card-title]:px-5 [&>.card-title]:py-4 sm:[&>.card-title]:px-6";
/** One row of the list card: the kit's row (icon chip, words, the row's one button), its sides in line with the header strip. */
const ROW = "list-row px-5 sm:px-6 motion-safe:animate-enter";
/** A row's title: the kit's (15 px semibold), wrapping instead of cut short, so a sentence or a name is whole on a phone. */
const ROW_TITLE = "list-row-title whitespace-normal [overflow-wrap:anywhere]";

/** A stat cell's figure while it is being read: a quiet bar, so no 0 shows before the answer. */
const PENDING = <span className="skeleton my-1 h-6 w-12" aria-hidden="true" />;

/** Rows arrive one after another, 30 ms apart, the ninth and later with the eighth. */
const enterDelay = (i: number): CSSProperties => ({ animationDelay: `${Math.min(i, 7) * 30}ms` });

/** "See all costs", with an arrow that nudges toward it; the whole line, arrow included, follows the link (40 px under a finger). */
function MoreLink({ to, children }: { to: string; children: string }) {
  return (
    <p className="text-link relative mt-4 w-fit pointer-coarse:min-h-10 [&>a]:after:absolute [&>a]:after:inset-0">
      <Link to={to} className="console-more">{children}</Link>
      <Icon name="arrow-right" size={16} />
    </p>
  );
}

/** Any customer's drawer one "Open" away: the first five matches, waiting companies first (B7), and the full list one link away. */
function CustomersCard({ rows, error, retry }: { rows: CustomerRow[] | undefined; error: boolean; retry: () => void }) {
  const [typed, setTyped] = useState("");
  const matches = rows ? customerMatches(rows, typed) : [];
  const seeAll = typed.trim() ? `/admin/customers?q=${encodeURIComponent(typed.trim())}` : "/admin/customers";
  return (
    <Card title={rows ? `Customers (${rows.length})` : "Customers"}>
      {!rows ? (
        error ? <ErrorState message="Could not load customers." onRetry={retry} /> : <Skeleton lines={4} />
      ) : (
        <>
          {rows.length ? (
            <div className="relative [&>input]:rounded-full [&>input]:pl-10">
              <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3" />
              <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search customers" aria-label="Search customers" />
            </div>
          ) : null}
          {/* the businesses as an inset box of the kit's rows inside the card (screenshot 7) */}
          <ul className="mt-3 overflow-hidden rounded-xl border border-line">
            {matches.slice(0, CUSTOMERS_SHOWN).map((c) => (
              <li key={c.id} className="list-row">
                <span className="list-row-lead"><Avatar name={c.name} shape="square" /></span>
                <span className="list-row-main">
                  <span className={ROW_TITLE}>{c.name}</span>
                  <span className="list-row-meta">{customerLine(c)}</span>
                </span>
                <span className="list-row-end">
                  {c.verifiedAt
                    ? <Link to={`/admin/customers?open=${encodeURIComponent(c.id)}`} className="btn secondary sm" aria-label={`Open ${c.name}`}>Open</Link>
                    : <Link to={`/admin/customers?open=${encodeURIComponent(c.id)}&tab=check`} className="btn secondary sm" aria-label={`Review ${c.name}`}>Review</Link>}
                </span>
              </li>
            ))}
            {!rows.length ? <li className="px-4 py-5 text-sm text-ink-3">No customers yet.</li> : !matches.length ? <li className="px-4 py-5 text-sm text-ink-3">{`No customer matches “${typed.trim()}”.`}</li> : null}
          </ul>
          {rows.length ? <MoreLink to={seeAll}>{typed.trim() ? "See every match in Customers" : `See all ${rows.length} customers`}</MoreLink> : null}
        </>
      )}
    </Card>
  );
}

/** The month's AI spend (one figure: founder answer F4) and the three customers who spent most: the "at a glance" side card. */
function CostsCard({ rows, error, retry, since, names }: { rows: CostRow[] | undefined; error: boolean; retry: () => void; since: string; names: ReadonlyMap<string, string> }) {
  const sum = rows ? costSummary(rows, names) : null;
  const from = new Date(`${since}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <Card title="Costs this month">
      {!sum ? (
        error ? <ErrorState message="Could not load costs." onRetry={retry} /> : <Skeleton lines={4} />
      ) : (
        <>
          {/* the big figure: its paragraph takes the display face, size and colour from this box */}
          <div className="font-display text-[40px] leading-none font-bold tracking-[-0.03em] text-ink tabular-nums">
            <p className="console-figure">{money(sum.total)}</p>
          </div>
          <p className="mt-2 text-[13px] text-ink-3">{`AI spend since ${from}, at list prices`}</p>
          {sum.top.length ? (
            <ul className="mt-4 divide-y divide-line border-y border-line" aria-label="Customers who spent most this month">
              {sum.top.map((t) => (
                <li key={t.companyId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{t.name}</span>
                  <span className="shrink-0 font-semibold text-ink tabular-nums">{money(t.usd)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">No customer has spent anything on AI this month.</p>
          )}
          <MoreLink to="/admin/system?view=costs">See all costs</MoreLink>
        </>
      )}
    </Card>
  );
}

/** One line on the system: jobs waiting and failed, workflow runs waiting, and the business calendar version in force. */
function SystemLine(props: { queue: QueueDto | undefined; queueFailed: boolean; retryQueue: () => void; calendar: CalendarDto | undefined; calendarFailed: boolean; retryCalendar: () => void }) {
  const { queue, calendar } = props;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2 [&_strong]:text-ink">
      <strong>System:</strong>
      {queue ? <span>{`${count(queue.queued, "job", "jobs")} waiting · ${queue.failed} failed · ${count(queue.waitingRuns, "workflow run", "workflow runs")} waiting`}</span> : props.queueFailed ? <><span>Could not check the queue.</span><Button size="sm" variant="quiet" onClick={props.retryQueue} ariaLabel="Try again: the queue">Try again</Button></> : <span>checking the queue…</span>}
      <span aria-hidden="true">·</span>
      {calendar ? <span>{calendar.version !== null ? `business calendar version ${calendar.version} in force` : "standard business hours (no calendar version yet)"}</span> : props.calendarFailed ? <><span>Could not check the business calendar.</span><Button size="sm" variant="quiet" onClick={props.retryCalendar} ariaLabel="Try again: the business calendar">Try again</Button></> : <span>checking the calendar…</span>}
      <Link to="/admin/system?view=queue" className="text-link text-[13px] pointer-coarse:min-h-10 sm:ml-auto">System and settings<Icon name="arrow-right" size={16} /></Link>
    </p>
  );
}
