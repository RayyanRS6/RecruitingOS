import { and, count, desc, eq, inArray } from "drizzle-orm";
import { CV_FILE_STATUS_LABEL, CandidateTab, STAGE_TAB, TEXT_SCREENS, TOLD_STATE_LABEL, applySourceLabel, byCvScore, byInterviewScore, candidateActions, cvScoreSummary, formAnswerViews, interviewScoreSummary, noCvScore, noInterviewScore, quoteFrom, stageLabel, tabOf, type AiReview, type ApplicationStage, type CandidateActionFacts, type CandidateCounts, type CandidateDocument, type CandidateList, type CandidatePanel, type CandidateRow, type CvFileStatus, type CvNoScore, type CvScore, type EvidenceAssessment, type InterviewAnswer, type InterviewScore, type PlanStop, type RolePacket, type RoleStatus, type ScreenAssessment } from "@ros/contracts";
import { aiCreditStanding, aiInterviewViewOf, audit, cvScoreFromReading, entitlements, formAnswersOf, interviewScoreFromScorecard, lockedAndWaiting, notLocked, remindedRecently, sameRequirements, screenAnswersSent } from "@ros/core";
import { DECISION_TEMPLATE, askedQuestions, chatPacket } from "@ros/agents";
import { applications, assessments, candidates, communications, documents, events, rolePackets, roles, screens, workflowRuns, type Tx } from "@ros/db";
import type { Actor } from "@ros/contracts";
import type { Container } from "../container";
import { lockedCardsOf } from "./locked-visibility";
import { companyTrialStanding } from "./trial";

/**
 * What a company reads about its candidates: a job's Candidates list and one candidate's panel, and the facts both rest
 * on. Every tab, label, score, order and allowed action is worked out here, from stored facts, with the one function the
 * contracts give for it; a screen shows what it gets. Nobody past the plan's candidates per job is ever read here
 * (`notLocked`), and nothing of an AI interview is, before the candidate pressed "Send my answers".
 */

type App = typeof applications.$inferSelect;
type Candidate = typeof candidates.$inferSelect;
/** An AI interview as the team's views read it: where it stands and what was recorded, never its transcript. */
const SCREEN_COLUMNS = { id: screens.id, applicationId: screens.applicationId, status: screens.status, invitedAt: screens.invitedAt, expiresAt: screens.expiresAt, remindedAt: screens.remindedAt, startedAt: screens.startedAt, completedAt: screens.completedAt, createdAt: screens.createdAt, assessmentId: screens.assessmentId, workflowRunId: screens.workflowRunId, progress: screens.progress, answers: screens.answers };
type Screen = Pick<typeof screens.$inferSelect, keyof typeof SCREEN_COLUMNS>;

/** Everything the team's views read about one person. */
export type Person = {
  app: App;
  candidate: Candidate;
  /** Their newest AI interview, whatever became of it. */
  screen: Screen | null;
  /** The newest CV reading, with the job version it was read against. */
  reading: { packetVersion: number; result: EvidenceAssessment } | null;
  /** Why they reached New without a CV score, from their newest `application.triaged` entry. */
  unscored: CvNoScore | null;
  /** The scorecard of their newest AI interview: only once they sent it, and once it is written. */
  scorecard: ScreenAssessment | null;
  /** That interview's run is over, so a sent interview without a scorecard will not get one by itself. */
  scoringOver: boolean;
  /** Their decision email still waits in the outbox. */
  decisionEmailWaiting: boolean;
};

const iso = (at: string): string => new Date(at).toISOString();
const ENDED_RUN = ["completed", "failed", "cancelled"];

