import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt } from "@ros/ai";
import { registerFakeHandlers } from "@ros/agents";
import type { DraftRolePacket, IntakeFacts, IntakeMessage } from "@ros/contracts";
import { intakeCaseResult, intakeContextOf, runIntakeCase, type IntakeModelCall } from "./intake-run";
import { EMPTY_FACTS, intakeGolden, intakeIllegal, type IntakeCase } from "./intake-suite";

/**
 * The steps of a job-builder case that a run on the real models rests on, driven as the runner drives them: the job is
 * checked as the model wrote it, before the server sets right what code would set right anyway; each of a case's jobs is
 * written afresh and judged on its own; a case set from its answers asks no turn of the conversation; and what the owner
 * was told could not be used is looked for in every written job. On the stand-in each of these passes whichever way it
 * is done, so only a scripted job can tell.
 */
function standIn() {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  let runs = 0;
  const call: IntakeModelCall = async (prompt, input, meta) => {
    const { result, model } = await callPrompt(rt, prompt, input, { companyId: null, ...meta });
    runs += 1;
    const runId = `run_${runs}`;
    if (result.kind === "ok") return { ok: true, output: result.output, runId, model };
    return { ok: false, runId, model, reason: result.kind === "refused" ? "refused" : "invalid", error: result.kind === "refused" ? result.reason : result.error };
  };
  /** The stand-in's own job from a case's answers, written before the case is run (its calls are not counted). */
  const draftOf = async (c: IntakeCase, answers: Partial<IntakeFacts> = c.facts ?? {}): Promise<DraftRolePacket> => {
    const messages: IntakeMessage[] = c.ownerMessages.map((content) => ({ role: "owner", content, at: "2026-11-18T12:00:00.000Z", kind: "text" }));
    const r = await callPrompt(rt, intakeCompilePrompt, intakeContextOf(c, { ...EMPTY_FACTS, ...answers }, messages).ctx, { companyId: null });
    if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a job: ${r.result.kind}`);
    fake.calls.length = 0;
    return r.result.output;
  };
  return { fake, call, draftOf, tasks: () => fake.calls.map((c) => c.task) };
}

const byId = (id: string): IntakeCase => {
  const c = [...intakeGolden, ...intakeIllegal].find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const HYGIENIST: Partial<IntakeFacts> = { title: "Hygienist", locationText: "Irvine, CA", remotePolicy: "onsite", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, mustHaves: ["Active CA RDH license"] };
const skill = (name: string, definition = "Shown in recent work."): DraftRolePacket["competencies"][number] => ({ key: name.toLowerCase().replace(/[^a-z]+/g, "_"), name, definition, importance: "important", indicators: ["An example from recent work"] });

describe("a job-builder case as the runner drives it", () => {
  it("writes a case set from its answers straight from them, asking no turn, as many jobs as it says, each noted", async () => {
    const twice = byId("dental_assistant_rule_out_words_written_twice");
    const { call, tasks } = standIn();
    const out = await runIntakeCase(call, twice, true);
    expect(out.failures).toEqual([]);
    expect(tasks()).toEqual(["intake.compile", "intake.compile"]);
    expect(out.notes.map((n) => n.slice(0, 9))).toEqual(["draft 1: ", "draft 2: "]);
    // a case set by its conversation asks a turn for each message, then writes its one job
    const typed = standIn();
    const rdh = await runIntakeCase(typed.call, byId("dental_rdh_one_sentence"), true);
    expect(rdh.failures).toEqual([]);
    expect(typed.tasks()).toEqual(["intake.turn", "intake.compile"]);
    expect(rdh.notes).toHaveLength(1);
    expect(rdh.notes[0]).toMatch(/^must-haves: "Active CA RDH license", "Periodontal charting"; skills: /);
    // and a suite that writes no job writes none, whatever the case checks
    const turnsOnly = standIn();
    expect((await runIntakeCase(turnsOnly.call, byId("dental_rdh_one_sentence"), false)).notes).toEqual([]);
    expect(turnsOnly.tasks()).toEqual(["intake.turn"]);
  });

  it("judges each job written again on its own, and says which one failed", async () => {
    const twice = byId("dental_assistant_rule_out_words_written_twice");
    const { fake, call, draftOf } = standIn();
    const draft = await draftOf(twice);
    const kept: DraftRolePacket = structuredClone(draft);
    kept.requirements.mustHaves = kept.requirements.mustHaves.map((m) => (m.text === "X-ray permit" ? { ...m, text: "No x-ray permit" } : m));
    fake.scriptNext("intake.compile", draft);
    fake.scriptNext("intake.compile", kept);
    expect((await runIntakeCase(call, twice, true)).failures).toEqual(["draft 2: must-haves written as what rules someone out: No x-ray permit"]);
  });

  it("checks the job as the model wrote it, though the server would set the disclosure line right", async () => {
    const asked = byId("dental_assistant_owner_questions");
    const { fake, call, draftOf } = standIn();
    const silent: DraftRolePacket = structuredClone(await draftOf(asked));
    silent.communication.disclosureText = "Sent by the hiring team.";
    fake.scriptNext("intake.compile", silent);
    expect((await runIntakeCase(call, asked, true)).failures).toEqual(["the disclosure line does not mention AI"]);
  });

  it("asks nothing for a case set from its answers that also checks a turn, and says why it fails", async () => {
    const { call, tasks } = standIn();
    const out = await runIntakeCase(call, { ...byId("dental_assistant_owner_questions"), expectTurn: () => [] }, true);
    expect(out.failures).toEqual(["a case with its answers set has no turn of the conversation to check"]);
    expect(tasks()).toEqual([]);
  });

  it("finds what the owner was told could not be used in a job written afterwards", async () => {
    const age = byId("age_recent_grads");
    const { fake, call, draftOf, tasks } = standIn();
    const leaked: DraftRolePacket = structuredClone(await draftOf(age, HYGIENIST));
    leaked.description.publicJobDescription += " Recent grads are welcome.";
    fake.scriptNext("intake.compile", leaked);
    const out = await runIntakeCase(call, age, true);
    expect(tasks()).toEqual(["intake.turn", "intake.turn", "intake.compile"]);
    expect(out.failures).toEqual(["declined criterion leaked into the job: recent grads"]);
  });

  // Every written job fails on a skill named the same as one of its must-haves, though its case's own checks never look
  // at skills, and its entry in the result file keeps the job's skills by name. No stand-in job has such a skill, so
  // only a scripted one can tell.
  it("fails a job with a skill named the same as one of its must-haves, and the case's entry keeps its skills by name", async () => {
    const asked = byId("dental_assistant_owner_questions");
    const { fake, call, draftOf } = standIn();
    const twin: DraftRolePacket = structuredClone(await draftOf(asked));
    expect(twin.requirements.mustHaves.map((m) => m.text)).toEqual(["Active California RDA license", "Four-handed dentistry"]);
    twin.competencies.push(skill("FOUR-HANDED DENTISTRY"));
    fake.scriptNext("intake.compile", twin);
    const entry = await intakeCaseResult(call, asked, true);
    expect(entry.id).toBe(asked.id);
    expect(entry.pass).toBe(false);
    expect(entry.failures).toEqual(['the skill "FOUR-HANDED DENTISTRY" (Shown in recent work.) repeats the must-have "Four-handed dentistry"']);
    expect(entry.notes).toHaveLength(1);
    expect(entry.notes?.[0]).toMatch(/^must-haves: "Active California RDA license", "Four-handed dentistry"; skills: [^;]*"FOUR-HANDED DENTISTRY"/);
    // the stand-in's own job passes, and keeps its note
    const own = await intakeCaseResult(call, asked, true);
    expect(own.pass).toBe(true);
    expect(own.failures).toEqual([]);
    expect(own.notes?.[0]).toMatch(/^must-haves: "Active California RDA license", /);
  });
});
