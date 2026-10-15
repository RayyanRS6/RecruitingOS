import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, SCREEN_PERSON_ROUTE_STATUSES, type Actor, type ReviewItem, type RolePacket, type ScreenProgress, type ScreenStatus, type ScreenTranscriptEntry, type ScreenTurn, type TapAnswer, type TapFormat, type UnconfirmedIntent } from "@ros/contracts";
import { runPromptDetached, screenTurnPrompt, type AiRuntime, type RunOutcome, type ScreenContext } from "@ros/ai";
import {
  EMPTY_SCREEN_PROGRESS, MOVED_ON_MESSAGE, REVIEW_MESSAGE, SCREEN_COMPLETE_MESSAGE, SKIPPED_MESSAGE, TURN_CAP_REVIEW_MESSAGE, WITHDRAW_CONFIRM_KEY, advanceProgress, modelTurnCap, modelTurnsUsed, answerWithdrawPrompt, answersOf, countConversation, createScreen, currentQuestion, declineConversation, editScreenAnswer, enforceTurnRules, flagAllowance,
  isFocusKey, loadScreenBundle, nextQuestion, pausedMessage, redactProtected, requestHuman, reviewItems, runScreenTurn, screenCommand, screenContextOf, screenIntro, sendConversationForLater, sendRepeatConfirmation,
  sendRepeatConversationLater, sendRepeatConversationResume, startScreenConversation, statusUrlFor, submitScreenAnswers, tapWords, withFocusAnswer, withdrawPending, withdrawnMessage, type AllowanceNote, type ScreenDeps, type ScreenIntro, type TurnResult,
} from "@ros/agents";
import { addBusinessHours, deadlineWords, emit, entitlements, evaluateEligibility, humanResponseExpectation, loadBusinessCalendar, oneVisitPolicyAllows, resolveApplyMode, resolvePolicy, tapFormatFor, transition } from "@ros/core";
import { applications, candidates, communications, companies, randomToken, rolePackets, roles, screens, unconfirmedScreens, withTenant, workflowRuns, type Db, type Tx } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import type { WorkflowEngine } from "@ros/workflows";
import type { Container } from "../container";
import { recordWithdrawal } from "./applications";
import { screenDeps } from "./screens";

/**
 * Applying and the screening conversation in one visit (plan Wave E, item E1; founder decision B1/Q15).
 *
 * `startApplyConversation` runs inside the apply page's transaction, right after `createApplication`, and says what the
 * page shows next: the conversation's introduction (Start, Do this later, I'd rather talk to a person), or the receipt.
 *
 * Repeat submissions (Q14 x Q15), design (a): anyone can type anyone's address, so a second application from an address
 * that already applied for the role must look exactly like a first one and change nothing. It gets the same introduction
 * and conversation, bound to a detached, unconfirmed session (`unconfirmed_screens`) that never touches the real
 * application: no stage, no screen, no message thread, no history entry, no allowance. When it ends, the address on
 * file gets an email; only if its owner opens the link and confirms are the answers (or the request for a person) added
 * to their application. Unconfirmed, what was typed is wiped after seven days. A withdrawal asked for inside it is never
 * carried out from there: the email points the address owner to their own status page. A first application to another
 * role from an address the company already knows gets the same detached conversation (known-bugs row 17): a stranger
 * never sees the first name on file, and their answers never join the real person's record unconfirmed.
 *
 * The page reads a conversation by its link with `findConversation` and `conversationView`, and acts on it with the
 * `conversation*` functions, without knowing which kind it is: both render and behave the same.
 */

type Application = typeof applications.$inferSelect;
type Candidate = typeof candidates.$inferSelect;
type Role = typeof roles.$inferSelect;
type Company = typeof companies.$inferSelect;
type Unconfirmed = typeof unconfirmedScreens.$inferSelect;

/** How long a repeat submission's words wait for the address owner to confirm them. */
export const UNCONFIRMED_DAYS = 7;
/** A conversation offered with the application: reminded after 48 hours, expired 72 hours after that. */
const SCREEN_LINK_HOURS = 48 + 72;
const PAUSE_RETRY_MINUTES = 30;
const PAUSE_GIVE_UP_HOURS = 24;
const HOUR = 3600_000;
const ACTIVE = new Set<string>(SCREEN_ACTIVE_STATUSES);
const WEB_ACTOR: Actor = { kind: "system", id: "screen_web" };
const APPLY_ACTOR: Actor = { kind: "system", id: "apply_page" };

/* ------------------------------------------------------------------------------------------------------------ */
/* The apply page's next step                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What the apply page shows after the form, for a first application and a repeat one alike:
 * - `conversation`: redirect to `/c/screen/<token>`, the fixed introduction of the conversation.
 * - `receipt`, with why: `later_flow` (the role uses "form now, conversation later", or the owner's rule for
 *   invitations is "ask me first" or "only a person": today's receipt); `under_review` (an answer to an eligibility
 *   question did not match: no conversation, a neutral receipt, and the status page says "Under review"; plan E7);
 *   `conversation_by_email` (the month's conversations are used up: the link comes by email once more are added; Q17;
 *   a repeat submission gets it too once the application has had its day's conversations,
 *   `CONVERSATIONS_PER_APPLICATION_PER_DAY`).
 */
export type ApplyVisitOutcome = { kind: "conversation"; token: string } | { kind: "receipt"; reason: "later_flow" | "under_review" | "conversation_by_email" };

export type ApplyVisitInput = {
  /** `createApplication`'s result: the application (the existing one for a repeat), its candidate, and whether it was a repeat. */
  application: Application;
  candidate: Candidate;
  duplicate: boolean;
  /**
   * The company had this person before the form was sent (an earlier application to another role). Typing someone's
   * address must never show their first name or add to their record (known-bugs row 17), so the conversation is the
   * same detached one a repeat submission gets: its answers join the application only once the address owner confirms
   * by email. Absent means a new person.
   */
  knownPerson?: boolean;
  role: Role;
  company: Company;
  /** The role's current packet: the version the job page and the form were built from. */
  packet: RolePacket;
  /** What the form said, never what is on file: a repeat submission's conversation greets the name that was typed. */
  typedFirstName: string;
  eligibilityAnswers: Record<string, unknown>;
};

/**
 * Called by the apply POST inside its transaction, after `createApplication` (plan E1). For a first application on a
 * role using the one-visit flow whose eligibility answers pass and whose invitation rule lets it start on its own: the
 * eligibility result is recorded, the application moves applied → received → eligible → invited to a screen, the
 * conversation is created on the web (never by text, whatever the candidate agreed to), and the `screen` workflow
 * starts with `invited_via` = "apply", sending no invitation (the acknowledgment and the status page carry the link).
 * A repeat submission computes the same answer from the same inputs and gets a detached conversation instead.
 */
