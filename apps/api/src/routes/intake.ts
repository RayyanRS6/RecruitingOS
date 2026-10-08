import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { ConversationMessage, INTAKE_MESSAGE_MAX, IntakeAnswersRequest, IntakeMessageRequest, KeepPacketFlag, StartIntake, type Actor, type IntakeSessionSummary, type PlanRoom } from "@ros/contracts";
import { IntakeSessionError, applyIntakeEdit, draftIntake, keepDraftFlag, requestIntakeApproval, runIntakeTurn, sessionView, startIntakeSession, type IntakeDeps, type IntakeSessionRow, type IntakeTurnOutcome } from "@ros/agents";
import { IntakeEditError, assertCan, can, emit, entitlements, looksLikePastedAd, normalizeFacts, notify, packetToFacts } from "@ros/core";
import { entitlements as entitlementRows, events, intakeSessions, recruiterEscalations, rolePackets, roles, usageEvents, withTenant, type Tx } from "@ros/db";
import { actorOf, requireTenant, type Tenant, type Vars } from "../middleware/session";
import { HttpError, messageTooLong } from "../middleware/errors";
import { briefViewerOf, composeBrief } from "../services/brief";
import type { Container } from "../container";

/**
 * The job builder's API (plan Wave C). Every model call runs between two short transactions (packages/agents/src/
 * intake.ts), so a request never holds a database connection while the model thinks.
 *
 * A draft belongs to the person who started it (founder decision Q6, option A): it carries pay and the reasons for the
 * hire, so only people who may start a hire and see pay reach these routes at all; each person lists and opens their
 * own drafts; owners and admins see every draft and may take one over. An ITS recruiter under a grant for one role or
 * one candidate never starts or opens a draft (C12); one brought in for the company opens their own drafts and the one
 * draft the request they accepted is about.
 */
export const intakeRoutes = new Hono<Vars>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether this person may start and open drafts: starting a hire, seeing pay, and no grant narrower than the company. */
function mayDraft(t: Tenant): boolean {
  if (t.staff && (t.staff.scope.roleId || t.staff.scope.applicationId)) return false;
  return can(t.role, "role.create") && can(t.role, "compensation.read");
}

function assertMayDraft(t: Tenant): void {
  assertCan(t.role, "role.create");
  assertCan(t.role, "compensation.read");
  if (t.staff && (t.staff.scope.roleId || t.staff.scope.applicationId)) throw new HttpError(403, "staff_scope", "Your access is limited to the role or candidate of the request you accepted, so you cannot start or open drafts.");
}

const ownerOf = (row: Pick<IntakeSessionRow, "createdByUserId" | "createdBy">): string | null => row.createdByUserId ?? (row.createdBy.kind === "user" || row.createdBy.kind === "recruiter" ? row.createdBy.id : null);

/** The draft an ITS recruiter's accepted request is about, if any (C12): the one draft beyond their own they may open. */
async function escalatedDraftOf(tx: Tx, t: Tenant): Promise<string | null> {
  const escalationId = t.staff?.scope.escalationId;
  if (!escalationId) return null;
  const [e] = await tx.select({ snapshot: recruiterEscalations.contextSnapshot }).from(recruiterEscalations).where(eq(recruiterEscalations.id, escalationId)).limit(1);
  const id = (e?.snapshot as { intakeSession?: { id?: unknown } | null } | undefined)?.intakeSession?.id;
  return typeof id === "string" ? id : null;
}

function mayActOnDraft(t: Tenant, row: IntakeSessionRow, escalated: string | null): boolean {
  if (ownerOf(row) === t.userId) return true;
  if (t.staff) return escalated === row.id;
  return t.role === "owner" || t.role === "admin";
}

/** Whether this person started the draft before an owner or admin took it over (the take-over event names them). */
async function startedBeforeTakeOver(tx: Tx, sessionId: string, userId: string): Promise<boolean> {
  const [hit] = await tx.select({ id: events.id }).from(events).where(and(eq(events.type, "intake.taken_over"), eq(events.subjectType, "intake_session"), eq(events.subjectId, sessionId), sql`${events.payload}->>'fromUserId' = ${userId}`)).limit(1);
  return !!hit;
}

