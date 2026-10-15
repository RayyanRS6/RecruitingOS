import { describe, expect, it } from "vitest";
import { RolePacket, type Actor, type DraftRolePacket } from "@ros/contracts";
import { companyQuestionProblemWords, companyQuestionProblems, guardPacket, normalizeCriterion, questionCheck, screenCriterion, unresolvedFlags } from "./packet-guard";

/** A small valid packet; each test changes what it is about. */
function packet(over: (p: RolePacket) => void = () => {}): RolePacket {
  const p = RolePacket.parse({
    identity: { title: "Registered Dental Hygienist", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time" },
    business: { reason: "replacement", timeline: {} },
    compensation: { basis: "hourly", min: 45, max: 55, ceiling: 58, discloseRange: true },
    description: { publicJobDescription: "Brightline Dental is hiring a registered dental hygienist in Irvine to care for a loyal patient base, five days a week." },
    requirements: { mustHaves: [{ key: "license", text: "Active CA RDH license", rationale: "Required by law.", evidencedBy: ["resume"] }], niceToHaves: [], eligibility: [] },
    competencies: [1, 2, 3].map((i) => ({ key: `c${i}`, name: `Competency ${i}`, definition: "Does the work well.", weight: 4, evaluatedIn: "both", indicators: ["Example"] })),
    evaluation: { criteria: ["Evidence for each must-have"], redFlags: [] },
    screening: { questions: ["Tell me about your perio charting.", "Which days can you work?", "What pay are you looking for?"].map((q, i) => ({ key: `q${i}`, question: q, kind: "skills" })) },
    interviews: { plan: [{ key: "owner", title: "Conversation", purpose: "Fit.", durationMinutes: 30, format: "video", competencyKeys: ["c1"] }], scorecard: { scale: { min: 1, max: 4, labels: {} } } },
    communication: { companyBlurb: "A friendly practice.", signature: "The team", disclosureText: "This message was written with help from an AI assistant. Reply HUMAN to reach a person.", humanAlternativeText: "Reply HUMAN for a person." },
    approvals: {},
    compliance: {},
    sourcing: { summary: "Careers page.", channels: ["careers_page"] },
    preferences: {},
    provenance: {},
  });
  over(p);
  return p;
}

const ctx = { companyName: "Brightline Dental", companyLocations: [{ city: "Irvine", region: "CA", country: "US" }] };
const dana: Actor = { kind: "user", id: "u-dana", name: "Dana" };

describe("the packet guard's fixed rules (plan C1)", () => {
  it("works out jurisdictions and notices, shows pay on every ad (founder decision Q9), and sets the ceiling and range right", () => {
    const { packet: p, changes } = guardPacket(packet((x) => { x.compensation = { ...x.compensation, min: 60, max: 50, ceiling: 40, discloseRange: false }; }), ctx);
    expect(p.compliance.jurisdictions).toEqual(["US-CA"]);
    expect(p.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
    expect(p.compensation).toMatchObject({ min: 50, max: 60, ceiling: 60, discloseRange: true });
    expect(changes).toHaveLength(3);
  });

  it("puts the AI disclosure and the human alternative back, and keeps six must-haves at most", () => {
    const { packet: p } = guardPacket(packet((x) => {
      x.communication.disclosureText = "From the team.";
      x.communication.humanAlternativeText = " ";
      x.requirements.mustHaves = Array.from({ length: 8 }, (_, i) => ({ key: `m${i}`, text: `Skill ${i}`, rationale: "r", evidencedBy: ["resume" as const] }));
    }), ctx);
    expect(p.communication.disclosureText).toMatch(/AI recruiting assistant/);
    expect(p.communication.humanAlternativeText).toMatch(/HUMAN/);
    expect(p.requirements.mustHaves).toHaveLength(6);
  });

  it("guards a draft that has no pay yet, and flags a pay figure nobody confirmed", () => {
    const draft: DraftRolePacket = packet((x) => { x.description.publicJobDescription += " Pay is $40 an hour."; });
    delete draft.compensation;
    const { packet: p, flags } = guardPacket(draft, ctx);
    expect(p.compensation).toBeUndefined();
    expect(flags.map((f) => f.rule)).toEqual(["unconfirmed_pay"]);
  });

  it("with pay set, the description may quote only the advertised range: an older figure or the private ceiling is flagged", () => {
    expect(guardPacket(packet((x) => { x.description.publicJobDescription += " Pay is $45 to $55 an hour."; }), ctx).flags).toEqual([]);
    // the pay changed after the words were written: the old figures no longer match
    const stale = guardPacket(packet((x) => { x.description.publicJobDescription += " Pay is $40 to $50 an hour, up to $58."; }), ctx);
    expect(stale.flags.map((f) => [f.rule, f.text])).toEqual([["pay_mismatch", "$40"], ["pay_mismatch", "$50"], ["pay_mismatch", "$58"]]);
    expect(unresolvedFlags(stale.packet)).toHaveLength(3);
  });

  it("keeps a skill's 1-5 weight in step with the importance a person picked (plan F3), and leaves an unpicked one alone", () => {
    const { packet: p, changes } = guardPacket(packet((x) => {
      x.competencies[0].importance = "helpful";
      x.competencies[1].importance = "essential";
    }), ctx);
    expect(p.competencies.map((c) => [c.importance ?? null, c.weight])).toEqual([["helpful", 1], ["essential", 5], [null, 4]]);
    expect(changes).toEqual([]);
  });
});

describe("what the owner was told could not be used never comes back (C1)", () => {
  const declined = [{ requested: "recent grads", reason: "Age and proxies for age cannot be hiring criteria.", alternative: "Describe the skills instead." }];

  it("takes it out of the lists, flags it everywhere else, and records it on the packet for later versions", () => {
    const { packet: p, flags } = guardPacket(packet((x) => {
      x.requirements.niceToHaves = [{ key: "n1", text: "Recent grads welcome", rationale: "r", evidencedBy: ["resume"] }, { key: "n2", text: "Dentrix", rationale: "r", evidencedBy: ["resume"] }];
      x.preferences.dealBreakersInTheirWords = ["Recent grads only"];
      x.description.publicJobDescription += " Perfect for recent grads!";
      x.screening.questions[1].question = "Are you one of our recent grads?";
    }), { ...ctx, declined });
    expect(p.requirements.niceToHaves.map((n) => n.text)).toEqual(["Dentrix"]);
    expect(p.preferences.dealBreakersInTheirWords).toEqual([]);
    expect(p.provenance.declinedCriteria).toEqual([expect.objectContaining({ requested: "recent grads", rule: "recent_graduate" })]);
    const paths = flags.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["description.publicJobDescription", "screening.questions[1].question"]));
    expect(flags.every((f) => f.declined)).toBe(true);
    // a later edit that drops the record still meets it: the previous version's list is passed in
    const next = guardPacket(packet((x) => { x.evaluation.redFlags = ["Recent grads"]; }), { ...ctx, declined: p.provenance.declinedCriteria });
    expect(next.packet.evaluation.redFlags).toEqual([]);
  });

  it("never empties the must-haves: the last one is flagged instead", () => {
    const { packet: p, flags } = guardPacket(packet((x) => { x.requirements.mustHaves[0].text = "Recent grads only"; }), { ...ctx, declined });
    expect(p.requirements.mustHaves).toHaveLength(1);
    expect(flags.some((f) => f.path === "requirements.mustHaves[0].text")).toBe(true);
  });

  it("matches whole words only: a declined 'Age' never takes out 'Manage the front desk' or flags 'average' and 'language'", () => {
    const { packet: p, flags, changes } = guardPacket(packet((x) => {
      x.requirements.mustHaves.push({ key: "desk", text: "Manage the front desk", rationale: "r", evidencedBy: ["resume"] });
      x.requirements.niceToHaves = [{ key: "lang", text: "A second language", rationale: "r", evidencedBy: ["screen"] }];
      x.description.publicJobDescription += " Above-average wages and a message from the owner.";
    }), { ...ctx, declined: [{ requested: "Age", reason: "Age cannot be a hiring requirement." }] });
    expect(p.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Manage the front desk"]);
    expect(p.requirements.niceToHaves).toHaveLength(1);
    expect(flags).toEqual([]);
    expect(changes).toEqual([]);
    // a declined phrase is still matched as a phrase, wherever it sits in the words
    const phrase = guardPacket(packet((x) => { x.requirements.niceToHaves = [{ key: "n", text: "Prefer recent grads, honestly", rationale: "r", evidencedBy: ["resume"] }]; }), { ...ctx, declined });
    expect(phrase.packet.requirements.niceToHaves).toEqual([]);
  });
});

describe("a kept flag stays kept when the lists around it move (C1)", () => {
  it("names the place by the item's key, not its position, so taking out an earlier must-have keeps the keep", () => {
    const flagged = guardPacket(packet((x) => {
      x.requirements.mustHaves.push({ key: "spoken", text: "Native English speaker", rationale: "r", evidencedBy: ["screen"] });
    }), ctx);
    const flag = flagged.flags[0];
    expect(flag.path).toBe("requirements.mustHaves[1].text");
    const asked = structuredClone(flagged.packet);
    asked.provenance.flags = [{ ...flag, keepReason: "Our patients are English speakers; we test the level needed." }];
    const kept = guardPacket(asked, { ...ctx, actor: dana });
    // the license (before it) is taken out: the phrase moves to position 0 and the person's keep carries over
    const moved = structuredClone(kept.packet);
    moved.requirements.mustHaves = moved.requirements.mustHaves.filter((m) => m.key !== "license");
    const after = guardPacket(moved, { ...ctx, previousFlags: kept.flags });
    expect(after.flags[0]).toMatchObject({ path: "requirements.mustHaves[0].text", kept: { by: dana } });
    expect(unresolvedFlags(after.packet)).toHaveLength(0);
  });
});

describe("wording that stands in for a protected trait is flagged anywhere a person reads it (C1)", () => {
  const cases: Array<[string, string]> = [
    ["age", "Ideal for candidates aged 25-35"],
    ["age", "Must be under 30"],
    ["age", "Join our young and energetic team"],
    ["recent_graduate", "Recent college graduates preferred"],
    ["language_origin", "Native English speaker"],
    ["citizenship", "US citizens only"],
    ["employment_gaps", "No gaps in employment"],
    ["family_status", "No kids, so you can stay late"],
    ["sex", "Female candidates only"],
    ["health_disability", "Must be able-bodied"],
    ["location_proxy", "Locals only, zip code 92618"],
    ["criminal_record", "No felons"],
    ["experience_cap", "No more than 5 years of experience"],
    ["experience_floor", "At least 15 years of dental experience"],
    ["pay_history", "What is your current salary?"],
  ];
  for (const [rule, text] of cases) {
    it(`${rule}: "${text}"`, () => expect(screenCriterion(text)?.rule).toBe(rule));
  }

  it("leaves lawful wording alone: minimum ages, numbers that are not ages, a clean driving record, pay expectations", () => {
    for (const text of ["Must be 18 or older to serve alcohol", "Must be over 21", "See over 50 patients a week", "Under 30 minutes from the office", "Clean driving record", "What pay are you looking for?", "Two years of front desk experience", "Comfortable with young children", "Local anesthesia certification"]) {
      expect(screenCriterion(text), text).toBeNull();
    }
  });

  it("stores flags on the packet; approval waits until each is edited out or kept with a reason, and who kept it carries over", () => {
    const flagged = guardPacket(packet((x) => { x.requirements.mustHaves.push({ key: "m2", text: "Native English speaker", rationale: "r", evidencedBy: ["screen"] }); }), ctx);
    expect(unresolvedFlags(flagged.packet)).toHaveLength(1);
    const flag = flagged.flags[0];
    expect(flag).toMatchObject({ path: "requirements.mustHaves[1].text", rule: "language_origin" });
    // a request to keep without someone saving it does nothing; with a person, it is stamped with them
    const asked = structuredClone(flagged.packet);
    asked.provenance.flags = [{ ...flag, keepReason: "The patients we serve speak English; we will test the level needed." }];
    expect(unresolvedFlags(guardPacket(asked, ctx).packet)).toHaveLength(1);
    const kept = guardPacket(asked, { ...ctx, actor: dana, now: "2026-10-08T10:00:00.000Z" });
    expect(unresolvedFlags(kept.packet)).toHaveLength(0);
    expect(kept.flags[0].kept).toEqual({ reason: "The patients we serve speak English; we will test the level needed.", by: dana, at: "2026-10-08T10:00:00.000Z" });
    // a later save keeps that record; a forged one (another person, another reason) is not trusted
    const resaved = guardPacket(kept.packet, { ...ctx, previousFlags: kept.flags });
    expect(resaved.flags[0].kept?.by).toEqual(dana);
    const forged = structuredClone(flagged.packet);
    forged.provenance.flags = [{ ...flag, kept: { reason: "x", by: { kind: "user", id: "someone" }, at: "2020-01-01" } }];
    expect(unresolvedFlags(guardPacket(forged, ctx).packet)).toHaveLength(1);
    // editing the words out clears the flag
    const edited = structuredClone(flagged.packet);
    edited.requirements.mustHaves[1].text = "Clear spoken English for patient instructions";
    expect(unresolvedFlags(guardPacket(edited, ctx).packet)).toHaveLength(0);
  });

  it("reads rewordings the same way", () => {
    expect(normalizeCriterion("Recent  GRADS!")).toBe(normalizeCriterion("recent grads"));
  });
});

describe("the questions every applicant answers pass the fairness check (Wave S7)", () => {
  const refused = [
    ["What is your gender?", "asks_sex"],
    ["What are your pronouns?", "asks_sex"],
    ["How old are you?", "asks_age"],
    ["What is your date of birth?", "asks_age"],
    ["What year did you graduate from high school?", "asks_age"],
    ["What is your ethnicity?", "asks_race"],
    ["Are you a US citizen?", "asks_origin"],
    ["What is your nationality?", "asks_origin"],
    ["Where were you born?", "asks_origin"],
    ["Is English your first language?", "asks_origin"],
    ["What religion are you?", "asks_religion"],
    ["Which holidays do you observe?", "asks_religion"],
    ["Are you married?", "asks_family"],
    ["Do you have children?", "asks_family"],
    ["How many kids do you have?", "asks_family"],
    ["Are you planning to start a family soon?", "asks_family"],
    ["Do you have any disabilities?", "asks_health"],
    ["Do you take any medication?", "asks_health"],
    ["Have you ever filed a workers' comp claim?", "asks_health"],
    ["Have you ever been convicted of a crime?", "asks_record"],
    ["Do you have a criminal record?", "asks_record"],
    ["What is your current salary?", "asks_pay_history"],
    // the real-model probes of the Wave S7 review: each one was allowed before
    ["Are you over 40?", "asks_age"],
    ["Are you under 30?", "asks_age"],
    ["Are you a veteran?", "asks_veteran"],
    ["Have you served in the military?", "asks_veteran"],
    ["Are you a parent?", "asks_family"],
    ["Are you a mother?", "asks_family"],
    ["Do you have childcare arrangements?", "asks_family"],
    ["Are you a green card holder?", "asks_origin"],
    ["Do you have any physical limitations?", "asks_health"],
    ["What were you paid at your last job?", "asks_pay_history"],
    ["Where did you grow up?", "asks_origin"],
    ["What languages do you speak natively?", "asks_origin"],
  ] as const;
  for (const [question, rule] of refused) {
    it(`refuses "${question}" (${rule})`, () => {
      expect(questionCheck(question)?.rule).toBe(rule);
      expect(companyQuestionProblems({ quick: [{ key: "cq_x", question, options: ["A", "B"] }] })[0]).toMatchObject({ list: "quick", index: 0, key: "cq_x", part: "question", rule });
    });
  }

  it("lets the work's own questions through, the lawful ones included", () => {
    const fine = [
      "Are you legally authorized to work in the United States for any employer?",
      "Are you at least 18 years old?",
      "Can you lift 25 pounds, with or without a reasonable accommodation?",
      "Do you have experience caring for patients with disabilities?",
      "Do you have experience working with children?",
      "How many children do you look after at once in your current role?",
      "How will you get to work?",
      "How many years have you used Dentrix?",
      "Tell us about a time you calmed a nervous patient.",
      "Are you single-handedly running a front desk today?",
      "Are you a manager now?",
      "How do you keep your health and safety training current?",
      "Do you hold current CPR/BLS certification?",
      "What pay are you looking for?",
      "Have you completed sexual harassment prevention training?",
    ];
    for (const q of fine) expect(questionCheck(q), q).toBeNull();
  });

  it("checks every part of a question: its help line, each answer offered and what a good answer shows", () => {
    const problems = companyQuestionProblems({
      quick: [
        { key: "cq_shift", question: "Which shift suits you?", help: "Tell us how old are you too", options: ["Morning", "Evening"] },
        { key: "cq_about", question: "Which describes you?", options: ["Male", "Female", "Prefer not to say"] },
      ],
      written: [{ key: "wq_story", question: "Tell us about a hard day at work.", lookFor: "Ideally married, with a stable home" }],
    });
    expect(problems.map((p) => [p.list, p.index, p.part, p.rule])).toEqual([
      ["quick", 0, "help", "asks_age"],
      ["quick", 1, "option", "asks_trait_option"],
      ["quick", 1, "option", "asks_trait_option"],
      ["written", 0, "lookFor", "asks_family"],
    ]);
    expect(companyQuestionProblemWords(problems[1])).toBe('Quick question 2, the answer "Male": An answer to choose from names a protected characteristic, so the question asks about it. Ask only about the work the job needs.');
    // answers to choose from that are a protected trait, or an age bracket, are refused (the review's probes)
    for (const options of [["U.S. citizen", "Green card holder", "Work visa"], ["Under 30", "30-49", "50 or over"], ["Mr", "Mrs", "Ms"], ["Mother", "Father"], ["Veteran", "Not a veteran"]]) {
      const found = companyQuestionProblems({ quick: [{ key: "cq_which", question: "Which one are you?", options }] });
      // every answer offered is refused, each with the rule it breaks
      expect(found.map((p) => p.part), options.join(" / ")).toEqual(options.map(() => "option"));
    }
    // numbers that count something are not ages
    expect(companyQuestionProblems({ quick: [{ key: "cq_n", question: "How many patients do you see a day?", options: ["Under 10", "10-20", "20 or more"] }] })).toEqual([]);
    // the phrase list's protected-characteristic rules are refused in a question, not only flagged
    expect(companyQuestionProblems({ written: [{ key: "wq_x", question: "Tell us about your work.", lookFor: "Native English speakers only" }] })[0]).toMatchObject({ part: "lookFor" });
    expect(companyQuestionProblems({ quick: [], written: [] })).toEqual([]);
    expect(companyQuestionProblems(null)).toEqual([]);
  });

  it("flags phrase-list wording in the company's questions like any other words, and still reads a protected question that got in", () => {
    const p = packet((x) => {
      x.companyQuestions = {
        quick: [{ kind: "number", key: "cq_years", question: "How many years of experience do you have?", required: true }],
        written: [
          { key: "wq_gaps", question: "Walk us through your last job.", required: true, lookFor: "No employment gaps" },
          { key: "wq_age", question: "How old are you?", required: true },
        ],
      };
    });
    const { flags } = guardPacket(p, ctx);
    expect(flags.map((f) => [f.path, f.rule])).toEqual([
      ["companyQuestions.written[0].lookFor", "employment_gaps"],
      ["companyQuestions.written[1].question", "asks_age"],
    ]);
    expect(flags[0].id).toContain("companyQuestions.written[wq_gaps].lookFor");
    // a packet without them is read as before
    expect(guardPacket(packet(), ctx).flags).toEqual([]);
  });
});
