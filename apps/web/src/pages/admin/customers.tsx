"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, cn, Drawer, ErrorState, Field, Icon, Menu, nextSort, Pill, Segmented, Skeleton, type SortDir, type SortKind, sortAnnouncement, sortRows, Table, type TableHead, TabPanel, Tabs } from "@ros/ui";
import { api, ApiError } from "../../api/client";
import { type AllowanceAlert, allowanceAlerts, allowanceChip } from "../../allowance";
import { EVERY_APPLICANT_LINE, REASON_MIN, reasonReady } from "../../apply-flow";
import { useNavigate, useSearchParams } from "../../nav";
import { RECRUITER_ASKS_OVER_CHIP } from "../../recruiter-requests";
import { toast } from "../../toast";
import { trialDate } from "../../trial";
import { CustomerReportPanel } from "../AdminCustomerReport";
import { type AlertRow, type CustomerRow, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { activityWords, exactMoney, exactWhen, money, planStatusWords, planWords, trialWords, whenWords } from "./admin-words";
import type { TrialStanding, TrialTerm } from "@ros/contracts";
import { Outcomes } from "./outcomes";

/*
 * The console's Customers section (redesign spec 3.2, Wave S6): every customer in a five-column list with filter pills,
 * a search box and a Sort chip, and one drawer per customer (`?open=<id>&tab=…`) whose tabs hold the ITS check, the
 * plan, how its people apply and its report. The hiring outcomes are the section's second part.
 * Fewer words (founder, 23 Oct 2026): a fact is said once (the drawer's header carries the company's facts, a plan's
 * standing is left out when it only repeats the plan), and an explanation staff need folds under "How this works";
 * what the law asks for, what a change does to candidates and what the customer will see stay in view.
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

/**
 * A customer's plan and where it stands with it: "Core · Design Partner pilot", "Starter · Active", and just "Trial" when
 * the standing only repeats the plan's name. `quietActive` leaves "Active" out too (the list, where it is the usual case).
 */
export function planLine(c: Pick<CustomerRow, "planKey" | "status">, quietActive = false): string {
  const plan = planWords(c.planKey);
  const standing = planStatusWords(c.status);
  return !standing || standing === plan || (quietActive && c.status === "active") ? plan : `${plan} · ${standing}`;
}

/**
 * Where a Trial customer's 30 days stand, under its plan: a quiet line ("ends Oct 31", "starts at the ITS check"), or,
 * once they ended and new applications are paused, the same words as a caution chip, so the warning and its date are one
 * thing on screen instead of a chip repeating the line.
 */
function TrialStandingLine({ c }: { c: Pick<CustomerRow, "trial" | "timezone"> }) {
  if (!c.trial) return null;
  const words = trialWords(c.trial, c.timezone);
  return c.trial.ended ? <Chip tone="caution">{words}</Chip> : <div className="small muted">{words}</div>;
}

/** A row's first line: 14 px in ink (redesign spec 3.3); its second lines are `.small.muted` (13 px, --ink-3). */
const LINE = "text-sm text-ink";
/** The company's name, which opens its drawer: a plain button that reads as the row's title (40 px tall under a finger). */
const NAME = "inline-flex items-center border-0 bg-transparent p-0 text-left font-sans text-sm leading-snug font-semibold text-ink break-words transition-colors duration-150 ease-soft hover:text-primary hover:underline pointer-coarse:min-h-10";
/** Stacked lines in a table cell or a glance value: the first line, then the quieter ones and the chips, each on its own line. */
const CELL = "grid justify-items-start gap-1";
/** The fields and buttons under a card's explanation; a Segmented keeps its own width instead of stretching across. */
const FORM = "mt-4 grid gap-3 [&>.segmented]:justify-self-start";
/** A question to confirm (inside a caution alert), or a line with its button: the words, and the buttons on the right. */
const CONFIRM = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2";
/** A card that only tells (where the company stands, how people apply): lavender-tinted, so the white cards that act stand out. */
const TINTED = "border-line-tint bg-tint shadow-none";

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
    <div className="stack gap-4">
      {/* The filter pills, then the search box and the Sort chip on the right (screenshot 7's Filters pill). */}
      <div className="flex flex-wrap items-center gap-2">
        {CUSTOMER_FILTERS.map((f) => (
          <button key={f.id} type="button" className="toggle-chip" aria-pressed={filter === f.id} onClick={() => pick(filter === f.id ? "all" : f.id)}>
            {f.label}
            {q.data ? <>{" "}<span className="count">{count(f.id)}</span></> : null}
          </button>
        ))}
        <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none [&>input]:rounded-full [&>input]:pl-10">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3" />
            {/* `talent-search` is unstyled, kept only because admin-customers-ui.test.ts pins this class string; so the
                pill shape and the icon's room come from the wrapper's [&>input] variants, not from utilities here */}
            <input className="input talent-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers" aria-label="Search customers" />
          </div>
          <Menu label={sort ? `Sort: ${sortChoice(sort.key).label}` : "Sort"} heading="Sort customers" align="end" currentLabel="Now" items={CUSTOMER_SORT_CHOICES.map((c) => ({ id: c.id, label: c.label, current: sort?.key === c.id }))} onSelect={(id) => sortBy(id as CustomerSortKey, "chip")} />
        </div>
      </div>
      {waiting.length ? (
        <Alert tone="caution">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span className="min-w-0 flex-1 basis-80">
              {waiting.length === 1 ? "1 company is" : `${waiting.length} companies are`} waiting for the ITS check: {waiting.map((c) => c.name).join(", ")}. Until you confirm a company, its careers page, job pages and Google listing are offline and its emails to candidates wait.
            </span>
            {filter !== "waiting" ? <Button size="sm" onClick={() => pick("waiting")}>Show only these</Button> : null}
          </div>
        </Alert>
      ) : null}
      {filter === "low" && lowCompanies.length ? (
        <Card needsYou title="AI interviews running low">
          <ul className="grid list-disc gap-1 pl-5 text-[15px] marker:text-ink-3">
            {lowCompanies.map((c) => {
              const a = low.get(c.id);
              return a ? <li key={c.id}><strong>{c.name}</strong>: {allowanceChip(a)}, since {new Date(a.since).toLocaleDateString()}</li> : null;
            })}
          </ul>
          {/* the one thing to do stays in view; the rule behind it folds */}
          <p className="mt-3 text-sm text-ink-2">Talk with each about topping up.</p>
          <details className="more mt-2">
            <summary>How this works</summary>
            <p className="small text-ink-2">Nothing is refused: applications are still accepted, anyone part-way through finishes, and once the allowance is used up new applicants get the chat link by email when more are added or the month starts again. The owners were told too.</p>
          </details>
        </Card>
      ) : null}
      {q.error ? <ErrorState message="Could not load customers." onRetry={() => q.refetch()} /> : (
        <Table
          head={[heading("company"), "ITS check", "Plan and use", heading("activity"), ""]}
          label="Customers"
          loading={q.isLoading ? 4 : undefined}
          empty={narrowed && rows.length ? <div className="flex flex-wrap items-center justify-between gap-3"><span>Nothing matches this filter.</span><Button size="sm" onClick={showAll}>Show all customers</Button></div> : "No customers yet."}
          announce={customerAnnouncement(announce, waiting.length)}
        >
          {shown.map((c) => <CustomerListRow key={c.id} c={c} low={low.get(c.id)} now={now} onOpen={(tab) => showDrawer({ id: c.id, tab })} />)}
        </Table>
      )}
      {opened && drawer ? <CustomerDrawer company={opened} low={low.get(opened.id)} tab={drawer.tab} onTab={(tab) => showDrawer({ id: opened.id, tab })} onClose={() => showDrawer(null)} /> : null}
    </div>
  );
}

