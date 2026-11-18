import { z } from "zod";
import type { EvidenceSource } from "./common";

/**
 * The one scoring system. Two numbers, each 0-100, never merged:
 *
 * - The CV score, from the CV reading alone: points earned over all the job's requirements. A must-have weighs 4, a skill
 *   3, 2 or 1 by its importance. Shown earns all of a requirement, partly shown half, anything else nothing; a must-have
 *   their own words show is not met holds the number at 54. The Candidates list ranks by it.
 * - The interview score, from the AI interview's scorecard alone: how many of the interview's own questions were
 *   answered to the job's standard, each question counting once.
 *
 * Both use the same bands and the same four finding words, so a word beside a number means the same wherever it shows.
 * The AI writes findings and quotes; every number and every word here is worked out in code. Candidates are never shown
 * a score.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Importance: how much a skill counts.                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export const Importance = z.enum(["essential", "important", "helpful"]);
export type Importance = z.infer<typeof Importance>;
export const IMPORTANCE_LABEL: Record<Importance, string> = { essential: "Essential", important: "Important", helpful: "Helpful" };

/**
 * The importance a stored skill carries: the label a person picked, or the one the 1-5 weight of an older job version
 * stands for (5 Essential, 3 or 4 Important, 1 or 2 Helpful). A skill with neither is Important.
 */
