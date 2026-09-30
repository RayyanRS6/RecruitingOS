import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { ApplicationStage as ApplicationStageEnum, type ApplicationStage, type OwnerGroup } from "@ros/contracts";
import { OUTCOME_STATEMENT, SOURCES, SOURCE_LABEL, STAGE_LABEL, isSource, ownerGroup } from "@ros/core";
import { applications, approvalRequests, assessments, candidates, communications, companies, events, hiringOutcomes, interviews, recruiterEscalations, roles, type Tx } from "@ros/db";
import { localDays } from "@ros/workflows";

/**
 * The role report (docs/spec/21 section 7, P1): the ten figures an owner asked for, computed from the system of record
 * inside the caller's tenant transaction with one query per figure and no per-application queries. Counts and
 * durations only: nothing here ranks or scores a candidate, and the JSON never carries a name. The applicant list is
 * the separate CSV, audited on export. The administrator's customer view runs the same composition over every role of
 * the company, so the two can never disagree.
 */

const DAY_MS = 86_400_000;
const OPEN_ESCALATION_STATUSES = ["open", "claimed", "in_progress"];

export type SourceCount = { source: string; label: string; sourceDetail: string | null; count: number };
export type DayCount = { day: string; count: number };
export type StageCount = { stage: ApplicationStage; label: string; group: OwnerGroup; count: number };
/** Completed stays come from application.stage_changed events; "now here" is the applications in the stage at report time. */
export type StageTime = { stage: ApplicationStage; label: string; group: OwnerGroup; completed: number; medianDays: number | null; averageDays: number | null; nowHere: number; longestDays: number | null };
export type PendingItem = { kind: "approval" | "candidate"; label: string; days: number; applicationId: string | null; approvalRequestId: string | null };
export type RecommendationRow = { recommendation: string; label: string; total: number; invited: number; interviewed: number; declined: number; held: number; noActionYet: number };
export type RoundCount = { roundKey: string; title: string; total: number; scheduled: number; completed: number; noShow: number; cancelled: number };
export type RoleReport = {
  generatedAt: string;
  /** The role the report is about; null for the administrator's view across a customer's roles. */
  role: { id: string; title: string; status: string; openedAt: string | null; closedAt: string | null; daysOpen: number | null } | null;
  applicants: { total: number; last30Days: number; timeZone: string; bySource: SourceCount[]; byDay: DayCount[] };
  stages: { total: number; byStage: StageCount[]; byGroup: Record<OwnerGroup, number> };
  timeInStage: { byStage: StageTime[]; waitingOnYou: { count: number; averageDays: number | null; medianDays: number | null; longestDays: number | null } };
  interviews: { total: number; requested: number; scheduled: number; completed: number; noShow: number; cancelled: number; offerExpired: number; rescheduledByCandidate: number; awaitingDecision: number; byRound: RoundCount[] };
  /** Decisions only a person can make: pending approvals plus candidates waiting on the owner (including those held on an eligibility answer). */
  pendingDecisions: { count: number; approvals: number; candidates: number; oldestDays: number | null; list: PendingItem[] };
  recommendationsVsDecisions: { assessed: number; rows: RecommendationRow[] };
  overrides: { eligibilityOverrides: number; reviewAnyway: number; holds: number; flaggedAssessments: number; byAction: Record<string, number> };
  escalations: { total: number; open: number; resolved: number; overdue: number; medianResponseHours: number | null };
  messages: { total: number; sent: number; failed: number; bounced: number; unknown: number; pending: number; candidatesAffected: number };
  outcomes: {
    statement: string; hired: number; withdrew: number; declinedByEmployer: number; declinedOffer: number; noHire: number; talentPool: number; corrections: number;
    role: { outcome: string; recordedAt: string } | null; rolesByOutcome: Record<string, number>; declineReasons: Array<{ reason: string; label: string; count: number }>;
  };
};

type AppRow = { id: string; roleId: string; candidateId: string; source: string; sourceDetail: string | null; stage: ApplicationStage; stageChangedAt: string; createdAt: string; latestAssessmentId: string | null; rejectReason: string | null };
type EventRow = { subjectId: string; occurredAt: string; payload: Record<string, unknown> };
type AssessmentRow = { id: string; applicationId: string; createdAt: string; recommendation: string | null };
type InterviewRow = { applicationId: string; status: string; roundKey: string; title: string; rescheduleCountCandidate: number; decision: string | null };
type ApprovalRow = { id: string; actionType: string; applicationId: string | null; createdAt: string };
type EscalationRow = { status: string; createdAt: string; firstResponseAt: string | null; slaDueAt: string | null; resolvedAt: string | null };
type OutcomeRow = { applicationId: string | null; roleId: string | null; outcome: string; milestone: string; recordedAt: string; correctionOf: string | null; correctedAt: string | null };
type RoleRow = { id: string; title: string; status: string; openedAt: string | null; closedAt: string | null };

