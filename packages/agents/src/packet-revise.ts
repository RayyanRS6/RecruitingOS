import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { PacketRevision as PacketRevisionSchema, REVISABLE_SECTION_LABEL, RevisableSection, type Actor, type DeclinedCriterion, type DraftRolePacket, type PacketRevision, type RevisionNotDone } from "@ros/contracts";
import { packetRevisePrompt, runPromptDetached, type AiRuntime, type RunOutcome } from "@ros/ai";
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
 * Asks the model for a proposal, with no transaction open while it thinks (`runPromptDetached`). The run row keeps what
 * the proposal was worked out on (the role's version, or the draft's fingerprint) and the request itself, for the record.
 */
export async function proposeRevision(
  db: Db,
  ai: AiRuntime,
  input: { companyId: string; companyName: string; actor: Actor; target: RevisionTarget; packet: DraftRolePacket; message: string; declined: DeclinedCriterion[] },
): Promise<RunOutcome<PacketRevision>> {
  const allowed = input.target.kind === "role" ? REVISABLE_FOR_ROLE : REVISABLE_FOR_DRAFT;
  const ref = input.target.kind === "role" ? { target: "role", roleId: input.target.roleId, baseVersion: input.target.baseVersion } : { target: "draft", sessionId: input.target.sessionId, baseHash: input.target.baseHash };
  return runPromptDetached(
    db,
    ai,
    packetRevisePrompt,
    { companyName: input.companyName, target: input.target.kind, roleStatus: input.target.kind === "role" ? input.target.roleStatus : null, packet: editableView(input.packet, allowed), allowed: [...allowed], declined: input.declined.map((d) => ({ requested: d.requested, reason: d.reason })), message: input.message },
    { companyId: input.companyId, inputRef: { ...ref, request: input.message, requestedBy: input.actor.id }, maxTokens: 16000 },
  );
}

const NOT_BY_CHAT = {
  pay: "Pay is set on the pay card.",
  decisionMaker: "Who makes the final decision is chosen from your team in the editor.",
  interviewers: "Who interviews is chosen from your team on the interview plan.",
  disclosure: "The line saying AI assists and the line on reaching a person stay as they are.",
  dealBreakers: "Deal-breakers in a draft are changed in the conversation or the panel beside it.",
} as const;

export type MergedRevision<T> = { packet: T; sections: RevisableSection[]; notChanged: RevisionNotDone[]; declined: DeclinedCriterion[] };

/**
 * The proposal laid over the packet it was worked out on, deterministically, so what is shown is what is saved. Only
 * the sections allowed for the target are taken; what the server owns inside them is put back (who decides, who
 * interviews, the AI notice lines, and a draft's deal-breakers), with a plain line for each part of the request that was
 * not done. A section the model returned unchanged is not counted as a change. Requests the model refused because they
 * stand in for a protected trait are recorded on the packet as declined, so no later version brings them back.
 */
export function mergeRevision<T extends DraftRolePacket>(base: T, revision: PacketRevision, target: "role" | "draft"): MergedRevision<T> {
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
      if (moved) note("Change who interviews", NOT_BY_CHAT.interviewers);
    }
    if (section === "preferences") {
      const value = next as DraftRolePacket["preferences"];
      if (value.decisionMakerUserId !== base.preferences.decisionMakerUserId || (value.decisionMakerName ?? null) !== (base.preferences.decisionMakerName ?? null)) note("Change who makes the final decision", NOT_BY_CHAT.decisionMaker);
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
    if (same(next, base[section])) continue;
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
  return { packet, sections, notChanged, declined };
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

/** A proposal by its id (the run that wrote it), or null when there is no such successful run in this company. */
export async function loadRevision(q: Queryable, runId: string): Promise<StoredRevision | null> {
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
    revision: parsed.data,
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
