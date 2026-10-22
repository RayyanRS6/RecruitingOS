"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "../nav";
import { Alert, Button, Card, cn, ErrorState, Icon, IconChip, Menu, PageHeader, Pill, SectionHeader, Skeleton, type Tone } from "@ros/ui";
import type { GettingStartedAction, TrialStanding } from "@ros/contracts";
import { api, ApiError, type Brief, type BriefCard, type ClosingDateResponse, type InterviewDraft, type Me, type Notification, type RoleSummary } from "../api/client";
import { ALLOWANCE_ASK, screeningAllowanceWarning, type AllowanceWarning, type UsageLine } from "../allowance";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";
import { RecruiterRequests } from "../components/RecruiterRequests";
import { useIsClient } from "../components/use-is-client";
import { interviewDraftPath } from "../hiring";
import { closingDateToast, isClosingDateAction } from "../publishing";
import { railListsRoles } from "../rail";
import { roleStatus } from "../role-status";
import { canChangeCompany, canStartHire } from "../roles";
import { presetOf, requestSentText } from "../recruiter-access";
import { START_HIRE_HREF } from "../start-hire";
import { briefDecisionToast } from "../talent-actions";
import { TRIAL_ASK, trialRow, type TrialRowWords } from "../trial";
import { HOME_ROWS, TODAY_REFRESH, cardLine, firstName, homeHeadline, homeJobs, homeRows, isFyi, moreLabel, nextStep, setupActionToast, splitActions, type HomeJob } from "../today";
import { POOL_CARD_NOTE, boardPersonPath, poolCardView } from "./board/board-model";
import { isDiscardDraft } from "./new-role/rules";
import { TodayStart } from "./new-role/TodayStart";

/**
 * A list's first appearance (spec 4): ENTER fades a row up, `stagger` starts each 30ms after the one above (the ninth and
 * later with the eighth). Filled backwards only, as the page's own template does: once it ends the row keeps no
 * transform or opacity, so it is no containing block or stacking context for the menus and sheets drawn inside it.
 */
const ENTER = "motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]";
const stagger = (i: number): CSSProperties | undefined => (i ? { animationDelay: `${Math.min(i, 7) * 30}ms` } : undefined);

/**
 * Home (docs/07; the simple, Kanvis-like Home of 14 October 2026), top to bottom: the greeting with one line on how
 * many things need you, Start a hire and Bring in a recruiter; getting started while the company is being set up;
 * "Needs you", one short row per card of the morning brief (its first sentence and its buttons, the rest behind "Why",
 * five at a time); "Your jobs", each opening on its Candidates once live; the "Who are you hiring?" box, which hands
 * over to the job builder at /roles/new (plan C4, founder decision Q5); your recruiter requests; and the assistant's
 * recent activity, folded. The conversation that drafts a job lives in the job builder; Home keeps none of its own.
 */
