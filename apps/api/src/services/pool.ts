import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { BOARD_COLUMN_LABEL, BoardColumn, type ActiveMark, type BoardCard, type BoardPlacement, type BoardView, type MatchScore, type MustHaveSummary, type ReadingVersion, type RolePacket } from "@ros/contracts";
import { CLOSER_LOOK_LABEL, STAGE_LABEL, activeFollowUpsFor, activeMarksFor, baseOwnerStage, boardPlacement, daysSince, evidenceView, matchScore, mustHaveSummary, ownerStage, ownerStageLabel, poolSummary, readingPair, readingVersion, unsentScreenReadings, type EvidenceView, type FollowUpView, type PoolPerson } from "@ros/core";
import { applications, approvalRequests, assessments, candidates, documents, events, interviews, rolePackets, roles, screens, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { INTERVIEW_ACTIVE_STATUSES, SCREEN_OPEN_STATUSES } from "./application-actions";
import { stillApplyingFor } from "./screens";

/**
 * The pool of one role as the board, Review and apply, the one-click questions and Today read it (plan Wave F): each
 * person's match score, must-have line and board placement, worked out on read from the stored findings (founder
 * decision B2), so they always match the evidence. No column caches the score: the list sorts by it in memory, and
 * everything is loaded with one query per kind of fact, never one per person.
 */
type AppRow = typeof applications.$inferSelect;
type AssessmentRow = typeof assessments.$inferSelect;

/** The role's packets by version, and the current one. */
export async function packetsOf(tx: Tx, role: Pick<typeof roles.$inferSelect, "id" | "currentPacketVersion">): Promise<{ byVersion: Map<number, RolePacket>; current: RolePacket | null; currentVersion: number | null }> {
  const rows = await tx.select({ version: rolePackets.version, packet: rolePackets.packet }).from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const byVersion = new Map(rows.map((r) => [r.version, r.packet]));
  const currentVersion = role.currentPacketVersion ?? rows[0]?.version ?? null;
  return { byVersion, current: currentVersion ? byVersion.get(currentVersion) ?? null : null, currentVersion };
}

/**
 * A person's readings as the team may see them: never one written from a conversation they did not send (founder
 * decision of 9 October 2026; `unsentScreenReadings` in @ros/core), so the reading and the match score rest on the
 * résumé and the application alone. The latest reading falls back to the newest one left.
 */
export function shownReadings<A extends Pick<AppRow, "latestAssessmentId">>(app: A, own: readonly AssessmentRow[], hidden: ReadonlySet<string>): { app: A; assessments: AssessmentRow[] } {
  if (!hidden.size || !own.some((x) => hidden.has(x.id))) return { app, assessments: [...own] };
  const left = own.filter((x) => !hidden.has(x.id));
  const latestAssessmentId = app.latestAssessmentId && hidden.has(app.latestAssessmentId) ? (left[0]?.id ?? null) : app.latestAssessmentId;
  return { app: { ...app, latestAssessmentId }, assessments: left };
}

/** A person's latest reading in brief, for counts over many people. */
export type LatestReading = { id: string; applicationId: string; createdAt: string; overall: string | null; recommendation: string | null };

/**
 * Each application's latest reading as the team may see it, for counts over many people (Today's strong count, the role
 * report): the latest one, unless it was written from a conversation the candidate never sent, then the newest one left
 * (their résumé's), as `shownReadings` does for the list, the board and the candidate's page. One query for the latest
 * readings, one for the screens that point at a reading without being complete, and one more only for those who fall
 * back. `roleIds` narrows it to some roles; every application of the company otherwise.
 */
export async function shownLatestReadings(tx: Tx, input: { companyId: string; roleIds?: readonly string[] | null }): Promise<Map<string, LatestReading>> {
  if (input.roleIds && !input.roleIds.length) return new Map();
  const columns = { id: assessments.id, applicationId: assessments.applicationId, createdAt: assessments.createdAt, overall: assessments.overall, recommendation: sql<string | null>`${assessments.result}->>'recommendation'`, kind: assessments.kind, anomalies: sql<unknown>`${assessments.result}->'anomalies'` };
  const ofCompany = input.roleIds ? and(eq(applications.companyId, input.companyId), inArray(applications.roleId, [...input.roleIds])) : eq(applications.companyId, input.companyId);
  const latest = await tx.select(columns).from(applications).innerJoin(assessments, eq(assessments.id, applications.latestAssessmentId)).where(ofCompany);
  if (!latest.length) return new Map();
  // A screen still pointing at a reading without being complete: few, so the whole company's are read.
  const links = await tx.select({ status: screens.status, assessmentId: screens.assessmentId }).from(screens).where(and(eq(screens.companyId, input.companyId), isNotNull(screens.assessmentId), ne(screens.status, "completed")));
  const asReading = (r: (typeof latest)[number]) => ({ id: r.id, kind: r.kind, result: { anomalies: r.anomalies } });
  const hidden = unsentScreenReadings(links, latest.map(asReading));
  const fallBack = latest.filter((r) => hidden.has(r.id)).map((r) => r.applicationId);
  const earlier = fallBack.length ? await tx.select(columns).from(assessments).where(and(eq(assessments.companyId, input.companyId), inArray(assessments.applicationId, fallBack))).orderBy(desc(assessments.createdAt)) : [];
  const hiddenEarlier = unsentScreenReadings(links, earlier.map(asReading));
  const out = new Map<string, LatestReading>();
  const keep = (r: (typeof latest)[number]) => out.set(r.applicationId, { id: r.id, applicationId: r.applicationId, createdAt: r.createdAt, overall: r.overall, recommendation: r.recommendation });
  for (const r of latest) if (!hidden.has(r.id)) keep(r);
  for (const r of earlier) if (!out.has(r.applicationId) && !hidden.has(r.id) && !hiddenEarlier.has(r.id)) keep(r);
  return out;
}

/** What the score, the must-have line and the placement of one person rest on, from rows already loaded. */
export type ScoredPerson = { latest: AssessmentRow | null; evidence: EvidenceView; match: MatchScore | null; mustHaves: MustHaveSummary | null; placement: BoardPlacement; readingVersion: ReadingVersion | null };

/**
 * One person's score, must-have line, placement and version label. The findings are read against the version of the
 * role the application was read against (plan F4); the label says when that is not the current version, and whether
 * the must-haves changed since (a decline resting on them then waits for a person). "Missing a must-have" on the list
 * reads the same merged findings as the score, so the filter, the score and the board agree.
 */
export function scorePerson(input: { app: Pick<AppRow, "stage" | "latestAssessmentId" | "packetVersion">; assessments: readonly AssessmentRow[]; packets: Map<number, RolePacket>; currentVersion: number | null; mark: Pick<ActiveMark, "mark" | "remindAt"> | null; stillApplying: boolean; resumeUnreadable: boolean; openScreen: boolean }): ScoredPerson {
  const { app } = input;
  const latest = input.assessments.find((x) => x.id === app.latestAssessmentId) ?? null;
  const pair = readingPair(input.assessments);
  const readAgainst = latest?.packetVersion ?? app.packetVersion;
  const packet = input.packets.get(readAgainst) ?? input.packets.get(app.packetVersion) ?? (input.currentVersion ? input.packets.get(input.currentVersion) : undefined) ?? null;
  const match = packet ? matchScore(pair, packet, { packetVersion: readAgainst }) : null;
  const evidence = evidenceView({ stage: app.stage, latest, resumeUnreadable: input.resumeUnreadable, packet });
  if (match) evidence.hasProvenMiss = match.missingMustHave.length > 0;
  const mustHaves = packet ? mustHaveSummary(pair, packet) : null;
  const version = latest ? readingVersion(readAgainst, input.currentVersion, { was: input.packets.get(readAgainst), now: input.currentVersion ? input.packets.get(input.currentVersion) : null }) : null;
  const placement = boardPlacement({ stage: app.stage, base: baseOwnerStage(app.stage), stageLabel: STAGE_LABEL[app.stage], mark: input.mark, stillApplying: input.stillApplying, latest, evidence, match, mustHaves, openScreen: input.openScreen, readingVersion: version });
  return { latest, evidence, match, mustHaves, placement, readingVersion: version };
}

/** The list rows' four score fields (founder decision B2): the number, its band, the coverage and the missing must-haves. */
export function scoreFields(match: MatchScore | null) {
  return { score: match?.score ?? null, band: match?.band ?? null, bandLabel: match?.bandLabel ?? null, coverage: match?.coverage ?? null, missingMustHave: match?.missingMustHave ?? [] };
}

export type PoolRow = ScoredPerson & {
  app: AppRow;
  name: string;
  assessments: AssessmentRow[];
  mark: ActiveMark | null;
  /** Their open follow-up (the Cancelled column, founder decisions 1A to 4A): the card's stage label reads it. */
  followUp: FollowUpView | null;
  stillApplying: boolean;
  openScreen: boolean;
  invitedAutomatically: boolean;
  suggestionWaiting: boolean;
  activeInterview: boolean;
};

export type Pool = { role: typeof roles.$inferSelect; packet: RolePacket | null; packets: Map<number, RolePacket>; currentVersion: number | null; rows: PoolRow[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/**
 * Everything the board knows about a role's applicants, in one query per kind of fact. An ITS recruiter given one
 * candidate sees that candidate only (`tenant.staff`, or `scopeApplicationId` for Today's viewer). `onlyIds` narrows the
 * load to some applications (Review and apply).
 */
export async function loadPool(tx: Tx, input: { roleId: string; tenant?: Pick<Tenant, "staff"> | null; scopeApplicationId?: string | null; onlyIds?: readonly string[] }): Promise<Pool> {
  const [role] = isUuid(input.roleId) ? await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1) : [];
  if (!role) throw new HttpError(404, "not_found", "Role not found.");
  const scope = input.scopeApplicationId ?? input.tenant?.staff?.scope.applicationId ?? null;
  // An id that is not one names nobody (Postgres would refuse it for the column).
  const only = input.onlyIds?.filter(isUuid);
  const where = only ? and(eq(applications.roleId, role.id), inArray(applications.id, only.length ? only : ["00000000-0000-0000-0000-000000000000"])) : eq(applications.roleId, role.id);
  const apps = (await tx.select().from(applications).where(where).orderBy(desc(applications.createdAt))).filter((a) => !scope || a.id === scope);
  const { byVersion, current, currentVersion } = await packetsOf(tx, role);
  if (!apps.length) return { role, packet: current, packets: byVersion, currentVersion, rows: [] };
  const appIds = apps.map((a) => a.id);
  const names = new Map((await tx.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, apps.map((a) => a.candidateId)))).map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const asmts = await tx.select().from(assessments).where(inArray(assessments.applicationId, appIds)).orderBy(desc(assessments.createdAt));
  const docIds = apps.filter((a) => a.resumeDocumentId).map((a) => a.resumeDocumentId!);
  const docs = docIds.length ? await tx.select({ id: documents.id, status: documents.status, hasText: sql<boolean>`${documents.textExtracted} is not null` }).from(documents).where(inArray(documents.id, docIds)) : [];
  const marks = await activeMarksFor(tx, appIds);
  const followUps = await activeFollowUpsFor(tx, appIds);
  const scr = await tx.select({ id: screens.id, applicationId: screens.applicationId, status: screens.status, assessmentId: screens.assessmentId }).from(screens).where(inArray(screens.applicationId, appIds)).orderBy(desc(screens.createdAt));
  const hidden = unsentScreenReadings(scr, asmts);
  const applying = await stillApplyingFor(tx, appIds);
  // Who sent the screening invitation: the assistant on its own ("invited automatically") or a person.
  const invites = scr.length ? await tx.select({ subjectId: events.subjectId, payload: events.payload }).from(events).where(and(eq(events.type, "screen.invited"), inArray(events.subjectId, scr.map((s) => s.id)))) : [];
  const automatic = new Set(invites.filter((e) => (e.payload as { invitedBy?: unknown }).invitedBy === "system").map((e) => e.subjectId));
  const ivs = await tx.select({ applicationId: interviews.applicationId, status: interviews.status }).from(interviews).where(inArray(interviews.applicationId, appIds));
  const waiting = new Set((await tx.select({ applicationId: approvalRequests.applicationId }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, appIds), inArray(approvalRequests.actionType, ["application.invite_screen", "application.recommend_interview"]), eq(approvalRequests.status, "pending")))).map((r) => r.applicationId));
  const rows = apps.map((loaded): PoolRow => {
    const { app, assessments: own } = shownReadings(loaded, asmts.filter((x) => x.applicationId === loaded.id), hidden);
    const doc = docs.find((d) => d.id === app.resumeDocumentId);
    const mark = marks.get(app.id) ?? null;
    const ownScreens = scr.filter((s) => s.applicationId === app.id);
    const openScreen = ownScreens.some((s) => SCREEN_OPEN_STATUSES.includes(s.status));
    const stillApplying = applying.has(app.id);
    const scored = scorePerson({ app, assessments: own, packets: byVersion, currentVersion, mark, stillApplying, resumeUnreadable: !!doc && doc.status === "clean" && !doc.hasText && !app.extraction, openScreen });
    return {
      ...scored,
      app,
      name: names.get(app.candidateId) || "Unknown",
      assessments: own,
      mark,
      followUp: followUps.get(app.id) ?? null,
      stillApplying,
      openScreen,
      invitedAutomatically: !!ownScreens[0] && automatic.has(ownScreens[0].id),
      suggestionWaiting: waiting.has(app.id),
      activeInterview: ivs.some((i) => i.applicationId === app.id && INTERVIEW_ACTIVE_STATUSES.includes(i.status)),
    };
  });
  return { role, packet: current, packets: byVersion, currentVersion, rows };
}

