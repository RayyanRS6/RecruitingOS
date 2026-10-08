import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  DraftRolePacket as DraftRolePacketSchema, IntakeServerState, RolePacket as RolePacketSchema,
  type Actor, type DeclinedCriterion, type DraftRolePacket, type IntakeAnswer, type IntakeExtraction, type IntakeFacts, type IntakeFactsPatch, type IntakeMessage,
  type IntakeQuestion, type IntakeRefusal, type IntakeSessionView, type IntakeTurn, type PayBenchmark, type Playbook, type PlaybookRole, type RolePacket,
} from "@ros/contracts";
import { intakeCompilePrompt, intakeExtractPrompt, intakeTurnPrompt, runPromptDetached, type AiRuntime, type IntakeContext } from "@ros/ai";
import {
  DECIDER_ROLES, DRAFT_IT_WORDS, ESSENTIAL_LABEL, INTERVIEWERS_DEFAULT_NOTE, SOMEONE_NEW, applyAnswers, applyFactsPatch, basisFromText, dealBreakerOffer, draftFactsKey, emit,
  guardPacket, intakeReadiness, normalizeCriterion, normalizeFacts, payCard, payConfirmed, payKey, payTyped, screenCriterion, typedByOwner, typedCeiling, unresolvedFlags,
  withoutRemoved, withoutServerOwned,
  type FactsEdit, type TeamMember,
} from "@ros/core";
import { companies, intakeSessions, memberships, playbooks, rolePackets, roles, users, withPlatform, withTenant, type Db, type Queryable, type Tx } from "@ros/db";
import { VERTICAL_TO_PLAYBOOK, compensationFor, findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import type { CompAdapter } from "@ros/integrations";
import { packetFingerprint } from "./packet-revise";

export type IntakeDeps = { ai: AiRuntime; comp: CompAdapter };

export type IntakeSessionRow = typeof intakeSessions.$inferSelect;

const EMPTY_FACTS: IntakeFacts = { mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] };

/**
 * Raised when a session is missing or no longer active, or (`stale_draft`) when a change was worked out on a draft that
 * has been rewritten or changed since; routes turn it into 404 or 409.
 */
export class IntakeSessionError extends Error {
  constructor(public readonly code: "not_found" | "not_active" | "stale_draft") {
    super(code === "not_found" ? "intake session not found" : code === "not_active" ? "intake session is no longer active" : "the draft changed since");
  }
}

/** The server's own record of a draft (pay confirmation, open cards, progress), with every default filled in. */
export function stateOf(row: Pick<IntakeSessionRow, "serverState">): IntakeServerState {
  const raw = (row.serverState ?? {}) as Record<string, unknown>;
  const parsed = IntakeServerState.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Every part that still reads is kept; one that does not is dropped on its own, never the pay confirmation with it.
  const out = IntakeServerState.parse({}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    const one = IntakeServerState.safeParse({ [k]: v });
    if (one.success) out[k] = (one.data as Record<string, unknown>)[k];
  }
  return out as IntakeServerState;
}

/**
 * The intake runs in three parts so no database transaction waits on the model or the wage service: a short
 * transaction records the owner's message and loads what the prompt needs; the benchmark lookup and the model call
 * happen with nothing held; a second short transaction persists the reply. The run is recorded whatever happens.
 */
type IntakeInputs = {
  company: typeof companies.$inferSelect;
  session: IntakeSessionRow;
  state: IntakeServerState;
  playbook: Playbook | null;
  playbookRole: PlaybookRole | null;
  playbookRow: { id: string; version: number } | null;
  titleGuess: string;
  locationText: string;
  /** Hourly or salary, known before the first market check (C2); null means ask first and check nothing yet. */
  basis: "hourly" | "salary" | null;
};

/** The basis a playbook role's pay table uses, when all of its rows agree (a dental hygienist is paid by the hour). */
function playbookBasis(role: PlaybookRole | null): "hourly" | "salary" | null {
  const bases = [...new Set((role?.compensation ?? []).map((r) => r.basis))];
  return bases.length === 1 ? bases[0] : null;
}

/** Hourly or salary before the first market check (C2): the facts, else the owner's own typed words, else the playbook role's table. */
export function basisFor(facts: IntakeFacts, typedWords: string[], role: PlaybookRole | null): "hourly" | "salary" | null {
  const stated = facts.compensationBasis === "hourly" || facts.compensationBasis === "salary" ? facts.compensationBasis : null;
  return stated ?? basisFromText(typedWords.join("\n")) ?? playbookBasis(role);
}

/** The fairness check the server applies to every answer a card offers (C6), for the evaluation harness. */
export { screenCriterion } from "@ros/core";

async function loadIntakeInputs(q: Queryable, companyId: string, sessionId: string): Promise<IntakeInputs> {
  const [company] = await q.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
  if (!company || !session) throw new IntakeSessionError("not_found");
  const playbookVertical = VERTICAL_TO_PLAYBOOK[company.vertical] ?? company.vertical;
  // The newest published version of the vertical's playbook (C2: this read the oldest).
  const pbRow = (await q.select().from(playbooks).where(eq(playbooks.vertical, playbookVertical)).orderBy(desc(playbooks.version)).limit(1))[0] ?? null;
  const playbook = pbRow?.content ?? findPlaybook(company.vertical);
  const facts = normalizeFacts(session.facts);
  const typed = typedByOwner(session.messages);
  // A pasted ad is never matched as a whole (an ad that mentions a receptionist is not a receptionist's job): only its
  // extracted title, or the owner's own typed words, name the job.
  const titleGuess = facts.title ?? typed[0] ?? "";
  const playbookRole = playbook && titleGuess ? matchPlaybookRole(playbook, titleGuess) : null;
  const locationText = facts.locationText ?? company.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ");
  const basis = basisFor(facts, typed, playbookRole);
  return { company, session, state: stateOf(session), playbook, playbookRole, playbookRow: pbRow ? { id: pbRow.id, version: pbRow.version } : null, titleGuess, locationText, basis };
}

export type BenchmarkResult = { benchmark: PayBenchmark | null; gap?: "basis_unknown" | "no_market_figure" };

/**
 * The pay benchmark (C2, C8): nothing until the basis is known; then the live wage service (a network call, made with
 * no transaction open), then the playbook's own table, labelled as an ITS estimate. A figure on the other basis is
 * never used: a $95,000 salary is not compared with hourly rates.
 */