/** Everything the figures are computed from, loaded once. Exported so the composition can be tested on hand-made rows. */
export type ReportData = {
  roles: RoleRow[];
  timeZone: string | null;
  apps: AppRow[];
  stageEvents: EventRow[];
  overrides: EventRow[];
  assessments: AssessmentRow[];
  interviews: InterviewRow[];
  approvals: ApprovalRow[];
  escalations: EscalationRow[];
  messages: RoleReport["messages"];
  outcomes: OutcomeRow[];
};

const NO_MESSAGES: RoleReport["messages"] = { total: 0, sent: 0, failed: 0, bounced: 0, unknown: 0, pending: 0, candidatesAffected: 0 };

/** One query per figure. `roleIds` null means every role of the company (the administrator's view). */
export async function loadReportData(tx: Tx, input: { companyId: string; roleIds: string[] | null }): Promise<ReportData> {
  const { companyId } = input;
  const empty: ReportData = { roles: [], timeZone: null, apps: [], stageEvents: [], overrides: [], assessments: [], interviews: [], approvals: [], escalations: [], messages: NO_MESSAGES, outcomes: [] };
  if (input.roleIds && input.roleIds.length === 0) return empty;
  const roleRows = await tx
    .select({ id: roles.id, title: roles.title, status: roles.status, openedAt: roles.openedAt, closedAt: roles.closedAt })
    .from(roles)
    .where(input.roleIds ? and(eq(roles.companyId, companyId), inArray(roles.id, input.roleIds)) : eq(roles.companyId, companyId))
    .orderBy(desc(roles.createdAt));
  if (!roleRows.length) return empty;
  const roleIds = roleRows.map((r) => r.id);
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const apps = (await tx
    .select({ id: applications.id, roleId: applications.roleId, candidateId: applications.candidateId, source: applications.source, sourceDetail: applications.sourceDetail, stage: applications.stage, stageChangedAt: applications.stageChangedAt, createdAt: applications.createdAt, latestAssessmentId: applications.latestAssessmentId, rejectReason: applications.rejectReason })
    .from(applications)
    .where(and(eq(applications.companyId, companyId), inArray(applications.roleId, roleIds)))
    .orderBy(asc(applications.createdAt))) as AppRow[];
  const ids = apps.map((a) => a.id);
  const eventsOf = (type: string) => ids.length
    ? tx.select({ subjectId: events.subjectId, occurredAt: events.occurredAt, payload: events.payload }).from(events).where(and(eq(events.companyId, companyId), eq(events.type, type), eq(events.subjectType, "application"), inArray(events.subjectId, ids))).orderBy(asc(events.occurredAt), asc(events.id))
    : Promise.resolve([] as EventRow[]);
  const stageEvents = await eventsOf("application.stage_changed");
  const overrides = await eventsOf("human.override");
  const latestIds = apps.map((a) => a.latestAssessmentId).filter((x): x is string => !!x);
  const asmts = latestIds.length
    ? await tx.select({ id: assessments.id, applicationId: assessments.applicationId, createdAt: assessments.createdAt, recommendation: sql<string | null>`${assessments.result}->>'recommendation'` }).from(assessments).where(and(eq(assessments.companyId, companyId), inArray(assessments.id, latestIds)))
    : [];
  const ivs = ids.length
    ? await tx.select({ applicationId: interviews.applicationId, status: interviews.status, roundKey: interviews.roundKey, title: interviews.title, rescheduleCountCandidate: interviews.rescheduleCountCandidate, decision: interviews.decision }).from(interviews).where(and(eq(interviews.companyId, companyId), inArray(interviews.applicationId, ids))).orderBy(asc(interviews.createdAt), asc(interviews.id))
    : [];
  const approvals = await tx
    .select({ id: approvalRequests.id, actionType: approvalRequests.actionType, applicationId: approvalRequests.applicationId, createdAt: approvalRequests.createdAt })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.companyId, companyId), inArray(approvalRequests.roleId, roleIds), eq(approvalRequests.status, "pending")));
  const escalations = await tx
    .select({ status: recruiterEscalations.status, createdAt: recruiterEscalations.createdAt, firstResponseAt: recruiterEscalations.firstResponseAt, slaDueAt: recruiterEscalations.slaDueAt, resolvedAt: recruiterEscalations.resolvedAt })
    .from(recruiterEscalations)
    .where(and(eq(recruiterEscalations.companyId, companyId), ids.length ? or(inArray(recruiterEscalations.roleId, roleIds), inArray(recruiterEscalations.applicationId, ids)) : inArray(recruiterEscalations.roleId, roleIds)));
  const [m] = ids.length
    ? await tx
        .select({
          total: sql<string>`count(*)`,
          sent: sql<string>`count(*) filter (where ${communications.status} in ('sent', 'delivered'))`,
          failed: sql<string>`count(*) filter (where ${communications.status} in ('failed', 'complained'))`,
          bounced: sql<string>`count(*) filter (where ${communications.status} = 'bounced')`,
          unknown: sql<string>`count(*) filter (where ${communications.status} = 'unknown')`,
          pending: sql<string>`count(*) filter (where ${communications.status} in ('queued', 'sending'))`,
          candidatesAffected: sql<string>`count(distinct ${communications.applicationId}) filter (where ${communications.status} in ('failed', 'bounced', 'complained', 'unknown'))`,
        })
        .from(communications)
        .where(and(eq(communications.companyId, companyId), eq(communications.direction, "outbound"), inArray(communications.applicationId, ids)))
    : [null];
  const messages: RoleReport["messages"] = m
    ? { total: Number(m.total), sent: Number(m.sent), failed: Number(m.failed), bounced: Number(m.bounced), unknown: Number(m.unknown), pending: Number(m.pending), candidatesAffected: Number(m.candidatesAffected) }
    : NO_MESSAGES;
  const outcomes = await tx
    .select({ applicationId: hiringOutcomes.applicationId, roleId: hiringOutcomes.roleId, outcome: hiringOutcomes.outcome, milestone: hiringOutcomes.milestone, recordedAt: hiringOutcomes.recordedAt, correctionOf: hiringOutcomes.correctionOf, correctedAt: hiringOutcomes.correctedAt })
    .from(hiringOutcomes)
    .where(and(eq(hiringOutcomes.companyId, companyId), inArray(hiringOutcomes.roleId, roleIds)));
  return { roles: roleRows, timeZone: company?.timezone ?? null, apps, stageEvents, overrides, assessments: asmts, interviews: ivs, approvals, escalations, messages, outcomes };
}

