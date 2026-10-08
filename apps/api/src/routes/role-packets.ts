import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { ZodError } from "zod";
import {
  ApplyRequirementFixes, DraftRolePacket as DraftRolePacketSchema, KeepPacketFlag, PacketFieldEdit, PacketRevisionRequest, RequestRoleApproval, RolePacket as RolePacketSchema, UpdateInterviewPlan,
  type Actor, type DeclinedCriterion, type DraftRolePacket, type Location, type PacketFlag, type PacketRevisionProposal, type RequirementsCheck, type RolePacket,
} from "@ros/contracts";
import {
  IntakeSessionError, RequirementFixError, applyRequirementFixes, checkRequirements, decideRevision, loadRevision, loadTeam, mergeRevision, packetFingerprint, payChanged, proposeRevision, sessionView, storeDraftPacket,
  type IntakeSessionRow, type MergedRevision, type StoredRevision,
} from "@ros/agents";
import { assertCan, can, emit, guardPacket, membersWithCalendarStatus, normalizeFacts, unresolvedFlags } from "@ros/core";
import { companies, events, intakeSessions, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Tenant, type Vars } from "../middleware/session";
import { jobPreview } from "../services/job-preview";
import { diffPackets } from "../services/packet-diff";
import { applyFieldEdit } from "../services/packet-fields";
import { cancelPendingPacketApprovals, createPacketVersion, currentVersionOf, startPacketApproval, type PacketRow, type RoleRow } from "../services/packet-versions";
import type { Container } from "../container";
import { loadDraft } from "./intake";

/**
 * The role page's Interview plan and Activity tabs, and "Request approval again" (docs/spec/21 section 7: B8, B9,
 * B11), and the job builder's packet tools (plan Wave C): change by chat (C10), the version diff, the requirements check
 * (C16), the plain-field editor (C11) and the candidate-view preview (C9). Mounted under /api/v1/roles after the role
 * routes, like the posting routes; the same tools for a draft before the role exists are `draftPacketRoutes`, mounted
 * under /api/v1/intake.
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
    return { ...planView(made.version, people), outcome: made.outcome, team: people, guardChanges: made.guardChanges };
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

/* ------------------------------------------------------------------------------------------------------------------ */
/* The job builder's packet tools (plan Wave C)                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The role, its versions newest first, and the company's name and places (for the packet guard). A write locks the role
 * row first, so two saves at once take turns: the second finds the first one's version and is refused as out of date
 * instead of colliding with it on the same version number.
 */
async function loadRolePackets(tx: Tx, roleId: string, opts: { forWrite?: boolean } = {}): Promise<{ role: RoleRow; versions: PacketRow[]; company: { name: string; locations: Location[] } }> {
  const [role] = opts.forWrite ? await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1).for("update") : await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw new HttpError(404, "not_found", "Role not found.");
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  if (!versions.length) throw new HttpError(409, "no_packet", "This role has no packet yet.");
  const [company] = await tx.select({ name: companies.name, locations: companies.locations }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  return { role, versions, company: { name: company?.name ?? "", locations: company?.locations ?? [] } };
}

function refuseClosed(role: RoleRow): void {
  if (role.status === "closed") throw new HttpError(409, "role_closed", "This role is closed, so it is not changed any more. Start a new role to hire again.");
}

/** A plain sentence for the first limit a changed packet breaks. */
function plainProblem(err: ZodError): string {
  const path = err.issues[0]?.path.join(".") ?? "";
  if (path.startsWith("screening.questions")) return "A role needs between three and twelve screening questions.";
  if (path.startsWith("requirements.mustHaves")) return "A role needs between one and six must-haves.";
  if (path.startsWith("competencies")) return "A role looks for between three and eight things in candidates.";
  if (path.startsWith("interviews.plan")) return "A role has between one and five interview steps.";
  if (path.startsWith("description")) return "The job description would be too short.";
  if (path.startsWith("compensation")) return "The pay would not be complete.";
  return "The change would leave the job incomplete.";
}