/** The draft the caller may open, refused plainly before any model call is made for it. Shared with the draft tools in role-packets.ts. */
export async function loadDraft(c: Context<Vars>, sessionId: string): Promise<IntakeSessionRow> {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  if (!UUID.test(sessionId)) throw new HttpError(404, "not_found", "Intake session not found.");
  const found = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [row] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
    if (!row) return null;
    const escalated = await escalatedDraftOf(tx, t);
    const allowed = mayActOnDraft(t, row, escalated);
    return { row, allowed, takenFromMe: !allowed && (await startedBeforeTakeOver(tx, row.id, t.userId)) };
  });
  if (!found) throw new HttpError(404, "not_found", "Intake session not found.");
  if (found.takenFromMe) throw new HttpError(403, "taken_over", "An owner or admin took over this draft, so it is theirs to continue now. Ask them if you need it back.");
  if (!found.allowed) throw new HttpError(403, "not_your_draft", "Someone else on your team started this draft. They can continue it, or an owner or admin can.");
  return found.row;
}

/** For an ITS recruiter or a member checking a request about a draft: may this person open it? (POST /escalations, C12.) */
export async function assertMayShareDraft(tx: Tx, t: Tenant, sessionId: string): Promise<void> {
  if (!mayDraft(t)) throw new HttpError(403, "forbidden", "Only people who can start a hire can ask about a draft.");
  const [row] = UUID.test(sessionId) ? await tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1) : [];
  if (!row) throw new HttpError(404, "not_found", "That draft is not in your company.");
  if (!mayActOnDraft(t, row, await escalatedDraftOf(tx, t))) throw new HttpError(403, "not_your_draft", "Someone else on your team started this draft. They can ask for help with it, or an owner or admin can.");
}

async function reload(container: Container, companyId: string, sessionId: string): Promise<IntakeSessionRow> {
  const [row] = await withTenant(container.db, companyId, (tx) => tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1));
  if (!row) throw new HttpError(404, "not_found", "Intake session not found.");
  return row;
}

function deps(container: Container): IntakeDeps {
  return { ai: container.ai, comp: container.integrations.comp };
}

/** Maps the agent's session errors onto the API's answers. */
function sessionErrors(err: unknown): never {
  if (err instanceof IntakeSessionError && err.code === "not_found") throw new HttpError(404, "not_found", "Intake session not found.");
  if (err instanceof IntakeSessionError && err.code === "stale_draft") throw new HttpError(409, "stale_draft", "The draft changed a moment ago. Look at it again, then make your change.");
  if (err instanceof IntakeSessionError) throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside. Start a new one for another hire.");
  if (err instanceof IntakeEditError) throw new HttpError(400, err.code, err.message);
  throw err;
}

async function turn(container: Container, input: Parameters<typeof runIntakeTurn>[2]): Promise<IntakeTurnOutcome> {
  try {
    return await runIntakeTurn(container.db, deps(container), input);
  } catch (err) {
    return sessionErrors(err);
  }
}

