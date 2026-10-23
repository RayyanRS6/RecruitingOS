"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecruiterRequestView } from "@ros/contracts";
import { Alert, Button, Card, Chip, cn, Field, Pill, type Tone } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { useSearchParams } from "../nav";
import { ACCESS_DAYS, accessWords } from "../recruiter-access";
import { REOPEN_MIN, STATE_WORDS, aboutWords, askedByWords, latestAnswer, pickedUpWords, reopenHint, replyByWords, requestActions, requestState, splitRequests, threadHeading, type RequestState } from "../recruiter-requests";
import { TODAY_REFRESH } from "../today";
import { toast } from "../toast";
import { useAskRole } from "./use-ask-role";

const STATE_TONE: Record<RequestState, Tone> = { waiting: "caution", working: "accent", answered: "good", cancelled: "neutral" };
const MINE = ["escalations", "mine"] as const;

/**
 * "Your recruiter requests" on Home (plan B4): every request the team made, or the system made for them, with its
 * state, the reply-by time, who picked it up and the recruiter's answer in full; the whole conversation one click away.
 * While a request is open anyone who may ask can add a note for the recruiter; once answered, "This didn't solve it"
 * reopens it (plan B5). A notice about an answer links here with ?request=<id>, which opens that request. Nothing shows
 * until there is a request, and never to someone who may not ask (an interviewer).
 */
export function RecruiterRequests() {
  const who = useAskRole();
  const q = useQuery({ queryKey: MINE, queryFn: () => api.get<RecruiterRequestView[]>("/api/v1/escalations/mine"), enabled: who.ready && who.mayAsk, ...TODAY_REFRESH });
  const [params] = useSearchParams();
  const linked = params.get("request");
  const [showOlder, setShowOlder] = useState(false);
  const rows = q.data ?? [];
  const { current, older } = splitRequests(rows, new Date());
  const linkedHere = !!linked && rows.some((r) => r.id === linked);
  const linkedOlder = !!linked && older.some((r) => r.id === linked);
  // A notice's link lands on the request it is about, opened, even when it has moved under "Older requests".
  useEffect(() => {
    if (!linkedHere) return;
    if (linkedOlder) setShowOlder(true);
    document.getElementById(`request-${linked}`)?.scrollIntoView({ block: "start" });
  }, [linked, linkedHere, linkedOlder]);
  if (!who.ready || !who.mayAsk || !rows.length) return null;
  const open = current.filter((r) => ["waiting", "working"].includes(requestState(r.status))).length;
  return (
    <div id="recruiter-requests">
      <Card title="Your recruiter requests" aside={open ? <Pill size="sm" tone="accent">{open} open</Pill> : null} className="max-sm:p-5">
        <ul aria-label="Your recruiter requests" className={cn("divide-y divide-line", current.length > 0 && "border-t border-line")}>
          {current.map((r) => <RequestItem key={r.id} r={r} linked={r.id === linked} staff={who.staff} />)}
        </ul>
        {older.length ? (
          <details className="more mt-3 border-t border-line pt-3" open={showOlder} onToggle={(e) => setShowOlder((e.target as HTMLDetailsElement).open)}>
            <summary>Older requests ({older.length})</summary>
            <ul className="divide-y divide-line border-t border-line">
              {older.map((r) => <RequestItem key={r.id} r={r} linked={r.id === linked} staff={who.staff} />)}
            </ul>
          </details>
        ) : null}
      </Card>
    </div>
  );
}

/** A conversation's first appearance (spec 4): each message 30ms after the one above, the ninth and later with the eighth. */
const stagger = (i: number): CSSProperties | undefined => (i ? { animationDelay: `${Math.min(i, 7) * 30}ms` } : undefined);

/**
 * The thread as a chat, in the job builder's chat look: the team's messages on the right in peach, the recruiter's on
 * the left in white. Only the messages there when it opens come in one after another; one added while it is open (a note
 * sent, a reopen) comes in at once.
 */