/** The report for one role, or null when the role is not visible in this transaction. */
export async function roleReport(tx: Tx, input: { companyId: string; roleId: string; now: Date }): Promise<RoleReport | null> {
  const data = await loadReportData(tx, { companyId: input.companyId, roleIds: [input.roleId] });
  if (!data.roles.length) return null;
  return composeRoleReport(data, input.now);
}

export type CustomerRoleSummary = { id: string; title: string; status: string; openedAt: string | null; closedAt: string | null; applicants: number; waitingOnYou: number; hired: number };

/** The administrator's view: the same figures over every role of the customer, plus one line per role. */
export async function customerReport(tx: Tx, input: { companyId: string; now: Date }): Promise<{ report: RoleReport; roles: CustomerRoleSummary[] }> {
  const data = await loadReportData(tx, { companyId: input.companyId, roleIds: null });
  const report = composeRoleReport(data, input.now);
  const rolesOut = data.roles.map((r) => {
    const own = data.apps.filter((a) => a.roleId === r.id);
    return { ...r, applicants: own.length, waitingOnYou: own.filter((a) => ownerGroup(a.stage) === "waiting_on_you").length, hired: own.filter((a) => a.stage === "hired").length };
  });
  return { report, roles: rolesOut };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Composition: pure, so the arithmetic can be tested on hand-made rows.                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** Which human decision followed the assistant's suggestion. Other human actions (an eligibility override, a flag, an outcome) are not decisions about the suggestion and are ignored here. */
type Decision = "invited" | "interviewed" | "declined" | "held";
const DECISION_OF_ACTION: Record<string, Decision> = {
  invite_screen: "invited",
  advance_to_interview: "interviewed",
  "interview.request": "interviewed",
  reject: "declined",
  hold: "held",
};
/** The decision after an interview is one human.override event with action "interview.decision"; the choice itself is in payload.decision. */
const DECISION_OF_INTERVIEW: Record<string, Decision> = {
  not_moving_forward: "declined",
  next_round: "interviewed",
  finalist: "interviewed",
  hired: "interviewed",
};

/** The decision one human.override event records about the candidate, or null when the event is not such a decision. */
function decisionOf(payload: Record<string, unknown>): Decision | null {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action === "interview.decision") return DECISION_OF_INTERVIEW[String(payload.decision)] ?? null;
  return DECISION_OF_ACTION[action] ?? null;
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  screen: "Screen suggested",
  strong_interview: "Interview strongly suggested",
  interview: "Interview suggested",
  hold: "Hold suggested",
  review_manually: "Needs a person's look",
  decline_recommended: "Decline suggested",
  none: "No suggestion",
};
const RECOMMENDATION_ORDER = Object.keys(RECOMMENDATION_LABEL);