/** "Bring in a recruiter" on a draft (C12): a request about the company's hiring that carries this draft's conversation. */
const DRAFT_HELP_QUESTION = "Please help me finish drafting this role. The assistant could not finish it with me.";
const askRecruiterAction = (sessionId: string) => ({ kind: "ask_recruiter", label: "Bring in a recruiter", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", intakeSessionId: sessionId, question: DRAFT_HELP_QUESTION } });

/** The turn as the page reads it; a failed turn says what to do next and offers a recruiter. */
function turnReply(r: IntakeTurnOutcome, sessionId: string) {
  if ("error" in r) return { error: r.error, recovery: "Try again, or bring in a recruiter to finish it with you.", proposedActions: [askRecruiterAction(sessionId)] };
  return { ...r.turn, benchmark: r.benchmark, benchmarkGap: r.benchmarkGap };
}

const MORE_ROLES_QUESTION = "We would like to open more roles than our plan includes. Can we talk about adding more?";
const askAboutPlan = { label: "Talk to ITS about more roles", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: MORE_ROLES_QUESTION } };

/**
 * Room on the plan for another role (C13), with the roles that used the places, so the owner learns it before answering
 * any question. A place is used when a role is created and is not given back when the role closes or fills (nothing
 * ever takes one off the count), so every role that used one is listed, closed ones too, and the message never suggests
 * closing a role to make room. There is nowhere in the product to change plans, so a full plan offers the one thing
 * that helps: asking ITS about more roles (a talk about the plan, which never uses one of the plan's recruiter requests).
 */
async function planRoom(tx: Tx, companyId: string): Promise<PlanRoom> {
  const check = await entitlements.check(tx, companyId, "active_roles", 1);
  const usage = await tx.select({ ref: usageEvents.ref }).from(usageEvents).where(and(eq(usageEvents.companyId, companyId), eq(usageEvents.key, "active_roles")));
  const ids = [...new Set(usage.map((u) => u.ref.roleId).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  const holding = ids.length ? await tx.select({ roleId: roles.id, title: roles.title, status: roles.status }).from(roles).where(inArray(roles.id, ids)) : [];
  const names = holding.map((r) => (r.status === "closed" || r.status === "filled" ? `${r.title} (${r.status})` : r.title));
  const message = check.ok
    ? null
    : `Your plan includes ${check.limit} role${check.limit === 1 ? "" : "s"}, and ${check.limit === 1 ? "it is" : "all are"} used${names.length ? `: ${names.join(", ")}` : ""}. A place is used when a role is created, and closing a role does not give it back. Talk to ITS about adding more.`;
  return { ok: check.ok, limit: check.limit, used: check.used, holding, message };
}

function limitReached(t: Tenant, room: PlanRoom): HttpError {
  return new HttpError(402, "limit_reached", room.message ?? "Your plan has no room for another role.", { actions: can(t.role, "escalation.create") ? [askAboutPlan] : [], room });
}

/** "Hire again" (C14): the facts of the role's latest approved version; pay is carried over to be confirmed again, never as confirmed. */
async function hireAgainSeed(tx: Tx, roleId: string) {
  const [role] = UUID.test(roleId) ? await tx.select({ id: roles.id, title: roles.title }).from(roles).where(eq(roles.id, roleId)).limit(1) : [];
  if (!role) throw new HttpError(404, "not_found", "That role is not in your company.");
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), isNotNull(rolePackets.approvedAt))).orderBy(desc(rolePackets.version)).limit(1);
  if (!pv) throw new HttpError(409, "never_approved", "That role was never approved, so there is nothing to start from yet.");
  return { title: role.title, facts: packetToFacts(pv.packet), fromRole: { roleId: role.id, version: pv.version, title: role.title } };
}

/**
 * Starts a draft together with its first message (C3, C5, C14): the owner's words (a pasted job ad fits), or "hire again"
 * from an earlier role, or both. The plan's room is checked first, so no draft and no assistant run happen on a full
 * plan (C13). The answer carries the draft and the assistant's first turn; a first message that is not about a role
 * leaves no draft behind (`session: null`, `notARole: true`).
 */
intakeRoutes.post("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  const body = StartIntake.parse(await c.req.json().catch(() => ({})));
  if (!body.initialMessage && !body.fromRoleId) throw new HttpError(400, "message_required", "Describe the role first: a sentence or two, or paste a job ad you already have.");
  const container = c.get("container");
  const actor = actorOf(c);
  const started = await withTenant(container.db, t.companyId, async (tx) => {
    const room = await planRoom(tx, t.companyId);
    if (!room.ok) throw limitReached(t, room);
    const seed = body.fromRoleId ? await hireAgainSeed(tx, body.fromRoleId) : null;
    const message = body.initialMessage
      ? { content: body.initialMessage, kind: looksLikePastedAd(body.initialMessage) ? ("pasted_ad" as const) : ("text" as const) }
      : { content: `Hire again: ${seed!.title}.`, kind: "hire_again" as const };
    return startIntakeSession(tx, { companyId: t.companyId, actor, userId: t.userId, message, facts: seed?.facts, fromRole: seed?.fromRole, via: seed ? "hire_again" : "start" });
  });
  const r = await turn(container, { companyId: t.companyId, sessionId: started.id, actor });
  if (!("error" in r) && r.notARole) return c.json({ session: null, notARole: true, reply: turnReply(r, started.id) }, 200);
  return c.json({ session: sessionView(await reload(container, t.companyId, started.id), t.userId), reply: turnReply(r, started.id) }, 201);
});

function summaryOf(row: IntakeSessionRow, viewerUserId: string): IntakeSessionSummary {
  const view = sessionView(row, viewerUserId);
  return {
    id: row.id,
    status: row.status,
    title: view.facts.title ?? view.draft?.identity.title ?? null,
    startedBy: { userId: view.startedBy.userId, name: view.startedBy.name },
    mine: view.startedBy.mine,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ownerMessages: row.messages.filter((m) => m.role === "owner").length,
    hasDraft: !!row.draftPacket,
    missing: view.readiness.missing,
  };
}

/**
 * Drafts in progress (C3): `?mine=1` lists the caller's own; without it, owners and admins see every draft in the
 * company (so they can pick one up), and everyone else still sees only their own. The plan's room comes along (C13).
 */
