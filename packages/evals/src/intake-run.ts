import { intakeCompilePrompt, intakeExtractPrompt, intakeTurnPrompt, type IntakeContext, type PromptDef, type RunOutcome } from "@ros/ai";
import { INTAKE_COMPILE_MAX_TOKENS, basisFor, factsFromExtraction, finalizePacket, mergeFacts, resolveBenchmark, type BenchmarkResult } from "@ros/agents";
import type { IntakeFacts, IntakeMessage, IntakeTurn } from "@ros/contracts";
import { findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import { EMPTY_FACTS, draftFailures, draftSkillsNote, type IntakeCase } from "./suites";

/**
 * One case of the job builder's suites (intake.*), driven as the runner drives it (runner.ts, which runs on import). Kept
 * here so a test can drive it with a scripted stand-in and pin the steps the run on the real models rests on: the check
 * on the draft as the model wrote it, each draft written afresh, and a case set from its answers asking no turn (review
 * of the intake evals fix, 13 Nov 2026).
 */

/** One model call, as the runner makes and records it (`runPrompt`); `meta` says what the call is for. */
export type IntakeModelCall = <TInput, TOutput>(prompt: PromptDef<TInput, TOutput>, input: TInput, meta: { inputRef: Record<string, unknown>; maxTokens?: number }) => Promise<RunOutcome<TOutput>>;

// The eval has no live wage service: the market check falls back to the playbook's table, as production does when the
// service is down. The basis comes first (plan C2), and the pay the owner typed counts as confirmed.
const noLiveWages = { id: "eval", status: "disabled" as const, benchmark: async () => null };

/** The job builder's input for a case's answers and conversation so far, with the market check made for it. */
export async function intakeContextOf(c: Pick<IntakeCase, "vertical">, facts: IntakeFacts, messages: IntakeMessage[]): Promise<{ ctx: IntakeContext; basis: "hourly" | "salary" | null; bench: BenchmarkResult }> {
  const playbook = findPlaybook(c.vertical);
  const typed = messages.filter((m) => m.role === "owner" && (!m.kind || m.kind === "text")).map((m) => m.content);
  const title = facts.title ?? typed[0] ?? "";
  const role = playbook && title ? matchPlaybookRole(playbook, title) : null;
  const basis = basisFor(facts, typed, role);
  const bench = await resolveBenchmark(noLiveWages, { basis, playbookRole: role, titleGuess: title, locationText: facts.locationText ?? "Irvine, CA" });
  const ad = messages.find((m) => m.kind === "pasted_ad");
  const pay = facts.compensationBasis && facts.compensationMin !== undefined && facts.compensationMax !== undefined && !ad ? { basis: facts.compensationBasis, min: facts.compensationMin, max: facts.compensationMax, ...(facts.compensationCeiling !== undefined ? { ceiling: facts.compensationCeiling } : {}) } : null;
  return {
    ctx: {
      company: { name: "Eval Co", vertical: c.vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
      playbook, playbookRole: role,
      benchmark: bench.benchmark, benchmarkGap: bench.gap,
      facts, messages,
      ad: ad ? { text: ad.content } : null,
      confirmedPay: pay,
    },
    basis,
    bench,
  };
}

/**
 * A case's failures, and its notes (each finished draft's must-haves and skills by name). `compile`: whether the suite
 * writes drafts; a case is compiled only when it checks one.
 */
export async function runIntakeCase(call: IntakeModelCall, c: IntakeCase, compile: boolean): Promise<{ failures: string[]; notes: string[] }> {
  const failures: string[] = [];
  const notes: string[] = [];
  let facts: IntakeFacts = { ...EMPTY_FACTS, ...c.facts };
  const messages: IntakeMessage[] = [];
  let lastTurn: IntakeTurn | null = null;
  // A case with its answers set is written straight from them (the quick start's edit, say): its messages are the
  // conversation and no intake.turn call reads them, so the draft is given exactly those answers (review of the
  // live-test fixes, #23). It has no turn, so nothing of a turn can be checked.
  if (c.facts) {
    if (c.expectTurn || c.expectBenchmark || c.pastedAd) failures.push("a case with its answers set has no turn of the conversation to check");
    for (const m of c.ownerMessages) messages.push({ role: "owner", content: m, at: new Date().toISOString(), kind: "text" });
  }
  // Otherwise each message is a turn of the conversation, answered by intake.turn as in the job builder.
  for (const [i, m] of (c.facts ? [] : c.ownerMessages).entries()) {
    const asAd = i === 0 && !!c.pastedAd;
    messages.push({ role: "owner", content: m, at: new Date().toISOString(), kind: asAd ? "pasted_ad" : "text" });
    // A pasted ad is read once for what it states before the market check (plan C5).
    if (asAd) {
      const x = await call(intakeExtractPrompt, { text: m, companyName: "Eval Co" }, { inputRef: { eval: c.id, read: "pasted_ad" } });
      if (!x.ok) {
        failures.push(`ad read failed: ${x.error}`);
        break;
      }
      if (x.output.isJobDescription) facts = factsFromExtraction(facts, x.output);
    }
    const built = await intakeContextOf(c, facts, messages);
    if (i === 0 && c.expectBenchmark) failures.push(...c.expectBenchmark({ basis: built.basis, benchmark: built.bench.benchmark, gap: built.bench.gap }));
    const r = await call(intakeTurnPrompt, built.ctx, { inputRef: { eval: c.id } });
    if (!r.ok) {
      failures.push(`turn failed: ${r.error}`);
      break;
    }
    facts = mergeFacts(facts, r.output.factsExtracted);
    messages.push({ role: "assistant", content: r.output.assistantMessage, at: new Date().toISOString() });
    lastTurn = r.output;
  }
  if (lastTurn && c.expectTurn) failures.push(...c.expectTurn({ ...lastTurn, factsExtracted: facts }));
  if (compile && (c.expectPacket || c.expectDraft) && failures.length === 0) {
    const { ctx } = await intakeContextOf(c, facts, messages);
    // As many drafts as the case asks for, each written afresh from the same answers ("Write it again") and judged on
    // its own: first as the model wrote it, then as the server finishes it (pay, the rules set in code, the guard).
    // The backstop that drops a question the owner left unticked (`withoutUntickedQuestions`, run when a draft is
    // written in the app) is left out on purpose, so a case measures the prompt's own line on the form.
    const drafts = Math.max(1, c.compiles ?? 1);
    for (let n = 1; n <= drafts; n++) {
      const which = drafts > 1 ? `draft ${n}: ` : "";
      const r = await call(intakeCompilePrompt, ctx, { inputRef: { eval: c.id, ...(drafts > 1 ? { draft: n } : {}) }, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      if (!r.ok) {
        failures.push(`${which}compile failed: ${r.error}`);
        continue;
      }
      failures.push(...(c.expectDraft?.(r.output) ?? []).map((x) => `${which}${x}`));
      const packet = finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
      // The case's checks and, on every compiled case, a skill that repeats a must-have; the note keeps the draft's
      // must-haves and skills by name (synthetic data), so one renamed can be seen in the result file (second review
      // of the live-test fixes, #14).
      failures.push(...draftFailures(c, packet).map((x) => `${which}${x}`));
      notes.push(`${which}${draftSkillsNote(packet)}`);
      const declined = facts.declinedCriteria.map((d) => d.requested.toLowerCase());
      // The packet records what was declined (and any flags) in its provenance on purpose; anywhere else is a leak.
      const text = JSON.stringify({ ...packet, provenance: { ...packet.provenance, declinedCriteria: [], flags: [] } }).toLowerCase();
      for (const d of declined) if (text.includes(d)) failures.push(`${which}declined criterion leaked into packet: ${d}`);
    }
  }
  return { failures, notes };
}
