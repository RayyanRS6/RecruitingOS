"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { titleMidSentence, type SetInterviewTime } from "@ros/contracts";
import { Alert, Button, Card, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ActionResult, type ApplicationDetail, type CancelledView, type InterviewBooked, type InterviewDraft, type InterviewPlanView, type NewTimesSettingView, type SendNewTimesResult, type SuggestedLine } from "../../api/client";
import { HOLD_ENDS_CANCELLED, cancelledBody, cancelledTitle, sendNewTimesQuestion, stopNewTimesQuestion } from "../../cancelled";
import { PERSONAL_LINE_MAX, suggestedLineNote } from "../../telling";
import { toast } from "../../toast";
import { Link } from "../../nav";
import { AskRecruiter } from "../../components/AskRecruiter";
import { SetTimeForm } from "../../components/SetTimeForm";
import { useCompanyCheck, useCompanyTimezone } from "../../components/use-company-check";
import { defaultInterviewers } from "../../interview-defaults";
import { candidateEmailLine, defaultDuration, freshForm, interviewNeedingTime, meetingLinkFor, placeKindFor, type SetTimeForm as SetTimeFormState } from "../../interview-time";
import { interviewDraftLine } from "../../hiring";
import { canDecline, canManageInterviews, canReadNotes } from "../../roles";
import { callNotesState, declineReasonFor } from "../../screen-view";
import { NOT_NOW_TOAST, declineConfirmText, declineSummary, decisionToast, holdDay, newTimesToast, outcomeNoticeText, outcomeToast, pickTimesToast, safetyNetAfterDecision, type InterviewRef, type PanelStep } from "../../talent-actions";
import { CallNotesCard } from "./call-notes";
import { DECLINE_REASONS, activeInterviews, eligibilityAnswerWords, firstSentence, holdDateBounds, whoDecides, type PanelTab } from "./helpers";
import { FinalistCard, HireStep, OfferStep, WaitingOnCandidateCard } from "./hiring";
import { useCandidateAction, useDraft, useFocusOnMount, useRefreshCandidate } from "./hooks";
import { NotesSummary } from "./notes";
import { TellCard } from "./telling";
import { LEAD, STEP, SUGGESTED, Why } from "./why";

/**
 * The area under the panel's header (plan A10; founder decision Q23): everything that waits on a person about this
 * candidate, then the step a stage choice opened. Each card is the same decision it always was, said in one short line
 * with its buttons (Wave S1); the longer words are one click away under "Why". Each one is a compact "Your next step"
 * card (the lavender-to-peach wash, its title, a line and a plum pill), straight under the tabs: no label over them
 * (founder, 23 Oct 2026: fewer words), the wash and the display titles set them apart from the section cards below.
 */

type Props = { a: ApplicationDetail; roleId: string; myRole: string | null; myUserId: string | null; step: PanelStep | null; setStep: (step: PanelStep | null, opts?: { roundKey?: string }) => void; roundKey?: string; onTab?: (tab: PanelTab) => void };

const DECIDED = ["rejected", "talent_pool"];
/** The steps from which an offer made outside the app can be recorded (plan H2). */
const FINALIST = ["finalist", "reference_check"];
/** Already in the Interviewing column, where the stage button has nothing to open: the approval card offers the interview. */
const INTERVIEW_READY = ["interview_recommended", "interview_complete"];
/** Why the same round is proposed again (founder decision L-12): our interviewer missed it, and the invitation apologises. */
const MISSED_BY_US_LINE = "Our interviewer missed it. The new invitation says sorry.";

