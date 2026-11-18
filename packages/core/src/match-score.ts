import { CHAT_WRAP_KEY, cvScoreOf, hasCheckedQuote, interviewScoreOf, questionFinding, requirementFinding, skillFinding, skillsInScore, type CvScore, type EvidenceAssessment, type InterviewScore, type RolePacket, type ScoredRequirement, type ScreenAssessment } from "@ros/contracts";

/**
 * The two scores of one application, each from one stored reading and worked out by the contracts' functions: the CV
 * score from the newest CV reading, the interview score from the newest scorecard. Pure: the list, the panel and the
 * evals read the same functions over the same rows. Nothing here reads a verdict a model wrote.
 */

type Requirements = Pick<RolePacket, "requirements" | "competencies">;

/**
 * The CV score from a CV reading and the job version it was read against: every must-have of that version, then every
 * skill the score counts, each in the job's own order with the reading's finding and its checked quote.
 * `earlierVersion`: the job's requirements changed since this reading.
 */
export function cvScoreFromReading(reading: Pick<EvidenceAssessment, "requirementFindings" | "competencyFindings">, packet: Requirements, opts: { earlierVersion?: boolean } = {}): CvScore {
  const quoteOf = (e: { quote?: string; unquoted?: boolean; source: ScoredRequirement["source"] } | undefined) => (e && hasCheckedQuote(e) ? { quote: e.quote?.trim() ?? null, source: e.source } : { quote: null, source: null });
  const mustHaves = packet.requirements.mustHaves.map((m): ScoredRequirement => {
    const found = (reading.requirementFindings ?? []).find((f) => f.requirementKey === m.key);
    return { key: m.key, label: m.text, mustHave: true, importance: null, finding: requirementFinding(found?.met ?? "unknown", hasCheckedQuote(found?.evidence)), ...quoteOf(found?.evidence) };
  });
  const skills = skillsInScore(packet).map((c): ScoredRequirement => {
    const found = (reading.competencyFindings ?? []).find((f) => f.competencyKey === c.key);
    return { key: c.key, label: c.name, mustHave: false, importance: c.importance, finding: skillFinding(found?.finding ?? "not_evidenced", hasCheckedQuote(found?.evidence)), ...quoteOf(found?.evidence) };
  });
  return cvScoreOf([...mustHaves, ...skills], opts);
}

/** Whether two versions of a job list the same requirements for the CV score: the same must-haves and skills, worded and weighted the same. */
export function sameRequirements(a: Requirements, b: Requirements): boolean {
  const key = (p: Requirements) => JSON.stringify([p.requirements.mustHaves.map((m) => [m.key, m.text.trim()]), skillsInScore(p).map((c) => [c.key, c.name.trim(), c.importance])]);
  return key(a) === key(b);
}

/**
 * The interview score from a sent AI interview's scorecard: one entry per question the interview asked (`asked`, in the
 * order asked), never the closing question. A question the scorecard says nothing about counts as not shown.
 */
export function interviewScoreFromScorecard(card: Pick<ScreenAssessment, "questionFindings">, asked: ReadonlyArray<{ key: string; question: string }>): InterviewScore {
  return interviewScoreOf(
    asked.filter((q) => q.key !== CHAT_WRAP_KEY).map((q) => {
      const found = (card.questionFindings ?? []).find((f) => f.questionKey === q.key);
      return { key: q.key, question: q.question, finding: questionFinding(found?.meetsModelAnswer ?? "unknown"), quote: hasCheckedQuote(found?.evidence) ? found?.evidence?.quote?.trim() ?? null : null, note: found?.finding?.trim() || null };
    }),
  );
}
