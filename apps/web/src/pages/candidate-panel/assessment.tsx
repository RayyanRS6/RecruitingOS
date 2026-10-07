"use client";

import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, EvidenceChip } from "@ros/ui";
import { api, ApiError, type ApplicationDetail, type AssessmentResult, type Screen } from "../../api/client";
import { toast } from "../../toast";
import { AskRecruiter } from "../../components/AskRecruiter";
import { ASSESSMENT_UNAVAILABLE_TEXT, CLOSER_LOOK_LABEL, NO_QUOTE_LABEL, RESUME_UNREADABLE_TEXT, SCORECARD_UNAVAILABLE_TEXT, closerLook, competencyUnquoted, isUnquoted, openScreenOf, requirementUnquoted, resumeUnreadable, scorecardUnavailable, screenQuestionText } from "../../evidence";
import { actionToast } from "../../talent-actions";
import { REC_LABEL } from "./helpers";

/**
 * The evidence on the candidate panel (plan A10): the assistant's readings with every claim's source and quote, the
 * screening conversation, and the cards that say when a reading could not be made. Nothing here decides anything.
 */

export function overallLabel(o: string): string {
  return { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" }[o] ?? o;
}

export const MET_TONE: Record<string, "good" | "accent" | "neutral" | "caution"> = { yes: "good", partially: "accent", no: "caution", unknown: "neutral", evidenced: "good", partially_evidenced: "accent", not_evidenced: "neutral", contradicted: "caution" };

const SCREEN_STATUS: Record<string, string> = { invited: "Invited", reminded: "Reminded", in_progress: "Answering", completed: "Completed", expired: "No response", abandoned: "Withdrawn", human_requested: "Asked for a person", cancelled: "Stopped", unfinished: "Not finished", declined_by_candidate: "Said no thanks", paused: "Paused" };

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

/** One-click flag with the founder context's taxonomy (§23). It records; it never retrains anything on its own. */
function FlagAssessment({ applicationId, assessmentId }: { applicationId: string; assessmentId: string }) {
  const [kind, setKind] = useState("");
  const [done, setDone] = useState(false);
  const flag = useMutation({
    mutationFn: (k: string) => api.post(`/api/v1/applications/${applicationId}/assessments/${assessmentId}/flag`, { kind: k }),
    onSuccess: () => { setDone(true); toast("Flagged.", "A person reviews these and they improve the system."); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not flag this."),
  });
  if (done) return <span className="small muted">Flagged, thank you.</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <select className="select" style={{ width: "auto", padding: "4px 8px", fontSize: 12.5 }} value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value) flag.mutate(e.target.value); }} aria-label="Something wrong with this assessment?">
        <option value="">Something wrong?</option>
        {FLAG_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
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
  if (open) return <p className="small muted" style={{ marginTop: 6 }}>{open.progress.focusQuestions?.length ? "A screen that starts with these questions is already open; the answers appear here as they come in." : "A screen is already open; these questions are part of its follow-ups, so there is nothing more to send."}</p>;
  if (!detail.allowedActions.includes("invite_screen")) return null;
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <Button size="sm" variant="primary" loading={ask.isPending} onClick={() => ask.mutate()} title="Invites them to a short web screen that starts with these questions">Ask about this in a screen</Button>
      <span className="small muted">A short web screen, by email, that opens with {unknowns === 1 ? "this question" : "these questions"}.</span>
    </div>
  );
}

/** While the assistant could not produce an assessment at all (its answer was unusable twice), the page says so instead of showing nothing. */
export function NoAssessmentCard({ detail }: { detail: ApplicationDetail }) {
  const look = closerLook(detail);
  if (!look.assessmentUnavailable) return null;
  return (
    <Card needsYou title="Résumé assessment" className="assessment">
      <div className="row"><Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip></div>
      <p style={{ marginTop: 8 }}>{ASSESSMENT_UNAVAILABLE_TEXT}</p>
      <p className="small muted" style={{ marginTop: 6 }}>Nothing is hidden: the résumé, the answers and the messages are on this panel. The assistant's answer was not usable after two tries; ITS has the details.</p>
      {resumeUnreadable(detail) ? <p className="small" style={{ color: "var(--needs-you)", marginTop: 6 }}>{RESUME_UNREADABLE_TEXT}</p> : null}
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
    <Card needsYou title="Screen scorecard" className="assessment">
      <div className="row"><Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip></div>
      <p style={{ marginTop: 8 }}>{SCORECARD_UNAVAILABLE_TEXT}</p>
      <p className="small muted" style={{ marginTop: 6 }}>Nothing is hidden: the whole conversation is on the Screen tab. {state.recruiterAsked ? "An ITS recruiter has been asked to look into it." : "ITS has the details."}</p>
      <div className="row" style={{ marginTop: 10 }}><AskRecruiter roleId={roleId} applicationId={detail.id} size="sm" /></div>
    </Card>
  );
}

type Assessment = ApplicationDetail["assessments"][number];

