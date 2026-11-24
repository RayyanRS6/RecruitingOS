"use client";

import { Children, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLAN_REQUEST_ALERT_KIND, type AdminAlert, type AdminFailures, type AdminQueue, type ResolveAlert } from "@ros/contracts";
import { Button, Card, Chip, cn, ErrorState, Icon, IconChip, IconLabel, type IconName, Skeleton } from "@ros/ui";
import { api, errorWords, type Me } from "../../api/client";
import { toast } from "../../toast";
import { adminKeys, reason } from "./admin-api";
import { aiStatusWords, codeWords, exactWhen, firstUpper, plainCode, severityWords, whenWords, workflowWords } from "./admin-words";

/*
 * System, Health: the alerts that need a person (Acknowledge, Resolve), the work that failed (a failed workflow run
 * can be retried; a failed background task or AI run is listed) and the queue's figures. One read for the alerts and
 * the failed work (GET /admin/failures, every 15 seconds), one for the queue (GET /admin/queue, every 5).
 */

/** What a part says when it has nothing in it: one word under the part's heading. */
export const NONE = "None.";

/**
 * An alert this administrator may not acknowledge: one about a platform role they changed, or one that concerns them,
 * is for another administrator. The API refuses it (second_person_required), so no button is offered.
 */
export function ackIsForAnother(a: Pick<AdminAlert, "kind" | "details" | "target">, myUserId: string | null | undefined): boolean {
  return !!myUserId && a.kind.startsWith("platform_role.") && (a.details?.actorId === myUserId || a.target?.id === myUserId);
}
export const ACK_FOR_ANOTHER = "Another administrator acknowledges this one, because it is about a platform role you changed or one that concerns you.";

/**
 * Notices about a company's plan: its AI interviews or AI credit running low or used up, and its request to change
 * plan. They are on the company's own page (its usage lines, "Asked to upgrade"), and the request closes when the plan
 * is changed, so they do not count as alerts that need a person.
 */
export const PLAN_NOTICE_KINDS: ReadonlySet<string> = new Set(["billing.screens_warning", "billing.screens_used_up", "billing.ai_credit_warning", "billing.ai_credit_used_up", PLAN_REQUEST_ALERT_KIND]);

/** An alert that waits for a person: open, and not a notice about a company's plan. */
export function needsAPerson(a: Pick<AdminAlert, "status" | "kind">): boolean {
  return a.status === "open" && !PLAN_NOTICE_KINDS.has(a.kind);
}

/** What Resolve says: the alert is closed for good, and the problem raises a new one if it comes back. */
export const RESOLVED_TOAST = { title: "Resolved.", detail: "If it happens again, a new alert is raised." };

/** The chip tone for an alert's severity: urgent in red, for your information in grey, the rest amber. */
function severityTone(severity: string): "critical" | "caution" | "neutral" {
  return severity === "critical" ? "critical" : severity === "info" ? "neutral" : "caution";
}

const timesWord = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

function useFailures() {
  return useQuery({ queryKey: adminKeys.failures, queryFn: () => api.get<AdminFailures>("/api/v1/admin/failures", reason), refetchInterval: 15000 });
}

/** A part's rows inside its card: edge to edge across the card, a hairline over the first and between each. */
const LIST = "-mx-6 divide-y divide-line border-t border-line max-sm:-mx-4";
/**
 * A row's first appearance: it rises in 30ms after the one above it (the eighth and later together; off for reduced
 * motion). The delay carries motion-safe: too, so it comes after the `animation` shorthand, which would reset it.
 */
const ENTER = "motion-safe:animate-enter motion-safe:[animation-delay:calc(var(--i)*30ms)]";
const stagger = (i: number) => ({ "--i": Math.min(i, 7) }) as CSSProperties;

