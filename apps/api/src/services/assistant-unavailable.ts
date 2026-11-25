import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { errorForLog, raiseAlertOnce, redactString, resolveAlertsOfKind } from "@ros/core";
import { aiRuns, withPlatform, type Tx } from "@ros/db";
import { providerProblem } from "@ros/workflows";
import type { Container } from "../container";

/**
 * When the AI provider itself is why the assistant cannot answer inside a request: it refuses our account (a bad API key,
 * billing) or it is not answering (an outage). The job builder (a turn, "Write the job") and Settings ("Draft it for me"
 * for the text about the company) call the model inside the request, so nothing is held and tried again as background
 * work is (packages/workflows/src/engine.ts, `holdForProvider`): the owner is told the truth, in words that never say
 * "Try again" (the next try would fail the same way), and a platform administrator gets one critical alert, which
 * stands until the assistant answers one of those requests again. Found on 24 November 2026: the provider answered 401
 * "invalid x-api-key", every owner read "Try again", and nobody was alerted.
 */

/**
 * The alert's kind. Its own, not the engine's `ai.provider_outage`: the engine resolves that one by itself whenever no
 * background work is held, which would close this one the moment it was raised.
 */
export const ASSISTANT_UNAVAILABLE_ALERT_KIND = "ai.assistant_unavailable";

/** What the owner reads first, wherever the assistant was asked. */
const NOT_AVAILABLE = "The assistant is not available right now.";

/** The whole sentence the owner reads in the job builder, on a turn and on "Write the job" alike: what they typed there is saved with the draft. */
export const ASSISTANT_UNAVAILABLE_LINE = `${NOT_AVAILABLE} Your words are saved; try again later.`;

/**
 * The same for "Draft it for me" on the text about the company. Nothing typed there is stored until a text is approved,
 * so this one promises nothing about saved words; it names the other way on, as that page's other failure does.
 */
export const ASSISTANT_UNAVAILABLE_ABOUT_LINE = `${NOT_AVAILABLE} Try again later, or write the text yourself.`;

type Cause = "account" | "outage";

/** The calls the assistant answers inside a request, and where a person meets each. */
type AssistantTask = "intake.turn" | "intake.compile" | "company.about";

const TITLE: Record<Cause, string> = {
  account: "The AI provider refuses our account: the job builder cannot answer",
  outage: "The AI provider is not answering: the job builder cannot answer",
};
/** What the person was doing, for the alert. */
const WHERE: Record<AssistantTask, string> = {
  "intake.turn": "used the job builder",
  "intake.compile": "used the job builder",
  "company.about": "asked for a draft of the text about their company, in Settings",
};
const WHAT_HAPPENED: Record<Cause, string> = {
  account: "The AI provider refused our account when someone",
  outage: "The AI provider did not answer when someone",
};
const WHAT_TO_CHECK: Record<Cause, string> = {
  account: "Check the API key (ANTHROPIC_API_KEY in Vercel and on the Railway worker) and the billing at the provider (credit balance).",
  outage: "Check the provider's status page; if it reports nothing, check the API key.",
};
/** What the person read, for the alert: true to the sentence each place shows. */
const WHAT_THEY_WERE_TOLD: Record<AssistantTask, string> = {
  "intake.turn": "The person was told that the assistant is not available and to try again later; their words are saved.",
  "intake.compile": "The person was told that the assistant is not available and to try again later; their words are saved.",
  "company.about": "The person was told that the assistant is not available, and to try again later or write the text themselves.",
};

/** The failed call as the runner reports it (`RunOutcome.error`), and which of the assistant's calls it was. */
export type FailedAssistantCall = { error: string; task: AssistantTask; aiRunId?: string };

