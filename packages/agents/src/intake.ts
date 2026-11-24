import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  DraftRolePacket as DraftRolePacketSchema, EmploymentType, INTAKE_ESSENTIALS, IntakeServerState, RemotePolicy, RolePacket as RolePacketSchema, mustHaveOf, rulesOut,
  type Actor, type DraftRolePacket, type IntakeAnswer, type IntakeEssentialKey, type IntakeExtraction, type IntakeFacts, type IntakeMessage, type IntakeQuestion, type IntakeQuestionField, type IntakeRefusal,
  type IntakeSessionView, type IntakeTurn, type LegalCheck, type PublishBlocker, type RolePacket,
} from "@ros/contracts";
import { intakeCompilePrompt, intakeExtractPrompt, intakeTurnPrompt, outOfCredit, routeDeadline, runPromptDetached, type AiRuntime, type IntakeContext } from "@ros/ai";
import {
  BENEFITS_DESCRIPTION_JURISDICTIONS, applyAnswers, dealBreakerOffer, draftFactsKey, emit, formQuestionProblems, guardPacket, intakeReadiness, jobJurisdictions, normalizeCriterion, normalizeFacts,
  payCard, payConfirmed, payKey, payTyped, regionFromLocationText, screenCriterion, unresolvedFlags,
} from "@ros/core";
import { companies, intakeSessions, rolePackets, roles, withPlatform, withTenant, type Db, type Queryable, type Tx } from "@ros/db";
import { resumeAsWeWriteIt } from "./assistant-words";

/**
 * The job builder ("intake"). One way in: the owner types an idea or pastes an ad. Each turn the assistant reads the
 * facts from the owner's words and asks question cards for what is missing; the server decides what is still missing
 * and which cards are shown. When every essential is in, "Write the job" has the assistant write the job; a person edits
 * it in the one editor and publishes it. No model call ever runs inside a database transaction.
 */

export type IntakeDeps = { ai: AiRuntime };

export type IntakeSessionRow = typeof intakeSessions.$inferSelect;