export async function startApplyConversation(tx: Tx, container: Container, input: ApplyVisitInput): Promise<ApplyVisitOutcome> {
  const { application: app, role, company, packet } = input;
  const now = container.engine.clock();
  if (resolveApplyMode(role, company.settings) !== "one_visit") return { kind: "receipt", reason: "later_flow" };
  const policy = await resolvePolicy(tx, company.id, role.id, "application.invite_screen");
  if (!oneVisitPolicyAllows(policy.level)) return { kind: "receipt", reason: "later_flow" };
  const eligibility = evaluateEligibility(packet.requirements.eligibility, input.eligibilityAnswers, now);
  if (!eligibility.passed) return { kind: "receipt", reason: "under_review" };
  const ent = await entitlements.check(tx, company.id, entitlements.TEXT_SCREENS, 1);
  const usedUp = !ent.ok && company.planKey !== "design_partner";
  // A repeat submission, or a first application to this role from an address the company already knows: the same page
  // as a new person's, on a detached conversation. A known person's new application goes on to the team as the form path
  // takes it (the intake workflow reads it, and any screening invitation goes to the address on file).
  if (input.duplicate || input.knownPerson) {
    if (usedUp) return { kind: "receipt", reason: "conversation_by_email" };
    // Past the day's conversations for this application, the same receipt as when the month's are used up: no row, no
    // link, no model calls. Never an existing conversation's link instead: that would show one person's words to the next.
    if (!(await anotherConversationToday(tx, app.id))) return { kind: "receipt", reason: "conversation_by_email" };
    const row = await createUnconfirmedConversation(tx, container, { application: app, role, company, firstName: input.typedFirstName, now });
    return { kind: "conversation", token: row.token };
  }
  // The intake workflow has not run yet; anything else means this application was already under way.
  if (app.stage !== "applied") return { kind: "receipt", reason: "later_flow" };
  await tx.update(applications).set({ eligibility }).where(eq(applications.id, app.id));
  await emit(tx, { type: "eligibility.evaluated", companyId: company.id, actor: APPLY_ACTOR, subject: { type: "application", id: app.id }, payload: { passed: true, failed: [], unverifiable: eligibility.unverifiable.map((u) => u.key), at: "apply" } });
  await transition(tx, { applicationId: app.id, companyId: company.id, to: "received", by: "system", actor: APPLY_ACTOR });
  await transition(tx, { applicationId: app.id, companyId: company.id, to: "eligible", by: "system", actor: APPLY_ACTOR });
  if (usedUp) {
    // Q17: the conversation link goes out by email once the allowance is topped up (the screen workflow waits for it).
    // On the web, as the receipt says, whatever the candidate agreed to about texts.
    await container.engine.start(tx, { workflowKey: "screen", companyId: company.id, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: role.id, invitedBy: "apply", flow: "one_visit", channel: "web" }, idempotencyKey: `screen:${app.id}`, actor: APPLY_ACTOR });
    return { kind: "receipt", reason: "conversation_by_email" };
  }
  const scr = await createScreen(tx, { companyId: company.id, applicationId: app.id, channel: "web", expiresAt: new Date(now.getTime() + SCREEN_LINK_HOURS * HOUR).toISOString(), now, invitedVia: "apply", flow: "one_visit" });
  await transition(tx, { applicationId: app.id, companyId: company.id, to: "screen_invited", by: "system", actor: APPLY_ACTOR });
  await emit(tx, { type: "screen.invited", companyId: company.id, actor: APPLY_ACTOR, subject: { type: "screen", id: scr.id }, payload: { channel: "web", applicationId: app.id, invitedBy: "apply", invitedVia: "apply" } });
  const run = await container.engine.start(tx, { workflowKey: "screen", companyId: company.id, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: role.id, screenId: scr.id, channel: "web", invitedVia: "apply", invitedBy: "apply" }, idempotencyKey: `screen:${app.id}`, actor: APPLY_ACTOR });
  await tx.update(screens).set({ workflowRunId: run.runId }).where(eq(screens.id, scr.id));
  return { kind: "conversation", token: scr.token };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Repeat submissions: the detached conversation                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** The job that wipes an unconfirmed conversation's words when its seven days are up. */
export const UNCONFIRMED_DISCARD_JOB_KIND = "screen.unconfirmed_discard";
/** The job that tries a paused detached conversation again (the assistant was down), every half hour for a day. */
export const UNCONFIRMED_RETRY_JOB_KIND = "screen.unconfirmed_retry";

/** What the detached conversation needs from the app. A container has all of it. */
export type ConversationDeps = { db: Db; ai: AiRuntime; integrations: Integrations; engine: WorkflowEngine; jobsBaseUrl: string };

function depsOf(container: Container): ConversationDeps {
  return { db: container.db, ai: container.ai, integrations: container.integrations, engine: container.engine, jobsBaseUrl: container.env.JOBS_BASE_URL };
}

/** Registers the two jobs of detached conversations (called once in container.ts). */
export function registerApplyConversationJobs(engine: WorkflowEngine, deps: ConversationDeps): void {
  engine.registerJob(UNCONFIRMED_DISCARD_JOB_KIND, async (payload, ctx) => {
    const id = String(payload.id ?? "");
    const companyId = String(payload.companyId ?? "");
    if (id && companyId) await withTenant(deps.db, companyId, (tx) => discardUnconfirmed(tx, id, ctx.now));
  });
  engine.registerJob(UNCONFIRMED_RETRY_JOB_KIND, async (payload, ctx) => {
    const id = String(payload.id ?? "");
    const companyId = String(payload.companyId ?? "");
    if (id && companyId) await retryDetached(deps, { id, companyId, now: ctx.now });
  });
}

/**
 * The conversations one application may have opened in a day, its own and repeat submissions' together. A repeat
 * submission's conversation is never counted against the company's allowance (only a confirmed one is), so without a
 * cap anyone could open model conversations without end by sending the form again with an address that already
 * applied. Counting the application's own conversation too means the receipt comes after the same number of
 * submissions whether or not the address had applied before (unless it applied within the day).
 */
export const CONVERSATIONS_PER_APPLICATION_PER_DAY = 4;

async function anotherConversationToday(tx: Tx, applicationId: string): Promise<boolean> {
  const since = sql`now() - interval '24 hours'`;
  const [own] = await tx.select({ n: sql<number>`count(*)` }).from(screens).where(and(eq(screens.applicationId, applicationId), sql`${screens.createdAt} > ${since}`));
  const [repeats] = await tx.select({ n: sql<number>`count(*)` }).from(unconfirmedScreens).where(and(eq(unconfirmedScreens.applicationId, applicationId), sql`${unconfirmedScreens.createdAt} > ${since}`));
  return Number(own?.n ?? 0) + Number(repeats?.n ?? 0) < CONVERSATIONS_PER_APPLICATION_PER_DAY;
}

async function createUnconfirmedConversation(tx: Tx, container: Container, input: { application: Application; role: Role; company: Company; firstName: string; now: Date }): Promise<Unconfirmed> {
  const expiresAt = new Date(input.now.getTime() + UNCONFIRMED_DAYS * 24 * HOUR);
  const firstName = input.firstName.trim().slice(0, 80) || "there";
  const [row] = await tx
    .insert(unconfirmedScreens)
    .values({ companyId: input.company.id, roleId: input.role.id, applicationId: input.application.id, packetVersion: input.role.currentPacketVersion ?? input.application.packetVersion, firstName, token: randomToken(24), status: "invited", progress: { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, expiresAt: expiresAt.toISOString() })
    .returning();
  // A fact about the detached conversation, never about the application: the team's history shows nothing of it.
  await emit(tx, { type: "screen.repeat_started", companyId: input.company.id, actor: { kind: "candidate", id: "applicant" }, subject: { type: "screen", id: row.id }, payload: { roleId: input.role.id, detached: true } });
  await container.engine.enqueue(tx, { kind: UNCONFIRMED_DISCARD_JOB_KIND, payload: { id: row.id, companyId: input.company.id }, runAt: expiresAt, maxAttempts: 5 });
  return row;
}

/**
 * A detached conversation with what it needs. `lock`: the row is held until the transaction ends, so two posts at once
 * (a double click on Send, two presses of the emailed button) act one after the other, the second on what the first left.
 */
async function loadDetached(q: Tx, id: string, opts: { lock?: boolean } = {}) {
  const [row] = opts.lock ? await q.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, id)).limit(1).for("update") : await q.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, id)).limit(1);
  if (!row) return null;
  const [company] = await q.select().from(companies).where(eq(companies.id, row.companyId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, row.roleId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, row.roleId), eq(rolePackets.version, row.packetVersion))).limit(1);
  const [app] = await q.select().from(applications).where(eq(applications.id, row.applicationId)).limit(1);
  const [candidate] = app ? await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1) : [];
  if (!company || !role || !pv || !app || !candidate) return null;
  return { row, company, role, packet: pv.packet, app, candidate };
}
type Detached = NonNullable<Awaited<ReturnType<typeof loadDetached>>>;

