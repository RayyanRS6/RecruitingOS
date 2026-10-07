"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "../nav";
import { Alert, Bubble, Button, Card, ErrorState, PageHeader, Pill, Skeleton, type Tone } from "@ros/ui";
import { api, ApiError, type Brief, type BriefCard, type IntakeSession, type Me, type Notification } from "../api/client";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";
import { canStartHire } from "../roles";
import { requestSentText } from "../recruiter-access";

type Turn = { role: "assistant" | "user" | "system"; content: string };

/** Without these the packet cannot be compiled; anything else the owner can leave for the draft. */
const ESSENTIAL_FACTS = ["title", "location", "compensation_range", "reason_for_hire", "interviewers", "decision_maker"];

/**
 * Home is the conversation (docs/07): the morning brief as cards, then a thread with the recruiting assistant.
 * A hiring request becomes an intake session; "draft it" compiles the Role Packet; approval happens on the role page.
 */
export function Home() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const brief = useQuery({ queryKey: ["brief"], queryFn: () => api.get<Brief>("/api/v1/brief") });
  // The intake is gated by role.create on the server; the button only appears for the roles that hold it.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A reload resumes the conversation this person was in the middle of; the session lives on the server. Drafts carry
  // pay, so only people who may start a hire ask for one (the API refuses everyone else).
  const mayStartHire = canStartHire(myRole);
  const current = useQuery({ queryKey: ["intake", "current"], queryFn: () => api.get<{ session: IntakeSession | null }>("/api/v1/intake/sessions/current"), enabled: mayStartHire });
  // "Talk to ITS about more roles", offered when the plan's role allowance refuses a new role.
  const [limitAsk, setLimitAsk] = useState<{ label: string; path: string; body: Record<string, unknown> } | null>(null);
  const [sentToRecruiter, setSentToRecruiter] = useState<string | null>(null);
  const hydrated = useRef(false);
  useEffect(() => {
    const s = current.data?.session;
    if (hydrated.current || !s) return;
    hydrated.current = true;
    if (sessionId || turns.length) return;
    setSessionId(s.id);
    setTurns(s.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "owner" ? "user" : "assistant", content: m.content })));
    setReady(!ESSENTIAL_FACTS.some((k) => s.missingFacts.includes(k)));
  }, [current.data, sessionId, turns.length]);

  // "Start a hire" opens the conversation for a new role; the draft itself (an intake session) is made only when the
  // first message is sent, so pressing the button, following a link or a stray N key saves nothing and records nothing.
  const [drafting, setDrafting] = useState(false);
  const startOver = useMutation({
    mutationFn: async () => { if (sessionId) await api.post(`/api/v1/intake/sessions/${sessionId}/abandon`); },
    onSettled: async () => {
      setSessionId(null);
      setDrafting(false);
      setReady(false);
      setTurns([]);
      await qc.invalidateQueries({ queryKey: ["intake", "current"] });
    },
  });

  const focusMessage = () => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ block: "center" }); };
  const beginHire = () => {
    if (sessionId || drafting) { focusMessage(); return; }
    setDrafting(true);
    setReady(false);
    setTurns([{ role: "assistant", content: "Tell me who you need to hire. The title, where they will work, the pay range and why the role is open is a good start; I will ask about the rest." }]);
    inputRef.current?.focus();
  };

  // The empty Today card's "Start a hire", the rail's button and its N shortcut link here with ?start=1: once the resume
  // check has answered, it opens the conversation (or the draft already in progress), then the address goes back to
  // plain Today. Back on plain Today the next ?start=1 counts again, so the rail's button works a second time here.
  const [params] = useSearchParams();
  const wantsStart = params.get("start") === "1";
  const started = useRef(false);
  useEffect(() => {
    if (!wantsStart) { started.current = false; return; }
    if (started.current || !mayStartHire || current.isPending) return;
    started.current = true;
    nav("/", { replace: true });
    // The conversation already open on this page counts too, even before the resume check has caught up with it.
    if (current.data?.session || sessionId || drafting) focusMessage();
    else beginHire();
  }, [wantsStart, mayStartHire, current.isPending, current.data, sessionId, drafting, nav, beginHire, focusMessage]);

  const send = useMutation({
    mutationFn: async (message: string) => {
      if (sessionId) {
        const r = await api.post<{ session: IntakeSession; reply: { assistantMessage?: string; readyToCompile?: boolean; error?: string; recovery?: string } }>(`/api/v1/intake/sessions/${sessionId}/messages`, { message });
        return { reply: r.reply.assistantMessage ?? `${r.reply.error ?? "Something went wrong."} ${r.reply.recovery ?? ""}`, ready: !!r.reply.readyToCompile, sessionId };
      }
      // The first message after "Start a hire" starts the draft with it.
      if (drafting) {
        const r = await api.post<{ session: IntakeSession; reply: { assistantMessage?: string; readyToCompile?: boolean; error?: string } | null }>("/api/v1/intake/sessions", { initialMessage: message });
        return { reply: r.reply?.assistantMessage ?? `${r.reply?.error ?? "Something went wrong."} Try again, or ask a recruiter to finish this with you.`, ready: !!r.reply?.readyToCompile, sessionId: r.session.id };
      }
      const r = await api.post<{ reply: string; intakeSessionId?: string; readyToCompile?: boolean }>("/api/v1/intake/conversation/messages", { message });
      return { reply: r.reply, ready: !!r.readyToCompile, sessionId: r.intakeSessionId ?? null };
    },
    onMutate: (message) => setTurns((t) => [...t, { role: "user", content: message }]),
    onSuccess: (r) => {
      setTurns((t) => [...t, { role: "assistant", content: r.reply }]);
      setSessionId(r.sessionId);
      if (r.sessionId) {
        setDrafting(false);
        qc.invalidateQueries({ queryKey: ["intake", "current"] });
      }
      setReady(r.ready);
    },
    onError: (err) => setTurns((t) => [...t, { role: "system", content: err instanceof ApiError ? err.message : "That didn't go through. Try again." }]),
  });

  const compile = useMutation({
    mutationFn: () => api.post<{ roleId: string; version: number }>(`/api/v1/intake/sessions/${sessionId}/compile`),
    onSuccess: async (r) => {
      toast("Role packet drafted. Review and approve it.");
      await qc.invalidateQueries({ queryKey: ["intake", "current"] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
      await qc.invalidateQueries({ queryKey: ["roles"] });
      nav(`/roles/${r.roleId}`);
    },
    onError: (err) => {
      setTurns((t) => [...t, { role: "system", content: err instanceof ApiError ? err.message : "Could not draft the packet." }]);
      if (err instanceof ApiError && err.code === "limit_reached") setLimitAsk((err.details as { actions?: Array<{ label: string; path: string; body: Record<string, unknown> }> } | undefined)?.actions?.[0] ?? null);
    },
  });
  const askForMoreRoles = useMutation({
    mutationFn: (a: { path: string; body: Record<string, unknown> }) => api.post<{ message: string }>(a.path, a.body),
    onSuccess: (r) => { setLimitAsk(null); setTurns((t) => [...t, { role: "system", content: r.message }]); toast("Sent to ITS."); qc.invalidateQueries({ queryKey: ["brief"] }); },
    onError: (err) => toast(err instanceof ApiError ? err.message : "That didn't go through. Try again."),
  });

  // Scroll to the newest message whenever one is added.
  const turnCount = turns.length;
  useEffect(() => { if (turnCount) endRef.current?.scrollIntoView({ block: "end" }); }, [turnCount]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const m = draft.trim();
    if (!m) return;
    setDraft("");
    send.mutate(m);
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        eyebrow="Today"
        title={`Good ${greeting()}.`}
        sub={brief.data?.summary ?? "What needs you, who is worth a look, what is at risk, and what was handled for you."}
        actions={
          <>
            {mayStartHire ? <Button variant="primary" icon="plus" onClick={beginHire}>Start a hire</Button> : null}
            <AskRecruiter />
          </>
        }
      />

      {/* A card's one-click request says what the recruiter will see and until when, and stays until read (the card itself may go). */}
      {sentToRecruiter ? <Alert tone="info"><div className="row" style={{ justifyContent: "space-between" }}><span>{sentToRecruiter}</span><Button size="sm" variant="quiet" onClick={() => setSentToRecruiter(null)}>Got it</Button></div></Alert> : null}
      {brief.isLoading ? <Skeleton lines={3} /> : brief.error ? <ErrorState message="Could not load your brief." onRetry={() => brief.refetch()} /> : (
        <div className="stack">
          {brief.data!.cards.map((card, i) => <BriefCardView key={i} card={card} onSentToRecruiter={setSentToRecruiter} />)}
        </div>
      )}

      <Updates />

      <Card title="Your recruiting chief of staff">
        <div className="stack" style={{ gap: 10 }}>
          {turns.length === 0 ? <Bubble from="assistant">Tell me who you need. For example: "I need a performance marketing manager in Los Angeles. $95,000 to $115,000. Hybrid, three days in the office. Someone who can start within 45 days."</Bubble> : null}
          {turns.map((t, i) => <Bubble key={i} from={t.role}>{t.content}</Bubble>)}
          {send.isPending ? <Bubble from="system">Thinking…</Bubble> : null}
          {/* Screen readers hear each new assistant reply without leaving the message box (accessibility checklist, known gap closed 21 Sep). */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="intake-announcer">{send.isPending ? "The assistant is thinking." : (turns.filter((t) => t.role !== "user").at(-1)?.content ?? "")}</div>
          {limitAsk ? (
            <Alert tone="caution">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>ITS can talk with you about adding more roles to your plan.</span>
                <Button variant="primary" size="sm" loading={askForMoreRoles.isPending} onClick={() => askForMoreRoles.mutate(limitAsk)}>{limitAsk.label}</Button>
              </div>
            </Alert>
          ) : null}
          {ready && sessionId ? (
            <Alert tone="info">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>I have enough to draft the role packet.</span>
                <Button variant="primary" size="sm" loading={compile.isPending} onClick={() => compile.mutate()}>Draft the role packet</Button>
              </div>
            </Alert>
          ) : null}
          <div ref={endRef} />
          <form onSubmit={submit} className="row" style={{ alignItems: "stretch" }}>
            <input ref={inputRef} className="input" style={{ flex: 1 }} placeholder={sessionId ? "Answer, or say 'draft it'" : "Who do you need to hire?"} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Message" />
            <Button type="submit" variant="primary" loading={send.isPending}>Send</Button>
          </form>
          {sessionId || drafting ? <p className="small muted">This conversation is drafting a role. <Button variant="quiet" size="sm" loading={startOver.isPending} onClick={() => startOver.mutate()}>Start over</Button></p> : null}
        </div>
      </Card>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function BriefCardView({ card, onSentToRecruiter }: { card: BriefCard; onSentToRecruiter: (message: string) => void }) {
  const qc = useQueryClient();
  const needsYou = ["decision", "needs_review", "stuck"].includes(card.kind);
  const act = useMutation({
    mutationFn: (a: BriefCard["actions"][number]) => api.post<unknown>(a.path, { ...(a.body ?? {}), question: (a.body as { question?: string } | undefined)?.question ?? `Please review: ${card.title}` }),
    // A request to a recruiter answers with what they will see and until when (Q31); the page keeps those words on screen.
    onSuccess: (r, a) => {
      if (a.path.includes("/escalations")) { toast("Sent to a recruiter."); onSentToRecruiter(requestSentText(r)); }
      else toast("Done.");
      qc.invalidateQueries({ queryKey: ["brief"] }); qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "That didn't work."),
  });
  return (
    <Card needsYou={needsYou} lift={needsYou}>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        <Pill size="sm" tone={cardTone(card.kind, needsYou)}>{label(card.kind)}</Pill>
      </div>
      {card.body ? <p className="small" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{card.body}</p> : null}
      {card.actions.length ? (
        <div className="row" style={{ marginTop: 12 }}>
          {card.actions.map((a, i) =>
            a.method === "GET" ? (
              <Link key={i} to={a.path} className={`btn ${i === 0 ? "primary" : "secondary"} sm`}>{a.label}</Link>
            ) : (
              <Button key={i} size="sm" variant={i === 0 ? "primary" : "secondary"} loading={act.isPending} onClick={() => act.mutate(a)}>{a.label}</Button>
            ),
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** A card's pill: amber when it waits on you, ink when a recruiter is involved, green when there is nothing waiting. */
function cardTone(kind: string, needsYou: boolean): Tone {
  if (needsYou) return "caution";
  return kind === "escalation" ? "accent" : kind === "empty" ? "good" : "neutral";
}

function label(kind: string): string {
  return { new_applicants: "New applicants", needs_review: "Needs you", decision: "Decision", posting_action: "One step", escalation: "Recruiter", stuck: "Stuck", screening: "Screening", interviews: "Your interviews", empty: "Nothing waiting" }[kind] ?? kind;
}

/** How many updates the card shows at once; "Mark these read" marks exactly these, never ones nobody has seen. */
const UPDATES_SHOWN = 8;

/** "Do it and tell me": what the assistant did on its own since you last looked. */
function Updates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "unread"], queryFn: () => api.get<Notification[]>("/api/v1/notifications?unread=1") });
  const read = useMutation({
    mutationFn: (ids: string[]) => api.post("/api/v1/notifications/read", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = q.data ?? [];
  if (!items.length) return null;
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
    </Card>
  );
}
