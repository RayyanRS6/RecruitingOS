import { redactContactDetails } from "@ros/contracts";
import { redactString } from "@ros/core";
import type { JobFailedInfo, StepFailedInfo } from "@ros/workflows";

/**
 * What a failed job or workflow run tells the error reporter (audit remediation H2). The message is fixed per kind,
 * so the reports group by what failed and never carry whatever text the failing step produced; the last error goes
 * into the context only, after the secret scrubber, the scrub for addresses and phone numbers written anywhere in it
 * (`redactContactDetails`; the shared scrubber removes those in query strings only), and a cut at 300 characters. A
 * provider's message that names a recipient therefore reaches the report as "could not deliver to [redacted]". The
 * platform-admin alert in the console keeps the fuller text; it never leaves the database.
 */
export const FAILURE_TEXT_LIMIT = 300;

/** The error text as it may leave the process: secrets, addresses and numbers gone, and no longer than the limit. */
export function describeFailure(text: string): string {
  const scrubbed = redactContactDetails(redactString(text));
  return scrubbed.length > FAILURE_TEXT_LIMIT ? `${scrubbed.slice(0, FAILURE_TEXT_LIMIT)}...` : scrubbed;
}

export type FailureReport = { err: Error; context: Record<string, unknown> };

/** A queued job that used up its attempts: the kind and the id, never the payload. */
export function jobFailureReport(info: JobFailedInfo): FailureReport {
  return {
    err: new Error(`job ${info.kind} failed for good after ${info.attempts} ${info.attempts === 1 ? "attempt" : "attempts"}`),
    context: { process: "queue", where: "job", kind: info.kind, jobId: info.jobId, attempts: info.attempts, error: describeFailure(info.error) },
  };
}

/** A workflow run that failed for good: keys and ids, never the state. */
export function stepFailureReport(info: StepFailedInfo): FailureReport {
  return {
    err: new Error(`workflow ${info.workflowKey} failed for good at step ${info.step} after ${info.attempts} ${info.attempts === 1 ? "attempt" : "attempts"}`),
    context: { process: "queue", where: "workflow", workflowKey: info.workflowKey, runId: info.runId, step: info.step, attempts: info.attempts, companyId: info.companyId, error: describeFailure(info.error) },
  };
}