intakeRoutes.get("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  const mine = ["1", "true"].includes(c.req.query("mine") ?? "");
  const everyone = !mine && !t.staff && (t.role === "owner" || t.role === "admin");
  const out = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const escalated = mine ? null : await escalatedDraftOf(tx, t);
    const own = or(eq(intakeSessions.createdByUserId, t.userId), sql`${intakeSessions.createdBy}->>'id' = ${t.userId}`, ...(escalated ? [eq(intakeSessions.id, escalated)] : []));
    const rows = await tx.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, t.companyId), eq(intakeSessions.status, "active"), ...(everyone ? [] : [own]))).orderBy(desc(intakeSessions.updatedAt));
    return { sessions: rows.map((r) => summaryOf(r, t.userId)), room: await planRoom(tx, t.companyId) };
  });
  return c.json(out);
});

/** Room on the plan for another role, when the new-role page opens (C13). */
intakeRoutes.get("/room", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  return c.json(await withTenant(c.get("container").db, t.companyId, (tx) => planRoom(tx, t.companyId)));
});

/** The conversation the caller was in the middle of, so a page reload resumes it instead of starting over. Never someone else's. */
intakeRoutes.get("/sessions/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  const [row] = await withTenant(c.get("container").db, t.companyId, (tx) =>
    tx.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, t.companyId), eq(intakeSessions.status, "active"), or(eq(intakeSessions.createdByUserId, t.userId), sql`${intakeSessions.createdBy}->>'id' = ${t.userId}`))).orderBy(desc(intakeSessions.updatedAt)).limit(1),
  );
  return c.json({ session: row ? sessionView(row, t.userId) : null });
});

intakeRoutes.get("/sessions/:id", requireTenant, async (c) => {
  const row = await loadDraft(c, c.req.param("id"));
  return c.json({ session: sessionView(row, c.get("tenant")!.userId) });
});

intakeRoutes.post("/sessions/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  await loadDraft(c, c.req.param("id"));
  const body = IntakeMessageRequest.parse(await c.req.json());
  const container = c.get("container");
  const r = await turn(container, { companyId: t.companyId, sessionId: c.req.param("id"), message: { content: body.message, kind: "text" }, actor: actorOf(c) });
  return c.json({ session: sessionView(await reload(container, t.companyId, c.req.param("id")), t.userId), reply: turnReply(r, c.req.param("id")) });
});

/**
 * Tapped answers, panel edits and "draft it" (C6, C7). The answers set the facts (set / add / remove), one short summary
 * goes into the conversation, and the assistant takes its next turn unless `reply` is false. `refused` lists anything
 * typed that failed the fairness check: it was not used, and the reason says why.
 */
intakeRoutes.post("/sessions/:id/answers", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  await loadDraft(c, c.req.param("id"));
  const body = IntakeAnswersRequest.parse(await c.req.json());
  const container = c.get("container");
  const sessionId = c.req.param("id");
  const actor = actorOf(c);
  let edit: Awaited<ReturnType<typeof applyIntakeEdit>>;
  try {
    edit = await applyIntakeEdit(container.db, { companyId: t.companyId, sessionId, actor, answers: body.answers, patch: body.patch, draftIt: body.draftIt, note: body.note });
  } catch (err) {
    return sessionErrors(err);
  }
  const r = body.reply ? await turn(container, { companyId: t.companyId, sessionId, actor }) : null;
  return c.json({ session: sessionView(await reload(container, t.companyId, sessionId), t.userId), reply: r ? turnReply(r, sessionId) : null, refused: edit.refused, summary: edit.summary });
});

/**
 * Writes the draft beside the conversation (C7, founder decision Q8): allowed once the essentials are in, or after one
 * round of questions, or when the owner said "draft it". No role is created and nobody is asked to approve anything.
 * While it runs, GET /sessions/:id shows `progress.stage` moving through benchmark, writing and checking (the checks and
 * the save), then done. Writing it again replaces the changes saved on the draft since (`readiness.draftEdits`), so the
 * page asks first.
 */
intakeRoutes.post("/sessions/:id/draft", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside.");
  const view = sessionView(row, t.userId);
  if (!view.readiness.mayDraft) throw new HttpError(409, "not_ready", view.readiness.draftBlocker ?? "Not ready to draft yet.", { readiness: view.readiness });
  const container = c.get("container");
  let out: Awaited<ReturnType<typeof draftIntake>>;
  try {
    out = await draftIntake(container.db, deps(container), { companyId: t.companyId, sessionId: row.id, actor: actorOf(c) });
  } catch (err) {
    return sessionErrors(err);
  }
  if ("error" in out) throw new HttpError(502, "ai_failed", "The assistant could not write the draft. Everything you confirmed is kept. Try again, or bring in a recruiter.", { aiRunId: out.aiRunId, actions: [askRecruiterAction(row.id)] });
  return c.json({ session: sessionView(await reload(container, t.companyId, row.id), t.userId), draft: out.draft });
});

