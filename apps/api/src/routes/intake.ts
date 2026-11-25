import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  AI_HELP_BUSY_LINE, DraftFieldEdit, IntakeAnswersRequest, IntakeMessageRequest, KeepPacketFlag, SetClosingDate, StartIntake, aiHelpLine, draftTitleOf, isOwnerOrAdmin,
  type Actor, type DraftSaved, type IntakeDraftAnswer, type IntakeSessionList, type IntakeSessionResponse, type IntakeStartResponse, type IntakeTurnReply, type IntakeTurnResponse,
} from "@ros/contracts";
import { IntakeSessionError, applyIntakeAnswers, draftIntake, jobFromDraft, keepDraftFlag, runIntakeTurn, saveDraftEdit, sessionView, startIntakeSession, type IntakeSessionRow, type IntakeTurnOutcome } from "@ros/agents";
import { IntakeEditError, aiCreditStanding, assertCan, can, closingDateProblem, draftOwnerId, emit, entitlements, looksLikePastedAd, normalizeFacts, notify } from "@ros/core";
import { companies, entitlements as entitlementRows, events, intakeSessions, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, type Tenant, type Vars } from "../middleware/session";
import { aiCreditRefusal, aiHelpBusy, aiHelpWordsOf, askForAiHelpOn, refusedForNow, type AiHelpWords } from "../services/ai-credit";
import { ASSISTANT_UNAVAILABLE_LINE, assistantAnswered, assistantUnavailable } from "../services/assistant-unavailable";
import { draftSummaries } from "../services/drafts";
import { applyFieldEdit } from "../services/packet-fields";
import { limitReached, planRoom } from "../services/plan-room";
import { draftChecks, draftClosingDate, publishResultOf, publishRole } from "../services/publish";

/**
 * The job builder's API. One way in: a draft starts with the owner's idea or a pasted ad; the assistant asks for what is
 * missing on cards; "Write the job" writes it; the one editor changes it; "Publish job" makes it a job, open. Every
 * model call runs between two short transactions (packages/agents/src/intake.ts), so a request never holds a database
 * connection while the model thinks.
 *
 * A draft belongs to the person who started it: each person lists and opens their own drafts; owners and admins see
 * every draft of the company and may take one over.
 */
export const intakeRoutes = new Hono<Vars>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = () => new HttpError(404, "not_found", "Draft not found.");
const NOT_ACTIVE = () => new HttpError(409, "not_active", "This draft has already become a job, or it was set aside. Start a new one for another hire.");
const NO_DRAFT = () => new HttpError(409, "no_draft", "Write the job first; then you can change it.");

/** Whether this person started the draft before an owner or admin took it over (the take-over event names them). */
async function startedBeforeTakeOver(tx: Tx, sessionId: string, userId: string): Promise<boolean> {
  const [hit] = await tx.select({ id: events.id }).from(events).where(and(eq(events.type, "intake.taken_over"), eq(events.subjectType, "intake_session"), eq(events.subjectId, sessionId), sql`${events.payload}->>'fromUserId' = ${userId}`)).limit(1);
  return !!hit;
}

/** The draft the caller may open, refused plainly before any model call is made for it. */
export async function loadDraft(c: Context<Vars>, sessionId: string): Promise<IntakeSessionRow> {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  if (!UUID.test(sessionId)) throw NOT_FOUND();
  const found = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [row] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
    if (!row) return null;
    const allowed = draftOwnerId(row) === t.userId || isOwnerOrAdmin(t.role);
    return { row, allowed, takenFromMe: !allowed && (await startedBeforeTakeOver(tx, row.id, t.userId)) };
  });
  if (!found) throw NOT_FOUND();
  if (found.takenFromMe) throw new HttpError(403, "taken_over", "An owner or admin took over this draft, so it is theirs to continue now. Ask them if you need it back.");
  if (!found.allowed) throw new HttpError(403, "not_your_draft", "Someone else on your team started this draft. They can continue it, or an owner or admin can.");
  return found.row;
}

/**
 * The draft as the builder reads it, read afresh: with the legal check of the written job, the plan's room and the
 * closing date chosen for it, so `readiness.publish` lists every reason it cannot be published yet. Beside it, the
 * company's time zone, in which the page counts "today" for that closing date, as the closing-date route below checks it.
 */