/** Raised when a draft is missing, no longer active, or has no written job yet; routes turn it into 404 or 409. */
export class IntakeSessionError extends Error {
  constructor(public readonly code: "not_found" | "not_active" | "no_draft") {
    super(code === "not_found" ? "intake session not found" : code === "not_active" ? "intake session is no longer active" : "the job has not been written yet");
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

/** JSON with every object's keys sorted, so two copies of the same draft compare equal whatever order they were stored in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A short fingerprint of a written job, to tell whether anything in it changed. */
export function packetFingerprint(packet: unknown): string {
  return createHash("sha256").update(stableJson(packet)).digest("hex").slice(0, 16);
}

/** The fairness check the server applies to every answer a card offers, for the evaluation harness. */
export { screenCriterion } from "@ros/core";

type IntakeInputs = { company: typeof companies.$inferSelect; session: IntakeSessionRow; state: IntakeServerState };

async function loadIntakeInputs(q: Queryable, companyId: string, sessionId: string): Promise<IntakeInputs> {
  const [company] = await q.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
  if (!company || !session) throw new IntakeSessionError("not_found");
  return { company, session, state: stateOf(session) };
}

/** The confirmed pay the written job may carry, or null: never the model's figures, never a figure nobody confirmed. */
function confirmedPayOf(facts: IntakeFacts, state: IntakeServerState): IntakeContext["confirmedPay"] {
  if (!payConfirmed(facts, state) || !state.pay) return null;
  return { basis: state.pay.basis, min: state.pay.min, max: state.pay.max };
}

function contextFrom(inputs: IntakeInputs, facts = normalizeFacts(inputs.session.facts)): IntakeContext {
  const { company, session, state } = inputs;
  const adText = state.ad ? session.messages[state.ad.messageIndex]?.content ?? null : null;
  return {
    company: { name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, locations: company.locations, benefitsSummary: company.settings.benefitsSummary },
    facts,
    messages: session.messages,
    ad: adText ? { text: adText } : null,
    confirmedPay: confirmedPayOf(facts, state),
    alreadyAsked: settle(state.settledFields, fieldsKnownFromFacts(facts, payConfirmed(facts, state))),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The question cards.                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The field a card sets as the server keeps it: the pay card is always "compensation". */
function cardField(q: Pick<IntakeQuestion, "field" | "mode">): IntakeQuestionField {
  return q.mode === "pay" || q.field === "compensation_basis" ? "compensation" : q.field;
}

/** The server's own card that offers stated deal-breakers back as must-haves, by its question. */
const DEAL_PROMPT = "From your deal-breakers: which should count openly as must-haves?";
function isDealCard(q: Pick<IntakeQuestion, "field" | "prompt">): boolean {
  return q.field === "must_haves" && (q.prompt === DEAL_PROMPT || q.prompt.startsWith(`${DEAL_PROMPT} `));
}

/**
 * The deal-breaker card's question. It names the deal-breakers it offers no ready-made answer for (words that still rule
 * someone out, "No RDA"), so the owner sees each one and can write what they need in the box for their own words. Two by
 * name at most, each cut to 60 characters, then how many more: within a card's 300 characters.
 */
function dealPrompt(toWrite: readonly string[]): string {
  if (!toWrite.length) return DEAL_PROMPT;
  const cut = (d: string) => { const t = d.trim().replace(/\s+/g, " ").replace(/"/g, "'"); return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t; };
  const named = toWrite.slice(0, 2).map((d) => `"${cut(d)}"`);
  const more = toWrite.length - named.length;
  const list = more ? `${named.join(", ")} and ${more} more` : named.join(" and ");
  return `${DEAL_PROMPT} To count ${list}, write ${toWrite.length === 1 ? "it" : "them"} as what they need.`.slice(0, 300);
}

/**
 * What showing a card settles: the pay card asks hourly or salary too. The deal-breaker card settles nothing: it asks
 * about the owner's own deal-breakers, not the must-haves.
 */
function cardFields(q: Pick<IntakeQuestion, "field" | "mode" | "prompt">): IntakeQuestionField[] {
  if (isDealCard(q)) return [];
  return cardField(q) === "compensation" ? ["compensation", "compensation_basis"] : [q.field];
}

/**
 * Card fields the facts already answer, so a card would ask it again. The work arrangement and the kind of job count
 * only as a value the job can keep, the same test the essentials use (`intakeReadiness`): words that are neither
 * answered nor asked would block the job with nothing to tap.
 */
export function fieldsKnownFromFacts(f: IntakeFacts, payIsConfirmed: boolean): IntakeQuestionField[] {
  const out: IntakeQuestionField[] = [];
  if (f.title) out.push("title");
  if (f.locationText) out.push("location");
  if (RemotePolicy.safeParse(f.remotePolicy).success) out.push("remote_policy");
  if (EmploymentType.safeParse(f.employmentType).success) out.push("employment_type");
  if (f.schedule) out.push("schedule");
  if (payIsConfirmed) out.push("compensation", "compensation_basis");
  if (f.mustHaves.length) out.push("must_haves");
  if (f.dealBreakers.length) out.push("deal_breakers");
  if (f.benefits) out.push("benefits");
  return out;
}

/** Adds fields to the settled list, once each, in the order first seen. */
export function settle(settled: readonly IntakeQuestionField[], more: readonly IntakeQuestionField[]): IntakeQuestionField[] {
  return [...new Set([...settled, ...more])];
}

const WORD = /[a-z0-9]+/g;
/** Words too common to show whose words an answer is in. */
const COMMON = new Set(["the", "and", "for", "with", "from", "your", "our", "you", "this", "that", "are", "was", "who", "its", "per", "not", "all", "any", "one", "can", "will", "has", "have", "into", "out", "about", "own", "they", "them", "their", "his", "her", "him", "she", "named", "called"]);
function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 3 && !COMMON.has(w));
}

/** An offered answer drawn from the company profile is the assistant's, never "Your words". */
const PROFILE_WORDS = /\b(?:company|business|your)\s+profile\b/i;

/**
 * An option the model labels as the owner's own words must be in them: at least half of its words appear in what the
 * owner wrote or answered. Otherwise it is the assistant's own idea and is labelled so.
 */
export function honestOrigins(q: IntakeQuestion, ownerWords: ReadonlySet<string>): IntakeQuestion {
  const options = q.options.map((o) => {
    if (o.origin !== "owner") return o;
    if (PROFILE_WORDS.test(o.label)) return { ...o, origin: "assistant" as const };
    const w = wordsOf(o.label);
    if (!w.length) return o;
    return w.filter((x) => ownerWords.has(x)).length * 2 >= w.length ? o : { ...o, origin: "assistant" as const };
  });
  return { ...q, options };
}

/** Every word the owner has typed, pasted or answered in this draft. */
export function ownerWordsOf(messages: IntakeMessage[]): Set<string> {
  return new Set(messages.filter((m) => m.role === "owner").flatMap((m) => wordsOf(m.content)));
}

/** Whether the owner typed or pasted anything since the assistant last replied (a summary of tapped answers is neither). */
export function typedSinceReply(messages: IntakeMessage[]): boolean {
  return messages.slice(messages.map((m) => m.role).lastIndexOf("assistant") + 1).some((m) => m.role === "owner" && m.kind !== "answers");
}

/** A card asking which company or business the job is for: every job here is the workspace company's, so it is never shown. */
const COMPANY_QUESTION = /\b(?:which|what)\s+(?:company|business|employer|organi[sz]ation|firm)(?=\s*(?:[?,.]|$)|\s+(?:is|are|does|do|for|name)\b)|\b(?:company|business|employer|firm)(?:'s)?\s+name\b|\bname\s+of\s+(?:the|your)\s+(?:company|business|employer|firm)\b/i;

/** Words every card shares, left out when two cards' wording is compared. */
const PROMPT_COMMON = new Set(["what", "which", "how", "when", "where", "does", "did", "should", "would", "could", "job", "role", "position", "person", "new", "hire", "need", "want", "there", "else", "also", "yet", "still", "like", "much", "many", "kind", "type"]);
function promptWords(text: string): Set<string> {
  return new Set(wordsOf(text).filter((w) => !PROMPT_COMMON.has(w)));
}

/** Words that make two alike prompts ask opposite things: must-haves and nice-to-haves. */
const OPPOSED: [RegExp, RegExp] = [/\b(?:must|required|essential|mandatory)\b/i, /\b(?:nice|preferred|bonus|plus|optional)\b/i];

/**
 * Two cards ask the same thing when most of their wording is shared (at least two words, and 60% of all words between
 * them) and they are not on opposite sides of must-have and nice-to-have.
 */
export function sameQuestion(a: string, b: string): boolean {
  if ((OPPOSED[0].test(a) && OPPOSED[1].test(b)) || (OPPOSED[1].test(a) && OPPOSED[0].test(b))) return false;
  const x = promptWords(a);
  const y = promptWords(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 2 && shared / new Set([...x, ...y]).size >= 0.6;
}

/** Keeps the wording of the cards shown in a draft, the latest 60 (not the server's own deal-breaker card). */
export function rememberPrompts(asked: readonly string[], shown: readonly IntakeQuestion[]): string[] {
  return [...asked, ...shown.filter((q) => !isDealCard(q)).map((q) => q.prompt)].slice(-60);
}

const ARRANGEMENT_OPTIONS: IntakeQuestion["options"] = [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Hybrid", value: "hybrid", origin: "assistant" }, { label: "Remote", value: "remote", origin: "assistant" }];

/**
 * The server's own card for each essential, shown while the essential is missing and no card of the assistant's asks for
 * it on this turn: again on every later turn until it is answered, so "still needed" always comes with a card to answer.
 */
const ESSENTIAL_CARD: Record<IntakeEssentialKey, Omit<IntakeQuestion, "id">> = {
  title: { field: "title", prompt: "What is the job title?", mode: "free", options: [], allowOwn: true, why: "It is the first thing candidates read." },
  location: { field: "location", prompt: "Where is the job? Give the city and state.", mode: "free", options: [], allowOwn: true, why: "The place is on the job page, and it decides which notices the page carries." },
  remote_policy: { field: "remote_policy", prompt: "Is the job on site, hybrid or remote?", mode: "single", options: ARRANGEMENT_OPTIONS, allowOwn: false, why: "Candidates decide whether to apply on it." },
  compensation_range: { field: "compensation", prompt: "What will you pay?", mode: "pay", options: [], allowOwn: true, why: "The pay range is shown on the job page." },
  employment_type: { field: "employment_type", prompt: "Is it full time or part time?", mode: "single", options: [{ label: "Full time", value: "full_time", origin: "assistant" }, { label: "Part time", value: "part_time", origin: "assistant" }], allowOwn: true, why: "It is on the job page beside the schedule." },
  schedule: { field: "schedule", prompt: "What are the days and hours?", mode: "free", options: [], allowOwn: true, why: "Candidates need to know when they would work." },
  must_haves: { field: "must_haves", prompt: "What must the person have?", mode: "multi", options: [], allowOwn: true, why: "Applications are read against the must-haves; keep it to the few you would not hire without." },
};

/** The card field that asks each essential. */
const ESSENTIAL_FIELD: Record<IntakeEssentialKey, IntakeQuestionField> = { title: "title", location: "location", remote_policy: "remote_policy", compensation_range: "compensation", employment_type: "employment_type", schedule: "schedule", must_haves: "must_haves" };

const BENEFITS_CARD: Omit<IntakeQuestion, "id"> = { field: "benefits", prompt: "What benefits come with the job?", mode: "free", options: [], allowOwn: true, why: "The law where this job is asks the job ad to describe the benefits." };

/**
 * The cards as they are stored and shown. The assistant chooses and words them; the server decides: it drops a card of
 * the assistant's whose field was already asked in this draft or that the facts already answer (`settled`), one that asks
 * which company the job is for, and one worded like a card already shown; draws the pay card itself (no options); gives
 * the work arrangement exactly its three choices; drops any offered answer that fails the fairness check; labels "Your
 * words" only where the words are the owner's; adds its own card for an essential still missing that nothing asks on this
 * turn (`missing`), in the essentials' order; offers stated deal-breakers back as must-haves, each worded as the
 * requirement it rules people out on (`mustHaveOf`), with none ready-made for one whose words still rule someone out,
 * which the card's question names; and asks for the benefits when the law of the job's place asks the ad to describe
 * them. Three cards at most.
 *
 * The assistant never asks twice; the server keeps offering what is still needed. `settled` stops the assistant's cards
 * only: the server's own card for a missing essential comes back on every turn until the essential is answered (a card
 * skipped, or answered in words that could not be used, would otherwise leave "still needed" with nothing to tap), and so
 * does the pay card while the pay is stated and no person has confirmed it (the caller lists it in `missing`).
 */
export function prepareQuestions(raw: IntakeQuestion[], input: { turnNo: number; payConfirmed: boolean; dealBreakers: string[]; missing?: readonly IntakeEssentialKey[]; benefitsNeeded?: boolean; settled?: readonly IntakeQuestionField[]; ownerWords?: ReadonlySet<string>; askedPrompts?: readonly string[] }): IntakeQuestion[] {
  const settled = new Set(input.settled ?? []);
  const asked = input.askedPrompts ?? [];
  const out: Array<Omit<IntakeQuestion, "id">> = [];
  for (const raw1 of raw) {
    const q = input.ownerWords ? honestOrigins(raw1, input.ownerWords) : raw1;
    const field = cardField(q);
    if (settled.has(field) || out.some((x) => cardField(x) === field)) continue;
    if (COMPANY_QUESTION.test(q.prompt)) continue;
    if ([...asked, ...out.map((x) => x.prompt)].some((p) => sameQuestion(p, q.prompt))) continue;
    if (field === "compensation") {
      if (!input.payConfirmed) out.push({ ...q, field: "compensation", mode: "pay", options: [], allowOwn: true });
      continue;
    }
    if (field === "remote_policy") {
      out.push({ ...q, mode: "single", options: ARRANGEMENT_OPTIONS, allowOwn: false });
      continue;
    }
    const options = q.options.filter((o) => o.label && o.value && !screenCriterion(o.label) && !screenCriterion(o.value)).slice(0, 6);
    if ((q.mode === "single" || q.mode === "multi") && !options.length && !q.allowOwn) continue;
    out.push({ ...q, options });
  }
  // Whatever was asked before: an essential still missing always has its card.
  for (const key of input.missing ?? []) {
    const field = ESSENTIAL_FIELD[key];
    if (!out.some((x) => cardField(x) === field)) out.push(ESSENTIAL_CARD[key]);
  }
  const rank = (q: Omit<IntakeQuestion, "id">) => { const i = INTAKE_ESSENTIALS.findIndex((key) => ESSENTIAL_FIELD[key] === cardField(q)); return i < 0 ? INTAKE_ESSENTIALS.length : i; };
  const cards = out.map((q, i) => ({ q, i })).sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i).map((x) => x.q);
  // The requirement each deal-breaker rules people out on, once each: never its negative words as a must-have. One whose
  // words still rule someone out gets no option, only the box for the owner's own words, and the card's question names it.
  const needs = input.dealBreakers
    .map((d): IntakeQuestion["options"][number] => { const m = mustHaveOf(d); return { label: m.slice(0, 200), value: m.slice(0, 500), origin: m === d.trim().replace(/\s+/g, " ") ? "owner" : "assistant" }; })
    .filter((o, i, all) => o.value && !rulesOut(o.value) && all.findIndex((x) => x.value.toLowerCase() === o.value.toLowerCase()) === i)
    .slice(0, 6);
  const toWrite = input.dealBreakers.filter((d, i, all) => {
    const m = mustHaveOf(d).slice(0, 500).toLowerCase();
    return !needs.some((o) => o.value.toLowerCase() === m) && all.findIndex((x) => x.trim().toLowerCase() === d.trim().toLowerCase()) === i;
  });
  const deal: Omit<IntakeQuestion, "id"> | null = input.dealBreakers.length
    ? { field: "must_haves", prompt: dealPrompt(toWrite), mode: "multi", options: needs, allowOwn: true, why: "Every application is read against the must-haves, and a person can explain them to a candidate; anything left out here is not used to judge anyone." }
    : null;
  // The deal-breaker card takes the place of a must-haves card on this turn: one list card at a time.
  const shown = [...cards.filter((q) => !(deal && q.field === "must_haves")).slice(0, deal ? 2 : 3), ...(deal ? [deal] : [])];
  if (input.benefitsNeeded && shown.length < 3 && !settled.has("benefits") && !shown.some((q) => q.field === "benefits")) shown.push(BENEFITS_CARD);
  return shown.slice(0, 3).map((q, i) => ({ ...q, id: `q${input.turnNo}_${i + 1}` }));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A turn of the conversation.                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export type IntakeTurnInput = { companyId: string; sessionId: string; actor: Actor; message?: { content: string; kind?: IntakeMessage["kind"] } };
export type IntakeTurnOk = { turn: IntakeTurn; aiRunId: string; notARole: boolean };
/** `noCredit`: the company's AI credit has no room, so the model was not asked: no failure, and the owner's way on is to upgrade. */
export type IntakeTurnOutcome = IntakeTurnOk | { error: string; aiRunId: string; noCredit?: boolean; refusedHoldUsd?: number };

/**
 * The cheap first read of a pasted ad, once per draft: the title, the place, the type, the schedule and the pay it
 * states go into the facts. The pay read from an ad is never taken as confirmed; the pay card asks the owner whether it
 * is still current. With no AI credit left nothing happens, and the ad stays unread, so it is read after an upgrade.
 */
async function readPastedAd(db: Db, deps: IntakeDeps, input: { companyId: string; sessionId: string }, deadlineAt: number): Promise<void> {
  const pending = await withTenant(db, input.companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    const state = s ? stateOf(s) : null;
    if (!s || !state?.ad || state.ad.extracted) return null;
    const [company] = await q.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
    return { text: s.messages[state.ad.messageIndex]?.content ?? "", companyName: company?.name ?? "the company" };
  });
  if (!pending) return;
  const out = await runPromptDetached(db, deps.ai, intakeExtractPrompt, pending, { companyId: input.companyId, inputRef: { sessionId: input.sessionId, read: "pasted_ad" }, deadlineAt });
  if (outOfCredit(out)) return;
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

/** Starts a draft together with its first message: a draft is never created empty. A long first message is kept as a pasted ad. */
export async function startIntakeSession(tx: Tx, input: { companyId: string; actor: Actor; userId: string | null; message: { content: string; kind: "text" | "pasted_ad" } }): Promise<IntakeSessionRow> {
  const at = new Date().toISOString();
  const state: Partial<IntakeServerState> = input.message.kind === "pasted_ad" ? { ad: { messageIndex: 0, chars: input.message.content.length, extracted: false, takenFromAd: [] } } : {};
  const [session] = await tx
    .insert(intakeSessions)
    .values({ companyId: input.companyId, createdBy: input.actor, createdByUserId: input.userId, messages: [{ role: "owner", content: input.message.content, at, kind: input.message.kind }], serverState: state })
    .returning();
  await emit(tx, { type: "intake.started", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { kind: input.message.kind } });
  return session;
}

/** "the three questions", "3 quick questions", "Two more cards": a count of the cards in the assistant's own words. */
const CARD_COUNT = /\b(?:(the|these|those|your|my|first|next|following)\s+)?(two|three|four|five|six|[2-6])\s+(?=(?:(?:quick|short|simple|more|follow-up)\s+)?(?:questions|cards)\b)/gi;

/**
 * The assistant's reply with no count of its cards: the server decides which cards are shown, after the model wrote its
 * message, so the cards count themselves. "the three questions" reads "the questions", "3 quick questions" reads "some
 * quick questions".
 */
export function withoutCardCount(message: string): string {
  return message.replace(CARD_COUNT, (_all, det: string | undefined, num: string) => (det ? `${det} ` : /^[A-Z]/.test(num) ? "Some " : "some "));
}

/**
 * The assistant's reply in the words the page uses. The model is told when a job is ready through a field named
 * readyToCompile and repeats the word to the owner ("the job is ready to compile"), who presses "Write the job"; and it
 * writes "résumé" where every page says "resume".
 */
export function inThePagesWords(message: string): string {
  return resumeAsWeWriteIt(message)
    .replace(/\bready\s+(?:to\s+(?:be\s+)?compiled?|for\s+compil(?:ing|ation))\b/gi, "ready to be written")
    .replace(/\bcompile\s+(the|this|your)\s+job\b/gi, (_all, the: string) => `write ${the} job`);
}

const ARRANGEMENT_WORDS = /\bhybrid\b|\bremote\b|\bon[\s-]?site\b|\bin[\s-]?(?:office|person)\b/i;

/**
 * The facts after a turn. A fact the assistant read replaces a single value and adds to a list. Two facts are kept only
 * when the owner's own words say them, because the assistant could otherwise fill them in from the company profile or by
 * guessing: the place (most of its words are the owner's) and the work arrangement (the owner named one in words they
 * typed; a pasted ad's mention is confirmed on a card). Asked, never assumed.
 */
export function mergeFacts(prev: IntakeFacts, next: IntakeFacts, messages?: IntakeMessage[]): IntakeFacts {
  const out = { ...normalizeFacts(prev) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) continue;
    out[k] = Array.isArray(v) ? dedupe([...(Array.isArray(out[k]) ? (out[k] as unknown[]) : []), ...v]) : v;
  }
  const merged = normalizeFacts(out);
  if (messages) {
    const owner = messages.filter((m) => m.role === "owner");
    const words = ownerWordsOf(owner);
    const place = wordsOf(merged.locationText ?? "");
    if (merged.locationText !== prev.locationText && place.filter((w) => words.has(w)).length * 2 < place.length) merged.locationText = prev.locationText;
    if (merged.remotePolicy !== prev.remotePolicy && !owner.some((m) => (m.kind ?? "text") === "text" && ARRANGEMENT_WORDS.test(m.content))) merged.remotePolicy = prev.remotePolicy;
  }
  if (!RemotePolicy.safeParse(merged.remotePolicy).success) delete merged.remotePolicy;
  return merged;
}

function dedupe<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const key = typeof item === "string" ? item.trim().toLowerCase() : JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const actorOfTurn = (a: Actor): Actor => ({ kind: a.kind, id: a.id, ...(a.name ? { name: a.name } : {}) });

/** Whether the law of the job's place asks the ad to describe the benefits, and nothing does yet. */
function benefitsNeeded(facts: IntakeFacts, companyBenefits: string | undefined): boolean {
  if (facts.benefits?.trim() || companyBenefits?.trim()) return false;
  const region = regionFromLocationText(facts.locationText);
  const places = jobJurisdictions({ jobLocations: region ? [{ region, country: "US" }] : [], remotePolicy: facts.remotePolicy });
  return places.some((j) => BENEFITS_DESCRIPTION_JURISDICTIONS.includes(j));
}

/** Pay the owner typed in their own words counts as set by them; the confirmation is recorded with who and when. */
async function confirmTypedPay(q: Tx, input: { companyId: string; sessionId: string; actor: Actor }, messages: IntakeMessage[], facts: IntakeFacts, state: IntakeServerState): Promise<void> {
  if (!payTyped(messages, facts) || payConfirmed(facts, state)) return;
  state.pay = { by: actorOfTurn(input.actor), at: new Date().toISOString(), via: "typed", basis: facts.compensationBasis as "hourly" | "salary", min: facts.compensationMin!, max: facts.compensationMax! };
  await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: input.sessionId }, payload: { via: "typed" } });
}

/**
 * One owner message in (or none, when it was already recorded), one assistant reply out. Persists the transcript, the
 * facts and the cards, and, once the job is written, its parts set by rule. A pasted ad is read first in the same
 * request, so both model calls share the request's deadline. The assistant reads facts only from words the owner typed
 * or pasted: on a turn that follows tapped answers alone, the facts stay as the answers set them.
 */
export async function runIntakeTurn(db: Db, deps: IntakeDeps, input: IntakeTurnInput): Promise<IntakeTurnOutcome> {
  const deadlineAt = routeDeadline();
  await withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    if (!input.message) return;
    const messages = [...session.messages, { role: "owner" as const, content: input.message.content, at: new Date().toISOString(), kind: input.message.kind ?? "text" }];
    await q.update(intakeSessions).set({ messages }).where(eq(intakeSessions.id, session.id));
  });
  await readPastedAd(db, deps, input, deadlineAt);
  const inputs = await withTenant(db, input.companyId, (q) => loadIntakeInputs(q, input.companyId, input.sessionId));
  const turnNo = inputs.session.messages.filter((m) => m.role === "owner").length;
  const out = await runPromptDetached(db, deps.ai, intakeTurnPrompt, contextFrom(inputs), { companyId: input.companyId, inputRef: { sessionId: input.sessionId, turn: inputs.session.messages.length }, deadlineAt });
  // The owner's words are saved above, and nothing failed: the route offers an upgrade.
  if (outOfCredit(out)) return { error: out.error, aiRunId: out.runId, noCredit: true, refusedHoldUsd: out.refusedHoldUsd };
  const agent: Actor = { kind: "agent", id: "intake", runId: out.runId };
  return withTenant(db, input.companyId, async (q) => {
    const loaded = await loadIntakeInputs(q, input.companyId, input.sessionId);
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!session) throw new IntakeSessionError("not_found");
    if (!out.ok) {
      await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: out.reason, error: out.error } });
      return { error: out.error, aiRunId: out.runId };
    }
    if (session.status !== "active") return { error: "This draft is no longer open.", aiRunId: out.runId };
    const state = stateOf(session);
    const before = normalizeFacts(session.facts);
    const facts = typedSinceReply(session.messages) ? mergeFacts(before, out.output.factsExtracted, session.messages) : before;
    const offer = dealBreakerOffer(facts, state.dealBreakersOffered);
    for (const d of offer.declined) if (!facts.declinedCriteria.some((x) => normalizeCriterion(x.requested) === normalizeCriterion(d.requested))) facts.declinedCriteria.push({ requested: d.requested, reason: d.reason, ...(d.alternative ? { alternative: d.alternative } : {}) });
    const notARole = session.messages.filter((m) => m.role === "owner").length === 1 && out.output.notARole;
    await confirmTypedPay(q, input, session.messages, facts, state);
    const confirmed = payConfirmed(facts, state);
    const missing = intakeReadiness({ facts, state, draft: null }).missing;
    // Pay that is stated but that nobody confirmed (read from a pasted ad) still needs its card.
    const toAsk: IntakeEssentialKey[] = confirmed || missing.includes("compensation_range") ? missing : [...missing, "compensation_range"];
    const questions = notARole ? [] : prepareQuestions(out.output.questions, {
      turnNo, payConfirmed: confirmed, dealBreakers: offer.offer, missing: toAsk, benefitsNeeded: !missing.length && benefitsNeeded(facts, loaded.company.settings.benefitsSummary),
      settled: settle(state.settledFields, fieldsKnownFromFacts(facts, confirmed)), ownerWords: ownerWordsOf(session.messages), askedPrompts: state.askedPrompts,
    });
    state.openQuestions = questions;
    state.settledFields = settle(state.settledFields, questions.flatMap(cardFields));
    state.askedPrompts = rememberPrompts(state.askedPrompts, questions);
    state.dealBreakersOffered = [...state.dealBreakersOffered, ...offer.offer];
    if (state.ad && out.output.takenFromAd.length && !state.ad.takenFromAd.length) state.ad = { ...state.ad, takenFromAd: out.output.takenFromAd };
    const message = inThePagesWords(withoutCardCount(out.output.assistantMessage));
    const messages = [...session.messages, { role: "assistant" as const, content: message, at: new Date().toISOString(), aiRunId: out.runId }];
    const draftPacket = !notARole && session.draftPacket ? draftByRule({ ...loaded, session, state }, facts, input.actor) : null;
    await q.update(intakeSessions).set({ messages, facts, missingFacts: missing, serverState: state, ...(notARole ? { status: "abandoned" } : {}), ...(draftPacket ? { draftPacket } : {}) }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.turn_completed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { missing, questions: questions.map((x) => x.field) } });
    // Not about hiring: nothing is left behind as a draft; the conversation stays in the record.
    if (notARole) await emit(q, { type: "intake.abandoned", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: "not_a_role", turns: messages.length } });
    return { turn: { ...out.output, assistantMessage: message, factsExtracted: facts, missingFacts: missing, questions, readyToCompile: !missing.length && confirmed }, aiRunId: out.runId, notARole };
  });
}

