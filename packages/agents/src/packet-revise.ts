import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { PacketRevision as PacketRevisionSchema, REVISABLE_SECTION_LABEL, RevisableSection, type Actor, type DeclinedCriterion, type DraftRolePacket, type PacketRevision, type RevisionNotDone } from "@ros/contracts";
import { packetRevisePrompt, routeDeadline, runPromptDetached, type AiRuntime, type RunOutcome } from "@ros/ai";
import { normalizeCriterion, screenCriterion } from "@ros/core";
import { aiRuns, type Db, type Queryable } from "@ros/db";

/**
 * Changing a packet by chat (plan C10). The model writes only a proposal: the sections that change and a plain summary.
 * Nothing is saved here. The route shows the merged, guarded change and the person confirms it; only then does it become
 * a new version of the role (source `agent_revision`) or the new draft before the role exists. The model's output stays
 * on its `ai_runs` row, so confirming reads exactly what was shown, never something the browser sends back, and the row
 * records what became of it (`final_outcome`).
 */

/** Every section may change on a saved role. */
export const REVISABLE_FOR_ROLE: readonly RevisableSection[] = RevisableSection.options;
/** A draft's pay is only ever what a person set or confirmed on the pay card (C7), so pay is not changed by chat there. */
export const REVISABLE_FOR_DRAFT: readonly RevisableSection[] = RevisableSection.options.filter((s) => s !== "compensation");

/** A short fingerprint of a draft: a change by chat or a fix is applied only to the draft it was worked out on. */
export function packetFingerprint(packet: unknown): string {
  return createHash("sha256").update(stableJson(packet)).digest("hex").slice(0, 16);
}

/** JSON with every object's keys sorted, so two copies of the same packet compare equal whatever order they were stored in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

export type RevisionTarget = { kind: "role"; roleId: string; baseVersion: number; roleStatus: string } | { kind: "draft"; sessionId: string; baseHash: string };

/** The sections the model may see and change, as they are now; provenance, approvals and compliance never leave the server. */
export function editableView(packet: DraftRolePacket, allowed: readonly RevisableSection[]): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const s of allowed) if (packet[s] !== undefined) view[s] = packet[s];
  return view;
}

/**
 * What a fresh try needs of the request's time: one call with its correction turn (the provider starts a correction only
 * with 120 s of its budget left) and the 30 s the route keeps to record the run and answer (providers/anthropic.ts).
 */
const FRESH_TRY_NEEDS_MS = 150_000;

/**
 * Whether a proposal that failed is worth one fresh call: neither reply held a usable answer (live test, 12 Nov 2026:
 * "no valid output (unconstrained): the reply holds no JSON object", and the same words sent again worked), and the
 * request has the time. Never for a reply cut off at max_tokens (asking again is cut off the same way), an outage, a
 * refusal, no AI help left, or a call that already ran out of time for its correction.
 */
export function worthAFreshTry(out: RunOutcome<unknown>, deadlineAt: number, now = Date.now()): boolean {
  return !out.ok && out.reason === "invalid" && out.error.startsWith("no valid output") && !out.error.includes("too little time") && deadlineAt - now >= FRESH_TRY_NEEDS_MS;
}

/**
 * Asks the model for a proposal, with no transaction open while it thinks (`runPromptDetached`). The run row keeps what
 * the proposal was worked out on (the role's version, or the draft's fingerprint) and the request itself, for the record.
 * When neither reply of the call held a usable answer, it asks once more, afresh, within the request's deadline
 * (`worthAFreshTry`): the first run keeps its row as it ended, the second names it (`retryOf`), and the proposal is the
 * second run's. What the person reads comes back in plain words (`plainRevision`).
 */