export function Home() {
  const nav = useNavigate();
  // Home keeps itself current (plan B9): on focus, and every minute while it is open and visible (today.ts).
  const brief = useQuery({ queryKey: ["brief"], queryFn: () => api.get<Brief>("/api/v1/brief"), ...TODAY_REFRESH });
  // Starting a hire is gated by role.create on the server; the box and the button only appear for the roles that hold it.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
  const mayStartHire = canStartHire(myRole);
  const [sentToRecruiter, setSentToRecruiter] = useState<string | null>(null);
  // The plan's screening conversations at 80% or used up (Q17): owners and admins, who can talk to ITS about the plan.
  const seesAllowance = canChangeCompany(myRole);
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<{ planKey?: string; timezone?: string; usage?: Record<string, UsageLine>; trial?: TrialStanding | null }>("/api/v1/companies/current"), enabled: seesAllowance, ...TODAY_REFRESH });
  const allowance = seesAllowance ? screeningAllowanceWarning(company.data?.usage, company.data?.planKey) : null;
  // The Trial plan's last 7 days, and its end (founder decision L-02 B): owners and admins, the first row under Needs you.
  const trial = seesAllowance ? trialRow(company.data?.trial, company.data?.timezone) : null;
  // "Your jobs" is the rail's list (the same request, shared): members only, never an ITS recruiter under a grant.
  const listsRoles = railListsRoles(me.data);
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles"), enabled: listsRoles });
  // The browser may have read that list before it takes this page over; the server never has it. Until the page is the
  // browser's (use-is-client.ts), "Your jobs" waits, so the first draw matches the server's (Wave S2).
  const isClient = useIsClient();
  const jobs = listsRoles && isClient ? homeJobs(roles.data ?? [], { role: myRole }) : [];

  // Old links and bookmarks to "/?start=1" (before the job builder had a page of its own) go to the job builder.
  const [params] = useSearchParams();
  const wantsStart = params.get("start") === "1";
  const moved = useRef(false);
  useEffect(() => {
    if (!wantsStart || moved.current) return;
    moved.current = true;
    nav(START_HIRE_HREF, { replace: true });
  }, [wantsStart, nav]);

  const { setup, rows, empty } = homeRows(brief.error ? [] : brief.data?.cards ?? []);
  const setupOpen = !!setup?.gettingStarted?.steps.some((s) => !s.done);
  const needs = rows.filter((c) => !isFyi(c.kind)).length + (trial ? 1 : 0) + (allowance ? 1 : 0) + (setupOpen ? 1 : 0);
  // A company's first screen (nothing yet, and this person may start a hire) is a first step, not "nothing waiting" (plan C18).
  const firstRun = !!empty && empty.actions.some((a) => a.path === START_HIRE_HREF);
  const name = firstName(me.data?.user.name);

  // The trial and allowance rows do not wait for the brief: they come from the company's own plan and usage.
  const needsBlock = rows.length || allowance || trial ? (
    <NeedsYou title={needs > 0 ? "Needs you" : "Good to know"} items={[
      ...(trial ? [{ key: "trial", node: <TrialRow row={trial} onSentToRecruiter={setSentToRecruiter} /> }] : []),
      ...(allowance ? [{ key: "allowance", node: <AllowanceRow warning={allowance} onSentToRecruiter={setSentToRecruiter} /> }] : []),
      ...rowKeys(rows).map(({ key, card }) => ({ key, node: card.kind === "pool_ready" && card.pool && card.roleId ? <PoolRow card={card} /> : <CardRow card={card} onSentToRecruiter={setSentToRecruiter} /> })),
    ]} />
  ) : empty ? (
    <Card className="max-sm:p-5"><CardRow card={empty} level={2} onSentToRecruiter={setSentToRecruiter} /></Card>
  ) : null;
  // "Your jobs" sits beside Needs you on a wide screen (screenshot 1's "Open roles"), and after it for the keyboard and
  // screen readers; on smaller screens it comes under it. The column is decided from what the first draw already knows
  // (whether this person has a jobs list), not from the list's arrival: while the list is coming (always on the first
  // draw) a quiet placeholder holds the column, and while the brief is coming Your jobs waits with it, so neither column
  // jumps sideways when the other fills in.
  const jobsComing = listsRoles && (!isClient || roles.isPending);
  const beside = !!needsBlock && (jobsComing || jobs.length > 0);
  const showJobs = jobs.length > 0 && (!!needsBlock || !brief.isLoading);

  return (
    <div className="stack gap-6 md:gap-8 [&>.page-header]:mb-0 [&_.page-header-row>h1]:text-[36px] sm:[&_.page-header-row>h1]:text-[44px] md:[&_.page-header-row>h1]:text-[52px]">
      <PageHeader
        eyebrow="Your desk"
        title={`Good ${greeting(isClient)}${name ? `, ${name}` : ""}`}
        sub={brief.data && !brief.error ? homeHeadline(needs, { firstRun }) : undefined}
        actions={
          <>
            {mayStartHire ? <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link> : null}
            <AskRecruiter />
          </>
        }
      />

      {/* A row's one-click request says what the recruiter will see and until when, and stays until read (the row itself may go). */}
      {sentToRecruiter ? <Alert tone="info"><div className="row justify-between"><span>{sentToRecruiter}</span><Button size="sm" variant="quiet" onClick={() => setSentToRecruiter(null)}>Got it</Button></div></Alert> : null}
      {brief.isLoading ? <Skeleton lines={3} /> : brief.error ? <ErrorState message="Could not load what needs you." onRetry={() => brief.refetch()} /> : setup ? <GettingStartedCard card={setup} onSentToRecruiter={setSentToRecruiter} /> : null}

      {needsBlock || showJobs ? (
        <div className={cn("grid min-w-0 items-start gap-6", beside && "xl:grid-cols-[minmax(0,1fr)_320px]")}>
          {needsBlock}
          {showJobs ? <YourJobs jobs={jobs} /> : beside ? <JobsPlaceholder /> : null}
        </div>
      ) : null}

      {mayStartHire ? <TodayStart /> : null}

      <RecruiterRequests />

      <RecentActivity summary={brief.data?.summary ?? null} />
    </div>
  );
}