export type AnswersOutcome = { refused: IntakeRefusal[]; summary: string[] };

/**
 * Tapped answers. One summary goes into the conversation as the owner's message, words typed beside the cards go in as
 * their own message, the facts change as the cards say, and pay set on the pay card is recorded as set by this person.
 * Once the job is written, its parts set by rule follow the answers at once. The next turn is the caller's.
 */
export async function applyIntakeAnswers(db: Db, input: { companyId: string; sessionId: string; actor: Actor; answers: IntakeAnswer[]; note?: string }): Promise<AnswersOutcome> {
  return withTenant(db, input.companyId, async (q) => {
    const loaded = await loadIntakeInputs(q, input.companyId, input.sessionId);
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const state = stateOf(session);
    const edit = applyAnswers(normalizeFacts(session.facts), state.openQuestions, input.answers);
    const now = new Date().toISOString();
    if (edit.pay) {
      state.pay = { by: actorOfTurn(input.actor), at: now, via: edit.pay.via, basis: edit.pay.basis, min: edit.pay.min, max: edit.pay.max };
      await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: edit.pay.via } });
    }
    const answered = new Set(input.answers.map((a) => a.questionId));
    state.settledFields = settle(state.settledFields, state.openQuestions.filter((x) => answered.has(x.id)).flatMap(cardFields));
    state.openQuestions = state.openQuestions.filter((x) => !answered.has(x.id));
    state.answeredRounds += 1;
    const lines = [...edit.summary, ...edit.refused.map((r) => `Not used: "${r.text}". ${r.reason}`)];
    if (!lines.length) lines.push("Skipped those questions.");
    const messages: IntakeMessage[] = [...session.messages, { role: "owner", content: lines.join("\n"), at: now, kind: "answers" }];
    if (input.note) messages.push({ role: "owner", content: input.note, at: now, kind: "text" });
    await confirmTypedPay(q, input, messages, edit.facts, state);
    const draftPacket = session.draftPacket ? draftByRule({ ...loaded, session: { ...session, messages }, state }, edit.facts, input.actor) : null;
    await q.update(intakeSessions).set({ facts: edit.facts, messages, serverState: state, ...(draftPacket ? { draftPacket } : {}) }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.answered", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { questionIds: [...answered], refused: edit.refused.length } });
    return { refused: edit.refused, summary: edit.summary };
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Writing the job.                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `noCredit`: the company's AI credit has no room for the writing, so the model was not asked: no failure, and the way on is to upgrade. */
export type DraftOutcome = { draft: DraftRolePacket; aiRunId: string } | { error: string; aiRunId: string; noCredit?: boolean; refusedHoldUsd?: number };

async function setProgress(db: Db, companyId: string, sessionId: string, progress: IntakeServerState["progress"] | "writing" | "checking" | "failed"): Promise<void> {
  await withTenant(db, companyId, async (q) => {
    const [s] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
    if (!s) return;
    const { progress: was, ...state } = stateOf(s);
    const at = new Date().toISOString();
    const next = typeof progress === "string" ? { stage: progress, startedAt: progress === "writing" ? at : was?.startedAt ?? at, at } : progress;
    await q.update(intakeSessions).set({ serverState: next ? { ...state, progress: next } : state }).where(eq(intakeSessions.id, sessionId));
  });
}

/** The writing's max_tokens: room for the job's JSON and the model's thinking before it. */
export const INTAKE_COMPILE_MAX_TOKENS = 32_000;

/**
 * "Write the job": one model call, never per turn. Each stage is recorded as it starts (writing, then checking, which
 * runs the checks and saves in one transaction, then done) so the page can show real progress while it polls. The job
 * carries the pay a person set or confirmed and the work arrangement exactly as the owner answered, then passes the
 * fairness guard. The answers the model wrote from are recorded as a key, so the page can tell when they change
 * afterwards. With no AI credit the progress is put back as it was: the page never reads "failed" for it.
 */
export async function draftIntake(db: Db, deps: IntakeDeps, input: { companyId: string; sessionId: string; actor: Actor }): Promise<DraftOutcome> {
  const deadlineAt = routeDeadline();
  const inputs = await withTenant(db, input.companyId, (q) => loadIntakeInputs(q, input.companyId, input.sessionId));
  if (inputs.session.status !== "active") throw new IntakeSessionError("not_active");
  await setProgress(db, input.companyId, input.sessionId, "writing");
  const ctx = contextFrom(inputs);
  const out = await runPromptDetached(db, deps.ai, intakeCompilePrompt, ctx, { companyId: input.companyId, inputRef: { sessionId: input.sessionId }, maxTokens: INTAKE_COMPILE_MAX_TOKENS, deadlineAt });
  if (outOfCredit(out)) {
    await setProgress(db, input.companyId, input.sessionId, inputs.state.progress);
    return { error: out.error, aiRunId: out.runId, noCredit: true, refusedHoldUsd: out.refusedHoldUsd };
  }
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
    const draft = finalizeDraft(asAnswered(out.output, facts), { ...ctx, facts }, { sessionId: session.id, aiRunId: out.runId, state, actor: input.actor, previousFlags: session.draftPacket?.provenance.flags ?? [] });
    const at = new Date().toISOString();
    // The key is of the answers the model was given, so anything changed while it wrote shows the job as out of date.
    state.draft = { at, aiRunId: out.runId, by: actorOfTurn(input.actor), payKey: payConfirmed(facts, state) ? payKey(state) : null, factsKey: draftFactsKey(ctx.facts), edits: 0 };
    state.progress = { stage: "done", startedAt: state.progress?.startedAt ?? at, at };
    await q.update(intakeSessions).set({ draftPacket: draft, serverState: state }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.drafted", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { aiRunId: out.runId, requestedBy: input.actor.id, flags: unresolvedFlags(draft).length, assumptions: draft.provenance.assumptions.length } });
    return { draft, aiRunId: out.runId };
  });
}

