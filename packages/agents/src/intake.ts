import { eq } from "drizzle-orm";
import type { Actor, IntakeFacts, IntakeTurn, RolePacket } from "@ros/contracts";
import { RolePacket as RolePacketSchema } from "@ros/contracts";
import { intakeCompilePrompt, intakeTurnPrompt, runPromptDetached, type AiRuntime, type IntakeContext } from "@ros/ai";
import { emit, resolveJurisdictions, disclosureLine } from "@ros/core";
import { companies, intakeSessions, playbooks, rolePackets, roles, withTenant, type Db, type Queryable, type Tx } from "@ros/db";
import { VERTICAL_TO_PLAYBOOK, compensationFor, findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import type { CompAdapter } from "@ros/integrations";

export type IntakeDeps = { ai: AiRuntime; comp: CompAdapter };

const EMPTY_FACTS: IntakeFacts = { mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] };

/** Raised when a session is missing or no longer active; routes turn it into 404 or 409. */
export class IntakeSessionError extends Error {
  constructor(public readonly code: "not_found" | "not_active") {
    super(code === "not_found" ? "intake session not found" : "intake session is no longer active");
  }
}

/**
 * The intake runs in three parts so no database transaction waits on the model or the wage service: a short
 * transaction records the owner's message and loads what the prompt needs; the benchmark lookup and the model call
 * happen with nothing held; a second short transaction persists the reply. The run is recorded whatever happens.
 */
type IntakeInputs = {
  company: typeof companies.$inferSelect;
  session: typeof intakeSessions.$inferSelect;
  playbook: ReturnType<typeof findPlaybook>;
  playbookRole: ReturnType<typeof matchPlaybookRole>;
  playbookRow: { id: string; version: number } | null;
  titleGuess: string;
  locationText: string;
  basis: "hourly" | "salary";
};

async function loadIntakeInputs(q: Queryable, companyId: string, sessionId: string): Promise<IntakeInputs> {
  const [company] = await q.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
  if (!company || !session) throw new IntakeSessionError("not_found");
  const playbookVertical = VERTICAL_TO_PLAYBOOK[company.vertical] ?? company.vertical;
  const pbRow = (await q.select().from(playbooks).where(eq(playbooks.vertical, playbookVertical)).orderBy(playbooks.version).limit(1))[0] ?? null;
  const playbook = pbRow?.content ?? findPlaybook(company.vertical);
  const titleGuess = session.facts.title ?? session.messages.find((m) => m.role === "owner")?.content ?? "";
  const playbookRole = playbook ? matchPlaybookRole(playbook, titleGuess) : null;
  const locationText = session.facts.locationText ?? company.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ");
  const basis = (session.facts.compensationBasis as "hourly" | "salary" | undefined) ?? "hourly";
  return { company, session, playbook, playbookRole, playbookRow: pbRow ? { id: pbRow.id, version: pbRow.version } : null, titleGuess, locationText, basis };
}

/** The pay benchmark: the live wage service first (a network call, made with no transaction open), then the playbook's table. */
async function resolveBenchmark(comp: CompAdapter, inputs: IntakeInputs): Promise<IntakeContext["benchmark"]> {
  let benchmark: IntakeContext["benchmark"] = null;
  try {
    const live = await comp.benchmark({ title: inputs.playbookRole?.title ?? inputs.titleGuess, locationText: inputs.locationText, basis: inputs.basis });
    if (live) benchmark = { ...live };
  } catch {
    benchmark = null;
  }
  if (!benchmark && inputs.playbookRole) {
    const row = compensationFor(inputs.playbookRole, inputs.locationText);
    if (row) benchmark = { basis: row.basis, p25: row.p25, p50: row.p50, p75: row.p75, source: `${row.source} (playbook)`, metro: row.metro };
  }
  return benchmark;
}

function contextFrom(inputs: IntakeInputs, benchmark: IntakeContext["benchmark"]): IntakeContext {
  const { company, session } = inputs;
  return {
    company: { name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, locations: company.locations, benefitsSummary: company.settings.benefitsSummary, website: company.settings.website },
    playbook: inputs.playbook,
    playbookRole: inputs.playbookRole,
    benchmark,
    facts: session.facts,
    messages: session.messages,
  };
}

