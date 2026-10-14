"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, Field } from "@ros/ui";
import { api, ApiError, type ApplicationDetail } from "../../api/client";
import { toast } from "../../toast";
import { callNotesBody, callNotesMayStayOpen, callNotesToast } from "../../screen-view";
import { useDraft, useRefreshCandidate } from "./hooks";
import { Why } from "./why";

/**
 * A recruiter's notes from a call (plan E3; founder decision Q16). A candidate who would rather talk to a person than to
 * the assistant is called by a recruiter, who adds what they learned here, under each question where it fits. By
 * default the notes finish the screening, so the scorecard is written from them. They are kept and shown as the
 * recruiter's notes, never as the candidate's own words, and are never used to say a must-have is not met. Shown to
 * recruiters only (the company's own, or ITS under a grant); the API checks it too.
 */
export function CallNotesCard({ a, roleId, prominent }: { a: ApplicationDetail; roleId: string; prominent: boolean }) {
  const [open, setOpen] = useState(prominent);
  const [byQuestion, setByQuestion] = useState<Record<string, string>>({});
  const [other, setOther] = useState("");
  const [complete, setComplete] = useState(true);
  useDraft("call-notes", [...Object.values(byQuestion), other].join("").trim());
  const refresh = useRefreshCandidate(a.id, roleId);
  // With no conversation yet, the notes are the screening and always finish it.
  const mayStayOpen = callNotesMayStayOpen(a);
  const body = callNotesBody(byQuestion, other, complete || !mayStayOpen);
  const save = useMutation({
    mutationFn: () => api.post<{ ok: true; screenId: string; completed: boolean }>(`/api/v1/applications/${a.id}/screen/recruiter-notes`, body),
    onSuccess: async (r) => {
      const t = callNotesToast(r, a.candidate.firstName);
      toast(t.title, t.detail);
      setByQuestion({});
      setOther("");
      setOpen(false);
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not add the notes. Try again."),
  });
  const first = a.candidate.firstName;
  if (!open) {
    return (
      <Card title="Notes from a call">
        <p className="small muted">Talked with {first} by phone? Add what you learned.</p>
        <div className="row" style={{ marginTop: 8 }}><Button size="sm" icon="edit" onClick={() => setOpen(true)}>Add notes from a call</Button></div>
      </Card>
    );
  }
  return (
    <Card needsYou={prominent} lift={prominent} title={prominent ? `${first} asked to talk to a person` : "Notes from a call"}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{prominent ? "Call or email them, then add what you learned here." : `Add what you learned on the call with ${first}.`}</p>
      <Why>
        {prominent ? <span>{first} chose a person instead of the assistant. Add what you learned under each question where it fits.</span> : null}
        <span>Your notes are kept as yours and labelled as notes from a call. They are never shown or quoted as {first}'s own words, never used to say a must-have is not met, and {first} does not see them.</span>
      </Why>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        {a.packetLabels.questions.map((q) => (
          <Field key={q.key} label={q.question} htmlFor={`call-note-${q.key}`}>
            <textarea id={`call-note-${q.key}`} className="textarea" rows={2} maxLength={4000} value={byQuestion[q.key] ?? ""} onChange={(e) => setByQuestion((now) => ({ ...now, [q.key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Anything else from the call" htmlFor="call-note-other"><textarea id="call-note-other" className="textarea" rows={3} maxLength={4000} value={other} onChange={(e) => setOther(e.target.value)} /></Field>
        {mayStayOpen ? (
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            Finish the screening with these notes, so the AI review is written from them
          </label>
        ) : <p className="small muted" style={{ margin: 0 }}>{first} has no screening chat, so these notes are the screening: the AI review is written from them.</p>}
        {mayStayOpen && !complete ? <p className="small muted" style={{ margin: 0 }}>The chat stays open, and you can add more notes later.</p> : null}
        <div className="row">
          <Button variant="primary" size="sm" disabled={!body} loading={save.isPending} onClick={() => save.mutate()}>Add the notes</Button>
          {!prominent ? <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>Cancel</Button> : null}
        </div>
      </div>
    </Card>
  );
}
