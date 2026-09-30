import { Hono } from "hono";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { RequestRoleApproval, UpdateInterviewPlan } from "@ros/contracts";
import { assertCan, emit, membersWithCalendarStatus } from "@ros/core";
import { events, rolePackets, roles, withTenant } from "@ros/db";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { cancelPendingPacketApprovals, createPacketVersion, currentVersionOf, startPacketApproval } from "../services/packet-versions";

/**
 * The role page's Interview plan and Activity tabs, and "Request approval again" (docs/spec/21 section 7: B8, B9,
 * B11). Mounted under /api/v1/roles after the role routes, like the posting routes.
 */
export const rolePacketRoutes = new Hono<Vars>();
rolePacketRoutes.use("/:id/*", roleScopeGuard);

const TIMELINE_LIMIT = 200;

/** The team members a round can be assigned to, with their scheduling readiness (from the members list). */
async function interviewerViews(tx: Parameters<typeof membersWithCalendarStatus>[0], companyId: string) {
  const members = (await membersWithCalendarStatus(tx, companyId)).filter((m) => m.status === "active");
  return members.map((m) => ({ userId: m.userId, name: m.name ?? m.email, email: m.email, role: m.role, schedulable: m.schedulable }));
}

/** The plan with names: what the Interview plan tab shows and what the PATCH answers. */
function planView(packet: typeof rolePackets.$inferSelect, people: Array<{ userId: string; name: string; email: string; role: string; schedulable: boolean }>) {
  return {
    version: packet.version,
    status: packet.status,
    rounds: packet.packet.interviews.plan.map((r) => ({
      key: r.key,
      title: r.title,
      purpose: r.purpose,
      durationMinutes: r.durationMinutes,
      format: r.format,
      interviewerRoles: r.interviewerRoles,
      interviewers: r.interviewerUserIds.map((id) => people.find((p) => p.userId === id) ?? { userId: id, name: "Someone no longer on the team", email: "", role: "", schedulable: false }),
    })),
  };
}

rolePacketRoutes.get("/:id/interview-plan", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) return null;
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const current = currentVersionOf(role, packets);
    if (!current) return null;
    const people = await interviewerViews(tx, t.companyId);
    return { ...planView(current, people), team: people };
  });
  if (!row) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(row);
});

/**
 * Interviewers per round. A new packet version ("Interviewers assigned") that follows the same rules as any edit:
 * current at once when an approver changes an open role, otherwise waiting for approval or kept with the draft.
 */
rolePacketRoutes.patch("/:id/interview-plan", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = UpdateInterviewPlan.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const current = currentVersionOf(role, packets);
    if (!current) throw new HttpError(409, "no_packet", "This role has no packet yet.");
    const people = await interviewerViews(tx, t.companyId);
    const known = new Set(people.map((p) => p.userId));
    const plan = current.packet.interviews.plan;
    for (const r of body.rounds) {
      if (!plan.some((p) => p.key === r.key)) throw new HttpError(400, "unknown_round", `There is no interview round "${r.key}" in this packet.`);
      const stranger = r.interviewerUserIds.find((id) => !known.has(id));
      if (stranger) throw new HttpError(400, "unknown_member", "Every interviewer must be an active member of your team.");
    }
    const next = structuredClone(current.packet);
    next.interviews.plan = plan.map((p) => { const patch = body.rounds.find((r) => r.key === p.key); return patch ? { ...p, interviewerUserIds: [...new Set(patch.interviewerUserIds)] } : p; });
    const made = await createPacketVersion(tx, container, { tenant: t, actor: actorOf(c), role, packet: next, changeSummary: "Interviewers assigned" });
    return { ...planView(made.version, people), outcome: made.outcome, team: people };
  });
  await container.kick();
  return c.json(result);
});

/** "Request approval again" on a role that was sent back (or whose approval ran out of time): a new request and a new run. */
rolePacketRoutes.post("/:id/request-approval", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = RequestRoleApproval.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    if (role.status !== "draft") throw new HttpError(409, "not_a_draft", role.status === "pending_approval" ? "This role is already waiting for approval." : "Only a role that was sent back can be sent for approval again.");
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const version = body.version ? packets.find((p) => p.version === body.version) : packets[0];
    if (!version) throw new HttpError(404, "version_not_found", "That packet version does not exist.");
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: "asked again" });
    await tx.update(roles).set({ status: "pending_approval", title: version.packet.identity.title }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role_packet.proposed", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${version.version}` }, payload: { roleId: role.id, version: version.version, again: true } });
    const { runId } = await startPacketApproval(tx, container, { companyId: t.companyId, role, version: version.version, actor, rationale: `${actor.name ?? "A team member"} asked for approval again${version.changeSummary ? ` after: ${version.changeSummary}` : ""}. Approve version ${version.version} to open the role and start posting.`, wasOpen: false });
    return { ok: true, version: version.version, workflowRunId: runId };
  });
  await container.kick();
  return c.json(result, 201);
});

/**
 * The role's activity: every event about the role itself, its packet versions, or anything that names the role in its
 * payload (applications, approvals, postings), newest first. Described in plain words by the page.
 */
rolePacketRoutes.get("/:id/timeline", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "events.read");
  const roleId = c.req.param("id") ?? "";
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return null;
    return tx
      .select({ id: events.id, type: events.type, occurredAt: events.occurredAt, actor: events.actor, subjectType: events.subjectType, subjectId: events.subjectId, payload: events.payload })
      .from(events)
      .where(and(
        eq(events.companyId, t.companyId),
        or(
          and(eq(events.subjectType, "role"), eq(events.subjectId, role.id)),
          and(inArray(events.subjectType, ["role_packet"]), like(events.subjectId, `${role.id}:%`)),
          sql`${events.payload}->>'roleId' = ${role.id}`,
        ),
      ))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(TIMELINE_LIMIT);
  });
  if (!rows) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(rows);
});