/**
 * A job just written, held to the owner's answers where the model must not decide: the work arrangement is the one the
 * owner gave, and a question for the application form that asks about a protected characteristic is left out (such a
 * question is never kept with a reason).
 */
function asAnswered(written: DraftRolePacket, facts: IntakeFacts): DraftRolePacket {
  const arrangement = RemotePolicy.safeParse(facts.remotePolicy);
  const refused = new Set(formQuestionProblems(written.formQuestions).map((p) => p.index));
  return {
    ...written,
    identity: arrangement.success ? { ...written.identity, remotePolicy: arrangement.data } : written.identity,
    formQuestions: written.formQuestions.filter((_, i) => !refused.has(i)),
  };
}

/**
 * The deterministic part after the model, and after every answer and edit: the pay only as a person set or confirmed it
 * (with who and how), the benefits line as the owner gave it, the record of which runs wrote the job, and then the
 * fairness guard. Nothing the model wrote about who decided what is kept: its wording flags are dropped (a flag "kept" by
 * the model would read as kept by the person asking, so a pasted ad could switch the fairness check off) and written
 * afresh by the guard; a person's earlier keeps carry over through `previousFlags`.
 */
export function finalizeDraft(raw: DraftRolePacket, ctx: IntakeContext, prov: FinishInput): DraftRolePacket {
  return finishDraft(raw, ctx, prov).draft;
}