export async function resolveBenchmark(comp: CompAdapter, inputs: Pick<IntakeInputs, "basis" | "playbookRole" | "titleGuess" | "locationText">): Promise<BenchmarkResult> {
  if (!inputs.basis) return { benchmark: null, gap: "basis_unknown" };
  try {
    const live = await comp.benchmark({ title: inputs.playbookRole?.title ?? inputs.titleGuess, locationText: inputs.locationText, basis: inputs.basis });
    if (live && live.basis === inputs.basis) return { benchmark: { basis: live.basis, p25: live.p25, p50: live.p50, p75: live.p75, source: live.source, metro: live.metro, asOf: live.asOf, origin: "market" } };
  } catch {
    // the wage service being down is not the owner's problem: fall through to the playbook
  }
  const row = inputs.playbookRole ? compensationFor(inputs.playbookRole, inputs.locationText) : null;
  if (row && row.basis === inputs.basis) return { benchmark: { basis: row.basis, p25: row.p25, p50: row.p50, p75: row.p75, source: `${row.source} (ITS playbook estimate)`, metro: row.metro, asOf: row.asOf, origin: "its_estimate" } };
  return { benchmark: null, gap: "no_market_figure" };
}

/**
 * The confirmed pay the draft may carry, or null: never the model's figures, never a figure nobody confirmed. The
 * ceiling too is the one recorded with the confirmation, never one the model read into the facts afterwards.
 */
function confirmedPayOf(facts: IntakeFacts, state: IntakeServerState): IntakeContext["confirmedPay"] {
  if (!payConfirmed(facts, state) || !state.pay) return null;
  return { basis: state.pay.basis, min: state.pay.min, max: state.pay.max, ...(state.pay.ceiling !== undefined ? { ceiling: state.pay.ceiling } : {}) };
}

function contextFrom(inputs: IntakeInputs, bench: BenchmarkResult): IntakeContext {
  const { company, session, state } = inputs;
  const facts = normalizeFacts(session.facts);
  const adText = state.ad ? session.messages[state.ad.messageIndex]?.content ?? null : null;
  return {
    company: { name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, locations: company.locations, benefitsSummary: company.settings.benefitsSummary, website: company.settings.website },
    playbook: inputs.playbook,
    playbookRole: inputs.playbookRole,
    benchmark: bench.benchmark,
    benchmarkGap: bench.gap,
    facts,
    messages: session.messages,
    ad: adText ? { text: adText } : null,
    confirmedPay: confirmedPayOf(facts, state),
    fromRole: state.fromRole ? { title: state.fromRole.title, version: state.fromRole.version } : null,
  };
}

/** The active members of the company, for team cards and the decision maker (C15). */
export async function loadTeam(q: Queryable, companyId: string): Promise<TeamMember[]> {
  const rows = await q.select({ userId: memberships.userId, role: memberships.role, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active")));
  return rows.map((r) => ({ userId: r.userId, role: r.role, name: r.name ?? r.email }));
}

const BASIS_CARD = (id: string): IntakeQuestion => ({
  id,
  field: "compensation_basis",
  prompt: "Is this job paid by the hour or a yearly salary?",
  mode: "single",
  options: [{ label: "By the hour", value: "hourly", origin: "assistant" }, { label: "A yearly salary", value: "salary", origin: "assistant" }],
  allowOwn: false,
  why: "So the pay is compared with the right market figures.",
});

/**
 * The cards as they are stored and shown (C6, C15, C17). The server, not the model: numbers every card; fills team cards
 * with the real team (deciders only for the final say) and "Someone not on the team yet"; clears the options of the
 * pay card (drawn from the pay data); drops any offered answer that fails the fairness check; asks hourly or salary first
 * when nobody knows; offers stated deal-breakers back as must-haves. Three cards at most.
 */
export function prepareQuestions(raw: IntakeQuestion[], input: { turnNo: number; team: TeamMember[]; basisKnown: boolean; payConfirmed: boolean; dealBreakers: string[] }): IntakeQuestion[] {
  const out: IntakeQuestion[] = [];
  for (const q of raw) {
    if (out.some((x) => x.field === q.field)) continue;
    if (q.mode === "team" || q.field === "interviewers" || (q.field === "decision_maker" && q.mode !== "free")) {
      const deciders = q.field === "decision_maker";
      const members = input.team.filter((m) => !deciders || DECIDER_ROLES.includes(m.role));
      out.push({ ...q, mode: "team", options: [...members.slice(0, 7).map((m) => ({ label: m.name.slice(0, 200), value: m.userId, origin: "team" as const })), { label: "Someone not on the team yet", value: SOMEONE_NEW, origin: "team" as const }], allowOwn: true });
      continue;
    }
    if (q.mode === "pay" || q.field === "compensation") {
      if (input.payConfirmed) continue;
      out.push({ ...q, field: "compensation", mode: "pay", options: [], allowOwn: true });
      continue;
    }
    const options = q.options.filter((o) => !screenCriterion(o.label) && !screenCriterion(o.value)).slice(0, 6);
    if ((q.mode === "single" || q.mode === "multi") && !options.length && !q.allowOwn) continue;
    out.push({ ...q, options });
  }
  const cards: IntakeQuestion[] = [];
  if (!input.basisKnown && !input.payConfirmed && !out.some((q) => q.field === "compensation_basis" || q.mode === "pay")) cards.push(BASIS_CARD("basis"));
  const deal: IntakeQuestion | null = input.dealBreakers.length
    ? { id: "deal", field: "must_haves", prompt: "You named these as deal-breakers. Which should count openly as must-haves?", mode: "multi", options: input.dealBreakers.slice(0, 6).map((d) => ({ label: d.slice(0, 200), value: d.slice(0, 500), origin: "owner" as const })), allowOwn: false, why: "Every application is reviewed against the must-haves, and a person can explain them to a candidate; anything left out here is not used to judge anyone." }
    : null;
  const room = 3 - cards.length - (deal ? 1 : 0);
  // The deal-breaker card replaces a must-haves card of the model's own, so the owner is asked once.
  cards.push(...out.filter((q) => !(deal && q.field === "must_haves")).slice(0, Math.max(0, room)));
  if (deal) cards.push(deal);
  return cards.slice(0, 3).map((q, i) => ({ ...q, id: `q${input.turnNo}_${i + 1}` }));
}

export type IntakeTurnInput = { companyId: string; sessionId: string; actor: Actor; message?: { content: string; kind?: IntakeMessage["kind"] } };
export type IntakeTurnOk = { turn: IntakeTurn; aiRunId: string; notARole: boolean; benchmark: PayBenchmark | null; benchmarkGap: "basis_unknown" | "no_market_figure" | null };
export type IntakeTurnOutcome = IntakeTurnOk | { error: string; aiRunId: string };

/**
 * The cheap first read of a pasted ad (C5), once per draft, before the market check: the title, the place, the basis
 * and the pay it states go into the facts, so the job is benchmarked as itself. The pay read from an ad is never taken
 * as confirmed; the pay card asks the owner whether it is still current.
 */
async function readPastedAd(db: Db, deps: IntakeDeps, input: { companyId: string; sessionId: string }): Promise<void> {
  const pending = await withTenant(db, input.companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    const state = s ? stateOf(s) : null;
    if (!s || !state?.ad || state.ad.extracted) return null;
    const [company] = await q.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
    return { text: s.messages[state.ad.messageIndex]?.content ?? "", companyName: company?.name ?? "the company" };
  });
  if (!pending) return;
  const out = await runPromptDetached(db, deps.ai, intakeExtractPrompt, pending, { companyId: input.companyId, inputRef: { sessionId: input.sessionId, read: "pasted_ad" } });
  await withTenant(db, input.companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!s) return;
    const state = stateOf(s);
    if (!state.ad) return;
    const facts = out.ok && out.output.isJobDescription ? factsFromExtraction(normalizeFacts(s.facts), out.output) : normalizeFacts(s.facts);
    if (!out.ok) await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: { kind: "agent", id: "intake", runId: out.runId }, subject: { type: "intake_session", id: s.id }, payload: { reason: out.reason, error: out.error, read: "pasted_ad" } });
    await q.update(intakeSessions).set({ facts, serverState: { ...state, ad: { ...state.ad, extracted: true } } }).where(eq(intakeSessions.id, s.id));
  });
}

