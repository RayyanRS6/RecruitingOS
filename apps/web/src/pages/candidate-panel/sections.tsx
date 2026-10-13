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
import { LOW_CONFIDENCE_LABEL, LOW_CONFIDENCE_TEXT, closerLook, openScreenOf } from "../../evidence";
import { offerMadeOn, plainDayWords } from "../../hiring";
import { callNotesState, overviewScreenLine } from "../../screen-view";
import { holdDay } from "../../talent-actions";
import { sentWithUndoToast, suggestedLineNote, threadItems, threadWhen, undoMillisLeft } from "../../telling";
import { AssessmentCard, NoAssessmentCard, ScorecardUnavailableCard, ScreenCard } from "./assessment";
import { CallNotesCard } from "./call-notes";
import { MatchCard } from "./match";
import { eligibilityAnswerWords, historyItems, notReadYetWords, recruiterEventsFor, resumeToShow, resumeView, suggestionAndDecision, type Compose, type HistoryItem } from "./helpers";

export type { Compose } from "./helpers";
import { useCandidateAction, useRefreshCandidate } from "./hooks";

/** The candidate panel's sections (plan A10): Overview, Screen, Résumé, Messages and History; the Notes tab is notes.tsx. */

/**
 * Overview: where they are, the match score against your must-haves with its breakdown (founder decision B2), the
 * latest reading (the screen's scorecard once there is one), the eligibility answers and the last three things that
 * happened. The rest of the evidence is one tab away.
 */
export function OverviewTab({ a, roleId, onHistory }: { a: ApplicationDetail; roleId: string; onHistory: () => void }) {
  const latest = a.assessments[0] ?? null;
  const look = closerLook(a);
  const recent = historyItems(a.timeline).slice(0, 3);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <WhereTheyAre a={a} />
      {look.lowConfidence && !look.needsCloserLook ? <Alert tone="caution"><strong>{LOW_CONFIDENCE_LABEL}.</strong> {LOW_CONFIDENCE_TEXT}</Alert> : null}
      <MatchCard a={a} />
      <ScorecardUnavailableCard detail={a} roleId={roleId} />
      {latest ? <AssessmentCard assessment={latest} detail={a} roleId={roleId} labels={a.packetLabels} title={latest.kind === "screen" ? "Latest reading: the screen" : "Latest reading: the résumé"} /> : look.assessmentUnavailable ? <NoAssessmentCard detail={a} /> : <Card title="Latest reading"><p className="small muted">{notReadYetWords(a.stage)}</p></Card>}
      <EligibilityAnswers a={a} />
      <Card title="Recent activity" aside={<Button size="sm" variant="quiet" onClick={onHistory}>All history</Button>}>
        {recent.length ? <HistoryList items={recent} /> : <p className="small muted">Nothing yet.</p>}
      </Card>
      <ContactCard a={a} />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">Want a second opinion on {a.candidate.firstName}?</span>
        <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
      </div>
    </div>
  );
}

/**
 * One line on where things stand: the mark and its note, a hold's date, interviews, a recorded outcome, whether a
 * decision was told, and the screening conversation when it says something ("Applied and talked in one visit", still
 * applying, sent without it, asked for a person; plan Wave E).
 */
