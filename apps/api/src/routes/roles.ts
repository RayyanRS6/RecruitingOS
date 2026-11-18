import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { CloseRole, PacketFieldEdit, ROLE_ACTION_BLOCKED, RolePacket as RolePacketSchema, RoleStatus, RoleStatusChange, SetClosingDate, appPaths, type ClosingDateAnswer, type PacketSaved, type RoleDetail } from "@ros/contracts";
import { CLOSING_DATE_REASON, assertCan, audit, closingDateProblem, closingDateRequired, closingDayWords, closingMoment, emit, notify } from "@ros/core";
import { companies, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { armClosingDate, closeAiInterviewsOfJob } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, roleScopeGuard, type Tenant, type Vars } from "../middleware/session";
import { closingDateFor } from "../services/closing-date";
import { roleDetail, roleSummaries } from "../services/jobs";
import { applyFieldEdit } from "../services/packet-fields";
import { createPacketVersion, currentVersionOf } from "../services/packet-versions";
import { publishRole } from "../services/publish";
import { assertNoNewWork } from "../services/trial";

/**
 * Jobs: the list, one job's page, its one editor, and what can be done with it (publish, pause, resume, close, the
 * closing date). The Share tab's routes are in routes/share.ts, the candidates of a job in routes/candidates.ts.
 */
export const roleRoutes = new Hono<Vars>();
roleRoutes.use("/:id", roleScopeGuard);
roleRoutes.use("/:id/*", roleScopeGuard);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = () => new HttpError(404, "not_found", "Job not found.");

/** The job's id from the address; one that is not an id names no job: a plain 404, never a database error. */
export function jobId(id: string | undefined): string {
  if (!id || !UUID.test(id)) throw NOT_FOUND();
  return id;
}

/** The job's page as it stands after a change. */
async function detailOf(tx: Tx, container: Container, t: Tenant, roleId: string): Promise<RoleDetail> {
  const detail = await roleDetail(tx, container, t, roleId);
  if (!detail) throw NOT_FOUND();
  return detail;
}

roleRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const status = RoleStatus.optional().parse(c.req.query("status") || undefined);
  const container = c.get("container");
  return c.json(await withTenant(container.db, t.companyId, (tx) => roleSummaries(tx, container, t, status)));
});

roleRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const id = jobId(c.req.param("id"));
  const container = c.get("container");
  return c.json(await withTenant(container.db, t.companyId, (tx) => detailOf(tx, container, t, id)));
});

/**
 * The one editor of a job. The edit starts from `baseVersion`, which must still be the newest version (someone else may
 * have saved since: 409 `stale_version`), and saves a new version: live at once on an open or paused job, saved on a
 * draft. Wording the fairness guard flags refuses the save on an open or paused job until it is changed or kept with a
 * reason (422 `packet_flags`); a form question about a protected characteristic is always refused (422
 * `question_not_allowed`). Answers the job as it now stands and what the guard fixed by rule.
 */
roleRoutes.patch("/:id/packet", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const id = jobId(c.req.param("id"));
  const body = PacketFieldEdit.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const saved = await withTenant(container.db, t.companyId, async (tx): Promise<PacketSaved> => {
    // The job's row is locked first, so two saves at once take turns: the second finds the first one's version and is refused as out of date.
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1).for("update");
    if (!role) throw NOT_FOUND();
    if (role.status === "closed") throw new HttpError(409, "role_closed", ROLE_ACTION_BLOCKED.closed);
    const [newest] = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version)).limit(1);
    if (!newest) throw new HttpError(409, "no_draft", "This job has not been written yet.");
    if (body.baseVersion !== newest.version) throw new HttpError(409, "stale_version", `Someone saved a newer version of this job (version ${newest.version}) since you opened it. Reload to see it, then make your change again.`);
    const edit = applyFieldEdit(RolePacketSchema.parse(newest.packet), body);
    if (!edit.fields.length && !body.keepFlags?.length) throw new HttpError(400, "nothing_changed", "Nothing was changed.");
    const made = await createPacketVersion(tx, container, { tenant: t, actor, role, packet: edit.packet, changeSummary: body.changeSummary ?? (edit.summary || "Kept flagged wording, with a reason") });
    return { role: await detailOf(tx, container, t, role.id), guardChanges: made.guardChanges };
  });
  await container.kick();
  return c.json(saved);
});

/**
 * "Publish job" on a job that is a draft: anyone on the team opens it with one press (services/publish.ts runs the
 * checks: the person's role, the plan, the wording flags, the legal check). Answers `PublishResult`.
 */
roleRoutes.post("/:id/publish", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const id = jobId(c.req.param("id"));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, (tx) => publishRole(tx, container, { tenant: t, actor: actorOf(c), roleId: id }));
  await container.kick();
  return c.json(result);
});

