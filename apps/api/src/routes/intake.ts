import { Hono, type Context } from "hono";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { AI_HELP_BUSY_LINE, ConversationMessage, INTAKE_MESSAGE_MAX, IntakeAnswersRequest, IntakeMessageRequest, KeepPacketFlag, StartIntake, aiHelpLine, type Actor, type IntakeSessionSummary, type PublishResult } from "@ros/contracts";
import { IntakeSessionError, applyIntakeEdit, draftIntake, keepDraftFlag, requestIntakeApproval, runIntakeTurn, sessionView, startIntakeSession, type IntakeDeps, type IntakeSessionRow, type IntakeTurnOutcome } from "@ros/agents";
import { IntakeEditError, aiCreditStanding, assertCan, can, emit, entitlements, looksLikePastedAd, normalizeFacts, notify, packetToFacts } from "@ros/core";
import { entitlements as entitlementRows, events, intakeSessions, rolePackets, roles, withTenant, type Tx } from "@ros/db";
import { actorOf, requireTenant, type Tenant, type Vars } from "../middleware/session";
import { HttpError, messageTooLong } from "../middleware/errors";
import { POLICIES, checkRateLimits } from "../middleware/rate-limit";
import { aiCreditRefusal, aiHelpBusy, aiHelpWordsOf, askForAiHelpOn, refusedForNow, type AiHelpWords } from "../services/ai-credit";
import { briefViewerOf, composeBrief } from "../services/brief";
import { IntakeSuggestRequest, suggestForQuickStart } from "../services/intake-suggest";
import { limitReached } from "../services/plan-room";
import { publishResultOf, publishRole } from "../services/publish";
import type { Container } from "../container";

/**
 * The job builder's API (plan Wave C). Every model call runs between two short transactions (packages/agents/src/
 * intake.ts), so a request never holds a database connection while the model thinks.
 *
 * A draft belongs to the person who started it (founder decision Q6, option A): it carries pay and the reasons for the
 * hire, so only people who may start a hire and see pay reach these routes at all; each person lists and opens their
 * own drafts; owners and admins see every draft and may take one over.
 */
export const intakeRoutes = new Hono<Vars>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether this person may start and open drafts: starting a hire and seeing pay. */
function mayDraft(t: Tenant): boolean {
  return can(t.role, "role.create") && can(t.role, "compensation.read");
}

function assertMayDraft(t: Tenant): void {
  assertCan(t.role, "role.create");
  assertCan(t.role, "compensation.read");
}

const ownerOf = (row: Pick<IntakeSessionRow, "createdByUserId" | "createdBy">): string | null => row.createdByUserId ?? (row.createdBy.kind === "user" ? row.createdBy.id : null);

function mayActOnDraft(t: Tenant, row: IntakeSessionRow): boolean {
  return ownerOf(row) === t.userId || t.role === "owner" || t.role === "admin";
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
    const allowed = mayActOnDraft(t, row);
    return { row, allowed, takenFromMe: !allowed && (await startedBeforeTakeOver(tx, row.id, t.userId)) };
  });
  if (!found) throw new HttpError(404, "not_found", "Intake session not found.");
  if (found.takenFromMe) throw new HttpError(403, "taken_over", "An owner or admin took over this draft, so it is theirs to continue now. Ask them if you need it back.");
  if (!found.allowed) throw new HttpError(403, "not_your_draft", "Someone else on your team started this draft. They can continue it, or an owner or admin can.");
  return found.row;
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

/**
 * A turn as the routes read it. `busy`: refused only for money held by work still running, so nothing is used up. `words`:
 * otherwise, the company's plan and the day its credit starts again, for the line and its button (`aiHelpLine`).
 */
type TurnOutcome = Exclude<IntakeTurnOutcome, { error: string }> | (Extract<IntakeTurnOutcome, { error: string }> & { busy?: boolean; words?: AiHelpWords });

async function turn(container: Container, input: Parameters<typeof runIntakeTurn>[2]): Promise<TurnOutcome> {
  try {
    const r = await runIntakeTurn(container.db, deps(container), input);
    if (!("error" in r) || !r.noCredit) return r;
    const busy = await refusedForNow(container, input.companyId, r.refusedHoldUsd ?? 0);
    return busy ? { ...r, busy } : { ...r, busy, words: await withTenant(container.db, input.companyId, (tx) => aiHelpWordsOf(tx, input.companyId, container.engine.clock())) };
  } catch (err) {
    return sessionErrors(err);
  }
}