function RequestThread({ thread }: { thread: RecruiterRequestView["thread"] }) {
  const [openedWith] = useState(thread.length);
  return (
    <ol aria-label="The conversation" className="mt-3 grid gap-3 rounded-2xl border border-line bg-ground p-3 sm:p-4">
      {thread.map((e, i) => {
        const ours = e.side === "customer";
        return (
          <li key={e.id} className={cn("grid min-w-0 max-w-[min(100%,36rem)] gap-1 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]", ours ? "justify-items-end justify-self-end" : "justify-items-start justify-self-start")} style={i < openedWith ? stagger(i) : undefined}>
            <p className="px-1 text-[12px] text-ink-3">{threadHeading(e)} · {new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
            <p className={cn("bubble min-w-0 rounded-2xl text-sm", ours ? "user rounded-tr-md" : "assistant rounded-tl-md text-ink")}>{e.body}</p>
          </li>
        );
      })}
    </ol>
  );
}

function RequestItem({ r, linked, staff }: { r: RecruiterRequestView; linked: boolean; staff: boolean }) {
  const qc = useQueryClient();
  const state = requestState(r.status);
  const may = requestActions(r, { staff });
  const answer = latestAnswer(r.thread);
  const [expanded, setExpanded] = useState(linked);
  const [mode, setMode] = useState<"note" | "reopen" | null>(null);
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => { if (linked) setExpanded(true); }, [linked]);
  const done = (message: string) => { setSaid(message); setMode(null); setText(""); qc.invalidateQueries({ queryKey: MINE }); qc.invalidateQueries({ queryKey: ["brief"] }); qc.invalidateQueries({ queryKey: ["staff-access"] }); };
  const note = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/api/v1/escalations/mine/${r.id}/messages`, { body: text.trim() }),
    onSuccess: (res) => { toast("Note sent."); done(res.message); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the note."),
  });
  const reopen = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/api/v1/escalations/mine/${r.id}/reopen`, { note: text.trim() }),
    onSuccess: (res) => { toast("Reopened."); done(res.message); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not reopen the request."),
  });
  const now = new Date();
  const picked = pickedUpWords(r);
  const fieldId = `request-${r.id}-text`;
  // scroll-mt-20: a notice's link (?request=<id>) scrolls the request clear of the sticky bar above the page
  return (
    <li id={`request-${r.id}`} className="scroll-mt-20 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <strong className="min-w-0 text-[15px] text-ink [overflow-wrap:anywhere]">{aboutWords(r)}</strong>
        <span className="row gap-1.5">
          {r.urgency === "high" || r.urgency === "critical" ? <Chip tone="caution">Urgent</Chip> : null}
          {r.reopenedCount ? <Chip>Reopened</Chip> : null}
          <Pill size="sm" tone={STATE_TONE[state]}>{STATE_WORDS[state]}</Pill>
        </span>
      </div>
      <p className="small muted mt-0.5">{[askedByWords(r.askedBy), replyByWords(r, now), picked].filter(Boolean).join(" · ")}</p>
      {answer && state === "answered" ? (
        <div className="mt-3 rounded-xl border border-line-tint bg-tint px-4 py-3">
          <p className="small text-ink-2">{threadHeading(answer)}</p>
          <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{answer.body}</p>
        </div>
      ) : <p className="small mt-2 whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{r.question}</p>}
      {said ? <div className="mt-3"><Alert tone="info">{said}</Alert></div> : null}
      <div className="row mt-3 gap-1.5">
        <Button size="sm" variant="quiet" onClick={() => setExpanded(!expanded)}>{expanded ? "Hide the conversation" : `Show the conversation (${r.thread.length})`}</Button>
        {may.note && mode !== "note" ? <Button size="sm" variant="secondary" onClick={() => { setMode("note"); setText(""); setSaid(null); }}>Add a note for the recruiter</Button> : null}
        {may.reopen && mode !== "reopen" ? <Button size="sm" variant="secondary" onClick={() => { setMode("reopen"); setText(""); setSaid(null); }}>This didn't solve it</Button> : null}
      </div>
      {expanded ? <RequestThread thread={r.thread} /> : null}
      {mode === "note" ? (
        <div className="stack mt-3 gap-2">
          <Field label="Your note for the recruiter" htmlFor={fieldId}>
            <textarea id={fieldId} className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row"><Button size="sm" variant="primary" disabled={!text.trim()} loading={note.isPending} onClick={() => note.mutate()}>Send note</Button><Button size="sm" variant="quiet" onClick={() => setMode(null)}>Cancel</Button></div>
        </div>
      ) : null}
      {mode === "reopen" ? (
        <div className="stack mt-3 gap-2">
          <Field label="What is still missing?" htmlFor={fieldId}>
            <textarea id={fieldId} className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <p className="small muted">{reopenHint(r.recruiterName, accessWords(r.scope), ACCESS_DAYS)}</p>
          <div className="row"><Button size="sm" variant="primary" disabled={text.trim().length < REOPEN_MIN} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen the request</Button><Button size="sm" variant="quiet" onClick={() => setMode(null)}>Keep it closed</Button></div>
        </div>
      ) : null}
    </li>
  );
}
