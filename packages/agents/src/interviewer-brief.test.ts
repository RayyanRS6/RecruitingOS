import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { assessments, createDb, migrate, withTenant, type DbHandle } from "@ros/db";
import { samplePacket } from "./fixtures/sample-packet";
import { briefForReader, composeInterviewerBrief, redactBriefPay, renderInterviewerBriefText, type InterviewerBrief } from "./interviewer-brief";

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
    for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter"] as const) expect(briefForReader(full, role), role).toEqual(full);
  });
});

/**
 * The brief from what the readings stored (the second review of the live-test fixes, 12 November 2026). A skill the score
 * counts as not known never reads "contradicted" (#3, #20, #38); a quote naming pay on a must-have the AI interview left
 * unknown never reaches an interviewer (#5); each must-have's quote says where it is from (#16).
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

  /** A new applicant with a résumé reading and then a scorecard, and the round's brief composed from them. */
  async function briefOf(resume: Record<string, unknown>, card: Record<string, unknown>): Promise<InterviewerBrief> {
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${applicationId}, ${companyId}, ${roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, 'interview_recommended')`);
    await handle.db.insert(assessments).values({ companyId, applicationId, kind: "triage", packetVersion: 1, result: reading(resume) as never, overall: "potential", confidence: "medium", createdAt: "2026-11-12T10:00:00.000Z" });
    await handle.db.insert(assessments).values({ companyId, applicationId, kind: "screen", packetVersion: 1, result: scorecard(card) as never, overall: "potential", confidence: "medium", createdAt: "2026-11-12T11:00:00.000Z" });
    const brief = await withTenant(handle.db, companyId, (tx) => composeInterviewerBrief(tx, { applicationId, candidateFirstName: "Ana", packet, roundKey: "owner" }));
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
});
