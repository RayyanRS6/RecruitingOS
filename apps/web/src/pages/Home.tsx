"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "../nav";
import { Alert, Button, Card, ErrorState, Icon, Menu, PageHeader, Pill, Skeleton, type Tone } from "@ros/ui";
import type { GettingStartedAction } from "@ros/contracts";
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
import { HOME_ROWS, TODAY_REFRESH, cardLine, firstName, homeHeadline, homeJobs, homeRows, isFyi, moreLabel, nextStep, setupActionToast, splitActions, type HomeJob } from "../today";
import { POOL_CARD_NOTE, boardPersonPath, poolCardView } from "./board/board-model";
import { isDiscardDraft } from "./new-role/rules";
import { TodayStart } from "./new-role/TodayStart";

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
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<{ planKey?: string; usage?: Record<string, UsageLine> }>("/api/v1/companies/current"), enabled: seesAllowance, ...TODAY_REFRESH });
  const allowance = seesAllowance ? screeningAllowanceWarning(company.data?.usage, company.data?.planKey) : null;
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
  const needs = rows.filter((c) => !isFyi(c.kind)).length + (allowance ? 1 : 0) + (setupOpen ? 1 : 0);
  // A company's first screen (nothing yet, and this person may start a hire) is a first step, not "nothing waiting" (plan C18).
  const firstRun = !!empty && empty.actions.some((a) => a.path === START_HIRE_HREF);
  const name = firstName(me.data?.user.name);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
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
      {sentToRecruiter ? <Alert tone="info"><div className="row" style={{ justifyContent: "space-between" }}><span>{sentToRecruiter}</span><Button size="sm" variant="quiet" onClick={() => setSentToRecruiter(null)}>Got it</Button></div></Alert> : null}
      {brief.isLoading ? <Skeleton lines={3} /> : brief.error ? <ErrorState message="Could not load what needs you." onRetry={() => brief.refetch()} /> : setup ? <GettingStartedCard card={setup} onSentToRecruiter={setSentToRecruiter} /> : null}
      {/* The allowance row does not wait for the brief: it comes from the company's own usage. */}
      {rows.length || allowance ? (
        <NeedsYou title={needs > 0 ? "Needs you" : "Good to know"} items={[
          ...(allowance ? [{ key: "allowance", node: <AllowanceRow warning={allowance} onSentToRecruiter={setSentToRecruiter} /> }] : []),
          ...rowKeys(rows).map(({ key, card }) => ({ key, node: card.kind === "pool_ready" && card.pool && card.roleId ? <PoolRow card={card} /> : <CardRow card={card} onSentToRecruiter={setSentToRecruiter} /> })),
        ]} />
      ) : empty ? (
        <Card><CardRow card={empty} level={2} onSentToRecruiter={setSentToRecruiter} /></Card>
      ) : null}

      <YourJobs jobs={jobs} />

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

/** "Needs you": five rows, then the rest behind "Show N more". */
function NeedsYou({ title, items }: { title: string; items: Array<{ key: string; node: ReactNode }> }) {
  const shown = items.slice(0, HOME_ROWS);
  const later = items.slice(HOME_ROWS);
  const list = (part: typeof items) => (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {part.map((r) => <li key={r.key} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>{r.node}</li>)}
    </ul>
  );
  return (
    <Card title={title}>
      {list(shown)}
      {later.length ? (
        <details className="more" style={{ marginTop: 4 }}>
          <summary>{`Show ${later.length} more`}</summary>
          {list(later)}
        </details>
      ) : null}
    </Card>
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
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "nowrap" }}>
        <Heading style={{ fontSize: 15.5, minWidth: 0, overflowWrap: "anywhere" }}>{props.title}</Heading>
        {props.pill}
      </div>
      {props.line ? <p className="small" style={{ margin: "2px 0 0", color: "var(--ink-2)" }}>{props.line}</p> : null}
      {props.children ? <div className="row" style={{ marginTop: 10 }}>{props.children}</div> : null}
      {props.note}
      {props.rest ? (
        <details className="more" style={{ marginTop: 8 }}>
          <summary aria-label={`${label}: ${props.title}`}>{label}</summary>
          {props.rest}
        </details>
      ) : null}
    </div>
  );
}

