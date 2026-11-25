import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@ros/ai";
import type { EvidenceAssessment } from "@ros/contracts";
import { DATED_JOB_LINE, applyEvidenceRules, assessmentSources, combineOutcomes, combineReadings, combineRunOutcomes, credentialFinding, credentialMustHaves, findingSubjects, formAnswerSaysNotHeld, liftableQuote, plainlyNotHeld, readingsOutcome, shownNotHeld, skillFloor, verifyAssessmentQuotes } from "./triage";

/**
 * One resume read three times can come back three ways, and an expired licence was "unknown" in two readings of three
 * although each quoted "expired". Three readings and their middle answer, and the expired-credential rule in code, make
 * the same application read the same each time. Two things found in review are pinned here: the rule overturning "yes"
 * on "never lapsed", and a skipped finding letting one "no" win.
 */
const RESUME = "Casey Morgan, RDH\nRegistered Dental Hygienist at Bayside Dental 2016 - 2021\nRDH license CA expired in 2021; renewal not started\nScaling and root planing, patient education";

type Met = EvidenceAssessment["requirementFindings"][number]["met"];
type Found = EvidenceAssessment["competencyFindings"][number]["finding"];

const reading = (licence: Met | null, perio: Met, chairside: Found, over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  summary: `licence ${licence}, perio ${perio}, chairside ${chairside}`,
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [{ competencyKey: "chairside", finding: chairside, evidence: { source: "resume", quote: "Scaling and root planing" } }],
  requirementFindings: [
    ...(licence === null ? [] : [{ requirementKey: "licence", met: licence, ...(licence === "unknown" ? {} : { evidence: { source: "resume" as const, quote: "RDH license CA expired in 2021" } }) }]),
    { requirementKey: "perio", met: perio, evidence: { source: "resume", quote: "Scaling and root planing" } },
  ],
  ...over,
});

const metOf = (a: EvidenceAssessment, key: string) => a.requirementFindings.find((f) => f.requirementKey === key)?.met;
const decided = (a: EvidenceAssessment) => ({ met: a.requirementFindings.map((f) => `${f.requirementKey}:${f.met}`), found: a.competencyFindings.map((f) => `${f.competencyKey}:${f.finding}`), summary: a.summary });

describe("three readings of the same application", () => {
  it("keep the middle answer of each finding, with the evidence of a reading that gave it", () => {
    const out = combineReadings([reading("no", "yes", "evidenced"), reading("no", "partially", "partially_evidenced"), reading("no", "yes", "evidenced")]);
    expect(metOf(out, "perio")).toBe("yes");
    expect(out.competencyFindings).toEqual([{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Scaling and root planing" } }]);
    // all three different: the middle on the order no, unknown, partially, yes
    expect(metOf(combineReadings([reading("no", "yes", "evidenced"), reading("no", "unknown", "evidenced"), reading("no", "partially", "evidenced")]), "perio")).toBe("partially");
  });

  it("count a finding a reading left out as unknown, so one reading's 'no' never outvotes two that said nothing", () => {
    const out = combineReadings([reading("no", "yes", "evidenced"), reading(null, "yes", "evidenced"), reading(null, "yes", "evidenced")]);
    expect(metOf(out, "licence")).toBe("unknown");
    expect(out.requirementFindings.find((f) => f.requirementKey === "licence")).toEqual({ requirementKey: "licence", met: "unknown" });
    // one "yes" and two silent: unknown too; two "yes" and one silent: yes
    expect(metOf(combineReadings([reading("yes", "yes", "evidenced"), reading(null, "yes", "evidenced"), reading(null, "yes", "evidenced")]), "licence")).toBe("unknown");
    expect(metOf(combineReadings([reading("yes", "yes", "evidenced"), reading("yes", "yes", "evidenced"), reading(null, "yes", "evidenced")]), "licence")).toBe("yes");
    // a key written twice in one reading still counts once
    const twice = reading("no", "yes", "evidenced");
    twice.requirementFindings.push({ requirementKey: "licence", met: "no", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } });
    expect(metOf(combineReadings([twice, reading("yes", "yes", "evidenced"), reading("yes", "yes", "evidenced")]), "licence")).toBe("yes");
  });

  it("read exactly the same whatever order the readings come back in, with the words of one reading", () => {
    const a = reading("no", "yes", "evidenced", { summary: "a" });
    const b = reading("unknown", "partially", "partially_evidenced", { summary: "b" });
    const c = reading("no", "yes", "partially_evidenced", { summary: "c" });
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]].map((o) => decided(combineReadings(o)));
    for (const o of orders) expect(o).toEqual(orders[0]);
    expect(orders[0]).toMatchObject({ met: ["licence:no", "perio:yes"], found: ["chairside:partially_evidenced"] });
    expect(["a", "b", "c"]).toContain(orders[0]!.summary);
  });

  it("use the first reading when fewer than three came back, and fail on an outage so the step is retried", () => {
    const sources = { resume: RESUME };
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    const invalid: RunOutcome<EvidenceAssessment> = { ok: false, runId: "r8", model: "m", reason: "invalid", error: "no valid output" };
    const outage: RunOutcome<EvidenceAssessment> = { ok: false, runId: "r9", model: "m", reason: "error", error: "provider error: 529" };
    const two = combineOutcomes([invalid, ok(reading("no", "yes", "evidenced"), "r2"), ok(reading("no", "partially", "evidenced"), "r3")], sources);
    expect(two).toMatchObject({ ok: true, runId: "r2" });
    if (two.ok) expect(metOf(two.output, "perio")).toBe("yes");
    expect(combineOutcomes([invalid, outage, invalid], sources)).toBe(outage);
    expect(combineOutcomes([invalid, invalid, invalid], sources)).toBe(invalid);
  });
});