/** The people behind these applications, with one query per kind of fact for all of them, never one per person. */
export async function loadPeople(tx: Tx, apps: readonly App[]): Promise<Person[]> {
  if (!apps.length) return [];
  const ids = apps.map((a) => a.id);
  const people = await tx.select().from(candidates).where(inArray(candidates.id, [...new Set(apps.map((a) => a.candidateId))]));
  const allScreens = await tx.select(SCREEN_COLUMNS).from(screens).where(inArray(screens.applicationId, ids)).orderBy(desc(screens.createdAt), desc(screens.id));
  const newest = new Map<string, Screen>();
  for (const s of allScreens) if (!newest.has(s.applicationId)) newest.set(s.applicationId, s);
  const readings = await tx.select({ id: assessments.id, applicationId: assessments.applicationId, kind: assessments.kind, packetVersion: assessments.packetVersion, result: assessments.result }).from(assessments).where(inArray(assessments.applicationId, ids)).orderBy(desc(assessments.createdAt));
  const triaged = await tx.select({ applicationId: events.subjectId, payload: events.payload }).from(events).where(and(eq(events.type, "application.triaged"), eq(events.subjectType, "application"), inArray(events.subjectId, ids))).orderBy(desc(events.occurredAt), desc(events.id));
  const waiting = new Set((await tx.select({ applicationId: communications.applicationId }).from(communications).where(and(inArray(communications.applicationId, ids), eq(communications.templateKey, DECISION_TEMPLATE), eq(communications.status, "queued")))).map((r) => r.applicationId));
  // A sent interview with no scorecard yet: whether its run is still going (being scored) or over (it could not be scored).
  const unscored = [...newest.values()].filter((s) => screenAnswersSent(s) && !s.assessmentId && s.workflowRunId).map((s) => s.workflowRunId!);
  const over = new Set(unscored.length ? (await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(inArray(workflowRuns.id, unscored), inArray(workflowRuns.status, ENDED_RUN)))).map((r) => r.id) : []);
  return apps.flatMap((app) => {
    const candidate = people.find((c) => c.id === app.candidateId);
    if (!candidate) return [];
    const screen = newest.get(app.id) ?? null;
    const reading = readings.find((r) => r.applicationId === app.id && r.kind === "triage");
    const card = screen && screenAnswersSent(screen) && screen.assessmentId ? readings.find((r) => r.id === screen.assessmentId) : undefined;
    const reason = triaged.find((e) => e.applicationId === app.id)?.payload.noScore;
    return [{
      app,
      candidate,
      screen,
      reading: reading ? { packetVersion: reading.packetVersion, result: reading.result as EvidenceAssessment } : null,
      unscored: reason === "unreadable" || reason === "ai_used_up" || reason === "not_scored" ? reason : null,
      scorecard: card ? (card.result as ScreenAssessment) : null,
      scoringOver: !!screen && (!screen.workflowRunId || over.has(screen.workflowRunId)),
      decisionEmailWaiting: waiting.has(app.id),
    }];
  });
}

/** What every row of one job shares: the job versions people were read against, the live one, and what the plan stops. */
export type JobContext = { roleStatus: RoleStatus; packets: Map<number, RolePacket>; current: RolePacket | null; planStop: PlanStop | null; now: Date; emailStopped: (address: string) => boolean };

export async function jobContext(tx: Tx, container: Pick<Container, "engine" | "emailStopped">, role: { id: string; companyId: string; status: string; currentPacketVersion: number | null }): Promise<JobContext> {
  const now = container.engine.clock();
  const versions = await tx.select({ version: rolePackets.version, packet: rolePackets.packet }).from(rolePackets).where(eq(rolePackets.roleId, role.id));
  const packets = new Map(versions.map((v) => [v.version, v.packet]));
  return { roleStatus: role.status as RoleStatus, packets, current: role.currentPacketVersion ? packets.get(role.currentPacketVersion) ?? null : null, planStop: await aiInterviewPlanStop(tx, role.companyId, now), now, emailStopped: container.emailStopped };
}

/**
 * Why the plan stops a new AI interview for this company now, or null: the trial has ended, this month's AI interviews
 * are used up (they are counted at a candidate's first answer, so this looks at what is used, not at who is invited),
 * or the plan's AI help is used up (the interview's turns and its scorecard need it).
 */
export async function aiInterviewPlanStop(tx: Tx, companyId: string, now: Date): Promise<PlanStop | null> {
  if ((await companyTrialStanding(tx, companyId, now))?.ended) return "trial_ended";
  if (!(await entitlements.check(tx, companyId, TEXT_SCREENS, 1, { now })).ok) return "ai_interviews_used_up";
  return (await aiCreditStanding(tx, companyId, { now, settled: true }))?.usedUp ? "ai_used_up" : null;
}

/**
 * The CV score of one person, from their newest CV reading and the job version it was read against. Before they are
 * read: "being read". Read and no reading: why (`unscored`). `earlierVersion`: the job's must-haves or skills changed
 * since their reading.
 */
export function cvScoreOfPerson(p: Person, ctx: Pick<JobContext, "packets" | "current">): CvScore {
  if (p.app.stage === "applied" || p.app.stage === "received") return noCvScore("being_read");
  const packet = p.reading ? ctx.packets.get(p.reading.packetVersion) : undefined;
  if (!p.reading || !packet) return noCvScore(p.unscored ?? "not_scored");
  return cvScoreFromReading(p.reading.result, packet, { earlierVersion: !!ctx.current && !sameRequirements(packet, ctx.current) });
}

/** The interview score of one person: null until they sent their answers; then the scorecard's, or why there is none yet. */
export function interviewScoreOfPerson(p: Person, ctx: Pick<JobContext, "packets">): InterviewScore | null {
  const { screen } = p;
  if (!screen || !screenAnswersSent(screen)) return null;
  const packet = ctx.packets.get(p.app.packetVersion);
  if (p.scorecard && packet) return interviewScoreFromScorecard(p.scorecard, askedQuestions(screen, packet));
  return noInterviewScore(screen.progress.scoreWaitsForCredit ? "ai_used_up" : p.scoringOver ? "not_scored" : "being_scored");
}