/** One owner message in, one assistant reply out. Persists the transcript and the merged facts. */
export async function runIntakeTurn(db: Db, deps: IntakeDeps, input: { companyId: string; sessionId: string; message: string; actor: Actor }): Promise<{ turn: IntakeTurn; aiRunId: string } | { error: string; aiRunId: string }> {
  const now = new Date().toISOString();
  const loaded = await withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (session.status !== "active") throw new IntakeSessionError("not_active");
    const messages = [...session.messages, { role: "owner" as const, content: input.message, at: now }];
    await q.update(intakeSessions).set({ messages }).where(eq(intakeSessions.id, session.id));
    return { inputs: await loadIntakeInputs(q, input.companyId, session.id), turn: messages.length };
  });
  const benchmark = await resolveBenchmark(deps.comp, loaded.inputs);
  const out = await runPromptDetached(db, deps.ai, intakeTurnPrompt, contextFrom(loaded.inputs, benchmark), { companyId: input.companyId, inputRef: { sessionId: input.sessionId, turn: loaded.turn } });
  const agent: Actor = { kind: "agent", id: "intake", runId: out.runId };
  return withTenant(db, input.companyId, async (q) => {
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (!out.ok) {
      await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: out.reason, error: out.error } });
      return { error: out.error, aiRunId: out.runId };
    }
    if (session.status !== "active") return { error: "This conversation has already produced a role.", aiRunId: out.runId };
    const merged = mergeFacts(session.facts, out.output.factsExtracted);
    const withReply = [...session.messages, { role: "assistant" as const, content: out.output.assistantMessage, at: new Date().toISOString(), aiRunId: out.runId }];
    await q.update(intakeSessions).set({ messages: withReply, facts: merged, missingFacts: out.output.missingFacts }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.turn_completed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { readyToCompile: out.output.readyToCompile, missing: out.output.missingFacts, confidence: out.output.confidence } });
    return { turn: { ...out.output, factsExtracted: merged }, aiRunId: out.runId };
  });
}

export type CompiledIntake = { roleId: string; packet: RolePacket; version: number; aiRunId: string };

/**
 * Compiles the Role Packet, creates the role (pending approval) and packet version 1. `finalize` runs inside the same
 * transaction as the role and packet rows (the caller starts the approval workflow and records the entitlement there),
 * so either everything commits or nothing does. Compiling twice returns the first result.
 */
export async function compileIntake(
  db: Db,
  deps: IntakeDeps,
  input: { companyId: string; sessionId: string; actor: Actor; hiringManagerUserId?: string | null },
  opts: { finalize?: (q: Tx, compiled: CompiledIntake) => Promise<void> } = {},
): Promise<CompiledIntake | { error: string; aiRunId: string }> {
  const loaded = await withTenant(db, input.companyId, async (q): Promise<{ existing: CompiledIntake; inputs: null } | { existing: null; inputs: IntakeInputs }> => {
    const existing = await alreadyCompiled(q, input.sessionId);
    if (existing) return { existing, inputs: null };
    return { existing: null, inputs: await loadIntakeInputs(q, input.companyId, input.sessionId) };
  });
  if (loaded.existing) return loaded.existing;
  const benchmark = await resolveBenchmark(deps.comp, loaded.inputs);
  const ctx = contextFrom(loaded.inputs, benchmark);
  const out = await runPromptDetached(db, deps.ai, intakeCompilePrompt, ctx, { companyId: input.companyId, inputRef: { sessionId: input.sessionId }, maxTokens: 24000 });
  const agent: Actor = { kind: "agent", id: "intake", runId: out.runId };
  return withTenant(db, input.companyId, async (q) => {
    const existing = await alreadyCompiled(q, input.sessionId); // a second compile of the same conversation returns the first packet
    if (existing) return existing;
    const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, input.sessionId)).limit(1);
    if (!session) throw new IntakeSessionError("not_found");
    if (!out.ok) {
      await emit(q, { type: "ai.run_failed", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { reason: out.reason, error: out.error } });
      return { error: out.error, aiRunId: out.runId };
    }
    const packet = finalizePacket(out.output, ctx, { sessionId: session.id, aiRunId: out.runId });
    const [role] = await q
      .insert(roles)
      .values({
        companyId: input.companyId,
        title: packet.identity.title,
        status: "pending_approval",
        hiringManagerUserId: input.hiringManagerUserId ?? null,
        playbookId: loaded.inputs.playbookRow?.id ?? null,
        playbookVersion: loaded.inputs.playbookRow?.version ?? null,
        playbookRoleKey: loaded.inputs.playbookRole?.key ?? null,
        createdBy: input.actor,
      })
      .returning();
    const [pv] = await q
      .insert(rolePackets)
      .values({ companyId: input.companyId, roleId: role.id, version: 1, packet, status: "proposed", source: "intake_agent", changeSummary: "Compiled from the intake conversation", createdBy: agent })
      .returning();
    await q.update(intakeSessions).set({ roleId: role.id, status: "compiled", draftPacket: packet }).where(eq(intakeSessions.id, session.id));
    await emit(q, { type: "intake.compiled", companyId: input.companyId, actor: agent, subject: { type: "intake_session", id: session.id }, payload: { roleId: role.id } });
    await emit(q, { type: "role.created", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { title: role.title, sessionId: session.id } });
    await emit(q, { type: "role_packet.proposed", companyId: input.companyId, actor: agent, subject: { type: "role_packet", id: `${role.id}:1` }, payload: { version: 1, assumptions: packet.provenance.assumptions } });
    const compiled: CompiledIntake = { roleId: role.id, packet, version: pv.version, aiRunId: out.runId };
    if (opts.finalize) await opts.finalize(q, compiled);
    return compiled;
  });
}

