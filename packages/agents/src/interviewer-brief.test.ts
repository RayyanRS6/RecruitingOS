import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { CHAT_WRAP_KEY } from "@ros/core";
import { assessments, createDb, migrate, screens, withTenant, type DbHandle } from "@ros/db";
import { samplePacket } from "./fixtures/sample-packet";
import { briefForReader, composeInterviewerBrief, redactBriefPay, renderInterviewerBriefText, type InterviewerBrief } from "./interviewer-brief";
import { CHAT_WRAP_QUESTION } from "./screening";

/**
 * The interviewer's brief in the confirmation email (docs/spec/21 F7). The live test of 12 November 2026 read "Practice
 * software: not assessed yet" for a skill the owner had set to "Only in your own interviews", which no AI review reads: the
 * email says it is for this interview, so it never reads as something the AI missed.
 */
describe("the interviewer's brief in words", () => {
  const skill = (key: string, name: string, evaluatedIn: "screen" | "interview" | "both", finding: InterviewerBrief["competencies"][number]["finding"] = null) => ({ key, name, definition: `${name} defined.`, indicators: [], finding, note: null, evaluatedIn });
  const brief = (competencies: InterviewerBrief["competencies"]): InterviewerBrief => ({ candidateFirstName: "Maya", round: { key: "r1", title: "Working interview", purpose: "See the chairside work.", durationMinutes: 45, format: "onsite" }, competencies, questions: [], mustHaves: [], strengths: [], concerns: [], screen: null, pay: null, includesPay: false });
  const mustHave = (text: string, met: InterviewerBrief["mustHaves"][number]["met"], quote: string | null, source: string | null, aboutPay = false) => ({ key: text.toLowerCase().replace(/\W+/g, "_"), text, met, quote, source, aboutPay });

  it("says a skill checked only in the team's own interviews is for this interview, and the others what the readings found", () => {
    const text = renderInterviewerBriefText(brief([skill("software", "Practice software", "interview"), skill("chairside", "Chairside skill", "both"), skill("patients", "Patient care", "both", "evidenced"), { ...skill("old", "old round key", "both"), evaluatedIn: null }]));
    expect(text).toContain("- Practice software: Practice software defined. (for this interview)");
    expect(text).not.toContain("Practice software defined. (not assessed yet)");
    expect(text).toContain("- Chairside skill: Chairside skill defined. (not assessed yet)");
    expect(text).toContain("- Patient care: Patient care defined. (so far: seen in the evidence)");
    // a round key the role has no skill for says nothing about own interviews
    expect(text).toContain("- old round key: old round key defined. (not assessed yet)");
  });

  // The second review of the live-test fixes (#16): a résumé line read as the candidate's words in the AI interview.
  it("says after each must-have's quote where it is from, and nothing after a must-have with no quote", () => {
    const text = renderInterviewerBriefText({
      ...brief([]),
      mustHaves: [
        mustHave("Digital radiography", "yes", "Take full-mouth and bitewing X-rays with digital sensors", "resume"),
        mustHave("Saturdays", "yes", "Yes, every other Saturday", "screen"),
        mustHave("RDA license", "yes", "Do you hold an active RDA license? Yes", "application"),
        mustHave("Coronal polishing", "partially", "Polishes on her own after the hygienist", "recruiter_note"),
        mustHave("CPR card", "partially", null, "resume"),
        mustHave("X-ray certificate", "unknown", null, null),
      ],
    });
    expect(text).toContain('- Digital radiography: met ("Take full-mouth and bitewing X-rays with digital sensors", from the résumé)\n');
    expect(text).toContain('- Saturdays: met ("Yes, every other Saturday", in the AI interview)\n');
    expect(text).toContain('- RDA license: met ("Do you hold an active RDA license? Yes", from the application)\n');
    expect(text).toContain("- Coronal polishing: partly met (\"Polishes on her own after the hygienist\", from the recruiter's call notes)\n");
    expect(text).toContain("- CPR card: partly met\n");
    expect(text).toContain("- X-ray certificate: unknown so far\n");
    expect(text.match(/from the résumé/g)).toHaveLength(1);
  });

  // The second review of the live-test fixes (#5): interviewers lack compensation.read, so no pay words reach them.
  it("keeps a must-have and what it says for a reader who may not see pay, without a quote that speaks to pay", () => {
    const paid: InterviewerBrief = { ...brief([]), mustHaves: [mustHave("Chairside experience", "yes", "4 years chairside assisting; desired pay $28/hour", "resume", true), mustHave("Radiography certificate", "yes", "Radiography certificate, 2021", "resume")], pay: { expectation: "$28/hour", withinRange: "yes" }, includesPay: true };
    const redacted = redactBriefPay(paid);
    expect(redacted.mustHaves).toEqual([{ ...paid.mustHaves[0], quote: null }, paid.mustHaves[1]]);
    expect(redacted).toMatchObject({ pay: null, includesPay: false });
    const text = renderInterviewerBriefText(redacted);
    expect(text).toContain("- Chairside experience: met\n");
    expect(text).toContain('- Radiography certificate: met ("Radiography certificate, 2021", from the résumé)\n');
    expect(text).not.toContain("$28");
    expect(renderInterviewerBriefText(paid)).toContain('- Chairside experience: met ("4 years chairside assisting; desired pay $28/hour", from the résumé)');
  });

  it("gives an interviewer no quote holding the candidate's contact details, the claim and the finding kept, and every other role the whole brief", () => {
    const full: InterviewerBrief = {
      ...brief([]),
      mustHaves: [mustHave("Lives near the office", "yes", "1234 Elm St, Irvine, CA 92618", "resume"), mustHave("Chairside experience", "yes", "Maya Lindqvist, chairside assistant since 2019", "resume")],
      strengths: [
        { claim: "Front desk cover", quote: "Front desk and chairside, maya.l@example.com", source: "resume", aboutPay: false },
        { claim: "Shares her work", quote: "Case photos at linkedin.com/in/maya-lindqvist", source: "resume", aboutPay: false },
        { claim: "Explains treatment plans", quote: "I walk every patient through the plan", source: "screen", aboutPay: false },
      ],
      concerns: [{ claim: "A gap in 2023", quote: "Call me at (714) 555-0142 about 2023", source: "screen", aboutPay: false }],
      pay: { expectation: "$28/hour", withinRange: "yes" },
      includesPay: true,
    };
    const theirs = briefForReader(full, "interviewer");
    expect(theirs.mustHaves.map((m) => [m.met, m.quote])).toEqual([["yes", null], ["yes", "Maya Lindqvist, chairside assistant since 2019"]]);
    expect(theirs.strengths.map((s) => [s.claim, s.quote])).toEqual([["Front desk cover", null], ["Shares her work", null], ["Explains treatment plans", "I walk every patient through the plan"]]);
    expect(theirs.concerns.map((s) => [s.claim, s.quote])).toEqual([["A gap in 2023", null]]);
    expect(theirs).toMatchObject({ pay: null, includesPay: false });
    expect(renderInterviewerBriefText(theirs)).not.toMatch(/Elm St|92618|example\.com|linkedin|555-0142/);
    for (const role of ["owner", "admin", "hiring_manager", "hr"] as const) expect(briefForReader(full, role), role).toEqual(full);
  });
});

