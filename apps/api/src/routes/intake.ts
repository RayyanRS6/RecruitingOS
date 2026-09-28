import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { ConversationMessage, IntakeMessageRequest, StartIntake } from "@ros/contracts";
import { IntakeSessionError, compileIntake, runIntakeTurn, type IntakeDeps } from "@ros/agents";
import { assertCan, emit, entitlements } from "@ros/core";
import { intakeSessions, withTenant, type Tx } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { composeBrief } from "../services/brief";
import type { Container } from "../container";

/**
 * The intake conversation. Every model call runs between two short transactions (see packages/agents/src/intake.ts),
 * so a request never holds a database connection while the model thinks.
 */
export const intakeRoutes = new Hono<Vars>();

function deps(container: Container): IntakeDeps {
  return { ai: container.ai, comp: container.integrations.comp };
}

/** Maps the agent's session errors onto the API's answers. */
async function turn(container: Container, input: Parameters<typeof runIntakeTurn>[2]) {
  try {
    return await runIntakeTurn(container.db, deps(container), input);
  } catch (err) {
    if (err instanceof IntakeSessionError && err.code === "not_found") throw new HttpError(404, "not_found", "Intake session not found.");
    if (err instanceof IntakeSessionError) throw new HttpError(409, "not_active", "This intake has already produced a role. Start a new one for another hire.");
    throw err;
  }
}

async function startSession(tx: Tx, companyId: string, actor: ReturnType<typeof actorOf>, via?: string) {
  const [session] = await tx.insert(intakeSessions).values({ companyId, createdBy: actor }).returning();
  await emit(tx, { type: "intake.started", companyId, actor, subject: { type: "intake_session", id: session.id }, payload: via ? { via } : {} });
  return session;
}

/** Starts an intake, optionally with the owner's first message. */
intakeRoutes.post("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const body = StartIntake.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const session = await withTenant(container.db, t.companyId, (tx) => startSession(tx, t.companyId, actorOf(c)));
  let reply: unknown = null;
  if (body.initialMessage) {
    const r = await turn(container, { companyId: t.companyId, sessionId: session.id, message: body.initialMessage, actor: actorOf(c) });
    reply = "turn" in r ? r.turn : { error: r.error };
  }
  const [fresh] = await withTenant(container.db, t.companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.id, session.id)).limit(1));
  return c.json({ session: fresh, reply }, 201);
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

intakeRoutes.post("/sessions/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const body = IntakeMessageRequest.parse(await c.req.json());
  const container = c.get("container");
  const r = await turn(container, { companyId: t.companyId, sessionId: c.req.param("id"), message: body.message, actor: actorOf(c) });
  const [fresh] = await withTenant(container.db, t.companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.id, c.req.param("id"))).limit(1));
  return c.json({ session: fresh, reply: "turn" in r ? r.turn : { error: r.error, recovery: "Try again, or ask a recruiter to finish this with you." } });
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

/**
 * Compiles the Role Packet. The plan's active-role allowance is checked before the model is called (so a refused
 * compile costs nothing) and again in the transaction that creates the role, where the approval workflow starts and
 * the allowance is recorded; all of that commits together or not at all.
 */
intakeRoutes.post("/sessions/:id/compile", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const container = c.get("container");
  const limitReached = (limit: number | null) => new HttpError(402, "limit_reached", `Your plan includes ${limit} active role${limit === 1 ? "" : "s"}. Close a role or upgrade to add another.`);
  const first = await withTenant(container.db, t.companyId, (tx) => entitlements.check(tx, t.companyId, "active_roles", 1));
  if (!first.ok) throw limitReached(first.limit);
  let workflowRunId: string | null = null;
  let result: Awaited<ReturnType<typeof compileIntake>>;
  try {
    result = await compileIntake(container.db, deps(container), { companyId: t.companyId, sessionId: c.req.param("id"), actor: actorOf(c), hiringManagerUserId: t.userId }, {
      finalize: async (tx, compiled) => {
        const again = await entitlements.check(tx, t.companyId, "active_roles", 1);
        if (!again.ok) throw limitReached(again.limit);
        const { runId } = await container.engine.start(tx, {
          workflowKey: "role_approval",
          companyId: t.companyId,
          subject: { type: "role", id: compiled.roleId },
          state: { roleId: compiled.roleId, packetVersion: compiled.version },
          idempotencyKey: `role_approval:${compiled.roleId}:${compiled.version}`,
          actor: actorOf(c),
        });
        workflowRunId = runId;
        await entitlements.record(tx, t.companyId, "active_roles", 1, "role", { roleId: compiled.roleId });
      },
    });
  } catch (err) {
    if (err instanceof IntakeSessionError) throw new HttpError(404, "not_found", "Intake session not found.");
    throw err;
  }
  await container.kick();
  if ("error" in result) return c.json({ error: { code: "ai_failed", message: "The AI could not compile the role packet. A recruiter can finish it with you.", details: result } }, 502);
  return c.json({ roleId: result.roleId, version: result.version, packet: result.packet, workflowRunId }, 201);
});

/**
 * Owner conversation (Slice 1): a message that reads like a hiring request ("I need to hire...", "looking for a...")
 * starts or continues the intake; anything else is answered from the brief. The routing is a plain keyword match by
 * design: cheap, predictable, and the owner can always start an intake explicitly from the Roles page.
 */
const HIRING_INTENT = /\b(hire|hiring|need (a|an|someone)|looking for (a|an)|open(ing)? (a )?role|position)\b/i;

intakeRoutes.post("/conversation/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const body = ConversationMessage.parse(await c.req.json());
  const container = c.get("container");
  type Routed = { kind: "brief"; brief: Awaited<ReturnType<typeof composeBrief>> } | { kind: "intake"; sessionId: string };
  const routed = await withTenant(container.db, t.companyId, async (tx): Promise<Routed> => {
    const active = (await tx.select().from(intakeSessions).where(eq(intakeSessions.status, "active")).orderBy(desc(intakeSessions.updatedAt)).limit(1))[0];
    if (!active && !HIRING_INTENT.test(body.message)) return { kind: "brief", brief: await composeBrief(tx, t.companyId) };
    if (!canStartHire(t.role)) throw new HttpError(403, "forbidden", "Your role cannot start a hire.");
    return { kind: "intake", sessionId: active ? active.id : (await startSession(tx, t.companyId, actorOf(c), "conversation")).id };
  });
  if (routed.kind === "brief") {
    const brief = routed.brief;
    return c.json({ reply: brief.cards.map((card) => `${card.title}. ${card.body}`).join("\n\n"), proposedActions: brief.cards.flatMap((card) => card.actions.map((a) => ({ kind: "link", label: a.label, path: a.path }))) });
  }
  const r = await turn(container, { companyId: t.companyId, sessionId: routed.sessionId, message: body.message, actor: actorOf(c) });
  if ("error" in r) return c.json({ reply: "I hit a problem drafting that. Try again, or tap Ask a recruiter and a person will finish it with you.", intakeSessionId: routed.sessionId, proposedActions: [{ kind: "ask_recruiter" }] });
  return c.json({ reply: r.turn.assistantMessage, intakeSessionId: routed.sessionId, readyToCompile: r.turn.readyToCompile, proposedActions: r.turn.readyToCompile ? [{ kind: "compile_packet", intakeSessionId: routed.sessionId }] : [] });
});

function canStartHire(role: Parameters<typeof assertCan>[0]): boolean {
  try {
    assertCan(role, "role.create");
    return true;
  } catch {
    return false;
  }
}
