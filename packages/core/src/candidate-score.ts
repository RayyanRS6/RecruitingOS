import { CANDIDATE_SCORE_BASIS, CANDIDATE_SCORE_OTHER_LABEL, type CandidateScoreRow, type CandidateScoreView, type MatchScore, type RolePacket } from "@ros/contracts";

/**
 * The match score as the candidate sees it after sending (founder decision S7-1; the contract in
 * packages/contracts/src/domain/apply-questions.ts). It is the team's match score (`matchScore`), never a new scoring:
 * the number, its band, and the breakdown, with only the job page's own must-haves named, in the job page's order.
 * Every other requirement the score counts (the skills the team looks for, which are not on the job page, shown or not) is
 * folded into one line, weighted as the score weighs them, so the bars and the number always agree. Null without a number.
 */
export function candidateScoreView(score: MatchScore | null | undefined, packet: Pick<RolePacket, "requirements">): CandidateScoreView | null {
  if (!score || score.score === null || !score.band || !score.bandLabel) return null;
  const publicKeys = packet.requirements.mustHaves.map((m) => m.key);
  const byKey = new Map(score.breakdown.map((c) => [c.key, c]));
  const rows: CandidateScoreRow[] = [];
  for (const m of packet.requirements.mustHaves) {
    const c = byKey.get(m.key);
    if (c?.mustHave) rows.push({ key: m.key, label: m.text, pctMet: c.pctMet, tone: toneOf(c.pctMet), words: c.finding });
  }
  const notPublic = (c: { key: string; mustHave: boolean }) => !c.mustHave || !publicKeys.includes(c.key);
  const others = score.breakdown.filter(notPublic);
  const weight = others.reduce((n, c) => n + c.weightPct, 0) + score.unknown.filter(notPublic).reduce((n, u) => n + u.weightPct, 0);
  const pct = weight > 0 ? Math.round(others.reduce((n, c) => n + c.pctMet * c.weightPct, 0) / weight) : null;
  // Its words say how much was shown (what nothing showed counts at no points), so its bar takes one neutral colour, never the
  // red of a must-have not met (the release review's second reading, 11 November 2026).
  const other: CandidateScoreRow | null = pct === null ? null : { key: "other", label: CANDIDATE_SCORE_OTHER_LABEL, pctMet: pct, tone: "shown", words: `${pct}% shown` };
  const notYetShown = score.unknown.filter((u) => u.mustHave && publicKeys.includes(u.key)).map((u) => packet.requirements.mustHaves.find((m) => m.key === u.key)?.text ?? u.label);
  // R20-9: whether their AI interview is in the number, as the team's label says it.
  const basis = score.interview === "done" ? CANDIDATE_SCORE_BASIS.both : CANDIDATE_SCORE_BASIS.resumeOnly;
  return { score: score.score, band: score.band, bandLabel: score.bandLabel, rows, other, notYetShown, coverage: score.coverage.words, basis, capped: score.capped };
}

/** A must-have bar's colour band: green from 80, amber from 40, red below. */
function toneOf(pct: number): CandidateScoreRow["tone"] {
  return pct >= 80 ? "strong" : pct >= 40 ? "partial" : "short";
}