/**
 * One customer in the list (screenshot 7's Businesses): a square initial and the name over its kind of business, the ITS
 * check as a pill with a dot, plan and use, last active, and one button.
 */
function CustomerListRow({ c, low, now, onOpen }: { c: CustomerRow; low: AllowanceAlert | undefined; now: number; onOpen: (tab: CustomerTab) => void }) {
  const verified = !!c.verifiedAt;
  const activity = activityWords(c.lastActivityAt, now);
  const usage = c.screeningConversations;
  return (
    <tr>
      <td>
        <div className="flex items-center gap-3">
          <Avatar name={c.name} shape="square" />
          <div className="grid min-w-0 justify-items-start gap-0.5">
            <button type="button" className={NAME} onClick={() => onOpen("overview")}>{c.name}</button>
            <div className="small muted">{c.vertical} · {c.sizeBand}</div>
          </div>
        </div>
      </td>
      <td>
        <div className={CELL}>
          {verified ? <Pill tone="good" size="sm">Confirmed</Pill> : <Pill tone="caution" size="sm" title={exactWhen(c.createdAt)}>{waitingWords(c.createdAt, now)}</Pill>}
          {c.heldMessages ? <div className="small muted">{plural(c.heldMessages, "message", "messages")} held</div> : null}
        </div>
      </td>
      <td>
        <div className={CELL}>
          <div className={LINE}>{planLine(c, true)}</div>
          {/* The Trial plan's 30 days (L-02 B): when they end, or that they ended and new applications are paused. */}
          <TrialStandingLine c={c} />
          {usage ? <div className="small muted">{usage.used}{usage.limit !== null ? ` of ${usage.limit}` : ""} chats this month</div> : null}
          {low ? <span title={allowanceChip(low)}><Chip tone="caution">{low.level === "used_up" ? "Used up" : "Running low"}</Chip></span> : null}
        </div>
      </td>
      <td>
        <div className={CELL}>
          {/* never active: the chip alone says so ("never active") */}
          {c.lastActivityAt ? <div className={LINE} title={exactWhen(c.lastActivityAt)}>{whenWords(c.lastActivityAt, new Date(now))}</div> : null}
          {activity.state !== "active" ? <Chip tone={activity.tone}>{activity.label}</Chip> : null}
        </div>
      </td>
      <td className="text-right">
        <Button size="sm" variant={verified ? "secondary" : "primary"} ariaLabel={`${verified ? "Open" : "Confirm"} ${c.name}`} onClick={() => onOpen(verified ? "overview" : "check")}>{verified ? "Open" : "Confirm"}</Button>
      </td>
    </tr>
  );
}