/** What the ad states fills only what is not known yet; nothing in it overrides the owner's own words. */
export function factsFromExtraction(facts: IntakeFacts, x: IntakeExtraction): IntakeFacts {
  const f = { ...facts };
  if (x.title && !f.title) f.title = x.title;
  if (x.locationText && !f.locationText) f.locationText = x.locationText;
  if (x.employmentType && !f.employmentType) f.employmentType = x.employmentType;
  if (x.schedule && !f.schedule) f.schedule = x.schedule;
  if (x.compensationBasis && !f.compensationBasis) f.compensationBasis = x.compensationBasis;
  if (x.compensationMin !== undefined && f.compensationMin === undefined) {
    f.compensationMin = x.compensationMin;
    f.compensationMax = x.compensationMax ?? x.compensationMin;
  }
  return f;
}

/**
 * Starts a draft together with its first message (C3): a draft is never created empty. A long first message is kept as
 * a pasted ad (C5); "just draft it" in typed words is recorded; a "hire again" draft starts from that role's facts.
 */
export async function startIntakeSession(
  tx: Tx,
  input: { companyId: string; actor: Actor; userId: string | null; message: { content: string; kind: NonNullable<IntakeMessage["kind"]> }; facts?: IntakeFacts; fromRole?: IntakeServerState["fromRole"]; via?: string },
): Promise<IntakeSessionRow> {
  const at = new Date().toISOString();
  const state: Partial<IntakeServerState> = {};
  if (input.message.kind === "pasted_ad") state.ad = { messageIndex: 0, chars: input.message.content.length, extracted: false, takenFromAd: [] };
  if (input.message.kind === "text" && DRAFT_IT_WORDS.test(input.message.content)) state.draftRequestedAt = at;
  if (input.fromRole) state.fromRole = input.fromRole;
  const [session] = await tx
    .insert(intakeSessions)
    .values({ companyId: input.companyId, createdBy: input.actor, createdByUserId: input.userId, messages: [{ role: "owner", content: input.message.content, at, kind: input.message.kind }], facts: input.facts ?? EMPTY_FACTS, serverState: state })
    .returning();
  await emit(tx, { type: "intake.started", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { kind: input.message.kind, ...(input.via ? { via: input.via } : {}), ...(input.fromRole ? { fromRoleId: input.fromRole.roleId } : {}) } });
  return session;
}

