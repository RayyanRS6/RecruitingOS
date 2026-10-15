import { inArray, eq } from "drizzle-orm";
import { importanceOf, type CompanyQuestions, type Confidence, type EligibilityResult, type Evidence, type EvidenceAssessment, type EvidenceSource, type Overall, type ResumeExtraction, type RolePacket } from "@ros/contracts";
import { resumeExtractPrompt, runPromptDetached, triageAssessPrompt, type AiRuntime, type RunOutcome, type TriageInput } from "@ros/ai";
import { applicationAnswerSentences, matchScore, quickQuestionsOf, scoredSkill } from "@ros/core";
import { aiRuns, withTenant, type Db, type Queryable } from "@ros/db";
import { SCORING_VIEW_VERSION, restoreQuotes, scoringView, withoutPlaceholders, type ScoringIdentity, type ScoringView } from "./scoring-view";

export { PLACEHOLDER as SCORING_PLACEHOLDER, SCORING_VIEW_VERSION, hasPlaceholder, restoreQuotes, scoringView, withoutPlaceholders, type HiddenKind, type ScoringIdentity, type ScoringView } from "./scoring-view";

/**
 * Resume extraction (Triage agent, Slice 1). Quotes are verified against the source text in code:
 * any quote that is not a substring of the resume is dropped and the entry is marked as unquoted, so
 * nothing the model invented can be presented as evidence. The model is called with no transaction open;
 * the run is recorded in its own short one.
 */
export async function extractResume(db: Db, ai: AiRuntime, input: { companyId: string; workflowRunId?: string | null; text: string; filename?: string; documentId: string }): Promise<RunOutcome<ResumeExtraction>> {
  const out = await runPromptDetached(db, ai, resumeExtractPrompt, { text: input.text, filename: input.filename }, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { documentId: input.documentId, chars: input.text.length } });
  if (!out.ok) return out;
  return { ...out, output: verifyQuotes(out.output, input.text) };
}

export function verifyQuotes(ex: ResumeExtraction, source: string): ResumeExtraction {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = norm(source);
  const check = (quote?: string) => (quote && src.includes(norm(quote)) ? quote : undefined);
  return {
    ...ex,
    positions: ex.positions.map((p) => ({ ...p, quote: check(p.quote) })),
    education: ex.education.map((e) => ({ ...e, quote: check(e.quote) })),
    licenses: ex.licenses.map((l) => ({ ...l, quote: check(l.quote) })),
    certifications: ex.certifications.map((c) => ({ ...c, quote: check(c.quote) })),
  };
}

/**
 * Inputs to the evidence-based assessment; the workflow assembles them from the system of record. `identity` is who the
 * application is from (the candidate's record), used only to hide those details from the reading (`scoringInput`).
 * Earlier applications to the company are not an input (founder decision D-04 = C): the team sees them on the
 * candidate's page; the reading never does.
 */
export type AssessInput = {
  companyId: string;
  workflowRunId?: string | null;
  applicationId: string;
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string | null;
  /**
   * `quick`: the answers to the company's quick questions (`applications.answers.quick`, Wave S7), when there are any.
   * `fromCv`: the form fields whose answer the form suggested from the résumé and the candidate left as it was
   * (`applications.answers.fromCv`): never read as the candidate's own words (`SUGGESTED_FROM_RESUME`).
   */
  applicationAnswers: { eligibility: Record<string, unknown>; quick?: Record<string, string> | null; noResumeSummary?: string; fromCv?: readonly string[] | null };
  eligibility: EligibilityResult | null;
  identity: ScoringIdentity;
  /**
   * A person kept the candidate in after an eligibility answer did not match ("Keep them in", or "Review anyway" after
   * an eligibility decline): the reading is told so, and is not sent the answers that person set aside.
   */
  eligibilityKeptIn?: boolean;
};

/**
 * The words the job is judged on, never hidden as a single name (scoring-view.ts `ScoringIdentity.keep`): the job's
 * title, must-haves, competencies and places, and the résumé's own job titles, employers and skills. Every part is read
 * with care: an older or partial packet may leave one out.
 */
export function jobWords(packet: Partial<Pick<RolePacket, "identity" | "requirements" | "competencies">> | null | undefined, extraction?: Pick<ResumeExtraction, "positions" | "skills"> | null): string[] {
  const p = packet ?? {};
  const out: string[] = [];
  if (p.identity?.title) out.push(p.identity.title);
  for (const l of p.identity?.locations ?? []) out.push([l.city, l.region].filter(Boolean).join(" "));
  for (const m of p.requirements?.mustHaves ?? []) out.push(m.text);
  for (const c of p.competencies ?? []) out.push(c.name ?? "");
  for (const pos of extraction?.positions ?? []) out.push(pos.title ?? "", pos.employer ?? "");
  for (const s of extraction?.skills ?? []) out.push(s);
  return out.filter(Boolean);
}

/**
 * What the résumé reading is given (D-04 = C): the résumé, the written answer, the answers on the form and the extraction
 * as the scoring view shows them (name, email, phone, street address and links replaced by placeholders), with the
 * scoring view itself, which maps a quote back to the original words and counts what was hidden. Since Wave S7 the
 * answers on the form go to the model as plain sentences, the question and the candidate's answer
 * (`formAnswerLines`), never as the form's field names: the fairness run of 15 Oct 2026 found a reading quoting
 * '"rdh_license":"yes"'. The sentences are the candidate's own words for the evidence rules (`assessmentSources`).
 */
export function scoringInput(input: Pick<AssessInput, "packet" | "extraction" | "resumeText" | "applicationAnswers" | "eligibility" | "identity" | "eligibilityKeptIn">): { promptInput: TriageInput; view: ScoringView } {
  const view = scoringView({ ...input.identity, fullName: input.identity.fullName ?? input.extraction?.fullName ?? null, keep: [...(input.identity.keep ?? []), ...jobWords(input.packet, input.extraction)] });
  const { noResumeSummary } = input.applicationAnswers;
  const kept = keptInView(input);
  const answers = view.deep(kept.answers);
  const promptInput: TriageInput = {
    packet: input.packet,
    extraction: input.extraction ? view.deep(input.extraction) : null,
    resumeText: input.resumeText === null ? null : view.text(input.resumeText),
    applicationAnswers: { eligibility: answers, ...(noResumeSummary === undefined ? {} : { noResumeSummary: view.text(noResumeSummary) }) },
    // the questions are the company's words; the answers go through the scoring view once, above
    answerSentences: formAnswerLines(input.packet, { eligibility: answers, quick: input.applicationAnswers.quick ? view.deep(input.applicationAnswers.quick) : null, fromCv: input.applicationAnswers.fromCv }),
    eligibility: kept.eligibility,
    ...(kept.keptIn ? { eligibilityKeptIn: true } : {}),
  };
  return { promptInput, view };
}

/** How a form answer suggested from the résumé, and left as it was, is put to the reading: never the candidate's own words. */
export const SUGGESTED_FROM_RESUME = "Suggested from the résumé, left as is (not the candidate's own words): ";

/** What `formAnswerLines` reads of the role: its eligibility questions and the company's quick questions. */
type QuestionsOf = { requirements: { eligibility?: RolePacket["requirements"]["eligibility"] }; companyQuestions?: CompanyQuestions | null };

/** An answer on its own, in plain words: free text as written, ticked days joined; null for a bare yes or no, or nothing. */
function ownAnswer(value: unknown): string | null {
  const text = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").join(", ") : typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const t = text.trim();
  return !t || /^(yes|y|no|n|true|false)$/i.test(t) ? null : t;
}

/**
 * The candidate's answers on the form as the résumé reading reads them, one line each (Wave S7): every answered
 * question of "Questions from <Company>" as a sentence ("Do you hold an active CA RDH license? Yes.", `answerSentence`
 * in @ros/core, the same wording the chat and Review & send use, so a quote of one is always found again); then any
 * answer to a question the role no longer asks, as the candidate wrote it, when it says more than a bare yes or no.
 * Never a field name. An answer the form suggested from the résumé and the candidate left as it was (`fromCv`) is
 * marked so (`SUGGESTED_FROM_RESUME`): the reading weighs it as the résumé's, with the résumé's evidence rules, and the
 * quote check never finds it as the candidate's own words (`assessmentSources`).
 */
