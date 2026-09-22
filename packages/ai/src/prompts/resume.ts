import { ResumeExtraction } from "@ros/contracts";
import { FAIRNESS_RULES, type PromptDef } from "./registry";

export type ResumeInput = { text: string; filename?: string };

const SYSTEM = `You extract structured facts from a resume. Extract only what is written; quote the supporting line for each position, license, and education entry. Do not infer age or any protected characteristic. Flag anomalies (date inconsistencies, contradictions, signs of AI-generated boilerplate) without judging the candidate.

${FAIRNESS_RULES}`;

export const resumeExtractPrompt: PromptDef<ResumeInput, ResumeExtraction> = {
  key: "resume.extract",
  version: 1,
  task: "resume.extract",
  agent: "triage",
  schema: ResumeExtraction,
  system: () => [{ text: SYSTEM, cache: true }],
  messages: (input) => [
    { role: "user", content: `<resume filename="${input.filename ?? "resume"}">\n${input.text.slice(0, 40_000)}\n</resume>\n\nExtract the structured facts.` },
  ],
};
