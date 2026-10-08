"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ActionResult, type ApplicationDetail, type CandidateNotice, type DecisionMessagePreview, type InterviewPlanView } from "../../api/client";
import { toast } from "../../toast";
import { decisionOnItsWayText } from "../../company-check";
import { AskRecruiter } from "../../components/AskRecruiter";
import { useCompanyCheck } from "../../components/use-company-check";
import { defaultInterviewers } from "../../interview-defaults";
import { callNotesState } from "../../screen-view";
import { NOT_NOW_TOAST, closeRoleToast, declineConfirmText, decisionToast, holdDay, outcomeToast, sendDecisionToast, type PanelStep } from "../../talent-actions";
import { CallNotesCard } from "./call-notes";
import { DECLINE_REASONS, activeInterviews, holdDateBounds } from "./helpers";
import { useCandidateAction, useDraft, useFocusOnMount, useRefreshCandidate } from "./hooks";

/**
 * The area under the panel's header (plan A10): everything that waits on a person about this candidate, then the step a
 * stage choice opened. Each card is the same decision it always was; only where it sits changed.
 */

type Props = { a: ApplicationDetail; roleId: string; myRole: string | null; myUserId: string | null; step: PanelStep | null; setStep: (step: PanelStep | null, opts?: { roundKey?: string }) => void; roundKey?: string };

const DECIDED = ["rejected", "talent_pool"];