/** One owner message in (or none, when it was already recorded), one assistant reply out. Persists the transcript, the facts and the cards. */
export async function runIntakeTurn(db: Db, deps: IntakeDeps, input: IntakeTurnInput): Promise<IntakeTurnOutcome> {
  const now = new Date().toISOString();
  await withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    if (!input.message) return;
    const kind = input.message.kind ?? "text";
    const messages = [...session.messages, { role: "owner" as const, content: input.message.content, at: now, kind }];
    const state = stateOf(session);
    if (kind === "text" && DRAFT_IT_WORDS.test(input.message.content) && !state.draftRequestedAt) state.draftRequestedAt = now;
    await q.update(intakeSessions).set({ messages, serverState: state }).where(eq(intakeSessions.id, session.id));
  });
  await readPastedAd(db, deps, input);
  const inputs = await withTenant(db, input.companyId, (q) => loadIntakeInputs(q, input.companyId, input.sessionId));
  const bench = await resolveBenchmark(deps.comp, inputs);
  const turnNo = inputs.session.messages.filter((m) => m.role === "owner").length;
  const out = await runPromptDetached(db, deps.ai, intakeTurnPrompt, contextFrom(inputs, bench), { companyId: input.companyId, inputRef: { sessionId: input.sessionId, turn: inputs.session.messages.length } });
  const agent: Actor = { kind: "agent", id: "intake", runId: out.runId };
  return withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (!out.ok) {
      await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: out.reason, error: out.error } });
      return { error: out.error, aiRunId: out.runId };
    }
    if (session.status !== "active") return { error: "This conversation has already produced a role.", aiRunId: out.runId };
    const state = stateOf(session);
    const before = normalizeFacts(session.facts);
    const merged = mergeFacts(before, withoutServerOwned(out.output.factsExtracted), state.removed);
    // The facts only the server sets come from the stored row, never from the model.
    merged.decisionMakerUserId = before.decisionMakerUserId;
    merged.interviewerUserIds = before.interviewerUserIds;
    merged.suggestions = before.suggestions;
    if (merged.decisionMakerUserId && merged.decisionMaker !== before.decisionMaker) merged.decisionMakerUserId = undefined;
    const offer = dealBreakerOffer(merged, state.dealBreakersOffered);
    if (offer.declined.length) merged.declinedCriteria = [...merged.declinedCriteria, ...offer.declined.filter((d) => !merged.declinedCriteria.some((x) => normalizeCriterion(x.requested) === normalizeCriterion(d.requested))).map((d) => ({ requested: d.requested, reason: d.reason, ...(d.alternative ? { alternative: d.alternative } : {}) }))];
    const firstTurn = session.messages.filter((m) => m.role === "owner").length === 1 && !state.fromRole;
    const notARole = firstTurn && out.output.notARole;
    const team = await loadTeam(q, input.companyId);
    const basisKnown = merged.compensationBasis === "hourly" || merged.compensationBasis === "salary" || inputs.basis !== null;
    if (payTyped(session.messages, merged) && !payConfirmed(merged, state)) {
      const ceiling = typedCeiling(session.messages, merged);
      state.pay = { by: actorOfTurn(input.actor), at: new Date().toISOString(), via: "typed", basis: merged.compensationBasis as "hourly" | "salary", min: merged.compensationMin!, max: merged.compensationMax!, ...(ceiling !== undefined ? { ceiling } : {}) };
      await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: "typed" } });
    } else if (state.pay && payConfirmed(merged, state)) {
      // Once the range is settled the ceiling is the person's: one they typed in this very message replaces it; one the
      // model read anywhere else (an earlier message, an ad) does not.
      const said = input.message && (input.message.kind ?? "text") === "text" ? [{ role: "owner" as const, content: input.message.content, at: now }] : [];
      const ceiling = typedCeiling(said, merged);
      if (ceiling !== undefined && ceiling !== state.pay.ceiling) {
        state.pay = { ...state.pay, by: actorOfTurn(input.actor), at: new Date().toISOString(), via: "typed", ceiling };
        await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: "typed", ceiling: true } });
      }
    }
    // The facts show the ceiling that was confirmed, so the pay card and the draft say the same.
    if (state.pay && payConfirmed(merged, state)) {
      if (state.pay.ceiling !== undefined) merged.compensationCeiling = state.pay.ceiling;
      else delete merged.compensationCeiling;
    }
    const questions = notARole ? [] : prepareQuestions(out.output.questions, { turnNo, team, basisKnown, payConfirmed: payConfirmed(merged, state), dealBreakers: offer.offer });
    state.openQuestions = questions;
    state.dealBreakersOffered = [...state.dealBreakersOffered, ...offer.offer];
    state.benchmark = bench.benchmark;
    state.benchmarkGap = bench.gap;
    if (state.ad && out.output.takenFromAd.length && !state.ad.takenFromAd.length) state.ad = { ...state.ad, takenFromAd: out.output.takenFromAd };
    const withReply = [...session.messages, { role: "assistant" as const, content: out.output.assistantMessage, at: new Date().toISOString(), aiRunId: out.runId }];
    await q.update(intakeSessions).set({ messages: withReply, facts: merged, missingFacts: out.output.missingFacts, serverState: state, ...(notARole ? { status: "abandoned" } : {}) }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.turn_completed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { readyToCompile: out.output.readyToCompile, missing: out.output.missingFacts, confidence: out.output.confidence, questions: questions.map((x) => x.field) } });
    // Not a role: nothing is left behind as a draft (founder decision Q5); the conversation stays in the record.
    if (notARole) await emit(q, { type: "intake.abandoned", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: "not_a_role", turns: withReply.length } });
    return { turn: { ...out.output, factsExtracted: merged, questions }, aiRunId: out.runId, notARole, benchmark: bench.benchmark, benchmarkGap: bench.gap ?? null };
  });
}

const actorOfTurn = (a: Actor): Actor => ({ kind: a.kind, id: a.id, ...(a.name ? { name: a.name } : {}) });

export type EditOutcome = { session: IntakeSessionRow; refused: IntakeRefusal[]; summary: string[] };

/**
 * Tapped answers and panel edits (C6, C7). One summary goes into the conversation as the owner's message (C15), words
 * typed beside the cards go in as their own message, the facts change with set / add / remove semantics (not the
 * append-only merge), pay set on the card or the panel is recorded as set by this person, and values a person took out
 * are held out of what the assistant sends back. The next turn, if any, is the caller's.
 */
export async function applyIntakeEdit(db: Db, input: { companyId: string; sessionId: string; actor: Actor; answers: IntakeAnswer[]; patch?: IntakeFactsPatch; draftIt?: boolean; note?: string }): Promise<EditOutcome> {
  return withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const state = stateOf(session);
    const team = await loadTeam(q, input.companyId);
    const fromAnswers = applyAnswers(normalizeFacts(session.facts), state.openQuestions, input.answers, team);
    const fromPatch = input.patch ? applyFactsPatch(fromAnswers.facts, input.patch, team) : null;
    const edits: FactsEdit[] = fromPatch ? [fromAnswers, fromPatch] : [fromAnswers];
    const facts = (fromPatch ?? fromAnswers).facts;
    const now = new Date().toISOString();
    const removed = [...state.removed];
    for (const e of edits) {
      for (const r of e.restored) for (let i = removed.length - 1; i >= 0; i--) if (removed[i].field === r.field && normalizeCriterion(removed[i].value) === normalizeCriterion(r.value)) removed.splice(i, 1);
      for (const r of e.removed) if (!removed.some((x) => x.field === r.field && normalizeCriterion(x.value) === normalizeCriterion(r.value))) removed.push(r);
    }
    state.removed = removed;
    const pay = fromPatch?.pay ?? fromAnswers.pay;
    if (pay) {
      state.pay = { by: actorOfTurn(input.actor), at: now, via: pay.via, basis: pay.basis, min: pay.min, max: pay.max, ...(pay.ceiling !== undefined ? { ceiling: pay.ceiling } : {}) };
      await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: pay.via } });
    }
    const answered = new Set(input.answers.map((a) => a.questionId));
    state.openQuestions = state.openQuestions.filter((x) => !answered.has(x.id));
    if (input.answers.length) state.answeredRounds += 1;
    if (input.draftIt && !state.draftRequestedAt) state.draftRequestedAt = now;
    if (input.note && DRAFT_IT_WORDS.test(input.note) && !state.draftRequestedAt) state.draftRequestedAt = now;
    const summary = edits.flatMap((e) => e.summary);
    const refused = edits.flatMap((e) => e.refused);
    const lines = [...summary, ...refused.map((r) => `Not used: "${r.text}". ${r.reason}`)];
    if (!lines.length && input.answers.length) lines.push("Skipped those questions.");
    if (input.draftIt) lines.push("Draft it.");
    const messages = [...session.messages];
    if (lines.length) messages.push({ role: "owner", content: lines.join("\n"), at: now, kind: "answers" });
    if (input.note) messages.push({ role: "owner", content: input.note, at: now, kind: "text" });
    // Typed pay in the note counts as set by this person, as in any typed message.
    if (!pay && payTyped(messages, facts) && !payConfirmed(facts, state)) {
      const ceiling = typedCeiling(messages, facts);
      state.pay = { by: actorOfTurn(input.actor), at: now, via: "typed", basis: facts.compensationBasis as "hourly" | "salary", min: facts.compensationMin!, max: facts.compensationMax!, ...(ceiling !== undefined ? { ceiling } : {}) };
      await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: "typed" } });
    }
    const [updated] = await q.update(intakeSessions).set({ facts, messages, serverState: state }).where(eq(intakeSessions.id, session.id)).returning();
    await emit(q, { type: "intake.answered", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { questionIds: [...answered], edited: !!input.patch, refused: refused.length, draftIt: !!input.draftIt } });
    return { session: updated, refused, summary };
  });
}