/**
 * One customer (redesign spec 3.2): a 640 px drawer named by the company, its facts under the name, and five tabs: the
 * Overview, then the bodies of the four sheets the console had before (ITS check, Plan, How people apply, Report), with
 * the same actions; their words follow the fewer-words rule (23 Oct 2026). Every "Change" on the Overview switches to
 * its tab. The header is the one place the company's facts are said, so a missing website is said there too ("no
 * website given"): the ITS check asks staff to look at the website.
 */
function CustomerDrawer({ company, low, tab, onTab, onClose }: { company: CustomerRow; low: AllowanceAlert | undefined; tab: CustomerTab; onTab: (tab: CustomerTab) => void; onClose: () => void }) {
  const sub = [company.vertical, `${company.sizeBand} employees`, company.settings.website || "no website given", `signed up ${whenWords(company.createdAt)}`].filter(Boolean).join(" · ");
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

/** A fact with its button on the right (the whole width of its value, also inside a CELL stack). */
function Fact(props: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 justify-self-stretch">
      <span className="min-w-0">{props.children}</span>
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
    <div className="stack gap-5">
      {/*
        "At a glance" (screenshot 7): one card of the kit's glance rows, each label beside its fact (over it on a phone), a
        hairline between them, outlined buttons. A value with more than one line stacks them (CELL), so a chip after a line
        sits on its own line with a little room.
      */}
      <Card>
        <dl className="glance">
          <dt>ITS check</dt>
          <dd>
            <Fact action={<Button size="sm" variant={verified ? "secondary" : "primary"} ariaLabel={verified ? "Change the ITS check" : undefined} onClick={() => onTab("check")}>{verified ? "Change" : "Confirm"}</Button>}>
              {/* the sign-up date is in the drawer's header; its exact time is the tooltip */}
              {verified ? `Confirmed ${exactWhen(c.verifiedAt)}${c.verifiedBy?.name ? ` by ${c.verifiedBy.name}` : ""}` : <span title={exactWhen(c.createdAt)}>{waitingWords(c.createdAt)}</span>}
            </Fact>
          </dd>
          <dt>Job boards</dt>
          <dd>{c.jobBoardsConfirmedAt ? "ITS can sign in" : "Not confirmed yet"}</dd>
          <dt>Plan</dt>
          <dd className={CELL}>
            <Fact action={<Button size="sm" variant="secondary" onClick={() => onTab("plan")}>Change plan</Button>}>{planLine(c)}</Fact>
            <TrialStandingLine c={c} />
            {c.seats && c.seats.limit !== null ? <div className="small muted" title={SEATS_NOTE}>{seatsWords(c.seats)}</div> : null}
            {extensionLines(c.trialTerm, c.timezone).map((line) => <div key={line.key} className="small muted">{line.text}</div>)}
            {c.screeningConversations ? <div className="small muted">{screeningLine(c.screeningConversations)}</div> : null}
            {low ? <Chip tone="caution">{allowanceChip(low)}</Chip> : null}
          </dd>
          <dt>How people apply</dt>
          <dd>
            <Fact>The same for everyone: the form, then the AI interview</Fact>
          </dd>
          <dt>Applicants' match score</dt>
          <dd>
            <Fact action={<Button size="sm" variant="secondary" ariaLabel="Change whether applicants see their match score" onClick={() => onTab("apply")}>Change</Button>}>{candidateScoreWords(candidateScoreOn(c))}</Fact>
          </dd>
          <dt>Jobs</dt>
          <dd>{plural(c.roles, "job", "jobs")} · {plural(c.applications, "applicant", "applicants")}</dd>
          <dt>Recruiter requests</dt>
          <dd className={CELL}>
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
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button icon="chart" onClick={() => onTab("report")}>See the report</Button>
      </div>
    </div>
  );
}