export function NeedsYou(props: Props) {
  const { a, roleId, step, setStep } = props;
  const [closeRole, setCloseRole] = useState(false);
  const can = (x: ApplicationDetail["allowedActions"][number]) => a.allowedActions.includes(x);
  const suggestions = a.pendingApprovals.filter((p) => p.actionType === "application.invite_screen" || p.actionType === "application.recommend_interview");
  // a decision nobody has told the candidate about yet, or whose message is on its way
  const telling = DECIDED.includes(a.stage) && (a.toldState === "not_told" || a.toldState === "queued");
  const messagesWaiting = a.pendingApprovals.some((p) => p.actionType === "message.send_freeform");
  // the candidate asked for a person (plan E3): for a recruiter, adding the notes from their call is what waits
  const callNotes = callNotesState(a, props.myRole);
  const cards = [
    callNotes.prominent ? <CallNotesCard key="call-notes" a={a} roleId={roleId} prominent /> : null,
    step === "hold" ? <HoldStep key="hold" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "decline" ? <DeclineStep key="decline" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "interview" ? <InterviewStep key="interview" a={a} roleId={roleId} initialRoundKey={props.roundKey} onClose={() => setStep(null)} /> : null,
    step === "hire" || step === "outcome" ? <OutcomeStep key="outcome" a={a} roleId={roleId} hire={step === "hire"} onClose={() => setStep(null)} onHired={() => setCloseRole(true)} /> : null,
    closeRole ? <CloseRoleCard key="close-role" id={a.id} roleId={roleId} onClose={() => setCloseRole(false)} /> : null,
    ...suggestions.map((p) => <SuggestionCard key={p.id} a={a} roleId={roleId} p={p} onInterview={() => setStep("interview")} />),
    can("record_decision") && step !== "interview" ? <DecisionCard key="decision" a={a} roleId={roleId} onNextRound={(key) => setStep("interview", { roundKey: key })} /> : null,
    a.stage === "ineligible" ? <EligibilityCard key="eligibility" a={a} roleId={roleId} /> : null,
    a.tags.includes("Hold ended") && step !== "hold" ? <HoldEndedCard key="hold-ended" a={a} roleId={roleId} onHoldAgain={() => setStep("hold")} /> : null,
    telling ? <TellCard key="tell" a={a} roleId={roleId} myRole={props.myRole} /> : null,
    messagesWaiting ? <WaitingMessages key="messages" a={a} roleId={roleId} myRole={props.myRole} myUserId={props.myUserId} /> : null,
    a.stage === "rejected" && a.rejectReason === "eligibility" ? <EligibilityDeclinedCard key="eligibility-declined" a={a} roleId={roleId} /> : null,
  ].filter(Boolean);
  if (!cards.length) return null;
  return (
    <section className="needs-area" aria-label="What needs you">
      {cards}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Steps a stage choice opens.                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** On hold (plan A4): until a date, with an optional note; private, and they come back to Today on that date. */
function HoldStep({ a, roleId, onClose }: { a: ApplicationDetail; roleId: string; onClose: () => void }) {
  const bounds = holdDateBounds();
  const [until, setUntil] = useState(bounds.initial);
  const [note, setNote] = useState("");
  useDraft("hold-note", note);
  const first = useFocusOnMount<HTMLInputElement>();
  const act = useCandidateAction(a.id, roleId, () => onClose());
  const valid = until >= bounds.min && until <= bounds.max;
  return (
    <Card needsYou lift title="Put on hold">
      <p className="small" style={{ color: "var(--ink-2)" }}>Nothing about {a.candidate.firstName} waits on anyone until the date you choose; then they come back to Today. Private: nothing is sent to the candidate.</p>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        <Field label="Bring them back on" htmlFor="hold-until" hint="Eight weeks at most."><input ref={first} id="hold-until" className="input" type="date" min={bounds.min} max={bounds.max} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        <Field label="Note (kept internally, optional)" htmlFor="hold-note"><input id="hold-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: waiting to hear about the second chair" /></Field>
        <div className="row">
          <Button variant="primary" size="sm" disabled={!valid} loading={act.isPending} onClick={() => act.mutate({ action: "set_mark", mark: "on_hold", remindAt: until, note: note.trim() || undefined })}>Put on hold</Button>
          <Button variant="quiet" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Not moving forward (founder decision B6): a reason from the fixed list, a note kept internally, and before the click
 * what follows: the decision is not sent now; a booked interview or offered times are called off, named, and the
 * candidate is told at once (no reason given) that the interview is off; and how the candidate will hear the decision.
 */
function DeclineStep({ a, roleId, onClose }: { a: ApplicationDetail; roleId: string; onClose: () => void }) {
  const [reason, setReason] = useState(DECLINE_REASONS[0][0]);
  const [note, setNote] = useState("");
  useDraft("decline-note", note);
  const first = useFocusOnMount<HTMLSelectElement>();
  const act = useCandidateAction(a.id, roleId, () => onClose());
  const interviews = activeInterviews(a.interviews);
  return (
    <Card needsYou lift title="Not moving forward">
      <Alert tone="caution">{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, interviews })}</Alert>
      <div className="stack" style={{ gap: 8, marginTop: 10 }}>
        <Field label="Reason" htmlFor="decline-reason"><select ref={first} id="decline-reason" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Note (kept internally, optional)" htmlFor="decline-note"><input id="decline-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="row">
          <Button variant="destructive" size="sm" loading={act.isPending} onClick={() => act.mutate({ action: "reject", reason, note: note.trim() || undefined })}>Confirm: not moving forward</Button>
          <Button variant="quiet" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

/** Approve an interview: the round and the interviewers; a person's approval is what starts scheduling. */
function InterviewStep({ a, roleId, initialRoundKey, onClose }: { a: ApplicationDetail; roleId: string; initialRoundKey?: string; onClose: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Array<{ userId: string; name: string | null; email: string; role: string; status: string; schedulable: boolean }>>("/api/v1/companies/current/members") });
  // The role's current plan names who interviews in each round now, so assignments made on the Interview plan tab reach candidates who applied before them.
  const currentPlan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`) });
  const nextRound = a.interviewPlan.find((r) => !a.interviews.some((i) => i.roundKey === r.key && ["completed"].includes(i.status))) ?? a.interviewPlan[0];
  const [roundKey, setRoundKey] = useState<string | null>(initialRoundKey ?? null);
  const [interviewers, setInterviewers] = useState<string[] | null>(null);
  const [linkSource, setLinkSource] = useState<"calendar" | "pasted">("calendar");
  const [meetingUrl, setMeetingUrl] = useState("");
  const first = useFocusOnMount<HTMLSelectElement>();
  const activeMembers = (members.data ?? []).filter((m) => m.status === "active");
  const chosenRoundKey = roundKey ?? nextRound?.key;
  const chosenInterviewers = defaultInterviewers({
    roundKey: chosenRoundKey,
    applicationPlan: a.interviewPlan,
    currentPlan: currentPlan.data?.rounds.map((r) => ({ key: r.key, interviewerUserIds: r.interviewers.map((i) => i.userId) })) ?? null,
    picked: interviewers,
    activeMemberIds: members.data && !currentPlan.isLoading ? new Set(activeMembers.map((m) => m.userId)) : null,
  });
  const request = useMutation({
    mutationFn: () => api.post(`/api/v1/applications/${a.id}/interviews`, { roundKey: chosenRoundKey, interviewerUserIds: chosenInterviewers, linkSource, meetingUrl: linkSource === "pasted" ? meetingUrl : undefined }),
    onSuccess: async () => { toast("Interview approved.", "Times go out to the candidate as soon as they exist."); onClose(); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not start the interview."),
  });
  return (
    <Card needsYou lift title="Approve an interview">
      <p className="small" style={{ color: "var(--ink-2)" }}>Your approval is what starts scheduling; the assistant never does this on its own. Times are offered to the candidate from the interviewers' calendars or declared hours.</p>
      {a.interviewPlan.length === 0 ? <Alert tone="caution">This role has no interview rounds yet. Add them on the role's Interview plan tab.</Alert> : (
        <>
          <Field label="Round" htmlFor="iv-round"><select ref={first} id="iv-round" className="select" value={chosenRoundKey ?? ""} onChange={(e) => { setRoundKey(e.target.value); setInterviewers(null); }}>{a.interviewPlan.map((r) => <option key={r.key} value={r.key}>{r.title} · {r.durationMinutes} min · {r.format.replace("_", " ")}</option>)}</select></Field>
          <fieldset style={{ border: 0, padding: 0, margin: "10px 0" }}>
            <legend className="small muted">Interviewers</legend>
            {members.isLoading || currentPlan.isLoading ? <Skeleton lines={2} /> : members.error ? <ErrorState message="Could not load your team, so nobody can be picked yet." onRetry={() => members.refetch()} /> : activeMembers.map((m) => (
              <label key={m.userId} className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={chosenInterviewers.includes(m.userId)} onChange={(e) => setInterviewers(e.target.checked ? [...chosenInterviewers, m.userId] : chosenInterviewers.filter((x) => x !== m.userId))} />
                {m.name ?? m.email} <Chip tone={m.schedulable ? "good" : "caution"}>{m.schedulable ? "availability known" : "no calendar or hours yet"}</Chip>
              </label>
            ))}
          </fieldset>
          {chosenInterviewers.length && (members.data ?? []).some((m) => chosenInterviewers.includes(m.userId) && !m.schedulable) ? <Alert tone="caution">An interviewer has neither a connected calendar nor declared hours. Times cannot be offered until they add one in Setup; they will be asked.</Alert> : null}
          <Field label="Meeting link" htmlFor="iv-link"><select id="iv-link" className="select" value={linkSource} onChange={(e) => setLinkSource(e.target.value as "calendar" | "pasted")}><option value="calendar">Create it with the calendar event</option><option value="pasted">I'll paste a link</option></select></Field>
          {linkSource === "pasted" ? <Field label="Link" htmlFor="iv-url"><input id="iv-url" className="input" type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://" /></Field> : null}
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" size="sm" loading={request.isPending} disabled={!chosenRoundKey || !chosenInterviewers.length || (linkSource === "pasted" && !meetingUrl)} onClick={() => request.mutate()}>Approve and offer times</Button>
        <Button size="sm" variant="quiet" onClick={onClose}>Not now</Button>
      </div>
    </Card>
  );
}

type OutcomeForm = { outcome: string; hireDate: string; offerAcceptedAt: string; reason: string; note: string; confirming: boolean };

/**
 * "Record what happened": hired, withdrew, declined, or no hire, under the person's name. Offer and Hired on the stage
 * button open it (the hire sheet of its own comes later); the platform never makes or sends an offer.
 */
function OutcomeStep({ a, roleId, hire, onClose, onHired }: { a: ApplicationDetail; roleId: string; hire: boolean; onClose: () => void; onHired: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [form, setForm] = useState<OutcomeForm>({ outcome: "hired_externally", hireDate: "", offerAcceptedAt: "", reason: "", note: "", confirming: false });
  useDraft("outcome-note", `${form.reason}${form.note}`);
  const first = useFocusOnMount<HTMLSelectElement>();
  const record = useMutation({
    mutationFn: () => api.post<{ roleStillOpen: boolean; roleId: string } & Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes">>(`/api/v1/applications/${a.id}/outcome`, { outcome: form.outcome, confirm: true, hireDate: form.hireDate || undefined, offerAcceptedAt: form.offerAcceptedAt || undefined, reason: form.reason || undefined, note: form.note || undefined }),
    onSuccess: async (r) => {
      const t = outcomeToast(form.outcome, r);
      toast(t.title, t.detail);
      if (r.roleStillOpen && form.outcome === "hired_externally") onHired();
      onClose();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the outcome."),
  });
  const mayDecline = a.allowedActions.includes("reject");
  return (
    <Card needsYou lift title={hire ? "Record the hire" : "Record what happened"}>
      <p className="small muted">You record it with your name; the platform never makes or sends an offer, and it asks for no pay, tax, identity or banking details.</p>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <Field label="What happened" htmlFor="oc-outcome"><select ref={first} id="oc-outcome" className="select" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value, confirming: false })}>
          <option value="hired_externally">Hired (offer accepted outside the platform)</option>
          {a.stage !== "talent_pool" ? <>
            <option value="offer_declined_externally">Declined an offer made outside the platform</option>
            <option value="candidate_withdrew">The candidate withdrew</option>
            {/* A decline is a decline, whoever records it: only roles that may decline see it (the route refuses the rest). */}
            {mayDecline ? <option value="employer_declined">We declined the candidate</option> : null}
            <option value="no_hire">No hire for this candidate</option>
          </> : null}
        </select></Field>
        {form.outcome === "hired_externally" ? <>
          <Field label="Hire date (start date agreed)" htmlFor="oc-date"><input id="oc-date" className="input" type="date" value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} /></Field>
          <Field label="Date the offer was accepted (optional)" htmlFor="oc-acc"><input id="oc-acc" className="input" type="date" value={form.offerAcceptedAt} onChange={(e) => setForm({ ...form, offerAcceptedAt: e.target.value })} /></Field>
        </> : null}
        {form.outcome === "employer_declined" ? <>
          <Field label="Reason (recorded with your name)" htmlFor="oc-reason"><input id="oc-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <p className="small muted" style={{ margin: 0 }}>{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, interviews: activeInterviews(a.interviews) })}</p>
        </> : null}
        <Field label="Note (kept internally, optional)" htmlFor="oc-note"><input id="oc-note" className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        {form.confirming ? (
          <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Record this outcome under your name? It is audited and can only be corrected by an administrator.</span><span className="row"><Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate()}>Yes, record it</Button><Button size="sm" variant="quiet" onClick={() => setForm({ ...form, confirming: false })}>No</Button></span></div></Alert>
        ) : <div className="row"><Button size="sm" variant="primary" disabled={(form.outcome === "hired_externally" && !form.hireDate) || (form.outcome === "employer_declined" && !form.reason.trim())} onClick={() => setForm({ ...form, confirming: true })}>Continue</Button><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div>}
      </div>
    </Card>
  );
}

/** After a hire: the role is still open, and closing it is a decision of its own. */
function CloseRoleCard({ id, roleId, onClose }: { id: string; roleId: string; onClose: () => void }) {
  const refresh = useRefreshCandidate(id, roleId);
  const close = useMutation({
    mutationFn: () => api.post<{ movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number }>(`/api/v1/roles/${roleId}/outcome`, { outcome: "filled", confirm: true }),
    onSuccess: async (r) => { const t = closeRoleToast(r); toast(t.title, t.detail); onClose(); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the role."),
  });
  return (
    <Card needsYou title="Close the role too?">
      <p className="small" style={{ color: "var(--ink-2)" }}>The hire is recorded. The role is still open; closing it is a separate decision. Other active candidates are kept in your talent pool, privately; anyone with an interview booked or times offered is told now, in a short note that gives no reason, that it is off.</p>
      <div className="row" style={{ marginTop: 10 }}><Button variant="primary" size="sm" loading={close.isPending} onClick={() => close.mutate()}>Yes, close it as filled</Button><Button size="sm" variant="quiet" onClick={onClose}>Keep it open</Button></div>
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What waits on a person.                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** The assistant's suggestion (a screen, an interview): Yes, or Not now with an optional reason (plan A6). */
function SuggestionCard({ a, roleId, p, onInterview }: { a: ApplicationDetail; roleId: string; p: ApplicationDetail["pendingApprovals"][number]; onInterview: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const screen = p.actionType === "application.invite_screen";
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
  useDraft(`not-now-${p.id}`, why);
  const decide = useMutation({
    mutationFn: (input: { decision: "approve" | "reject"; note?: string }) => api.post(`/api/v1/approvals/${p.id}/decide`, input),
    onSuccess: async (_r, input) => {
      if (input.decision === "reject") toast(NOT_NOW_TOAST.title, NOT_NOW_TOAST.detail);
      else if (screen) toast("Invitation on its way.", "The screen goes to the candidate by email, or by text when they agreed to texts.");
      else { toast("Moved to Interviewing.", "Choose the round and the interviewers next; times go out to the candidate from there."); onInterview(); }
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  return (
    <Card needsYou lift title={screen ? "The assistant suggests a screen" : "The assistant suggests an interview"}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{p.rationale}</p>
      {declining ? (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <Field label="Why not now? (optional, kept internally)" htmlFor={`why-${p.id}`}><input id={`why-${p.id}`} className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          <div className="row">
            <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ decision: "reject", note: why.trim() || "Not now" })}>Set it aside</Button>
            <Button size="sm" variant="quiet" onClick={() => setDeclining(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 10 }}>
          <Button variant="primary" size="sm" loading={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>{screen ? "Yes, invite to a screen" : "Yes, interview"}</Button>
          <Button size="sm" onClick={() => setDeclining(true)}>Not now</Button>
          <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
        </div>
      )}
    </Card>
  );
}

/**
 * The decision after an interview is a person's (docs/06; release 1 records it, scorecards and debriefs come later).
 * Shown when the last interview is over and nobody has decided yet: next round, finalist, or not moving forward with a reason.
 * "Next round" opens the interview approval with that round and its interviewers.
 */
function DecisionCard({ a, roleId, onNextRound }: { a: ApplicationDetail; roleId: string; onNextRound: (roundKey: string) => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [decision, setDecision] = useState<"finalist" | "not_moving_forward" | null>(null);
  const [reason, setReason] = useState(DECLINE_REASONS[0][0]);
  const [note, setNote] = useState("");
  useDraft("decision-note", note);
  const record = useMutation({
    mutationFn: (body: { decision: "next_round" | "finalist" | "not_moving_forward"; reason?: string; note?: string }) => api.post<{ stage: string; nextRoundKey: string | null } & Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes">>(`/api/v1/applications/${a.id}/decision`, body),
    onSuccess: async (r, body) => {
      const t = decisionToast(body.decision, r);
      toast(t.title, t.detail);
      setDecision(null);
      setNote("");
      if (body.decision === "next_round" && r.nextRoundKey) onNextRound(r.nextRoundKey);
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the decision."),
  });
  const last = a.interviews.find((i) => ["completed", "no_show"].includes(i.status) && !i.decision);
  const idx = last ? a.interviewPlan.findIndex((r) => r.key === last.roundKey) : -1;
  const hasNextRound = idx >= 0 && idx + 1 < a.interviewPlan.length;
  return (
    <Card needsYou lift title="How did the interview go?">
      <p className="small" style={{ color: "var(--ink-2)" }}>{last ? `${last.title}${last.outcome === "no_show_candidate" ? " (the candidate did not attend)" : last.outcome === "no_show_interviewer" ? " (the interviewer did not attend)" : ""}. ` : ""}The decision is yours and is recorded with your name.</p>
      {!decision ? (
        <div className="row" style={{ marginTop: 10 }}>
          {hasNextRound ? <Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate({ decision: "next_round" })}>Next round</Button> : null}
          <Button size="sm" variant={hasNextRound ? undefined : "primary"} onClick={() => setDecision("finalist")}>Finalist</Button>
          <Button size="sm" variant="destructive" onClick={() => setDecision("not_moving_forward")}>Not moving forward</Button>
          <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 12 }}>
          {decision === "not_moving_forward" ? (
            <>
              <Alert tone="caution">{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, interviews: activeInterviews(a.interviews) })}</Alert>
              <Field label="Reason" htmlFor="decision-reason"><select id="decision-reason" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </>
          ) : null}
          <Field label={decision === "finalist" ? "What stood out (kept internally)" : "Note (kept internally)"} htmlFor="decision-note"><input id="decision-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <Button variant={decision === "finalist" ? "primary" : "destructive"} loading={record.isPending} onClick={() => record.mutate({ decision, reason: decision === "not_moving_forward" ? reason : undefined, note: note.trim() || undefined })}>{decision === "finalist" ? "Confirm finalist" : "Confirm: not moving forward"}</Button>
            <Button variant="quiet" onClick={() => setDecision(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Held on an eligibility answer (plan A2): only a person keeps them in or declines them; "Decline now" asks to confirm first. */
function EligibilityCard({ a, roleId }: { a: ApplicationDetail; roleId: string }) {
  const [overrideNote, setOverrideNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  useDraft("eligibility-override", overrideNote);
  useDraft("eligibility-note", note);
  const act = useCandidateAction(a.id, roleId, () => setConfirming(false));
  const can = (x: ApplicationDetail["allowedActions"][number]) => a.allowedActions.includes(x);
  const blocked = (x: ApplicationDetail["allowedActions"][number]) => a.blockedReasons[x] ?? "Not available at this step.";
  return (
    <Card needsYou title="Held on an eligibility answer">
      <p className="small" style={{ color: "var(--ink-2)" }}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${f.reason}`).join("; ")}</p>
      <p className="small muted" style={{ marginTop: 6 }}>Held for your decision; nothing has been sent to them about it. Keep them in if the answer was a mistake. You are reminded daily, and an ITS recruiter is brought in after three days. Say why if you keep them in; it is recorded and the system learns from it.</p>
      <Field label="Why keep them in?" htmlFor="ovnote"><input id="ovnote" className="input" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="For example: sitting the licensing exam next week" /></Field>
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" size="sm" disabled={!overrideNote.trim() || !can("override_eligibility")} title={can("override_eligibility") ? (overrideNote.trim() ? "Keeps them in the process with your reason" : "Say why first") : blocked("override_eligibility")} loading={act.isPending && act.variables?.action === "override_eligibility"} onClick={() => act.mutate({ action: "override_eligibility", note: overrideNote })}>Keep them in</Button>
        <Button size="sm" variant="destructive" disabled={!can("reject")} title={can("reject") ? "Not moving forward on this answer: you confirm next" : blocked("reject")} onClick={() => setConfirming(true)}>Decline now</Button>
      </div>
      {!can("reject") ? <p className="small muted" style={{ marginTop: 6 }}>{blocked("reject")}</p> : null}
      {confirming ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <Alert tone="caution">{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, eligibility: true })} The reason recorded is the eligibility answer above.</Alert>
          <Field label="Note (kept internally, optional)" htmlFor="elig-note"><input id="elig-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row"><Button variant="destructive" loading={act.isPending && act.variables?.action === "reject"} onClick={() => act.mutate({ action: "reject", reason: "eligibility", note: note.trim() || "Confirmed after the eligibility hold" })}>Confirm decline</Button><Button onClick={() => setConfirming(false)}>Cancel</Button></div>
        </div>
      ) : null}
    </Card>
  );
}