function WhereTheyAre({ a }: { a: ApplicationDetail }) {
  const outcomes = useQuery({ queryKey: ["outcomes", a.id], queryFn: () => api.get<{ statement: string; outcomes: OutcomeRecord[] }>(`/api/v1/applications/${a.id}/outcomes`), enabled: ["hired", "withdrawn", "rejected", "talent_pool", "declined"].includes(a.stage) });
  const recorded = outcomes.data?.outcomes.find((o) => !o.correctedAt);
  const lines: string[] = [];
  const screenLine = overviewScreenLine(a);
  if (screenLine) lines.push(screenLine);
  if (a.mark) lines.push(`${a.mark.mark === "on_hold" && a.mark.remindAt ? `On hold until ${holdDay(a.mark.remindAt)}` : a.mark.label}${a.mark.setBy.name ? `, set by ${a.mark.setBy.name}` : ""}${a.mark.note ? `: "${a.mark.note}"` : ""}. Private.`);
  if (a.toldState === "sent") lines.push(`Told the decision by message${a.candidateToldAt ? ` on ${new Date(a.candidateToldAt).toLocaleDateString()}` : ""}.`);
  if (a.toldState === "told_in_person") lines.push(`Told the decision in person${a.candidateToldAt ? ` (recorded ${new Date(a.candidateToldAt).toLocaleDateString()})` : ""}.`);
  if (a.toldState === "before_tracking") lines.push("Decided before decisions became private: their status page already showed it, so nothing more is sent.");
  // An offer made outside the app (plan H2): the next move is the candidate's.
  if (a.stage === "offer_sent") lines.push(`Offer made on ${plainDayWords(offerMadeOn(a))}, outside the app: waiting on their answer.`);
  const interviews = a.interviews;
  if (!lines.length && !interviews.length && !recorded) return null;
  return (
    <Card title="Where things stand">
      {lines.map((l) => <p key={l} className="small" style={{ margin: "0 0 4px" }}>{l}</p>)}
      {interviews.map((i) => <p key={i.id} className="small" style={{ margin: "0 0 4px" }}><Link to={`/interviews/${i.id}`}>{i.title}</Link> · {i.status.replace(/_/g, " ")}{i.startsAt ? ` · ${new Date(i.startsAt).toLocaleString("en-US", { timeZone: i.timezone ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : i.status === "scheduling" ? ` · ${i.offeredSlots.length} times offered` : ""}{i.decision ? ` · decision: ${i.decision.replace(/_/g, " ")}` : ""}</p>)}
      {recorded ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
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
    <Card title="Eligibility answers">
      {a.eligibility ? (
        <div className="small">
          <p>{a.eligibility.passed ? "Met every required answer." : "Did not meet a required answer."}</p>
          {a.eligibility.failedRules.map((f) => <p key={f.key} style={{ color: "var(--needs-you)" }}>{f.question} → {eligibilityAnswerWords(f)}</p>)}
          {a.eligibility.unverifiable.map((u) => <p key={u.key} className="muted">{u.question}: not answered</p>)}
        </div>
      ) : <p className="muted small">Not checked yet.</p>}
    </Card>
  );
}

function ContactCard({ a }: { a: ApplicationDetail }) {
  return (
    <Card title="Contact and consent">
      <dl className="kv">
        <dt>Email</dt><dd>{a.candidate.email ?? "none"}</dd>
        <dt>Phone</dt><dd>{a.candidate.phone ?? "none"}</dd>
        <dt>Location</dt><dd>{a.candidate.locationText ?? "not given"}</dd>
        <dt>Text messages</dt><dd>{a.candidate.consent.sms?.granted ? `Consented (${a.candidate.consent.sms.source})` : "No consent; email only"}</dd>
        <dt>AI notice</dt><dd>{a.candidate.consent.ai_notice ? `Shown ${new Date(a.candidate.consent.ai_notice.at).toLocaleDateString()}` : "not recorded"}</dd>
        <dt>Applied through</dt><dd>{a.source.replace(/_/g, " ")}</dd>
        {a.candidate.preferences?.talentPoolOptOut ? <><dt>Future roles</dt><dd>Asked not to be kept for future roles; nobody contacts them about other openings</dd></> : null}
      </dl>
    </Card>
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
      <div className="row" style={{ marginTop: 8 }}>
        <Button size="sm" disabled={!allowed} title={allowed ? "Calls off the invitation before they start" : a.blockedReasons.cancel_screen} onClick={() => setConfirming(true)}>Stop this screen</Button>
        {!allowed && a.blockedReasons.cancel_screen ? <span className="small muted">{a.blockedReasons.cancel_screen}</span> : null}
      </div>
    );
  }
  return (
    <Alert tone="caution">
      <div className="stack" style={{ gap: 8 }}>
        <span>Stop the screening invitation for {a.candidate.firstName}? Their link stops working, and they get a short, polite note saying the screen is no longer needed. It does not decide anything about them.</span>
        <div className="row"><Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: "cancel_screen" })}>Yes, stop it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>Keep it open</Button></div>
      </div>
    </Alert>
  );
}

/**
 * Screen: every screening conversation, newest first, with its transcript open, and the scorecards. A recruiter can add
 * notes from a call here (plan E3); when the candidate asked for a person, that form waits at the top of the panel instead.
 */
export function ScreenTab({ a, roleId, myRole = null }: { a: ApplicationDetail; roleId: string; myRole?: string | null }) {
  const scorecards = a.assessments.filter((x) => x.kind === "screen");
  const notes = callNotesState(a, myRole);
  const notesCard = notes.show && !notes.prominent ? <CallNotesCard a={a} roleId={roleId} prominent={false} /> : null;
  if (!a.screens.length) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <Card title="Screening conversation"><p className="small muted">{a.candidate.firstName} has not been invited to a screen yet. A screen is a short conversation, by web or text, with the questions you approved for this role.</p></Card>
        {notesCard}
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      {a.screens.map((s, i) => <ScreenCard key={s.id} screen={s} open={i === 0} questions={a.packetLabels.questions} timeline={a.timeline} action={i === 0 ? <StopScreen a={a} roleId={roleId} /> : undefined} />)}
      {notesCard}
      <ScorecardUnavailableCard detail={a} roleId={roleId} />
      {scorecards.slice(a.assessments[0]?.kind === "screen" ? 1 : 0).map((s) => <AssessmentCard key={s.id} assessment={s} detail={a} roleId={roleId} labels={a.packetLabels} />)}
      {a.assessments[0]?.kind === "screen" ? <p className="small muted">The latest scorecard is on the Overview.</p> : null}
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
  if (!lines.length) return <p className="small" style={{ whiteSpace: "pre-wrap" }}>{answers.summary}</p>;
  return (
    <dl className="kv small">
      {lines.map(([key, label]) => <Fragment key={key}><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{answers[key]}</dd></Fragment>)}
    </dl>
  );
}

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
    <div ref={box} className={full ? "resume-viewer full" : "resume-viewer"} {...(full ? { role: "dialog", "aria-modal": true, "aria-label": `Résumé: ${doc.filename}` } : {})}>
      <div className="resume-viewer-bar">
        <span className="resume-viewer-name">{doc.filename}{v.asText ? <span className="muted"> (the words we read from it)</span> : null}</span>
        <span className="row" style={{ gap: 6 }}>
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

/** Résumé: the file itself (plan H5), what the résumé says, the files (each opening is recorded), and any earlier readings. */
export function ResumeTab({ a, roleId }: { a: ApplicationDetail; roleId: string }) {
  const readings = a.assessments.filter((x) => x.kind === "triage" && x.id !== a.assessments[0]?.id);
  const shown = resumeToShow(a.documents, a.resumeDocumentId);
  return (
    <div className="stack" style={{ gap: 14 }}>
      {shown ? <ResumeViewer a={a} doc={shown} /> : null}
      <Card title="What the résumé says">
        {a.extraction ? (
          <div className="stack" style={{ gap: 8 }}>
            {a.extraction.positions.map((p, i) => <div key={i} className="small"><strong>{p.title}</strong>{p.employer ? ` at ${p.employer}` : ""}{p.startDate ? ` · ${p.startDate}–${p.endDate ?? "present"}` : ""}{p.quote ? <><br /><span className="muted">"{p.quote}"</span> <EvidenceChip source="resume" /></> : null}</div>)}
            {a.extraction.licenses.length ? <div className="row">{a.extraction.licenses.map((l, i) => <Chip key={i} tone="good">{l.name}{l.jurisdiction ? ` (${l.jurisdiction})` : ""}</Chip>)}</div> : null}
            {a.extraction.skills.length ? <p className="small muted">Skills mentioned: {a.extraction.skills.join(", ")}</p> : null}
            {a.extraction.anomalies.length ? <Alert tone="caution">{a.extraction.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")}. Flagged for a person to look at; never used to decline.</Alert> : null}
          </div>
        ) : a.answers.noResume?.summary ? <NoResumeAnswers answers={a.answers.noResume} /> : <p className="muted small">No résumé text available{a.documents.some((d) => d.status === "clean") ? " (the file could not be read; open it below)" : ""}.</p>}
        {a.documents.length ? (
          <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
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
      {readings.map((r) => <AssessmentCard key={r.id} assessment={r} detail={a} roleId={roleId} labels={a.packetLabels} title="Résumé assessment" />)}
    </div>
  );
}

/** The assistant's suggested line the person kept (Q28): the line itself, and the run it came from, for the record. */
type KeptSuggestion = { line: string; runId: string | null };

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
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Conversation" aside={thread.length ? <span className="small muted">Oldest first</span> : null}>
        {thread.length ? (
          <ol className="msg-thread" aria-label={`Messages with ${first}`}>
            {thread.map((m) => (
              <li key={m.id} className={`msg-item ${m.from}`}>
                <p className="msg-head">
                  <strong>{m.who}</strong>{m.channel === "sms" ? " (text message)" : ""}<span aria-hidden="true"> · </span><span className="sr-only">, </span><time dateTime={new Date(m.at).toISOString()}>{threadWhen(m.at)}</time>
                  {m.status ? <> <Chip tone={m.statusTone}>{m.status}</Chip></> : null}
                </p>
                <p className="msg-subject">{m.subject ?? m.label}</p>
                {m.long ? (
                  <details className="msg-more">
                    <summary>{m.text.slice(0, 160).trimEnd()}… <span className="link-like">Show all</span></summary>
                    <p className="msg-body">{m.text}</p>
                  </details>
                ) : <p className="msg-body">{m.text}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="muted small">No messages yet.</p>}
      </Card>
      <Card title={`Write to ${first}`}>
        {!open ? (
          <div className="row">
            <Button size="sm" icon="mail" disabled={!a.candidate.email} title={a.candidate.email ? "Your own words, sent under the hiring team's name with yours in the footer" : "No email address on file"} onClick={() => setOpen(true)}>Write to {first}</Button>
            {lastSent ? <InlineUndo autoFocus undoUntil={lastSent.undoUntil} ariaLabel={`Undo your message to ${first}`} onUndo={async () => { await takeBack({ applicationId: a.id, roleId, communicationId: lastSent.communicationId, firstName: first, kind: "message" }); setLastSent(null); }} /> : null}
            {!a.candidate.email ? <span className="small muted">No email address on file.</span> : null}
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p className="small muted" style={{ margin: 0 }}>Your own words, sent as {preview.data?.fromName ?? "the hiring team"} to {preview.data?.to ?? a.candidate.email}. {preview.data ? (preview.data.repliesComeBack ? "Replies come back to this panel." : "Replies reach the ITS mailbox, where a person reads them.") : ""}{preview.data?.needsApproval ? " An owner or admin reads your message before it goes out." : ""}{preview.data?.undoSeconds ? ` After Send you have ${preview.data.undoSeconds} seconds to undo it.` : ""}</p>
            <Field label="Subject (optional)" htmlFor="msg-subject"><input id="msg-subject" className="input" value={subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} maxLength={200} /></Field>
            <Field label="Message" htmlFor="msg-text"><textarea id="msg-text" className="input" rows={6} value={text} onChange={(e) => { setCompose({ ...compose, text: e.target.value }); if (!e.target.value.trim()) setKept(null); }} maxLength={5000} placeholder={`Hi ${first},`} /></Field>
            {suggestion?.line && !kept ? (
              <div className="suggested-line">
                <p className="small" style={{ margin: 0 }}><q>{suggestion.line}</q></p>
                <p className="small muted" style={{ margin: "4px 0 0" }}>{suggestion.note}</p>
                <div className="row" style={{ marginTop: 6 }}><Button size="sm" onClick={() => keepSuggestion(suggestion.line!)}>Use this line</Button><Button size="sm" variant="quiet" onClick={() => suggest.reset()}>No thanks</Button></div>
              </div>
            ) : suggestion && !suggestion.line ? <p className="small muted" style={{ margin: 0 }}>{suggestion.note}</p> : null}
            {preview.data ? <div className="small muted" style={{ whiteSpace: "pre-wrap", borderTop: "1px solid var(--line)", paddingTop: 8 }}>{aiHelped && preview.data.aiFooter ? preview.data.aiFooter : preview.data.footer}</div> : null}
            <div className="row">
              <Button size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>{preview.data?.needsApproval ? "Send for approval" : "Send"}</Button>
              {!kept ? <Button size="sm" variant="secondary" icon="sparkle" loading={suggest.isPending} onClick={() => suggest.mutate()} title="The assistant suggests one opening line; if you keep it, the email says the assistant helped">Suggest an opening line</Button> : null}
              <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
            {aiHelped ? (
              <div className="row" style={{ gap: 8 }}>
                <p className="small muted" style={{ margin: 0 }}>{suggestedLineNote(lineStillWhole, "footer")}</p>
                {lineStillWhole ? <Button size="sm" variant="quiet" onClick={takeOutLine}>Take out the assistant's line</Button> : null}
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
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
    <div className="stack" style={{ gap: 14 }}>
      {both.suggested ? (
        <Card>
          <p className="small" style={{ margin: 0 }}>
            The assistant suggested <strong>{both.suggested}</strong>.{" "}
            {both.decided ? <>{both.decidedBy === "A team member" ? "Your team" : both.decidedBy} decided <strong>{both.decided}</strong>.</> : "Nobody has decided yet."}
            <span className="muted"> People make the hiring decisions. The assistant reads applications and suggests next steps, and under your settings it can invite people to its screening conversation on its own.</span>
          </p>
        </Card>
      ) : null}
      <Card title="What happened">
        {recruiter.isLoading ? <Skeleton lines={2} /> : null}
        {items.length ? <HistoryList items={items} /> : <p className="small muted">Nothing yet.</p>}
      </Card>
    </div>
  );
}

function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ul className="history">
      {items.map((it) => (
        <li key={it.key}>
          <span className="when">{new Date(it.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span>
            <span>{it.what}</span>
            <br />
            <span className="who">{it.who}</span>
            {it.why ? <><br /><span className="why">{it.why}</span></> : null}
            {it.told ? <><br /><span className="who">{it.told}</span></> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
