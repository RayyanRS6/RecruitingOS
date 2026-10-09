"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, ErrorState, Icon, Skeleton } from "@ros/ui";
import type { NoteStarter } from "@ros/contracts";
import { api, ApiError, type NoteView, type NotesView } from "../../api/client";
import { toast } from "../../toast";
import { NOTE_AUTOSAVE_MS, NOTE_BODY_MAX, NOTES_REMINDER, applyStarter, earlierVersions, noteExcerpt, noteMeta, noteSaveState, othersNotes, saveStatusWords, shouldAutosave, starterChoices, timeWords, whoReadsLine, type NoteWithVersions } from "../../notes";
import { useDraft } from "./hooks";

/**
 * Private team notes on a candidate (founder decision Q24; plan H3): each person's own note, saved as they type, with
 * starters ("Before the interview", "After the interview", "For and against"), the earlier versions kept, and a reminder
 * to stick to job-related facts. Never shown to the candidate and never given to the AI assistant. The hiring team reads
 * everyone's; an interviewer writes and reads only their own, on people they interviewed.
 */

export const notesKey = (applicationId: string) => ["notes", applicationId] as const;

/** GET /applications/:id/notes, not retried on a refusal (a role that cannot read notes gets a 403, and that is an answer). */
export function useNotes(applicationId: string, enabled = true) {
  return useQuery({
    queryKey: notesKey(applicationId),
    queryFn: () => api.get<NotesView>(`/api/v1/applications/${applicationId}/notes`),
    enabled,
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 2,
  });
}

/** The Notes tab: the reminder, your own note, then everyone else's you may read. */
export function NotesTab({ applicationId, firstName }: { applicationId: string; firstName: string }) {
  const q = useNotes(applicationId);
  if (q.isLoading) return <Skeleton lines={5} />;
  if (q.error || !q.data) return <ErrorState message={q.error instanceof ApiError ? q.error.message : "Could not load the notes."} onRetry={q.error instanceof ApiError && q.error.status === 403 ? undefined : () => q.refetch()} />;
  const view = q.data;
  const others = othersNotes(view);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Alert tone="info">
        <span className="row" style={{ gap: 6, alignItems: "flex-start", flexWrap: "nowrap" }}><Icon name="lock" size={16} /><span><strong>{view.privacy}</strong> {NOTES_REMINDER}</span></span>
      </Alert>
      <MyNote applicationId={applicationId} view={view} firstName={firstName} />
      {view.canRead === "all" ? (
        <Card title={others.length ? `Your team's notes (${others.length})` : "Your team's notes"}>
          {others.length ? <ul className="note-list">{others.map((n) => <NoteItem key={n.id} n={n} />)}</ul> : <p className="small muted">Nobody else has written a note on {firstName} yet.</p>}
        </Card>
      ) : null}
      <p className="small muted" style={{ margin: 0 }}>{whoReadsLine(view.canRead)}</p>
    </div>
  );
}

/** Someone else's note: who, from which starter, when, and the words. */
function NoteItem({ n }: { n: NoteWithVersions }) {
  return (
    <li className="note-item">
      <Avatar name={n.author.name} size="sm" />
      <div>
        <p className="small muted" style={{ margin: 0 }}>{noteMeta(n)}</p>
        <p className="note-body">{n.body}</p>
      </div>
    </li>
  );
}

/**
 * The reader's own note: the starters, the box (saved when typing pauses), where the save stands, the earlier versions,
 * and Remove. Someone who may not write sees why instead. Also on the interview sheet, for an interviewer's own note.
 */
