"use client";

import { type ReactNode, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AiInterviewPanel, AiReview, CandidatePanel as CandidatePanelView, DecisionMessagePreview, ReviewPoint } from "@ros/contracts";
import { Alert, Avatar, Button, Card, Drawer, ErrorState, Icon, Pill, ScoreBadge, Skeleton } from "@ros/ui";
import { ApiError, api, errorWords, isCandidateLocked } from "../../api/client";
import { answerWords, interviewFacts, panelButtons, panelRefresh, privateLine, questionRows, requirementRows, resumeView, scoreView, type ScoreView } from "../../candidates";
import { LockedCard } from "../../components/LockedCandidates";
import { Upgrade } from "../../components/Upgrade";
import { appliedWhen, longDay } from "../../dates";
import { BULLETS, SUBHEAD } from "../look";
import { ActionButton } from "./ActionButton";
import type { useCandidateActions } from "./use-actions";

/** Rows inside a card, divided by hairlines. */
const ROWS = "grid divide-y divide-line [&>li]:py-3 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0";

/**
 * The candidate panel, a side sheet over the list: the name and where the person stands, the actions the API allows
 * for that stage and no other, and three sections: the resume match (the score with every requirement's finding and
 * quote), the application (the screening answers, contact details and the resume file) and the AI interview (where it
 * stands and, once the candidate sent their answers, its score, the per-question table and their answers). Someone
 * past the plan's candidates per job shows the locked card and nothing else.
 */
export function CandidatePanel({ id, actions, decisionOpen, onDecisionOpen, onClose }: { id: string; actions: ReturnType<typeof useCandidateActions>; decisionOpen: boolean; onDecisionOpen: (open: boolean) => void; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["candidate", id],
    queryFn: () => api.get<CandidatePanelView>(`/api/v1/applications/${id}`),
    // locked or not there is an answer, not a hiccup: it is not asked again
    retry: (count, e) => !(e instanceof ApiError && [402, 403, 404].includes(e.status)) && count < 1,
    refetchInterval: (query) => panelRefresh(query.state.data),
  });
  const p = q.data;
  const title = p?.candidate.name ?? "Candidate";
  const sub = p ? [p.label, p.toldLabel, appliedWhen(p.appliedAt)].filter(Boolean).join(" · ") : undefined;
  return (
    <Drawer open onClose={onClose} title={title} sub={sub} leading={p ? <Avatar name={p.candidate.name} size="lg" /> : undefined} size="lg">
      {q.isLoading ? <Skeleton lines={6} /> : isCandidateLocked(q.error) ? <LockedCard /> : q.error || !p ? (
        q.error instanceof ApiError && q.error.status === 404 ? <p className="small muted">We could not find this person.</p> : <ErrorState message="Could not load this person." onRetry={() => q.refetch()} />
      ) : (
        <div className="stack gap-5">
          <Actions panel={p} actions={actions} decisionOpen={decisionOpen} onDecisionOpen={onDecisionOpen} />
          <ResumeMatch panel={p} />
          <Application panel={p} />
          <Interview ai={p.aiInterview} />
        </div>
      )}
    </Drawer>
  );
}

/**
 * What can be done with the person now: a button for each action the API lists, in its order. "Email the decision"
 * first shows the email exactly as it will go. A decision nobody has told the candidate says so plainly.
 */
function Actions({ panel: p, actions, decisionOpen, onDecisionOpen }: { panel: CandidatePanelView; actions: ReturnType<typeof useCandidateActions>; decisionOpen: boolean; onDecisionOpen: (open: boolean) => void }) {
  const buttons = panelButtons(p.actions);
  const told = privateLine(p);
  const busy = actions.one.isPending ? actions.one.variables?.action : null;
  const sending = buttons.find((b) => b.action === "send_decision" && b.allowed);
  // once the email is on its way (or the person moved on), the email shown before sending has nothing left to send
  useEffect(() => {
    if (decisionOpen && !sending) onDecisionOpen(false);
  }, [decisionOpen, sending, onDecisionOpen]);
  if (!buttons.length && !told && !actions.problem) return null;
  return (
    <div className="grid gap-3">
      {told ? <Alert tone="info">{told}</Alert> : null}
      {actions.problem ? (
        <Alert tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{actions.problem.message}</span>
            {actions.problem.ask ? <Upgrade label={actions.problem.ask.label} size="sm" reason={actions.problem.ask.reason} /> : null}
          </div>
        </Alert>
      ) : null}
      {decisionOpen && sending ? (
        <DecisionEmail id={p.id} sending={busy === "send_decision"} onSend={() => actions.one.mutate({ id: p.id, action: "send_decision" })} onCancel={() => onDecisionOpen(false)} />
      ) : buttons.length ? (
        // a group named for screen readers: the buttons are this person's
        <fieldset className="row min-w-0" aria-label={`Actions for ${p.candidate.name}`}>
          {buttons.map((b) => (
            <ActionButton
              key={b.action}
              state={b}
              who={p.candidate.name}
              variant={b.variant}
              busy={busy === b.action}
              waiting={!!busy && busy !== b.action}
              onRun={() => (b.action === "send_decision" ? onDecisionOpen(true) : actions.one.mutate({ id: p.id, action: b.action }))}
            />
          ))}
        </fieldset>
      ) : null}
      {decisionOpen ? null : buttons.map((b) => (b.note ? <p key={b.action} className="small muted">{b.note}</p> : !b.allowed && b.reason ? <p key={b.action} className="small muted">{b.label}: {b.reason}</p> : null))}
    </div>
  );
}

