import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { isCompanyVerified, type Actor } from "@ros/contracts";
import { ALERT_PRIVACY_LINE, DECISION_STAGES, activeFollowUpsFor, activeMarksFor, createEscalation, emit, followUpParked, gate, holdEnded, inCancelled, isOneVisitFlow, isStillApplying, loadBusinessCalendar, notify, resolveNotifyCadence, resolvePolicy, storedPreferences, zonedParts } from "@ros/core";
import { applications, approvalRequests, candidates, companies, interventions, memberships, roles, screens, users, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { queueCommunication } from "./outbox";

/**
 * The stuck-role detector and its intervention ladder (docs/02 "Customer success", docs/06 `stuck_role_detector`).
 * Detectors are read-only and also feed the brief. The ladder records what was done in `interventions`, respects the
 * `intervention.nudge` cooldown policy, and ends in a recruiter escalation so no role rots quietly.
 */

export type Detection = {
  detector: "candidates_waiting" | "screens_unanswered" | "approval_pending" | "no_applicants" | "hold_ended" | "decisions_untold" | "conversations_stuck" | "offers_waiting";
  roleId: string;
  roleTitle: string;
  title: string;
  body: string;
  action: { label: string; href: string };
  days: number;
  /** hold_ended, decisions_untold, offers_waiting and candidates_waiting (longest waiting first): the people concerned, so Today can name them. */
  applicationIds?: string[];
};

const DAYS = 86_400_000;
/** The untold safety net's reminder (founder decision B6, plan-adjustments §4, Q27): after two working days. */
export const UNTOLD_REMIND_WORKING_DAYS = 2;
/** After this many working days nobody has told the candidate, the safety net acts (Q27; decision-messages.ts). */
export const UNTOLD_SEND_WORKING_DAYS = 5;

/**
 * What counts as a working day: the days of the week (0 Sunday to 6 Saturday; Monday to Friday unless the company set
 * its contact days), in a time zone (UTC when none is given), with holidays (YYYY-MM-DD in that zone) left out.
 */
export type WorkingDayRules = { timeZone?: string | null; workDays?: readonly number[] | null; holidays?: ReadonlySet<string> | null };

/**
 * Working days from `from` to `now`, a day at a time: a decision made on Friday morning is two working days old on
 * Tuesday morning (one later when Monday is a holiday). Counting stops at `cap`; only "at least" matters here.
 */
export function workingDaysSince(from: Date, now: Date, cap = 60, rules: WorkingDayRules = {}): number {
  const zone = rules.timeZone || "UTC";
  const days = rules.workDays?.length ? rules.workDays : [1, 2, 3, 4, 5];
  let n = 0;
  for (let t = from.getTime() + DAYS; t <= now.getTime() && n < cap; t += DAYS) {
    const p = zonedParts(new Date(t), zone);
    if (days.includes(p.weekday) && !rules.holidays?.has(p.dayKey)) n += 1;
  }
  return n;
}

/**
 * When the untold safety net may act on a decision made at `from` (Q27): the moment it is `days` working days old,
 * counted as `workingDaysSince` counts them, and that day in the company's calendar (YYYY-MM-DD). The daily check acts at
 * its first run from then on. The candidate panel names the day (`untoldFallbackOn`).
 */
export function untoldFallbackAt(from: Date, rules: WorkingDayRules = {}, days = UNTOLD_SEND_WORKING_DAYS): { at: Date; day: string } {
  const zone = rules.timeZone || "UTC";
  const work = rules.workDays?.length ? rules.workDays : [1, 2, 3, 4, 5];
  let t = from.getTime();
  for (let n = 0, i = 0; n < days && i < 120; i++) {
    t += DAYS;
    const p = zonedParts(new Date(t), zone);
    if (work.includes(p.weekday) && !rules.holidays?.has(p.dayKey)) n += 1;
  }
  return { at: new Date(t), day: zonedParts(new Date(t), zone).dayKey };
}

/**
 * The company's working days for the untold safety net: its time zone, the days it set for contacting candidates
 * (Monday to Friday otherwise), and the holidays on the ITS business calendar.
 */
export async function workingDayRulesFor(q: Queryable, companyId: string, now: Date): Promise<WorkingDayRules> {
  const [company] = await q.select({ timezone: companies.timezone, settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const calendar = await loadBusinessCalendar(q, now);
  const days = company?.settings.businessHours?.days?.filter((d) => d >= 1 && d <= 5);
  return { timeZone: company?.timezone ?? null, workDays: days?.length ? days : null, holidays: new Set(calendar.current.holidays.map((h) => h.date)) };
}

/**
 * The decisions nobody has told the candidate about for two working days or more (declined, or moved to the talent
 * pool; not one whose message waits for an approver): the reminder of the untold safety net. Decisions stay private;
 * the team is reminded, by name, to send the message or record telling them, and hears what happens at five working days
 * (decision-messages.ts `runUntoldSafetyNet`): the standard message goes by itself, or a recruiter is brought in.
 */
function untoldDecisions(role: { id: string; title: string }, apps: Array<typeof applications.$inferSelect>, waitingApproval: Set<string>, names: Map<string, string>, now: Date, rules: WorkingDayRules): Detection | null {
  const age = (a: typeof applications.$inferSelect) => workingDaysSince(new Date(a.rejectedAt ?? a.stageChangedAt), now, 60, rules);
  const late = apps.filter((a) => DECISION_STAGES.includes(a.stage) && a.toldState === "not_told" && !waitingApproval.has(a.id) && age(a) >= UNTOLD_REMIND_WORKING_DAYS);
  if (!late.length) return null;
  const days = Math.max(...late.map(age));
  const who = late.slice(0, 5).map((a) => names.get(a.candidateId) ?? "A candidate").join(", ");
  const one = late.length === 1;
  return { detector: "decisions_untold", roleId: role.id, roleTitle: role.title, days, applicationIds: late.map((a) => a.id), title: `${one ? "1 person has" : `${late.length} people have`} not been told your decision for ${UNTOLD_REMIND_WORKING_DAYS} working days or more (${role.title})`, body: `${who}${late.length > 5 ? ` and ${late.length - 5} more` : ""}. Your decision stays private until someone sends the decision message or records telling ${one ? "them" : "each of them"}. If nobody has after ${UNTOLD_SEND_WORKING_DAYS} working days, the standard message goes by itself and you are told; if your settings ask for approval or keep decision messages with a person, or a recruiter is running the role, a recruiter is brought in instead and nothing is sent. Check the message, then send it.`, action: { label: "Review and send", href: `/roles/${role.id}/talent?ownerStage=not_moving_forward&told=not_told` } };
}

const HOURS = 3_600_000;

/**
 * Whether a conversation offered with the application is still open a day past the moment it should have closed by
 * itself (plan E4, E5): never started, a day past its link's lapse; started and idle, a day past the reminder and the
 * close (72 hours after the last answer); paused, a day past the hand-over to a person (24 hours). Its run stalled, and
 * someone is left "Still applying" with nobody told.
 */
export function conversationOverdue(s: Pick<typeof screens.$inferSelect, "status" | "expiresAt" | "startedAt" | "lastCandidateMessageAt" | "progress">, now: Date): boolean {
  const since = (at: string | null | undefined) => (at ? now.getTime() - Date.parse(at) : 0);
  if (s.status === "paused") return since(s.progress.pausedAt ?? s.lastCandidateMessageAt) > (24 + 24) * HOURS;
  if (s.status === "in_progress") return since(s.lastCandidateMessageAt ?? s.startedAt) > (24 + 48 + 24) * HOURS;
  return ["invited", "reminded"].includes(s.status) && since(s.expiresAt) > 24 * HOURS;
}

/** The steps where a candidate waits on the team for a decision (the finalist too, plan G10). */
const WAITING_ON_TEAM: readonly string[] = ["triaged", "screen_complete", "interview_recommended", "interview_complete", "finalist"];
/** An offer made outside the app with no answer recorded this many days on is the team's to follow up (plan G10, H2). */
export const OFFER_WAIT_DAYS = 5;

/**
 * The applications among these whose decision message waits for an approver: their own request, or the one request for
 * a closed role's closing message (Q30). One query.
 */
export async function decisionsWaitingApproval(q: Queryable, applicationIds: string[]): Promise<Set<string>> {
  if (!applicationIds.length) return new Set();
  const rows = await q.select({ applicationId: approvalRequests.applicationId, proposal: approvalRequests.proposal }).from(approvalRequests).where(and(eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")));
  const wanted = new Set(applicationIds);
  const out = new Set<string>();
  for (const r of rows) {
    if (r.applicationId) { if (wanted.has(r.applicationId)) out.add(r.applicationId); continue; }
    const ids = (r.proposal as { kind?: string; applicationIds?: unknown }).kind === "role_closed" ? (r.proposal as { applicationIds?: unknown }).applicationIds : null;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && wanted.has(id)) out.add(id);
  }
  return out;
}

/** The candidates among these whose details were deleted at their request: nobody is reminded to tell them a decision. */
export async function removedCandidates(q: Queryable, candidateIds: string[]): Promise<Set<string>> {
  if (!candidateIds.length) return new Set();
  const rows = await q.select({ id: candidates.id }).from(candidates).where(and(inArray(candidates.id, [...new Set(candidateIds)]), isNotNull(candidates.anonymizedAt)));
  return new Set(rows.map((r) => r.id));
}

async function candidateNames(q: Queryable, candidateIds: string[]): Promise<Map<string, string>> {
  if (!candidateIds.length) return new Map();
  const rows = await q.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, [...new Set(candidateIds)]));
  return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim() || "A candidate"]));
}

