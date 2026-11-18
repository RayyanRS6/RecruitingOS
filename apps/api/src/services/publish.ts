import { and, desc, eq, ne } from "drizzle-orm";
import { ROLE_ACTION_BLOCKED, type Actor, type LegalCheck, type LegalCheckItem, type PacketFlag, type PublishBlocker, type PublishCheck, type PublishResult, type RolePacket } from "@ros/contracts";
import { assertCan, closingDateProblem, closingDateRequired, companyToday, defaultClosingDate, emit, openFlagsMessage, postingLegalCheck, unresolvedFlags } from "@ros/core";
import { companies, events, intakeSessions, rolePackets, roles, type Tx } from "@ros/db";
import { armClosingDate } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { jobUrls } from "./job-urls";
import { limitReached, planRoom } from "./plan-room";
import { assertNoNewWork } from "./trial";

/**
 * Publishing a job. A person on the team who may publish presses one button and the job is open: nobody else approves
 * it. What is checked first, here and nowhere else: the person's role, the plan, the wording flags of the fairness
 * guard, and what the law of the job's places asks of the ad.
 */

type RoleRow = typeof roles.$inferSelect;

/** The parts of a job record, or of a draft not yet a job, that the checks read. A draft has no pay until a person sets it. */
type CheckedPacket = {
  identity: Pick<RolePacket["identity"], "locations" | "remotePolicy">;
  compensation?: Pick<RolePacket["compensation"], "min" | "max" | "benefitsSummary"> | null;
  provenance: { flags?: PacketFlag[] };
};

/**
 * The legal check of a version before it goes public: what the law of the job's places asks of the ad, with the
 * company's benefits description and the job's closing date. A Colorado (or remote) job without a date is not blocked:
 * it gets `defaultClosesOn` when it opens, and the check says so.
 */
export async function legalCheckFor(tx: Tx, input: { role: Pick<RoleRow, "companyId" | "applicationsCloseOn">; packet: Pick<CheckedPacket, "identity" | "compensation">; now: Date }): Promise<LegalCheck> {
  const [company] = await tx.select({ settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, input.role.companyId)).limit(1);
  const needsDate = closingDateRequired({ jobLocations: input.packet.identity.locations, remotePolicy: input.packet.identity.remotePolicy });
  return postingLegalCheck({
    packet: input.packet,
    companySettings: company?.settings ?? null,
    closesOn: input.role.applicationsCloseOn,
    defaultClosesOn: needsDate ? defaultClosingDate(input.now, company?.timezone) : null,
    today: companyToday(input.now, company?.timezone),
  });
}

/** One missing item of the legal check as a blocker: what the law asks for, then how to fix it. */
function legalBlocker(item: LegalCheckItem): PublishBlocker {
  return { code: "legal_check", message: [item.detail, item.fix].filter((part): part is string => !!part).join(" ") };
}

/**
 * What in the job record itself holds publishing: wording the fairness guard flagged that nobody has reworded or kept
 * with a reason (one blocker for all of it), and each thing the law of the job's places asks of the ad that is missing.
 */
export async function recordBlockers(tx: Tx, input: { role: Pick<RoleRow, "companyId" | "applicationsCloseOn">; packet: CheckedPacket; now: Date }): Promise<{ blockers: PublishBlocker[]; legalCheck: LegalCheck }> {
  const open = unresolvedFlags(input.packet);
  const legalCheck = await legalCheckFor(tx, input);
  const blockers: PublishBlocker[] = [...(open.length ? [{ code: "open_flags" as const, message: openFlagsMessage(open.length) }] : []), ...legalCheck.missing.map(legalBlocker)];
  return { blockers, legalCheck };
}

const NO_ROOM = "Your plan has no room for another job.";

/**
 * Whether "Publish job" works now for a draft job, with every plain reason when it does not, in the order the publish
 * refuses: the plan (the trial ended, or no room for another job), then the job record (`recordBlockers`). The job
 * holds its own place on the plan, so it is not counted against itself.
 */
export async function publishCheckFor(tx: Tx, input: { role: Pick<RoleRow, "id" | "companyId" | "applicationsCloseOn">; packet: CheckedPacket; now: Date }): Promise<PublishCheck> {
  const room = await planRoom(tx, input.role.companyId, { newRoleId: input.role.id, now: input.now });
  const plan: PublishBlocker[] = room.ok ? [] : [{ code: room.trialEnded ? "trial_ended" : "plan", message: room.message ?? NO_ROOM }];
  const blockers = [...plan, ...(await recordBlockers(tx, input)).blockers];
  return { allowed: blockers.length === 0, blockers };
}

/** The date chosen in the job builder: kept with the draft as a `role.closing_date_set` event on it, newest last. */
async function builderClosingDate(tx: Tx, roleId: string): Promise<string | null> {
  const [session] = await tx.select({ id: intakeSessions.id }).from(intakeSessions).where(eq(intakeSessions.roleId, roleId)).orderBy(desc(intakeSessions.createdAt)).limit(1);
  if (!session) return null;
  const [last] = await tx.select({ payload: events.payload }).from(events).where(and(eq(events.subjectType, "intake_session"), eq(events.subjectId, session.id), eq(events.type, "role.closing_date_set"))).orderBy(desc(events.id)).limit(1);
  const chosen = (last?.payload as { closesOn?: unknown } | undefined)?.closesOn;
  return typeof chosen === "string" ? chosen.slice(0, 10) : null;
}