/**
 * The time of day by the reader's own clock once the page is theirs. Until then (the server's draw and the browser's
 * first one) both go by the hour in UTC, the hosted server's own clock, so they say the same and the greeting changes
 * no more often than it did.
 */
function greeting(local: boolean): string {
  const now = new Date();
  const h = local ? now.getHours() : now.getUTCHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

/** A steady key for each row (the cards carry no id of their own), so a row keeps its state when one above it goes. */
function rowKeys(cards: BriefCard[]): Array<{ key: string; card: BriefCard }> {
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const base = [card.kind, card.approvalRequestId, card.applicationId, card.roleId, card.title].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, card };
  });
}

/**
 * "Needs you" (screenshot 1's "Applications to pick up"): the heading over one bordered list, a row per thing, five
 * rows, then the rest behind "Show N more" inside the same list. The list is the `card` the end-to-end tests look in.
 */
function NeedsYou({ title, items }: { title: string; items: Array<{ key: string; node: ReactNode }> }) {
  const shown = items.slice(0, HOME_ROWS);
  const later = items.slice(HOME_ROWS);
  const list = (part: typeof items, from: number) => (
    <ul className="divide-y divide-line">
      {part.map((r, i) => <li key={r.key} className={cn("px-4 py-4 sm:px-5", ENTER)} style={stagger(from + i)}>{r.node}</li>)}
    </ul>
  );
  return (
    <section className="min-w-0">
      <SectionHeader title={title} />
      <div className="card p-0">
        {list(shown, 0)}
        {later.length ? (
          <details className="more border-t border-line [&>summary]:px-4 [&>summary]:py-3 sm:[&>summary]:px-5 [&[open]>summary]:mb-0">
            <summary>{`Show ${later.length} more`}</summary>
            <div className="border-t border-line">{list(later, shown.length)}</div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One row: a short title with its word, one line, the buttons, and the rest of the explanation behind a fold whose
 * name says what opens. `level`: the heading level (3 under "Needs you", 2 for a card on its own).
 */
function Row(props: { title: string; pill: ReactNode; line?: string; rest?: ReactNode; moreLabel?: string; level?: 2 | 3; children?: ReactNode; note?: ReactNode }) {
  const Heading = props.level === 2 ? "h2" : "h3";
  const label = props.moreLabel ?? "Why";
  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <Heading className="min-w-0 font-sans text-[15px] font-semibold leading-snug tracking-normal text-ink [overflow-wrap:anywhere]">{props.title}</Heading>
        {props.pill}
      </div>
      {props.line ? <p className="mt-1 text-sm text-ink-2">{props.line}</p> : null}
      {props.children ? <div className="row mt-3">{props.children}</div> : null}
      {props.note}
      {props.rest ? (
        <details className="more mt-2">
          <summary aria-label={`${label}: ${props.title}`}>{label}</summary>
          {props.rest}
        </details>
      ) : null}
    </div>
  );
}

const restText = (text: string) => <p className="small whitespace-pre-wrap text-ink-2">{text}</p>;

/**
 * The month's screening conversations at 80% of the plan's allowance, or used up (founder decision Q17). Nothing stops
 * either way: applications keep coming in, and once the allowance is used up new applicants get the conversation link
 * by email when more are added. The one button opens the request to ITS about the plan, filled in, never sent in one
 * click; talking about the plan never uses one of the plan's recruiter requests.
 */
function AllowanceRow({ warning, onSentToRecruiter }: { warning: AllowanceWarning; onSentToRecruiter: (message: string) => void }) {
  const { line, rest } = cardLine(warning.body);
  return (
    <Row title={warning.title} pill={<Pill size="sm" tone="caution">{warning.level === "used_up" ? "Used up" : "80% used"}</Pill>} line={line} rest={rest ? restText(rest) : null}>
      <AskRecruiter label="Ask ITS about adding more" size="sm" variant="secondary" preset={ALLOWANCE_ASK} onSent={onSentToRecruiter} />
      <Link to="/setup" className="btn quiet sm">See usage</Link>
    </Row>
  );
}

/**
 * The Trial plan's last 7 days, and its end (founder decision L-02 B): "Your trial ends on <date>", then "Your trial has
 * ended" with the one line on what is paused. Choosing a plan is done by ITS, so the button opens the request about the
 * plan, filled in, never sent in one click; "See plan" opens Settings, where the plan and its dates are.
 */
function TrialRow({ row, onSentToRecruiter }: { row: TrialRowWords; onSentToRecruiter: (message: string) => void }) {
  return (
    <Row title={row.title} pill={<Pill size="sm" tone="caution">{row.level === "ended" ? "Trial ended" : "Trial ends soon"}</Pill>} line={row.body}>
      <AskRecruiter label="Ask ITS to choose a plan" size="sm" variant="secondary" preset={TRIAL_ASK} onSent={onSentToRecruiter} />
      <Link to="/setup" className="btn quiet sm">See plan</Link>
    </Row>
  );
}

/** One card of the brief as a row: its buttons answer it from here, or open the page it is about. */
function CardRow({ card, level, onSentToRecruiter }: { card: BriefCard; level?: 2 | 3; onSentToRecruiter: (message: string) => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const needsYou = ["decision", "needs_review", "stuck"].includes(card.kind);
  // A company's first screen (nothing yet, and this person may start a hire) is a first step, not "nothing waiting" (plan C18).
  const firstRun = card.kind === "empty" && card.actions.some((a) => a.path === START_HIRE_HREF);
  // Discarding a draft cannot be undone, so the row asks first (plan C18).
  const [discarding, setDiscarding] = useState<BriefCard["actions"][number] | null>(null);
  const act = useMutation({
    // A closing-date card's "Extend" posts the new date exactly as the card has it (plan D7); nothing else is added.
    mutationFn: (a: BriefCard["actions"][number]) => api.post<unknown>(a.path, isDiscardDraft(a) ? {} : isClosingDateAction(a) ? a.body ?? {} : { ...(a.body ?? {}), question: (a.body as { question?: string } | undefined)?.question ?? `Please review: ${card.title}` }),
    // A request to a recruiter answers with what they will see and until when (Q31); the page keeps those words on screen.
    // An answer to an approval ("Yes", "Not now", "Do not send") says exactly what it did.
    onSuccess: (r, a) => {
      if (isDiscardDraft(a)) { toast("Draft discarded.", "Nothing was sent to anyone."); setDiscarding(null); qc.invalidateQueries({ queryKey: ["intake", "mine"] }); }
      else if (isClosingDateAction(a)) { const t = closingDateToast(r as ClosingDateResponse); toast(t.title, t.detail); if (card.roleId) { qc.invalidateQueries({ queryKey: ["role", card.roleId] }); qc.invalidateQueries({ queryKey: ["postings", card.roleId] }); } }
      else if (a.path.includes("/escalations")) { toast("Sent to a recruiter."); onSentToRecruiter(requestSentText(r)); qc.invalidateQueries({ queryKey: ["escalations", "mine"] }); }
      else { const t = briefDecisionToast(a, r); toast(t.title, t.detail); }
      qc.invalidateQueries({ queryKey: ["brief"] }); qc.invalidateQueries({ queryKey: ["notifications"] });
      if (card.roleId) { qc.invalidateQueries({ queryKey: ["applications", card.roleId] }); qc.invalidateQueries({ queryKey: ["roles"] }); }
      if (card.applicationId) qc.invalidateQueries({ queryKey: ["application", card.applicationId] });
      // "Yes, interview" (plan H4): straight on to the interview approval, filled in from the plan, on the candidate's panel.
      const draft = (r as { interviewDraft?: InterviewDraft | null } | null)?.interviewDraft ?? null;
      const next = interviewDraftPath(draft);
      if (draft && next) { qc.setQueryData(["interview-draft", draft.applicationId], draft); nav(next); }
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "That didn't work."),
  });
  // While one answer is on its way the row's buttons wait, and a pick from its More menu is ignored (the menu's own
  // button stays enabled, so the keyboard's focus is not dropped to the page).
  const run = (a: BriefCard["actions"][number]) => (a.method === "GET" ? nav(a.path) : act.isPending ? undefined : isDiscardDraft(a) ? setDiscarding(a) : act.mutate(a));
  // Asking before a discard replaces the row's buttons: focus moves to "Discard it", so the keyboard is not left on nothing.
  const confirmRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (discarding) (confirmRef.current?.nextElementSibling as HTMLElement | null)?.focus();
  }, [discarding]);
  const { line, rest } = cardLine(card.body);
  const { shown, more } = splitActions(card.actions);
  // Start a hire is Home's one main button: a row's first button is the strong one on the row, the others quiet.
  const button = (a: BriefCard["actions"][number], i: number) => {
    const variant = i === 0 ? "secondary" : "quiet";
    return a.method === "GET"
      ? <Link key={i} to={a.path} className={`btn ${variant} sm`}>{a.label}</Link>
      : <Button key={i} size="sm" variant={variant} loading={act.isPending && act.variables === a} disabled={act.isPending} onClick={() => run(a)}>{a.label}</Button>;
  };
  return (
    <Row title={card.title} level={level} pill={<Pill size="sm" tone={firstRun ? "accent" : cardTone(card.kind, needsYou)}>{firstRun ? "First step" : label(card.kind)}</Pill>} line={line} rest={rest ? restText(rest) : null} moreLabel={moreLabel(card)}>
      {discarding ? (
        <>
          <span ref={confirmRef} className="small basis-full text-ink-2 sm:basis-auto">Discard this draft? It stays in your records but cannot be continued.</span>
          <Button size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate(discarding)}>Discard it</Button>
          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => setDiscarding(null)}>Keep it</Button>
        </>
      ) : card.actions.length ? (
        <>
          {shown.map(button)}
          {more.length ? <Menu label="More" ariaLabel={`More: ${card.title}`} buttonClassName="btn quiet sm" items={more.map((a, i) => ({ id: String(i), label: a.label }))} onSelect={(id) => run(more[Number(id)])} /> : null}
        </>
      ) : null}
    </Row>
  );
}