/**
 * The turn as the page reads it; a failed turn says what to do next. A turn with no AI credit left
 * failed at nothing: the owner's words are saved, and the way on is to upgrade (`upgrade`), with no "try again";
 * on the last plan, with nothing above it, to talk with ITS or wait for the day it starts again, and the button says so.
 * Refused only for money held by work still running, nothing is used up: the way on is to try again in a few minutes.
 */
function turnReply(r: TurnOutcome) {
  if ("error" in r) {
    if (r.busy) return { error: r.error, recovery: AI_HELP_BUSY_LINE.turn, proposedActions: [] };
    if (r.noCredit) return { error: r.error, recovery: aiHelpLine("turn", r.words), proposedActions: [askForAiHelpOn(r.words?.planKey)], upgrade: true };
    return { error: r.error, recovery: "Try again.", proposedActions: [] };
  }
  return { ...r.turn, benchmark: r.benchmark, benchmarkGap: r.benchmarkGap };
}

/**
 * A company with no room stops spending on a job it could not post: the AI routes on a draft that has no role yet (writing
 * it, changing it by chat) answer as the start of a draft does, before any model call. A draft that already made its role
 * holds its place, and so does everything done on that role afterwards. Shared with the draft tools in role-packets.ts.
 */
export async function assertRoomForDraft(c: Context<Vars>, row: IntakeSessionRow): Promise<void> {
  if (row.roleId) return;
  const t = c.get("tenant")!;
  const container = c.get("container");
  const room = await withTenant(container.db, t.companyId, (tx) => planRoom(tx, t.companyId, { now: container.engine.clock() }));
  if (!room.ok) throw limitReached(t, room);
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
    const room = await planRoom(tx, t.companyId, { now: container.engine.clock(), newDraft: true });
    if (!room.ok) throw limitReached(t, room);
    const seed = body.fromRoleId ? await hireAgainSeed(tx, body.fromRoleId) : null;
    const message = body.initialMessage
      ? { content: body.initialMessage, kind: looksLikePastedAd(body.initialMessage) ? ("pasted_ad" as const) : ("text" as const) }
      : { content: `Hire again: ${seed!.title}.`, kind: "hire_again" as const };
    return startIntakeSession(tx, { companyId: t.companyId, actor, userId: t.userId, message, facts: seed?.facts, fromRole: seed?.fromRole, via: seed ? "hire_again" : "start" });
  });
  const r = await turn(container, { companyId: t.companyId, sessionId: started.id, actor });
  if (!("error" in r) && r.notARole) return c.json({ session: null, notARole: true, reply: turnReply(r) }, 200);
  return c.json({ session: sessionView(await reload(container, t.companyId, started.id), t.userId), reply: turnReply(r) }, 201);
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
  const everyone = !mine && (t.role === "owner" || t.role === "admin");
  const out = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const own = or(eq(intakeSessions.createdByUserId, t.userId), sql`${intakeSessions.createdBy}->>'id' = ${t.userId}`);
    const rows = await tx.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, t.companyId), eq(intakeSessions.status, "active"), ...(everyone ? [] : [own]))).orderBy(desc(intakeSessions.updatedAt));
    return { sessions: rows.map((r) => summaryOf(r, t.userId)), room: await planRoom(tx, t.companyId, { now: c.get("container").engine.clock(), newDraft: true }) };
  });
  return c.json(out);
});

/**
 * Suggestions for the quick start (Wave S3, G3): must-have skills and yes/no questions from the answers so far, for a
 * job our hiring guides do not know. Only the job's facts go in, never anything about a candidate; every line passed the
 * fairness word check, and refused ones are left out. Same people as starting a draft; no draft is made and the plan's
 * room is not used. A failed or slow run answers with no suggestions (`unavailable: true`), never an error the page must show;
 * so does a person or a company over the hourly allowance of model calls for this (POLICIES.intakeSuggest), and a company
 * with no room for another job, which spends nothing here (the page already shows it the room's own alert).
 */
intakeRoutes.post("/suggestions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  const body = IntakeSuggestRequest.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const room = await withTenant(container.db, t.companyId, (tx) => planRoom(tx, t.companyId, { now: container.engine.clock() }));
  if (!room.ok || (await checkRateLimits(c, [POLICIES.intakeSuggest]))) return c.json({ mustHaves: [], questions: [], unavailable: true as const });
  return c.json(await suggestForQuickStart(container, { companyId: t.companyId, userId: t.userId, body }));
});

