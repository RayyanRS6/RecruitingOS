import { describe, expect, it } from "vitest";
import { RolePacket, type Actor, type DraftRolePacket } from "@ros/contracts";
import { PROXY_RULES, formQuestionProblems, guardPacket, normalizeCriterion, questionCheck, screenCriterion, screenDealBreaker, uniqueKeys, unresolvedFlags, wordingProblems } from "./packet-guard";

/** A small valid job record; each test changes what it is about. */
function packet(over: (p: RolePacket) => void = () => {}): RolePacket {
  const p = RolePacket.parse({
    identity: { title: "Registered Dental Hygienist", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time" },
    compensation: { basis: "hourly", min: 45, max: 55, discloseRange: true },
    description: { publicJobDescription: "Brightline Dental is hiring a registered dental hygienist in Irvine to care for a loyal patient base, five days a week." },
    requirements: { mustHaves: [{ key: "license", text: "Active CA RDH license", rationale: "Required by law." }], niceToHaves: [] },
    competencies: [1, 2, 3].map((i) => ({ key: `c${i}`, name: `Competency ${i}`, definition: "Does the work well.", importance: "important", indicators: ["Example"] })),
    screening: { questions: ["Tell me about your perio charting.", "Which days can you work?", "What pay are you looking for?"].map((q, i) => ({ key: `q${i}`, question: q, kind: "skills" })) },
    communication: { companyBlurb: "A friendly practice.", signature: "The team", disclosureText: "This message was written with help from an AI assistant.", humanAlternativeText: "Reply to any of our emails to reach a person." },
    compliance: {},
    provenance: {},
  });
  over(p);
  return p;
}

const ctx = { companyName: "Brightline Dental", companyLocations: [{ city: "Irvine", region: "CA", country: "US" }] };
const dana: Actor = { kind: "user", id: "u-dana", name: "Dana" };

describe("the guard's fixed rules", () => {
  it("works out jurisdictions and notices, shows pay on every ad, and puts a reversed range the right way round", () => {
    const { packet: p, changes } = guardPacket(packet((x) => { x.compensation = { ...x.compensation, min: 60, max: 50, discloseRange: false }; }), ctx);
    expect(p.compliance.jurisdictions).toEqual(["US-CA"]);
    expect(p.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
    expect(p.compensation).toMatchObject({ min: 50, max: 60, discloseRange: true });
    expect(changes).toHaveLength(2);
  });

  it("writes the AI disclosure, how to reach a person and the signature in the code's own words, whatever the job held, and keeps six must-haves at most", () => {
    const { packet: p } = guardPacket(packet((x) => {
      x.communication.disclosureText = "From the team.";
      x.communication.humanAlternativeText = " ";
      x.requirements.mustHaves = Array.from({ length: 8 }, (_, i) => ({ key: `m${i}`, text: `Skill ${i}`, rationale: "r" }));
    }), ctx);
    const CODE_LINES = {
      disclosureText: "This message was sent by the hiring team at Brightline Dental with help from an AI recruiting assistant.",
      humanAlternativeText: "To reach a person at any time, reply to any of our emails or use the contact on the job page.",
      signature: "The hiring team at Brightline Dental",
    };
    expect(p.communication).toMatchObject(CODE_LINES);
    // lines that read well enough are replaced too: a model wrote them with the job, and nobody was shown them, so the
    // record never keeps them (it kept them until 25 November 2026, and every email carried them)
    const written = packet();
    expect(written.communication).toMatchObject({ disclosureText: "This message was written with help from an AI assistant.", humanAlternativeText: "Reply to any of our emails to reach a person.", signature: "The team" });
    const saved = guardPacket(written, ctx);
    expect(saved.packet.communication).toMatchObject(CODE_LINES);
    // the rest of that section is the job's own, and the owner is told of no change: these lines are not theirs to see or edit
    expect(saved.packet.communication.companyBlurb).toBe("A friendly practice.");
    expect(saved.changes).toEqual([]);
    // saving it again changes nothing
    expect(guardPacket(saved.packet, ctx).packet.communication).toEqual(saved.packet.communication);
    expect(p.requirements.mustHaves).toHaveLength(6);
  });

  // A reading's findings are matched to a job's must-haves and skills by key, a scorecard's to the AI interview's
  // questions and a candidate's answers to the form's questions, and nothing held the keys of a record apart: the model
  // is only asked for unique ones. Two items under one key shared one finding (code check of 25 November 2026).
  it("leaves every must-have, nice-to-have, skill, AI interview question and form question with a key no other of its kind has", () => {
    const { packet: p, changes } = guardPacket(packet((x) => {
      x.requirements.mustHaves = [{ key: "license", text: "Active CA RDH license", rationale: "Required by law." }, { key: "license", text: "Local anesthesia permit" }, { key: "perio", text: "Periodontal charting" }, { key: "license", text: "Nitrous monitoring permit" }];
      x.requirements.niceToHaves = [{ key: "license", text: "Laser certification" }, { key: "n", text: "Dentrix" }, { key: "n", text: "Spanish" }];
      x.competencies = [...x.competencies, { ...x.competencies[0], name: "Another skill" }];
      x.screening.questions = [...x.screening.questions, { key: "q0", question: "How do you calm an anxious patient?", kind: "behavioral" }];
      x.formQuestions = [{ kind: "yes_no", key: "fq", question: "Can you work Saturdays?", required: true }, { kind: "yes_no", key: "fq", question: "Do you hold a current CPR card?", required: true }, { kind: "yes_no", key: "fq_2", question: "Can you start within 30 days?", required: true }];
    }), ctx);
    // the first item with a key keeps it; a repeat gets a short suffix that no item of its list has
    expect(p.requirements.mustHaves.map((m) => [m.key, m.text])).toEqual([["license", "Active CA RDH license"], ["license_2", "Local anesthesia permit"], ["perio", "Periodontal charting"], ["license_3", "Nitrous monitoring permit"]]);
    // each list is its own: a nice-to-have may carry a must-have's key, as nothing matches across the two
    expect(p.requirements.niceToHaves.map((m) => m.key)).toEqual(["license", "n", "n_2"]);
    expect(p.competencies.map((c) => [c.key, c.name])).toEqual([["c1", "Competency 1"], ["c2", "Competency 2"], ["c3", "Competency 3"], ["c1_2", "Another skill"]]);
    expect(p.screening.questions.map((q) => q.key)).toEqual(["q0", "q1", "q2", "q0_2"]);
    expect(p.formQuestions.map((q) => q.key)).toEqual(["fq", "fq_3", "fq_2"]);
    // nothing else of an item changes, and the owner is told of nothing: a key is never on a screen
    expect(p.requirements.mustHaves[0]).toEqual({ key: "license", text: "Active CA RDH license", rationale: "Required by law." });
    expect(p.competencies[3]).toEqual({ ...p.competencies[0], key: "c1_2", name: "Another skill" });
    expect(changes).toEqual([]);
    // saved again, every key stays: an existing unique key never changes, because stored readings point at it
    const again = guardPacket(p, ctx).packet;
    for (const list of ["mustHaves", "niceToHaves"] as const) expect(again.requirements[list].map((m) => m.key)).toEqual(p.requirements[list].map((m) => m.key));
    expect([again.competencies, again.screening.questions, again.formQuestions].map((l) => l.map((i) => i.key))).toEqual([p.competencies, p.screening.questions, p.formQuestions].map((l) => l.map((i) => i.key)));
    const untouched = packet();
    const kept = guardPacket(untouched, ctx).packet;
    expect([kept.requirements.mustHaves, kept.competencies, kept.screening.questions].map((l) => l.map((i) => i.key))).toEqual([["license"], ["c1", "c2", "c3"], ["q0", "q1", "q2"]]);
    expect(uniqueKeys([{ key: "a" }, { key: "a_2" }, { key: "a" }, { key: "a" }]).map((i) => i.key)).toEqual(["a", "a_2", "a_3", "a_4"]);
    expect(uniqueKeys([])).toEqual([]);
  });

  it("names a flag by its item's own key, so a phrase in each of two items that came with one key is flagged in both", () => {
    const { packet: p, flags } = guardPacket(packet((x) => {
      x.requirements.mustHaves = [{ key: "m", text: "Native English speaker" }, { key: "m", text: "Native Spanish speaker" }];
    }), ctx);
    expect(p.requirements.mustHaves.map((m) => m.key)).toEqual(["m", "m_2"]);
    expect(flags.map((f) => [f.path, f.id])).toEqual([["requirements.mustHaves[0].text", "language_origin:requirements.mustHaves[m].text:native_english_speaker"], ["requirements.mustHaves[1].text", "language_origin:requirements.mustHaves[m_2].text:native_spanish_speaker"]]);
  });

  it("guards a draft that has no pay yet, and flags a pay figure nobody confirmed", () => {
    const draft: DraftRolePacket = packet((x) => { x.description.publicJobDescription += " Pay is $40 an hour."; });
    delete draft.compensation;
    const { packet: p, flags } = guardPacket(draft, ctx);
    expect(p.compensation).toBeUndefined();
    expect(flags.map((f) => f.rule)).toEqual(["unconfirmed_pay"]);
  });

  it("with pay set, the description may quote only the advertised range: an older figure is flagged", () => {
    expect(guardPacket(packet((x) => { x.description.publicJobDescription += " Pay is $45 to $55 an hour."; }), ctx).flags).toEqual([]);
    // the pay changed after the words were written: the old figures no longer match
    const stale = guardPacket(packet((x) => { x.description.publicJobDescription += " Pay is $40 to $50 an hour, up to $58."; }), ctx);
    expect(stale.flags.map((f) => [f.rule, f.text])).toEqual([["pay_mismatch", "$40"], ["pay_mismatch", "$50"], ["pay_mismatch", "$58"]]);
    expect(unresolvedFlags(stale.packet)).toHaveLength(3);
  });
});

describe("what the owner was told could not be used never comes back", () => {
  const declined = [{ requested: "recent grads", reason: "Age and proxies for age cannot be hiring criteria.", alternative: "Describe the skills instead." }];

  it("takes it out of the lists, flags it everywhere else, and records it on the job for later versions", () => {
    const { packet: p, flags } = guardPacket(packet((x) => {
      x.requirements.niceToHaves = [{ key: "n1", text: "Recent grads welcome", rationale: "r" }, { key: "n2", text: "Dentrix", rationale: "r" }];
      x.description.publicJobDescription += " Perfect for recent grads!";
      x.screening.questions[1].question = "Are you one of our recent grads?";
    }), { ...ctx, declined });
    expect(p.requirements.niceToHaves.map((n) => n.text)).toEqual(["Dentrix"]);
    expect(p.provenance.declinedCriteria).toEqual([expect.objectContaining({ requested: "recent grads", rule: "recent_graduate" })]);
    const paths = flags.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["description.publicJobDescription", "screening.questions[1].question"]));
    expect(flags.every((f) => f.declined)).toBe(true);
    // a later edit that drops the record still meets it: the previous version's list is passed in
    const next = guardPacket(packet((x) => { x.requirements.niceToHaves = [{ key: "n3", text: "Recent grads", rationale: "r" }]; }), { ...ctx, declined: p.provenance.declinedCriteria });
    expect(next.packet.requirements.niceToHaves).toEqual([]);
  });

  it("never empties the must-haves: the last one is flagged instead", () => {
    const { packet: p, flags } = guardPacket(packet((x) => { x.requirements.mustHaves[0].text = "Recent grads only"; }), { ...ctx, declined });
    expect(p.requirements.mustHaves).toHaveLength(1);
    expect(flags.some((f) => f.path === "requirements.mustHaves[0].text")).toBe(true);
  });

  it("matches whole words only: a declined 'Age' never takes out 'Manage the front desk' or flags 'average' and 'language'", () => {
    const { packet: p, flags, changes } = guardPacket(packet((x) => {
      x.requirements.mustHaves.push({ key: "desk", text: "Manage the front desk", rationale: "r" });
      x.requirements.niceToHaves = [{ key: "lang", text: "A second language", rationale: "r" }];
      x.description.publicJobDescription += " Above-average wages and a message from the owner.";
    }), { ...ctx, declined: [{ requested: "Age", reason: "Age cannot be a hiring requirement." }] });
    expect(p.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Manage the front desk"]);
    expect(p.requirements.niceToHaves).toHaveLength(1);
    expect(flags).toEqual([]);
    expect(changes).toEqual([]);
    // a declined phrase is still matched as a phrase, wherever it sits in the words
    const phrase = guardPacket(packet((x) => { x.requirements.niceToHaves = [{ key: "n", text: "Prefer recent grads, honestly", rationale: "r" }]; }), { ...ctx, declined });
    expect(phrase.packet.requirements.niceToHaves).toEqual([]);
  });

  it("finds a declined request restated as the must-have it reads as too (review of the live test, 12 Nov 2026)", () => {
    const visa = [{ requested: "No visa permit", reason: "Limiting a job to citizens is unlawful unless a law requires it." }];
    const { packet: p, flags } = guardPacket(packet((x) => {
      x.requirements.mustHaves.push({ key: "visa", text: "Valid visa permit", rationale: "r" });
      x.description.publicJobDescription += " A visa permit is a must.";
    }), { ...ctx, declined: visa });
    expect(p.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license"]);
    expect(flags).toEqual([expect.objectContaining({ path: "description.publicJobDescription", rule: "declined", text: "No visa permit", declined: true })]);
    // only what it reads as: a declined "No children" never takes out work with children
    const kids = guardPacket(packet((x) => { x.requirements.mustHaves.push({ key: "peds", text: "Experience with children", rationale: "r" }); }), { ...ctx, declined: [{ requested: "No children", reason: "Family status and pregnancy cannot be hiring criteria." }] });
    expect(kids.packet.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Experience with children"]);
    expect(kids.flags).toEqual([]);
  });
});

describe("a kept flag stays kept when the lists around it move", () => {
  it("names the place by the item's key, not its position, so taking out an earlier must-have keeps the keep", () => {
    const flagged = guardPacket(packet((x) => {
      x.requirements.mustHaves.push({ key: "spoken", text: "Native English speaker", rationale: "r" });
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

describe("wording that stands in for a protected trait is flagged anywhere a person reads it", () => {
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

  it("stores flags on the job; publishing waits until each is edited out or kept with a reason, and who kept it carries over", () => {
    const flagged = guardPacket(packet((x) => { x.requirements.mustHaves.push({ key: "m2", text: "Native English speaker", rationale: "r" }); }), ctx);
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

describe("the application form's questions pass the fairness check", () => {
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
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["A", "B"] }])[0]).toMatchObject({ index: 0, key: "cq_x", part: "question", rule });
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

  it("checks every part of a question: its help line and each answer offered", () => {
    const problems = formQuestionProblems([
      { key: "cq_shift", question: "Which shift suits you?", help: "Tell us how old are you too", options: ["Morning", "Evening"] },
      { key: "cq_about", question: "Which describes you?", options: ["Male", "Female", "Prefer not to say"] },
      { key: "cq_story", question: "Have you worked a front desk?", help: "Ideally married, with a stable home" },
    ]);
    expect(problems.map((p) => [p.index, p.key, p.part, p.rule])).toEqual([
      [0, "cq_shift", "help", "asks_age"],
      [1, "cq_about", "option", "asks_trait_option"],
      [1, "cq_about", "option", "asks_trait_option"],
      [2, "cq_story", "help", "asks_family"],
    ]);
    expect(problems[1].words).toBe('Screening question 2, the answer "Male": An answer to choose from names a protected characteristic, so the question asks about it. Ask only about the work the job needs.');
    expect(problems[0].words).toMatch(/^Screening question 1, its help line: /);
    // answers to choose from that are a protected trait, or an age bracket, are refused
    for (const options of [["U.S. citizen", "Green card holder", "Work visa"], ["Under 30", "30-49", "50 or over"], ["Mr", "Mrs", "Ms"], ["Mother", "Father"], ["Veteran", "Not a veteran"]]) {
      const found = formQuestionProblems([{ key: "cq_which", question: "Which one are you?", options }]);
      // every answer offered is refused, each with the rule it breaks
      expect(found.map((p) => p.part), options.join(" / ")).toEqual(options.map(() => "option"));
    }
    // numbers that count something are not ages
    expect(formQuestionProblems([{ key: "cq_n", question: "How many patients do you see a day?", options: ["Under 10", "10-20", "20 or more"] }])).toEqual([]);
    // the phrase list's protected-characteristic rules are refused in a question, not only flagged
    expect(formQuestionProblems([{ key: "cq_x", question: "Tell us about your work.", help: "Native English speakers only" }])[0]).toMatchObject({ part: "help" });
    expect(formQuestionProblems([])).toEqual([]);
    expect(formQuestionProblems(null)).toEqual([]);
  });

  it("flags phrase-list wording in the form's questions like any other words, and still reads a protected question that got in", () => {
    const p = packet((x) => {
      x.formQuestions = [
        { kind: "number", key: "cq_years", question: "How many years of experience do you have?", required: true },
        { kind: "yes_no", key: "cq_gaps", question: "Did your last job run for a year or more?", help: "No employment gaps", required: true },
        { kind: "yes_no", key: "cq_age", question: "How old are you?", required: true },
      ];
    });
    const { flags } = guardPacket(p, ctx);
    expect(flags.map((f) => [f.path, f.rule])).toEqual([
      ["formQuestions[1].help", "employment_gaps"],
      ["formQuestions[2].question", "asks_age"],
    ]);
    expect(flags[0].id).toContain("formQuestions[cq_gaps].help");
    // a job without them is read as before
    expect(guardPacket(packet(), ctx).flags).toEqual([]);
  });
});

// Review of the live-test fixes, 17 Nov 2026: "No felony convictions", "Felony-free" or "Must not have a felony" as a
// deal-breaker or a must-have, and "Are you a convicted felon?" as a question, got past the fairness check, so the AI
// interview could screen people on their record.
describe("a ban on a criminal record is refused in any common wording, and a background check after an offer never is", () => {
  it("refuses a requirement that rules people out for a record, with the rule's own reason and alternative", () => {
    expect(screenCriterion("No felony convictions")).toEqual({
      rule: "criminal_record",
      text: "No felony",
      reason: "A blanket ban on criminal records breaks fair-chance hiring laws in many places.",
      alternative: "Leave any background check to the end of the process, after an offer, where the law allows it.",
    });
    const refused = [
      // refused before, and still
      "No felons", "No felonies", "No criminal record", "Clean record", "Never convicted",
      // the wordings that got past
      "No felony convictions", "No felony", "No criminal convictions", "Felony-free", "Without a criminal record", "Must not have any convictions", "Must not have a felony",
      // each word for a record, after each word that rules someone out
      "No felon", "No conviction", "No criminal history", "No criminal background", "No criminal charges", "No criminal offenses", "No arrests", "No misdemeanors",
      "Without felony convictions", "Never been arrested", "Must not have a criminal history", "Cannot have a criminal record", "Can't have any misdemeanors", "Free of criminal convictions",
      // the "-free" forms
      "Felon-free", "Conviction-free", "Arrest-free",
      // the same ban in other common words
      "Won't hire felons", "Felons need not apply", "Must not be a convicted felon", "Has not been convicted of a felony",
    ];
    for (const text of refused) expect(screenCriterion(text)?.rule, text).toBe("criminal_record");
    // rebuilt from the final check (LT-31): a word between, a list, "No one with" or "Do not apply if" is read as production reads it
    for (const text of ["Never had a felony", "No prior felony convictions", "No DUIs or felonies", "No one with a criminal record", "Do not apply if you have a felony"]) expect(screenCriterion(text), text).toBeNull();
  });

  it("refuses a question about the candidate's own record, wherever a question is set", () => {
    for (const question of ["Are you a convicted felon?", "Any felony convictions?", "Have you ever been convicted of a crime?", "Are you on probation or parole?", "Are you felony-free?"]) {
      expect(questionCheck(question)?.rule, question).toBe("asks_record");
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["Yes", "No"] }])[0], question).toMatchObject({ part: "question", rule: "asks_record" });
    }
    // rebuilt from the final check (LT-31): neither is in production's words or a fixed phrase, so both are saved, as in production
    for (const question of ["Do you have a felony?", "Ever been arrested?"]) {
      expect(questionCheck(question), question).toBeNull();
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["Yes", "No"] }]), question).toEqual([]);
    }
  });

  it("never refuses a background check after an offer, work with people who have a record, or a driving record, beyond production's own words", () => {
    const fine = [
      "Background check after a conditional offer", "Offer contingent on a background check", "No background check until after an offer",
      "With or without a criminal record, you are welcome to apply",
      "Clean driving record", "Valid driver's license", "Valid driver's licence and a clean driving record", "No DUI convictions",
      // waits for counsel: neither refused nor flagged for now
      "Must pass a background check",
    ];
    for (const text of fine) {
      expect(screenCriterion(text), text).toBeNull();
      expect(questionCheck(text), text).toBeNull();
    }
    for (const question of ["Do you have a clean driving record?", "Do you hold a valid driver's license?", "Are you OK with a 90-day probation period?"]) {
      expect(questionCheck(question), question).toBeNull();
    }
    // rebuilt from the final check (LT-31): production's "No criminal background", and in a question its bare "criminal record" or "criminal background", still refuse these
    for (const text of ["Criminal background check after a conditional offer", "Experience supporting clients with a criminal record"]) expect(screenCriterion(text), text).toBeNull();
    expect(screenCriterion("No criminal background check until after an offer")?.text).toBe("No criminal background");
    for (const text of ["Criminal background check after a conditional offer", "No criminal background check until after an offer", "Experience supporting clients with a criminal record", "Do you have experience supporting clients with a criminal record?", "Are you willing to complete a criminal background check after a conditional offer?"]) {
      expect(questionCheck(text)?.rule, text).toBe("asks_record");
    }
  });

  it("flags the wider wordings on a job saved before at its next save, keeps their words, and a keep made before still holds", () => {
    const reason = "A blanket ban on criminal records breaks fair-chance hiring laws in many places.";
    const alternative = "Leave any background check to the end of the process, after an offer, where the law allows it.";
    // as it was saved: the description's ban was flagged under the words the rule found then, and a person kept it
    const keep = { id: "criminal_record:description.publicJobDescription:no_felonies", path: "description.publicJobDescription", rule: "criminal_record", text: "No felonies", reason, alternative, kept: { reason: "State law bars anyone with a felony from this licensed role.", by: dana, at: "2026-11-01T10:00:00.000Z" } };
    const saved = packet((x) => {
      x.requirements.mustHaves.push({ key: "record", text: "No felony convictions", rationale: "r" });
      x.description.publicJobDescription += " No felonies or misdemeanors.";
      x.provenance.flags = [keep];
    });
    const next = guardPacket(saved, { ...ctx, previousFlags: [keep] });
    // nothing is taken out or reworded: the job reads as it did
    expect(next.packet.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "No felony convictions"]);
    expect(next.packet.description.publicJobDescription).toBe(saved.description.publicJobDescription);
    expect(next.changes).toEqual([]);
    // the keep holds, and the must-have the old rule let through waits for a person
    expect(next.flags.map((f) => [f.path, f.rule, f.text, !!f.kept])).toEqual([
      ["description.publicJobDescription", "criminal_record", "No felonies", true],
      ["requirements.mustHaves[1].text", "criminal_record", "No felony", false],
    ]);
    expect(unresolvedFlags(next.packet)).toHaveLength(1);
  });
});

// Review of the criminal-record fix, 17 Nov 2026: a ban written after "people with" passed, a record named on its own was
// stored as a deal-breaker and offered back as the must-have "Felony convictions", fair-chance and billing words were
// refused, questions about the work were refused, crime types before "convictions", ex-felons and "Felons will not be
// considered" passed, and a question in a ban's own words was only flagged, so it could be kept.
describe("the review of the criminal-record fix: each common ban refused, and the lawful words around a record never", () => {
  const RULE = { rule: "criminal_record", reason: "A blanket ban on criminal records breaks fair-chance hiring laws in many places.", alternative: "Leave any background check to the end of the process, after an offer, where the law allows it." };

  it("refuses a ban written after the people it rules out, with the words the rule found before the fix", () => {
    for (const text of ["We only hire people with a clean record", "Individuals who have never been convicted", "Looking for people with no criminal record", "Team members with no felonies", "Those with no criminal history", "Seeking individuals with no felony convictions"]) {
      expect(screenCriterion(text), text).toMatchObject(RULE);
    }
    // rebuilt from the final check (LT-31): none of these holds production's words or a fixed phrase, so they pass, as in production
    for (const text of ["People with felonies need not apply", "Those with a felony need not apply", "Those with a criminal record will be disqualified"]) expect(screenCriterion(text), text).toBeNull();
    // the words a flag kept before the fix was found by, so that keep still holds
    expect(screenCriterion("We only hire people with a clean record")?.text).toBe("clean record");
    expect(screenCriterion("Individuals who have never been convicted")?.text).toBe("never been convicted");
    // the people the work is with still pass
    for (const text of ["Experience supporting clients with a criminal record", "Experience supporting clients with no stable housing or criminal records", "We welcome applicants with a criminal record", "We hire people with records"]) expect(screenCriterion(text), text).toBeNull();
  });

  it("refuses ex-felons and the felony-free form, and reads a crime's kind, non-felons, offenders and someone not considered for a record as production does", () => {
    for (const text of ["No ex-felons", "Must be felony-free"]) expect(screenCriterion(text), text).toMatchObject(RULE);
    // rebuilt from the final check (LT-31): only production's words and the fixed phrases are a ban, so these pass, as in production
    for (const text of [
      "No domestic violence convictions", "No drug-related convictions", "No theft-related convictions", "No fraud convictions", "No assault convictions", "No violent crime convictions", "No theft or fraud convictions", "Must have no domestic violence convictions",
      "Must be a non-felon", "Non-felons only", "No ex-cons", "Ex-offenders need not apply", "No sex offenders", "No registered sex offenders", "No jail time",
      "Felons will not be considered", "Applicants with a felony conviction will not be considered", "We will not consider anyone with a criminal record", "A felony disqualifies you", "Felony convictions disqualify",
      "We do not hire anyone who has been convicted of a felony", "Applicants who have been convicted of a felony will not be considered",
      "Must not carry any felony convictions", "Cannot hold a felony conviction", "No pending criminal charges", "Must have a spotless record", "Zero felony convictions",
    ]) expect(screenCriterion(text), text).toBeNull();
  });

  it("never refuses fair-chance words, billing words or a driving record", () => {
    for (const text of [
      "We are a second-chance employer in Irvine, and we do not hold a criminal record against anyone who wants to work.", "We will not hold past convictions against our team.", "We do not hold arrests or convictions against applicants.",
      "End each day with no pending charges", "You don't have to be felony-free to apply", "We do not have a criminal record requirement for this job.",
      "No conviction automatically disqualifies you", "No felony or misdemeanor conviction will disqualify you", "No one convicted of a felony will be automatically disqualified", "Not every conviction disqualifies you",
      "No one with a record is turned away", "We will not take arrests into account", "No degree, convictions considered case by case",
      "We will not consider arrests that did not lead to a conviction", "Convictions older than seven years will not be considered", "We have no blanket ban on convictions", "Arrests without a conviction are never considered", "We welcome ex-offenders",
      "Pursuant to the San Francisco Fair Chance Ordinance, we will consider for employment qualified applicants with arrest and conviction records.",
      "We consider all qualified applicants without regard to race, color, religion, sex, national origin, or arrest and conviction records.", "No experience needed, felons welcome!",
      "No DUI or DWI convictions", "No reckless driving convictions", "No traffic convictions", "Never had a DUI conviction", "Keep a clean record of patient charts", "No candidate record is linked to this request.",
    ]) expect(screenCriterion(text), text).toBeNull();
  });

  it("refuses a question about the candidate's own record in these words, and one in a ban's own words, wherever a question is set", () => {
    for (const question of [
      "Are you a person with a criminal record?", "Are you an individual with a criminal history?", "Are you one of those with a criminal record?",
      "Have you ever been charged?", "Are you currently on parole?", "Have you ever been on probation or parole?",
      "Do you have a clean record?", "Can you confirm you have no felony convictions?", "Are you free of felony convictions?", "Have you never been convicted?",
      "Have you served time in jail or prison?",
    ]) {
      expect(questionCheck(question)?.rule, question).toBe("asks_record");
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["Yes", "No"] }])[0], question).toMatchObject({ part: "question", rule: "asks_record" });
    }
    // rebuilt from the final check (LT-31): none of these holds production's words or a fixed phrase, so they are saved, as in production
    for (const question of [
      "Were you ever charged with a crime?", "Were you charged?", "Do you have any pending charges?", "Do you have any pending criminal charges?",
      "Do you have any fraud convictions?", "Any domestic violence convictions?", "Do you have any violent crime convictions?", "Are you an ex-felon?", "Are you a non-felon?", "Are you a registered sex offender?",
      "Is your record clean?", "Are you currently awaiting trial?",
    ]) {
      expect(questionCheck(question), question).toBeNull();
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["Yes", "No"] }]), question).toEqual([]);
    }
    // a ban's words in a help line or in what a good answer shows are refused too, never only flagged; rebuilt from the
    // final check (LT-31), the question rule reads a ban's words in every part, so it is the one that refuses them
    expect(formQuestionProblems([{ key: "cq_x", question: "Tell us about your last job.", help: "We only hire people with a clean record" }])[0]).toMatchObject({ part: "help", rule: "asks_record", text: "clean record" });
  });

  it("never refuses a question about the work with records, the people it is with, or a bill's charges, beyond production's own words", () => {
    for (const question of [
      "How do you follow up on any pending charges on a patient account?", "Do you have experience clearing any pending charges on patient accounts?", "In your last job, were you charged with opening the office?",
      "Do you have probation and parole experience?", "Are you a former probation or parole officer?", "Do you have experience with probation and parole clients?", "Have you worked with people on probation or parole?",
      "Have you helped clients convicted of a felony find housing?", "Have you handled criminal charges as a paralegal?", "Do you have experience researching criminal records?",
      "Do you have any DUI convictions?", "Can you pass a background check?",
    ]) {
      expect(questionCheck(question), question).toBeNull();
      expect(formQuestionProblems([{ key: "cq_x", question, options: ["Yes", "No"] }]), question).toEqual([]);
    }
    // rebuilt from the final check (LT-31): production's bare "criminal record" in a question refuses it, as in production
    expect(formQuestionProblems([{ key: "cq_x", question: "Have you worked with people who have a criminal record?", options: ["Yes", "No"] }])[0]).toMatchObject({ part: "question", rule: "asks_record", text: "criminal record" });
  });

  it("reads a record named on its own as a deal-breaker as the ban, and only as a deal-breaker", () => {
    for (const text of ["Felony convictions", "A criminal record", "Felons", "Criminal history", "Any convictions", "Arrest record"]) {
      expect(screenDealBreaker(text), text).toMatchObject(RULE);
      // as a must-have's own words they are no ban
      expect(screenCriterion(text), text).toBeNull();
    }
    // rebuilt from the final check (LT-31): a deal-breaker is a record named on its own only with one of the fixed leading words
    for (const text of ["Convicted of a felony", "Has a felony", "Pending charges", "Theft convictions"]) expect(screenDealBreaker(text), text).toBeNull();
    for (const text of ["DUI convictions", "Moving violations", "Must pass a background check", "Cannot pass a background check", "Criminal background check after a conditional offer", "Experience supporting clients with a criminal record", "Cannot work Saturdays", "Smokers"]) {
      expect(screenDealBreaker(text), text).toBeNull();
    }
    // the phrase list reads every deal-breaker as before
    expect(screenDealBreaker("No felons")).toEqual(screenCriterion("No felons"));
    expect(screenDealBreaker("No recent grads")?.rule).toBe("recent_graduate");
  });

  it("flags a saved job's ban as before, and a must-have in the words of a deal-breaker refused for a record, and passes fair-chance words", () => {
    // as it was saved: the description's ban was flagged under the words the rule found then, and a person kept it
    const keep = { id: "criminal_record:description.publicJobDescription:clean_record", path: "description.publicJobDescription", ...RULE, text: "clean record", kept: { reason: "Our state licensing board requires it for this role.", by: dana, at: "2026-11-01T10:00:00.000Z" } };
    const saved = packet((x) => {
      x.description.publicJobDescription += " We only hire people with a clean record. We do not hold a criminal record against anyone who wants to work.";
      x.requirements.mustHaves.push({ key: "record", text: "Felonies", rationale: "r" }, { key: "saturdays", text: "Able to work Saturdays", rationale: "r" });
      x.provenance.flags = [keep];
    });
    // the owner's deal-breaker "No felonies" was refused in the job builder; the job carries the refusal
    const declined = [{ requested: "No felonies", ...RULE }];
    const next = guardPacket(saved, { ...ctx, previousFlags: [keep], declined });
    // nothing is taken out or reworded: the job reads as it did and goes on running
    expect(next.packet.description.publicJobDescription).toBe(saved.description.publicJobDescription);
    expect(next.packet.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Felonies", "Able to work Saturdays"]);
    expect(next.changes).toEqual([]);
    // the keep holds; the must-have in the refused deal-breaker's words waits for a person
    expect(next.flags.map((f) => [f.path, f.rule, f.text, !!f.kept])).toEqual([
      ["description.publicJobDescription", "criminal_record", "clean record", true],
      ["requirements.mustHaves[1].text", "criminal_record", "Felonies", false],
    ]);
    expect(unresolvedFlags(next.packet)).toHaveLength(1);
    // with no such deal-breaker refused, the same words are no ban
    expect(guardPacket(saved, { ...ctx, previousFlags: [keep] }).flags.map((f) => f.path)).toEqual(["description.publicJobDescription"]);
    // a form question in a ban's own words is refused when it is saved, with the reason a question gets
    const problem = formQuestionProblems([{ key: "cq_record", question: "Do you have a clean record?", options: ["Yes", "No"] }]);
    expect(problem[0].words).toBe("Screening question 1: Asking about arrests or convictions on an application breaks fair-chance hiring laws in many places. Leave any background check to the end of the process, after an offer, where the law allows it.");
  });
});

