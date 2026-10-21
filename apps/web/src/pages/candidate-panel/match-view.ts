import { IMPORTANCE_LABEL, MISSING_MUST_HAVE_CAP, type BoardPlacement, type Importance, type MatchCriterion, type MatchScore, type MustHaveSummary, type OwnerStage, type ReadingVersion } from "@ros/contracts";
import type { ApplicationDetail } from "../../api/client";
import { scoreBasis } from "../../talent-list";

/**
 * The match score on the candidate panel (founder decision B2; docs/spec/22 section 5), kept free of React so it can be
 * tested (tests/web/match-panel.test.ts): the words around the number, the bars (the costliest first, then "N more at
 * full marks"), what was left out of the score, the version label (plan F4), and the order the evidence is listed in
 * (plan F2). The number itself comes from the API (`matchScore`, worked out by code in packages/core from the checked
 * findings); nothing here works it out again.
 */

export const MATCH_TITLE = "Against your must-haves";
/** The promise wherever the score is explained, in the same words as MATCH_SCORE_PROMISE in packages/core. */
export const MATCH_PROMISE = "A match score worked out from checked evidence, with the breakdown shown. A person always decides.";

/** The verdict's line when the AI review could not be made at all (the card above the verdict says what to do). */
export const NO_REVIEW_LINE = "No match score: the AI review could not be made, so read this one yourself.";

/** What GET /applications/:id carries since Wave F; an older answer leaves it out, and the panel then shows nothing for it. */
type ScoredDetail = { matchScore?: MatchScore | null; readingVersion?: ReadingVersion | null; mustHaves?: MustHaveSummary | null; placement?: BoardPlacement | null };

/** The must-have line (plan F1): "Must-haves: 3 of 4 shown, 1 not yet known". Null without a reading or must-haves. */
export function mustHaveLineOf(a: ApplicationDetail): string | null {
  const s = (a as ApplicationDetail & ScoredDetail).mustHaves;
  return s?.total ? s.words : null;
}

/**
 * The step the pool board suggests for them (plan F6), as on their board card: what to do next and why, or what needs
 * a person's eye first. Null once a person has sorted or decided, or while they are still applying or being read.
 */
export function suggestedStepOf(a: ApplicationDetail): { label: string; reason: string; needsYourEye: boolean } | null {
  const p = (a as ApplicationDetail & ScoredDetail).placement;
  if (p?.state !== "suggested" || !p.nextStep) return null;
  return { label: p.nextStep.label, reason: p.needsYourEye ?? p.nextStep.reason, needsYourEye: !!p.needsYourEye };
}

/** The button beside the suggested next step: a stage move (it opens the same step as the stage button), a section, or writing to them. */
export type NextStepAction = { kind: "move"; to: OwnerStage; label: string } | { kind: "tab"; tab: "resume"; label: string } | { kind: "write"; label: string };

const MOVE_WORDS: Partial<Record<OwnerStage, string>> = { shortlist: "Move to Shortlist", longlist: "Move to Longlist", interviewing: "Approve an interview", not_moving_forward: "Not moving forward" };

/**
 * What the one button beside the suggested next step does (Wave S1): the board's suggestion applied the way the stage
 * button would (an interview opens the approval, Not moving forward opens the private decline; nothing moves by itself),
 * the résumé for "Read it yourself", or the message box for "Ask for more detail". Null when there is nothing to press:
 * no suggestion, or a move the API does not allow now.
 */
export function nextStepAction(a: Pick<ApplicationDetail, "stageMoves" | "candidate"> & ScoredDetail): NextStepAction | null {
  const p = a.placement;
  if (p?.state !== "suggested" || !p.nextStep) return null;
  const may = (to: OwnerStage) => a.stageMoves.some((m) => m.to === to && m.allowed && !m.current);
  const move = (to: OwnerStage): NextStepAction | null => (may(to) && MOVE_WORDS[to] ? { kind: "move", to, label: MOVE_WORDS[to]! } : null);
  switch (p.nextStep.kind) {
    case "read_yourself":
      return { kind: "tab", tab: "resume", label: "Open the résumé" };
    case "interview":
      return move("interviewing") ?? (p.suggestedAction ? move(p.suggestedAction) : null);
    case "ask_more":
      return a.candidate.email ? { kind: "write", label: `Write to ${a.candidate.firstName || "them"}` } : null;
    default:
      return p.suggestedAction ? move(p.suggestedAction) : null;
  }
}

