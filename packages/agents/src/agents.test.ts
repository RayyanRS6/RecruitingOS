import { describe, expect, it } from "vitest";
import { FakeProvider } from "@ros/ai";
import { IntakeTurn, RolePacket } from "@ros/contracts";
import { registerFakeHandlers } from "./fake-handlers";
import { mergeFacts } from "./intake";
import { verifyQuotes } from "./triage";

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
