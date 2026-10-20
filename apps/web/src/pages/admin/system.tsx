"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, Drawer, ErrorState, Field, Menu, numHead, Segmented, Skeleton, Table, Tabs, Timeline, useTableSort } from "@ros/ui";
import { api, ApiError } from "../../api/client";
import { toast } from "../../toast";
import { dayKey } from "../candidate-panel/helpers";
import { adminKeys, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { aiStatusWords, exactMoney, exactWhen, firstUpper, money, runStatusWords, STEP_STATUS_WORDS, whenWords, wordFor, workflowWords } from "./admin-words";

/*
 * The console's System and settings section (redesign spec 3.2, Wave S6 slice S6-E): costs, workflow runs, AI runs,
 * queue health, the business calendar and the administrators. Tables have at most five columns; everything else about a
 * row is in its drawer. Codes read as words (admin-words.ts); the exact figures and times stay in tooltips and drawers.
 */

/** "intake.turn" or "screen_invited" -> "Intake turn", "Screen invited": a code with dots, readable. */
const codeWords = (code: string | null | undefined) => (code ? firstUpper(code.replace(/[._]/g, " ").replace(/\s+/g, " ").trim()) : "");

/** A run's status as a chip tone. */
const runTone = (s: string) => (s === "failed" ? "critical" : s === "waiting" ? "caution" : s === "completed" ? "good" : "accent");

/** JSON for the folded "raw" parts of a drawer: wrapped, never scrolling the page sideways. */
function Raw(props: { value: unknown }) {
  return <pre className="small" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(props.value, null, 2)}</pre>;
}

