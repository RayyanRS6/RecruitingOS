import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, type IntakeContext } from "@ros/ai";
import { finalizePacket, registerFakeHandlers } from "@ros/agents";
import type { DraftRolePacket, IntakeFacts, RolePacket } from "@ros/contracts";
import { findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import { DA_DAYS_QUESTION, DA_RDA_QUESTION, DA_XRAY_CPR_QUESTION, EMPTY_FACTS, GROWTH_WORDS, RDH_FACTS, REPLACEMENT_WORDS, draftFailures, draftSkillsNote, intakeGolden, reasonInDescription, ruleOutMustHaves, skillsRepeatingMustHaves, type IntakeCase } from "./suites";

/**
 * The job builder's draft where intake.compile v6 alone keeps it right (review of the live-test fixes, 12 Nov 2026,
 * #21, #23, #44 and #47): the cases pass on the local stand-in, so `pnpm eval` stays green, and their checks fail on a
 * draft that breaks the prompt's lines, so the run on the real models can fail where the fixes rest on the prompt.
 */
const fake = new FakeProvider();
registerFakeHandlers(fake);
const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };

const byId = (id: string): IntakeCase => {
  const c = intakeGolden.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

/** The draft's input as the runner gives it for answers already set (no market figure here: the stand-in needs none). */
const contextOf = (vertical: string, facts: IntakeFacts, ownerMessages: string[]): IntakeContext => {
  const playbook = findPlaybook(vertical);
  return {
    company: { name: "Eval Co", vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
    playbook,
    playbookRole: playbook && facts.title ? matchPlaybookRole(playbook, facts.title) : null,
    benchmark: null,
    facts,
    messages: ownerMessages.map((content) => ({ role: "owner" as const, content, at: "2026-11-12T12:00:00.000Z", kind: "text" as const })),
    confirmedPay: facts.compensationBasis && facts.compensationMin !== undefined && facts.compensationMax !== undefined ? { basis: facts.compensationBasis, min: facts.compensationMin, max: facts.compensationMax } : null,
  };
};

/** The stand-in's draft from these answers: as it wrote it, and as the server finishes it. */
const written = async (vertical: string, facts: IntakeFacts, ownerMessages: string[] = ["Just draft it."]) => {
  const ctx = contextOf(vertical, facts, ownerMessages);
  const r = await callPrompt(rt, intakeCompilePrompt, ctx, { companyId: null });
  if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a draft: ${r.result.kind}`);
  const draft = r.result.output;
  return { draft, finish: (d: DraftRolePacket = draft): RolePacket => finalizePacket(d, ctx, { sessionId: "eval", aiRunId: "r" }) };
};
const ofCase = (c: IntakeCase) => written(c.vertical, { ...EMPTY_FACTS, ...c.facts }, c.ownerMessages);
const rule = (key: string, type: DraftRolePacket["requirements"]["eligibility"][number]["type"], question: string, knockout = true): DraftRolePacket["requirements"]["eligibility"][number] => ({ key, type, question, expectation: {}, rationale: "Asked of everyone.", knockout });
const mustHave = (text: string): RolePacket["requirements"]["mustHaves"][number] => ({ key: text.toLowerCase().replace(/[^a-z]+/g, "_"), text, rationale: "Chosen by the owner", evidencedBy: ["resume", "screen"] });

describe("intake.golden: the quick start's answers, compiled as they are stored", () => {
  const quickStart = intakeGolden.filter((c) => c.facts?.formQuestionsChosen);

  it("offers the Dental Assistant's three questions in the playbook's words, each one chosen or left unticked", () => {
    expect(new Set([DA_RDA_QUESTION, DA_XRAY_CPR_QUESTION, DA_DAYS_QUESTION]).size).toBe(3);
    expect(DA_RDA_QUESTION).toContain("(RDA)");
    expect(DA_XRAY_CPR_QUESTION).toContain("x-ray");
    expect(DA_DAYS_QUESTION).toContain("available");
    expect(quickStart.map((c) => c.id)).toEqual(["dental_assistant_quick_start_deal_breaker_counted_openly", "dental_assistant_quick_start_deal_breaker_kept_private", "dental_assistant_quick_start_rda_question_unticked"]);
    for (const c of quickStart) {
      const offered = [...(c.facts?.eligibilityNotes ?? []), ...(c.facts?.suggestions ?? []).filter((s) => s.field === "eligibility").map((s) => s.text)];
      expect(offered.sort(), c.id).toEqual([DA_RDA_QUESTION, DA_XRAY_CPR_QUESTION, DA_DAYS_QUESTION].sort());
      // written straight from the answers, with the knockout checked on the draft as the model wrote it
      expect(c.expectTurn, c.id).toBeUndefined();
      expect(c.expectDraft, c.id).toBeDefined();
    }
  });

  it("passes every case set from its answers on the local stand-in, as written and as finished", async () => {
    const seeded = intakeGolden.filter((c) => c.facts);
    expect(seeded.length).toBe(4);
    for (const c of seeded) {
      const { draft, finish } = await ofCase(c);
      expect(c.expectDraft?.(draft) ?? [], c.id).toEqual([]);
      expect(draftFailures(c, finish()), c.id).toEqual([]);
    }
    // the stand-in writes exactly what v6 asks on the quick start: the RDA question only when chosen, each holding a "no"
    const [counted, kept, unticked] = await Promise.all(quickStart.map(ofCase));
    expect(counted?.draft.requirements.eligibility.map((e) => [e.key, e.knockout])).toEqual([["bls", true], ["schedule", true], ["rda_license", true]]);
    expect(kept?.draft.requirements.eligibility.map((e) => e.key)).toEqual(["bls", "schedule"]);
    expect(unticked?.draft.requirements.eligibility.map((e) => e.key)).toEqual(["bls", "schedule"]);
  });

  it("fails a draft that breaks v6's lines on the form, though the server would make every question hold", async () => {
    const counted = byId("dental_assistant_quick_start_deal_breaker_counted_openly");
    const { draft, finish } = await ofCase(counted);
    const holdsNobody: DraftRolePacket = structuredClone(draft);
    holdsNobody.requirements.eligibility[0]!.knockout = false;
    expect(counted.expectDraft?.(holdsNobody)).toEqual(['the AI wrote questions on the form whose "no" holds nobody: bls']);
    // finished, the question holds (finalizeDraft's rule), so only the check on the model's own draft can fail
    expect(counted.expectPacket?.(finish(holdsNobody))).toEqual([]);
    const more: DraftRolePacket = structuredClone(draft);
    more.requirements.eligibility.push(rule("start", "start_date", "Can you start within 30 days?"), rule("rda_again", "license", "Do you currently hold an active California RDA license?"));
    expect(counted.expectPacket?.(finish(more))).toEqual(["the RDA licence is asked 2 times on the form", 'questions on the form the owner did not choose: "Can you start within 30 days?"']);
    const lost: DraftRolePacket = structuredClone(draft);
    lost.requirements.eligibility = lost.requirements.eligibility.filter((e) => e.key === "schedule");
    lost.requirements.mustHaves = lost.requirements.mustHaves.filter((m) => !/RDA/.test(m.text));
    expect(counted.expectPacket?.(finish(lost))).toEqual(["no must-have for the deal-breaker counted openly (an active California RDA license)", "no RDA licence question on the form", `a question the owner chose is not on the form: "${DA_XRAY_CPR_QUESTION}"`]);
    const negative: DraftRolePacket = structuredClone(draft);
    negative.requirements.mustHaves = negative.requirements.mustHaves.map((m) => (/RDA/.test(m.text) ? { ...m, text: "No active California RDA license" } : m));
    expect(counted.expectPacket?.(finish(negative))).toEqual(["must-haves written as what rules someone out: No active California RDA license"]);
  });

  it("fails a draft that uses a deal-breaker kept private, or a question left unticked", async () => {
    const kept = byId("dental_assistant_quick_start_deal_breaker_kept_private");
    const one = await ofCase(kept);
    const used: DraftRolePacket = structuredClone(one.draft);
    used.requirements.mustHaves.push(mustHave("Active California RDA license"));
    used.requirements.eligibility.push(rule("ca_rda_license", "license", "Do you currently hold an active California RDA license?"));
    expect(kept.expectPacket?.(one.finish(used))).toEqual(["a must-have from the deal-breaker kept private: Active California RDA license", 'the RDA licence question the owner left unticked is on the form: "Do you currently hold an active California RDA license?"']);
    const unticked = byId("dental_assistant_quick_start_rda_question_unticked");
    const two = await ofCase(unticked);
    const onForm: DraftRolePacket = structuredClone(two.draft);
    onForm.requirements.eligibility = [...onForm.requirements.eligibility.filter((e) => e.key !== "schedule"), rule("rda_license", "license", DA_RDA_QUESTION)];
    onForm.requirements.mustHaves = onForm.requirements.mustHaves.filter((m) => !/RDA/.test(m.text));
    expect(unticked.expectPacket?.(two.finish(onForm))).toEqual([
      'the owner\'s must-have "Active California RDA license" is not on the draft',
      `the RDA licence question the owner left unticked is on the form: "${DA_RDA_QUESTION}"`,
      `a question the owner chose is not on the form: "${DA_DAYS_QUESTION}"`,
    ]);
  });
});

describe("intake.golden: must-haves in words that rule someone out, written twice", () => {
  const twice = byId("dental_assistant_rule_out_words_written_twice");

  it("is set from the answers as typed, unlike the prompt's own example, and written twice", () => {
    expect(twice.compiles).toBe(2);
    expect(twice.facts?.mustHaves).toEqual(["Four-handed dentistry", "Digital radiography", "No x-ray permit", "Without a current BLS certification", "Not certified in coronal polishing"]);
    expect(intakeCompilePrompt.system(contextOf("dental", { ...EMPTY_FACTS, ...twice.facts }, twice.ownerMessages)).map((b) => b.text).join("\n")).not.toMatch(/No x-ray permit|Without a current BLS|Not certified in coronal/i);
  });

  it("fails a draft that keeps such words, in any of their shapes, or leaves one of the must-haves out", async () => {
    const { draft, finish } = await ofCase(twice);
    expect(draft.requirements.mustHaves.map((m) => m.text)).toEqual(["Four-handed dentistry", "Digital radiography", "X-ray permit", "Current BLS certification", "Certified in coronal polishing"]);
    const kept: DraftRolePacket = structuredClone(draft);
    kept.requirements.mustHaves = [mustHave("Four-handed dentistry"), mustHave("No x-ray permit"), mustHave("Without a current BLS card"), mustHave("Lacks coronal polishing certification")];
    expect(twice.expectPacket?.(finish(kept))).toEqual(["must-haves written as what rules someone out: No x-ray permit; Without a current BLS card; Lacks coronal polishing certification"]);
    const dropped: DraftRolePacket = structuredClone(draft);
    dropped.requirements.mustHaves = dropped.requirements.mustHaves.filter((m) => !/coronal|BLS/.test(m.text));
    expect(twice.expectPacket?.(finish(dropped))).toEqual(["the must-have about the BLS certification is not on the draft", "the must-have about coronal polishing is not on the draft"]);
    expect(ruleOutMustHaves({ requirements: { ...draft.requirements, mustHaves: [mustHave("Cannot work Saturdays"), mustHave("Able to work Saturdays")] } })).toEqual(["must-haves written as what rules someone out: Cannot work Saturdays"]);
  });
});

describe("intake.golden: why the owner is hiring, and skills that repeat a must-have", () => {
  it("finds the reason in the public description, and growth only as the practice's own", () => {
    const said = (publicJobDescription: string, words: RegExp) => reasonInDescription({ description: { publicJobDescription } }, words);
    expect(said("Join a caring team. We are replacing our hygienist, who moved away. You will see patients daily.", REPLACEMENT_WORDS)).toEqual(['why the owner is hiring is written into the public description: "We are replacing our hygienist, who moved away."']);
    expect(said("Our hygienist moved, so the chair is open.", REPLACEMENT_WORDS)).toHaveLength(1);
    expect(said("Join a caring team that keeps the schedule moving.", REPLACEMENT_WORDS)).toEqual([]);
    for (const growth of ["Harbor Dental is a growing practice in Irvine.", "We're growing and need another assistant.", "Our team continues to grow.", "Our Irvine office has grown.", "This role supports our growth."]) expect(said(growth, GROWTH_WORDS), growth).toHaveLength(1);
    for (const own of ["You will have room to grow your skills.", "We support your career growth.", "Join a team where you can grow.", "Grow with us."]) expect(said(own, GROWTH_WORDS), own).toEqual([]);
  });

  it("finds a skill that repeats a must-have under its name or in its definition, never one that names it in passing", () => {
    const repeats = (mustHaves: string[], ...skills: Array<[string, string]>) => skillsRepeatingMustHaves({ requirements: { mustHaves: mustHaves.map(mustHave), niceToHaves: [], eligibility: [] }, competencies: skills.map(([name, definition]) => ({ key: name.toLowerCase().replace(/[^a-z]+/g, "_"), name, definition, weight: 4, evaluatedIn: "both", indicators: [] })) }).length;
    const da = ["Four-handed dentistry", "Digital radiography", "Active California RDA license"];
    for (const twin of [["Digital Radiography.", "Takes x-rays."], ["Radiography", "Takes x-rays."], ["Radiographic imaging", "Clear images."], ["X-ray technique", "Positions the sensor."], ["Imaging", "Takes and processes digital radiographs."], ["Four-handed assisting", "Passes instruments."]] as Array<[string, string]>) expect(repeats(da, twin), twin[0]).toBe(1);
    // the playbook's own skills overlap other must-haves by design, and stay
    const playbook = findPlaybook("dental")!.roles.find((r) => r.key === "da")!.competencies.map((c): [string, string] => [c.name, c.definition]);
    expect(repeats(da, ...playbook)).toBe(0);
    expect(repeats(da, ["Digital charting", "Charts in the practice software."])).toBe(0);
    const rdh = ["Active CA RDH license", "Perio experience"];
    const quality = findPlaybook("dental")!.roles.find((r) => r.key === "rdh")!.competencies.find((c) => c.key === "clinical_quality")!;
    expect(quality.definition).toContain("perio assessment");
    expect(repeats(rdh, [quality.name, quality.definition])).toBe(0);
    expect(repeats(rdh, ["Periodontal care", "Gentle scaling and root planing."])).toBe(1);
  });

  it("fails dental_rdh_irvine and the Dental Assistant case on either, and passes the stand-in's drafts of them", async () => {
    // the skills are judged in other words too on these two (`skillRepeats`), through the check every compiled case runs
    const rdh = byId("dental_rdh_irvine");
    expect(rdh.skillRepeats).toBe("any name");
    const one = await written("dental", RDH_FACTS, ["I need a dental hygienist in Irvine."]);
    expect(draftFailures(rdh, one.finish())).toEqual([]);
    const told: DraftRolePacket = structuredClone(one.draft);
    told.description.publicJobDescription += " We are hiring because our hygienist moved.";
    told.competencies.push({ key: "perio_therapy", name: "Periodontal therapy", definition: "Scaling and root planing.", weight: 4, evaluatedIn: "both", indicators: ["Describes a full-mouth debridement"] });
    told.interviews.plan[0]!.competencyKeys.push("perio_therapy");
    expect(draftFailures(rdh, one.finish(told))).toEqual(['why the owner is hiring is written into the public description: "We are hiring because our hygienist moved."', 'the skill "Periodontal therapy" (Scaling and root planing.) repeats the must-have "Periodontal (perio) charting and therapy experience"']);
    const assistant = byId("dental_assistant_license_in_negative_words");
    expect(assistant.skillRepeats).toBe("any name");
    const two = await written("dental", { ...EMPTY_FACTS, ...STAND_IN_ANSWERS.dental_assistant_license_in_negative_words });
    expect(two.draft.requirements.eligibility.find((e) => e.key === "bls")?.knockout).toBe(false);
    expect(draftFailures(assistant, two.finish())).toEqual([]);
    const grown: DraftRolePacket = structuredClone(two.draft);
    grown.description.publicJobDescription += " We're a growing practice.";
    grown.competencies.push({ key: "imaging", name: "Radiographic imaging", definition: "Clear, diagnostic images.", weight: 4, evaluatedIn: "both", indicators: ["Explains a full-mouth series"] });
    expect(draftFailures(assistant, two.finish(grown))).toEqual(['why the owner is hiring is written into the public description: "We\'re a growing practice."', 'the skill "Radiographic imaging" (Clear, diagnostic images.) repeats the must-have "digital radiography"']);
  });
});

/**
 * The answers the intake.turn stand-in would leave for each compiled case that sets none (its messages, read as the job
 * builder reads them), so its draft can be written here without a turn.
 */
const STAND_IN_ANSWERS: Record<string, Partial<IntakeFacts>> = {
  dental_rdh_irvine: RDH_FACTS,
  dental_front_office_just_draft_it: { title: "Front Office Coordinator", locationText: "Tustin, CA", employmentType: "full_time", compensationBasis: "hourly", compensationMin: 22, compensationMax: 26 },
  dental_assistant_license_in_negative_words: { title: "Dental Assistant", locationText: "Irvine, CA", employmentType: "full_time", reason: "growth", compensationBasis: "hourly", compensationMin: 24, compensationMax: 28, decisionMaker: "me", interviewers: ["me"], mustHaves: ["four-handed dentistry", "digital radiography", "no active California RDA license"] },
  dental_office_manager_just_draft_it: { title: "Dental Office Manager", locationText: "Irvine, CA", employmentType: "full_time", reason: "growth", compensationBasis: "hourly", compensationMin: 34, compensationMax: 40, decisionMaker: "me" },
};
const draftOf = (c: IntakeCase) => (c.facts ? ofCase(c) : written(c.vertical, { ...EMPTY_FACTS, ...STAND_IN_ANSWERS[c.id] }, c.ownerMessages));
const skill = (name: string, definition = "Shown in recent work.") => ({ key: name.toLowerCase().replace(/[^a-z]+/g, "_"), name, definition, weight: 5, evaluatedIn: "both" as const, indicators: ["An example from recent work"] });

describe("intake.golden: every draft and a skill named the same as a must-have (second review of the live-test fixes, #14, #24, #15)", () => {
  const compiled = intakeGolden.filter((c) => c.expectPacket || c.expectDraft);

  it("holds every compiled case to it, and the two cases of the first review to one in other words too", async () => {
    expect(compiled.map((c) => [c.id, c.skillRepeats ?? "same name"])).toEqual([
      ["dental_rdh_irvine", "any name"],
      ["dental_front_office_just_draft_it", "same name"],
      ["dental_assistant_license_in_negative_words", "any name"],
      ["dental_assistant_rule_out_words_written_twice", "same name"],
      ["dental_assistant_quick_start_deal_breaker_counted_openly", "same name"],
      ["dental_assistant_quick_start_deal_breaker_kept_private", "same name"],
      ["dental_assistant_quick_start_rda_question_unticked", "same name"],
      ["dental_office_manager_just_draft_it", "same name"],
    ]);
    expect(compiled.filter((c) => !c.facts).map((c) => c.id).sort()).toEqual(Object.keys(STAND_IN_ANSWERS).sort());
    for (const c of compiled) {
      const { finish, draft } = await draftOf(c);
      // the stand-in's draft passes, and writes no skill named like a must-have
      expect(draftFailures(c, finish()), c.id).toEqual([]);
      const first = draft.requirements.mustHaves[0]!;
      const twin: DraftRolePacket = structuredClone(draft);
      twin.competencies.push(skill(first.text.toUpperCase()));
      expect(draftFailures(c, finish(twin)), c.id).toContain(`the skill "${first.text.toUpperCase()}" (Shown in recent work.) repeats the must-have "${first.text}"`);
    }
  });

  it("drafts the Dental Office Manager without the playbook's 'Team leadership', and fails a draft that keeps it", async () => {
    const om = byId("dental_office_manager_just_draft_it");
    expect(om.ownerMessages).toEqual(["Dental office manager in Irvine, $34 to $40 an hour, full time. It's growth. I decide. Just draft it."]);
    expect(findPlaybook("dental")!.roles.find((r) => r.key === "office_manager")!.competencies.map((c) => c.name)).toContain("Team leadership");
    const { draft, finish } = await draftOf(om);
    expect(draft.requirements.mustHaves.map((m) => m.text)).toEqual(["Dental practice management experience", "Team leadership", "Insurance and AR management"]);
    expect(draft.competencies.map((c) => c.name)).toEqual(["Financial management", "Operations", "Patient experience", "Judgment and calm"]);
    expect(draftFailures(om, finish())).toEqual([]);
    const kept: DraftRolePacket = structuredClone(draft);
    kept.competencies.unshift(skill("Team leadership", "Hires, trains, holds accountable, keeps morale."));
    expect(draftFailures(om, finish(kept))).toEqual(['the skill "Team leadership" (Hires, trains, holds accountable, keeps morale.) repeats the must-have "Team leadership"']);
    // nor does its description say why the owner is hiring ("It's growth.")
    const grown: DraftRolePacket = structuredClone(draft);
    grown.description.publicJobDescription += " Our practice keeps growing.";
    expect(draftFailures(om, finish(grown))).toEqual(['why the owner is hiring is written into the public description: "Our practice keeps growing."']);
  });

  it("notes each draft's must-haves and skills by name, and the skills whose words are all in a must-have", async () => {
    const om = byId("dental_office_manager_just_draft_it");
    const { draft, finish } = await draftOf(om);
    expect(draftSkillsNote(finish())).toBe('must-haves: "Dental practice management experience", "Team leadership", "Insurance and AR management"; skills: "Financial management", "Operations", "Patient experience", "Judgment and calm"');
    // a skill renamed from "Team leadership" passes on its name, and shows in the note
    const renamed: DraftRolePacket = structuredClone(draft);
    renamed.competencies.unshift(skill("Leadership", "Hires, trains, holds accountable, keeps morale."), skill("People leadership"));
    expect(draftFailures(om, finish(renamed))).toEqual([]);
    expect(draftSkillsNote(finish(renamed))).toBe('must-haves: "Dental practice management experience", "Team leadership", "Insurance and AR management"; skills: "Leadership", "People leadership", "Financial management", "Operations", "Patient experience", "Judgment and calm"; skills whose words are all in a must-have: "Leadership" ("Team leadership")');
    const da = { requirements: { mustHaves: [mustHave("Digital radiography"), mustHave("Four-handed dentistry")], niceToHaves: [], eligibility: [] }, competencies: [skill("X-rays"), skill("Chairside skill"), skill("Digital radiography and intraoral scanning")] };
    expect(draftSkillsNote(da)).toBe('must-haves: "Digital radiography", "Four-handed dentistry"; skills: "X-rays", "Chairside skill", "Digital radiography and intraoral scanning"; skills whose words are all in a must-have: "X-rays" ("Digital radiography")');
    expect(draftSkillsNote({ requirements: { mustHaves: [], niceToHaves: [], eligibility: [] }, competencies: [] })).toBe("must-haves: none; skills: none");
  });

  it("reads the same name as the score does, case, accents and punctuation aside, when the case judges names alone", () => {
    const of = (...names: string[]) => skillsRepeatingMustHaves({ requirements: { mustHaves: [mustHave("Digital radiography")], niceToHaves: [], eligibility: [] }, competencies: names.map((n) => skill(n)) }, "same name");
    expect(of("Digital Radiography.", "digital  radiography")).toHaveLength(2);
    expect(of("Radiographic imaging", "Radiography", "Digital radiography and intraoral scanning")).toEqual([]);
    // in any words, the first review's reading, those repeat it too but the last
    expect(skillsRepeatingMustHaves({ requirements: { mustHaves: [mustHave("Digital radiography")], niceToHaves: [], eligibility: [] }, competencies: [skill("Radiographic imaging"), skill("Radiography")] })).toHaveLength(2);
    // that reading fails other roles' own playbook skills beside the qualifications a draft takes as must-haves, so those
    // drafts are judged by the name, and their note shows a skill renamed
    const role = (key: string) => findPlaybook("dental")!.roles.find((r) => r.key === key)!;
    const asDrafted = (key: string) => ({ requirements: { mustHaves: role(key).commonQualifications.slice(0, 3).map(mustHave), niceToHaves: [], eligibility: [] }, competencies: role(key).competencies.map((c) => skill(c.name, c.definition)) });
    expect(skillsRepeatingMustHaves(asDrafted("front_office"))).toEqual(['the skill "Scheduling and follow-through" (Keeps the schedule full and accurate; confirms and reactivates.) repeats the must-have "Multi-line phones and scheduling"']);
    expect(skillsRepeatingMustHaves(asDrafted("front_office"), "same name")).toEqual([]);
    expect(skillsRepeatingMustHaves(asDrafted("office_manager"))).toEqual(['the skill "Team leadership" (Hires, trains, holds accountable, keeps morale.) repeats the must-have "Team leadership"', 'the skill "Financial management" (Collections, AR, insurance, and daily numbers.) repeats the must-have "Dental practice management experience"']);
    expect(skillsRepeatingMustHaves(asDrafted("office_manager"), "same name")).toEqual(['the skill "Team leadership" (Hires, trains, holds accountable, keeps morale.) repeats the must-have "Team leadership"']);
  });
});
