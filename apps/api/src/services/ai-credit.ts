import { AI_HELP_UPGRADE_QUESTION } from "@ros/contracts";
import { aiCreditRoomSoon, can } from "@ros/core";
import { withTenant } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";

/**
 * How the owner meets the AI credit (packages/core/src/ai-credit.ts) on the routes they use: a plain line and a way to
 * upgrade, in words, never dollars, and never "try again" or "bring in a recruiter", which would be false or would offer a
 * free person in place of an upgrade. A candidate never comes here: their pages carry on in the job's own words. The one
 * exception is a call refused only for money held by work still running: nothing is used up, and trying again is what is true.
 */

/** The way on: the "ask ITS" request about the plan, which never uses one of the plan's recruiter requests. */
export const askForMoreAiHelp = { label: "Upgrade", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: AI_HELP_UPGRADE_QUESTION } };

/** 402, never 502: nothing failed. `message`: one of `AI_HELP_LINE`. */
export function aiCreditRefusal(t: Pick<Tenant, "role">, message: string): HttpError {
  return new HttpError(402, "ai_credit_used_up", message, { actions: can(t.role, "escalation.create") ? [askForMoreAiHelp] : [], upgrade: true });
}

/** Refused only for money held by work still running (`refusedForNow`): nothing to upgrade, and it comes back within minutes. `message`: one of `AI_HELP_LINE`'s busy lines. */
export function aiHelpBusy(message: string): HttpError {
  return new HttpError(409, "ai_help_busy", message);
}

/** Whether a call the credit refused fits on the money actually spent, so only the holds of calls still running stand in its way. */
export function refusedForNow(container: Pick<Container, "db" | "engine">, companyId: string, holdUsd: number): Promise<boolean> {
  return withTenant(container.db, companyId, (tx) => aiCreditRoomSoon(tx, { companyId, holdUsd, now: container.engine.clock() }));
}

/** The refusal in the words that are true: used up, or for now. */
export async function aiCreditAnswer(container: Pick<Container, "db" | "engine">, t: Pick<Tenant, "companyId" | "role">, holdUsd: number, lines: { usedUp: string; busy: string }): Promise<HttpError> {
  return (await refusedForNow(container, t.companyId, holdUsd)) ? aiHelpBusy(lines.busy) : aiCreditRefusal(t, lines.usedUp);
}
