import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { RolePacket as RolePacketSchema, type Actor, type PacketFlag, type RolePacket } from "@ros/contracts";
import { payChanged } from "@ros/agents";
import { can, emit, guardPacket, isSoleOwner, markBoardsOutdated, notify, resolveDecisionMaker, resolvePolicy, unresolvedFlags } from "@ros/core";
import { approvalRequests, companies, rolePackets, roles, workflowRuns, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { refuseCompanyQuestions } from "./packet-fields";

/**
 * Packet versions and their approval (docs/spec/21 section 7, B2, B3, B9, B10, B13). Every edit is a new version;
 * nothing is overwritten. Whether the new version takes effect at once or waits for an approver depends on the role's
 * state and on who is editing:
 * - a pending role: the older approval and its workflow run are cancelled and a new run asks for approval of the new version;
 * - an open or paused role, edited by someone who may approve (their role is on the company's approver list): a wording
 *   change is approved and becomes current, after the preview the page shows first, and the named decision maker is told
 *   (not asked); a change to the pay, the title, the places or the eligibility questions follows the same approval as a
 *   new role (founder decision Q10 = B, plan D4), and a company's only owner confirms their own change; wording the
 *   fairness check flagged and the editor kept waits for a second approver, unless the editor is the company's only
 *   owner (founder decision L-01, 15 October 2026);
 * - an open or paused role, edited by someone who may not: the version is proposed and waits; the role keeps running on
 *   the old one. A paused role is treated like an open one, so an edit saved during a pause is never stranded: it is
 *   current at once or waits for an approver, and resuming the job publishes whatever is current then (Wave S5, row 12);
 * - a draft (sent back) role: the version is proposed; the person asks for approval again from the role page;
 * - a closed role: refused (409 `role_closed`), whichever route the edit came by.
 * Once a version of a running role becomes current, the boards posted by hand still show the old one (plan D4,
 * `markBoardsOutdated`): ITS gets an update task per board, or the team is told which boards to update.
 */

/** The plain refusal every route that writes a new version gives for a closed role. */
export const CLOSED_ROLE_MESSAGE = "This role is closed, so it is not changed any more. Start a new role to hire again.";

/** A role that runs: open, or paused (an edit made during a pause takes effect like one made while it is open). */
const RUNNING: readonly string[] = ["open", "paused"];
export type RoleRow = typeof roles.$inferSelect;
export type PacketRow = typeof rolePackets.$inferSelect;

export type NewVersionOutcome = "approved_current" | "proposed_pending_approval" | "proposed";

/** What an edit to a live job changes that needs the same approval as a new role (Q10 = B), in plain words. */
export type MaterialChange = "pay" | "title" | "location" | "eligibility";
export const MATERIAL_CHANGE_LABEL: Record<MaterialChange, string> = { pay: "the pay", title: "the job title", location: "where the job is", eligibility: "the eligibility questions" };

/** Deep equality that ignores key order (a stored packet's keys come back from the database in their own order). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));

/**
 * The changes between two packets that need approval when the job is live: anything in the pay (the range, the basis,
 * the currency, the private ceiling, the bonus and benefits text), the title, the places or the work model (a remote job
 * answers to other laws), and the eligibility questions. Wording elsewhere is not on the list.
 */
export function materialChanges(before: RolePacket, after: RolePacket): MaterialChange[] {
  const out: MaterialChange[] = [];
  const a = before.compensation;
  const b = after.compensation;
  if (a.basis !== b.basis || a.currency !== b.currency || a.min !== b.min || a.max !== b.max || a.ceiling !== b.ceiling || (a.mid ?? null) !== (b.mid ?? null) || (a.bonus ?? "") !== (b.bonus ?? "") || (a.benefitsSummary ?? "") !== (b.benefitsSummary ?? "") || a.discloseRange !== b.discloseRange) out.push("pay");
  if (before.identity.title.trim() !== after.identity.title.trim()) out.push("title");
  if (!same(before.identity.locations, after.identity.locations) || before.identity.remotePolicy !== after.identity.remotePolicy) out.push("location");
  if (!same(before.requirements.eligibility, after.requirements.eligibility)) out.push("eligibility");
  return out;
}

/** The version the role runs on: the current one when it has been opened, otherwise the newest. */
export function currentVersionOf(role: Pick<RoleRow, "currentPacketVersion">, versions: PacketRow[]): PacketRow | null {
  const newest = versions.slice().sort((a, b) => b.version - a.version);
  return newest.find((p) => p.version === (role.currentPacketVersion ?? newest[0]?.version)) ?? newest[0] ?? null;
}

/**
 * Cancels every pending packet approval on the role and the workflow run that was waiting on each one, and any
 * role_approval run on the role that has not reached its approval gate yet: the request row is only created by the
 * run's first step on a worker tick, so an edit that lands before that tick finds no request to cancel and would
 * otherwise leave two runs asking for approval of two versions. Cancelling is idempotent, so a run found both ways is
 * cancelled once.
 */
export async function cancelPendingPacketApprovals(tx: Tx, container: Container, input: { companyId: string; roleId: string; actor: Actor; reason: string }): Promise<number> {
  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, input.roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending")));
  // Stamped on the engine's clock, the one the approval's request and expiry are judged on.
  const decidedAt = container.engine.clock().toISOString();
  for (const p of pending) {
    await tx.update(approvalRequests).set({ status: "cancelled", decidedAt, decisionNote: input.reason }).where(eq(approvalRequests.id, p.id));
    await emit(tx, { type: "approval.cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, roleId: input.roleId, version: (p.proposal as { version?: number }).version ?? null, reason: input.reason }, correlationId: p.workflowRunId });
    if (p.workflowRunId) await container.engine.cancel(tx, p.workflowRunId, input.actor, input.reason);
  }
  const unfinished = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowKey, "role_approval"), inArray(workflowRuns.status, ["running", "waiting"]), sql`${workflowRuns.subject}->>'type' = 'role'`, sql`${workflowRuns.subject}->>'id' = ${input.roleId}`));
  for (const r of unfinished) await container.engine.cancel(tx, r.id, input.actor, input.reason);
  return pending.length;
}

