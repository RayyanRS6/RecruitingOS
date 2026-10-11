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
 * Evidence-based assessment (Triage agent, Slice 2). The model reads; code verifies every quote against the
 * source text and discards any claim whose quote cannot be found, so nothing invented reaches the owner.
 */
export async function assessApplication(db: Db, ai: AiRuntime, input: AssessInput): Promise<RunOutcome<EvidenceAssessment>> {
  const out = await runPromptDetached(
    db,
    ai,
    triageAssessPrompt,
    { packet: input.packet, extraction: input.extraction, resumeText: input.resumeText, applicationAnswers: input.applicationAnswers, eligibility: input.eligibility, priorApplications: input.priorApplications },
    { companyId: input.companyId, workflowRunId: input.workflowRunId ?? null, inputRef: { applicationId: input.applicationId, resumeChars: input.resumeText?.length ?? 0, hasExtraction: !!input.extraction } },
  );
  if (!out.ok) return out;
  const sources: Partial<Record<EvidenceSource, string>> = {
    resume: input.resumeText ?? "",
    application: `${input.applicationAnswers.noResumeSummary ?? ""}\n${JSON.stringify(input.applicationAnswers.eligibility)}`,
    candidate_statement: input.applicationAnswers.noResumeSummary ?? "",
  };
  return { ...out, output: verifyAssessmentQuotes(out.output, sources) };
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
