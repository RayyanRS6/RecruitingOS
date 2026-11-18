import { describe, expect, it } from "vitest";
import { screenTurnPrompt, type ScreenContext } from "@ros/ai";
import { futureRolesLine, reminderClosingLine } from "./coordinator";
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
    // Version 4 (a close that promises no time) keeps the pay rule of version 2; version 5 (Wave S5) leaves out skills
    // checked in the interviews only; version 6 (Wave S7) adds the Kanvis-style chat, and without a plan says what 5 said;
    // version 7 (Wave S9) states the turn's contract (follow-ups labelled, a candidate's question never recorded, help and
    // a person for a confused candidate) and keeps the pay rule; version 8 (the 22 Oct 2026 try-out) never asks again for
    // what the candidate already said.
    expect(screenTurnPrompt.version).toBe(8);
    expect(system(ctx())).toContain("Never ask for anything the candidate has already told you in this conversation, above all in their latest reply.");
    // doubt is only about what was already said: a must-have their words do not plainly confirm keeps its follow-up
    expect(system(ctx())).toContain("When in doubt whether they already said it, do not ask it again; but a must-have their words do not plainly confirm (a license held, never said to be active) still gets its one short follow-up.");
    expect(system(ctx())).not.toContain("when in doubt, move on");
    expect(system(ctx())).toContain("never state or suggest a time");
    expect(system(ctx())).not.toMatch(/few days/);
    expect(system(ctx(true))).toContain("Posted pay: hourly 45 to 55 USD.");
    expect(system(ctx(false))).toContain("Posted pay: not disclosed; say a person can discuss pay.");
    // without the public rule's answer, the owner's own choice
    expect(system(ctx())).toContain("Posted pay: not disclosed");
  });
});

describe("verifyQuotes", () => {
  it("drops quotes that do not appear in the source", () => {
    const out = verifyQuotes({ positions: [{ title: "RDH", quote: "RDH at Smile Co 2019-2023", current: false }], education: [], licenses: [{ name: "RDH", quote: "invented line" }], certifications: [], skills: [], languages: [], anomalies: [], confidence: "medium" }, "Registered hygienist.\nRDH at Smile Co 2019-2023\n");
    expect(out.positions[0].quote).toBe("RDH at Smile Co 2019-2023");
    expect(out.licenses[0].quote).toBeUndefined();
  });
});
