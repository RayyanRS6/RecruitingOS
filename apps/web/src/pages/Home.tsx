"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "../nav";
import { Alert, Button, Card, ErrorState, Icon, PageHeader, Pill, Skeleton, type Tone } from "@ros/ui";
import type { GettingStartedAction } from "@ros/contracts";
import { api, ApiError, type Brief, type BriefCard, type ClosingDateResponse, type InterviewDraft, type Me, type Notification } from "../api/client";
import { ALLOWANCE_ASK, screeningAllowanceWarning, type UsageLine } from "../allowance";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";
import { RecruiterRequests } from "../components/RecruiterRequests";
import { interviewDraftPath } from "../hiring";
import { closingDateToast, isClosingDateAction } from "../publishing";
import { canChangeCompany, canStartHire } from "../roles";
import { presetOf, requestSentText } from "../recruiter-access";
import { START_HIRE_HREF } from "../start-hire";
import { briefDecisionToast } from "../talent-actions";
import { TODAY_REFRESH, nextStep, setupActionToast } from "../today";
import { POOL_CARD_NOTE, boardPersonPath, poolCardView } from "./board/board-model";
import { isDiscardDraft } from "./new-role/rules";
import { TodayStart } from "./new-role/TodayStart";

/**
 * Today (docs/07): the morning brief as cards, including any role this person started and has not finished, then the
 * "Who are you hiring?" box, which hands over to the job builder at /roles/new (plan C4, founder decision Q5). The
 * conversation that drafts a role lives there, beside the draft; Today keeps none of its own.
 */
export function Home() {
  const nav = useNavigate();
  // Today keeps itself current (plan B9): on focus, and every minute while it is open and visible (today.ts).
  const brief = useQuery({ queryKey: ["brief"], queryFn: () => api.get<Brief>("/api/v1/brief"), ...TODAY_REFRESH });
  // Starting a hire is gated by role.create on the server; the box and the button only appear for the roles that hold it.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
  const mayStartHire = canStartHire(myRole);
  const [sentToRecruiter, setSentToRecruiter] = useState<string | null>(null);

  // Old links and bookmarks to "/?start=1" (before the job builder had a page of its own) go to the job builder.
  const [params] = useSearchParams();
  const wantsStart = params.get("start") === "1";
  const moved = useRef(false);
  useEffect(() => {
    if (!wantsStart || moved.current) return;
    moved.current = true;
    nav(START_HIRE_HREF, { replace: true });
  }, [wantsStart, nav]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        eyebrow="Today"
        title={`Good ${greeting()}.`}
        sub={brief.data?.summary ?? "What needs you, who is worth a look, what is at risk, and what was handled for you."}
        actions={
          <>
            {mayStartHire ? <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link> : null}
            <AskRecruiter />
          </>
        }
      />

      {/* A card's one-click request says what the recruiter will see and until when, and stays until read (the card itself may go). */}
      {sentToRecruiter ? <Alert tone="info"><div className="row" style={{ justifyContent: "space-between" }}><span>{sentToRecruiter}</span><Button size="sm" variant="quiet" onClick={() => setSentToRecruiter(null)}>Got it</Button></div></Alert> : null}
      {/* The plan's screening conversations at 80% or used up (Q17): owners and admins, who can talk to ITS about the plan. */}
      {canChangeCompany(myRole) ? <AllowanceCard onSentToRecruiter={setSentToRecruiter} /> : null}
      {brief.isLoading ? <Skeleton lines={3} /> : brief.error ? <ErrorState message="Could not load your brief." onRetry={() => brief.refetch()} /> : (
        <div className="stack">
          {brief.data!.cards.map((card, i) => card.kind === "getting_started" ? <GettingStartedCard key={`setup-${i}`} card={card} onSentToRecruiter={setSentToRecruiter} /> : card.kind === "pool_ready" && card.pool && card.roleId ? <PoolReadyCard key={`pool-${card.roleId}`} card={card} /> : <BriefCardView key={i} card={card} onSentToRecruiter={setSentToRecruiter} />)}
        </div>
      )}

      {mayStartHire ? <TodayStart /> : null}

      <RecruiterRequests />

      <Updates />
    </div>
  );
}

