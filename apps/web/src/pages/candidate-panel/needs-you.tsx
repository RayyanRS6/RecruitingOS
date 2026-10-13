"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ActionResult, type ApplicationDetail, type CancelledView, type InterviewDraft, type InterviewPlanView, type NewTimesSettingView, type SendNewTimesResult, type SuggestedLine } from "../../api/client";
import { HOLD_ENDS_CANCELLED, cancelledBody, cancelledTitle, sendNewTimesQuestion, stopNewTimesQuestion } from "../../cancelled";
import { PERSONAL_LINE_MAX, suggestedLineNote } from "../../telling";
import { toast } from "../../toast";
import { AskRecruiter } from "../../components/AskRecruiter";
import { defaultInterviewers } from "../../interview-defaults";
import { interviewDraftLine } from "../../hiring";
import { canDecline, canReadNotes } from "../../roles";
import { callNotesState } from "../../screen-view";
import { NOT_NOW_TOAST, declineConfirmText, decisionToast, holdDay, newTimesToast, outcomeNoticeText, outcomeToast, type PanelStep } from "../../talent-actions";
import { CallNotesCard } from "./call-notes";
import { DECLINE_REASONS, activeInterviews, holdDateBounds, whoDecides, type PanelTab } from "./helpers";
import { FinalistCard, HireStep, OfferStep, WaitingOnCandidateCard } from "./hiring";
import { useCandidateAction, useDraft, useFocusOnMount, useRefreshCandidate } from "./hooks";
import { NotesSummary } from "./notes";
import { TellCard } from "./telling";

/**
 * The area under the panel's header (plan A10): everything that waits on a person about this candidate, then the step a
 * stage choice opened. Each card is the same decision it always was; only where it sits changed.
 */

type Props = { a: ApplicationDetail; roleId: string; myRole: string | null; myUserId: string | null; step: PanelStep | null; setStep: (step: PanelStep | null, opts?: { roundKey?: string }) => void; roundKey?: string; onTab?: (tab: PanelTab) => void };

const DECIDED = ["rejected", "talent_pool"];
/** The steps from which an offer made outside the app can be recorded (plan H2). */
const FINALIST = ["finalist", "reference_check"];
/** Already in the Interviewing column, where the stage button has nothing to open: the approval card offers the interview. */
const INTERVIEW_READY = ["interview_recommended", "interview_complete"];