// Pause only from open and resume only from paused: a resume never reopens a closed job or opens a draft, and a second
// press changes nothing.
for (const action of ["pause", "resume"] as const) {
  roleRoutes.post(`/:id/${action}`, requireTenant, async (c) => {
    const t = c.get("tenant")!;
    assertCan(t.role, "role.manage");
    const id = jobId(c.req.param("id"));
    const body = RoleStatusChange.parse(await c.req.json().catch(() => ({})));
    const container = c.get("container");
    const detail = await withTenant(container.db, t.companyId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1);
      if (!role) throw NOT_FOUND();
      if (role.status === "closed") throw new HttpError(409, "role_closed", ROLE_ACTION_BLOCKED.closed);
      if (action === "pause" && role.status !== "open") throw new HttpError(409, "not_open", role.status === "paused" ? "This job is already paused." : "Only an open job can be paused. This job is not published yet.");
      if (action === "resume" && role.status !== "paused") throw new HttpError(409, "not_paused", role.status === "open" ? "This job is already open." : "Only a paused job can be resumed.");
      // A trial that has ended takes no new applications: a paused job waits for a plan. Pausing never does.
      if (action === "resume") await assertNoNewWork(tx, t.companyId, container.engine.clock());
      const patch = action === "pause" ? { status: "paused", pausedAt: container.engine.clock().toISOString() } : { status: "open", pausedAt: null };
      // the state is checked again in the write itself, so two presses at once pause (or resume) once
      const [updated] = await tx.update(roles).set(patch).where(and(eq(roles.id, role.id), eq(roles.status, action === "pause" ? "open" : "paused"))).returning({ id: roles.id });
      if (!updated) throw new HttpError(409, action === "pause" ? "not_open" : "not_paused", "Someone changed this job a moment ago. Refresh to see where it is now.");
      await emit(tx, { type: action === "pause" ? "role.paused" : "role.resumed", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
      return detailOf(tx, container, t, role.id);
    });
    await container.kick();
    return c.json(detail);
  });
}

/**
 * Closes a job, for good: its page is no longer public, it takes no applications, and its place on the plan comes back.
 * Nobody is told anything by a close, and nobody's place in the process changes: a person tells a candidate a decision.
 * An AI interview of the job that was still open closes with it, so no link works for a job that takes no more
 * applications; an interview already sent keeps its answers and its score (`closeAiInterviewsOfJob`).
 * A second press answers the closed job as it stands.
 */
roleRoutes.post("/:id/close", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const id = jobId(c.req.param("id"));
  CloseRole.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const detail = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1).for("update");
    if (!role) throw NOT_FOUND();
    if (role.status !== "closed") {
      await tx.update(roles).set({ status: "closed", closedAt: container.engine.clock().toISOString() }).where(eq(roles.id, role.id));
      await emit(tx, { type: "role.closed", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { from: role.status } });
      // the timer that would stop applications on the closing date has nothing left to do
      await armClosingDate(tx, container.engine, { companyId: t.companyId, roleId: role.id, closesOn: null, actor });
      await closeAiInterviewsOfJob(tx, container.engine, { roleId: role.id, actor, now: container.engine.clock() });
    }
    return detailOf(tx, container, t, role.id);
  });
  await container.kick();
  return c.json(detail);
});

/**
 * The closing date: the last day new applications are taken, in the company's time zone, or null to take it off. For
 * an open or paused job the timer is set again (packages/workflows closing-date.ts); a draft gets its timer when it is
 * published. A later date on a job whose date already stopped applications takes applications again. Colorado (and
 * remote) jobs keep a date: 409 `closing_date_required`.
 */
roleRoutes.post("/:id/closing-date", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const id = jobId(c.req.param("id"));
  const body = SetClosingDate.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const answer = await withTenant(container.db, t.companyId, async (tx): Promise<ClosingDateAnswer> => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!role) throw NOT_FOUND();
    if (role.status === "closed") throw new HttpError(409, "role_closed", ROLE_ACTION_BLOCKED.closed);
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const packet = currentVersionOf(role, versions)?.packet ?? null;
    const now = container.engine.clock();
    if (body.closesOn) {
      const problem = closingDateProblem(body.closesOn, now, company?.timezone);
      if (problem) throw new HttpError(400, "bad_closing_date", problem);
    } else if (packet && closingDateRequired({ jobLocations: packet.identity.locations, remotePolicy: packet.identity.remotePolicy })) {
      throw new HttpError(409, "closing_date_required", "The law in Colorado asks the job ad to say when applications close, and this job is there (or remote). Choose a later date instead of taking it off.");
    }
    const previous = role.applicationsCloseOn ? role.applicationsCloseOn.slice(0, 10) : null;
    const [updated] = await tx.update(roles).set({ applicationsCloseOn: body.closesOn }).where(eq(roles.id, role.id)).returning();
    await emit(tx, { type: "role.closing_date_set", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { closesOn: body.closesOn, previous } });
    await audit(tx, { companyId: t.companyId, actor, action: "role.closing_date_changed", target: { type: "role", id: role.id }, reason: body.closesOn ? `closes on ${body.closesOn}` : "closing date removed", details: { closesOn: body.closesOn, previous } });
    if (role.status === "open" || role.status === "paused") await armClosingDate(tx, container.engine, { companyId: t.companyId, roleId: role.id, closesOn: body.closesOn, actor });
    // A later date opens again the applications the old date stopped. Once a trial has ended that is new work and waits
    // for a plan (402 `trial_ended`); a plain date change is still taken.
    let reopened = false;
    let row = updated;
    if (body.closesOn && !role.acceptingApplications && role.applicationsClosedReason === CLOSING_DATE_REASON && closingMoment(body.closesOn, company?.timezone).getTime() > now.getTime()) {
      await assertNoNewWork(tx, t.companyId, now);
      [row] = await tx.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null }).where(eq(roles.id, role.id)).returning();
      await emit(tx, { type: "role.applications_reopened", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { reason: "closing date extended", closesOn: body.closesOn } });
      await notify(tx, { companyId: t.companyId, kind: "applications.reopened", title: `${role.title} is taking applications again`, body: `${actor.name ?? "A team member"} moved the closing date to ${closingDayWords(body.closesOn)}. The job page shows the apply button again.`, action: { label: "Open the job", href: appPaths.job(role.id) } });
      reopened = true;
    }
    return { ok: true, reopened, closingDate: closingDateFor(row, company ?? null, packet, now) };
  });
  await container.kick();
  return c.json(answer);
});