const REJECT_REASON_LABEL: Record<string, string> = {
  eligibility: "Did not meet an eligibility rule",
  not_a_match_experience: "Experience not a match",
  not_a_match_skills: "Skills not a match",
  compensation_mismatch: "Pay expectations did not match",
  location_or_schedule: "Location or schedule",
  position_filled: "Position filled",
  role_closed: "Role closed",
  candidate_unresponsive: "Candidate did not respond",
  employer_declined: "Employer declined",
  other: "Other",
  unspecified: "No reason recorded",
};

const APPROVAL_LABEL: Record<string, string> = {
  "role_packet.approve": "Approve the role packet",
  "application.invite_screen": "Invite to a screen?",
  "application.recommend_interview": "Interview this candidate?",
  "application.hold_ineligible": "Decide on an eligibility hold",
  "disposition.send": "Send the decline message?",
  "intervention.offer_recruiter": "Want a recruiter to take a look?",
};

const ROLE_STATUS_LABEL: Record<string, string> = {
  draft: "draft",
  pending_approval: "waiting for approval",
  open: "open",
  paused: "paused",
  filled: "filled",
  closed: "closed",
};

export function composeRoleReport(data: ReportData, now: Date): RoleReport {
  const nowMs = now.getTime();
  const days = (fromMs: number, toMs = nowMs) => Math.max(0, toMs - fromMs) / DAY_MS;
  const wholeDays = (iso: string) => Math.floor(days(Date.parse(iso)));
  const single = data.roles.length === 1 ? data.roles[0] : null;
  const role = single ? { ...single, daysOpen: single.openedAt ? wholeDays(single.openedAt) : null } : null;

  // 1. Applicants by source and by day (days cut in the company's own time zone, as the volume alert cuts them).
  const bySourceMap = new Map<string, SourceCount>();
  for (const a of data.apps) {
    const key = `${a.source}\u0000${a.sourceDetail ?? ""}`;
    const row = bySourceMap.get(key) ?? { source: a.source, label: isSource(a.source) ? SOURCE_LABEL[a.source] : a.source, sourceDetail: a.sourceDetail ?? null, count: 0 };
    row.count += 1;
    bySourceMap.set(key, row);
  }
  const sourceOrder = (s: string) => { const i = (SOURCES as readonly string[]).indexOf(s); return i === -1 ? SOURCES.length : i; };
  const bySource = [...bySourceMap.values()].sort((x, y) => sourceOrder(x.source) - sourceOrder(y.source) || x.source.localeCompare(y.source) || (x.sourceDetail ?? "").localeCompare(y.sourceDetail ?? "") || y.count - x.count);
  const local = localDays(now, data.timeZone);
  const byDay: DayCount[] = Array.from({ length: 30 }, (_, i) => ({ day: local.key(local.start(i - 29)), count: 0 }));
  const dayIndex = new Map(byDay.map((d, i) => [d.day, i]));
  for (const a of data.apps) {
    const i = dayIndex.get(local.key(new Date(a.createdAt)));
    if (i !== undefined) byDay[i].count += 1;
  }
  const applicants = { total: data.apps.length, last30Days: byDay.reduce((n, d) => n + d.count, 0), timeZone: local.timeZone, bySource, byDay };

  // 2. Where everyone is: counts by stage, in the stage order, and by owner group.
  const stageCount = new Map<ApplicationStage, number>();
  const byGroup: Record<OwnerGroup, number> = { waiting_on_you: 0, in_process: 0, not_moving_forward: 0, hired: 0 };
  for (const a of data.apps) {
    stageCount.set(a.stage, (stageCount.get(a.stage) ?? 0) + 1);
    byGroup[ownerGroup(a.stage)] += 1;
  }
  const byStage: StageCount[] = ApplicationStageEnum.options.filter((s) => stageCount.has(s)).map((s) => ({ stage: s, label: STAGE_LABEL[s], group: ownerGroup(s), count: stageCount.get(s) ?? 0 }));
  const stages = { total: data.apps.length, byStage, byGroup };

  // 3. Time in stage: every completed stay from the stage-change history, and how long the people in each stage have been there now.
  const eventsByApp = new Map<string, EventRow[]>();
  for (const e of data.stageEvents) eventsByApp.set(e.subjectId, [...(eventsByApp.get(e.subjectId) ?? []), e]);
  const stays = new Map<ApplicationStage, number[]>();
  const dwell = new Map<ApplicationStage, number[]>();
  for (const a of data.apps) {
    let stage: ApplicationStage = "applied";
    let since = Date.parse(a.createdAt);
    for (const e of eventsByApp.get(a.id) ?? []) {
      const at = Date.parse(e.occurredAt);
      const from = (typeof e.payload.from === "string" ? e.payload.from : stage) as ApplicationStage;
      stays.set(from, [...(stays.get(from) ?? []), days(since, at)]);
      stage = (typeof e.payload.to === "string" ? e.payload.to : stage) as ApplicationStage;
      since = at;
    }
    dwell.set(a.stage, [...(dwell.get(a.stage) ?? []), days(Date.parse(a.stageChangedAt))]);
  }
  const timeByStage: StageTime[] = ApplicationStageEnum.options
    .filter((s) => stays.has(s) || dwell.has(s))
    .map((s) => {
      const done = stays.get(s) ?? [];
      const here = dwell.get(s) ?? [];
      return { stage: s, label: STAGE_LABEL[s], group: ownerGroup(s), completed: done.length, medianDays: round1(median(done)), averageDays: round1(average(done)), nowHere: here.length, longestDays: here.length ? round1(Math.max(...here)) : null };
    });
  const waiting = data.apps.filter((a) => ownerGroup(a.stage) === "waiting_on_you").map((a) => days(Date.parse(a.stageChangedAt)));
  const timeInStage = { byStage: timeByStage, waitingOnYou: { count: waiting.length, averageDays: round1(average(waiting)), medianDays: round1(median(waiting)), longestDays: waiting.length ? round1(Math.max(...waiting)) : null } };

  // 4. Interviews by status and by round; a request is an interview not yet on the calendar.
  const rounds = new Map<string, RoundCount>();
  const iv = { total: 0, requested: 0, scheduled: 0, completed: 0, noShow: 0, cancelled: 0, offerExpired: 0, rescheduledByCandidate: 0, awaitingDecision: 0 };
  for (const i of data.interviews) {
    iv.total += 1;
    if (i.status === "proposed" || i.status === "scheduling") iv.requested += 1;
    if (i.status === "scheduled") iv.scheduled += 1;
    if (i.status === "completed") iv.completed += 1;
    if (i.status === "no_show") iv.noShow += 1;
    if (i.status === "cancelled") iv.cancelled += 1;
    if (i.status === "offer_expired") iv.offerExpired += 1;
    iv.rescheduledByCandidate += i.rescheduleCountCandidate;
    if ((i.status === "completed" || i.status === "no_show") && !i.decision) iv.awaitingDecision += 1;
    const r = rounds.get(i.roundKey) ?? { roundKey: i.roundKey, title: i.title, total: 0, scheduled: 0, completed: 0, noShow: 0, cancelled: 0 };
    r.total += 1;
    if (i.status === "scheduled") r.scheduled += 1;
    if (i.status === "completed") r.completed += 1;
    if (i.status === "no_show") r.noShow += 1;
    if (i.status === "cancelled") r.cancelled += 1;
    rounds.set(i.roundKey, r);
  }
  const interviewsOut = { ...iv, byRound: [...rounds.values()] };

  // 5. Decisions waiting for a person: candidates in "waiting on you" or held on an eligibility answer, plus pending approvals not already counted through their candidate.
  const waitingApps = data.apps.filter((a) => ownerGroup(a.stage) === "waiting_on_you" || a.stage === "ineligible");
  const waitingIds = new Set(waitingApps.map((a) => a.id));
  const items: PendingItem[] = [
    ...waitingApps.map((a) => ({ kind: "candidate" as const, label: STAGE_LABEL[a.stage], days: wholeDays(a.stageChangedAt), applicationId: a.id, approvalRequestId: null })),
    ...data.approvals.filter((p) => !p.applicationId || !waitingIds.has(p.applicationId)).map((p) => ({ kind: "approval" as const, label: APPROVAL_LABEL[p.actionType] ?? p.actionType.replace(/[._]/g, " "), days: wholeDays(p.createdAt), applicationId: p.applicationId, approvalRequestId: p.id })),
  ].sort((x, y) => y.days - x.days);
  const pendingDecisions = { count: items.length, approvals: data.approvals.length, candidates: waitingApps.length, oldestDays: items.length ? items[0].days : null, list: items.slice(0, 5) };

  // 6. What the assistant suggested and what a person then decided (the first decision after the suggestion).
  const overridesByApp = new Map<string, EventRow[]>();
  for (const e of data.overrides) overridesByApp.set(e.subjectId, [...(overridesByApp.get(e.subjectId) ?? []), e]);
  const recRows = new Map<string, RecommendationRow>();
  for (const a of data.assessments) {
    const rec = a.recommendation ?? "none";
    const row = recRows.get(rec) ?? { recommendation: rec, label: RECOMMENDATION_LABEL[rec] ?? rec.replace(/_/g, " "), total: 0, invited: 0, interviewed: 0, declined: 0, held: 0, noActionYet: 0 };
    row.total += 1;
    const assessedAt = Date.parse(a.createdAt);
    let decided: Decision | null = null;
    for (const e of overridesByApp.get(a.applicationId) ?? []) {
      if (Date.parse(e.occurredAt) < assessedAt) continue;
      decided = decisionOf(e.payload);
      if (decided) break;
    }
    if (decided) row[decided] += 1;
    else row.noActionYet += 1;
    recRows.set(rec, row);
  }
  const recOrder = (r: string) => { const i = RECOMMENDATION_ORDER.indexOf(r); return i === -1 ? RECOMMENDATION_ORDER.length : i; };
  const recommendationsVsDecisions = { assessed: data.assessments.length, rows: [...recRows.values()].sort((x, y) => recOrder(x.recommendation) - recOrder(y.recommendation)) };

  // 7. Times a person overruled the system, by kind.
  const byAction: Record<string, number> = {};
  for (const e of data.overrides) {
    const action = typeof e.payload.action === "string" ? e.payload.action : "other";
    byAction[action] = (byAction[action] ?? 0) + 1;
  }
  const overrides = { eligibilityOverrides: byAction.override_eligibility ?? 0, reviewAnyway: byAction.review_anyway ?? 0, holds: byAction.hold ?? 0, flaggedAssessments: byAction.flag_assessment ?? 0, byAction };

  // 8. Recruiter help on this role: open, resolved, past the promised response time, and how quickly a recruiter first responded.
  const responseHours = data.escalations.filter((e) => e.firstResponseAt).map((e) => Math.max(0, Date.parse(e.firstResponseAt!) - Date.parse(e.createdAt)) / 3_600_000);
  const escalations = {
    total: data.escalations.length,
    open: data.escalations.filter((e) => OPEN_ESCALATION_STATUSES.includes(e.status)).length,
    resolved: data.escalations.filter((e) => e.status === "resolved").length,
    overdue: data.escalations.filter((e) => OPEN_ESCALATION_STATUSES.includes(e.status) && !e.resolvedAt && e.slaDueAt && Date.parse(e.slaDueAt) < nowMs).length,
    medianResponseHours: round1(median(responseHours)),
  };

  // 9. Messages to candidates, straight from the outbox's own statuses (loaded as one aggregate).
  const messages = data.messages;

  // 10. Outcomes: the current record per candidate (a corrected record is replaced by its correction), the role's own outcome, and why candidates were declined.
  const current = data.outcomes.filter((o) => !o.correctedAt);
  const count = (outcome: string) => current.filter((o) => o.applicationId && o.outcome === outcome).length;
  const roleOutcomes = current.filter((o) => !o.applicationId && o.milestone === "role");
  const rolesByOutcome: Record<string, number> = {};
  for (const o of roleOutcomes) rolesByOutcome[o.outcome] = (rolesByOutcome[o.outcome] ?? 0) + 1;
  const reasons = new Map<string, number>();
  for (const a of data.apps) if (a.stage === "rejected") reasons.set(a.rejectReason ?? "unspecified", (reasons.get(a.rejectReason ?? "unspecified") ?? 0) + 1);
  const roleOutcome = single ? roleOutcomes.find((o) => o.roleId === single.id) ?? null : null;
  const outcomes = {
    statement: OUTCOME_STATEMENT,
    hired: count("hired_externally"),
    withdrew: count("candidate_withdrew"),
    declinedByEmployer: count("employer_declined"),
    declinedOffer: count("offer_declined_externally"),
    noHire: count("no_hire"),
    talentPool: data.apps.filter((a) => a.stage === "talent_pool").length,
    corrections: data.outcomes.filter((o) => o.correctionOf).length,
    role: roleOutcome ? { outcome: roleOutcome.outcome, recordedAt: roleOutcome.recordedAt } : null,
    rolesByOutcome,
    declineReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, label: REJECT_REASON_LABEL[reason] ?? reason.replace(/_/g, " "), count: n })).sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason)),
  };

  return { generatedAt: now.toISOString(), role, applicants, stages, timeInStage, interviews: interviewsOut, pendingDecisions, recommendationsVsDecisions, overrides, escalations, messages, outcomes };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The two CSV files: the applicant list (names; audited on export) and the figures as rows.                     */
