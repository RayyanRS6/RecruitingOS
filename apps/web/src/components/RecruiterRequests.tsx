"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecruiterRequestView } from "@ros/contracts";
import { Alert, Button, Card, Chip, Field, Pill, type Tone } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { useSearchParams } from "../nav";
import { ACCESS_DAYS, accessWords } from "../recruiter-access";
import { RECENT_DAYS, REOPEN_MIN, STATE_WORDS, aboutWords, askedByWords, latestAnswer, pickedUpWords, reopenHint, replyByWords, requestActions, requestState, splitRequests, threadHeading, type RequestState } from "../recruiter-requests";
import { TODAY_REFRESH } from "../today";
import { toast } from "../toast";
import { useAskRole } from "./use-ask-role";

const STATE_TONE: Record<RequestState, Tone> = { waiting: "caution", working: "accent", answered: "good", cancelled: "neutral" };
const MINE = ["escalations", "mine"] as const;

/**
 * "Your recruiter requests" on Today (plan B4): every request the team made, or the system made for them, with its
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
      <Card title="Your recruiter requests" aside={open ? <Pill size="sm" tone="accent">{open} open</Pill> : null}>
        <p className="small muted" style={{ marginBottom: 8 }}>What your team asked ITS recruiters, and what they answered. Answers stay here for {RECENT_DAYS} days after they come in.</p>
        <ul aria-label="Your recruiter requests" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {current.map((r) => <RequestItem key={r.id} r={r} linked={r.id === linked} staff={who.staff} />)}
        </ul>
        {older.length ? (
          <details open={showOlder} onToggle={(e) => setShowOlder((e.target as HTMLDetailsElement).open)} style={{ marginTop: 10 }}>
            <summary className="small">Older requests ({older.length})</summary>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {older.map((r) => <RequestItem key={r.id} r={r} linked={r.id === linked} staff={who.staff} />)}
            </ul>
          </details>
        ) : null}
      </Card>
    </div>
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
  return (
    <li id={`request-${r.id}`} style={{ borderTop: "1px solid var(--line)", padding: "10px 0", scrollMarginTop: 80 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <strong>{aboutWords(r)}</strong>
        <span className="row" style={{ gap: 6 }}>
          {r.urgency === "high" || r.urgency === "critical" ? <Chip tone="caution">Urgent</Chip> : null}
          {r.reopenedCount ? <Chip>Reopened</Chip> : null}
          <Pill size="sm" tone={STATE_TONE[state]}>{STATE_WORDS[state]}</Pill>
        </span>
      </div>
      <p className="small muted" style={{ margin: "2px 0 0" }}>{[askedByWords(r.askedBy), replyByWords(r, now), picked].filter(Boolean).join(" · ")}</p>
      {answer && state === "answered" ? (
        <div style={{ marginTop: 8 }}>
          <p className="small muted" style={{ margin: 0 }}>{threadHeading(answer)}</p>
          <p style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{answer.body}</p>
        </div>
      ) : <p className="small" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", color: "var(--ink-2)" }}>{r.question}</p>}
      {said ? <div style={{ marginTop: 8 }}><Alert tone="info">{said}</Alert></div> : null}
      <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
        <Button size="sm" variant="quiet" onClick={() => setExpanded(!expanded)}>{expanded ? "Hide the conversation" : `Show the whole conversation (${r.thread.length})`}</Button>
        {may.note && mode !== "note" ? <Button size="sm" variant="secondary" onClick={() => { setMode("note"); setText(""); setSaid(null); }}>Add a note for the recruiter</Button> : null}
        {may.reopen && mode !== "reopen" ? <Button size="sm" variant="secondary" onClick={() => { setMode("reopen"); setText(""); setSaid(null); }}>This didn't solve it</Button> : null}
      </div>
      {expanded ? (
        <ol aria-label="The conversation" style={{ listStyle: "none", margin: "8px 0 0", padding: "0 0 0 12px", borderLeft: "2px solid var(--line)" }}>
          {r.thread.map((e) => (
            <li key={e.id} style={{ padding: "4px 0" }}>
              <p className="small muted" style={{ margin: 0 }}>{threadHeading(e)} · {new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
              <p className="small" style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{e.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {mode === "note" ? (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <Field label="Your note for the recruiter" htmlFor={fieldId} hint={r.recruiterName ? `${r.recruiterName} is told there is a new note and reads it with your request.` : "The recruiter who picks the request up reads it with your request."}>
            <textarea id={fieldId} className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row"><Button size="sm" variant="primary" disabled={!text.trim()} loading={note.isPending} onClick={() => note.mutate()}>Send note</Button><Button size="sm" variant="quiet" onClick={() => setMode(null)}>Cancel</Button></div>
        </div>
      ) : null}
      {mode === "reopen" ? (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          <Field label="What is still missing?" htmlFor={fieldId} hint="The recruiter reads this first.">
            <textarea id={fieldId} className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <p className="small muted" style={{ margin: 0 }}>{reopenHint(r.recruiterName, accessWords(r.scope), ACCESS_DAYS)}</p>
          <div className="row"><Button size="sm" variant="primary" disabled={text.trim().length < REOPEN_MIN} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen the request</Button><Button size="sm" variant="quiet" onClick={() => setMode(null)}>Keep it closed</Button></div>
        </div>
      ) : null}
    </li>
  );
}
