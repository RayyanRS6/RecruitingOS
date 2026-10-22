"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IntakeSessionSummary, PlanRoom } from "@ros/contracts";
import { Alert, Button, Eyebrow, Icon, IconChip, Skeleton } from "@ros/ui";
import { api } from "../../api/client";
import { Link, useNavigate } from "../../nav";
import { AskRecruiter } from "../../components/AskRecruiter";
import { presetOf } from "../../recruiter-access";
import { browserStorage, QUICK_START_HREF } from "../../start-hire";
import { TRIAL_ASK } from "../../trial";
import { Composer } from "./Composer";
import { AssistantMark, ChatMessage, Thinking } from "./Conversation";
import { composerPlaceholder, startHireHref, type RecruiterAction } from "./rules";
import { readQuickStart, type QuickScope } from "./quick-start";
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
 * When the trial has ended (L-02 B) the ask is to choose a plan, also when the room came from GET /intake/room or
 * /intake/sessions, which carry no ask of their own.
 */
export function RoomAlert({ room, ask }: { room: PlanRoom; ask: PlanAsk | null }) {
  return (
    <Alert tone="caution">
      <div className="grid gap-2">
        <span>{room.message ?? "Your plan has no room for another role right now."}</span>
        {room.holding.length ? (
          <ul className="small grid list-disc gap-0.5 pl-[18px]">
            {room.holding.map((r) => <li key={r.roleId}><Link to={`/roles/${r.roleId}`}>{r.title}</Link>{PLACE_STATUS_WORD[r.status] ? <span className="muted"> ({PLACE_STATUS_WORD[r.status]})</span> : null}</li>)}
          </ul>
        ) : null}
        <div className="row">
          <AskRecruiter label={ask?.label ?? (room.trialEnded ? "Ask ITS to choose a plan" : "Talk to ITS about more roles")} size="sm" variant="secondary" preset={ask ? presetOf(ask.body) : room.trialEnded ? TRIAL_ASK : { kind: "ask", about: "all", topic: "plan", question: "We would like to open more roles than our plan includes. Can we talk about adding more?" }} />
        </div>
      </div>
    </Alert>
  );
}

/**
 * The job builder's first screen (plan C4, C5, C13; Wave S2 K2): "Who are you hiring?" with two ways to start. First,
 * the quick questions (ten small steps, `?way=quick`), the main button; then one big box for a sentence or a whole job
 * ad, with quick starts for the roles our hiring guide knows. The draft is made only when the first message is sent, so
 * opening this page saves nothing. "Start a hire" picks up the draft this person already has in progress rather than
 * starting a second one; "Start a different role" comes here with ?new=1 to begin another. When the plan has no room
 * the page says so before anything is typed, with the roles holding the places.
 */