/**
 * Starts a role_approval run for a version. The first request for a version keeps the key the intake route uses, so
 * the two never start the same run twice; a version sent again after a rejection gets a numbered key.
 */
export async function startPacketApproval(tx: Tx, container: Container, input: { companyId: string; role: RoleRow; version: number; actor: Actor; rationale: string; wasOpen: boolean }): Promise<{ runId: string }> {
  const earlier = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.roleId, input.role.id), eq(approvalRequests.actionType, "role_packet.approve")));
  const sameVersion = earlier.length; // any earlier request on the role makes the key unique enough; the count only grows
  const idempotencyKey = sameVersion === 0 ? `role_approval:${input.role.id}:${input.version}` : `role_approval:${input.role.id}:${input.version}:${sameVersion + 1}`;
  const { runId } = await container.engine.start(tx, {
    workflowKey: "role_approval",
    companyId: input.companyId,
    subject: { type: "role", id: input.role.id },
    state: { roleId: input.role.id, packetVersion: input.version, requestedBy: input.actor, rationale: input.rationale, wasOpen: input.wasOpen },
    idempotencyKey,
    actor: input.actor,
  });
  return { runId };
}

/**
 * The packet guard on every saved version (plan C1, packages/core/src/packet-guard.ts): jurisdictions and notices, pay on
 * the ad, the ceiling, the disclosure lines, six must-haves, nothing the owner was told could not be used, and flags for
 * wording that stands in for a protected trait. What the earlier version recorded as declined, and who kept which flag,
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
  if (!before || payChanged(before, incoming)) {
    incoming.provenance.payConfirmedBy = { by: input.actor, at: input.now ?? new Date().toISOString(), via: "edited" };
    incoming.provenance.payOrigin = "edited";
  } else {
    if (before.provenance.payConfirmedBy) incoming.provenance.payConfirmedBy = before.provenance.payConfirmedBy;
    if (before.provenance.payOrigin) incoming.provenance.payOrigin = before.provenance.payOrigin;
  }
  // The questions every applicant answers (Wave S7): one that asks about a protected characteristic is refused, whichever
  // route the version came by (the questions card, the full-packet editor), never saved with a flag to keep.
  refuseCompanyQuestions(incoming.companyQuestions);
  const guarded = guardPacket(incoming, { companyName: company?.name ?? "", companyLocations: company?.locations ?? [], declined: before?.provenance.declinedCriteria ?? [], previousFlags, actor: input.actor });
  const newlyKept = guarded.flags.filter((f) => f.kept && !previousFlags.some((p) => p.id === f.id && p.kept?.reason === f.kept?.reason));
  return { packet: RolePacketSchema.parse(guarded.packet), newlyKept, changes: guarded.changes };
}

export async function createPacketVersion(
  tx: Tx,
  container: Container,
  input: { tenant: Tenant; actor: Actor; role: RoleRow; packet: RolePacket; changeSummary: string; source?: "human_edit" | "playbook" | "import" | "agent_revision" },
): Promise<{ version: PacketRow; outcome: NewVersionOutcome; approvalRunId: string | null; guardChanges: string[]; needsApproval: NeedsApproval | null; boardsShowingOldVersion: string[]; paused?: true }> {
  const { tenant: t, actor, role } = input;
  // A closed role is never changed again, whichever route the edit came by (row 64).
  if (role.status === "closed") throw new HttpError(409, "role_closed", CLOSED_ROLE_MESSAGE);
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const next = (versions[0]?.version ?? 0) + 1;
  const running = RUNNING.includes(role.status);
  // Who may approve: the permission, and the company's approver list for this role (it can be narrowed, row 59).
  const editorMayApprove = await mayApproveRoles(tx, t, role.id);
  const now = container.engine.clock().toISOString();
  const { packet, newlyKept, changes: guardChanges } = await guardPacketVersion(tx, { companyId: t.companyId, actor, packet: input.packet, previous: versions[0] ?? null, now });
  // Q10 = B: on a live job, the pay, the title, the places and the eligibility questions need the same approval as a new role.
  const live = running ? currentVersionOf(role, versions) : null;
  const material = live ? materialChanges(live.packet, packet) : [];
  // L-01: wording the fairness check flagged and kept, which the version the job runs on did not already keep, needs a
  // second approver's yes before it goes public, unless the editor is the company's only owner (nobody else could say
  // yes). Measured against the live version, never the newest saved one: a flag kept in an earlier save still waiting
  // for approval (or kept on its approval card) does not go live by saving again with a small change (Wave S5 review).
  const liveKept = new Set((live?.packet.provenance.flags ?? []).filter((f) => f.kept).map((f) => `${f.id}|${f.kept?.reason ?? ""}`));
  const keptSinceLive = running ? (packet.provenance.flags ?? []).filter((f) => f.kept && !liveKept.has(`${f.id}|${f.kept.reason ?? ""}`)) : [];
  const keptByEditor = running && keptSinceLive.length > 0 && !(await isSoleOwner(tx, t.companyId, t.userId));
  // A version with a flag nobody has dealt with waits for approval even from an approver: the approval card shows it.
  const approvesNow = running && editorMayApprove && unresolvedFlags(packet).length === 0 && material.length === 0 && !keptByEditor;
  const [pv] = await tx
    .insert(rolePackets)
    .values({ companyId: t.companyId, roleId: role.id, version: next, packet, status: approvesNow ? "approved" : "proposed", source: input.source ?? "human_edit", changeSummary: input.changeSummary, createdBy: actor, approvedBy: approvesNow ? t.userId : null, approvedAt: approvesNow ? now : null })
    .returning();
  await emit(tx, { type: "role_packet.edited", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, changeSummary: input.changeSummary, takesEffect: approvesNow ? "now" : running ? "after_approval" : "with_the_role", openFlags: unresolvedFlags(packet).length } });
  for (const f of newlyKept) await emit(tx, { type: "packet.flag_kept", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { flagId: f.id, rule: f.rule, reason: f.kept?.reason ?? null } });
  const editorName = actor.name ?? "A team member";
  if (approvesNow) {
    // An approver's edit to a running role: current at once, and any version still waiting for approval is withdrawn.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `replaced by version ${next}` });
    for (const v of versions) if (v.status === "approved") await tx.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
    await tx.update(roles).set({ currentPacketVersion: next, title: input.packet.identity.title }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, via: "edit_while_open" } });
    const outdated = await markBoardsOutdated(tx, { companyId: t.companyId, roleId: role.id, previousVersion: role.currentPacketVersion, newVersion: next, actor, now: container.engine.clock() });
    await tellDecisionMaker(tx, { tenant: t, role, packet, version: next, editorName, changeSummary: input.changeSummary });
    // A paused job shows the version only when it resumes: `paused` lets the page say so instead of "live" (additive).
    return { version: pv, outcome: "approved_current", approvalRunId: null, guardChanges, needsApproval: null, boardsShowingOldVersion: outdated, ...(role.status === "paused" ? { paused: true as const } : {}) };
  }
  if (running || role.status === "pending_approval") {
    // Whoever was asked to approve the older version is no longer needed; the new version gets its own request.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `superseded by version ${next}` });
    if (role.status === "pending_approval") await tx.update(roles).set({ title: input.packet.identity.title }).where(eq(roles.id, role.id));
    const labels = material.map((m) => MATERIAL_CHANGE_LABEL[m]);
    const changed = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels.join("");
    const which = role.status === "paused" ? "paused" : "live";
    const keeps = `Until it is approved the job keeps running on version ${role.currentPacketVersion ?? "the approved one"}.`;
    const rationale = running
      ? material.length && editorMayApprove
        ? `${editorName} changed ${changed} of the ${which} job: ${input.changeSummary}. A change to the pay, the title, the place or the eligibility questions needs the same approval as a new role. ${keeps}`
        : keptByEditor
          ? `${editorName} changed the ${which} job: ${input.changeSummary}. It keeps wording the fairness check flagged; the reason for keeping it is on this card beside the words. Another approver decides. ${keeps}`
          : `${editorName} changed the details of the ${which} job: ${input.changeSummary}. Approve to make version ${next} current; until then the job keeps running on version ${role.currentPacketVersion ?? "the approved one"}.`
      : `${editorName} edited the job details: ${input.changeSummary}. Approve version ${next} to open the job and start posting.`;
    const { runId } = await startPacketApproval(tx, container, { companyId: t.companyId, role, version: next, actor, rationale, wasOpen: running });
    // The company's only owner approves their own change: the page offers "Confirm this change" at once (Q10).
    const needsApproval: NeedsApproval | null = material.length && editorMayApprove
      ? { changes: material, words: `This changes ${changed}, so it needs the same approval as a new role before it goes live.`, youMayConfirm: await isSoleOwner(tx, t.companyId, t.userId) }
      : keptByEditor && editorMayApprove
        ? { changes: [], words: "You kept wording the fairness check flagged, so another approver says yes before it goes live.", youMayConfirm: false }
        : null;
    return { version: pv, outcome: "proposed_pending_approval", approvalRunId: runId, guardChanges, needsApproval, boardsShowingOldVersion: [] };
  }
  // Draft (sent back): the version is kept; it is sent for approval again from the role page.
  return { version: pv, outcome: "proposed", approvalRunId: null, guardChanges, needsApproval: null, boardsShowingOldVersion: [] };
}

/**
 * Whether the person may approve this role's versions: they hold role.approve and their team role is on the approver
 * list the company (or this role) set for "role_packet.approve" (Settings > Hiring rules can narrow it).
 */
