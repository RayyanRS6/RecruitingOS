import { describe, expect, it } from "vitest";
import { DraftRolePacket, PACKET_VISIBILITY, RolePacket, RolePacketFields, packetVisibility } from "./role-packet";

/** A job version as it was stored before the record was cut down: every old section, and the form's questions in two places. */
const stored = () => ({
  schemaVersion: 1,
  identity: { title: "Dental Assistant", department: "Clinical", locations: [{ city: "Denver", region: "CO", country: "US" }], employmentType: "full_time", schedule: "Mon to Fri, 8 to 5", remotePolicy: "onsite", reportsTo: "Office manager" },
  business: { reason: "growth", reasonDetail: "A second chair", timeline: { urgency: "high", inactivityDays: 10 } },
  compensation: { basis: "hourly", currency: "USD", min: 24, mid: 26, max: 28, ceiling: 30, bonus: "Sign-on bonus", benefitsSummary: "Health and dental", discloseRange: true, sources: [{ name: "Owner" }], ownerStated: true },
  description: { publicJobDescription: "We are a busy family practice looking for a dental assistant who enjoys patient care.", internalNotes: "Backfill for Sam" },
  requirements: {
    mustHaves: [{ key: "mh_1_rda", text: "Active RDA license", rationale: "State law", evidencedBy: ["resume", "screen"] }, { key: "mh_2_xray", text: "X-ray certified", rationale: "Daily work", evidencedBy: ["interview"] }],
    niceToHaves: [{ key: "nh_1", text: "Dentrix", rationale: "Our software", evidencedBy: ["resume"] }],
    eligibility: [
      { key: "license", type: "license", question: "Do you hold an active RDA license?", expectation: { license: "RDA" }, rationale: "Required by the state", knockout: true },
      { key: "days", type: "schedule_availability", question: "Which of these days can you work?", expectation: { days: ["Mon", "Sat"] }, rationale: "", knockout: true },
    ],
  },
  competencies: [
    { key: "chairside", name: "Chairside assisting", definition: "Four-handed dentistry", weight: 5, evaluatedIn: "both", indicators: ["Passes instruments"] },
    { key: "patients", name: "Patient care", definition: "Puts people at ease", weight: 3, importance: "helpful", evaluatedIn: "interview", indicators: ["Explains"] },
    { key: "software", name: "Practice software", definition: "Charts and schedules", weight: 1, evaluatedIn: "screen", indicators: ["Dentrix"] },
  ],
  evaluation: { criteria: ["Reliability"], redFlags: ["Late"] },
  screening: { questions: [{ key: "sq_1", question: "Tell me about a busy day.", competencyKey: "chairside", kind: "behavioral", modelAnswer: "A concrete day", followUpIf: "vague" }, { key: "sq_2", question: "What pay are you looking for?", kind: "compensation" }, { key: "sq_3", question: "When could you start?", kind: "availability" }], maxMinutes: 10 },
  interviews: { plan: [{ key: "r1", title: "Working interview", purpose: "See them work", durationMinutes: 60, format: "onsite", interviewerUserIds: ["u1"], interviewerRoles: [], competencyKeys: ["chairside"], suggestedQuestions: [] }], scorecard: { scale: { min: 1, max: 4, labels: {} }, requireEvidence: true, overallRecommendationOptions: ["yes", "no"] } },
  communication: { tone: "warm", companyBlurb: "A family practice.", candidateMayBeTold: ["pay"], signature: "The Smile team", disclosureText: "An AI assistant helps us.", humanAlternativeText: "You can ask for a person." },
  approvals: { packetApproverRoles: ["owner"], interviewApproverRoles: ["owner"], offerApproverRoles: ["owner"] },
  compliance: { jurisdictions: ["US-CO"], notices: ["ai_use"], retentionClass: "decision_data_4y", recordingPolicy: "consent_required", smsRequiresConsent: true },
  sourcing: { summary: "Boards", channels: ["indeed"], targetSources: [], sponsoredDailyBudget: 0, rediscovery: true },
  preferences: { decisionMakerName: "Dr Chen", dealBreakersInTheirWords: ["No RDA license"], schedulingWindows: [] },
  provenance: { playbookId: "dental", playbookVersion: 1, intakeSessionId: "s1", aiRunIds: ["run1"], assumptions: ["Full time"], sources: ["owner"], flags: [], payOrigin: "pay_card", benchmark: { basis: "hourly", p25: 22, p50: 25, p75: 29, source: "BLS", metro: "Denver", origin: "market" } },
  companyQuestions: {
    quick: [{ kind: "choice", key: "cq_shift", question: "Which shift do you prefer?", required: true, options: ["Morning", "Afternoon"] }, { kind: "number", key: "cq_years", question: "Years of chairside experience?", required: false, unit: "years", min: 0, max: 50 }],
    written: [{ key: "wq_why", question: "Why this practice?", required: true, lookFor: "Something specific" }],
  },
});