/**
 * The brief from what the readings stored (the second review of the live-test fixes, 12 November 2026). A skill the score
 * counts as not known never reads "contradicted" (#3, #20, #38); a quote naming pay on a must-have the AI interview left
 * unknown never reaches an interviewer (#5); each must-have's quote says where it is from (#16). The second look at that
 * fix: no pay reaches an interviewer in a quote however it is written, nor in an AI interview answer, and a strength or
 * concern whose quote alone names an amount keeps its claim.
 */
describe("the brief from the stored readings", () => {
  let handle: DbHandle;
  const companyId = randomUUID();
  const roleId = randomUUID();
  const packet = samplePacket((p) => {
    p.interviews.plan[0]!.competencyKeys = ["chairside", "patients", "infection"];
  });
  const reading = (over: Record<string, unknown>) => ({ overall: "potential", confidence: "medium", summary: "Read.", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], recommendation: "screen", rationale: "x", ...over });
  const scorecard = (over: Record<string, unknown>) => reading({ questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", ...over });

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone, settings) VALUES (${companyId}, 'Harbor Dental', ${`harbor-${companyId}`}, 'dental', '20-49', 'America/Los_Angeles', '{}'::jsonb)`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${roleId}, ${companyId}, 'Dental Assistant', 'open', ${sql`'{"kind":"user","id":"u1"}'::jsonb`})`);
  });
  afterAll(async () => {
    await handle.close();
  });

  /**
   * A new applicant with a résumé reading and then a scorecard, and the round's brief composed from them. `answers`: an
   * AI interview they sent, with these answers by question key.
   */
  async function briefOf(resume: Record<string, unknown>, card: Record<string, unknown>, more: { answers?: Record<string, string>; packet?: RolePacket } = {}): Promise<InterviewerBrief> {
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${applicationId}, ${companyId}, ${roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, 'interview_recommended')`);
    await handle.db.insert(assessments).values({ companyId, applicationId, kind: "triage", packetVersion: 1, result: reading(resume) as never, overall: "potential", confidence: "medium", createdAt: "2026-11-12T10:00:00.000Z" });
    if (more.answers) await handle.db.insert(screens).values({ companyId, applicationId, channel: "web", status: "completed", token: `brief-${applicationId}`, completedAt: "2026-11-12T10:30:00.000Z", answers: more.answers });
    await handle.db.insert(assessments).values({ companyId, applicationId, kind: "screen", packetVersion: 1, result: scorecard(card) as never, overall: "potential", confidence: "medium", createdAt: "2026-11-12T11:00:00.000Z" });
    const brief = await withTenant(handle.db, companyId, (tx) => composeInterviewerBrief(tx, { applicationId, candidateFirstName: "Ana", packet: more.packet ?? packet, roundKey: "owner" }));
    return brief!;
  }

  it("reads a skill the score counts nothing for as not seen yet, with a note only from an entry that says so, and a checked one as against them", async () => {
    const brief = await briefOf(
      { competencyFindings: [{ competencyKey: "chairside", finding: "not_evidenced", note: "Not mentioned in the résumé." }] },
      {
        competencyFindings: [
          // the quote failed the check: stripped, "goes against it" kept with the strip's note, as the evidence rules leave it
          { competencyKey: "chairside", finding: "contradicted", evidence: { source: "screen" }, note: "quote could not be verified against the source" },
          { competencyKey: "patients", finding: "contradicted", evidence: { source: "screen", unquoted: true } },
          { competencyKey: "infection", finding: "contradicted", evidence: { source: "screen", quote: "I skip the autoclave log on busy days" } },
        ],
      },
    );
    expect(brief.competencies.map((c) => [c.key, c.finding, c.note])).toEqual([["chairside", "not_evidenced", "Not mentioned in the résumé."], ["patients", "not_evidenced", null], ["infection", "contradicted", null]]);
    const text = renderInterviewerBriefText(brief);
    expect(text).toContain("- Chairside skill: Anticipates the dentist's next step. (so far: not seen yet; Not mentioned in the résumé.)");
    expect(text).toContain("- Patient care: Puts nervous patients at ease. (so far: not seen yet)");
    expect(text).toContain("- Infection control: Follows sterilization steps every time. (so far: contradicted by the evidence)");
    expect(text).not.toContain("could not be verified");
  });

  it("marks a must-have whose quote names pay, so an interviewer reads met without it, and says where each quote is from", async () => {
    const payQuote = "4 years chairside assisting, looking for $28/hour";
    const brief = await briefOf(
      {
        requirementFindings: [
          { requirementKey: "mh_xray", met: "yes", evidence: { source: "screen", quote: "Radiography certificate, Dental Board of California, 2021" } },
          { requirementKey: "mh_chairside", met: "yes", evidence: { source: "resume", quote: payQuote } },
        ],
        strengths: [{ claim: "Runs the sterilization log", evidence: { source: "resume", quote: "Sterilization lead at 1234 Elm St, Irvine, CA 92618" } }],
      },
      { requirementFindings: [{ requirementKey: "mh_xray", met: "unknown" }, { requirementKey: "mh_chairside", met: "unknown" }] },
    );
    // the owner's copy: the résumé's checked yes with its quote; a reading that named another source still checked it against the résumé
    expect(brief.mustHaves).toEqual([
      { key: "mh_xray", text: "Radiography certificate", met: "yes", quote: "Radiography certificate, Dental Board of California, 2021", source: "resume", aboutPay: false },
      { key: "mh_chairside", text: "Chairside experience in a dental office", met: "yes", quote: payQuote, source: "resume", aboutPay: true },
    ]);
    expect(renderInterviewerBriefText(brief)).toContain(`- Chairside experience in a dental office: met ("${payQuote}", from the résumé)`);
    const theirs = briefForReader(brief, "interviewer");
    expect(theirs.mustHaves.map((m) => [m.key, m.met, m.quote])).toEqual([["mh_xray", "yes", "Radiography certificate, Dental Board of California, 2021"], ["mh_chairside", "yes", null]]);
    const text = renderInterviewerBriefText(theirs);
    expect(text).toContain('- Radiography certificate: met ("Radiography certificate, Dental Board of California, 2021", from the résumé)\n');
    expect(text).toContain("- Chairside experience in a dental office: met\n");
    expect(text).toContain("- Runs the sterilization log\n");
    expect(text).not.toMatch(/\$28|Elm St|92618/);
  });

  // A second look at that fix: the Associate Dentist's pay is "a daily guarantee against a percentage of production" (the
  // dental playbook), and a résumé or an answer may name pay without a dollar sign.
  it("gives an interviewer a must-have's finding without a quote naming pay by the day, without a dollar sign or in a pay deal's words, and keeps a quote naming none", async () => {
    const cases: Array<[source: "resume" | "screen", quote: string, amount: string]> = [
      ["resume", "Associate, Bright Smiles 2021-2024, $900/day guarantee + 30% of collections", "$900"],
      ["resume", "Chairside at Bright Smiles, $400 per day", "$400"],
      ["resume", "Chairside assistant since 2019. Desired rate: 28/hr", "28/hr"],
      ["resume", "Chairside at Smile Dental, 28 an hour", "28 an hour"],
      ["resume", "Lead chairside assistant, 80k base", "80k"],
      ["screen", "Yes, chairside every day, if the daily guarantee is at least $900", "$900"],
    ];
    for (const [source, quote, amount] of cases) {
      const found = { requirementKey: "mh_chairside", met: "yes", evidence: { source, quote } };
      const brief = await briefOf(
        { requirementFindings: [{ requirementKey: "mh_xray", met: "yes", evidence: { source: "resume", quote: "Radiography certificate, 2021" } }, ...(source === "resume" ? [found] : [])] },
        { requirementFindings: [{ requirementKey: "mh_xray", met: "unknown" }, source === "screen" ? found : { requirementKey: "mh_chairside", met: "unknown" }] },
      );
      expect(brief.mustHaves.find((m) => m.key === "mh_chairside"), quote).toMatchObject({ met: "yes", quote, source, aboutPay: true });
      const theirs = briefForReader(brief, "interviewer");
      expect(theirs.mustHaves.map((m) => [m.key, m.met, m.quote]), quote).toEqual([["mh_xray", "yes", "Radiography certificate, 2021"], ["mh_chairside", "yes", null]]);
      const text = renderInterviewerBriefText(theirs);
      expect(text, quote).toContain("- Chairside experience in a dental office: met\n");
      expect(text, quote).not.toContain(amount);
    }
  });

  // A second look at that fix: a practice's own figures ("$90k" of collections) and a patient's co-pay are not the
  // candidate's pay, so a strength or concern whose quote alone names an amount keeps its claim, as a must-have keeps "met".
  it("keeps for an interviewer a strength or concern whose quote alone names pay, without the quote, and leaves out one whose claim speaks to pay or whose quote repeats what they said about it", async () => {
    const brief = await briefOf(
      {
        strengths: [
          { claim: "Improved the practice's collections", evidence: { source: "resume", quote: "Raised monthly collections from $90k to $120k" } },
          { claim: "Strong daily production", evidence: { source: "resume", quote: "About $4,500 a day in production" } },
          { claim: "Explains insurance to patients", evidence: { source: "resume", quote: "Collected the co-pay at check-in and posted insurance payments" } },
          { claim: "Happy with the posted pay", evidence: { source: "resume", quote: "Front desk lead, 2020-2024" } },
        ],
        concerns: [{ claim: "Short stay at the last job", evidence: { source: "resume", quote: "Office Manager, Bright Dental, Feb-Jul 2025, $65k/yr" } }],
      },
      { compensationExpectation: { stated: "$34 an hour", withinRange: "above" }, concerns: [{ claim: "Wants more than the posted range", evidence: { source: "screen", quote: "I need $34 an hour to move" } }] },
    );
    const quoted = (xs: InterviewerBrief["strengths"]) => xs.map((x) => [x.claim, x.quote]);
    // the owner's copy keeps them all
    expect(quoted(brief.strengths)).toEqual([["Improved the practice's collections", "Raised monthly collections from $90k to $120k"], ["Strong daily production", "About $4,500 a day in production"], ["Explains insurance to patients", "Collected the co-pay at check-in and posted insurance payments"], ["Happy with the posted pay", "Front desk lead, 2020-2024"]]);
    expect(quoted(brief.concerns)).toEqual([["Wants more than the posted range", "I need $34 an hour to move"], ["Short stay at the last job", "Office Manager, Bright Dental, Feb-Jul 2025, $65k/yr"]]);
    expect(briefForReader(brief, "owner")).toEqual(brief);
    const theirs = briefForReader(brief, "interviewer");
    expect(quoted(theirs.strengths)).toEqual([["Improved the practice's collections", null], ["Strong daily production", "About $4,500 a day in production"], ["Explains insurance to patients", "Collected the co-pay at check-in and posted insurance payments"]]);
    expect(quoted(theirs.concerns)).toEqual([["Short stay at the last job", null]]);
    const text = renderInterviewerBriefText(theirs);
    expect(text).toContain("- Improved the practice's collections\n");
    expect(text).toContain("- Short stay at the last job\n");
    expect(text).not.toMatch(/\$90k|\$65k|\$34|posted pay|posted range/);
  });

  // A second look at that fix: what they said in the AI interview is their own words, where pay and contact details are
  // most often written outside the pay question.
  it("gives an interviewer none of the AI interview's answers that speak to pay or hold contact details, and keeps those about their work with the practice's own figures", async () => {
    const answers = {
      recent: "I assisted on about $5k a day of production",
      nervous: "I showed her what her plan covers and what she would pay herself, and she calmed down",
      available: "Tuesday to Friday, from the 1st, at $32 or more",
      pay: "$28 to $30",
      mh_chairside: "Four years chairside, last at 26 an hour",
      wrap_up: "Call me at (714) 555-0142 after 5",
    };
    const brief = await briefOf({}, {}, { answers });
    const said = (b: InterviewerBrief) => (b.screen?.answers ?? []).map((a) => a.answer).sort();
    expect(said(brief)).toEqual(Object.values(answers).sort());
    expect(briefForReader(brief, "owner")).toEqual(brief);
    const theirs = briefForReader(brief, "interviewer");
    expect(said(theirs)).toEqual([answers.recent, answers.nervous].sort());
    const text = renderInterviewerBriefText(theirs);
    expect(text).toContain(`  ${answers.recent}\n`);
    expect(text).not.toMatch(/\$32|\$28|26 an hour|555-0142|What hourly range/);
  });

  it("reads a company's written question about pay as the pay question, and an answer about their work naming an hourly amount as about pay", async () => {
    const asked = samplePacket((p) => {
      p.interviews.plan[0]!.competencyKeys = ["chairside", "patients", "infection"];
      p.companyQuestions = { quick: [], written: [{ key: "wq_numbers", question: "Which numbers did you track at your last office?", required: true }, { key: "wq_software", question: "Which dental software have you used?", required: true }, { key: "wq_pay", question: "What pay are you hoping for here?", required: true }] };
    });
    const answers = { wq_numbers: "Collections held at $150k a month with AR under 30 days", wq_software: "Dentrix for charting at Smile Dental, where I made 26/hr", wq_pay: "Around 30" };
    const brief = await briefOf({}, {}, { answers, packet: asked });
    expect((brief.screen?.answers ?? []).map((a) => [a.question, a.answer]).sort()).toEqual([["What pay are you hoping for here?", answers.wq_pay], ["Which dental software have you used?", answers.wq_software], ["Which numbers did you track at your last office?", answers.wq_numbers]]);
    const theirs = briefForReader(brief, "interviewer");
    expect((theirs.screen?.answers ?? []).map((a) => a.answer)).toEqual([answers.wq_numbers]);
    expect(renderInterviewerBriefText(theirs)).not.toMatch(/26\/hr|Around 30|hoping for/);
  });

  it("counts a bare number they gave for pay only as that number, never inside a year", async () => {
    const brief = await briefOf(
      { requirementFindings: [{ requirementKey: "mh_chairside", met: "yes", evidence: { source: "resume", quote: "Chairside assistant, Smile Dental 2019-2025" } }], strengths: [{ claim: "Stays with an office", evidence: { source: "resume", quote: "Smile Dental, 2019-2025" } }] },
      { requirementFindings: [{ requirementKey: "mh_chairside", met: "unknown" }], concerns: [{ claim: "Asked about the range twice", evidence: { source: "screen", quote: "Is 25 possible?" } }] },
      { answers: { pay: "25", recent: "Chairside since 2019, and 2025 was my busiest year" } },
    );
    const theirs = briefForReader(brief, "interviewer");
    expect(theirs.mustHaves.find((m) => m.key === "mh_chairside")).toMatchObject({ met: "yes", quote: "Chairside assistant, Smile Dental 2019-2025", aboutPay: false });
    expect(theirs.strengths.map((s) => [s.claim, s.quote])).toEqual([["Stays with an office", "Smile Dental, 2019-2025"]]);
    // its quote repeats the number they gave for pay
    expect(theirs.concerns).toEqual([]);
    expect((theirs.screen?.answers ?? []).map((a) => a.answer)).toEqual(["Chairside since 2019, and 2025 was my busiest year"]);
  });

  // Left out by the repair of the brief (9ef60ca): a must-have's gap answer is kept under the must-have's key and the
  // closing answer under the closing question's, so the sheet and the email read "mh 1 active ca rdh license" and "wrap up".
  it("names an AI interview answer by the words it was asked in: a must-have's gap answer by the must-have, the closing answer by the closing question, any other key in plain words, in the brief and the email, for every reader", async () => {
    const licensed = samplePacket((p) => {
      p.interviews.plan[0]!.competencyKeys = ["chairside", "patients", "infection"];
      p.requirements.mustHaves.unshift({ key: "mh_1_active_ca_rdh_license", text: "Active California RDH license", rationale: "Required by the state", evidencedBy: ["resume", "screen"] });
    });
    const said = {
      gap: "Yes, I hold an active California RDH license and renewed it this spring.",
      closing: "I can start two weeks after an offer.",
      xrays: "I took digital X-rays every day at my last office.",
      swaps: "Happy to swap shifts with the team.",
    };
    // the last two: a must-have and a written question the job no longer has, which nothing names
    const brief = await briefOf({}, {}, { answers: { mh_1_active_ca_rdh_license: said.gap, [CHAT_WRAP_KEY]: said.closing, mh_3_digital_xrays: said.xrays, wq_shift_swaps: said.swaps }, packet: licensed });
    const named = [["Active California RDH license", said.gap], [CHAT_WRAP_QUESTION, said.closing], ["Digital xrays", said.xrays], ["Shift swaps", said.swaps]].sort();
    for (const reader of ["owner", "interviewer"] as const) {
      const theirs = briefForReader(brief, reader);
      expect((theirs.screen?.answers ?? []).map((a) => [a.question, a.answer]).sort(), reader).toEqual(named);
      const text = renderInterviewerBriefText(theirs);
      expect(text, reader).toContain(`- Active California RDH license\n  ${said.gap}\n`);
      expect(text, reader).toContain(`- ${CHAT_WRAP_QUESTION}\n  ${said.closing}\n`);
      expect(text, reader).toContain(`- Digital xrays\n  ${said.xrays}\n`);
      expect(text, reader).toContain(`- Shift swaps\n  ${said.swaps}\n`);
      expect(text, reader).not.toMatch(/_|\bmh\b|\bwq\b|wrap up/i);
    }
  });
});