export function MyNote({ applicationId, view, firstName, compact = false }: { applicationId: string; view: NotesView; firstName: string; compact?: boolean }) {
  const qc = useQueryClient();
  const mine = (view.mine ?? null) as NoteWithVersions | null;
  const [text, setText] = useState(mine?.body ?? "");
  const [starter, setStarter] = useState<NoteStarter | null>(mine?.starter ?? null);
  const [saved, setSaved] = useState<{ body: string; at: string | null }>({ body: mine?.body ?? "", at: mine?.updatedAt ?? null });
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const save = useMutation({
    mutationFn: (body: string) => api.put<{ note: NoteView; changed: boolean }>(`/api/v1/applications/${applicationId}/notes/mine`, { starter, body }),
    onSuccess: (r) => {
      setSaved({ body: r.note.body, at: r.note.updatedAt });
      setError(null);
      qc.setQueryData<NotesView>(notesKey(applicationId), (old) => (old ? { ...old, mine: r.note, notes: [...old.notes.filter((n) => !n.mine), r.note] } : old));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "the connection dropped; it saves again when you type"),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/v1/applications/${applicationId}/notes/mine`),
    onSuccess: async () => {
      setText("");
      setStarter(null);
      setSaved({ body: "", at: null });
      setRemoving(false);
      toast("Your note was removed.", "Nobody on the team sees it any more.");
      await qc.invalidateQueries({ queryKey: notesKey(applicationId) });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not remove the note."),
  });
  const saving = save.isPending;
  const mutate = save.mutate;
  // Autosave: once typing pauses, new words worth keeping are saved. The server makes one version per sitting: the words
  // replaced after a longer pause are kept as an earlier version.
  useEffect(() => {
    if (!shouldAutosave({ text, saved: saved.body, saving })) return;
    const t = setTimeout(() => mutate(text.trim()), NOTE_AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [text, saved.body, saving, mutate]);
  const state = noteSaveState({ text, saved: saved.body, saving, error });
  // Words not saved yet count as unsent text: moving to the next person asks first.
  useDraft(`note-${applicationId}`, state === "unsaved" || state === "error" || state === "too_long" ? text : "");
  const versions = earlierVersions(mine);
  const boxId = `my-note-${applicationId}`;
  if (!view.canWrite) {
    return (
      <Card title="Your note">
        {mine ? <p className="note-body">{mine.body}</p> : null}
        <p className="small muted" style={{ margin: mine ? "8px 0 0" : 0 }}>{view.writeBlockedReason ?? "Your role can't write notes on candidates."}</p>
      </Card>
    );
  }
  const pick = (s: NoteStarter) => {
    setText((now) => applyStarter(now, s));
    if (!starter || !text.trim()) setStarter(s);
  };
  return (
    <Card title="Your note" aside={mine?.edited || versions.length ? <Chip>Changed</Chip> : null}>
      {compact ? <p className="small muted" style={{ margin: "0 0 8px" }}>{NOTES_REMINDER}</p> : null}
      <div className="row" style={{ gap: 6, marginBottom: 8 }} role="group" aria-label="Start from">
        {/* the chosen starter is heard as pressed, not only seen by its fill */}
        {starterChoices(view).map((s) => <Button key={s.id} size="sm" variant={starter === s.id ? "primary" : "secondary"} ariaPressed={starter === s.id} onClick={() => pick(s.id)} title={s.prompt}>{s.label}</Button>)}
        {/* once words are written, another starter adds its heading but the note stays filed under the first one: say which */}
        <span className="small muted" aria-live="polite">{starter ? `Filed under: ${starterChoices(view).find((c) => c.id === starter)?.label ?? starter}` : ""}</span>
      </div>
      <label htmlFor={boxId} className="sr-only">Your note on {firstName}</label>
      <textarea id={boxId} className="textarea note-box" rows={compact ? 4 : 7} maxLength={NOTE_BODY_MAX + 200} value={text} onChange={(e) => setText(e.target.value)} placeholder={`What you saw and heard, as it bears on the job. Only your team reads it; ${firstName} never does.`} aria-describedby={`${boxId}-status`} />
      <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
        <span id={`${boxId}-status`} className={state === "error" || state === "too_long" ? "small note-problem" : "small muted"} aria-live="polite">{saveStatusWords(state, { savedAt: saved.at, error })}</span>
        <span className="row" style={{ gap: 6 }}>
          {state === "error" ? <Button size="sm" onClick={() => mutate(text.trim())}>Try again</Button> : null}
          {saved.body && !removing ? <Button size="sm" variant="quiet" onClick={() => setRemoving(true)}>Remove my note</Button> : null}
        </span>
      </div>
      {removing ? (
        <Alert tone="caution">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Remove your note? Nobody on the team will see it any more.</span>
            <span className="row"><Button size="sm" variant="primary" loading={remove.isPending} onClick={() => remove.mutate()}>Yes, remove it</Button><Button size="sm" variant="quiet" onClick={() => setRemoving(false)}>Keep it</Button></span>
          </div>
        </Alert>
      ) : null}
      {versions.length ? (
        <details className="small" style={{ marginTop: 8 }}>
          <summary>Earlier versions ({versions.length})</summary>
          <ul className="note-versions">{versions.map((v) => <li key={v.at}><span className="muted">Until {timeWords(v.at)}</span><p className="note-body">{v.body}</p></li>)}</ul>
        </details>
      ) : mine?.edited ? <p className="small muted" style={{ marginTop: 8 }}>Changed since it was first written; the earlier words are kept on record.</p> : null}
    </Card>
  );
}

/**
 * The team's notes where a decision is made (the "How did the interview go?" card): who wrote what, in a line each, and
 * the way to the Notes tab to read them in full or add your own. Nothing for someone who does not read notes.
 */
export function NotesSummary({ applicationId, onOpen }: { applicationId: string; onOpen: () => void }) {
  const q = useNotes(applicationId);
  if (!q.data) return null;
  const notes = [...q.data.notes].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
  return (
    <div className="notes-summary">
      <p className="small" style={{ margin: 0 }}><strong>Team notes</strong> <span className="muted">(private)</span></p>
      {notes.length ? (
        <ul className="note-lines">{notes.map((n) => <li key={n.id} className="small"><strong>{n.mine ? "You" : n.author.name}</strong>{n.starterLabel ? <span className="muted"> · {n.starterLabel}</span> : null}: {noteExcerpt(n.body)}</li>)}</ul>
      ) : <p className="small muted" style={{ margin: "2px 0 0" }}>No notes yet.</p>}
      <Button size="sm" variant="quiet" onClick={onOpen}>{q.data.canWrite && !q.data.mine ? "Add your note" : "Open the notes"}</Button>
    </div>
  );
}