/** "122 of 150 screening chats this month, resets October 30" (the reset date when the API gives one). */
export function screeningLine(u: { used: number; limit: number | null; resetsAt?: string | null }): string {
  const resets = u.resetsAt ? `, resets ${new Date(u.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
  return `${u.used}${u.limit !== null ? ` of ${u.limit}` : ""} AI interviews this month${resets}`;
}

export type PlanOption = { key: string; name: string; limits: Record<string, number | null> };
const LIMIT_WORDS: Array<[string, string]> = [["active_roles", "active jobs"], ["text_screens", "AI interviews a month"], ["recruiter_asks", "recruiter requests a month"], ["seats", "seats"]];

/** What a plan includes, in one line: "3 active jobs · 300 screening chats a month · 10 recruiter requests a month · unlimited seats". */
export function planLimitsLine(limits: Record<string, number | null>): string {
  return LIMIT_WORDS.filter(([k]) => k in limits).map(([k, words]) => `${limits[k] === null ? "unlimited" : limits[k]} ${words}`).join(" · ");
}

/** The toast after a plan change; `endedTrial` when the change took the customer off the Trial plan (founder decision L-02 B). */
export function planChangedToast(company: string, plan: string, endedTrial = false): { title: string; detail: string } {
  const limits = "The new limits apply at once. This month's usage stays; the reset date does not move.";
  return { title: `${company} is on ${plan} now.`, detail: endedTrial ? `The trial has ended; new applications are open again. ${limits}` : limits };
}

/** "2 of 3 people": the Trial plan's people (founder decision L-02 B); what counts is SEATS_NOTE, the line's tooltip. */
export function seatsWords(seats: { used: number; limit: number | null }): string {
  return `${seats.used}${seats.limit !== null ? ` of ${seats.limit}` : ""} people`;
}

/** Why the people in use can be more than the team shows: the tooltip on the seats line. */
export const SEATS_NOTE = "Invitations not yet answered count too.";

/** Each extension of a trial, oldest first: "Extended by 14 days on Oct 20 by Sam, to Nov 13: the owner's kick-off moved." */
export function extensionLines(term: TrialTerm | null | undefined, timeZone?: string | null): Array<{ key: string; text: string }> {
  return (term?.extensions ?? []).map((e) => ({ key: `${e.at}|${e.to}`, text: `Extended by ${e.days} ${e.days === 1 ? "day" : "days"} on ${trialDate(e.at, timeZone, { short: true })}${e.by.name ? ` by ${e.by.name}` : ""}, to ${trialDate(e.to, timeZone, { short: true })}: ${e.reason}` }));
}

const DAY_MS = 86_400_000;
/** The longest one extension may be (the API refuses more, TrialExtensionRequest). */
export const TRIAL_EXTENSION_MAX_DAYS = 90;

/** Where an extension by `days` would take the trial: from the later of its end and now, as the API counts it. */
export function trialExtendedTo(trial: Pick<TrialStanding, "endsAt">, days: number, now: number = Date.now()): string {
  const end = trial.endsAt ? Date.parse(trial.endsAt) : now;
  return new Date(Math.max(Number.isFinite(end) ? end : now, now) + days * DAY_MS).toISOString();
}

/** A number of days the API takes: a whole number from 1 to 90. */
export function extensionDaysOk(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= TRIAL_EXTENSION_MAX_DAYS;
}

/** The confirm line before an extension: "Extend Bright Dental's trial by 14 days, to November 13?" */
export function trialExtensionQuestion(company: string, days: number, to: string, timeZone?: string | null): string {
  return `Extend ${company}'s trial by ${days} ${days === 1 ? "day" : "days"}, to ${trialDate(to, timeZone)}?`;
}

