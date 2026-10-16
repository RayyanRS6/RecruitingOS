import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { LearnedFact, isCompanyVerified, trialPaused, type KeptFact, type LearnedFactKind, type RolePacket, type ScreenProgress, type ScreenTranscriptEntry, type ScreeningQuestion, type WriteupAnswer } from "@ros/contracts";
import { KEPT_FACTS_MAX, candidateWordsOf, fromAddress, loadScreenBundle, queueCommunication, redactProtected, replyToFor, saidByCandidate, statusUrlFor } from "@ros/agents";
import { openPayload, screenAnswersOf, screenAnswersSent, sealPayload, writtenQuestionsOf } from "@ros/core";
import { applications, candidates, companies, roles, unconfirmedScreens, withPlatform, withTenant, type ApplicationAnswers, type Db, type Tx } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import type { WorkflowEngine } from "@ros/workflows";
import type { Container } from "../container";
import { hashToken, type ConversationRef } from "./apply-conversation";
import { addressMatch } from "./applications";

/**
 * What a candidate's company-scoped record learns from the chats they send, and how a returning candidate reuses it
 * (Wave S7, spec steps 3 and 10, slice S7-F; the contract is `LearnedFact` in @ros/contracts and s7-contracts.md).
 *
 * - Learning is done in code, never by a model: a fact is the candidate's own words about one thing the chat settled
 *   (a must-have the CV did not show and they gave something concrete for, a written question they answered, an open
 *   question from the résumé reading), each checked against what they themselves sent (`saidByCandidate`). Never the
 *   assistant's notes, never a "covered" the candidate did not say, never something settled as not known or skipped,
 *   never pay or a start date (those belong to one job), never a sentence about a protected characteristic.
 * - The facts live on the application whose sent chat taught them (`applications.answers.learned`): the profile is the
 *   candidate's facts on their applications at one company, never across companies, and a deletion request erases them
 *   with the rest of `answers` (core/privacy-requests.ts), the access export carries them the same way.
 * - Reuse: "Applied here before? Use your details" emails the address on file (only) a sealed link that opens this job's
 *   form with the details filled in; the page answers the same whether or not the address is known. The application
 *   record offers the same for another open role at the company, its private link being the key.
 * - Wave S8 (spec-s8-followups.md, B): that form also lists the facts, each ticked ("From your earlier chats at
 *   <Company>"); the ones still ticked at Send are kept on the new application (`answers.kept`) and go to its chat as
 *   the candidate's own words. Only their ids come from the form; the link is opened again and the words read again
 *   here, and the address typed must be the one on file. Without the link nothing earlier is shown or used.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Learning from a sent chat                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** At most this many facts from one chat; the candidate reads, changes or removes each one. */
export const LEARNED_FACTS_PER_CHAT = 8;
/** A fact needs a few words to stand on its own ("Yes." says nothing on a later application). */
const MIN_WORDS = 3;

/** What one sent conversation holds, as the screen row stores it. */
export type SentChat = { id: string; status: string; transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress };

/** The packet's screening questions by kind: what a later application to the same company can use. Pay, a start date and eligibility belong to one job. */
const SCREENING_KIND: Partial<Record<ScreeningQuestion["kind"], LearnedFactKind>> = { skills: "skill", behavioral: "experience", logistics: "logistics", motivation: "other" };

/** A company's own written question, by its words: pay and start dates are left out; a project, the way to work, or experience otherwise. */
function kindOfCompanyQuestion(question: string): LearnedFactKind | null {
  if (/\b(pay|salary|wage|wages|compensation|start|notice period)\b/i.test(question)) return null;
  if (/\b(project|projects|portfolio|built|build)\b/i.test(question)) return "project";
  if (/\b(transport|commute|commuting|drive|driving|car|vehicle|relocate|relocating|travel)\b/i.test(question)) return "logistics";
  return "experience";
}