type FinishInput = { sessionId: string; aiRunId: string; state: IntakeServerState; actor?: Actor; previousFlags?: DraftRolePacket["provenance"]["flags"] };

/** `finalizeDraft`, with what the guard itself changed, in plain words (`changes`). */
function finishDraft(raw: DraftRolePacket, ctx: IntakeContext, prov: FinishInput): { draft: DraftRolePacket; changes: string[] } {
  const packet: DraftRolePacket = structuredClone(raw);
  delete packet.provenance.flags;
  const facts = normalizeFacts(ctx.facts);
  const pay = confirmedPayOf(facts, prov.state);
  if (pay && prov.state.pay) {
    const benefits = facts.benefits?.trim() || packet.compensation?.benefitsSummary;
    packet.compensation = { basis: pay.basis as "hourly" | "salary", currency: packet.compensation?.currency ?? "USD", min: pay.min, max: pay.max, ...(benefits ? { benefitsSummary: benefits } : {}), discloseRange: true };
    packet.provenance.payConfirmedBy = { by: prov.state.pay.by, at: prov.state.pay.at, via: prov.state.pay.via };
    packet.provenance.payOrigin = prov.state.pay.via;
  } else {
    delete packet.compensation;
    delete packet.provenance.payConfirmedBy;
    delete packet.provenance.payOrigin;
  }
  packet.provenance.intakeSessionId = prov.sessionId;
  packet.provenance.aiRunIds = [...new Set([...(packet.provenance.aiRunIds ?? []), ...(prov.aiRunId ? [prov.aiRunId] : [])])];
  const guarded = guardPacket(packet, { companyName: ctx.company.name, companyLocations: ctx.company.locations, declined: facts.declinedCriteria, previousFlags: prov.previousFlags ?? [], actor: prov.actor, now: new Date().toISOString() });
  return { draft: DraftRolePacketSchema.parse(guarded.packet), changes: guarded.changes };
}

