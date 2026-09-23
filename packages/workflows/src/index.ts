import { WorkflowEngine } from "./engine";
import { roleApproval } from "./definitions/role-approval";
import { publishRole } from "./definitions/publish-role";
import { applicationIntake } from "./definitions/application-intake";
import { screen } from "./definitions/screen";
import { stuckRoleDetector } from "./definitions/stuck-role-detector";
import { scheduleInterview } from "./definitions/schedule-interview";
import type { EngineDeps, EngineOptions, Services } from "./types";

export * from "./types";
export { WorkflowEngine };
export { processQuarantinedDocument, type QuarantineOutcome } from "./documents";

/** Creates the engine with every workflow definition registered. */
export function createEngine(deps: { db: EngineDeps["db"]; services: Omit<Services, "engine"> }, opts: EngineOptions = {}): WorkflowEngine {
  const services = deps.services as Services;
  const engine = new WorkflowEngine({ db: deps.db, services }, opts);
  (services as { engine: WorkflowEngine }).engine = engine;
  engine.register(roleApproval);
  engine.register(publishRole);
  engine.register(applicationIntake);
  engine.register(screen);
  engine.register(stuckRoleDetector);
  engine.register(scheduleInterview);
  return engine;
}