export async function mayApproveRoles(tx: Tx, t: Pick<Tenant, "companyId" | "role">, roleId: string): Promise<boolean> {
  if (!can(t.role, "role.approve")) return false;
  const policy = await resolvePolicy(tx, t.companyId, roleId, "role_packet.approve");
  return policy.approverRoles.includes(t.role);
}

/**
 * L-01: the named decision maker is told, not asked, when someone else's wording-only edit to the job went live at once.
 * Nothing waits for them; the notice says what changed and how to see it.
 */
async function tellDecisionMaker(tx: Tx, input: { tenant: Tenant; role: RoleRow; packet: RolePacket; version: number; editorName: string; changeSummary: string }): Promise<void> {
  const dm = await resolveDecisionMaker(tx, input.tenant.companyId, input.packet);
  if (!dm || dm.userId === input.tenant.userId) return;
  const paused = input.role.status === "paused";
  await notify(tx, {
    companyId: input.tenant.companyId,
    kind: "role.edited_live",
    title: `${input.packet.identity.title}: version ${input.version} is ${paused ? "current" : "live"}`,
    body: `${input.editorName} changed the wording of the job: ${input.changeSummary}. ${paused ? "It takes effect when the job resumes" : "It is live now"}. You are told because you are its decision maker; nothing waits for you.`,
    action: { label: "Open the job", href: `/roles/${input.role.id}?tab=activity` },
    userIds: [dm.userId],
  });
}