/** Room on the plan for another role, when the new-role page opens (C13). */
intakeRoutes.get("/room", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  return c.json(await withTenant(c.get("container").db, t.companyId, (tx) => planRoom(tx, t.companyId, { now: c.get("container").engine.clock(), newDraft: true })));
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
  return c.json({ session: sessionView(await reload(container, t.companyId, c.req.param("id")), t.userId), reply: turnReply(r) });
});

/**
 * Tapped answers, panel edits and "draft it" (C6, C7). The answers set the facts (set / add / remove), one short summary
 * goes into the conversation, and the assistant takes its next turn unless `reply` is false. `refused` lists anything
 * typed that failed the fairness check: it was not used, and the reason says why. `dealBreakersOffered` (the quick start):
 * the edit's deal-breakers were already offered as must-haves, so the builder's card never offers them again.
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
    edit = await applyIntakeEdit(container.db, { companyId: t.companyId, sessionId, actor, answers: body.answers, patch: body.patch, draftIt: body.draftIt, note: body.note, dealBreakersOffered: body.dealBreakersOffered });
  } catch (err) {
    return sessionErrors(err);
  }
  const r = body.reply ? await turn(container, { companyId: t.companyId, sessionId, actor }) : null;
  return c.json({ session: sessionView(await reload(container, t.companyId, sessionId), t.userId), reply: r ? turnReply(r) : null, refused: edit.refused, summary: edit.summary });
});

/**
 * Writes the draft beside the conversation (C7, founder decision Q8): allowed once the essentials are in, or after one
 * round of questions, or when the owner said "draft it". No role is created and nobody is asked to approve anything.
 * While it runs, GET /sessions/:id shows `progress.stage` moving through benchmark, writing and checking (the checks and
 * the save), then done. Writing it again replaces what was saved on the draft since and the answers do not hold
 * (`readiness.draftEdits` counts those changes), so the page asks first. A company with no room for another job is
 * refused first (`assertRoomForDraft`): this is the dearest
 * call the job builder makes, and so the first the AI credit stops, with everything confirmed kept (`creditRefusedDraft`).
 */
intakeRoutes.post("/sessions/:id/draft", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside.");
  await assertRoomForDraft(c, row);
  const view = sessionView(row, t.userId);
  if (!view.readiness.mayDraft) throw new HttpError(409, "not_ready", view.readiness.draftBlocker ?? "Not ready to draft yet.", { readiness: view.readiness });
  const container = c.get("container");
  let out: Awaited<ReturnType<typeof draftIntake>>;
  try {
    out = await draftIntake(container.db, deps(container), { companyId: t.companyId, sessionId: row.id, actor: actorOf(c) });
  } catch (err) {
    return sessionErrors(err);
  }
  if ("error" in out) {
    if (out.noCredit) throw await creditRefusedDraft(c, out.refusedHoldUsd ?? 0);
    throw new HttpError(502, "ai_failed", "The assistant could not write the draft. Everything you confirmed is kept. Try again.", { aiRunId: out.aiRunId, actions: [] });
  }
  return c.json({ session: sessionView(await reload(container, t.companyId, row.id), t.userId), draft: out.draft });
});

/**
 * The draft refused for want of AI credit. It holds more than any other call, so it stops while a little is left: then
 * saying "used up" would be false beside the percentage in Settings, and the line says what is true. Read from money actually
 * spent, and refused only for the holds of work still running, it says to try again in a few minutes.
 */
async function creditRefusedDraft(c: Context<Vars>, holdUsd: number): Promise<HttpError> {
  const t = c.get("tenant")!;
  const container = c.get("container");
  if (await refusedForNow(container, t.companyId, holdUsd)) return aiHelpBusy(AI_HELP_BUSY_LINE.draft);
  const now = container.engine.clock();
  const { standing, words } = await withTenant(container.db, t.companyId, async (tx) => ({ standing: await aiCreditStanding(tx, t.companyId, { now, settled: true }), words: await aiHelpWordsOf(tx, t.companyId, now) }));
  return aiCreditRefusal(t, aiHelpLine(standing && !standing.usedUp ? "draftTooBig" : "draft", words), words.planKey);
}

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
 * "Publish job" on a draft: creates the job and its version 1 from the draft the person checked and opens it, in one
 * transaction (services/publish.ts runs the publish checks: the person's role, the plan, the wording flags, the legal
 * check). Refused with 409 `not_ready` and what is left, in plain words, until the draft is up to date with the answers,
 * the essentials are in and a person set or confirmed the pay. The plan's room is checked before anything runs and again
 * in that transaction, where the place is recorded; all of it commits together or not at all. A second press answers
 * with the job the first one made. Answers 201 `PublishResult`.
 */
