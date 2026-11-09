import { and, count, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { ApplicationStage, HireFollowUp, MembershipRole } from "@ros/contracts";
import { STAGE_LABEL, activeMarksFor, can, closingDayWords, companyToday, notLocked } from "@ros/core";
import { applications, candidates, companies, hiringOutcomes, roles, type Tx } from "@ros/db";
import { inStaffScope, type StaffScope } from "./staff-scope";

/**
 * The hire sheet (plan H1): after a person records a hire with its start date, the people still in the running for the
 * role are the backups to keep warm until that day, and the role can be closed in the same sheet. Today carries a card
 * keyed on the start date ("keep your backups warm") until the hire starts. Nothing here tells anyone anything: who to
 * tell, and when, stays a person's choice (founder decision B6).
 */

/** The steps where someone is still in the running once interviews began: interviewing, finalist, an offer of their own. */
const IN_THE_RUNNING: readonly ApplicationStage[] = ["interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check", "offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding"];
/** Everyone the role close would move to the talent pool. */
const STILL_IN_PROCESS: readonly ApplicationStage[] = ["applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete", ...IN_THE_RUNNING];

type Backup = { applicationId: string; name: string; stageLabel: string };

/**
 * The backups on a role: everyone still in the running at the interview step or later, and anyone shortlisted, other
 * than the person hired. A recruiter given one candidate sees only that candidate. Never someone past the plan's candidates
 * per job (Rule 3): this names people, and the hire sheet is read by everyone who may record a hire.
 */
export async function backupsOn(tx: Tx, input: { roleId: string; hiredApplicationId: string | null; scope?: StaffScope | null }): Promise<Backup[]> {
  const apps = (await tx.select({ id: applications.id, stage: applications.stage, candidateId: applications.candidateId, stageChangedAt: applications.stageChangedAt }).from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.stage, [...STILL_IN_PROCESS]), notLocked())))
    .filter((a) => a.id !== input.hiredApplicationId && inStaffScope(input.scope ?? null, { roleId: input.roleId, applicationId: a.id }));
  const marks = await activeMarksFor(tx, apps.map((a) => a.id));
  const warm = apps.filter((a) => IN_THE_RUNNING.includes(a.stage) || marks.get(a.id)?.mark === "shortlist");
  if (!warm.length) return [];
  const names = await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, warm.map((a) => a.candidateId)));
  // The furthest along first: an offer, then finalists, then interviews.
  return warm
    .sort((a, b) => IN_THE_RUNNING.indexOf(b.stage) - IN_THE_RUNNING.indexOf(a.stage) || Date.parse(a.stageChangedAt) - Date.parse(b.stageChangedAt))
    .map((a) => {
      const n = names.find((x) => x.id === a.candidateId);
      const mark = marks.get(a.id);
      return { applicationId: a.id, name: `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate", stageLabel: !IN_THE_RUNNING.includes(a.stage) && mark ? mark.label : STAGE_LABEL[a.stage] };
    });
}

/**
 * What the hire sheet shows once the hire is recorded: the backups, and closing the role as filled (POST /roles/:id/outcome)
 * while it is still open, with how many people that would move to the talent pool. The close needs outcome.record, as
 * the hire does.
 */
export async function hireFollowUp(tx: Tx, input: { roleId: string; hiredApplicationId: string; startDate: string | null; role: MembershipRole; scope?: StaffScope | null }): Promise<HireFollowUp> {
  const backups = await backupsOn(tx, { roleId: input.roleId, hiredApplicationId: input.hiredApplicationId, scope: input.scope });
  const [role] = await tx.select({ status: roles.status }).from(roles).where(eq(roles.id, input.roleId)).limit(1);
  let closeRole: HireFollowUp["closeRole"] = null;
  if (role && role.status !== "closed" && can(input.role, "outcome.record")) {
    // Who would move to the team's talent pool: someone locked moves with them, but is not the team's to keep (`recordRoleOutcome`).
    const others = (await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.stage, [...STILL_IN_PROCESS]), notLocked()))).filter((a) => a.id !== input.hiredApplicationId).length;
    // Someone who may close the role but not tell candidates a decision (HR) is told who sends the closing message. The
    // safety net is said too (founder decision D-03 A): if nobody tells them, the closing message goes by itself after
    // five working days, or, under settings that keep these messages with a person, an ITS recruiter is brought in.
    const then = can(input.role, "application.reject") ? "and you see the closing message before it goes." : "and an owner, admin, hiring manager or recruiter sends them the closing message from their Home page.";
    const net = "If nobody tells them within 5 working days of closing, the closing message goes by itself (or an ITS recruiter is brought in, if your settings say so).";
    const words = others
      ? `Close the role as filled. The ${others === 1 ? "1 person" : `${others} people`} still in process ${others === 1 ? "moves" : "move"} to your talent pool, privately: nobody is told at once, ${then} ${net}`
      : "Close the role as filled. Nobody else is still in process.";
    closeRole = { path: `/api/v1/roles/${input.roleId}/outcome`, outcome: "filled", stillInProcess: others, words };
  }
  // A number and never who: a recruiter given one candidate reads about nobody else.
  const [lockedRow] = input.scope?.applicationId ? [] : await tx.select({ n: count() }).from(applications).where(and(eq(applications.roleId, input.roleId), isNotNull(applications.lockedAt)));
  const locked = Number(lockedRow?.n ?? 0);
  return { startDate: input.startDate, backups: { count: backups.length, people: backups, ...(locked ? { locked } : {}) }, closeRole };
}

/** A Today card about a hire; the brief adds it with its other cards (kind "hire"). */
export type HireCard = { kind: "hire"; title: string; body: string; roleId: string; applicationId: string; actions: Array<{ label: string; method: "GET"; path: string }> };

/** "Close this job?" once a hire has started: a person's question, so it is a card that needs them. */
export type CloseJobCard = { kind: "needs_review"; title: string; body: string; roleId: string; applicationId: string; actions: Array<{ label: string; method: "GET"; path: string }> };

/**
 * "Close this job?" (6 November 2026): once every hire on a job has started, a job still open or paused asks to be closed,
 * on Home every day until it is. "Keep the role open" used to leave it live and taking applications with nothing asking
 * again. While any hire on it is still to start, the backups card stands instead. For those who may close a role
 * (outcome.record), within a recruiter's grant; never about someone the team may not read.
 */
export async function closeAfterHireCards(tx: Tx, input: { companyId: string; viewer: { role: MembershipRole; scope?: StaffScope | null }; now: Date }): Promise<CloseJobCard[]> {
  if (!can(input.viewer.role, "outcome.record")) return [];
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const today = companyToday(input.now, company?.timezone ?? null);
  const hires = await tx
    .select({ applicationId: hiringOutcomes.applicationId, roleId: hiringOutcomes.roleId, hireDate: hiringOutcomes.hireDate, stage: applications.stage, lockedAt: applications.lockedAt, candidateId: applications.candidateId })
    .from(hiringOutcomes)
    .innerJoin(applications, eq(applications.id, hiringOutcomes.applicationId))
    .where(and(eq(hiringOutcomes.companyId, input.companyId), eq(hiringOutcomes.outcome, "hired_externally"), isNull(hiringOutcomes.correctedAt), isNotNull(hiringOutcomes.hireDate)));
  // The hires that still stand (a corrected or reopened record leaves the stage), by job.
  const byRole = new Map<string, typeof hires>();
  for (const h of hires) if (h.roleId && h.stage === "hired" && !h.lockedAt && inStaffScope(input.viewer.scope ?? null, { roleId: h.roleId })) byRole.set(h.roleId, [...(byRole.get(h.roleId) ?? []), h]);
  if (!byRole.size) return [];
  const live = await tx.select({ id: roles.id, title: roles.title, status: roles.status, acceptingApplications: roles.acceptingApplications }).from(roles).where(and(inArray(roles.id, [...byRole.keys()]), inArray(roles.status, ["open", "paused"])));
  const cards: CloseJobCard[] = [];
  for (const role of live) {
    const own = byRole.get(role.id) ?? [];
    if (own.some((h) => (h.hireDate ?? "").slice(0, 10) >= today)) continue;
    const last = [...own].sort((a, b) => (b.hireDate ?? "").localeCompare(a.hireDate ?? ""))[0];
    const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, last.candidateId)).limit(1);
    const name = `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "Your new hire";
    const still = role.status === "paused" ? "paused, and still open" : role.acceptingApplications ? "still live and taking applications" : "still open";
    cards.push({
      kind: "needs_review",
      title: `Close this job? ${role.title}`,
      body: `${name} started on ${closingDayWords(last.hireDate!)}, and ${role.title} is ${still}. Close it if the job is filled: anyone still in process moves to your talent pool, privately, and you see the closing message before it goes.`,
      roleId: role.id,
      applicationId: last.applicationId!,
      actions: [{ label: "Close the job", method: "GET", path: `/roles/${role.id}?close=1` }],
    });
  }
  return cards;
}

/**
 * "Keep your backups warm" (plan H1), one card per hire whose start date has not passed yet, while anyone else is still
 * in the running for that role. Keyed on the start date: the card goes away the day after the hire starts. Shown to
 * those who read applications, within a recruiter's grant.
 */
export async function backupsWarmCards(tx: Tx, input: { companyId: string; viewer: { role: MembershipRole; scope?: StaffScope | null }; now: Date }): Promise<HireCard[]> {
  if (!can(input.viewer.role, "application.read")) return [];
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const today = companyToday(input.now, company?.timezone ?? null);
  const hires = await tx.select({ applicationId: hiringOutcomes.applicationId, roleId: hiringOutcomes.roleId, hireDate: hiringOutcomes.hireDate }).from(hiringOutcomes).where(and(eq(hiringOutcomes.companyId, input.companyId), eq(hiringOutcomes.outcome, "hired_externally"), isNull(hiringOutcomes.correctedAt), gte(hiringOutcomes.hireDate, today)));
  const cards: HireCard[] = [];
  for (const h of hires) {
    if (!h.applicationId || !h.roleId || !h.hireDate) continue;
    if (!inStaffScope(input.viewer.scope ?? null, { roleId: h.roleId })) continue;
    // The hire still stands: a corrected or reopened record leaves the stage, and the card with it.
    const [hired] = await tx.select({ stage: applications.stage, candidateId: applications.candidateId, lockedAt: applications.lockedAt }).from(applications).where(eq(applications.id, h.applicationId)).limit(1);
    if (hired?.stage !== "hired" || hired.lockedAt) continue;
    const backups = await backupsOn(tx, { roleId: h.roleId, hiredApplicationId: h.applicationId, scope: input.viewer.scope });
    if (!backups.length) continue;
    const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, h.roleId)).limit(1);
    const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, hired.candidateId)).limit(1);
    const name = `${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "Your new hire";
    const when = h.hireDate.slice(0, 10) === today ? "today" : `on ${closingDayWords(h.hireDate)}`;
    const who = backups.slice(0, 5).map((b) => `${b.name} (${b.stageLabel})`).join(", ");
    const one = backups.length === 1;
    cards.push({
      kind: "hire",
      title: `Keep your backups warm until ${name} starts (${role?.title ?? "the role"})`,
      body: `${name} starts ${when}. ${one ? "1 person is" : `${backups.length} people are`} still in the running: ${who}${backups.length > 5 ? ` and ${backups.length - 5} more` : ""}. Keep them in mind and hold off telling them a decision until ${name} has started; if the start falls through, you can pick up where you left off.`,
      roleId: h.roleId,
      applicationId: h.applicationId,
      actions: [{ label: "See them", method: "GET", path: `/roles/${h.roleId}/talent` }],
    });
  }
  return cards;
}