export async function proposeRevision(
  db: Db,
  ai: AiRuntime,
  input: { companyId: string; companyName: string; actor: Actor; target: RevisionTarget; packet: DraftRolePacket; message: string; declined: DeclinedCriterion[]; deadlineAt?: number },
): Promise<RunOutcome<PacketRevision>> {
  const deadlineAt = input.deadlineAt ?? routeDeadline();
  const allowed = input.target.kind === "role" ? REVISABLE_FOR_ROLE : REVISABLE_FOR_DRAFT;
  const ref = input.target.kind === "role" ? { target: "role", roleId: input.target.roleId, baseVersion: input.target.baseVersion } : { target: "draft", sessionId: input.target.sessionId, baseHash: input.target.baseHash };
  const promptInput = { companyName: input.companyName, target: input.target.kind, roleStatus: input.target.kind === "role" ? input.target.roleStatus : null, packet: editableView(input.packet, allowed), allowed: [...allowed], declined: input.declined.map((d) => ({ requested: d.requested, reason: d.reason })), message: input.message };
  const meta = { companyId: input.companyId, inputRef: { ...ref, request: input.message, requestedBy: input.actor.id }, maxTokens: 16000, deadlineAt };
  const first = await runPromptDetached(db, ai, packetRevisePrompt, promptInput, meta);
  const out = worthAFreshTry(first, deadlineAt) ? await runPromptDetached(db, ai, packetRevisePrompt, promptInput, { ...meta, inputRef: { ...meta.inputRef, retryOf: first.runId } }) : first;
  return out.ok ? { ...out, output: plainRevision(out.output, input.companyName) } : out;
}

