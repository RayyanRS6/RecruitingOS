import { MORE_JOBS_UPGRADE_QUESTION, TRIAL_ENDED_LINE, aiHelpLine, jobsTotalLine, mayOfferUpgrade, type PlanRoom } from "@ros/contracts";
import { aiCreditRoomForJob, can, entitlements } from "@ros/core";
import type { Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { aiHelpWordsOf, askForMoreAiHelp, talkToItsAboutAiHelp } from "./ai-credit";
import { TRIAL_PLAN_QUESTION, companyTrialStanding } from "./trial";

const MORE_ROLES_QUESTION = "We would like to open more roles than our plan includes. Can we talk about adding more?";
const askAboutPlan = { label: "Talk to ITS about more roles", method: "POST", path: "/api/v1/plans/request", body: { reason: MORE_ROLES_QUESTION } };
/** The same request when the trial has ended (founder decision L-02 B): choosing a plan is done by ITS. */
const askToChoosePlan = { label: "Ask ITS to choose a plan", method: "POST", path: "/api/v1/plans/request", body: { reason: TRIAL_PLAN_QUESTION } };
/** The same request when the plan's jobs are all used for good: closing a role would not help. */
const askToUpgrade = { label: "Upgrade", method: "POST", path: "/api/v1/plans/request", body: { reason: MORE_JOBS_UPGRADE_QUESTION } };

/** A role's state as the room message names it; an open role needs no word. */
const PLACE_STATUS_WORD: Record<string, string> = { draft: "not published yet", paused: "paused" };

/**
 * Room on the plan for another role (C13), with the roles using the places, so the owner learns it before answering any
 * question. A role uses a place while it is a draft, open or paused; closing it gives the place back, so a full plan
 * says so and names the roles using the places. There is nowhere in the product to change plans, so a full plan also
 * offers asking ITS about more roles. `newRoleId` is a role created in this very transaction, or the draft being
 * published, which is not counted against itself. A trial that has ended comes first (founder decision L-02 B): no new
 * job starts until a plan is chosen, whatever room the plan has, and the message is the owner's one line. No roles are
 * listed then: closing one would not help. The same goes for a plan whose jobs ever are all used (`jobs_total`, Free's one
 * job): nothing closed gives that place back, so no roles are listed, and the way on is to upgrade (`upgrade`).
 * `newDraft`: the question is whether to start a new one, so the AI credit counts too: with too little left to write the
 * job, the owner hears it before anyone types. A draft already written does not ask this: writing it was the dear part, and
 * publishing it uses no model.
 */
export async function planRoom(tx: Tx, companyId: string, opts: { newRoleId?: string; now?: Date; newDraft?: boolean } = {}): Promise<PlanRoom> {
  const room = await entitlements.roleRoom(tx, companyId, { except: opts.newRoleId });
  if ((await companyTrialStanding(tx, companyId, opts.now ?? new Date()))?.ended) return { ok: false, limit: room.limit, used: room.used, holding: [], message: TRIAL_ENDED_LINE, trialEnded: true };
  if (room.lifetime?.full) return { ok: false, limit: room.lifetime.limit, used: room.lifetime.used, holding: [], message: jobsTotalLine((await entitlements.planOf(tx, companyId))?.name, room.lifetime.limit), upgrade: true };
  const names = room.holding.map((r) => (PLACE_STATUS_WORD[r.status] ? `${r.title} (${PLACE_STATUS_WORD[r.status]})` : r.title));
  const message = room.ok
    ? null
    : `Your plan includes ${room.limit} role${room.limit === 1 ? "" : "s"} at a time, and ${room.limit === 1 ? "it is" : "all are"} in use${names.length ? `: ${names.join(", ")}` : ""}. A role uses a place while it is open, paused or not published yet, and closing a role gives its place back. Close a role you no longer need, or talk to ITS about adding more.`;
  if (room.ok && opts.newDraft) {
    const credit = await aiCreditRoomForJob(tx, companyId, { now: opts.now });
    if (credit !== "ok") {
      // On the last plan nothing is above theirs: the line names ITS and the day it starts again, and so does its button.
      const words = await aiHelpWordsOf(tx, companyId, opts.now ?? new Date());
      const nothingAbove = words.planKey !== undefined && !mayOfferUpgrade(words.planKey);
      return { ok: false, limit: room.limit, used: room.used, holding: [], message: aiHelpLine(credit === "used_up" ? "newJob" : "newJobTooBig", words), upgrade: true, aiHelp: true, ...(nothingAbove ? { nothingAbove } : {}) };
    }
  }
  return { ok: room.ok, limit: room.limit, used: room.used, holding: room.holding, message };
}

/** The 402 a full plan answers with: the room's own line, the room, and the request this person may send about it. */
export function limitReached(t: Pick<Tenant, "role">, room: PlanRoom): HttpError {
  const ask = room.trialEnded ? askToChoosePlan : room.aiHelp ? (room.nothingAbove ? talkToItsAboutAiHelp : askForMoreAiHelp) : room.upgrade ? askToUpgrade : askAboutPlan;
  return new HttpError(402, "limit_reached", room.message ?? "Your plan has no room for another role.", { actions: can(t.role, "plan.request") ? [ask] : [], room, ...(room.upgrade ? { upgrade: true } : {}) });
}
