import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { CompanyQuestionsEdit, PacketFieldEdit, SetClosingDate, type DraftRolePacket, type Location } from "@ros/contracts";
import { loadTeam, type IntakeSessionRow } from "@ros/agents";
import { assertCan, closingDateProblem, companyHasLocked, emit, unresolvedFlags } from "@ros/core";
import { companies, events, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { jobPreview } from "../services/job-preview";
import { diffPackets } from "../services/packet-diff";
import { applyCompanyQuestionsEdit, applyFieldEdit } from "../services/packet-fields";
import { withoutLockedEvents } from "../services/locked-visibility";
import { withoutUnsentChats } from "../services/screen-visibility";
import { CLOSED_ROLE_MESSAGE, createPacketVersion, currentVersionOf, type PacketRow, type RoleRow } from "../services/packet-versions";
import type { Container } from "../container";
import { loadDraft } from "./intake";


/**
 * The job's activity list, the one editor of a published job and the candidate-view preview, mounted under
 * /api/v1/roles after the job routes; the closing date and the preview of a draft are `draftPacketRoutes`, mounted
 * under /api/v1/intake.
 */
export const rolePacketRoutes = new Hono<Vars>();
rolePacketRoutes.use("/:id/*", roleScopeGuard);

const TIMELINE_LIMIT = 200;

/**
 * The role's activity: every event about the role itself, its packet versions, or anything that names the role in its
 * payload (applications, approvals, postings), newest first. Described in plain words by the page. Like the activity
 * list, nothing is shown about a screening chat the candidate has not sent: no entry about a single answer, no count of
 * what was answered, and no entry about a reading the team may not see (`withoutUnsentScreenEvents`). Nor about anyone
 * past the plan's candidates per job (Rule 3, `withoutLockedEvents`).
 */
rolePacketRoutes.get("/:id/timeline", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "events.read");
  const roleId = c.req.param("id") ?? "";
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) return null;
    const found = await tx
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
      // With people past the plan's limit whose entries come out: read further back, keep what may be shown, and answer with the same number at most.
      .limit((await companyHasLocked(tx, t.companyId)) ? TIMELINE_LIMIT * 10 : TIMELINE_LIMIT);
    return (await withoutLockedEvents(tx, t.companyId, await withoutUnsentChats(tx, found))).slice(0, TIMELINE_LIMIT);
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
  if (!versions.length) throw new HttpError(409, "no_packet", "This job has no saved details yet.");
  const [company] = await tx.select({ name: companies.name, locations: companies.locations }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  return { role, versions, company: { name: company?.name ?? "", locations: company?.locations ?? [] } };
}

function refuseClosed(role: RoleRow): void {
  if (role.status === "closed") throw new HttpError(409, "role_closed", CLOSED_ROLE_MESSAGE);
}

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
    return { ...made.version, outcome: made.outcome, guardChanges: made.guardChanges, ...(made.paused ? { paused: true } : {}), fields: edit.fields, notes: edit.notes, diff: diffPackets(base.packet, made.version.packet, { from: base.version, to: made.version.version }) };
  });
  await container.kick();
  return c.json(result);
});

/**
 * "Questions every applicant answers" (Wave S7, the job's Scoring tab): the company's quick questions on the form and its
 * written questions in the chat, each list sent whole, in order. Every question passes the fairness check first: one
 * that asks about a protected characteristic is refused (422 `question_not_allowed`, each refused part in
 * `details.problems`); wording the phrase list flags is saved with the flag, so approval waits for a person. Starts from
 * `baseVersion`, which must still be the newest, and saves a new version like any edit. These questions never hold or
 * decline anyone, so on a live job an approver's change takes effect at once (not on the Q10 list).
 */
rolePacketRoutes.put("/:id/company-questions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = CompanyQuestionsEdit.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const { role, versions } = await loadRolePackets(tx, c.req.param("id") ?? "", { forWrite: true });
    refuseClosed(role);
    const base = versions[0];
    if (body.baseVersion !== base.version) throw new HttpError(409, "stale_version", `Someone saved a newer version of this role (version ${base.version}) since you opened it. Reload to see it, then make your change again.`);
    const edit = applyCompanyQuestionsEdit(base.packet, body);
    if (!edit.fields.length) throw new HttpError(400, "nothing_changed", "Nothing was changed.");
    const made = await createPacketVersion(tx, container, { tenant: t, actor, role, packet: edit.packet, changeSummary: body.changeSummary ?? edit.summary });
    // Recorded like every edit: `role_packet.edited`, with the summary ("Edited: quick questions, written questions").
    return { ...made.version, outcome: made.outcome, guardChanges: made.guardChanges, ...(made.paused ? { paused: true } : {}), fields: edit.fields, flags: unresolvedFlags(made.version.packet).filter((f) => f.path.startsWith("companyQuestions")), diff: diffPackets(base.packet, made.version.packet, { from: base.version, to: made.version.version }) };
  });
  await container.kick();
  return c.json(result);
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The same tools for a draft before the role exists (mounted under /api/v1/intake)                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export const draftPacketRoutes = new Hono<Vars>();

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

/**
 * The closing date chosen in the job builder (row 61), kept with the draft on the server so it survives another device
 * and reaches the role without a second call: recorded as a `role.closing_date_set` event on the draft (no new column),
 * and set on the role by the approval workflow's first step when the role has no date of its own yet. Needs role.manage,
 * like the role's own closing date. GET answers `{ closesOn }` (null when none was chosen); PUT takes `{ closesOn }`
 * (null takes it off) and answers the same.
 */
async function draftClosingDateOf(tx: Tx, sessionId: string): Promise<string | null> {
  const [last] = await tx.select({ payload: events.payload }).from(events).where(and(eq(events.subjectType, "intake_session"), eq(events.subjectId, sessionId), eq(events.type, "role.closing_date_set"))).orderBy(desc(events.id)).limit(1);
  const value = (last?.payload as { closesOn?: unknown } | undefined)?.closesOn;
  return typeof value === "string" ? value : null;
}

draftPacketRoutes.get("/sessions/:id/closing-date", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const row = await loadDraft(c, c.req.param("id") ?? "");
  const closesOn = await withTenant(c.get("container").db, t.companyId, (tx) => draftClosingDateOf(tx, row.id));
  return c.json({ closesOn });
});

draftPacketRoutes.put("/sessions/:id/closing-date", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = SetClosingDate.parse(await c.req.json());
  const row = await loadDraft(c, c.req.param("id") ?? "");
  if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside. Set the closing date on the job's Share tab.");
  const container = c.get("container");
  const actor = actorOf(c);
  const out = await withTenant(container.db, t.companyId, async (tx) => {
    if (body.closesOn) {
      const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
      const problem = closingDateProblem(body.closesOn, container.engine.clock(), company?.timezone);
      if (problem) throw new HttpError(400, "bad_closing_date", problem);
    }
    const previous = await draftClosingDateOf(tx, row.id);
    if (previous !== body.closesOn) await emit(tx, { type: "role.closing_date_set", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { closesOn: body.closesOn, previous, draft: true } });
    return { closesOn: body.closesOn };
  });
  return c.json(out);
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