/** The exact email "Email the decision" sends, shown before it goes: who it goes to, its subject and its words. */
function DecisionEmail({ id, sending, onSend, onCancel }: { id: string; sending: boolean; onSend: () => void; onCancel: () => void }) {
  const q = useQuery({ queryKey: ["decision-message", id], queryFn: () => api.get<DecisionMessagePreview>(`/api/v1/applications/${id}/decision-message`), retry: false, staleTime: 0 });
  return (
    <Card title="Email the decision">
      {q.isLoading ? <Skeleton lines={4} /> : q.error || !q.data ? <ErrorState message={errorWords(q.error, "Could not load the email.")} onRetry={() => q.refetch()} /> : (
        <div className="stack gap-3">
          <dl className="glance">
            <dt>To</dt><dd>{q.data.to ?? "No email address on file"}</dd>
            <dt>Subject</dt><dd>{q.data.subject}</dd>
          </dl>
          <p className="whitespace-pre-wrap rounded-xl border border-line bg-ground/60 p-3.5 text-[14.5px] text-ink-2 wrap-anywhere">{q.data.text}</p>
          <div className="row">
            <Button variant="primary" icon="send" loading={sending} onClick={onSend}>Send the email</Button>
            <Button variant="ghost" disabled={sending} onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** A score at the head of its section: the number large, its band word, or the words for why there is none. */
function BigScore({ view, label, children }: { view: ScoreView; label: string; children?: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <ScoreBadge size={view.score === null ? "md" : "lg"} label={label} score={view.score} tone={view.tone} band={view.band} none={view.none ?? undefined} />
      {children}
    </div>
  );
}

/** The AI's own words about a resume or an interview, folded: a summary, strengths, concerns and open questions. Words only. */
function Review({ review }: { review: AiReview }) {
  const points = (items: ReviewPoint[]) => (
    <ul className={BULLETS}>
      {items.map((s) => <li key={`${s.claim}|${s.quote ?? ""}`}>{s.claim}{s.quote ? <span className="text-ink-2"> "{s.quote}"{s.from ? `, ${s.from}` : ""}</span> : null}</li>)}
    </ul>
  );
  return (
    <details className="more">
      <summary>AI review</summary>
      <div className="grid gap-3">
        <p className="text-[14.5px] text-ink-2">{review.summary}</p>
        {review.strengths.length ? <div className="grid gap-1.5"><h3 className={SUBHEAD}>Strengths</h3>{points(review.strengths)}</div> : null}
        {review.concerns.length ? <div className="grid gap-1.5"><h3 className={SUBHEAD}>Concerns</h3>{points(review.concerns)}</div> : null}
        {review.openQuestions.length ? (
          <div className="grid gap-1.5">
            <h3 className={SUBHEAD}>Open questions</h3>
            <ul className={BULLETS}>{review.openQuestions.map((o) => <li key={o.question}>{o.question}{o.whyItMatters ? <span className="text-ink-2"> {o.whyItMatters}</span> : null}</li>)}</ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** The resume match: the score, the must-have line, anything missing, and every requirement with its finding and quote. */
function ResumeMatch({ panel: p }: { panel: CandidatePanelView }) {
  const rows = requirementRows(p.cvScore);
  return (
    <Card title="Resume match">
      <div className="stack gap-4">
        <BigScore view={scoreView(p.cvScore)} label="Resume match">
          {p.cvScore.mustHaveLine ? <p className="text-[14px] text-ink-2">{p.cvScore.mustHaveLine}</p> : null}
          {p.cvScore.missingLine ? <p className="text-[14px] font-medium text-critical">{p.cvScore.missingLine}</p> : null}
          {p.cvScore.earlierVersionLine ? <p className="small muted">{p.cvScore.earlierVersionLine}</p> : null}
        </BigScore>
        {rows.length ? (
          <ul className={ROWS} aria-label="Requirements">
            {rows.map((r) => (
              <li key={r.key} className="grid gap-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="min-w-0 wrap-anywhere">{r.label}</strong>
                  <span className="inline-tag">{r.tag}</span>
                  <span className="small muted tabular-nums">{r.points}</span>
                  <Pill size="sm" tone={r.tone} className="ml-auto">{r.finding}</Pill>
                </span>
                {r.quote ? <span className="small text-ink-2 wrap-anywhere">{r.quote}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {p.cvReview ? <Review review={p.cvReview} /> : null}
      </div>
    </Card>
  );
}

/** The application: the screening answers (a "No" flagged), how to reach the person, where they came from, and the resume file. */
function Application({ panel: p }: { panel: CandidatePanelView }) {
  const cv = resumeView(p.id, p.cv);
  return (
    <Card title="Application">
      <div className="stack gap-4">
        {p.screeningAnswers.length ? (
          <ul className={ROWS} aria-label="Screening answers">
            {p.screeningAnswers.map((a) => (
              <li key={a.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <span className="min-w-0 flex-[1_1_14rem] wrap-anywhere">{a.question}</span>
                {a.flagged ? <Pill size="sm" tone="caution" icon="flag">{a.answer ?? "No answer"}</Pill> : <strong className="wrap-anywhere">{a.answer ?? "No answer"}</strong>}
              </li>
            ))}
          </ul>
        ) : null}
        <dl className="glance">
          <dt>Email</dt><dd>{p.candidate.email ? <a href={`mailto:${p.candidate.email}`}>{p.candidate.email}</a> : "None on file"}</dd>
          {p.candidate.phone ? <><dt>Phone</dt><dd><a href={`tel:${p.candidate.phone.replace(/[^\d+]/g, "")}`}>{p.candidate.phone}</a></dd></> : null}
          <dt>Applied</dt><dd>{longDay(p.appliedAt)}</dd>
          <dt>Came from</dt><dd>{p.sourceLabel}</dd>
          {p.toldAt ? <><dt>Told</dt><dd>{longDay(p.toldAt)}</dd></> : null}
        </dl>
        <div className="grid gap-2">
          <h3 className={SUBHEAD}>Resume</h3>
          {cv.words ? <p className="small muted">{cv.words}</p> : null}
          {/* the file in a frame of this site's own address; each opening is recorded by the server */}
          {cv.frame && p.cv ? <iframe src={cv.frame} title={`Resume: ${p.cv.filename}`} referrerPolicy="same-origin" className="h-[min(70vh,720px)] w-full rounded-2xl border border-line bg-surface" /> : null}
          {cv.download && p.cv ? <p><a href={cv.download} target="_blank" rel="noopener noreferrer" className="text-link"><Icon name="file-text" size={16} />Download {p.cv.filename}<span className="sr-only"> (opens in a new tab)</span></a></p> : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * The AI interview: where it stands and, once the candidate pressed "Send my answers", its score, each question with
 * its finding, and their answers, folded. Nothing of an interview is here before that.
 */
function Interview({ ai }: { ai: AiInterviewPanel | null }) {
  const facts = interviewFacts(ai);
  return (
    <Card title="AI interview" aside={ai ? <Pill size="sm" tone={ai.status === "done" ? "good" : "neutral"}>{ai.label}</Pill> : null}>
      {!ai ? <p className="small muted">Not sent.</p> : (
        <div className="stack gap-4">
          {facts.length ? <p className="small text-ink-2">{facts.join(" · ")}</p> : null}
          {ai.score ? (
            <>
              <BigScore view={scoreView(ai.score)} label="AI interview">
                {ai.score.answeredLine ? <p className="text-[14px] text-ink-2">{ai.score.answeredLine}</p> : null}
              </BigScore>
              {ai.score.questions.length ? (
                <ul className={ROWS} aria-label="Interview questions">
                  {questionRows(ai.score).map((r) => (
                    <li key={r.key} className="grid gap-1">
                      <span className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                        <strong className="min-w-0 flex-[1_1_14rem] wrap-anywhere">{r.question}</strong>
                        <Pill size="sm" tone={r.tone}>{r.finding}</Pill>
                      </span>
                      {r.note ? <span className="small text-ink-2">{r.note}</span> : null}
                      {r.quote ? <span className="small text-ink-2 wrap-anywhere">{r.quote}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {ai.review ? <Review review={ai.review} /> : null}
          {ai.answers.length ? (
            <details className="more">
              <summary>{`Their answers (${ai.answers.length})`}</summary>
              <ul className={ROWS}>
                {ai.answers.map((a) => (
                  <li key={a.key} className="grid gap-1">
                    <strong className="wrap-anywhere">{a.question}</strong>
                    <span className="whitespace-pre-wrap text-[14.5px] text-ink-2 wrap-anywhere">{answerWords(a)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </Card>
  );
}