export async function detectStuckRoles(q: Queryable, companyId: string, now: Date): Promise<Detection[]> {
  const out: Detection[] = [];
  // Until ITS confirms the company (founder decision B7) its open roles are not public and its invitations wait in the
  // outbox: "no applicants" and "invitations nobody answered" would be wrong advice, so they wait for the check too.
  const [company] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const publicNow = !!company && isCompanyVerified(company.settings);
  const rules = await workingDayRulesFor(q, companyId, now);
  const open = await q.select().from(roles).where(and(eq(roles.companyId, companyId), eq(roles.status, "open")));
  // A closed role's people were moved to the talent pool privately: they are reminded about too, however long ago it
  // closed, unless the one closing message for all of them waits for its approval (Q30).
  const closed = await q.select({ id: roles.id, title: roles.title }).from(roles).where(and(eq(roles.companyId, companyId), eq(roles.status, "closed")));
  if (closed.length) {
    const decidedOnClosed = await q.select().from(applications).where(and(inArray(applications.roleId, closed.map((r) => r.id)), inArray(applications.stage, [...DECISION_STAGES]), eq(applications.toldState, "not_told")));
    const removed = await removedCandidates(q, decidedOnClosed.map((a) => a.candidateId));
    const untold = decidedOnClosed.filter((a) => !removed.has(a.candidateId));
    const waiting = await decisionsWaitingApproval(q, untold.map((a) => a.id));
    const names = await candidateNames(q, untold.map((a) => a.candidateId));
    for (const role of closed) {
      const d = untoldDecisions(role, untold.filter((a) => a.roleId === role.id), waiting, names, now, rules);
      if (d) out.push(d);
    }
  }
  for (const role of open) {
    const apps = await q.select().from(applications).where(eq(applications.roleId, role.id));
    // A person on hold or set aside nudges nobody until their hold ends (plan A4); their candidate-facing reminders carry on.
    // Nor does someone under Cancelled whose automatic new times are still to come: nothing waits on the team before that day.
    const marks = await activeMarksFor(q, apps.map((a) => a.id));
    const followUps = await activeFollowUpsFor(q, apps.map((a) => a.id));
    const parked = (a: { id: string }) => { const m = marks.get(a.id); const f = followUps.get(a.id); return m?.mark === "on_hold" || m?.mark === "not_a_fit_for_now" || (!!f && followUpParked(f)); };
    // Decisions pending: ready for review, screened, recommended, interviewed with nobody's decision recorded yet, or a
    // finalist with no next step recorded (plan G10). People under Cancelled have a Today card of their own (apps/api
    // brief.ts), so they are never named here as well.
    const waiting = apps.filter((a) => WAITING_ON_TEAM.includes(a.stage) && !parked(a) && !inCancelled(a.stage, followUps.get(a.id)));
    if (waiting.length) {
      const oldest = Math.min(...waiting.map((a) => Date.parse(a.stageChangedAt)));
      const days = Math.floor((now.getTime() - oldest) / DAYS);
      const finalists = waiting.filter((a) => a.stage === "finalist").length;
      const body = finalists === waiting.length
        ? `${finalists === 1 ? "A finalist is" : `${finalists} finalists are`} waiting to hear what comes next: record an offer made, the next step, or not moving forward. Finalists who wait more than a week often take another job.`
        : "They are ready for a decision: invite to a screening chat, interview, decide after an interview, or decline with a reason. Candidates who wait more than a week usually move on.";
      // the people, longest waiting first, so Today can name the first and open them (plan G10)
      const longestFirst = [...waiting].sort((a, b) => Date.parse(a.stageChangedAt) - Date.parse(b.stageChangedAt)).map((a) => a.id);
      if (days >= 3) out.push({ detector: "candidates_waiting", roleId: role.id, roleTitle: role.title, days, applicationIds: longestFirst, title: `${waiting.length} ${waiting.length === 1 ? "candidate has" : "candidates have"} been waiting on you for ${days} days (${role.title})`, body, action: { label: "Review them", href: `/roles/${role.id}/talent` } });
    }
    // An offer made outside the app (plan H2) with no answer recorded: the team checks in with the candidate, then records
    // Accepted or Declined. The team's own follow-up, never a recruiter's.
    const offers = apps.filter((a) => a.stage === "offer_sent" && !parked(a) && now.getTime() - Date.parse(a.stageChangedAt) >= OFFER_WAIT_DAYS * DAYS);
    if (offers.length) {
      const days = Math.floor((now.getTime() - Math.min(...offers.map((a) => Date.parse(a.stageChangedAt)))) / DAYS);
      const names = await candidateNames(q, offers.map((a) => a.candidateId));
      const who = offers.slice(0, 5).map((a) => names.get(a.candidateId) ?? "A candidate").join(", ");
      out.push({ detector: "offers_waiting", roleId: role.id, roleTitle: role.title, days, applicationIds: offers.map((a) => a.id), title: `${offers.length === 1 ? "An offer has" : `${offers.length} offers have`} had no answer recorded for ${days} days (${role.title})`, body: `${who}${offers.length > 5 ? ` and ${offers.length - 5} more` : ""}. Check in with ${offers.length === 1 ? "them" : "each of them"}, then record whether they accepted or declined. The app never sends or changes an offer.`, action: { label: "Review them", href: `/roles/${role.id}/talent?ownerStage=offer` } });
    }
    // Holds whose date has come: the person is back in front of the team, by name on Today.
    const ended = apps.filter((a) => holdEnded(marks.get(a.id), now) && !["hired", "withdrawn", "rejected", "declined", "talent_pool"].includes(a.stage));
    if (ended.length) {
      const since = Math.min(...ended.map((a) => Date.parse(marks.get(a.id)?.remindAt ?? now.toISOString())));
      const names = await q.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, ended.map((a) => a.candidateId)));
      const who = ended.slice(0, 5).map((a) => { const n = names.find((x) => x.id === a.candidateId); return `${n?.firstName ?? ""} ${n?.lastName ?? ""}`.trim() || "A candidate"; }).join(", ");
      out.push({ detector: "hold_ended", roleId: role.id, roleTitle: role.title, days: Math.floor((now.getTime() - since) / DAYS), applicationIds: ended.map((a) => a.id), title: `${ended.length === 1 ? "A hold has" : `${ended.length} holds have`} ended (${role.title})`, body: `${who}${ended.length > 5 ? ` and ${ended.length - 5} more` : ""}. You put ${ended.length === 1 ? "them" : "these people"} on hold until now; decide what comes next: move them on, hold again with a new date, or decline with a reason. Nothing has been sent to them.`, action: { label: "Review them", href: `/roles/${role.id}/talent?ownerStage=on_hold` } });
    }
    const invites = await q.select().from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.status, ["invited", "reminded"]), inArray(screens.applicationId, apps.map((a) => a.id).length ? apps.map((a) => a.id) : ["00000000-0000-0000-0000-000000000000"])));
    // Someone offered the conversation with their application is still applying (plan E6): their reminder and closing
    // run on their own (the application then reaches the team), and the team hears when it ends, not before.
    const stale = invites.filter((s) => s.invitedAt && now.getTime() - Date.parse(s.invitedAt) >= 3 * DAYS && !parked({ id: s.applicationId }) && !isStillApplying(s) && !isOneVisitFlow(s.progress));
    if (stale.length && publicNow) {
      const days = Math.floor((now.getTime() - Math.min(...stale.map((s) => Date.parse(s.invitedAt!)))) / DAYS);
      out.push({ detector: "screens_unanswered", roleId: role.id, roleTitle: role.title, days, title: `${stale.length} screening chat ${stale.length === 1 ? "invite has" : "invites have"} gone unanswered for ${days} days (${role.title})`, body: "A reminder went out automatically. A recruiter can call them, or you can move on to the next candidates.", action: { label: "See who", href: `/roles/${role.id}/talent?stage=screen_invited` } });
    }
    // The conversation that goes with the application closes by itself (E4, E5). One still open well past that point
    // leaves the person "Still applying", unseen by the team and maybe waiting: they are named, for the team to open.
    const offered = apps.length ? await q.select().from(screens).where(and(eq(screens.companyId, companyId), inArray(screens.status, ["invited", "reminded", "in_progress", "paused"]), inArray(screens.applicationId, apps.map((a) => a.id)))) : [];
    const stuck = offered.filter((s) => (isOneVisitFlow(s.progress) || isStillApplying(s)) && conversationOverdue(s, now));
    if (stuck.length) {
      const stuckApps = apps.filter((a) => stuck.some((s) => s.applicationId === a.id));
      const names = await candidateNames(q, stuckApps.map((a) => a.candidateId));
      const who = stuckApps.slice(0, 5).map((a) => names.get(a.candidateId) ?? "A candidate").join(", ");
      const days = Math.floor((now.getTime() - Math.min(...stuckApps.map((a) => Date.parse(a.createdAt)))) / DAYS);
      out.push({ detector: "conversations_stuck", roleId: role.id, roleTitle: role.title, days, applicationIds: stuckApps.map((a) => a.id), title: `${stuckApps.length === 1 ? "1 applicant is" : `${stuckApps.length} applicants are`} stuck in the screening chat (${role.title})`, body: `${who}${stuckApps.length > 5 ? ` and ${stuckApps.length - 5} more` : ""}. Their screening chat should have closed by itself and did not, so their application has not reached you as ready and they may be waiting. Their answers appear only once they send them; a recruiter can contact them.`, action: { label: "See who", href: `/roles/${role.id}/talent` } });
    }
    const pending = await q.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
    const oldPending = pending.filter((p) => p.actionType !== "role_packet.approve" && now.getTime() - Date.parse(p.createdAt) >= 2 * DAYS && !(p.applicationId && parked({ id: p.applicationId })));
    if (oldPending.length) {
      const days = Math.floor((now.getTime() - Math.min(...oldPending.map((p) => Date.parse(p.createdAt)))) / DAYS);
      out.push({ detector: "approval_pending", roleId: role.id, roleTitle: role.title, days, title: `A decision has been waiting ${days} days (${role.title})`, body: oldPending.map((p) => p.rationale ?? p.actionType.replace(/[._]/g, " ")).join("; "), action: { label: "Decide", href: "/" } });
    }
    const notTold = apps.filter((a) => DECISION_STAGES.includes(a.stage) && a.toldState === "not_told");
    const removed = await removedCandidates(q, notTold.map((a) => a.candidateId));
    const decided = notTold.filter((a) => !removed.has(a.candidateId));
    const untold = decided.length ? untoldDecisions(role, decided, await decisionsWaitingApproval(q, decided.map((a) => a.id)), await candidateNames(q, decided.map((a) => a.candidateId)), now, rules) : null;
    if (untold) out.push(untold);
    const daysOpen = role.openedAt ? Math.floor((now.getTime() - Date.parse(role.openedAt)) / DAYS) : 0;
    if (apps.length === 0 && daysOpen >= 14 && publicNow) {
      out.push({ detector: "no_applicants", roleId: role.id, roleTitle: role.title, days: daysOpen, title: `${role.title} has had no applicants in ${daysOpen} days`, body: "Posting on Indeed from your account, asking the team for referrals, or a recruiter search usually fixes this within a week.", action: { label: "See posting options", href: `/roles/${role.id}` } });
    }
  }
  return out;
}