/** The facts the one rule of actions reads (`candidateActions`), each a stored fact. */
export function actionFacts(p: Person, ctx: JobContext): CandidateActionFacts {
  return {
    stage: p.app.stage,
    aiInterview: aiInterviewViewOf(p.screen)?.status ?? null,
    toldState: p.app.stage === "rejected" ? p.app.toldState : null,
    decisionEmailWaiting: p.decisionEmailWaiting,
    reachable: !!p.candidate.email && !p.candidate.anonymizedAt && !ctx.emailStopped(p.candidate.email),
    remindedRecently: !!p.screen && remindedRecently(p.screen, ctx.now),
    roleStatus: ctx.roleStatus,
    planStop: ctx.planStop,
  };
}

const nameOf = (c: Pick<Candidate, "firstName" | "lastName">): string => `${c.firstName} ${c.lastName}`.trim();

/** One person as a row of the Candidates list. */
export function rowOf(p: Person, ctx: JobContext): CandidateRow {
  const aiInterview = aiInterviewViewOf(p.screen);
  const interview = interviewScoreOfPerson(p, ctx);
  const packet = ctx.packets.get(p.app.packetVersion);
  const toldState = p.app.stage === "rejected" ? p.app.toldState : null;
  return {
    id: p.app.id,
    name: nameOf(p.candidate),
    appliedAt: iso(p.app.createdAt),
    stage: p.app.stage,
    tab: tabOf(p.app.stage),
    label: stageLabel(p.app.stage, aiInterview?.status),
    cvScore: cvScoreSummary(cvScoreOfPerson(p, ctx)),
    interviewScore: interview ? interviewScoreSummary(interview) : null,
    aiInterview,
    flags: packet ? formAnswerViews(packet.formQuestions, formAnswersOf(p.app.answers)).flatMap((v) => (v.flag ? [v.flag] : [])) : [],
    toldState,
    toldLabel: toldState ? TOLD_STATE_LABEL[toldState] : null,
    actions: candidateActions(actionFacts(p, ctx)),
  };
}

const noCounts = (): CandidateCounts => ({ total: 0, byTab: Object.fromEntries(CandidateTab.options.map((tab) => [tab, 0])) as Record<CandidateTab, number>, locked: 0 });

/**
 * How many people each job has in each tab. A tab counts the people the team may read; the people past the plan's
 * candidates per job are counted only in `locked` and in `total`.
 */
export async function candidateCounts(tx: Tx, roleIds: readonly string[]): Promise<Map<string, CandidateCounts>> {
  const out = new Map(roleIds.map((id) => [id, noCounts()]));
  if (!roleIds.length) return out;
  const byStage = await tx.select({ roleId: applications.roleId, stage: applications.stage, n: count() }).from(applications).where(and(inArray(applications.roleId, [...roleIds]), notLocked())).groupBy(applications.roleId, applications.stage);
  for (const row of byStage) {
    const counts = out.get(row.roleId);
    if (!counts) continue;
    counts.total += Number(row.n);
    if (row.stage in STAGE_TAB) counts.byTab[tabOf(row.stage)] += Number(row.n);
  }
  const locked = await tx.select({ roleId: applications.roleId, n: count() }).from(applications).where(and(inArray(applications.roleId, [...roleIds]), lockedAndWaiting())).groupBy(applications.roleId);
  for (const row of locked) {
    const counts = out.get(row.roleId);
    if (!counts) continue;
    counts.locked = Number(row.n);
    counts.total += Number(row.n);
  }
  return out;
}

/**
 * GET /api/v1/roles/:id/applications: one tab's rows in the server's order (by CV score, highest first, no score last,
 * then who applied first; Interviewed by interview score, then CV score), the counts of every tab, and the locked cards.
 * Null when the job is not this company's.
 */
export async function candidateList(tx: Tx, container: Pick<Container, "engine" | "emailStopped">, input: { roleId: string; tab: CandidateTab }): Promise<CandidateList | null> {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) return null;
  const stages = (Object.keys(STAGE_TAB) as ApplicationStage[]).filter((s) => STAGE_TAB[s] === input.tab);
  const apps = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), notLocked(), inArray(applications.stage, stages)));
  const ctx = await jobContext(tx, container, role);
  const rows = (await loadPeople(tx, apps)).map((p) => rowOf(p, ctx)).sort(input.tab === "interviewed" ? byInterviewScore : byCvScore);
  return { role: { id: role.id, title: role.title, status: ctx.roleStatus, version: role.currentPacketVersion }, tab: input.tab, counts: (await candidateCounts(tx, [role.id])).get(role.id) ?? noCounts(), rows, locked: await lockedCardsOf(tx, role.id) };
}