/** A reading by the assistant: what it found against each must-have, strengths and concerns with their quotes, and what it could not tell. */
export function AssessmentCard({ assessment, detail, roleId, labels, title }: { assessment: Assessment; detail: ApplicationDetail; roleId: string; labels: PacketLabels; title?: string }) {
  const { id: assessmentId, kind, overall, confidence, createdAt } = assessment;
  const result: AssessmentResult = assessment.result;
  const mustHave = (key: string) => labels.mustHaves.find((m) => m.key === key)?.text ?? key.replace(/^mh_\d+_/, "").replace(/_/g, " ");
  const competency = (key: string) => labels.competencies.find((c) => c.key === key)?.name ?? key.replace(/_/g, " ");
  const question = (key: string) => screenQuestionText(detail, key) ?? key.replace(/_/g, " ");
  // The reading the "closer look" check was made on carries the mark (plan A8): the résumé's while it waits for review,
  // the screen's once the screen is complete; with the reason when the reading disagrees with its own findings.
  const triage = kind === "triage";
  const look = closerLook(detail);
  const marked = look.checkedId === assessmentId;
  const reasons = result.confidenceReasons ?? [];
  return (
    <Card title={title ?? (kind === "screen" ? "Screen scorecard" : "Résumé assessment")} className="assessment" needsYou={marked} aside={<span className="row"><span className="small muted">{new Date(createdAt).toLocaleDateString()}</span><FlagAssessment applicationId={detail.id} assessmentId={assessmentId} /></span>}>
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
      {result.requirementFindings?.length ? <div className="block"><h3>Must-haves</h3><ul>{result.requirementFindings.map((r, j) => <li key={j}>{mustHave(r.requirementKey)} <Chip tone={MET_TONE[r.met] ?? "neutral"}>{r.met}</Chip>{r.evidence?.quote ? <span className="small muted"> "{r.evidence.quote}"</span> : requirementUnquoted(r) ? <NoQuote /> : null}</li>)}</ul></div> : null}
      {result.questionFindings?.length ? <div className="block"><h3>Answers</h3><ul>{result.questionFindings.map((f, j) => <li key={j}><span className="muted small">{question(f.questionKey)}</span><br />{f.finding} {f.answered ? <Chip tone={MET_TONE[f.meetsModelAnswer] ?? "neutral"}>{f.meetsModelAnswer === "unknown" ? "recorded" : f.meetsModelAnswer}</Chip> : null}</li>)}</ul></div> : null}
      {result.competencyFindings?.length ? <div className="block"><h3>Competencies</h3><div className="row">{result.competencyFindings.map((c, j) => <Chip key={j} tone={MET_TONE[c.finding] ?? "neutral"}>{competency(c.competencyKey)}: {c.finding.replace(/_/g, " ")}{competencyUnquoted(c) ? ` (${NO_QUOTE_LABEL})` : ""}</Chip>)}</div></div> : null}
      <div className="block"><h3>Strengths</h3>{result.strengths.length ? <ul>{result.strengths.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : isUnquoted(s.evidence) ? <NoQuote /> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Concerns</h3>{result.concerns.length ? <ul>{result.concerns.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : isUnquoted(s.evidence) ? <NoQuote /> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Open questions</h3>{result.unknowns.length ? <ul>{result.unknowns.map((u, j) => <li key={j}>{u.question} <span className="muted small">({u.whyItMatters})</span></li>)}</ul> : <p className="muted small">Nothing outstanding.</p>}{triage ? <AskInScreen detail={detail} roleId={roleId} unknowns={result.unknowns.length} /> : null}</div>
      {result.anomalies?.length ? <p className="small muted" style={{ marginTop: 8 }}>Flags (never used to decline): {result.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")}</p> : null}
      <p className="small muted" style={{ marginTop: 8 }}>{result.rationale}</p>
    </Card>
  );
}

/** One screening conversation: its state, the open questions' answers first, and the whole transcript. */
export function ScreenCard({ screen, open, action }: { screen: Screen; open?: boolean; action?: ReactNode }) {
  // A screen that opened with the open questions keeps their answers beside the questions; they count, and they are shown first.
  const focusAnswered = (screen.progress.focusQuestions ?? []).filter((f) => f.answer);
  const answered = Object.keys(screen.answers).length + focusAnswered.length;
  const asked = screen.progress.askedKeys.length;
  return (
    <Card title="Screening conversation" aside={<div className="row"><Chip>{screen.channel === "sms" ? "text + web" : "web chat"}</Chip><Chip tone={screen.status === "completed" ? "good" : screen.status === "human_requested" ? "needs" : screen.status === "expired" ? "caution" : "accent"}>{SCREEN_STATUS[screen.status] ?? screen.status.replace(/_/g, " ")}</Chip></div>}>
      <p className="small muted">{screen.invitedAt ? `Invited ${new Date(screen.invitedAt).toLocaleDateString()}` : ""}{screen.remindedAt ? ` · reminded ${new Date(screen.remindedAt).toLocaleDateString()}` : ""}{screen.completedAt ? ` · completed ${new Date(screen.completedAt).toLocaleDateString()}` : ""} · {answered} answered{asked > answered ? `, ${asked - answered} asked` : ""}</p>
      {action}
      {focusAnswered.length ? (
        <div style={{ marginTop: 8 }}>
          <p className="small muted">What they said about the open questions:</p>
          <dl className="kv small" style={{ marginTop: 4 }}>{focusAnswered.map((f) => <div key={f.key}><dt>{f.question}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{f.answer}</dd></div>)}</dl>
        </div>
      ) : null}
      {screen.transcript.length ? (
        <details style={{ marginTop: 8 }} open={open}>
          <summary className="small">Read the conversation ({screen.transcript.length} messages)</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {screen.transcript.map((t, i) => <div key={i} className={`bubble ${t.role === "candidate" ? "user" : t.role === "assistant" ? "assistant" : "system"}`} style={{ whiteSpace: "pre-wrap" }}>{t.content}</div>)}
          </div>
        </details>
      ) : <p className="small muted" style={{ marginTop: 6 }}>They have not opened it yet.</p>}
    </Card>
  );
}