/**
 * Resuming a paused job (row 12): a version saved during the pause before Wave S5, when such edits were kept and nothing
 * else, would otherwise stay stranded behind the old one. The newest version newer than the current one that is still
 * proposed and has no approval waiting gets its approval request, like any edit to a running job; the job runs on the
 * current version until someone says yes. Returns the version sent for approval, if any.
 */
export async function settleVersionsSavedWhilePaused(tx: Tx, container: Container, input: { companyId: string; role: RoleRow; actor: Actor }): Promise<number | null> {
  const { role } = input;
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const stranded = versions.find((v) => v.status === "proposed" && v.version > (role.currentPacketVersion ?? 0));
  if (!stranded) return null;
  const [waiting] = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))).limit(1);
  if (waiting) return null;
  const by = stranded.createdBy.name ?? "A team member";
  const rationale = `${by} saved version ${stranded.version} while the job was paused${stranded.changeSummary ? `: ${stranded.changeSummary}` : ""}. Approve to make it current; until then the job runs on version ${role.currentPacketVersion ?? "the approved one"}.`;
  await startPacketApproval(tx, container, { companyId: input.companyId, role, version: stranded.version, actor: stranded.createdBy, rationale, wasOpen: true });
  return stranded.version;
}

/**
 * Why an approver's own edit to a live job waits (Q10 = B): which of the pay, the title, the place or the eligibility
 * questions changed, in a sentence, and whether the editor may confirm it themselves (a company's only owner).
 */
export type NeedsApproval = { changes: MaterialChange[]; words: string; youMayConfirm: boolean };
