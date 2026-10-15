"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, Drawer, ErrorState, Field, Menu, nextSort, Segmented, Skeleton, type SortDir, type SortKind, sortAnnouncement, sortRows, Table, type TableHead, TabPanel, Tabs } from "@ros/ui";
import { api, ApiError } from "../../api/client";
import { type AllowanceAlert, allowanceAlerts, allowanceChip } from "../../allowance";
import { APPLY_MODE_HELP, APPLY_MODE_LABEL, APPLY_MODE_NOTE, REASON_MIN, companyFlowToast, reasonReady, type ApplyMode } from "../../apply-flow";
import { RoleApplyMode } from "../../components/ApplyMode";
import { useNavigate, useSearchParams } from "../../nav";
import { RECRUITER_ASKS_OVER_CHIP } from "../../recruiter-requests";
import { toast } from "../../toast";
import { CustomerReportPanel } from "../AdminCustomerReport";
import { type AlertRow, type CustomerRow, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { activityWords, exactMoney, exactWhen, money, planStatusWords, planWords, whenWords } from "./admin-words";
import { Outcomes } from "./outcomes";

/*
 * The console's Customers section (redesign spec 3.2, Wave S6): every customer in a five-column list with filter pills,
 * a search box and a Sort chip, and one drawer per customer (`?open=<id>&tab=…`) whose tabs hold the ITS check, the
 * plan, how its people apply and its report. The hiring outcomes are the section's second part.
 */

export const CUSTOMER_SORT = { company: (c: CustomerRow) => c.name, applicants: (c: CustomerRow) => c.applications, cost: (c: CustomerRow) => c.aiCostUsd, activity: (c: CustomerRow) => (c.lastActivityAt ? Date.parse(c.lastActivityAt) : null) };
type CheckedRow = { verifiedAt: string | null; createdAt: string };

/** Companies waiting for the ITS check, the longest waiting first (founder decision B7). */
export function waitingCustomers<T extends CheckedRow>(rows: readonly T[]): T[] {
  return rows.filter((c) => !c.verifiedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The customers table's order (founder decision B7): the companies waiting for the ITS check on top whatever order a
 * heading gives, the longest waiting first, then the confirmed ones in the chosen order (`sortConfirmed`).
 */
export function customerOrder<T extends CheckedRow>(rows: readonly T[], sortConfirmed: (confirmed: T[]) => T[]): T[] {
  return [...waitingCustomers(rows), ...sortConfirmed(rows.filter((c) => c.verifiedAt))];
}

/** What a screen reader hears after a sort; while any company waits, also that the waiting ones stay on top. */
export function customerAnnouncement(announce: string, waiting: number): string {
  return announce && waiting ? `${announce} Companies waiting for the ITS check stay at the top.` : announce;
}

export type CustomerSortKey = keyof typeof CUSTOMER_SORT;
export type CustomerSort = { key: CustomerSortKey; dir: SortDir } | null;

/**
 * Every order the list can take, in the order the Sort chip offers them. Applicants and AI cost are no longer columns
 * (they are on the drawer's Overview), so the chip is how they stay usable; Company and Last active also sort from
 * their headings.
 */
export const CUSTOMER_SORT_CHOICES: ReadonlyArray<{ id: CustomerSortKey; label: string; kind: SortKind }> = [
  { id: "company", label: "Company", kind: "text" },
  { id: "applicants", label: "Applicants", kind: "number" },
  { id: "cost", label: "AI cost", kind: "number" },
  { id: "activity", label: "Last active", kind: "date" },
];

function sortChoice(key: CustomerSortKey): { label: string; kind: SortKind } {
  return CUSTOMER_SORT_CHOICES.find((c) => c.id === key) ?? { label: key, kind: "text" };
}

/**
 * The order after a choice: a heading pressed again flips its order; a choice from the Sort chip, or a new heading,
 * starts the useful way round (A to Z for the name, highest first for figures, latest first for a date).
 */
export function nextCustomerSort(current: CustomerSort, key: CustomerSortKey, from: "chip" | "heading"): { key: CustomerSortKey; dir: SortDir } {
  return nextSort(from === "chip" ? null : current, key, sortChoice(key).kind);
}

/** The customers in the list's order: the companies waiting for the ITS check on top (B7), the rest in the chosen order. */
export function sortedCustomers(rows: readonly CustomerRow[], sort: CustomerSort): CustomerRow[] {
  return customerOrder(rows, (confirmed) => (sort ? sortRows(confirmed, CUSTOMER_SORT[sort.key], sort.dir) : confirmed));
}

/** The filter pills above the list, each its own `?show=` (none for All). */
export type CustomerFilter = "all" | "waiting" | "low" | "quiet";
export const CUSTOMER_FILTERS: ReadonlyArray<{ id: CustomerFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting for the ITS check" },
  { id: "low", label: "Running low" },
  { id: "quiet", label: "Quiet" },
];

export function customerFilterFrom(value: string | null): CustomerFilter {
  return CUSTOMER_FILTERS.find((f) => f.id === value)?.id ?? "all";
}

/**
 * Whether a customer belongs under a pill: Waiting, not confirmed yet; Running low, an open allowance alert (80% of the
 * screening chats, or used up); Quiet, no activity for more than 7 days (the console's churn rule, admin-words.ts).
 */
export function customerInFilter(c: CustomerRow, filter: CustomerFilter, low: ReadonlyMap<string, unknown>, now: number = Date.now()): boolean {
  if (filter === "waiting") return !c.verifiedAt;
  if (filter === "low") return low.has(c.id);
  if (filter === "quiet") return activityWords(c.lastActivityAt, now).state !== "active";
  return true;
}

/** Whether a customer matches what was typed in the search box: its name, kind of business, address or website. */
export function customerMatches(c: CustomerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, c.vertical, c.slug, c.settings.website ?? ""].some((v) => v.toLowerCase().includes(q));
}

/** The customer drawer's tabs, each its own `&tab=` (none for the Overview). */
export type CustomerTab = "overview" | "check" | "plan" | "apply" | "report";
export const CUSTOMER_TABS: Array<{ id: CustomerTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "check", label: "ITS check" },
  { id: "plan", label: "Plan" },
  { id: "apply", label: "How people apply" },
  { id: "report", label: "Report" },
];

export function customerTabFrom(value: string | null): CustomerTab {
  return CUSTOMER_TABS.find((t) => t.id === value)?.id ?? "overview";
}

/**
 * The address after a change to the list or its drawer, with everything else in it kept (the console's `?view=`, the
 * Overview's `?q=`). Closing the drawer takes its tab off too.
 */
export function customersSearch(search: URLSearchParams, patch: { open?: string | null; tab?: CustomerTab; show?: CustomerFilter }): string {
  const next = new URLSearchParams(search);
  if (patch.open === null) {
    next.delete("open");
    next.delete("tab");
  } else if (patch.open !== undefined) next.set("open", patch.open);
  if (patch.tab !== undefined) {
    if (patch.tab === "overview") next.delete("tab");
    else next.set("tab", patch.tab);
  }
  if (patch.show !== undefined) {
    if (patch.show === "all") next.delete("show");
    else next.set("show", patch.show);
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

const DAY = 86_400_000;

/** How long a company has waited for the ITS check: "Waiting since today", "Waiting 1 day", "Waiting 3 days". */
export function waitingWords(createdAt: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(createdAt)) / DAY);
  return days < 1 ? "Waiting since today" : `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A row's first line: 14 px in ink (redesign spec 3.3); its second lines are `.small.muted` (13 px, --ink-3). */
const LINE: CSSProperties = { fontSize: 14, color: "var(--ink)" };
/** The company's name, which opens its drawer. */
const NAME: CSSProperties = { padding: 0, border: 0, background: "none", color: "var(--ink)", font: "600 15px/1.3 var(--ui)", textAlign: "left", cursor: "pointer" };

/**
 * All customers: pills (All, Waiting for the ITS check, Running low, Quiet) with counts, a search box and a Sort chip
 * above a list of five columns; the companies waiting for the ITS check always on top (B7). A company's name or its
 * button opens the customer drawer, kept in the address (`?open=<id>&tab=…`) so a reload, a link from the Overview or
 * from the recruiter queue lands on it.
 */
export function Customers() {
  const [search] = useSearchParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["admin", "customers"], queryFn: () => api.get<CustomerRow[]>("/api/v1/admin/customers", reason) });
  // Companies at 80% of their screening conversations, or past them (Q17): from the alerts ITS was sent.
  const alerts = useQuery({ queryKey: ["admin", "alerts"], queryFn: () => api.get<AlertRow[]>("/api/v1/admin/alerts", reason) });
  const low = allowanceAlerts(alerts.data ?? []);
  const [filter, setFilter] = useState<CustomerFilter>(() => customerFilterFrom(search.get("show")));
  const [query, setQuery] = useState(() => search.get("q") ?? "");
  const [sort, setSort] = useState<CustomerSort>(null);
  const [announce, setAnnounce] = useState("");

  // The customer drawer, mirrored in the address with replace, so Back leaves the page as before.
  const openParam = search.get("open");
  const fromAddress = (): { id: string; tab: CustomerTab } | null => (openParam ? { id: openParam, tab: customerTabFrom(search.get("tab")) } : null);
  const [drawer, setDrawer] = useState(fromAddress);
  // A link followed while this page is open (the Overview's "Review", the recruiter queue) changes only the address: follow it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `?open=` in the address re-reads it
  useEffect(() => {
    if (openParam && openParam !== drawer?.id) setDrawer(fromAddress());
  }, [openParam]);
  const go = (patch: Parameters<typeof customersSearch>[1]) => nav(`${window.location.pathname}${customersSearch(search, patch)}`, { replace: true });
  const showDrawer = (next: { id: string; tab: CustomerTab } | null) => {
    setDrawer(next);
    go(next ? { open: next.id, tab: next.tab } : { open: null });
  };
  const pick = (next: CustomerFilter) => {
    setFilter(next);
    go({ show: next });
  };
  const sortBy = (key: CustomerSortKey, from: "chip" | "heading") => {
    const next = nextCustomerSort(sort, key, from);
    setSort(next);
    setAnnounce(sortAnnouncement(sortChoice(key).label, sortChoice(key).kind, next.dir));
  };
  const heading = (key: CustomerSortKey): TableHead => ({ label: sortChoice(key).label, sort: sort?.key === key ? sort.dir : null, onSort: () => sortBy(key, "heading") });

  const rows = q.data ?? [];
  const now = Date.now();
  // Companies waiting for the ITS check come first, the longest waiting at the top (founder decision B7).
  const waiting = waitingCustomers(rows);
  const lowCompanies = rows.filter((c) => low.has(c.id));
  const count = (f: CustomerFilter) => rows.filter((c) => customerInFilter(c, f, low, now)).length;
  const shown = sortedCustomers(rows.filter((c) => customerInFilter(c, filter, low, now) && customerMatches(c, query)), sort);
  const narrowed = filter !== "all" || query.trim() !== "";
  const showAll = () => {
    setQuery("");
    pick("all");
  };
  const opened = drawer ? (rows.find((c) => c.id === drawer.id) ?? null) : null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="talent-toolbar">
        {CUSTOMER_FILTERS.map((f) => (
          <button key={f.id} type="button" className="toggle-chip" aria-pressed={filter === f.id} onClick={() => pick(filter === f.id ? "all" : f.id)}>
            {f.label}
            {q.data ? <>{" "}<span className="count">{count(f.id)}</span></> : null}
          </button>
        ))}
        <input className="input talent-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers" aria-label="Search customers" />
        <Menu label={sort ? `Sort: ${sortChoice(sort.key).label}` : "Sort"} heading="Sort customers" align="end" currentLabel="Now" items={CUSTOMER_SORT_CHOICES.map((c) => ({ id: c.id, label: c.label, current: sort?.key === c.id }))} onSelect={(id) => sortBy(id as CustomerSortKey, "chip")} />
      </div>
      {waiting.length ? (
        <Alert tone="caution">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>
              {waiting.length === 1 ? "1 company is" : `${waiting.length} companies are`} waiting for the ITS check: {waiting.map((c) => c.name).join(", ")}. Until you confirm a company, its careers page, job pages and Google listing are offline and its emails to candidates wait.
            </span>
            {filter !== "waiting" ? <Button size="sm" onClick={() => pick("waiting")}>Show only these</Button> : null}
          </div>
        </Alert>
      ) : null}
      {filter === "low" && lowCompanies.length ? (
        <Card needsYou title="Screening chats running low">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {lowCompanies.map((c) => {
              const a = low.get(c.id);
              return a ? <li key={c.id}><strong>{c.name}</strong>: {allowanceChip(a)}, since {new Date(a.since).toLocaleDateString()}</li> : null;
            })}
          </ul>
          <p className="muted" style={{ marginTop: 8 }}>Talk with each about topping up. Nothing is refused: applications are still accepted, anyone part-way through finishes, and once the allowance is used up new applicants get the chat link by email when more are added or the month starts again. The owners were told too.</p>
        </Card>
      ) : null}
      {q.error ? <ErrorState message="Could not load customers." onRetry={() => q.refetch()} /> : (
        <Table
          head={[heading("company"), "ITS check", "Plan and use", heading("activity"), ""]}
          label="Customers"
          loading={q.isLoading ? 4 : undefined}
          empty={narrowed && rows.length ? <div className="row" style={{ justifyContent: "space-between" }}><span>Nothing matches this filter.</span><Button size="sm" onClick={showAll}>Show all customers</Button></div> : "No customers yet."}
          announce={customerAnnouncement(announce, waiting.length)}
        >
          {shown.map((c) => <CustomerListRow key={c.id} c={c} low={low.get(c.id)} now={now} onOpen={(tab) => showDrawer({ id: c.id, tab })} />)}
        </Table>
      )}
      {opened && drawer ? <CustomerDrawer company={opened} low={low.get(opened.id)} tab={drawer.tab} onTab={(tab) => showDrawer({ id: opened.id, tab })} onClose={() => showDrawer(null)} /> : null}
    </div>
  );
}

/** One customer in the list: name and kind of business, the ITS check, plan and use, last active, and one button. */
function CustomerListRow({ c, low, now, onOpen }: { c: CustomerRow; low: AllowanceAlert | undefined; now: number; onOpen: (tab: CustomerTab) => void }) {
  const verified = !!c.verifiedAt;
  const activity = activityWords(c.lastActivityAt, now);
  const usage = c.screeningConversations;
  return (
    <tr>
      <td>
        <button type="button" style={NAME} onClick={() => onOpen("overview")}>{c.name}</button>
        <div className="small muted">{c.vertical} · {c.sizeBand}</div>
      </td>
      <td>
        {verified ? <Chip tone="good">Confirmed</Chip> : <span title={exactWhen(c.createdAt)}><Chip tone="caution">{waitingWords(c.createdAt, now)}</Chip></span>}
        {c.heldMessages ? <div className="small muted">{plural(c.heldMessages, "message", "messages")} held</div> : null}
      </td>
      <td>
        <div style={LINE}>{planWords(c.planKey)}{c.status !== "active" ? ` · ${planStatusWords(c.status)}` : ""}</div>
        {usage ? <div className="small muted">{usage.used}{usage.limit !== null ? ` of ${usage.limit}` : ""} chats this month</div> : null}
        {low ? <span title={allowanceChip(low)}><Chip tone="caution">{low.level === "used_up" ? "Used up" : "Running low"}</Chip></span> : null}
      </td>
      <td>
        {/* never active: the chip alone says so ("never active") */}
        {c.lastActivityAt ? <div style={LINE} title={exactWhen(c.lastActivityAt)}>{whenWords(c.lastActivityAt, new Date(now))}</div> : null}
        {activity.state !== "active" ? <Chip tone={activity.tone}>{activity.label}</Chip> : null}
      </td>
      <td>
        <Button size="sm" variant={verified ? "secondary" : "primary"} ariaLabel={`${verified ? "Open" : "Confirm"} ${c.name}`} onClick={() => onOpen(verified ? "overview" : "check")}>{verified ? "Open" : "Confirm"}</Button>
      </td>
    </tr>
  );
}

/**
 * One customer (redesign spec 3.2): a 640 px drawer named by the company, its facts under the name, and five tabs: the
 * Overview, then the bodies of the four sheets the console had before (ITS check, Plan, How people apply, Report),
 * unchanged in what they do and say. Every "Change" on the Overview switches to its tab.
 */
function CustomerDrawer({ company, low, tab, onTab, onClose }: { company: CustomerRow; low: AllowanceAlert | undefined; tab: CustomerTab; onTab: (tab: CustomerTab) => void; onClose: () => void }) {
  const sub = [company.vertical, `${company.sizeBand} employees`, company.settings.website || "", `signed up ${whenWords(company.createdAt)}`].filter(Boolean).join(" · ");
  // The button pressed on the Overview goes with it: focus moves to the tab it opened.
  const switchTo = (next: CustomerTab) => {
    onTab(next);
    requestAnimationFrame(() => document.getElementById(`customer-drawer-tab-${next}`)?.focus());
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={company.name}
      sub={sub}
      leading={<Avatar name={company.name} shape="square" letters={1} size="lg" />}
      tabs={<Tabs idBase="customer-drawer" label="Customer sections" value={tab} onChange={(v) => onTab(customerTabFrom(v))} items={CUSTOMER_TABS} />}
    >
      <TabPanel key={company.id} idBase="customer-drawer" value={tab}>
        {tab === "overview" ? <CustomerOverview c={company} low={low} onTab={switchTo} /> : null}
        {tab === "check" ? <CompanyCheckPanel company={company} /> : null}
        {tab === "plan" ? <PlanPanel company={company} onDone={() => switchTo("overview")} /> : null}
        {tab === "apply" ? <ApplyFlowPanel company={company} /> : null}
        {tab === "report" ? <CustomerReportPanel companyId={company.id} /> : null}
      </TabPanel>
    </Drawer>
  );
}

/** A fact with its button on the right. */
function Fact(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
      <span>{props.children}</span>
      {props.action}
    </div>
  );
}

/**
 * Everything the list knows about one customer, in plain words: the ITS check, job boards, plan and its screening chats
 * (with the running-low chip), how people apply, jobs and applicants, recruiter requests (with the "Past its recruiter
 * requests" chip, Q33), AI cost (the exact figure on hover), last activity and the messages held.
 */
function CustomerOverview({ c, low, onTab }: { c: CustomerRow; low: AllowanceAlert | undefined; onTab: (tab: CustomerTab) => void }) {
  const verified = !!c.verifiedAt;
  const activity = activityWords(c.lastActivityAt);
  const asks = c.recruiterAsks;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <dl className="kv" style={LINE}>
        <dt>ITS check</dt>
        <dd>
          <Fact action={<Button size="sm" variant={verified ? "quiet" : "primary"} ariaLabel={verified ? "Change the ITS check" : undefined} onClick={() => onTab("check")}>{verified ? "Change" : "Confirm"}</Button>}>
            {verified ? `Confirmed ${exactWhen(c.verifiedAt)}${c.verifiedBy?.name ? ` by ${c.verifiedBy.name}` : ""}` : `${waitingWords(c.createdAt)} (signed up ${exactWhen(c.createdAt)})`}
          </Fact>
        </dd>
        <dt>Job boards</dt>
        <dd>{c.jobBoardsConfirmedAt ? "ITS can sign in" : "Not confirmed yet"}</dd>
        <dt>Plan</dt>
        <dd>
          <Fact action={<Button size="sm" variant="quiet" onClick={() => onTab("plan")}>Change plan</Button>}>{planWords(c.planKey)} · {planStatusWords(c.status)}</Fact>
          {c.screeningConversations ? <div className="small muted">{screeningLine(c.screeningConversations)}</div> : null}
          {low ? <Chip tone="caution">{allowanceChip(low)}</Chip> : null}
        </dd>
        <dt>How people apply</dt>
        <dd>
          <Fact action={<Button size="sm" variant="quiet" ariaLabel="Change how people apply" onClick={() => onTab("apply")}>Change</Button>}>{APPLY_MODE_LABEL[c.applyFlowDefault ?? "form_then_screen"]}</Fact>
        </dd>
        <dt>Jobs</dt>
        <dd>{plural(c.roles, "job", "jobs")} · {plural(c.applications, "applicant", "applicants")}</dd>
        <dt>Recruiter requests</dt>
        <dd>
          <div>{asks ? `${asks.used}${asks.limit !== null ? ` of ${asks.limit}` : ""} this month` : "None recorded"} · {c.escalations} in all</div>
          {/* Past the plan's recruiter requests (Q33): nothing was refused; ITS talks with the customer about billing. */}
          {c.recruiterAsks?.over ? <Chip tone="caution">{RECRUITER_ASKS_OVER_CHIP}</Chip> : null}
        </dd>
        <dt>AI cost</dt>
        <dd><span title={exactMoney(c.aiCostUsd)}>{money(c.aiCostUsd)}</span> in all</dd>
        <dt>Last activity</dt>
        <dd>{c.lastActivityAt ? <>{exactWhen(c.lastActivityAt)} </> : null}<Chip tone={activity.tone}>{activity.label}</Chip></dd>
        <dt>Messages held</dt>
        <dd>{c.heldMessages ? `${plural(c.heldMessages, "message", "messages")} to candidates` : "None"}</dd>
      </dl>
      <div className="row">
        <Button onClick={() => onTab("report")}>See the report</Button>
      </div>
    </div>
  );
}

/** "122 of 150 screening chats this month, resets October 30" (the reset date when the API gives one). */
export function screeningLine(u: { used: number; limit: number | null; resetsAt?: string | null }): string {
  const resets = u.resetsAt ? `, resets ${new Date(u.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
  return `${u.used}${u.limit !== null ? ` of ${u.limit}` : ""} screening chats this month${resets}`;
}

export type PlanOption = { key: string; name: string; limits: Record<string, number | null> };
const LIMIT_WORDS: Array<[string, string]> = [["active_roles", "active jobs"], ["text_screens", "screening chats a month"], ["recruiter_asks", "recruiter requests a month"], ["seats", "seats"]];

/** What a plan includes, in one line: "3 active jobs · 300 screening chats a month · 10 recruiter requests a month · unlimited seats". */
export function planLimitsLine(limits: Record<string, number | null>): string {
  return LIMIT_WORDS.filter(([k]) => k in limits).map(([k, words]) => `${limits[k] === null ? "unlimited" : limits[k]} ${words}`).join(" · ");
}

/** The toast after a plan change. */
export function planChangedToast(company: string, plan: string): { title: string; detail: string } {
  return { title: `${company} is on ${plan} now.`, detail: "The new limits apply at once. This month's usage stays; the reset date does not move." };
}

/**
 * The Plan control (Wave S2 F1; founder decision F8), platform admins only: pick a plan, say why, confirm. The new limits
 * apply at once (POST /admin/customers/:id/plan); the change is audited with the reason and the customer sees it in
 * their history. Design Partner starts the 90-day pilot. Once changed, the drawer goes back to its Overview.
 */
function PlanPanel({ company, onDone }: { company: CustomerRow; onDone: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.get<PlanOption[]>("/api/v1/admin/plans", reason) });
  const [pick, setPick] = useState(company.planKey);
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const chosen = (plans.data ?? []).find((p) => p.key === pick) ?? null;
  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/admin/customers/${company.id}/plan`, { planKey: pick, reason: why.trim() }, reason),
    onSuccess: () => {
      const t = planChangedToast(company.name, chosen?.name ?? pick);
      toast(t.title, t.detail);
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      qc.invalidateQueries({ queryKey: ["admin", "alerts"] });
      onDone();
    },
    onError: (e) => { setConfirming(false); toast(e instanceof ApiError ? e.message : "Could not change the plan."); },
  });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Pick a plan">
        <p className="small muted">Now on {planWords(company.planKey)}.{company.screeningConversations ? ` ${screeningLine(company.screeningConversations)}.` : ""}</p>
        {plans.isLoading ? <Skeleton lines={3} /> : plans.error ? <ErrorState message="Could not load the plans." onRetry={() => plans.refetch()} /> : (
          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
            <Field label="Plan" htmlFor="plan-pick">
              <select id="plan-pick" className="select" value={pick} onChange={(e) => { setPick(e.target.value); setConfirming(false); }}>
                {(plans.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </Field>
            {chosen ? <p className="small" style={{ margin: 0 }}>{planLimitsLine(chosen.limits)}</p> : null}
            {pick !== company.planKey ? (
              <>
                <Field label="Why (required, kept with the change)" htmlFor="plan-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="plan-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
                {confirming ? (
                  <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Put {company.name} on {chosen?.name ?? pick}?</span><span className="row"><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Yes, change it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
                ) : <div className="row"><Button variant="primary" disabled={!reasonReady(why)} onClick={() => setConfirming(true)}>Change plan</Button><Button variant="quiet" onClick={() => { setPick(company.planKey); setWhy(""); }}>Cancel</Button></div>}
              </>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * How a customer's applicants meet the screening conversation (plan E1; founder decision B1), ITS only: the company's
 * default ("form now, conversation later" until ITS switches the one-visit flow on for pilot roles or the whole company) and each role's own setting. Every change needs a reason, which is
 * audited and kept with who made it. Roles that already have their own setting keep it when the default changes.
 */
function ApplyFlowPanel({ company }: { company: CustomerRow }) {
  const qc = useQueryClient();
  const current: ApplyMode = company.applyFlowDefault ?? "form_then_screen";
  const [flow, setFlow] = useState<ApplyMode>(current);
  const [why, setWhy] = useState("");
  const roles = useQuery({ queryKey: ["admin", "customer-report", company.id], queryFn: () => api.get<{ roles: Array<{ id: string; title: string; status: string }> }>(`/api/v1/admin/customers/${company.id}/report`, reason) });
  const save = useMutation({
    mutationFn: () => api.post<{ applyFlow: ApplyMode; changed: boolean }>(`/api/v1/admin/customers/${company.id}/apply-flow`, { applyFlow: flow, reason: why.trim() }, reason),
    onSuccess: (r) => {
      const t = companyFlowToast(company.name, r.applyFlow, r.changed);
      toast(t.title, t.detail);
      setWhy("");
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      // each role's "the company's default" now names the new one
      qc.invalidateQueries({ queryKey: ["role"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the default."),
  });
  const openRoles = (roles.data?.roles ?? []).filter((r) => r.status !== "closed");
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="The company's default">
        <p className="small muted">For every role of {company.name} without its own setting. {APPLY_MODE_NOTE}</p>
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <Segmented value={flow} onChange={setFlow} ariaLabel="The company's default" options={[{ value: "one_visit", label: APPLY_MODE_LABEL.one_visit }, { value: "form_then_screen", label: APPLY_MODE_LABEL.form_then_screen }]} />
          <p className="small" style={{ margin: 0, color: "var(--ink-2)" }}>{APPLY_MODE_HELP[flow]}</p>
          {flow !== current ? (
            <>
              <Field label="Why (required, kept with the change)" htmlFor="apply-flow-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="apply-flow-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
              <div className="row"><Button variant="primary" disabled={!reasonReady(why)} loading={save.isPending} onClick={() => save.mutate()}>Save the default</Button><Button variant="quiet" onClick={() => { setFlow(current); setWhy(""); }}>Cancel</Button></div>
            </>
          ) : null}
        </div>
      </Card>
      <Card title="Each role">
        {roles.isLoading ? <Skeleton lines={3} /> : roles.error ? <ErrorState message="Could not load the roles." onRetry={() => roles.refetch()} /> : openRoles.length ? (
          <div className="stack" style={{ gap: 12 }}>
            {openRoles.map((r) => (
              <div key={r.id} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <strong>{r.title} <span className="small muted">({r.status.replace(/_/g, " ")})</span></strong>
                <RoleApplyMode roleId={r.id} roleTitle={r.title} compact />
              </div>
            ))}
          </div>
        ) : <p className="small muted">No open or draft roles.</p>}
      </Card>
    </div>
  );
}

/**
 * The one-time ITS check of a company (founder decision B7): confirm it after checking it is real, or take a confirmation
 * back; both need a reason, which the customer sees in their own history, and a second press to confirm. Below, whether
 * ITS can sign in to the company's job boards, which ticks the owner's getting-started step.
 */
function CompanyCheckPanel({ company }: { company: CustomerRow }) {
  const qc = useQueryClient();
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const verified = !!company.verifiedAt;
  const change = useMutation({
    mutationFn: () => api.post<{ changed: boolean; releasedMessages: number }>(`/api/v1/admin/customers/${company.id}/verification`, { verified: !verified, reason: why.trim(), confirm: true }, reason),
    onSuccess: (r) => {
      toast(verified ? `${company.name} is no longer confirmed.` : `${company.name} is confirmed.`, verified ? "Its public pages are offline and its messages to candidates wait. The owners were told." : `Its pages are public now${r.releasedMessages ? ` and ${r.releasedMessages} held ${r.releasedMessages === 1 ? "message is" : "messages are"} on ${r.releasedMessages === 1 ? "its" : "their"} way` : ""}. The owners were told.`);
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not change the check."),
  });
  const boards = useMutation({
    mutationFn: (confirmed: boolean) => api.post(`/api/v1/admin/customers/${company.id}/job-boards`, { confirmed }, reason),
    onSuccess: (_r, confirmed) => { toast(confirmed ? "Job-board access confirmed." : "Job-board access no longer confirmed."); qc.invalidateQueries({ queryKey: ["admin", "customers"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record it."),
  });
  // A confirmed company with messages still held (one held while the confirmation was being made): confirming again sends them.
  const release = useMutation({
    mutationFn: () => api.post<{ releasedMessages: number }>(`/api/v1/admin/customers/${company.id}/verification`, { verified: true, reason: "Held messages sent after the company was confirmed.", confirm: true }, reason),
    onSuccess: (r) => { toast(r.releasedMessages ? `${r.releasedMessages} held ${r.releasedMessages === 1 ? "message is" : "messages are"} on ${r.releasedMessages === 1 ? "its" : "their"} way.` : "Nothing was held any more."); qc.invalidateQueries({ queryKey: ["admin", "customers"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the held messages."),
  });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="The company">
        <p className="small">{company.name} · {company.vertical} · {company.sizeBand} employees · {company.settings.website || "no website given"} · signed up {new Date(company.createdAt).toLocaleDateString()}</p>
        <p className="small muted">{verified ? `Confirmed ${new Date(company.verifiedAt ?? "").toLocaleString()}${company.verifiedBy?.name ? ` by ${company.verifiedBy.name}` : ""}.` : "Not confirmed yet: its careers page, job pages and Google listing are offline, and its emails to candidates wait. It can draft and approve roles."}</p>
        {company.heldMessages && !verified ? <p className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} held and will go out when you confirm.</p> : null}
        {company.heldMessages && verified ? (
          <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} still held although the company is confirmed.</span>
            <Button size="sm" variant="primary" loading={release.isPending} onClick={() => release.mutate()}>Send the held messages</Button>
          </div>
        ) : null}
      </Card>
      <Card title={verified ? "Take the confirmation back" : "Confirm the company"}>
        <p className="small muted">{verified ? "Its careers page, job pages and feeds go offline at once and its messages to candidates wait again. Roles, candidates and decisions are kept." : "Confirm only after checking the company is real: the kick-off call, its website, a phone number. Its pages go public, approved roles are published and held messages go out."} The owners are told, and they see your reason in their activity history.</p>
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <Field label={verified ? "Why you are taking it back" : "How you checked the company"} htmlFor="co-check-why"><input id="co-check-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>{verified ? `Take back the confirmation of ${company.name}?` : `Confirm ${company.name} and make its pages public?`}</span><span className="row"><Button size="sm" variant={verified ? "destructive" : "primary"} loading={change.isPending} onClick={() => change.mutate()}>{verified ? "Yes, take it back" : "Yes, confirm it"}</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant={verified ? "secondary" : "primary"} disabled={why.trim().length < 5} onClick={() => setConfirming(true)}>{verified ? "Take back the confirmation" : "Confirm the company"}</Button></div>}
        </div>
      </Card>
      <Card title="Job-board access">
        <p className="small muted">The owner adds the ITS recruiter as a user on the company's LinkedIn, Indeed and ZipRecruiter accounts. Record here once ITS can sign in to each; it ticks the owner's getting-started step.</p>
        <div className="row" style={{ marginTop: 8 }}>
          {company.jobBoardsConfirmedAt
            ? <><Chip tone="good">ITS can sign in</Chip><Button size="sm" variant="secondary" loading={boards.isPending} onClick={() => boards.mutate(false)}>No longer confirmed</Button></>
            : <Button size="sm" variant="primary" loading={boards.isPending} onClick={() => boards.mutate(true)}>ITS can sign in to the job boards</Button>}
        </div>
      </Card>
    </div>
  );
}

/** The parts of Customers, each its own `?view=`: the list of customers first, then the hiring outcomes. */
export const CUSTOMERS_PARTS: SectionPart[] = [{ id: "all", label: "All customers" }, { id: "outcomes", label: "Hiring outcomes" }];

/** The Customers section (the contract in admin-api.ts): the customers list and the hiring outcomes under its part tabs. */
export function CustomersSection({ view, onView }: SectionProps) {
  const part = partOf(CUSTOMERS_PARTS, view);
  return (
    <Tabs label="Customers" value={part} onChange={onView} items={CUSTOMERS_PARTS}>
      {part === "outcomes" ? <Outcomes /> : <Customers />}
    </Tabs>
  );
}
