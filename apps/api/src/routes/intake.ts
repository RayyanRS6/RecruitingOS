import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { ConversationMessage, IntakeMessageRequest, StartIntake } from "@ros/contracts";
import { compileIntake, runIntakeTurn } from "@ros/agents";
import { assertCan, emit, entitlements } from "@ros/core";
import { intakeSessions, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { composeBrief } from "../services/brief";

export const intakeRoutes = new Hono<Vars>();

function deps(c: { get(k: "container"): Vars["Variables"]["container"] }) {
  const container = c.get("container");
  return { ai: container.ai, comp: container.integrations.comp };
}

intakeRoutes.post("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const body = StartIntake.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [session] = await tx.insert(intakeSessions).values({ companyId: t.companyId, createdBy: actorOf(c) }).returning();
    await emit(tx, { type: "intake.started", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: session.id }, payload: {} });
    let reply: unknown = null;
    if (body.initialMessage) {
      const turn = await runIntakeTurn(tx, deps(c), { companyId: t.companyId, sessionId: session.id, message: body.initialMessage, actor: actorOf(c) });
      reply = "turn" in turn ? turn.turn : { error: turn.error };
    }
    const [fresh] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, session.id)).limit(1);
    return { session: fresh, reply };
  });
  return c.json(result, 201);
});

intakeRoutes.get("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.companyId, t.companyId)).orderBy(desc(intakeSessions.createdAt)).limit(20));
  return c.json(rows);
});

/** The conversation the owner was in the middle of, so a page reload resumes it instead of starting over. */
intakeRoutes.get("/sessions/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const [row] = await withTenant(c.get("container").db, t.companyId, (tx) =>
    tx.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, t.companyId), eq(intakeSessions.status, "active"))).orderBy(desc(intakeSessions.updatedAt)).limit(1),
  );
  return c.json({ session: row ?? null });
});

intakeRoutes.get("/sessions/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const [row] = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.id, c.req.param("id"))).limit(1));
  if (!row) throw new HttpError(404, "not_found", "Intake session not found.");
  return c.json(row);
});

intakeRoutes.post("/sessions/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const body = IntakeMessageRequest.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [session] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, c.req.param("id"))).limit(1);
    if (!session) throw new HttpError(404, "not_found", "Intake session not found.");
    if (session.status !== "active") throw new HttpError(409, "not_active", "This intake has already produced a role. Start a new one for another hire.");
    const turn = await runIntakeTurn(tx, deps(c), { companyId: t.companyId, sessionId: session.id, message: body.message, actor: actorOf(c) });
    const [fresh] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, session.id)).limit(1);
    return { session: fresh, reply: "turn" in turn ? turn.turn : { error: turn.error, recovery: "Try again, or ask a recruiter to finish this with you." } };
  });
  return c.json(result);
});

/** "Start over": the conversation stays in the record but no longer resumes. */
intakeRoutes.post("/sessions/:id/abandon", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const result = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [session] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, c.req.param("id"))).limit(1);
    if (!session) throw new HttpError(404, "not_found", "Intake session not found.");
    if (session.status !== "active") return session;
    const [updated] = await tx.update(intakeSessions).set({ status: "abandoned" }).where(eq(intakeSessions.id, session.id)).returning();
    await emit(tx, { type: "intake.abandoned", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: session.id }, payload: { turns: session.messages.length } });
    return updated;
  });
  return c.json(result);
});

intakeRoutes.post("/sessions/:id/compile", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const ent = await entitlements.check(tx, t.companyId, "active_roles", 1);
    if (!ent.ok) throw new HttpError(402, "limit_reached", `Your plan includes ${ent.limit} active role${ent.limit === 1 ? "" : "s"}. Close a role or upgrade to add another.`);
    const compiled = await compileIntake(tx, deps(c), { companyId: t.companyId, sessionId: c.req.param("id"), actor: actorOf(c), hiringManagerUserId: t.userId });
    if ("error" in compiled) return { error: compiled.error, aiRunId: compiled.aiRunId };
    const { runId } = await container.engine.start(tx, {
      workflowKey: "role_approval",
      companyId: t.companyId,
      subject: { type: "role", id: compiled.roleId },
      state: { roleId: compiled.roleId, packetVersion: compiled.version },
      idempotencyKey: `role_approval:${compiled.roleId}:${compiled.version}`,
      actor: actorOf(c),
    });
    await entitlements.record(tx, t.companyId, "active_roles", 1, "role", { roleId: compiled.roleId });
    return { roleId: compiled.roleId, version: compiled.version, packet: compiled.packet, workflowRunId: runId };
  });
  await container.kick();
  if ("error" in result) return c.json({ error: { code: "ai_failed", message: "The AI could not compile the role packet. A recruiter can finish it with you.", details: result } }, 502);
  return c.json(result, 201);
});

/** Owner conversation: Slice 1 routes hiring requests into intake and answers "what needs me" from the brief. */
intakeRoutes.post("/conversation/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const body = ConversationMessage.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const active = (await tx.select().from(intakeSessions).where(eq(intakeSessions.status, "active")).orderBy(desc(intakeSessions.updatedAt)).limit(1))[0];
    const wantsHire = /\b(hire|hiring|need (a|an|someone)|looking for (a|an)|open(ing)? (a )?role|position)\b/i.test(body.message);
    if (active || wantsHire) {
      if (!assertCanSafe(t.role)) throw new HttpError(403, "forbidden", "Your role cannot start a hire.");
      let session = active;
      if (!session) {
        [session] = await tx.insert(intakeSessions).values({ companyId: t.companyId, createdBy: actorOf(c) }).returning();
        await emit(tx, { type: "intake.started", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: session.id }, payload: { via: "conversation" } });
      }
      const turn = await runIntakeTurn(tx, deps(c), { companyId: t.companyId, sessionId: session.id, message: body.message, actor: actorOf(c) });
      if ("error" in turn) return { reply: "I hit a problem drafting that. Try again, or tap Ask a recruiter and a person will finish it with you.", intakeSessionId: session.id, proposedActions: [{ kind: "ask_recruiter" }] };
      return { reply: turn.turn.assistantMessage, intakeSessionId: session.id, readyToCompile: turn.turn.readyToCompile, proposedActions: turn.turn.readyToCompile ? [{ kind: "compile_packet", intakeSessionId: session.id }] : [] };
    }
    const brief = await composeBrief(tx, t.companyId);
    return { reply: brief.cards.map((card) => `${card.title}. ${card.body}`).join("\n\n"), proposedActions: brief.cards.flatMap((card) => card.actions.map((a) => ({ kind: "link", label: a.label, path: a.path }))) };
  });
  return c.json(result);
});

function assertCanSafe(role: Parameters<typeof assertCan>[0]): boolean {
  try {
    assertCan(role, "role.create");
    return true;
  } catch {
    return false;
  }
}