export type DraftOutcome = { draft: DraftRolePacket; aiRunId: string } | { error: string; aiRunId: string };

async function setProgress(db: Db, companyId: string, sessionId: string, stage: NonNullable<IntakeServerState["progress"]>["stage"]): Promise<void> {
  await withTenant(db, companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
    if (!s) return;
    const state = stateOf(s);
    const at = new Date().toISOString();
    state.progress = { stage, startedAt: stage === "benchmark" ? at : state.progress?.startedAt ?? at, at };
    await q.update(intakeSessions).set({ serverState: state }).where(eq(intakeSessions.id, sessionId));
  });
}

/**
 * Writes the draft beside the conversation (C7, founder decision Q8): one model call at the judgment tier, never per
 * turn. Each stage is recorded as it starts (benchmark, writing, then checking, which runs the checks and saves in one
 * transaction, then done) so the page can show real progress while it polls; the draft carries pay only once a person
 * set or confirmed it, then passes the packet guard. The answers the model wrote from are recorded as a key, so the page
 * can tell when they change afterwards.
 */
export async function draftIntake(db: Db, deps: IntakeDeps, input: { companyId: string; sessionId: string; actor: Actor }): Promise<DraftOutcome> {
  await withTenant(db, input.companyId, async (q) => {
    const [s] = await q.select({ status: intakeSessions.status }).from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!s) throw new IntakeSessionError("not_found");
    if (s.status !== "active") throw new IntakeSessionError("not_active");
  });
  await setProgress(db, input.companyId, input.sessionId, "benchmark");
  const inputs = await withTenant(db, input.companyId, (q) => loadIntakeInputs(q, input.companyId, input.sessionId));
  const bench = await resolveBenchmark(deps.comp, inputs);
  await setProgress(db, input.companyId, input.sessionId, "writing");
  const ctx = contextFrom(inputs, bench);
  const out = await runPromptDetached(db, deps.ai, intakeCompilePrompt, ctx, { companyId: input.companyId, inputRef: { sessionId: input.sessionId }, maxTokens: 24000 });
  const agent: Actor = { kind: "agent", id: "intake", runId: out.runId };
  if (!out.ok) {
    await setProgress(db, input.companyId, input.sessionId, "failed");
    await withTenant(db, input.companyId, (q) => emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: input.sessionId }, payload: { reason: out.reason, error: out.error } }));
    return { error: out.error, aiRunId: out.runId };
  }
  await setProgress(db, input.companyId, input.sessionId, "checking");
  return withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const state = stateOf(session);
    const facts = normalizeFacts(session.facts);
    const draft = finalizeDraft(out.output, { ...ctx, facts }, { sessionId: session.id, aiRunId: out.runId, state, actor: input.actor, previousFlags: session.draftPacket?.provenance.flags ?? [], benchmark: bench.benchmark, messages: session.messages });
    const at = new Date().toISOString();
    // The key is of the answers the model was given, so anything changed while it wrote shows the draft as out of date.
    state.draft = { at, aiRunId: out.runId, by: actorOfTurn(input.actor), payKey: payConfirmed(facts, state) ? payKey(state) : null, factsKey: draftFactsKey(ctx.facts), edits: 0 };
    state.progress = { stage: "done", startedAt: state.progress?.startedAt ?? at, at };
    state.benchmark = bench.benchmark;
    state.benchmarkGap = bench.gap;
    await q.update(intakeSessions).set({ draftPacket: draft, serverState: state }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.drafted", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { aiRunId: out.runId, requestedBy: input.actor.id, flags: unresolvedFlags(draft).length, assumptions: draft.provenance.assumptions.length, payConfirmed: !!draft.compensation } });
    return { draft, aiRunId: out.runId };
  });
}

/** An assumption line the server itself writes below (an essential not set, the pay not set, who interviews by default). */
const serverAssumption = (a: string) => a.startsWith("Not set yet: ") || a === PAY_NOT_SET || a.endsWith(INTERVIEWERS_DEFAULT_NOTE);
const PAY_NOT_SET = "Pay is not set yet: nobody has set or confirmed it.";

/**
 * The deterministic part after the model (C1, C7, C15, C17): pay only from a person's confirmation (with who and how),
 * the decision maker and the interviewers as team members, the owner's deal-breakers in their own words, the essentials
 * still missing listed as assumptions, the market figure on the record, and then the packet guard. Run again on a saved
 * draft (a change by chat, asking for approval), it brings all of that up to date with the answers as they are now.
 *
 * Nothing the model wrote about who decided what is kept: its `ownerStated`, its wording flags (a flag "kept" by the
 * model would read as kept by the person asking, so a pasted ad could switch the fairness check off), and interviewer
 * ids it made up. The guard writes the flags afresh; a person's earlier keeps carry over through `previousFlags`.
 */
