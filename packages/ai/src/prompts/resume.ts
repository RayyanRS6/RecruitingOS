import { ResumeExtraction } from "@ros/contracts";
import { FAIRNESS_RULES, type PromptDef } from "./registry";

export type ResumeInput = { text: string; filename?: string };

const SYSTEM = `You extract structured facts from a resume: the person's name, where they are based, their positions, licenses, certifications and skills, and the years of experience they add up to. Extract only what is written, and nothing else about the person; quote the supporting line for each position, license and certification. Name each license and certification by its short name as the resume writes it ("RDH", "RDA", "RN", "BLS"), with the state or country in jurisdiction and the number and expiry date when written; the status words stay in the quote. Do not infer age or any protected characteristic.

${FAIRNESS_RULES}`;

/**
 * The resume's facts, read once per application: the name and the place, positions, licences, certifications and
 * skills, each with the line it rests on. Nothing is asked for that no code reads.
 */
export const resumeExtractPrompt: PromptDef<ResumeInput, ResumeExtraction> = {
  key: "resume.extract",
  version: 3,
  task: "resume.extract",
  agent: "triage",
  schema: ResumeExtraction,
  system: () => [{ text: SYSTEM, cache: true }],
  messages: (input) => [
    { role: "user", content: `<resume filename="${input.filename ?? "resume"}">\n${input.text.slice(0, 40_000)}\n</resume>\n\nExtract the structured facts.` },
  ],
};
