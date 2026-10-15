"use client";

import { type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, Dialog, EvidenceChip, Menu } from "@ros/ui";
import { api, ApiError, type ApplicationDetail, type AssessmentResult, type Me, type Screen } from "../../api/client";
import { ACCESS_LIMITS, accessWords } from "../../recruiter-access";
import { toast } from "../../toast";
import { AskRecruiter } from "../../components/AskRecruiter";
import { ASSESSMENT_UNAVAILABLE_TEXT, CLOSER_LOOK_LABEL, NO_QUOTE_LABEL, RESUME_UNREADABLE_TEXT, SCORECARD_UNAVAILABLE_TEXT, closerLook, competencyUnquoted, isUnquoted, openScreenOf, requirementUnquoted, resumeUnreadable, scorecardUnavailable, screenQuestionText } from "../../evidence";
import { APPLIED_IN_ONE_VISIT, DECLINED_WORDS, EDITED_WORDS, SCREEN_STATUS_LABEL, TAPPED_WORDS, answerLines, generalNotes, hiddenAnswersLine, isRecruiterNote, recruiterNoteLabel, screenOrigin, transcriptBubble, unansweredWords } from "../../screen-view";
import { actionToast } from "../../talent-actions";
import { ASSISTANT_NOTE_LABEL, REC_LABEL, chatGapLines, writeupLines, writeupSummary, type PanelQuestion, type WriteupLine } from "./helpers";
import { competencyChip, importanceTag, orderCompetencyFindings, orderRequirementFindings, requirementChip, skillLabels } from "./match-view";
import { Why } from "./why";

/**
 * The evidence on the candidate panel (plan A10): the assistant's readings with every claim's source and quote, the
 * screening conversation, and the cards that say when a reading could not be made. Nothing here decides anything.
 */