/** "the packet", "the Role Packet", "the draft packet's": the word for the job's record, and what the person calls it. */
const PACKET_WORD = /\b(?:(role|job|draft)(?:['\u2019]s)?\s+)?(packet)(s)?\b/gi;
/** The words before "packet" that make it the job's record ("the packet", "your packet"), not another thing ("patient packets"). */
const RECORD_BEFORE = new Set(["the", "this", "that", "your", "its", "our", "each", "a", "an"]);
/**
 * Words that only say which of the job's records it is, between one of those (or the start of a sentence) and "packet":
 * "the current packet", "your saved packet" (review of the change-by-chat fix, 13 Nov 2026). Never a noun, so "the
 * updated welcome packet" and "the new hire packet" stay the thing itself.
 */
const RECORD_QUALIFIER = new Set(["current", "existing", "saved", "same", "updated", "latest", "whole", "entire", "original", "revised", "provided", "given"]);

/** Whether the text up to here ends where a sentence starts. */
const atSentenceStart = (before: string) => /(?:^|[.!?]["'\u201d)]?\s+)$/.test(before);

/** The text before "packet" without the words that only qualify it ("the current " reads "the "). */
function withoutQualifiers(before: string): string {
  let rest = before;
  let last = /([A-Za-z]+)\s+$/.exec(rest);
  while (last && RECORD_QUALIFIER.has(last[1].toLowerCase())) {
    rest = rest.slice(0, last.index);
    last = /([A-Za-z]+)\s+$/.exec(rest);
  }
  return rest;
}

/** Whether the text up to here is inside double quotes ("\u2026" or \u201c\u2026\u201d): words quoted are someone's own. */
function quoted(before: string): boolean {
  return (before.match(/"/g) ?? []).length % 2 === 1 || before.lastIndexOf("\u201c") > before.lastIndexOf("\u201d");
}

/** Where a name (the company's) is in the text, written as it is ("The Packet", never "the packet"). */
function spansOf(text: string, name: string | undefined): Array<[number, number]> {
  const n = name?.trim();
  if (!n || !/packet/i.test(n)) return [];
  return [...text.matchAll(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/**
 * The person's words for the job's record, never "packet" (live test, 12 Nov 2026: "I did not change anything because
 * the packet already says this."): "the draft packet" reads "the draft"; the Role Packet, and a packet after the, this,
 * that, your, its, our, each, a or an or starting a sentence, also with a word such as current, existing or saved
 * between ("the current packet", "Current packet"), reads "job"; a plural stays one, and it is in lower case unless it
 * starts a sentence. Any other "packet" is the thing itself and keeps its word (review of the live-test fixes, 12 Nov
 * 2026: "new patient packets" read "new patient jobs"): after another noun ("new patient packets", "a welcome packet",
 * "pay packets"), inside double quotes, before a name ("Packet Dental", not "I") and inside the company's name.
 */
export function plainWords(text: string, companyName?: string): string {
  const name = spansOf(text, companyName);
  return text.replace(PACKET_WORD, (match: string, kind: string | undefined, _word: string, plural: string | undefined, offset: number) => {
    const before = text.slice(0, offset);
    const startsSentence = atSentenceStart(before);
    const lead = withoutQualifiers(before);
    const record = !!kind || startsSentence || (lead !== before && atSentenceStart(lead)) || RECORD_BEFORE.has(/([A-Za-z]+)\s+$/.exec(lead)?.[1]?.toLowerCase() ?? "");
    const named = /^\s+(?!I\b)[A-Z]/.test(text.slice(offset + match.length)) || name.some(([a, b]) => offset < b && offset + match.length > a);
    if (!record || named || quoted(before)) return match;
    const word = `${kind?.toLowerCase() === "draft" ? "draft" : "job"}${plural ? "s" : ""}`;
    return startsSentence ? `${word[0].toUpperCase()}${word.slice(1)}` : word;
  });
}

/**
 * A proposal with what the person reads in plain words (`plainWords`): the summary, the question and why each part was
 * not done. The request stays as written here, for the fairness record (`mergeRevision` shows it in plain words).
 */
export function plainRevision(r: PacketRevision, companyName?: string): PacketRevision {
  const plain = (text: string) => plainWords(text, companyName);
  return {
    ...r,
    summary: plain(r.summary),
    ...(r.question !== undefined ? { question: plain(r.question) } : {}),
    notChanged: r.notChanged.map((n) => ({ ...n, reason: plain(n.reason) })),
  };
}

/**
 * Why part of a request was not done, as the person reads it. On a draft the owner's answers hold who interviews, who
 * decides and the deal-breakers, changed with Edit beside the draft (live test, 12 Nov 2026: "the conversation" by then
 * only takes changes like this one, and "the interview plan" is a tab of the saved job; review of the live-test fixes:
 * the decision maker's line said "the editor"); a saved job keeps its own places.
 */
const NOT_BY_CHAT = {
  pay: "Pay is set on the pay card.",
  decisionMaker: "Who makes the final decision is chosen from your team in the editor.",
  decisionMakerOnDraft: "Who makes the final decision is chosen from your team with Edit beside the draft.",
  interviewers: "Who interviews is chosen from your team on the interview plan.",
  interviewersOnDraft: "Who interviews is chosen from your team with Edit beside the draft.",
  disclosure: "The line saying AI assists and the line on reaching a person stay as they are.",
  dealBreakers: "Deal-breakers in a draft are changed with Edit beside the draft.",
  knockout: 'On a draft, a "no" to a question on the form always holds the application for your decision. To ask it without holding anyone, ask for it in the AI interview instead.',
} as const;

/**
 * The summary the person reads when the model proposed a change and the server put every part of it back (review of the
 * live-test fixes, 12 Nov 2026: "I changed the CPR question so a no no longer holds the application. Not done: ..."):
 * never the model's own words about a change that was not made.
 */
const NOTHING_CHANGED = "Nothing was changed.";

/** A draft's questions on the form, each holding a "no" for the owner's decision, as `finalizeDraft` keeps every draft. */
function holdingEveryNo(r: DraftRolePacket["requirements"]): DraftRolePacket["requirements"] {
  return { ...r, eligibility: r.eligibility.map((e) => ({ ...e, knockout: true })) };
}

/**
 * The merge: the packet as it would be saved, the sections that change, each part not done as the person reads it
 * (the request in plain words too), what was declined (in the request's own words), and the summary to show.
 */
export type MergedRevision<T> = { packet: T; sections: RevisableSection[]; notChanged: RevisionNotDone[]; declined: DeclinedCriterion[]; summary: string };

/**
 * The proposal laid over the packet it was worked out on, deterministically, so what is shown is what is saved. Only
 * the sections allowed for the target are taken; what the server owns inside them is put back (who decides, who
 * interviews, the AI notice lines, and a draft's deal-breakers, and on a draft every question on the form holds a "no"
 * for the owner's decision), with a plain line for each part of the request that was not done: a question on the form
 * that held, loosened, is such a part, while a new one is simply set to hold. A section the model returned unchanged is
 * not counted as a change, and when the model changed something and none of it is left, the summary says nothing was
 * changed. Requests the model refused because they stand in for a protected trait are recorded on the packet as declined,
 * in their own words, so no later version brings them back; each request is shown in plain words (the company's name,
 * when given, kept as it is).
 */
export function mergeRevision<T extends DraftRolePacket>(base: T, revision: PacketRevision, target: "role" | "draft", companyName?: string): MergedRevision<T> {
  const allowed = target === "role" ? REVISABLE_FOR_ROLE : REVISABLE_FOR_DRAFT;
  const packet = structuredClone(base);
  const notChanged: RevisionNotDone[] = [...revision.notChanged];
  const note = (request: string, reason: string) => {
    if (!notChanged.some((n) => n.reason === reason)) notChanged.push({ request, reason });
  };
  const sections: RevisableSection[] = [];
  for (const section of RevisableSection.options) {
    const proposed = revision.changes[section];
    if (proposed === undefined) continue;
    if (!allowed.includes(section)) {
      note(`Change the ${REVISABLE_SECTION_LABEL[section].toLowerCase()}`, section === "compensation" ? NOT_BY_CHAT.pay : `${REVISABLE_SECTION_LABEL[section]} is not changed by chat.`);
      continue;
    }
    const next = structuredClone(proposed);
    if (section === "interviews") {
      const value = next as DraftRolePacket["interviews"];
      const known = new Set(base.interviews.plan.flatMap((r) => r.interviewerUserIds));
      let moved = false;
      value.plan = value.plan.map((r) => {
        const before = base.interviews.plan.find((b) => b.key === r.key);
        const ids = before ? before.interviewerUserIds : r.interviewerUserIds.filter((id) => known.has(id));
        if (!same([...r.interviewerUserIds].sort(), [...ids].sort())) moved = true;
        return { ...r, interviewerUserIds: ids };
      });
      if (moved) note("Change who interviews", target === "draft" ? NOT_BY_CHAT.interviewersOnDraft : NOT_BY_CHAT.interviewers);
    }
    if (section === "preferences") {
      const value = next as DraftRolePacket["preferences"];
      if (value.decisionMakerUserId !== base.preferences.decisionMakerUserId || (value.decisionMakerName ?? null) !== (base.preferences.decisionMakerName ?? null)) note("Change who makes the final decision", target === "draft" ? NOT_BY_CHAT.decisionMakerOnDraft : NOT_BY_CHAT.decisionMaker);
      value.decisionMakerUserId = base.preferences.decisionMakerUserId;
      value.decisionMakerName = base.preferences.decisionMakerName;
      if (value.decisionMakerUserId === undefined) delete value.decisionMakerUserId;
      if (value.decisionMakerName === undefined) delete value.decisionMakerName;
      if (target === "draft" && !same(value.dealBreakersInTheirWords, base.preferences.dealBreakersInTheirWords)) {
        note("Change the deal-breakers", NOT_BY_CHAT.dealBreakers);
        value.dealBreakersInTheirWords = base.preferences.dealBreakersInTheirWords;
      }
    }
    if (section === "communication") {
      const value = next as DraftRolePacket["communication"];
      if (value.disclosureText !== base.communication.disclosureText || value.humanAlternativeText !== base.communication.humanAlternativeText) note("Change the AI notice", NOT_BY_CHAT.disclosure);
      value.disclosureText = base.communication.disclosureText;
      value.humanAlternativeText = base.communication.humanAlternativeText;
    }
    if (section === "compensation" && base.compensation) {
      const value = next as NonNullable<DraftRolePacket["compensation"]>;
      // Whether a person stated the range stays as recorded; the figures are confirmed by whoever confirms this change.
      value.ownerStated = base.compensation.ownerStated;
    }
    // On a draft every question on the form holds a "no" for the owner's decision (`finalizeDraft`), so chat never makes
    // one hold nobody; a saved job's own "asked, not required" stays the person's, in its editor. Only a question that
    // held and was loosened is said to be not done: a new one is simply set to hold (review of the live-test fixes,
    // 12 Nov 2026: a question added by chat got a "Not done" nobody asked for).
    const holding = section === "requirements" && target === "draft";
    if (holding) {
      const value = next as DraftRolePacket["requirements"];
      const held = new Set(base.requirements.eligibility.filter((e) => e.knockout).map((e) => e.key));
      if (value.eligibility.some((e) => e.knockout === false && held.has(e.key))) note("Stop a question on the form from holding anyone", NOT_BY_CHAT.knockout);
      value.eligibility = value.eligibility.map((e) => ({ ...e, knockout: true }));
    }
    if (same(next, holding ? holdingEveryNo(base.requirements) : base[section])) continue;
    (packet as Record<string, unknown>)[section] = next;
    sections.push(section);
  }
  // Nothing may point at something to look for that the change took away: an interview step keeps at least one.
  if (sections.includes("competencies")) {
    const keys = new Set(packet.competencies.map((c) => c.key));
    packet.interviews.plan = packet.interviews.plan.map((r) => {
      const kept = r.competencyKeys.filter((k) => keys.has(k));
      return { ...r, competencyKeys: kept.length ? kept : [packet.competencies[0].key] };
    });
    packet.screening.questions = packet.screening.questions.map((q) => {
      if (!q.competencyKey || keys.has(q.competencyKey)) return q;
      const { competencyKey: _gone, ...rest } = q;
      return rest;
    });
  }
  const declined: DeclinedCriterion[] = [];
  for (const n of notChanged) {
    const hit = screenCriterion(n.request);
    if (hit && !declined.some((d) => normalizeCriterion(d.requested) === normalizeCriterion(n.request))) declined.push({ requested: n.request, reason: n.reason, alternative: hit.alternative, rule: hit.rule });
  }
  if (declined.length) packet.provenance.declinedCriteria = [...(packet.provenance.declinedCriteria ?? []), ...declined.filter((d) => !(packet.provenance.declinedCriteria ?? []).some((x) => normalizeCriterion(x.requested) === normalizeCriterion(d.requested)))];
  // The model writes the request in its own words, and the person reads it ("Not done: ..."): in plain words too, once
  // the fairness record above has it as written (review of the live-test fixes, 12 Nov 2026).
  const shown = notChanged.map((n) => ({ ...n, request: plainWords(n.request, companyName) }));
  // A section sent back as it was is no change the model made; one it did make that the server put back is.
  const proposed = RevisableSection.options.some((s) => revision.changes[s] !== undefined && !same(revision.changes[s], base[s]));
  return { packet, sections, notChanged: shown, declined, summary: proposed && !sections.length ? NOTHING_CHANGED : revision.summary };
}

/** Whether the pay figures differ between two packets: a confirmed change of pay is recorded as set by the person who confirmed it. */
export function payChanged(before: DraftRolePacket, after: DraftRolePacket): boolean {
  const a = before.compensation;
  const b = after.compensation;
  if (!a || !b) return !!a !== !!b;
  return a.basis !== b.basis || a.min !== b.min || a.max !== b.max || a.ceiling !== b.ceiling;
}

export type StoredRevision = {
  runId: string;
  target: "role" | "draft";
  roleId: string | null;
  baseVersion: number | null;
  sessionId: string | null;
  baseHash: string | null;
  request: string | null;
  revision: PacketRevision;
  /** What became of it: applied (and as which version), or set aside. Null while nobody has decided. */
  decided: { decision: "applied" | "discarded"; at: string; by: Actor; version?: number } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A proposal by its id (the run that wrote it), or null when there is no such successful run in this company. Its words
 * are the ones the person was shown (`plainRevision`, the company's name kept as it is); the run keeps the model's own.
 */
export async function loadRevision(q: Queryable, runId: string, companyName?: string): Promise<StoredRevision | null> {
  if (!UUID.test(runId)) return null;
  const [row] = await q.select().from(aiRuns).where(eq(aiRuns.id, runId)).limit(1);
  if (row?.task !== "packet.revise" || row.status !== "ok" || !row.structuredOutput) return null;
  const parsed = PacketRevisionSchema.safeParse(row.structuredOutput);
  if (!parsed.success) return null;
  const ref = row.inputRef as Record<string, unknown>;
  const str = (k: string) => (typeof ref[k] === "string" ? (ref[k] as string) : null);
  const target = ref.target === "draft" ? "draft" : "role";
  return {
    runId: row.id,
    target,
    roleId: str("roleId"),
    baseVersion: typeof ref.baseVersion === "number" ? ref.baseVersion : null,
    sessionId: str("sessionId"),
    baseHash: str("baseHash"),
    request: str("request"),
    revision: plainRevision(parsed.data, companyName),
    decided: (row.finalOutcome as StoredRevision["decided"]) ?? null,
  };
}

/**
 * Records on the run what became of the proposal, once: the first decision stands. False when someone decided it a
 * moment ago (two clicks at once), so the caller can refuse the second instead of saving the change twice.
 */
export async function decideRevision(q: Queryable, runId: string, outcome: NonNullable<StoredRevision["decided"]>): Promise<boolean> {
  const done = await q.update(aiRuns).set({ finalOutcome: outcome as unknown as Record<string, unknown> }).where(and(eq(aiRuns.id, runId), isNull(aiRuns.finalOutcome))).returning({ id: aiRuns.id });
  return done.length > 0;
}
