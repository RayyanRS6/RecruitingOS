"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, ErrorState, Field, Skeleton } from "@ros/ui";
import { DECISION_WORDING_LABEL, type DecisionWording } from "@ros/contracts";
import { api, ApiError, type ActionResult, type ApplicationDetail, type CandidateNotice, type DecisionMessagePreview } from "../../api/client";
import { toast } from "../../toast";
import { decisionOnItsWayText } from "../../company-check";
import { useCompanyCheck } from "../../components/use-company-check";
import { InlineUndo } from "../../components/InlineUndo";
import { useTakeBack, useUndoToast } from "../../components/use-undo";
import { sendDecisionToast } from "../../talent-actions";
import { PERSONAL_LINE_HINT, PERSONAL_LINE_MAX, WORDING_HINT, safetyNetLine, sendButtonLabel, sendPolicyLine, sentWithUndoToast, undoMillisLeft, wordingChoices } from "../../telling";
import { whoDecides } from "./helpers";
import { useCandidateAction, useDraft, useRefreshCandidate } from "./hooks";
import { LEAD, STEP } from "./why";

/**
 * Telling the candidate a decision (founder decisions B6, Q27, Q28; plan Wave G). The decision was private; this card
 * waits until someone tells them: "Send message" opens the Send screen (one of the approved wordings, an optional
 * personal line checked before anything goes, the exact message shown first), and Send gives 30 seconds to Undo. "I told
 * them myself" records it. The safety net says on which day the standard message goes by itself, or a recruiter is
 * brought in, if nobody does.
 */

/** A value that settles once it has not changed for `ms` (the personal line is checked when typing pauses). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** What a waiting approval carries: the wording and the personal line the Send chose (Q28). */
type WaitingProposal = { wording?: DecisionWording | null; personalLine?: { text?: string } | null };

