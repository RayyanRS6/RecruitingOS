import { MORE_JOBS_UPGRADE_QUESTION, TRIAL_ENDED_LINE, aiHelpLine, jobsTotalLine, mayOfferUpgrade, type PlanLimitDetails, type PlanRoom } from "@ros/contracts";
import { aiCreditRoomForJob, can, entitlements } from "@ros/core";
import type { Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { aiHelpWordsOf, askForMoreAiHelp, talkToItsAboutAiHelp } from "./ai-credit";
import { TRIAL_PLAN_QUESTION, companyTrialStanding } from "./trial";

type Ask = NonNullable<PlanLimitDetails["ask"]>;

/** The request a full plan offers: closing a job would give a place back, so it asks to talk about more. */
const askAboutMoreJobs: Ask = { label: "Talk to ITS about more jobs", reason: "We would like to open more jobs than our plan includes. Can we talk about adding more?" };
/** The same request when the trial has ended: choosing a plan is done by ITS. */
const askToChoosePlan: Ask = { label: "Ask ITS to choose a plan", reason: TRIAL_PLAN_QUESTION };
/** The same request when the plan's jobs are all used for good: closing a job would not help. */
const askToUpgrade: Ask = { label: "Upgrade", reason: MORE_JOBS_UPGRADE_QUESTION };

/** A job's state as the room message names it; an open job needs no word. */
const PLACE_STATUS_WORD: Record<string, string> = { draft: "not published yet", paused: "paused" };

/**
 * Room on the plan for another job, with the jobs using the places, so the owner learns it before answering any
 * question. A job uses a place while it is a draft, open or paused; closing it gives the place back, so a full plan says
 * so, names the jobs using the places, and offers asking ITS about more (`ask`). `newRoleId` is a job created in this
 * very transaction, or the draft being published, which is not counted against itself. A trial that has ended comes
 * first: no new job starts until a plan is chosen, whatever room the plan has. No jobs are listed then: closing one
 * would not help. The same goes for a plan whose jobs ever are all used (`jobs_total`, Free's one job): nothing closed
 * gives that place back, and the way on is to upgrade (`upgrade`). `newDraft`: the question is whether to start a new
 * one, so the AI credit counts too: with too little left to write the job, the owner hears it before anyone types. A job
 * already written does not ask this: writing it was the dear part, and publishing it uses no model.
 */
export async function planRoom(tx: Tx, companyId: string, opts: { newRoleId?: string; now?: Date; newDraft?: boolean } = {}): Promise<PlanRoom> {
  const room = await entitlements.roleRoom(tx, companyId, { except: opts.newRoleId });
  if ((await companyTrialStanding(tx, companyId, opts.now ?? new Date()))?.ended) return { ok: false, limit: room.limit, used: room.used, holding: [], message: TRIAL_ENDED_LINE, ask: askToChoosePlan, trialEnded: true };
  if (room.lifetime?.full) return { ok: false, limit: room.lifetime.limit, used: room.lifetime.used, holding: [], message: jobsTotalLine((await entitlements.planOf(tx, companyId))?.name, room.lifetime.limit), ask: askToUpgrade, upgrade: true };
  if (!room.ok) {
    const names = room.holding.map((r) => (PLACE_STATUS_WORD[r.status] ? `${r.title} (${PLACE_STATUS_WORD[r.status]})` : r.title));
    const message = `Your plan includes ${room.limit} job${room.limit === 1 ? "" : "s"} at a time, and ${room.limit === 1 ? "it is" : "all are"} in use${names.length ? `: ${names.join(", ")}` : ""}. A job uses a place while it is open, paused or not published yet, and closing a job gives its place back. Close a job you no longer need, or talk to ITS about adding more.`;
    return { ok: false, limit: room.limit, used: room.used, holding: room.holding, message, ask: askAboutMoreJobs };
  }
  if (opts.newDraft) {
    const credit = await aiCreditRoomForJob(tx, companyId, { now: opts.now });
    if (credit !== "ok") {
      // On the last plan nothing is above theirs: the line names ITS and the day it starts again, and so does its button.
      const words = await aiHelpWordsOf(tx, companyId, opts.now ?? new Date());
      const nothingAbove = words.planKey !== undefined && !mayOfferUpgrade(words.planKey);
      return { ok: false, limit: room.limit, used: room.used, holding: [], message: aiHelpLine(credit === "used_up" ? "newJob" : "newJobTooBig", words), ask: nothingAbove ? talkToItsAboutAiHelp : askForMoreAiHelp, upgrade: true, aiHelp: true, ...(nothingAbove ? { nothingAbove } : {}) };
    }
  }
  return { ok: true, limit: room.limit, used: room.used, holding: room.holding, message: null, ask: null };
}

/** The 402 a full plan answers with: the room's own line, and in `details` the room and the request this person may send about it. */
export function limitReached(t: Pick<Tenant, "role">, room: PlanRoom): HttpError {
  const details: PlanLimitDetails = { upgrade: !!(room.upgrade || room.trialEnded), ask: can(t.role, "plan.request") ? room.ask : null, room };
  return new HttpError(402, "limit_reached", room.message ?? "Your plan has no room for another job.", details);
}