export function formAnswerLines(packet: QuestionsOf | null | undefined, answers: { eligibility?: Record<string, unknown> | null; quick?: Record<string, string> | null; fromCv?: readonly string[] | null }): string[] {
  const role = { requirements: { eligibility: packet?.requirements?.eligibility ?? [] }, companyQuestions: packet?.companyQuestions ?? null };
  const suggested = new Set(answers.fromCv ?? []);
  const fieldOf = (s: { key: string; source: string }) => (s.source === "eligibility" ? `elig_${s.key}` : `q_${s.key}`);
  const sentences = applicationAnswerSentences(role, answers).map((s) => (suggested.has(fieldOf(s)) ? `${SUGGESTED_FROM_RESUME}${s.sentence}` : s.sentence));
  const asked = new Set(quickQuestionsOf(role).map((q) => `${q.source}:${q.key}`));
  const others = [
    ...Object.entries(answers.eligibility ?? {}).filter(([k]) => !asked.has(`eligibility:${k}`)),
    ...Object.entries(answers.quick ?? {}).filter(([k]) => !asked.has(`company:${k}`)),
  ]
    .map(([, v]) => ownAnswer(v))
    .filter((v): v is string => v !== null);
  return [...sentences, ...others];
}

/**
 * The eligibility side of the reading's input after a person's "keep them in" (known bug 30): the result reads as
 * passed and the answers that person set aside are not sent, so the model never reads someone the team kept in as
 * having failed. Without an override, the input as it was.
 */
function keptInView(input: Pick<AssessInput, "applicationAnswers" | "eligibility" | "eligibilityKeptIn">): { answers: Record<string, unknown>; eligibility: EligibilityResult | null; keptIn: boolean } {
  const answers = input.applicationAnswers.eligibility;
  if (!input.eligibilityKeptIn) return { answers, eligibility: input.eligibility, keptIn: false };
  const setAside = new Set((input.eligibility?.failedRules ?? []).map((f) => f.key));
  return {
    answers: Object.fromEntries(Object.entries(answers).filter(([k]) => !setAside.has(k))),
    eligibility: input.eligibility ? { ...input.eligibility, passed: true, failedRules: [] } : null,
    keptIn: true,
  };
}

/**
 * How many times an application is read. The fairness run on Haiku 5.5 (14 Oct 2026) showed one reading of the same
 * résumé moving a competency between "evidenced" and "partially evidenced", and so the score by 5 to 11 points; the
 * middle answer of three readings (`combineReadings`) holds still. The three run side by side, about a cent in all.
 */
export const TRIAGE_READINGS = 3;

/** What `assessmentSources` may be given beyond the texts: the role and the eligibility side, or the reading's own input. */
type SourcesInput = Pick<AssessInput, "resumeText" | "applicationAnswers"> & { packet?: QuestionsOf | null; answerSentences?: readonly string[] } & Partial<Pick<AssessInput, "eligibility" | "eligibilityKeptIn">>;

/**
 * The texts a résumé reading may quote, by source, for the quote check. The application side is the candidate's own
 * answers only, one per line: never the form's field names or JSON around them, so a quote such as
 * `rdh_license":"yes` (a self-reported box, whose key supplies the words) is not found and is no evidence. With the
 * role (or the reading's input, which carries the sentences it was sent) the answers are the sentences the reading was
 * given (`formAnswerLines`, Wave S7), so a quote of one ("Do you hold an active CA RDH license? Yes.") is the candidate's
 * own words; an answer a person set aside ("keep them in") is not among them.
 */
export function assessmentSources(input: SourcesInput): Partial<Record<EvidenceSource, string>> {
  const answers = input.answerSentences
    ? [...input.answerSentences]
    : input.packet
      ? formAnswerLines(input.packet, { eligibility: keptInView({ applicationAnswers: input.applicationAnswers, eligibility: input.eligibility ?? null, eligibilityKeptIn: input.eligibilityKeptIn }).answers, quick: input.applicationAnswers.quick, fromCv: input.applicationAnswers.fromCv })
      : Object.values(input.applicationAnswers.eligibility ?? {}).map((v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v)));
  return {
    resume: input.resumeText ?? "",
    // an answer suggested from the résumé and left as it was is the résumé's evidence, never a quote of the candidate's own
    application: [input.applicationAnswers.noResumeSummary ?? "", ...answers.filter((a) => !a.startsWith(SUGGESTED_FROM_RESUME))].join("\n"),
    candidate_statement: input.applicationAnswers.noResumeSummary ?? "",
  };
}

/**
 * Evidence-based assessment (Triage agent, Slice 2). The model reads the application `TRIAGE_READINGS` times; code
 * verifies every quote against the source text and discards any claim whose quote cannot be found, so nothing invented
 * reaches the owner, then keeps the middle answer of the readings for each finding.
 */
export async function assessApplication(db: Db, ai: AiRuntime, input: AssessInput): Promise<RunOutcome<EvidenceAssessment>> {
  const { promptInput, view } = scoringInput(input);
  // The record says which view the reading used and how many details it hid: counts only, never the values.
  const inputRef = { applicationId: input.applicationId, resumeChars: input.resumeText?.length ?? 0, hasExtraction: !!input.extraction, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() };
  const read = (reading: number) => runPromptDetached(db, ai, triageAssessPrompt, promptInput, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { ...inputRef, reading } });
  const runs = await Promise.all(Array.from({ length: TRIAGE_READINGS }, (_, i) => read(i + 1)));
  // A reading lost to an outage is asked once more; one still lost fails the step, which the engine retries, rather than
  // leaving this applicant with fewer readings than the next.
  const settled = await Promise.all(runs.map((r, i) => (!r.ok && r.reason === "error" ? read(i + 1) : r)));
  const outage = settled.find((r) => !r.ok && r.reason === "error");
  if (outage) return outage;
  const out = readingsOutcome(settled, view, input);
  await linkReadingRuns(db, input.companyId, out, settled);
  return out;
}

/**
 * The readings as the team sees them, combined into the middle answer, then settled (`triageSettlement`: the skill floor
 * of Wave S9 round 4, the overall reading and the recommendation). Quotes are checked against the ORIGINAL words,
 * and shown as the candidate wrote them: one the model wrote around a placeholder is mapped back first
 * (`restoreReadingQuotes`); one that cannot be fails the check. The model's own words (summary, claims, unknowns) keep no
 * placeholder either: "[name]" reads "the candidate". A skill the role checks in the interviews only is left out of the
 * reading (the prompt does not list it; a finding the model wrote anyway is dropped). The flags about the résumé itself
 * are the readings' and the extraction's, not only the kept reading's (`withResumeFlags`). Wave S9 round 4: a skill one
 * reading of three showed on a checked quote of the candidate's own work is partly shown, never more; never over a
 * verified "contradicted"; never from a dated job line or a yes/no answer on the form; never for a must-have
 * (`skillFloor`, read from the same checked texts as the quotes); the scorecard is not affected. Shared with the
 * fairness evals (packages/evals), so they check exactly what the app does after the model has answered.
 */
export function readingsOutcome(readings: ReadonlyArray<RunOutcome<Reading>>, view: Pick<ScoringView, "restore">, input: Pick<AssessInput, "resumeText" | "applicationAnswers" | "packet"> & Partial<Pick<AssessInput, "eligibility" | "eligibilityKeptIn" | "extraction">>): RunOutcome<Reading> {
  const sources = assessmentSources(input);
  const checked = readings.map((r) => (r.ok ? { ...r, output: withoutInterviewSkills(withoutPlaceholders(restoreReadingQuotes(r.output, view, sources)), input.packet) } : r));
  const out = combineOutcomes(checked, sources, credentialMustHaves(input.packet), findingSubjects(input.packet), triageSettlement(input.packet, input, sources));
  return out.ok ? { ...out, output: withResumeFlags(out.output, checked.flatMap((r) => (r.ok ? [r.output] : [])), input.extraction ?? null) } : out;
}

