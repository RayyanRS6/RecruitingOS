import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, packetRevisePrompt, type IntakeContext } from "@ros/ai";
import { REVISABLE_FOR_ROLE, editableView, finalizePacket, mergeRevision, registerFakeHandlers } from "@ros/agents";
import type { PacketRevision, RolePacket } from "@ros/contracts";
import { findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import { RDH_FACTS, mustHaveAskedAsSkill, reviseCases, type ReviseCase } from "./suites";

/**
 * Change by chat (packet.revise v2) asked for a skill that is the same as a must-have (second review of the live-test
 * fixes, 12 Nov 2026, #12): the case passes on the local stand-in, so `pnpm eval` stays green, and fails on a proposal
 * that adds such a skill, so the run on the real models can fail where only the prompt's line keeps it out.
 */
const fake = new FakeProvider();
registerFakeHandlers(fake);
const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };

/** The golden hygienist's job as the runner writes it (`goldenPacket`), here on the stand-in and with no market figure. */
async function golden(): Promise<RolePacket> {
  const playbook = findPlaybook("dental");
  const ctx: IntakeContext = {
    company: { name: "Eval Co", vertical: "dental", sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
    playbook,
    playbookRole: playbook ? matchPlaybookRole(playbook, RDH_FACTS.title ?? "") : null,
    benchmark: null,
    facts: RDH_FACTS,
    messages: [{ role: "owner", content: "I need a dental hygienist in Irvine.", at: "2026-11-12T12:00:00.000Z" }],
    confirmedPay: { basis: "hourly", min: 45, max: 55, ceiling: 58 },
  };
  const r = await callPrompt(rt, intakeCompilePrompt, ctx, { companyId: null });
  if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a draft: ${r.result.kind}`);
  return finalizePacket(r.result.output, ctx, { sessionId: "eval", aiRunId: "r" });
}

const byId = (id: string): ReviseCase => {
  const c = reviseCases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

describe("packet.revise: a skill that is the same as a must-have", () => {
  const c = byId("skill_named_as_a_must_have");

  it("asks for one of the golden job's must-haves, in its words, as an essential skill, and passes the stand-in's answer", async () => {
    const base = await golden();
    expect(c.target).toBe("role");
    expect(mustHaveAskedAsSkill(base)?.text).toBe("Periodontal (perio) charting and therapy experience");
    const message = typeof c.message === "string" ? c.message : c.message(base);
    expect(message).toBe("Add Periodontal (perio) charting and therapy experience as an essential skill");
    const r = await callPrompt(rt, packetRevisePrompt, { companyName: "Eval Co", target: "role", roleStatus: "open", packet: editableView(base, REVISABLE_FOR_ROLE), allowed: [...REVISABLE_FOR_ROLE], declined: [], message }, { companyId: null });
    if (r.result.kind !== "ok") throw new Error(`the stand-in gave no answer: ${r.result.kind}`);
    const revision = r.result.output;
    expect(revision.changes).toEqual({});
    expect(revision.notChanged).toEqual([{ request: message, reason: 'The job already has "Periodontal (perio) charting and therapy experience" as a must-have, which counts the most.' }]);
    expect(c.expect({ revision, merged: mergeRevision(base, revision, "role"), base })).toEqual([]);
  });

  it("fails a proposal that adds it, in its words or in others, renames a skill to it, or leaves the request unanswered", async () => {
    const base = await golden();
    const asked = mustHaveAskedAsSkill(base);
    if (!asked) throw new Error("the golden job has no must-have");
    const judge = (revision: PacketRevision) => c.expect({ revision, merged: mergeRevision(base, revision, "role"), base });
    const adding = (name: string): PacketRevision => ({
      summary: `I added an essential skill: ${name}.`,
      changes: { competencies: [...base.competencies, { key: "perio_skill", name, definition: "Charts and treats periodontal disease.", weight: 5, importance: "essential", evaluatedIn: "both", indicators: ["Explains a perio chart"] }] },
      notChanged: [],
    });
    expect(judge(adding(asked.text))).toEqual([
      `the skill "${asked.text}" (Charts and treats periodontal disease.) repeats the must-have "${asked.text}"`,
      "changed competencies although the job already has it as a must-have",
      "did not say that the job already has it as a must-have",
    ]);
    expect(judge(adding("Periodontal therapy"))[0]).toBe(`the skill "Periodontal therapy" (Charts and treats periodontal disease.) repeats the must-have "${asked.text}"`);
    const renamed: PacketRevision = { summary: "I renamed a skill.", changes: { competencies: base.competencies.map((s, i) => (i === 0 ? { ...s, name: asked.text } : s)) }, notChanged: [] };
    expect(judge(renamed)[0]).toMatch(new RegExp(`^the skill "${asked.text.replace(/[()]/g, "\\$&")}" \\(.*\\) repeats the must-have`));
    // the golden job's own skills are never judged: only one the change adds or renames
    expect(judge({ summary: "I have not changed anything.", changes: {}, notChanged: [{ request: "Add it as a skill", reason: "The job already has it as a must-have, which counts the most." }] })).toEqual([]);
    expect(judge({ summary: "Nothing needs to change.", changes: {}, notChanged: [] })).toEqual(["did not say that the job already has it as a must-have"]);
    // taking the must-have out to make it a skill is a change of its own, not this request
    const moved: PacketRevision = { summary: "I made it a skill.", changes: { requirements: { ...base.requirements, mustHaves: base.requirements.mustHaves.filter((m) => m.key !== asked.key) } }, notChanged: [] };
    expect(judge(moved)).toEqual([`the must-have "${asked.text}" is no longer on the job`, "changed requirements although the job already has it as a must-have", "did not say that the job already has it as a must-have"]);
  });
});