/**
 * A row's word: amber when it waits on you, ink when a recruiter is involved, green when there is nothing waiting or a
 * job just went live (the day to share it), amber for a closing date that is about to stop applications or did.
 */
function cardTone(kind: string, needsYou: boolean): Tone {
  if (needsYou || kind === "closing_date") return "caution";
  return kind === "escalation" ? "accent" : kind === "empty" || kind === "share" || kind === "hire" ? "good" : "neutral";
}

/** `hire`: "keep your backups warm" until a new hire starts (plan H1). */
function label(kind: string): string {
  return { new_applicants: "New applicants", needs_review: "Needs you", decision: "Decision", posting_action: "One step", escalation: "Recruiter", stuck: "Stuck", screening: "AI interview", interviews: "Your interviews", empty: "Nothing waiting", getting_started: "Getting started", draft: "Draft", closing_date: "Closing date", share: "Live today", pool_ready: "Ready to sort", hire: "New hire" }[kind] ?? kind;
}

/**
 * A job's pool, sorted on the board and waiting for a person (plan F7): the board's first sentence, then the board and
 * Review and apply; the other sentences and up to three next steps naming people (each opens their panel over the
 * board) behind "Why". The row suggests; nothing moves until someone applies it, and nobody is emailed.
 */
function PoolRow({ card }: { card: BriefCard }) {
  const view = poolCardView(card.pool!);
  const [first, ...others] = view.sentences;
  const rest = others.length || view.steps.length ? (
    <div className="stack gap-2">
      {others.length ? <p className="small text-ink-2">{others.join(" ")}</p> : null}
      {view.steps.length ? (
        <div>
          <p className="small muted">Suggested next steps</p>
          <ul className="mt-1.5 grid gap-2">
            {view.steps.map((s) => (
              <li key={s.applicationId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="chip accent">{s.label}</span>
                <span className="small min-w-0 text-ink-2"><Link to={boardPersonPath(card.roleId!, s.applicationId)}>{s.name}</Link>: {s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;
  return (
    <Row title={card.title} pill={<Pill size="sm" tone="good">{label(card.kind)}</Pill>} line={first} rest={rest} note={<p className="small muted mt-2">{POOL_CARD_NOTE}</p>}>
      {card.actions.filter((a) => a.method === "GET").map((a, i) => <Link key={a.path} to={a.path} className={`btn ${i === 0 ? "quiet" : "secondary"} sm`}>{a.label}</Link>)}
    </Row>
  );
}

/**
 * Getting started (plans B1 and B2): while ITS confirms the company, what waits until then (nobody can hide that; one
 * line shows, the rest one click away); then the steps still to do, each with its buttons and why it matters behind
 * "Why", and the steps already done folded underneath. Its buttons send exactly what the card says, except a request to
 * ITS, which opens in the request form first; hiding the steps hides them for this person only.
 */
function GettingStartedCard({ card, onSentToRecruiter }: { card: BriefCard; onSentToRecruiter: (message: string) => void }) {
  const qc = useQueryClient();
  const setup = card.gettingStarted;
  const steps = setup?.steps ?? [];
  const act = useMutation({
    mutationFn: (a: GettingStartedAction) => api.post<unknown>(a.path, a.body ?? {}),
    onSuccess: (_r, a) => {
      const words = setupActionToast(a);
      toast(words.title, words.detail);
      qc.invalidateQueries({ queryKey: ["brief"] });
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "That didn't work."),
  });
  // A request to ITS opens in the request form, filled in: what the recruiter would see, the reply-by time and the plan's
  // recruiter requests are on screen before anything is sent (Q31). Every other button sends exactly what it says.
  const button = (a: GettingStartedAction, primary: boolean) => a.method === "GET"
    ? <Link key={a.label} to={a.path} className={`btn ${primary ? "primary" : "secondary"} sm`}>{a.label}</Link>
    : a.path.includes("/escalations")
      ? <AskRecruiter key={a.label} label={a.label} size="sm" variant={primary ? "primary" : "secondary"} preset={presetOf(a.body)} onSent={onSentToRecruiter} />
      : <Button key={a.label} size="sm" variant={primary ? "primary" : "secondary"} loading={act.isPending && act.variables === a} disabled={act.isPending} onClick={() => act.mutate(a)}>{a.label}</Button>;
  const next = nextStep(steps);
  const todo = steps.filter((s) => !s.done);
  const done = steps.filter((s) => s.done);
  const hide = card.actions.find((a) => a.method === "POST");
  const unverified = setup?.verified === false;
  const { line, rest } = cardLine(card.body);
  // Screenshot 1's "Your next step" hero: the lavender-to-peach wash, a coral-dot eyebrow while a step is still to do, the
  // title in display type, then the steps as a short checklist with the next one raised; the done ones stay folded.
  return (
    <Card needsYou className="max-sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-2.5">
          {next ? <p className="eyebrow live">Your next step</p> : null}
          <h2 className="font-display text-[28px] font-bold leading-[1.08] tracking-[-0.035em] text-ink [overflow-wrap:anywhere] md:text-[34px]">{card.title}</h2>
        </div>
        {unverified ? <Pill size="sm" tone="caution">Waiting for ITS</Pill> : null}
      </div>
      {line ? <p className="mt-2.5 max-w-[62ch] text-[15px] text-ink-2">{line}</p> : null}
      {rest ? (
        <details className="more mt-3">
          <summary>{unverified ? "What waits until then" : "Why"}</summary>
          {restText(rest)}
        </details>
      ) : null}
      {todo.length ? (
        <ol aria-label="Steps to get started" className="mt-5 grid gap-2.5">
          {todo.map((s, n) => (
            <li key={s.key} className={cn("flex items-start gap-3 rounded-2xl border p-4", ENTER, s === next ? "border-line-tint bg-surface shadow-sm" : "border-line bg-surface/70")} style={stagger(n)}>
              <span aria-hidden="true" className={cn("mt-0.5 size-[18px] flex-none rounded-full border-[1.5px]", s === next ? "border-primary bg-tint" : "border-dashed border-line-strong")} />
              <div className="min-w-0 flex-1">
                <strong>{s.title}</strong>
                <span className="sr-only"> (not done yet)</span>
                {s.detail ? <p className="small mt-0.5 text-ink-2">{s.detail}</p> : null}
                {s.actions.length ? <div className="row mt-3">{s.actions.map((a, i) => button(a, s === next && i === 0))}</div> : null}
                <details className="more mt-2">
                  <summary aria-label={`Why: ${s.title}`}>Why</summary>
                  <p className="small muted">{s.why}</p>
                </details>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {done.length ? (
        <details className="more mt-4">
          <summary>{`Done (${done.length})`}</summary>
          <ul aria-label="Steps done" className="grid gap-1">
            {done.map((s) => (
              <li key={s.key} className="flex items-start gap-3 py-1.5">
                <span className="mt-px flex-none text-good"><Icon name="check-circle" size={18} label="Done" /></span>
                <div className="min-w-0 flex-1">
                  <strong className="text-ink-3">{s.title}</strong>
                  {s.detail ? <p className="small mt-0.5 text-ink-2">{s.detail}</p> : null}
                  <p className="small muted mt-0.5">{s.why}</p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {setup?.dismissible && hide ? <div className="row mt-2 justify-end"><Button size="sm" variant="quiet" loading={act.isPending && act.variables === hide} disabled={act.isPending} onClick={() => act.mutate(hide)}>{hide.label}</Button></div> : null}
    </Card>
  );
}

/**
 * "Your jobs" (the Kanvis way; screenshot 1's "Open roles" side card): one row per job being worked on, each opening on
 * its Candidates once it is live. It arrives once the page is the browser's, so it fades in rather than popping.
 */
function YourJobs({ jobs }: { jobs: HomeJob[] }) {
  if (!jobs.length) return null;
  return (
    <section className="side-card motion-safe:animate-fade motion-safe:[animation-fill-mode:backwards]" aria-labelledby="home-jobs">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="home-jobs">Your jobs</h2>
        <Link to="/roles" className="text-link pointer-coarse:min-h-10">All jobs<Icon name="arrow-right" size={16} /></Link>
      </div>
      <div className="grid">
        {jobs.map((j) => {
          const s = roleStatus(j.status);
          return (
            <Link key={j.id} to={j.href} className="list-row">
              <IconChip icon="briefcase" size="sm" />
              <span className="list-row-main">
                <span className="list-row-title whitespace-normal [overflow-wrap:anywhere]">{j.title}</span>
                <span className="list-row-meta">
                  {j.facts ? <span>{j.facts}</span> : null}
                  <Pill size="sm" tone={s.tone}>{s.label}</Pill>
                </span>
              </span>
              <span className="chev"><Icon name="arrow-up-right" size={16} /></span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Holds Your jobs' column beside Needs you while the jobs list is coming, so Needs you does not narrow when it arrives.
 * Only where the column is beside (xl up); on smaller screens Your jobs simply comes in under Needs you. Says nothing.
 */
function JobsPlaceholder() {
  return (
    <div aria-hidden="true" className="side-card hidden gap-3 xl:grid">
      <div className="skeleton h-5 w-2/5" />
      <div className="skeleton h-11" />
      <div className="skeleton h-11" />
    </div>
  );
}

/** How many updates show at once; "Mark these read" marks exactly these, never ones nobody has seen. */
const UPDATES_SHOWN = 8;
/** A paragraph's link stands 40px tall on a touch screen (spec 0.5); the link itself keeps its plain markup. */
const TOUCH_LINK = "pointer-coarse:[&>a]:inline-flex pointer-coarse:[&>a]:min-h-10 pointer-coarse:[&>a]:items-center";

/**
 * "Do it and tell me": what the assistant did on its own since you last looked, folded under "Recent activity", with the
 * brief's day in numbers. Every earlier update, read or not, is on the Updates page (plan B3).
 */
function RecentActivity({ summary }: { summary: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "unread"], queryFn: () => api.get<Notification[]>("/api/v1/notifications?unread=1"), ...TODAY_REFRESH });
  const read = useMutation({
    mutationFn: (ids: string[]) => api.post("/api/v1/notifications/read", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  if (!q.isSuccess) return null;
  const items = q.data ?? [];
  const day = summary ? <p className="small muted mb-2">{summary}</p> : null;
  // Quiet on purpose: a hairline above, small type, folded until asked for.
  if (!items.length) {
    return (
      <div className="stack gap-1.5 border-t border-line pt-5">
        {day ? <details className="more"><summary>Recent activity</summary>{day}</details> : null}
        <p className={cn("small muted", TOUCH_LINK)}>No new updates. <Link to="/updates">See earlier updates</Link></p>
      </div>
    );
  }
  const shown = items.slice(0, UPDATES_SHOWN);
  const more = items.length - shown.length;
  return (
    <div className="stack gap-1.5 border-t border-line pt-5">
      <details className="more">
        <summary>{`Recent activity (${items.length})`}</summary>
        {day}
        {more > 0 ? <p className="small muted mb-2">Showing the {shown.length} newest. {more} more will show here once you mark these read.</p> : null}
        <ul className="grid max-w-[72ch]">
          {shown.map((n) => (
            <li key={n.id} className="small border-t border-line py-2.5">
              <strong>{n.title}</strong> <span className="muted">· {new Date(n.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <br />
              <span className="text-ink-2">{n.body}</span>
              {n.action ? <> <Link to={n.action.href}>{n.action.label}</Link></> : null}
            </li>
          ))}
        </ul>
        <div className="row mt-2">
          <Button size="sm" variant="secondary" loading={read.isPending} onClick={() => read.mutate(shown.map((n) => n.id))}>{more > 0 ? "Mark these read" : "Mark all read"}</Button>
        </div>
      </details>
      <p className={cn("small", TOUCH_LINK)}><Link to="/updates">See earlier updates</Link></p>
    </div>
  );
}