export function overallLabel(o: string): string {
  return { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" }[o] ?? o;
}

export const MET_TONE: Record<string, "good" | "accent" | "neutral" | "caution"> = { yes: "good", partially: "accent", no: "caution", unknown: "neutral", evidenced: "good", partially_evidenced: "accent", not_evidenced: "neutral", contradicted: "caution" };

type PacketLabels = ApplicationDetail["packetLabels"];

const FLAG_KINDS: Array<[string, string]> = [
  ["wrong_evidence", "Cited the wrong evidence"],
  ["hallucination", "Made something up"],
  ["policy_error", "Broke a rule we set"],
  ["bias_concern", "Bias concern"],
  ["poor_communication", "Poorly worded"],
  ["wrong_workflow_action", "Took the wrong next step"],
  ["false_negative", "Missed a good candidate"],
  ["false_positive", "Overrated this candidate"],
  ["missing_context", "Missed context we gave"],
];

/** Said before a team member's flag goes to ITS: what the recruiter will see, and for how long (Q31: say the real access). */
export const FLAG_SHARE = `This asks an ITS recruiter to check the AI review. Once they pick it up they see ${accessWords("application")}. ${ACCESS_LIMITS}`;

/**
 * One-click flag with the founder context's taxonomy (§23). It records; it never retrains anything on its own. A team
 * member's flag reaches an ITS recruiter as a check of this reading (plan F11), so choosing a kind asks first, saying
 * what the recruiter will see, and the toast says what the API did. An ITS recruiter's own flag is only recorded.
 */
function FlagAssessment({ applicationId, assessmentId }: { applicationId: string; assessmentId: string }) {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const staff = !!me.data?.staffAccess;
  const [kind, setKind] = useState("");
  const [done, setDone] = useState(false);
  const flag = useMutation({
    mutationFn: (k: string) => api.post<{ message?: string; review?: { escalationId: string; created: boolean } | null }>(`/api/v1/applications/${applicationId}/assessments/${assessmentId}/flag`, { kind: k }),
    onSuccess: (r) => { setDone(true); toast(r.message ?? "Flagged and recorded.", "Nothing changes for the candidate."); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not flag this."),
  });
  if (done) return <span className="small muted">Flagged, thank you.</span>;
  const label = FLAG_KINDS.find(([v]) => v === kind)?.[1] ?? "";
  // A menu, not a dropdown: the arrow keys only move through the kinds, and a kind is acted on with Enter or a click
  // (a dropdown acts on its first arrow press on Windows). The menu hands the focus back to its button before the
  // dialog opens, so closing the dialog lands there.
  const choose = (k: string) => { if (staff) flag.mutate(k); else setKind(k); };
  return (
    <span className="row" style={{ gap: 6 }}>
      <Menu label="Something wrong?" ariaLabel="Something wrong with this assessment?" heading="What looks wrong?" items={FLAG_KINDS.map(([id, l]) => ({ id, label: l }))} onSelect={choose} align="end" disabled={flag.isPending} />
      {kind && !staff ? (
        <Dialog
          open
          onClose={() => setKind("")}
          title="Ask an ITS recruiter to check this AI review?"
          sub={`You chose: ${label}.`}
          footer={<><Button variant="ghost" onClick={() => setKind("")} disabled={flag.isPending}>Cancel</Button><Button variant="primary" loading={flag.isPending} onClick={() => flag.mutate(kind)}>Send for a check</Button></>}
        >
          <p>{FLAG_SHARE}</p>
          <p className="small muted">Nothing changes for the candidate, and they are not told.</p>
        </Dialog>
      ) : null}
    </span>
  );
}

/**
 * "Ask about this in a screen" (docs/spec/21, P1): the one-click follow-up on a résumé assessment with open questions.
 * The API's `invite_screen` capability gates it (the route refuses `ask_in_screen` under the same rule); when a screen is
 * already open the button gives way to a sentence, since the invitation cannot be sent twice.
 */
function AskInScreen({ detail, roleId, unknowns }: { detail: ApplicationDetail; roleId: string; unknowns: number }) {
  const qc = useQueryClient();
  const ask = useMutation({
    mutationFn: () => api.post<{ next?: string }>(`/api/v1/applications/${detail.id}/actions`, { action: "ask_in_screen" }),
    onSuccess: async (r) => { const t = actionToast("ask_in_screen", r); toast(t.title, t.detail); await qc.invalidateQueries({ queryKey: ["application", detail.id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["brief"] }); await qc.invalidateQueries({ queryKey: ["notifications"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the invitation."),
  });
  if (!unknowns) return null;
  const open = openScreenOf(detail);
  if (open) return <p className="small muted" style={{ marginTop: 6 }}>{open.progress.focusQuestions?.length ? "A screening chat that starts with these questions is already open; the answers appear here once they finish it." : "A screening chat is already open; these questions are part of its follow-ups, so there is nothing more to send."}</p>;
  if (!detail.allowedActions.includes("invite_screen")) return null;
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <Button size="sm" variant="primary" loading={ask.isPending} onClick={() => ask.mutate()} title="Invites them to a short web chat that starts with these questions">Ask about this in a screening chat</Button>
      <span className="small muted">Sent by email; it starts with {unknowns === 1 ? "this question" : "these questions"}.</span>
    </div>
  );
}

/** While the assistant could not produce an assessment at all (its answer was unusable twice), the page says so instead of showing nothing. */
export function NoAssessmentCard({ detail }: { detail: ApplicationDetail }) {
  const look = closerLook(detail);
  if (!look.assessmentUnavailable) return null;
  return (
    <Card needsYou title="AI review of the résumé" className="assessment">
      <div className="row"><Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip></div>
      <p style={{ marginTop: 8 }}>{ASSESSMENT_UNAVAILABLE_TEXT}</p>
      {resumeUnreadable(detail) ? <p className="small" style={{ color: "var(--needs-you)", marginTop: 6 }}>{RESUME_UNREADABLE_TEXT}</p> : null}
      <Why>Nothing is hidden: the résumé, the answers and the messages are on this panel. The assistant's answer was not usable after two tries; ITS has the details.</Why>
    </Card>
  );
}

/** A claim about the candidate with nothing quoted from them: shown, never passed off as evidence (plan 0.9). */
function NoQuote() {
  return <span className="small muted" title="Nothing from the candidate's own words backs this up yet"> ({NO_QUOTE_LABEL})</span>;
}

/**
 * The screen is finished but its scorecard could not be written (plan 0.9): the run gave up after two unusable answers
 * and asked ITS to look. The panel says so, so a finished screen never sits there looking unread.
 */
export function ScorecardUnavailableCard({ detail, roleId }: { detail: ApplicationDetail; roleId: string }) {
  const state = scorecardUnavailable(detail);
  if (!state.unavailable) return null;
  return (
    <Card needsYou title="AI review of the screening chat" className="assessment">
      <div className="row"><Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip></div>
      <p style={{ marginTop: 8 }}>{SCORECARD_UNAVAILABLE_TEXT}</p>
      <div className="row" style={{ marginTop: 10 }}><AskRecruiter roleId={roleId} applicationId={detail.id} size="sm" /></div>
      <Why>Nothing is hidden: the whole chat is on the Screening chat tab. {state.recruiterAsked ? "An ITS recruiter has been asked to look into it." : "ITS has the details."}</Why>
    </Card>
  );
}

/** A claim's source the candidate wrote or said: its quote is "their words". */
const THEIR_SOURCES = new Set(["resume", "application", "candidate_statement", "screen", "interview"]);

type Point = AssessmentResult["strengths"][number];

/**
 * Strengths and concerns on the Overview (Wave S1): the latest AI review's first three of each as short bullets, each
 * quote one click away. Every one of them, with its source, is in the AI review under "Full breakdown".
 */
export function StrengthsAndConcerns({ assessment }: { assessment: Assessment | null }) {
  if (!assessment) return null;
  const { strengths, concerns } = assessment.result;
  if (!strengths.length && !concerns.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: "0 16px" }}>
      <Points title="Strengths" items={strengths} />
      <Points title="Concerns" items={concerns} />
    </div>
  );
}

function Points({ title, items }: { title: string; items: readonly Point[] }) {
  const shown = items.slice(0, 3);
  return (
    <div className="match-section" style={{ marginTop: 10 }}>
      <h3>{title}</h3>
      {shown.length ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          {shown.map((s, j) => (
            <li key={j}>
              {s.claim}
              {s.evidence.quote ? (
                <details className="more">
                  <summary>{THEIR_SOURCES.has(s.evidence.source) ? "Their words" : "The source"}</summary>
                  <span className="muted">"{s.evidence.quote}"</span>
                </details>
              ) : isUnquoted(s.evidence) ? <NoQuote /> : null}
            </li>
          ))}
        </ul>
      ) : <p className="small muted" style={{ margin: 0 }}>None recorded.</p>}
      {items.length > shown.length ? <p className="small muted" style={{ margin: "4px 0 0" }}>{items.length - shown.length} more under Full breakdown.</p> : null}
    </div>
  );
}

type Assessment = ApplicationDetail["assessments"][number];

/** A reading by the assistant: what it found against each must-have, strengths and concerns with their quotes, and what it could not tell. */
export function AssessmentCard({ assessment, detail, roleId, labels, title }: { assessment: Assessment; detail: ApplicationDetail; roleId: string; labels: PacketLabels; title?: string }) {
  const { id: assessmentId, kind, overall, confidence, createdAt } = assessment;
  const result: AssessmentResult = assessment.result;
  const mustHave = (key: string) => labels.mustHaves.find((m) => m.key === key)?.text ?? key.replace(/^mh_\d+_/, "").replace(/_/g, " ");
  const competency = (key: string) => labels.competencies.find((c) => c.key === key)?.name ?? key.replace(/_/g, " ");
  const skills = skillLabels({ packetLabels: labels });
  const question = (key: string) => screenQuestionText(detail, key) ?? key.replace(/_/g, " ");
  // The reading the "closer look" check was made on carries the mark (plan A8): the résumé's while it waits for review,
  // the screen's once the screen is complete; with the reason when the reading disagrees with its own findings.
  const triage = kind === "triage";
  const look = closerLook(detail);
  const marked = look.checkedId === assessmentId;
  const reasons = result.confidenceReasons ?? [];
  return (
    <Card title={title ?? (kind === "screen" ? "AI review of the screening chat" : "AI review of the résumé")} className="assessment" needsYou={marked} aside={<span className="row"><span className="small muted">{new Date(createdAt).toLocaleDateString()}</span><FlagAssessment applicationId={detail.id} assessmentId={assessmentId} /></span>}>
      <div className="row"><Chip tone={overall === "strong" ? "good" : overall === "weak" ? "caution" : "accent"}>{overallLabel(overall)}</Chip><Chip tone={result.recommendation === "decline_recommended" ? "caution" : "neutral"}>{REC_LABEL[result.recommendation] ?? result.recommendation}</Chip><Chip>{confidence} confidence</Chip>{marked ? <Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip> : null}</div>
      {marked && look.inconsistent && look.reason ? <Alert tone="caution">{look.reason}</Alert> : null}
      <p style={{ marginTop: 8 }}>{result.summary}</p>
      {reasons.length ? <p className="small muted" style={{ marginTop: 4 }}>Confidence is {confidence} because {reasons.join("; ")}.</p> : null}
      {triage && resumeUnreadable(detail) ? <Alert tone="caution">{RESUME_UNREADABLE_TEXT}</Alert> : null}
      {kind === "screen" && (result.compensationExpectation?.stated || result.availability?.stated) ? (
        <dl className="kv" style={{ marginTop: 8 }}>
          {result.compensationExpectation?.stated ? <><dt>Pay expectation</dt><dd>{result.compensationExpectation.stated} <Chip tone={result.compensationExpectation.withinRange === "yes" ? "good" : result.compensationExpectation.withinRange === "above" ? "caution" : "neutral"}>{result.compensationExpectation.withinRange === "yes" ? "within range" : result.compensationExpectation.withinRange}</Chip></dd></> : null}
          {result.availability?.stated ? <><dt>Availability</dt><dd>{result.availability.stated} <Chip tone={MET_TONE[result.availability.matchesSchedule] ?? "neutral"}>{result.availability.matchesSchedule.replace("_", " ")}</Chip></dd></> : null}
        </dl>
      ) : null}
      {/* the most serious finding first, then what counts most (plan F2) */}
      {result.requirementFindings?.length ? (
        <div className="block">
          <h3>Must-haves</h3>
          <ul>
            {orderRequirementFindings(result.requirementFindings, labels.mustHaves).map((r, j) => {
              const chip = requirementChip(r);
              return <li key={`${r.requirementKey}:${j}`}>{mustHave(r.requirementKey)} <Chip tone={chip.tone}>{chip.words}</Chip>{r.evidence?.quote ? <span className="small muted"> "{r.evidence.quote}"</span> : requirementUnquoted(r) ? <NoQuote /> : null}</li>;
            })}
          </ul>
        </div>
      ) : null}
      {result.questionFindings?.length ? <div className="block"><h3>Answers</h3><ul>{result.questionFindings.map((f, j) => <li key={j}><span className="muted small">{question(f.questionKey)}</span><br />{f.finding} {f.answered ? <Chip tone={MET_TONE[f.meetsModelAnswer] ?? "neutral"}>{f.meetsModelAnswer === "unknown" ? "recorded" : f.meetsModelAnswer}</Chip> : null}</li>)}</ul></div> : null}
      {result.competencyFindings?.length ? (
        <div className="block">
          <h3>Skills</h3>
          <ul>
            {orderCompetencyFindings(result.competencyFindings, skills).map((c, j) => {
              const chip = competencyChip(c);
              const tag = importanceTag(skills, c.competencyKey);
              return (
                <li key={`${c.competencyKey}:${j}`}>
                  {competency(c.competencyKey)} {tag ? <span className="sbar-tag">{tag}</span> : null} <Chip tone={chip.tone}>{chip.words}</Chip>
                  {c.evidence?.quote ? <span className="small muted"> "{c.evidence.quote}"</span> : competencyUnquoted(c) ? <NoQuote /> : null}
                  {c.note ? <><br /><span className="small muted">{c.note}</span></> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="block"><h3>Strengths</h3>{result.strengths.length ? <ul>{result.strengths.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : isUnquoted(s.evidence) ? <NoQuote /> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Concerns</h3>{result.concerns.length ? <ul>{result.concerns.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : isUnquoted(s.evidence) ? <NoQuote /> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Open questions</h3>{result.unknowns.length ? <ul>{result.unknowns.map((u, j) => <li key={j}>{u.question} <span className="muted small">({u.whyItMatters})</span></li>)}</ul> : <p className="muted small">Nothing outstanding.</p>}{triage ? <AskInScreen detail={detail} roleId={roleId} unknowns={result.unknowns.length} /> : null}</div>
      {result.anomalies?.length ? <p className="small muted" style={{ marginTop: 8 }}>Flags (never used to decline): {result.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")}</p> : null}
      <p className="small muted" style={{ marginTop: 8 }}>{result.rationale}</p>
    </Card>
  );
}

/**
 * One screening conversation: its state and how it reached them ("Applied and talked in one visit"), the open
 * questions' answers first, each question with what the candidate did with it (chose not to answer, changed it before
 * sending, picked it from the choices), a recruiter's call notes labelled as theirs, and the whole transcript. Until the
 * candidate sends their answers, and for good if they never did, none of that is here (founder decision of 9 October
 * 2026): a calm line says why (`hiddenAnswersLine`), and a recruiter's call notes still show.
 *
 * A chat sent in Wave S7's flow comes first as "Answers to your questions": each company question with the answer
 * written up from the candidate's replies, the assistant's note labelled as its own, and that question's part of the
 * chat one click away (`WriteupAnswers`); then the must-haves the résumé did not show that the chat asked about. Any
 * other answer follows as before, and the whole chat stays at the bottom.
 */
export function ScreenCard({ screen, open, action, questions = [], mustHaves = [], timeline = [] }: { screen: Screen; open?: boolean; action?: ReactNode; questions?: readonly PanelQuestion[]; mustHaves?: ReadonlyArray<{ key: string; text: string }>; timeline?: ApplicationDetail["timeline"] }) {
  // A screen that opened with the open questions keeps their answers beside the questions; they count, and they are shown first.
  const focusAnswered = (screen.progress.focusQuestions ?? []).filter((f) => f.answer);
  const answered = Object.keys(screen.answers).length + focusAnswered.length;
  const asked = screen.progress.askedKeys.length;
  const skipped = screen.progress.declined?.length ?? 0;
  const origin = screenOrigin(screen, timeline);
  const written = writeupLines(screen, questions);
  const gaps = chatGapLines(screen, mustHaves);
  const writtenKeys = new Set(written.map((w) => w.key));
  const lines = answerLines(screen, questions).filter((l) => !writtenKeys.has(l.key));
  const general = generalNotes(screen, questions);
  const hidden = hiddenAnswersLine(screen, timeline);
  const notes = screen.transcript.filter(isRecruiterNote).map((t) => ({ text: t.content, by: t.by ?? null, question: t.questionKey ? questions.find((q) => q.key === t.questionKey)?.question ?? null : null }));
  const counts = screen.answersShared === false ? "" : ` · ${answered} answered${skipped ? `, ${skipped} not answered by choice` : ""}${asked > answered + skipped ? `, ${asked - answered - skipped} asked` : ""}`;
  return (
    <Card title="Screening chat" aside={<div className="row">{origin ? <Chip tone={origin === APPLIED_IN_ONE_VISIT ? "good" : "neutral"}>{origin}</Chip> : null}<Chip>{screen.channel === "sms" ? "text + web" : "web chat"}</Chip><Chip tone={screen.status === "completed" ? "good" : screen.status === "human_requested" ? "needs" : screen.status === "expired" ? "caution" : "accent"}>{SCREEN_STATUS_LABEL[screen.status] ?? screen.status.replace(/_/g, " ")}</Chip></div>}>
      <p className="small muted">{screen.invitedAt ? `${origin ? "Offered" : "Invited"} ${new Date(screen.invitedAt).toLocaleDateString()}` : ""}{screen.remindedAt ? ` · reminded ${new Date(screen.remindedAt).toLocaleDateString()}` : ""}{screen.completedAt ? ` · ${screen.status === "completed" ? "completed" : "closed"} ${new Date(screen.completedAt).toLocaleDateString()}` : ""}{counts}</p>
      {hidden ? <p className="small" style={{ marginTop: 8 }}>{hidden}</p> : null}
      {action}
      {screen.answersShared === false ? (
        // Nothing the candidate said: a recruiter's call notes alone, each with the question it is about.
        notes.length ? (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {notes.map((n, i) => <div key={i} className="bubble recruiter" style={{ whiteSpace: "pre-wrap" }}><span className="bubble-label">{recruiterNoteLabel(n.by)}{n.question ? ` About: ${n.question}` : ""}</span>{n.text}</div>)}
          </div>
        ) : null
      ) : <>
      <WriteupAnswers lines={written} />
      {gaps.length ? (
        <div style={{ marginTop: 8 }}>
          <p className="small muted">Must-haves the résumé did not show, asked about in the chat:</p>
          <dl className="kv small" style={{ marginTop: 4 }}>{gaps.map((g) => <div key={g.key}><dt>{g.text}</dt><dd>{g.words}</dd></div>)}</dl>
        </div>
      ) : null}
      {focusAnswered.length ? (
        <div style={{ marginTop: 8 }}>
          <p className="small muted">What they said about the open questions:</p>
          <dl className="kv small" style={{ marginTop: 4 }}>{focusAnswered.map((f) => <div key={f.key}><dt>{f.question}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{f.answer}</dd></div>)}</dl>
        </div>
      ) : null}
      {lines.length ? (
        <div style={{ marginTop: 8 }}>
          <p className="small muted">{written.length ? "Their other answers" : "Their answers"}{lines.some((l) => l.declined) ? `. "${DECLINED_WORDS}" is never held against them; it counts as not known yet.` : ""}</p>
          <dl className="kv small" style={{ marginTop: 4 }}>
            {lines.map((l) => (
              <div key={l.key}>
                <dt>{l.question}</dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>
                  {l.answer ?? <span className="muted"><em>{l.declined ? DECLINED_WORDS : unansweredWords(screen.status)}</em></span>}
                  {l.edited ? <> <Chip>{EDITED_WORDS}</Chip></> : null}
                  {l.tapped ? <> <span className="muted">({TAPPED_WORDS.toLowerCase()})</span></> : null}
                  {l.notes.map((n, i) => <span key={i} className="bubble recruiter" style={{ display: "block", marginTop: 6 }}><span className="bubble-label">{recruiterNoteLabel(n.by)}</span>{n.text}</span>)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {general.length ? (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          {general.map((n, i) => <div key={i} className="bubble recruiter"><span className="bubble-label">{recruiterNoteLabel(n.by)}</span>{n.text}</div>)}
        </div>
      ) : null}
      {screen.transcript.length ? (
        <details style={{ marginTop: 8 }} open={open}>
          <summary className="small">Read the chat ({screen.transcript.length} messages)</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {screen.transcript.map((t, i) => {
              const b = transcriptBubble(t);
              return <div key={i} className={`bubble ${b.kind}`} style={{ whiteSpace: "pre-wrap" }}>{b.label ? <span className="bubble-label">{b.label}</span> : null}{b.text}</div>;
            })}
          </div>
        </details>
      ) : <p className="small muted" style={{ marginTop: 6 }}>They have not opened it yet.</p>}
      </>}
    </Card>
  );
}

/**
 * "Answers to your questions" (Wave S7): each company question, numbered, with the answer written up from the
 * candidate's replies and where its words come from, what became of the question, the pieces of their own messages it
 * rests on, the assistant's note in its own labelled box (never inside the answer), a recruiter's call notes, and that
 * question's part of the chat one click away. Nothing when the chat has no write-up.
 */
export function WriteupAnswers({ lines }: { lines: readonly WriteupLine[] }) {
  if (!lines.length) return null;
  return (
    <section className="match-section" aria-label="Answers to your questions">
      <h3>Answers to your questions</h3>
      <p className="small muted" style={{ margin: 0 }}>{writeupSummary(lines)}. Each answer is drafted from their own replies; the part of the chat behind it is one click away, and the whole chat is below.</p>
      <ol className="small" style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 12 }}>
        {lines.map((l) => (
          <li key={l.key}>
            <p style={{ margin: 0 }}><strong>{l.question}</strong>{l.required ? null : <span className="muted"> (optional)</span>} <Chip tone={l.tone}>{l.statusWords}</Chip></p>
            {l.answer ? <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{l.answer}</p> : <p className="muted" style={{ margin: "4px 0 0" }}><em>{l.statusWords}</em></p>}
            {l.answer ? <p className="muted" style={{ margin: "2px 0 0" }}>{l.byWords}</p> : null}
            {l.note ? <div className="bubble assistant" style={{ marginTop: 6 }}><span className="bubble-label">{ASSISTANT_NOTE_LABEL}</span>{l.note}</div> : null}
            {l.notes.map((n, i) => <div key={i} className="bubble recruiter" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}><span className="bubble-label">{recruiterNoteLabel(n.by)}</span>{n.text}</div>)}
            {l.quotes.length ? (
              <details className="more">
                <summary>Their words it rests on ({l.quotes.length})</summary>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{l.quotes.map((q) => <li key={q} className="muted">"{q}"</li>)}</ul>
              </details>
            ) : null}
            {l.chat.length ? (
              <details className="more">
                <summary>Read this part of the chat ({l.chat.length} {l.chat.length === 1 ? "message" : "messages"})</summary>
                <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                  {l.chat.map((b, i) => <div key={i} className={`bubble ${b.kind}`} style={{ whiteSpace: "pre-wrap" }}>{b.label ? <span className="bubble-label">{b.label}</span> : null}{b.text}</div>)}
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