export function StartView({ fresh, companyName, scope = null }: { fresh: boolean; companyName: string | null; scope?: QuickScope | null }) {
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
  // Quick answers kept in this browser: read after the first draw, so the server and the browser draw the same page.
  const [quickKept, setQuickKept] = useState(false);
  const scopeKey = scope ? `${scope.companyId}:${scope.userId}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only when the person or the company changes (scopeKey), not for each new scope object
  useEffect(() => { setQuickKept(!!scope && !!readQuickStart(browserStorage(), scope)); }, [scopeKey]);
  const { start, pending, sent, notARole, problem, limit, clearProblem } = useStartDraft({ replace: true });

  if (drafts.isLoading || resume) return <Skeleton lines={4} />;
  const planAsk = limit;
  const room = planAsk?.room ?? drafts.data?.room ?? null;
  const full = !!room && !room.ok;
  const quick = quickStartsFor(company.data?.vertical);
  const others = fresh ? drafts.data?.sessions ?? [] : [];
  const name = companyName ?? company.data?.name ?? null;

  return (
    <div className="start mx-auto grid w-full max-w-[880px] gap-6">
      <header className="grid gap-2.5 md:[&>h1]:text-[44px]">
        <Eyebrow>{name ? `New job · ${name}` : "New job"}</Eyebrow>
        <h1>Who are you hiring?</h1>
        <p className="max-w-[60ch] text-[15.5px] text-ink-2">Two ways to start. The assistant drafts the job; you decide.</p>
      </header>
      {full && room ? <RoomAlert room={room} ask={planAsk?.ask ?? null} /> : null}
      {sent ? null : (
        // "Your next step" (screenshot 1's hero): the quick questions are the main way in
        <section className="card needs-you grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" aria-labelledby="start-quick-h">
          <div className="grid justify-items-start gap-2">
            <IconChip icon="sparkles" tone="peach" />
            <h2 id="start-quick-h" className="mt-2 font-display text-[26px] font-bold leading-[1.1] tracking-[-0.03em] md:text-[30px]">Answer a few quick questions</h2>
            <p className="max-w-[52ch] text-[15px] text-ink-2">Ten short steps, one at a time. Then the assistant writes the job post.</p>
          </div>
          <div className="row">
            <Button variant="primary" iconEnd="arrow-right" disabled={full} onClick={() => nav(QUICK_START_HREF)}>{quickKept ? "Continue the quick questions" : "Start the quick questions"}</Button>
          </div>
        </section>
      )}
      {/* The guided conversation (screenshot 3): the big box, the roles to start from, and the honest line at its foot */}
      <div className="card grid gap-4 border-line-tint bg-linear-170 from-tint/70 via-surface via-45% to-surface p-5 sm:p-6">
        <div className="flex min-w-0 items-center gap-3">
          <IconChip icon="message-circle" />
          <h2 className="min-w-0 font-display text-xl font-bold tracking-[-0.02em]">Or describe it, or paste a job ad</h2>
        </div>
        {sent ? (
          <div className="grid gap-4 py-1">
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
            hint={<span><Icon name="paperclip" size={14} /> Paste a job ad: up to 20,000 characters.</span>}
          />
        )}
        {notARole ? (
          <div className="flex min-w-0 items-start gap-2.5 motion-safe:animate-enter">
            <AssistantMark />
            <div className="bubble assistant min-w-0 rounded-2xl rounded-tl-md">{notARole}</div>
          </div>
        ) : null}
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
        {quick.length && !sent ? (
          <div className="grid gap-2">
            <span className="text-[12.5px] text-ink-3">Roles our hiring guide knows:</span>
            <ul className="flex flex-wrap gap-2" aria-label="Start from a role our hiring guide knows">
              {quick.map((q) => (
                <li key={q.label}>
                  <button type="button" className="suggestion disabled:cursor-not-allowed disabled:opacity-50" disabled={full} onClick={() => { setText(q.text); clearProblem(); box.current?.focus(); }}>{q.label}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="flex items-start gap-1.5 border-t border-line pt-3.5 text-[12.5px] leading-snug text-ink-3"><Icon name="sparkle" size={14} className="mt-px text-accent" /> You are talking with an AI assistant. It drafts; you decide. Nothing is posted or sent to anyone until someone approves the role.</p>
      </div>
      {others.length ? (
        <section className="grid gap-3" aria-label="Your drafts in progress">
          <h2 className="font-display text-2xl font-bold tracking-[-0.025em]">Your drafts in progress</h2>
          <ul className="list-card divide-y divide-line overflow-hidden">
            {others.map((s, i) => (
              <li key={s.id} className="motion-safe:animate-enter [animation-delay:calc(var(--i)*30ms)]" style={{ "--i": Math.min(i, 7) } as CSSProperties}>
                <Link to={startHireHref(s.id)} className="list-row">
                  <IconChip icon="file-text" size="sm" />
                  <span className="list-row-main">
                    <strong className="list-row-title">{s.title ?? "Untitled role"}</strong>
                    <span className="list-row-meta">{s.hasDraft ? "Draft written" : "Still being drafted"} · last changed {new Date(s.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <Icon name="chevron-right" className="chev" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
