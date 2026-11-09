import { eq } from "drizzle-orm";
import { AI_HELP_UPGRADE_QUESTION, mayOfferUpgrade } from "@ros/contracts";
import { aiCreditResetsAt, aiCreditRoomSoon, can, closingDayWords, companyToday, entitlements } from "@ros/core";
import { companies, withTenant, type Queryable } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";

/**
 * How the owner meets the AI credit (packages/core/src/ai-credit.ts) on the routes they use: a plain line and a way to
 * upgrade (on the last plan, with nothing above it, a way to ITS and the day it starts again), in words, never dollars,
 * and never "try again" or "bring in a recruiter", which would be false or would offer a free person in place of an
 * upgrade. A candidate never comes here: their pages carry on in the job's own words. The one
 * exception is a call refused only for money held by work still running: nothing is used up, and trying again is what is true.
 */

/** The way on: the "ask ITS" request about the plan, which never uses one of the plan's recruiter requests. */
export const askForMoreAiHelp = { label: "Upgrade", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: AI_HELP_UPGRADE_QUESTION } };
/** The same request on the last plan, where nothing is above theirs: it opens the same sheet, which asks to talk about the plan (the check of 9 November). */
export const talkToItsAboutAiHelp = { ...askForMoreAiHelp, label: "Talk to ITS" };

/** Which of the two a company on this plan is offered. A plan not given reads as one with somewhere to go, as `aiHelpLine` reads it. */
export function askForAiHelpOn(planKey: string | null | undefined): typeof askForMoreAiHelp {
  return planKey === undefined || mayOfferUpgrade(planKey) ? askForMoreAiHelp : talkToItsAboutAiHelp;
}

/** What the owner's AI help lines need of the company (`aiHelpLine`): its plan, and the day its monthly credit starts again, in words on its own calendar. */
export type AiHelpWords = { planKey?: string; resetsOn: string | null };

export async function aiHelpWordsOf(q: Queryable, companyId: string, now: Date): Promise<AiHelpWords> {
  const [company] = await q.select({ planKey: companies.planKey, timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const resetsAt = await aiCreditResetsAt(q, companyId, { now });
  return { planKey: company?.planKey, resetsOn: resetsAt ? closingDayWords(companyToday(new Date(resetsAt), company?.timezone)) : null };
}

/** 402, never 502: nothing failed. `message`: one of `AI_HELP_LINE` (`aiHelpLine`). `planKey`: the company's, so the last plan's button says Talk to ITS. */
export function aiCreditRefusal(t: Pick<Tenant, "role">, message: string, planKey?: string): HttpError {
  return new HttpError(402, "ai_credit_used_up", message, { actions: can(t.role, "escalation.create") ? [askForAiHelpOn(planKey)] : [], upgrade: true });
}

/** Refused only for money held by work still running (`refusedForNow`): nothing to upgrade, and it comes back within minutes. `message`: one of `AI_HELP_LINE`'s busy lines. */
export function aiHelpBusy(message: string): HttpError {
  return new HttpError(409, "ai_help_busy", message);
}

/** Whether a call the credit refused fits on the money actually spent, so only the holds of calls still running stand in its way. */
export function refusedForNow(container: Pick<Container, "db" | "engine">, companyId: string, holdUsd: number): Promise<boolean> {
  return withTenant(container.db, companyId, (tx) => aiCreditRoomSoon(tx, { companyId, holdUsd, now: container.engine.clock() }));
}

/** The refusal in the words that are true: used up, or for now. These lines name no upgrade, but their button does, so it reads the plan. */
export async function aiCreditAnswer(container: Pick<Container, "db" | "engine">, t: Pick<Tenant, "companyId" | "role">, holdUsd: number, lines: { usedUp: string; busy: string }): Promise<HttpError> {
  if (await refusedForNow(container, t.companyId, holdUsd)) return aiHelpBusy(lines.busy);
  const plan = await withTenant(container.db, t.companyId, (tx) => entitlements.planOf(tx, t.companyId));
  return aiCreditRefusal(t, lines.usedUp, plan?.key);
}