/** Keeps a flagged phrase in the draft, with the person's reason (C1); approval no longer waits on it. */
intakeRoutes.post("/sessions/:id/flags/keep", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const body = KeepPacketFlag.parse(await c.req.json());
  const container = c.get("container");
  let kept: { found: boolean };
  try {
    kept = await keepDraftFlag(container.db, { companyId: t.companyId, sessionId: row.id, actor: actorOf(c), flagId: body.flagId, reason: body.reason });
  } catch (err) {
    return sessionErrors(err);
  }
  if (!kept.found) throw new HttpError(404, "flag_not_found", "That check is no longer on the draft.");
  return c.json({ session: sessionView(await reload(container, t.companyId, row.id), t.userId) });
});

/**
 * "Ask for approval" (C7): creates the role and its packet version 1 from the draft the person checked, and starts the
 * approval workflow, only once that draft is up to date with the answers, the six essentials are in, a person set or
 * confirmed the pay, and no wording check is open (409 `not_ready` lists what is left, in plain words). The plan's room
 * is checked before anything runs and again in the transaction that creates the role, where the approval starts and the
 * place is recorded; all of that commits together or not at all. `draftFirst` is the older one-step POST /compile.
 */
async function askForApproval(c: Context<Vars>, draftFirst: boolean) {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id") ?? "");
  const container = c.get("container");
  const first = row.roleId ? null : await withTenant(container.db, t.companyId, (tx) => planRoom(tx, t.companyId));
  if (first && !first.ok) throw limitReached(t, first);
  let workflowRunId: string | null = null;
  let result: Awaited<ReturnType<typeof requestIntakeApproval>>;
  try {
    result = await requestIntakeApproval(container.db, deps(container), { companyId: t.companyId, sessionId: row.id, actor: actorOf(c), hiringManagerUserId: t.userId }, {
      draftFirst,
      finalize: async (tx, compiled) => {
        // Two drafts asked for at once take turns on the plan's count, so together they never go past it.
        await tx.select({ id: entitlementRows.id }).from(entitlementRows).where(and(eq(entitlementRows.companyId, t.companyId), eq(entitlementRows.key, "active_roles"))).for("update");
        const again = await planRoom(tx, t.companyId);
        if (!again.ok) throw limitReached(t, again);
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
    return sessionErrors(err);
  }
  await container.kick();
  if ("notReady" in result) throw new HttpError(409, "not_ready", `Not ready to ask for approval yet. ${result.notReady.join(" ")}`, { blockers: result.notReady });
  if ("error" in result) return c.json({ error: { code: "ai_failed", message: "The assistant could not write the draft. Everything you confirmed is kept. A recruiter can finish it with you.", details: { aiRunId: result.aiRunId, actions: [askRecruiterAction(row.id)] } } }, 502);
  return c.json({ roleId: result.roleId, version: result.version, packet: result.packet, workflowRunId }, 201);
}

intakeRoutes.post("/sessions/:id/request-approval", requireTenant, (c) => askForApproval(c, false));
/**
 * The older one-step name for the same action, kept for API clients: writes the draft first when there is none (or when
 * the answers moved on and nobody saved a change on it), then asks for approval under the same rules.
 */
intakeRoutes.post("/sessions/:id/compile", requireTenant, (c) => askForApproval(c, true));

/** An owner or admin takes over someone else's draft (C3, founder decision Q6), for example when that person is away or left. */
intakeRoutes.post("/sessions/:id/take-over", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  if (t.staff || (t.role !== "owner" && t.role !== "admin")) throw new HttpError(403, "forbidden", "Only an owner or an admin can take over someone else's draft.");
  const row = await loadDraft(c, c.req.param("id"));
  if (ownerOf(row) === t.userId) throw new HttpError(409, "already_yours", "This draft is already yours.");
  if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside.");
  const container = c.get("container");
  const actor: Actor = actorOf(c);
  const fromUserId = ownerOf(row);
  await withTenant(container.db, t.companyId, async (tx) => {
    await tx.update(intakeSessions).set({ createdBy: actor, createdByUserId: t.userId }).where(eq(intakeSessions.id, row.id));
    await emit(tx, { type: "intake.taken_over", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { from: row.createdBy, fromUserId } });
    // The person who started it hears it from the product, not by finding the draft gone.
    const title = normalizeFacts(row.facts).title ?? row.draftPacket?.identity.title ?? null;
    if (fromUserId) await notify(tx, { companyId: t.companyId, kind: "intake.taken_over", title: `${actor.name ?? "An owner or admin"} took over your draft${title ? `: ${title}` : ""}`, body: "They continue it from here. Nothing was sent to anyone, and the conversation so far is kept with the draft.", userIds: [fromUserId] });
  });
  return c.json({ session: sessionView(await reload(container, t.companyId, row.id), t.userId) });
});

/** "Start over" or "Discard": the conversation stays in the record but no longer resumes. */
intakeRoutes.post("/sessions/:id/abandon", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  await loadDraft(c, c.req.param("id"));
  const result = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [session] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, c.req.param("id"))).limit(1);
    if (!session) throw new HttpError(404, "not_found", "Intake session not found.");
    if (session.status !== "active") return session;
    const [updated] = await tx.update(intakeSessions).set({ status: "abandoned" }).where(eq(intakeSessions.id, session.id)).returning();
    await emit(tx, { type: "intake.abandoned", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: session.id }, payload: { turns: session.messages.length } });
    return updated;
  });
  return c.json(sessionView(result, t.userId));
});

