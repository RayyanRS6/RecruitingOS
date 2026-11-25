import { intakeCompilePrompt, intakeExtractPrompt, intakeTurnPrompt, type IntakeContext, type PromptDef, type RunOutcome } from "@ros/ai";
import { INTAKE_COMPILE_MAX_TOKENS, afterTurn, factsFromExtraction, finalizePacket, mergeFacts, type AfterTurn } from "@ros/agents";
import { IntakeServerState, type Actor, type IntakeFacts, type IntakeMessage, type IntakeTurn, type RolePacket } from "@ros/contracts";
import { EMPTY_FACTS, draftFailures, draftSkillsNote, type IntakeCase } from "./intake-suite";

/**
 * One case of the job builder's suites (intake.*), driven as the runner drives it (runner.ts, which runs on import). Kept
 * here so a test can drive it with a scripted stand-in and pin the steps a run on the real models rests on: the check of
 * the job as the model wrote it, each job written afresh, a case set from its answers asking no turn, and the check of
 * every written job's skills, with the notes the result file keeps of them (`intakeCaseResult`). After each turn the
 * server's own work is done as the app does it (`afterTurn`), so a case can judge what the page would show.
 */

/** Who the case's owner is, for pay they typed (counted as set by them, as in the app). */
const EVAL_OWNER: Actor = { kind: "system", id: "eval" };

/** One model call, as the runner makes and records it (`runPrompt`); `meta` says what the call is for. */
export type IntakeModelCall = <TInput, TOutput>(prompt: PromptDef<TInput, TOutput>, input: TInput, meta: { inputRef: Record<string, unknown>; maxTokens?: number }) => Promise<RunOutcome<TOutput>>;

/**
 * The job builder's input for a case's answers and conversation so far. No pay is among it: no prompt is asked for the
 * pay any more, and a written job carries the pay in the case's answers (`finalizePacket`).
 */
