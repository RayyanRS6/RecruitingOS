import { sql } from "drizzle-orm";
import { errorForLog, raiseAlertOnce, redactString, resolveAlertsOfKind } from "@ros/core";
import { withPlatform } from "@ros/db";
import { providerProblem } from "@ros/workflows";
import type { Container } from "../container";

/**
 * When the AI provider itself is why the job builder's assistant cannot answer: it refuses our account (a bad API key,
 * billing) or it is not answering (an outage). The job builder calls the model inside the request, so nothing is held
 * and tried again as background work is (packages/workflows/src/engine.ts, `holdForProvider`): the owner is told the
 * truth, in words that never say "Try again" (the next try would fail the same way), and a platform administrator gets
 * one critical alert, which stands until the assistant answers in the job builder again. Found on 24 November 2026: the
 * provider answered 401 "invalid x-api-key", every owner read "Try again", and nobody was alerted.
 */

/**
 * The alert's kind. Its own, not the engine's `ai.provider_outage`: the engine resolves that one by itself whenever no
 * background work is held, which would close this one the moment it was raised.
 */
export const ASSISTANT_UNAVAILABLE_ALERT_KIND = "ai.assistant_unavailable";

/** The whole sentence the owner reads, on a turn and on "Write the job" alike. */
export const ASSISTANT_UNAVAILABLE_LINE = "The assistant is not available right now. Your words are saved; try again later.";

type Cause = "account" | "outage";

const TITLE: Record<Cause, string> = {
  account: "The AI provider refuses our account: the job builder cannot answer",
  outage: "The AI provider is not answering: the job builder cannot answer",
};
const WHAT_HAPPENED: Record<Cause, string> = {
  account: "The AI provider refused our account when someone used the job builder",
  outage: "The AI provider did not answer when someone used the job builder",
};
const WHAT_TO_CHECK: Record<Cause, string> = {
  account: "Check the API key (ANTHROPIC_API_KEY in Vercel and on the Railway worker) and the billing at the provider (credit balance).",
  outage: "Check the provider's status page; if it reports nothing, check the API key.",
};

/** The failed call as the runner reports it (`RunOutcome.error`), and which of the job builder's calls it was. */
export type FailedAssistantCall = { error: string; task: "intake.turn" | "intake.compile"; aiRunId?: string };

/**
 * Whether a failed call of the job builder's failed because of the provider (`providerProblem`: "account" or "outage");
 * if so, the alert is raised, once: while one stands, open or acknowledged, nothing more is raised, and two requests
 * failing at the same moment take turns. Anything else (an answer that did not fit, a refusal, a local error) is no
 * provider trouble: false, and the route keeps its usual words. A failure to raise is logged and never reaches the owner.
 */
export async function assistantUnavailable(container: Pick<Container, "db" | "engine">, failed: FailedAssistantCall): Promise<boolean> {
  const cause = providerProblem(failed.error);
  if (!cause) return false;
  const said = redactString(failed.error.trim().replace(/^provider (?:error|threw|unavailable|account):\s*/, "")).slice(0, 200);
  try {
    await withPlatform(container.db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ASSISTANT_UNAVAILABLE_ALERT_KIND}))`);
      await raiseAlertOnce(tx, {
        kind: ASSISTANT_UNAVAILABLE_ALERT_KIND,
        severity: "critical",
        title: TITLE[cause],
        body: `${WHAT_HAPPENED[cause]}, so the assistant cannot answer anyone and no job can be written until this is fixed. ${WHAT_TO_CHECK[cause]} The error was: ${said}. The person was told that the assistant is not available and to try again later; their words are saved. This alert resolves by itself the next time the assistant answers in the job builder.`,
        details: { cause, task: failed.task, ...(failed.aiRunId ? { aiRunId: failed.aiRunId } : {}) },
      }, { now: container.engine.clock() });
    });
  } catch (err) {
    console.warn(`[intake] could not raise the alert that the assistant is not available: ${errorForLog(err)}`);
  }
  return true;
}

/**
 * A model call of the job builder's succeeded, so the provider answers: the alert, if one stands, is resolved, and the
 * next trouble is a new alert. A failure to resolve is logged and never reaches the owner.
 */
export async function assistantAnswered(container: Pick<Container, "db" | "engine">): Promise<void> {
  try {
    await withPlatform(container.db, (tx) => resolveAlertsOfKind(tx, ASSISTANT_UNAVAILABLE_ALERT_KIND, { now: container.engine.clock(), reason: "the assistant answered in the job builder again" }));
  } catch (err) {
    console.warn(`[intake] could not resolve the alert that the assistant is not available: ${errorForLog(err)}`);
  }
}
