import { WorkflowEngine } from "./engine";
import { roleApproval } from "./definitions/role-approval";
import { publishRole } from "./definitions/publish-role";
import { applicationIntake } from "./definitions/application-intake";
import { screen } from "./definitions/screen";
import { stuckRoleDetector } from "./definitions/stuck-role-detector";
export { DEFAULT_VOLUME_ALERT_PER_DAY, localDays, type LocalDays } from "./volume-days";
import { scheduleInterview } from "./definitions/schedule-interview";
import { emailNotifications, notificationDigest } from "./definitions/notification-digest";
import { NOTIFICATION_EMAIL_JOB_KIND } from "@ros/core";
import type { EngineDeps, EngineOptions, Services } from "./types";

export * from "./types";
export { WorkflowEngine };
export { COMPANY_CHECK_WAIT_REASON, companyVerifiedSignal } from "./definitions/publish-role";
export { ALERT_TEMPLATE, DIGEST_TEMPLATE, NOTIFICATION_DIGEST_KEY, emailNotifications, startNotificationDigest } from "./definitions/notification-digest";
export { DISCARD_OBJECT_JOB_KIND, discardUnusedObject, examineQuarantinedDocument, processQuarantinedDocument, queueObjectDiscard, recordQuarantineVerdict, type QuarantineExamination, type QuarantineOutcome } from "./documents";
import { DISCARD_OBJECT_JOB_KIND, discardUnusedObject } from "./documents";

/** Creates the engine with every workflow definition registered. */
export function createEngine(deps: { db: EngineDeps["db"]; services: Omit<Services, "engine">; onJobFailed?: EngineDeps["onJobFailed"]; onStepFailed?: EngineDeps["onStepFailed"] }, opts: EngineOptions = {}): WorkflowEngine {
  const services = deps.services as Services;
  const engine = new WorkflowEngine({ db: deps.db, services, onJobFailed: deps.onJobFailed, onStepFailed: deps.onStepFailed }, opts);
  (services as { engine: WorkflowEngine }).engine = engine;
  engine.register(roleApproval);
  engine.register(publishRole);
  engine.register(applicationIntake);
  engine.register(screen);
  engine.register(stuckRoleDetector);
  engine.register(scheduleInterview);
  // Email alerts (plan B3): the morning summaries, and the emails for updates someone wants as they happen.
  engine.register(notificationDigest);
  engine.registerJob(NOTIFICATION_EMAIL_JOB_KIND, async (payload, ctx) => { await emailNotifications(deps.db, services, payload, ctx.now); });
  // Stored objects no document row uses any more (a quarantine copy once its verdict committed, a clean copy whose row never moved) are removed here, after the fact.
  engine.registerJob(DISCARD_OBJECT_JOB_KIND, (payload) => discardUnusedObject(deps.db, services.integrations.storage, payload));
  return engine;
}