/**
 * The month's screening conversations at 80% of the plan's allowance, or used up (founder decision Q17). Nothing stops
 * either way: applications keep coming in, and once the allowance is used up new applicants get the conversation link
 * by email when more are added. The one button opens the request to ITS about the plan, filled in, never sent in one
 * click; talking about the plan never uses one of the plan's recruiter requests.
 */
function AllowanceCard({ onSentToRecruiter }: { onSentToRecruiter: (message: string) => void }) {
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<{ planKey?: string; usage?: Record<string, UsageLine> }>("/api/v1/companies/current"), ...TODAY_REFRESH });
  const warning = screeningAllowanceWarning(company.data?.usage, company.data?.planKey);
  if (!warning) return null;
  return (
    <Card needsYou={warning.level === "used_up"} lift>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{warning.title}</h2>
        <Pill size="sm" tone="caution">{warning.level === "used_up" ? "Used up" : "80% used"}</Pill>
      </div>
      <p className="small" style={{ color: "var(--ink-2)" }}>{warning.body}</p>
      <div className="row" style={{ marginTop: 12 }}>
        <AskRecruiter label="Ask ITS about adding more" size="sm" variant="primary" preset={ALLOWANCE_ASK} onSent={onSentToRecruiter} />
        <Link to="/setup" className="btn secondary sm">See usage</Link>
      </div>
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function BriefCardView({ card, onSentToRecruiter }: { card: BriefCard; onSentToRecruiter: (message: string) => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const needsYou = ["decision", "needs_review", "stuck"].includes(card.kind);
  // A company's first screen (nothing yet, and this person may start a hire) is a first step, not "nothing waiting" (plan C18).
  const firstRun = card.kind === "empty" && card.actions.some((a) => a.path === START_HIRE_HREF);
  // Discarding a draft cannot be undone, so the card asks first (plan C18).
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
  return (
    <Card needsYou={needsYou} lift={needsYou}>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        <Pill size="sm" tone={firstRun ? "accent" : cardTone(card.kind, needsYou)}>{firstRun ? "First step" : label(card.kind)}</Pill>
      </div>
      {card.body ? <p className="small" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{card.body}</p> : null}
      {discarding ? (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small" style={{ color: "var(--ink-2)" }}>Discard this draft? It stays in your records but cannot be continued.</span>
          <Button size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate(discarding)}>Discard it</Button>
          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => setDiscarding(null)}>Keep it</Button>
        </div>
      ) : card.actions.length ? (
        <div className="row" style={{ marginTop: 12 }}>
          {card.actions.map((a, i) =>
            a.method === "GET" ? (
              <Link key={i} to={a.path} className={`btn ${i === 0 ? "primary" : "secondary"} sm`}>{a.label}</Link>
            ) : (
              <Button key={i} size="sm" variant={i === 0 ? "primary" : "secondary"} loading={act.isPending && act.variables === a} disabled={act.isPending} onClick={() => (isDiscardDraft(a) ? setDiscarding(a) : act.mutate(a))}>{a.label}</Button>
            ),
          )}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A card's pill: amber when it waits on you, ink when a recruiter is involved, green when there is nothing waiting or a
 * job just went live (the day to share it), amber for a closing date that is about to stop applications or did.
 */
function cardTone(kind: string, needsYou: boolean): Tone {
  if (needsYou || kind === "closing_date") return "caution";
  return kind === "escalation" ? "accent" : kind === "empty" || kind === "share" || kind === "hire" ? "good" : "neutral";
}

/** `hire`: "keep your backups warm" until a new hire starts (plan H1). */
function label(kind: string): string {
  return { new_applicants: "New applicants", needs_review: "Needs you", decision: "Decision", posting_action: "One step", escalation: "Recruiter", stuck: "Stuck", screening: "Screening", interviews: "Your interviews", empty: "Nothing waiting", getting_started: "Getting started", draft: "Draft", closing_date: "Closing date", share: "Live today", pool_ready: "Ready to sort", hire: "New hire" }[kind] ?? kind;
}

/**
 * A role's pool, sorted on the board and waiting for a person (plan F7): two plain sentences from the board's summary,
 * up to three next steps naming people (each opens their panel over the board), then the board and Review and apply.
 * The card suggests; nothing moves until someone applies it, and nobody is emailed.
 */
function PoolReadyCard({ card }: { card: BriefCard }) {
  const view = poolCardView(card.pool!);
  return (
    <Card lift>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        <Pill size="sm" tone="good">{label(card.kind)}</Pill>
      </div>
      {view.sentences.length ? <p className="small" style={{ color: "var(--ink-2)" }}>{view.sentences.join(" ")}</p> : null}
      {view.steps.length ? (
        <div style={{ marginTop: 10 }}>
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
      <div className="row" style={{ marginTop: 12 }}>
        {card.actions.filter((a) => a.method === "GET").map((a, i) => <Link key={a.path} to={a.path} className={`btn ${i === 0 ? "secondary" : "primary"} sm`}>{a.label}</Link>)}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>{POOL_CARD_NOTE}</p>
    </Card>
  );
}

/**
 * Getting started (plans B1 and B2): while ITS confirms the company, what waits until then (nobody can hide that); then
 * the steps this person can do, each with one line on why it matters, ticked when the record shows it done. Its buttons
 * send exactly what the card says, except a request to ITS, which opens in the request form first; hiding the steps
 * hides them for this person only.
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
  const hide = card.actions.find((a) => a.method === "POST");
  return (
    <Card lift>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        <Pill size="sm" tone={setup?.verified === false ? "caution" : "neutral"}>{setup?.verified === false ? "Waiting for ITS" : label(card.kind)}</Pill>
      </div>
      {setup?.verified === false ? <Alert tone="info">{card.body}</Alert> : <p className="small" style={{ color: "var(--ink-2)" }}>{card.body}</p>}
      {steps.length ? (
        <ol aria-label="Steps to get started" style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
          {steps.map((s) => (
            <li key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", borderTop: "1px solid var(--line)", padding: "10px 0" }}>
              {s.done
                ? <span style={{ color: "var(--good-dot)", flex: "none", marginTop: 1 }}><Icon name="check-circle" size={18} label="Done" /></span>
                : <span aria-hidden="true" style={{ flex: "none", width: 16, height: 16, margin: "2px 1px 0", borderRadius: "50%", border: "1.5px solid var(--line-strong)" }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ color: s.done ? "var(--ink-3)" : "var(--ink)" }}>{s.title}</strong>
                {s.done ? null : <span className="sr-only"> (not done yet)</span>}
                <p className="small muted" style={{ margin: "2px 0 0" }}>{s.why}</p>
                {s.detail ? <p className="small" style={{ margin: "2px 0 0", color: "var(--ink-2)" }}>{s.detail}</p> : null}
                {!s.done && s.actions.length ? <div className="row" style={{ marginTop: 8 }}>{s.actions.map((a, i) => button(a, s === next && i === 0))}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {setup?.dismissible && hide ? <div className="row" style={{ justifyContent: "flex-end" }}><Button size="sm" variant="quiet" loading={act.isPending && act.variables === hide} disabled={act.isPending} onClick={() => act.mutate(hide)}>{hide.label}</Button></div> : null}
    </Card>
  );
}

/** How many updates the card shows at once; "Mark these read" marks exactly these, never ones nobody has seen. */
const UPDATES_SHOWN = 8;

/** "Do it and tell me": what the assistant did on its own since you last looked. */
function Updates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "unread"], queryFn: () => api.get<Notification[]>("/api/v1/notifications?unread=1"), ...TODAY_REFRESH });
  const read = useMutation({
    mutationFn: (ids: string[]) => api.post("/api/v1/notifications/read", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = q.data ?? [];
  // Every earlier update, read or not, is on the Updates page (plan B3).
  if (!items.length) return q.isSuccess ? <p className="small muted" style={{ margin: 0 }}>No new updates. <Link to="/updates">See earlier updates</Link></p> : null;
  const shown = items.slice(0, UPDATES_SHOWN);
  const more = items.length - shown.length;
  return (
    <Card title="What the assistant did" aside={<Button size="sm" variant="quiet" loading={read.isPending} onClick={() => read.mutate(shown.map((n) => n.id))}>{more > 0 ? "Mark these read" : "Mark all read"}</Button>}>
      {more > 0 ? <p className="small muted" style={{ marginBottom: 8 }}>Showing the {shown.length} newest. {more} more will show here once you mark these read.</p> : null}
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
      <p className="small" style={{ margin: "10px 0 0" }}><Link to="/updates">See earlier updates</Link></p>
    </Card>
  );
}