export function NeedsYou(props: Props) {
  const { a, roleId, step, setStep } = props;
  const can = (x: ApplicationDetail["allowedActions"][number]) => a.allowedActions.includes(x);
  const suggestions = a.pendingApprovals.filter((p) => p.actionType === "application.invite_screen" || p.actionType === "application.recommend_interview");
  // a decision nobody has told the candidate about yet, or whose message is on its way
  const telling = DECIDED.includes(a.stage) && (a.toldState === "not_told" || a.toldState === "queued");
  const messagesWaiting = a.pendingApprovals.some((p) => p.actionType === "message.send_freeform");
  // the candidate asked for a person (plan E3): for a recruiter, adding the notes from their call is what waits
  const callNotes = callNotesState(a, props.myRole);
  // after the interviews (plan Wave H): a finalist's next step, and an offer waiting on the candidate's answer
  const finalist = FINALIST.includes(a.stage) && can("record_outcome") && !step && !can("record_decision");
  const waitingOnCandidate = a.stage === "offer_sent" && step !== "hire";
  // Already at the interview step with nothing in motion (an interview cancelled, times that expired, "Next round", the
  // approval set aside with "Not now", or the assistant's recommendation after a screen): the approval stays one click away.
  // Someone under Cancelled has their own card instead, with "Send new times" (founder decisions 1A to 4A).
  const cancelled = a.ownerStage === "cancelled" ? a.cancelled : null;
  const readyToInterview = !step && can("interview") && !can("record_decision") && INTERVIEW_READY.includes(a.stage)
    && !suggestions.some((p) => p.actionType === "application.recommend_interview") && a.mark?.mark !== "on_hold" && a.mark?.mark !== "not_a_fit_for_now" && !cancelled;
  const cards = [
    callNotes.prominent ? <CallNotesCard key="call-notes" a={a} roleId={roleId} prominent /> : null,
    step === "hold" ? <HoldStep key="hold" a={a} roleId={roleId} cancelled={!!cancelled} onClose={() => setStep(null)} /> : null,
    step === "decline" ? <DeclineStep key="decline" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "interview" ? <InterviewStep key="interview" a={a} roleId={roleId} initialRoundKey={props.roundKey} onClose={() => setStep(null)} /> : null,
    step === "offer" ? <OfferStep key="offer" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "hire" ? <HireStep key="hire" a={a} roleId={roleId} mayTell={canDecline(props.myRole)} onClose={() => setStep(null)} /> : null,
    step === "outcome" ? <OutcomeStep key="outcome" a={a} roleId={roleId} onClose={() => setStep(null)} onHire={() => setStep("hire")} /> : null,
    ...suggestions.map((p) => <SuggestionCard key={p.id} a={a} roleId={roleId} p={p} onInterview={(roundKey) => setStep("interview", { roundKey })} />),
    // under Cancelled: above the decision card, which an undecided no-show also has ("Send new times …, or decide below")
    cancelled && step !== "interview" ? <CancelledCard key="cancelled" a={a} c={cancelled} roleId={roleId} onChooseInterviewers={() => setStep("interview")} /> : null,
    can("record_decision") && step !== "interview" && step !== "hire" ? <DecisionCard key="decision" a={a} roleId={roleId} myRole={props.myRole} onNextRound={(key) => setStep("interview", { roundKey: key })} onHire={() => setStep("hire")} onNotes={() => props.onTab?.("notes")} /> : null,
    readyToInterview ? <ReadyToInterviewCard key="ready-to-interview" a={a} onApprove={() => setStep("interview")} /> : null,
    finalist ? <FinalistCard key="finalist" a={a} setStep={(s) => setStep(s)} /> : null,
    waitingOnCandidate ? <WaitingOnCandidateCard key="waiting-on-candidate" a={a} roleId={roleId} onAccepted={() => setStep("hire")} /> : null,
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

/**
 * On hold (plan A4): until a date, with an optional note; private, and they come back to Today on that date. For someone
 * under Cancelled, a hold takes them out of it, and no automatic new times go to them.
 */
function HoldStep({ a, roleId, cancelled, onClose }: { a: ApplicationDetail; roleId: string; cancelled: boolean; onClose: () => void }) {
  const bounds = holdDateBounds();
  const [until, setUntil] = useState(bounds.initial);
  const [note, setNote] = useState("");
  useDraft("hold-note", note);
  const first = useFocusOnMount<HTMLInputElement>();
  const act = useCandidateAction(a.id, roleId, () => onClose());
  const valid = until >= bounds.min && until <= bounds.max;
  return (
    <Card needsYou lift title="Put on hold">
      <p className="small" style={{ color: "var(--ink-2)" }}>Nothing about {a.candidate.firstName} waits on anyone until the date you choose; then they come back to Today. Private: nothing is sent to the candidate.{cancelled ? ` ${HOLD_ENDS_CANCELLED}` : ""}</p>
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

type LinkChoice = "calendar" | "pasted";

/**
 * The meeting link on the interview approval (decision D3). The calendar makes the link only when an interviewer has a
 * connected, working calendar: the event it books carries the video link. With none (the development stand-in, or nobody
 * connected), "Create it with the calendar event" recorded no link at all, so it is not offered: the box for a link is
 * shown instead, and left empty the invitation names the format (in person, by phone) and the team gives any details.
 * `picked` is what the person chose in the menu when it is offered; typing a link first counts as choosing to paste one.
 * `ready` is false while a link that is needed is missing; `body` is what the approval sends.
 */
export function meetingLinkFor(input: { calendarLive: boolean; picked: LinkChoice | null; url: string }): { offerCalendar: boolean; mode: LinkChoice; urlRequired: boolean; ready: boolean; body: { linkSource: LinkChoice; meetingUrl?: string } } {
  const url = input.url.trim();
  if (!input.calendarLive) return { offerCalendar: false, mode: "pasted", urlRequired: false, ready: true, body: url ? { linkSource: "pasted", meetingUrl: url } : { linkSource: "calendar" } };
  const mode = input.picked ?? (url ? "pasted" : "calendar");
  if (mode === "calendar") return { offerCalendar: true, mode, urlRequired: false, ready: true, body: { linkSource: "calendar" } };
  return { offerCalendar: true, mode, urlRequired: true, ready: !!url, body: url ? { linkSource: "pasted", meetingUrl: url } : { linkSource: "pasted" } };
}

/**
 * Approve an interview: the round and the interviewers; a person's approval is what starts scheduling. It opens filled
 * in from the interview plan (plan H4: the next round, its interviewers who are still on the team, the scheduling
 * window), so "Yes, interview" on a suggestion is one more look and one click, never a second approval.
 */
function InterviewStep({ a, roleId, initialRoundKey, onClose }: { a: ApplicationDetail; roleId: string; initialRoundKey?: string; onClose: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  // `calendar`: each person's calendar connection, if any; a working one ("live") is what can make the meeting link.
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Array<{ userId: string; name: string | null; email: string; role: string; status: string; schedulable: boolean; calendar?: { status: string } | null }>>("/api/v1/companies/current/members") });
  // The role's current plan names who interviews in each round now, so assignments made on the Interview plan tab reach candidates who applied before them.
  const currentPlan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`) });
  // The card filled in by the API (the answer to "Yes, interview" puts it here first); a refusal just leaves the page's own defaults.
  const draft = useQuery({ queryKey: ["interview-draft", a.id], queryFn: () => api.get<InterviewDraft>(`/api/v1/applications/${a.id}/interview-draft`), retry: false });
  const nextRound = a.interviewPlan.find((r) => !a.interviews.some((i) => i.roundKey === r.key && ["completed"].includes(i.status))) ?? a.interviewPlan[0];
  const [roundKey, setRoundKey] = useState<string | null>(initialRoundKey ?? null);
  const [interviewers, setInterviewers] = useState<string[] | null>(null);
  const [linkPicked, setLinkPicked] = useState<LinkChoice | null>(null);
  const [meetingUrl, setMeetingUrl] = useState("");
  const first = useFocusOnMount<HTMLSelectElement>();
  const activeMembers = (members.data ?? []).filter((m) => m.status === "active");
  const filled = draft.data && a.interviewPlan.some((r) => r.key === draft.data.roundKey) ? draft.data : null;
  const chosenRoundKey = roundKey ?? filled?.roundKey ?? nextRound?.key;
  const fromDraft = filled && filled.roundKey === chosenRoundKey && filled.interviewerUserIds.length ? filled.interviewerUserIds : null;
  const chosenInterviewers = defaultInterviewers({
    roundKey: chosenRoundKey,
    applicationPlan: a.interviewPlan,
    currentPlan: currentPlan.data?.rounds.map((r) => ({ key: r.key, interviewerUserIds: r.interviewers.map((i) => i.userId) })) ?? null,
    picked: interviewers ?? fromDraft,
    activeMemberIds: members.data && !currentPlan.isLoading ? new Set(activeMembers.map((m) => m.userId)) : null,
  });
  // The calendar can make the meeting link only through an interviewer's working calendar connection (see meetingLinkFor).
  const calendarLive = activeMembers.some((m) => chosenInterviewers.includes(m.userId) && m.calendar?.status === "live");
  const link = meetingLinkFor({ calendarLive, picked: linkPicked, url: meetingUrl });
  const videoRound = a.interviewPlan.find((r) => r.key === chosenRoundKey)?.format === "video";
  // An optional personal line on the invitation (Q28): the person's own, or one the assistant suggested and they kept, in
  // which case the invitation says the assistant helped. Checked by the API like a decision message's line.
  const [line, setLine] = useState("");
  const [kept, setKept] = useState<{ line: string; runId: string | null } | null>(null);
  // Kept once, the assistant helped, however the line is changed afterwards; only taking it out or emptying the box ends that.
  const lineAiHelped = !!kept;
  const lineStillWhole = !!kept && line.includes(kept.line);
  const suggest = useMutation({
    mutationFn: () => api.post<SuggestedLine>(`/api/v1/applications/${a.id}/messages/suggest`, { purpose: "interview_invite", roundKey: chosenRoundKey }),
    onError: (e) => toast(e instanceof ApiError ? e.message : "The assistant could not suggest a line just now."),
  });
  const request = useMutation({
    mutationFn: () => api.post(`/api/v1/applications/${a.id}/interviews`, { roundKey: chosenRoundKey, interviewerUserIds: chosenInterviewers, ...link.body, ...(line.trim() ? { invitationLine: { text: line.trim(), aiHelped: lineAiHelped, ...(kept?.runId ? { suggestionRunId: kept.runId } : {}) } } : {}) }),
    onSuccess: async () => { toast("Interview approved.", "Times go out to the candidate as soon as they exist."); onClose(); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not start the interview."),
  });
  const suggestion = suggest.data;
  return (
    <Card needsYou lift title="Approve an interview">
      <p className="small" style={{ color: "var(--ink-2)" }}>Your approval is what starts scheduling; the assistant never does this on its own. Times are offered to the candidate from the interviewers' calendars or declared hours.</p>
      {filled && filled.roundKey === chosenRoundKey ? <p className="small interview-filled" style={{ margin: "8px 0 0" }}>{interviewDraftLine(filled)}</p> : null}
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
          {link.offerCalendar ? <Field label="Meeting link" htmlFor="iv-link"><select id="iv-link" className="select" value={link.mode} onChange={(e) => setLinkPicked(e.target.value as LinkChoice)}><option value="calendar">Create it with the calendar event</option><option value="pasted">I'll paste a link</option></select></Field> : null}
          {link.mode === "pasted" ? (
            <Field label={link.urlRequired ? "Link" : "Meeting link (optional)"} htmlFor="iv-url" hint={link.urlRequired ? undefined : "For a video call, paste its link (it starts with https://). Leave it empty for an interview in person. A link is made with the calendar event only for an interviewer who connected their calendar in Setup."}>
              <input id="iv-url" className="input" type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://" />
            </Field>
          ) : null}
          {!link.offerCalendar && videoRound && !meetingUrl.trim() ? <p className="small muted" style={{ margin: 0 }}>This round is a video call. Without a link here, the invitation names the format only, so send {a.candidate.firstName} the link yourself.</p> : null}
          <Field label="A personal line for the invitation (optional)" htmlFor="iv-line" hint={`It goes with the times, under your name: one or two sentences, ${PERSONAL_LINE_MAX} characters at most. It is checked before anything is sent: no scores, nothing about age, family, health, religion or background.`}>
            <textarea id="iv-line" className="textarea" rows={2} maxLength={PERSONAL_LINE_MAX} value={line} onChange={(e) => { setLine(e.target.value); if (!e.target.value.trim()) setKept(null); }} placeholder={`For example: We enjoyed reading about your work, ${a.candidate.firstName}.`} />
          </Field>
          {suggestion?.line && !kept ? (
            <div className="suggested-line">
              <p className="small" style={{ margin: 0 }}><q>{suggestion.line}</q></p>
              <p className="small muted" style={{ margin: "4px 0 0" }}>{suggestion.note}</p>
              <div className="row" style={{ marginTop: 6 }}><Button size="sm" onClick={() => { setLine(suggestion.line!); setKept({ line: suggestion.line!, runId: suggestion.suggestionRunId }); }}>Use this line</Button><Button size="sm" variant="quiet" onClick={() => suggest.reset()}>No thanks</Button></div>
            </div>
          ) : suggestion && !suggestion.line ? <p className="small muted" style={{ margin: 0 }}>{suggestion.note}</p> : null}
          {!kept ? <div className="row"><Button size="sm" variant="secondary" icon="sparkle" loading={suggest.isPending} disabled={!chosenRoundKey} onClick={() => suggest.mutate()} title="The assistant suggests one friendly line; if you keep it, the invitation says the assistant helped">Suggest a line</Button></div> : null}
          {lineAiHelped ? (
            <div className="row" style={{ gap: 8 }}>
              <p className="small muted" style={{ margin: 0 }}>{suggestedLineNote(lineStillWhole, "invitation")}</p>
              {lineStillWhole ? <Button size="sm" variant="quiet" onClick={() => { setLine(line.replace(kept!.line, "").trim()); setKept(null); }}>Take out the assistant's line</Button> : null}
            </div>
          ) : null}
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" size="sm" loading={request.isPending} disabled={!chosenRoundKey || !chosenInterviewers.length || !link.ready} onClick={() => request.mutate()}>Approve and offer times</Button>
        <Button size="sm" variant="quiet" onClick={onClose}>Not now</Button>
      </div>
    </Card>
  );
}

type OutcomeForm = { outcome: string; reason: string; note: string; confirming: boolean };

/**
 * "Record what happened" (More on the panel): an offer they declined, they withdrew, we declined them, or no hire, under
 * the person's name. A hire has its own sheet (plan H1), one click away. A decline takes a reason from the same fixed list
 * as every decline (plan G2); the person's own words go in the note. The platform never makes or sends an offer.
 */
function OutcomeStep({ a, roleId, onClose, onHire }: { a: ApplicationDetail; roleId: string; onClose: () => void; onHire: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const mayDecline = a.allowedActions.includes("reject");
  const [form, setForm] = useState<OutcomeForm>({ outcome: a.stage === "offer_sent" ? "offer_declined_externally" : "candidate_withdrew", reason: DECLINE_REASONS[0][0], note: "", confirming: false });
  useDraft("outcome-note", form.note);
  const first = useFocusOnMount<HTMLSelectElement>();
  const record = useMutation({
    mutationFn: () => api.post<{ roleStillOpen: boolean; roleId: string } & Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes">>(`/api/v1/applications/${a.id}/outcome`, { outcome: form.outcome, confirm: true, reason: form.outcome === "employer_declined" ? form.reason : undefined, note: form.note.trim() || undefined }),
    onSuccess: async (r) => {
      const t = outcomeToast(form.outcome, r);
      toast(t.title, t.detail);
      onClose();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the outcome."),
  });
  const pastDecision = a.stage === "talent_pool";
  return (
    <Card needsYou lift title="Record what happened">
      <p className="small muted">You record it with your name; the platform never makes or sends an offer, and it asks for no pay, tax, identity or banking details. {outcomeNoticeText(activeInterviews(a.interviews))}</p>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small">Hired them?</span>
        <Button size="sm" onClick={onHire}>Open the hire sheet</Button>
      </div>
      {pastDecision ? null : (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <Field label="What happened" htmlFor="oc-outcome"><select ref={first} id="oc-outcome" className="select" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value, confirming: false })}>
            {a.stage === "offer_sent" ? <option value="offer_declined_externally">They declined the offer made outside the platform</option> : null}
            <option value="candidate_withdrew">The candidate withdrew</option>
            {/* A decline is a decline, whoever records it: only roles that may decline see it (the route refuses the rest). */}
            {mayDecline ? <option value="employer_declined">We declined the candidate</option> : null}
            <option value="no_hire">No hire for this candidate</option>
            {a.stage !== "offer_sent" ? <option value="offer_declined_externally">They declined an offer made outside the platform</option> : null}
          </select></Field>
          {form.outcome === "employer_declined" ? <>
            <Field label="Reason (recorded with your name)" htmlFor="oc-reason"><select id="oc-reason" className="select" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>{DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <p className="small muted" style={{ margin: 0 }}>{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, interviews: activeInterviews(a.interviews) })}</p>
          </> : null}
          <Field label="Note (kept internally, optional)" htmlFor="oc-note"><input id="oc-note" className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          {form.confirming ? (
            <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Record this outcome under your name? It is audited and can only be corrected by an administrator.</span><span className="row"><Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate()}>Yes, record it</Button><Button size="sm" variant="quiet" onClick={() => setForm({ ...form, confirming: false })}>No</Button></span></div></Alert>
          ) : <div className="row"><Button size="sm" variant="primary" onClick={() => setForm({ ...form, confirming: true })}>Continue</Button><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div>}
        </div>
      )}
      {pastDecision ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div> : null}
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What waits on a person.                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The assistant's suggestion (a screen, an interview): Yes, or Not now with an optional reason (plan A6). "Yes,
 * interview" goes straight on to the interview approval, filled in from the plan (plan H4): one more look, one click.
 */
function SuggestionCard({ a, roleId, p, onInterview }: { a: ApplicationDetail; roleId: string; p: ApplicationDetail["pendingApprovals"][number]; onInterview: (roundKey?: string) => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshCandidate(a.id, roleId);
  const screen = p.actionType === "application.invite_screen";
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
  useDraft(`not-now-${p.id}`, why);
  const decide = useMutation({
    mutationFn: (input: { decision: "approve" | "reject"; note?: string }) => api.post<{ interviewDraft?: InterviewDraft | null }>(`/api/v1/approvals/${p.id}/decide`, input),
    onSuccess: async (r, input) => {
      if (input.decision === "reject") toast(NOT_NOW_TOAST.title, NOT_NOW_TOAST.detail);
      else if (screen) toast("Invitation on its way.", "The screen goes to the candidate by email, or by text when they agreed to texts.");
      else {
        toast("Moved to Interviewing.", "Check the interview below and approve it; times go out to the candidate from there.");
        if (r.interviewDraft) qc.setQueryData(["interview-draft", a.id], r.interviewDraft);
        onInterview(r.interviewDraft?.roundKey);
      }
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
 * Someone already at the interview step with no interview in motion and no decision waiting: the way to approve one.
 * The stage button has nothing to open here (they are in Interviewing already), so this card is how a cancelled
 * interview, times that expired, a "Next round" decision or an approval set aside with "Not now" gets going again. The
 * approval it opens is filled in from the plan, so the right round is already chosen.
 */
function readyToInterviewWords(a: Pick<ApplicationDetail, "candidate" | "interviews">): { title: string; body: string; button: string } {
  const first = a.candidate.firstName;
  const latest = a.interviews[0]; // newest first
  if (latest?.status === "cancelled") return { title: "The interview was cancelled", body: `The ${latest.title} with ${first} was cancelled. Approve a new interview and fresh times go out to them.`, button: "Approve an interview" };
  if (latest?.status === "offer_expired") return { title: "No time was picked", body: `${first} did not pick a time for the ${latest.title}. Approve it again and new times go out to them.`, button: "Approve an interview" };
  if (latest?.decision === "next_round") return { title: "Set up the next round", body: `You chose the next round after the ${latest.title}. Approve it and times go out to ${first}.`, button: "Approve the next round" };
  return { title: "Ready to interview", body: `${first} is ready to interview. Choose the round and the interviewers; times go out to them from there.`, button: "Approve an interview" };
}

function ReadyToInterviewCard({ a, onApprove }: { a: ApplicationDetail; onApprove: () => void }) {
  const w = readyToInterviewWords(a);
  return (
    <Card needsYou title={w.title}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{w.body} Nothing is sent until you approve it.</p>
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" size="sm" onClick={onApprove}>{w.button}</Button>
      </div>
    </Card>
  );
}

/**
 * Someone under Cancelled (founder decisions 1A to 4A): what they chose when they cancelled, or that they did not come,
 * and where their new times stand, in the words of the state the API reports. "Send new times" reopens the interview
 * they cancelled for the same round (after a no-show, it sets up a new one for that round); "Don't send automatically"
 * stops a set still waiting for its day. Both ask first. They stay under Cancelled until they book or someone decides.
 * When nobody who ran the interview is still on the team, "Choose interviewers" opens the interview approval instead.
 */
function CancelledCard({ a, c, roleId, onChooseInterviewers }: { a: ApplicationDetail; c: CancelledView; roleId: string; onChooseInterviewers: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [asking, setAsking] = useState<"send" | "stop" | null>(null);
  const [noInterviewers, setNoInterviewers] = useState(false);
  // the company's setting and whether ITS has confirmed the company; shared with the Talent page and Setup
  const setting = useQuery({ queryKey: ["new-times-setting"], queryFn: () => api.get<NewTimesSettingView>("/api/v1/companies/current/new-times"), retry: false });
  const first = a.candidate.firstName;
  const round = a.interviews.find((i) => i.id === c.interviewId)?.title ?? a.interviews[0]?.title ?? "interview";
  const send = useMutation({
    mutationFn: () => api.post<SendNewTimesResult>(`/api/v1/applications/${a.id}/new-times`, {}),
    onSuccess: async (r) => {
      const t = newTimesToast({ kind: "sent", via: r.via, firstName: first, round });
      toast(t.title, t.detail);
      setAsking(null);
      setNoInterviewers(false);
      await refresh();
    },
    onError: (e) => {
      setAsking(null);
      if (e instanceof ApiError && e.code === "no_interviewers") setNoInterviewers(true);
      toast(e instanceof ApiError ? e.message : "Could not send new times.");
    },
  });
  const stop = useMutation({
    mutationFn: () => api.post(`/api/v1/applications/${a.id}/new-times/stop`, {}),
    onSuccess: async () => {
      const t = newTimesToast({ kind: "stopped" });
      toast(t.title, t.detail);
      setAsking(null);
      await refresh();
    },
    onError: (e) => {
      setAsking(null);
      toast(e instanceof ApiError ? e.message : "Could not stop the automatic new times.");
    },
  });
  const can = (x: ApplicationDetail["allowedActions"][number]) => a.allowedActions.includes(x);
  // Before ITS confirms the company nothing goes automatically and a send is refused, so the card says so and offers no send.
  const companyConfirmed = setting.data?.companyConfirmed;
  const maySend = can("send_new_times") && companyConfirmed !== false;
  // Waits on the team only when nothing is on its way to them: no set waiting for its day, no times being prepared or out.
  const parked = c.auto.state === "waiting" || c.auto.state === "waiting_check";
  const needsYou = !parked && (c.times === "none" || c.times === "expired" || c.times === "not_reached");
  return (
    <Card needsYou={needsYou} title={cancelledTitle(first, c.reason)}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{cancelledBody({ firstName: first, round, c, companyConfirmed, decideBelow: can("record_decision") })}</p>
      {asking === "send" ? (
        <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>{sendNewTimesQuestion(first, round)}</span><span className="row"><Button size="sm" variant="primary" icon="send" loading={send.isPending} onClick={() => send.mutate()}>Yes, send</Button><Button size="sm" variant="quiet" onClick={() => setAsking(null)}>Cancel</Button></span></div></Alert>
      ) : asking === "stop" ? (
        <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>{stopNewTimesQuestion(first)}</span><span className="row"><Button size="sm" variant="primary" loading={stop.isPending} onClick={() => stop.mutate()}>Yes, stop</Button><Button size="sm" variant="quiet" onClick={() => setAsking(null)}>Keep it</Button></span></div></Alert>
      ) : maySend || can("stop_new_times") || noInterviewers ? (
        <div className="row" style={{ marginTop: 10 }}>
          {maySend ? <Button size="sm" variant="primary" icon="send" onClick={() => setAsking("send")}>Send new times</Button> : null}
          {can("stop_new_times") ? <Button size="sm" variant="quiet" onClick={() => setAsking("stop")}>Don't send automatically</Button> : null}
          {noInterviewers ? <Button size="sm" variant="quiet" onClick={onChooseInterviewers}>Choose interviewers</Button> : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The decision after an interview is a person's (docs/06; release 1 records it, scorecards and debriefs come later).
 * Shown when the last interview is over and nobody has decided yet: next round, finalist, hire, or not moving forward
 * with a reason. "Next round" opens the interview approval with that round and its interviewers; "Hire" the hire sheet.
 * The team's private notes sit on the card (plan H3), so the decision is made with them in view.
 */
function DecisionCard({ a, roleId, myRole, onNextRound, onHire, onNotes }: { a: ApplicationDetail; roleId: string; myRole: string | null; onNextRound: (roundKey: string) => void; onHire: () => void; onNotes: () => void }) {
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
  // A candidate who did not come never moves on to the next round from here: new times for the same round, or a decision.
  const hasNextRound = idx >= 0 && idx + 1 < a.interviewPlan.length && last?.outcome !== "no_show_candidate";
  return (
    <Card needsYou lift title="How did the interview go?">
      <p className="small" style={{ color: "var(--ink-2)" }}>{last ? `${last.title}${last.outcome === "no_show_candidate" ? " (the candidate did not attend)" : last.outcome === "no_show_interviewer" ? " (the interviewer did not attend)" : ""}. ` : ""}The decision is yours and is recorded with your name.</p>
      {canReadNotes(myRole) ? <NotesSummary applicationId={a.id} onOpen={onNotes} /> : null}
      {!decision ? (
        <div className="row" style={{ marginTop: 10 }}>
          {hasNextRound ? <Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate({ decision: "next_round" })}>Next round</Button> : null}
          <Button size="sm" variant={hasNextRound ? undefined : "primary"} onClick={() => setDecision("finalist")}>Finalist</Button>
          {a.allowedActions.includes("record_outcome") ? <Button size="sm" onClick={onHire} title="Opens the hire sheet: the start date, then what to do with the role">Hire</Button> : null}
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
