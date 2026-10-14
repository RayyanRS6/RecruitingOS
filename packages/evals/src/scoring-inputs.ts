import { scorecardInput, scoringInput, type ScoringIdentity, type ScoringView } from "@ros/agents";
import { screenAssessPrompt, triageAssessPrompt, type PromptDef, type ScreenContext, type TriageInput } from "@ros/ai";
import type { EligibilityResult, ResumeExtraction, RolePacket } from "@ros/contracts";

/**
 * What the scoring readings are sent, built exactly as the app builds it (founder decision D-04 = C, Wave S2): the résumé
 * reading (`triage.assess`) through `scoringInput` and the scorecard (`screen.assess`) through `scorecardInput`, both in
 * packages/agents. The evals never assemble these inputs by hand, so a fairness case tests what the model really reads.
 * Pure code, no model and no database: tested in scoring-inputs.test.ts.
 */

/** An earlier application by the same person to the same company, as the team sees it on the candidate's page. */
export type EarlierApplication = { roleTitle: string; appliedAt: string; outcome: "not_moving_forward" | "withdrawn" | "hired"; note?: string };

/**
 * An application as the app stores it when the reading runs: everything the workflow loads (application-intake.ts,
 * the `ready` step), earlier applications included. `scoringInput` takes only what the reading may see.
 */
export type EvalApplication = {
  packet: RolePacket;
  extraction: ResumeExtraction | null;
  resumeText: string | null;
  applicationAnswers: { eligibility: Record<string, unknown>; noResumeSummary?: string };
  eligibility: EligibilityResult | null;
  identity: ScoringIdentity;
  earlierApplications?: readonly EarlierApplication[];
};

/** Everything a prompt sends the model for one input (every system block, then every message), as one text. */
export function modelInputText<I, O>(prompt: PromptDef<I, O>, input: I): string {
  return [...prompt.system(input).map((b) => b.text), ...prompt.messages(input).map((m) => `${m.role}: ${m.content}`)].join("\n\n");
}

/** The messages alone (the candidate's part: résumé, answers, conversation), without the system blocks that hold the job. */
export function modelMessagesText<I, O>(prompt: PromptDef<I, O>, input: I): string {
  return prompt.messages(input).map((m) => m.content).join("\n\n");
}

/**
 * The résumé reading's input for an application, as the app builds it: the scoring view, everything the model is sent
 * (`text`) and the candidate's part of it (`messages`).
 */
export function triageModelInput(app: EvalApplication): { promptInput: TriageInput; view: ScoringView; text: string; messages: string } {
  const { promptInput, view } = scoringInput(app);
  return { promptInput, view, text: modelInputText(triageAssessPrompt, promptInput), messages: modelMessagesText(triageAssessPrompt, promptInput) };
}

/**
 * The scorecard's input for a conversation, as the app builds it: the scoring view, everything the model is sent
 * (`text`) and the candidate's part of it (`messages`).
 */
export function scorecardModelInput(ctx: ScreenContext, identity: ScoringIdentity): { ctx: ScreenContext; view: ScoringView; text: string; messages: string } {
  const { ctx: seen, view } = scorecardInput(ctx, identity);
  return { ctx: seen, view, text: modelInputText(screenAssessPrompt, seen), messages: modelMessagesText(screenAssessPrompt, seen) };
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
