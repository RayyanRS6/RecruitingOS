import { describe, expect, it } from "vitest";
import { FakeProvider, screenTurnPrompt, type ScreenContext } from "@ros/ai";
import { IntakeTurn, RolePacket } from "@ros/contracts";
import { futureRolesLine, reminderClosingLine } from "./coordinator";
import { registerFakeHandlers } from "./fake-handlers";
import { mergeFacts } from "./intake";
import { verifyQuotes } from "./triage";

describe("what candidate emails say about future roles (Wave 0 item 0.11)", () => {
  it("offers the talent pool only to someone who has not said no to it, and acknowledges the choice otherwise", () => {
    expect(futureRolesLine({ preferences: {} })).toMatch(/reply "no thanks"/);
    const optedOut = futureRolesLine({ preferences: { talentPoolOptOut: true } });
    expect(optedOut).toBe("As you asked, we will not keep your details for future roles.");
    expect(optedOut).not.toMatch(/no thanks|keep your information/);
    expect(reminderClosingLine({ preferences: {} })).toMatch(/keep you in mind for future openings\.$/);
    expect(reminderClosingLine({ preferences: { talentPoolOptOut: true } })).toBe("If you are no longer interested, no reply is needed; we will close the application in a few days.");
  });
});

describe("the screening assistant states pay as the job page does (plan 0.8)", () => {
  const packet = {
    identity: { title: "Registered Dental Hygienist", employmentType: "full_time", locations: [{ city: "Irvine", region: "CA" }] },
    compensation: { basis: "hourly", min: 45, max: 55, currency: "USD", discloseRange: false },
    screening: { questions: [], maxMinutes: 10 },
    competencies: [],
    requirements: { mustHaves: [] },
    communication: { candidateMayBeTold: [], tone: "warm", humanAlternativeText: "Reply HUMAN for a person." },
    interviews: { plan: [] },
  } as unknown as ScreenContext["packet"];
  const ctx = (payShown?: boolean): ScreenContext => ({ company: { name: "Harbor Dental" }, packet, candidate: { firstName: "Dana" }, channel: "web", progress: { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 }, answers: {}, transcript: [], focusUnknowns: [], latestCandidateMessage: null, ...(payShown === undefined ? {} : { payShown }) });
  const system = (c: ScreenContext) => screenTurnPrompt.system(c).map((b) => b.text).join("\n");

  it("gives the range the law makes the public page show, even when the owner chose not to", () => {
    expect(screenTurnPrompt.version).toBe(2);
    expect(system(ctx(true))).toContain("Posted pay: hourly 45 to 55 USD.");
    expect(system(ctx(false))).toContain("Posted pay: not disclosed; say a person can discuss pay.");
    // without the public rule's answer, the owner's own choice
    expect(system(ctx())).toContain("Posted pay: not disclosed");
  });
});

describe("fake intake handler", () => {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const sys = (facts: unknown) => [
    { text: "system" },
    { text: "Vertical playbook: Dental v1.\nMatched playbook role: Registered Dental Hygienist. Summary: x." },
    { text: "Company: Brightline Dental. Vertical: dental. Size: 50-99 employees. Locations: Irvine, CA." },
    { text: "Compensation benchmark for Los Angeles-Long Beach-Anaheim, CA (hourly): p25 50, p50 57, p75 64. Source: playbook." },
    { text: `Facts established so far (JSON): ${JSON.stringify(facts)}` },
  ];

  it("extracts title, location, pay, and asks recruiter questions", async () => {
    const res = await fake.structured({
      task: "intake.turn", agent: "intake", companyId: "c", promptKey: "intake.turn", promptVersion: 1,
      system: sys({}),
      messages: [{ role: "user", content: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." }],
      schema: IntakeTurn, inputRef: {},
    }, "fake");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.output.factsExtracted.title).toBe("Registered Dental Hygienist");
    expect(res.output.factsExtracted.locationText).toBe("Irvine");
    expect(res.output.factsExtracted.compensationMin).toBe(45);
    expect(res.output.factsExtracted.compensationMax).toBe(55);
    expect(res.output.factsExtracted.compensationBasis).toBe("hourly");
    expect(res.output.factsExtracted.employmentType).toBe("full_time");
    expect(res.output.readyToCompile).toBe(false);
    expect(res.output.nextQuestions.length).toBeGreaterThan(0);
    expect(res.output.assistantMessage).toMatch(/below the midpoint/);
  });

  it("declines unlawful criteria and offers an alternative", async () => {
    const res = await fake.structured({
      task: "intake.turn", agent: "intake", companyId: "c", promptKey: "intake.turn", promptVersion: 1,
      system: sys({ title: "Registered Dental Hygienist" }),
      messages: [{ role: "user", content: "Also, only recent grads under 30 please, and no employment gaps." }],
      schema: IntakeTurn, inputRef: {},
    }, "fake");
    if (res.kind !== "ok") throw new Error("expected ok");
    expect(res.output.factsExtracted.declinedCriteria.length).toBeGreaterThanOrEqual(2);
    expect(res.output.assistantMessage).toMatch(/can't build/);
  });

  it("compiles a valid packet with declined criteria removed", async () => {
    const res = await fake.structured({
      task: "intake.compile", agent: "intake", companyId: "c", promptKey: "intake.compile", promptVersion: 1,
      system: sys({}).slice(0, 4),
      messages: [{ role: "user", content: `Established facts (JSON): ${JSON.stringify({ title: "Registered Dental Hygienist", locationText: "Irvine, CA", compensationMin: 45, compensationMax: 55, compensationBasis: "hourly", employmentType: "full_time", reason: "replacement", interviewers: ["Dr. Chen"], decisionMaker: "the owner", mustHaves: ["Active CA RDH license", "Perio experience"], declinedCriteria: [{ requested: "under 30", reason: "age", alternative: "" }] })}\n\nConversation transcript:\nowner: hi\n\nCompile the Role Packet now.` }],
      schema: RolePacket, inputRef: {},
    }, "fake");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.output.identity.title).toBe("Registered Dental Hygienist");
    expect(res.output.requirements.eligibility.some((e) => e.type === "license")).toBe(true);
    expect(res.output.compensation.ceiling).toBe(55);
    expect(JSON.stringify(res.output)).not.toMatch(/under 30/);
  });
});

describe("mergeFacts", () => {
  it("merges arrays without duplicates and keeps prior scalars", () => {
    const merged = mergeFacts({ mustHaves: ["a"], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [], title: "X" }, { mustHaves: ["A", "b"], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [], title: "" });
    expect(merged.mustHaves).toEqual(["a", "b"]);
    expect(merged.title).toBe("X");
  });
});

describe("verifyQuotes", () => {
  it("drops quotes that do not appear in the source", () => {
    const out = verifyQuotes({ positions: [{ title: "RDH", quote: "RDH at Smile Co 2019-2023", current: false }], education: [], licenses: [{ name: "RDH", quote: "invented line" }], certifications: [], skills: [], languages: [], anomalies: [], confidence: "medium" }, "Registered hygienist.\nRDH at Smile Co 2019-2023\n");
    expect(out.positions[0].quote).toBe("RDH at Smile Co 2019-2023");
    expect(out.licenses[0].quote).toBeUndefined();
  });
});