/** Words cut to `max` characters at a sentence end, else at a word; `mark` adds "…" where words were cut off. */
export function clipWords(text: string, max: number, mark: boolean): string {
  if (text.length <= max) return text;
  const room = mark ? max - 1 : max;
  const cut = text.slice(0, room);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end >= room * 0.4) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(" ");
  const kept = (space > 0 ? cut.slice(0, space) : cut).trimEnd();
  return mark ? `${kept}…` : kept;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The candidate's own words, kept only when they said them, they say something, and nothing in them is about a protected characteristic. */
function ownWords(raw: string | null | undefined, heard: string): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const kept = redactProtected(text);
  if (kept !== text) return null;
  if (kept.split(" ").filter(Boolean).length < MIN_WORDS) return null;
  return saidByCandidate(kept, heard) ? kept : null;
}

/**
 * The facts one sent chat teaches the candidate's record (pure, so it is tested on its own). Empty for a chat that was
 * not sent by the candidate (`screenAnswersSent`: closed on a recruiter's call, or never sent).
 */
export function factsFromSentChat(input: { chat: SentChat; packet: Pick<RolePacket, "screening" | "companyQuestions">; applicationId: string; roleTitle: string; at: string; newId?: () => string }): LearnedFact[] {
  const { chat, packet } = input;
  if (!screenAnswersSent(chat)) return [];
  const heard = candidateWordsOf(chat);
  if (!heard.trim()) return [];
  const plan = chat.progress.chat;
  const declined = new Set(chat.progress.declined ?? []);
  const answers = screenAnswersOf(chat);
  const writeup = new Map<string, WriteupAnswer>((chat.progress.writeup?.answers ?? []).map((a) => [a.questionKey, a]));
  // With a plan, only what it settled as covered; without one (a chat from before Wave S7), what was answered and not skipped.
  const settled = (key: string) => {
    const item = plan?.items.find((i) => i.key === key);
    return item ? item.state === "covered" : !declined.has(key);
  };
  const topics: Array<{ key: string; kind: LearnedFactKind }> = [];
  for (const item of plan?.items ?? []) if (item.kind === "gap" && item.state === "covered") topics.push({ key: item.key, kind: "skill" });
  for (const f of chat.progress.focusQuestions ?? []) if (settled(f.key)) topics.push({ key: f.key, kind: "experience" });
  for (const q of writtenQuestionsOf(packet)) {
    const kind = q.source === "screening" ? SCREENING_KIND[packet.screening.questions.find((s) => s.key === q.key)?.kind ?? "compensation"] ?? null : kindOfCompanyQuestion(q.question);
    if (kind && settled(q.key)) topics.push({ key: q.key, kind });
  }
  const newId = input.newId ?? (() => `lf_${randomBytes(8).toString("hex")}`);
  const seen = new Set<string>();
  const out: LearnedFact[] = [];
  for (const topic of topics) {
    if (out.length >= LEARNED_FACTS_PER_CHAT) break;
    const written = writeup.get(topic.key);
    if (written && (written.status === "not_given" || written.status === "skipped")) continue;
    // Their exact words first (a write-up they changed themselves, then the answer as recorded), then the pieces of their messages the write-up rests on.
    const choices = [written?.by === "candidate" ? written.answer : null, answers[topic.key], ...(written?.quotes ?? [])];
    let words: string | null = null;
    for (const choice of choices) {
      words = ownWords(choice, heard);
      if (words) break;
    }
    if (!words) continue;
    const text = clipWords(words, 200, true);
    if (seen.has(norm(text))) continue;
    seen.add(norm(text));
    out.push({ id: newId(), kind: topic.kind, text, quote: clipWords(words, 500, false), from: { applicationId: input.applicationId, screenId: chat.id, roleTitle: input.roleTitle, at: input.at } });
  }
  return out;
}

