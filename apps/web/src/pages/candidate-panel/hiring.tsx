"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Field } from "@ros/ui";
import { api, ApiError, type ActionResult, type ApplicationDetail, type ClosingMessagePreview, type HireFollowUp, type OfferMadeResult } from "../../api/client";
import { toast } from "../../toast";
import { ClosingMessageCard } from "../../components/ClosingMessage";
import { closeRoleToast, type PanelStep } from "../../talent-actions";
import { dayKey, hireConfirmText, hireFollowUpView, hireToast, keepWarmToast, offerAnswerToast, offerDateBounds, offerMadeToast, offerNote, offerStepText, waitingOnCandidateText } from "../../hiring";
import { useDraft, useFocusOnMount, useRefreshCandidate } from "./hooks";

/**
 * Interviews to hire on the candidate panel (plan Wave H; founder decision Q29): what comes after a finalist (an offer
 * made outside the app, a hire, or not moving forward), the record-only "Offer made", the wait for the candidate's answer
 * (Accepted opens the hire sheet; Declined is recorded), and the hire sheet with what to do next with the role and the
 * other finalists. The app never writes, sends or changes an offer, and nothing here sends anything to the candidate.
 */

/** A finalist (or someone whose references are being checked): what next, one click each. */
export function FinalistCard({ a, setStep }: { a: ApplicationDetail; setStep: (step: PanelStep) => void }) {
  const first = a.candidate.firstName;
  return (
    <Card needsYou title={`${first} is a finalist: what next?`}>
      <p className="small" style={{ color: "var(--ink-2)" }}>Make the offer yourself, by phone or in writing, then record it here; the app never writes or sends an offer. When they accept, record the hire. Nothing here is sent to {first}.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <Button size="sm" variant="primary" onClick={() => setStep("offer")} title="Records the day and an optional private note; nothing is sent">Offer made</Button>
        <Button size="sm" onClick={() => setStep("hire")}>They accepted: hire</Button>
        {a.allowedActions.includes("reject") ? <Button size="sm" variant="quiet" onClick={() => setStep("decline")}>Not moving forward</Button> : null}
      </div>
    </Card>
  );
}