export type LadderLevel = "brief" | "message" | "offer_recruiter" | "escalation";
const LADDER: LadderLevel[] = ["brief", "message", "offer_recruiter", "escalation"];
/**
 * Detectors that only ever tell the team in the app: a hold that ended is the team's own reminder, and so is a decision
 * nobody has told yet (the reminder of the untold safety net; at five working days the safety net acts itself). An offer
 * waiting for an answer goes as far as an email to the team: following up an offer made outside the app is theirs.
 */
const LADDER_TOP: Partial<Record<Detection["detector"], LadderLevel>> = { hold_ended: "brief", decisions_untold: "brief", offers_waiting: "message" };

export type LadderDeps = { integrations: Integrations; appBaseUrl: string; itsQueueEmail: string; now: Date; actor: Actor };

/**
 * Applies the ladder to today's detections and closes interventions whose condition has cleared.
 * Returns what was sent, for the workflow ledger and tests.
 */
export async function runInterventionLadder(q: Queryable, deps: LadderDeps, companyId: string, detections: Detection[]): Promise<Array<{ roleId: string; detector: string; level: LadderLevel | "skipped" | "resolved"; reason?: string }>> {
  const results: Array<{ roleId: string; detector: string; level: LadderLevel | "skipped" | "resolved"; reason?: string }> = [];
  const openInterventions = await q.select().from(interventions).where(and(eq(interventions.companyId, companyId), eq(interventions.status, "sent")));
  for (const iv of openInterventions) {
    const still = detections.some((d) => d.roleId === iv.roleId && d.detector === iv.detector);
    if (!still) {
      await q.update(interventions).set({ status: "resolved", respondedAt: deps.now.toISOString(), response: "condition cleared" }).where(eq(interventions.id, iv.id));
      await emit(q, { type: "intervention.responded", companyId, actor: deps.actor, subject: { type: "role", id: iv.roleId ?? "" }, payload: { detector: iv.detector, level: iv.ladderLevel, outcome: "resolved" } });
      results.push({ roleId: iv.roleId ?? "", detector: iv.detector, level: "resolved" });
    }
  }
  for (const d of detections) {
    const prior = await q.select().from(interventions).where(and(eq(interventions.companyId, companyId), eq(interventions.roleId, d.roleId), eq(interventions.detector, d.detector))).orderBy(desc(interventions.sentAt));
    const policy = await resolvePolicy(q, companyId, d.roleId, "intervention.nudge");
    if (policy.level === "human_only") { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: "nudges disabled by policy" }); continue; }
    const cooldownHours = Number(policy.params.cooldownHours ?? 48);
    const last = prior[0];
    const sinceLast = last ? (deps.now.getTime() - Date.parse(last.sentAt)) / 3_600_000 : Infinity;
    // An intervention that was already resolved once and fires again starts the ladder over.
    const active = last && last.status === "sent" ? prior.filter((p) => p.status === "sent") : [];
    if (last && last.status === "sent" && sinceLast < cooldownHours) { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: `cooldown (${Math.round(cooldownHours - sinceLast)}h left)` }); continue; }
    const level = LADDER[Math.min(active.length, LADDER.length - 1)];
    if (level === "escalation" && active.some((p) => p.ladderLevel === "escalation")) { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: "already escalated" }); continue; }
    const top = LADDER_TOP[d.detector];
    if (top && LADDER.indexOf(level) > LADDER.indexOf(top)) { results.push({ roleId: d.roleId, detector: d.detector, level: "skipped", reason: "already told in the app" }); continue; }
    await sendIntervention(q, deps, companyId, d, level);
    const [row] = await q.insert(interventions).values({ companyId, roleId: d.roleId, detector: d.detector, ladderLevel: level, status: "sent", sentAt: deps.now.toISOString() }).returning({ id: interventions.id });
    await emit(q, { type: "intervention.sent", companyId, actor: deps.actor, subject: { type: "role", id: d.roleId }, payload: { detector: d.detector, level, interventionId: row.id, days: d.days } });
    results.push({ roleId: d.roleId, detector: d.detector, level });
  }
  return results;
}