describe("a skill one reading showed on a checked quote (Wave S9 round 4)", () => {
  const DUTY = "Scaling and root planing, patient education";
  const PLAIN_NO_LINE = "I do not hold a California RDH license";
  const JOB_LINE = "Registered Dental Hygienist at Bayside Dental 2016 - 2021";
  const FORM_LINE = "Do you hold an active CA RDH license? Yes.";
  /** The said_plainly CV of the fairness evals (packages/evals `credentialCases`). */
  const PLAIN_NO = `Drew Park\nAnaheim, CA\n${JOB_LINE}\nA.S. Dental Hygiene, Cypress College\n${PLAIN_NO_LINE}\n${DUTY}`;
  const PACKET = {
    requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law" }, { key: "perio", text: "Periodontal therapy", rationale: "work" }], niceToHaves: [] },
    formQuestions: [{ kind: "yes_no", key: "el_license", question: "Do you hold an active CA RDH license?", required: true }],
    competencies: [
      { key: "clinical", name: "Clinical care", definition: "Thorough, gentle periodontal care.", importance: "essential", indicators: ["charts accurately"] },
      { key: "patients", name: "Patient communication", definition: "Explains care plainly and builds trust.", importance: "essential", indicators: ["explains findings"] },
    ],
  } as never;
  type Skill = EvidenceAssessment["competencyFindings"][number];
  type Must = EvidenceAssessment["requirementFindings"][number];
  const skill = (key: string, finding: Found, quote?: string, source: "resume" | "application" = "resume"): Skill => ({ competencyKey: key, finding, ...(quote ? { evidence: { source, quote } } : {}) });
  const plainNo: Must = { requirementKey: "licence", met: "no", evidence: { source: "resume", quote: PLAIN_NO_LINE } };
  const perioPartly: Must = { requirementKey: "perio", met: "partially", evidence: { source: "resume", quote: DUTY } };
  const read = (clinical: Skill, patients: Skill, requirementFindings: Must[] = [plainNo, perioPartly], over: Partial<EvidenceAssessment> = {}): EvidenceAssessment =>
    reading(null, "unknown", "not_evidenced", { requirementFindings, competencyFindings: [clinical, patients], summary: `${clinical.finding}/${patients.finding}`, ...over });
  const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
  const view = { restore: (s: string) => s };
  const input = (resumeText: string) => ({ packet: PACKET, resumeText, formAnswers: { el_license: "yes" } });
  const outcome = (readings: readonly EvidenceAssessment[], resumeText = PLAIN_NO) => {
    const out = readingsOutcome(readings.map((r, i) => ok(r, `r${i}`)), view, input(resumeText));
    if (!out.ok) throw new Error("expected readings");
    return out.output;
  };
  const skillOf = (a: EvidenceAssessment, key: string) => a.competencyFindings.find((f) => f.competencyKey === key);
  const orders = <T>(xs: readonly [T, T, T]): T[][] => {
    const [a, b, c] = xs;
    return [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  };
  const shownOnDuty = read(skill("clinical", "partially_evidenced", DUTY), skill("patients", "not_evidenced"));
  const noneShown = read(skill("clinical", "not_evidenced"), skill("patients", "not_evidenced"));

  it("settles a duty line one reading of three showed at partly shown, the same in every order", () => {
    const outs = orders([shownOnDuty, noneShown, noneShown]).map((o) => outcome(o));
    for (const out of outs) {
      expect(skillOf(out, "clinical")).toEqual({ competencyKey: "clinical", finding: "partially_evidenced", evidence: { source: "resume", quote: DUTY } });
      expect(skillOf(out, "patients")?.finding).toBe("not_evidenced");
      expect(out.requirementFindings.map((f) => `${f.requirementKey}:${f.met}`)).toEqual(["licence:no", "perio:partially"]);
      expect(out.competencyFindings).toEqual(outs[0]!.competencyFindings);
      expect(decided(out)).toEqual(decided(outs[0]!));
    }
  });

  it("lifts a skill one reading showed in full to partly shown, never to shown", () => {
    const full = read(skill("clinical", "evidenced", DUTY, "resume"), skill("patients", "not_evidenced"), [plainNo, perioPartly]);
    full.competencyFindings[0] = { ...full.competencyFindings[0]!, note: "the reading's own note" };
    for (const o of orders([full, noneShown, noneShown])) {
      // the note of a reading that said shown is not kept: it would say more than partly shown
      expect(skillOf(outcome(o), "clinical")).toEqual({ competencyKey: "clinical", finding: "partially_evidenced", evidence: { source: "resume", quote: DUTY } });
    }
    // a reading that said partly shown keeps its note
    const noted = read(skill("clinical", "partially_evidenced", DUTY), skill("patients", "not_evidenced"));
    noted.competencyFindings[0] = { ...noted.competencyFindings[0]!, note: "names the procedure only" };
    expect(skillOf(outcome([noneShown, noted, noneShown]), "clinical")).toMatchObject({ finding: "partially_evidenced", note: "names the procedure only" });
  });

  it("never lifts over a checked 'contradicted', and leaves every other middle answer as it was", () => {
    const against = read(skill("clinical", "contradicted", "A.S. Dental Hygiene, Cypress College"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([against, noneShown, shownOnDuty]), "clinical")?.finding).toBe("not_evidenced");
    expect(skillOf(outcome([against, against, shownOnDuty]), "clinical")?.finding).toBe("contradicted");
    expect(skillOf(outcome([shownOnDuty, shownOnDuty, noneShown]), "clinical")?.finding).toBe("partially_evidenced");
    // a "contradicted" with nothing quoted is no evidence against them, so it does not stop the floor
    const saidAgainst = read(skill("clinical", "contradicted"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([saidAgainst, noneShown, shownOnDuty]), "clinical")?.finding).toBe("partially_evidenced");
  });

  it("never lifts on a quote that failed the check or says too little", () => {
    const invented = read(skill("clinical", "partially_evidenced", "Led the periodontal program for six years"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([invented, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
    const thin = read(skill("clinical", "partially_evidenced", "Dentrix"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([thin, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
    // one word that is in the résumé is still too little
    const oneWord = read(skill("clinical", "partially_evidenced", "Scaling"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([oneWord, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
  });

  it("never lifts on a dated job line or a yes/no answer on the form", () => {
    const jobLine = read(skill("clinical", "partially_evidenced", JOB_LINE), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([jobLine, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
    // a part of the job line is read with the whole line
    const employer = read(skill("clinical", "partially_evidenced", "Registered Dental Hygienist at Bayside Dental"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([employer, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
    const formLine = read(skill("clinical", "partially_evidenced", FORM_LINE, "application"), skill("patients", "not_evidenced"));
    expect(skillOf(outcome([formLine, noneShown, noneShown]), "clinical")?.finding).toBe("not_evidenced");
    // both quotes pass the check: it is the floor's own rule that keeps them from lifting the skill
    const sources = assessmentSources(input(PLAIN_NO));
    expect(sources.application).toContain(FORM_LINE);
    const settled = [skill("clinical", "not_evidenced"), skill("patients", "not_evidenced")];
    for (const shown of [jobLine, formLine]) {
      const checked = verifyAssessmentQuotes(shown, sources);
      expect(checked.competencyFindings[0]?.evidence?.unquoted).toBeUndefined();
      expect(skillFloor(settled, [checked, noneShown, noneShown], () => true)[0]?.finding).toBe("partially_evidenced");
      expect(skillFloor(settled, [checked, noneShown, noneShown], liftableQuote(sources))[0]?.finding).toBe("not_evidenced");
    }
  });

  it("never floors a must-have", () => {
    const active = PLAIN_NO.replace(PLAIN_NO_LINE, "RDH license CA active");
    const licence = (met: Must["met"]): Must => ({ requirementKey: "licence", met, ...(met === "yes" ? { evidence: { source: "resume", quote: "RDH license CA active" } } : {}) });
    const unknownLicence = read(skill("clinical", "not_evidenced"), skill("patients", "not_evidenced"), [licence("unknown"), perioPartly]);
    const yesLicence = read(skill("clinical", "not_evidenced"), skill("patients", "not_evidenced"), [licence("yes"), perioPartly]);
    for (const o of orders([unknownLicence, unknownLicence, yesLicence])) expect(metOf(outcome(o, active), "licence")).toBe("unknown");
  });


  it("leaves a plain middle answer alone where no floor is asked for", () => {
    const runs = [ok(noneShown, "r1"), ok(noneShown, "r2"), ok(shownOnDuty, "r3")];
    const out = combineRunOutcomes(runs, (r) => r, 3);
    expect(out.ok && skillOf(out.output, "clinical")?.finding).toBe("not_evidenced");
    expect(combineReadings([noneShown, noneShown, shownOnDuty]).competencyFindings.map((f) => f.finding)).toEqual(["not_evidenced", "not_evidenced"]);
  });

  it("uses the first reading as before when fewer than three came back", () => {
    const invalid: RunOutcome<EvidenceAssessment> = { ok: false, runId: "rx", model: "m", reason: "invalid", error: "no valid output" };
    const out = readingsOutcome([invalid, ok(noneShown, "r1"), ok(shownOnDuty, "r2")], view, input(PLAIN_NO));
    expect(out.ok && skillOf(out.output, "clinical")?.finding).toBe("not_evidenced");
  });

  it("reads which quotes may lift a skill from the candidate's whole line", () => {
    const resume = ["Hygienist at Harbor Dental 2016 - 2021", "Hygienist at Pacific Smiles 2019 – Present", "Dental Assistant at Sunrise 2014 to 2019", DUTY, "Graduated 2015, A.S. Dental Hygiene"].join("\n");
    const written = "I chart perio for about eight patients a day and teach home care to each of them";
    const application = [written, FORM_LINE, "Can you work the posted schedule? No.", "Which practice software have you used? Dentrix and Eaglesoft every day."].join("\n");
    const liftable = liftableQuote({ resume, application, candidate_statement: written });
    const at = (quote: string, source: "resume" | "application" | "candidate_statement" = "resume") => liftable({ source, quote });
    for (const q of ["Hygienist at Harbor Dental 2016 - 2021", "Hygienist at Pacific Smiles", "Dental Assistant at Sunrise 2014 to 2019"]) expect(at(q), q).toBe(false);
    for (const q of [DUTY, "Graduated 2015, A.S. Dental Hygiene"]) expect(at(q), q).toBe(true);
    expect(at("I chart perio for about eight patients a day", "application")).toBe(true);
    expect(at("teach home care to each of them", "candidate_statement")).toBe(true);
    expect(at(FORM_LINE, "application")).toBe(false);
    expect(at("Can you work the posted schedule? No.", "application")).toBe(false);
    expect(at("Which practice software have you used? Dentrix and Eaglesoft every day.", "application")).toBe(true);
    // a quote whose line is not found is read alone
    expect(at("Hygienist at Coastal Dental 2020 - now")).toBe(false);
    for (const s of ["2016 - 2021", "2019 – Present", "2014 to 2019", "2018—current", "2020 until today"]) expect(DATED_JOB_LINE.test(s), s).toBe(true);
    for (const s of ["Graduated 2015", "2,019 patients", "since 2019"]) expect(DATED_JOB_LINE.test(s), s).toBe(false);
  });
});

describe("a credential the candidate's own words show is not held", () => {
  it("is read from expired, lapsed, inactive, revoked, suspended or not renewed, never when negated or held again", () => {
    for (const q of ["RDH license CA expired in 2021; renewal not started", "License lapsed 2019", "RDH (inactive)", "License revoked", "BLS not renewed"]) expect(shownNotHeld(q), q).toBe(true);
    for (const q of [
      "RDH license CA active", "License lapsed in 2019, renewed in 2020", "Current RDH license", "RDH license valid through 2027", "Licence reinstated after it lapsed",
      "it has never lapsed or been suspended", "CA RDH license #12345, not expired", "non-expired California RDH license", "License never suspended or revoked",
      "RDH license lapsed briefly in 2019 and is currently in good standing", "License inactive 2018-2019, reactivated 2020", "My license hasn't expired",
    ]) expect(shownNotHeld(q), q).toBe(false);
  });

  it("reads pending, applied for, in training and not yet as not in force too", () => {
    for (const q of ["CA RDH license pending: board exam passed", "Applied for my RDH license in May", "Enrolled in a dental hygiene program, graduating 2027", "Not yet licensed", "RDH trainee"]) expect(shownNotHeld(q), q).toBe(true);
    // "currently" alone no longer says it is held ("currently enrolled"); "currently licensed" does
    expect(shownNotHeld("Currently enrolled in an RDH program")).toBe(true);
    expect(shownNotHeld("Currently licensed in CA; renewal due 2027")).toBe(false);
  });

  it("is 'not held' plainly only when the candidate says so, with nothing pending, lapsed or held about it", () => {
    for (const q of ["I do not hold a California RDH license", "I don't have an RDH license", "Not licensed in California", "No RDH license", "I have no hygiene license", "Never held a license", "Unlicensed"]) expect(plainlyNotHeld(q), q).toBe(true);
    for (const q of ["RDH license CA expired in 2021", "I do not have my license yet", "I don't hold it yet: exam in May", "No RDH license; application pending", "I do not hold an active CA license", "Enrolled in a dental hygiene program, graduating 2027", "RDH license CA active"]) expect(plainlyNotHeld(q), q).toBe(false);
  });

  /**
   * The licence rule: a credential must-have is "no" only when the candidate's own words say plainly they do not hold
   * it; lapsed, expired, pending or unclear is "unknown", whatever the model answered, so every reading of the same CV
   * gives the same finding and score.
   */
  it("holds a credential must-have to the licence rule, whatever the model answered", () => {
    const credentials = credentialMustHaves({ requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law" }, { key: "perio", text: "Periodontal therapy", rationale: "work" }], niceToHaves: [] } });
    expect([...credentials]).toEqual(["licence"]);
    const text = `${RESUME}\nI do not hold a Nevada RDH license\nRDH license CA active`;
    const inResume = (e: { quote?: string; source: string }) => e.source === "resume" && text.includes(e.quote ?? "");
    const quoted = (key: string, met: Met, quote: string) => reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: key, met, evidence: { source: "resume", quote } }] });
    const lapsed = "RDH license CA expired in 2021; renewal not started";
    // lapsed: "unknown" from every answer the model could give, so three readings always agree
    for (const met of ["no", "unknown", "partially", "yes"] as const) expect(metOf(applyEvidenceRules(quoted("licence", met, lapsed), inResume, { credentials }), "licence"), met).toBe("unknown");
    // said plainly: a "no" stands
    expect(metOf(applyEvidenceRules(quoted("licence", "no", "I do not hold a Nevada RDH license"), inResume, { credentials }), "licence")).toBe("no");
    // held: a "yes" stands
    expect(metOf(applyEvidenceRules(quoted("licence", "yes", "RDH license CA active"), inResume, { credentials }), "licence")).toBe("yes");
    // only a credential must-have, and only when the caller names the credentials
    expect(metOf(applyEvidenceRules(quoted("perio", "no", lapsed), inResume, { credentials }), "perio")).toBe("no");
    expect(metOf(applyEvidenceRules(quoted("licence", "no", lapsed), inResume), "licence")).toBe("no");
    // a quote that is not in the résumé is no evidence at all
    expect(metOf(applyEvidenceRules(quoted("licence", "no", "I do not hold any license"), inResume, { credentials }), "licence")).toBe("unknown");
  });

  it("reads the candidate's whole line, never only the part the model quoted (review of Wave S5)", () => {
    const packet = { requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law" }], niceToHaves: [] } };
    const credentials = credentialMustHaves(packet);
    const subjects = findingSubjects(packet);
    const sources = { resume: `${RESUME}\nI do not hold a CA RDH license` };
    const said = (met: Met, quote: string) => reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met, evidence: { source: "resume", quote } }] });
    // a "yes" quoting only "RDH license CA" from the expired line is read with the whole line: unknown
    expect(metOf(verifyAssessmentQuotes(said("yes", "RDH license CA"), sources, credentials, subjects), "licence")).toBe("unknown");
    // an "unknown" quoting the plain words is "no": the finding rests on the words, not on the model's answer
    for (const met of ["unknown", "no", "partially", "yes"] as const) expect(metOf(verifyAssessmentQuotes(said(met, "I do not hold a CA RDH license"), sources, credentials, subjects), "licence"), met).toBe("no");
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    const middle = (mets: Met[]) => {
      const out = combineOutcomes(mets.map((m, i) => ok(said(m, "I do not hold a CA RDH license"), `r${i}`)), sources, credentials, subjects);
      if (!out.ok) throw new Error("expected readings");
      return metOf(out.output, "licence");
    };
    expect(middle(["no", "unknown", "unknown"])).toBe("no");
    expect(middle(["no", "no", "unknown"])).toBe("no");
  });

  it("does not read a renewal or another qualification as the licence's state", () => {
    expect(credentialFinding("yes", "RDH license CA #12345, renewal expected 2026")).toBe("yes");
    expect(credentialFinding("yes", "RDH license CA #12345; renewal in progress", "Active CA RDH license")).toBe("yes");
    expect(credentialFinding("yes", "Enrolled in a dental hygiene program")).toBe("unknown");
    expect(credentialFinding("yes", "Enrolled in a dental hygiene program", "Active CA RDH license")).toBe("unknown");
    expect(credentialFinding("yes", "RDH license CA; studying for local anesthesia permit", "Active CA RDH license")).toBe("yes");
    // the licence's own state still counts on a line that also names another
    expect(credentialFinding("yes", "RDH license CA expired 2021; BLS current", "Active CA RDH license")).toBe("unknown");
    expect(credentialFinding("no", "RDH license CA; not licensed in Nevada", "Active CA RDH license")).toBe("unknown");
  });


  it("never takes a field name of the form as a quote: only the answers, as the sentences the reading was given", () => {
    const input = { resumeText: RESUME, packet: { formQuestions: [{ kind: "yes_no", key: "rdh_license", question: "Do you hold an active CA RDH license?", required: true }, { kind: "choice", key: "shift", question: "Which shift do you prefer?", options: ["Mornings", "Evenings"], required: true }] } as never, formAnswers: { rdh_license: "yes", shift: "Mornings" } };
    const sources = assessmentSources(input);
    expect(sources.application).not.toContain("rdh_license");
    expect(sources.application).toContain("Do you hold an active CA RDH license? Yes.");
    expect(sources.application).toContain("Mornings");
    const out = verifyAssessmentQuotes(reading("yes", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "application", quote: 'rdh_license":"yes' } }] }), sources);
    expect(out.requirementFindings[0]).toMatchObject({ met: "partially", evidence: { source: "application", unquoted: true } });
  });

  it("makes the lapsed licence of the fairness run read the same in all three readings", () => {
    const credentials = new Set(["licence"]);
    const sources = { resume: RESUME };
    const lapsedReading = (met: Met) => reading(met, "partially", "partially_evidenced", { requirementFindings: [{ requirementKey: "licence", met, ...(met === "unknown" ? {} : { evidence: { source: "resume" as const, quote: "RDH license CA expired in 2021; renewal not started" } }) }] });
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    // the run of 14 Oct 2026: "no", "no", "unknown" in one application, "unknown" three times in the next
    const first = combineOutcomes([ok(lapsedReading("no"), "r1"), ok(lapsedReading("no"), "r2"), ok(lapsedReading("unknown"), "r3")], sources, credentials);
    const second = combineOutcomes([ok(lapsedReading("unknown"), "r4"), ok(lapsedReading("unknown"), "r5"), ok(lapsedReading("unknown"), "r6")], sources, credentials);
    if (!first.ok || !second.ok) throw new Error("expected readings");
    expect(metOf(first.output, "licence")).toBe("unknown");
    expect(metOf(second.output, "licence")).toBe("unknown");
  });
});

/**
 * The code check of 25 November 2026, in two halves. Any "do not have" or "do not hold" in a line cited for a credential
 * read as plainly not holding it, whatever it was they did not have: "I do not have any restrictions on my license" gave
 * "not met" even where the model had answered "yes". And "I do not hold a current CPR certificate", which is not plainly
 * "not held" on purpose (a lapsed one is not current either), left a model's "yes" standing, because the word that says a
 * credential is in force was read inside the sentence that denies it.
 */
describe("what the candidate says they do not have (the licence rule, 25 November 2026)", () => {
  const RN = "Active RN license";
  const CPR = "Current CPR certificate";
  const ANSWERS = ["yes", "partially", "unknown", "no"] as const;

  it("reads 'not held' only when what they do not have is the credential itself", () => {
    // something about a licence, another licence, or something else: the finding stands as the model read it, and a "no"
    // these words do not say is not known
    const somethingElse: Array<[string, string]> = [
      ["I do not have any restrictions on my license", RN],
      ["I do not have any complaints against my RN license", RN],
      ["I do not have experience with CPR", CPR],
      ["I have no restrictions on my license", RN],
      ["No restrictions on my RN license", RN],
      ["I do not have any license restrictions", RN],
      ["No license restrictions", RN],
      ["I have never had a license suspended", RN],
      ["I have never practiced without a license", RN],
      ["I am licensed in Texas and do not hold a license in any other state", RN],
    ];
    for (const [line, subject] of somethingElse) {
      expect(plainlyNotHeld(line, subject), line).toBe(false);
      for (const met of ["yes", "partially", "unknown"] as const) expect(credentialFinding(met, line, subject), `${met}: ${line}`).toBe(met);
      expect(credentialFinding("no", line, subject), line).toBe("unknown");
    }
    // the credential itself, named by its kind, by the must-have's own name for it, or as "it" in a reply to "Do you have
    // it?": not met, whatever the model answered
    const itself: Array<[string, string]> = [
      ["I do not hold an RN license", RN],
      ["I don't have an RN license, I work as a nursing assistant", RN],
      ["No RN license", RN],
      ["I hold no nursing license", RN],
      ["I no longer hold an RN license", RN],
      ["I have never held a nursing license", RN],
      ["I do not have a CPR or BLS certification", CPR],
      ["I do not have CPR", CPR],
      ["No, I don't have it.", CPR],
      ["I do not have one", "Radiography certificate"],
      ["I do not have a driver's license or a car", "Valid driver's license"],
    ];
    for (const [line, subject] of itself) {
      expect(plainlyNotHeld(line, subject), line).toBe(true);
      for (const met of ANSWERS) expect(credentialFinding(met, line, subject), `${met}: ${line}`).toBe("no");
    }
  });

  it("never reads 'yes' or 'partly' out of a sentence that says they do not hold the credential", () => {
    const notInForce: Array<[string, string]> = [
      ["I do not hold a current CPR certificate", CPR],
      ["I do not hold an active RN license", RN],
      ["I do not have a current, valid license", RN],
      ["I do not have a valid driver's license at this time", "Valid driver's license"],
      ["No current RN license", RN],
      ["I hold no active licenses", RN],
      ["Not currently certified in CPR", CPR],
      ["No, I do not have a current one", CPR],
      ["I do not have my license yet", RN],
    ];
    for (const [line, subject] of notInForce) {
      // not plainly "not held": lapsed, pending or held but not in force all fit these words
      expect(plainlyNotHeld(line, subject), line).toBe(false);
      for (const met of ANSWERS) expect(credentialFinding(met, line, subject), `${met}: ${line}`).toBe("unknown");
    }
    // A line that says a credential is in force apart from what they say they do not have keeps the model's reading, as
    // before: which of the two the job asks for is the reading's to say, and "no" is still only what the words say plainly.
    const held: Array<[string, string]> = [
      ["RN license TX #123456, active. I do not have any disciplinary actions on my license.", RN],
      ["Active RN license, no restrictions", RN],
      ["I have an active RN license but I do not hold a compact license", RN],
      ["RN license TX (active), not licensed in Nevada", RN],
      ["I hold a current RN license and do not hold any other state licenses", RN],
      ["Licensed RN in Texas (active), not licensed in any other state", RN],
      ["Never without an active RN license since 2010", RN],
    ];
    for (const [line, subject] of held) {
      expect(credentialFinding("yes", line, subject), line).toBe("yes");
      expect(credentialFinding("no", line, subject), line).toBe("unknown");
    }
  });

  it("reads an answer on the form the same way, with its question", () => {
    for (const line of ["Do you have a CPR or BLS certification? No.", "Do you hold a current CPR certificate? No.", "Are you licensed in Texas? No."]) expect(formAnswerSaysNotHeld(line), line).toBe(true);
    for (const line of ["Do you have any license restrictions? No.", "Do you have any restrictions on your license? No.", "Do you hold a license in any other state? No."]) expect(formAnswerSaysNotHeld(line), line).toBe(false);
  });

  it("holds a whole reading to both halves, on a resume line and on an answer on the form", () => {
    const RESTRICTIONS_LINE = "I do not have any restrictions on my license";
    const CPR_LINE = "I do not hold a current CPR certificate";
    const RESTRICTIONS_ANSWER = "Do you have any restrictions on your license? No.";
    const CPR_ANSWER = "Do you hold a current CPR certificate? No.";
    const input = {
      packet: {
        requirements: { mustHaves: [{ key: "licence", text: RN, rationale: "law" }, { key: "cpr", text: CPR, rationale: "safety" }], niceToHaves: [] },
        competencies: [],
        formQuestions: [
          { kind: "yes_no", key: "fq_restrictions", question: "Do you have any restrictions on your license?", required: true },
          { kind: "yes_no", key: "fq_cpr", question: "Do you hold a current CPR certificate?", required: true },
        ],
      } as never,
      resumeText: `Registered Nurse at Lakeside Clinic 2018 - present\nRN license TX #123456\n${RESTRICTIONS_LINE}\n${CPR_LINE}`,
      formAnswers: { fq_restrictions: "no", fq_cpr: "no" },
    };
    const sources = assessmentSources(input);
    expect(sources.application).toBe(`${RESTRICTIONS_ANSWER}\n${CPR_ANSWER}`);
    type Said = { met: Met; source: "resume" | "application"; quote: string };
    const made = (licence: Said, cpr: Said): EvidenceAssessment =>
      reading(null, "unknown", "not_evidenced", {
        competencyFindings: [],
        requirementFindings: [{ requirementKey: "licence", met: licence.met, evidence: { source: licence.source, quote: licence.quote } }, { requirementKey: "cpr", met: cpr.met, evidence: { source: cpr.source, quote: cpr.quote } }],
      });
    /** What the team sees of three readings that said the same, as the app works it out. */
    const shown = (licence: Said, cpr: Said) => {
      const out = readingsOutcome([1, 2, 3].map((n) => ({ ok: true as const, output: made(licence, cpr), runId: `r${n}`, model: "m" })), { restore: (s: string) => s }, input);
      if (!out.ok) throw new Error("expected readings");
      return { licence: metOf(out.output, "licence"), cpr: metOf(out.output, "cpr"), quotes: Object.fromEntries(out.output.requirementFindings.map((f) => [f.requirementKey, f.evidence?.quote])) };
    };
    for (const [restrictions, certificate, source] of [[RESTRICTIONS_LINE, CPR_LINE, "resume"], [RESTRICTIONS_ANSWER, CPR_ANSWER, "application"]] as const) {
      // no restrictions on a licence is no word on holding it: the reading stands, and a "no" on it is not known
      for (const met of ["yes", "partially", "unknown"] as const) expect(shown({ met, source, quote: restrictions }, { met: "unknown", source, quote: certificate }).licence, `${source} ${met}`).toBe(met);
      expect(shown({ met: "no", source, quote: restrictions }, { met: "unknown", source, quote: certificate }).licence, source).toBe("unknown");
      // "do not hold a current …" is never shown or partly shown, and never plainly not met; the checked quote is kept
      for (const met of ANSWERS) {
        const out = shown({ met: "yes", source, quote: restrictions }, { met, source, quote: certificate });
        expect(out.cpr, `${source} ${met}`).toBe("unknown");
        expect(out.quotes).toEqual({ licence: restrictions, cpr: certificate });
      }
    }
    // one reading alone goes through the same rule
    const one = verifyAssessmentQuotes(made({ met: "yes", source: "application", quote: RESTRICTIONS_ANSWER }, { met: "yes", source: "resume", quote: CPR_LINE }), sources, credentialMustHaves(input.packet), findingSubjects(input.packet));
    expect([metOf(one, "licence"), metOf(one, "cpr")]).toEqual(["yes", "unknown"]);
  });
});