/* ------------------------------------------------------------------------------------------------------------ */

export const APPLICANT_COLUMNS = ["Applied on", "Name", "Source", "Source detail", "Stage", "Days in stage", "Recommendation", "Decision", "Outcome", "Interviews", "Interviews completed"] as const;
export type ApplicantRow = Record<(typeof APPLICANT_COLUMNS)[number], string | number>;

/** The latest thing a person did with the application, in plain words. */
const ACTION_LABEL: Record<string, string> = {
  invite_screen: "Invited to a screen",
  advance_to_interview: "Moved to interview",
  "interview.request": "Interview requested",
  "interview.decision": "Interview decision recorded",
  reject: "Declined",
  hold: "Put on hold",
  override_eligibility: "Eligibility overridden",
  review_anyway: "Reviewed anyway",
  flag_assessment: "Assessment flagged",
  outcome: "Outcome recorded",
  outcome_corrected: "Outcome corrected",
};
/** An "interview.decision" event is labelled by the choice it carries, not by the generic action name. */
const INTERVIEW_DECISION_LABEL: Record<string, string> = {
  not_moving_forward: "Not moving forward after interview",
  next_round: "Moved to the next round",
  finalist: "Finalist",
  hired: "Hired",
};

/** The plain label of one human.override event; null when the event names no action, "" when the action has no label. */
function actionLabel(payload: Record<string, unknown>): string | null {
  const action = typeof payload.action === "string" ? payload.action : null;
  if (action === null) return null;
  if (action === "interview.decision") return INTERVIEW_DECISION_LABEL[String(payload.decision)] ?? ACTION_LABEL[action];
  return ACTION_LABEL[action] ?? "";
}
const OUTCOME_LABEL: Record<string, string> = {
  hired_externally: "Hired",
  candidate_withdrew: "Withdrew",
  employer_declined: "Declined by employer",
  offer_declined_externally: "Declined the offer",
  no_hire: "No hire",
};