async function draftAnswer(container: Container, t: Tenant, sessionId: string): Promise<IntakeDraftAnswer> {
  return withTenant(container.db, t.companyId, async (tx) => {
    const [row] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
    if (!row) throw NOT_FOUND();
    const checks = await draftChecks(tx, { companyId: t.companyId, sessionId: row.id, active: row.status === "active", draft: row.draftPacket ?? null, now: container.engine.clock() });
    return { session: sessionView(row, t.userId, checks), timeZone: checks.timeZone };
  });
}

/** Maps the agent's and the rules' errors onto the API's answers. */
function sessionErrors(err: unknown): never {
  if (err instanceof IntakeSessionError) throw err.code === "not_found" ? NOT_FOUND() : err.code === "no_draft" ? NO_DRAFT() : NOT_ACTIVE();
  if (err instanceof IntakeEditError) throw new HttpError(400, err.code, err.message);
  throw err;
}

/**
 * A turn as the routes read it. `busy`: refused only for money held by work still running. `words`: the company's plan
 * and the day its credit starts again. `unavailable`: the AI provider itself is the problem (services/assistant-unavailable.ts).
 */
type TurnOutcome = IntakeTurnOutcome & { busy?: boolean; words?: AiHelpWords; unavailable?: boolean };

/**
 * One turn, for every route that takes one (a new draft, a message, tapped answers). A turn the model answered resolves
 * the alert that the assistant is not available, if one stands; a turn that failed because of the provider raises it.
 */
async function turn(container: Container, input: Parameters<typeof runIntakeTurn>[2]): Promise<TurnOutcome> {
  try {
    const r = await runIntakeTurn(container.db, { ai: container.ai }, input);
    if (!("error" in r)) {
      await assistantAnswered(container);
      return r;
    }
    if (!r.noCredit) return (await assistantUnavailable(container, { error: r.error, task: "intake.turn", aiRunId: r.aiRunId })) ? { ...r, unavailable: true } : r;
    if (await refusedForNow(container, input.companyId, r.refusedHoldUsd ?? 0)) return { ...r, busy: true };
    return { ...r, words: await withTenant(container.db, input.companyId, (tx) => aiHelpWordsOf(tx, input.companyId, container.engine.clock())) };
  } catch (err) {
    return sessionErrors(err);
  }
}

/**
 * The turn as the page reads it; a failed turn says what to do next. With no AI credit left nothing failed: the owner's
 * words are saved, and the way on is to upgrade (`upgrade`, with the request this person may send), never "try again".
 * Refused only for money held by work still running, the way on is to try again in a few minutes. When the AI provider
 * itself is the problem (`unavailable`), trying again at once would fail the same way: the page shows the one sentence
 * as it is, and an administrator has been alerted. Any other failure keeps "Try again".
 */
function turnReply(r: TurnOutcome, t: Pick<Tenant, "role">): IntakeTurnReply {
  if (!("error" in r)) return { assistantMessage: r.turn.assistantMessage, takenFromAd: r.turn.takenFromAd, notARole: r.notARole };
  if (r.busy) return { error: "The assistant did not answer.", recovery: AI_HELP_BUSY_LINE.turn, upgrade: false, ask: null };
  if (r.noCredit) return { error: "The assistant did not answer.", recovery: aiHelpLine("turn", r.words), upgrade: true, ask: can(t.role, "plan.request") ? askForAiHelpOn(r.words?.planKey) : null };
  if (r.unavailable) return { error: "The assistant is not available right now.", recovery: ASSISTANT_UNAVAILABLE_LINE, upgrade: false, ask: null, unavailable: true };
  return { error: "The assistant could not answer that.", recovery: "Your words are saved. Try again.", upgrade: false, ask: null };
}

/** A company with no room for another job is refused before any model is called for a draft that is not a job yet. */
async function assertRoom(c: Context<Vars>, opts: { newDraft?: boolean } = {}): Promise<void> {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const room = await withTenant(container.db, t.companyId, (tx) => planRoom(tx, t.companyId, { now: container.engine.clock(), ...opts }));
  if (!room.ok) throw limitReached(t, room);
}

/**
 * Starts a draft together with its first message: the owner's idea in a sentence, or a pasted job ad. The plan's room
 * is checked first, so no draft and no assistant run happen on a full plan. The answer carries the draft and the
 * assistant's first turn; a first message that is not about hiring leaves no draft behind (`session: null`).
 */
