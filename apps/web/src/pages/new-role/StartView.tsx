"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IntakeSessionSummary, PlanRoom } from "@ros/contracts";
import { Alert, Eyebrow, Icon, Skeleton } from "@ros/ui";
import { api } from "../../api/client";
import { Link, useNavigate } from "../../nav";
import { AskRecruiter } from "../../components/AskRecruiter";
import { presetOf } from "../../recruiter-access";
import { Composer } from "./Composer";
import { AssistantMark, ChatMessage, Thinking } from "./Conversation";
import { composerPlaceholder, startHireHref, type RecruiterAction } from "./rules";
import { quickStartsFor } from "./quick-starts";
import { useStartDraft } from "./use-start-draft";

type PlanAsk = RecruiterAction;

/** The company's business type, for the quick starts (GET /companies/current, the query Setup reads too). */
type CompanyLite = { name?: string; vertical?: string; settings: Record<string, unknown> };

/** A role's state beside its name in the room list; an open role needs no word. */
const PLACE_STATUS_WORD: Record<string, string> = { pending_approval: "waiting for approval", draft: "sent back for changes", paused: "paused" };

/**
 * Where the plan stands, when it has no room: the roles using the places now (open, paused, waiting for approval or sent
 * back for changes; closing one gives its place back), each a link to close it from, and a way to ask ITS for more (C13).
 */
export function RoomAlert({ room, ask }: { room: PlanRoom; ask: PlanAsk | null }) {
  return (
    <Alert tone="caution">
      <div className="stack" style={{ gap: 8 }}>
        <span>{room.message ?? "Your plan has no room for another role right now."}</span>
        {room.holding.length ? (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {room.holding.map((r) => <li key={r.roleId}><Link to={`/roles/${r.roleId}`}>{r.title}</Link>{PLACE_STATUS_WORD[r.status] ? <span className="muted"> ({PLACE_STATUS_WORD[r.status]})</span> : null}</li>)}
          </ul>
        ) : null}
        <div className="row">
          <AskRecruiter label={ask?.label ?? "Talk to ITS about more roles"} size="sm" variant="secondary" preset={ask ? presetOf(ask.body) : { kind: "ask", about: "all", topic: "plan", question: "We would like to open more roles than our plan includes. Can we talk about adding more?" }} />
        </div>
      </div>
    </Alert>
  );
}

/**
 * The job builder's first screen (plan C4, C5, C13): "Who are you hiring?", one big box for a sentence or a whole job ad,
 * and quick starts for the roles our hiring guide knows. The draft is made only when the first message is sent, so
 * opening this page saves nothing. "Start a hire" picks up the draft this person already has in progress rather than
 * starting a second one; "Start a different role" comes here with ?new=1 to begin another. When the plan has no room
 * the page says so before anything is typed, with the roles holding the places.
 */
export function StartView({ fresh, companyName }: { fresh: boolean; companyName: string | null }) {
  const nav = useNavigate();
  const drafts = useQuery({ queryKey: ["intake", "mine"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[]; room: PlanRoom }>("/api/v1/intake/sessions?mine=1") });
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<CompanyLite>("/api/v1/companies/current") });
  const latest = drafts.data?.sessions[0] ?? null;
  const resume = !fresh && !!latest;
  const resumed = useRef(false);
  useEffect(() => {
    if (!resume || !latest || resumed.current) return;
    resumed.current = true;
    nav(startHireHref(latest.id), { replace: true });
  }, [resume, latest, nav]);

  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);
  const { start, pending, sent, notARole, problem, limit, clearProblem } = useStartDraft({ replace: true });

  if (drafts.isLoading || resume) return <Skeleton lines={4} />;
  const planAsk = limit;
  const room = planAsk?.room ?? drafts.data?.room ?? null;
  const full = !!room && !room.ok;
  const quick = quickStartsFor(company.data?.vertical);
  const others = fresh ? drafts.data?.sessions ?? [] : [];
  const name = companyName ?? company.data?.name ?? null;

  return (
    <div className="start">
      <Eyebrow>{name ? `New role · ${name}` : "New role"}</Eyebrow>
      <h1>Who are you hiring?</h1>
      <p className="start-lede">Describe the role in a sentence or paste a job ad you already have. I'll ask a few questions and draft the job for you.</p>
      {full && room ? <RoomAlert room={room} ask={planAsk?.ask ?? null} /> : null}
      {sent ? (
        <div className="start-sent">
          <ChatMessage m={{ role: "owner", content: sent, kind: sent.length >= 1200 ? "pasted_ad" : "text" }} />
          <Thinking label="Reading what you wrote…" />
        </div>
      ) : (
        <Composer
          size="lg"
          first
          inputRef={box}
          value={text}
          onChange={(v) => { setText(v); clearProblem(); }}
          onSend={start}
          sending={pending}
          disabled={full}
          label="Describe the role, or paste a job ad"
          placeholder={composerPlaceholder({ started: false, hasDraft: false })}
          hint={<span className="paste-hint"><Icon name="paperclip" size={14} /> Paste a job ad: up to 20,000 characters.</span>}
        />
      )}
      {notARole ? (
        <div className="chat-msg assistant">
          <AssistantMark />
          <div className="bubble assistant">{notARole}</div>
        </div>
      ) : null}
      {problem ? <Alert tone="critical">{problem}</Alert> : null}
      {quick.length && !sent ? (
        <div className="quick-starts">
          <span className="small muted">Roles our hiring guide knows:</span>
          <ul className="row" aria-label="Start from a role our hiring guide knows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {quick.map((q) => (
              <li key={q.label}>
                <button type="button" className="toggle-chip" disabled={full} onClick={() => { setText(q.text); clearProblem(); box.current?.focus(); }}>{q.label}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="small muted start-note"><Icon name="sparkle" size={14} /> You are talking with an AI assistant. It drafts; you decide. Nothing is posted or sent to anyone until someone approves the role.</p>
      {others.length ? (
        <section className="start-others" aria-label="Your drafts in progress">
          <h2>Your drafts in progress</h2>
          <ul className="list">
            {others.map((s) => (
              <li key={s.id}>
                <Link to={startHireHref(s.id)} className="list-item">
                  <span className="list-item-main">
                    <strong>{s.title ?? "Untitled role"}</strong>
                    <span className="sub">{s.hasDraft ? "Draft written" : "Still being drafted"} · last changed {new Date(s.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <span className="list-item-end"><Icon name="chevron-right" /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