/**
 * One row per application, oldest first. No AI rationale, evidence, résumé text or pay in the file. `onlyApplicationId`
 * is the candidate a staff grant names: a recruiter who accepted a request about one candidate gets that row alone,
 * the same limit the role's applications list applies.
 */
export async function applicantRows(tx: Tx, input: { companyId: string; roleId: string; now: Date; onlyApplicationId?: string | null }): Promise<{ role: RoleRow; rows: ApplicantRow[] } | null> {
  const data = await loadReportData(tx, { companyId: input.companyId, roleIds: [input.roleId] });
  if (!data.roles.length) return null;
  const apps = input.onlyApplicationId ? data.apps.filter((a) => a.id === input.onlyApplicationId) : data.apps;
  const candidateIds = [...new Set(apps.map((a) => a.candidateId))];
  const names = candidateIds.length ? await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(and(eq(candidates.companyId, input.companyId), inArray(candidates.id, candidateIds))) : [];
  const nameOf = new Map(names.map((n) => [n.id, `${n.firstName} ${n.lastName}`.trim()]));
  const recOf = new Map(data.assessments.map((a) => [a.applicationId, a.recommendation]));
  const lastAction = new Map<string, string>();
  for (const e of data.overrides) {
    const label = actionLabel(e.payload);
    if (label !== null) lastAction.set(e.subjectId, label);
  }
  const outcomeOf = new Map<string, string>();
  for (const o of data.outcomes) if (o.applicationId && !o.correctedAt && OUTCOME_LABEL[o.outcome]) outcomeOf.set(o.applicationId, o.outcome);
  const local = localDays(input.now, data.timeZone);
  const rows: ApplicantRow[] = apps.map((a) => {
    const ivs = data.interviews.filter((i) => i.applicationId === a.id);
    const rec = recOf.get(a.id);
    return {
      "Applied on": local.key(new Date(a.createdAt)),
      Name: nameOf.get(a.candidateId) ?? "",
      Source: isSource(a.source) ? SOURCE_LABEL[a.source] : a.source,
      "Source detail": a.sourceDetail ?? "",
      Stage: STAGE_LABEL[a.stage],
      "Days in stage": Math.floor(Math.max(0, input.now.getTime() - Date.parse(a.stageChangedAt)) / DAY_MS),
      Recommendation: rec ? RECOMMENDATION_LABEL[rec] ?? rec.replace(/_/g, " ") : "",
      Decision: lastAction.get(a.id) ?? "",
      Outcome: OUTCOME_LABEL[outcomeOf.get(a.id) ?? ""] ?? "",
      Interviews: ivs.length,
      "Interviews completed": ivs.filter((i) => i.status === "completed").length,
    };
  });
  return { role: data.roles[0], rows };
}

