"use client";

import { Alert, Card, Chip, ScoreBadge, type ScoreBarItem, ScoreBars } from "@ros/ui";
import type { ApplicationDetail } from "../../api/client";
import { MATCH_PROMISE, MATCH_TITLE, cappedLine, confidenceChip, coverageLine, leftOut, matchBars, matchCardState, missingMustHaves, mustHaveLineOf, quoteSummary, suggestedStepOf, versionNote, type MatchBar } from "./match-view";

/**
 * "Against your must-haves" on the candidate panel's Overview (founder decision B2; docs/spec/22 section 5): the match
 * score as a big "91/100" with its band word, the confidence of the reading as a chip of its own, what the number rests
 * on ("Based on 5 of 7 requirements"), a red chip for each must-have their own words show is missing, then one bar per
 * requirement, the costliest first, each with its tag, how much was met, the points it cost and their words one click
 * away; the ones at full marks fold under one line. What the evidence says nothing about is listed apart: left out of
 * the score, never counted against them. The number is worked out by code from checked findings; a person decides.
 */
export function MatchCard({ a }: { a: ApplicationDetail }) {
  const state = matchCardState(a);
  if (state.kind === "hidden") return null;
  if (state.kind === "unread") {
    return (
      <Card title={MATCH_TITLE}>
        <p className="small muted" style={{ margin: 0 }}>{state.text}</p>
      </Card>
    );
  }
  const m = state.m;
  const version = versionNote(a, m);
  const mustHaveLine = mustHaveLineOf(a);
  const next = suggestedStepOf(a);
  if (state.kind === "nothing") {
    return (
      <Card title={MATCH_TITLE} aside={<ScoreBadge score={null} />}>
        <p className="small" style={{ margin: 0 }}>{state.text}</p>
        {mustHaveLine ? <p className="match-coverage">{mustHaveLine}</p> : null}
        <LeftOut m={m} />
        <NextStep next={next} />
        <Footer version={version} />
      </Card>
    );
  }
  const bars = matchBars(m);
  const confidence = confidenceChip(m.confidence);
  const missing = missingMustHaves(m);
  const capped = cappedLine(m);
  return (
    <Card title={MATCH_TITLE}>
      <div className="match-head">
        <ScoreBadge score={state.score} size="lg" showBand />
        {confidence ? <span title={confidence.title}><Chip tone={confidence.tone}>{confidence.label}</Chip></span> : null}
      </div>
      <p className="match-coverage">{coverageLine(m)}</p>
      {mustHaveLine ? <p className="match-coverage">{mustHaveLine}</p> : null}
      {missing.length ? (
        <div className="stack" style={{ gap: 6, marginTop: 10 }}>
          {missing.map((x) => (
            <div key={x.key}>
              <Chip tone="critical" icon="alert">{x.chip}</Chip>
              {x.quote ? <blockquote className="small" style={{ margin: "6px 0 0", paddingLeft: 10, borderLeft: "2px solid var(--critical-line)" }}>Their own words: "{x.quote}"</blockquote> : null}
            </div>
          ))}
          {capped ? <p className="small muted" style={{ margin: 0 }}>{capped}</p> : null}
        </div>
      ) : null}
      <div className="match-section">
        <h3>{bars.costly.length ? "What cost points" : "The breakdown"}</h3>
        <ScoreBars label="Requirements, the ones that cost the most points first" items={bars.costly.map(barItem)} folded={bars.full.map(barItem)} foldedLabel={bars.foldedLabel ?? undefined} />
      </div>
      <LeftOut m={m} />
      <NextStep next={next} />
      <Footer version={version} />
    </Card>
  );
}

/** The step the pool board suggests, as on their board card; nothing moves until a person applies it. */
function NextStep({ next }: { next: ReturnType<typeof suggestedStepOf> }) {
  if (!next) return null;
  return (
    <div className="match-section">
      <h3>Suggested next step</h3>
      <p className="small" style={{ margin: 0 }}><span className="next-step-tag">{next.label}</span> {next.needsYourEye ? <span style={{ color: "var(--caution)" }}>{next.reason}</span> : next.reason}</p>
    </div>
  );
}

/** One bar with its finding, where it came from, and their words behind one click. */
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
    <div className="match-section">
      <h3>{out.heading}</h3>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {out.items.map((u) => <li key={`${u.tag}:${u.key}`}>{u.label} <span className={u.tag === "Must-have" ? "sbar-tag must" : "sbar-tag"}>{u.tag}</span></li>)}
      </ul>
      <p className="small muted" style={{ margin: "6px 0 0" }}>{out.note}</p>
    </div>
  );
}

/** The version label (plan F4) and the promise: worked out from checked evidence, and a person decides. */
function Footer({ version }: { version: ReturnType<typeof versionNote> }) {
  return (
    <div className="stack" style={{ gap: 6, marginTop: 14 }}>
      {version?.changed ? <Alert tone="caution">{version.text}</Alert> : version ? <p className="small muted" style={{ margin: 0 }}>{version.text}</p> : null}
      <p className="small muted" style={{ margin: 0 }}>{MATCH_PROMISE}</p>
    </div>
  );
}
