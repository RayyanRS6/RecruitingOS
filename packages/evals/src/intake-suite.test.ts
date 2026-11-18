import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, type IntakeContext } from "@ros/ai";
import { finalizePacket, registerFakeHandlers } from "@ros/agents";
import type { DraftRolePacket, IntakeFacts, RolePacket } from "@ros/contracts";
import { DA_DAYS_QUESTION, DA_RDA_QUESTION, DA_XRAY_CPR_QUESTION, EMPTY_FACTS, RDH_FACTS, REPLACEMENT_WORDS, draftFailures, draftSkillsNote, intakeGolden, quickStartFormFailures, reasonInDescription, ruleOutMustHaves, saysPracticeGrows, skillsRepeatingMustHaves, type IntakeCase } from "./suites";

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
  return {
    company: { name: "Eval Co", vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
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
    expect(quickStart.map((c) => c.id)).toEqual(["dental_assistant_quick_start_deal_breaker_counted_openly", "dental_assistant_quick_start_deal_breaker_kept_private", "dental_assistant_quick_start_rda_question_unticked", "dental_assistant_quick_start_deal_breaker_no_offered_question"]);
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
    expect(seeded.length).toBe(5);
    for (const c of seeded) {
      const { draft, finish } = await ofCase(c);
      expect(c.expectDraft?.(draft) ?? [], c.id).toEqual([]);
      expect(draftFailures(c, finish()), c.id).toEqual([]);
    }
    // the stand-in writes exactly what v6 asks on the quick start: the x-ray and CPR/BLS question as the owner chose it,
    // the RDA question only when chosen, one question for a deal-breaker counted openly that none of them asks, and each
    // holding a "no"
    const [counted, kept, unticked, noneAsks] = await Promise.all(quickStart.map(ofCase));
    expect(counted?.draft.requirements.eligibility.map((e) => [e.key, e.knockout])).toEqual([["xray_bls", true], ["schedule", true], ["rda_license", true]]);
    expect(counted?.draft.requirements.eligibility[0]?.question).toBe(DA_XRAY_CPR_QUESTION);
    expect(kept?.draft.requirements.eligibility.map((e) => e.key)).toEqual(["xray_bls", "schedule"]);
    expect(unticked?.draft.requirements.eligibility.map((e) => e.key)).toEqual(["xray_bls", "schedule"]);
    expect(noneAsks?.draft.requirements.eligibility.map((e) => [e.key, e.type, e.knockout])).toEqual([["xray_bls", "certification", true], ["schedule", "schedule_availability", true], ["infection_control_certificate", "certification", true]]);
  });

  it("fails a draft that breaks v6's lines on the form, though the server would make every question hold", async () => {
    const counted = byId("dental_assistant_quick_start_deal_breaker_counted_openly");
    const { draft, finish } = await ofCase(counted);
    const holdsNobody: DraftRolePacket = structuredClone(draft);
    holdsNobody.requirements.eligibility[0]!.knockout = false;
    expect(counted.expectDraft?.(holdsNobody)).toEqual(['the AI wrote questions on the form whose "no" holds nobody: xray_bls']);
    // finished, the question holds (finalizeDraft's rule), so only the check on the model's own draft can fail
    expect(counted.expectPacket?.(finish(holdsNobody))).toEqual([]);
    // the owner's x-ray and CPR/BLS question cut to either half fails; written in two questions, it passes (review of the
    // intake evals fix, 13 Nov 2026)
    const withRules = (...rules: DraftRolePacket["requirements"]["eligibility"]): DraftRolePacket => {
      const d: DraftRolePacket = structuredClone(draft);
      d.requirements.eligibility = [...rules, ...d.requirements.eligibility.filter((e) => e.key !== "xray_bls")];
      return d;
    };
    expect(counted.expectPacket?.(finish(withRules(rule("bls", "certification", "Do you hold current CPR/BLS certification?"))))).toEqual([`a question the owner chose is on the form without the x-ray certification: "${DA_XRAY_CPR_QUESTION}"`]);
    expect(counted.expectPacket?.(finish(withRules(rule("xray", "certification", "Do you hold a current radiation safety / x-ray certification?"))))).toEqual([`a question the owner chose is on the form without CPR/BLS: "${DA_XRAY_CPR_QUESTION}"`]);
    expect(counted.expectPacket?.(finish(withRules(rule("xray", "certification", "Do you hold a current radiation safety / x-ray certification?"), rule("bls", "certification", "Do you hold current CPR/BLS certification?"))))).toEqual([]);
    // the half is read from the question candidates answer, never from its key or what it expects
    expect(quickStartFormFailures({ requirements: { eligibility: [{ ...rule("xray_bls", "certification", "Do you hold current CPR/BLS certification?"), expectation: { certification: "x-ray, BLS" } }, rule("schedule", "schedule_availability", DA_DAYS_QUESTION)] } }, { rda: false })).toEqual([`a question the owner chose is on the form without the x-ray certification: "${DA_XRAY_CPR_QUESTION}"`]);
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

  // Review of the intake evals fix, 13 Nov 2026: v6's "Either way, add one rule for each deal-breaker the owner counted
  // openly", which case (a) cannot fail, since the owner chose the RDA question there.
  it("fails a draft with no question, or two, for a deal-breaker counted openly that none of the chosen questions asks", async () => {
    const none = byId("dental_assistant_quick_start_deal_breaker_no_offered_question");
    expect(none.facts).toMatchObject({ mustHaves: ["Four-handed dentistry", "Digital radiography", "Infection control certificate"], dealBreakers: ["No infection control certificate"], eligibilityNotes: [DA_XRAY_CPR_QUESTION, DA_DAYS_QUESTION], formQuestionsChosen: true });
    expect(none.facts?.suggestions).toEqual([{ field: "eligibility", text: DA_RDA_QUESTION, origin: "playbook" }]);
    const { draft, finish } = await ofCase(none);
    // exactly the owner's two questions, as the model obeying "exactly the owner's chosen questions" alone would write it
    const chosenOnly: DraftRolePacket = structuredClone(draft);
    chosenOnly.requirements.eligibility = chosenOnly.requirements.eligibility.filter((e) => !/infection/i.test(e.question));
    expect(none.expectPacket?.(finish(chosenOnly))).toEqual(["no question on the form for the deal-breaker counted openly (an infection control certificate)"]);
    const twice: DraftRolePacket = structuredClone(draft);
    twice.requirements.eligibility.push(rule("infection_course", "certification", "Have you completed the 8-hour infection control course?"));
    expect(none.expectPacket?.(finish(twice))).toEqual(["the deal-breaker counted openly is asked 2 times on the form (an infection control certificate)"]);
    // the RDA question the owner left unticked, and the must-have left out, fail too
    const more: DraftRolePacket = structuredClone(draft);
    more.requirements.eligibility.push(rule("rda_license", "license", DA_RDA_QUESTION));
    more.requirements.mustHaves = more.requirements.mustHaves.filter((m) => !/infection/i.test(m.text));
    expect(none.expectPacket?.(finish(more))).toEqual(["no must-have for the deal-breaker counted openly (an infection control certificate)", `the RDA licence question the owner left unticked is on the form: "${DA_RDA_QUESTION}"`]);
    // the question in the model's own words counts, holding a "no" as the model wrote it
    const own: DraftRolePacket = structuredClone(chosenOnly);
    own.requirements.eligibility.push(rule("infection_control", "certification", "Have you completed California's 8-hour infection control course?", false));
    expect(none.expectPacket?.(finish(own))).toEqual([]);
    expect(none.expectDraft?.(own)).toEqual(['the AI wrote questions on the form whose "no" holds nobody: infection_control']);
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
    const said = (publicJobDescription: string, says: RegExp | ((sentence: string) => boolean)) => reasonInDescription({ description: { publicJobDescription } }, says);
    expect(said("Join a caring team. We are replacing our hygienist, who moved away. You will see patients daily.", REPLACEMENT_WORDS)).toEqual(['why the owner is hiring is written into the public description: "We are replacing our hygienist, who moved away."']);
    expect(said("Our hygienist moved, so the chair is open.", REPLACEMENT_WORDS)).toHaveLength(1);
    expect(said("Join a caring team that keeps the schedule moving.", REPLACEMENT_WORDS)).toEqual([]);
    const practice = [
      "Harbor Dental is a growing practice in Irvine.",
      "We're growing and need another assistant.",
      "Our team continues to grow.",
      "Our Irvine office has grown.",
      "This role supports our growth.",
      // any plain way of saying it (review of the intake evals fix, 13 Nov 2026), the company's own name too
      "Harbor Dental is a busy, growing family practice in Irvine.",
      "Due to growth, we are adding a dental assistant.",
      "We have a growing patient base.",
      "Join a growing Irvine practice.",
      "Our practice has seen steady patient growth.",
      "Eval Co is growing and needs another dental assistant.",
      "Our growing Irvine practice needs another assistant.",
      "We are a growing, patient-focused practice.",
      "We've grown quickly over the last year.",
      "We're hiring to keep up with growth.",
      "Business is growing.",
      "Harbor Dental has grown to three doctors.",
      "Our schedule is growing busier every month.",
      "It's time to grow our team.",
      "We've grown into a three-doctor practice.",
      // the candidate's own growth beside it does not hide it
      "Join our growing practice, with room to grow.",
    ];
    for (const growth of practice) expect(said(growth, saysPracticeGrows), growth).toHaveLength(1);
    const own = [
      "You will have room to grow your skills.",
      "We support your career growth.",
      "Join a team where you can grow.",
      "Grow with us.",
      "Opportunities for professional growth.",
      "We invest in your growth.",
      "A place to learn and grow.",
      "Paid continuing education and growth opportunities.",
      "We hire people with a growth mindset.",
      "Watch your skills grow with every patient.",
      "A place where you can learn, grow and thrive.",
      "Training, growth and advancement are part of the job.",
    ];
    for (const sentence of own) expect(said(sentence, saysPracticeGrows), sentence).toEqual([]);
    // the whole description is read sentence by sentence, and the one that says it is named
    expect(said("You will have room to grow. Due to growth, we are adding a second assistant.", saysPracticeGrows)).toEqual(['why the owner is hiring is written into the public description: "Due to growth, we are adding a second assistant."']);
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
      ["dental_assistant_quick_start_deal_breaker_no_offered_question", "same name"],
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
  });
});
