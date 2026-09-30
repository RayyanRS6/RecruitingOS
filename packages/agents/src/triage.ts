import type { EligibilityResult, Evidence, EvidenceAssessment, EvidenceSource, ResumeExtraction, RolePacket } from "@ros/contracts";
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
 * Drops strengths and concerns whose quote is not in the cited source; downgrades requirement and competency
 * findings that relied on an unverifiable quote. Sources not listed (playbook, benchmark, owner statements) are
 * not candidate claims and pass through.
 */
export function verifyAssessmentQuotes(a: EvidenceAssessment, sources: Partial<Record<EvidenceSource, string>>): EvidenceAssessment {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = new Map<string, string>();
  for (const [k, v] of Object.entries(sources)) normalized.set(k, norm(v ?? ""));
  const grounded = (e: Evidence | undefined): boolean => {
    if (!e) return true;
    if (!e.quote) return true;
    const src = normalized.get(e.source);
    if (src === undefined) return true;
    return src.includes(norm(e.quote));
  };
  let dropped = 0;
  const strengths = a.strengths.filter((f) => { const ok = grounded(f.evidence); if (!ok) dropped += 1; return ok; });
  const concerns = a.concerns.filter((f) => { const ok = grounded(f.evidence); if (!ok) dropped += 1; return ok; });
  const competencyFindings = a.competencyFindings.map((f) => {
    if (grounded(f.evidence)) return f;
    dropped += 1;
    return { ...f, evidence: undefined, finding: f.finding === "evidenced" ? ("partially_evidenced" as const) : f.finding, note: [f.note, "quote could not be verified against the source"].filter(Boolean).join("; ") };
  });
  const requirementFindings = a.requirementFindings.map((f) => {
    if (grounded(f.evidence)) return f;
    dropped += 1;
    return { ...f, evidence: undefined, met: f.met === "yes" ? ("partially" as const) : f.met };
  });
  const anomalies = dropped ? [...a.anomalies, { kind: "unverified_quote", detail: `${dropped} claim${dropped === 1 ? "" : "s"} cited text that is not in the source and ${dropped === 1 ? "was" : "were"} discarded` }] : a.anomalies;
  // Dropping a claim lowers what the owner can rely on; say so where the card explains the confidence.
  const confidenceReasons = dropped ? [...(a.confidenceReasons ?? []), `${dropped === 1 ? "one claim" : `${dropped} claims`} quoted text that is not in the source and ${dropped === 1 ? "was" : "were"} dropped`] : a.confidenceReasons;
  return { ...a, strengths, concerns, competencyFindings, requirementFindings, anomalies, ...(confidenceReasons ? { confidenceReasons } : {}) };
}
