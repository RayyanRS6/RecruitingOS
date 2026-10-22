"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, EvidenceChip, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ApplicationDetail, type MessagePreview, type SendMessageResult, type SuggestedLine, type TimelineEvent } from "../../api/client";
import { Link } from "../../nav";
import { toast } from "../../toast";
import { AskRecruiter } from "../../components/AskRecruiter";
import { InlineUndo } from "../../components/InlineUndo";
import { useTakeBack, useUndoToast } from "../../components/use-undo";
import { openScreenOf } from "../../evidence";
import { offerMadeOn, plainDayWords } from "../../hiring";
import { aiInterviewCard, callNotesState, noScreenWords, overviewScreenLine } from "../../screen-view";
import { holdDay } from "../../talent-actions";
import { HIDDEN_LINK_NOTE, sentWithUndoToast, suggestedLineNote, threadItems, threadWhen, undoMillisLeft, type ThreadPart } from "../../telling";
import { AssessmentCard, NoAssessmentCard, ScorecardUnavailableCard, ScreenCard, StrengthsAndConcerns } from "./assessment";
import { CallNotesCard } from "./call-notes";
import { MatchVerdict, NextStepLine, ScoreBreakdown } from "./match";
import type { NextStepAction } from "./match-view";
import { eligibilityAnswerWords, historyItems, panelQuestions, recruiterEventsFor, resumeToShow, resumeView, suggestionAndDecision, writeupLines, writeupOverviewLine, type Compose, type HistoryItem } from "./helpers";
import { CARD, QUOTE, Why } from "./why";

export type { Compose } from "./helpers";
import { useCandidateAction, useRefreshCandidate } from "./hooks";

/** The candidate panel's sections (plan A10): Overview, Screening chat, Résumé, Messages and History; the Notes tab is notes.tsx. */

/**
 * Overview, the Kanvis way (Wave S1; founder decision B2): the verdict first (the match score, its band and how sure the
 * AI was, one line on the must-haves), the suggested next step with its one button, the first strengths and concerns,
 * then where things stand. The full breakdown (how the score was worked out, the AI review with every finding and quote,
 * the open questions, the eligibility answers and "Something wrong?") is one click away; so are consent and source under
 * the contact line, and everything that happened, on the History tab.
 */
export function OverviewTab({ a, roleId, onHistory, onNext }: { a: ApplicationDetail; roleId: string; onHistory: () => void; onNext?: (action: NextStepAction) => void }) {
  const latest = a.assessments[0] ?? null;
  return (
    <div className="stack gap-4">
      <AiInterviewCard a={a} roleId={roleId} onDecline={() => onNext?.({ kind: "move", to: "not_moving_forward", label: "Not moving forward" })} />
      <NoAssessmentCard detail={a} />
      <ScorecardUnavailableCard detail={a} roleId={roleId} />
      <MatchVerdict a={a}>
        <NextStepLine a={a} onAction={onNext} />
        <StrengthsAndConcerns assessment={latest} />
      </MatchVerdict>
      <WhereTheyAre a={a} />
      <details className="more">
        <summary>Full breakdown</summary>
        <div className="stack gap-4">
          <ScoreBreakdown a={a} />
          {/* Without an AI review yet, the verdict above already says why (`notReadYetWords`, or the card that says it could not be made). */}
          {latest ? <AssessmentCard assessment={latest} detail={a} roleId={roleId} labels={a.packetLabels} title={latest.kind === "screen" ? "AI review: the AI interview" : "AI review: the résumé"} /> : null}
          <EligibilityAnswers a={a} />
          <FormAnswers a={a} />
        </div>
      </details>
      <ContactLine a={a} />
      {/* the panel's foot: everything that happened, and a recruiter */}
      <div className="row justify-between border-t border-line pt-4">
        <Button size="sm" variant="quiet" icon="clock" onClick={onHistory}>See all activity</Button>
        <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
      </div>
    </div>
  );
}

/**
 * "AI interview" (20 Oct 2026, R20-7), at the top of the Overview for someone under "No AI interview yet", like the
 * Cancelled card: where they stand in neutral words, and "Send a reminder" (an open link, once a day), "Send a new link"
 * (the link closed) and "Not moving forward" (the private decline, "Candidate did not respond" chosen first once the
 * link closed). Nothing on it waits on the team (`aiInterviewCard`).
 */