export function intakeContextOf(c: Pick<IntakeCase, "vertical">, facts: IntakeFacts, messages: IntakeMessage[]): { ctx: IntakeContext } {
  const ad = messages.find((m) => m.kind === "pasted_ad");
  return {
    ctx: {
      company: { name: "Eval Co", vertical: c.vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
      facts,
      messages,
      ad: ad ? { text: ad.content } : null,
    },
  };
}

/**
 * A case's failures, and its notes (each written job's must-haves and skills by name). `compile`: whether the suite
 * writes jobs; a case's job is written only when the case checks one.
 */
export async function runIntakeCase(call: IntakeModelCall, c: IntakeCase, compile: boolean): Promise<{ failures: string[]; notes: string[] }> {
  const failures: string[] = [];
  const notes: string[] = [];
  let facts: IntakeFacts = { ...EMPTY_FACTS, ...c.facts };
  const messages: IntakeMessage[] = [];
  let lastTurn: IntakeTurn | null = null;
  // The server's own record of the draft, and what it made of the last turn.
  let state = IntakeServerState.parse({});
  let after: AfterTurn | null = null;
  // A case with its answers set is written straight from them: its messages are the conversation and no intake.turn
  // call reads them, so the job is given exactly those answers. It has no turn, so nothing of a turn can be checked.
  if (c.facts) {
    if (c.expectTurn || c.pastedAd) failures.push("a case with its answers set has no turn of the conversation to check");
    for (const m of c.ownerMessages) messages.push({ role: "owner", content: m, at: new Date().toISOString(), kind: "text" });
  }
  // Otherwise each message is a turn of the conversation, answered by intake.turn as in the job builder.
  for (const [i, m] of (c.facts ? [] : c.ownerMessages).entries()) {
    const asAd = i === 0 && !!c.pastedAd;
    messages.push({ role: "owner", content: m, at: new Date().toISOString(), kind: asAd ? "pasted_ad" : "text" });
    // A pasted ad is read once for what it states, before the first reply.
    if (asAd) {
      const x = await call(intakeExtractPrompt, { text: m, companyName: "Eval Co" }, { inputRef: { eval: c.id, read: "pasted_ad" } });
      if (!x.ok) {
        failures.push(`ad read failed: ${x.error}`);
        break;
      }
      if (x.output.isJobDescription) facts = factsFromExtraction(facts, x.output);
    }
    const r = await call(intakeTurnPrompt, intakeContextOf(c, facts, messages).ctx, { inputRef: { eval: c.id } });
    if (!r.ok) {
      failures.push(`turn failed: ${r.error}`);
      break;
    }
    // What the server makes of the turn, by the app's own code: what is still needed, whether the job can be written,
    // the cards and the reply as stored. Then the facts as the builder keeps them from the model's reading: a place or a
    // work arrangement the owner did not say is not kept (and nothing the server declined by itself is added, so a case
    // that checks a refusal checks the model's).
    after = afterTurn({ turn: r.output, messages, facts, state, actor: EVAL_OWNER, at: new Date().toISOString() });
    state = after.state;
    facts = mergeFacts(facts, r.output.factsExtracted, messages);
    messages.push({ role: "assistant", content: after.message, at: new Date().toISOString() });
    lastTurn = r.output;
  }
  if (lastTurn && after && c.expectTurn) failures.push(...c.expectTurn({ ...lastTurn, factsExtracted: facts }, after));
  if (compile && (c.expectPacket || c.expectDraft) && failures.length === 0) {
    const { ctx } = intakeContextOf(c, facts, messages);
    // As many jobs as the case asks for, each written afresh from the same answers and judged on its own: first as
    // the model wrote it, then as the server builds the job record from it (the work arrangement, the state, the pay,
    // the notices and their lines, the fairness guard).
    const drafts = Math.max(1, c.compiles ?? 1);
    for (let n = 1; n <= drafts; n++) {
      const which = drafts > 1 ? `draft ${n}: ` : "";
      const r = await call(intakeCompilePrompt, ctx, { inputRef: { eval: c.id, ...(drafts > 1 ? { draft: n } : {}) }, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      if (!r.ok) {
        failures.push(`${which}compile failed: ${r.error}`);
        continue;
      }
      failures.push(...(c.expectDraft?.(r.output) ?? []).map((x) => `${which}${x}`));
      // A job that cannot be published as it stands (no pay in the answers, say, so none is on the job) fails its case
      // with the reason. It never stops the run.
      let packet: RolePacket;
      try {
        packet = finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
      } catch (e) {
        failures.push(`${which}the job as written cannot be published: ${problemOf(e)} (pay in the answers: ${payOf(facts)})`);
        continue;
      }
      // The case's checks and, on every written job, a skill that repeats a must-have; the note keeps the job's
      // must-haves and skills by name (synthetic data), so one renamed can be seen in the result file.
      failures.push(...draftFailures(c, packet).map((x) => `${which}${x}`));
      notes.push(`${which}${draftSkillsNote(packet)}`);
      const declined = facts.declinedCriteria.map((d) => d.requested.toLowerCase());
      // The job records what was declined (and any flags) in its provenance on purpose; anywhere else is a leak.
      const text = JSON.stringify({ ...packet, provenance: { ...packet.provenance, declinedCriteria: [], flags: [] } }).toLowerCase();
      for (const d of declined) if (text.includes(d)) failures.push(`${which}declined criterion leaked into the job: ${d}`);
    }
  }
  return { failures, notes };
}

/** What stopped a job from being published, in a line: each field a schema refused with why, or the error's own words. */
function problemOf(e: unknown): string {
  const issues = (e as { issues?: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } | null)?.issues;
  if (Array.isArray(issues) && issues.length) return issues.map((i) => `${i.path.map(String).join(".") || "the job"}: ${i.message}`).join("; ");
  return e instanceof Error ? e.message : String(e);
}

/** A pay as a few words, for a failure's reason: "hourly 45 to 55", or what of it is missing. */
function payOf(p: { compensationBasis?: string; compensationMin?: number; compensationMax?: number }): string {
  if (p.compensationBasis === undefined && p.compensationMin === undefined && p.compensationMax === undefined) return "none";
  return `${p.compensationBasis ?? "no basis"} ${p.compensationMin ?? "no low end"} to ${p.compensationMax ?? "no high end"}`;
}

/** A case's entry in the result file: whether it passed, its failures, and its notes when it has any. */
export type IntakeCaseResult = { id: string; pass: boolean; failures: string[]; notes?: string[] };

/**
 * A case run and written as the runner writes it into the result file (`runIntakeSuite`), so a test can pin what the
 * signed file holds: a job with a skill named the same as one of its must-haves fails its case, and the entry keeps each
 * written job's must-haves and skills by name.
 */
export async function intakeCaseResult(call: IntakeModelCall, c: IntakeCase, compile: boolean): Promise<IntakeCaseResult> {
  // A case that stops (a check of its own that throws, say) is a failed case with the reason: the run goes on to the next.
  const { failures, notes } = await runIntakeCase(call, c, compile).catch((e: unknown) => ({ failures: [`the case stopped: ${problemOf(e)}`], notes: [] as string[] }));
  return { id: c.id, pass: failures.length === 0, failures, ...(notes.length ? { notes } : {}) };
}
