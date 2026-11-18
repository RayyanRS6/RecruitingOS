import { describe, expect, it } from "vitest";
import { ADVERSE_DECISION_LINE, adverseDecisionLineApplies, regionFromLocationText } from "@ros/core";
import { DECISION_TEMPLATE, decisionMessage } from "./coordinator";
import { samplePacket } from "./fixtures/sample-packet";

/**
 * Telling candidates: the one standard wording and the locked footer, and Colorado's line. Pure pieces; the scenario
 * test (tests/scenario/hiring.test.ts) runs them end to end.
 */
const company = { id: "c1", name: "Harbor Dental", settings: {} } as never;
const candidate = { firstName: "Ana" } as never;
/** The job's own lines, as the sample job stores them, ask for a reply with a keyword; an email says these instead. */
const PERSON_LINE = "To reach a person at any time, reply to this email.";
const DISCLOSURE = "This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant.";

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
    const order = [packet.communication.signature, PERSON_LINE, ADVERSE_DECISION_LINE.text, DISCLOSURE].map((s) => m.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(m.text.endsWith(DISCLOSURE)).toBe(true);
    // without Colorado the line is not there, and nothing else changes
    expect(write().text).not.toContain(ADVERSE_DECISION_LINE.text);
    expect(write().text).toBe(m.text.replace(`${ADVERSE_DECISION_LINE.text}\n\n`, ""));
  });

  it("never asks for a reply with a keyword nothing reads: it names the company's own contact when it set one, else a reply, once", () => {
    expect(packet.communication.humanAlternativeText).toMatch(/HUMAN/);
    expect(packet.communication.disclosureText).toMatch(/HUMAN/);
    expect(write().text).not.toMatch(/HUMAN/);
    expect(write().text.match(/To reach a person at any time/g)).toHaveLength(1);
    const withContact = { id: "c1", name: "Harbor Dental", settings: { hiringContact: { email: "jobs@harbor.test", name: "Maya" } } } as never;
    const own = decisionMessage({ candidate, company: withContact, packet, adverseDecisionLine: false }).text;
    expect(own).toContain("To reach a person at any time, email jobs@harbor.test.");
    expect(own).not.toMatch(/HUMAN|reply to this email/);
    // a job whose own lines ask for no keyword keeps them word for word
    const plain = structuredClone(packet);
    plain.communication.humanAlternativeText = "You can always ask for a person.";
    plain.communication.disclosureText = "Sent with help from an AI assistant.";
    const kept = decisionMessage({ candidate, company, packet: plain, adverseDecisionLine: false }).text;
    expect(kept).toContain("You can always ask for a person.\n\nSent with help from an AI assistant.");
    expect(kept).not.toContain("To reach a person at any time");
    // and one whose disclosure alone carries the keyword gets the line there
    plain.communication.disclosureText = "Written with help from an AI assistant. Reply HUMAN to reach a person.";
    expect(decisionMessage({ candidate, company, packet: plain, adverseDecisionLine: false }).text.endsWith(`Written with help from an AI assistant. ${PERSON_LINE}`)).toBe(true);
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
    // it asks for a reply, which a person reads, and for no keyword, which nothing reads
    expect(ADVERSE_DECISION_LINE.text).toContain("Reply to this email within 30 days, and someone who was not part of the decision will answer you.");
    expect(ADVERSE_DECISION_LINE.text).not.toMatch(/EXPLAIN/);
  });
});