/** The person as the summary and the questions read them. */
export function poolPersonOf(row: PoolRow): PoolPerson {
  return { applicationId: row.app.id, name: row.name, waitingSince: new Date(row.app.stageChangedAt).toISOString(), stillApplying: row.stillApplying, placement: row.placement, match: row.match, mustHaves: row.mustHaves };
}

/** Where a person opens: their panel on the role's Talent page. */
export const openPath = (roleId: string, applicationId: string) => `/roles/${roleId}/talent?open=${applicationId}`;

const READING_WORDS: Record<string, string> = { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" };

export function boardCard(row: PoolRow, roleId: string, now: Date): BoardCard {
  const { app, latest, match } = row;
  // The board keeps its three columns (`boardPlacement`); someone under Cancelled is labelled so on their card.
  const strip = ownerStage(app, row.mark, row.followUp);
  const quoteOf = (f: { claim: string; evidence: { source: string; quote?: string; unquoted?: boolean } }) => ({ claim: f.claim, quote: f.evidence.quote?.trim() || null, source: f.evidence.source, unquoted: !!f.evidence.unquoted || !f.evidence.quote?.trim() });
  // The gap that cost the most, with its quote, before the reading's own first concern.
  const top = match?.breakdown.find((c) => c.pointsLost > 0) ?? null;
  const gap = top ? { claim: `${top.label}: ${top.finding.toLowerCase()}`, quote: top.quote, source: top.source, unquoted: top.unquoted } : latest?.result.concerns[0] ? quoteOf(latest.result.concerns[0]) : null;
  return {
    applicationId: app.id,
    name: row.name,
    appliedAt: new Date(app.createdAt).toISOString(),
    waitingDays: daysSince(new Date(app.stageChangedAt).toISOString(), now),
    stage: app.stage,
    stageLabel: row.evidence.needsCloserLook ? CLOSER_LOOK_LABEL : STAGE_LABEL[app.stage],
    ownerStage: strip,
    ownerStageLabel: ownerStageLabel(strip, row.mark, row.followUp),
    mark: row.mark,
    score: match,
    mustHaves: row.mustHaves,
    confidence: match?.confidence ?? null,
    reading: latest ? (row.evidence.needsCloserLook ? CLOSER_LOOK_LABEL : READING_WORDS[latest.overall] ?? null) : null,
    strengths: (latest?.result.strengths ?? []).slice(0, 2).map(quoteOf),
    gap,
    placement: row.placement,
    readingVersion: row.readingVersion,
    facts: { openScreen: row.openScreen, invitedAutomatically: row.invitedAutomatically, suggestionWaiting: row.suggestionWaiting, stillApplying: row.stillApplying, lowConfidence: row.evidence.lowConfidence, needsCloserLook: row.evidence.needsCloserLook },
    open: openPath(roleId, app.id),
  };
}

/**
 * The board (plan F6): the three columns, the people still applying apart, and the summary (plan F7). In each column
 * the people still to sort come first, highest score first, then those already done; ties go to the longest wait.
 */
export function boardView(pool: Pool, now: Date): BoardView {
  const columns = Object.fromEntries(BoardColumn.options.map((c) => [c, [] as BoardCard[]])) as BoardView["columns"];
  const stillApplying: BoardCard[] = [];
  for (const row of pool.rows) {
    const card = boardCard(row, pool.role.id, now);
    if (!row.placement.column) stillApplying.push(card);
    else columns[row.placement.column].push(card);
  }
  const rank = (c: BoardCard) => (c.placement.state === "suggested" ? 0 : c.placement.state === "waiting" ? 1 : 2);
  for (const c of BoardColumn.options) columns[c].sort((a, b) => rank(a) - rank(b) || (b.score?.score ?? -1) - (a.score?.score ?? -1) || b.waitingDays - a.waitingDays || a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId));
  return {
    role: { id: pool.role.id, title: pool.role.title, status: pool.role.status, currentPacketVersion: pool.currentVersion },
    columns,
    stillApplying,
    summary: poolSummary(pool.rows.map(poolPersonOf), pool.packet, { roleId: pool.role.id, now }),
    generatedAt: now.toISOString(),
  };
}

/** "3 on the shortlist, 2 on the longlist": the column names in words, for toasts and cards. */
export function columnWords(counts: Record<string, number>): string {
  return BoardColumn.options.filter((c) => counts[c]).map((c) => `${counts[c]} ${c === "not_moving_forward" ? "not moving forward" : `on the ${BOARD_COLUMN_LABEL[c].toLowerCase()}`}`).join(", ");
}