// Final check of the criminal-record repair, 17 Nov 2026: the open word patterns of the fix and its repair let through
// questions and bans production refused, and refused lawful words production allowed. The rules were rebuilt (LT-31) as
// production's own two patterns, plus fixed phrases, minus a short list of fixed exceptions read the same way in every field.
describe("the criminal-record rules rebuilt from the final check: production's words, fixed phrases added, fixed exceptions taken out", () => {
  type Field = "requirement" | "deal-breaker" | "question" | "about" | "description";
  type Result = "refused" | "flagged" | "allowed";
  // the About check's rules (apps/api company-settings-profile.ts): the phrase list without the years and pay-history rules
  const ABOUT_RULES = PROXY_RULES.filter((r) => !["experience_floor", "experience_cap", "pay_history"].includes(r.rule));
  const aboutCheck = (text: string) => {
    for (const r of ABOUT_RULES) {
      const hit = r.find(text);
      if (hit) return { rule: r.rule, text: hit };
    }
    return null;
  };
  /** What a field does with the words, through the code it runs: refused where they are set, flagged on a saved job, or allowed. */
  function read(field: Field, text: string): { result: Result; rule?: string; hit?: string } {
    if (field === "question") {
      const problem = formQuestionProblems([{ key: "cq_x", question: text, options: ["Yes", "No"] }])[0];
      // one question on its own is read the same way
      expect(questionCheck(text)?.rule ?? null, `${text} (one question on its own)`).toBe(problem?.rule ?? null);
      if (problem) return { result: "refused", rule: problem.rule, hit: problem.text };
      const flag = guardPacket(packet((x) => { x.formQuestions = [{ kind: "choice", key: "cq_x", question: text, options: ["Yes", "No"], required: true }]; }), ctx).flags[0];
      return flag ? { result: "flagged", rule: flag.rule, hit: flag.text } : { result: "allowed" };
    }
    if (field === "description") {
      const flag = guardPacket(packet((x) => { x.description.publicJobDescription += ` ${text}`; }), ctx).flags[0];
      return flag ? { result: "flagged", rule: flag.rule, hit: flag.text } : { result: "allowed" };
    }
    const hit = field === "deal-breaker" ? screenDealBreaker(text) : field === "about" ? aboutCheck(text) : screenCriterion(text);
    return hit ? { result: "refused", rule: hit.rule, hit: hit.text } : { result: "allowed" };
  }

  // [the field it is typed in, the words, what happens, and for a refusal or a flag the words it is found by]
  const TABLE: Array<[Field, string, Result, string?]> = [
    // production's own words are still refused or flagged, with production's words, so a flag kept in production holds
    ["requirement", "No felons", "refused", "No felons"],
    ["requirement", "Clean record", "refused", "Clean record"],
    ["requirement", "Never been convicted", "refused", "Never been convicted"],
    ["description", "Friendly dental office in Irvine. No felonies, misdemeanors considered case by case. Great benefits.", "flagged", "No felonies"],
    ["requirement", "No felonies, misdemeanors considered case by case", "refused", "No felonies"],
    ["requirement", "No felonies - misdemeanors considered case by case", "refused", "No felonies"],
    ["requirement", "No felonies, but misdemeanors are considered case by case", "refused", "No felonies"],
    ["requirement", "Must have no felonies, misdemeanors considered case by case", "refused", "no felonies"],
    ["requirement", "No felons, minor offenses excluded", "refused", "No felons"],
    ["requirement", "No felonies, juvenile records excluded", "refused", "No felonies"],
    ["requirement", "No felons, arrests not counted against you", "refused", "No felons"],
    ["requirement", "No felonies, failure to disclose will disqualify you", "refused", "No felonies"],
    ["requirement", "No felonies, any conviction will disqualify you", "refused", "No felonies"],
    ["deal-breaker", "Never been convicted, misdemeanors ok", "refused", "Never been convicted"],
    ["about", "No felons, barring exceptional circumstances", "refused", "No felons"],
    ["requirement", "Must have a clean record of at least 7 years", "refused", "clean record"],
    ["description", "Must have a clean record of at least 7 years.", "flagged", "clean record"],
    ["requirement", "Clean criminal record of 10 years required", "refused", "Clean criminal record"],
    ["requirement", "A clean background of at least five years", "refused", "clean background"],
    ["requirement", "We hire local residents with no criminal record.", "refused", "no criminal record"],
    ["deal-breaker", "Teens with no criminal record", "refused", "no criminal record"],
    ["about", "We only hire students with a clean record.", "refused", "clean record"],
    ["requirement", "Students who have never been convicted", "refused", "never been convicted"],
    ["description", "Summer jobs for teens with no criminal record.", "flagged", "no criminal record"],
    ["requirement", "Youths with no felonies", "refused", "no felonies"],
    ["about", "Open to college students with no criminal background", "refused", "no criminal background"],
    ["requirement", "Residents with no arrests", "refused", "no arrests"],
    ["requirement", "No convictions for DUI", "refused", "No convictions"],
    ["question", "Have you ever been charged with or convicted of a crime?", "refused", "Have you ever been charged"],
    ["question", "Have you ever been charged with, or convicted of, a crime?", "refused", "Have you ever been charged"],
    ["question", "Have you been charged with or convicted of a crime in the past 7 years?", "refused", "Have you been charged"],
    ["question", "Have you ever been charged with anything?", "refused", "Have you ever been charged"],
    ["question", "Have you ever been charged with a criminal act?", "refused", "Have you ever been charged"],
    ["question", "Have you ever been charged with sexual misconduct?", "refused", "Have you ever been charged"],
    ["question", "Have you ever been charged by the police?", "refused", "Have you ever been charged"],
    ["question", "Have you been charged in the last 7 years?", "refused", "Have you been charged"],
    ["question", "Have you ever been charged or arrested?", "refused", "Have you ever been charged"],
    ["question", "Have you been convicted of a DUI?", "refused", "Have you been convicted"],
    ["question", "Applicants with a criminal record: please explain below.", "refused", "criminal record"],
    ["question", "Candidates who have a criminal history should describe it here.", "refused", "criminal history"],
    ["question", "Applicants with any felony convictions must list them.", "refused", "any felony"],
    ["question", "If you are a person with a criminal record, please explain.", "refused", "criminal record"],
    ["question", "If you're a person with a criminal record, please explain.", "refused", "criminal record"],
    ["question", "If you are an applicant with a criminal background, tell us about it.", "refused", "criminal background"],
    ["question", "As an applicant with a criminal record, explain what happened.", "refused", "criminal record"],
    ["question", "Employees with a criminal record must tell us.", "refused", "criminal record"],
    ["question", "Workers with any convictions must list them below.", "refused", "any convictions"],
    ["question", "Applicants with a criminal record must explain the conviction here.", "refused", "criminal record"],
    ["question", "Candidates with any felony convictions must list them here.", "refused", "any felony"],
    ["question", "Applicants with any arrests in the past 7 years must list them.", "refused", "any arrests"],
    ["question", "Candidates with a criminal history, please give details.", "refused", "criminal history"],
    ["question", "Workers with any felony convictions must list them below.", "refused", "any felony"],
    ["question", "If you are an applicant with a criminal record, explain it here.", "refused", "criminal record"],
    ["question", "Those with a criminal record must explain it here.", "refused", "criminal record"],
    ["question", "Please review any criminal convictions you may have and list them.", "refused", "any criminal convictions"],
    ["question", "Please verify any convictions you have.", "refused", "any convictions"],
    ["question", "Can we run a criminal background check before your interview?", "refused", "criminal background"],
    ["question", "Will you allow us to perform a criminal background check before we meet?", "refused", "criminal background"],
    ["question", "Do you authorize us to conduct a criminal background check?", "refused", "criminal background"],
    ["question", "Do you consent to us running a criminal background check?", "refused", "criminal background"],
    ["question", "Do you authorize us to obtain any criminal history?", "refused", "any criminal history"],
    ["question", "Have you experienced any arrests?", "refused", "any arrests"],
    ["question", "Have you experienced any convictions in the last 7 years?", "refused", "any convictions"],
    ["question", "Do you have experience supporting clients with a criminal record?", "refused", "criminal record"],
    // a question in a ban's words is refused, never only flagged as production did
    ["question", "Do you have a clean record?", "refused", "clean record"],
    ["question", "Do you have a clean record with the DMV?", "refused", "clean record"],
    ["question", "Can you confirm you have no felony convictions?", "refused", "no felony"],

    // the fixed phrases added to the ban: a record after "no", "without", "never", "must not have", "cannot have",
    // "may not have" or "free of"
    ["requirement", "No felony convictions", "refused", "No felony"],
    ["requirement", "Without a criminal record", "refused", "Without a criminal record"],
    ["requirement", "Never any arrests", "refused", "Never any arrests"],
    ["requirement", "Never a felony conviction", "refused", "Never a felony"],
    // after "never" English always puts "a", "an" or "any" before the record, so a bare "never arrest" is the verb
    ["description", "Officers never arrest or detain customers.", "allowed"],
    ["requirement", "Must not have any convictions", "refused", "Must not have any convictions"],
    ["deal-breaker", "Cannot have a criminal record", "refused", "Cannot have a criminal record"],
    ["requirement", "Can't have any misdemeanors", "refused", "Can't have any misdemeanors"],
    ["requirement", "Can not have a felony", "refused", "Can not have a felony"],
    ["about", "Our staff may not have any criminal charges.", "refused", "may not have any criminal charges"],
    ["requirement", "Free of criminal convictions", "refused", "Free of criminal convictions"],
    ["requirement", "Without an arrest in the last 7 years", "refused", "Without an arrest"],
    // its "-free" forms
    ["requirement", "Felony-free", "refused", "Felony-free"],
    ["requirement", "Conviction-free", "refused", "Conviction-free"],
    ["description", "All our staff are felon-free.", "flagged", "felon-free"],
    ["requirement", "Arrest-free", "refused", "Arrest-free"],
    // and the whole bans
    ["requirement", "No ex-felons", "refused", "No ex-felons"],
    ["requirement", "No ex-offenders", "refused", "No ex-offenders"],
    ["deal-breaker", "No parolees", "refused", "No parolees"],
    ["requirement", "Felons need not apply", "refused", "Felons need not apply"],
    ["about", "Felons may not apply.", "refused", "Felons may not apply"],
    ["requirement", "Not a convicted felon", "refused", "Not a convicted felon"],
    ["requirement", "Must not be a convicted felon", "refused", "not be a convicted felon"],
    ["requirement", "Must not be on parole", "refused", "Must not be on parole"],
    ["requirement", "Must not be on probation or parole", "refused", "Must not be on probation or parole"],
    ["requirement", "Must never have been convicted of a felony", "refused", "never have been convicted"],
    ["requirement", "Has not been convicted of a felony", "refused", "Has not been convicted of a felony"],
    ["about", "A felony conviction will disqualify you.", "refused", "A felony conviction will disqualify"],
    ["requirement", "A felony conviction will result in disqualification", "refused", "felony conviction will result in disqualification"],
    ["requirement", "Will not hire felons", "refused", "Will not hire felons"],
    ["description", "We won't hire felons.", "flagged", "won't hire felons"],
    ["requirement", "We do not hire felons", "refused", "do not hire felons"],

    // a deal-breaker whose whole words are a record, with at most one fixed leading word and a time window
    ["deal-breaker", "Felony convictions", "refused", "Felony convictions"],
    ["deal-breaker", "A criminal record", "refused", "A criminal record"],
    ["deal-breaker", "Criminal history", "refused", "Criminal history"],
    ["deal-breaker", "Anyone with a felony", "refused", "Anyone with a felony"],
    ["deal-breaker", "People with criminal records", "refused", "People with criminal records"],
    ["deal-breaker", "Those with a criminal record", "refused", "Those with a criminal record"],
    ["deal-breaker", "Applicants with felony convictions", "refused", "Applicants with felony convictions"],
    ["deal-breaker", "Having a criminal record", "refused", "Having a criminal record"],
    ["deal-breaker", "Anyone convicted of a felony", "refused", "Anyone convicted of a felony"],
    ["deal-breaker", "On probation or parole", "refused", "On probation or parole"],
    ["deal-breaker", "Felony convictions in the last 7 years", "refused", "Felony convictions in the last 7 years"],
    ["requirement", "Felony convictions", "allowed"],

    // the fixed phrases added to the question
    ["question", "Are you a convicted felon?", "refused", "Are you a convicted felon"],
    ["question", "Are you currently on parole?", "refused", "Are you currently on parole"],
    ["question", "Are you on probation or parole?", "refused", "Are you on probation or parole"],
    ["question", "Have you ever been on probation or parole?", "refused", "Have you ever been on probation or parole"],
    ["question", "Have you ever spent time in jail or prison?", "refused", "spent time in jail"],
    ["question", "Have you served time in prison?", "refused", "served time in prison"],
    ["question", "Have you ever been in trouble with the law?", "refused", "trouble with the law"],
    ["question", "Do you have any criminal records?", "refused", "any criminal records"],

    // the exceptions, the same in every field: fair-chance statements and a record that is the work's own
    ["question", "With or without a criminal record, you are welcome to apply.", "allowed"],
    ["requirement", "With or without a criminal record, you are welcome to apply.", "allowed"],
    ["question", "A criminal record does not automatically disqualify you.", "allowed"],
    ["about", "No conviction automatically disqualifies you.", "allowed"],
    ["requirement", "No felony or misdemeanor conviction will disqualify you", "allowed"],
    ["about", "No felony, misdemeanor or arrest will automatically disqualify you.", "allowed"],
    ["about", "No felony conviction will be considered disqualifying.", "allowed"],
    ["about", "Brightline Dental is a second-chance employer in Irvine. Applicants with a criminal record will not be considered ineligible for that reason alone.", "allowed"],
    ["question", "Applicants with a criminal record will not be considered ineligible.", "allowed"],
    ["about", "We are a second-chance employer, and we never refuse to hire people with criminal records.", "allowed"],
    ["question", "We never refuse to hire people with a criminal record.", "allowed"],
    ["requirement", "Arrests without a conviction are never considered", "allowed"],
    ["requirement", "You don't have to be felony-free to apply", "allowed"],
    ["about", "Felony-free isn't a requirement here.", "allowed"],
    ["about", "We have no felony restrictions.", "allowed"],
    ["requirement", "Keep a clean record of patient charts", "allowed"],
    ["description", "Keep a clean record of patient charts.", "allowed"],

    // allowed, as in production: a check after an offer, the work with people who have a record or with records, and
    // lawful words that hold a record word
    ["requirement", "Background check after a conditional offer", "allowed"],
    ["requirement", "Offer contingent on a background check", "allowed"],
    ["requirement", "No background check until after an offer", "allowed"],
    ["requirement", "Experience supporting clients with a criminal record", "allowed"],
    ["description", "You will support clients with a criminal record as they return to work.", "allowed"],
    ["requirement", "Maintain patient records", "allowed"],
    ["deal-breaker", "Criminal records research experience", "allowed"],
    ["requirement", "Must pass a background check", "allowed"],
    ["question", "In your last job, were you charged with opening the office?", "allowed"],
    ["question", "Have you received any cardiac arrest training?", "allowed"],
    ["question", "Is your cardiac arrest certification current?", "allowed"],
    ["question", "Describe your caries arrest protocol for young patients.", "allowed"],
    ["question", "Have you responded to any cardiac arrests at work?", "allowed"],
    ["question", "Have you made any citizen's arrests as a security guard?", "allowed"],
    ["question", "What are your personal convictions about patient care?", "allowed"],
    ["requirement", "Without a current cardiac arrest certification", "allowed"],
    ["requirement", "No cardiac arrest training required; we train on BLS.", "allowed"],
    ["deal-breaker", "Cardiac arrest response training", "allowed"],
    ["question", "Are you a criminal justice student?", "allowed"],
    ["question", "Are you a criminal justice student or graduate?", "allowed"],
    ["question", "Are you a criminal defense attorney?", "allowed"],
    ["question", "Have you worked with someone on parole?", "allowed"],
    ["question", "Have you ever worked with someone on probation or parole?", "allowed"],
    ["question", "Have you helped anyone convicted of a crime find work?", "allowed"],
    ["question", "Are you comfortable working alongside coworkers who have criminal records?", "allowed"],
    ["question", "Are you familiar with state criminal records databases?", "allowed"],
    ["question", "Have you handled medical or criminal records?", "allowed"],
    ["question", "Have you ever worked as a criminal records clerk?", "allowed"],
    ["question", "Do you have experience reading criminal records?", "allowed"],
    ["question", "Do you have arrest powers?", "allowed"],
    ["question", "Do you have arrest and detention training?", "allowed"],
    ["question", "Are you on probation right now at your current job?", "allowed"],
    // in no fixed phrase and not in production's words, so saved, as in production
    ["question", "Applicants who have been convicted of a felony: please describe the conviction.", "allowed"],
    ["question", "Applicants on probation or parole must tell us.", "allowed"],
    ["about", "We do not consider people with records to be a risk.", "allowed"],
    ["about", "We don't consider ex-offenders a risk.", "allowed"],
    ["about", "Felons are not considered unqualified.", "allowed"],
    ["about", "We won't refuse to hire anyone with a past conviction.", "allowed"],
    ["about", "Does a criminal record disqualify you? No, we look at each person.", "allowed"],
    ["about", "Q: Do convictions disqualify applicants? A: No.", "allowed"],
    ["about", "We do not have a felony ban.", "allowed"],
    ["about", "You do not need a spotless record to join our team.", "allowed"],
    ["about", "A spotless record isn't required.", "allowed"],
    ["about", "We have a spotless record with the health department.", "allowed"],
    ["about", "Our company has an unblemished record with the Better Business Bureau.", "allowed"],
    ["about", "We have never been charged with a health code violation.", "allowed"],
    ["about", "No sealed or expunged convictions will be considered.", "allowed"],
    ["about", "No expunged convictions will be considered.", "allowed"],
    ["about", "No juvenile convictions will be considered.", "allowed"],
    ["about", "No juvenile convictions are considered.", "allowed"],
    ["about", "Applicants with criminal histories are not considered ineligible.", "allowed"],
    ["about", "People with a criminal record will not be considered less favorably.", "allowed"],
    ["about", "No one with a criminal record will be considered ineligible for that reason alone.", "allowed"],

    // the driving record: nothing is refused only for a DUI, a DWI, traffic or moving violations or a driving record
    ["requirement", "Clean driving record", "allowed"],
    ["question", "Do you have a clean driving record?", "allowed"],
    ["requirement", "Valid driver's licence", "allowed"],
    ["requirement", "No DUI convictions", "allowed"],
    ["requirement", "No moving violations", "allowed"],
    ["deal-breaker", "DUI convictions", "allowed"],
    ["deal-breaker", "Convictions for DUI in the last 5 years", "allowed"],
    ["deal-breaker", "A conviction for DUI", "allowed"],
    ["deal-breaker", "Arrests for DUI", "allowed"],
    ["deal-breaker", "Convicted of a DUI", "allowed"],
    ["deal-breaker", "Convicted of DUI", "allowed"],
    ["deal-breaker", "Charged with DUI", "allowed"],
    ["deal-breaker", "Convictions for reckless driving", "allowed"],
    ["deal-breaker", "Offenses on driving record", "allowed"],
    ["deal-breaker", "Convictions found in the background check after a conditional offer", "allowed"],
    ["requirement", "Must not have been convicted of a DUI", "allowed"],
    ["requirement", "Has not been convicted of a DUI in 5 years", "allowed"],
    ["requirement", "Never charged with a DUI", "allowed"],
    ["requirement", "Without convictions for DUI", "allowed"],
    ["requirement", "A conviction-free driving record", "allowed"],
    ["requirement", "Must never have been convicted of a DUI", "allowed"],
    ["question", "Do you have any DUI convictions?", "allowed"],
  ];

  for (const [field, text, result, hit] of TABLE) {
    it(`${field}: "${text}" is ${result}`, () => {
      const got = read(field, text);
      expect(got.result).toBe(result);
      if (result !== "allowed") expect(got).toMatchObject({ rule: field === "question" ? "asks_record" : "criminal_record", ...(hit ? { hit } : {}) });
    });
  }

  it("keeps a flag kept in production: the same words, so the same id", () => {
    const reason = "A blanket ban on criminal records breaks fair-chance hiring laws in many places.";
    const alternative = "Leave any background check to the end of the process, after an offer, where the law allows it.";
    const keep = { id: "criminal_record:description.publicJobDescription:no_felonies", path: "description.publicJobDescription", rule: "criminal_record", reason, alternative, text: "No felonies", kept: { reason: "State law bars anyone with a felony from this licensed role.", by: dana, at: "2026-11-01T10:00:00.000Z" } };
    const saved = packet((x) => {
      x.description.publicJobDescription += " No felonies, misdemeanors considered case by case.";
      x.provenance.flags = [keep];
    });
    const next = guardPacket(saved, { ...ctx, previousFlags: [keep] });
    expect(next.flags.map((f) => [f.id, !!f.kept])).toEqual([["criminal_record:description.publicJobDescription:no_felonies", true]]);
    expect(unresolvedFlags(next.packet)).toEqual([]);
  });

  it("refuses an answer offered in a ban's words, as a question in them, and passes a driving record's own words", () => {
    const problems = formQuestionProblems([{ key: "cq_driving", question: "How would you describe your driving record?", options: ["Clean record", "One or two tickets", "Clean driving record"] }]);
    expect(problems.map((p) => [p.part, p.rule, p.text])).toEqual([["option", "asks_record", "Clean record"]]);
  });
});