export function finalizeDraft(
  raw: DraftRolePacket,
  ctx: IntakeContext,
  prov: { sessionId: string; aiRunId: string; state: IntakeServerState; actor?: Actor; previousFlags?: DraftRolePacket["provenance"]["flags"]; benchmark?: PayBenchmark | null; messages?: IntakeMessage[] },
): DraftRolePacket {
  const packet: DraftRolePacket = structuredClone(raw);
  delete packet.provenance.flags;
  const facts = normalizeFacts(ctx.facts);
  const pay = confirmedPayOf(facts, prov.state);
  const benchmark = prov.benchmark ?? null;
  if (pay && prov.state.pay) {
    const benefits = packet.compensation?.benefitsSummary ?? facts.benefits;
    const sources = [...(packet.compensation?.sources ?? []).filter((s) => s.name !== "owner-stated"), ...(benchmark ? [{ name: benchmark.source, detail: `${benchmark.metro}: p25 ${benchmark.p25}, p50 ${benchmark.p50}, p75 ${benchmark.p75}` }] : []), { name: "owner-stated", detail: `${pay.min}–${pay.max} ${pay.basis}` }];
    packet.compensation = {
      basis: pay.basis as "hourly" | "salary",
      currency: packet.compensation?.currency ?? "USD",
      min: pay.min,
      mid: Math.round((pay.min + pay.max) / 2),
      max: pay.max,
      ceiling: Math.max(pay.ceiling ?? pay.max, pay.max),
      ...(packet.compensation?.bonus ? { bonus: packet.compensation.bonus } : {}),
      ...(benefits ? { benefitsSummary: benefits } : {}),
      discloseRange: true,
      sources: sources.filter((s, i) => sources.findIndex((x) => x.name === s.name) === i),
      ownerStated: true,
    };
    packet.provenance.payConfirmedBy = { by: prov.state.pay.by, at: prov.state.pay.at, via: prov.state.pay.via };
    packet.provenance.payOrigin = prov.state.pay.via;
  } else {
    delete packet.compensation;
    delete packet.provenance.payConfirmedBy;
    delete packet.provenance.payOrigin;
  }
  packet.preferences.decisionMakerName = facts.decisionMaker ?? packet.preferences.decisionMakerName;
  if (facts.decisionMakerUserId) packet.preferences.decisionMakerUserId = facts.decisionMakerUserId;
  else delete packet.preferences.decisionMakerUserId;
  packet.preferences.dealBreakersInTheirWords = facts.dealBreakers;
  // Who interviews is chosen from the team on a card or the panel; ids the model wrote (made up, or people nobody chose) are not kept.
  for (const r of packet.interviews.plan) r.interviewerUserIds = [...(facts.interviewerUserIds ?? [])];
  const readiness = intakeReadiness({ facts, state: prov.state, messages: prov.messages ?? ctx.messages, draft: null });
  const notSet = readiness.essentials.filter((e) => !e.done).map((e) => `Not set yet: ${ESSENTIAL_LABEL[e.key].toLowerCase()}.`);
  const assumed = readiness.essentials.filter((e) => e.done && e.note).map((e) => `${ESSENTIAL_LABEL[e.key]}: ${e.value}. ${e.note}`);
  // The server's own lines are written afresh each time, so a saved draft never keeps one the answers have since settled.
  const modelAssumptions = (packet.provenance.assumptions ?? []).filter((a) => !serverAssumption(a));
  packet.provenance = {
    ...packet.provenance,
    intakeSessionId: prov.sessionId,
    aiRunIds: [...new Set([...(packet.provenance.aiRunIds ?? []), ...(prov.aiRunId ? [prov.aiRunId] : [])])],
    playbookId: ctx.playbook ? `${ctx.playbook.vertical}@v${ctx.playbook.version}` : packet.provenance.playbookId,
    playbookVersion: ctx.playbook?.version ?? packet.provenance.playbookVersion,
    sources: [...new Set([...(packet.provenance.sources ?? []), ...(benchmark ? [benchmark.source] : [])])],
    assumptions: [...new Set([...modelAssumptions, ...assumed, ...notSet, ...(pay ? [] : [PAY_NOT_SET])])],
    ...(benchmark ? { benchmark } : {}),
  };
  if (!benchmark) delete packet.provenance.benchmark;
  const declined: DeclinedCriterion[] = facts.declinedCriteria;
  const guarded = guardPacket(packet, { companyName: ctx.company.name, companyLocations: ctx.company.locations, declined, previousFlags: prov.previousFlags ?? [], actor: prov.actor, now: new Date().toISOString() });
  return DraftRolePacketSchema.parse(guarded.packet);
}

/**
 * The packet as it goes to approval: the draft with confirmed pay, through the guard once more, as a full Role Packet.
 * Kept for the evaluation harness and older callers, which hand it the model's packet directly.
 */
export function finalizePacket(raw: RolePacket | DraftRolePacket, ctx: IntakeContext, prov: { sessionId: string; aiRunId: string; state?: IntakeServerState; actor?: Actor }): RolePacket {
  const outside = prov.state ? null : confirmedStateFrom(normalizeFacts(ctx.facts), raw);
  const state = prov.state ?? outside!.state;
  const draft = finalizeDraft(raw, outside ? { ...ctx, facts: outside.facts } : ctx, { sessionId: prov.sessionId, aiRunId: prov.aiRunId, state, actor: prov.actor, benchmark: ctx.benchmark ? benchmarkOf(ctx.benchmark) : null });
  return RolePacketSchema.parse(draft);
}

/** For callers outside a session (the evals): the case's own pay counts as confirmed, as the owner typed it there. */
function confirmedStateFrom(facts: IntakeFacts, raw: RolePacket | DraftRolePacket): { facts: IntakeFacts; state: IntakeServerState } {
  const basis = (facts.compensationBasis ?? raw.compensation?.basis) as "hourly" | "salary" | undefined;
  const min = facts.compensationMin ?? raw.compensation?.min;
  const max = facts.compensationMax ?? raw.compensation?.max;
  const state = IntakeServerState.parse({});
  if (!basis || min === undefined || max === undefined) return { facts, state };
  state.pay = { by: { kind: "system", id: "eval" }, at: new Date().toISOString(), via: "typed", basis, min, max };
  return { facts: { ...facts, compensationBasis: basis, compensationMin: min, compensationMax: max }, state };
}

function benchmarkOf(b: NonNullable<IntakeContext["benchmark"]>): PayBenchmark {
  return { basis: b.basis === "salary" ? "salary" : "hourly", p25: b.p25, p50: b.p50, p75: b.p75, source: b.source, metro: b.metro, ...(b.asOf ? { asOf: b.asOf } : {}), origin: b.origin ?? "market" };
}

export type CompiledIntake = { roleId: string; packet: RolePacket; version: number; aiRunId: string };
export type ApprovalAsk = CompiledIntake | { error: string; aiRunId: string } | { notReady: string[] };