export function TellCard({ a, roleId, myRole }: { a: ApplicationDetail; roleId: string; myRole: string | null }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const takeBack = useTakeBack();
  const [sending, setSending] = useState(false);
  const [inPerson, setInPerson] = useState(false);
  const [takingBack, setTakingBack] = useState(false);
  const [note, setNote] = useState("");
  // The message this card's Send queued, while it waits out its Undo window: Undo is offered here as well as on the toast.
  const [sent, setSent] = useState<{ communicationId: string; undoUntil: string } | null>(null);
  useDraft("told-note", note);
  const act = useCandidateAction(a.id, roleId, () => { setSending(false); setInPerson(false); setTakingBack(false); });
  const waiting = a.pendingApprovals.find((p) => p.actionType === "disposition.send");
  // In the outbox of a company ITS has not confirmed yet, the message waits for the check (founder decision B7).
  const check = useCompanyCheck();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => api.post<{ candidateNotice?: CandidateNotice }>(`/api/v1/approvals/${waiting?.id}/decide`, { decision }),
    onSuccess: async (r, decision) => {
      const t = decision === "approve" ? sendDecisionToast(r.candidateNotice ?? "not_sent") : { title: "Not sent.", detail: "The candidate has not been told. Send it later, or tell them yourself and record it." };
      toast(t.title, t.detail);
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const first = a.candidate.firstName;
  if (a.toldState === "queued") {
    // a message that seems stuck can be settled by a person: recording that they told them withdraws it if it has not left
    return (
      <Alert tone="info">
        <div className="row justify-between">
          <span>{decisionOnItsWayText(first, check)}</span>
          <span className="row">
            {sent ? <InlineUndo autoFocus undoUntil={sent.undoUntil} ariaLabel={`Undo the decision message to ${first}`} onUndo={async () => { await takeBack({ applicationId: a.id, roleId, communicationId: sent.communicationId, firstName: first, kind: "decision" }); setSent(null); }} /> : null}
            {a.allowedActions.includes("told_in_person") ? <Button size="sm" variant="quiet" loading={act.isPending} onClick={() => act.mutate({ action: "told_in_person", note: "Told them while the message was on its way" })}>I told them myself</Button> : null}
          </span>
        </div>
      </Alert>
    );
  }
  if (a.toldState !== "not_told") return null;
  const mayApprove = !!waiting && !!myRole && (waiting.requiredRoles.length ? waiting.requiredRoles.includes(myRole) : ["owner", "admin"].includes(myRole));
  const canSend = a.allowedActions.includes("send_decision");
  const canTell = a.allowedActions.includes("told_in_person");
  // Quiet undo (plan G1): the decision goes, and they are back at the step it was made from; the stage button offers the same.
  const backTo = a.allowedActions.includes("undo_decision") ? a.stageMoves.find((m) => m.via === "undo_decision" && m.allowed) : undefined;
  const proposal = (waiting?.proposal ?? {}) as WaitingProposal;
  const chosen = proposal.wording && proposal.wording in DECISION_WORDING_LABEL ? `the "${DECISION_WORDING_LABEL[proposal.wording]}" wording` : "the standard wording";
  const line = proposal.personalLine?.text?.trim();
  // a closed role's one closing message naming them waits for approval too (Q30): no safety-net date while it does
  const safety = safetyNetLine({ a, waitingApproval: !!waiting || !!a.decisionMessageWaiting });
  return (
    <Card needsYou lift title={waiting ? `Send the decision message to ${first}?` : `${first} has not been told yet`} className={STEP}>
      {waiting ? (
        <p className={LEAD}>{mayApprove ? `Someone on your team wants to send the decision message, in ${chosen}.` : `The decision message, in ${chosen}, is waiting for ${whoDecides(waiting.requiredRoles)} to approve it.`} Nothing goes out until it is approved.</p>
      ) : a.decisionMessageWaiting ? (
        <p className={LEAD}>The role's closing message, which includes {first}, is waiting for approval. Nothing goes out until it is approved; it is decided on Home.</p>
      ) : (
        <p className={LEAD}>Your decision is private: nothing has been sent to {first}.</p>
      )}
      {waiting && line ? <p className="small">Their personal line: <q>{line}</q></p> : null}
      {/* The safety net in one short line (founder decision D-03 A), with its day, set off by a rule on its left. */}
      {safety && !sending ? <p className="small muted border-l-2 border-line-2 pl-2.5">{safety}</p> : null}
      {waiting && mayApprove ? (
        <div className="row">
          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate("approve")}>Yes, send it</Button>
          <Button size="sm" variant="quiet" loading={decide.isPending} onClick={() => decide.mutate("reject")}>Do not send</Button>
        </div>
      ) : null}
      {!waiting && !sending && !inPerson && !takingBack ? (
        <div className="row">
          <Button size="sm" variant="primary" icon="send" disabled={!canSend} title={canSend ? "Shows the message before anything is sent" : a.blockedReasons.send_decision} onClick={() => setSending(true)}>Send message</Button>
          <Button size="sm" disabled={!canTell} title={canTell ? "Records it; nothing is sent" : a.blockedReasons.told_in_person} onClick={() => setInPerson(true)}>I told them myself</Button>
          {backTo ? <Button size="sm" variant="quiet" title="If this was a mistake: they go back to where they were" onClick={() => setTakingBack(true)}>Take back this decision</Button> : null}
        </div>
      ) : null}
      {takingBack && backTo ? (
        <div className="stack gap-3">
          {/* Someone declined from Cancelled goes back there, with what they chose (their promised new times may still go). */}
          <p className="small">{backTo.to === "cancelled" ? `Take back this decision? ${first} goes back under Cancelled, with what they chose. Nothing about this decision was sent to them, and nothing will be.` : `Take back this decision? ${first} goes back to ${backTo.label}. Nothing was sent to them, and nothing will be.`}</p>
          <div className="row">
            <Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: "undo_decision" })}>Yes, take it back</Button>
            <Button size="sm" variant="quiet" onClick={() => setTakingBack(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {waiting && !inPerson && canTell ? <div className="row"><Button size="sm" variant="quiet" onClick={() => setInPerson(true)}>I told them myself</Button></div> : null}
      {!canSend && !canTell && a.blockedReasons.send_decision ? <p className="small muted">{a.blockedReasons.send_decision}</p> : null}
      {sending ? <SendDecisionStep a={a} roleId={roleId} onClose={() => setSending(false)} onSent={setSent} /> : null}
      {inPerson ? (
        <div className="stack gap-3">
          <p className="small">Record that you told {first} yourself? Nothing more will be sent to them about this decision.</p>
          <Field label="How and when (kept internally, optional)" htmlFor="told-note"><input id="told-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: by phone on Tuesday" /></Field>
          <div className="row">
            <Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: "told_in_person", note: note.trim() || undefined })}>Yes, record it</Button>
            <Button size="sm" variant="quiet" onClick={() => setInPerson(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The Send screen (Q28): the approved wordings, the suggested one chosen to start with; an optional personal line, checked
 * as it is typed exactly as Send checks it (a refusal says what to take out, and Send waits); and the exact message the
 * candidate gets. Send under "Do it" waits out the Undo window, with Undo on the toast and, through `onSent`, on the
 * card that opened this step (where the keyboard can reach it inside the panel).
 */
export function SendDecisionStep({ a, roleId, onClose, onSent }: { a: ApplicationDetail; roleId: string; onClose: () => void; onSent?: (sent: { communicationId: string; undoUntil: string }) => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const undoToast = useUndoToast();
  const base = useQuery({ queryKey: ["decision-message", a.id], queryFn: () => api.get<DecisionMessagePreview>(`/api/v1/applications/${a.id}/decision-message`) });
  const [wording, setWording] = useState<DecisionWording | null>(null);
  const [line, setLine] = useState("");
  useDraft("personal-line", line);
  const settledLine = useSettled(line.trim(), 600);
  const chosen = wording ?? base.data?.wording ?? null;
  // The first answer is the suggested wording (Q28) with no line; any other choice is checked and shown by the API (the line travels in the body).
  const custom = !!base.data && (chosen !== base.data.wording || !!settledLine);
  const preview = useQuery({
    queryKey: ["decision-message", a.id, chosen, settledLine],
    queryFn: () => api.post<DecisionMessagePreview>(`/api/v1/applications/${a.id}/decision-message/preview`, { wording: chosen ?? undefined, personalLine: settledLine || undefined }),
    enabled: custom,
    retry: false,
  });
  const shown = custom ? preview.data : base.data;
  const refused = custom && preview.error instanceof ApiError && preview.error.code === "personal_line_refused" ? preview.error.message : null;
  const checking = custom && (preview.isFetching || settledLine !== line.trim());
  const send = useMutation({
    mutationFn: () => api.post<ActionResult>(`/api/v1/applications/${a.id}/actions`, { action: "send_decision", wording: chosen ?? undefined, personalLine: line.trim() || undefined }),
    onSuccess: async (r) => {
      const notice = r.candidateNotice ?? "not_sent";
      const plain = sendDecisionToast(notice);
      const seconds = Math.round(undoMillisLeft(r.undoUntil) / 1000);
      const t = sentWithUndoToast({ firstName: a.candidate.firstName, seconds, wording: r.wording ?? chosen, kind: "decision" });
      undoToast({ applicationId: a.id, roleId, communicationId: notice === "queued" ? r.communicationId : null, undoUntil: r.undoUntil, firstName: a.candidate.firstName, kind: "decision", title: t.title, detail: t.detail ?? "", plain });
      if (notice === "queued" && r.communicationId && r.undoUntil && undoMillisLeft(r.undoUntil) > 0) onSent?.({ communicationId: r.communicationId, undoUntil: r.undoUntil });
      onClose();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the message."),
  });
  if (base.isLoading) return <Skeleton lines={4} />;
  if (base.error || !base.data) return <ErrorState message="Could not load the message." onRetry={() => base.refetch()} />;
  const d = base.data;
  const choices = wordingChoices(d.wordings);
  const fixed = choices.length <= 1;
  const sendable = !!d.to && d.policy !== "not_sent" && !refused && !checking && !!shown;
  return (
    <div className="stack gap-3">
      <p className="small muted">{sendPolicyLine({ to: d.to, policy: d.policy, undoSeconds: d.undoSeconds })}</p>
      {fixed ? (
        <p className="small">Wording: <strong>{choices[0]?.label ?? DECISION_WORDING_LABEL[d.wording]}</strong>. <span className="muted">{WORDING_HINT[d.wording]}</span></p>
      ) : (
        // each approved wording a card to pick, tinted once picked
        <fieldset className="grid gap-2 [&>legend]:mb-2 [&>legend]:font-semibold">
          <legend className="small">Which approved wording?</legend>
          {choices.map((c) => (
            <label key={c.id} className="check data-[checked=true]:border-line-tint data-[checked=true]:bg-tint" data-checked={chosen === c.id ? "true" : undefined}>
              <input type="radio" name={`wording-${a.id}`} value={c.id} checked={chosen === c.id} onChange={() => setWording(c.id)} aria-label={c.text} />
              <span><strong>{c.text}</strong><br /><span className="small muted">{c.hint}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      {/* The personal line is optional: one click away; the message below always shows what goes, line included. */}
      <details className="more">
        <summary>{line.trim() ? "Your personal line" : "Add a personal line (optional)"}</summary>
        <div className="stack gap-1">
          <Field label="A personal line (optional)" htmlFor={`personal-line-${a.id}`} hint={PERSONAL_LINE_HINT}>
            <textarea id={`personal-line-${a.id}`} className="textarea" rows={2} maxLength={PERSONAL_LINE_MAX} value={line} onChange={(e) => setLine(e.target.value)} placeholder={`For example: It was a pleasure to meet you, ${a.candidate.firstName}.`} />
          </Field>
          {/* the count is announced only near the limit, not on every keystroke */}
          <p className="small muted text-right tabular-nums" aria-live={line.length >= PERSONAL_LINE_MAX - 30 ? "polite" : "off"}>{line.length} of {PERSONAL_LINE_MAX}</p>
        </div>
      </details>
      {refused ? <Alert tone="critical">{refused}</Alert> : null}
      {custom && preview.error && !refused ? <ErrorState message={preview.error instanceof ApiError ? preview.error.message : "Could not show the message with your changes."} onRetry={() => preview.refetch()} /> : null}
      {shown && !refused ? (
        // the email as it goes: on the paper ground inside the card, like a letter
        <div className="card message-preview grid gap-1.5 rounded-xl bg-ground p-4 shadow-none" aria-busy={checking || undefined}>
          {/* only this short line is live, so the whole message is not read out again after each check */}
          <p className="small muted" aria-live="polite">What {a.candidate.firstName} gets{checking ? " (checking your line…)" : ""}</p>
          <p className="small"><strong>{shown.subject}</strong></p>
          <p className="small whitespace-pre-wrap">{shown.text}</p>
          {shown.adverseDecisionLine ? <p className="small muted mt-1">Colorado's notice is included: they can ask for the reasons and for a person to review the decision.</p> : null}
        </div>
      ) : null}
      <div className="row">
        <Button size="sm" variant="primary" icon="send" disabled={!sendable} loading={send.isPending} title={refused ? "Change the personal line first" : undefined} onClick={() => send.mutate()}>{sendButtonLabel(d.policy)}</Button>
        <Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
