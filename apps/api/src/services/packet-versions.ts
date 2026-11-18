import { desc, eq } from "drizzle-orm";
import { ROLE_ACTION_BLOCKED, RolePacket as RolePacketSchema, appPaths, type Actor, type PacketFlag, type RolePacket } from "@ros/contracts";
import { emit, guardPacket, notify, openFlagsMessage, unresolvedFlags } from "@ros/core";
import { companies, rolePackets, roles, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { refuseFormQuestions } from "./packet-fields";
import { rewritePostsAfterEdit } from "./share";

/**
 * Versions of a job record. Every edit is a new version; nothing is overwritten.
 * - an open or paused job: the new version is live at once, stamped with who saved it. A save that carries wording the
 *   fairness guard flagged, which nobody reworded or kept with a reason, is refused (422 `packet_flags`), so a live job
 *   page never shows flagged wording nobody looked at. A paused job shows the version when it resumes. When what the job
 *   page says changed, the Share tab's posts nobody edited are written again (services/share.ts);
 * - a draft job: the version is saved, and goes live when the job is published (services/publish.ts);
 * - a closed job: refused (409 `role_closed`), whichever route the edit came by.
 */

/** A job that runs: open, or paused (an edit made during a pause takes effect like one made while it is open). */
const RUNNING: readonly string[] = ["open", "paused"];
export type RoleRow = typeof roles.$inferSelect;
export type PacketRow = typeof rolePackets.$inferSelect;

/** What a save did: `live` on an open or paused job, `saved` on a draft that is not published yet. */
export type NewVersionOutcome = "live" | "saved";

/** The version the job runs on: the current one when it has been opened, otherwise the newest. */
export function currentVersionOf(role: Pick<RoleRow, "currentPacketVersion">, versions: PacketRow[]): PacketRow | null {
  const newest = versions.slice().sort((a, b) => b.version - a.version);
  return newest.find((p) => p.version === (role.currentPacketVersion ?? newest[0]?.version)) ?? newest[0] ?? null;
}

/**
 * The fairness guard on every saved version (packages/core/src/packet-guard.ts): jurisdictions and notices, pay on the
 * ad, the disclosure lines, six must-haves, nothing the owner was told could not be used, and flags for wording that
 * stands in for a protected trait. What the earlier version recorded as declined, and who kept which flag,
 * carries over; a flag kept in this edit is stamped with the editor and recorded as an event.
 *
 * Who set the pay is the server's record, never the client's: whatever the incoming packet says about it is ignored. A
 * version whose pay differs from the one before is recorded as set by the person saving it, now; otherwise the earlier
 * record carries over. `changes` lists, in plain words, what the guard itself changed (a must-have it took out, say).
 */
export async function guardPacketVersion(tx: Tx, input: { companyId: string; actor: Actor; packet: RolePacket; previous: PacketRow | null; now?: string }): Promise<{ packet: RolePacket; newlyKept: PacketFlag[]; changes: string[] }> {
  const [company] = await tx.select({ name: companies.name, locations: companies.locations }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const previousFlags = input.previous?.packet.provenance.flags ?? [];
  const incoming = structuredClone(input.packet);
  delete incoming.provenance.payConfirmedBy;
  delete incoming.provenance.payOrigin;
  const before = input.previous?.packet ?? null;
  if (!before || before.compensation.basis !== incoming.compensation.basis || before.compensation.min !== incoming.compensation.min || before.compensation.max !== incoming.compensation.max) {
    incoming.provenance.payConfirmedBy = { by: input.actor, at: input.now ?? new Date().toISOString(), via: "edited" };
    incoming.provenance.payOrigin = "edited";
  } else {
    if (before.provenance.payConfirmedBy) incoming.provenance.payConfirmedBy = before.provenance.payConfirmedBy;
    if (before.provenance.payOrigin) incoming.provenance.payOrigin = before.provenance.payOrigin;
  }
  // A form question that asks about a protected characteristic is refused, never saved with a flag to keep.
  refuseFormQuestions(incoming.formQuestions);
  const guarded = guardPacket(incoming, { companyName: company?.name ?? "", companyLocations: company?.locations ?? [], declined: before?.provenance.declinedCriteria ?? [], previousFlags, actor: input.actor });
  const newlyKept = guarded.flags.filter((f) => f.kept && !previousFlags.some((p) => p.id === f.id && p.kept?.reason === f.kept?.reason));
  return { packet: RolePacketSchema.parse(guarded.packet), newlyKept, changes: guarded.changes };
}

export async function createPacketVersion(
  tx: Tx,
  container: Container,
  input: { tenant: Tenant; actor: Actor; role: RoleRow; packet: RolePacket; changeSummary: string },
): Promise<{ version: PacketRow; outcome: NewVersionOutcome; guardChanges: string[]; paused?: true }> {
  const { tenant: t, actor, role } = input;
  if (role.status === "closed") throw new HttpError(409, "role_closed", ROLE_ACTION_BLOCKED.closed);
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const next = (versions[0]?.version ?? 0) + 1;
  const running = RUNNING.includes(role.status);
  const now = container.engine.clock().toISOString();
  const { packet, newlyKept, changes: guardChanges } = await guardPacketVersion(tx, { companyId: t.companyId, actor, packet: input.packet, previous: versions[0] ?? null, now });
  const open = unresolvedFlags(packet);
  if (running && open.length) throw new HttpError(422, "packet_flags", openFlagsMessage(open.length), { flags: open });
  const [pv] = await tx
    .insert(rolePackets)
    .values({ companyId: t.companyId, roleId: role.id, version: next, packet, status: running ? "approved" : "proposed", source: "human_edit", changeSummary: input.changeSummary, createdBy: actor, approvedBy: running ? t.userId : null, approvedAt: running ? now : null })
    .returning();
  await emit(tx, { type: "role_packet.edited", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, changeSummary: input.changeSummary, takesEffect: running ? "now" : "with_the_role", openFlags: open.length } });
  for (const f of newlyKept) await emit(tx, { type: "packet.flag_kept", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { flagId: f.id, rule: f.rule, reason: f.kept?.reason ?? null } });
  if (!running) {
    await tx.update(roles).set({ title: packet.identity.title }).where(eq(roles.id, role.id));
    return { version: pv, outcome: "saved", guardChanges };
  }
  for (const v of versions) if (v.status === "approved") await tx.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
  await tx.update(roles).set({ currentPacketVersion: next, title: packet.identity.title }).where(eq(roles.id, role.id));
  await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, via: "edit_while_open" } });
  await tellJobStarter(tx, { tenant: t, role, title: packet.identity.title, version: next, editorName: actor.name ?? "A team member", changeSummary: input.changeSummary });
  // When what the job page says changed, the posts nobody edited are written again in the background.
  await rewritePostsAfterEdit(tx, container.engine, { role, before: versions[0]?.packet, after: packet });
  // A paused job shows the version only when it resumes: `paused` lets the page say so instead of "live".
  return { version: pv, outcome: "live", guardChanges, ...(role.status === "paused" ? { paused: true as const } : {}) };
}

/**
 * The person who started a job is told, not asked, when a teammate's change to it went live. Nothing waits for them; the
 * notice says what changed and how to see it.
 */
async function tellJobStarter(tx: Tx, input: { tenant: Tenant; role: RoleRow; title: string; version: number; editorName: string; changeSummary: string }): Promise<void> {
  const starter = input.role.createdBy.kind === "user" ? input.role.createdBy.id : null;
  if (!starter || starter === input.tenant.userId) return;
  const paused = input.role.status === "paused";
  await notify(tx, {
    companyId: input.tenant.companyId,
    kind: "role.edited_live",
    title: `${input.title}: version ${input.version} is ${paused ? "current" : "live"}`,
    body: `${input.editorName} changed the job: ${input.changeSummary}. ${paused ? "It takes effect when the job resumes" : "It is live now"}. You are told because you started this job; nothing waits for you.`,
    action: { label: "Open the job", href: appPaths.job(input.role.id) },
    userIds: [starter],
  });
}