/**
 * The one line under the score (Wave S1): how many must-haves their words show, partly show, show are not met, and do
 * not say yet ("1 of 5 must-haves shown · 3 not known yet"); without must-haves, what the score rests on. Null with neither.
 */
export function verdictLine(a: ScoredDetail): string | null {
  const s = a.mustHaves;
  if (s?.total) {
    const parts = [`${s.shown} of ${s.total} must-haves shown`];
    if (s.partly) parts.push(`${s.partly} partly`);
    if (s.notShown) parts.push(`${s.notShown} not met`);
    if (s.unknown) parts.push(`${s.unknown} not known yet`);
    return parts.join(" · ");
  }
  return a.matchScore?.coverage.words ?? null;
}
/** A skill's label with its importance, as GET /applications/:id gives it since Wave F (plan F3). */
export type LabelledSkill = { key: string; name: string; importance?: Importance | null };

export function matchOf(a: ApplicationDetail): MatchScore | null | undefined {
  return (a as ApplicationDetail & ScoredDetail).matchScore;
}

export function readingVersionOf(a: ApplicationDetail): ReadingVersion | null {
  return (a as ApplicationDetail & ScoredDetail).readingVersion ?? null;
}

/** The role's skills with their importance; older answers have no importance, and their skills read as untagged. */
export function skillLabels(a: Pick<ApplicationDetail, "packetLabels">): LabelledSkill[] {
  return a.packetLabels.competencies as LabelledSkill[];
}

/**
 * What the match card shows: nothing for an answer from before the score existed (`hidden`), a line when there is no
 * reading yet (`unread`) or when the reading does not speak to any requirement (`nothing`), otherwise the score.
 */
export type MatchCardState = { kind: "hidden" } | { kind: "unread"; text: string } | { kind: "nothing"; text: string; m: MatchScore } | { kind: "scored"; score: number; m: MatchScore };

export function matchCardState(a: ApplicationDetail): MatchCardState {
  const m = matchOf(a);
  if (m === undefined) return { kind: "hidden" };
  if (!m) return { kind: "unread", text: a.assessments.length ? "No match score yet: there is no AI review of this application against the job's requirements." : a.stage === "ineligible" ? "No match score yet. It comes from the AI review, which starts once someone keeps them in." : "No match score yet. It comes from the AI review, which usually comes a minute or two after they apply." };
  if (m.score === null) return { kind: "nothing", text: m.coverage.words, m };
  return { kind: "scored", score: m.score, m };
}

/**
 * "Based on 5 of 7 requirements. From the résumé and the AI interview." The coverage, then what the score rests on (its
 * label, R20-9: "Résumé only: AI interview not done yet" until the AI interview is in it; `scoreBasis`).
 */
export function coverageLine(m: MatchScore): string {
  if (!m.coverage.known) return m.coverage.words;
  const basis = scoreBasis(m);
  return basis ? `${m.coverage.words}. ${basis}.` : `${m.coverage.words}.`;
}

const CONFIDENCE_WORD: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * The confidence chip, kept apart from the score: how sure the assistant was about the reading the score rests on. It
 * never changes the number; a low one asks the reader to read the evidence themselves.
 */
export function confidenceChip(c: MatchScore["confidence"]): { label: string; tone: "neutral" | "caution"; title: string } | null {
  if (!c) return null;
  return {
    label: `${CONFIDENCE_WORD[c] ?? c} confidence`,
    tone: c === "low" ? "caution" : "neutral",
    title: c === "low" ? "The AI was not sure about the review behind this score. Read the evidence yourself before you decide." : "How sure the AI was about the review behind this score. It does not change the number.",
  };
}

/** One bar of the breakdown, in the panel's words. */
export type MatchBar = { key: string; label: string; tag: string; mustHave: boolean; pctMet: number; pointsLost: number; finding: string; source: string; quote: string | null };

