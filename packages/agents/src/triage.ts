import type { Confidence, EligibilityResult, Evidence, EvidenceAssessment, EvidenceSource, ResumeExtraction, RolePacket } from "@ros/contracts";
import { resumeExtractPrompt, runPromptDetached, triageAssessPrompt, type AiRuntime, type RunOutcome } from "@ros/ai";
import type { Db } from "@ros/db";

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

/** Inputs to the evidence-based assessment; the workflow assembles them from the system of record. */
export type AssessInput = {
  companyId: string;
  workflowRunId?: string | null;
  applicationId: string;
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string | null;
  applicationAnswers: { eligibility: Record<string, unknown>; noResumeSummary?: string };
  eligibility: EligibilityResult | null;
  priorApplications: Array<{ roleTitle: string; stage: string; at: string }>;
};

/**
 * How many times an application is read. The fairness run on Haiku 5.5 (14 Oct 2026) showed one reading of the same
 * résumé moving a competency between "evidenced" and "partially evidenced", and so the score by 5 to 11 points; the
 * middle answer of three readings (`combineReadings`) holds still. The three run side by side, about a cent in all.
 */
export const TRIAGE_READINGS = 3;

/** The texts a résumé reading may quote, by source, for the quote check. */
export function assessmentSources(input: Pick<AssessInput, "resumeText" | "applicationAnswers">): Partial<Record<EvidenceSource, string>> {
  return {
    resume: input.resumeText ?? "",
    application: `${input.applicationAnswers.noResumeSummary ?? ""}\n${JSON.stringify(input.applicationAnswers.eligibility)}`,
    candidate_statement: input.applicationAnswers.noResumeSummary ?? "",
  };
}

/**
 * Evidence-based assessment (Triage agent, Slice 2). The model reads the application `TRIAGE_READINGS` times; code
 * verifies every quote against the source text and discards any claim whose quote cannot be found, so nothing invented
 * reaches the owner, then keeps the middle answer of the readings for each finding.
 */
export async function assessApplication(db: Db, ai: AiRuntime, input: AssessInput): Promise<RunOutcome<EvidenceAssessment>> {
  const promptInput = { packet: input.packet, extraction: input.extraction, resumeText: input.resumeText, applicationAnswers: input.applicationAnswers, eligibility: input.eligibility, priorApplications: input.priorApplications };
  const inputRef = { applicationId: input.applicationId, resumeChars: input.resumeText?.length ?? 0, hasExtraction: !!input.extraction };
  const runs = await Promise.all(
    Array.from({ length: TRIAGE_READINGS }, (_, i) => runPromptDetached(db, ai, triageAssessPrompt, promptInput, { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { ...inputRef, reading: i + 1 } })),
  );
  return combineOutcomes(runs, assessmentSources(input));
}

type Reading = EvidenceAssessment;

/**
 * The readings that came back, each through the evidence rules, combined into one (`combineReadings`); the first failure
 * when none came back. With fewer than three the first is used as it is: a middle answer needs three.
 */
export function combineOutcomes(runs: ReadonlyArray<RunOutcome<Reading>>, sources: Partial<Record<EvidenceSource, string>>): RunOutcome<Reading> {
  const ok = runs.filter((r): r is Extract<RunOutcome<Reading>, { ok: true }> => r.ok);
  if (!ok.length) return runs[0]!;
  const readings = ok.map((r) => verifyAssessmentQuotes(r.output, sources));
  return { ...ok[0]!, output: readings.length >= 3 ? combineReadings(readings) : readings[0]! };
}

const MET_ORDER = ["no", "unknown", "partially", "yes"] as const;
const FINDING_ORDER = ["contradicted", "not_evidenced", "partially_evidenced", "evidenced"] as const;

/** The middle value of an odd number of readings, on the finding's own order. */
function middle<T extends string>(values: readonly T[], order: readonly T[]): T {
  const sorted = [...values].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** The value most readings gave; `fallback` when no value has more readings than the others. */
function mostCommon<T>(values: readonly T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([v]) => v);
  return leaders.length === 1 ? leaders[0]! : fallback;
}