function detachedContext(d: Detached, state: { progress: ScreenProgress; answers: Record<string, string>; transcript: ScreenTranscriptEntry[] }, latest: string | null): ScreenContext {
  // The typed first name and no résumé questions: nothing about the person on file reaches the model or the page.
  return screenContextOf({ companyName: d.company.name, companyLocations: d.company.locations, noticeOverrides: d.company.settings.notices, packet: d.packet, firstName: d.row.firstName, focusUnknowns: [] }, { channel: "web", ...state }, latest);
}

function closedFor(status: string, companyName: string): string {
  if (status === "completed") return SCREEN_COMPLETE_MESSAGE;
  if (status === "human_requested") return "A person from the hiring team will follow up with you shortly.";
  if (status === "paused") return pausedMessage(companyName);
  return "This screening has closed. Reply HUMAN if you would like a person to follow up.";
}

/** Words for a date the way the address owner reads it, in the company's time zone. */
function dayWords(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/**
 * The emails repeat submissions' detached conversations may send to the address on file, per application in a day, of
 * every kind together ("Do this later", "it works again", "please confirm"). Anyone can type anyone's address, so
 * without a cap one person could fill someone's mailbox from the apply form; above it the action is recorded and
 * nothing is sent, and the page reads the same either way.
 */
export const DETACHED_EMAILS_PER_DAY = 3;
const DETACHED_TEMPLATES = ["screen_repeat_later", "screen_repeat_resume", "screen_repeat_confirm"];

async function detachedEmailAllowed(tx: Tx, applicationId: string): Promise<boolean> {
  const [row] = await tx.select({ n: sql<number>`count(*)` }).from(communications).where(and(eq(communications.applicationId, applicationId), inArray(communications.templateKey, DETACHED_TEMPLATES), sql`${communications.createdAt} > now() - interval '24 hours'`));
  return Number(row?.n ?? 0) < DETACHED_EMAILS_PER_DAY;
}

/**
 * The email to the address on file when a detached conversation ends: confirm the answers, confirm the request for a
 * person (`outage`: a person offered because the assistant stopped working), or (a withdrawal) use their own status
 * page. Once per conversation: a second call (two presses of Send at once) finds it asked already and leaves the link
 * that went out as it is.
 */
async function askAddressOwner(tx: Tx, deps: ConversationDeps, d: Detached, intent: UnconfirmedIntent, now: Date): Promise<void> {
  if (d.row.confirmation) return;
  const raw = intent === "withdraw" ? null : randomToken(24);
  const link = raw ? `${deps.jobsBaseUrl}/c/confirm-answers/${raw}` : statusUrlFor(deps.jobsBaseUrl, d.app);
  await tx.update(unconfirmedScreens).set({ intent, confirmation: "sent", confirmTokenHash: raw ? hashToken(raw) : null, confirmSentAt: now.toISOString() }).where(eq(unconfirmedScreens.id, d.row.id));
  const emailed = await detachedEmailAllowed(tx, d.app.id);
  if (emailed) await sendRepeatConfirmation(tx, deps.integrations, { application: d.app, candidate: d.candidate, role: d.role, company: d.company, packet: d.packet, actor: { kind: "system", id: "repeat_application" }, unconfirmedId: d.row.id, link, intent, on: dayWords(now, d.company.timezone) });
  await emit(tx, { type: "screen.repeat_confirmation_sent", companyId: d.company.id, actor: { kind: "system", id: "repeat_application" }, subject: { type: "screen", id: d.row.id }, payload: { intent, emailed } });
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

type DetachedState = { status: ScreenStatus; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress };

/** Writes the assistant's reply on a detached conversation; the end of the questions goes to "check your answers" (E10), saying `reviewMessage` (REVIEW_MESSAGE unless given). */
async function detachedReply(tx: Tx, d: Detached, s: DetachedState & { message: string; questionKey: string | null; done: boolean; aiRunId?: string; reviewMessage?: string }): Promise<TurnResult> {
  const message = s.done ? s.reviewMessage ?? REVIEW_MESSAGE : s.message;
  const progress: ScreenProgress = s.done ? { ...s.progress, phase: "review", currentQuestionKey: null } : s.progress;
  const transcript = [...s.transcript, { role: "assistant" as const, content: message, at: new Date().toISOString(), questionKey: s.questionKey ?? undefined, channel: "web" as const, aiRunId: s.aiRunId }];
  await tx.update(unconfirmedScreens).set({ status: s.status, transcript, answers: s.answers, progress }).where(eq(unconfirmedScreens.id, d.row.id));
  return { kind: "reply", message, done: false, humanRequested: false, ...(s.done ? { review: true } : {}) };
}

/** "Understood. A person ... will follow up": the same words the real conversation uses. */
async function personReply(q: Tx, companyName: string): Promise<string> {
  return `Understood. A person from ${companyName} will follow up with you ${humanResponseExpectation(new Date(), await loadBusinessCalendar(q))}.`;
}

/** The first transaction of a detached turn, mirroring `beginScreenTurn`: commands, a skip and a tap never reach the model. */
async function beginDetachedTurn(tx: Tx, deps: ConversationDeps, id: string, input: TurnAction): Promise<{ done: TurnResult } | { ctx: ScreenContext; turn: number }> {
  let d = await loadDetached(tx, id, { lock: true });
  if (!d || d.row.discardedAt) return { done: { kind: "error", message: "This conversation is no longer available." } };
  const now = deps.engine.clock();
  const at = now.toISOString();
  if (!ACTIVE.has(d.row.status)) return { done: { kind: "closed", message: closedFor(d.row.status, d.company.name) } };
  // An answer posted before Start: the first question is put first, as Start does (and as a first application's does).
  if (!d.row.transcript.some((t) => t.role === "assistant") && (await openDetached(tx, d, at))) d = (await loadDetached(tx, id))!;
  const { row, packet } = d;
  if (row.progress.phase === "review") return { done: { kind: "reply", message: REVIEW_MESSAGE, done: false, humanRequested: false, review: true } };
  const current = row.progress.currentQuestionKey;
  if ((input.skip || input.tap) && !current) return { done: { kind: "error", message: "There is no question to answer here right now." } };
  const tapped = input.tap ? tapWords(packet, row.progress, input.tap, now) : null;
  if (input.tap && !tapped) return { done: { kind: "error", message: "That answer does not fit this question. Please type it instead." } };
  const message = input.message ?? "";
  const said = input.skip ? null : tapped ?? message;
  // As in the real conversation (E11): a skip during a follow-up to an answer already given moves on and keeps it.
  const movesOn = !!input.skip && !!current && answersOf(row)[current] !== undefined;
  const entry: ScreenTranscriptEntry = input.skip
    ? movesOn ? { role: "system", content: MOVED_ON_MESSAGE, at, channel: "web", questionKey: current ?? undefined, source: "system" } : { role: "system", content: SKIPPED_MESSAGE, at, channel: "web", questionKey: current ?? undefined, source: "skip" }
    : tapped ? { role: "candidate", content: tapped, at, channel: "web", questionKey: current ?? undefined, source: "tap" } : { role: "candidate", content: message, at, channel: "web" };
  const transcript = [...row.transcript, entry];
  await tx.update(unconfirmedScreens).set({ status: "in_progress", startedAt: row.startedAt ?? at, transcript, lastCandidateMessageAt: at }).where(eq(unconfirmedScreens.id, row.id));
  const state: DetachedState = { status: "in_progress", transcript, answers: { ...row.answers }, progress: row.progress };
  const command = said !== null && !tapped ? screenCommand(message, withdrawPending(row.transcript)) : null;
  if (command === "confirm_withdraw" || command === "keep_application") return { done: await detachedWithdraw(tx, deps, { ...d, row: { ...row, ...state } }, command === "confirm_withdraw") };
  if (command === "human") return { done: await detachedPerson(tx, deps, { ...d, row: { ...row, ...state } }, "contact_me") };
  if (command === "withdraw") {
    const ask = `Do you want to withdraw your application for ${packet.identity.title}? Press "Yes, withdraw my application" below to confirm. To keep your application, just type your answer.`;
    await tx.update(unconfirmedScreens).set({ transcript: [...transcript, { role: "assistant", content: ask, at, channel: "web", questionKey: WITHDRAW_CONFIRM_KEY }] }).where(eq(unconfirmedScreens.id, row.id));
    return { done: { kind: "reply", message: ask, done: false, humanRequested: false } };
  }
  if (input.skip || tapped) {
    const key = current!;
    let progress = state.progress;
    const answers = state.answers;
    if (tapped) {
      if (isFocusKey(key)) progress = withFocusAnswer(progress, key, tapped);
      else answers[key] = tapped;
      if (progress.declined?.includes(key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== key) };
    } else if (!movesOn) progress = { ...progress, declined: [...new Set([...(progress.declined ?? []), key])] };
    const next = nextQuestion(packet, progress, answersOf({ answers, progress }));
    const lead = tapped ? "Thanks." : "No problem.";
    const silent: ScreenTurn = { messageToCandidate: " ", questionKey: next?.key ?? null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: !next, humanRequested: false };
    progress = advanceProgress(progress, silent);
    return { done: await detachedReply(tx, d, { ...state, answers, progress, message: next ? `${lead} Next: ${next.question}` : lead, questionKey: next?.key ?? null, done: !next }) };
  }
  // The same cap on model calls as the real conversation (`modelTurnCap`), ending the same way: "check your answers",
  // where nothing calls the model. Nothing about it tells this conversation apart from a first application's.
  if (modelTurnsUsed(transcript) >= modelTurnCap(packet)) {
    await emit(tx, { type: "screen.turn_cap_reached", companyId: d.company.id, actor: { kind: "system", id: "screening" }, subject: { type: "screen", id: row.id }, payload: { detached: true, modelTurns: modelTurnsUsed(transcript), cap: modelTurnCap(packet), ending: "review", channel: "web" } });
    const ended: ScreenTurn = { messageToCandidate: " ", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: true, humanRequested: false };
    return { done: await detachedReply(tx, d, { ...state, progress: advanceProgress(state.progress, ended), message: TURN_CAP_REVIEW_MESSAGE, reviewMessage: TURN_CAP_REVIEW_MESSAGE, questionKey: null, done: true }) };
  }
  return { ctx: detachedContext(d, state, message), turn: transcript.length };
}

/** The second transaction of a detached turn, mirroring `finishScreenTurn`. Also finishes a retry after an outage. */
async function finishDetachedTurn(tx: Tx, deps: ConversationDeps, id: string, out: RunOutcome<ScreenTurn>): Promise<TurnResult> {
  const d = await loadDetached(tx, id, { lock: true });
  if (!d) return { kind: "error", message: "This conversation is no longer available." };
  const { row, packet, company } = d;
  const now = deps.engine.clock();
  if (!out.ok) {
    if (row.status === "paused") return { kind: "error", message: pausedMessage(company.name) };
    const failures = (row.progress.failures ?? 0) + 1;
    if (failures >= 2) {
      // E5, as in the real conversation: paused with the answers kept, and tried again until the assistant answers.
      const msg = pausedMessage(company.name);
      await tx.update(unconfirmedScreens).set({ status: "paused", progress: { ...row.progress, failures, pausedAt: now.toISOString() }, transcript: [...row.transcript, { role: "assistant", content: msg, at: now.toISOString(), channel: "web" }] }).where(eq(unconfirmedScreens.id, row.id));
      await deps.engine.enqueue(tx, { kind: UNCONFIRMED_RETRY_JOB_KIND, payload: { id: row.id, companyId: row.companyId }, runAt: new Date(now.getTime() + PAUSE_RETRY_MINUTES * 60_000), maxAttempts: 3 });
      return { kind: "reply", message: msg, done: false, humanRequested: false, paused: true };
    }
    await tx.update(unconfirmedScreens).set({ progress: { ...row.progress, failures } }).where(eq(unconfirmedScreens.id, row.id));
    return { kind: "error", message: "Sorry, something went wrong on our end. Please send that again in a minute." };
  }
  let turn = enforceTurnRules(out.output, packet, row.progress, answersOf(row));
  if (turn.humanRequested) {
    turn = !/business/i.test(turn.messageToCandidate) ? { ...turn, messageToCandidate: `${turn.messageToCandidate} You can expect to hear from a person ${humanResponseExpectation(new Date(), await loadBusinessCalendar(tx))}.` } : turn;
    await tx.update(unconfirmedScreens).set({ transcript: [...row.transcript, { role: "assistant", content: turn.messageToCandidate, at: now.toISOString(), channel: "web", aiRunId: out.runId }] }).where(eq(unconfirmedScreens.id, row.id));
    const fresh = (await loadDetached(tx, id))!;
    await detachedPerson(tx, deps, fresh, "contact_me", { silent: true });
    return { kind: "reply", message: turn.messageToCandidate, done: false, humanRequested: true };
  }
  const answers = { ...row.answers };
  let progress = advanceProgress(row.progress, turn);
  if (turn.answerRecorded) {
    const recorded = redactProtected(turn.answerRecorded.answer);
    if (isFocusKey(turn.answerRecorded.questionKey)) progress = withFocusAnswer(progress, turn.answerRecorded.questionKey, recorded);
    else answers[turn.answerRecorded.questionKey] = recorded;
  }
  if (row.status === "paused") progress = { ...progress, pausedAt: undefined };
  return detachedReply(tx, d, { status: "in_progress", transcript: row.transcript, answers, progress, message: turn.messageToCandidate, questionKey: turn.questionKey, done: turn.done, aiRunId: out.runId });
}

/**
 * "Have a person contact me" (or HUMAN) in a detached conversation: the same reply; the address owner confirms it first.
 * `outage`: nobody asked; the assistant stopped working for a day, and the address owner is offered a person instead.
 */
async function detachedPerson(tx: Tx, deps: ConversationDeps, d: Detached, choice: "contact_me" | "send_without", opts: { silent?: boolean; outage?: boolean } = {}): Promise<TurnResult> {
  const { row, company } = d;
  if (!SCREEN_PERSON_ROUTE_STATUSES.includes(row.status)) return { kind: "closed", message: closedFor(row.status, company.name) };
  const now = deps.engine.clock();
  if (choice === "send_without") {
    // The real application goes on to the team either way, so there is nothing to confirm.
    const msg = `Thanks. Your application has gone to the hiring team at ${company.name} without the conversation. People on the team review it and you will hear from them either way.`;
    await tx.update(unconfirmedScreens).set({ status: "declined_by_candidate", finishedAt: now.toISOString(), transcript: [...row.transcript, { role: "assistant", content: msg, at: now.toISOString(), channel: "web" }] }).where(eq(unconfirmedScreens.id, row.id));
    return { kind: "reply", message: msg, done: true, humanRequested: false };
  }
  const msg = opts.silent ? null : await personReply(tx, company.name);
  await tx.update(unconfirmedScreens).set({ status: "human_requested", finishedAt: now.toISOString(), transcript: msg ? [...row.transcript, { role: "assistant", content: msg, at: now.toISOString(), channel: "web" }] : row.transcript }).where(eq(unconfirmedScreens.id, row.id));
  await askAddressOwner(tx, deps, d, opts.outage ? "outage" : "person", now);
  return { kind: "reply", message: msg ?? "", done: false, humanRequested: true };
}

/** The answer to "do you want to withdraw?" in a detached conversation: the same words; nothing is withdrawn from here. */
async function detachedWithdraw(tx: Tx, deps: ConversationDeps, d: Detached, confirm: boolean): Promise<TurnResult> {
  const { row, packet, company } = d;
  if (!ACTIVE.has(row.status)) return { kind: "closed", message: closedFor(row.status, company.name) };
  const now = deps.engine.clock();
  if (!confirm) {
    const current = currentQuestion(packet, row.progress);
    const msg = `No problem, your application stays active.${current ? ` Here is where we were: ${current.question}` : ""}`;
    await tx.update(unconfirmedScreens).set({ transcript: [...row.transcript, { role: "assistant", content: msg, at: now.toISOString(), channel: "web" }] }).where(eq(unconfirmedScreens.id, row.id));
    return { kind: "reply", message: msg, done: false, humanRequested: false };
  }
  const msg = withdrawnMessage(packet.identity.title);
  await tx.update(unconfirmedScreens).set({ status: "abandoned", finishedAt: now.toISOString(), transcript: [...row.transcript, { role: "assistant", content: msg, at: now.toISOString(), channel: "web" }] }).where(eq(unconfirmedScreens.id, row.id));
  await askAddressOwner(tx, deps, d, "withdraw", now);
  return { kind: "reply", message: msg, done: true, humanRequested: false, withdrawn: true };
}

/** The retry of a paused detached conversation (E5): on success it opens again and the address on file is emailed the link. */
async function retryDetached(deps: ConversationDeps, input: { id: string; companyId: string; now: Date }): Promise<void> {
  const plan = await withTenant(deps.db, input.companyId, async (tx) => {
    const d = await loadDetached(tx, input.id);
    if (d?.row.status !== "paused" || d.row.discardedAt) return null;
    const last = d.row.transcript.map((t) => t.role).lastIndexOf("candidate");
    if (last < 0) return null;
    const transcript = d.row.transcript.slice(0, last + 1);
    return { ctx: detachedContext(d, { progress: d.row.progress, answers: d.row.answers, transcript }, transcript[last].content), turn: last + 1 };
  });
  if (!plan) return;
  const out = await runPromptDetached(deps.db, deps.ai, screenTurnPrompt, plan.ctx, { companyId: input.companyId, workflowRunId: null, inputRef: { unconfirmedScreenId: input.id, retry: true } });
  await withTenant(deps.db, input.companyId, async (tx) => {
    const before = await loadDetached(tx, input.id, { lock: true });
    if (before?.row.status !== "paused") return;
    const pausedAt = before.row.progress.pausedAt ?? input.now.toISOString();
    await finishDetachedTurn(tx, deps, input.id, out);
    const after = (await loadDetached(tx, input.id))!;
    if (after.row.status !== "paused") {
      // Open again: the link goes to the address on file, worded for a repeat submission. Handed to a person instead (the
      // retried answer asked for one): the address owner was already asked to confirm that.
      if (after.row.status === "in_progress" && (await detachedEmailAllowed(tx, after.app.id))) {
        await sendRepeatConversationResume(tx, deps.integrations, { application: after.app, candidate: after.candidate, role: after.role, company: after.company, packet: after.packet, actor: { kind: "system", id: "screening" }, appBaseUrl: deps.jobsBaseUrl, screen: { id: after.row.id, token: after.row.token }, questions: after.packet.screening.questions.length, minutes: after.packet.screening.maxMinutes, pausedAt, unconfirmedId: after.row.id, on: dayWords(new Date(after.row.createdAt), after.company.timezone) });
      }
      return;
    }
    if (input.now.getTime() - Date.parse(pausedAt) >= PAUSE_GIVE_UP_HOURS * HOUR) {
      // A day without the assistant: a person is offered instead, in words that say why (nobody asked for one).
      await tx.update(unconfirmedScreens).set({ status: "in_progress" }).where(eq(unconfirmedScreens.id, input.id));
      await detachedPerson(tx, deps, { ...after, row: { ...after.row, status: "in_progress" } }, "contact_me", { silent: true, outage: true });
      return;
    }
    await deps.engine.enqueue(tx, { kind: UNCONFIRMED_RETRY_JOB_KIND, payload: { id: input.id, companyId: input.companyId }, runAt: new Date(input.now.getTime() + PAUSE_RETRY_MINUTES * 60_000), maxAttempts: 3 });
  });
}

/** Seven days on and not confirmed: what was typed is wiped. That it happened, and when, stays. */
export async function discardUnconfirmed(tx: Tx, id: string, now: Date): Promise<boolean> {
  const [row] = await tx.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, id)).limit(1);
  if (!row || row.discardedAt || row.confirmation === "confirmed" || row.confirmation === "not_added") return false;
  if (Date.parse(row.expiresAt) > now.getTime()) return false;
  await tx.update(unconfirmedScreens).set({ transcript: [], answers: {}, firstName: "", confirmTokenHash: null, confirmation: "discarded", discardedAt: now.toISOString(), status: ACTIVE.has(row.status) || row.status === "paused" ? "expired" : row.status }).where(eq(unconfirmedScreens.id, id));
  await emit(tx, { type: "screen.repeat_discarded", companyId: row.companyId, actor: { kind: "system", id: "repeat_application" }, subject: { type: "screen", id }, payload: { confirmation: row.confirmation } });
  return true;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The address owner confirms                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The page behind the emailed link (`/c/confirm-answers/<token>`): `ready` shows one button ("Add these answers to my
 * application" or "Yes, ask a person to contact me"); the others say what happened. Opening the link changes nothing.
 */
export type RepeatConfirmationView = { state: "ready" | "added" | "person" | "not_added" | "gone"; intent: UnconfirmedIntent | null; companyName: string; roleTitle: string; answered: number; questions: number };

async function findByConfirmToken(db: Db, raw: string): Promise<{ id: string; companyId: string } | null> {
  if (!raw || raw.length > 100) return null;
  const [row] = await db.select({ id: unconfirmedScreens.id, companyId: unconfirmedScreens.companyId }).from(unconfirmedScreens).where(eq(unconfirmedScreens.confirmTokenHash, hashToken(raw))).limit(1);
  return row ?? null;
}

/** A person was asked for (or, after a day-long outage, offered): confirming brings one in. */
const PERSON_INTENTS: readonly string[] = ["person", "outage"];

function confirmationView(d: Detached, now: Date): RepeatConfirmationView {
  const base = { intent: d.row.intent ?? null, companyName: d.company.name, roleTitle: d.packet.identity.title, answered: Object.keys(answersOf(d.row)).length, questions: d.packet.screening.questions.length };
  if (d.row.confirmation === "confirmed") return { ...base, state: PERSON_INTENTS.includes(d.row.intent ?? "") ? "person" : "added" };
  if (d.row.confirmation === "not_added") return { ...base, state: "not_added" };
  if (d.row.confirmation !== "sent" || d.row.discardedAt || Date.parse(d.row.expiresAt) <= now.getTime()) return { ...base, state: "gone" };
  return { ...base, state: "ready" };
}

export async function repeatConfirmationView(db: Db, raw: string, now: Date): Promise<RepeatConfirmationView | null> {
  const found = await findByConfirmToken(db, raw);
  if (!found) return null;
  return withTenant(db, found.companyId, async (tx) => {
    const d = await loadDetached(tx, found.id);
    return d ? confirmationView(d, now) : null;
  });
}

/**
 * The address owner pressed the button (Q14 x Q15). The answers (and a request for a person) are added to their real
 * application when it can still take them: it is still before interviews, no conversation of theirs has answers yet,
 * and the team has not stopped the invitation. Otherwise nothing is added and the page says so. Pressing twice changes
 * nothing more. Counted against the allowance here, at the first answer on the record (E9).
 */
export async function confirmRepeat(container: Container, raw: string): Promise<RepeatConfirmationView | null> {
  const found = await findByConfirmToken(container.db, raw);
  if (!found) return null;
  const now = container.engine.clock();
  let allowance: AllowanceNote | null = null;
  const view = await withTenant(container.db, found.companyId, async (tx) => {
    // Locked: a second press at the same moment waits, then finds it confirmed and answers the same.
    const d = await loadDetached(tx, found.id, { lock: true });
    if (!d) return null;
    const before = confirmationView(d, now);
    if (before.state !== "ready") return before;
    const { row, app, candidate, company, role, packet } = d;
    const intent = row.intent ?? "answers";
    const own = await tx.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt));
    const hasAnswers = own.some((s) => Object.keys(answersOf(s)).length > 0 || ["in_progress", "completed", "human_requested", "paused"].includes(s.status));
    const stoppedByTeam = own[0]?.status === "cancelled";
    const open = ["received", "eligible", "triaged", "screen_invited"].includes(app.stage);
    const candidateActor: Actor = { kind: "candidate", id: candidate.id };
    const finish = async (confirmation: "confirmed" | "not_added", mergedScreenId: string | null) => {
      await tx.update(unconfirmedScreens).set({ confirmation, confirmedAt: now.toISOString(), mergedScreenId, transcript: [], answers: {}, firstName: "" }).where(eq(unconfirmedScreens.id, row.id));
      await emit(tx, { type: "screen.repeat_confirmed", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: mergedScreenId ?? row.id }, payload: { unconfirmedId: row.id, intent, added: confirmation === "confirmed" } });
    };
    if (!open || hasAnswers || stoppedByTeam) {
      await finish("not_added", null);
      return { ...before, state: "not_added" as const };
    }
    const target = own.find((s) => s.status === "invited" || s.status === "reminded") ?? (await createScreen(tx, { companyId: company.id, applicationId: app.id, channel: "web", expiresAt: new Date(now.getTime() + SCREEN_LINK_HOURS * HOUR).toISOString(), now, invitedVia: "confirmed_repeat", flow: "one_visit" }));
    const answered = Object.keys(answersOf(row)).length;
    const progress: ScreenProgress = { ...row.progress, flow: "one_visit", ...(intent === "answers" ? { submittedAt: row.progress.submittedAt ?? now.toISOString() } : {}) };
    const done = intent === "answers";
    await tx.update(screens).set({ transcript: row.transcript, answers: row.answers, progress, status: done ? "completed" : "in_progress", startedAt: row.startedAt ?? now.toISOString(), lastCandidateMessageAt: row.lastCandidateMessageAt ?? now.toISOString(), completedAt: done ? now.toISOString() : null }).where(eq(screens.id, target.id));
    // The stages a first application would have passed through.
    const [cur] = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
    if (cur.stage !== "screen_invited") await transition(tx, { applicationId: app.id, companyId: company.id, to: "screen_invited", by: "system", actor: candidateActor, reason: "answers confirmed by email after applying again" });
    if (done || answered) await transition(tx, { applicationId: app.id, companyId: company.id, to: "screening", by: "system", actor: candidateActor });
    if (answered) allowance = await countConversation(tx, { companyId: company.id, companyName: company.name, screenId: target.id });
    await finish("confirmed", target.id);
    if (!done) {
      const reason = intent === "outage" ? "the assistant stopped working during a conversation after applying again; the candidate confirmed by email that a person should contact them" : "candidate asked for a person after applying again, and confirmed it by email";
      await requestHuman(tx, screenDeps(container), { screenId: target.id, reason, actor: candidateActor, reply: null, replyChannel: "web" });
      return { ...before, state: "person" as const };
    }
    await transition(tx, { applicationId: app.id, companyId: company.id, to: "screen_complete", by: "system", actor: candidateActor });
    await emit(tx, { type: "screen.completed", companyId: company.id, actor: candidateActor, subject: { type: "screen", id: target.id }, payload: { questionsAnswered: answered, questions: packet.screening.questions.length, skipped: row.progress.declined?.length ?? 0, channel: "web", via: "confirmed_repeat" } });
    // The scorecard: the screen's own run wakes if it is waiting; otherwise a run starts for this screen.
    const [run] = target.workflowRunId ? await tx.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, target.workflowRunId)).limit(1) : [];
    if (run && ["waiting", "running"].includes(run.status)) await container.engine.signal(tx, { companyId: company.id, key: `screen:${target.id}:completed` });
    else {
      const started = await container.engine.start(tx, { workflowKey: "screen", companyId: company.id, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: role.id, screenId: target.id, channel: "web", invitedVia: "confirmed_repeat" }, idempotencyKey: `screen:${app.id}:confirmed:${row.id}`, actor: candidateActor });
      await tx.update(screens).set({ workflowRunId: started.runId }).where(eq(screens.id, target.id));
    }
    return { ...before, state: "added" as const };
  });
  await flagAllowance(container.db, allowance);
  await container.kick();
  return view;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* One conversation page for both kinds                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export type ConversationRef = { kind: "screen" | "detached"; id: string; companyId: string; applicationId: string; token: string };