intakeRoutes.post("/sessions/:id/publish", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id") ?? "");
  const container = c.get("container");
  const actor = actorOf(c);
  const first = row.roleId ? null : await withTenant(container.db, t.companyId, (tx) => planRoom(tx, t.companyId, { now: container.engine.clock() }));
  if (first && !first.ok) throw limitReached(t, first);
  const made: { result: PublishResult | null } = { result: null };
  let compiled: Awaited<ReturnType<typeof requestIntakeApproval>>;
  try {
    compiled = await requestIntakeApproval(container.db, deps(container), { companyId: t.companyId, sessionId: row.id, actor, hiringManagerUserId: t.userId }, {
      finalize: async (tx, job) => {
        // Two drafts published at once take turns on the plan's count, so together they never go past it.
        await tx.select({ id: entitlementRows.id }).from(entitlementRows).where(and(eq(entitlementRows.companyId, t.companyId), eq(entitlementRows.key, "active_roles"))).for("update");
        made.result = await publishRole(tx, container, { tenant: t, actor, roleId: job.roleId });
        await entitlements.record(tx, t.companyId, "active_roles", 1, "role", { roleId: job.roleId });
      },
    });
  } catch (err) {
    return sessionErrors(err);
  }
  if ("notReady" in compiled) throw new HttpError(409, "not_ready", `Not ready to publish yet. ${compiled.notReady.join(" ")}`, { blockers: compiled.notReady });
  if ("error" in compiled) return c.json({ error: { code: "ai_failed", message: "The assistant could not write the draft. Everything you confirmed is kept. Try again.", details: { aiRunId: compiled.aiRunId, actions: [] } } }, 502);
  // The job existed already: answered as it stands when it is published, and published now when it is still a draft.
  const roleId = compiled.roleId;
  const result = made.result ?? (await withTenant(container.db, t.companyId, async (tx) => (await publishResultOf(tx, container, roleId)) ?? publishRole(tx, container, { tenant: t, actor, roleId })));
  await container.kick();
  return c.json(result, 201);
});
/** An owner or admin takes over someone else's draft (C3, founder decision Q6), for example when that person is away or left. */
intakeRoutes.post("/sessions/:id/take-over", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertMayDraft(t);
  if (t.role !== "owner" && t.role !== "admin") throw new HttpError(403, "forbidden", "Only an owner or an admin can take over someone else's draft.");
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
    const room = await planRoom(tx, t.companyId, { now: container.engine.clock(), newDraft: true });
    if (!room.ok) throw limitReached(t, room);
    const kind = looksLikePastedAd(body.message) ? ("pasted_ad" as const) : ("text" as const);
    return { sessionId: (await startIntakeSession(tx, { companyId: t.companyId, actor, userId: t.userId, message: { content: body.message, kind }, via: "conversation" })).id, continuing: false };
  });
  if (routed.continuing && body.message.length > INTAKE_MESSAGE_MAX) throw messageTooLong(INTAKE_MESSAGE_MAX, { afterFirst: true });
  const r = await turn(container, { companyId: t.companyId, sessionId: routed.sessionId, actor, ...(routed.continuing ? { message: { content: body.message, kind: "text" as const } } : {}) });
  if ("error" in r && r.busy) return c.json({ reply: AI_HELP_BUSY_LINE.turn, intakeSessionId: routed.sessionId, proposedActions: [] });
  if ("error" in r && r.noCredit) return c.json({ reply: aiHelpLine("turn", r.words), intakeSessionId: routed.sessionId, proposedActions: [askForAiHelpOn(r.words?.planKey)], upgrade: true });
  if ("error" in r) return c.json({ reply: "I hit a problem drafting that. Try again.", intakeSessionId: routed.sessionId, proposedActions: [] });
  if (r.notARole) return c.json({ reply: r.turn.assistantMessage, notARole: true, proposedActions: [] });
  const view = sessionView(await reload(container, t.companyId, routed.sessionId), t.userId);
  return c.json({ reply: r.turn.assistantMessage, intakeSessionId: routed.sessionId, readyToCompile: r.turn.readyToCompile, questions: r.turn.questions, readiness: view.readiness, proposedActions: [{ kind: "open_draft", label: "Open the draft", path: `/roles/new?session=${routed.sessionId}` }] });
});