const SOURCE_WORDS: Record<MatchCriterion["source"], string> = { resume: "from the AI review of the résumé", screen: "from the AI interview" };

/** The tag beside a requirement: "Must-have", or how much a skill counts (Essential, Important, Helpful). */
export function criterionTag(c: { mustHave: boolean; importance: Importance | null }): string {
  if (c.mustHave) return "Must-have";
  return c.importance ? IMPORTANCE_LABEL[c.importance] : "Skill";
}

export function matchBar(c: MatchCriterion): MatchBar {
  return { key: c.key, label: c.label, tag: criterionTag(c), mustHave: c.mustHave, pctMet: c.pctMet, pointsLost: c.pointsLost, finding: c.finding, source: SOURCE_WORDS[c.source], quote: c.quote };
}

/**
 * The bars: the requirements that cost points, costliest first (the API's order), then the ones at full marks folded
 * under one line, "3 more at full marks" (or "All 4 at full marks" when nothing cost a point).
 */
export function matchBars(m: MatchScore): { costly: MatchBar[]; full: MatchBar[]; foldedLabel: string | null } {
  const bars = m.breakdown.map(matchBar);
  const costly = bars.filter((b) => b.pctMet < 100);
  const full = bars.filter((b) => b.pctMet >= 100);
  if (!full.length) return { costly, full, foldedLabel: null };
  const foldedLabel = costly.length ? `${full.length} more at full marks` : full.length === 1 ? "1 requirement at full marks" : `All ${full.length} at full marks`;
  return { costly, full, foldedLabel };
}

/** The line that opens a bar's quote: what was found, where, and whether there are words of theirs to read. */
export function quoteSummary(b: MatchBar): string {
  return `${b.finding}, ${b.source}${b.quote ? " · see their words" : " · no quote"}`;
}

/** The red chips, one per must-have their own words show is not met, each with the quote that shows it. */
export function missingMustHaves(m: MatchScore): Array<{ key: string; chip: string; quote: string }> {
  return m.missingMustHave.map((x) => ({ key: x.key, chip: `Missing must-have: ${x.label}`, quote: x.quote }));
}

/** Why the number is not higher when a missing must-have held it down. */
export function cappedLine(m: MatchScore): string | null {
  return m.capped ? `A must-have their own words show is not met holds the score at ${MISSING_MUST_HAVE_CAP} at most.` : null;
}

/** The requirements the evidence says nothing about: left out of the score, never counted against them. */
export function leftOut(m: MatchScore): { heading: string; items: Array<{ key: string; label: string; tag: string }>; note: string } | null {
  if (!m.unknown.length) return null;
  const n = m.unknown.length;
  return {
    heading: n === 1 ? "1 requirement not known yet" : `${n} requirements not known yet`,
    items: m.unknown.map((u) => ({ key: u.key, label: u.label, tag: criterionTag(u) })),
    note: `Left out of the score, never counted against them. Ask about ${n === 1 ? "it" : "them"} in the AI interview or a call.`,
  };
}

/**
 * The version label (plan F4): which version of the role the reading was made against. When that is an earlier one,
 * it says so, and that the score uses the requirements as they were then.
 */