function AiInterviewCard({ a, roleId, onDecline }: { a: ApplicationDetail; roleId: string; onDecline: () => void }) {
  const act = useCandidateAction(a.id, roleId);
  const card = aiInterviewCard(a);
  if (!card) return null;
  return (
    <Card title="AI interview" className={CARD}>
      <p className="small text-ink-2">{card.line}</p>
      <div className="row">
        {card.remind ? <Button size="sm" variant="primary" icon="send" disabled={!card.remind.allowed} title={card.remind.allowed ? undefined : card.remind.reason} loading={act.isPending && act.variables?.action === "remind_screen"} onClick={() => act.mutate({ action: "remind_screen" })}>Send a reminder</Button> : null}
        {card.resend ? <Button size="sm" variant="primary" icon="send" disabled={!card.resend.allowed} title={card.resend.allowed ? undefined : card.resend.reason} loading={act.isPending && act.variables?.action === "invite_screen"} onClick={() => act.mutate({ action: "invite_screen" })}>Send a new link</Button> : null}
        {card.decline ? <Button size="sm" variant="quiet" onClick={onDecline}>Not moving forward</Button> : null}
      </div>
      {card.remind && !card.remind.allowed && card.remind.reason ? <p className="small muted">{card.remind.reason}</p> : null}
    </Card>
  );
}

/**
 * One line on where things stand: the mark and its note, a hold's date, interviews, a recorded outcome, whether a
 * decision was told, and the screening conversation when it says something ("Applied, then did the AI interview.", still
 * applying, sent without it, asked for a person; plan Wave E), and once a sent chat was written up, how many of the
 * company's questions it answered (Wave S7).
 */
