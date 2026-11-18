import { WorkflowEngine } from "./engine";
import { applicationIntake } from "./definitions/application-intake";
import { screen } from "./definitions/screen";
import { roleClosingDate } from "./definitions/closing-date";
import { emailNotifications } from "./notification-email";
import { NOTIFICATION_EMAIL_JOB_KIND } from "@ros/core";
import type { EngineDeps, EngineOptions, Services } from "./types";

export * from "./types";
export { WorkflowEngine };
export { AI_HOLD_CHECK_EVERY_MS, AI_HOLD_CHECK_JOB_KIND, AI_HOLD_KEY, AI_OUTAGE_ALERT_KIND, HELD_RELEASE_SPACING_MS, JOB_RETRY_CAP_MS, NEWER_BUILD_PATIENCE_MS, NEWER_BUILD_RETRY_MS, OUTDATED_WORKER_ALERT_KIND, PROVIDER_OUTAGE_PATIENCE_MS, isProviderOutage, jobRetryDelayMs, outageAttempts, providerProblem, retryDelayMs } from "./engine";
export { ROLE_CLOSING_DATE_KEY, armClosingDate } from "./definitions/closing-date";
export { SCREEN_WORKFLOW_KEY, cancelAiInterview, startAiInterview } from "./definitions/screen";
export { ALERT_TEMPLATE, emailNotifications } from "./notification-email";
export { DISCARD_OBJECT_JOB_KIND, discardUnusedObject, examineQuarantinedDocument, processQuarantinedDocument, queueObjectDiscard, recordQuarantineVerdict, type QuarantineExamination, type QuarantineOutcome } from "./documents";
export { unlockApplicants } from "./unlock-applicants";
export { rereadApplicants } from "./reread-applicants";
import { DISCARD_OBJECT_JOB_KIND, discardUnusedObject } from "./documents";

/** Creates the engine with every workflow definition registered. */
export function createEngine(deps: { db: EngineDeps["db"]; services: Omit<Services, "engine">; onJobFailed?: EngineDeps["onJobFailed"]; onStepFailed?: EngineDeps["onStepFailed"] }, opts: EngineOptions = {}): WorkflowEngine {
  const services = deps.services as Services;
  const engine = new WorkflowEngine({ db: deps.db, services, onJobFailed: deps.onJobFailed, onStepFailed: deps.onStepFailed }, opts);
  (services as { engine: WorkflowEngine }).engine = engine;
  engine.register(applicationIntake);
  engine.register(screen);
  // A job's closing date: applications stop at the end of that day in the company's time zone.
  engine.register(roleClosingDate);
  // The emails for updates: one per person whose "Email me updates" is on, and always for an account notice.
  engine.registerJob(NOTIFICATION_EMAIL_JOB_KIND, async (payload, ctx) => { await emailNotifications(deps.db, services, payload, ctx.now); });
  // Stored objects no document row uses any more (a quarantine copy once its verdict committed, a clean copy whose row never moved) are removed here, after the fact.
  engine.registerJob(DISCARD_OBJECT_JOB_KIND, (payload) => discardUnusedObject(deps.db, services.integrations.storage, payload));
  return engine;
}