/** The conversation a link opens: a screen, or a repeat submission's detached conversation. Null for an unknown link. */
export async function findConversation(db: Db, token: string): Promise<ConversationRef | null> {
  if (!token || token.length > 100) return null;
  const [s] = await db.select({ id: screens.id, companyId: screens.companyId, applicationId: screens.applicationId }).from(screens).where(eq(screens.token, token)).limit(1);
  if (s) return { kind: "screen", ...s, token };
  const [d] = await db.select({ id: unconfirmedScreens.id, companyId: unconfirmedScreens.companyId, applicationId: unconfirmedScreens.applicationId }).from(unconfirmedScreens).where(eq(unconfirmedScreens.token, token)).limit(1);
  return d ? { kind: "detached", ...d, token } : null;
}

/**
 * Everything the conversation page shows, the same for both kinds (the page must not render them differently):
 * - `phase`: `intro` (the fixed introduction with Start, Do this later, I'd rather talk to a person: every conversation
 *   on the web before its first question, however it was offered; plan E2), `conversation`, `review` ("check your
 *   answers", E10), or `closed` (`status` says how: completed, human_requested, paused, declined_by_candidate,
 *   unfinished, abandoned, expired, cancelled).
 * - `current`: the question being asked, the tap answer it offers (E12), and whether it already has an answer (the
 *   assistant is following up: skipping then moves on and keeps it, E11). `review`: one line per question.
 * - `transcript`: what the candidate sees; a recruiter's call notes are never on it.
 * - `personExpectation`: when a person would be in touch if asked now ("within four business hours (...)"), for the
 *   page that offers one.
 * - `personAsked`: once a person was asked for (status `human_requested`), the time promised then, in words, and whether
 *   it has passed: the closed page keeps that promise instead of making a new one each time it is opened. Null
 *   otherwise, or for an old conversation with no record of when.
 * There is deliberately no status link here: a detached conversation has none to give, so neither kind shows one.
 */