/** Declined on an owner-authored eligibility rule: "Review anyway" reopens it (docs/FOUNDER-CONTEXT.md §10). */
function EligibilityDeclinedCard({ a, roleId }: { a: ApplicationDetail; roleId: string }) {
  const act = useCandidateAction(a.id, roleId);
  const can = a.allowedActions.includes("review_anyway");
  return (
    <Card title="Declined on an eligibility answer">
      <p className="small" style={{ color: "var(--ink-2)" }}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${f.reason}`).join("; ") || "An eligibility rule you authored was not met."}</p>
      <div className="row" style={{ marginTop: 10 }}><Button size="sm" disabled={!can} title={can ? "Reopens the application so it is looked at again" : a.blockedReasons.review_anyway ?? "Not available at this step."} loading={act.isPending} onClick={() => act.mutate({ action: "review_anyway", note: "Reopened by the owner" })}>Review anyway</Button></div>
    </Card>
  );
}

/** A hold whose date has come (plan A4): they are back in front of the team; take them off hold or hold them again. */
function HoldEndedCard({ a, roleId, onHoldAgain }: { a: ApplicationDetail; roleId: string; onHoldAgain: () => void }) {
  const act = useCandidateAction(a.id, roleId);
  return (
    <Card needsYou title="The hold has ended">
      <p className="small" style={{ color: "var(--ink-2)" }}>You put {a.candidate.firstName} on hold{a.mark?.remindAt ? ` until ${holdDay(a.mark.remindAt)}` : ""}{a.mark?.note ? ` (${a.mark.note})` : ""}. Decide what comes next: take them off hold, hold them again, or choose another stage. Nothing has been sent to them.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <Button size="sm" variant="primary" disabled={!a.allowedActions.includes("clear_mark")} loading={act.isPending} onClick={() => act.mutate({ action: "clear_mark", note: "Hold ended" })}>Take off hold</Button>
        <Button size="sm" onClick={onHoldAgain}>Hold again</Button>
      </div>
    </Card>
  );
}

const ROLE_WORDS: Record<string, string> = { owner: "an owner", admin: "an admin", hiring_manager: "a hiring manager", recruiter: "a recruiter", hr: "HR", interviewer: "an interviewer" };
/** "an owner or an admin": who a waiting message is waiting for, in the reader's words. */
const whoDecides = (roles: string[]) => (roles.length ? roles.map((r) => ROLE_WORDS[r] ?? r.replace(/_/g, " ")).join(" or ") : "an owner or an admin");

const POLICY_LINE: Record<ApplicationDetail["declineMessage"], string> = {
  sends: "It goes as soon as you press Send.",
  needs_approval: "Under your settings it waits for approval before it goes out.",
  not_sent: "Under your settings no decision messages are sent. Tell them yourself, then record it here.",
};

/**
 * A decision nobody has told the candidate yet (founder decision B6): "Send message" shows the exact standard wording
 * first, then sends it (or asks for its approval, under the company's settings); "I told them myself" records it.
 */
function TellCard({ a, roleId, myRole }: { a: ApplicationDetail; roleId: string; myRole: string | null }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [inPerson, setInPerson] = useState(false);
  const [note, setNote] = useState("");
  useDraft("told-note", note);
  const act = useCandidateAction(a.id, roleId, () => { setPreviewOpen(false); setInPerson(false); });
  const preview = useQuery({ queryKey: ["decision-message", a.id], queryFn: () => api.get<DecisionMessagePreview>(`/api/v1/applications/${a.id}/decision-message`), enabled: previewOpen });
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
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>{decisionOnItsWayText(first, check)}</span>
          {a.allowedActions.includes("told_in_person") ? <Button size="sm" variant="quiet" loading={act.isPending} onClick={() => act.mutate({ action: "told_in_person", note: "Told them while the message was on its way" })}>I told them myself</Button> : null}
        </div>
      </Alert>
    );
  }
  if (a.toldState !== "not_told") return null;
  const mayApprove = !!waiting && !!myRole && (waiting.requiredRoles.length ? waiting.requiredRoles.includes(myRole) : ["owner", "admin"].includes(myRole));
  const canSend = a.allowedActions.includes("send_decision");
  const canTell = a.allowedActions.includes("told_in_person");
  return (
    <Card needsYou lift title={waiting ? `Send the decision message to ${first}?` : `${first} has not been told yet`}>
      {waiting ? (
        <p className="small" style={{ color: "var(--ink-2)" }}>{mayApprove ? "Someone on your team wants to send the standard decision message. Nothing goes out until you say yes." : `The decision message is waiting for ${whoDecides(waiting.requiredRoles)} to approve it; nothing has gone out yet.`}</p>
      ) : (
        <p className="small" style={{ color: "var(--ink-2)" }}>Your decision is private: nothing has been sent to {first}. Send the standard decision message when you are ready, or record that you told them yourself.</p>
      )}
      {waiting && mayApprove ? (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate("approve")}>Yes, send it</Button>
          <Button size="sm" variant="quiet" loading={decide.isPending} onClick={() => decide.mutate("reject")}>Do not send</Button>
        </div>
      ) : null}
      {!waiting && !previewOpen && !inPerson ? (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" variant="primary" icon="send" disabled={!canSend} title={canSend ? "Shows the message before anything is sent" : a.blockedReasons.send_decision} onClick={() => setPreviewOpen(true)}>Send message</Button>
          <Button size="sm" disabled={!canTell} title={canTell ? "Records it; nothing is sent" : a.blockedReasons.told_in_person} onClick={() => setInPerson(true)}>I told them myself</Button>
        </div>
      ) : null}
      {waiting && !inPerson && canTell ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="quiet" onClick={() => setInPerson(true)}>I told them myself</Button></div> : null}
      {!canSend && !canTell && a.blockedReasons.send_decision ? <p className="small muted" style={{ marginTop: 6 }}>{a.blockedReasons.send_decision}</p> : null}
      {previewOpen ? (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          {preview.isLoading ? <Skeleton lines={4} /> : preview.error || !preview.data ? <ErrorState message="Could not load the message." onRetry={() => preview.refetch()} /> : (
            <>
              <p className="small muted" style={{ margin: 0 }}>To {preview.data.to ?? "nobody: there is no email address on file"} · {POLICY_LINE[preview.data.policy]}</p>
              <div className="card" style={{ padding: "12px 14px" }}>
                <p className="small" style={{ margin: 0 }}><strong>{preview.data.subject}</strong></p>
                <p className="small" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{preview.data.text}</p>
              </div>
              <div className="row">
                <Button size="sm" variant="primary" icon="send" disabled={!preview.data.to || preview.data.policy === "not_sent"} loading={act.isPending} onClick={() => act.mutate({ action: "send_decision" })}>{preview.data.policy === "needs_approval" ? "Send for approval" : "Send"}</Button>
                <Button size="sm" variant="quiet" onClick={() => setPreviewOpen(false)}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {inPerson ? (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <p className="small" style={{ margin: 0 }}>Record that you told {first} yourself? Nothing more will be sent to them about this decision.</p>
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

type WaitingMessage = { id: string; requiredRoles: string[]; proposal: { subject?: string | null; text?: string; senderName?: string; senderUserId?: string } };

/**
 * A message a team member wrote to the candidate (F11) that waits for an owner or admin: the text, who wrote it, and
 * the buttons for a reader whose role may decide; everyone else, the writer included, sees who it waits for.
 */
function WaitingMessages({ a, roleId, myRole, myUserId }: { a: ApplicationDetail; roleId: string; myRole: string | null; myUserId: string | null }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "reject" }) => api.post(`/api/v1/approvals/${input.id}/decide`, { decision: input.decision }),
    onSuccess: async (_r, input) => { toast(input.decision === "approve" ? "Sent under the writer's name." : "Not sent.", input.decision === "approve" ? undefined : "The writer has been told."); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const waiting: WaitingMessage[] = a.pendingApprovals.filter((p) => p.actionType === "message.send_freeform").map((p) => ({ id: p.id, requiredRoles: p.requiredRoles ?? [], proposal: (p.proposal ?? {}) as WaitingMessage["proposal"] }));
  if (!waiting.length) return null;
  const mayDecide = (p: WaitingMessage) => !!myRole && p.requiredRoles.includes(myRole);
  const name = `${a.candidate.firstName} ${a.candidate.lastName}`;
  return (
    <>
      {waiting.map((p) => (
        <Card key={p.id} needsYou={mayDecide(p)} title={`A message to ${a.candidate.firstName}`}>
          {mayDecide(p) ? (
            <Alert tone="caution">Send this message to {name}? {p.proposal.senderName ?? "A team member"} wrote it; nothing goes out until you say yes.</Alert>
          ) : (
            <Alert tone="neutral">{myUserId && p.proposal.senderUserId === myUserId ? "You wrote" : `${p.proposal.senderName ?? "A team member"} wrote`} this to {name}. It is waiting for {whoDecides(p.requiredRoles)} to read it; nothing goes out until they say yes.</Alert>
          )}
          {p.proposal.subject ? <p className="small" style={{ margin: "8px 0 0" }}><strong>{p.proposal.subject}</strong></p> : null}
          <p className="small" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{p.proposal.text}</p>
          {mayDecide(p) ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "approve" })}>Yes, send it</Button><Button size="sm" variant="quiet" loading={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "reject" })}>Do not send</Button></div> : null}
        </Card>
      ))}
    </>
  );
}