/** The toast once it is extended. */
export function trialExtendedToast(to: string, timeZone?: string | null): string {
  return `Trial extended to ${trialDate(to, timeZone)}.`;
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
    mutationFn: () => api.post<{ trialEnded?: boolean }>(`/api/v1/admin/customers/${company.id}/plan`, { planKey: pick, reason: why.trim() }, reason),
    onSuccess: (r) => {
      const t = planChangedToast(company.name, chosen?.name ?? pick, !!r?.trialEnded);
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
    <div className="stack gap-4">
      <Card title="Pick a plan">
        <p className="small muted">Now on {planWords(company.planKey)}.{company.screeningConversations ? ` ${screeningLine(company.screeningConversations)}.` : ""}</p>
        {plans.isLoading ? <Skeleton lines={3} /> : plans.error ? <ErrorState message="Could not load the plans." onRetry={() => plans.refetch()} /> : (
          <div className={FORM}>
            <Field label="Plan" htmlFor="plan-pick">
              <select id="plan-pick" className="select" value={pick} onChange={(e) => { setPick(e.target.value); setConfirming(false); }}>
                {(plans.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </Field>
            {chosen ? <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">{planLimitsLine(chosen.limits)}</p> : null}
            {pick !== company.planKey ? (
              <>
                <Field label="Why (required, kept with the change)" htmlFor="plan-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="plan-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
                {confirming ? (
                  <Alert tone="caution"><div className={CONFIRM}><span>Put {company.name} on {chosen?.name ?? pick}?</span><span className="row"><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Yes, change it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
                ) : <div className="row"><Button variant="primary" disabled={!reasonReady(why)} onClick={() => setConfirming(true)}>Change plan</Button><Button variant="quiet" onClick={() => { setPick(company.planKey); setWhy(""); }}>Cancel</Button></div>}
              </>
            ) : null}
          </div>
        )}
      </Card>
      {company.trial?.started && company.trial.endsAt ? <TrialExtensionCard company={company} trial={company.trial} /> : null}
    </div>
  );
}

/**
 * "Extend the trial" (founder decision L-02 B), on the Plan tab of a customer on the Trial plan whose 30 days have
 * started: a number of days (1 to 90) and a reason, then a second press to confirm. The new end counts from the later of
 * the old end and today (POST /admin/customers/:id/trial); the extension is audited with the reason, the owners are told,
 * the "trial ended" alert is resolved and a paused company takes applications again.
 */
function TrialExtensionCard({ company, trial }: { company: CustomerRow; trial: TrialStanding }) {
  const qc = useQueryClient();
  const [days, setDays] = useState("14");
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const count = Number(days);
  const ready = extensionDaysOk(count) && reasonReady(why);
  const to = trialExtendedTo(trial, extensionDaysOk(count) ? count : 0);
  const extend = useMutation({
    mutationFn: () => api.post<{ trial: TrialStanding | null }>(`/api/v1/admin/customers/${company.id}/trial`, { days: count, reason: why.trim(), confirm: true }, reason),
    onSuccess: (r) => {
      toast(trialExtendedToast(r.trial?.endsAt ?? to, company.timezone));
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      qc.invalidateQueries({ queryKey: ["admin", "alerts"] });
    },
    onError: (e) => { setConfirming(false); toast(e instanceof ApiError ? e.message : "Could not extend the trial."); },
  });
  return (
    <Card title="Extend the trial">
      <p className="small muted">{trial.ended ? `The trial ended on ${trialDate(trial.endsAt ?? "", company.timezone)}: new applications, new jobs and new AI interviews are paused.` : `The trial ends on ${trialDate(trial.endsAt ?? "", company.timezone)}.`} An extension counts from the later of the end and today. The owners are told, and they see your reason in their activity history.</p>
      <div className={FORM}>
        <Field label="Days to add" htmlFor="trial-days" hint={`From 1 to ${TRIAL_EXTENSION_MAX_DAYS}.`}><input id="trial-days" className="input" type="number" inputMode="numeric" min={1} max={TRIAL_EXTENSION_MAX_DAYS} step={1} value={days} onChange={(e) => { setDays(e.target.value); setConfirming(false); }} /></Field>
        {/* the card's line above already says the owners see the reason, so the hint keeps only the rule */}
        <Field label="Why (required, kept with the change)" htmlFor="trial-why" hint={`At least ${REASON_MIN} characters.`}><input id="trial-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
        {confirming ? (
          <Alert tone="caution"><div className={CONFIRM}><span>{trialExtensionQuestion(company.name, count, to, company.timezone)}</span><span className="row"><Button size="sm" variant="primary" loading={extend.isPending} onClick={() => extend.mutate()}>Yes, extend it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
        ) : <div className="row"><Button variant="primary" disabled={!ready} onClick={() => setConfirming(true)}>Extend the trial</Button></div>}
      </div>
    </Card>
  );
}

/**
 * How a customer's applicants apply (plan E1). Since 20 October 2026 (R20-12) ITS's "apply and talk in one visit" switch
 * is hidden and ignored: every applicant takes the same path, said here in one line. What ITS still sets on this tab is
 * whether applicants see their match score (S7-1).
 */
function ApplyFlowPanel({ company }: { company: CustomerRow }) {
  return (
    <div className="stack gap-4">
      {/* a fact with nothing to change: a tinted card */}
      <Card title="How people apply" className={TINTED}>
        <p className="small muted">{EVERY_APPLICANT_LINE}</p>
      </Card>
      <CandidateScorePanel company={company} />
    </div>
  );
}

/** Whether a customer's applicants see their match score after sending (founder decision S7-1): on unless ITS turned it off. */
export function candidateScoreOn(c: Pick<CustomerRow, "candidateScoreShown">): boolean {
  return c.candidateScoreShown !== false;
}

/** The Overview's words for the switch. */
export function candidateScoreWords(on: boolean): string {
  return on ? "Shown to applicants after they send" : "Not shown to applicants";
}

/** The toast after the switch was saved. */
export function candidateScoreToast(company: string, shown: boolean, changed: boolean): { title: string; detail: string } {
  if (!changed) return { title: `Nothing changed for ${company}.`, detail: shown ? "Applicants already see their match score after they send." : "Applicants already do not see their match score." };
  return shown
    ? { title: `${company}'s applicants see their match score now.`, detail: "It shows on each application record once the application is sent, with the breakdown. The customer sees the change in their activity history." }
    : { title: `${company}'s applicants no longer see their match score.`, detail: "Their application records stop showing it at once. The team still sees every score. The customer sees the change in their activity history." };
}

type ScoreChoice = "shown" | "hidden";

/**
 * The ITS switch for the match score applicants see (founder decision S7-1; Wave S7, S7-E): on by default, per
 * company. Every change needs a reason, which is audited and kept with who made it (POST
 * /admin/customers/:id/candidate-score). Counsel items 1 and 21: a lawyer reviews it before real candidates in NYC, IL,
 * CA or CO.
 */
function CandidateScorePanel({ company }: { company: CustomerRow }) {
  const qc = useQueryClient();
  const current: ScoreChoice = candidateScoreOn(company) ? "shown" : "hidden";
  const [choice, setChoice] = useState<ScoreChoice>(current);
  const [why, setWhy] = useState("");
  const setBy = company.settings.candidateScoreSetBy;
  const save = useMutation({
    mutationFn: () => api.post<{ shown: boolean; changed: boolean }>(`/api/v1/admin/customers/${company.id}/candidate-score`, { shown: choice === "shown", reason: why.trim() }, reason),
    onSuccess: (r) => {
      const t = candidateScoreToast(company.name, r.shown, r.changed);
      toast(t.title, t.detail);
      setWhy("");
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the switch."),
  });
  return (
    <Card title="Applicants' match score">
      {/* the legal review (counsel items 1 and 21) stays in view; what applicants see folds under "How this works" */}
      <p className="small muted">A lawyer reviews this before it is used with real applicants in New York City, Illinois, California or Colorado.</p>
      {setBy ? <p className="small muted mt-1.5">Last set {exactWhen(setBy.at)}{setBy.by.name ? ` by ${setBy.by.name}` : ""}: {setBy.reason}</p> : null}
      <details className="more mt-3">
        <summary>How this works</summary>
        <p className="small text-ink-2">After sending, each applicant of {company.name} sees their match score on their application record: the number, and how it breaks down against the requirements on the job page. Other requirements fold into one line; the team's private notes never show.</p>
      </details>
      <div className={FORM}>
        <Segmented value={choice} onChange={setChoice} ariaLabel="Applicants' match score" options={[{ value: "shown", label: "Show it" }, { value: "hidden", label: "Don't show it" }]} />
        {choice !== current ? (
          <>
            <Field label="Why (required, kept with the change)" htmlFor="candidate-score-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="candidate-score-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
            <div className="row"><Button variant="primary" disabled={!reasonReady(why)} loading={save.isPending} onClick={() => save.mutate()}>Save</Button><Button variant="quiet" onClick={() => { setChoice(current); setWhy(""); }}>Cancel</Button></div>
          </>
        ) : null}
      </div>
    </Card>
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
    <div className="stack gap-4">
      {/*
        where the company stands: a tinted card; the cards that act on it stay white. Its facts (kind, size, website, when
        it signed up) are the drawer's header, in view above every tab, so they are not said again here.
      */}
      <Card title="The company" className={TINTED}>
        <div className="grid gap-1.5">
          <p className="text-sm text-ink-2">{verified ? `Confirmed ${new Date(company.verifiedAt ?? "").toLocaleString()}${company.verifiedBy?.name ? ` by ${company.verifiedBy.name}` : ""}.` : "Not confirmed yet: its careers page, job pages and Google listing are offline, and its emails to candidates wait. It can draft and approve roles."}</p>
          {company.heldMessages && !verified ? <p className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} held and will go out when you confirm.</p> : null}
          {company.heldMessages && verified ? (
            <div className={cn(CONFIRM, "mt-1")}>
              <span className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} still held although the company is confirmed.</span>
              <Button size="sm" variant="primary" loading={release.isPending} onClick={() => release.mutate()}>Send the held messages</Button>
            </div>
          ) : null}
        </div>
      </Card>
      <Card title={verified ? "Take the confirmation back" : "Confirm the company"}>
        <p className="small muted">{verified ? "Its careers page, job pages and feeds go offline at once and its messages to candidates wait again. Roles, candidates and decisions are kept." : "Confirm only after checking the company is real: the kick-off call, its website, a phone number. Its pages go public, approved roles are published and held messages go out."} The owners are told, and they see your reason in their activity history.</p>
        <div className={FORM}>
          <Field label={verified ? "Why you are taking it back" : "How you checked the company"} htmlFor="co-check-why"><input id="co-check-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className={CONFIRM}><span>{verified ? `Take back the confirmation of ${company.name}?` : `Confirm ${company.name} and make its pages public?`}</span><span className="row"><Button size="sm" variant={verified ? "destructive" : "primary"} loading={change.isPending} onClick={() => change.mutate()}>{verified ? "Yes, take it back" : "Yes, confirm it"}</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant={verified ? "secondary" : "primary"} disabled={why.trim().length < 5} onClick={() => setConfirming(true)}>{verified ? "Take back the confirmation" : "Confirm the company"}</Button></div>}
        </div>
      </Card>
      <Card title="Job-board access">
        {/* the button says what it records; when to press it, and what it ticks for the owner, folds */}
        <details className="more">
          <summary>How this works</summary>
          <p className="small text-ink-2">The owner adds the ITS recruiter as a user on the company's LinkedIn, Indeed and ZipRecruiter accounts. Record here once ITS can sign in to each; it ticks the owner's getting-started step.</p>
        </details>
        <div className="row mt-3">
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