export type ConversationView = {
  token: string;
  status: ScreenStatus;
  phase: "intro" | "conversation" | "review" | "closed";
  oneVisit: boolean;
  channel: "web" | "sms";
  companyName: string;
  roleTitle: string;
  firstName: string;
  intro: ScreenIntro;
  transcript: Array<{ role: "assistant" | "candidate" | "system"; content: string; questionKey?: string }>;
  answered: number;
  total: number;
  current: { key: string; question: string; tap: TapFormat | null; answered: boolean } | null;
  review: ReviewItem[] | null;
  withdrawPending: boolean;
  personExpectation: string;
  personAsked: { dueWords: string; overdue: boolean } | null;
  /** Closed as complete by a recruiter's notes from a call: the candidate never sent their own answers, so the page never says they did. */
  finishedOnACall: boolean;
};

function viewOf(input: { token: string; status: string; channel: string; progress: ScreenProgress; answers: Record<string, string>; transcript: ScreenTranscriptEntry[]; companyName: string; notices: Company["settings"]["notices"]; packet: RolePacket; firstName: string; expectation: string; personAsked: ConversationView["personAsked"] }): ConversationView {
  const { progress, packet } = input;
  const status = input.status as ScreenStatus;
  const oneVisit = progress.flow === "one_visit";
  const opened = input.transcript.some((t) => t.role === "assistant");
  const open = ACTIVE.has(status);
  const web = input.channel !== "sms";
  const phase = !open ? "closed" : progress.phase === "review" ? "review" : web && !opened ? "intro" : "conversation";
  const q = open && phase === "conversation" ? currentQuestion(packet, progress) : null;
  const answers = answersOf({ answers: input.answers, progress });
  return {
    token: input.token,
    status,
    phase,
    oneVisit,
    channel: web ? "web" : "sms",
    companyName: input.companyName,
    roleTitle: packet.identity.title,
    firstName: input.firstName,
    intro: screenIntro({ companyName: input.companyName, firstName: input.firstName, packet, noticeOverrides: input.notices, focus: !!progress.focusQuestions?.length }),
    transcript: input.transcript.filter((t) => t.role !== "recruiter").map((t) => ({ role: t.role as "assistant" | "candidate" | "system", content: t.content, ...(t.questionKey ? { questionKey: t.questionKey } : {}) })),
    answered: Object.keys(answers).length,
    total: packet.screening.questions.length,
    current: q ? { key: q.key, question: q.question, tap: tapFormatFor(q, packet.compensation), answered: answers[q.key] !== undefined } : null,
    review: phase === "review" ? reviewItems({ answers: input.answers, progress }, packet) : null,
    withdrawPending: open && withdrawPending(input.transcript),
    personExpectation: input.expectation,
    personAsked: status === "human_requested" ? input.personAsked : null,
    finishedOnACall: status === "completed" && progress.completedBy === "recruiter_call",
  };
}