export function versionNote(a: ApplicationDetail, m: MatchScore | null | undefined): { text: string; changed: boolean } | null {
  const rv = readingVersionOf(a);
  if (rv) return { text: `${rv.label} The score uses the requirements as they were then.`, changed: true };
  const v = m?.packetVersion;
  return v ? { text: `Read against version ${v} of the job details, the current one.`, changed: false } : null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The order the evidence is listed in (plan F2): the most serious finding first, then what counts most.          */
/* ------------------------------------------------------------------------------------------------------------ */

type Ref = { quote?: string; unquoted?: boolean } | undefined;
const verified = (e: Ref) => !!e?.quote?.trim() && !e.unquoted;

/** 0 not met (shown by a quote), 1 partly, 2 "not met" with no quote, 3 not known, 4 shown. */
export function requirementSeverity(f: { met: string; evidence?: Ref }): number {
  if (f.met === "no") return verified(f.evidence) ? 0 : 2;
  if (f.met === "partially") return 1;
  if (f.met === "unknown") return 3;
  return 4;
}

/** 0 goes against it (shown by a quote), 1 partly, 2 "goes against it" with no quote, 3 not shown yet, 4 shown. */
export function competencySeverity(f: { finding: string; evidence?: Ref }): number {
  if (f.finding === "contradicted") return verified(f.evidence) ? 0 : 2;
  if (f.finding === "partially_evidenced") return 1;
  if (f.finding === "not_evidenced") return 3;
  return 4;
}

const IMPORTANCE_RANK: Record<Importance, number> = { essential: 0, important: 1, helpful: 2 };

/** The must-have findings, the most serious first; equals keep the role's own order of must-haves. */
export function orderRequirementFindings<T extends { requirementKey: string; met: string; evidence?: Ref }>(findings: readonly T[], mustHaves: ReadonlyArray<{ key: string }>): T[] {
  const at = (key: string) => {
    const i = mustHaves.findIndex((m) => m.key === key);
    return i < 0 ? mustHaves.length : i;
  };
  return findings.map((f, i) => ({ f, i })).sort((x, y) => requirementSeverity(x.f) - requirementSeverity(y.f) || at(x.f.requirementKey) - at(y.f.requirementKey) || x.i - y.i).map((x) => x.f);
}

/** The skill findings, the most serious first, then Essential before Important before Helpful, then the role's order. */
export function orderCompetencyFindings<T extends { competencyKey: string; finding: string; evidence?: Ref }>(findings: readonly T[], skills: ReadonlyArray<LabelledSkill>): T[] {
  const at = (key: string) => {
    const i = skills.findIndex((s) => s.key === key);
    return i < 0 ? skills.length : i;
  };
  const rank = (key: string) => {
    const imp = skills.find((s) => s.key === key)?.importance;
    return imp ? IMPORTANCE_RANK[imp] : 3;
  };
  return findings.map((f, i) => ({ f, i })).sort((x, y) => competencySeverity(x.f) - competencySeverity(y.f) || rank(x.f.competencyKey) - rank(y.f.competencyKey) || at(x.f.competencyKey) - at(y.f.competencyKey) || x.i - y.i).map((x) => x.f);
}

const REQUIREMENT_WORDS: Record<string, string> = { yes: "Shown", partially: "Partly shown", no: "Not met", unknown: "Not known yet" };
const COMPETENCY_WORDS: Record<string, string> = { evidenced: "Shown", partially_evidenced: "Partly shown", not_evidenced: "Not shown yet", contradicted: "Goes against it" };

export type FindingChip = { words: string; tone: "good" | "caution" | "critical" | "neutral" };

/**
 * A must-have finding in plain words, with its colour. Red only for a must-have their own words show is not met; a
 * "not met" with nothing quoted counts as not known, and says so.
 */
export function requirementChip(f: { met: string; evidence?: Ref }): FindingChip {
  const s = requirementSeverity(f);
  if (s === 0) return { words: REQUIREMENT_WORDS.no, tone: "critical" };
  if (s === 2) return { words: "Not met, but nothing quoted: counted as not known", tone: "neutral" };
  return { words: REQUIREMENT_WORDS[f.met] ?? f.met.replace(/_/g, " "), tone: s === 1 ? "caution" : s === 4 ? "good" : "neutral" };
}

/** A skill finding in plain words. "Goes against it" is never red: red belongs to a missing must-have. */
export function competencyChip(f: { finding: string; evidence?: Ref }): FindingChip {
  const s = competencySeverity(f);
  if (s === 2) return { words: "Goes against it, but nothing quoted: counted as not known", tone: "neutral" };
  return { words: COMPETENCY_WORDS[f.finding] ?? f.finding.replace(/_/g, " "), tone: s === 1 ? "caution" : s === 4 ? "good" : "neutral" };
}

/** A skill's importance as a tag ("Essential"), or null when the role's labels do not say. */
export function importanceTag(skills: ReadonlyArray<LabelledSkill>, key: string): string | null {
  const imp = skills.find((s) => s.key === key)?.importance;
  return imp ? IMPORTANCE_LABEL[imp] : null;
}