/**
 * The written job with its parts set by rule brought up to date with the answers about to be saved, with no model call
 * and its words as written. Null when there is no written job or nothing moved. A job that no longer reads is left as it
 * is: publishing brings it up to date anyway.
 */
function draftByRule(loaded: IntakeInputs, facts: IntakeFacts, actor: Actor): DraftRolePacket | null {
  const current = loaded.session.draftPacket;
  if (!current) return null;
  try {
    const draft = finalizeDraft(current, contextFrom(loaded, facts), { sessionId: loaded.session.id, aiRunId: loaded.state.draft?.aiRunId ?? "", state: loaded.state, actor, previousFlags: current.provenance.flags ?? [] });
    return packetFingerprint(draft) === packetFingerprint(current) ? null : draft;
  } catch {
    return null;
  }
}

/** The job as it is published, from a job the model wrote, outside a draft: for the evaluation harness, where the case's own pay counts as confirmed. */
export function finalizePacket(raw: DraftRolePacket, ctx: IntakeContext, prov: { sessionId: string; aiRunId: string }): RolePacket {
  const facts = normalizeFacts(ctx.facts);
  const state = IntakeServerState.parse({});
  const basis = facts.compensationBasis ?? raw.compensation?.basis;
  const min = facts.compensationMin ?? raw.compensation?.min;
  const max = facts.compensationMax ?? raw.compensation?.max;
  const paid = (basis === "hourly" || basis === "salary") && min !== undefined && max !== undefined;
  if (paid) state.pay = { by: { kind: "system", id: "eval" }, at: new Date().toISOString(), via: "typed", basis, min, max };
  const answered = paid ? { ...facts, compensationBasis: basis, compensationMin: min, compensationMax: max } : facts;
  return RolePacketSchema.parse(finalizeDraft(asAnswered(raw, answered), { ...ctx, facts: answered }, { ...prov, state }));
}