/** How long a person may take to reach someone who asked for one, as the conversation promises it (founder decision F12). */
const PERSON_REPLY_BUSINESS_HOURS = 4;

/**
 * `now`: the moment the page is read (the real time unless a test says otherwise). The promise to someone who asked for
 * a person is worked out from when they asked, so it stays the same however often the page is opened; a request made
 * outside business hours counts from the next opening, as "on the next business day" said at the time.
 */
export async function conversationView(db: Db, ref: ConversationRef, now: Date = new Date()): Promise<ConversationView | null> {
  return withTenant(db, ref.companyId, async (tx) => {
    const calendar = await loadBusinessCalendar(tx, now);
    const expectation = humanResponseExpectation(now, calendar);
    const asked = (at: string | null | undefined): ConversationView["personAsked"] => {
      if (!at) return null;
      const due = addBusinessHours(new Date(at), PERSON_REPLY_BUSINESS_HOURS, calendar);
      return { dueWords: deadlineWords(due, calendar), overdue: now.getTime() > due.getTime() };
    };
    if (ref.kind === "screen") {
      const b = await loadScreenBundle(tx, ref.id);
      if (!b) return null;
      return viewOf({ token: ref.token, status: b.screen.status, channel: b.screen.channel, progress: b.screen.progress, answers: b.screen.answers, transcript: b.screen.transcript, companyName: b.company.name, notices: b.company.settings.notices, packet: b.packet, firstName: b.candidate.firstName, expectation, personAsked: b.screen.status === "human_requested" ? asked(b.screen.humanRequestedAt) : null });
    }
    const d = await loadDetached(tx, ref.id);
    if (!d) return null;
    // A wiped conversation reads as an expired link, like a screen nobody answered.
    const status = d.row.discardedAt ? "expired" : d.row.status;
    return viewOf({ token: ref.token, status, channel: "web", progress: d.row.progress, answers: d.row.answers, transcript: d.row.discardedAt ? [] : d.row.transcript, companyName: d.company.name, notices: d.company.settings.notices, packet: d.packet, firstName: d.row.firstName || "there", expectation, personAsked: status === "human_requested" ? asked(d.row.finishedAt) : null });
  });
}