/**
 * One reading from several of the same application (three, after the evidence rules): each must-have and each
 * competency takes the middle answer of the readings (must-haves ordered no, unknown, partially, yes; competencies
 * contradicted, not evidenced, partially, evidenced), with the evidence of a reading that gave it. The overall reading,
 * recommendation and confidence take the answer most readings gave. The words (summary, strengths, concerns, questions)
 * come from the reading closest to that result. The same application then reads, and scores, the same each time.
 */
export function combineReadings(readings: readonly Reading[]): Reading {
  const first = readings[0]!;
  const reqKeys = [...new Set(readings.flatMap((r) => r.requirementFindings.map((f) => f.requirementKey)))];
  const compKeys = [...new Set(readings.flatMap((r) => r.competencyFindings.map((f) => f.competencyKey)))];
  const met = new Map(reqKeys.map((k) => [k, middle(readings.flatMap((r) => r.requirementFindings.filter((f) => f.requirementKey === k).map((f) => f.met)), MET_ORDER)]));
  const found = new Map(compKeys.map((k) => [k, middle(readings.flatMap((r) => r.competencyFindings.filter((f) => f.competencyKey === k).map((f) => f.finding)), FINDING_ORDER)]));
  const overall = mostCommon(readings.map((r) => r.overall), first.overall);
  const confidence = mostCommon(readings.map((r) => r.confidence), first.confidence);
  // the closest reading shares the overall and the confidence (so its reasons explain it), then the most findings
  const agreement = (r: Reading) => (r.overall === overall ? 1000 : 0) + (r.confidence === confidence ? 500 : 0) + r.requirementFindings.filter((f) => met.get(f.requirementKey) === f.met).length * 10 + r.competencyFindings.filter((f) => found.get(f.competencyKey) === f.finding).length;
  const closest = [...readings].sort((a, b) => agreement(b) - agreement(a))[0]!;
  const ordered = [closest, ...readings.filter((r) => r !== closest)];
  const requirementFindings = reqKeys.map((k) => ordered.flatMap((r) => r.requirementFindings).find((f) => f.requirementKey === k && f.met === met.get(k))!);
  const competencyFindings = compKeys.map((k) => ordered.flatMap((r) => r.competencyFindings).find((f) => f.competencyKey === k && f.finding === found.get(k))!);
  return {
    ...closest,
    overall,
    recommendation: mostCommon(readings.map((r) => r.recommendation), closest.recommendation),
    confidence,
    requirementFindings,
    competencyFindings,
  };
}

/**
 * Checks every quote in a résumé assessment against the text it cites (plan 0.9, through `applyEvidenceRules`).
 * Sources not listed (playbook, benchmark, owner statements) are not candidate claims and pass through; a candidate
 * source with no text here (a screen or interview quoted in a résumé reading) cannot be checked, so it counts as unverified.
 */
export function verifyAssessmentQuotes(a: EvidenceAssessment, sources: Partial<Record<EvidenceSource, string>>): EvidenceAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(sources)) normalized.set(k, norm(v ?? ""));
  return applyEvidenceRules(a, (e) => {
    const src = normalized.get(e.source);
    if (src === undefined) return CANDIDATE_EVIDENCE_SOURCES.has(e.source) ? false : null;
    return src.includes(norm(e.quote ?? ""));
  });
}

/** The candidate's own record or words: a claim citing one of these must quote it, and the quote is checked. */
export const CANDIDATE_EVIDENCE_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>(["resume", "application", "candidate_statement", "screen", "interview"]);

const NOT_HELD = /\b(expired|lapsed|inactive|revoked|suspended|not renewed|renewal not started)\b/i;
const STILL_HELD = /\b(active|current|valid|reinstated)\b|(?<!\bnot )\brenewed\b/i;