async function alreadyCompiled(q: Queryable, sessionId: string): Promise<CompiledIntake | null> {
  const [session] = await q.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).limit(1);
  if (!session) throw new IntakeSessionError("not_found");
  if (!session.roleId) return null;
  const [existing] = await q.select().from(rolePackets).where(eq(rolePackets.roleId, session.roleId)).limit(1);
  return existing ? { roleId: session.roleId, packet: existing.packet, version: existing.version, aiRunId: "" } : null;
}

/** Deterministic guarantees applied after the model: jurisdictions, disclosure, ceiling, provenance. */
export function finalizePacket(raw: RolePacket, ctx: IntakeContext, prov: { sessionId: string; aiRunId: string }): RolePacket {
  const packet: RolePacket = structuredClone(raw);
  const jurisdictions = resolveJurisdictions([...packet.identity.locations, ...ctx.company.locations]);
  packet.compliance.jurisdictions = jurisdictions;
  const notices = new Set([...packet.compliance.notices, "ai_use", "privacy"]);
  if (jurisdictions.some((j) => ["US-CA", "US-CO", "US-NY", "US-WA", "US-HI", "US-IL", "US-MD", "US-MN", "US-NJ", "US-VT", "US-MA"].includes(j))) {
    notices.add("pay_transparency");
    packet.compensation.discloseRange = true;
  }
  packet.compliance.notices = [...notices];
  if (packet.compensation.ceiling < packet.compensation.max) packet.compensation.ceiling = packet.compensation.max;
  if (packet.compensation.min > packet.compensation.max) [packet.compensation.min, packet.compensation.max] = [packet.compensation.max, packet.compensation.min];
  if (!packet.communication.disclosureText || !/AI|artificial intelligence/i.test(packet.communication.disclosureText)) packet.communication.disclosureText = disclosureLine(ctx.company.name);
  if (!packet.communication.humanAlternativeText) packet.communication.humanAlternativeText = "Reply HUMAN at any time and a person from our team will follow up.";
  packet.requirements.mustHaves = packet.requirements.mustHaves.slice(0, 6);
  packet.provenance = {
    ...packet.provenance,
    intakeSessionId: prov.sessionId,
    aiRunIds: [...(packet.provenance.aiRunIds ?? []), prov.aiRunId],
    playbookId: ctx.playbook ? `${ctx.playbook.vertical}@v${ctx.playbook.version}` : packet.provenance.playbookId,
    playbookVersion: ctx.playbook?.version ?? packet.provenance.playbookVersion,
    sources: [...new Set([...(packet.provenance.sources ?? []), ...(ctx.benchmark ? [ctx.benchmark.source] : [])])],
  };
  // Declined criteria must never leak into the packet.
  const declined = (ctx.facts.declinedCriteria ?? []).map((d) => d.requested.toLowerCase());
  packet.requirements.mustHaves = packet.requirements.mustHaves.filter((m) => !declined.some((d) => m.text.toLowerCase().includes(d)));
  packet.requirements.niceToHaves = packet.requirements.niceToHaves.filter((m) => !declined.some((d) => m.text.toLowerCase().includes(d)));
  return RolePacketSchema.parse(packet);
}

export function mergeFacts(prev: IntakeFacts, next: IntakeFacts): IntakeFacts {
  const out: IntakeFacts = { ...EMPTY_FACTS, ...prev };
  for (const [k, v] of Object.entries(next)) {
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
