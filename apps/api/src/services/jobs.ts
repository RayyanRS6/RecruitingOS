import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { ApplicationStage, CandidateTab, ROLE_STATUS_LABEL, RolePacket as RolePacketSchema, RoleStatus, roleActions, tabOf, type CandidateCounts, type RoleDetail, type RolePacket, type RoleSummary } from "@ros/contracts";
import { jobNoticesFor, lockedAndWaiting, notLocked, payShown, payTransparencyApplies } from "@ros/core";
import { applications, companies, rolePackets, roles, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { closingDateFor } from "./closing-date";
import { jobUrls } from "./job-urls";
import { currentVersionOf, type RoleRow } from "./packet-versions";
import { legalCheckFor, publishCheckFor } from "./publish";
import { companyTrialStanding } from "./trial";

/**
 * A job as the company's screens read it: one line of the Jobs list (`RoleSummary`) and a job's page (`RoleDetail`).
 * Every label, count and action is worked out here, so a screen shows what it gets.
 */

/** A job's status as the screens know it; anything stored from before the four statuses reads as a draft. */
function statusOf(role: Pick<RoleRow, "status">): RoleStatus {
  const status = RoleStatus.safeParse(role.status);
  return status.success ? status.data : "draft";
}

/** Where a job is, in words: its first place. */
export function placeOf(locations: ReadonlyArray<{ label?: string; city?: string; region?: string }> | null | undefined): string | null {
  const first = locations?.[0];
  return first ? [first.city, first.region].filter(Boolean).join(", ") || first.label || null : null;
}

/** When anything last happened on a job: the latest of its own changes and its newest application. */
function lastActivityOf(role: RoleRow, newestApplication: string | null): string {
  const times = [role.createdAt, role.updatedAt, role.openedAt, role.pausedAt, role.closedAt, newestApplication].map((x) => (x ? Date.parse(x) : Number.NaN)).filter((n) => Number.isFinite(n));
  return times.length ? new Date(Math.max(...times)).toISOString() : role.createdAt;
}

const iso = (at: string | null): string | null => (at ? new Date(at).toISOString() : null);

const noCounts = (): CandidateCounts => ({ total: 0, byTab: Object.fromEntries(CandidateTab.options.map((tab) => [tab, 0])) as Record<CandidateTab, number>, locked: 0 });

/**
 * How many people each job has in each tab, the people past the plan's candidates per job counted only in `total` and
 * `locked`, and each job's newest application. Three queries for the whole list, whatever its length.
 */
async function countsFor(tx: Tx, roleIds: string[]): Promise<Map<string, { counts: CandidateCounts; newest: string | null }>> {
  const out = new Map(roleIds.map((id) => [id, { counts: noCounts(), newest: null as string | null }]));
  if (!roleIds.length) return out;
  const byStage = await tx.select({ roleId: applications.roleId, stage: applications.stage, n: count() }).from(applications).where(and(inArray(applications.roleId, roleIds), notLocked())).groupBy(applications.roleId, applications.stage);
  for (const row of byStage) {
    const stage = ApplicationStage.safeParse(row.stage);
    const entry = out.get(row.roleId);
    if (!entry) continue;
    entry.counts.total += Number(row.n);
    if (stage.success) entry.counts.byTab[tabOf(stage.data)] += Number(row.n);
  }
  const locked = await tx.select({ roleId: applications.roleId, n: count() }).from(applications).where(and(inArray(applications.roleId, roleIds), lockedAndWaiting())).groupBy(applications.roleId);
  for (const row of locked) {
    const entry = out.get(row.roleId);
    if (!entry) continue;
    entry.counts.locked = Number(row.n);
    entry.counts.total += Number(row.n);
  }
  const newest = await tx.select({ roleId: applications.roleId, at: sql<string | Date | null>`max(${applications.createdAt})` }).from(applications).where(inArray(applications.roleId, roleIds)).groupBy(applications.roleId);
  // a raw max() may come back from the driver as a Date or as text
  for (const row of newest) {
    const entry = out.get(row.roleId);
    if (entry && row.at) entry.newest = row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString();
  }
  return out;
}

function summaryOf(role: RoleRow, place: string | null, counted: { counts: CandidateCounts; newest: string | null }, now: Date): RoleSummary {
  const status = statusOf(role);
  return {
    id: role.id,
    title: role.title,
    place,
    status,
    statusLabel: ROLE_STATUS_LABEL[status],
    createdAt: new Date(role.createdAt).toISOString(),
    openedAt: iso(role.openedAt),
    closedAt: iso(role.closedAt),
    daysOpen: role.openedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(role.openedAt)) / 86_400_000)) : null,
    lastActivityAt: lastActivityOf(role, counted.newest),
    closesOn: role.applicationsCloseOn ? role.applicationsCloseOn.slice(0, 10) : null,
    acceptingApplications: status === "open" && role.acceptingApplications,
    counts: counted.counts,
  };
}

