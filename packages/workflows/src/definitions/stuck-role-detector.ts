import { detectStuckRoles, runInterventionLadder } from "@ros/agents";
import type { WorkflowDefinition } from "../types";

type State = { companyId: string; lastRunAt?: string; lastResults?: unknown };

const EVERY_HOURS = 24;

/**
 * docs/06 `stuck_role_detector`: one run per company, forever. Detects, applies the intervention ladder, sleeps a day.
 * Started when the company is created; idempotent by company.
 */
export const stuckRoleDetector: WorkflowDefinition<State> = {
  key: "stuck_role_detector",
  version: 1,
  initialStep: "detect",
  maxAttempts: 5,
  escalationKind: "stuck_role",
  steps: {
    async detect(ctx) {
      const detections = await detectStuckRoles(ctx.q, ctx.companyId, ctx.now);
      const results = await runInterventionLadder(ctx.q, { integrations: ctx.services.integrations, appBaseUrl: ctx.services.env.appBaseUrl, itsQueueEmail: ctx.services.env.itsQueueEmail, now: ctx.now, actor: ctx.actor }, ctx.companyId, detections);
      const until = new Date(ctx.now.getTime() + EVERY_HOURS * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "timer", until, reason: "daily stuck-role check" }, state: { lastRunAt: ctx.now.toISOString(), lastResults: results }, resumeStep: "detect" };
    },
  },
};