describe("the job record", () => {
  it("still reads a version stored before it was cut down, dropping every section the product no longer has", () => {
    const p = RolePacket.parse(stored());
    expect(Object.keys(p).sort()).toEqual(["communication", "compensation", "competencies", "compliance", "description", "formQuestions", "identity", "provenance", "requirements", "schemaVersion", "screening"]);
    expect(p.identity).toEqual({ title: "Dental Assistant", department: "Clinical", locations: [{ city: "Denver", region: "CO", country: "US" }], employmentType: "full_time", schedule: "Mon to Fri, 8 to 5", remotePolicy: "onsite" });
    expect(p.compensation).toEqual({ basis: "hourly", currency: "USD", min: 24, max: 28, benefitsSummary: "Health and dental", discloseRange: true });
    expect(p.description).toEqual({ publicJobDescription: "We are a busy family practice looking for a dental assistant who enjoys patient care." });
    expect(p.requirements).toEqual({ mustHaves: [{ key: "mh_1_rda", text: "Active RDA license", rationale: "State law" }, { key: "mh_2_xray", text: "X-ray certified", rationale: "Daily work" }], niceToHaves: [{ key: "nh_1", text: "Dentrix", rationale: "Our software" }] });
    expect(p.compliance).toEqual({ jurisdictions: ["US-CO"], notices: ["ai_use"] });
    expect(p.provenance).toEqual({ intakeSessionId: "s1", aiRunIds: ["run1"], assumptions: ["Full time"], flags: [], payOrigin: "pay_card" });
    expect(p.screening.questions[0]).toEqual({ key: "sq_1", question: "Tell me about a busy day.", kind: "behavioral", modelAnswer: "A concrete day" });
  });

  it("reads each skill's importance: the label a person picked, or the one an older 1-5 weight stands for, and counts every skill", () => {
    const p = RolePacket.parse(stored());
    expect(p.competencies).toEqual([
      { key: "chairside", name: "Chairside assisting", definition: "Four-handed dentistry", importance: "essential", indicators: ["Passes instruments"] },
      { key: "patients", name: "Patient care", definition: "Puts people at ease", importance: "helpful", indicators: ["Explains"] },
      { key: "software", name: "Practice software", definition: "Charts and schedules", importance: "helpful", indicators: ["Dentrix"] },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/evaluatedIn|evidencedBy|"weight"/);
  });

  it("gathers the form's questions of an older version into the one list: its yes/no questions, then the choice and number questions", () => {
    const p = RolePacket.parse(stored());
    expect(p.formQuestions).toEqual([
      { kind: "yes_no", key: "license", question: "Do you hold an active RDA license?", help: "Required by the state", required: true },
      { kind: "yes_no", key: "days", question: "Which of these days can you work?", required: false },
      { kind: "choice", key: "cq_shift", question: "Which shift do you prefer?", required: true, options: ["Morning", "Afternoon"] },
      { kind: "number", key: "cq_years", question: "Years of chairside experience?", required: false, unit: "years", min: 0, max: 50 },
    ]);
    // nothing of the questions that were asked only inside the AI chat is kept
    expect(JSON.stringify(p)).not.toMatch(/wq_why|lookFor|companyQuestions|eligibility|knockout/);
  });

  it("reads a version saved now as it is, and reads it again the same", () => {
    const now = RolePacket.parse(stored());
    const again = RolePacket.parse(JSON.parse(JSON.stringify(now)));
    expect(again).toEqual(now);
    const edited = RolePacket.parse({ ...now, formQuestions: [{ kind: "yes_no", key: "sat", question: "Can you work Saturdays?" }] });
    expect(edited.formQuestions).toEqual([{ kind: "yes_no", key: "sat", question: "Can you work Saturdays?", required: true }]);
  });

  it("needs a title, a place, pay, a description, a must-have and three AI interview questions, and nothing the product dropped", () => {
    const { competencies: _c, formQuestions: _f, ...least } = RolePacket.parse(stored());
    const p = RolePacket.parse(least);
    expect(p.competencies).toEqual([]);
    expect(p.formQuestions).toEqual([]);
    expect(RolePacket.safeParse({ ...least, requirements: { mustHaves: [] } }).success).toBe(false);
    expect(RolePacket.safeParse({ ...least, screening: { questions: least.screening.questions.slice(0, 2) } }).success).toBe(false);
    expect(RolePacket.safeParse({ ...least, description: { publicJobDescription: "Too short." } }).success).toBe(false);
    const { compensation: _pay, ...noPay } = least;
    expect(RolePacket.safeParse(noPay).success).toBe(false);
    expect(Object.keys(RolePacketFields.shape).sort()).toEqual(["communication", "compensation", "competencies", "compliance", "description", "formQuestions", "identity", "provenance", "requirements", "schemaVersion", "screening"]);
  });

  it("lets a draft go without pay until a person sets it, and reads an older draft the same way", () => {
    const { compensation: _pay, ...noPay } = stored();
    const draft = DraftRolePacket.parse(noPay);
    expect(draft.compensation).toBeUndefined();
    expect(draft.formQuestions).toHaveLength(4);
    expect(DraftRolePacket.parse(stored()).compensation?.max).toBe(28);
  });

  it("says who sees each part of the record", () => {
    expect(packetVisibility("identity.title")).toBe("public");
    expect(packetVisibility("identity.department")).toBe("internal");
    expect(packetVisibility("compensation.min")).toBe("public");
    expect(packetVisibility("requirements.mustHaves[1].text")).toBe("public");
    expect(packetVisibility("requirements.mustHaves[1].rationale")).toBe("reviewed");
    expect(packetVisibility("competencies[0].name")).toBe("reviewed");
    expect(packetVisibility("formQuestions[2].question")).toBe("asked");
    expect(packetVisibility("screening.questions[0].question")).toBe("asked");
    expect(packetVisibility("screening.questions[0].modelAnswer")).toBe("reviewed");
    expect(packetVisibility("provenance.flags")).toBe("internal");
    expect(packetVisibility("something.else")).toBe("internal");
    for (const path of Object.keys(PACKET_VISIBILITY)) expect(Object.keys(RolePacketFields.shape), path).toContain(path.split(".")[0]);
  });
});