/** Whether a quote says a licence or certificate is not held today: expired and the like, with nothing saying it is again. */
export function shownNotHeld(quote: string): boolean {
  return NOT_HELD.test(quote) && !STILL_HELD.test(quote);
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
 * The evidence rules every reading passes before anyone sees it (plan 0.9). `inSource(e)` says whether a non-empty quote
 * is in the text it cites: true, false, or null for a source that is not the candidate's (it passes through).
 * - A strength or concern whose quote is not in the source is dropped.
 * - A competency or must-have finding whose quote is not in the source keeps its place without the quote: "evidenced"
 *   becomes "partially evidenced", a must-have "yes" becomes "partially".
 * - A must-have "no" stands only on a verified quote from the candidate; otherwise it becomes "unknown". A gap is a
 *   question for the screen, never a conclusion.
 * - A must-have whose verified quote says it is expired, lapsed, inactive, revoked, suspended or not renewed (and not
 *   also active, current, renewed or valid) is "no", whatever the reading said: the fairness run on Haiku 5.5 (14 Oct
 *   2026) quoted "RDH license CA expired in 2021; renewal not started" and still wrote "unknown" in two readings of three.
 * - A claim about the candidate with nothing quoted is kept and marked `unquoted`, so the page says "no quote".
 * - When any of that happened the confidence steps down one level, and the reasons say why.
 * The model's own `unquoted` marks are never trusted: the flag is recomputed here.
 */
export function applyEvidenceRules<T extends Readable>(a: T, inSource: (e: Evidence) => boolean | null): T {
  type Check = "verified" | "failed" | "external" | "none";
  const check = (e: Evidence | undefined): Check => {
    if (!e?.quote?.trim()) return "none";
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
  const keepClaim = (f: Claim): Claim | null => {
    if (check(f.evidence) === "failed") {
      dropped += 1;
      return null;
    }
    return { ...f, evidence: marked(f.evidence) };
  };
  const strengths = a.strengths.map(keepClaim).filter((f): f is Claim => f !== null);
  const concerns = a.concerns.map(keepClaim).filter((f): f is Claim => f !== null);
  const competencyFindings = a.competencyFindings.map((f): CompetencyFinding => {
    if (check(f.evidence) !== "failed") return { ...f, evidence: f.evidence ? marked(f.evidence) : undefined };
    dropped += 1;
    return { ...f, evidence: stripped(f.evidence!), finding: f.finding === "evidenced" ? "partially_evidenced" : f.finding, note: [f.note, "quote could not be verified against the source"].filter(Boolean).join("; ") };
  });
  const requirementFindings = a.requirementFindings.map((f): RequirementFinding => {
    const c = check(f.evidence);
    if (c === "failed") dropped += 1;
    const evidence = !f.evidence ? undefined : c === "failed" ? stripped(f.evidence) : marked(f.evidence);
    if (f.met === "no" && c !== "verified") {
      mustHaveNoWithoutQuote += 1;
      return { ...f, evidence, met: "unknown" };
    }
    // only on the candidate's own record or words: a recruiter's call note never makes a must-have "no"
    if (c === "verified" && f.evidence && CANDIDATE_EVIDENCE_SOURCES.has(f.evidence.source) && shownNotHeld(f.evidence.quote ?? "")) return { ...f, evidence, met: "no" };
    return { ...f, evidence, met: c === "failed" && f.met === "yes" ? "partially" : f.met };
  });
  if (!dropped && !mustHaveNoWithoutQuote) return { ...a, strengths, concerns, competencyFindings, requirementFindings };
  const anomalies = dropped ? [...a.anomalies, { kind: "unverified_quote", detail: `${dropped} claim${dropped === 1 ? "" : "s"} cited text that is not in the source and ${dropped === 1 ? "was" : "were"} discarded` }] : a.anomalies;
  // Dropping a claim lowers what the owner can rely on; say so where the card explains the confidence.
  const reasons = [...(a.confidenceReasons ?? [])];
  if (dropped) reasons.push(`${dropped === 1 ? "one claim" : `${dropped} claims`} quoted text that is not in the source and ${dropped === 1 ? "was" : "were"} dropped`);
  if (mustHaveNoWithoutQuote) reasons.push(`${mustHaveNoWithoutQuote === 1 ? "one must-have was" : `${mustHaveNoWithoutQuote} must-haves were`} marked not met with nothing quoted to show it, so ${mustHaveNoWithoutQuote === 1 ? "it is" : "they are"} treated as unknown`);
  // The schema allows six reasons; the newest (why the confidence just dropped) are the ones to keep.
  return { ...a, strengths, concerns, competencyFindings, requirementFindings, anomalies, confidence: stepDownConfidence(a.confidence), confidenceReasons: reasons.slice(-6) };
}