describe("a text written from a saved job (a LinkedIn post, an Indeed listing) is held to the job description's rules", () => {
  const job = (over: (p: RolePacket) => void = () => {}) => {
    const p = guardPacket(packet(over), ctx).packet;
    return { compensation: p.compensation, benefits: p.compensation.benefitsSummary ?? null, provenance: p.provenance };
  };

  it("passes plain words, the job's own pay however it is written, and a figure from its benefits line", () => {
    const plain = job((x) => { x.compensation.benefitsSummary = "Health cover and a $500 uniform allowance"; });
    for (const line of ["We are hiring a hygienist in Irvine.", "Pay: $45–$55 an hour", "$45.00 to $55.00 an hour, full time", "- $500 uniform allowance", "Over 50 patients a week, Monday to Friday"]) expect(wordingProblems(line, plain), line).toEqual([]);
    expect(wordingProblems("Salary $90k to $110,000 a year", { compensation: { min: 90000, max: 110000 }, provenance: {} })).toEqual([]);
  });

  it("finds wording that stands in for a protected trait, with the rule, the words and the reason", () => {
    expect(wordingProblems("Recent graduates welcome, and no criminal record.", job()).map((p) => [p.rule, p.text])).toEqual([["recent_graduate", "Recent graduates"], ["criminal_record", "no criminal record"]]);
    const [age] = wordingProblems("A young team, ages 22 to 30.", job());
    expect(age).toMatchObject({ rule: "age", reason: "Age, and wording that stands in for age, cannot be a hiring requirement." });
  });

  it("finds a pay figure that is neither the job's range nor in its benefits line", () => {
    expect(wordingProblems("Earn up to $70 an hour, with a $1,000 sign-on bonus.", job()).map((p) => [p.rule, p.text])).toEqual([["pay_mismatch", "$70"], ["pay_mismatch", "$1,000"]]);
    expect(wordingProblems("A $1,000 sign-on bonus.", job((x) => { x.compensation.benefitsSummary = "A $1,000 sign-on bonus"; }))).toEqual([]);
  });

  it("finds what the owner was told could not be used, reworded as a must-have too", () => {
    const declined = job((x) => { x.provenance.declinedCriteria = [{ requested: "No visa permit", reason: "Visa status cannot be a requirement." }]; });
    expect(wordingProblems("- Visa permit", declined).map((p) => [p.rule, p.text, p.reason])).toEqual([["declined", "No visa permit", "Visa status cannot be a requirement."]]);
    expect(wordingProblems("- Active CA RDH license", declined)).toEqual([]);
  });

  it("passes wording a person kept in the job with a reason, and only that wording", () => {
    const flagged = guardPacket(packet((x) => { x.requirements.mustHaves[0].text = "10+ years of experience as a hygienist"; }), ctx);
    const [flag] = flagged.flags;
    expect(flag.rule).toBe("experience_floor");
    const open = { compensation: flagged.packet.compensation, provenance: flagged.packet.provenance };
    expect(wordingProblems(`- ${flag.text}`, open).map((p) => p.rule)).toEqual(["experience_floor"]);
    const kept = guardPacket(packet((x) => { x.requirements.mustHaves[0].text = "10+ years of experience as a hygienist"; x.provenance.flags = [{ ...flag, keepReason: "The lead hygienist trains the others." }]; }), { ...ctx, actor: dana }).packet;
    expect(wordingProblems(`- ${flag.text}`, { compensation: kept.compensation, provenance: kept.provenance })).toEqual([]);
    expect(wordingProblems("- 15+ years of experience", { compensation: kept.compensation, provenance: kept.provenance }).map((p) => p.rule)).toEqual(["experience_floor"]);
  });
});