/** The model calls made inside a request (the job builder's, and the draft of the text about the company), whose failures count towards an outage. */
const ASSISTANT_PROMPTS = ["intake.turn", "intake.compile", "intake.extract", "company.about"];
/**
 * An outage is alerted from its second failure within this long. A provider now and then answers one call "overloaded"
 * or too late and the next one well: that one call tells the owner the truth and wakes nobody. A refused account (a bad
 * key, billing) never mends by itself, so it is alerted at once.
 */
export const OUTAGE_ALERT_WINDOW_MINUTES = 10;

/** Whether another of those calls met the provider not answering within the window, before this one. */
async function failedJustBefore(tx: Tx, failed: FailedAssistantCall): Promise<boolean> {
  const rows = await tx
    .select({ error: aiRuns.error })
    .from(aiRuns)
    .where(and(inArray(aiRuns.promptKey, ASSISTANT_PROMPTS), eq(aiRuns.status, "error"), sql`${aiRuns.createdAt} > now() - ${sql.raw(`interval '${OUTAGE_ALERT_WINDOW_MINUTES} minutes'`)}`, failed.aiRunId ? ne(aiRuns.id, failed.aiRunId) : undefined))
    .limit(20);
  return rows.some((r) => providerProblem(r.error ?? "") === "outage");
}

/**
 * Whether a failed call of the assistant's failed because of the provider (`providerProblem`: "account" or "outage");
 * if so, the alert is raised, once: while one stands, open or acknowledged, nothing more is raised, and two requests
 * failing at the same moment take turns. A refused account is alerted at once; an outage from its second failure within
 * `OUTAGE_ALERT_WINDOW_MINUTES` (the owner reads the same true sentence either way). Anything else (an answer that did
 * not fit, a refusal, a local error) is no provider trouble: false, and the route keeps its usual words. A failure to
 * raise is logged and never reaches the owner.
 */
export async function assistantUnavailable(container: Pick<Container, "db" | "engine">, failed: FailedAssistantCall): Promise<boolean> {
  const cause = providerProblem(failed.error);
  if (!cause) return false;
  const said = redactString(failed.error.trim().replace(/^provider (?:error|threw|unavailable|account):\s*/, "")).slice(0, 200);
  try {
    await withPlatform(container.db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ASSISTANT_UNAVAILABLE_ALERT_KIND}))`);
      if (cause === "outage" && !(await failedJustBefore(tx, failed))) return;
      await raiseAlertOnce(tx, {
        kind: ASSISTANT_UNAVAILABLE_ALERT_KIND,
        severity: "critical",
        title: TITLE[cause],
        body: `${WHAT_HAPPENED[cause]} ${WHERE[failed.task]}, so the assistant cannot answer anyone and no job can be written until this is fixed. ${WHAT_TO_CHECK[cause]} The error was: ${said}. ${WHAT_THEY_WERE_TOLD[failed.task]} This alert resolves by itself the next time the assistant answers in the job builder or in Settings.`,
        details: { cause, task: failed.task, ...(failed.aiRunId ? { aiRunId: failed.aiRunId } : {}) },
      }, { now: container.engine.clock() });
    });
  } catch (err) {
    console.warn(`[intake] could not raise the alert that the assistant is not available: ${errorForLog(err)}`);
  }
  return true;
}

/**
 * One of those model calls succeeded, so the provider answers: the alert, if one stands, is resolved, and the next
 * trouble is a new alert. `where`: the place it answered, for the record. A failure to resolve is logged and never
 * reaches the owner.
 */
export async function assistantAnswered(container: Pick<Container, "db" | "engine">, where: "in the job builder" | "in Settings" = "in the job builder"): Promise<void> {
  try {
    await withPlatform(container.db, (tx) => resolveAlertsOfKind(tx, ASSISTANT_UNAVAILABLE_ALERT_KIND, { now: container.engine.clock(), reason: `the assistant answered ${where} again` }));
  } catch (err) {
    console.warn(`[intake] could not resolve the alert that the assistant is not available: ${errorForLog(err)}`);
  }
}
