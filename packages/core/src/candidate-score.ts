import { CANDIDATE_SCORE_BASIS, CANDIDATE_SCORE_OTHER_LABEL, type CandidateScoreRow, type CandidateScoreView, type MatchScore, type RolePacket } from "@ros/contracts";

/**
 * The match score as the candidate sees it after sending (founder decision S7-1; the contract in
 * packages/contracts/src/domain/apply-questions.ts). It is the team's match score (`matchScore`), never a new scoring:
 * the number, its band, and the breakdown, with only the job page's own must-haves named, in the job page's order.
 * Every other requirement the score counted (the skills the team looks for, which are not on the job page) is folded
 * into one line, weighted as the score weighs them. Null without a number.
 */
export function candidateScoreView(score: MatchScore | null | undefined, packet: Pick<RolePacket, "requirements">): CandidateScoreView | null {
  if (!score || score.score === null || !score.band || !score.bandLabel) return null;
  const publicKeys = packet.requirements.mustHaves.map((m) => m.key);
  const byKey = new Map(score.breakdown.map((c) => [c.key, c]));
  const rows: CandidateScoreRow[] = [];
  // Each bar shows the share the number counted (`countedPct`: a partly shown requirement can count for more than half,
  // so the bars and the number always agree), else the share met.
  const counted = (c: MatchScore["breakdown"][number]) => c.countedPct ?? c.pctMet;
  for (const m of packet.requirements.mustHaves) {
    const c = byKey.get(m.key);
    if (c?.mustHave) rows.push({ key: m.key, label: m.text, pctMet: counted(c), tone: toneOf(counted(c)), words: c.finding });
  }
  const others = score.breakdown.filter((c) => !c.mustHave || !publicKeys.includes(c.key));
  const weight = others.reduce((n, c) => n + c.weightPct, 0);
  const pct = weight > 0 ? Math.round(others.reduce((n, c) => n + counted(c) * c.weightPct, 0) / weight) : null;
  const other: CandidateScoreRow | null = pct === null ? null : { key: "other", label: CANDIDATE_SCORE_OTHER_LABEL, pctMet: pct, tone: toneOf(pct), words: `${pct}% shown` };
  const notYetShown = score.unknown.filter((u) => u.mustHave && publicKeys.includes(u.key)).map((u) => packet.requirements.mustHaves.find((m) => m.key === u.key)?.text ?? u.label);
  // R20-9: whether their AI interview is in the number, as the team's label says it.
  const basis = score.interview === "done" ? CANDIDATE_SCORE_BASIS.both : CANDIDATE_SCORE_BASIS.resumeOnly;
  return { score: score.score, band: score.band, bandLabel: score.bandLabel, rows, other, notYetShown, coverage: score.coverage.words, basis, capped: score.capped };
}

/** The bar's colour band: green from 80, amber from 40, red below. */
function toneOf(pct: number): CandidateScoreRow["tone"] {
  return pct >= 80 ? "strong" : pct >= 40 ? "partial" : "short";
}