type Guarded = { ok: true; packet: DraftRolePacket; flags: PacketFlag[]; newFlags: PacketFlag[]; changes: string[] } | { ok: false; problem: string };

/**
 * The changed packet as it would be saved: through the packet guard (the rules `createPacketVersion` and a draft's save
 * both apply), then the packet's schema. Returns the wording checks it would carry, and which of them are new.
 */
function guardedChange(base: DraftRolePacket, next: DraftRolePacket, ctx: { company: { name: string; locations: Location[] }; actor: Actor; declined: DeclinedCriterion[]; full: boolean }): Guarded {
  const guarded = guardPacket(next, { companyName: ctx.company.name, companyLocations: ctx.company.locations, declined: ctx.declined, previousFlags: base.provenance.flags ?? [], actor: ctx.actor });
  const parsed = ctx.full ? RolePacketSchema.safeParse(guarded.packet) : DraftRolePacketSchema.safeParse(guarded.packet);
  if (!parsed.success) return { ok: false, problem: plainProblem(parsed.error) };
  const flags = unresolvedFlags(parsed.data);
  const before = new Set((base.provenance.flags ?? []).map((f) => f.id));
  return { ok: true, packet: parsed.data, flags, newFlags: flags.filter((f) => !before.has(f.id)), changes: guarded.changes };
}

/** What confirming a change does to a role, by the same rule as `createPacketVersion`. */
function takesEffect(role: RoleRow, t: Tenant, openFlags: number): PacketRevisionProposal["takesEffect"] {
  if (role.status === "open" && can(t.role, "role.approve") && openFlags === 0) return "now";
  return role.status === "open" || role.status === "pending_approval" ? "after_approval" : "with_the_role";
}

const AI_FAILED = "The assistant could not work out that change. Nothing was changed. Try again, or make the change in the editor.";

/** A failed model call is recorded as an event on what it was about, then answered plainly; nothing was changed. */
async function revisionFailed(container: Container, companyId: string, subject: { type: "role" | "intake_session"; id: string }, out: { runId: string; reason: string; error: string }): Promise<never> {
  await withTenant(container.db, companyId, (tx) => emit(tx, { type: "ai.run_failed", companyId, actor: { kind: "agent", id: "intake", runId: out.runId }, subject, payload: { task: "packet.revise", reason: out.reason, error: out.error } }));
  throw new HttpError(502, "ai_failed", AI_FAILED, { aiRunId: out.runId });
}

/** A proposal whose merged packet breaks a limit is set aside on the run and answered plainly; nothing was changed. */
async function revisionInvalid(container: Container, companyId: string, subject: { type: "role" | "intake_session"; id: string }, runId: string, problem: string): Promise<never> {
  await withTenant(container.db, companyId, async (tx) => {
    await decideRevision(tx, runId, { decision: "discarded", at: container.engine.clock().toISOString(), by: { kind: "system", id: "packet_guard" } });
    await emit(tx, { type: "ai.output_invalid", companyId, actor: { kind: "agent", id: "intake", runId }, subject, payload: { task: "packet.revise", problem } });
  });
  throw new HttpError(422, "revision_invalid", `That change could not be made as written: ${problem} Nothing was changed. Try asking another way.`, { aiRunId: runId });
}

function proposalOf(input: { runId: string; target: PacketRevisionProposal["target"]; base: DraftRolePacket; merged: MergedRevision<DraftRolePacket>; guarded: Extract<Guarded, { ok: true }>; question: string | undefined; summary: string; takesEffect: PacketRevisionProposal["takesEffect"]; from: number | null }): PacketRevisionProposal {
  return {
    revisionId: input.runId,
    target: input.target,
    summary: input.summary,
    question: input.question ?? null,
    notChanged: input.merged.notChanged,
    sections: input.merged.sections,
    diff: diffPackets(input.base, input.guarded.packet, { from: input.from }),
    flags: input.guarded.flags,
    newFlags: input.guarded.newFlags,
    guardChanges: input.guarded.changes,
    takesEffect: input.takesEffect,
    packet: input.guarded.packet,
  };
}