/** "Start" on the introduction: the first question, in the packet's words (E2). */
export async function conversationStart(container: Container, ref: ConversationRef): Promise<boolean> {
  if (ref.kind === "screen") {
    const r = await withTenant(container.db, ref.companyId, (tx) => startScreenConversation(tx, screenDeps(container), { screenId: ref.id, actor: WEB_ACTOR }));
    await container.kick();
    return r.ok;
  }
  return withTenant(container.db, ref.companyId, async (tx) => {
    const d = await loadDetached(tx, ref.id, { lock: true });
    if (!d || d.row.discardedAt || !ACTIVE.has(d.row.status)) return false;
    if (d.row.transcript.some((t) => t.role === "assistant")) return true;
    return openDetached(tx, d, container.engine.clock().toISOString());
  });
}

/** The first question of a detached conversation, in the packet's words, as `startScreenConversation` writes it. */
async function openDetached(tx: Tx, d: Detached, at: string): Promise<boolean> {
  const first = nextQuestion(d.packet, d.row.progress, answersOf(d.row));
  if (!first) return false;
  const progress = advanceProgress(d.row.progress, { messageToCandidate: first.question, questionKey: first.key, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false });
  await tx.update(unconfirmedScreens).set({ status: "in_progress", startedAt: d.row.startedAt ?? at, lastCandidateMessageAt: at, progress, transcript: [...d.row.transcript, { role: "assistant", content: first.question, at, questionKey: first.key, channel: "web", source: "system" }] }).where(eq(unconfirmedScreens.id, d.row.id));
  return true;
}

/** One thing the candidate did on the page: typed a `message`, pressed "Skip this question" (E11) or tapped an answer (E12). */
export type TurnAction = { message?: string | null; skip?: boolean; tap?: TapAnswer | null };

/** A turn of the conversation, either kind. An empty message with no skip or tap is refused before anything is written. */
export async function conversationTurn(container: Container, ref: ConversationRef, input: TurnAction): Promise<TurnResult> {
  const message = (input.message ?? "").trim().slice(0, 2000);
  if (!message && !input.skip && !input.tap) return { kind: "error", message: "Please type an answer first." };
  const action = { message, skip: !!input.skip, tap: input.tap ?? null };
  if (ref.kind === "screen") {
    const noted = withdrawalsNoted(container);
    const r = await runScreenTurn(container.db, ref.companyId, noted.deps, { screenId: ref.id, message, channel: "web", actor: WEB_ACTOR, skip: action.skip, tap: action.tap });
    await noted.record();
    await container.kick();
    return r;
  }
  const deps = depsOf(container);
  const begun = await withTenant(container.db, ref.companyId, (tx) => beginDetachedTurn(tx, deps, ref.id, action));
  if ("done" in begun) {
    await container.kick();
    return begun.done;
  }
  const out = await runPromptDetached(container.db, container.ai, screenTurnPrompt, begun.ctx, { companyId: ref.companyId, workflowRunId: null, inputRef: { unconfirmedScreenId: ref.id, turn: begun.turn } });
  const result = await withTenant(container.db, ref.companyId, (tx) => finishDetachedTurn(tx, deps, ref.id, out));
  await container.kick();
  return result;
}

/**
 * "Do this later": the link by email, to the address on file (E2). False when the conversation is no longer waiting to
 * start. A repeat submission's copy goes in words that say someone applied again with that address, within the day's
 * cap of such emails; the page says the same either way.
 */
export async function conversationLater(container: Container, ref: ConversationRef): Promise<boolean> {
  const sent = await withTenant(container.db, ref.companyId, async (tx) => {
    if (ref.kind === "screen") {
      const b = await loadScreenBundle(tx, ref.id);
      if (!b || !ACTIVE.has(b.screen.status)) return false;
      await sendConversationForLater(tx, container.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: WEB_ACTOR, correlationId: b.screen.workflowRunId, appBaseUrl: container.env.JOBS_BASE_URL, screen: { id: b.screen.id, token: b.screen.token }, questions: b.packet.screening.questions.length, minutes: b.packet.screening.maxMinutes });
      return true;
    }
    const d = await loadDetached(tx, ref.id);
    if (!d || d.row.discardedAt || !ACTIVE.has(d.row.status)) return false;
    if (await detachedEmailAllowed(tx, d.app.id)) {
      await sendRepeatConversationLater(tx, container.integrations, { application: d.app, candidate: d.candidate, role: d.role, company: d.company, packet: d.packet, actor: WEB_ACTOR, appBaseUrl: container.env.JOBS_BASE_URL, screen: { id: d.row.id, token: d.row.token }, questions: d.packet.screening.questions.length, minutes: d.packet.screening.maxMinutes, unconfirmedId: d.row.id, on: dayWords(new Date(d.row.createdAt), d.company.timezone) });
    }
    return true;
  });
  await container.kick();
  return sent;
}