/**
 * "Ask for approval" (C7): creates the role and packet version 1 and hands the transaction to `finalize` (the caller
 * starts the approval workflow and records the plan's allowance there), so everything commits together or nothing
 * does. Refused, with plain reasons, until there is a written draft that is up to date with the answers, the six
 * essentials are in, a person set or confirmed the pay, and no wording check is open.
 *
 * The role is made from the draft the person saw: its words are never rewritten here. The parts set by rule (the pay
 * set or confirmed since, who decides and who interviews, the deal-breakers, the assumptions) are brought up to date
 * with the answers as they are now. Only the one-step `draftFirst` path (POST /compile, for API clients) writes a draft
 * first, when there is none, or when the answers moved on and nobody saved a change on it since. Two asks at once take
 * turns on the draft's row: the second gets the role the first created.
 */
export async function requestIntakeApproval(
  db: Db,
  deps: IntakeDeps,
  input: { companyId: string; sessionId: string; actor: Actor; hiringManagerUserId?: string | null },
  opts: { finalize?: (q: Tx, compiled: CompiledIntake) => Promise<void>; draftFirst?: boolean } = {},
): Promise<ApprovalAsk> {
  const first = await withTenant(db, input.companyId, async (q): Promise<{ existing: CompiledIntake } | { blockers: string[] } | { redraft: boolean }> => {
    const existing = await alreadyCompiled(q, input.sessionId);
    if (existing) return { existing };
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!s) throw new IntakeSessionError("not_found");
    if (s.status !== "active") throw new IntakeSessionError("not_active");
    const state = stateOf(s);
    const facts = normalizeFacts(s.facts);
    const draft = s.draftPacket ?? null;
    const now = intakeReadiness({ facts, state, messages: s.messages, draft });
    const redraft = !!opts.draftFirst && (!draft || (now.draftOutOfDate && now.draftEdits === 0));
    const readiness = redraft ? intakeReadiness({ facts, state, messages: s.messages, draft: null, draftRequired: false }) : now;
    if (!readiness.mayAskForApproval) return { blockers: readiness.approvalBlockers };
    return { redraft };
  });
  if ("existing" in first) return first.existing;
  if ("blockers" in first) return { notReady: first.blockers };
  let aiRunId = "";
  if (first.redraft) {
    const drafted = await draftIntake(db, deps, input);
    if ("error" in drafted) return drafted;
    aiRunId = drafted.aiRunId;
  }
  return withTenant(db, input.companyId, async (q): Promise<ApprovalAsk> => {
    // One ask at a time per draft: the row is locked first, so whoever comes second finds the role the first created.
    const [locked] = await q.select({ id: intakeSessions.id }).from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!locked) throw new IntakeSessionError("not_found");
    const existing = await alreadyCompiled(q, input.sessionId);
    if (existing) return existing;
    const loaded = await loadIntakeInputs(q, input.companyId, input.sessionId);
    const { session, state } = loaded;
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const stored = session.draftPacket;
    const facts = normalizeFacts(session.facts);
    const before = intakeReadiness({ facts, state, messages: session.messages, draft: stored });
    if (!stored || !before.mayAskForApproval) return { notReady: before.approvalBlockers };
    const runId = aiRunId || state.draft?.aiRunId || "";
    const agent: Actor = { kind: "agent", id: "intake", ...(runId ? { runId } : {}) };
    // The deterministic part once more, on the words the person saw, against the answers and the pay as they are now.
    const ctx = contextFrom(loaded, { benchmark: state.benchmark ?? null, gap: state.benchmarkGap });
    const draft = finalizeDraft(stored, { ...ctx, facts }, { sessionId: session.id, aiRunId: runId, state, actor: input.actor, previousFlags: stored.provenance.flags ?? [], benchmark: state.benchmark ?? null, messages: session.messages });
    const after = intakeReadiness({ facts, state, messages: session.messages, draft });
    if (!after.mayAskForApproval) return { notReady: after.approvalBlockers };
    const packet = RolePacketSchema.parse(draft);
    const [role] = await q
      .insert(roles)
      .values({
        companyId: input.companyId,
        title: packet.identity.title,
        status: "pending_approval",
        hiringManagerUserId: input.hiringManagerUserId ?? null,
        playbookId: loaded.playbookRow?.id ?? null,
        playbookVersion: loaded.playbookRow?.version ?? null,
        playbookRoleKey: loaded.playbookRole?.key ?? null,
        createdBy: input.actor,
      })
      .returning();
    const [pv] = await q
      .insert(rolePackets)
      .values({ companyId: input.companyId, roleId: role.id, version: 1, packet, status: "proposed", source: "intake_agent", changeSummary: "Drafted with the assistant from the conversation", createdBy: agent })
      .returning();
    await q.update(intakeSessions).set({ roleId: role.id, status: "compiled", draftPacket: packet }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.compiled", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { roleId: role.id } });
    await emit(q, { type: "intake.approval_requested", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { roleId: role.id, payConfirmedVia: packet.provenance.payOrigin ?? null } });
    await emit(q, { type: "role.created", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { title: role.title, sessionId: session.id } });
    await emit(q, { type: "role_packet.proposed", companyId: input.companyId, actor: agent, subject: { type: "role_packet", id: `${role.id}:1` }, payload: { version: 1, assumptions: packet.provenance.assumptions } });
    const compiled: CompiledIntake = { roleId: role.id, packet, version: pv.version, aiRunId: runId };
    if (opts.finalize) await opts.finalize(q, compiled);
    return compiled;
  });
}

/** The one-step path older callers use: draft if needed, then ask for approval, under exactly the same rules. */
export const compileIntake = (db: Db, deps: IntakeDeps, input: Parameters<typeof requestIntakeApproval>[2], opts: Omit<NonNullable<Parameters<typeof requestIntakeApproval>[3]>, "draftFirst"> = {}): Promise<ApprovalAsk> =>
  requestIntakeApproval(db, deps, input, { ...opts, draftFirst: true });

async function alreadyCompiled(q: Queryable, sessionId: string): Promise<CompiledIntake | null> {
  const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
  if (!session) throw new IntakeSessionError("not_found");
  if (!session.roleId) return null;
  const [existing] = await q.select().from(rolePackets).where(eq(rolePackets.roleId, session.roleId)).limit(1);
  return existing ? { roleId: session.roleId, packet: existing.packet, version: existing.version, aiRunId: "" } : null;
}

/**
 * Keeps a flagged phrase in the draft with the person's reason (C1): the guard stamps who and when. Nothing else in the
 * draft changes; the approver sees the reason on the approval card.
 */