/** The Jobs list, newest first; `status` keeps one status. */
export async function roleSummaries(tx: Tx, container: Container, t: Pick<Tenant, "companyId">, status?: RoleStatus): Promise<RoleSummary[]> {
  const list = await tx.select().from(roles).where(status ? and(eq(roles.companyId, t.companyId), eq(roles.status, status)) : eq(roles.companyId, t.companyId)).orderBy(desc(roles.createdAt));
  if (!list.length) return [];
  const ids = list.map((r) => r.id);
  const counted = await countsFor(tx, ids);
  // Each job's places, from the version it runs on (the newest while it is a draft).
  const versions = await tx.select({ roleId: rolePackets.roleId, version: rolePackets.version, locations: sql<RolePacket["identity"]["locations"] | null>`${rolePackets.packet}->'identity'->'locations'` }).from(rolePackets).where(inArray(rolePackets.roleId, ids)).orderBy(desc(rolePackets.version));
  const now = container.engine.clock();
  return list.map((role) => {
    const mine = versions.filter((v) => v.roleId === role.id);
    const current = mine.find((v) => v.version === role.currentPacketVersion) ?? mine[0];
    return summaryOf(role, placeOf(current?.locations), counted.get(role.id) ?? { counts: noCounts(), newest: null }, now);
  });
}

/**
 * A job's page: the version it runs on (the newest while it is a draft) with what the page shows beside it. An older
 * stored version reads as today's record. Null when the job is not this company's.
 */
export async function roleDetail(tx: Tx, container: Container, t: Pick<Tenant, "companyId" | "role">, roleId: string): Promise<RoleDetail | null> {
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) return null;
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const current = currentVersionOf(role, versions);
  const parsed = current ? RolePacketSchema.safeParse(current.packet) : null;
  const packet = parsed?.success ? parsed.data : null;
  const [company] = await tx.select({ slug: companies.slug, locations: companies.locations, settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  const now = container.engine.clock();
  const counted = (await countsFor(tx, [role.id])).get(role.id) ?? { counts: noCounts(), newest: null };
  const status = statusOf(role);
  const notices = packet ? jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company?.locations ?? [], overrides: company?.settings.notices }) : [];
  const trialEnded = !!(await companyTrialStanding(tx, role.companyId, now))?.ended;
  return {
    ...summaryOf(role, placeOf(packet?.identity.locations), counted, now),
    version: current?.version ?? null,
    packet,
    payShown: !!packet && payShown(packet.compensation, notices),
    payRequiredByLaw: payTransparencyApplies(notices),
    closingDate: closingDateFor(role, company ?? null, packet, now),
    legalCheck: packet ? await legalCheckFor(tx, { role, packet, now }) : null,
    flags: packet?.provenance.flags ?? [],
    urls: jobUrls(container.env, { slug: company?.slug ?? "", roleId: role.id }),
    public: status === "open" || status === "paused",
    publish: status === "draft" ? (packet ? await publishCheckFor(tx, { role, packet, now }) : { allowed: false, blockers: [{ code: "no_draft", message: "This job has not been written yet." }] }) : null,
    actions: roleActions({ status, role: t.role, trialEnded }),
  };
}