/** The flags a reading or the résumé's extraction raises about the résumé itself, in a fixed order (the code adds others, such as "unverified_quote"). */
const RESUME_FLAGS = ["possible_ai_generated", "date_inconsistency", "contradiction", "missing_dates"] as const;
/** A flag the extraction raised, in the code's words: the extraction's own words can name the candidate, which a reading's never do. */
const RESUME_FLAG_WORDS: Record<(typeof RESUME_FLAGS)[number], string> = {
  possible_ai_generated: "parts of the résumé read like generated or template text (found when the résumé was read for its facts; the Résumé tab says more)",
  date_inconsistency: "the dates in the résumé do not agree (found when the résumé was read for its facts; the Résumé tab says more)",
  contradiction: "the résumé says two things that do not agree (found when the résumé was read for its facts; the Résumé tab says more)",
  missing_dates: "the résumé leaves out dates (found when the résumé was read for its facts; the Résumé tab says more)",
};

/**
 * The flags about the résumé itself on the reading the team sees (Wave S9 round 2): the kept reading's own, plus each
 * kind that most of the readings raised or that the résumé's extraction raised (the reading is given the extraction's
 * flags). The words of the kept reading come from one reading (`combineReadings`), so a flag two readings of three raised,
 * or one the extraction found ("Lorem ipsum" in a résumé), was lost whenever that one reading left it out: the real-model
 * run of 15 Oct 2026 (round 1) showed an AI-written résumé with no flag. A flag is for a person to look at and never
 * moves the overall reading, the score or the recommendation (docs/11). The same whatever order the readings came in.
 */
export function withResumeFlags(kept: Reading, readings: readonly Pick<Reading, "anomalies">[], extraction: Pick<ResumeExtraction, "anomalies"> | null): Reading {
  const listed = new Set(kept.anomalies.map((a) => a.kind));
  const added: Reading["anomalies"] = [];
  for (const kind of RESUME_FLAGS) {
    if (listed.has(kind)) continue;
    const raised = readings.flatMap((r) => r.anomalies.filter((a) => a.kind === kind).slice(0, 1)).sort((a, b) => a.detail.localeCompare(b.detail));
    if (raised.length && raised.length * 2 > readings.length) added.push({ kind, detail: raised[0]!.detail });
    else if (extraction?.anomalies.some((a) => a.kind === kind)) added.push({ kind, detail: RESUME_FLAG_WORDS[kind] });
  }
  return added.length ? { ...kept, anomalies: [...kept.anomalies, ...added] } : kept;
}

/**
 * The overall reading of a résumé reading, worked out in code from its settled findings (Wave S7), so it can never
 * move on its own between readings of the same application: the fairness run of 15 Oct 2026 found the licence finding
 * steady but the overall reading "potential" in one reading and "unknown" in the next. It reads the findings exactly as
 * the match score does (`matchScore` in @ros/core: a "yes" with nothing quoted is partly shown, a "no" only on a
 * checked quote, a skill for the interviews left out), by the prompt's own definitions:
 * - "unknown" when there is nothing to read the work from (no résumé text and no written description of their work);
 * - "weak" when the candidate's own words show a must-have is not met;
 * - "strong" when every must-have is shown, at least half of the skills (and at least one) are shown, and no essential
 *   skill goes against them;
 * - "potential" when something relevant is shown, in full or in part;
 * - when the findings say nothing either way (every requirement not known, or only a skill against them), the
 *   readings' own judgement of the work is all there is ("thin but relevant" is potential, "not this kind of work" is
 *   weak): the middle of what the readings said (`said`), "unknown" when most said so, never "strong" on no findings.
 *   Without `said`, "unknown".
 * Never "weak" for a skill alone, a gap, a career change or a missing degree: those are not findings against a must-have.
 */
export function settledOverall(reading: Pick<EvidenceAssessment, "requirementFindings" | "competencyFindings">, packet: Pick<RolePacket, "requirements" | "competencies">, opts: { hasWork: boolean; said?: readonly Overall[] }): Overall {
  if (!opts.hasWork) return "unknown";
  const score = matchScore({ resume: { kind: "triage", result: reading }, screen: null }, packet);
  const judged = (): Overall => {
    const said = opts.said?.length ? middleOverall(opts.said) : "unknown";
    return said === "strong" ? "potential" : said;
  };
  if (!score) return judged();
  if (score.missingMustHave.length) return "weak";
  const musts = score.breakdown.filter((c) => c.mustHave);
  const mustUnknown = score.unknown.some((u) => u.mustHave);
  const skills = packet.competencies.filter(scoredSkill);
  const shownSkills = score.breakdown.filter((c) => !c.mustHave && c.pctMet === 100).length;
  const essential = new Set(skills.filter((c) => importanceOf(c) === "essential").map((c) => c.key));
  const essentialAgainst = score.breakdown.some((c) => !c.mustHave && c.pctMet === 0 && essential.has(c.key));
  const everyMust = !mustUnknown && musts.every((c) => c.pctMet === 100);
  const enoughSkills = skills.length === 0 || shownSkills >= Math.max(1, Math.ceil(skills.length / 2));
  if (everyMust && enoughSkills && !essentialAgainst && (musts.length > 0 || shownSkills > 0)) return "strong";
  return score.breakdown.some((c) => c.pctMet > 0) ? "potential" : judged();
}

/**
 * The recommendation that goes with the overall reading worked out in code, by the prompt's own rule, so it moves only
 * when a finding moves: "review_manually" when the reading is "unknown" or an eligibility answer did not match (and no
 * person kept them in); "hold" when it is "weak"; "screen" when it is "strong" or "potential" and they are eligible.
 * "hold" never declines anyone: a person decides (no automatic rejection).
 */
export function settledRecommendation(overall: Overall, opts: { eligible: boolean }): EvidenceAssessment["recommendation"] {
  if (overall === "unknown") return "review_manually";
  if (overall === "weak") return "hold";
  return opts.eligible ? "screen" : "review_manually";
}

/** How a combined reading is settled after the middle answers are taken (`combineRunOutcomes`). */
export type ReadingSettlement<R extends Combinable> = {
  /** The overall reading from the combined findings, and what each reading said overall (`said`). */
  overallOf: (findings: Pick<Combinable, "requirementFindings" | "competencyFindings">, said: readonly Combinable["overall"][]) => Combinable["overall"];
  /**
   * The competency findings once the middle answers are taken, settled further from the readings themselves before the
   * overall reading is worked out (the résumé reading's skill floor, Wave S9 round 4: `skillFloor`). The scorecard gives
   * none, so its findings stay the middle answers.
   */
  skills?: (settled: Combinable["competencyFindings"], readings: readonly R[]) => Combinable["competencyFindings"];
  /** Anything that follows from it (the résumé reading: its recommendation). */
  finish?: (reading: R) => R;
};

/**
 * The résumé reading's settlement: the skill floor (`skillFloor`, Wave S9 round 4), the overall reading from its
 * findings, and the recommendation that goes with it. Eligible unless the eligibility answers were checked and did not
 * match, with no person keeping them in. `sources`: the candidate's texts the quotes were checked against
 * (`assessmentSources`), which the floor reads the line around a quote from; without them, worked out from `input`.
 * The skill floor: a skill one reading of three showed on a checked quote of the candidate's own work is partly shown,
 * never more; never over a verified "contradicted"; never from a dated job line or a yes/no answer on the form
 * (`liftableQuote`); never for a must-have. The scorecard is not affected (it gives no settlement).
 */
export function triageSettlement(packet: Pick<RolePacket, "requirements" | "competencies">, input: Pick<AssessInput, "resumeText" | "applicationAnswers"> & Partial<Pick<AssessInput, "eligibility" | "eligibilityKeptIn">>, sources?: Partial<Record<EvidenceSource, string>>): ReadingSettlement<Reading> {
  const hasWork = !!input.resumeText?.trim() || !!input.applicationAnswers.noResumeSummary?.trim();
  const eligible = !!input.eligibilityKeptIn || input.eligibility?.passed !== false;
  const liftable = liftableQuote(sources ?? assessmentSources(input));
  return {
    overallOf: (findings, said) => settledOverall(findings, packet, { hasWork, said }),
    skills: (settled, readings) => skillFloor(settled, readings, liftable),
    finish: (r) => ({ ...r, recommendation: settledRecommendation(r.overall, { eligible }) }),
  };
}