/** The facts stored on one application, each read through the contract (anything malformed is left out). */
function storedFacts(answers: { learned?: unknown } | null | undefined): LearnedFact[] {
  const list = Array.isArray(answers?.learned) ? answers.learned : [];
  return list.flatMap((f) => {
    const parsed = LearnedFact.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Called once a chat is really sent: after Send on a screen (pages/review-page.tsx), and after the address owner
 * confirms a repeat submission's answers (pages/profile-pages.tsx). Adds to `applications.answers.learned` the facts the
 * candidate said themselves, each resting on their own words; never the assistant's notes or inferences. Idempotent:
 * a chat already learned from (a double press of Send) adds nothing, and facts the candidate removed stay removed.
 * Returns how many facts were added.
 */
export async function learnFromSentChat(container: Container, ref: ConversationRef): Promise<number> {
  if (ref.kind !== "screen") return 0;
  const now = container.engine.clock().toISOString();
  return withTenant(container.db, ref.companyId, async (tx) => {
    const b = await loadScreenBundle(tx, ref.id);
    if (!b || b.candidate.anonymizedAt || !screenAnswersSent(b.screen)) return 0;
    // Locked: two presses of Send at once learn one after the other, and the second finds the first's facts.
    const [app] = await tx.select().from(applications).where(eq(applications.id, b.screen.applicationId)).limit(1).for("update");
    if (!app) return 0;
    const learned = Array.isArray(app.answers.learned) ? app.answers.learned : [];
    if (storedFacts(app.answers).some((f) => f.from.screenId === b.screen.id)) return 0;
    const facts = factsFromSentChat({ chat: b.screen, packet: b.packet, applicationId: app.id, roleTitle: b.packet.identity.title, at: now });
    if (!facts.length) return 0;
    await tx.update(applications).set({ answers: { ...app.answers, learned: [...learned, ...facts] } }).where(eq(applications.id, app.id));
    return facts.length;
  });
}

/**
 * A repeat submission's answers were just confirmed by the address owner (pages/profile-pages.tsx): the screen they were
 * added to is sent now, so the record learns from it as from any sent chat. Nothing for a link that added nothing.
 */
export async function learnFromConfirmedRepeat(container: Container, rawToken: string): Promise<number> {
  if (!rawToken || rawToken.length > 100) return 0;
  // The link is looked up before any company is known: a platform read, as the confirmation itself does.
  const [row] = await withPlatform(container.db, (tx) => tx.select({ companyId: unconfirmedScreens.companyId, applicationId: unconfirmedScreens.applicationId, mergedScreenId: unconfirmedScreens.mergedScreenId, confirmation: unconfirmedScreens.confirmation }).from(unconfirmedScreens).where(eq(unconfirmedScreens.confirmTokenHash, hashToken(rawToken))).limit(1));
  if (row?.confirmation !== "confirmed" || !row.mergedScreenId) return 0;
  return learnFromSentChat(container, { kind: "screen", id: row.mergedScreenId, companyId: row.companyId, applicationId: row.applicationId, token: "" });
}

/** The candidate's facts at this company, newest first, without the ones they removed, each wording once, for their application record. */
export async function learnedFactsFor(tx: Tx, input: { companyId: string; candidateId: string }): Promise<LearnedFact[]> {
  const rows = await tx.select({ answers: applications.answers }).from(applications).where(and(eq(applications.companyId, input.companyId), eq(applications.candidateId, input.candidateId)));
  const all = rows.flatMap((r) => storedFacts(r.answers)).filter((f) => !f.removedAt);
  all.sort((a, b) => Date.parse(b.from.at) - Date.parse(a.from.at) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return all.filter((f) => {
    const key = norm(f.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What changing a fact did, for the record page's line: "changed", "removed", or why nothing changed. */
export type FactChange = "changed" | "removed" | "empty" | "personal" | "missing";

/**
 * The candidate changes or removes one of their facts from their application record (`POST /c/status/:token/facts/:id`).
 * The fact may sit on any of their applications at the company (the profile is company-scoped). A change keeps their
 * new words exactly, unless a sentence is about a protected characteristic, which is left out as in the chat; a removal
 * takes the words out at once and keeps only that a fact was removed, so the chat it came from never teaches it again.
 * Wave S8: the same fact kept on a later application (`answers.kept`) says the new words too, or goes with the removal,
 * so "your applications here keep your new words" and "no longer kept with your applications here" stay true.
 */
export async function changeLearnedFact(container: Container, input: { companyId: string; candidateId: string; factId: string; action: "change" | "remove"; text?: string | null }): Promise<FactChange> {
  const now = container.engine.clock().toISOString();
  const typed = (input.text ?? "").replace(/\s+/g, " ").trim();
  if (input.action === "change" && !typed) return "empty";
  const words = typed ? redactProtected(typed) : "";
  if (input.action === "change" && words.startsWith("(answer recorded")) return "personal";
  return withTenant(container.db, input.companyId, async (tx) => {
    const apps = await tx.select({ id: applications.id, answers: applications.answers }).from(applications).where(and(eq(applications.companyId, input.companyId), eq(applications.candidateId, input.candidateId))).for("update");
    const learnedOf = (answers: ApplicationAnswers) => (Array.isArray(answers.learned) ? answers.learned : []);
    const origin = apps.find((a) => learnedOf(a.answers).some((f) => f.id === input.factId));
    const fact = origin ? learnedOf(origin.answers).find((f) => f.id === input.factId) : undefined;
    if (!origin || !fact || fact.removedAt) return "missing";
    const next: LearnedFact = input.action === "remove" ? { id: fact.id, kind: fact.kind, text: "Removed", quote: "", from: fact.from, removedAt: now } : { ...fact, text: clipWords(words, 200, false), editedAt: now };
    for (const app of apps) {
      const keptList = Array.isArray(app.answers.kept) ? app.answers.kept : [];
      const holdsKept = keptList.some((k) => k.id === input.factId);
      if (app.id !== origin.id && !holdsKept) continue;
      const { kept: _kept, learned: _learned, ...rest } = app.answers;
      const learned = learnedOf(app.answers).map((f) => (f.id === input.factId ? next : f));
      const kept = input.action === "remove" ? keptList.filter((k) => k.id !== input.factId) : keptList.map((k) => (k.id === input.factId ? { ...k, text: next.text, editedAt: now } : k));
      await tx.update(applications).set({ answers: { ...rest, ...(app.answers.learned ? { learned } : {}), ...(kept.length ? { kept } : {}) } }).where(eq(applications.id, app.id));
    }
    return input.action === "remove" ? "removed" : "changed";
  });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Reusing the details at the same company                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What a returning candidate's details link fills in on the form (spec step 3, "applied here before? use your saved
 * details", same company only): the details on their record and what their sent chats taught it. The link is emailed to
 * the address on file only, or offered on their own application record, and arrives on the apply form as `?reuse=<token>`;
 * the form (S7-B) asks for this and shows every value as "From your earlier application — check it". Null for a token
 * that does not open, is for another company or job, has expired, or whose person was deleted. `candidateId` (Wave S8):
 * whose facts these are, so Send keeps them only on that person's new application; it is never put on the page.
 * `facts`: the newest `KEPT_FACTS_MAX`, the ones the form lists.
 */
export type ReusedDetails = { candidateId: string; firstName: string; lastName: string; email: string; phone: string | null; locationText: string | null; workSummary: string | null; facts: LearnedFact[] };

const REUSE_PURPOSE = "profile-reuse";
/** How long the emailed link works. */
export const REUSE_LINK_HOURS = 72;
/** How long a link offered on the application record works (the record can always offer a new one). */
export const REUSE_RECORD_LINK_HOURS = 24;
const HOUR = 3600_000;

/** `c` company, `p` person, `r` role; `s` the record's private link (hashed) when it was offered there, so a link replaced as shared by mistake stops these too. */
type ReusePayload = { v: 1; c: string; p: string; r: string; s?: string; exp: number };

function statusHash(statusToken: string): string {
  return createHash("sha256").update(`reuse:${statusToken}`).digest("hex").slice(0, 24);
}

/** A sealed reuse token for one person and one job at one company. */
export function reuseToken(secret: string, input: { companyId: string; candidateId: string; roleId: string; statusToken?: string }, now: Date, hours: number): string {
  const payload: ReusePayload = { v: 1, c: input.companyId, p: input.candidateId, r: input.roleId, ...(input.statusToken ? { s: statusHash(input.statusToken) } : {}), exp: now.getTime() + hours * HOUR };
  return sealPayload(REUSE_PURPOSE, payload, secret);
}

/** The apply form's address with a reuse token. */
export function reuseFormPath(slug: string, roleId: string, token: string): string {
  return `/careers/${slug}/jobs/${roleId}/apply?reuse=${encodeURIComponent(token)}`;
}

export async function reusedDetailsFor(container: Container, input: { companyId: string; roleId: string; token: string }): Promise<ReusedDetails | null> {
  if (!input.token || input.token.length > 2000) return null;
  const p = openPayload<ReusePayload>(REUSE_PURPOSE, input.token, container.env.SESSION_SECRET, container.engine.clock().getTime());
  if (p?.v !== 1 || p.c !== input.companyId || p.r !== input.roleId) return null;
  return withTenant(container.db, input.companyId, async (tx) => {
    const [cand] = await tx.select().from(candidates).where(and(eq(candidates.id, p.p), eq(candidates.companyId, input.companyId))).limit(1);
    if (!cand?.email || cand.anonymizedAt || cand.mergedIntoCandidateId) return null;
    const apps = await tx.select({ statusToken: applications.statusToken, answers: applications.answers }).from(applications).where(and(eq(applications.companyId, input.companyId), eq(applications.candidateId, cand.id))).orderBy(desc(applications.createdAt));
    if (!apps.length) return null;
    if (p.s && !apps.some((a) => statusHash(a.statusToken) === p.s)) return null;
    const workSummary = apps.find((a) => typeof a.answers.workSummary === "string" && a.answers.workSummary.trim())?.answers.workSummary ?? null;
    return { candidateId: cand.id, firstName: cand.firstName, lastName: cand.lastName, email: cand.email, phone: cand.phone, locationText: cand.locationText, workSummary, facts: (await learnedFactsFor(tx, { companyId: input.companyId, candidateId: cand.id })).slice(0, KEPT_FACTS_MAX) };
  });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Keeping earlier facts on the next application (Wave S8)                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The facts a form opened from the reuse link keeps, at Send: the link is opened again (`reusedDetailsFor`: the same
 * company, job, person, deletion, merge and record-link checks as when the form was shown), the address typed must be
 * the one on file (`addressMatch`, the one rule for finding a person by a typed address), and only the facts whose ids
 * were still ticked and that are that person's are kept, in the words the record holds now. The form's own words are
 * never read: only ids. Null when nothing is kept.
 */
export async function factsToKeep(container: Container, input: { companyId: string; roleId: string; token: string; typedEmail: string; ids: readonly string[] }): Promise<{ candidateId: string; facts: LearnedFact[] } | null> {
  if (!input.token || !input.ids.length) return null;
  const match = addressMatch(input.typedEmail);
  if (!match) return null;
  const details = await reusedDetailsFor(container, { companyId: input.companyId, roleId: input.roleId, token: input.token });
  if (!details) return null;
  const ticked = new Set(input.ids);
  const facts = details.facts.filter((f) => ticked.has(f.id));
  if (!facts.length) return null;
  const [same] = await withTenant(container.db, input.companyId, (tx) => tx.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.id, details.candidateId), eq(candidates.companyId, input.companyId), match)).limit(1));
  return same ? { candidateId: details.candidateId, facts } : null;
}

/** The kept facts as the new application stores them (`answers.kept`): the record's words today, and when they were kept. */
export function keptFactsOf(facts: readonly LearnedFact[], at: string): KeptFact[] {
  return facts.slice(0, KEPT_FACTS_MAX).map((f) => ({ id: f.id, kind: f.kind, text: f.text, from: f.from, keptAt: at }));
}

/** Stores the kept facts on the new application, in the apply form's own transaction. */
export async function keepFactsOn(tx: Tx, input: { applicationId: string; facts: readonly KeptFact[] }): Promise<void> {
  if (!input.facts.length) return;
  const [app] = await tx.select({ answers: applications.answers }).from(applications).where(eq(applications.id, input.applicationId)).limit(1).for("update");
  if (!app) return;
  await tx.update(applications).set({ answers: { ...app.answers, kept: [...input.facts] } }).where(eq(applications.id, input.applicationId));
}

// What the chat reads of them (`keptFactLines`, `chatFactsWithKept`) lives with the chat's other facts in @ros/agents,
// so the chat in the visit and one whose link was emailed later (`chatFactsOf`) read them alike.

/** The queue job that answers "Use the details I gave before" (registered by `registerProfileJobs`). */
export const REUSE_LINK_JOB_KIND = "candidate.reuse_link";

export type ReuseLinkDeps = { db: Db; integrations: Integrations; jobsBaseUrl: string; secret: string };

/** Registers the reuse email's job. Called once in container.ts, and by the page before it queues one (the same handler again changes nothing). */
export function registerProfileJobs(engine: WorkflowEngine, deps: ReuseLinkDeps): void {
  engine.registerJob(REUSE_LINK_JOB_KIND, async (payload, ctx) => {
    const email = typeof payload.email === "string" ? payload.email : "";
    const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
    const roleId = typeof payload.roleId === "string" ? payload.roleId : "";
    if (email && companyId && roleId) await emailReuseLink(deps, { email, companyId, roleId }, ctx.now);
  });
}

function depsOf(container: Container): ReuseLinkDeps {
  return { db: container.db, integrations: container.integrations, jobsBaseUrl: container.env.JOBS_BASE_URL, secret: container.env.SESSION_SECRET };
}

/**
 * The page only queues the request, the same single write whatever the address, and answers at once; how long it takes
 * says nothing about whether the address is known (as "Lost your link?" does). The worker runs `emailReuseLink`.
 */
export async function queueReuseLink(container: Container, input: { companyId: string; roleId: string; email: string }): Promise<void> {
  registerProfileJobs(container.engine, depsOf(container));
  await container.engine.enqueue(container.db, { kind: REUSE_LINK_JOB_KIND, payload: { companyId: input.companyId, roleId: input.roleId, email: input.email.trim().toLowerCase() }, maxAttempts: 3 });
}

const hourKey = (now: Date) => now.toISOString().slice(0, 13);

/**
 * The worker's half: when the company holds this person (same address-matching rule as "Lost your link?", never across
 * companies), the address it has on file gets a link to this job's form with their details filled in, or, when they
 * already applied for this job, their own link to that application. At most one an hour per person and job. Returns how
 * many emails were queued (for tests only).
 */
export async function emailReuseLink(deps: ReuseLinkDeps, input: { email: string; companyId: string; roleId: string }, now: Date): Promise<number> {
  const match = addressMatch(input.email);
  if (!match) return 0;
  return withTenant(deps.db, input.companyId, async (tx) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    const [role] = await tx.select({ id: roles.id, title: roles.title }).from(roles).where(and(eq(roles.id, input.roleId), eq(roles.companyId, input.companyId))).limit(1);
    if (!company || !role || !isCompanyVerified(company.settings)) return 0;
    const [candidate] = await tx.select().from(candidates).where(and(eq(candidates.companyId, input.companyId), match, isNull(candidates.anonymizedAt), isNull(candidates.mergedIntoCandidateId))).limit(1);
    if (!candidate?.email) return 0;
    const apps = await tx.select().from(applications).where(eq(applications.candidateId, candidate.id)).orderBy(desc(applications.createdAt)).limit(20);
    const latest = apps[0];
    if (!latest) return 0;
    const already = apps.find((a) => a.roleId === role.id);
    const signOff = `The hiring team at ${company.name}`;
    const text = already
      ? `Hi ${candidate.firstName},

Someone asked to apply for ${role.title} at ${company.name} with the details you gave before. You have already applied for this job, so there is nothing more to send. Your own link shows where your application stands:
${statusUrlFor(deps.jobsBaseUrl, already)}

If you did not ask for this, you do not need to do anything. Nothing was sent and nothing has changed.

${signOff}`
      : `Hi ${candidate.firstName},

Someone asked to apply for ${role.title} at ${company.name} using the details you gave ${company.name} before. If that was you, this link opens the application form with your details filled in, ready for you to check and change:
${deps.jobsBaseUrl}${reuseFormPath(company.slug, role.id, reuseToken(deps.secret, { companyId: company.id, candidateId: candidate.id, roleId: role.id }, now, REUSE_LINK_HOURS))}

The link works for ${REUSE_LINK_HOURS / 24} days. Your details stay with ${company.name}: they are never shared with another company.

If you did not ask for this, you do not need to do anything. Nothing was sent and nothing has changed.

${signOff}`;
    const about = already ?? latest;
    await queueCommunication(tx, deps.integrations, {
      channel: "email",
      companyId: company.id,
      candidateId: candidate.id,
      applicationId: about.id,
      to: candidate.email,
      from: fromAddress(company, deps.integrations),
      replyTo: replyToFor(about, deps.integrations),
      subject: already ? `Your application for ${role.title} at ${company.name}` : `Your details for ${role.title} at ${company.name}`,
      text,
      templateKey: "profile_reuse_link",
      idempotencyKey: `profile_reuse_link:${candidate.id}:${role.id}:${hourKey(now)}`,
      tags: { template: "profile_reuse_link", applicationId: about.id },
      actor: { kind: "system", id: "reuse_request" },
      disclosureIncluded: false,
    }, now);
    return 1;
  });
}

/** One open role the application record offers "Apply with my details" for. */
export type OtherRole = { roleId: string; title: string };

/**
 * "Apply for another role at <Company> with these details" (spec step 10), from the candidate's own application record:
 * the company's other open roles that take applications and that they have not applied for. No reuse link is handed to
 * the page: whoever holds a forwarded status link must not open a form filled with the person's details, so the link
 * goes by email to the address on file (`queueReuseLinkFor`). Empty when the company's pages are not public. `slug` for
 * the careers page link.
 */
export async function otherRolesFor(container: Container, input: { companyId: string; candidateId: string }): Promise<{ companyName: string; slug: string | null; roles: OtherRole[] }> {
  return withTenant(container.db, input.companyId, async (tx) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
    if (!company) return { companyName: "", slug: null, roles: [] };
    if (!isCompanyVerified(company.settings)) return { companyName: company.name, slug: null, roles: [] };
    // A company whose trial ended takes no new applications (founder decision L-02 B): nothing to offer, and nothing said why.
    if (trialPaused(company, container.engine.clock())) return { companyName: company.name, slug: company.slug, roles: [] };
    const applied = new Set((await tx.select({ roleId: applications.roleId }).from(applications).where(and(eq(applications.companyId, input.companyId), eq(applications.candidateId, input.candidateId)))).map((a) => a.roleId));
    const openRoles = await tx.select({ id: roles.id, title: roles.title }).from(roles).where(and(eq(roles.companyId, input.companyId), eq(roles.status, "open"), eq(roles.acceptingApplications, true))).orderBy(roles.title);
    return { companyName: company.name, slug: company.slug, roles: openRoles.filter((r) => !applied.has(r.id)).map((r) => ({ roleId: r.id, title: r.title })) };
  });
}

/**
 * "Email me a link for this job", from the application record: the same queued email as "Applied here before?" (a link
 * that opens the job's form with the details on file), sent only to the address on the candidate's record. False when
 * the role is not one the record offers, or the person has no address on file.
 */
export async function queueReuseLinkFor(container: Container, input: { companyId: string; candidateId: string; roleId: string }): Promise<boolean> {
  const offered = await otherRolesFor(container, input);
  if (!offered.roles.some((r) => r.roleId === input.roleId)) return false;
  const [cand] = await withTenant(container.db, input.companyId, (tx) => tx.select({ email: candidates.email }).from(candidates).where(and(eq(candidates.id, input.candidateId), eq(candidates.companyId, input.companyId))).limit(1));
  if (!cand?.email) return false;
  await queueReuseLink(container, { companyId: input.companyId, roleId: input.roleId, email: cand.email });
  return true;
}

/** The application a record's private link opens, looked up before any company is known (a platform read). */
export async function applicationForStatusToken(db: Db, token: string): Promise<{ id: string; companyId: string; candidateId: string; statusToken: string } | null> {
  if (!token || token.length > 100) return null;
  const [app] = await withPlatform(db, (tx) => tx.select({ id: applications.id, companyId: applications.companyId, candidateId: applications.candidateId, statusToken: applications.statusToken }).from(applications).where(eq(applications.statusToken, token)).limit(1));
  return app ?? null;
}