/** The stored proposal for this role or draft, still undecided, or a plain refusal. */
function usableRevision(stored: StoredRevision | null, match: (s: StoredRevision) => boolean): StoredRevision {
  if (!stored || !match(stored)) throw new HttpError(404, "revision_not_found", "That suggested change is not on this job.");
  if (stored.decided) throw new HttpError(409, "already_decided", stored.decided.decision === "applied" ? "This change was already saved." : "This change was set aside. Ask again if you still want it.");
  return stored;
}

/**
 * Change by chat (C10): the person's request goes to the assistant, which proposes the sections that change. Nothing is
 * saved: the answer shows the change field by field, the wording checks it would carry and what confirming does, and
 * POST /:id/revisions/:revisionId/apply saves exactly that. The model is called with no transaction open.
 */
rolePacketRoutes.post("/:id/revisions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  assertCan(t.role, "compensation.read");
  const body = PacketRevisionRequest.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const loaded = await withTenant(container.db, t.companyId, (tx) => loadRolePackets(tx, c.req.param("id") ?? ""));
  refuseClosed(loaded.role);
  const base = loaded.versions[0];
  const subject = { type: "role" as const, id: loaded.role.id };
  const declined = base.packet.provenance.declinedCriteria ?? [];
  const out = await proposeRevision(container.db, container.ai, { companyId: t.companyId, companyName: loaded.company.name, actor, target: { kind: "role", roleId: loaded.role.id, baseVersion: base.version, roleStatus: loaded.role.status }, packet: base.packet, message: body.message, declined });
  if (!out.ok) return revisionFailed(container, t.companyId, subject, out);
  const merged = mergeRevision<DraftRolePacket>(base.packet, out.output, "role");
  const guarded = guardedChange(base.packet, merged.packet, { company: loaded.company, actor, declined, full: true });
  if (!guarded.ok) return revisionInvalid(container, t.companyId, subject, out.runId, guarded.problem);
  const proposal = proposalOf({ runId: out.runId, target: { kind: "role", roleId: loaded.role.id, baseVersion: base.version }, base: base.packet, merged, guarded, question: out.output.question, summary: out.output.summary, takesEffect: takesEffect(loaded.role, t, guarded.flags.length), from: base.version });
  await withTenant(container.db, t.companyId, (tx) => emit(tx, { type: "packet.revision_proposed", companyId: t.companyId, actor, subject, payload: { roleId: loaded.role.id, baseVersion: base.version, revisionId: out.runId, sections: merged.sections, notChanged: merged.notChanged.length, asked: !!out.output.question, newFlags: guarded.newFlags.length } }));
  return c.json(proposal);
});

/**
 * Confirms a change by chat: the proposal stored on its run is laid over the version it was worked out on (refused when
 * the role has moved on since), then saved like any edit (`createPacketVersion`, source `agent_revision`), under the
 * person who confirmed it. A change of pay is recorded as set by them.
 */