function WhereTheyAre({ a }: { a: ApplicationDetail }) {
  const outcomes = useQuery({ queryKey: ["outcomes", a.id], queryFn: () => api.get<{ statement: string; outcomes: OutcomeRecord[] }>(`/api/v1/applications/${a.id}/outcomes`), enabled: ["hired", "withdrawn", "rejected", "talent_pool", "declined"].includes(a.stage) });
  const recorded = outcomes.data?.outcomes.find((o) => !o.correctedAt);
  const lines: string[] = [];
  const screenLine = overviewScreenLine(a);
  if (screenLine) lines.push(screenLine);
  const written = a.screens[0] ? writeupLines(a.screens[0], panelQuestions(a.packetLabels)) : [];
  if (written.length) lines.push(writeupOverviewLine(written));
  if (a.mark) lines.push(`${a.mark.mark === "on_hold" && a.mark.remindAt ? `On hold until ${holdDay(a.mark.remindAt)}` : a.mark.label}${a.mark.setBy.name ? `, set by ${a.mark.setBy.name}` : ""}${a.mark.note ? `: "${a.mark.note}"` : ""}. Private.`);
  if (a.toldState === "sent") lines.push(`Told the decision by message${a.candidateToldAt ? ` on ${new Date(a.candidateToldAt).toLocaleDateString()}` : ""}.`);
  if (a.toldState === "told_in_person") lines.push(`Told the decision in person${a.candidateToldAt ? ` (recorded ${new Date(a.candidateToldAt).toLocaleDateString()})` : ""}.`);
  if (a.toldState === "before_tracking") lines.push("Decided before decisions became private: their status page already showed it, so nothing more is sent.");
  // An offer made outside the app (plan H2): the next move is the candidate's.
  if (a.stage === "offer_sent") lines.push(`Offer made on ${plainDayWords(offerMadeOn(a))}, outside the app: waiting on their answer.`);
  const interviews = a.interviews;
  if (!lines.length && !interviews.length && !recorded) return null;
  return (
    <Card title="Where things stand" className={CARD}>
      {lines.length || interviews.length ? (
        <div className="grid gap-1">
          {lines.map((l) => <p key={l} className="small">{l}</p>)}
          {interviews.map((i) => <p key={i.id} className="small"><Link to={`/interviews/${i.id}`}>{i.title}</Link> · {i.status.replace(/_/g, " ")}{i.startsAt ? ` · ${new Date(i.startsAt).toLocaleString("en-US", { timeZone: i.timezone ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : i.status === "scheduling" ? ` · ${i.offeredSlots.length} times offered` : ""}{i.decision ? ` · decision: ${i.decision.replace(/_/g, " ")}` : ""}</p>)}
        </div>
      ) : null}
      {recorded ? (
        <p className="small">
          <Chip tone={recorded.outcome === "hired_externally" ? "good" : "neutral"}>{OUTCOME_WORDS[recorded.outcome] ?? recorded.outcome.replace(/_/g, " ")}</Chip>{" "}
          <span className="muted">Recorded by {recorded.recordedBy.name ?? "a team member"} on {new Date(recorded.recordedAt).toLocaleDateString()}{recorded.hireDate ? `, hire date ${recorded.hireDate}` : ""}{recorded.correctionOf ? " (a correction by an ITS administrator)" : ""}. {outcomes.data?.statement}</span>
        </p>
      ) : null}
    </Card>
  );
}

type OutcomeRecord = { id: string; outcome: string; hireDate: string | null; offerAcceptedAt: string | null; recordedBy: { name?: string; id: string }; recordedAt: string; correctedAt: string | null; correctionReason: string | null; correctionOf: string | null };
const OUTCOME_WORDS: Record<string, string> = { hired_externally: "Hired", candidate_withdrew: "Withdrew", employer_declined: "We declined", offer_declined_externally: "Declined the offer", no_hire: "No hire" };

function EligibilityAnswers({ a }: { a: ApplicationDetail }) {
  return (
    <Card title="Eligibility answers" className={CARD}>
      {a.eligibility ? (
        <div className="small grid gap-1">
          <p>{a.eligibility.passed ? "Met every required answer." : "Did not meet a required answer."}</p>
          {a.eligibility.failedRules.map((f) => <p key={f.key} className="text-caution">{f.question} → {eligibilityAnswerWords(f)}</p>)}
          {a.eligibility.unverifiable.map((u) => <p key={u.key} className="muted">{u.question}: not answered</p>)}
        </div>
      ) : <p className="muted small">Not checked yet.</p>}
    </Card>
  );
}

/** Said next to an answer the form suggested from the résumé and the candidate left as it was. */
export const SUGGESTED_FROM_RESUME_KEPT = "Suggested from the résumé, kept by the candidate";
export const WORK_SUMMARY_LABEL = "Their summary of their work (checked by them)";
/** Over the facts from earlier chats they kept on the form (Wave S8): the form told them the company sees what they keep. */
export const KEPT_FACTS_LABEL = "Kept from their earlier chats here, confirmed on this application";

/**
 * "Questions from the form" (Wave S7): every answer to the form's questions, the eligibility ones and the company's own
 * quick questions, in the same sentence the candidate's record and the AI read, each marked when it was suggested from
 * the résumé and kept; then the summary of their work they checked; then (Wave S8) the facts from their earlier chats
 * here that they kept ticked on a form opened from the emailed reuse link, in their own words. Nothing for an
 * application without any.
 */
export function FormAnswers({ a }: { a: Pick<ApplicationDetail, "formAnswers" | "workSummary" | "keptFacts"> }) {
  const answers = a.formAnswers ?? [];
  const summary = a.workSummary ?? null;
  const kept = a.keptFacts ?? [];
  if (!answers.length && !summary && !kept.length) return null;
  return (
    <Card title="Questions from the form">
      <div className="small grid gap-3">
        {answers.length ? (
          <ul className="grid list-disc gap-1 pl-5 marker:text-ink-3">
            {answers.map((s) => <li key={`${s.source}:${s.key}`}>{s.sentence}{s.fromCv ? <span className="muted"> ({SUGGESTED_FROM_RESUME_KEPT})</span> : null}</li>)}
          </ul>
        ) : null}
        {summary ? (
          <div className="grid gap-1">
            <p className="muted">{WORK_SUMMARY_LABEL}</p>
            <p className="whitespace-pre-line">{summary.text}</p>
          </div>
        ) : null}
        {kept.length ? (
          <div className="grid gap-1">
            <p className="muted">{KEPT_FACTS_LABEL}</p>
            <ul className="grid list-disc gap-1 pl-5 marker:text-ink-3">
              {kept.map((k) => <li key={k.id}>{k.text}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Contact in one line (email · phone · place), with consent and where they applied one click away (Wave S1). */
function ContactLine({ a }: { a: ApplicationDetail }) {
  const c = a.candidate;
  const parts = [c.email ?? "No email address", c.phone ?? "No phone", c.locationText].filter((x): x is string => !!x);
  return (
    <section className="small grid gap-1.5" aria-label="Contact">
      <p className="wrap-anywhere"><span className="muted">Contact: </span>{parts.join(" · ")}</p>
      <details className="more">
        <summary>Consent and source</summary>
        <dl className="kv">
          <dt>Email</dt><dd>{c.email ?? "none"}</dd>
          <dt>Phone</dt><dd>{c.phone ?? "none"}</dd>
          <dt>Location</dt><dd>{c.locationText ?? "not given"}</dd>
          <dt>Text messages</dt><dd>{c.consent.sms?.granted ? `Consented (${c.consent.sms.source})` : "No consent; email only"}</dd>
          <dt>AI notice</dt><dd>{c.consent.ai_notice ? `Shown ${new Date(c.consent.ai_notice.at).toLocaleDateString()}` : "not recorded"}</dd>
          <dt>Applied through</dt><dd>{a.source.replace(/_/g, " ")}</dd>
          {c.preferences?.talentPoolOptOut ? <><dt>Future roles</dt><dd>Asked not to be kept for future roles; nobody contacts them about other openings</dd></> : null}
        </dl>
      </details>
    </section>
  );
}

const STOPPABLE = ["invited", "reminded"];

/**
 * "Stop this screen" (plan A7): before they start, a screening invitation can be called off. The API decides whether
 * it may be (`cancel_screen`); until it says, the screen's own state does.
 */
export function StopScreen({ a, roleId }: { a: ApplicationDetail; roleId: string }) {
  const [confirming, setConfirming] = useState(false);
  const act = useCandidateAction(a.id, roleId, () => setConfirming(false));
  const open = openScreenOf(a);
  if (!open || !STOPPABLE.includes(open.status)) return null;
  const known = a.allowedActions.includes("cancel_screen") || a.blockedReasons.cancel_screen !== undefined;
  const allowed = known ? a.allowedActions.includes("cancel_screen") : true;
  if (!confirming) {
    return (
      <div className="row">
        <Button size="sm" disabled={!allowed} title={allowed ? "Calls off the invitation before they start" : a.blockedReasons.cancel_screen} onClick={() => setConfirming(true)}>Stop this AI interview</Button>
        {!allowed && a.blockedReasons.cancel_screen ? <span className="small muted">{a.blockedReasons.cancel_screen}</span> : null}
      </div>
    );
  }
  return (
    <Alert tone="caution">
      <div className="stack gap-2">
        <span>Stop {a.candidate.firstName}'s AI interview invitation? Their link stops working, and they get a short, polite note saying it is no longer needed. Nothing is decided about them.</span>
        <div className="row"><Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: "cancel_screen" })}>Yes, stop it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep it open</Button></div>
      </div>
    </Alert>
  );
}

/**
 * Screening chat: every screening chat, newest first, with its transcript open, and the AI reviews of them. A recruiter
 * can add notes from a call here (plan E3); when the candidate asked for a person, that form waits at the top of the
 * panel instead.
 */
export function ScreenTab({ a, roleId, myRole = null }: { a: ApplicationDetail; roleId: string; myRole?: string | null }) {
  const scorecards = a.assessments.filter((x) => x.kind === "screen");
  const notes = callNotesState(a, myRole);
  const notesCard = notes.show && !notes.prominent ? <CallNotesCard a={a} roleId={roleId} prominent={false} /> : null;
  if (!a.screens.length) {
    const none = noScreenWords(a);
    return (
      <div className="stack gap-4">
        <Card title="AI interview" className={CARD}>
          <p className="small muted">{none.line}</p>
          <Why label="What is an AI interview?">{none.why}</Why>
        </Card>
        {notesCard}
      </div>
    );
  }
  return (
    <div className="stack gap-4">
      {/* The company's written questions name the answers too (Wave S7), with each one written up from the chat. */}
      {a.screens.map((s, i) => <ScreenCard key={s.id} screen={s} open={i === 0} questions={panelQuestions(a.packetLabels)} mustHaves={a.packetLabels.mustHaves} timeline={a.timeline} action={i === 0 ? <StopScreen a={a} roleId={roleId} /> : undefined} />)}
      {notesCard}
      <ScorecardUnavailableCard detail={a} roleId={roleId} />
      {scorecards.slice(a.assessments[0]?.kind === "screen" ? 1 : 0).map((s) => <AssessmentCard key={s.id} assessment={s} detail={a} roleId={roleId} labels={a.packetLabels} />)}
      {a.assessments[0]?.kind === "screen" ? <p className="small muted">The latest AI review of this chat is on the Overview, under Full breakdown.</p> : null}
    </div>
  );
}

/** The four guided questions of the apply form (plan D10), in the order the form asks them, with the panel's labels. */
const GUIDED_ANSWERS: ReadonlyArray<[key: string, label: string]> = [["recentWork", "Most recent work"], ["dayToDay", "Day to day"], ["skills", "Skills, licenses or tools"], ["lookingFor", "Looking for"]];

/**
 * What someone without a résumé told us: each guided answer on its own labelled line; an application from the older
 * one-box form (or by email) shows its summary as before.
 */
export function NoResumeAnswers({ answers }: { answers: Record<string, string> }) {
  const lines = GUIDED_ANSWERS.filter(([key]) => answers[key]?.trim());
  if (!lines.length) return <p className="small whitespace-pre-wrap">{answers.summary}</p>;
  return (
    <dl className="kv small">
      {lines.map(([key, label]) => <Fragment key={key}><dt>{label}</dt><dd className="whitespace-pre-wrap">{answers[key]}</dd></Fragment>)}
    </dl>
  );
}

/** The résumé viewer's frame: the file in a rounded box on the card's surface, as tall as the screen allows. */
const VIEWER = "grid gap-2 [&>iframe]:w-full [&>iframe]:rounded-2xl [&>iframe]:border [&>iframe]:border-line [&>iframe]:bg-surface";

/**
 * The résumé inside the panel (plan H5): the file in a frame of this site's own address (each opening is recorded, as
 * the file's is), full screen on a click, or in a new tab. Mounted only while the Résumé tab is open. A Word file shows
 * the words it was read as; a file nothing could be read from opens in a new tab only.
 */
function ResumeViewer({ a, doc }: { a: ApplicationDetail; doc: ApplicationDetail["documents"][number] }) {
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const v = resumeView(a.id, doc);
  const focusables = useCallback(() => [...(box.current?.querySelectorAll<HTMLElement>("button, a[href], iframe") ?? [])], []);
  // Full screen is a dialog: focus moves into it and stays there, Escape leaves it first (before it would close the
  // panel), and focus goes back to where it was.
  useEffect(() => {
    if (!full) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFull(false);
        return;
      }
      const items = focusables();
      if (e.key !== "Tab" || !items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, [full, focusables]);
  if (!v.frame) return null;
  return (
    // full screen: the whole window over the panel (its layer, under the toasts), the frame filling what the bar leaves
    <div ref={box} className={full ? `${VIEWER} fixed inset-0 z-[70] grid-rows-[auto_minmax(0,1fr)] bg-ground px-4 pt-3 pb-4 [&>iframe]:h-full` : `${VIEWER} [&>iframe]:h-[min(70vh,760px)]`} {...(full ? { role: "dialog", "aria-modal": true, "aria-label": `Résumé: ${doc.filename}` } : {})}>
      <div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
        <span className="min-w-0 text-sm font-semibold wrap-anywhere">{doc.filename}{v.asText ? <span className="muted font-normal"> (the words we read from it)</span> : null}</span>
        <span className="row gap-1.5">
          <Button size="sm" icon={full ? "shrink" : "expand"} onClick={() => setFull(!full)}>{full ? "Exit full screen" : "Full screen"}</Button>
          <a href={v.open} target="_blank" rel="noopener noreferrer" className="btn secondary sm">Open in a new tab</a>
        </span>
      </div>
      <iframe src={v.frame} title={`Résumé: ${doc.filename}`} className="resume-frame" referrerPolicy="same-origin" />
      {full ? (
        // biome-ignore lint/a11y: a focus guard: Tab out of the framed file lands here and goes back to the top, so focus stays in the full-screen résumé (key presses inside the frame never reach this page)
        <span tabIndex={0} onFocus={() => focusables()[0]?.focus()} />
      ) : null}
    </div>
  );
}

/** Résumé: the file itself (plan H5), what the résumé says, the files (each opening is recorded), and any earlier AI reviews. */
export function ResumeTab({ a, roleId }: { a: ApplicationDetail; roleId: string }) {
  const readings = a.assessments.filter((x) => x.kind === "triage" && x.id !== a.assessments[0]?.id);
  const shown = resumeToShow(a.documents, a.resumeDocumentId);
  return (
    <div className="stack gap-4">
      {shown ? <ResumeViewer a={a} doc={shown} /> : null}
      <Card title="What the résumé says" className={CARD}>
        {a.extraction ? (
          <div className="stack gap-3">
            {a.extraction.positions.map((p, i) => <div key={i} className="small grid gap-1.5"><span><strong>{p.title}</strong>{p.employer ? ` at ${p.employer}` : ""}{p.startDate ? ` · ${p.startDate}–${p.endDate ?? "present"}` : ""}</span>{p.quote ? <span className={QUOTE}>"{p.quote}" <EvidenceChip source="resume" /></span> : null}</div>)}
            {a.extraction.licenses.length ? <div className="row">{a.extraction.licenses.map((l, i) => <Chip key={i} tone="good">{l.name}{l.jurisdiction ? ` (${l.jurisdiction})` : ""}</Chip>)}</div> : null}
            {a.extraction.skills.length ? <p className="small muted">Skills mentioned: {a.extraction.skills.join(", ")}</p> : null}
            {a.extraction.anomalies.length ? <Alert tone="caution">{a.extraction.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")}. Flagged for a person to look at; never used to decline.</Alert> : null}
          </div>
        ) : a.answers.noResume?.summary ? <NoResumeAnswers answers={a.answers.noResume} /> : <p className="muted small">No résumé text available{a.documents.some((d) => d.status === "clean") ? " (the file could not be read; open it below)" : ""}.</p>}
        {a.documents.length ? (
          <ul className="small grid list-disc gap-1 pl-5 marker:text-ink-3">
            {a.documents.map((d) => (
              <li key={d.id}>
                {d.status === "clean" ? (
                  <><a href={`/api/v1/applications/${a.id}/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer">Open {d.filename}</a> <span className="muted">({Math.max(1, Math.round(d.sizeBytes / 1024))} KB; this open is recorded)</span></>
                ) : d.status === "quarantined" ? (
                  <span className="muted">{d.filename}: being checked and scanned before anyone can open it.</span>
                ) : d.status === "rejected" ? (
                  <span className="muted">{d.filename}: refused ({(d.rejectedReason ?? "unknown").replace(/_/g, " ")}) and removed. The candidate can send another.</span>
                ) : (
                  <span className="muted">{d.filename}: removed.</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {readings.map((r) => <AssessmentCard key={r.id} assessment={r} detail={a} roleId={roleId} labels={a.packetLabels} title="Earlier AI review of the résumé" />)}
    </div>
  );
}

/** The assistant's suggested line the person kept (Q28): the line itself, and the run it came from, for the record. */
type KeptSuggestion = { line: string; runId: string | null };

/**
 * The conversation as chat bubbles (screenshot 3, the coss look): the team, the assistant and an ITS recruiter on the
 * left on the surface with a hairline, the candidate's own words on the right in peach; each message rises in once,
 * the first few one after another. The items' classes are pinned (`msg-item <from>`), so the list styles them.
 */
const THREAD = [
  "flex flex-col gap-3",
  "[&>li]:grid [&>li]:max-w-[88%] [&>li]:gap-1 [&>li]:self-start [&>li]:rounded-2xl [&>li]:rounded-bl-md [&>li]:border [&>li]:border-line [&>li]:bg-surface [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere [&>li]:shadow-xs [&>li]:motion-safe:animate-enter [&>li]:motion-safe:[animation-fill-mode:backwards] max-sm:[&>li]:max-w-[96%]",
  "[&>.candidate]:self-end [&>.candidate]:rounded-bl-2xl [&>.candidate]:rounded-br-md [&>.candidate]:border-accent/20 [&>.candidate]:bg-peach",
  "[&>.recruiter]:border-dashed [&>.recruiter]:border-line-strong [&>.recruiter]:bg-tint [&>.system]:bg-surface-2 [&>.system]:shadow-none",
  "[&_.msg-body]:text-sm [&_.msg-body]:whitespace-pre-wrap [&_.msg-body]:text-ink",
].join(" ");

/**
 * Messages (plan G7): the conversation with the candidate, oldest first, as a thread (what the team sent and who sent it,
 * what went by itself, an ITS recruiter's answers, and the candidate's replies in their own words), then writing to them
 * (F11: the person's own words, under the hiring team's name with theirs in the footer). The assistant can suggest an
 * opening line (Q28); kept, the footer says the assistant helped. Send waits out the Undo window (plan G9).
 */
export function MessagesTab({ a, roleId, compose, setCompose }: { a: ApplicationDetail; roleId: string; compose: Compose; setCompose: (next: Compose) => void }) {
  const refresh = useRefreshCandidate(a.id, roleId);
  const undoToast = useUndoToast();
  const takeBack = useTakeBack();
  // The message just sent, while it waits out its Undo window: Undo is offered here as well as on the toast.
  const [lastSent, setLastSent] = useState<{ communicationId: string; undoUntil: string } | null>(null);
  const { open, subject, text } = compose;
  const setOpen = (v: boolean) => setCompose({ ...compose, open: v });
  const preview = useQuery({ queryKey: ["message-preview", a.id], queryFn: () => api.get<MessagePreview>(`/api/v1/applications/${a.id}/messages/preview`), enabled: open });
  const [kept, setKept] = useState<KeptSuggestion | null>(null);
  // Once "Use this line" was pressed the assistant helped, however the line was changed afterwards (Q28; product thesis:
  // every candidate touch is disclosed). It stops only when the person takes the line out or empties the message.
  const aiHelped = !!kept;
  const lineStillWhole = !!kept && text.includes(kept.line);
  const takeOutLine = () => {
    if (kept && lineStillWhole) setCompose({ ...compose, text: text.replace(kept.line, "").replace(/^\s+/, "") });
    setKept(null);
  };
  const suggest = useMutation({
    mutationFn: () => api.post<SuggestedLine>(`/api/v1/applications/${a.id}/messages/suggest`, { purpose: "update" }),
    onError: (e) => toast(e instanceof ApiError ? e.message : "The assistant could not suggest a line just now."),
  });
  const send = useMutation({
    mutationFn: () => api.post<SendMessageResult>(`/api/v1/applications/${a.id}/messages`, { subject: subject.trim() || undefined, text, ...(kept ? { aiHelped: true, suggestionRunId: kept.runId ?? undefined } : {}) }),
    onSuccess: async (r) => {
      if (r.status === "queued") {
        const seconds = Math.round(undoMillisLeft(r.undoUntil) / 1000);
        const t = sentWithUndoToast({ firstName: a.candidate.firstName, seconds, kind: "message" });
        undoToast({ applicationId: a.id, roleId, communicationId: r.communicationId, undoUntil: r.undoUntil, firstName: a.candidate.firstName, kind: "message", title: t.title, detail: t.detail ?? "", plain: { title: `Sent to ${a.candidate.firstName}.`, detail: "It is on its way." } });
        if (r.communicationId && r.undoUntil && undoMillisLeft(r.undoUntil) > 0) setLastSent({ communicationId: r.communicationId, undoUntil: r.undoUntil });
      } else if (r.status === "held") toast("Saved.", "It goes out as soon as ITS confirms your company.");
      else toast("Saved for approval.", "An owner or admin reads it before it goes out; you will be told.");
      setCompose({ open: false, subject: "", text: "" });
      setKept(null);
      suggest.reset();
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the message."),
  });
  const first = a.candidate.firstName;
  const thread = threadItems(a.communications, first);
  const suggestion = suggest.data;
  const keepSuggestion = (line: string) => {
    setCompose({ ...compose, text: text.trim() ? `${line}\n\n${text}` : `${line}\n\n` });
    setKept({ line, runId: suggestion?.suggestionRunId ?? null });
  };
  return (
    <div className="stack gap-4">
      <Card title="Conversation" aside={thread.length ? <span className="small muted">Oldest first</span> : null} className={CARD}>
        {thread.length ? (
          <ol className={THREAD} aria-label={`Messages with ${first}`}>
            {thread.map((m, i) => (
              // the first eight rise in one after another (30ms apart); the rest with the eighth
              <li key={m.id} className={`msg-item ${m.from}`} style={{ animationDelay: `${Math.min(i, 7) * 30}ms` }}>
                <p className="text-[12.5px] text-ink-3 [&>strong]:font-semibold [&>strong]:text-ink-2">
                  <strong>{m.who}</strong>{m.channel === "sms" ? " (text message)" : ""}<span aria-hidden="true"> · </span><span className="sr-only">, </span><time dateTime={new Date(m.at).toISOString()}>{threadWhen(m.at)}</time>
                  {m.status ? <> <Chip tone={m.statusTone}>{m.status}</Chip></> : null}
                </p>
                <p className="text-[13.5px] font-semibold text-ink">{m.subject ?? m.label}</p>
                {m.long ? (
                  // the opening words read as a "read more" line: "Show all" says what opens, so no disclosure triangle
                  <details className="[&>summary]:cursor-pointer [&>summary]:list-none [&>summary::-webkit-details-marker]:hidden [&>summary]:text-[13.5px] [&>summary]:text-ink-2 [&[open]>summary]:mb-1.5">
                    <summary>{m.text.slice(0, 160).trimEnd()}… <span className="link-like">Show all</span></summary>
                    <MessageBody parts={m.parts} />
                  </details>
                ) : <MessageBody parts={m.parts} />}
                {m.hiddenLinks ? <p className="small muted msg-hidden-note">{HIDDEN_LINK_NOTE}</p> : null}
              </li>
            ))}
          </ol>
        ) : <p className="muted small">No messages yet.</p>}
      </Card>
      <Card title={`Write to ${first}`} className={CARD}>
        {!open ? (
          <div className="row">
            <Button size="sm" icon="mail" disabled={!a.candidate.email} title={a.candidate.email ? "Your own words, sent under the hiring team's name with yours in the footer" : "No email address on file"} onClick={() => setOpen(true)}>Write to {first}</Button>
            {lastSent ? <InlineUndo autoFocus undoUntil={lastSent.undoUntil} ariaLabel={`Undo your message to ${first}`} onUndo={async () => { await takeBack({ applicationId: a.id, roleId, communicationId: lastSent.communicationId, firstName: first, kind: "message" }); setLastSent(null); }} /> : null}
            {!a.candidate.email ? <span className="small muted">No email address on file.</span> : null}
          </div>
        ) : (
          <div className="stack gap-3">
            <p className="small muted">To {preview.data?.to ?? a.candidate.email}, from {preview.data?.fromName ?? "the hiring team"}.{preview.data?.needsApproval ? " An owner or admin reads it before it goes out." : ""}</p>
            <Why label="How sending works">Your own words, sent as {preview.data?.fromName ?? "the hiring team"} to {preview.data?.to ?? a.candidate.email}. {preview.data ? (preview.data.repliesComeBack ? "Replies come back to this panel." : "Replies reach the ITS mailbox, where a person reads them.") : ""}{preview.data?.needsApproval ? " An owner or admin reads your message before it goes out." : ""}{preview.data?.undoSeconds ? ` After Send you have ${preview.data.undoSeconds} seconds to undo it.` : ""}</Why>
            <Field label="Subject (optional)" htmlFor="msg-subject"><input id="msg-subject" className="input" value={subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} maxLength={200} /></Field>
            <Field label="Message" htmlFor="msg-text"><textarea id="msg-text" className="input" rows={6} value={text} onChange={(e) => { setCompose({ ...compose, text: e.target.value }); if (!e.target.value.trim()) setKept(null); }} maxLength={5000} placeholder={`Hi ${first},`} /></Field>
            {suggestion?.line && !kept ? (
              <div className="grid gap-2 rounded-xl border border-line-tint bg-tint px-4 py-3">
                <p className="small"><q>{suggestion.line}</q></p>
                <p className="small muted">{suggestion.note}</p>
                <div className="row"><Button size="sm" onClick={() => keepSuggestion(suggestion.line!)}>Use this line</Button><Button size="sm" variant="quiet" onClick={() => suggest.reset()}>No thanks</Button></div>
              </div>
            ) : suggestion && !suggestion.line ? <p className="small muted">{suggestion.note}</p> : null}
            {preview.data ? <div className="small muted whitespace-pre-wrap border-t border-line pt-3">{aiHelped && preview.data.aiFooter ? preview.data.aiFooter : preview.data.footer}</div> : null}
            <div className="row">
              <Button size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>{preview.data?.needsApproval ? "Send for approval" : "Send"}</Button>
              {!kept ? <Button size="sm" variant="secondary" icon="sparkle" loading={suggest.isPending} onClick={() => suggest.mutate()} title="The assistant suggests one opening line; if you keep it, the email says the assistant helped">Suggest an opening line</Button> : null}
              <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
            {aiHelped ? (
              <div className="row gap-2">
                <p className="small muted">{suggestedLineNote(lineStillWhole, "footer")}</p>
                {lineStillWhole ? <Button size="sm" variant="quiet" onClick={takeOutLine}>Take out the assistant's line</Button> : null}
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * A message's words, with a link only the candidate can use (hidden by the API as `/c/<kind>/[link]`) shown as muted
 * words, never a link to open (22 Oct 2026 try-out); the line under the message says why (`HIDDEN_LINK_NOTE`).
 */
function MessageBody({ parts }: { parts: ThreadPart[] }) {
  return (
    <p className="msg-body">
      {parts.map((p, i) => (p.hiddenLink ? <span key={i} className="muted" title={HIDDEN_LINK_NOTE}>{p.text}</span> : <Fragment key={i}>{p.text}</Fragment>))}
    </p>
  );
}

type EventRow = TimelineEvent & { subjectType?: string; subjectId?: string };

/**
 * History: who did what (a person by name, the assistant, or "suggested by the assistant, approved by …"), the reasons
 * and notes, what the candidate was told, and recruiter help, which is recorded on the request rather than the
 * application and read with a second query.
 */
export function HistoryTab({ a, mayReadActivity }: { a: ApplicationDetail; mayReadActivity: boolean }) {
  const recruiter = useQuery({ queryKey: ["events", "escalation"], queryFn: () => api.get<EventRow[]>("/api/v1/events?subjectType=escalation"), enabled: mayReadActivity });
  const items = historyItems(a.timeline, recruiterEventsFor(a.id, recruiter.data ?? []));
  const both = suggestionAndDecision(a.timeline);
  return (
    <div className="stack gap-4">
      {both.suggested ? (
        <Card className={CARD}>
          <p className="small">
            The assistant suggested <strong>{both.suggested}</strong>.{" "}
            {both.decided ? <>{both.decidedBy === "A team member" ? "Your team" : both.decidedBy} decided <strong>{both.decided}</strong>.</> : "Nobody has decided yet."}
          </p>
          <Why label="Who decides?">People make the hiring decisions. The assistant reads applications and suggests next steps, and it invites every applicant to its AI interview on its own.</Why>
        </Card>
      ) : null}
      <Card title="What happened" className={CARD}>
        {recruiter.isLoading ? <Skeleton lines={2} /> : null}
        {items.length ? <HistoryList items={items} /> : <p className="small muted">Nothing yet.</p>}
      </Card>
    </div>
  );
}

/** Everything that happened, newest first: divided rows with the time in a muted column (on a phone, above the words). */
function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ul className="grid">
      {items.map((it) => (
        <li key={it.key} className="grid gap-x-3 gap-y-0.5 border-t border-line py-3 text-[13.5px] first:border-t-0 first:pt-0 last:pb-0 sm:grid-cols-[112px_minmax(0,1fr)]">
          <span className="text-[12.5px] text-ink-3 tabular-nums">{new Date(it.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span className="grid min-w-0 gap-0.5 wrap-anywhere">
            <span className="text-ink">{it.what}</span>
            <span className="text-[12.5px] text-ink-3">{it.who}</span>
            {it.why ? <span className="text-[13px] text-ink-2">{it.why}</span> : null}
            {it.told ? <span className="text-[12.5px] text-ink-3">{it.told}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