/** The AI's words about a CV or an AI interview as the panel shows them: each point with its checked quote and where it is from. */
function reviewOf(reading: Pick<EvidenceAssessment, "summary" | "strengths" | "concerns" | "unknowns">): AiReview {
  const point = (f: EvidenceAssessment["strengths"][number]) => {
    const quote = f.evidence.quote?.trim() && !f.evidence.unquoted ? f.evidence.quote.trim() : null;
    return { claim: f.claim, quote, from: quote ? quoteFrom(f.evidence.source) : null };
  };
  return { summary: reading.summary, strengths: (reading.strengths ?? []).map(point), concerns: (reading.concerns ?? []).map(point), openQuestions: (reading.unknowns ?? []).map((u) => ({ question: u.question, whyItMatters: u.whyItMatters })) };
}

/** Every question a sent AI interview asked, the closing one too, with the answer the candidate sent. */
function interviewAnswers(screen: Screen, packet: RolePacket): InterviewAnswer[] {
  const asked = new Set(screen.progress.askedKeys);
  const declined = new Set(screen.progress.declined ?? []);
  const own = new Set((screen.progress.chat?.items ?? []).filter((i) => i.kind === "question").map((i) => i.key));
  return chatPacket(packet, screen.progress).screening.questions.filter((q) => own.has(q.key) || asked.has(q.key)).map((q) => {
    const answer = screen.answers[q.key]?.trim() || null;
    return { key: q.key, question: q.question, answer, skipped: !answer && declined.has(q.key) };
  });
}

/**
 * GET /api/v1/applications/:id: one candidate as the panel shows them. Opening it is recorded in the audit history. Null
 * when the application is not this company's (someone past the plan's limit is refused before this, by the path guard).
 */
export async function candidatePanel(tx: Tx, container: Pick<Container, "engine" | "emailStopped">, input: { applicationId: string; companyId: string; actor: Actor }): Promise<CandidatePanel | null> {
  const [app] = await tx.select().from(applications).where(and(eq(applications.id, input.applicationId), notLocked())).limit(1);
  const [role] = app ? await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1) : [];
  const [p] = app ? await loadPeople(tx, [app]) : [];
  if (!app || !role || !p) return null;
  const ctx = await jobContext(tx, container, role);
  const row = rowOf(p, ctx);
  const packet = ctx.packets.get(app.packetVersion) ?? null;
  const [doc] = app.resumeDocumentId ? await tx.select({ id: documents.id, filename: documents.filename, mime: documents.mime, sizeBytes: documents.sizeBytes, status: documents.status, text: documents.textExtracted }).from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1) : [];
  const status = (doc && doc.status in CV_FILE_STATUS_LABEL ? doc.status : "deleted") as CvFileStatus;
  const cv: CandidateDocument | null = doc ? { id: doc.id, filename: doc.filename, mime: doc.mime, sizeBytes: doc.sizeBytes, status, statusLabel: CV_FILE_STATUS_LABEL[status], hasText: !!doc.text?.trim() } : null;
  const sent = !!p.screen && screenAnswersSent(p.screen);
  await audit(tx, { companyId: input.companyId, actor: input.actor, action: "candidate.viewed", target: { type: "application", id: app.id } });
  return {
    id: app.id,
    role: { id: role.id, title: role.title, status: ctx.roleStatus },
    candidate: { firstName: p.candidate.firstName, lastName: p.candidate.lastName, name: row.name, email: p.candidate.email, phone: p.candidate.phone },
    appliedAt: row.appliedAt,
    source: app.source,
    sourceLabel: applySourceLabel(app.source),
    stage: row.stage,
    tab: row.tab,
    label: row.label,
    toldState: row.toldState,
    toldLabel: row.toldLabel,
    toldAt: app.stage === "rejected" && app.candidateToldAt ? iso(app.candidateToldAt) : null,
    cv,
    cvScore: cvScoreOfPerson(p, ctx),
    cvReview: p.reading ? reviewOf(p.reading.result) : null,
    screeningAnswers: packet ? formAnswerViews(packet.formQuestions, formAnswersOf(app.answers)) : [],
    // Nothing of an interview reaches the team before the candidate sent it: no score, no words, no answer.
    aiInterview: row.aiInterview ? { ...row.aiInterview, score: interviewScoreOfPerson(p, ctx), review: sent && p.scorecard ? reviewOf(p.scorecard) : null, answers: sent && p.screen && packet ? interviewAnswers(p.screen, packet) : [] } : null,
    actions: row.actions,
  };
}
