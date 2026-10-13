import { EvidenceAssessment, type EligibilityResult, type ResumeExtraction, type RolePacket } from "@ros/contracts";
import { FAIRNESS_RULES, FINDING_RULES, type PromptDef } from "./registry";

export type TriageInput = {
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string | null;
  applicationAnswers: { eligibility: Record<string, unknown>; noResumeSummary?: string };
  eligibility: EligibilityResult | null;
  priorApplications: Array<{ roleTitle: string; stage: string; at: string }>;
};

const TRIAGE_SYSTEM = `You are the triage specialist of a recruiting department. For one application you produce an evidence-based assessment against the Role Packet so the owner can decide who to talk to. You inform; you never decide.

How to assess:
- Read the resume text and the application. Every strength and concern must cite evidence: source "resume" or "application" with a verbatim quote (a contiguous excerpt of the source text). Quotes are verified in code; a quote that is not in the source is removed and the claim is discarded, so quote exactly. A claim with no quote is shown to the owner marked "no quote" and lowers what they can rely on.
- requirementFindings: one entry per must-have (use the requirement key), decided by the definitions below; when one is unknown, add the question to unknowns.
- competencyFindings: one entry per competency key, decided by the definitions below.
- overall: "strong" when the must-haves are evidenced and several competencies are evidenced; "potential" when most must-haves are evidenced or the evidence is thin but relevant; "weak" ONLY when the evidence contradicts a must-have or shows the candidate does not do this kind of work; "unknown" only when there is too little to say: no resume text and no written description of their work, an unreadable file, or contradictions. A written description of their work in the application is evidence: assess it like a short resume, quoting it with source "application".
- Never mark "weak" for an employment gap, a career change, a non-traditional path, a missing degree, or being "overqualified". Overqualified is at most a concern with the reason stated. Contradictory information becomes an unknown, not a conclusion. Anomalies (possible AI-generated text, date inconsistencies) are listed under anomalies and have no effect on overall.
- unknowns: the questions a screen should ask, each with why it matters for this role.
- recommendation: "screen" when the candidate is eligible and overall is strong or potential; "hold" when overall is weak on evidence; "review_manually" when overall is unknown, the resume could not be read, or the information contradicts itself.
- summary: two or three plain sentences an owner can read in ten seconds. rationale: why the recommendation, citing the findings.
- confidenceReasons: one to four short plain phrases saying what drives the confidence level, written for an owner who is not a recruiter ("no resume, only the written summary", "two must-haves have no evidence", "the dates in the resume contradict each other", "the resume could not be read"). Leave the list empty only when confidence is high and nothing is missing.
- Give no number or score of any kind; the findings are the assessment.

${FINDING_RULES}

${FAIRNESS_RULES}`;

/**
 * What the model is asked for: the assessment without `secondaryScore` (plan 0.9). The model never writes a number; any
 * match score is worked out later in code from the checked findings. The stored column stays, always empty.
 */
export const TriageModelOutput = EvidenceAssessment.omit({ secondaryScore: true });

function packetBlock(p: RolePacket): string {
  const comp = p.compensation;
  return [
    `Role: ${p.identity.title} (${p.identity.employmentType.replace("_", " ")}${p.identity.schedule ? `, ${p.identity.schedule}` : ""}) at ${p.identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ")}.`,
    `Must-haves: ${p.requirements.mustHaves.map((m) => `[${m.key}] ${m.text} (${m.rationale})`).join(" | ")}`,
    `Nice-to-haves: ${p.requirements.niceToHaves.map((m) => `[${m.key}] ${m.text}`).join(" | ") || "none"}`,
    `Competencies: ${p.competencies.map((c) => `[${c.key}] ${c.name}: ${c.definition} Indicators: ${c.indicators.join("; ")}`).join(" | ")}`,
    `Evaluation criteria: ${p.evaluation.criteria.join("; ")}. Red flags to discuss (never automatic): ${p.evaluation.redFlags.join("; ") || "none"}.`,
    `Pay: ${comp.basis} ${comp.min} to ${comp.max} ${comp.currency}.`,
  ].join("\n");
}

// Version 2 (plan 0.9): a must-have "no" needs a quote, and no number is requested.
// Version 3 (fairness run on Haiku 5.5, 14 Oct 2026): written definitions of yes / partially / no / unknown, so the same
// application reads the same each time (one résumé had scored 83, 71 and 67); a written description is evidence when
// there is no resume; the candidate is "the candidate", never named, in the reading's own words.
export const triageAssessPrompt: PromptDef<TriageInput, EvidenceAssessment> = {
  key: "triage.assess",
  version: 3,
  task: "triage.assess",
  agent: "triage",
  schema: TriageModelOutput,
  system: (input) => [
    { text: TRIAGE_SYSTEM, cache: true },
    { text: packetBlock(input.packet), cache: true },
  ],
  messages: (input) => [
    {
      role: "user",
      content: [
        input.resumeText ? `<resume>\n${input.resumeText.slice(0, 40_000)}\n</resume>` : "<resume>(no resume text available)</resume>",
        input.extraction ? `<extraction>\n${JSON.stringify({ positions: input.extraction.positions, licenses: input.extraction.licenses, certifications: input.extraction.certifications, skills: input.extraction.skills, yearsOfExperienceEstimate: input.extraction.yearsOfExperienceEstimate, anomalies: input.extraction.anomalies })}\n</extraction>` : "",
        `<application>\n${input.applicationAnswers.noResumeSummary ? `About their recent work (in their words): ${input.applicationAnswers.noResumeSummary}\n` : ""}Eligibility answers: ${JSON.stringify(input.applicationAnswers.eligibility)}\nEligibility result: ${input.eligibility ? (input.eligibility.passed ? "passed" : `failed ${input.eligibility.failedRules.map((f) => f.key).join(", ")}`) : "not evaluated"}\n</application>`,
        input.priorApplications.length ? `<prior_applications>${input.priorApplications.map((p) => `${p.roleTitle}: ${p.stage} (${p.at.slice(0, 10)})`).join("; ")}</prior_applications>` : "",
        "Assess this application against the Role Packet.",
      ].filter(Boolean).join("\n\n"),
    },
  ],
};