const restText = (text: string) => <p className="small" style={{ margin: 0, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{text}</p>;

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
          <span ref={confirmRef} className="small" style={{ color: "var(--ink-2)" }}>Discard this draft? It stays in your records but cannot be continued.</span>
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
  return { new_applicants: "New applicants", needs_review: "Needs you", decision: "Decision", posting_action: "One step", escalation: "Recruiter", stuck: "Stuck", screening: "Screening chat", interviews: "Your interviews", empty: "Nothing waiting", getting_started: "Getting started", draft: "Draft", closing_date: "Closing date", share: "Live today", pool_ready: "Ready to sort", hire: "New hire" }[kind] ?? kind;
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
    <div className="stack" style={{ gap: 8 }}>
      {others.length ? <p className="small" style={{ margin: 0, color: "var(--ink-2)" }}>{others.join(" ")}</p> : null}
      {view.steps.length ? (
        <div>
          <p className="small muted" style={{ margin: 0 }}>Suggested next steps</p>
          <ul className="pool-steps" style={{ marginTop: 6 }}>
            {view.steps.map((s) => (
              <li key={s.applicationId}>
                <span className="next-step-tag">{s.label}</span>
                <span className="small"><Link to={boardPersonPath(card.roleId!, s.applicationId)}>{s.name}</Link>: {s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;
  return (
    <Row title={card.title} pill={<Pill size="sm" tone="good">{label(card.kind)}</Pill>} line={first} rest={rest} note={<p className="small muted" style={{ margin: "8px 0 0" }}>{POOL_CARD_NOTE}</p>}>
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
  return (
    <Card lift>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        {unverified ? <Pill size="sm" tone="caution">Waiting for ITS</Pill> : null}
      </div>
      {line ? <p className="small" style={{ margin: 0, color: "var(--ink-2)" }}>{line}</p> : null}
      {rest ? (
        <details className="more" style={{ marginTop: 6 }}>
          <summary>{unverified ? "What waits until then" : "Why"}</summary>
          {restText(rest)}
        </details>
      ) : null}
      {todo.length ? (
        <ol aria-label="Steps to get started" style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
          {todo.map((s) => (
            <li key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", borderTop: "1px solid var(--line)", padding: "10px 0" }}>
              <span className="todo-ring" aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{s.title}</strong>
                <span className="sr-only"> (not done yet)</span>
                {s.detail ? <p className="small" style={{ margin: "2px 0 0", color: "var(--ink-2)" }}>{s.detail}</p> : null}
                {s.actions.length ? <div className="row" style={{ marginTop: 8 }}>{s.actions.map((a, i) => button(a, s === next && i === 0))}</div> : null}
                <details className="more" style={{ marginTop: 6 }}>
                  <summary aria-label={`Why: ${s.title}`}>Why</summary>
                  <p className="small muted" style={{ margin: 0 }}>{s.why}</p>
                </details>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {done.length ? (
        <details className="more" style={{ marginTop: 6 }}>
          <summary>{`Done (${done.length})`}</summary>
          <ul aria-label="Steps done" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {done.map((s) => (
              <li key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0" }}>
                <span style={{ color: "var(--good-dot)", flex: "none", marginTop: 1 }}><Icon name="check-circle" size={18} label="Done" /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ color: "var(--ink-3)" }}>{s.title}</strong>
                  {s.detail ? <p className="small" style={{ margin: "2px 0 0", color: "var(--ink-2)" }}>{s.detail}</p> : null}
                  <p className="small muted" style={{ margin: "2px 0 0" }}>{s.why}</p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {setup?.dismissible && hide ? <div className="row" style={{ justifyContent: "flex-end" }}><Button size="sm" variant="quiet" loading={act.isPending && act.variables === hide} disabled={act.isPending} onClick={() => act.mutate(hide)}>{hide.label}</Button></div> : null}
    </Card>
  );
}

/** "Your jobs" (the Kanvis way): one row per job being worked on, each opening on its Candidates once it is live. */
function YourJobs({ jobs }: { jobs: HomeJob[] }) {
  if (!jobs.length) return null;
  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby="home-jobs">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 id="home-jobs">Your jobs</h2>
        <Link to="/roles" className="small">All jobs</Link>
      </div>
      <div className="list">
        {jobs.map((j) => {
          const s = roleStatus(j.status);
          return (
            <Link key={j.id} to={j.href} className="list-item">
              <span className="list-item-main">
                <strong style={{ overflowWrap: "anywhere" }}>{j.title}</strong>
                {j.facts ? <span className="sub">{j.facts}</span> : null}
              </span>
              <span className="list-item-end">
                <Pill size="sm" tone={s.tone}>{s.label}</Pill>
                <Icon name="chevron-right" />
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** How many updates show at once; "Mark these read" marks exactly these, never ones nobody has seen. */
const UPDATES_SHOWN = 8;

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
  const day = summary ? <p className="small muted" style={{ margin: "0 0 8px" }}>{summary}</p> : null;
  if (!items.length) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        {day ? <details className="more"><summary>Recent activity</summary>{day}</details> : null}
        <p className="small muted" style={{ margin: 0 }}>No new updates. <Link to="/updates">See earlier updates</Link></p>
      </div>
    );
  }
  const shown = items.slice(0, UPDATES_SHOWN);
  const more = items.length - shown.length;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <details className="more">
        <summary>{`Recent activity (${items.length})`}</summary>
        {day}
        {more > 0 ? <p className="small muted" style={{ margin: "0 0 8px" }}>Showing the {shown.length} newest. {more} more will show here once you mark these read.</p> : null}
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }} className="stack">
          {shown.map((n) => (
            <li key={n.id} className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <strong>{n.title}</strong> <span className="muted">· {new Date(n.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <br />
              <span style={{ color: "var(--ink-2)" }}>{n.body}</span>
              {n.action ? <> <Link to={n.action.href}>{n.action.label}</Link></> : null}
            </li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="secondary" loading={read.isPending} onClick={() => read.mutate(shown.map((n) => n.id))}>{more > 0 ? "Mark these read" : "Mark all read"}</Button>
        </div>
      </details>
      <p className="small" style={{ margin: 0 }}><Link to="/updates">See earlier updates</Link></p>
    </div>
  );
}