rolePacketRoutes.post("/:id/revisions/:revisionId/apply", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  assertCan(t.role, "compensation.read");
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions, company } = await loadRolePackets(tx, c.req.param("id") ?? "", { forWrite: true });
    refuseClosed(role);
    const stored = usableRevision(await loadRevision(tx, c.req.param("revisionId") ?? ""), (s) => s.target === "role" && s.roleId === role.id);
    const base = versions[0];
    if (stored.baseVersion !== base.version) throw new HttpError(409, "stale_revision", `The role changed after this was suggested (it is on version ${base.version} now). Ask again, so the change is worked out on the latest version.`);
    const merged = mergeRevision<RolePacket>(base.packet, stored.revision, "role");
    if (!merged.sections.length) throw new HttpError(409, "nothing_to_apply", "There is nothing to save in this suggestion.");
    const packet = merged.packet;
    const now = container.engine.clock().toISOString();
    packet.provenance.aiRunIds = [...new Set([...(packet.provenance.aiRunIds ?? []), stored.runId])];
    if (payChanged(base.packet, packet)) {
      packet.provenance.payConfirmedBy = { by: actor, at: now, via: "edited" };
      packet.provenance.payOrigin = "edited";
    }
    const checked = guardedChange(base.packet, packet, { company, actor, declined: base.packet.provenance.declinedCriteria ?? [], full: true });
    if (!checked.ok) throw new HttpError(422, "revision_invalid", `That change could not be made as written: ${checked.problem} Nothing was changed.`);
    if (!(await decideRevision(tx, stored.runId, { decision: "applied", at: now, by: actor, version: base.version + 1 }))) throw new HttpError(409, "already_decided", "This change was already saved.");
    const made = await createPacketVersion(tx, container, { tenant: t, actor, role, packet, changeSummary: `Changed by chat: ${stored.revision.summary}`.slice(0, 500), source: "agent_revision" });
    await emit(tx, { type: "packet.revision_applied", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${made.version.version}` }, payload: { roleId: role.id, version: made.version.version, baseVersion: base.version, revisionId: stored.runId, sections: merged.sections } });
    return { ...made.version, outcome: made.outcome, approvalRunId: made.approvalRunId, guardChanges: made.guardChanges, sections: merged.sections, diff: diffPackets(base.packet, made.version.packet, { from: base.version, to: made.version.version }) };
  });
  await container.kick();
  return c.json(result, 201);
});

/** "Not this": the proposal is set aside on its run, so it can never be saved later; nothing else changes. */
rolePacketRoutes.post("/:id/revisions/:revisionId/discard", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const container = c.get("container");
  const actor = actorOf(c);
  await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, c.req.param("id") ?? "")).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const stored = usableRevision(await loadRevision(tx, c.req.param("revisionId") ?? ""), (s) => s.target === "role" && s.roleId === role.id);
    if (await decideRevision(tx, stored.runId, { decision: "discarded", at: container.engine.clock().toISOString(), by: actor })) await emit(tx, { type: "packet.revision_discarded", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { roleId: role.id, revisionId: stored.runId } });
  });
  return c.json({ ok: true });
});

/**
 * What changed between two versions of the role (C10), field by field. `to` defaults to the newest version and `from`
 * to the one before it. Without compensation.read the pay section is left out, like GET /:id/packets.
 */
rolePacketRoutes.get("/:id/packets/diff", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const num = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) ? Number(v) : null);
  const askedTo = num(c.req.query("to"));
  const askedFrom = num(c.req.query("from"));
  const { versions } = await withTenant(c.get("container").db, t.companyId, (tx) => loadRolePackets(tx, c.req.param("id") ?? ""));
  const to = askedTo === null ? versions[0] : versions.find((v) => v.version === askedTo);
  if (!to) throw new HttpError(404, "version_not_found", "That version does not exist.");
  const from = askedFrom === null ? versions.find((v) => v.version < to.version) ?? null : versions.find((v) => v.version === askedFrom);
  if (from === undefined) throw new HttpError(404, "version_not_found", "That version does not exist.");
  return c.json(diffPackets(from?.packet ?? null, to.packet, { from: from?.version ?? null, to: to.version, includePay: can(t.role, "compensation.read") }));
});

/**
 * The candidate's view of a version before it is public (C9; Wave D's authenticated preview page reads the same): the
 * newest version unless `?version=N`. Pay is on the page, so this needs compensation.read, like the packet itself.
 */
rolePacketRoutes.get("/:id/preview", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  assertCan(t.role, "compensation.read");
  const container = c.get("container");
  const asked = c.req.query("version");
  const out = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions } = await loadRolePackets(tx, c.req.param("id") ?? "");
    const pv = asked ? versions.find((v) => String(v.version) === asked) : versions[0];
    if (!pv) throw new HttpError(404, "version_not_found", "That version does not exist.");
    const [company] = await tx.select({ name: companies.name, slug: companies.slug, locations: companies.locations, settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const current = currentVersionOf(role, versions);
    return jobPreview({ packet: pv.packet, company, source: { kind: "version", roleId: role.id, version: pv.version, status: pv.status, current: current?.version === pv.version && !!role.currentPacketVersion, roleStatus: role.status }, smsEnabled: container.env.SMS_ENABLED });
  });
  return c.json(out);
});

/**
 * The requirements check (C16) on the newest version unless `?version=N`: suggestions with one-tap fixes, never a score.
 * Nothing changes until POST /:id/requirements-check/apply with the fixes a person tapped.
 */
rolePacketRoutes.get("/:id/requirements-check", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const asked = c.req.query("version");
  const { versions } = await withTenant(c.get("container").db, t.companyId, (tx) => loadRolePackets(tx, c.req.param("id") ?? ""));
  const pv = asked ? versions.find((v) => String(v.version) === asked) : versions[0];
  if (!pv) throw new HttpError(404, "version_not_found", "That version does not exist.");
  return c.json(checkRequirements(pv.packet, `v${pv.version}`, pv.version) satisfies RequirementsCheck);
});

function fixErrors(err: unknown): never {
  if (err instanceof RequirementFixError) throw new HttpError(err.code === "unknown_fix" ? 409 : 400, err.code, err.message);
  throw err;
}

/** Applies the tapped fixes to the version the check ran on, as a new version under the person who tapped them. */
rolePacketRoutes.post("/:id/requirements-check/apply", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = ApplyRequirementFixes.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions } = await loadRolePackets(tx, c.req.param("id") ?? "", { forWrite: true });
    refuseClosed(role);
    const base = versions[0];
    if (body.base !== `v${base.version}`) throw new HttpError(409, "stale_check", "The role changed after the check ran. Run the check again.");
    let fixed: ReturnType<typeof applyRequirementFixes<RolePacket>>;
    try {
      fixed = applyRequirementFixes(base.packet, body.fixIds);
    } catch (err) {
      return fixErrors(err);
    }
    const made = await createPacketVersion(tx, container, { tenant: t, actor, role, packet: fixed.packet, changeSummary: `Requirements check: ${fixed.applied.join(" ")}`.slice(0, 500) });
    await emit(tx, { type: "packet.check_applied", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${made.version.version}` }, payload: { roleId: role.id, version: made.version.version, applied: fixed.applied.length, skipped: fixed.skipped.length } });
    return { ...made.version, outcome: made.outcome, approvalRunId: made.approvalRunId, guardChanges: made.guardChanges, applied: fixed.applied, skipped: fixed.skipped, diff: diffPackets(base.packet, made.version.packet, { from: base.version, to: made.version.version }), check: checkRequirements(made.version.packet, `v${made.version.version}`, made.version.version) };
  });
  await container.kick();
  return c.json(result, 201);
});