export function NeedsYou(props: Props) {
  const { a, roleId, step, setStep } = props;
  const can = (x: ApplicationDetail["allowedActions"][number]) => a.allowedActions.includes(x);
  // The assistant's "Interview?" suggestion. No "Invite to a screening chat?" card any more (20 Oct 2026, R20-4): every
  // applicant gets the AI interview by itself, and an old suggestion still waiting lapses on its own.
  const suggestions = a.pendingApprovals.filter((p) => p.actionType === "application.recommend_interview");
  // a decision nobody has told the candidate about yet, or whose message is on its way
  const telling = DECIDED.includes(a.stage) && (a.toldState === "not_told" || a.toldState === "queued");
  const messagesWaiting = a.pendingApprovals.some((p) => p.actionType === "message.send_freeform");
  // the candidate asked for a person (plan E3): for a recruiter, adding the notes from their call is what waits
  const callNotes = callNotesState(a, props.myRole);
  // after the interviews (plan Wave H): a finalist's next step, and an offer waiting on the candidate's answer
  const finalist = FINALIST.includes(a.stage) && can("record_outcome") && !step && !can("record_decision");
  const waitingOnCandidate = a.stage === "offer_sent" && step !== "hire";
  // Already at the interview step with nothing in motion (an interview cancelled, times that expired, "Next round", the
  // step set aside with "Not now", or the assistant's suggestion after a screen), or on the shortlist (the owner's words, 6
  // November 2026: "nadine sets date and time from the shortlisted candidates"): "Set a date and time" is the main button.
  // Someone under Cancelled has their own card instead (founder decisions 1A to 4A).
  const cancelled = a.ownerStage === "cancelled" ? a.cancelled : null;
  const readyToInterview = !step && can("interview") && !can("record_decision") && (INTERVIEW_READY.includes(a.stage) || a.mark?.mark === "shortlist")
    && !suggestions.some((p) => p.actionType === "application.recommend_interview") && a.mark?.mark !== "on_hold" && a.mark?.mark !== "not_a_fit_for_now" && !cancelled;
  // An interview set up with no time, or times that never reached them: nobody is left on it with nothing to press.
  const noTime = !step && canManageInterviews(props.myRole) ? interviewNeedingTime(a.interviews) : null;
  const cards = [
    callNotes.prominent ? <CallNotesCard key="call-notes" a={a} roleId={roleId} prominent /> : null,
    step === "hold" ? <HoldStep key="hold" a={a} roleId={roleId} cancelled={!!cancelled} onClose={() => setStep(null)} /> : null,
    step === "decline" ? <DeclineStep key="decline" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "interview" ? <InterviewStep key="interview" a={a} roleId={roleId} initialRoundKey={props.roundKey} myUserId={props.myUserId} onClose={() => setStep(null)} /> : null,
    noTime ? <NoTimeCard key={`no-time-${noTime.id}`} a={a} roleId={roleId} iv={noTime} /> : null,
    step === "offer" ? <OfferStep key="offer" a={a} roleId={roleId} onClose={() => setStep(null)} /> : null,
    step === "hire" ? <HireStep key="hire" a={a} roleId={roleId} mayTell={canDecline(props.myRole)} onClose={() => setStep(null)} /> : null,
    step === "outcome" ? <OutcomeStep key="outcome" a={a} roleId={roleId} onClose={() => setStep(null)} onHire={() => setStep("hire")} /> : null,
    ...suggestions.map((p) => <SuggestionCard key={p.id} a={a} roleId={roleId} p={p} onInterview={(roundKey) => setStep("interview", { roundKey })} />),
    // under Cancelled: above the decision card, which an undecided no-show also has ("Send new times …, or decide below")
    cancelled && step !== "interview" ? <CancelledCard key="cancelled" a={a} c={cancelled} roleId={roleId} onSetTime={() => setStep("interview")} /> : null,
    can("record_decision") && step !== "interview" && step !== "hire" ? <DecisionCard key="decision" a={a} roleId={roleId} myRole={props.myRole} onNextRound={(key) => setStep("interview", { roundKey: key })} onSameRound={(key) => setStep("interview", { roundKey: key })} onHire={() => setStep("hire")} onNotes={() => props.onTab?.("notes")} /> : null,
    readyToInterview ? <ReadyToInterviewCard key="ready-to-interview" a={a} onSetTime={() => setStep("interview")} /> : null,
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
    // Rises in once, filled backwards only: afterwards the section is no containing block or layer for the sheets drawn
    // inside its cards. A long word or address breaks anywhere, so it never pushes a phone's screen sideways. Named for
    // screen readers only; on screen the cards' wash says it.
    <section className="mb-1 grid gap-3 wrap-anywhere motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]" aria-label="What needs you">
      {cards}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Steps a stage choice opens.                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** How the company's settings run this person's decision message, as the panel knows it: the safety net's way (D-03 A). */
function decisionHint(a: ApplicationDetail): { policy: ApplicationDetail["declineMessage"]; to: string | null } {
  return { policy: a.declineMessage, to: a.candidate.email };
}

/**
 * What a decline says before the click (founder decisions B6 and D-03 A): private now, any interview it calls off, and
 * the day the standard message goes by itself if nobody tells them first, in short lines; the whole of it (how the
 * candidate will hear under the company's settings, each interview by name and time) one click away.
 */
export function DeclineNotice({ a, interviews, eligibility = false }: { a: ApplicationDetail; interviews?: readonly InterviewRef[]; eligibility?: boolean }) {
  const lines = declineSummary(a.declineMessage, { hasEmail: !!a.candidate.email, interviews });
  return (
    <Alert tone="caution">
      <div className="grid gap-2">
        <div className="grid gap-1">
          {lines.map((l) => <span key={l}>{l}</span>)}
        </div>
        <Why label="What happens next">{declineConfirmText(a.declineMessage, { hasEmail: !!a.candidate.email, interviews, eligibility })}{eligibility ? " The reason recorded is the eligibility answer above." : ""}</Why>
      </div>
    </Alert>
  );
}

/**
 * On hold (plan A4): until a date, with an optional note; private, and they come back to Home on that date. For someone
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
    <Card needsYou lift title="Put on hold" className={STEP}>
      <p className={LEAD}>Private: nothing is sent to the candidate.{cancelled ? ` ${HOLD_ENDS_CANCELLED}` : ""}</p>
      <Why>Nothing about {a.candidate.firstName} waits on anyone until the date you choose; then they come back to your Home page.</Why>
      <div className="stack gap-3">
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
  // "Candidate did not respond" first once their AI interview link closed unused or unfinished (R20-7); a choice still.
  const [reason, setReason] = useState<string>(declineReasonFor(a) ?? DECLINE_REASONS[0][0]);
  const [note, setNote] = useState("");
  useDraft("decline-note", note);
  const first = useFocusOnMount<HTMLSelectElement>();
  const act = useCandidateAction(a.id, roleId, () => onClose());
  const interviews = activeInterviews(a.interviews);
  return (
    <Card needsYou lift title="Not moving forward" className={STEP}>
      <DeclineNotice a={a} interviews={interviews} />
      <div className="stack gap-3">
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

/** The meeting link's rules (decision D3) live with the form's other pure parts; kept here too for the pages that read them. */
export { meetingLinkFor } from "../../interview-time";

/** "Dana Whitfield", "Dana Whitfield and Wes Park": who interviews, on the fold that holds the ticks. */
function namesWords(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * Set a date and time (the owner's words, 6 November 2026: "nadine sets date and time from the shortlisted candidates and
 * he/she will get the mail"): the round only when the plan has more than one, then the day, the time on the company's
 * clock, how long and where; who interviews and a personal line are folded. One press books it, with no calendar and no
 * hours needed, and the candidate gets one email. The press is the approval (AC10.1): nobody else is asked. It opens filled
 * in from the interview plan (plan H4: the next round, its interviewers still on the team, else the person pressing), so
 * "Yes, interview" on a suggestion is one more look and one press. Where every interviewer has hours or a calendar, the old
 * way stays one fold away, under the button: "Or let them pick from your free times".
 */
function InterviewStep({ a, roleId, initialRoundKey, myUserId, onClose }: { a: ApplicationDetail; roleId: string; initialRoundKey?: string; myUserId: string | null; onClose: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const check = useCompanyCheck();
  // Always the company's clock, said by name (never the browser's): the API reads the day and time in it.
  const timeZone = useCompanyTimezone() ?? a.interviews.find((i) => i.timezone)?.timezone ?? null;
  // `calendar`: each person's calendar connection, if any; a working one ("live") is what can make the meeting link.
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Array<{ userId: string; name: string | null; email: string; role: string; status: string; schedulable: boolean; calendar?: { status: string } | null }>>("/api/v1/companies/current/members") });
  // The role's current plan names who interviews in each round now, so assignments made on the Interview plan tab reach candidates who applied before them.
  const currentPlan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`) });
  // The card filled in by the API (the answer to "Yes, interview" puts it here first); a refusal just leaves the page's own defaults.
  const draft = useQuery({ queryKey: ["interview-draft", a.id], queryFn: () => api.get<InterviewDraft>(`/api/v1/applications/${a.id}/interview-draft`), retry: false });
  const nextRound = a.interviewPlan.find((r) => !a.interviews.some((i) => i.roundKey === r.key && ["completed"].includes(i.status))) ?? a.interviewPlan[0];
  const [roundKey, setRoundKey] = useState<string | null>(initialRoundKey ?? null);
  const [interviewers, setInterviewers] = useState<string[] | null>(null);
  const [withOpen, setWithOpen] = useState(false);
  const activeMembers = (members.data ?? []).filter((m) => m.status === "active");
  const filled = draft.data && a.interviewPlan.some((r) => r.key === draft.data.roundKey) ? draft.data : null;
  const chosenRoundKey = roundKey ?? filled?.roundKey ?? nextRound?.key;
  const round = a.interviewPlan.find((r) => r.key === chosenRoundKey) ?? null;
  const fromDraft = filled && filled.roundKey === chosenRoundKey && filled.interviewerUserIds.length ? filled.interviewerUserIds : null;
  const membersKnown = !!members.data && !currentPlan.isLoading;
  const chosenInterviewers = defaultInterviewers({
    roundKey: chosenRoundKey,
    applicationPlan: a.interviewPlan,
    currentPlan: currentPlan.data?.rounds.map((r) => ({ key: r.key, interviewerUserIds: r.interviewers.map((i) => i.userId) })) ?? null,
    picked: interviewers ?? fromDraft,
    activeMemberIds: membersKnown ? new Set(activeMembers.map((m) => m.userId)) : null,
    fallbackUserId: myUserId,
  });
  // The calendar can make the meeting link only through an interviewer's working calendar connection (see meetingLinkFor).
  const calendarLive = activeMembers.some((m) => chosenInterviewers.includes(m.userId) && m.calendar?.status === "live");
  // The form follows the round: its length and the place its format suggests, keeping the day and time already chosen.
  const [form, setForm] = useState<SetTimeFormState>(() => freshForm(round));
  const [formRound, setFormRound] = useState(chosenRoundKey);
  if (formRound !== chosenRoundKey) {
    setFormRound(chosenRoundKey);
    setForm((f) => ({ ...f, durationMinutes: defaultDuration(round?.durationMinutes), place: placeKindFor(round?.format) }));
  }
  const link = meetingLinkFor({ calendarLive, picked: form.linkPicked ?? null, url: form.place === "link" ? form.url : "" });
  // The old way, folded: offered only when every interviewer has hours or a calendar, the one case it can work in.
  const everyoneHasHours = membersKnown && chosenInterviewers.length > 0 && chosenInterviewers.every((id) => activeMembers.some((m) => m.userId === id && m.schedulable));
  const names = activeMembers.filter((m) => chosenInterviewers.includes(m.userId)).map((m) => m.name ?? m.email);
  const nobody = membersKnown && !chosenInterviewers.length;
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
  const invitationLine = line.trim() ? { invitationLine: { text: line.trim(), aiHelped: lineAiHelped, ...(kept?.runId ? { suggestionRunId: kept.runId } : {}) } } : {};
  // One press books it: the date and time a person set (POST /applications/:id/interviews with `setTime`). A press before
  // the team has loaded (nobody can be ticked yet) says what is missing instead of sending nobody.
  const book = async (setTime: SetInterviewTime) => {
    if (!chosenInterviewers.length) throw new ApiError(400, "no_interviewers", "Tick who will interview.");
    return api.post<InterviewBooked>(`/api/v1/applications/${a.id}/interviews`, { roundKey: chosenRoundKey, interviewerUserIds: chosenInterviewers, setTime, ...invitationLine });
  };
  // The old way: the times are worked out from the interviewers' hours or calendars and emailed for the candidate to pick.
  const offer = useMutation({
    mutationFn: () => api.post(`/api/v1/applications/${a.id}/interviews`, { roundKey: chosenRoundKey, interviewerUserIds: chosenInterviewers, ...link.body, ...invitationLine }),
    onSuccess: async () => { const t = pickTimesToast(a.candidate.firstName, check); toast(t.title, t.detail); await refresh(); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not set up the interview."),
  });
  const suggestion = suggest.data;
  // The same round again after our interviewer missed it (founder decision L-12): the card says why it proposes it.
  const missedByUs = !!filled && filled.roundKey === chosenRoundKey && (filled as InterviewDraft & { sameRoundAgain?: string }).sameRoundAgain === "missed_by_us";
  const openWith = () => {
    setWithOpen(true);
    document.getElementById("iv-with")?.focus();
  };
  return (
    <Card needsYou lift title="Set a date and time" className={STEP}>
      {missedByUs ? <p className="small">{MISSED_BY_US_LINE}</p> : null}
      {a.interviewPlan.length === 0 ? (
        <>
          <Alert tone="caution">This job has no interview rounds yet. Add them on the job's Interview plan tab.</Alert>
          <div className="row"><Button size="sm" variant="quiet" onClick={onClose}>Not now</Button></div>
        </>
      ) : (
        <SetTimeForm
          idBase="iv"
          firstName={a.candidate.firstName}
          hasEmail={!!a.candidate.email}
          phone={a.candidate.phone}
          timeZone={timeZone}
          form={form}
          onChange={setForm}
          roundMinutes={round?.durationMinutes}
          videoRound={round?.format === "video"}
          calendarLive={calendarLive}
          // the team, the plan and who is pressing, all read before anyone can be ticked (the person pressing is the default)
          interviewers={membersKnown && myUserId ? chosenInterviewers.length : undefined}
          teamLoading={!membersKnown || !myUserId}
          onMissingInterviewers={openWith}
          autoFocus
          before={a.interviewPlan.length > 1 ? <Field label="Round" htmlFor="iv-round"><select id="iv-round" className="select" value={chosenRoundKey ?? ""} onChange={(e) => { setRoundKey(e.target.value); setInterviewers(null); }}>{a.interviewPlan.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></Field> : null}
          after={
            <>
              {/* who interviews: ticked from the plan, else the person pressing; folded, and open while nobody is ticked */}
              <details className="more" open={withOpen || nobody} onToggle={(e) => setWithOpen(e.currentTarget.open)}>
                <summary id="iv-with">{names.length ? `With ${namesWords(names)}` : membersKnown ? "Choose who interviews" : "Who interviews"}</summary>
                <fieldset className="grid gap-2">
                  <legend className="sr-only">Interviewers</legend>
                  {members.isLoading || currentPlan.isLoading ? <Skeleton lines={2} /> : members.error ? <ErrorState message="Could not load your team, so nobody can be picked yet." onRetry={() => members.refetch()} /> : activeMembers.map((m) => (
                    <label key={m.userId} className="option-row flex-wrap">
                      <input type="checkbox" checked={chosenInterviewers.includes(m.userId)} onChange={(e) => setInterviewers(e.target.checked ? [...chosenInterviewers, m.userId] : chosenInterviewers.filter((x) => x !== m.userId))} />
                      <span className="min-w-0 wrap-anywhere">{m.name ?? m.email}</span>
                    </label>
                  ))}
                </fieldset>
              </details>
              {/* The personal line is optional and rarely used: one click away (the assistant's suggestion is asked for inside it). */}
              <details className="more">
                <summary>{line.trim() ? "Your personal line (it goes with the invitation)" : "Add a personal line (optional)"}</summary>
                <div className="stack gap-3">
                  {/* the hint states the length the box stops at (else typing stops without a word) and the rule the line is checked against */}
                  <Field label="A personal line for the invitation (optional)" htmlFor="iv-line" hint={`One or two sentences, ${PERSONAL_LINE_MAX} characters at most. It is checked before anything is sent: no scores, nothing about age, family, health, religion or background.`}>
                    <textarea id="iv-line" className="textarea" rows={2} maxLength={PERSONAL_LINE_MAX} value={line} onChange={(e) => { setLine(e.target.value); if (!e.target.value.trim()) setKept(null); }} placeholder={`For example: We enjoyed reading about your work, ${a.candidate.firstName}.`} />
                  </Field>
                  {suggestion?.line && !kept ? (
                    <div className={SUGGESTED}>
                      <p className="small"><q>{suggestion.line}</q></p>
                      <p className="small muted">{suggestion.note}</p>
                      <div className="row"><Button size="sm" onClick={() => { setLine(suggestion.line!); setKept({ line: suggestion.line!, runId: suggestion.suggestionRunId }); }}>Use this line</Button><Button size="sm" variant="quiet" onClick={() => suggest.reset()}>No thanks</Button></div>
                    </div>
                  ) : suggestion && !suggestion.line ? <p className="small muted">{suggestion.note}</p> : null}
                  {!kept ? <div className="row"><Button size="sm" variant="secondary" icon="sparkle" loading={suggest.isPending} disabled={!chosenRoundKey} onClick={() => suggest.mutate()} title="The assistant suggests one friendly line; if you keep it, the invitation says the assistant helped">Suggest a line</Button></div> : null}
                  {lineAiHelped ? (
                    <div className="row gap-2">
                      <p className="small muted">{suggestedLineNote(lineStillWhole, "invitation")}</p>
                      {lineStillWhole ? <Button size="sm" variant="quiet" onClick={() => { setLine(line.replace(kept!.line, "").trim()); setKept(null); }}>Take out the assistant's line</Button> : null}
                    </div>
                  ) : null}
                </div>
              </details>
              {/* what the plan filled in, said once, one click away */}
              {filled && filled.roundKey === chosenRoundKey ? <Why>{interviewDraftLine(filled)}</Why> : null}
            </>
          }
          footer={everyoneHasHours ? (
            <details className="more">
              <summary>Or let them pick from your free times</summary>
              <div className="stack gap-2">
                <p className="small muted">{a.candidate.firstName} gets times from the interviewers' hours by email and picks one.</p>
                <div className="row"><Button size="sm" loading={offer.isPending} disabled={!chosenRoundKey || !link.ready} onClick={() => offer.mutate()}>Offer times to pick from</Button></div>
              </div>
            </details>
          ) : null}
          submit={book}
          // the panel is read again before the form closes, so what shows next is the booking, never the card it came from
          onDone={async () => { await refresh(); onClose(); }}
          onCancel={onClose}
        />
      )}
    </Card>
  );
}

/**
 * An interview set up with no time (being prepared, reopened with nothing to offer) or with times that never reached them
 * (the email failed, or there is no address): for those who manage interviews, "Set a date and time" on the panel, posting
 * to that same interview (POST /interviews/:id/set-time). Nobody is left on it with nothing to press (6 November 2026).
 */
function NoTimeCard({ a, roleId, iv }: { a: ApplicationDetail; roleId: string; iv: ApplicationDetail["interviews"][number] }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const timeZone = useCompanyTimezone() ?? iv.timezone;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SetTimeFormState>(() => freshForm({ durationMinutes: iv.durationMinutes, format: iv.format }));
  const first = a.candidate.firstName;
  const round = titleMidSentence(iv.title);
  const reached = iv.status === "scheduling" && iv.offeredSlots.length ? candidateEmailLine(iv.candidateEmail, first) : null;
  return (
    <Card needsYou lift title={reached ? `The times did not reach ${first}` : `The ${round} has no time yet`} className={STEP}>
      {reached ? <p className={LEAD}>{reached}</p> : null}
      {open ? (
        <SetTimeForm
          idBase={`set-${iv.id}`}
          firstName={first}
          hasEmail={!!a.candidate.email}
          phone={a.candidate.phone}
          timeZone={timeZone}
          form={form}
          onChange={setForm}
          roundMinutes={iv.durationMinutes}
          videoRound={iv.format === "video"}
          autoFocus
          submit={(body) => api.post<InterviewBooked>(`/api/v1/interviews/${iv.id}/set-time`, body)}
          onDone={async () => { await refresh(); setOpen(false); }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <div className="row">
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Set a date and time</Button>
          <Link to={`/interviews/${iv.id}`} className="btn quiet sm">Open the interview</Link>
        </div>
      )}
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
    mutationFn: () => api.post<{ roleStillOpen: boolean; roleId: string } & Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes" | "decisionMessage">>(`/api/v1/applications/${a.id}/outcome`, { outcome: form.outcome, confirm: true, reason: form.outcome === "employer_declined" ? form.reason : undefined, note: form.note.trim() || undefined }),
    onSuccess: async (r) => {
      const t = outcomeToast(form.outcome, { ...r, decisionMessage: r.decisionMessage ?? decisionHint(a) });
      toast(t.title, t.detail);
      onClose();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the outcome."),
  });
  const pastDecision = a.stage === "talent_pool";
  return (
    <Card needsYou lift title="Record what happened" className={STEP}>
      <p className={LEAD}>Recorded with your name. {outcomeNoticeText(activeInterviews(a.interviews))}</p>
      <Why>You record it with your name; the platform never makes or sends an offer, and it asks for no pay, tax, identity or banking details.</Why>
      <div className="row">
        <Button size="sm" onClick={onHire}>Open the hire sheet</Button>
      </div>
      {pastDecision ? null : (
        <div className="stack gap-3">
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
            <DeclineNotice a={a} interviews={activeInterviews(a.interviews)} />
          </> : null}
          {/* "No hire" is a private decision too (they move to the talent pool untold): the safety net is said (D-03 A). */}
          {form.outcome === "no_hire" ? <p className="small muted">Private: nothing is sent to them now. {safetyNetAfterDecision({ decisionMessage: decisionHint(a) })}</p> : null}
          <Field label="Note (kept internally, optional)" htmlFor="oc-note"><input id="oc-note" className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          {form.confirming ? (
            <Alert tone="caution"><div className="row justify-between"><span>Record this outcome under your name? It is audited and can only be corrected by an administrator.</span><span className="row"><Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate()}>Yes, record it</Button><Button size="sm" variant="quiet" onClick={() => setForm({ ...form, confirming: false })}>No</Button></span></div></Alert>
          ) : <div className="row"><Button size="sm" variant="primary" onClick={() => setForm({ ...form, confirming: true })}>Continue</Button><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div>}
        </div>
      )}
      {pastDecision ? <div className="row"><Button size="sm" variant="quiet" onClick={onClose}>Cancel</Button></div> : null}
    </Card>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What waits on a person.                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The assistant's suggestion of an interview: Yes, or Not now with an optional reason (plan A6). "Yes, interview" goes
 * straight on to the interview approval, filled in from the plan (plan H4): one more look, one click.
 */
function SuggestionCard({ a, roleId, p, onInterview }: { a: ApplicationDetail; roleId: string; p: ApplicationDetail["pendingApprovals"][number]; onInterview: (roundKey?: string) => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshCandidate(a.id, roleId);
  const [declining, setDeclining] = useState(false);
  const [why, setWhy] = useState("");
  useDraft(`not-now-${p.id}`, why);
  const decide = useMutation({
    mutationFn: (input: { decision: "approve" | "reject"; note?: string }) => api.post<{ interviewDraft?: InterviewDraft | null }>(`/api/v1/approvals/${p.id}/decide`, input),
    onSuccess: async (r, input) => {
      if (input.decision === "reject") toast(NOT_NOW_TOAST.title, NOT_NOW_TOAST.detail);
      else {
        toast("Moved to Interviewing.", "Set the date and time below.");
        if (r.interviewDraft) qc.setQueryData(["interview-draft", a.id], r.interviewDraft);
        onInterview(r.interviewDraft?.roundKey);
      }
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const rationale = firstSentence(p.rationale);
  return (
    <Card needsYou lift title="The assistant suggests an interview" className={STEP}>
      {rationale.line ? <p className={LEAD}>{rationale.line}</p> : null}
      {rationale.rest ? <Why>{rationale.rest}</Why> : null}
      {declining ? (
        <div className="stack gap-3">
          <Field label="Why not now? (optional, kept internally)" htmlFor={`why-${p.id}`}><input id={`why-${p.id}`} className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          <div className="row">
            <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ decision: "reject", note: why.trim() || "Not now" })}>Set it aside</Button>
            <Button size="sm" variant="quiet" onClick={() => setDeclining(false)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button variant="primary" size="sm" loading={decide.isPending} onClick={() => decide.mutate({ decision: "approve" })}>Yes, interview</Button>
          <Button size="sm" onClick={() => setDeclining(true)}>Not now</Button>
          <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
        </div>
      )}
    </Card>
  );
}

/**
 * Someone on the shortlist, or already at the interview step with no interview in motion and no decision waiting: "Set a
 * date and time" is the one button (the owner's words, 6 November 2026). For someone in Interviewing the stage button has
 * nothing to open, so this card is how a cancelled interview, times that lapsed, a "Next round" decision or a step set
 * aside with "Not now" gets going again. The form it opens is filled in from the plan, so the right round is chosen.
 * Times that lapsed because their email never reached them say that, never that the candidate did not pick one.
 */
export function readyToInterviewWords(a: Pick<ApplicationDetail, "candidate" | "interviews" | "mark">): { title: string; body: string; button: string } {
  const first = a.candidate.firstName;
  const latest = a.interviews[0]; // newest first
  const button = "Set a date and time";
  if (latest?.status === "cancelled") return { title: "The interview was cancelled", body: `The ${latest.title} with ${first} was cancelled.`, button };
  if (latest?.status === "offer_expired" && (latest.candidateEmail === "failed" || latest.candidateEmail === "no_email")) return { title: "The times never reached them", body: `The email with times for the ${latest.title} did not reach ${first}.`, button };
  if (latest?.status === "offer_expired") return { title: "No time was picked", body: `${first} did not pick a time for the ${latest.title}.`, button };
  if (latest?.decision === "next_round") return { title: "Set up the next round", body: `You chose the next round after the ${latest.title}.`, button };
  if (a.mark?.mark === "shortlist") return { title: "Ready to interview", body: `${first} is on your shortlist.`, button };
  return { title: "Ready to interview", body: `${first} is ready to interview.`, button };
}

function ReadyToInterviewCard({ a, onSetTime }: { a: ApplicationDetail; onSetTime: () => void }) {
  const w = readyToInterviewWords(a);
  return (
    <Card needsYou title={w.title} className={STEP}>
      <p className={LEAD}>{w.body}</p>
      <div className="row">
        <Button variant="primary" size="sm" onClick={onSetTime}>{w.button}</Button>
      </div>
    </Card>
  );
}

/**
 * Someone under Cancelled (founder decisions 1A to 4A): what they chose when they cancelled, or that they did not come,
 * and where their new times stand, in the words of the state the API reports. "Send new times" reopens the interview
 * they cancelled for the same round (after a no-show, it sets up a new one for that round); "Don't send automatically"
 * stops a set still waiting for its day. Both ask first. They stay under Cancelled until they book or someone decides.
 * "Set a date and time" comes first (6 November 2026): it books a time a person chooses, with no hours needed, and takes
 * them out of Cancelled; it is also the way on when nobody who ran the interview is still on the team.
 */
function CancelledCard({ a, c, roleId, onSetTime }: { a: ApplicationDetail; c: CancelledView; roleId: string; onSetTime: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [asking, setAsking] = useState<"send" | "stop" | null>(null);
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
      await refresh();
    },
    onError: (e) => {
      setAsking(null);
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
  // Before ITS confirms the company nothing goes automatically and a send is refused, so the card says so and offers no send;
  // nor with nobody's hours to offer (`noHours`, 10 November 2026): "Set a date and time" is the way on.
  const companyConfirmed = setting.data?.companyConfirmed;
  const maySend = can("send_new_times") && companyConfirmed !== false && !c.noHours;
  // Waits on the team only when nothing is on its way to them: no set waiting for its day, no times being prepared or out.
  const parked = c.auto.state === "waiting" || c.auto.state === "waiting_check";
  const needsYou = !parked && (c.times === "none" || c.times === "expired" || c.times === "not_reached");
  return (
    <Card needsYou={needsYou} title={cancelledTitle(first, c.reason)} className={STEP}>
      <p className={LEAD}>{cancelledBody({ firstName: first, round, c, companyConfirmed, decideBelow: can("record_decision") })}</p>
      {asking === "send" ? (
        <Alert tone="caution"><div className="row justify-between"><span>{sendNewTimesQuestion(first, round)}</span><span className="row"><Button size="sm" variant="primary" icon="send" loading={send.isPending} onClick={() => send.mutate()}>Yes, send</Button><Button size="sm" variant="quiet" onClick={() => setAsking(null)}>Cancel</Button></span></div></Alert>
      ) : asking === "stop" ? (
        <Alert tone="caution"><div className="row justify-between"><span>{stopNewTimesQuestion(first)}</span><span className="row"><Button size="sm" variant="primary" loading={stop.isPending} onClick={() => stop.mutate()}>Yes, stop</Button><Button size="sm" variant="quiet" onClick={() => setAsking(null)}>Keep it</Button></span></div></Alert>
      ) : can("interview") || maySend || can("stop_new_times") ? (
        <div className="row">
          {can("interview") ? <Button size="sm" variant="primary" onClick={onSetTime}>Set a date and time</Button> : null}
          {maySend ? <Button size="sm" variant={can("interview") ? undefined : "primary"} icon="send" onClick={() => setAsking("send")}>Send new times</Button> : null}
          {can("stop_new_times") ? <Button size="sm" variant="quiet" onClick={() => setAsking("stop")}>Don't send automatically</Button> : null}
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
function DecisionCard({ a, roleId, myRole, onNextRound, onSameRound, onHire, onNotes }: { a: ApplicationDetail; roleId: string; myRole: string | null; onNextRound: (roundKey: string) => void; onSameRound: (roundKey: string) => void; onHire: () => void; onNotes: () => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const [decision, setDecision] = useState<"finalist" | "not_moving_forward" | null>(null);
  const [reason, setReason] = useState(DECLINE_REASONS[0][0]);
  const [note, setNote] = useState("");
  useDraft("decision-note", note);
  const record = useMutation({
    mutationFn: (body: { decision: "next_round" | "finalist" | "not_moving_forward"; reason?: string; note?: string }) => api.post<{ stage: string; nextRoundKey: string | null } & Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes" | "decisionMessage">>(`/api/v1/applications/${a.id}/decision`, body),
    onSuccess: async (r, body) => {
      // the safety net's way under the company's settings (D-03 A): the answer's own word, else what this panel knows
      const t = decisionToast(body.decision, { ...r, decisionMessage: r.decisionMessage ?? decisionHint(a) });
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
  // Our interviewer missed it (founder decision L-12): the same round again comes first, and records no decision; the
  // other choices stay, second.
  const sameRoundFirst = !!last && last.outcome === "no_show_interviewer" && a.allowedActions.includes("interview");
  return (
    <Card needsYou lift title="How did the interview go?" className={STEP}>
      <p className={LEAD}>{last ? `${last.title}${last.outcome === "no_show_candidate" ? " (the candidate did not attend)" : last.outcome === "no_show_interviewer" ? " (the interviewer did not attend)" : ""}. ` : ""}Your decision, recorded with your name.</p>
      {sameRoundFirst ? <p className="small">{MISSED_BY_US_LINE}</p> : null}
      {canReadNotes(myRole) ? <NotesSummary applicationId={a.id} onOpen={onNotes} /> : null}
      {!decision ? (
        <div className="row">
          {sameRoundFirst && last ? <Button size="sm" variant="primary" onClick={() => onSameRound(last.roundKey)}>Set the same round again</Button> : null}
          {hasNextRound ? <Button size="sm" variant={sameRoundFirst ? undefined : "primary"} loading={record.isPending} onClick={() => record.mutate({ decision: "next_round" })}>Next round</Button> : null}
          <Button size="sm" variant={hasNextRound || sameRoundFirst ? undefined : "primary"} onClick={() => setDecision("finalist")}>Finalist</Button>
          {a.allowedActions.includes("record_outcome") ? <Button size="sm" onClick={onHire} title="Opens the hire sheet: the start date, then what to do with the role">Hire</Button> : null}
          <Button size="sm" variant="destructive" onClick={() => setDecision("not_moving_forward")}>Not moving forward</Button>
          <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
        </div>
      ) : (
        <div className="stack gap-3">
          {decision === "not_moving_forward" ? (
            <>
              <DeclineNotice a={a} interviews={activeInterviews(a.interviews)} />
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
    <Card needsYou title="Held on an eligibility answer" className={STEP}>
      <div className="grid gap-1">
        <p className={LEAD}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${eligibilityAnswerWords(f)}`).join("; ")}</p>
        <p className="small muted">Held for your decision; nothing was sent to them.</p>
      </div>
      <Why>Keep them in if the answer was a mistake. You are reminded daily, and an ITS recruiter is brought in after three days. Say why if you keep them in; it is recorded and the system learns from it.</Why>
      <Field label="Why keep them in?" htmlFor="ovnote"><input id="ovnote" className="input" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="For example: sitting the licensing exam next week" /></Field>
      <div className="row">
        <Button variant="primary" size="sm" disabled={!overrideNote.trim() || !can("override_eligibility")} title={can("override_eligibility") ? (overrideNote.trim() ? "Keeps them in the process with your reason" : "Say why first") : blocked("override_eligibility")} loading={act.isPending && act.variables?.action === "override_eligibility"} onClick={() => act.mutate({ action: "override_eligibility", note: overrideNote })}>Keep them in</Button>
        <Button size="sm" variant="destructive" disabled={!can("reject")} title={can("reject") ? "Not moving forward on this answer: you confirm next" : blocked("reject")} onClick={() => setConfirming(true)}>Decline now</Button>
      </div>
      {!can("reject") ? <p className="small muted">{blocked("reject")}</p> : null}
      {confirming ? (
        <div className="stack gap-3">
          <DeclineNotice a={a} eligibility />
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
    <Card title="Declined on an eligibility answer" className={STEP}>
      <p className={LEAD}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${eligibilityAnswerWords(f)}`).join("; ") || "An eligibility rule you authored was not met."}</p>
      <div className="row"><Button size="sm" disabled={!can} title={can ? "Reopens the application so it is looked at again" : a.blockedReasons.review_anyway ?? "Not available at this step."} loading={act.isPending} onClick={() => act.mutate({ action: "review_anyway", note: "Reopened by the owner" })}>Review anyway</Button></div>
    </Card>
  );
}

/** A hold whose date has come (plan A4): they are back in front of the team; take them off hold or hold them again. */
function HoldEndedCard({ a, roleId, onHoldAgain }: { a: ApplicationDetail; roleId: string; onHoldAgain: () => void }) {
  const act = useCandidateAction(a.id, roleId);
  return (
    <Card needsYou title="The hold has ended" className={STEP}>
      <p className={LEAD}>You put {a.candidate.firstName} on hold{a.mark?.remindAt ? ` until ${holdDay(a.mark.remindAt)}` : ""}{a.mark?.note ? ` (${a.mark.note})` : ""}.</p>
      <Why>Decide what comes next: take them off hold, hold them again, or choose another stage at the top. Nothing has been sent to them.</Why>
      <div className="row">
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
        <Card key={p.id} needsYou={mayDecide(p)} title={`A message to ${a.candidate.firstName}`} className={STEP}>
          {mayDecide(p) ? (
            <Alert tone="caution">Send this message to {name}? {p.proposal.senderName ?? "A team member"} wrote it; nothing goes out until you say yes.</Alert>
          ) : (
            <Alert tone="neutral">{myUserId && p.proposal.senderUserId === myUserId ? "You wrote" : `${p.proposal.senderName ?? "A team member"} wrote`} this to {name}. It is waiting for {whoDecides(p.requiredRoles)} to read it; nothing goes out until they say yes.</Alert>
          )}
          {/* the message itself, as the candidate would read it */}
          <div className="grid gap-1.5 rounded-xl border border-line bg-surface px-4 py-3">
            {p.proposal.subject ? <p className="small"><strong>{p.proposal.subject}</strong></p> : null}
            <p className="small whitespace-pre-wrap">{p.proposal.text}</p>
          </div>
          {mayDecide(p) ? <div className="row"><Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "approve" })}>Yes, send it</Button><Button size="sm" variant="quiet" loading={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "reject" })}>Do not send</Button></div> : null}
        </Card>
      ))}
    </>
  );
}
