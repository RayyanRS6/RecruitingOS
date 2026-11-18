import { describe, expect, it } from "vitest";
import { ADVERSE_DECISION_LINE, adverseDecisionLineApplies, regionFromLocationText } from "@ros/core";
import { DECISION_TEMPLATE, decisionMessage } from "./coordinator";
import { samplePacket } from "./fixtures/sample-packet";

/**
 * Telling candidates: the one standard wording and the locked footer, and Colorado's line. Pure pieces; the scenario
 * test (tests/scenario/hiring.test.ts) runs them end to end.
 */
const company = { id: "c1", name: "Harbor Dental" } as never;
const candidate = { firstName: "Ana" } as never;

describe("the decision message", () => {
  const packet = samplePacket();
  const write = (adverseDecisionLine = false) => decisionMessage({ candidate, company, packet, adverseDecisionLine });

  it("says the decision in the one standard wording, under one template key, and never gives a reason", () => {
    expect(write().subject).toBe("Your application to Harbor Dental");
    expect(write().text).toContain("Hi Ana,");
    expect(write().text).toContain(`Thank you for your interest in the ${packet.identity.title} position at Harbor Dental.`);
    expect(write().text).toContain("After reviewing your background against what this role needs, the team has decided not to move forward at this time.");
    expect(DECISION_TEMPLATE).toBe("disposition");
    expect(write().text).not.toMatch(/score|experience was|because you|future (roles|openings)|no thanks/i);
  });

  it("ends with the locked footer: the signature, how to reach a person, Colorado's line when it applies, the AI disclosure", () => {
    const m = write(true);
    const order = [packet.communication.signature, packet.communication.humanAlternativeText, ADVERSE_DECISION_LINE.text, packet.communication.disclosureText].map((s) => m.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // without Colorado the line is not there, and nothing else changes
    expect(write().text).not.toContain(ADVERSE_DECISION_LINE.text);
    expect(write().text).toBe(m.text.replace(`${ADVERSE_DECISION_LINE.text}\n\n`, ""));
  });
});

describe("Colorado's adverse-decision line", () => {
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