/** "Offer made" (Q29): the day it was made and a private note; record-only, nothing sent to the candidate. */
export function OfferStep({ a, roleId, onClose }: { a: ApplicationDetail; roleId: string; onClose: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const bounds = offerDateBounds();
  const [madeOn, setMadeOn] = useState(bounds.initial);
  const [note, setNote] = useState("");
  useDraft("offer-note", note);
  const first = useFocusOnMount<HTMLInputElement>();
  const record = useMutation({
    mutationFn: () => api.post<OfferMadeResult>(`/api/v1/applications/${a.id}/offer`, { confirm: true, madeOn, note: note.trim() || undefined }),
    onSuccess: async () => {
      const t = offerMadeToast(a.candidate.firstName);
      toast(t.title, t.detail);
      onClose();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the offer."),
  });
  const valid = !!madeOn && madeOn <= bounds.max;
  return (
    <Card needsYou lift title="Offer made">
      <p className="small" style={{ color: "var(--ink-2)" }}>{offerStepText(a.candidate.firstName)}</p>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        <Field label="The day you made the offer" htmlFor="offer-day"><input ref={first} id="offer-day" className="input" type="date" max={bounds.max} value={madeOn} onChange={(e) => setMadeOn(e.target.value)} /></Field>
        <Field label="Private note (kept internally, optional)" htmlFor="offer-note" hint="For your team only, for example what was agreed to follow up on. Never sent to the candidate; no pay, tax or bank details are asked for."><textarea id="offer-note" className="textarea" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="row">
          <Button variant="primary" size="sm" disabled={!valid} loading={record.isPending} onClick={() => record.mutate()}>Record the offer</Button>
          <Button variant="quiet" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

/** An offer waiting on the candidate's answer (the "waiting on the candidate" group): Accepted opens the hire sheet; Declined is recorded. */
export function WaitingOnCandidateCard({ a, roleId, onAccepted }: { a: ApplicationDetail; roleId: string; onAccepted: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [answer, setAnswer] = useState<"declined" | "withdrew" | null>(null);
  const [note, setNote] = useState("");
  useDraft("offer-answer-note", note);
  const record = useMutation({
    mutationFn: (which: "declined" | "withdrew") => api.post<Pick<ActionResult, "interviewsCancelled" | "interviewOffNotes">>(`/api/v1/applications/${a.id}/outcome`, { outcome: which === "declined" ? "offer_declined_externally" : "candidate_withdrew", confirm: true, note: note.trim() || undefined }),
    onSuccess: async (r, which) => {
      const t = offerAnswerToast(which, r);
      toast(t.title, t.detail);
      setAnswer(null);
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record their answer."),
  });
  const mayRecord = a.allowedActions.includes("record_outcome");
  const privateNote = offerNote(a);
  return (
    <Card needsYou title={`Waiting on ${a.candidate.firstName}'s answer`}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{waitingOnCandidateText(a)}</p>
      {privateNote ? <p className="small muted" style={{ marginTop: 4 }}>Your note with the offer (kept internally): {privateNote}</p> : null}
      {!mayRecord ? <p className="small muted" style={{ marginTop: 6 }}>{a.blockedReasons.record_outcome ?? "Your role can't record their answer."}</p> : answer ? (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <p className="small" style={{ margin: 0 }}>{answer === "declined" ? `Record that ${a.candidate.firstName} declined the offer?` : `Record that ${a.candidate.firstName} withdrew?`} It is recorded with your name; nothing is sent to them.</p>
          <Field label="Note (kept internally, optional)" htmlFor="offer-answer-note"><input id="offer-answer-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate(answer)}>Yes, record it</Button>
            <Button size="sm" variant="quiet" onClick={() => setAnswer(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="primary" onClick={onAccepted}>They accepted</Button>
          <Button size="sm" onClick={() => setAnswer("declined")}>They declined</Button>
          <Button size="sm" variant="quiet" onClick={() => setAnswer("withdrew")}>They withdrew</Button>
        </div>
      )}
    </Card>
  );
}

/** What the hire answers: the backups and closing the role (plan H1). */
type HireAnswer = { hire?: HireFollowUp | null; roleId?: string };

/**
 * The hire sheet (plan H1), one sheet: the start date, the day they accepted the offer (optional), a confirmation, and
 * then what to do with the role and the others still in the running: close it now and tell them (the one closing message,
 * seen before it goes), or keep them warm until the start date. After an interview with no decision yet, the hire is
 * recorded as that interview's decision too.
 */
export function HireStep({ a, roleId, onClose }: { a: ApplicationDetail; roleId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshCandidate(a.id, roleId);
  const name = `${a.candidate.firstName} ${a.candidate.lastName}`.trim();
  const [startDate, setStartDate] = useState("");
  const [acceptedOn, setAcceptedOn] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [after, setAfter] = useState<HireFollowUp | null>(null);
  const [closing, setClosing] = useState<ClosingMessagePreview | null>(null);
  useDraft("hire-note", note);
  const first = useFocusOnMount<HTMLInputElement>();
  // An interview over and undecided: the hire is its decision (POST /decision with "hired"), so both records agree.
  const viaDecision = a.allowedActions.includes("record_decision");
  const record = useMutation({
    mutationFn: () => viaDecision
      ? api.post<HireAnswer>(`/api/v1/applications/${a.id}/decision`, { decision: "hired", hireDate: startDate, offerAcceptedAt: acceptedOn || undefined, note: note.trim() || undefined })
      : api.post<HireAnswer>(`/api/v1/applications/${a.id}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: startDate, offerAcceptedAt: acceptedOn || undefined, note: note.trim() || undefined }),
    onSuccess: async (r) => {
      const t = hireToast({ name, startDate });
      toast(t.title, t.detail);
      setConfirming(false);
      const follow = r.hire ?? null;
      if (follow && (follow.backups.count > 0 || follow.closeRole)) setAfter(follow);
      else onClose();
      await refresh();
    },
    onError: (e) => { setConfirming(false); toast(e instanceof ApiError ? e.message : "Could not record the hire."); },
  });
  const close = useMutation({
    mutationFn: (path: string) => api.post<{ movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number; closingMessage?: ClosingMessagePreview | null }>(path, { outcome: "filled", confirm: true }),
    onSuccess: async (r) => {
      const t = closeRoleToast(r);
      toast(t.title, t.detail);
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["role", roleId] })]);
      if (r.closingMessage && r.closingMessage.count > 0) setClosing(r.closingMessage);
      else onClose();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the role."),
  });
  if (closing) return <ClosingMessageCard roleId={roleId} preview={closing} onDone={onClose} />;
  if (after) {
    const v = hireFollowUpView(after, a.candidate.firstName || name);
    return (
      <Card needsYou lift title={`${name} is hired: what about the role?`}>
        <p className="small" style={{ color: "var(--ink-2)" }}>{v.startLine}</p>
        {v.backupsLine ? (
          <>
            <p className="small" style={{ margin: "8px 0 4px" }}>{v.backupsLine}</p>
            <ul className="people-list" aria-label="Still in the running">
              {v.people.map((p) => <li key={p.applicationId}><Avatar name={p.name} size="sm" /><span>{p.name}</span><span className="muted small">{p.stageLabel}</span></li>)}
            </ul>
          </>
        ) : null}
        <div className="hire-choices">
          {v.mayClose && after.closeRole ? (
            <div className="hire-choice">
              <strong>Close the role now and tell them</strong>
              <p className="small muted">{v.closeWords}</p>
              <Button size="sm" variant="primary" loading={close.isPending} onClick={() => close.mutate(after.closeRole!.path)}>Close it now</Button>
            </div>
          ) : null}
          {v.keepWarmWords ? (
            <div className="hire-choice">
              <strong>Keep them warm until the start date</strong>
              <p className="small muted">{v.keepWarmWords}</p>
              <Button size="sm" onClick={() => { const t = keepWarmToast(a.candidate.firstName || name, after.startDate); toast(t.title, t.detail); onClose(); }}>Keep the role open</Button>
            </div>
          ) : null}
        </div>
        {!v.mayClose && !v.keepWarmWords ? <div className="row" style={{ marginTop: 10 }}><Button size="sm" onClick={onClose}>Done</Button></div> : null}
      </Card>
    );
  }
  const valid = !!startDate;
  return (
    <Card needsYou lift title={`Hire ${name}`}>
      <p className="small muted">You record it with your name; the platform never makes or sends an offer, and it asks for no pay, tax, identity or banking details.</p>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <Field label="Start date (agreed with them)" htmlFor="hire-start"><input ref={first} id="hire-start" className="input" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setConfirming(false); }} /></Field>
        <Field label="The day they accepted the offer (optional)" htmlFor="hire-accepted"><input id="hire-accepted" className="input" type="date" max={dayKey(new Date())} value={acceptedOn} onChange={(e) => { setAcceptedOn(e.target.value); setConfirming(false); }} /></Field>
        <Field label="Note (kept internally, optional)" htmlFor="hire-note"><input id="hire-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {confirming ? (
          <Alert tone="caution">
            <div className="stack" style={{ gap: 8 }}>
              <span>{hireConfirmText({ name, startDate, offerAcceptedAt: acceptedOn || undefined })}</span>
              <div className="row"><Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate()}>Yes, record the hire</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></div>
            </div>
          </Alert>
        ) : (
          <div className="row"><Button size="sm" variant="primary" disabled={!valid} onClick={() => setConfirming(true)}>Continue</Button><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div>
        )}
      </div>
    </Card>
  );
}
