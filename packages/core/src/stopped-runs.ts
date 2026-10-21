/**
 * The request a stopped workflow run raises (packages/workflows/src/engine.ts, failForGood), in plain words: the
 * customer reads it under their recruiter requests and on Today, and the recruiter after accepting it. The error itself
 * stays with the run (`last_error`, the `workflow.failed` event) for ITS, never in front of the customer.
 */
export const STOPPED_WORK: Readonly<Record<string, string>> = {
  application_intake: "Processing this application",
  screen: "The AI interview",
  schedule_interview: "Scheduling this interview",
  role_approval: "Approving this role",
  publish_role: "Publishing this role",
};

export function stoppedRunQuestion(workflowKey: string, attempts: number): string {
  const tries = attempts === 1 ? "the first try" : `${attempts} tries`;
  return `${STOPPED_WORK[workflowKey] ?? "An automatic step"} stopped after ${tries} and needs a person to take over.`;
}

/**
 * The words requests from stopped runs carried before 13 October 2026, unchanged in every version:
 * `Workflow ${key} failed at step "${step}" after ${attempts} attempts: ${error}. Please take over.` The error can run
 * over several lines and hold a provider's JSON.
 */
const LEGACY_STOPPED_RUN = /^Workflow (\S+) failed at step "[^"]*" after (\d+) attempts?: [\s\S]*\. Please take over\.$/;

/**
 * A request's text as it is shown: an old stopped-run request reads in today's plain words (what stopped and how many
 * tries), never the technical error. Only Recruiting OS ever wrote those words (`requestedByKind` "system"), so a
 * request a person raised is always shown as they wrote it, even when they pasted the old error into it. The stored
 * text is never rewritten.
 */
export function plainRequestText(text: string, requestedByKind: string | null | undefined): string {
  if (requestedByKind !== "system") return text;
  const m = LEGACY_STOPPED_RUN.exec(text);
  return m ? stoppedRunQuestion(m[1], Number(m[2])) : text;
}