/**
 * The owner conversation (kept as a thin wrapper, C4): there is no keyword guessing any more. For someone who may draft,
 * every message is about a role: it continues their latest draft or starts one (on a plan with room). Someone who may
 * not draft is answered from the brief. A first message that is not about a role leaves no draft behind.
 */
intakeRoutes.post("/conversation/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const body = ConversationMessage.parse(await c.req.json());
  const container = c.get("container");
  if (!mayDraft(t)) {
    const brief = await withTenant(container.db, t.companyId, (tx) => composeBrief(tx, t.companyId, briefViewerOf(t)));
    return c.json({ reply: brief.cards.map((card) => `${card.title}. ${card.body}`).join("\n\n"), proposedActions: brief.cards.flatMap((card) => card.actions.map((a) => ({ kind: "link", label: a.label, path: a.path }))) });
  }
  const actor = actorOf(c);
  const routed = await withTenant(container.db, t.companyId, async (tx): Promise<{ sessionId: string; continuing: boolean }> => {
    const [active] = await tx.select({ id: intakeSessions.id }).from(intakeSessions).where(and(eq(intakeSessions.companyId, t.companyId), eq(intakeSessions.status, "active"), or(eq(intakeSessions.createdByUserId, t.userId), sql`${intakeSessions.createdBy}->>'id' = ${t.userId}`))).orderBy(desc(intakeSessions.updatedAt)).limit(1);
    if (active) return { sessionId: active.id, continuing: true };
    const room = await planRoom(tx, t.companyId);
    if (!room.ok) throw limitReached(t, room);
    const kind = looksLikePastedAd(body.message) ? ("pasted_ad" as const) : ("text" as const);
    return { sessionId: (await startIntakeSession(tx, { companyId: t.companyId, actor, userId: t.userId, message: { content: body.message, kind }, via: "conversation" })).id, continuing: false };
  });
  if (routed.continuing && body.message.length > INTAKE_MESSAGE_MAX) throw messageTooLong(INTAKE_MESSAGE_MAX, { afterFirst: true });
  const r = await turn(container, { companyId: t.companyId, sessionId: routed.sessionId, actor, ...(routed.continuing ? { message: { content: body.message, kind: "text" as const } } : {}) });
  if ("error" in r) return c.json({ reply: "I hit a problem drafting that. Try again, or tap Bring in a recruiter and a person will finish it with you.", intakeSessionId: routed.sessionId, proposedActions: [askRecruiterAction(routed.sessionId)] });
  if (r.notARole) return c.json({ reply: r.turn.assistantMessage, notARole: true, proposedActions: [] });
  const view = sessionView(await reload(container, t.companyId, routed.sessionId), t.userId);
  return c.json({ reply: r.turn.assistantMessage, intakeSessionId: routed.sessionId, readyToCompile: r.turn.readyToCompile, questions: r.turn.questions, readiness: view.readiness, proposedActions: [{ kind: "open_draft", label: "Open the draft", path: `/roles/new?session=${routed.sessionId}` }] });
});