/**
 * Saves a person's edit of the written job, with the draft's row locked so two edits never overwrite each other. `edit`
 * turns the job as it stands into the job as edited (the one editor's rules; it may refuse by throwing). Pay or a
 * benefits line changed here is the person's own: the pay counts as set by them, and the answers follow, so nothing
 * puts the earlier figures back. The edit passes the fairness guard, which lists any wording to change or keep
 * (`guardChanges`: what it fixed by rule), and is counted, since writing the job again would replace it.
 */
export async function saveDraftEdit(db: Db, input: { companyId: string; sessionId: string; actor: Actor; edit: (draft: DraftRolePacket) => DraftRolePacket }): Promise<{ draft: DraftRolePacket; guardChanges: string[] }> {
  return withTenant(db, input.companyId, async (q) => {
    const loaded = await loadIntakeInputs(q, input.companyId, input.sessionId);
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const current = session.draftPacket;
    if (!current) throw new IntakeSessionError("no_draft");
    const edited = input.edit(current);
    const state = stateOf(session);
    const facts = normalizeFacts(session.facts);
    const pay = edited.compensation;
    if (pay && (pay.basis !== current.compensation?.basis || pay.min !== current.compensation?.min || pay.max !== current.compensation?.max)) {
      facts.compensationBasis = pay.basis;
      facts.compensationMin = pay.min;
      facts.compensationMax = pay.max;
      state.pay = { by: actorOfTurn(input.actor), at: new Date().toISOString(), via: "edited", basis: pay.basis, min: pay.min, max: pay.max };
      await emit(q, { type: "intake.pay_confirmed", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { via: "edited" } });
    }
    if ((pay?.benefitsSummary ?? "") !== (current.compensation?.benefitsSummary ?? "")) {
      if (pay?.benefitsSummary) facts.benefits = pay.benefitsSummary;
      else delete facts.benefits;
    }
    const { draft, changes } = finishDraft(edited, contextFrom({ ...loaded, session, state }, facts), { sessionId: session.id, aiRunId: state.draft?.aiRunId ?? "", state, actor: input.actor, previousFlags: current.provenance.flags ?? [] });
    if (state.draft) state.draft = { ...state.draft, payKey: payKey(state), edits: state.draft.edits + 1 };
    await q.update(intakeSessions).set({ draftPacket: draft, facts, serverState: state }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "role_packet.edited", companyId: input.companyId, actor: input.actor, subject: { type: "intake_session", id: session.id }, payload: { draft: true, flags: unresolvedFlags(draft).length } });
    return { draft, guardChanges: changes };
  });
}