export function importanceOf(c: { weight?: number | null; importance?: Importance | null }): Importance {
  if (c.importance) return c.importance;
  if (typeof c.weight !== "number") return "important";
  return c.weight >= 5 ? "essential" : c.weight >= 3 ? "important" : "helpful";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Bands: one table for both numbers.                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

export type MatchBand = "very_high" | "high" | "medium" | "low";
/** 85 and up, 70 and up, 55 and up, below: the one band word shown beside a CV score or an interview score. */
export const MATCH_SCORE_BANDS: ReadonlyArray<{ band: MatchBand; min: number; label: string }> = [
  { band: "very_high", min: 85, label: "Very high" },
  { band: "high", min: 70, label: "High" },
  { band: "medium", min: 55, label: "Medium" },
  { band: "low", min: 0, label: "Low" },
];

/** The band of a 0-100 score, or null without one. */
export function matchBand(score: number | null | undefined): { band: MatchBand; label: string } | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const s = Math.min(100, Math.max(0, Math.round(score)));
  const b = MATCH_SCORE_BANDS.find((x) => s >= x.min) ?? MATCH_SCORE_BANDS[MATCH_SCORE_BANDS.length - 1];
  return { band: b.band, label: b.label };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Findings: one set of words for a requirement and for an interview question.                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What the evidence says about one requirement of the job, or about one question of the AI interview. `not_met`: their
 * own quoted words show it is not met. `not_shown`: nothing says either way; it earns nothing and is never read as a no.
 */
export const ScoreFinding = z.enum(["shown", "partly", "not_met", "not_shown"]);
export type ScoreFinding = z.infer<typeof ScoreFinding>;
export const SCORE_FINDING_LABEL: Record<ScoreFinding, string> = { shown: "Shown", partly: "Partly shown", not_met: "Not met", not_shown: "Not shown yet" };
/** How much of a requirement or a question each finding earns, in percent. */
export const FINDING_CREDIT: Record<ScoreFinding, number> = { shown: 100, partly: 50, not_met: 0, not_shown: 0 };

/**
 * A must-have's finding from the CV reading's own answer about it (`requirementFindings[].met`). `quoted`: the reading
 * quoted the candidate's own words and the code found the quote in them. Shown needs a checked quote; shown with nothing
 * quoted counts as partly; "not met" without a checked quote is not known.
 */
export function requirementFinding(met: "yes" | "partially" | "no" | "unknown", quoted: boolean): ScoreFinding {
  if (met === "yes") return quoted ? "shown" : "partly";
  if (met === "partially") return "partly";
  if (met === "no" && quoted) return "not_met";
  return "not_shown";
}

/** A skill's finding from the CV reading's own answer about it (`competencyFindings[].finding`), by the same rule. */
export function skillFinding(finding: "evidenced" | "partially_evidenced" | "not_evidenced" | "contradicted", quoted: boolean): ScoreFinding {
  if (finding === "evidenced") return quoted ? "shown" : "partly";
  if (finding === "partially_evidenced") return "partly";
  if (finding === "contradicted" && quoted) return "not_met";
  return "not_shown";
}

/** An interview question's finding from the scorecard's own answer about it (`questionFindings[].meetsModelAnswer`). */
export function questionFinding(meets: "yes" | "partially" | "no" | "unknown"): ScoreFinding {
  return meets === "yes" ? "shown" : meets === "partially" ? "partly" : meets === "no" ? "not_met" : "not_shown";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Which requirements the CV score counts.                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** A must-have their own words show is not met holds the CV score at this number. */
export const MISSING_MUST_HAVE_CAP = 54;
/** How much each kind of requirement counts: must-haves most, then the skills by their importance. */
export const MATCH_WEIGHT = { must_have: 4, essential: 3, important: 2, helpful: 1 } as const;

/** The weight of a requirement: a must-have 4, a skill by its importance (Essential 3, Important 2, Helpful 1). */
export const matchWeightOf = (c: { mustHave: boolean; importance?: Importance | null }): number => (c.mustHave ? MATCH_WEIGHT.must_have : MATCH_WEIGHT[c.importance ?? "helpful"]);

/**
 * A name as the twin rule compares it: case, accents and punctuation aside. Letters of any script keep their marks, and
 * digits, "+" and "#" count, so "C++" is not "C#".
 */
const sameWords = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{M}\p{N}+#]+/gu, " ").trim();

/**
 * A skill named exactly as one of the job's must-haves. The CV score counts the two once, as the must-have. Exact words
 * only, case, accents and punctuation aside: "Digital radiography and intraoral scanning" stays a skill of its own.
 */
export function repeatsMustHave(skill: { name: string }, mustHaves: ReadonlyArray<{ text: string }>): boolean {
  const name = sameWords(skill.name);
  return !!name && mustHaves.some((m) => sameWords(m.text) === name);
}

/** The skills the CV score counts on a job: every skill but one named exactly like a must-have. */
export function skillsInScore<C extends { name: string }>(packet: { requirements: { mustHaves: ReadonlyArray<{ text: string }> }; competencies: readonly C[] }): C[] {
  return packet.competencies.filter((c) => !repeatsMustHave(c, packet.requirements.mustHaves));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The sums.                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export type WeighedRequirement = { weight: number; finding: ScoreFinding; mustHave: boolean };

/**
 * The CV score's sums over every requirement of the job, in the order given: points earned over the points of all of
 * them. `score` is null only when there is nothing to weigh (the job lists no requirement). `held`: a must-have shown
 * not met kept the number at `MISSING_MUST_HAVE_CAP`. Each requirement's share of the score and the points it lost come
 * back too. Moving any one finding up (not met, not shown, partly, shown) never lowers the score.
 */
export function weighRequirements(items: readonly WeighedRequirement[]): { score: number | null; held: boolean; parts: Array<{ share: number; lost: number }> } {
  const total = items.reduce((n, r) => n + r.weight, 0);
  if (!total) return { score: null, held: false, parts: items.map(() => ({ share: 0, lost: 0 })) };
  let lost = 0;
  const parts = items.map((r) => {
    const share = (100 * r.weight) / total;
    const exactLost = share * (1 - FINDING_CREDIT[r.finding] / 100);
    lost += exactLost;
    return { share, lost: exactLost };
  });
  // to six places first, so the same sum reached in another order rounds the same way at a half point
  const raw = Math.round(Number((100 - lost).toFixed(6)));
  const held = items.some((r) => r.mustHave && r.finding === "not_met") && raw > MISSING_MUST_HAVE_CAP;
  const score = Math.min(100, Math.max(0, held ? MISSING_MUST_HAVE_CAP : raw));
  return { score, held, parts };
}

/**
 * The interview score's sum: each question the interview asked counts once, answered to the job's standard 100%, partly
 * 50%, otherwise nothing. Null when the interview asked nothing that is scored.
 */
export function interviewSum(findings: readonly ScoreFinding[]): number | null {
  if (!findings.length) return null;
  const earned = findings.reduce((n, f) => n + FINDING_CREDIT[f], 0);
  return Math.round(Number((earned / findings.length).toFixed(6)));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The CV score as the team reads it.                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Why a person has no CV score. `being_read`: the CV is being read now; `unreadable`: the file has no text a reading
 * could use; `not_scored`: the reading could not be made; `ai_used_up`: the plan's AI help is used up, and they are read
 * when it returns; `locked`: past the plan's candidates per job (such a person is never a row: only a count and a card).
 */
export const CvNoScore = z.enum(["being_read", "unreadable", "not_scored", "ai_used_up", "locked"]);
export type CvNoScore = z.infer<typeof CvNoScore>;
export const CV_NO_SCORE_LABEL: Record<CvNoScore, string> = {
  being_read: "Reading the resume",
  unreadable: "Resume could not be read",
  not_scored: "Not scored yet",
  ai_used_up: "Not scored: your plan's AI help is used up",
  locked: "Locked",
};

/** One requirement of the job as the sums take it: what it is, what the CV reading found, and the quote it rests on. */
export type ScoredRequirement = {
  key: string;
  label: string;
  mustHave: boolean;
  /** For a skill; null for a must-have. */
  importance: Importance | null;
  finding: ScoreFinding;
  /** Their own words, checked against the CV or the form's answers; null without one. */
  quote: string | null;
  /** Where the quote is from: the CV (`resume`) or the application form's answers (`application`). */
  source: EvidenceSource | null;
};
/** The same, as the breakdown lists it: with the finding's word and this requirement's share of the score in points out of 100. */
export type ScoreRequirement = ScoredRequirement & { findingLabel: string; weightPct: number };

export type CvScore = {
  /** 0-100, or null with `noScore` saying why. */
  score: number | null;
  band: MatchBand | null;
  bandLabel: string | null;
  noScore: CvNoScore | null;
  noScoreLabel: string | null;
  /** How many of the job's must-haves the CV shows, from the same list as the number. */
  mustHaves: { shown: number; total: number };
  /** "3 of 4 must-haves shown"; null without a reading or without must-haves. */
  mustHaveLine: string | null;
  /** A must-have shown not met kept the number at 54. */
  held: boolean;
  missingMustHaves: Array<{ key: string; label: string; quote: string | null }>;
  /** "Missing a must-have: Active RDA licence"; null when none is shown not met. */
  missingLine: string | null;
  /** Every requirement the number counts, the must-haves first, each in the job's own order. */
  requirements: ScoreRequirement[];
  /** Scored against an earlier version of the job (its requirements changed since and the new reading is not in yet). */
  earlierVersion: boolean;
  earlierVersionLine: string | null;
};

export const EARLIER_VERSION_LINE = "Scored against an earlier version of the job";

export function mustHaveLine(shown: number, total: number): string {
  return `${shown} of ${total} must-have${total === 1 ? "" : "s"} shown`;
}

export function missingMustHaveLine(labels: readonly string[]): string {
  return `Missing a must-have: ${labels.join("; ")}`;
}

/**
 * The CV score of one application, from the findings of its newest CV reading. `items`: every must-have of the job, then
 * every skill the score counts (`skillsInScore`), each with its finding (`requirementFinding`, `skillFinding`). The
 * must-have line and the number come from this one list, so they can never disagree.
 */
export function cvScoreOf(items: readonly ScoredRequirement[], opts: { earlierVersion?: boolean } = {}): CvScore {
  const { score, held, parts } = weighRequirements(items.map((r) => ({ weight: matchWeightOf(r), finding: r.finding, mustHave: r.mustHave })));
  const musts = items.filter((r) => r.mustHave);
  const shown = musts.filter((r) => r.finding === "shown").length;
  const missing = musts.filter((r) => r.finding === "not_met").map((r) => ({ key: r.key, label: r.label, quote: r.quote }));
  const band = matchBand(score);
  return {
    score,
    band: band?.band ?? null,
    bandLabel: band?.label ?? null,
    noScore: score === null ? "not_scored" : null,
    noScoreLabel: score === null ? CV_NO_SCORE_LABEL.not_scored : null,
    mustHaves: { shown, total: musts.length },
    mustHaveLine: musts.length ? mustHaveLine(shown, musts.length) : null,
    held,
    missingMustHaves: missing,
    missingLine: missing.length ? missingMustHaveLine(missing.map((m) => m.label)) : null,
    requirements: items.map((r, i) => ({ ...r, findingLabel: SCORE_FINDING_LABEL[r.finding], weightPct: Math.round(parts[i].share) })),
    earlierVersion: !!opts.earlierVersion,
    earlierVersionLine: opts.earlierVersion ? EARLIER_VERSION_LINE : null,
  };
}

/** The CV score of someone who has none, with the reason. */
export function noCvScore(reason: CvNoScore): CvScore {
  return { score: null, band: null, bandLabel: null, noScore: reason, noScoreLabel: CV_NO_SCORE_LABEL[reason], mustHaves: { shown: 0, total: 0 }, mustHaveLine: null, held: false, missingMustHaves: [], missingLine: null, requirements: [], earlierVersion: false, earlierVersionLine: null };
}

/** What a row of the Candidates list carries of the CV score: the number or why there is none, and its two lines. */
export type CvScoreSummary = Pick<CvScore, "score" | "band" | "bandLabel" | "noScore" | "noScoreLabel" | "mustHaveLine" | "missingLine" | "earlierVersion">;

export function cvScoreSummary(s: CvScore): CvScoreSummary {
  return { score: s.score, band: s.band, bandLabel: s.bandLabel, noScore: s.noScore, noScoreLabel: s.noScoreLabel, mustHaveLine: s.mustHaveLine, missingLine: s.missingLine, earlierVersion: s.earlierVersion };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The interview score as the team reads it.                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Why a sent AI interview has no score. `being_scored`: the scorecard is being written; `ai_used_up`: the plan's AI help
 * is used up (the answers are there to read, and it is scored when the help returns); `not_scored`: the scorecard could
 * not be written.
 */
export const InterviewNoScore = z.enum(["being_scored", "not_scored", "ai_used_up"]);
export type InterviewNoScore = z.infer<typeof InterviewNoScore>;
export const INTERVIEW_NO_SCORE_LABEL: Record<InterviewNoScore, string> = {
  being_scored: "Scoring the AI interview",
  not_scored: "AI interview could not be scored",
  ai_used_up: "Not scored: your plan's AI help is used up",
};

/** One question the interview asked, as the per-question table lists it. The closing question is never one of them. */
export type InterviewQuestionResult = {
  key: string;
  question: string;
  finding: ScoreFinding;
  findingLabel: string;
  /** Their own words from the interview, checked against what they sent; null without a quote. */
  quote: string | null;
  /** The scorecard's one plain sentence on what the answer showed; null when it gave none. */
  note: string | null;
};

export type InterviewScore = {
  /** 0-100, or null with `noScore` saying why. */
  score: number | null;
  band: MatchBand | null;
  bandLabel: string | null;
  noScore: InterviewNoScore | null;
  noScoreLabel: string | null;
  /** How many questions were answered to the job's standard, of how many the interview asked. */
  answered: { met: number; total: number };
  /** "4 of 6 questions answered to the job's standard"; null without a scorecard. */
  answeredLine: string | null;
  /** The per-question table, in the order the interview asked. */
  questions: InterviewQuestionResult[];
};

export function answeredLine(met: number, total: number): string {
  return `${met} of ${total} question${total === 1 ? "" : "s"} answered to the job's standard`;
}

/** The interview score of one sent AI interview, from its scorecard's per-question findings (`questionFinding`). */
export function interviewScoreOf(questions: ReadonlyArray<Omit<InterviewQuestionResult, "findingLabel">>): InterviewScore {
  const score = interviewSum(questions.map((q) => q.finding));
  const band = matchBand(score);
  const met = questions.filter((q) => q.finding === "shown").length;
  return {
    score,
    band: band?.band ?? null,
    bandLabel: band?.label ?? null,
    noScore: score === null ? "not_scored" : null,
    noScoreLabel: score === null ? INTERVIEW_NO_SCORE_LABEL.not_scored : null,
    answered: { met, total: questions.length },
    answeredLine: questions.length ? answeredLine(met, questions.length) : null,
    questions: questions.map((q) => ({ ...q, findingLabel: SCORE_FINDING_LABEL[q.finding] })),
  };
}

/** The interview score of a sent AI interview that has none, with the reason. */
export function noInterviewScore(reason: InterviewNoScore): InterviewScore {
  return { score: null, band: null, bandLabel: null, noScore: reason, noScoreLabel: INTERVIEW_NO_SCORE_LABEL[reason], answered: { met: 0, total: 0 }, answeredLine: null, questions: [] };
}

/** What a row of the Candidates list carries of the interview score. */
export type InterviewScoreSummary = Pick<InterviewScore, "score" | "band" | "bandLabel" | "noScore" | "noScoreLabel" | "answeredLine">;

export function interviewScoreSummary(s: InterviewScore): InterviewScoreSummary {
  return { score: s.score, band: s.band, bandLabel: s.bandLabel, noScore: s.noScore, noScoreLabel: s.noScoreLabel, answeredLine: s.answeredLine };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Ranking. The server orders every list; a screen shows the rows in the order it gets them.                      */
/* ------------------------------------------------------------------------------------------------------------ */

type Ranked = { cvScore: { score: number | null }; interviewScore?: { score: number | null } | null; appliedAt: string };

const higherFirst = (a: number | null | undefined, b: number | null | undefined): number => {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
};
const earlierFirst = (a: string, b: string): number => Date.parse(a) - Date.parse(b);

/** The order of every tab but Interviewed: the CV score, highest first; people with no score last; then who applied first. */
export function byCvScore(a: Ranked, b: Ranked): number {
  return higherFirst(a.cvScore.score, b.cvScore.score) || earlierFirst(a.appliedAt, b.appliedAt);
}

/** The order of the Interviewed tab: the interview score, highest first and none last; then the CV score; then who applied first. */
export function byInterviewScore(a: Ranked, b: Ranked): number {
  return higherFirst(a.interviewScore?.score, b.interviewScore?.score) || byCvScore(a, b);
}