intakeRoutes.post("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const body = StartIntake.parse(await c.req.json().catch(() => ({})));
  await assertRoom(c, { newDraft: true });
  const container = c.get("container");
  const actor = actorOf(c);
  const started = await withTenant(container.db, t.companyId, (tx) => startIntakeSession(tx, { companyId: t.companyId, actor, userId: t.userId, message: { content: body.initialMessage, kind: looksLikePastedAd(body.initialMessage) ? "pasted_ad" : "text" } }));
  const r = await turn(container, { companyId: t.companyId, sessionId: started.id, actor });
  if (!("error" in r) && r.notARole) return c.json({ session: null, notARole: true, reply: turnReply(r, t) } satisfies IntakeStartResponse, 200);
  return c.json({ ...(await draftAnswer(container, t, started.id)), notARole: false, reply: turnReply(r, t) } satisfies IntakeStartResponse, 201);
});

/**
 * Drafts in progress, newest first: `?mine=1` lists the caller's own; without it, owners and admins see every draft of
 * the company (so they can pick one up), and everyone else still sees only their own. The plan's room comes along. Each
 * line is the one summary Home shows too (services/drafts.ts).
 */
intakeRoutes.get("/sessions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.create");
  const everyone = !["1", "true"].includes(c.req.query("mine") ?? "") && isOwnerOrAdmin(t.role);
  const container = c.get("container");
  const out = await withTenant(container.db, t.companyId, async (tx): Promise<IntakeSessionList> => {
    return { sessions: await draftSummaries(tx, { companyId: t.companyId, userId: t.userId, everyone }), room: await planRoom(tx, t.companyId, { now: container.engine.clock(), newDraft: true }) };
  });
  return c.json(out);
});

intakeRoutes.get("/sessions/:id", requireTenant, async (c) => {
  const row = await loadDraft(c, c.req.param("id"));
  return c.json((await draftAnswer(c.get("container"), c.get("tenant")!, row.id)) satisfies IntakeSessionResponse);
});

intakeRoutes.post("/sessions/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const body = IntakeMessageRequest.parse(await c.req.json());
  const container = c.get("container");
  const r = await turn(container, { companyId: t.companyId, sessionId: row.id, message: { content: body.message, kind: "text" }, actor: actorOf(c) });
  return c.json({ ...(await draftAnswer(container, t, row.id)), reply: turnReply(r, t), refused: [], summary: [] } satisfies IntakeTurnResponse);
});

/**
 * Tapped answers to the open cards, and any words typed beside them. The answers set the facts, one short summary goes
 * into the conversation, and the assistant takes its next turn. `refused` lists anything that failed the fairness
 * check: it was not used, and the reason says why.
 */
intakeRoutes.post("/sessions/:id/answers", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const body = IntakeAnswersRequest.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  let edit: Awaited<ReturnType<typeof applyIntakeAnswers>>;
  try {
    edit = await applyIntakeAnswers(container.db, { companyId: t.companyId, sessionId: row.id, actor, answers: body.answers, note: body.note });
  } catch (err) {
    return sessionErrors(err);
  }
  const r = await turn(container, { companyId: t.companyId, sessionId: row.id, actor });
  return c.json({ ...(await draftAnswer(container, t, row.id)), reply: turnReply(r, t), refused: edit.refused, summary: edit.summary } satisfies IntakeTurnResponse);
});

/**
 * "Write the job": needs every essential and pay a person set or confirmed (409 `not_ready`, with the readiness). While
 * it runs, GET /sessions/:id shows `progress.stage` moving through writing and checking to done. Writing it again
 * replaces what a person edited on it since (`readiness.draftEdits` counts those), so the page asks first. This is the
 * dearest call the job builder makes: a company with no room for another job is refused first, and with too little AI
 * credit left everything confirmed is kept. A writing that failed answers 502: `assistant_unavailable` when the AI
 * provider itself is the problem (an administrator is alerted, and the message never says "Try again"), `ai_failed` for
 * anything else.
 */
