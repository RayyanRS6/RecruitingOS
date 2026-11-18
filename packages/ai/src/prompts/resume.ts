import { ResumeExtraction } from "@ros/contracts";
import { FAIRNESS_RULES, type PromptDef } from "./registry";

export type ResumeInput = { text: string; filename?: string };

const SYSTEM = `You extract structured facts from a resume. Extract only what is written; quote the supporting line for each position, license, and education entry. Name each license and certification by its short name as the resume writes it ("RDH", "RDA", "RN", "BLS"), with the state or country in jurisdiction and the number and expiry date when written; the status words stay in the quote. Do not infer age or any protected characteristic. Flag anomalies (date inconsistencies, contradictions, signs of AI-generated boilerplate) without judging the candidate.

${FAIRNESS_RULES}`;

/** The CV's facts, read once per application: positions, licences, certifications and skills, each with the line it rests on. */
export const resumeExtractPrompt: PromptDef<ResumeInput, ResumeExtraction> = {
  key: "resume.extract",
  version: 2,
  task: "resume.extract",
  agent: "triage",
  schema: ResumeExtraction,
  system: () => [{ text: SYSTEM, cache: true }],
  messages: (input) => [
    { role: "user", content: `<resume filename="${input.filename ?? "resume"}">\n${input.text.slice(0, 40_000)}\n</resume>\n\nExtract the structured facts.` },
  ],
};
