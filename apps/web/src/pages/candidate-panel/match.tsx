"use client";

import type { ReactNode } from "react";
import { Alert, Button, Card, Chip, ScoreBadge, type ScoreBarItem, ScoreBars } from "@ros/ui";
import type { ApplicationDetail } from "../../api/client";
import { CLOSER_LOOK_LABEL, LOW_CONFIDENCE_LABEL, LOW_CONFIDENCE_TEXT, closerLook } from "../../evidence";
import { overallLabel } from "./assessment";
import { resumeOnlyChip } from "../../talent-list";
import { firstSentence, notReadYetWords } from "./helpers";
import { MATCH_PROMISE, MATCH_TITLE, NO_REVIEW_LINE, basisLine, cappedLine, confidenceChip, coverageLine, leftOut, matchBars, matchCardState, missingMustHaves, nextStepAction, quoteSummary, suggestedStepOf, verdictLine, versionNote, type MatchBar, type NextStepAction } from "./match-view";
import { CARD, LABEL, QUOTE, Why } from "./why";

/**
 * The match score on the candidate panel's Overview (founder decision B2; docs/spec/22 section 5), split the Kanvis way
 * (Wave S1): the verdict first (the score as a big "91/100" with its band word, how sure the AI was, one line on the
 * must-haves, and a red chip for each must-have their own words show is missing), then the suggested next step with its
 * one button. How the number was worked out (the bars per requirement, costliest first, what was left out of the score,
 * the version label and the promise) sits under "Full breakdown". The number is worked out by code; a person decides.
 */

/** A part of the card under a hairline, with its small label on top. */
const PART = "grid gap-2 border-t border-line pt-4";
/** The line on what a number covers ("1 of 2 must-haves shown"). */
const COVERAGE = "text-[13.5px] text-ink-2 tabular-nums";

