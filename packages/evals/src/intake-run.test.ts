import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt } from "@ros/ai";
import { registerFakeHandlers } from "@ros/agents";
import type { DraftRolePacket, IntakeMessage } from "@ros/contracts";
import { intakeCaseResult, intakeContextOf, runIntakeCase, type IntakeModelCall } from "./intake-run";
import { DA_RDA_QUESTION, EMPTY_FACTS, intakeGolden, type IntakeCase } from "./suites";

/**
 * The steps of a job-builder case that the run on the real models rests on, driven as the runner drives them (review of
 * the intake evals fix, 13 Nov 2026): the draft is checked as the model wrote it, before the server makes every question
 * hold; each of a case's drafts is written afresh and judged on its own; a case set from its answers asks no turn of the
 * conversation; and the server's backstop for a question left unticked is left out, so the prompt's own line is measured.
 * On the stand-in each of these passes whichever way it is done, so only a scripted draft can tell.
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
  /** The stand-in's own draft of a case's answers, written before the case is run (its calls are not counted). */
  const draftOf = async (c: IntakeCase): Promise<DraftRolePacket> => {
    const messages: IntakeMessage[] = c.ownerMessages.map((content) => ({ role: "owner", content, at: "2026-11-13T12:00:00.000Z", kind: "text" }));
    const { ctx } = await intakeContextOf(c, { ...EMPTY_FACTS, ...c.facts }, messages);
    const r = await callPrompt(rt, intakeCompilePrompt, ctx, { companyId: null });
    if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a draft: ${r.result.kind}`);
    fake.calls.length = 0;
    return r.result.output;
  };
  return { fake, call, draftOf, tasks: () => fake.calls.map((c) => c.task) };
}

const byId = (id: string): IntakeCase => {
  const c = intakeGolden.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const skill = (name: string, definition = "Shown in recent work."): DraftRolePacket["competencies"][number] => ({ key: name.toLowerCase().replace(/[^a-z]+/g, "_"), name, definition, weight: 5, evaluatedIn: "both", indicators: ["An example from recent work"] });

describe("a job-builder case as the runner drives it", () => {
  it("writes a case set from its answers straight from them, asking no turn, as many drafts as it says, each noted", async () => {
    const twice = byId("dental_assistant_rule_out_words_written_twice");
    const { call, tasks } = standIn();
    const out = await runIntakeCase(call, twice, true);
    expect(out.failures).toEqual([]);
    expect(tasks()).toEqual(["intake.compile", "intake.compile"]);
    expect(out.notes.map((n) => n.slice(0, 9))).toEqual(["draft 1: ", "draft 2: "]);
    // a case set by its conversation asks a turn for each message, then writes its one draft
    const typed = standIn();
    const front = await runIntakeCase(typed.call, byId("dental_front_office_just_draft_it"), true);
    expect(front.failures).toEqual([]);
    expect(typed.tasks()).toEqual(["intake.turn", "intake.compile"]);
    expect(front.notes).toHaveLength(1);
    expect(front.notes[0]).toMatch(/^must-haves: /);
  });

  it("judges each draft written again on its own, and says which one failed", async () => {
    const twice = byId("dental_assistant_rule_out_words_written_twice");
    const { fake, call, draftOf } = standIn();
    const draft = await draftOf(twice);
    const kept: DraftRolePacket = structuredClone(draft);
    kept.requirements.mustHaves = kept.requirements.mustHaves.map((m) => (m.text === "X-ray permit" ? { ...m, text: "No x-ray permit" } : m));
    fake.scriptNext("intake.compile", draft);
    fake.scriptNext("intake.compile", kept);
    expect((await runIntakeCase(call, twice, true)).failures).toEqual(["draft 2: must-haves written as what rules someone out: No x-ray permit"]);
  });

  it("checks the draft as the model wrote it, though the server makes every question on the form hold", async () => {
    const counted = byId("dental_assistant_quick_start_deal_breaker_counted_openly");
    const { fake, call, draftOf } = standIn();
    const loose: DraftRolePacket = structuredClone(await draftOf(counted));
    const first = loose.requirements.eligibility[0]!;
    first.knockout = false;
    fake.scriptNext("intake.compile", loose);
    expect((await runIntakeCase(call, counted, true)).failures).toEqual([`the AI wrote questions on the form whose "no" holds nobody: ${first.key}`]);
  });

  it("leaves out the server's backstop for a question left unticked, so a model that puts it back fails", async () => {
    const kept = byId("dental_assistant_quick_start_deal_breaker_kept_private");
    const { fake, call, draftOf } = standIn();
    const back: DraftRolePacket = structuredClone(await draftOf(kept));
    back.requirements.eligibility.push({ key: "rda_license", type: "license", question: DA_RDA_QUESTION, expectation: {}, rationale: "Some duties need it.", knockout: true });
    fake.scriptNext("intake.compile", back);
    expect((await runIntakeCase(call, kept, true)).failures).toEqual([`the RDA licence question the owner left unticked is on the form: "${DA_RDA_QUESTION}"`]);
  });

  it("asks nothing for a case set from its answers that also checks a turn, and says why it fails", async () => {
    const { call, tasks } = standIn();
    const out = await runIntakeCase(call, { ...byId("dental_assistant_quick_start_deal_breaker_counted_openly"), expectTurn: () => [] }, true);
    expect(out.failures).toEqual(["a case with its answers set has no turn of the conversation to check"]);
    expect(tasks()).toEqual([]);
  });

  // Every compiled case fails on a skill named the same as one of its must-haves, though its own checks never look at
  // skills, and its entry in the result file keeps the draft's skills by name (review of the fix for the second review's
  // #14). No stand-in draft has such a skill, so only a scripted one can tell.
  it("fails a draft with a skill named the same as one of its must-haves, and the case's entry keeps its skills by name", async () => {
    const counted = byId("dental_assistant_quick_start_deal_breaker_counted_openly");
    const { fake, call, draftOf } = standIn();
    const twin: DraftRolePacket = structuredClone(await draftOf(counted));
    expect(twin.requirements.mustHaves[0]?.text).toBe("Four-handed dentistry");
    twin.competencies.push(skill("FOUR-HANDED DENTISTRY"));
    fake.scriptNext("intake.compile", twin);
    const entry = await intakeCaseResult(call, counted, true);
    expect(entry.id).toBe(counted.id);
    expect(entry.pass).toBe(false);
    expect(entry.failures).toEqual(['the skill "FOUR-HANDED DENTISTRY" (Shown in recent work.) repeats the must-have "Four-handed dentistry"']);
    expect(entry.notes).toHaveLength(1);
    expect(entry.notes?.[0]).toMatch(/^must-haves: "Four-handed dentistry", [^;]*; skills: [^;]*"FOUR-HANDED DENTISTRY"/);
    // the stand-in's own draft passes, and keeps its note
    const own = await intakeCaseResult(call, counted, true);
    expect(own.pass).toBe(true);
    expect(own.failures).toEqual([]);
    expect(own.notes?.[0]).toMatch(/^must-haves: "Four-handed dentistry", /);
  });

  it("fails the Dental Office Manager's draft that keeps the playbook's 'Team leadership' beside that must-have", async () => {
    const om = byId("dental_office_manager_just_draft_it");
    const { fake, call, draftOf, tasks } = standIn();
    const kept: DraftRolePacket = structuredClone(await draftOf(om));
    expect(kept.requirements.mustHaves.map((m) => m.text)).toContain("Team leadership");
    kept.competencies.unshift(skill("Team leadership", "Hires, trains, holds accountable, keeps morale."));
    fake.scriptNext("intake.compile", kept);
    const entry = await intakeCaseResult(call, om, true);
    expect(tasks()).toEqual(["intake.turn", "intake.compile"]);
    expect(entry.pass).toBe(false);
    expect(entry.failures).toEqual(['the skill "Team leadership" (Hires, trains, holds accountable, keeps morale.) repeats the must-have "Team leadership"']);
    expect(entry.notes?.[0]).toMatch(/; skills: "Team leadership", /);
  });
});