/** Whether evidence carries a checked quote, as the match score reads it: something quoted, and not marked "no quote". */
const checkedQuote = (e: Evidence | undefined): e is Evidence => !!e?.quote?.trim() && !e.unquoted;

/**
 * The skill floor of the résumé reading (Wave S9 round 4; the real-model runs of 15 Oct 2026): a competency whose middle
 * answer is "not evidenced", but which one of the readings showed (partly or fully) on a checked quote that may lift it
 * (`liftable`, `liftableQuote`: never a dated job line or a yes/no answer on the form), settles at "partially evidenced"
 * with that quote. Never higher than partly shown, never when any reading said "contradicted" on a checked quote, and
 * never for a must-have (only competency findings are read). It only ever moves a finding toward the candidate, so the
 * score stays monotonic, and the quote it keeps is chosen by the readings' content (partly before fully shown, then by
 * the quote), never by the order the readings came back in. Pure; exported for the tests.
 */
export function skillFloor(settled: Combinable["competencyFindings"], readings: readonly Pick<Combinable, "competencyFindings">[], liftable: (e: Evidence) => boolean): Combinable["competencyFindings"] {
  const rank = (f: CompetencyFinding) => (f.finding === "partially_evidenced" ? 0 : 1);
  return settled.map((f): CompetencyFinding => {
    if (f.finding !== "not_evidenced") return f;
    const said = readings.flatMap((r) => {
      const first = r.competencyFindings.find((x) => x.competencyKey === f.competencyKey);
      return first ? [first] : [];
    });
    if (said.some((x) => x.finding === "contradicted" && checkedQuote(x.evidence))) return f;
    const shown = said
      .filter((x) => (x.finding === "partially_evidenced" || x.finding === "evidenced") && checkedQuote(x.evidence) && liftable(x.evidence))
      .sort((a, b) => rank(a) - rank(b) || (a.evidence?.quote ?? "").localeCompare(b.evidence?.quote ?? "") || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const lift = shown[0];
    if (!lift?.evidence) return f;
    return { competencyKey: f.competencyKey, finding: "partially_evidenced", evidence: lift.evidence, ...(lift.finding === "partially_evidenced" && lift.note ? { note: lift.note } : {}) };
  });
}

/**
 * A line with a span of years on it ("2016 - 2021", "2019 – Present", "2014 to 2019"): a job's title, employer and
 * dates, which on its own is no evidence of a competency (the prompt's own rule), so it never lifts one (`liftableQuote`).
 */
export const DATED_JOB_LINE = /\b(?:19|20)\d{2}\s*(?:-|–|—|to|until)\s*(?:(?:19|20)\d{2}|present|current|now|today)\b/i;

/** Whether a quote sits in an answer on the form that is a yes or a no to its question (`answerInContext`). */
function yesNoFormAnswer(quote: string, application: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return false;
  for (const raw of application.split(/\r?\n/)) {
    const line = raw.trim();
    if (!norm(line).includes(q)) continue;
    const asked = line.match(/^(.+\?)\s+(\S.*)$/);
    if (asked && answerInContext(asked[1] ?? "", asked[2] ?? "") !== null) return true;
  }
  return false;
}

/**
 * Which checked quotes may lift a skill under the skill floor (`skillFloor`), read from the candidate's texts by source
 * (`assessmentSources`): never a yes or no answer on the form ("Do you hold an active CA RDH license? Yes."), and never
 * a line with a span of years on it (`DATED_JOB_LINE`: a job title, an employer and dates), read as the whole line
 * around the quote (`sentenceAround`), or the quote itself when the line is not found. A title, an employer, years in a
 * job or a yes/no answer is not on its own evidence of a competency (the prompt's own rule). Anything else may.
 */
export function liftableQuote(sources: Partial<Record<EvidenceSource, string>>): (e: Evidence) => boolean {
  return (e) => {
    const quote = e.quote ?? "";
    if (e.source === "application" && yesNoFormAnswer(quote, sources.application ?? "")) return false;
    const line = sentenceAround(quote, sources[e.source] ?? "") ?? quote;
    return !DATED_JOB_LINE.test(line);
  };
}

/** A reading without findings on skills the role checks in the interviews only (`scoredSkill` in @ros/core). */
export function withoutInterviewSkills<T extends Pick<EvidenceAssessment, "competencyFindings">>(reading: T, packet: Pick<RolePacket, "competencies">): T {
  const interviewOnly = new Set((packet.competencies ?? []).filter((c) => !scoredSkill(c)).map((c) => c.key));
  if (!interviewOnly.size) return reading;
  return { ...reading, competencyFindings: reading.competencyFindings.filter((f) => !interviewOnly.has(f.competencyKey)) };
}

/**
 * Every model run behind one stored reading, linked to the run the reading keeps as its own (`assessments.ai_run_id`):
 * each run's `final_outcome` says `readingOf` that run and lists all of them, so the audit trail from the reading the team
 * saw reaches all three runs, and a flag on the reading marks every one (`readingRunIds`). Bookkeeping only: a failure
 * here is logged and never loses the reading.
 */
export async function linkReadingRuns(db: Db, companyId: string, kept: RunOutcome<unknown>, runs: ReadonlyArray<RunOutcome<unknown>>): Promise<void> {
  if (!kept.ok) return;
  const ids = [...new Set(runs.map((r) => r.runId).filter((id): id is string => !!id))];
  if (ids.length < 2) return;
  try {
    await withTenant(db, companyId, (q) => q.update(aiRuns).set({ finalOutcome: { readingOf: kept.runId, readings: ids } }).where(inArray(aiRuns.id, ids)));
  } catch (err) {
    console.warn(`[triage] could not link the readings' runs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The model runs behind the reading whose own run is `aiRunId`: itself and every run linked to it (`linkReadingRuns`),
 * read from the kept run's own `final_outcome.readings` (a primary-key lookup). An older reading with no link: itself.
 */
export async function readingRunIds(q: Queryable, aiRunId: string): Promise<string[]> {
  const [kept] = await q.select({ finalOutcome: aiRuns.finalOutcome }).from(aiRuns).where(eq(aiRuns.id, aiRunId)).limit(1);
  const readings = (kept?.finalOutcome as { readings?: unknown } | null | undefined)?.readings;
  const linked = Array.isArray(readings) ? readings.filter((x): x is string => typeof x === "string") : [];
  return [...new Set([aiRunId, ...linked])];
}

/**
 * A reading's quotes as the candidate wrote them (D-04 = C): each quote with a placeholder mapped back to the original
 * text of the source it cites, else of any source. Exported for the tests.
 */
export function restoreReadingQuotes<T>(reading: T, view: Pick<ScoringView, "restore">, sources: Partial<Record<EvidenceSource, string>>): T {
  const all = Object.values(sources).filter((s): s is string => !!s);
  return restoreQuotes(reading, view, (source) => {
    const own = source ? sources[source as EvidenceSource] : undefined;
    return own ? [own, ...all.filter((s) => s !== own)] : all;
  });
}

/**
 * The must-haves that name a licence, certificate, permit or registration: the only ones the expired-credential rule
 * (`applyEvidenceRules`, `shownNotHeld`) may settle.
 */
export function credentialMustHaves(packet: Pick<RolePacket, "requirements">): ReadonlySet<string> {
  return new Set(packet.requirements.mustHaves.filter((m) => /licen[cs]|certif|permit|registration|registered|credential/i.test(m.text)).map((m) => m.key));
}

/** What each finding is about, by key: a must-have's words, or a skill's name (`applyEvidenceRules` `subjects`). */
export function findingSubjects(packet: Partial<Pick<RolePacket, "requirements" | "competencies">> | null | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of packet?.requirements?.mustHaves ?? []) out.set(m.key, m.text);
  for (const c of packet?.competencies ?? []) if (!out.has(c.key)) out.set(c.key, c.name);
  return out;
}

/**
 * The line or sentence of `source` that holds `quote` (whitespace and case aside): the candidate's words around a
 * quote, so the licence rule reads "RDH license CA expired in 2021" whole when a reading quoted only "RDH license CA".
 * A quote over several lines gives all of them (at most six); one not found, null.
 */
export function sentenceAround(quote: string, source: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return null;
  const parts = source
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const normed = parts.map(norm);
  for (let len = 1; len <= Math.min(6, normed.length); len++) {
    for (let i = 0; i + len <= normed.length; i++) if (normed.slice(i, i + len).join(" ").includes(q)) return parts.slice(i, i + len).join(" ");
  }
  return null;
}

type Reading = EvidenceAssessment;
/** What `combineReadings` needs of a reading: a résumé reading and a screening scorecard both have it. */
type Combinable = Pick<EvidenceAssessment, "overall" | "confidence" | "confidenceReasons" | "requirementFindings" | "competencyFindings">;

/**
 * The readings that came back, each through the evidence rules, combined into one (`combineReadings`). With fewer than
 * three (a reading refused or unusable) the first is used, and its confidence reasons say it was read fewer times. With
 * none, the failure: an outage when any reading had one, so the step is retried.
 */
export function combineOutcomes(runs: ReadonlyArray<RunOutcome<Reading>>, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>, subjects?: ReadonlyMap<string, string>, settle?: ReadingSettlement<Reading>): RunOutcome<Reading> {
  return combineRunOutcomes(runs, (r) => verifyAssessmentQuotes(r, sources, credentials, subjects), "this application", TRIAGE_READINGS, settle);
}

/**
 * `combineOutcomes` for any kind of reading (the résumé reading, the screening scorecard): `check` puts each reading
 * through its evidence rules first; `what` names what was read, for the reason given when fewer readings came back.
 * The run kept is the first usable one; `linkReadingRuns` ties the others to it. With `settle` (the résumé reading,
 * Wave S7) the overall reading is worked out from the combined findings, also when fewer readings came back; its skill
 * floor (`skills`, Wave S9 round 4) applies only when all the readings came back, as the first is used otherwise.
 */
export function combineRunOutcomes<R extends Combinable>(runs: ReadonlyArray<RunOutcome<R>>, check: (r: R) => R, what: string, count = TRIAGE_READINGS, settle?: ReadingSettlement<R>): RunOutcome<R> {
  const ok = runs.filter((r): r is Extract<RunOutcome<R>, { ok: true }> => r.ok);
  if (!ok.length) return runs.find((r): r is Extract<RunOutcome<R>, { ok: false }> => !r.ok && r.reason === "error") ?? runs[0]!;
  const readings = ok.map((r) => check(r.output));
  const finish = settle?.finish ?? ((r: R) => r);
  if (readings.length >= count) return { ...ok[0]!, output: finish(combineReadings(readings, settle ? { overallOf: settle.overallOf, skills: settle.skills } : {})) };
  const one = readings[0]!;
  const reason = `the assistant could read ${what} ${readings.length === 1 ? "once" : `${readings.length} times`} instead of ${count}`;
  return { ...ok[0]!, output: finish({ ...one, ...(settle ? { overall: settle.overallOf(one, [one.overall]) } : {}), confidenceReasons: [...(one.confidenceReasons ?? []), reason].slice(-6) }) };
}

const MET_ORDER = ["no", "unknown", "partially", "yes"] as const;
const FINDING_ORDER = ["contradicted", "not_evidenced", "partially_evidenced", "evidenced"] as const;
const OVERALL_ORDER = ["weak", "potential", "strong"] as const;
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;

/**
 * The middle value on the finding's own order. For an even number the upper middle: a tie never resolves against the
 * candidate. Every reading gives exactly one value per key (`combineReadings`), so with three readings it is the true middle.
 */
function middle<T extends string>(values: readonly T[], order: readonly T[]): T {
  const sorted = [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The overall reading of several: "unknown" when most readings say so, otherwise the middle of the others. */
function middleOverall(values: readonly Combinable["overall"][]): Combinable["overall"] {
  const known = values.filter((v): v is (typeof OVERALL_ORDER)[number] => v !== "unknown");
  return known.length * 2 <= values.length && values.some((v) => v === "unknown") ? "unknown" : middle(known, OVERALL_ORDER);
}

/**
 * One reading from several of the same application (three, after the evidence rules), the same whatever order they
 * came back in:
 * - each reading gives exactly one answer per must-have and per competency (its first; a reading that left one out
 *   counts as "unknown" or "not evidenced"), and the result is the middle answer (must-haves ordered no, unknown,
 *   partially, yes; competencies contradicted, not evidenced, partially, evidenced), with the evidence of a reading that
 *   gave it;
 * - the overall reading and the confidence are the middle on their own order ("unknown" only when most readings say so);
 *   with `overallOf` (the résumé reading, Wave S7) the overall reading is worked out from the combined findings
 *   instead (`settledOverall`), so it moves only when a finding moves;
 * - with `skills` (the résumé reading, Wave S9 round 4: `skillFloor`) the competency findings are settled further from
 *   the readings before that: a skill one reading of three showed on a checked quote of the candidate's own work is
 *   partly shown, never more; never over a verified "contradicted"; never from a dated job line or a yes/no answer;
 *   never for a must-have. The scorecard gives none, so it is not affected;
 * - the recommendation, the confidence reasons and the words (summary, strengths, concerns, questions) all come from one
 *   reading, the closest to that result, so they never contradict each other (for a scorecard also the answers, the pay
 *   and availability it recorded, and the eligibility confirmations).
 */
export function combineReadings<R extends Combinable>(readings: readonly R[], opts: { overallOf?: ReadingSettlement<R>["overallOf"]; skills?: ReadingSettlement<R>["skills"] } = {}): R {
  const reqKeys = [...new Set(readings.flatMap((r) => r.requirementFindings.map((f) => f.requirementKey)))].sort();
  const compKeys = [...new Set(readings.flatMap((r) => r.competencyFindings.map((f) => f.competencyKey)))].sort();
  const reqOf = (r: R, k: string) => r.requirementFindings.find((f) => f.requirementKey === k);
  const compOf = (r: R, k: string) => r.competencyFindings.find((f) => f.competencyKey === k);
  const met = new Map(reqKeys.map((k) => [k, middle(readings.map((r) => reqOf(r, k)?.met ?? "unknown"), MET_ORDER)]));
  const found = new Map(compKeys.map((k) => [k, middle(readings.map((r) => compOf(r, k)?.finding ?? "not_evidenced"), FINDING_ORDER)]));
  const confidence = middle(readings.map((r) => r.confidence), CONFIDENCE_ORDER);
  // the closest reading to an overall reading: the same overall (when one is given), then the same confidence, then the
  // most findings; a tie is settled by the reading's own content, never by the order the readings came back in
  const closestTo = (overall: Combinable["overall"] | null) => {
    const agreement = (r: R) => (overall !== null && r.overall === overall ? 1000 : 0) + (r.confidence === confidence ? 500 : 0) + reqKeys.filter((k) => reqOf(r, k)?.met === met.get(k)).length * 10 + compKeys.filter((k) => compOf(r, k)?.finding === found.get(k)).length;
    const ranked = [...readings].sort((a, b) => agreement(b) - agreement(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const requirementFindings = reqKeys.map((k) => ranked.map((r) => reqOf(r, k)).find((f) => f?.met === met.get(k)) ?? { requirementKey: k, met: met.get(k)! });
    const competencyFindings = compKeys.map((k) => ranked.map((r) => compOf(r, k)).find((f) => f?.finding === found.get(k)) ?? { competencyKey: k, finding: found.get(k)! });
    return { closest: ranked[0]!, requirementFindings, competencyFindings };
  };
  if (!opts.overallOf) {
    const overall = middleOverall(readings.map((r) => r.overall));
    const chosen = closestTo(overall);
    const competencyFindings = opts.skills ? opts.skills(chosen.competencyFindings, readings) : chosen.competencyFindings;
    return { ...chosen.closest, overall, confidence, requirementFindings: chosen.requirementFindings, competencyFindings };
  }
  // Settled in code: the findings (with their evidence) are picked without looking at what each reading said overall,
  // the skills settled further from the readings when asked (`skills`), the overall reading is worked out from them, and
  // the words come from the reading closest to it.
  const settled = closestTo(null);
  const findings = opts.skills ? { ...settled, competencyFindings: opts.skills(settled.competencyFindings, readings) } : settled;
  const overall = opts.overallOf(findings, readings.map((r) => r.overall));
  return { ...closestTo(overall).closest, overall, confidence, requirementFindings: findings.requirementFindings, competencyFindings: findings.competencyFindings };
}

/**
 * Checks every quote in a résumé assessment against the text it cites (plan 0.9, through `applyEvidenceRules`). A
 * résumé reading is given only the candidate's own texts, so nothing else can be quoted in it: a quote citing any
 * other source (a screen, an interview, the owner's words, a playbook, a benchmark, a recruiter's note, "verified") must
 * still be found in the candidate's texts, or it fails the check like an invented one (known bug 34). A claim citing such
 * a source with nothing quoted is no evidence of anything either, so it never scores in full (`matchScore`).
 */
export function verifyAssessmentQuotes(a: EvidenceAssessment, sources: Partial<Record<EvidenceSource, string>>, credentials?: ReadonlySet<string>, subjects?: ReadonlyMap<string, string>): EvidenceAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(sources)) normalized.set(k, norm(v ?? ""));
  // the line a checked quote sits on, in the source it names (or the first source holding it); an answer on the form
  // ("Do you hold an active CA RDH license? No.") is read as the statement it makes ("I do not hold ...")
  const lineOf = (e: Evidence): string | null => {
    const quote = e.quote ?? "";
    const answer = e.source === "application" ? formAnswerAround(quote, sources.application ?? "") : null;
    if (answer) return answer;
    const own = sources[e.source];
    const texts = own !== undefined ? [own] : Object.values(sources).filter((s): s is string => !!s);
    for (const t of texts) {
      const line = sentenceAround(quote, t);
      if (line) return line;
    }
    return null;
  };
  return applyEvidenceRules(
    a,
    (e) => {
      const quote = norm(e.quote ?? "");
      const src = normalized.get(e.source);
      if (src !== undefined) return src.includes(quote);
      return [...normalized.values()].some((s) => !!s && s.includes(quote));
    },
    { credentials, lineOf, ...(subjects ? { subjects } : {}) },
  );
}

/**
 * The answer on the form a quote sits in (`formAnswerLines`: one line each, the question then the answer), read as the
 * statement it makes, with the question (`answerInContext`): "Do you hold an active CA RDH license? No." reads "I do not
 * hold an active CA RDH license", so the licence rule reads it as plainly as the same words in a résumé. Null when the
 * quote is not in a line of that shape.
 */
export function formAnswerAround(quote: string, application: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  if (!q) return null;
  for (const raw of application.split(/\r?\n/)) {
    const line = raw.trim();
    if (!norm(line).includes(q)) continue;
    const asked = line.match(/^(.+\?)\s+(\S.*)$/);
    if (asked) return answerInContext(asked[1] ?? "", asked[2] ?? "") ?? line;
  }
  return null;
}

/** The candidate's own record or words: a claim citing one of these must quote it, and the quote is checked. */
export const CANDIDATE_EVIDENCE_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>(["resume", "application", "candidate_statement", "screen", "interview"]);

/**
 * The fewest words a quote needs to count as evidence (Wave S5, 15 Oct 2026), not counting yes, no and the small
 * words around them: "Yes", "I do" or "Dentrix" alone show nothing a person could check.
 */
export const MIN_QUOTE_WORDS = 2;
const FILLER_WORDS = new Set(["yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "true", "false", "none", "maybe", "na", "n", "a", "i", "an", "the", "do", "did", "does", "am", "is", "it", "have", "has", "of", "and", "or", "to", "in", "on", "my"]);

/** Whether a quote says enough to be evidence: at least `MIN_QUOTE_WORDS` words besides yes, no and the like. */
export function meaningfulQuote(quote: string | null | undefined): boolean {
  const words = (quote ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => w.length > 1 && !FILLER_WORDS.has(w)).length >= MIN_QUOTE_WORDS;
}

/**
 * Words that say a licence, certificate, permit or registration is not in force today: lapsed, expired, revoked and the
 * like, or still to come (pending, applied for, in training, enrolled, not yet). Under the founder's licence rule (15 Oct
 * 2026) every one of these reads "unknown", for the screening chat to ask about.
 */
const NOT_HELD = /\b(expired|lapsed|inactive|revoked|suspended|not renewed|renewal not started|pending|applied for|applying for|awaiting|in progress|enrolled|enrolling|studying|in training|trainee|graduating|not yet|yet to|expected)\b/gi;
const STILL_HELD = /\b(active|current|valid|reinstated|reactivated|good standing)\b|\bcurrently (licensed|certified|registered|active|valid|hold|holding)\b|(?<!\bnot )\brenewed\b/i;
/** A status word just after a negation ("never lapsed", "not expired", "hasn't been suspended", "non-expired") says the opposite. */
const NEGATED = /(\b(never|not|no|nor|without)\b[^.;,]{0,20}|n['’]t\s+(been\s+)?|\bnon-?\s*)$/i;
/** A plain statement that the candidate does not hold the credential: "I do not hold", "not licensed", "no RDH license". */
const PLAINLY_NOT_HELD = new RegExp(
  [
    String.raw`\b(?:do|does|did)\s+not\s+(?:currently\s+)?(?:have|hold)\b`,
    String.raw`\b(?:do|does|did)n['’]t\s+(?:currently\s+)?(?:have|hold)\b`,
    String.raw`\bnever\s+(?:had|held|been\s+(?:licensed|certified|registered))\b`,
    String.raw`\bno\s+longer\s+(?:have|hold|licensed|certified|registered)\b`,
    String.raw`\bnot\s+(?:currently\s+)?(?:licensed|certified|registered)\b`,
    String.raw`\b(?:unlicensed|uncertified|unregistered)\b`,
    String.raw`\b(?:have|hold)\s+no\s+(?:[\w-]+\s+){0,3}?(?:licen[cs]es?|certificat\w*|registrations?|permits?|credentials?)\b`,
    String.raw`^\s*no\s+(?:[\w-]+\s+){0,3}?(?:licen[cs]es?|certificat\w*|registrations?|permits?|credentials?)\b`,
    String.raw`\bwithout\s+(?:a|an|any)\s+(?:[\w-]+\s+){0,2}?(?:licen[cs]es?|certificat\w*|registrations?|permits?)\b`,
  ].join("|"),
  "i",
);
/** Still to come, or not settled: a "do not hold" with any of these is pending, so "unknown". */
const NOT_SETTLED = /\b(yet|pending|applied|applying|awaiting|waiting|in progress|enrolled|studying|training|graduat\w*|expected|exam|soon|will)\b/i;

/** A word naming a credential or the way to one: a part of a line with none of these is about something else. */
const CREDENTIAL_WORD = /\b(licen[cs]\w*|certif\w*|registration|registered|permit|programs?|programmes?|credentials?|board|exam|rdh)\b/i;
/** Words of a must-have that say nothing about which credential it is. */
const GENERIC_SUBJECT_WORDS = new Set(["active", "current", "valid", "state", "must", "with", "and", "for", "hold", "holds", "have", "license", "licence", "licensed", "licenced", "licensure", "certificate", "certification", "certified", "registration", "registered", "permit", "credential", "credentials"]);
/** A renewal's own state ("renewal expected 2026", "renewal in progress") is not the credential's. */
const RENEWAL_BEFORE = /\brenewal\s+(?:is\s+|was\s+)?$/i;
const RENEWAL_STATE = /^(expected|in progress|pending|applied for|applying for|awaiting)$/i;

const wordsIn = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The parts of a quote (or of the line around it) about the credential itself, split at semicolons, line breaks and
 * sentence ends. When some part names a credential, a part that names none ("renewal expected 2026") is left out; with
 * the must-have's own words (`subject`, e.g. "Active CA RDH license"), when some part names them, a part about another
 * qualification ("studying for local anesthesia permit") is left out too. With nothing named anywhere, the whole quote.
 */
function aboutTheCredential(quote: string, subject?: string | null): string[] {
  const clauses = quote
    .split(/;|\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const own = wordsIn(subject ?? "").filter((w) => w.length > 1 && !FILLER_WORDS.has(w) && !GENERIC_SUBJECT_WORDS.has(w));
  const hasOwn = (c: string) => {
    const w = wordsIn(c);
    return own.some((o) => w.includes(o));
  };
  const named = (c: string) => CREDENTIAL_WORD.test(c) || hasOwn(c);
  const anyNamed = clauses.some(named);
  const ownSomewhere = own.length > 0 && clauses.some(hasOwn);
  return clauses.filter((c) => (!anyNamed || named(c)) && (!ownSomewhere || hasOwn(c)));
}

/**
 * Whether a quote says a licence or certificate is not in force today: an expired-, pending- or in-training-like word
 * that is not negated, and nothing in the quote saying it is held (active, current, valid, renewed, reinstated, in good
 * standing). Only the parts about the credential count (`aboutTheCredential`): "RDH license CA #12345, renewal expected
 * 2026" is held, and "RDH license CA; studying for local anesthesia permit" is not about the RDH licence's state.
 */
export function shownNotHeld(quote: string, subject?: string | null): boolean {
  const parts = aboutTheCredential(quote, subject);
  if (parts.some((c) => STILL_HELD.test(c))) return false;
  for (const c of parts) {
    for (const m of c.matchAll(NOT_HELD)) {
      const at = m.index ?? 0;
      const before = c.slice(Math.max(0, at - 30), at);
      if (NEGATED.test(before)) continue;
      if (RENEWAL_BEFORE.test(before) && RENEWAL_STATE.test(m[0])) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a quote says plainly that the candidate does not hold the credential, with nothing pending, lapsed or held
 * about it. The plain words must be in a part about the credential (`aboutTheCredential`); anything pending or held
 * anywhere in the quote keeps it from being plain.
 */
export function plainlyNotHeld(quote: string, subject?: string | null): boolean {
  const about = aboutTheCredential(quote, subject).join("; ");
  return PLAINLY_NOT_HELD.test(about) && !NOT_SETTLED.test(quote) && !STILL_HELD.test(quote) && !shownNotHeld(quote, subject);
}

type Met = EvidenceAssessment["requirementFindings"][number]["met"];

/**
 * The founder's licence rule (15 Oct 2026) for a credential must-have with a checked quote, read from the candidate's
 * words (`text`: the line the quote sits on, or the chat question a short answer replies to, so the finding never rests
 * on which part of a line the model chose to quote): "no" when the words say plainly the candidate does not hold it,
 * whatever the model answered; a lapsed, expired, pending or unclear credential is "unknown", never "no", "yes" or
 * "partially"; a "no" the words do not say plainly is "unknown". Anything else stands as read. `subject`: the
 * must-have's own words, so a part of the line about another qualification is not read as this one.
 */
export function credentialFinding(met: Met, text: string, subject?: string | null): Met {
  if (plainlyNotHeld(text, subject)) return "no";
  if (shownNotHeld(text, subject)) return "unknown";
  if (met === "no") return "unknown";
  return met;
}

/** One step down: what a reader can rely on once a claim lost its quote. */
export function stepDownConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

/** The parts of a reading the evidence rules touch; a résumé assessment and a screen scorecard both have them. */
type Readable = Pick<EvidenceAssessment, "confidence" | "confidenceReasons" | "strengths" | "concerns" | "competencyFindings" | "requirementFindings" | "anomalies">;
type Claim = EvidenceAssessment["strengths"][number];
type CompetencyFinding = EvidenceAssessment["competencyFindings"][number];
type RequirementFinding = EvidenceAssessment["requirementFindings"][number];

/**
 * What `applyEvidenceRules` may know beyond the quote itself:
 * - `credentials`: the must-haves the licence rule holds to (`credentialMustHaves`);
 * - `subjects`: what each finding is about, by key (`findingSubjects`);
 * - `lineOf(e)`: the candidate's line or sentence around a checked quote, for the licence rule (`sentenceAround`);
 * - `answerOf(e, subject)`: for a quote too short alone ("Yes", "No, I don't") that is a whole chat answer, the
 *   question it replies to read with it (`answerInContext`), when that question is about `subject`; else null.
 */
export type EvidenceRuleOptions = {
  credentials?: ReadonlySet<string>;
  subjects?: ReadonlyMap<string, string>;
  lineOf?: (e: Evidence) => string | null | undefined;
  answerOf?: (e: Evidence, subject: string | null) => string | null | undefined;
};

const YES_ANSWER = /^(?:yes|yeah|yep|yup|sure|correct|i do|i have|i am|i hold)\b/;
const NO_ANSWER = /^(?:no|nope|not really|i do not|i don['’]t|i have not|i haven['’]t|i am not|i['’]m not)\b/;
const HOLD_QUESTION = /\b(?:do|did|does)\s+you\s+(?:currently\s+|still\s+)?(have|hold)\b\s*(.*)$/i;
const ARE_YOU_QUESTION = /\bare\s+you\s+(?:currently\s+|still\s+)?((?:licensed|certified|registered)\b.*)$/i;

/** The last question in an assistant's message ("Thanks, that helps. Next: Do you hold ...?"), or the whole message. */
const lastQuestionOf = (question: string): string => {
  const q = question.replace(/\s+/g, " ").trim();
  return q.split(/(?<=[.!?:])\s+/).filter((s) => s.endsWith("?")).at(-1) ?? q;
};

/**
 * A yes or no to a closed question about holding something ("Do you hold ...?", "Do you have ...?", "Are you licensed
 * ...?"), as the statement it makes and whether it says held: a bare "No" to "Do you hold a California RDH license?" is
 * { held: false, statement: "I do not hold a California RDH license" }. Null for any other question, and for anything
 * but a yes or a no. Pure; exported for the scorecard (`plainCredentialAnswers`) and the tests.
 */
export function closedAnswer(question: string, answer: string): { held: boolean; statement: string } | null {
  const a = answer.replace(/\s+/g, " ").trim().toLowerCase();
  const no = NO_ANSWER.test(a);
  const yes = YES_ANSWER.test(a) && !no;
  if (!yes && !no) return null;
  const asked = lastQuestionOf(question);
  const hold = asked.match(HOLD_QUESTION);
  const are = asked.match(ARE_YOU_QUESTION);
  const rest = (s: string) => s.replace(/[?.!\s]+$/, "");
  if (hold) return { held: yes, statement: `${no ? `I do not ${hold[1]!.toLowerCase()}` : `I ${hold[1]!.toLowerCase()}`} ${rest(hold[2] ?? "")}`.trim() };
  if (are) return { held: yes, statement: `${no ? "I am not" : "I am"} ${rest(are[1] ?? "")}`.trim() };
  return null;
}

/**
 * A short chat answer read with the question it replies to, as one statement the evidence rules can read: a bare "No"
 * to "Do you hold a California RDH license?" reads "I do not hold a California RDH license", a bare "Yes" reads "I hold
 * a California RDH license" (`closedAnswer`). A yes or no to any other closed question reads as the question followed by
 * the answer. Anything else ("Maybe", "Dentrix") is not a plain answer to a closed question: null, so it stays too short
 * to count. Pure; exported for the scorecard and the tests.
 */
export function answerInContext(question: string, answer: string): string | null {
  const closed = closedAnswer(question, answer);
  if (closed) return closed.statement;
  const a = answer.replace(/\s+/g, " ").trim().toLowerCase();
  return YES_ANSWER.test(a) || NO_ANSWER.test(a) ? `${lastQuestionOf(question)} ${answer.trim()}` : null;
}

/**
 * The evidence rules every reading passes before anyone sees it (plan 0.9). `inSource(e)` says whether a non-empty quote
 * is in the text it cites: true, false, or null for a source that is not the candidate's (it passes through).
 * - A strength or concern whose quote is not in the source is dropped.
 * - A competency or must-have finding whose quote is not in the source keeps its place without the quote: "evidenced"
 *   becomes "partially evidenced", a must-have "yes" becomes "partially".
 * - A must-have "no" stands only on a verified quote from the candidate; otherwise it becomes "unknown". A gap is a
 *   question for the screen, never a conclusion.
 * - A quote too short to show anything (`meaningfulQuote`: a lone "yes", "I do", one word) is no evidence: it is taken
 *   off and the claim is marked "no quote", as if nothing were quoted (so a "yes" on it never scores in full). The
 *   exception is a whole chat answer to a closed question about that finding (`answerOf`): "Yes" to "Do you hold a
 *   California RDH license?" says it, and is read with the question.
 * - The founder's licence rule (15 Oct 2026, `credentialFinding`), for a credential must-have (`credentials`: one that
 *   names a licence, certificate, permit or registration) with a checked quote, read from the candidate's words around
 *   the quote (`lineOf`, `answerOf`), never only the part the model chose: "no" when they say plainly they do not hold
 *   it, whatever the model answered; lapsed, expired, pending or unclear is "unknown" (asked about in the screening
 *   chat). The fairness run on Haiku 5.5 (14 Oct 2026) read "RDH license CA expired in 2021; renewal not started" as
 *   "no" in some readings and "unknown" in others; now every reading of it is "unknown".
 * - A claim about the candidate with nothing quoted is kept and marked `unquoted`, so the page says "no quote".
 * - When a claim was dropped or a "no" had nothing to show it, the confidence steps down one level, and the reasons say
 *   why; a credential settled by the licence rule is said in the reasons too.
 * The model's own `unquoted` marks are never trusted: the flag is recomputed here.
 */
export function applyEvidenceRules<T extends Readable>(a: T, inSource: (e: Evidence) => boolean | null, opts: EvidenceRuleOptions = {}): T {
  type Check = "verified" | "failed" | "external" | "thin" | "none";
  const subjectOf = (key?: string) => (key ? opts.subjects?.get(key) ?? null : null);
  /** A short answer read with the chat question it replies to (`answerOf`), when there is one about this finding. */
  const answered = (e: Evidence, key?: string) => (e.source === "recruiter_note" ? null : opts.answerOf?.(e, subjectOf(key)) ?? null);
  const check = (e: Evidence | undefined, key?: string): Check => {
    if (!e?.quote?.trim()) return "none";
    if (!meaningfulQuote(e.quote) && !meaningfulQuote(answered(e, key))) return "thin";
    const r = inSource(e);
    return r === null ? "external" : r ? "verified" : "failed";
  };
  /** The evidence as shown: the model's flag removed, `unquoted` set when a candidate claim has no quote. */
  const marked = (e: Evidence): Evidence => {
    const { unquoted: _unquoted, ...rest } = e;
    return !rest.quote?.trim() && CANDIDATE_EVIDENCE_SOURCES.has(rest.source) ? { ...rest, quote: undefined, unquoted: true } : rest;
  };
  /** A quote that failed the check: the source stays, the quote goes. */
  const stripped = (e: Evidence): Evidence => marked({ source: e.source });
  let dropped = 0;
  let mustHaveNoWithoutQuote = 0;
  let credentialsSettled = 0;
  let credentialsPlainlyNo = 0;
  /** The evidence as kept: a failed or too-short quote taken off (the source stays), anything else as marked. */
  const kept = (e: Evidence, c: Check): Evidence => (c === "failed" || c === "thin" ? stripped(e) : marked(e));
  const keepClaim = (f: Claim): Claim | null => {
    const c = check(f.evidence, undefined);
    if (c === "failed") {
      dropped += 1;
      return null;
    }
    return { ...f, evidence: kept(f.evidence, c) };
  };
  const strengths = a.strengths.map(keepClaim).filter((f): f is Claim => f !== null);
  const concerns = a.concerns.map(keepClaim).filter((f): f is Claim => f !== null);
  const competencyFindings = a.competencyFindings.map((f): CompetencyFinding => {
    const c = check(f.evidence, f.competencyKey);
    if (c !== "failed") return { ...f, evidence: f.evidence ? kept(f.evidence, c) : undefined };
    dropped += 1;
    return { ...f, evidence: stripped(f.evidence!), finding: f.finding === "evidenced" ? "partially_evidenced" : f.finding, note: [f.note, "quote could not be verified against the source"].filter(Boolean).join("; ") };
  });
  const requirementFindings = a.requirementFindings.map((f): RequirementFinding => {
    const c = check(f.evidence, f.requirementKey);
    if (c === "failed") dropped += 1;
    const evidence = !f.evidence ? undefined : kept(f.evidence, c);
    const credential = !!opts.credentials?.has(f.requirementKey);
    if (f.met === "no" && c !== "verified") {
      mustHaveNoWithoutQuote += 1;
      return { ...f, evidence, met: "unknown" };
    }
    const met = c === "failed" && f.met === "yes" ? "partially" : f.met;
    // The licence rule, on a quote that stands, read from the candidate's words around it: the line it sits on, or the
    // chat question a short answer replies to. A recruiter's note is read as quoted and never makes a "no".
    if (credential && (c === "verified" || c === "external") && f.evidence?.quote) {
      const quote = f.evidence.quote;
      const subject = subjectOf(f.requirementKey);
      const words = c === "verified" ? (meaningfulQuote(quote) ? opts.lineOf?.(f.evidence) : answered(f.evidence, f.requirementKey)) ?? quote : quote;
      const read = credentialFinding(met, words, subject);
      const settled = c === "external" && read === "no" ? "unknown" : read;
      if (settled !== met) {
        if (settled === "no") credentialsPlainlyNo += 1;
        else credentialsSettled += 1;
        return { ...f, evidence, met: settled };
      }
    }
    return { ...f, evidence, met };
  });
  if (!dropped && !mustHaveNoWithoutQuote && !credentialsSettled && !credentialsPlainlyNo) return { ...a, strengths, concerns, competencyFindings, requirementFindings };
  const anomalies = dropped ? [...a.anomalies, { kind: "unverified_quote", detail: `${dropped} claim${dropped === 1 ? "" : "s"} cited text that is not in the source and ${dropped === 1 ? "was" : "were"} discarded` }] : a.anomalies;
  // Dropping a claim lowers what the owner can rely on; say so where the card explains the confidence.
  const reasons = [...(a.confidenceReasons ?? [])];
  if (credentialsPlainlyNo) reasons.push(`${credentialsPlainlyNo === 1 ? "a licence or certificate is" : `${credentialsPlainlyNo} licences or certificates are`} not held, as the candidate says plainly in their own words`);
  if (credentialsSettled) reasons.push(`${credentialsSettled === 1 ? "a licence or certificate is" : `${credentialsSettled} licences or certificates are`} lapsed, pending or unclear in the candidate's words, so not known yet: the screening chat can ask`);
  if (dropped) reasons.push(`${dropped === 1 ? "one claim" : `${dropped} claims`} quoted text that is not in the source and ${dropped === 1 ? "was" : "were"} dropped`);
  if (mustHaveNoWithoutQuote) reasons.push(`${mustHaveNoWithoutQuote === 1 ? "one must-have was" : `${mustHaveNoWithoutQuote} must-haves were`} marked not met with nothing quoted to show it, so ${mustHaveNoWithoutQuote === 1 ? "it is" : "they are"} treated as unknown`);
  const stepDown = dropped > 0 || mustHaveNoWithoutQuote > 0;
  // The schema allows six reasons; the newest (why the confidence just dropped) are the ones to keep.
  return { ...a, strengths, concerns, competencyFindings, requirementFindings, anomalies, confidence: stepDown ? stepDownConfidence(a.confidence) : a.confidence, confidenceReasons: reasons.slice(-6) };
}