/**
 * The closing date a job opens with. Its own date stands; without one, the date chosen in the job builder is taken. A
 * date that has passed would stop applications the moment the job went up, so it is not kept. Where the law asks the ad
 * to say when applications close (Colorado, or a remote job) and no date is left, the job gets one thirty days out, in
 * the company's time zone, which the team can change. The timer that stops applications at the end of that day is set,
 * and any timer waiting for another date is cancelled.
 */
async function settleClosingDate(tx: Tx, container: Container, input: { role: RoleRow; packet: RolePacket; actor: Actor; now: Date }): Promise<string | null> {
  const { role, packet, actor, now } = input;
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  const own = role.applicationsCloseOn ? role.applicationsCloseOn.slice(0, 10) : null;
  const fromBuilder = own ? null : await builderClosingDate(tx, role.id);
  const chosen = own ?? fromBuilder;
  const kept = chosen && !closingDateProblem(chosen, now, company?.timezone) ? chosen : null;
  const required = closingDateRequired({ jobLocations: packet.identity.locations, remotePolicy: packet.identity.remotePolicy });
  const closesOn = kept ?? (required ? defaultClosingDate(now, company?.timezone) : null);
  if (closesOn !== own) {
    const why = kept ? { from: "job_builder" } : { defaulted: !!closesOn, reason: own ? "The closing date had passed when the job was published." : "Colorado expects the job ad to say when applications close." };
    await tx.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role.closing_date_set", companyId: role.companyId, actor, subject: { type: "role", id: role.id }, payload: { closesOn, previous: own, ...why } });
  }
  await armClosingDate(tx, container.engine, { companyId: role.companyId, roleId: role.id, closesOn, actor });
  return closesOn;
}

/**
 * Publishes a draft job, inside the caller's tenant transaction, with the job's row locked so two presses publish
 * once. Refused, in this order: the person's role (403); a job that is not a draft (409 `role_closed`, or
 * `already_published` for one that is open or paused); the plan (402 `trial_ended`, 402 `limit_reached`); the job
 * record (409 `not_ready`, each reason in `details.blockers`). Then the newest version becomes the live one, stamped
 * with who published it, the job opens, and its closing date is settled (`settleClosingDate`). Nothing is sent to
 * anyone, and nobody else is asked.
 */
export async function publishRole(tx: Tx, container: Container, input: { tenant: Pick<Tenant, "companyId" | "userId" | "role">; actor: Actor; roleId: string }): Promise<PublishResult> {
  const { tenant: t, actor } = input;
  assertCan(t.role, "role.publish");
  const now = container.engine.clock();
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1).for("update");
  if (!role) throw new HttpError(404, "not_found", "Job not found.");
  if (role.status === "closed") throw new HttpError(409, "role_closed", ROLE_ACTION_BLOCKED.closed);
  if (role.status !== "draft") throw new HttpError(409, "already_published", "This job is already published.");
  const [company] = await tx.select({ slug: companies.slug }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  if (!company) throw new HttpError(404, "not_found", "Company not found.");
  const [version] = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version)).limit(1);
  if (!version) throw new HttpError(409, "not_ready", "This job has not been written yet.", { blockers: [{ code: "no_draft", message: "This job has not been written yet." }] satisfies PublishBlocker[] });
  await assertNoNewWork(tx, t.companyId, now);
  const room = await planRoom(tx, t.companyId, { newRoleId: role.id, now });
  if (!room.ok) throw limitReached(t, room);
  const { blockers } = await recordBlockers(tx, { role, packet: version.packet, now });
  if (blockers.length) throw new HttpError(409, "not_ready", `This job cannot be published yet. ${blockers.map((b) => b.message).join(" ")}`, { blockers });

  const at = now.toISOString();
  await tx.update(rolePackets).set({ status: "approved", approvedBy: t.userId, approvedAt: at }).where(eq(rolePackets.id, version.id));
  await tx.update(rolePackets).set({ status: "superseded" }).where(and(eq(rolePackets.roleId, role.id), ne(rolePackets.id, version.id), ne(rolePackets.status, "superseded")));
  await tx.update(roles).set({ status: "open", currentPacketVersion: version.version, title: version.packet.identity.title, openedAt: role.openedAt ?? at }).where(eq(roles.id, role.id));
  await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${version.version}` }, payload: { roleId: role.id, version: version.version } });
  await emit(tx, { type: "role.opened", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { packetVersion: version.version } });
  await settleClosingDate(tx, container, { role, packet: version.packet, actor, now });
  return { ok: true, roleId: role.id, version: version.version, urls: jobUrls(container.env, { slug: company.slug, roleId: role.id }) };
}

/** What publishing a job answered, read again from the job as it stands; null while it is still a draft. */
export async function publishResultOf(tx: Tx, container: Container, roleId: string): Promise<PublishResult | null> {
  const [role] = await tx.select({ id: roles.id, companyId: roles.companyId, status: roles.status, version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role || role.status === "draft" || role.version === null) return null;
  const [company] = await tx.select({ slug: companies.slug }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  if (!company) return null;
  return { ok: true, roleId: role.id, version: role.version, urls: jobUrls(container.env, { slug: company.slug, roleId: role.id }) };
}
