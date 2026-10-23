"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, Field } from "@ros/ui";
import { api, ApiError, type ApplicationDetail } from "../../api/client";
import { toast } from "../../toast";
import { callNotesBody, callNotesMayStayOpen, callNotesQuestions, callNotesToast } from "../../screen-view";
import { useDraft, useRefreshCandidate } from "./hooks";
import { CARD, LEAD, STEP, Why } from "./why";

/**
 * A recruiter's notes from a call (plan E3; founder decision Q16). A candidate who would rather talk to a person than to
 * the assistant is called by a recruiter, who adds what they learned here, under each question where it fits. By
 * default the notes finish the screening, so the scorecard is written from them. They are kept and shown as the
 * recruiter's notes, never as the candidate's own words, and are never used to say a must-have is not met. Shown to
 * recruiters only (the company's own, or ITS under a grant); the API checks it too. When the candidate asked for a
 * person it waits at the top of the panel as a step; otherwise it is a button on the AI interview tab that opens it
 * as a section card.
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
  // The questions the conversation asks (Wave S8: on one created since, the company's written questions), so each note keeps its question.
  const questions = callNotesQuestions(a);
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
  const look = prominent ? STEP : CARD;
  // Closed, the one button says what it does (a card titled the same over it said it twice, as on the Messages tab);
  // open, the card's title heads the form.
  if (!open) return <div className="row"><Button size="sm" icon="edit" onClick={() => setOpen(true)}>Add notes from a call</Button></div>;
  return (
    <Card needsYou={prominent} lift={prominent} title={prominent ? `${first} asked to talk to a person` : "Notes from a call"} className={look}>
      {/* the step a candidate's request opened says what to do first; the plain card's title already does */}
      {prominent ? <p className={LEAD}>Call or email them, then add what you learned here.</p> : null}
      <Why>
        {prominent ? <span>{first} chose a person instead of the assistant. Add what you learned under each question where it fits.</span> : null}
        <span>Your notes are kept as yours and labelled as notes from a call. They are never shown or quoted as {first}'s own words, never used to say a must-have is not met, and {first} does not see them.</span>
      </Why>
      <div className="stack gap-3">
        {questions.map((q) => (
          <Field key={q.key} label={q.question} htmlFor={`call-note-${q.key}`}>
            <textarea id={`call-note-${q.key}`} className="textarea" rows={2} maxLength={4000} value={byQuestion[q.key] ?? ""} onChange={(e) => setByQuestion((now) => ({ ...now, [q.key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Anything else from the call" htmlFor="call-note-other"><textarea id="call-note-other" className="textarea" rows={3} maxLength={4000} value={other} onChange={(e) => setOther(e.target.value)} /></Field>
        {mayStayOpen ? (
          <label className="check">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            Finish the AI interview with these notes, so the AI review is written from them
          </label>
        ) : <p className="small muted">{first} has no AI interview, so these notes are their AI interview: the AI review is written from them.</p>}
        {mayStayOpen && !complete ? <p className="small muted">The chat stays open, and you can add more notes later.</p> : null}
        <div className="row">
          <Button variant="primary" size="sm" disabled={!body} loading={save.isPending} onClick={() => save.mutate()}>Add the notes</Button>
          {!prominent ? <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>Cancel</Button> : null}
        </div>
      </div>
    </Card>
  );
}