/** A date as the dashboard reads it ("today", "3 days ago", "Oct 3"), the exact time on hover. */
function When({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  return <time dateTime={at} title={exactWhen(at)}>{whenWords(at)}</time>;
}

/**
 * A problem's words, split for the eye: its first sentence is read at a glance, and the rest (a provider's own message,
 * the reason, what to check) waits under "Details". Nothing is cut: both halves are always in the page.
 */
export function leadAndRest(body: string | null | undefined): { lead: string; rest: string } {
  const words = (body ?? "").trim();
  const first = /^(.{20,}?[.!?])\s+(?=\S)/s.exec(words);
  return first ? { lead: first[1], rest: words.slice(first[0].length) } : { lead: words, rest: "" };
}

type ProblemTone = "critical" | "caution" | "neutral";

/**
 * One problem, read top to bottom: a mark in the colour of how urgent it is, its title, one quiet line (the word for
 * how urgent or what kind, and when), one sentence, and the rest under "Details". Its buttons sit beside the title on a
 * wide screen and under the words on a narrow one. The mark is decoration: the word beside the date says the same.
 */
function ProblemRow(props: { tone?: ProblemTone; icon?: IconName; tag?: ReactNode; title: ReactNode; at?: string | null; body?: string | null; detail?: ReactNode; children?: ReactNode; index?: number }) {
  const { lead, rest } = leadAndRest(props.body);
  return (
    <li className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3.5 gap-y-3 px-6 py-4 max-sm:px-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${ENTER}`} style={stagger(props.index ?? 0)}>
      <IconChip icon={props.icon ?? "alert"} tone={props.tone ?? "neutral"} size="sm" />
      <div className="grid min-w-0 gap-0.5">
        <strong className="text-[15px] leading-snug text-ink wrap-anywhere">{props.title}</strong>
        {props.tag || props.at ? (
          <p className="small muted flex flex-wrap items-center gap-x-1.5">
            {props.tag ? <span>{props.tag}</span> : null}
            {props.tag && props.at ? <span aria-hidden="true">·</span> : null}
            <When at={props.at} />
          </p>
        ) : null}
        {lead ? <p className="mt-1.5 max-w-[72ch] text-[14px] text-ink-2 wrap-anywhere">{lead}</p> : null}
        {props.detail ? <p className="small muted mt-1 max-w-[72ch] wrap-anywhere">{props.detail}</p> : null}
        {rest ? (
          <details className="more mt-1.5">
            {/* the button says what a press does: "Show details", then "Hide details" (the kit shows one of the two) */}
            <summary><span className="if-closed">Show details</span><span className="if-open">Hide details</span></summary>
            <p className="small max-w-[72ch] rounded-xl bg-surface-2 px-3.5 py-3 text-ink-2 wrap-anywhere">{rest}</p>
          </details>
        ) : null}
      </div>
      {Children.toArray(props.children).length ? <div className="col-start-2 grid gap-2 sm:col-start-3 sm:row-start-1 sm:justify-items-end">{props.children}</div> : null}
    </li>
  );
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

/** Alerts that need a person: Acknowledge (unless it is for another administrator) and Resolve. The acknowledged ones and the plan notices are folded under them. */
function Alerts({ alerts }: { alerts: AdminAlert[] }) {
  const qc = useQueryClient();
  // Who is signed in: an alert about their own platform role change is acknowledged by another administrator.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/acknowledge`, {}, reason), onSuccess: () => { toast("Acknowledged."); qc.invalidateQueries({ queryKey: adminKeys.failures }); }, onError: (e) => toast(errorWords(e, "Could not acknowledge the alert. Try again in a moment.")) });
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/resolve`, {} satisfies ResolveAlert, reason), onSuccess: () => { toast(RESOLVED_TOAST.title, RESOLVED_TOAST.detail); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: adminKeys.companies }); }, onError: (e) => toast(errorWords(e, "Could not resolve the alert. Try again in a moment.")) });
  const needing = alerts.filter(needsAPerson);
  const others = alerts.filter((a) => !needsAPerson(a));
  const row = (a: AdminAlert, i: number) => (
    <ProblemRow
      key={a.id}
      index={i}
      tone={severityTone(a.severity)}
      tag={severityWords(a.severity)}
      title={a.title}
      at={a.createdAt}
      body={a.body}
      // who acknowledges it is said under the alert's own words, where it is read, not squeezed beside the title
      detail={ackIsForAnother(a, me.data?.user.id) && a.status === "open" ? ACK_FOR_ANOTHER : undefined}
    >
      {a.status === "acknowledged" || !ackIsForAnother(a, me.data?.user.id) ? (
        <div className="row">
          {a.status === "acknowledged" ? <Chip tone="neutral">Acknowledged</Chip> : null}
          {ackIsForAnother(a, me.data?.user.id) ? null : (
            <>
              {a.status === "open" ? <Button size="sm" variant="secondary" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>Acknowledge</Button> : null}
              <Button size="sm" variant="quiet" loading={resolve.isPending && resolve.variables === a.id} onClick={() => resolve.mutate(a.id)}>Resolve</Button>
            </>
          )}
        </div>
      ) : null}
    </ProblemRow>
  );
  return (
    <Card title={`Alerts that need a person (${needing.length})`}>
      {needing.length ? <ul className={LIST}>{needing.map(row)}</ul> : <Empty />}
      {others.length ? (
        <details className="more mt-5">
          <summary>{`Acknowledged and plan notices (${others.length})`}</summary>
          <ul className={LIST}>{others.map(row)}</ul>
        </details>
      ) : null}
    </Card>
  );
}

/** Failed workflow runs (each with Retry, which puts it back in the queue), background tasks that failed, and AI runs that were not OK. */
function FailedWork({ failures }: { failures: AdminFailures }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason),
    onSuccess: () => { toast("Retried. The run is back in the queue."); qc.invalidateQueries({ queryKey: adminKeys.failures }); qc.invalidateQueries({ queryKey: adminKeys.queue }); },
    onError: (e) => toast(errorWords(e, "Could not retry the run. Try again in a moment.")),
  });
  const { failedRuns, failedJobs, failedAi } = failures;
  if (!failedRuns.length && !failedJobs.length && !failedAi.length) return <Card title="Failed work (0)"><Empty /></Card>;
  return (
    <>
      {failedRuns.length ? (
        <Card title={`Failed workflow runs (${failedRuns.length})`}>
          <ul className={LIST}>
            {failedRuns.map((r, i) => (
              <ProblemRow key={r.id} index={i} tone="critical" icon="refresh" tag="Failed" title={workflowWords(r.workflowKey)} at={r.updatedAt} detail={[r.currentStep ? `Step: ${plainCode(r.currentStep)}` : null, r.attempts ? `Tried ${timesWord(r.attempts)}` : null, r.lastError ? r.lastError.slice(0, 160) : null].filter(Boolean).join(" · ")}>
                <div className="row">
                  <Button size="sm" variant="secondary" ariaLabel={`Retry: ${workflowWords(r.workflowKey)}`} loading={retry.isPending && retry.variables === r.id} onClick={() => retry.mutate(r.id)}>Retry</Button>
                </div>
              </ProblemRow>
            ))}
          </ul>
        </Card>
      ) : null}
      {failedJobs.length ? (
        <Card title={`Background tasks that failed (${failedJobs.length})`}>
          <ul className={LIST}>
            {failedJobs.map((j, i) => <ProblemRow key={j.id} index={i} tone="caution" icon="activity" title={firstUpper(plainCode(j.kind))} at={j.createdAt} detail={[j.attempts ? `Tried ${timesWord(j.attempts)}` : null, j.lastError].filter(Boolean).join(" · ")} />)}
          </ul>
        </Card>
      ) : null}
      {failedAi.length ? (
        <Card title={`AI runs that were not OK (${failedAi.length})`}>
          <ul className={LIST}>
            {failedAi.map((a, i) => <ProblemRow key={a.id} index={i} tone="caution" icon="sparkle" tag={aiStatusWords(a.status)} title={codeWords(a.task)} at={a.createdAt} detail={[a.model, a.error].filter(Boolean).join(" · ")} />)}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

/**
 * One figure of the queue: the kit's stat cell, its label and number kept a dt and its dd. The pair sits straight in
 * the cell (a dl allows one div between it and its dt/dd, never two), so the cell itself stacks them.
 */
function Figure(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="stat-cell flex-col items-start justify-center gap-0.5">
      <dt className="stat-cell-label">{props.label}</dt>
      <dd className={cn("stat-cell-value", props.className)}>{props.children}</dd>
    </div>
  );
}

/** The queue: work waiting to run, the oldest of it, what failed, and the workflow runs waiting. */
export function Queue() {
  const q = useQuery({ queryKey: adminKeys.queue, queryFn: () => api.get<AdminQueue>("/api/v1/admin/queue", reason), refetchInterval: 5000 });
  // A failed load says so instead of loading for ever; a failed refresh keeps the last figures on screen.
  if (!q.data) return q.error ? <ErrorState message="Could not load the queue." onRetry={() => q.refetch()} /> : <Skeleton lines={3} />;
  return (
    // that the figures are live is said by the mark beside the title (its words are its name and tooltip)
    <Card title="Queue" aside={<IconLabel icon="activity" label="These figures refresh every 5 seconds." />}>
      <dl className="stat-strip mb-4">
        <Figure label="Jobs waiting to run">{q.data.queued}</Figure>
        <Figure label="Oldest waiting job" className="font-sans text-[15px] font-semibold tracking-normal">{q.data.oldestQueuedAt ? exactWhen(q.data.oldestQueuedAt) : "none"}</Figure>
        <Figure label="Jobs that failed" className={q.data.failed > 0 ? "text-critical" : undefined}>{q.data.failed}</Figure>
        <Figure label="Workflow runs waiting">{q.data.waitingRuns}</Figure>
      </dl>
      <details className="more">
        <summary>Workflows the system can run ({q.data.definitions.length})</summary>
        <ul className="list-disc space-y-1 pl-5 text-[14px] marker:text-ink-3">
          {q.data.definitions.map((d) => <li key={d}>{workflowWords(d)} <span className="small muted">({d})</span></li>)}
        </ul>
      </details>
    </Card>
  );
}

/** The Health part: alerts first, then the work that failed, then the queue. */
export function Health() {
  const q = useFailures();
  return (
    <div className="stack gap-5">
      {q.isLoading ? <Skeleton lines={4} /> : q.error || !q.data ? <ErrorState message="Could not load the alerts and the failed work." onRetry={() => q.refetch()} /> : (
        <>
          <Alerts alerts={q.data.alerts} />
          <FailedWork failures={q.data} />
        </>
      )}
      <Queue />
    </div>
  );
}