/**
 * Keeps a flagged phrase in a version waiting for approval (C1), with the person's reason, from the role page's approval
 * card. The flag on that same version is stamped with who kept it, why and when; nothing else in the version changes, so
 * the approval already asked for stands and the approver reads the reason beside the phrase. Only a version not yet
 * approved: an approved version never has an open flag. Recorded as an event like every keep.
 */
rolePacketRoutes.post("/:id/packets/:version/flags/keep", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = KeepPacketFlag.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const out = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions } = await loadRolePackets(tx, c.req.param("id") ?? "", { forWrite: true });
    refuseClosed(role);
    const pv = versions.find((v) => String(v.version) === c.req.param("version"));
    if (!pv) throw new HttpError(404, "version_not_found", "That version does not exist.");
    if (pv.status !== "proposed") throw new HttpError(409, "not_waiting", "Only a version waiting for approval has wording left to decide on.");
    const flag = (pv.packet.provenance.flags ?? []).find((f) => f.id === body.flagId);
    if (!flag) throw new HttpError(404, "flag_not_found", "That check is no longer on this version.");
    if (flag.kept) throw new HttpError(409, "already_kept", "That wording was already kept, with a reason.");
    const packet = structuredClone(pv.packet);
    const kept = { reason: body.reason, by: actor, at: container.engine.clock().toISOString() };
    packet.provenance.flags = (packet.provenance.flags ?? []).map((f) => (f.id === flag.id ? { ...f, kept } : f));
    await tx.update(rolePackets).set({ packet }).where(eq(rolePackets.id, pv.id));
    await emit(tx, { type: "packet.flag_kept", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${pv.version}` }, payload: { roleId: role.id, version: pv.version, flagId: flag.id, rule: flag.rule, reason: body.reason } });
    return { version: pv.version, flags: packet.provenance.flags, openFlags: unresolvedFlags(packet).length };
  });
  return c.json(out);
});

/**
 * The plain-field editor (C11): title, places, job type, schedule, work model, pay (basis, range, private ceiling), the
 * screening questions (3 to 12, added, removed and reordered as one list), the eligibility questions (from the allowed
 * kinds only), deal-breakers, the decision maker (a team member who may approve) and the message tone. Starts from
 * `baseVersion`, which must still be the newest, and saves a new version like any edit.
 */
rolePacketRoutes.patch("/:id/packet", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = PacketFieldEdit.parse(await c.req.json());
  if (body.compensation) assertCan(t.role, "compensation.read");
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions } = await loadRolePackets(tx, c.req.param("id") ?? "", { forWrite: true });
    refuseClosed(role);
    const base = versions[0];
    if (body.baseVersion !== base.version) throw new HttpError(409, "stale_version", `Someone saved a newer version of this role (version ${base.version}) since you opened it. Reload to see it, then make your change again.`);
    const team = body.decisionMakerUserId ? await loadTeam(tx, t.companyId) : [];
    const edit = applyFieldEdit(base.packet, body, { team, actor, now: container.engine.clock().toISOString() });
    if (!edit.fields.length) throw new HttpError(400, "nothing_changed", "Nothing was changed.");
    const made = await createPacketVersion(tx, container, { tenant: t, actor, role, packet: edit.packet, changeSummary: body.changeSummary ?? edit.summary });
    return { ...made.version, outcome: made.outcome, approvalRunId: made.approvalRunId, guardChanges: made.guardChanges, fields: edit.fields, notes: edit.notes, diff: diffPackets(base.packet, made.version.packet, { from: base.version, to: made.version.version }) };
  });
  await container.kick();
  return c.json(result);
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The same tools for a draft before the role exists (mounted under /api/v1/intake)                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export const draftPacketRoutes = new Hono<Vars>();

/** The agent's draft errors as answers; `stale` is how this route says the draft moved on since the change was worked out. */
function draftErrors(err: unknown, stale?: HttpError): never {
  if (err instanceof IntakeSessionError && err.code === "stale_draft" && stale) throw stale;
  if (err instanceof IntakeSessionError) throw err.code === "not_found" ? new HttpError(404, "not_found", "Intake session not found.") : err.code === "stale_draft" ? new HttpError(409, "stale_draft", "The draft changed a moment ago. Look at it again, then make your change.") : new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside.");
  throw err;
}

const STALE_REVISION = () => new HttpError(409, "stale_revision", "The draft changed after this was suggested. Ask again, so the change is worked out on the draft as it is now.");
const STALE_CHECK = () => new HttpError(409, "stale_check", "The draft changed after the check ran. Run the check again.");

/** The caller's draft (the intake routes' own access rule), active and with a draft packet written. */
async function draftOf(c: Context<Vars>): Promise<{ row: IntakeSessionRow; draft: DraftRolePacket }> {
  const row = await loadDraft(c, c.req.param("id") ?? "");
  if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside.");
  if (!row.draftPacket) throw new HttpError(409, "no_draft", "Write the draft first; then you can preview it, check it and change it.");
  return { row, draft: row.draftPacket };
}

async function companyOf(container: Container, companyId: string) {
  const [company] = await withTenant(container.db, companyId, (tx) => tx.select({ name: companies.name, slug: companies.slug, locations: companies.locations, settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1));
  return company;
}

/** Everything the owner was told could not be used: the conversation's record and the draft's own. */
const draftDeclined = (row: IntakeSessionRow, draft: DraftRolePacket): DeclinedCriterion[] => [...normalizeFacts(row.facts).declinedCriteria, ...(draft.provenance.declinedCriteria ?? [])];

async function reloadSession(container: Container, companyId: string, sessionId: string, viewer: string) {
  const [row] = await withTenant(container.db, companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1));
  return row ? sessionView(row, viewer) : null;
}

/** Change the draft by chat (C10): the same proposal as for a role, worked out on the draft as it is now. Pay stays on the pay card. */
draftPacketRoutes.post("/sessions/:id/revisions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const { row, draft } = await draftOf(c);
  const body = PacketRevisionRequest.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const company = await companyOf(container, t.companyId);
  const subject = { type: "intake_session" as const, id: row.id };
  const declined = draftDeclined(row, draft);
  const out = await proposeRevision(container.db, container.ai, { companyId: t.companyId, companyName: company?.name ?? "", actor, target: { kind: "draft", sessionId: row.id, baseHash: packetFingerprint(draft) }, packet: draft, message: body.message, declined });
  if (!out.ok) return revisionFailed(container, t.companyId, subject, out);
  const merged = mergeRevision(draft, out.output, "draft");
  const guarded = guardedChange(draft, merged.packet, { company: { name: company?.name ?? "", locations: company?.locations ?? [] }, actor, declined, full: false });
  if (!guarded.ok) return revisionInvalid(container, t.companyId, subject, out.runId, guarded.problem);
  const proposal = proposalOf({ runId: out.runId, target: { kind: "draft", sessionId: row.id }, base: draft, merged, guarded, question: out.output.question, summary: out.output.summary, takesEffect: "draft", from: null });
  await withTenant(container.db, t.companyId, (tx) => emit(tx, { type: "packet.revision_proposed", companyId: t.companyId, actor, subject, payload: { revisionId: out.runId, sections: merged.sections, notChanged: merged.notChanged.length, asked: !!out.output.question, newFlags: guarded.newFlags.length } }));
  return c.json(proposal);
});

/**
 * Confirms a change by chat on a draft: refused when the draft was rewritten or changed since; otherwise saved through
 * the same path as every draft write (the packet guard, pay only as confirmed). The check that the draft is still the
 * one the change was worked out on, the save, the proposal's outcome and the event all happen in one transaction, with
 * the draft's row locked, so two confirmations (or a confirmation and a fix) never overwrite each other. Answers with the
 * session as the page reads it.
 */
draftPacketRoutes.post("/sessions/:id/revisions/:revisionId/apply", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const { row, draft } = await draftOf(c);
  const container = c.get("container");
  const actor = actorOf(c);
  const stored = await withTenant(container.db, t.companyId, async (tx) => usableRevision(await loadRevision(tx, c.req.param("revisionId") ?? ""), (s) => s.target === "draft" && s.sessionId === row.id));
  if (stored.baseHash !== packetFingerprint(draft)) throw STALE_REVISION();
  const merged = mergeRevision(draft, stored.revision, "draft");
  if (!merged.sections.length) throw new HttpError(409, "nothing_to_apply", "There is nothing to save in this suggestion.");
  merged.packet.provenance.aiRunIds = [...new Set([...(merged.packet.provenance.aiRunIds ?? []), stored.runId])];
  let saved: DraftRolePacket;
  try {
    saved = await storeDraftPacket(container.db, { companyId: t.companyId, sessionId: row.id, actor, draft: merged.packet, expectedHash: stored.baseHash ?? "" }, {
      onSaved: async (tx) => {
        if (!(await decideRevision(tx, stored.runId, { decision: "applied", at: container.engine.clock().toISOString(), by: actor }))) throw new HttpError(409, "already_decided", "This change was already saved.");
        await emit(tx, { type: "packet.revision_applied", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { revisionId: stored.runId, sections: merged.sections } });
      },
    });
  } catch (err) {
    return draftErrors(err, STALE_REVISION());
  }
  return c.json({ session: await reloadSession(container, t.companyId, row.id, t.userId), draft: saved, sections: merged.sections, diff: diffPackets(draft, saved) }, 201);
});

draftPacketRoutes.post("/sessions/:id/revisions/:revisionId/discard", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id") ?? "");
  const container = c.get("container");
  const actor = actorOf(c);
  await withTenant(container.db, t.companyId, async (tx) => {
    const stored = usableRevision(await loadRevision(tx, c.req.param("revisionId") ?? ""), (s) => s.target === "draft" && s.sessionId === row.id);
    if (await decideRevision(tx, stored.runId, { decision: "discarded", at: container.engine.clock().toISOString(), by: actor })) await emit(tx, { type: "packet.revision_discarded", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { revisionId: stored.runId } });
  });
  return c.json({ ok: true });
});

/** The candidate's view of the draft (C9): the job page and the apply form's questions as they would read, with what is still missing. */
draftPacketRoutes.get("/sessions/:id/preview", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const { row, draft } = await draftOf(c);
  const container = c.get("container");
  const company = await companyOf(container, t.companyId);
  if (!company) throw new HttpError(404, "not_found", "Company not found.");
  return c.json(jobPreview({ packet: draft, company, source: { kind: "draft", sessionId: row.id }, smsEnabled: container.env.SMS_ENABLED }));
});

/** The requirements check (C16) on the draft as it is now; the fixes apply only to this same draft. */
draftPacketRoutes.get("/sessions/:id/requirements-check", requireTenant, async (c) => {
  const { draft } = await draftOf(c);
  return c.json(checkRequirements(draft, `d${packetFingerprint(draft)}`) satisfies RequirementsCheck);
});

draftPacketRoutes.post("/sessions/:id/requirements-check/apply", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const { row, draft } = await draftOf(c);
  const body = ApplyRequirementFixes.parse(await c.req.json());
  if (body.base !== `d${packetFingerprint(draft)}`) throw STALE_CHECK();
  const container = c.get("container");
  const actor = actorOf(c);
  let fixed: ReturnType<typeof applyRequirementFixes<DraftRolePacket>>;
  try {
    fixed = applyRequirementFixes(draft, body.fixIds);
  } catch (err) {
    return fixErrors(err);
  }
  let saved: DraftRolePacket;
  try {
    // Saved only onto the draft the check ran on (its row locked), with the event in the same transaction.
    saved = await storeDraftPacket(container.db, { companyId: t.companyId, sessionId: row.id, actor, draft: fixed.packet, expectedHash: packetFingerprint(draft) }, {
      onSaved: (tx) => emit(tx, { type: "packet.check_applied", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { applied: fixed.applied.length, skipped: fixed.skipped.length } }).then(() => undefined),
    });
  } catch (err) {
    return draftErrors(err, STALE_CHECK());
  }
  return c.json({ session: await reloadSession(container, t.companyId, row.id, t.userId), draft: saved, applied: fixed.applied, skipped: fixed.skipped, diff: diffPackets(draft, saved), check: checkRequirements(saved, `d${packetFingerprint(saved)}`) }, 201);
});