export const SUMMARY_COLUMNS = ["Figure", "Item", "Value"] as const;

/** The figures as rows, in the order the page shows them. */
export function summaryRows(r: RoleReport): Array<[string, string, string | number]> {
  const rows: Array<[string, string, string | number]> = [];
  const add = (figure: string, item: string, value: string | number | null) => rows.push([figure, item, value === null ? "" : value]);
  if (r.role) {
    add("Role", "Title", r.role.title);
    add("Role", "Status", ROLE_STATUS_LABEL[r.role.status] ?? r.role.status.replace(/_/g, " "));
    add("Role", "Days open", r.role.daysOpen);
  }
  add("Applicants", "Total", r.applicants.total);
  add("Applicants", "Last 30 days", r.applicants.last30Days);
  for (const s of r.applicants.bySource) add("Applicants by source", s.sourceDetail ? `${s.label}: ${s.sourceDetail}` : s.label, s.count);
  for (const d of r.applicants.byDay) if (d.count) add("Applicants by day", d.day, d.count);
  add("Stages", "Waiting on you", r.stages.byGroup.waiting_on_you);
  add("Stages", "In process", r.stages.byGroup.in_process);
  add("Stages", "Not moving forward", r.stages.byGroup.not_moving_forward);
  add("Stages", "Hired", r.stages.byGroup.hired);
  for (const s of r.stages.byStage) add("Stage counts", s.label, s.count);
  for (const s of r.timeInStage.byStage) {
    add("Time in stage (typical days)", s.label, s.medianDays);
    add("Time in stage (average days)", s.label, s.averageDays);
  }
  add("Waiting on you now", "Candidates", r.timeInStage.waitingOnYou.count);
  add("Waiting on you now", "Longest wait (days)", r.timeInStage.waitingOnYou.longestDays);
  add("Interviews", "Requested", r.interviews.requested);
  add("Interviews", "Scheduled", r.interviews.scheduled);
  add("Interviews", "Completed", r.interviews.completed);
  add("Interviews", "No-shows", r.interviews.noShow);
  add("Interviews", "Cancelled", r.interviews.cancelled);
  add("Interviews", "Rescheduled by the candidate", r.interviews.rescheduledByCandidate);
  add("Interviews", "Awaiting your decision", r.interviews.awaitingDecision);
  for (const round of r.interviews.byRound) add("Interviews by round", round.title, round.total);
  add("Pending decisions", "Total", r.pendingDecisions.count);
  add("Pending decisions", "Oldest (days)", r.pendingDecisions.oldestDays);
  for (const row of r.recommendationsVsDecisions.rows) {
    add("Suggestions vs decisions", `${row.label}: total`, row.total);
    add("Suggestions vs decisions", `${row.label}: invited to a screen`, row.invited);
    add("Suggestions vs decisions", `${row.label}: moved to interview`, row.interviewed);
    add("Suggestions vs decisions", `${row.label}: declined`, row.declined);
    add("Suggestions vs decisions", `${row.label}: put on hold`, row.held);
    add("Suggestions vs decisions", `${row.label}: no decision yet`, row.noActionYet);
  }
  add("Overrides", "Eligibility overridden", r.overrides.eligibilityOverrides);
  add("Overrides", "Reviewed anyway", r.overrides.reviewAnyway);
  add("Overrides", "Put on hold", r.overrides.holds);
  add("Overrides", "Assessments flagged", r.overrides.flaggedAssessments);
  add("Recruiter help", "Requests", r.escalations.total);
  add("Recruiter help", "Open", r.escalations.open);
  add("Recruiter help", "Resolved", r.escalations.resolved);
  add("Recruiter help", "Past the promised response time", r.escalations.overdue);
  add("Recruiter help", "Typical first response (hours)", r.escalations.medianResponseHours);
  add("Messages", "Sent", r.messages.sent);
  add("Messages", "Failed", r.messages.failed);
  add("Messages", "Bounced", r.messages.bounced);
  add("Messages", "Delivery unknown", r.messages.unknown);
  add("Messages", "Waiting to send", r.messages.pending);
  add("Messages", "Candidates affected", r.messages.candidatesAffected);
  add("Outcomes", "Hired", r.outcomes.hired);
  add("Outcomes", "Withdrew", r.outcomes.withdrew);
  add("Outcomes", "Declined by employer", r.outcomes.declinedByEmployer);
  add("Outcomes", "Declined the offer", r.outcomes.declinedOffer);
  add("Outcomes", "No hire", r.outcomes.noHire);
  add("Outcomes", "In the talent pool", r.outcomes.talentPool);
  add("Outcomes", "Corrections", r.outcomes.corrections);
  if (r.outcomes.role) add("Outcomes", "Role outcome", r.outcomes.role.outcome.replace(/_/g, " "));
  for (const d of r.outcomes.declineReasons) add("Decline reasons", d.label, d.count);
  add("Report", "Generated at", r.generatedAt);
  return rows;
}

/** RFC 4180 rows with a byte-order mark so a spreadsheet opens accented names correctly; a cell that a spreadsheet would run as a formula is neutralised. */
export function toCsv(rows: Array<ReadonlyArray<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** A download name from the role title: letters and digits only, lower case, dashes between words. */
export function csvFilename(title: string, suffix: string, now: Date): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "role";
  return `${slug}-${suffix}-${now.toISOString().slice(0, 10)}.csv`;
}