/** The verdict card: the score and its words; `children` (the next step, strengths and concerns) sit under it. */
export function MatchVerdict({ a, children }: { a: ApplicationDetail; children?: ReactNode }) {
  const state = matchCardState(a);
  const look = closerLook(a);
  const latest = a.assessments[0] ?? null;
  const m = state.kind === "scored" || state.kind === "nothing" ? state.m : null;
  const version = versionNote(a, m);
  const confidence = m ? confidenceChip(m.confidence) : null;
  const missing = m ? missingMustHaves(m) : [];
  // An older answer without the score: the AI review's own words stand in for it.
  const fallback = state.kind === "hidden" && latest ? latest : null;
  // When the AI review could not be made at all, the card above the verdict says so; the line never promises one soon.
  const line = !m && look.assessmentUnavailable ? NO_REVIEW_LINE
    : state.kind === "unread" ? state.text
    : m ? verdictLine(a) ?? (state.kind === "nothing" ? state.text : null)
    : fallback ? firstSentence(fallback.result.summary).line
    : notReadYetWords(a.stage);
  const lowShown = confidence?.tone === "caution" || fallback?.confidence === "low";
  // What every number rests on, in words under it, the AI interview's too (22 Oct 2026 try-out; R20-9)
  const basis = state.kind === "scored" ? basisLine(m) : null;
  // R20-9: a number with no AI interview in it yet says so beside it, the full label on hover; never with the line above,
  // which says it in full (the panel's header keeps its own chip on every section)
  const resumeOnly = m && !basis ? resumeOnlyChip(m) : null;
  return (
    <Card title={MATCH_TITLE} className={CARD}>
      {/* the number in display type, like the figures on Home's stat tiles, with its band word and how sure the AI was */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {state.kind === "scored" ? <ScoreBadge score={state.score} size="lg" showBand /> : fallback ? <Chip tone={fallback.overall === "strong" ? "good" : fallback.overall === "weak" ? "caution" : "accent"}>{overallLabel(fallback.overall)}</Chip> : <ScoreBadge score={null} />}
        {resumeOnly ? <span title={resumeOnly.title}><Chip tone="neutral">{resumeOnly.label}</Chip></span> : null}
        {confidence ? <span title={confidence.title}><Chip tone={confidence.tone}>{confidence.label}</Chip></span> : fallback ? <Chip tone={fallback.confidence === "low" ? "caution" : "neutral"}>{fallback.confidence} confidence</Chip> : null}
        {look.needsCloserLook ? <span title={look.reason ?? undefined}><Chip tone="needs">{CLOSER_LOOK_LABEL}</Chip></span> : look.lowConfidence && !lowShown ? <span title={LOW_CONFIDENCE_TEXT}><Chip tone="caution">{LOW_CONFIDENCE_LABEL}</Chip></span> : null}
        {version?.changed ? <span title={version.text}><Chip tone="caution">Read against older job details</Chip></span> : null}
      </div>
      {basis || line ? (
        <div className="grid gap-1">
          {basis ? <p className="small muted match-basis">{basis}</p> : null}
          {line ? <p className={COVERAGE}>{line}</p> : null}
        </div>
      ) : null}
      {/* the chip's reason, for keyboard and touch too (a title shows on hover only); the card above says it when no review could be made */}
      {look.needsCloserLook && look.reason && !look.assessmentUnavailable ? <Why label="Why a closer look?">{look.reason}</Why> : null}
      {missing.length ? (
        <div className="grid gap-2">
          {missing.map((x) => (
            <div key={x.key} className="grid justify-items-start gap-1">
              <Chip tone="critical" icon="alert">{x.chip}</Chip>
              {x.quote ? <TheirWords quote={x.quote} /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {children}
      {/* L-08 B: text aimed at the AI was found and ignored; a plain line, never a warning, and never a reason to decline */}
      {a.hiddenTextNote ? <p className="small muted">{a.hiddenTextNote}</p> : null}
    </Card>
  );
}

/** A quote from the candidate, one click away: their words in the lavender block with the plum rule. */
export function TheirWords({ quote, label = "Their words" }: { quote: string; label?: string }) {
  return (
    <details className="more [&[open]>summary]:mb-1.5">
      <summary>{label}</summary>
      <blockquote className={`small ${QUOTE}`}>"{quote}"</blockquote>
    </details>
  );
}

/**
 * The step the pool board suggests, as on their board card, in one line with its one button (`nextStepAction`); the
 * rest of the reason is under "Why". Nothing moves until a person presses it.
 */
export function NextStepLine({ a, onAction }: { a: ApplicationDetail; onAction?: (action: NextStepAction) => void }) {
  const next = suggestedStepOf(a);
  if (!next) return null;
  const action = onAction ? nextStepAction(a) : null;
  const { line, rest } = firstSentence(next.reason);
  return (
    <div className={PART}>
      <h3 className={LABEL}>Suggested next step</h3>
      <div className="row justify-between">
        <p className="small min-w-0 flex-[1_1_220px]"><strong>{next.label}</strong>{line ? <> · <span className={next.needsYourEye ? "text-caution" : undefined}>{line}</span></> : null}</p>
        {action ? <Button size="sm" onClick={() => onAction?.(action)}>{action.label}</Button> : null}
      </div>
      {rest ? <Why>{rest}</Why> : null}
    </div>
  );
}

/**
 * How the score was worked out, under "Full breakdown": what it rests on, why a missing must-have holds it down, the bars
 * per requirement (the costliest first, the ones at full marks folded), what is not known yet, how sure the AI was, the
 * version of the job it was read against, and the promise that a person decides. Nothing for an older answer without
 * the score, or before there is one (the verdict says so).
 */
export function ScoreBreakdown({ a }: { a: ApplicationDetail }) {
  const state = matchCardState(a);
  if (state.kind === "hidden" || state.kind === "unread") return null;
  const m = state.m;
  const version = versionNote(a, m);
  const confidence = confidenceChip(m.confidence);
  const capped = cappedLine(m);
  const look = closerLook(a);
  const bars = state.kind === "scored" ? matchBars(m) : null;
  return (
    <Card title="How the score was worked out" className={CARD}>
      <div className="grid gap-1">
        <p className={COVERAGE}>{state.kind === "nothing" ? state.text : coverageLine(m)}</p>
        {capped ? <p className="small muted">{capped}</p> : null}
      </div>
      {bars ? (
        <div className={PART}>
          <h3 className={LABEL}>{bars.costly.length ? "What cost points" : "The breakdown"}</h3>
          <ScoreBars label="Requirements, the ones that cost the most points first" items={bars.costly.map(barItem)} folded={bars.full.map(barItem)} foldedLabel={bars.foldedLabel ?? undefined} />
        </div>
      ) : null}
      <LeftOut m={m} />
      {confidence || look.lowConfidence ? (
        <div className={PART}>
          <h3 className={LABEL}>How sure the AI is</h3>
          {confidence ? <p className="small"><Chip tone={confidence.tone}>{confidence.label}</Chip> {confidence.title}</p> : null}
          {look.lowConfidence ? <p className="small muted"><strong>{LOW_CONFIDENCE_LABEL}.</strong> {LOW_CONFIDENCE_TEXT}</p> : null}
        </div>
      ) : null}
      <Footer version={version} />
    </Card>
  );
}

/** One bar with its finding, where it came from, and their words behind one click (ScoreBars' `.sbar-detail` draws the quote). */
function barItem(b: MatchBar): ScoreBarItem {
  return {
    key: `${b.mustHave ? "mh" : "sk"}:${b.key}`,
    label: b.label,
    tag: b.tag,
    mustHave: b.mustHave,
    pctMet: b.pctMet,
    pointsLost: b.pointsLost,
    detail: b.quote ? (
      <details>
        <summary>{quoteSummary(b)}</summary>
        <blockquote>"{b.quote}"</blockquote>
      </details>
    ) : (
      <span>{quoteSummary(b)}</span>
    ),
  };
}

function LeftOut({ m }: { m: Parameters<typeof leftOut>[0] }) {
  const out = leftOut(m);
  if (!out) return null;
  return (
    <div className={PART}>
      <h3 className={LABEL}>{out.heading}</h3>
      <ul className="small grid list-disc gap-1 pl-5 marker:text-ink-3">
        {out.items.map((u) => <li key={`${u.tag}:${u.key}`}>{u.label} <span className={u.tag === "Must-have" ? "sbar-tag must" : "sbar-tag"}>{u.tag}</span></li>)}
      </ul>
      <p className="small muted">{out.note}</p>
    </div>
  );
}

/** The version label (plan F4) and the promise: worked out from checked evidence, and a person decides. */
function Footer({ version }: { version: ReturnType<typeof versionNote> }) {
  return (
    <div className="grid gap-1.5 border-t border-line pt-4">
      {version?.changed ? <Alert tone="caution">{version.text}</Alert> : version ? <p className="small muted">{version.text}</p> : null}
      <p className="small muted">{MATCH_PROMISE}</p>
    </div>
  );
}
