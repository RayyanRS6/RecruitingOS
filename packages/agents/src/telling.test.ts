import { describe, expect, it } from "vitest";
import { ADVERSE_DECISION_LINE, adverseDecisionLineApplies, regionFromLocationText } from "@ros/core";
import { decisionTemplateKey, dispositionMessage } from "./coordinator";
import { samplePacket } from "./fixtures/sample-packet";

/**
 * Telling candidates: the approved wordings and the locked footer, and Colorado's line. Pure pieces; the API tests
 * (apps/api/src/telling-candidates.test.ts) run them end to end.
 */
const company = { id: "c1", name: "Harbor Dental" } as never;
const candidate = (over: { talentPoolOptOut?: boolean } = {}) => ({ firstName: "Ana", preferences: { talentPoolOptOut: over.talentPoolOptOut } }) as never;

describe("the decision message (Q28)", () => {
  const packet = samplePacket();
  const write = (wording: Parameters<typeof dispositionMessage>[0]["wording"], extra: Partial<Parameters<typeof dispositionMessage>[0]> = {}) => dispositionMessage({ candidate: candidate(), company, packet, wording, ...extra });

  it("says the decision in one of the approved wordings, each under its own template key, and never gives a reason", () => {
    expect(write("v1").text).toContain("After reviewing your background against what this role needs, the team has decided not to move forward at this time.");
    expect(write("v2").text).toContain("After careful thought, the team at Harbor Dental has decided not to move forward");
    expect(write("v3").text).toContain("The team has decided not to move forward with your application for this role.");
    expect(write("after_interview").text).toContain("Thank you for taking the time to meet the team at Harbor Dental.");
    expect(write("position_filled").text).toContain("The position has now been filled");
    expect(write("role_closed").text).toContain("Harbor Dental has closed this position");
    expect(write("eligibility").text).toContain("reply to this email and a person will take a look");
    expect(["v1", "v2", "v3", "after_interview", "position_filled", "role_closed", "eligibility"].map((w) => decisionTemplateKey(w as never))).toEqual(["disposition:human", "disposition:human:v2", "disposition:human:v3", "disposition:after_interview", "disposition:position_filled", "disposition:role_closed", "disposition:eligibility"]);
    for (const w of ["v1", "v2", "v3", "after_interview", "position_filled", "role_closed"] as const) expect(write(w).text).not.toMatch(/score|experience was|skills|pay|because you/i);
  });

  it("ends with the locked footer: future roles with the status link, how to reach a person, Colorado's line when it applies, the AI disclosure", () => {
    const m = write("v1", { statusUrl: "https://jobs.example/c/status/tok", adverseDecisionLine: true });
    const order = [
      packet.communication.signature,
      "reply \"no thanks\"",
      "You can also choose this on your status page: https://jobs.example/c/status/tok",
      packet.communication.humanAlternativeText,
      ADVERSE_DECISION_LINE.text,
      packet.communication.disclosureText,
    ].map((s) => m.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // without Colorado and for someone who already said no to future roles: their choice is acknowledged, no link offered
    const other = dispositionMessage({ candidate: candidate({ talentPoolOptOut: true }), company, packet, wording: "role_closed", statusUrl: "https://jobs.example/c/status/tok" });
    expect(other.text).toContain("As you asked, we will not keep your details for future roles.");
    expect(other.text).not.toContain("status page");
    expect(other.text).not.toContain(ADVERSE_DECISION_LINE.text);
  });
});

describe("Colorado's adverse-decision line (plan G5)", () => {
  it("reads a state from what the candidate wrote, only when it is plain", () => {
    expect(regionFromLocationText("Denver, CO")).toBe("CO");
    expect(regionFromLocationText("Boulder, Colorado 80302")).toBe("CO");
    expect(regionFromLocationText("colorado")).toBe("CO");
    expect(regionFromLocationText("Charleston, West Virginia")).toBe("WV");
    expect(regionFromLocationText("Irvine, CA 92618, USA")).toBe("CA");
    expect(regionFromLocationText("Colorado Springs")).toBe("CO");
    expect(regionFromLocationText("somewhere nice")).toBeNull();
    expect(regionFromLocationText("Paris, TX")).toBe("TX");
    expect(regionFromLocationText(null)).toBeNull();
  });

  it("applies when the job is in Colorado or the candidate is, and is marked as draft wording for counsel", () => {
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Denver", region: "CO", country: "US" }] })).toBe(true);
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Irvine", region: "CA", country: "US" }], candidateLocationText: "Aurora, CO" })).toBe(true);
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Irvine", region: "CA", country: "US" }], candidateLocationText: "Tustin, CA" })).toBe(false);
    expect(ADVERSE_DECISION_LINE).toMatchObject({ counselStatus: "draft", jurisdictions: ["US-CO"] });
    expect(ADVERSE_DECISION_LINE.text).toMatch(/EXPLAIN/);
  });
});