intakeRoutes.post("/sessions/:id/draft", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  if (row.status !== "active") throw NOT_ACTIVE();
  await assertRoom(c);
  const container = c.get("container");
  const { session: view } = await draftAnswer(container, t, row.id);
  if (!view.readiness.mayDraft) throw new HttpError(409, "not_ready", view.readiness.draftBlocker ?? "The job cannot be written yet.", { readiness: view.readiness });
  let out: Awaited<ReturnType<typeof draftIntake>>;
  try {
    out = await draftIntake(container.db, { ai: container.ai }, { companyId: t.companyId, sessionId: row.id, actor: actorOf(c) });
  } catch (err) {
    return sessionErrors(err);
  }
  if ("error" in out) {
    if (out.noCredit) throw await creditRefusedDraft(c, out.refusedHoldUsd ?? 0);
    // The AI provider itself is the problem: said as it is, with an alert for an administrator, and never "Try again".
    if (await assistantUnavailable(container, { error: out.error, task: "intake.compile", aiRunId: out.aiRunId })) throw new HttpError(502, "assistant_unavailable", ASSISTANT_UNAVAILABLE_LINE, { aiRunId: out.aiRunId });
    throw new HttpError(502, "ai_failed", "The assistant could not write the job. Everything you confirmed is kept. Try again.", { aiRunId: out.aiRunId });
  }
  await assistantAnswered(container);
  return c.json((await draftAnswer(container, t, row.id)) satisfies IntakeSessionResponse);
});

/**
 * The writing refused for want of AI credit. It holds more than any other call, so it stops while a little is left:
 * then saying "used up" would be false beside the percentage in Settings, and the line says what is true. Refused only
 * for the holds of work still running, it says to try again in a few minutes.
 */
async function creditRefusedDraft(c: Context<Vars>, holdUsd: number): Promise<HttpError> {
  const t = c.get("tenant")!;
  const container = c.get("container");
  if (await refusedForNow(container, t.companyId, holdUsd)) return aiHelpBusy(AI_HELP_BUSY_LINE.draft);
  const now = container.engine.clock();
  const { standing, words } = await withTenant(container.db, t.companyId, async (tx) => ({ standing: await aiCreditStanding(tx, t.companyId, { now, settled: true }), words: await aiHelpWordsOf(tx, t.companyId, now) }));
  return aiCreditRefusal(t, aiHelpLine(standing && !standing.usedUp ? "draftTooBig" : "draft", words), words.planKey);
}

/**
 * The one editor on a written job that is not published yet. The edit is always saved; wording the fairness guard flags
 * is listed on the draft and holds publishing until it is changed or kept with a reason. A form question about a
 * protected characteristic is refused (422 `question_not_allowed`).
 */
intakeRoutes.patch("/sessions/:id/draft", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const body = DraftFieldEdit.parse(await c.req.json());
  const container = c.get("container");
  let saved: { guardChanges: string[] };
  try {
    saved = await saveDraftEdit(container.db, {
      companyId: t.companyId, sessionId: row.id, actor: actorOf(c),
      edit: (draft) => {
        const edit = applyFieldEdit(draft, body);
        if (!edit.fields.length) throw new HttpError(400, "nothing_changed", "Nothing was changed.");
        return edit.packet;
      },
    });
  } catch (err) {
    return sessionErrors(err);
  }
  return c.json({ ...(await draftAnswer(container, t, row.id)), guardChanges: saved.guardChanges } satisfies DraftSaved);
});

/** Keeps a flagged phrase in the written job, with the person's reason; publishing no longer waits on it. */
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
  if (!kept.found) throw new HttpError(404, "flag_not_found", "That flagged wording is no longer on the job.");
  return c.json((await draftAnswer(container, t, row.id)) satisfies IntakeSessionResponse);
});

/**
 * The closing date chosen in the job builder, kept with the draft on the server as a `role.closing_date_set` event on
 * it, and set on the job when it is published. An owner or an admin sets it, like a job's own closing date; null takes
 * it off.
 */
intakeRoutes.put("/sessions/:id/closing-date", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = SetClosingDate.parse(await c.req.json());
  const row = await loadDraft(c, c.req.param("id"));
  if (row.status !== "active") throw NOT_ACTIVE();
  const container = c.get("container");
  await withTenant(container.db, t.companyId, async (tx) => {
    if (body.closesOn) {
      const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
      const problem = closingDateProblem(body.closesOn, container.engine.clock(), company?.timezone);
      if (problem) throw new HttpError(400, "bad_closing_date", problem);
    }
    const previous = await draftClosingDate(tx, row.id);
    if (previous !== body.closesOn) await emit(tx, { type: "role.closing_date_set", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: row.id }, payload: { closesOn: body.closesOn, previous, draft: true } });
  });
  return c.json((await draftAnswer(container, t, row.id)) satisfies IntakeSessionResponse);
});