/** Team-facing mail goes through the outbox like everything sent from inside a transaction. */
function teamMail(q: Queryable, deps: LadderDeps, companyId: string, input: { to: string; subject: string; text: string; idempotencyKey: string; templateKey: string; tags?: Record<string, string> }) {
  return queueCommunication(q, deps.integrations, { channel: "email", companyId, to: input.to, from: `${deps.integrations.env.productName} <${deps.integrations.env.fromAddress}>`, subject: input.subject, text: input.text, templateKey: input.templateKey, idempotencyKey: input.idempotencyKey, tags: { template: input.templateKey, ...(input.tags ?? {}) }, actor: deps.actor }, deps.now);
}

async function sendIntervention(q: Queryable, deps: LadderDeps, companyId: string, d: Detection, level: LadderLevel): Promise<void> {
  const href = `${deps.appBaseUrl}${d.action.href}`;
  if (level === "brief") {
    await notify(q, { companyId, kind: `stuck.${d.detector}`, title: d.title, body: d.body, action: d.action });
    return;
  }
  const team = await q.select({ email: users.email, name: users.name, userId: users.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, companyId), inArray(memberships.role, ["owner", "admin", "hiring_manager"]), eq(memberships.status, "active")));
  // Each person's own setting for roles that need attention (plan B3) decides: as it happens, this rung's own email; daily
  // or weekly, their summary carries it; off, the app only. Both rungs' updates sit in the same group.
  const prefs = await storedPreferences(q, companyId, team.map((o) => o.userId));
  const owners = team.filter((o) => resolveNotifyCadence(`stuck.${d.detector}`, prefs.get(o.userId) ?? {}).cadence === "immediate");
  const emailed = owners.map((o) => o.userId);
  const day = deps.now.toISOString().slice(0, 10);
  // The emails carry the title (the role, counts and days) and the link, never the body: a body can name candidates,
  // and no email alert does (plan B3). The app shows the rest after sign-in.
  // The people emailed here have their copy recorded as emailed, so no alert or summary repeats it for them.
  if (level === "message") {
    await notify(q, { companyId, kind: `stuck.${d.detector}`, title: d.title, body: d.body, action: d.action, emailedSeparatelyTo: emailed });
    for (const o of owners) {
      await teamMail(q, deps, companyId, { to: o.email, subject: d.title, text: `${o.name ? `Hi ${o.name.split(" ")[0]},` : "Hi,"}\n\n${d.title}.\n\n${d.action.label}: ${href}\n\n${ALERT_PRIVACY_LINE}\n\nIf you would rather a recruiter handled this, reply to this email or use "Ask a recruiter" in the app.`, idempotencyKey: `intervention:${companyId}:${d.roleId}:${d.detector}:message:${day}:${o.userId}`, templateKey: "intervention", tags: { detector: d.detector } });
    }
    return;
  }
  if (level === "offer_recruiter") {
    const g = await gate(q, { companyId, roleId: d.roleId, actionType: "intervention.offer_recruiter", subject: { type: "role", id: d.roleId }, proposal: { detector: d.detector }, rationale: d.title, requestedBy: deps.actor });
    if (g.outcome === "human_only") return;
    const offer = "An ITS recruiter can review the shortlist, reach out to candidates, and get this moving. It is one click from the job's page or Home.";
    await notify(q, { companyId, kind: "stuck.offer_recruiter", title: `Want a recruiter to take a look at ${d.roleTitle}?`, body: `${d.body}\n\n${offer}`, action: { label: "Ask a recruiter", href: d.action.href }, emailedSeparatelyTo: emailed });
    for (const o of owners) {
      await teamMail(q, deps, companyId, { to: o.email, subject: `Want a recruiter to look at ${d.roleTitle}?`, text: `${d.title}.\n\n${offer}\n\nOpen: ${href}\n\n${ALERT_PRIVACY_LINE}`, idempotencyKey: `intervention:${companyId}:${d.roleId}:${d.detector}:offer:${day}:${o.userId}`, templateKey: "intervention", tags: { detector: d.detector } });
    }
    return;
  }
  const esc = await createEscalation(q, { companyId, roleId: d.roleId, kind: "stuck_role", question: `${d.title}. ${d.body} The owner has not acted after a brief line, a message, and an offer of help. Please review the role and reach out.`, requestedBy: deps.actor });
  await notify(q, { companyId, kind: "stuck.escalated", title: `A recruiter is reviewing ${d.roleTitle}`, body: "It has been waiting a while, so an ITS recruiter is taking a look and will reach out.", action: { label: "See role", href: `/roles/${d.roleId}` } });
  // The ITS queue gets the title (the role, counts and days) and the link, never the body: a body can name candidates or
  // carry the team's own words, and the queue sees only what the request is about until someone accepts it (correction
  // 11). The full request stays on the escalation, which opens on acceptance and loses a person's name on deletion.
  await teamMail(q, deps, companyId, { to: deps.itsQueueEmail, subject: `[stuck_role] ${d.title}`, text: `${d.title}.\n\nThe team has not acted after a note in the app, an email, and an offer of help. Accept it in the queue to open the full request: ${deps.appBaseUrl}/recruiter/queue/${esc.id}`, idempotencyKey: `escalation:${esc.id}`, templateKey: "escalation" });
}
