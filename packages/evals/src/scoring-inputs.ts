import { scorecardInput, scoringInput, type ScoringIdentity, type ScoringView } from "@ros/agents";
import { screenAssessPrompt, triageAssessPrompt, type PromptDef, type ScorecardContext, type TriageInput } from "@ros/ai";
import type { ResumeExtraction, RolePacket, ScreenProgress, ScreenTranscriptEntry } from "@ros/contracts";

/**
 * What the two readings that score are sent, built exactly as the app builds it: the CV reading (`triage.assess`) through
 * `scoringInput` and the AI interview's scorecard (`screen.assess`) through `scorecardInput`, both in packages/agents.
 * The evals never assemble these inputs by hand, so a fairness case tests what the model really reads. Pure code, no
 * model and no database: tested in scoring-inputs.test.ts.
 */

/** An earlier application by the same person to the same company, as the company holds it. The readings are never given one. */
export type EarlierApplication = { roleTitle: string; appliedAt: string; outcome: "not_selected" | "withdrawn" | "hired"; note?: string };

/**
 * An application as the app holds it when the CV is read: what the intake loads (application-intake.ts, the `read`
 * step), and the person's earlier applications beside it. `scoringInput` takes only what the reading may see.
 */
export type EvalApplication = {
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string;
  /** The application form's answers, by question key. */
  formAnswers: Record<string, unknown>;
  identity: ScoringIdentity;
  earlierApplications?: readonly EarlierApplication[];
};

/** A sent AI interview as the app holds it when the scorecard is written: who it is from, the job, and the interview's row. */
export type EvalInterview = {
  packet: RolePacket;
  identity: ScoringIdentity;
  screen: { transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress };
  /** The CV's facts on the application, whose job titles, employers and skills are never hidden as a name. */
  extraction?: ResumeExtraction | null;
};

/** Everything a prompt sends the model for one input (every system block, then every message), as one text. */
export function modelInputText<I, O>(prompt: PromptDef<I, O>, input: I): string {
  return [...prompt.system(input).map((b) => b.text), ...prompt.messages(input).map((m) => `${m.role}: ${m.content}`)].join("\n\n");
}

/** The messages alone (the candidate's part: the CV, the answers, the conversation), without the system blocks that hold the job. */
export function modelMessagesText<I, O>(prompt: PromptDef<I, O>, input: I): string {
  return prompt.messages(input).map((m) => m.content).join("\n\n");
}

/**
 * The CV reading's input for an application, as the app builds it: the scoring view, everything the model is sent
 * (`text`) and the candidate's part of it (`messages`).
 */
export function triageModelInput(app: EvalApplication): { promptInput: TriageInput; view: ScoringView; text: string; messages: string } {
  const { promptInput, view } = scoringInput(app);
  return { promptInput, view, text: modelInputText(triageAssessPrompt, promptInput), messages: modelMessagesText(triageAssessPrompt, promptInput) };
}

/**
 * The scorecard's input for a sent AI interview, as the app builds it: the scoring view, everything the model is sent
 * (`text`) and the candidate's part of it (`messages`).
 */
export function scorecardModelInput(interview: EvalInterview, companyName = "Eval Dental"): { ctx: ScorecardContext; view: ScoringView; text: string; messages: string } {
  const { identity } = interview;
  const candidate = { firstName: identity.firstName ?? "", lastName: identity.lastName ?? "", email: identity.email ?? null, phone: identity.phone ?? null };
  const { ctx, view } = scorecardInput({ screen: interview.screen, candidate, company: { name: companyName }, rolePacket: interview.packet, app: { extraction: interview.extraction ?? null } } as Parameters<typeof scorecardInput>[0]);
  return { ctx, view, text: modelInputText(screenAssessPrompt, ctx), messages: modelMessagesText(screenAssessPrompt, ctx) };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The personal details that reached the model: each of `details` found in `modelInput`. A detail with seven or more
 * digits (a phone number) is found whatever separators the text puts between its digits; any other is found as a whole
 * word, in any case.
 */
export function leakedDetails(modelInput: string, details: readonly string[]): string[] {
  return details.filter((d) => {
    const digits = d.replace(/\D/g, "");
    const pattern = digits.length >= 7 ? digits.split("").join("[^\\d\\n]{0,3}") : `(?<![\\p{L}\\p{N}])${escapeRegExp(d)}(?![\\p{L}\\p{N}])`;
    return new RegExp(pattern, "iu").test(modelInput);
  }).map((d) => `the model was sent "${d}"`);
}

/**
 * The words the job is judged on that the scoring view must keep (places, employers, schools, licences): each one
 * missing from `candidatePart` (the messages, so a place the job's own details name does not hide a loss).
 */
export function lostEvidence(candidatePart: string, kept: readonly string[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  return kept.filter((k) => !norm(candidatePart).includes(norm(k))).map((k) => `the model was not sent "${k}", which the job is judged on`);
}

/** Where two model inputs part, with a little of each around it: empty when they are the same. */
export function modelInputDifference(a: string, b: string): string[] {
  if (a === b) return [];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return [`the model was sent different inputs: ${around(a)} vs ${around(b)}`];
}