export async function keepDraftFlag(db: Db, input: { companyId: string; sessionId: string; actor: Actor; flagId: string; reason: string }): Promise<{ found: boolean }> {
  return withTenant(db, input.companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!s) throw new IntakeSessionError("not_found");
    if (s.status !== "active") throw new IntakeSessionError("not_active");
    const draft = s.draftPacket;
    const flag = draft?.provenance.flags?.find((f) => f.id === input.flagId);
    if (!draft || !flag) return { found: false };
    const asked = structuredClone(draft);
    asked.provenance.flags = (asked.provenance.flags ?? []).map((f) => (f.id === input.flagId ? { ...f, keepReason: input.reason } : f));
    const [company] = await q.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    const guarded = guardPacket(asked, { companyName: company?.name ?? "", companyLocations: company?.locations ?? [], declined: normalizeFacts(s.facts).declinedCriteria, previousFlags: draft.provenance.flags ?? [], actor: input.actor });
    await q.update(intakeSessions).set({ draftPacket: DraftRolePacketSchema.parse(guarded.packet) }).where(eq(intakeSessions.id, s.id));
    await emit(q, { type: "packet.flag_kept", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: s.id }, payload: { flagId: input.flagId, rule: flag.rule, reason: input.reason } });
    return { found: true };
  });
}

/**
 * Saves a revised draft before the role exists (for "change it by chat" and the requirements check's fixes, C10, C16):
 * through the packet guard, keeping who kept which flag, with pay only as confirmed. The caller has shown the change and
 * the person confirmed it. With `expectedHash` (the fingerprint of the draft the change was worked out on) the row is
 * locked and the save is refused (`stale_draft`) when the draft changed since, so two changes never overwrite each
 * other; `onSaved` records what the caller needs (the proposal's outcome, the event) in the same transaction. The count
 * of saved changes goes up by one: writing the draft again would replace them, and the page says so first.
 */
export async function storeDraftPacket(
  db: Db,
  input: { companyId: string; sessionId: string; actor: Actor; draft: DraftRolePacket; expectedHash?: string },
  opts: { onSaved?: (q: Tx, saved: DraftRolePacket) => Promise<void> } = {},
): Promise<DraftRolePacket> {
  return withTenant(db, input.companyId, async (q) => {
    const [locked] = await q.select({ id: intakeSessions.id }).from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!locked) throw new IntakeSessionError("not_found");
    const loaded = await loadIntakeInputs(q, input.companyId, input.sessionId);
    if (loaded.session.status !== "active") throw new IntakeSessionError("not_active");
    const current = loaded.session.draftPacket;
    if (input.expectedHash !== undefined && (!current || packetFingerprint(current) !== input.expectedHash)) throw new IntakeSessionError("stale_draft");
    const facts = normalizeFacts(loaded.session.facts);
    const ctx = contextFrom(loaded, { benchmark: loaded.state.benchmark ?? null, gap: loaded.state.benchmarkGap });
    const draft = finalizeDraft(input.draft, { ...ctx, facts }, { sessionId: loaded.session.id, aiRunId: loaded.state.draft?.aiRunId ?? "", state: loaded.state, actor: input.actor, previousFlags: current?.provenance.flags ?? [], benchmark: loaded.state.benchmark ?? null, messages: loaded.session.messages });
    const state = loaded.state;
    if (state.draft) state.draft = { ...state.draft, edits: (state.draft.edits ?? 0) + 1 };
    await q.update(intakeSessions).set({ draftPacket: draft, serverState: state }).where(eq(intakeSessions.id, loaded.session.id));
    if (opts.onSaved) await opts.onSaved(q, draft);
    return draft;
  });
}

/** An active draft nobody wrote anything into is cleared away quietly after this long (C3). */
export const EMPTY_DRAFT_AFTER_MS = 3600_000;

/**
 * The daily sweep's part for drafts (C3): an active draft with no message from a person, older than an hour, is set
 * aside as abandoned, with an event. Drafts are only ever started with a message now; this clears rows from before. The
 * database picks them out, so no conversation (or pasted ad) is read into memory to find them.
 */
export async function expireEmptyDrafts(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - EMPTY_DRAFT_AFTER_MS).toISOString();
  return withPlatform(db, async (tx) => {
    const rows = await tx
      .select({ id: intakeSessions.id, companyId: intakeSessions.companyId, turns: sql<number>`jsonb_array_length(${intakeSessions.messages})` })
      .from(intakeSessions)
      .where(and(eq(intakeSessions.status, "active"), lt(intakeSessions.createdAt, cutoff), sql`not (${intakeSessions.messages} @> '[{"role":"owner"}]'::jsonb)`));
    for (const r of rows) {
      await tx.update(intakeSessions).set({ status: "abandoned" }).where(eq(intakeSessions.id, r.id));
      await emit(tx, { type: "intake.abandoned", companyId: r.companyId, actor: { kind: "system", id: "draft_sweep" }, subject: { type: "intake_session", id: r.id }, payload: { reason: "empty", turns: Number(r.turns) } });
    }
    return rows.length;
  });
}

/** The draft as the job builder reads it: facts, open cards, readiness and the pay card computed on the server (C7, C8). */
export function sessionView(row: IntakeSessionRow, viewerUserId: string): IntakeSessionView {
  const state = stateOf(row);
  const facts = normalizeFacts(row.facts);
  const draft = row.draftPacket ?? null;
  const owner = row.createdByUserId ?? (row.createdBy.kind === "user" || row.createdBy.kind === "recruiter" ? row.createdBy.id : null);
  return {
    id: row.id,
    status: row.status,
    roleId: row.roleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedBy: { userId: owner, name: row.createdBy.name ?? null, mine: owner === viewerUserId },
    messages: row.messages,
    facts,
    missingFacts: row.missingFacts,
    questions: row.status === "active" ? state.openQuestions : [],
    readiness: intakeReadiness({ facts, state, messages: row.messages, draft }),
    pay: payCard(facts, state),
    draft,
    flags: draft?.provenance.flags ?? [],
    ad: state.ad ? { chars: state.ad.chars, takenFromAd: state.ad.takenFromAd } : null,
    fromRole: state.fromRole ?? null,
    progress: state.progress ?? null,
  };
}

export function mergeFacts(prev: IntakeFacts, next: IntakeFacts, removed: Array<{ field: string; value: string }> = []): IntakeFacts {
  const out: IntakeFacts = { ...EMPTY_FACTS, ...prev };
  for (const [k, v] of Object.entries(withoutRemoved(next, removed))) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const existing = (out as Record<string, unknown>)[k];
      const merged = [...(Array.isArray(existing) ? existing : []), ...v];
      (out as Record<string, unknown>)[k] = dedupe(merged);
    } else if (typeof v === "string" && v.trim() === "") {
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const key = typeof item === "string" ? item.trim().toLowerCase() : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