/** Keeps a flagged phrase in the written job with the person's reason: the guard stamps who and when. Nothing else changes. */
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

/* ------------------------------------------------------------------------------------------------------------------ */
/* From a draft to a job.                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export type JobFromDraft = { roleId: string; version: number; created: boolean } | { blockers: PublishBlocker[] };

/**
 * Turns the written draft into a job, inside the caller's transaction: the job (still a draft, for the caller to
 * publish in the same transaction) and its version 1, from the job the person checked. Its words are never rewritten
 * here; the parts set by rule are brought up to date with the answers and the pay as they are now. Refused, with every
 * reason, until every essential is in, a person set or confirmed the pay, the job is written and up to date with the
 * answers, and no wording flag is open. Two presses take turns on the draft's row: the second gets the job the first made.
 */
export async function jobFromDraft(tx: Tx, input: { companyId: string; sessionId: string; actor: Actor }): Promise<JobFromDraft> {
  const loaded = await loadIntakeInputs(tx, input.companyId, input.sessionId);
  const [session] = await tx.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1).for("update");
  if (!session) throw new IntakeSessionError("not_found");
  if (session.roleId) {
    const [existing] = await tx.select({ version: rolePackets.version }).from(rolePackets).where(eq(rolePackets.roleId, session.roleId)).limit(1);
    return { roleId: session.roleId, version: existing?.version ?? 1, created: false };
  }
  if (session.status !== "active") throw new IntakeSessionError("not_active");
  const state = stateOf(session);
  const facts = normalizeFacts(session.facts);
  const stored = session.draftPacket ?? null;
  const before = intakeReadiness({ facts, state, draft: stored });
  if (!stored || !before.publish.allowed) return { blockers: before.publish.blockers };
  const runId = state.draft?.aiRunId ?? "";
  const draft = finalizeDraft(stored, contextFrom({ ...loaded, session, state }, facts), { sessionId: session.id, aiRunId: runId, state, actor: input.actor, previousFlags: stored.provenance.flags ?? [] });
  const after = intakeReadiness({ facts, state, draft });
  if (!after.publish.allowed) return { blockers: after.publish.blockers };
  const packet = RolePacketSchema.parse(draft);
  const agent: Actor = { kind: "agent", id: "intake", ...(runId ? { runId } : {}) };
  const [role] = await tx.insert(roles).values({ companyId: input.companyId, title: packet.identity.title, status: "draft", createdBy: input.actor }).returning();
  const [pv] = await tx.insert(rolePackets).values({ companyId: input.companyId, roleId: role.id, version: 1, packet, status: "proposed", source: "intake_agent", changeSummary: "Written with the assistant in the job builder", createdBy: agent }).returning();
  await tx.update(intakeSessions).set({ roleId: role.id, status: "compiled", draftPacket: packet }).where(eq(intakeSessions.id, session.id));
  await emit(tx, { type: "intake.compiled", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { roleId: role.id } });
  await emit(tx, { type: "role.created", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { title: role.title, sessionId: session.id } });
  return { roleId: role.id, version: pv.version, created: true };
}

/** An active draft nobody wrote anything into is cleared away quietly after this long. */
export const EMPTY_DRAFT_AFTER_MS = 3600_000;

/**
 * The daily sweep's part for drafts: an active draft with no message from a person, older than an hour, is set aside as
 * abandoned, with an event. The database picks them out, so no conversation (or pasted ad) is read into memory.
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

/**
 * The draft as the job builder reads it: the facts, the open cards, the pay card and the readiness, computed on the
 * server. What needs the company, the plan or the calendar comes from the caller: the legal check of the written job
 * with its blockers, the plan's blockers and the closing date chosen for the job.
 */
export function sessionView(row: IntakeSessionRow, viewerUserId: string, more: { legalCheck?: LegalCheck | null; legalBlockers?: PublishBlocker[]; planBlockers?: PublishBlocker[]; closesOn?: string | null } = {}): IntakeSessionView {
  const state = stateOf(row);
  const facts = normalizeFacts(row.facts);
  const draft = row.draftPacket ?? null;
  const owner = row.createdByUserId ?? (row.createdBy.kind === "user" ? row.createdBy.id : null);
  return {
    id: row.id,
    status: row.status === "compiled" || row.status === "abandoned" ? row.status : "active",
    roleId: row.roleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedBy: { userId: owner, name: row.createdBy.name ?? null, mine: owner === viewerUserId },
    messages: row.messages,
    facts,
    questions: row.status === "active" ? state.openQuestions : [],
    readiness: intakeReadiness({ facts, state, draft, planBlockers: more.planBlockers, legalBlockers: more.legalBlockers }),
    pay: payCard(facts, state),
    draft,
    flags: draft?.provenance.flags ?? [],
    legalCheck: more.legalCheck ?? null,
    closesOn: more.closesOn ?? null,
    ad: state.ad ? { chars: state.ad.chars, takenFromAd: state.ad.takenFromAd } : null,
    progress: state.progress ?? null,
  };
}