/**
 * "I'd rather talk to a person" leads to two equal choices (E3, Q16): `contact_me` (an ITS recruiter contacts them
 * within four business hours; escalated as before, and counted) or `send_without` (the application goes on to the team
 * without the conversation). Works while the conversation is paused too (E5). Null when the conversation is closed.
 */
export async function conversationPerson(container: Container, ref: ConversationRef, choice: "contact_me" | "send_without"): Promise<{ message: string } | null> {
  const out = await withTenant(container.db, ref.companyId, async (tx) => {
    if (ref.kind === "screen") {
      const b = await loadScreenBundle(tx, ref.id);
      if (!b || !SCREEN_PERSON_ROUTE_STATUSES.includes(b.screen.status as ScreenStatus)) return null;
      if (choice === "send_without") return declineConversation(tx, screenDeps(container), { screenId: ref.id, actor: { kind: "candidate", id: b.candidate.id } });
      const reply = await personReply(tx, b.company.name);
      await requestHuman(tx, screenDeps(container), { screenId: ref.id, reason: "candidate chose 'Have a person contact me'", actor: { kind: "candidate", id: b.candidate.id }, reply, replyChannel: "web" });
      return { message: reply };
    }
    const d = await loadDetached(tx, ref.id, { lock: true });
    if (!d || d.row.discardedAt) return null;
    const r = await detachedPerson(tx, depsOf(container), d, choice);
    return r.kind === "reply" ? { message: r.message } : null;
  });
  await container.kick();
  return out;
}

/** The answer to "do you want to withdraw?" on the page. In a detached conversation nothing is withdrawn (see above). */
export async function conversationWithdraw(container: Container, ref: ConversationRef, confirm: boolean): Promise<string | null> {
  const noted = withdrawalsNoted(container);
  const msg = await withTenant(container.db, ref.companyId, async (tx) => {
    if (ref.kind === "screen") {
      const b = await loadScreenBundle(tx, ref.id);
      if (!b) return null;
      return answerWithdrawPrompt(tx, noted.deps, { screenId: ref.id, confirm, channel: "web", actor: { kind: "candidate", id: b.candidate.id } });
    }
    const d = await loadDetached(tx, ref.id, { lock: true });
    if (!d || d.row.discardedAt || !withdrawPending(d.row.transcript)) return null;
    const r = await detachedWithdraw(tx, depsOf(container), d, confirm);
    return r.kind === "reply" ? r.message : null;
  });
  await noted.record();
  await container.kick();
  return msg;
}

/**
 * The screening agent's deps with withdrawals noted: a confirmed "withdraw" in the screening chat is, once its
 * transaction has committed, also a recorded request with a confirmation email, as from the status page (known-bugs
 * row 74). `record` runs after the chat's transaction and does nothing when nobody withdrew.
 */
function withdrawalsNoted(container: Container): { deps: ScreenDeps; record: () => Promise<void> } {
  const base = screenDeps(container);
  const withdrawn: Array<{ companyId: string; applicationId: string }> = [];
  const deps: ScreenDeps = {
    ...base,
    onWithdrawn: async (q, input) => {
      await base.onWithdrawn?.(q, input);
      withdrawn.push({ companyId: input.companyId, applicationId: input.applicationId });
    },
  };
  const record = async () => {
    for (const w of withdrawn.splice(0)) {
      const [app] = await withTenant(container.db, w.companyId, (tx) => tx.select({ id: applications.id, companyId: applications.companyId, candidateId: applications.candidateId }).from(applications).where(eq(applications.id, w.applicationId)).limit(1));
      if (app) await recordWithdrawal(container, app, "screening_chat");
    }
  };
  return { deps, record };
}

/** An answer changed on the "check your answers" page (E10): typed `text`, or a `tap`. */
export async function conversationEdit(container: Container, ref: ConversationRef, input: { questionKey: string; text?: string | null; tap?: TapAnswer | null }): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  return withTenant(container.db, ref.companyId, async (tx) => {
    if (ref.kind === "screen") {
      const b = await loadScreenBundle(tx, ref.id);
      if (!b) return { ok: false as const, error: "This conversation is no longer available." };
      return editScreenAnswer(tx, { screenId: ref.id, questionKey: input.questionKey, text: input.text, tap: input.tap, actor: { kind: "candidate", id: b.candidate.id }, now: container.engine.clock() });
    }
    const d = await loadDetached(tx, ref.id, { lock: true });
    if (!d || d.row.discardedAt || d.row.status !== "in_progress" || d.row.progress.phase !== "review") return { ok: false as const, error: "These answers can no longer be changed." };
    const question = d.packet.screening.questions.find((x) => x.key === input.questionKey);
    if (!question) return { ok: false as const, error: "That question is not part of this conversation." };
    const now = container.engine.clock();
    const typed = input.text?.trim().slice(0, 2000) ?? "";
    const tapped = input.tap ? tapWords(d.packet, { currentQuestionKey: question.key }, input.tap, now) : null;
    const words = tapped ?? typed;
    if (!words) return { ok: false as const, error: input.tap ? "That answer does not fit this question. Please type it instead." : "Please type an answer first." };
    const recorded = tapped ?? redactProtected(words);
    const answers = { ...d.row.answers, [question.key]: recorded };
    let progress: ScreenProgress = { ...d.row.progress, edits: { ...(d.row.progress.edits ?? {}), [question.key]: (d.row.progress.edits?.[question.key] ?? 0) + 1 } };
    if (progress.declined?.includes(question.key)) progress = { ...progress, declined: progress.declined.filter((k) => k !== question.key) };
    await tx.update(unconfirmedScreens).set({ answers, progress, lastCandidateMessageAt: now.toISOString(), transcript: [...d.row.transcript, { role: "candidate", content: words, at: now.toISOString(), channel: "web", questionKey: question.key, source: "edit" }] }).where(eq(unconfirmedScreens.id, d.row.id));
    return { ok: true as const, answer: recorded };
  });
}

/** "Send" on the "check your answers" page (E10). A detached conversation then asks the address owner to confirm. */
export async function conversationSubmit(container: Container, ref: ConversationRef): Promise<boolean> {
  const ok = await withTenant(container.db, ref.companyId, async (tx) => {
    if (ref.kind === "screen") return (await submitScreenAnswers(tx, screenDeps(container), { screenId: ref.id, actor: WEB_ACTOR })).ok;
    const d = await loadDetached(tx, ref.id, { lock: true });
    if (!d || d.row.discardedAt) return false;
    if (d.row.status === "completed") return true;
    if (d.row.status !== "in_progress" || d.row.progress.phase !== "review") return false;
    const now = container.engine.clock();
    await tx.update(unconfirmedScreens).set({ status: "completed", finishedAt: now.toISOString(), progress: { ...d.row.progress, submittedAt: now.toISOString() } }).where(eq(unconfirmedScreens.id, d.row.id));
    await askAddressOwner(tx, depsOf(container), d, "answers", now);
    return true;
  });
  await container.kick();
  return ok;
}

/** Repeat submissions of one application that still wait for the address owner (for the tests and the ITS console). */
export async function unconfirmedFor(tx: Tx, applicationId: string): Promise<Unconfirmed[]> {
  return tx.select().from(unconfirmedScreens).where(and(eq(unconfirmedScreens.applicationId, applicationId), inArray(unconfirmedScreens.confirmation, ["sent"]))).orderBy(desc(unconfirmedScreens.createdAt));
}
