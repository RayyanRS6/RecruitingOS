import { and, eq, inArray } from "drizzle-orm";
import { ROLE_STATUS_LABEL, TRIAL_ENDED_LINE, type HomeJob, type HomeNotice, type HomeView, type RoleStatus } from "@ros/contracts";
import { aiCreditView, can } from "@ros/core";
import { companies, roles, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { askForAiHelpOn } from "./ai-credit";
import { candidateCounts } from "./candidates";
import { draftSummaries } from "./drafts";
import { planRoom } from "./plan-room";
import { TRIAL_ENDING_PLAN_QUESTION, TRIAL_PLAN_QUESTION, companyTrialStanding, trialDateWords } from "./trial";

/**
 * GET /api/v1/home: the open and paused jobs with how many people are new to review and how many finished the AI
 * interview (the one with the most to review first), this person's unfinished drafts, the plan's room for another job,
 * and the notices about the trial and the plan's AI help. Counts only: nobody is named here, and nobody past the plan's
 * candidates per job is counted in "to review".
 */
export async function homeView(tx: Tx, container: Pick<Container, "engine">, t: Pick<Tenant, "companyId" | "userId" | "role">): Promise<HomeView> {
  const now = container.engine.clock();
  const live = await tx.select({ id: roles.id, title: roles.title, status: roles.status }).from(roles).where(and(eq(roles.companyId, t.companyId), inArray(roles.status, ["open", "paused"])));
  const counts = await candidateCounts(tx, live.map((r) => r.id));
  const jobs: HomeJob[] = live.map((r) => {
    const c = counts.get(r.id);
    const status = r.status as RoleStatus;
    return { id: r.id, title: r.title, status, statusLabel: ROLE_STATUS_LABEL[status], toReview: c?.byTab.new ?? 0, interviewed: c?.byTab.interviewed ?? 0, applicants: c?.total ?? 0 };
  });
  jobs.sort((a, b) => b.toReview - a.toReview || b.interviewed - a.interviewed || a.title.localeCompare(b.title));
  // this person's own drafts, each the one summary the Jobs page and the builder's first page show too
  const drafts = await draftSummaries(tx, { companyId: t.companyId, userId: t.userId });
  return { jobs, drafts, room: await planRoom(tx, t.companyId, { now, newDraft: true }), notices: await homeNotices(tx, t, now) };
}

/** The lines above everything on Home: the trial ending or ended, and the plan's AI help at 80% or used up, each with the request it offers. */
async function homeNotices(tx: Tx, t: Pick<Tenant, "companyId" | "role">, now: Date): Promise<HomeNotice[]> {
  const mayAsk = can(t.role, "plan.request");
  const [company] = await tx.select({ planKey: companies.planKey, timezone: companies.timezone }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
  const notices: HomeNotice[] = [];
  const trial = await companyTrialStanding(tx, t.companyId, now);
  const choosePlan = (reason: string) => (mayAsk ? { label: "Ask ITS to choose a plan", reason } : null);
  if (trial?.ended) notices.push({ kind: "trial_ended", title: "Your trial has ended", body: TRIAL_ENDED_LINE, upgrade: true, ask: choosePlan(TRIAL_PLAN_QUESTION) });
  else if (trial?.endingSoon && trial.endsAt) notices.push({ kind: "trial_ending", title: `Your trial ends on ${trialDateWords(trial.endsAt, company?.timezone)}`, body: "After that, new applications, new jobs and new AI interviews pause until a plan is chosen; everything already started carries on.", upgrade: true, ask: choosePlan(TRIAL_ENDING_PLAN_QUESTION) });
  const credit = await aiCreditView(tx, t.companyId, { now, timeZone: company?.timezone, planKey: company?.planKey });
  if (credit?.level && credit.notice) notices.push({ kind: credit.level === "used_up" ? "ai_help_used_up" : "ai_help_warning", title: credit.notice.title, body: credit.notice.body, upgrade: true, ask: mayAsk ? askForAiHelpOn(company?.planKey) : null });
  return notices;
}