/**
 * "Publish job" on a draft: makes the job and its version 1 from the job the person checked and opens it, in one
 * transaction. Refused for the plan first (402), then with every other reason at once (409 `not_ready`,
 * `details.blockers`): an essential missing, pay nobody confirmed, the job not written or out of date with the answers,
 * flagged wording, the legal check. Two drafts published at once take turns on the plan's count, so together they never
 * go past it. A second press answers with the job the first one made. Answers 201 `PublishResult`.
 */
intakeRoutes.post("/sessions/:id/publish", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const container = c.get("container");
  const actor = actorOf(c);
  if (!row.roleId) {
    if (row.status !== "active") throw NOT_ACTIVE();
    await assertRoom(c);
    const { blockers } = (await draftAnswer(container, t, row.id)).session.readiness.publish;
    if (blockers.length) throw new HttpError(409, "not_ready", `This job cannot be published yet. ${blockers.map((b) => b.message).join(" ")}`, { blockers });
  }
  let result: Awaited<ReturnType<typeof publishRole>>;
  try {
    result = await withTenant(container.db, t.companyId, async (tx) => {
      await tx.select({ id: entitlementRows.id }).from(entitlementRows).where(and(eq(entitlementRows.companyId, t.companyId), eq(entitlementRows.key, "active_roles"))).for("update");
      const made = await jobFromDraft(tx, { companyId: t.companyId, sessionId: row.id, actor });
      if ("blockers" in made) throw new HttpError(409, "not_ready", `This job cannot be published yet. ${made.blockers.map((b) => b.message).join(" ")}`, { blockers: made.blockers });
      // The job existed already: answered as it stands when it is published, and published now when it is still a draft.
      if (!made.created) return (await publishResultOf(tx, container, made.roleId)) ?? publishRole(tx, container, { tenant: t, actor, roleId: made.roleId });
      const published = await publishRole(tx, container, { tenant: t, actor, roleId: made.roleId });
      await entitlements.record(tx, t.companyId, "active_roles", 1, "role", { roleId: made.roleId });
      return published;
    });
  } catch (err) {
    return sessionErrors(err);
  }
  await container.kick();
  return c.json(result, 201);
});

/** An owner or admin takes over someone else's draft, for example when that person is away or left. */
intakeRoutes.post("/sessions/:id/take-over", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const row = await loadDraft(c, c.req.param("id"));
  if (draftOwnerId(row) === t.userId) throw new HttpError(409, "already_yours", "This draft is already yours.");
  if (row.status !== "active") throw NOT_ACTIVE();
  const container = c.get("container");
  const actor: Actor = actorOf(c);
  const fromUserId = draftOwnerId(row);
  await withTenant(container.db, t.companyId, async (tx) => {
    await tx.update(intakeSessions).set({ createdBy: actor, createdByUserId: t.userId }).where(eq(intakeSessions.id, row.id));
    await emit(tx, { type: "intake.taken_over", companyId: t.companyId, actor, subject: { type: "intake_session", id: row.id }, payload: { from: row.createdBy, fromUserId } });
    // The person who started it hears it from the product, not by finding the draft gone.
    const title = draftTitleOf({ facts: normalizeFacts(row.facts), draft: row.draftPacket });
    if (fromUserId) await notify(tx, { companyId: t.companyId, kind: "intake.taken_over", title: `${actor.name ?? "An owner or admin"} took over your draft${title ? `: ${title}` : ""}`, body: "They continue it from here. Nothing was sent to anyone, and the conversation so far is kept with the draft.", userIds: [fromUserId] });
  });
  return c.json((await draftAnswer(container, t, row.id)) satisfies IntakeSessionResponse);
});

/** "Discard": the draft is set aside; the conversation stays in the record but no longer resumes. */
intakeRoutes.post("/sessions/:id/abandon", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const row = await loadDraft(c, c.req.param("id"));
  const container = c.get("container");
  await withTenant(container.db, t.companyId, async (tx) => {
    const [updated] = await tx.update(intakeSessions).set({ status: "abandoned" }).where(and(eq(intakeSessions.id, row.id), eq(intakeSessions.status, "active"))).returning({ id: intakeSessions.id });
    if (updated) await emit(tx, { type: "intake.abandoned", companyId: t.companyId, actor: actorOf(c), subject: { type: "intake_session", id: row.id }, payload: { turns: row.messages.length } });
  });
  return c.json((await draftAnswer(container, t, row.id)) satisfies IntakeSessionResponse);
});
