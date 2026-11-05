import { AI_HELP_UPGRADE_QUESTION } from "@ros/contracts";
import { can } from "@ros/core";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";

/**
 * How the owner meets the AI credit (packages/core/src/ai-credit.ts) on the routes they use: a plain line and a way to
 * upgrade, in words, never dollars, and never "try again" or "bring in a recruiter", which would be false or would offer a
 * free person in place of an upgrade. A candidate never comes here: their pages carry on in the job's own words.
 */

/** The way on: the "ask ITS" request about the plan, which never uses one of the plan's recruiter requests. */
export const askForMoreAiHelp = { label: "Upgrade", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: AI_HELP_UPGRADE_QUESTION } };

/** 402, never 502: nothing failed. `message`: one of `AI_HELP_LINE`. */
export function aiCreditRefusal(t: Pick<Tenant, "role">, message: string): HttpError {
  return new HttpError(402, "ai_credit_used_up", message, { actions: can(t.role, "escalation.create") ? [askForMoreAiHelp] : [], upgrade: true });
}
