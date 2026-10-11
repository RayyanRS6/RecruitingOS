import { describe, expect, it } from "vitest";
import { RolePacket as RolePacketSchema } from "@ros/contracts";
import { guardPacket } from "@ros/core";
import { samplePacket } from "./fixtures/sample-packet";
import { RequirementFixError, applyRequirementFixes, checkRequirements } from "./requirements-check";

/**
 * The requirements check before approval (plan C16): rules, never a score. Each suggestion says why in plain words and
 * offers one-tap fixes; nothing changes until a person applies a fix, and a fix never leaves the packet incomplete.
 */
describe("the requirements check", () => {
  it("finds nothing to suggest in a fair, checkable packet", () => {
    const check = checkRequirements(samplePacket(), "v1", 1);
    expect(check.suggestions).toEqual([]);
    expect(check.summary).toMatch(/Nothing to suggest/);
    expect(JSON.stringify(check)).not.toMatch(/score/i);
  });

  it("names unprovable must-haves, traits presented as skills, duplicates, proxies and maximum years, each with a reason", () => {
    const p = samplePacket((x) => {
      x.requirements.mustHaves.push(
        { key: "mh_stay", text: "Will stay with us for at least 3 years", rationale: "Turnover", evidencedBy: ["interview"] },
        { key: "mh_attitude", text: "Team player with a positive attitude", rationale: "Small team", evidencedBy: ["interview"] },
        { key: "mh_years", text: "2-5 years of chairside experience", rationale: "Experience", evidencedBy: ["resume"] },
        { key: "mh_english", text: "Native English speaker", rationale: "Patients", evidencedBy: ["screen"] },
      );
      x.requirements.niceToHaves.push({ key: "nh_xray", text: "Radiography certificate", rationale: "Again", evidencedBy: ["resume"] });
      x.requirements.niceToHaves.push({ key: "nh_cap", text: "Comfortable with digital x-rays, no more than 5 years of experience", rationale: "Budget", evidencedBy: ["resume"] });
      x.screening.questions.push({ key: "history", question: "What is your current salary?", kind: "compensation" });
    });
    const check = checkRequirements(p, "v2", 2);
    const by = (id: string) => check.suggestions.find((s) => s.id === id);
    expect(by("unprovable:mustHaves:mh_stay")).toMatchObject({ kind: "unprovable", title: "Hard to check before someone starts", path: "requirements.mustHaves[mh_stay]" });
    expect(by("trait_as_skill:mustHaves:mh_attitude")?.why).toMatch(/personality trait/);
    expect(by("max_years:mustHaves:mh_years")?.fixes).toEqual([expect.objectContaining({ op: "replace_text", after: "2 or more years of chairside experience" })]);
    expect(by("max_years:niceToHaves:nh_cap")?.fixes).toEqual([expect.objectContaining({ op: "replace_text", after: "Comfortable with digital x-rays" }), expect.objectContaining({ op: "remove" })]);
    expect(by("proxy:mustHaves:mh_english")?.fixes.map((f) => f.op)).toEqual(["replace_text", "remove"]);
    expect(by("duplicate:niceToHaves:nh_xray")?.why).toMatch(/already a must-have/);
    expect(by("proxy:screening:history")?.fixes[0]).toMatchObject({ op: "replace_text", after: "What pay are you looking for?" });
    // a real skill with a trait word beside it is left alone
    expect(check.suggestions.some((s) => s.text === "Chairside experience in a dental office")).toBe(false);
    expect(check.summary).toMatch(/Nothing changes unless you apply a fix/);
  });

  it("points at the packet guard's flag on the same words, so one fix clears both", () => {
    const p = samplePacket((x) => x.requirements.mustHaves.push({ key: "mh_english", text: "Native English speaker", rationale: "Patients", evidencedBy: ["screen"] }));
    const guarded = guardPacket(p, { companyName: "Harbor Dental", companyLocations: [] }).packet;
    const flag = guarded.provenance.flags!.find((f) => f.path === "requirements.mustHaves[2].text")!;
    expect(checkRequirements(guarded, "v1").suggestions.find((s) => s.kind === "proxy")?.flagId).toBe(flag.id);
    const fixed = applyRequirementFixes(guarded, ["proxy:mustHaves:mh_english:replace_text"]).packet;
    expect(guardPacket(fixed, { companyName: "Harbor Dental", companyLocations: [] }).flags).toEqual([]);
  });

  it("applies only the fixes tapped: reworded, taken out, or moved to the interview as something to look for", () => {
    const p = samplePacket((x) => {
      x.requirements.mustHaves.push({ key: "mh_attitude", text: "Team player with a positive attitude", rationale: "Small team", evidencedBy: ["interview"] });
      x.requirements.mustHaves.push({ key: "mh_stay", text: "Will stay with us for at least 3 years", rationale: "Turnover", evidencedBy: ["interview"] });
      x.screening.questions.push({ key: "history", question: "What is your current salary?", kind: "compensation", modelAnswer: "A number" });
    });
    const before = structuredClone(p);
    const out = applyRequirementFixes(p, ["trait_as_skill:mustHaves:mh_attitude:to_interview", "unprovable:mustHaves:mh_stay:remove", "proxy:screening:history:replace_text", "unprovable:mustHaves:mh_stay:to_interview"]);
    expect(p).toEqual(before);
    expect(out.packet.requirements.mustHaves.map((m) => m.key)).toEqual(["mh_xray", "mh_chairside"]);
    const added = out.packet.competencies.find((c) => c.definition === "Team player with a positive attitude")!;
    expect(added).toMatchObject({ evaluatedIn: "interview", weight: 3 });
    expect(out.packet.interviews.plan[0].competencyKeys).toContain(added.key);
    expect(out.packet.screening.questions.find((q) => q.key === "history")).toEqual({ key: "history", question: "What pay are you looking for?", kind: "compensation" });
    // a second tap on the same item is skipped, never applied twice
    expect(out.skipped).toEqual(["unprovable:mustHaves:mh_stay:to_interview"]);
    expect(out.applied).toHaveLength(3);
    expect(RolePacketSchema.safeParse(out.packet).success).toBe(true);
  });

  it("never offers a fix that would leave the packet incomplete, and refuses one that would", () => {
    const one = samplePacket((x) => {
      x.requirements.mustHaves = [{ key: "mh_attitude", text: "Hard-working and reliable", rationale: "Small team", evidencedBy: ["interview"] }];
      x.screening.questions = x.screening.questions.slice(0, 3);
      x.screening.questions.push({ key: "recent_again", question: "Tell me about your most recent dental assisting work.", kind: "skills" });
    });
    const check = checkRequirements(one, "v1");
    expect(check.suggestions.find((s) => s.id === "trait_as_skill:mustHaves:mh_attitude")?.fixes).toEqual([]);
    const dup = check.suggestions.find((s) => s.id === "duplicate:screening:recent_again")!;
    expect(dup.fixes.map((f) => f.op)).toEqual(["remove"]);
    const three = structuredClone(one);
    three.screening.questions = three.screening.questions.slice(0, 2).concat(three.screening.questions.slice(3));
    expect(checkRequirements(three, "v1").suggestions.find((s) => s.kind === "duplicate")?.fixes).toEqual([]);
    expect(() => applyRequirementFixes(one, ["nope"])).toThrow(RequirementFixError);
    const crowded = samplePacket((x) => {
      for (let i = 0; i < 5; i += 1) x.competencies.push({ key: `extra_${i}`, name: `Extra ${i}`, definition: "More.", weight: 2, evaluatedIn: "interview", indicators: ["x"] });
      x.requirements.mustHaves.push({ key: "mh_reliable", text: "Reliable and punctual", rationale: "Small team", evidencedBy: ["interview"] });
    });
    expect(() => applyRequirementFixes(crowded, ["trait_as_skill:mustHaves:mh_reliable:to_interview"])).toThrow(/eight things at most/);
  });
});