/** One plain part of a drawer: a small heading over its content. */
function DrawerPart(props: { title: string; children: ReactNode }) {
  return (
    <section className="stack" style={{ gap: 8 }}>
      <h3 className="eyebrow">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** A customer's name from the customers list the console already reads (no API change); an unknown id reads as a short id. */
function useCustomerNames(): (companyId: string | null) => string {
  const q = useQuery({ queryKey: adminKeys.customers, queryFn: () => api.get<Array<{ id: string; name: string }>>("/api/v1/admin/customers", reason) });
  const names = new Map((q.data ?? []).map((c) => [c.id, c.name]));
  return (companyId) => (companyId ? (names.get(companyId) ?? `Customer ${companyId.slice(0, 8)}`) : "ITS platform");
}

/** "3:10 PM" for something that happened today, else "yesterday", "3 days ago", "Oct 3". */
function whenShort(iso: string): string {
  const words = whenWords(iso);
  if (words !== "today") return words;
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Workflows                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

type RunWait = { kind: string; until?: string; reason?: string };
/** A workflow run as GET /admin/runs lists it (the latest 200, newest change first). */
export type RunRow = { id: string; companyId: string | null; workflowKey: string; status: string; currentStep: string; wait: RunWait | null; attempts: number; lastError: string | null; updatedAt: string; subject: { type: string; id: string } };
type RunDetail = {
  run: RunRow & { state: Record<string, unknown>; startedAt?: string; completedAt?: string | null };
  steps: Array<{ seq: number; stepKey: string; status: string; error: string | null; output: Record<string, unknown>; startedAt: string }>;
  aiRuns: Array<{ id: string; task: string; model: string; promptKey: string; promptVersion: number; status: string; inputTokens: number; outputTokens: number; costUsd: string; latencyMs: number; structuredOutput: Record<string, unknown> | null; error: string | null }>;
  events: Array<{ type: string; occurredAt: string; actor: { kind: string; id: string; name?: string }; payload: Record<string, unknown> }>;
};

/** The figure GET /admin/runs stops at: counts made from its answer are "of the latest 200". */
export const RUNS_READ_LIMIT = 200;

/** The status pills over the runs: the same filter values as before; `completed` reads "Done". */
const RUN_FILTERS = [
  { id: "", label: "All" },
  { id: "running", label: runStatusWords("running") },
  { id: "waiting", label: runStatusWords("waiting") },
  { id: "failed", label: runStatusWords("failed") },
  { id: "completed", label: runStatusWords("completed") },
] as const;

const runsUrl = (show: string) => `/api/v1/admin/runs${show ? `?status=${show}` : ""}`;

/** What a waiting run waits on, in words: "Timer until Oct 14, 2026, 3:10 PM (retry 2/5)". */
function waitWords(wait: RunWait | null): string {
  if (!wait) return "";
  return `${codeWords(wait.kind)}${wait.until ? ` until ${exactWhen(wait.until)}` : ""}${wait.reason ? ` (${wait.reason})` : ""}`;
}

/** Retry puts a failed run back in the queue (POST /admin/runs/:id/retry), from the list or from its drawer. */
function useRetryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason),
    // Problems › Failed work and Overview list failed runs from GET /admin/failures, so that answer is read again too.
    onSuccess: () => { toast("Retried. The run is back in the queue."); qc.invalidateQueries({ queryKey: ["admin", "runs"] }); qc.invalidateQueries({ queryKey: ["admin", "run"] }); qc.invalidateQueries({ queryKey: adminKeys.failures }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the run. Try again in a moment."),
  });
}

// The parts are exported for SystemSection, Problems (RunDrawer) and the server-render tests (apps/shell/components/admin-system-ui.test.ts).
/** `initialShow`: the status pill the list opens on (All unless given). */
export function Runs({ initialShow = "" }: { initialShow?: string }) {
  const [show, setShow] = useState<string>(initialShow);
  const [opened, setOpened] = useState<RunRow | null>(null);
  // the counts come from the unfiltered read; the list for a pill is read for that status, as before
  const all = useQuery({ queryKey: adminKeys.runs(""), queryFn: () => api.get<RunRow[]>(runsUrl(""), reason) });
  const q = useQuery({ queryKey: adminKeys.runs(show), queryFn: () => api.get<RunRow[]>(runsUrl(show), reason) });
  const retry = useRetryRun();
  const count = (id: string) => (all.data ? (id ? all.data.filter((r) => r.status === id).length : all.data.length) : undefined);
  return (
    <div className="stack">
      <div className="talent-toolbar">
        <fieldset aria-label="Show runs" className="row" style={{ gap: 6, flexWrap: "wrap", border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {RUN_FILTERS.map((f) => {
            const n = count(f.id);
            return (
              <button key={f.id || "all"} type="button" className="toggle-chip" aria-pressed={show === f.id} onClick={() => setShow(f.id)}>
                {f.label}
                {n !== undefined ? <>{" "}<span className="count">{n}</span></> : null}
              </button>
            );
          })}
        </fieldset>
        {all.data && all.data.length >= RUNS_READ_LIMIT ? <span className="small muted">Counts are of the latest {RUNS_READ_LIMIT} runs.</span> : null}
      </div>
      {q.error ? <ErrorState message="Could not load runs." onRetry={() => q.refetch()} /> : (
        <Table
          head={["Workflow", "Status", "Step", "Updated", ""]}
          scroll
          loading={q.data ? undefined : 4}
          empty={show ? (
            <span className="row" style={{ justifyContent: "space-between", gap: 10 }}>
              <span>No runs with this status.</span>
              <Button size="sm" variant="secondary" onClick={() => setShow("")}>Show all runs</Button>
            </span>
          ) : "No workflow runs yet."}
        >
          {(q.data ?? []).map((r) => (
            <tr key={r.id}>
              <td><button type="button" className="btn quiet sm" onClick={() => setOpened(r)}>{workflowWords(r.workflowKey)}</button></td>
              <td><Chip tone={runTone(r.status)}>{runStatusWords(r.status)}</Chip></td>
              <td>{codeWords(r.currentStep)}</td>
              <td><span title={exactWhen(r.updatedAt)}>{whenShort(r.updatedAt)}</span></td>
              <td>{r.status === "failed" ? <Button size="sm" loading={retry.isPending && retry.variables === r.id} onClick={() => retry.mutate(r.id)}>Retry</Button> : null}</td>
            </tr>
          ))}
        </Table>
      )}
      {opened ? <RunDrawer row={opened} onClose={() => setOpened(null)} /> : null}
    </div>
  );
}

/**
 * One workflow run in plain parts (it answers the six questions for any run: what the AI saw, concluded, why, which
 * policy, what the human did, what happened): the facts that left the table, "What happened" (its steps), "AI calls"
 * (one line each, details folded), "Who did what" (its history) and, folded at the bottom, the raw state.
 */
export function RunDrawer(props: { row: RunRow; onClose: () => void }) {
  const { row } = props;
  const q = useQuery({ queryKey: adminKeys.run(row.id), queryFn: () => api.get<RunDetail>(`/api/v1/admin/runs/${row.id}`, reason) });
  const retry = useRetryRun();
  const customerName = useCustomerNames();
  const run = q.data ? { ...row, ...q.data.run } : row;
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={workflowWords(run.workflowKey)}
      sub={`${runStatusWords(run.status)} · step: ${codeWords(run.currentStep)} · updated ${exactWhen(run.updatedAt)}`}
      actions={run.status === "failed" ? <Button size="sm" variant="primary" loading={retry.isPending} onClick={() => retry.mutate(run.id)}>Retry</Button> : null}
    >
      <div className="stack" style={{ gap: 20 }}>
        <dl className="kv">
          <dt>Customer</dt><dd>{customerName(run.companyId)}</dd>
          <dt>About</dt><dd>{codeWords(run.subject.type)} <span className="small muted">{run.subject.id.slice(0, 8)}</span></dd>
          <dt>Status</dt><dd><Chip tone={runTone(run.status)}>{runStatusWords(run.status)}</Chip></dd>
          {run.wait ? <><dt>Waiting on</dt><dd>{waitWords(run.wait)}</dd></> : null}
          <dt>Attempts</dt><dd>{run.attempts}</dd>
          {run.lastError ? <><dt>Error</dt><dd style={{ color: "var(--critical)", overflowWrap: "anywhere" }}>{run.lastError}</dd></> : null}
          <dt>Workflow</dt><dd className="small muted">{run.workflowKey}</dd>
        </dl>
        {q.error ? <ErrorState message="Could not load this run." onRetry={() => q.refetch()} /> : !q.data ? <Skeleton lines={6} /> : (
          <>
            <DrawerPart title="What happened">
              {q.data.steps.length === 0 ? <p className="muted">No steps yet.</p> : (
                <Timeline items={q.data.steps.map((s) => ({ when: s.startedAt, what: `${codeWords(s.stepKey)}: ${wordFor(STEP_STATUS_WORDS, s.status).toLowerCase()}${s.error ? ` (${s.error})` : ""}` }))} />
              )}
            </DrawerPart>
            <DrawerPart title="AI calls">
              {q.data.aiRuns.length === 0 ? <p className="muted small">No model calls in this run.</p> : q.data.aiRuns.map((a) => (
                <details key={a.id} className="more">
                  <summary>{codeWords(a.task)} · {a.model} · {aiStatusWords(a.status)} · {money(Number(a.costUsd))}</summary>
                  <dl className="kv">
                    <dt>Prompt</dt><dd>{a.promptKey}, version {a.promptVersion}</dd>
                    <dt>Tokens</dt><dd>{a.inputTokens} in · {a.outputTokens} out</dd>
                    <dt>Cost</dt><dd>{exactMoney(Number(a.costUsd), 5)}</dd>
                    <dt>Time taken</dt><dd>{a.latencyMs} ms</dd>
                    {a.error ? <><dt>Error</dt><dd style={{ color: "var(--critical)" }}>{a.error}</dd></> : null}
                  </dl>
                  <Raw value={a.structuredOutput} />
                </details>
              ))}
            </DrawerPart>
            <DrawerPart title="Who did what">
              {q.data.events.length === 0 ? <p className="muted small">Nothing recorded yet.</p> : (
                <Timeline items={q.data.events.map((e) => ({ when: e.occurredAt, what: codeWords(e.type), who: e.actor.name ?? `${e.actor.kind} ${e.actor.id.slice(0, 8)}` }))} />
              )}
            </DrawerPart>
            <details className="more">
              <summary>Raw state</summary>
              <div className="stack" style={{ gap: 10 }}>
                <Raw value={q.data.run.state} />
                {q.data.steps.length ? <><h3 className="eyebrow">Step results</h3><Raw value={q.data.steps.map((s) => ({ step: s.stepKey, status: s.status, output: s.output }))} /></> : null}
                {q.data.events.some((e) => Object.keys(e.payload).length) ? <><h3 className="eyebrow">History details</h3><Raw value={q.data.events.map((e) => ({ type: e.type, payload: e.payload }))} /></> : null}
              </div>
            </details>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* AI runs                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** An AI run as GET /admin/ai-runs lists it (the latest 200). */
export type AiRunRow = { id: string; companyId: string | null; agent: string; task: string; model: string; promptKey: string; promptVersion: number; status: string; inputTokens: number; outputTokens: number; costUsd: string; latencyMs: number; confidence: string | null; createdAt: string };
type AiRunDetail = { run: AiRunRow & { structuredOutput: Record<string, unknown> | null; error: string | null; modelVersion?: string | null }; events: RunDetail["events"] };

type AiSort = "when" | "cost" | "latency";
/** Every order the AI runs had before: When and Cost as headings, all three in the Sort chip. */
const AI_SORTS: Array<{ id: AiSort; label: string; kind: "date" | "number" }> = [
  { id: "when", label: "When", kind: "date" },
  { id: "cost", label: "Cost", kind: "number" },
  { id: "latency", label: "Time taken", kind: "number" },
];

export function AiRuns() {
  const q = useQuery({ queryKey: adminKeys.aiRuns, queryFn: () => api.get<AiRunRow[]>("/api/v1/admin/ai-runs", reason) });
  const s = useTableSort<AiSort>({ key: "when", dir: "descending" });
  const [opened, setOpened] = useState<AiRunRow | null>(null);
  if (q.error) return <ErrorState message="Could not load AI runs." onRetry={() => q.refetch()} />;
  const sortedBy = AI_SORTS.find((o) => o.id === s.sort?.key) ?? AI_SORTS[0];
  return (
    <div className="stack">
      <div className="talent-toolbar">
        {/* the visible words are the button's name (WCAG 2.5.3); choosing the order in force keeps it, never flips it */}
        <Menu
          label={`Sort: ${sortedBy.label}`}
          heading="Sort AI runs by"
          items={AI_SORTS.map((o) => ({ id: o.id, label: o.label, current: o.id === sortedBy.id }))}
          onSelect={(id) => {
            const o = AI_SORTS.find((x) => x.id === id);
            if (o) s.choose(o.id, o.label, o.kind);
          }}
        />
      </div>
      <Table head={[s.col("when", "When", "date"), "Task", "Model", "Status", s.col("cost", "Cost", "number", { num: true })]} scroll loading={q.data ? undefined : 4} empty="No AI runs recorded yet." announce={s.announce}>
        {s.apply(q.data ?? [], { when: (r) => Date.parse(r.createdAt), cost: (r) => Number(r.costUsd), latency: (r) => r.latencyMs }).map((r) => (
          <tr key={r.id}>
            <td><span title={exactWhen(r.createdAt)}>{whenShort(r.createdAt)}</span></td>
            <td><button type="button" className="btn quiet sm" onClick={() => setOpened(r)}>{codeWords(r.task)}</button></td>
            <td className="small">{r.model}</td>
            <td><Chip tone={r.status === "ok" ? "good" : "critical"}>{aiStatusWords(r.status)}</Chip></td>
            <td className="num"><span title={exactMoney(Number(r.costUsd), 5)}>{money(Number(r.costUsd))}</span><div className="small muted">{r.latencyMs} ms</div></td>
          </tr>
        ))}
      </Table>
      {opened ? <AiRunDrawer row={opened} onClose={() => setOpened(null)} /> : null}
    </div>
  );
}

/** One AI run: who asked, with which prompt, what it cost and took, how sure it was, and its result (GET /admin/ai-runs/:id). */
export function AiRunDrawer(props: { row: AiRunRow; onClose: () => void }) {
  const { row } = props;
  const q = useQuery({ queryKey: [...adminKeys.aiRuns, row.id], queryFn: () => api.get<AiRunDetail>(`/api/v1/admin/ai-runs/${row.id}`, reason) });
  const customerName = useCustomerNames();
  const run = q.data ? { ...row, ...q.data.run } : row;
  const detail = q.data?.run;
  return (
    <Drawer open onClose={props.onClose} title={codeWords(run.task)} sub={`${aiStatusWords(run.status)} · ${exactWhen(run.createdAt)}`}>
      <div className="stack" style={{ gap: 20 }}>
        <dl className="kv">
          <dt>Customer</dt><dd>{customerName(run.companyId)}</dd>
          <dt>Agent</dt><dd>{codeWords(run.agent)}</dd>
          <dt>Model</dt><dd>{run.model}{detail?.modelVersion ? <span className="small muted"> ({detail.modelVersion})</span> : null}</dd>
          <dt>Prompt</dt><dd>{run.promptKey}, version {run.promptVersion}</dd>
          <dt>Status</dt><dd><Chip tone={run.status === "ok" ? "good" : "critical"}>{aiStatusWords(run.status)}</Chip></dd>
          <dt>Tokens</dt><dd>{run.inputTokens} in · {run.outputTokens} out</dd>
          <dt>Cost</dt><dd>{exactMoney(Number(run.costUsd), 5)}</dd>
          <dt>Time taken</dt><dd>{run.latencyMs} ms</dd>
          <dt>Confidence</dt><dd>{run.confidence ? codeWords(run.confidence) : "Not given"}</dd>
          {detail?.error ? <><dt>Error</dt><dd style={{ color: "var(--critical)", overflowWrap: "anywhere" }}>{detail.error}</dd></> : null}
        </dl>
        {q.error ? <ErrorState message="Could not load this AI run." onRetry={() => q.refetch()} /> : !q.data ? <Skeleton lines={4} /> : (
          <>
            <DrawerPart title="Result">
              {q.data.run.structuredOutput ? <Raw value={q.data.run.structuredOutput} /> : <p className="muted small">No result recorded.</p>}
            </DrawerPart>
            {q.data.events.length ? (
              <DrawerPart title="Who did what">
                <Timeline items={q.data.events.map((e) => ({ when: e.occurredAt, what: codeWords(e.type), who: e.actor.name ?? `${e.actor.kind} ${e.actor.id.slice(0, 8)}` }))} />
              </DrawerPart>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Costs                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One customer, task and model as GET /admin/costs groups the spend. */
type CostRow = { companyId: string | null; task: string; model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number };
type CostPeriod = "month" | "all";

/**
 * The first day of this month in the business calendar's time zone, as GET /admin/costs?since= takes it ("2026-10-01").
 * A zone the browser does not know falls back to the reader's own calendar.
 */
export function monthStartIn(timeZone: string | undefined, now: Date = new Date()): string {
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(now);
    year = Number(parts.find((p) => p.type === "year")?.value ?? year);
    month = Number(parts.find((p) => p.type === "month")?.value ?? month);
  } catch {
    // an unknown zone: the reader's own calendar, read above
  }
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/**
 * The query key of the spend since a date, the same as the Overview's Costs card uses (Overview.tsx), so one answer
 * serves both; the all-time answer keeps the plain key. Both start with adminKeys.costs.
 */
export const costsSinceKey = (since: string) => [...adminKeys.costs, "since", since];

/** `initialPeriod`: the spend the part opens on (this month unless given). */
export function Costs({ initialPeriod = "month" }: { initialPeriod?: CostPeriod }) {
  const [period, setPeriod] = useState<CostPeriod>(initialPeriod);
  // "This month" counts from the 1st in the business calendar's time zone (redesign spec 3.2)
  const calendar = useQuery({ queryKey: adminKeys.calendar, queryFn: () => api.get<CalendarDto>("/api/v1/admin/calendar", reason), enabled: period === "month" });
  const zone = calendar.data?.current.timeZone;
  const since = period === "month" ? (zone ? monthStartIn(zone) : calendar.error ? monthStartIn(undefined) : null) : null;
  const q = useQuery({
    queryKey: period === "all" ? adminKeys.costs : costsSinceKey(since ?? ""),
    queryFn: () => api.get<CostRow[]>(`/api/v1/admin/costs${since ? `?since=${since}` : ""}`, reason),
    enabled: period === "all" || since !== null,
  });
  const customerName = useCustomerNames();
  const rows = q.data ? [...q.data].sort((a, b) => b.costUsd - a.costUsd) : undefined;
  const total = (rows ?? []).reduce((n, r) => n + r.costUsd, 0);
  return (
    <div className="stack">
      <div className="talent-toolbar" style={{ justifyContent: "space-between" }}>
        <Segmented ariaLabel="Which spend" value={period} onChange={setPeriod} options={[{ value: "month", label: "This month" }, { value: "all", label: "All time" }]} />
        {rows ? <p style={{ margin: 0 }}>{period === "month" ? "Spent so far this month" : "Total model spend recorded"}: <strong title={exactMoney(total)}>{money(total)}</strong></p> : null}
      </div>
      <p className="small muted" style={{ margin: 0 }}>At list prices; the fake provider is free.{period === "month" && since ? ` Counted from ${since}.` : ""}</p>
      {q.error ? <ErrorState message="Could not load costs." onRetry={() => q.refetch()} /> : (
        <>
          <Table
            head={["Customer", "Task", "Model", numHead("Runs"), numHead("Cost")]}
            scroll
            loading={rows ? undefined : 4}
            empty={period === "month" ? (
              <span className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                <span>No model spend recorded this month.</span>
                <Button size="sm" variant="secondary" onClick={() => setPeriod("all")}>Show all time</Button>
              </span>
            ) : "No model spend recorded yet."}
          >
            {(rows ?? []).map((r) => (
              <tr key={`${r.companyId ?? "its"}-${r.task}-${r.model}`}>
                <td>{customerName(r.companyId)}</td>
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
              <Table head={["Customer", "Task", "Model", numHead("Tokens in"), numHead("Tokens out")]}>
                {rows.map((r) => (
                  <tr key={`${r.companyId ?? "its"}-${r.task}-${r.model}`}>
                    <td>{customerName(r.companyId)}</td>
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
/* Queue health                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export function Queue() {
  const q = useQuery({ queryKey: adminKeys.queue, queryFn: () => api.get<{ queued: number; failed: number; oldestQueuedAt: string | null; waitingRuns: number; definitions: string[] }>("/api/v1/admin/queue", reason), refetchInterval: 5000 });
  // A failed load says so instead of loading for ever; a failed refresh keeps the last figures on screen.
  if (!q.data) return q.error ? <ErrorState message="Could not load the queue." onRetry={() => q.refetch()} /> : <Skeleton lines={3} />;
  return (
    <Card title="Queue health">
      <dl className="kv">
        <dt>Jobs waiting to run</dt><dd>{q.data.queued}</dd>
        <dt>Oldest waiting job</dt><dd>{q.data.oldestQueuedAt ? exactWhen(q.data.oldestQueuedAt) : "none"}</dd>
        <dt>Jobs that failed</dt><dd>{q.data.failed}</dd>
        <dt>Workflow runs waiting</dt><dd>{q.data.waitingRuns}</dd>
      </dl>
      <p className="small muted">These figures refresh every 5 seconds.</p>
      <details className="more">
        <summary>Workflows the system can run ({q.data.definitions.length})</summary>
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {q.data.definitions.map((d) => <li key={d}>{workflowWords(d)} <span className="small muted">({d})</span></li>)}
        </ul>
      </details>
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Business calendar                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

type HoursWindow = { start: string; end: string };
type CalendarDto = {
  current: { timeZone: string; hours: Record<string, HoursWindow[]>; holidays: Array<{ date: string; name: string }>; closures: Array<{ from: string; to: string; name: string }>; coverageChanges: Array<{ from: string; to: string; reason: string; hours: HoursWindow[] | null }> };
  version: number | null; effectiveFrom: string | null; description: string;
  upcoming: Array<{ version: number; effectiveFrom: string; note: string }>;
  versions: Array<{ version: number; effectiveFrom: string; timeZone: string; note: string; createdAt: string; createdBy: { name?: string; id: string } }>;
  preview: Array<{ date: string; weekday: string; open: HoursWindow[]; reason: string | null }>;
};
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York"];
const windowsToText = (ws: HoursWindow[]) => ws.map((w) => `${w.start}-${w.end}`).join(", ");
const parseWindows = (t: string): HoursWindow[] => t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [start = "", end = ""] = x.split("-").map((y) => y.trim()); return { start, end }; });
const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
// Today in the administrator's own calendar: the UTC date read as tomorrow on a US evening, so a version meant to start
// now said "takes effect on its date".
const todayKey = () => dayKey(new Date());

/**
 * The ITS business calendar (correction 12): every save is a new version with an effective date; nothing is edited in
 * place; deadlines already set keep their values until an administrator recalculates them with a reason.
 */
export function CalendarAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adminKeys.calendar, queryFn: () => api.get<CalendarDto>("/api/v1/admin/calendar", reason) });
  const [effectiveFrom, setEffectiveFrom] = useState(todayKey());
  const [timeZone, setTimeZone] = useState("America/Los_Angeles");
  const [hours, setHours] = useState<Record<string, string>>({});
  const [holidays, setHolidays] = useState("");
  const [closures, setClosures] = useState("");
  const [coverage, setCoverage] = useState("");
  const [note, setNote] = useState("");
  const [recalcReason, setRecalcReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const c = q.data.current;
    setTimeZone(c.timeZone);
    setHours(Object.fromEntries(DAYS.map((d) => [d, windowsToText(c.hours[d] ?? [])])));
    setHolidays(c.holidays.map((h) => `${h.date} ${h.name}`).join("\n"));
    setClosures(c.closures.map((x) => `${x.from} ${x.to} ${x.name}`).join("\n"));
    setCoverage(c.coverageChanges.map((x) => `${x.from} ${x.to} ${x.hours ? windowsToText(x.hours).replace(/, /g, "+") : "closed"} ${x.reason}`).join("\n"));
  }, [q.data]);
  const build = () => {
    const parseDated = (l: string, n: number) => { const parts = l.split(/\s+/); return { dates: parts.slice(0, n), rest: parts.slice(n).join(" ") }; };
    return {
      effectiveFrom, timeZone, note,
      hours: Object.fromEntries(DAYS.map((d) => [d, parseWindows(hours[d] ?? "")])),
      holidays: lines(holidays).map((l) => { const { dates, rest } = parseDated(l, 1); return { date: dates[0], name: rest || "Holiday" }; }),
      closures: lines(closures).map((l) => { const { dates, rest } = parseDated(l, 2); return { from: dates[0], to: dates[1], name: rest || "Closed" }; }),
      coverageChanges: lines(coverage).map((l) => { const { dates, rest } = parseDated(l, 2); const [spec = "", ...why] = rest.split(/\s+/); return { from: dates[0], to: dates[1], hours: spec === "closed" ? null : parseWindows(spec.replace(/\+/g, ",")), reason: why.join(" ") || "coverage change" }; }),
    };
  };
  const save = useMutation({
    mutationFn: () => api.post<{ version: number; inForceNow: boolean; description: string }>("/api/v1/admin/calendar", build(), reason),
    onSuccess: (r) => { setProblem(null); toast(`Saved as version ${r.version}${r.inForceNow ? " (in force now)" : " (takes effect on its date)"}.`); qc.invalidateQueries({ queryKey: ["admin", "calendar"] }); },
    onError: (e) => setProblem(e instanceof ApiError ? `${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ""}` : "Could not save."),
  });
  const recalc = useMutation({
    mutationFn: () => api.post<{ considered: number; changed: number }>("/api/v1/admin/calendar/recalculate", { reason: recalcReason }, reason),
    onSuccess: (r) => { toast(`Recalculated ${r.changed} of ${r.considered} open deadlines.`); setRecalcReason(""); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not recalculate."),
  });
  if (!q.data) return q.error ? <ErrorState message="Could not load the business calendar." onRetry={() => q.refetch()} /> : <Skeleton lines={6} />;
  return (
    <div className="stack">
      <Card title={`In force: ${q.data.description}`}>
        <p className="small muted">{q.data.version ? `Version ${q.data.version}, effective ${q.data.effectiveFrom}.` : "Built-in default; no version published yet."}{q.data.upcoming.length ? ` Upcoming: ${q.data.upcoming.map((u) => `v${u.version} from ${u.effectiveFrom}`).join(", ")}.` : ""} Service-level clocks count only open hours. Deadlines already set keep their values unless you recalculate them below.</p>
      </Card>
      <Card title="Publish a new version">
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
        <div className="grid-2">
          <Field label="Effective from" htmlFor="cal-eff"><input id="cal-eff" className="input" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
          <Field label="Time zone" htmlFor="cal-tz"><select id="cal-tz" className="select" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>{[...new Set([...ZONES, timeZone])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>Standard hours per day (24-hour windows, comma-separated; blank means closed)</legend>
          <div className="grid-2">
            {DAYS.map((d) => <Field key={d} label={DAY_LABEL[d]} htmlFor={`cal-${d}`}><input id={`cal-${d}`} className="input" placeholder="09:00-17:00" value={hours[d] ?? ""} onChange={(e) => setHours({ ...hours, [d]: e.target.value })} /></Field>)}
          </div>
        </fieldset>
        <Field label="Holidays (one per line: date, name)" htmlFor="cal-hol"><textarea id="cal-hol" className="textarea" rows={6} value={holidays} onChange={(e) => setHolidays(e.target.value)} placeholder="2026-11-26 Thanksgiving Day" /></Field>
        <Field label="ITS closures (one per line: first day, last day, name)" htmlFor="cal-clo"><textarea id="cal-clo" className="textarea" rows={3} value={closures} onChange={(e) => setClosures(e.target.value)} placeholder="2026-12-24 2026-12-31 Year-end closure" /></Field>
        <Field label="Temporary coverage changes (one per line: first day, last day, hours or 'closed', reason)" hint="Join several windows with +, for example 09:00-12:00+13:00-15:00." htmlFor="cal-cov"><textarea id="cal-cov" className="textarea" rows={3} value={coverage} onChange={(e) => setCoverage(e.target.value)} placeholder="2026-10-05 2026-10-09 09:00-12:00 Conference week" /></Field>
        <Field label="Note for the audit record" htmlFor="cal-note"><input id="cal-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change" /></Field>
        <div style={{ marginTop: 10 }}><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Publish version</Button></div>
      </Card>
      <Card title="Recalculate open deadlines">
        <p className="small muted">Only on request. Every changed deadline is audited and the customer sees the change on their request.</p>
        <Field label="Reason" htmlFor="cal-reason"><input id="cal-reason" className="input" value={recalcReason} onChange={(e) => setRecalcReason(e.target.value)} placeholder="Holiday closure added after these requests were opened" /></Field>
        <div style={{ marginTop: 10 }}><Button variant="secondary" loading={recalc.isPending} disabled={recalcReason.trim().length < 5} onClick={() => recalc.mutate()}>Recalculate all open deadlines</Button></div>
      </Card>
      <Card title="Next four weeks">
        <Table head={["Date", "Day", "Open", "Note"]}>
          {q.data.preview.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.weekday}</td><td>{d.open.length ? windowsToText(d.open) : <Chip tone="neutral">closed</Chip>}</td><td className="small muted">{d.reason ?? ""}</td></tr>)}
        </Table>
      </Card>
      <Card title="Versions">
        {q.data.versions.length === 0 ? <p className="small muted">No versions yet.</p> : (
          <Table head={["Version", "Effective", "Time zone", "Note", "Published"]}>
            {q.data.versions.map((v) => <tr key={v.version}><td>{v.version}</td><td>{v.effectiveFrom}</td><td>{v.timeZone}</td><td>{v.note}</td><td className="small">{new Date(v.createdAt).toLocaleString()} by {v.createdBy.name ?? v.createdBy.id}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Administrators                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

type RoleGrant = { id: string; userId: string; email: string; name: string | null; authProvider: string | null; role: string; source: string; grantedBy: { name?: string; id: string }; grantReason: string; grantedAt: string; revokedAt: string | null; revokedBy: { name?: string; id: string } | null; revokeReason: string | null };

/** A platform role, as the Role picker names it. */
const PLATFORM_ROLE_WORDS: Readonly<Record<string, string>> = { its_recruiter: "ITS recruiter", platform_admin: "Platform administrator" };
const roleWords = (code: string) => wordFor(PLATFORM_ROLE_WORDS, code);

/**
 * Platform roles (21 Sep, item 2): the ledger of named people. Grants and revocations need a second factor, a reason,
 * and are seen by every other administrator; nobody can grant themselves anything.
 */
export function Administrators() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adminKeys.platformRoles, queryFn: () => api.get<{ grants: RoleGrant[]; activeAdmins: number; bootstrap: { configured: number; ignored: boolean } }>("/api/v1/admin/platform-roles", reason) });
  const [form, setForm] = useState({ email: "", role: "its_recruiter", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; reason: string } | null>(null);
  const grant = useMutation({ mutationFn: () => api.post("/api/v1/admin/platform-roles", { ...form, confirm: true }, reason), onSuccess: () => { toast("Granted. Every other administrator has been told."); setForm({ email: "", role: "its_recruiter", reason: "" }); setConfirming(false); qc.invalidateQueries({ queryKey: ["admin", "platform-roles"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not grant.") });
  const revoke = useMutation({ mutationFn: (r: { id: string; reason: string }) => api.post(`/api/v1/admin/platform-roles/${r.id}/revoke`, { reason: r.reason, confirm: true }, reason), onSuccess: () => { toast("Revoked. Every other administrator has been told."); setRevoking(null); qc.invalidateQueries({ queryKey: ["admin", "platform-roles"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not revoke.") });
  if (!q.data) return q.error ? <ErrorState message="Could not load platform roles." onRetry={() => q.refetch()} /> : <Skeleton lines={4} />;
  const active = q.data.grants.filter((g) => !g.revokedAt);
  const past = q.data.grants.filter((g) => g.revokedAt);
  return (
    <div className="stack" style={{ gap: 14 }}>
      {q.data.bootstrap.ignored ? <Alert tone="caution">BOOTSTRAP_ADMIN_EMAILS is still set but administrators already exist. It grants nothing now; remove it from the environment.</Alert> : null}
      <Card title={`Current platform roles (${q.data.activeAdmins} administrator${q.data.activeAdmins === 1 ? "" : "s"})`}>
        <Table head={["Person", "Role", "Granted", "Reason", ""]}>
          {active.map((g) => (
            <tr key={g.id}>
              <td>{g.name ?? g.email}<div className="small muted">{g.email}</div></td>
              <td><Chip tone={g.role === "platform_admin" ? "accent" : "neutral"}>{roleWords(g.role)}</Chip></td>
              <td><span title={exactWhen(g.grantedAt)}>{new Date(g.grantedAt).toLocaleDateString()}</span><div className="small muted">by {g.grantedBy.name ?? g.grantedBy.id} · {codeWords(g.source).toLowerCase()}</div></td>
              <td className="small">{g.grantReason}</td>
              <td>
                {revoking?.id === g.id ? (
                  <div className="stack" style={{ gap: 6 }}>
                    <Field label="Reason for revoking" htmlFor={`rr-${g.id}`}><input id={`rr-${g.id}`} className="input" value={revoking.reason} onChange={(e) => setRevoking({ id: g.id, reason: e.target.value })} /></Field>
                    <div className="row"><Button size="sm" variant="destructive" disabled={revoking.reason.trim().length < 5} loading={revoke.isPending} onClick={() => revoke.mutate(revoking)}>Revoke now</Button><Button size="sm" variant="quiet" onClick={() => setRevoking(null)}>Cancel</Button></div>
                  </div>
                ) : <Button size="sm" variant="secondary" onClick={() => setRevoking({ id: g.id, reason: "" })}>Revoke</Button>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Grant a platform role">
        <p className="small muted">The person must already have signed in with Microsoft 365 and a second factor. You cannot grant yourself a role. Every other administrator and the ITS queue mailbox are told, and another administrator must acknowledge the alert.</p>
        <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
          <Field label="Staff email" htmlFor="pr-email"><input id="pr-email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role" htmlFor="pr-role"><select id="pr-role" className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="its_recruiter">ITS recruiter</option><option value="platform_admin">Platform administrator</option></select></Field>
          <Field label="Reason" htmlFor="pr-reason"><input id="pr-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Grant {roleWords(form.role)} to {form.email}?</span><span className="row"><Button size="sm" variant="primary" loading={grant.isPending} onClick={() => grant.mutate()}>Yes, grant it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant="primary" disabled={!form.email.includes("@") || form.reason.trim().length < 5} onClick={() => setConfirming(true)}>Grant</Button></div>}
        </div>
      </Card>
      <SignOutEverywhere />
      {past.length ? <Card title="Past roles"><ul className="small" style={{ paddingLeft: 18 }}>{past.map((g) => <li key={g.id}>{g.email} · {roleWords(g.role)} · granted {new Date(g.grantedAt).toLocaleDateString()} by {g.grantedBy.name ?? g.grantedBy.id} · revoked {g.revokedAt ? new Date(g.revokedAt).toLocaleDateString() : ""} by {g.revokedBy?.name ?? g.revokedBy?.id}: {g.revokeReason}</li>)}</ul></Card> : null}
    </div>
  );
}

/**
 * "Sign someone out everywhere" (POST /admin/sessions/revoke): after a lost or stolen phone or laptop, or when someone
 * leaves, every session they have ends at once and they must sign in again. A reason and a confirmation; audited.
 */
export function SignOutEverywhere() {
  const [form, setForm] = useState({ email: "", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const signOut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; sessionsEnded: number }>("/api/v1/admin/sessions/revoke", { email: form.email.trim(), reason: form.reason.trim(), confirm: true }, reason),
    onSuccess: (r) => { toast(r.sessionsEnded ? `Signed out. ${r.sessionsEnded} session${r.sessionsEnded === 1 ? "" : "s"} ended.` : "Done. They had no open sessions."); setForm({ email: "", reason: "" }); setConfirming(false); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not sign them out."),
  });
  return (
    <Card title="Sign someone out everywhere">
      <p className="small muted">Use it after a lost or stolen phone or laptop, or when someone leaves. Every place they are signed in ends at once; nothing else about them changes. For a lost second-factor device, reset it in the identity service first.</p>
      <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
        <Field label="Email they sign in with" htmlFor="so-email"><input id="so-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Reason" htmlFor="so-reason"><input id="so-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
        {confirming ? (
          <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Sign {form.email.trim()} out of every device?</span><span className="row"><Button size="sm" variant="destructive" loading={signOut.isPending} onClick={() => signOut.mutate()}>Yes, sign them out</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
        ) : <div className="row"><Button variant="secondary" disabled={!form.email.includes("@") || form.reason.trim().length < 5} onClick={() => setConfirming(true)}>Sign out everywhere</Button></div>}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The section                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The parts of System and settings, each its own `?view=` (redesign spec 3.1). */
export const SYSTEM_PARTS: SectionPart[] = [
  { id: "costs", label: "Costs" },
  { id: "workflows", label: "Workflows" },
  { id: "ai", label: "AI runs" },
  { id: "queue", label: "Queue health" },
  { id: "calendar", label: "Business calendar" },
  { id: "admins", label: "Administrators" },
];

/** The System and settings section (the contract in admin-api.ts): its six parts as underline tabs. */
export function SystemSection({ view, onView }: SectionProps) {
  const part = partOf(SYSTEM_PARTS, view);
  return (
    <Tabs label="System and settings" value={part} onChange={onView} items={SYSTEM_PARTS}>
      {part === "workflows" ? <Runs /> : part === "ai" ? <AiRuns /> : part === "queue" ? <Queue /> : part === "calendar" ? <CalendarAdmin /> : part === "admins" ? <Administrators /> : <Costs />}
    </Tabs>
  );
}
