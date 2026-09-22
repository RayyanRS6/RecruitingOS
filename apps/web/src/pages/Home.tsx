"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "../nav";
import { Alert, Bubble, Button, Card, Chip, ErrorState, Skeleton } from "@ros/ui";
import { api, ApiError, type Brief, type BriefCard, type IntakeSession, type Notification } from "../api/client";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";

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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A reload resumes the conversation the owner was in the middle of; the session lives on the server.
  const current = useQuery({ queryKey: ["intake", "current"], queryFn: () => api.get<{ session: IntakeSession | null }>("/api/v1/intake/sessions/current") });
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

  const startOver = useMutation({
    mutationFn: async () => { if (sessionId) await api.post(`/api/v1/intake/sessions/${sessionId}/abandon`); },
    onSettled: async () => {
      setSessionId(null);
      setReady(false);
      setTurns([]);
      await qc.invalidateQueries({ queryKey: ["intake", "current"] });
    },
  });

  const send = useMutation({
    mutationFn: async (message: string) => {
      if (sessionId) {
        const r = await api.post<{ session: IntakeSession; reply: { assistantMessage?: string; readyToCompile?: boolean; error?: string; recovery?: string } }>(`/api/v1/intake/sessions/${sessionId}/messages`, { message });
        return { reply: r.reply.assistantMessage ?? `${r.reply.error ?? "Something went wrong."} ${r.reply.recovery ?? ""}`, ready: !!r.reply.readyToCompile, sessionId };
      }
      const r = await api.post<{ reply: string; intakeSessionId?: string; readyToCompile?: boolean }>("/api/v1/intake/conversation/messages", { message });
      return { reply: r.reply, ready: !!r.readyToCompile, sessionId: r.intakeSessionId ?? null };
    },
    onMutate: (message) => setTurns((t) => [...t, { role: "user", content: message }]),
    onSuccess: (r) => {
      setTurns((t) => [...t, { role: "assistant", content: r.reply }]);
      setSessionId(r.sessionId);
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
    onError: (err) => setTurns((t) => [...t, { role: "system", content: err instanceof ApiError ? err.message : "Could not draft the packet." }]),
  });

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const m = draft.trim();
    if (!m) return;
    setDraft("");
    send.mutate(m);
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div>
          <h1>Good {greeting()}.</h1>
          <p>{brief.data?.summary ?? "What needs you, who is worth a look, what is at risk, and what was handled for you."}</p>
        </div>
        <AskRecruiter />
      </div>

      {brief.isLoading ? <Skeleton lines={3} /> : brief.error ? <ErrorState message="Could not load your brief." onRetry={() => brief.refetch()} /> : (
        <div className="stack">
          {brief.data!.cards.map((card, i) => <BriefCardView key={i} card={card} />)}
        </div>
      )}

      <Updates />

      <Card title="Your recruiting chief of staff">
        <div className="stack" style={{ gap: 10 }}>
          {turns.length === 0 ? <Bubble role="assistant">Tell me who you need. For example: "I need a performance marketing manager in Los Angeles. $95,000 to $115,000. Hybrid, three days in the office. Someone who can start within 45 days."</Bubble> : null}
          {turns.map((t, i) => <Bubble key={i} role={t.role}>{t.content}</Bubble>)}
          {send.isPending ? <Bubble role="system">Thinking…</Bubble> : null}
          {/* Screen readers hear each new assistant reply without leaving the message box (accessibility checklist, known gap closed 21 Sep). */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="intake-announcer">{send.isPending ? "The assistant is thinking." : (turns.filter((t) => t.role !== "user").at(-1)?.content ?? "")}</div>
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
            <input className="input" style={{ flex: 1 }} placeholder={sessionId ? "Answer, or say 'draft it'" : "Who do you need to hire?"} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Message" />
            <Button type="submit" variant="primary" loading={send.isPending}>Send</Button>
          </form>
          {sessionId ? <p className="small muted">This conversation is drafting a role. <Button variant="quiet" size="sm" loading={startOver.isPending} onClick={() => startOver.mutate()}>Start over</Button></p> : null}
        </div>
      </Card>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

function BriefCardView({ card }: { card: BriefCard }) {
  const qc = useQueryClient();
  const needsYou = ["decision", "needs_review", "stuck"].includes(card.kind);
  const act = useMutation({
    mutationFn: (a: BriefCard["actions"][number]) => api.post(a.path, { ...(a.body ?? {}), question: (a.body as { question?: string } | undefined)?.question ?? `Please review: ${card.title}` }),
    onSuccess: (_r, a) => { toast(a.path.includes("/escalations") ? "Sent to a recruiter." : "Done."); qc.invalidateQueries({ queryKey: ["brief"] }); qc.invalidateQueries({ queryKey: ["notifications"] }); },
    onError: (err) => toast(err instanceof ApiError ? err.message : "That didn't work."),
  });
  return (
    <Card needsYou={needsYou} lift={needsYou}>
      <div className="card-title">
        <h2 style={{ fontSize: 16 }}>{card.title}</h2>
        <Chip tone={needsYou ? "needs" : card.kind === "escalation" ? "accent" : "neutral"}>{label(card.kind)}</Chip>
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

function label(kind: string): string {
  return { new_applicants: "New applicants", needs_review: "Needs you", decision: "Decision", posting_action: "One step", escalation: "Recruiter", stuck: "Stuck", screening: "Screening", empty: "All clear" }[kind] ?? kind;
}

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
  return (
    <Card title="What the assistant did" aside={<Button size="sm" variant="quiet" loading={read.isPending} onClick={() => read.mutate(items.map((n) => n.id))}>Mark all read</Button>}>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }} className="stack">
        {items.slice(0, 8).map((n) => (
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
