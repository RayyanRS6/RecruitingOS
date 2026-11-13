import { describe, expect, it } from "vitest";
import { RolePacket as RolePacketSchema } from "@ros/contracts";
import { guardPacket, scoredSkill } from "@ros/core";
import { triageAssessPrompt } from "@ros/ai";
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

  // Review of the live-test fixes, 12 Nov 2026: drafts and jobs saved before the fix can keep a deal-breaker's own words as
  // a must-have, which the job page lists as wanted; nothing found them.
  it("finds a must-have or nice-to-have worded as what rules someone out, with the requirement it reads as when there is one", () => {
    const p = samplePacket((x) => {
      x.requirements.mustHaves.push(
        { key: "mh_rda", text: "No active California RDA license", rationale: "Required", evidencedBy: ["resume", "screen"] },
        { key: "mh_saturdays", text: "Cannot work Saturdays", rationale: "Saturday clinic", evidencedBy: ["screen"] },
        { key: "mh_short", text: "No RDA", rationale: "Required", evidencedBy: ["resume"] },
        { key: "mh_must", text: "Must work Saturdays", rationale: "Saturday clinic", evidencedBy: ["screen"] },
      );
      x.requirements.niceToHaves.push({ key: "nh_permit", text: "No x-ray permit", rationale: "Helpful", evidencedBy: ["resume"] });
      x.requirements.niceToHaves.push({ key: "nh_grads", text: "No recent grads", rationale: "Experience", evidencedBy: ["resume"] });
      x.preferences.dealBreakersInTheirWords = ["No active California RDA license", "Cannot work Saturdays"];
    });
    const check = checkRequirements(p, "v4", 4);
    const by = (id: string) => check.suggestions.find((s) => s.id === id);
    expect(by("rules_out:mustHaves:mh_rda")).toMatchObject({
      kind: "rules_out",
      title: "Reads as what rules someone out",
      path: "requirements.mustHaves[mh_rda]",
      text: "No active California RDA license",
      why: expect.stringMatching(/says who is ruled out.*Write it as what they need\.$/),
      fixes: [{ id: "rules_out:mustHaves:mh_rda:replace_text", op: "replace_text", label: 'Change it to "Active California RDA license"', after: "Active California RDA license" }],
    });
    expect(by("rules_out:mustHaves:mh_saturdays")?.fixes).toEqual([expect.objectContaining({ op: "replace_text", label: 'Change it to "Able to work Saturdays"', after: "Able to work Saturdays" })]);
    // a short form cannot be turned round: the person writes what they need
    expect(by("rules_out:mustHaves:mh_short")).toMatchObject({ fixes: [], why: expect.stringMatching(/Write it as what they need\.$/) });
    expect(by("rules_out:niceToHaves:nh_permit")?.fixes).toEqual([expect.objectContaining({ op: "replace_text", after: "X-ray permit" })]);
    // a requirement already worded as what they need is left alone, and a proxy keeps its own suggestion only
    expect(check.suggestions.filter((s) => s.text === "Must work Saturdays")).toEqual([]);
    expect(check.suggestions.filter((s) => s.text === "No recent grads").map((s) => s.kind)).toEqual(["proxy"]);
    // a suggestion, never a block: nothing changes until a fix is tapped, and then only its words
    const before = structuredClone(p);
    const out = applyRequirementFixes(p, ["rules_out:mustHaves:mh_rda:replace_text", "rules_out:mustHaves:mh_saturdays:replace_text"]);
    expect(p).toEqual(before);
    expect(out.packet.requirements.mustHaves.map((m) => m.text)).toEqual(["Radiography certificate", "Chairside experience in a dental office", "Active California RDA license", "Able to work Saturdays", "No RDA", "Must work Saturdays"]);
    expect(out.packet.preferences.dealBreakersInTheirWords).toEqual(["No active California RDA license", "Cannot work Saturdays"]);
    expect(out.applied).toEqual(['Changed "No active California RDA license" to "Active California RDA license".', 'Changed "Cannot work Saturdays" to "Able to work Saturdays".']);
    expect(checkRequirements(out.packet, "v5", 5).suggestions.filter((s) => s.kind === "rules_out").map((s) => s.id)).toEqual(["rules_out:mustHaves:mh_short", "rules_out:niceToHaves:nh_permit"]);
    expect(RolePacketSchema.safeParse(out.packet).success).toBe(true);
  });

  // Review of the hire-again fix, 12 Nov 2026: the one tap turned a rule worded in the negative into its opposite ("Will
  // not share patient information" offered "Willing to share patient information").
  it("turns words round in one tap only for a credential someone lacks or a deal-breaker's own words, never a rule worded in the negative", () => {
    const rules = ["Will not share patient information", "Won't call out last minute", "Can't use a phone with patients", "Not registered as a sex offender"];
    const p = samplePacket((x) => {
      x.requirements.mustHaves.push(...rules.map((text, i) => ({ key: `mh_rule${i}`, text, rationale: "An office rule", evidencedBy: ["interview" as const] })));
      x.requirements.niceToHaves.push({ key: "nh_saturdays", text: "Cannot work Saturdays", rationale: "Saturday clinic", evidencedBy: ["screen"] });
      x.requirements.niceToHaves.push({ key: "nh_bls", text: "Without a current BLS certification", rationale: "Helpful", evidencedBy: ["resume"] });
    });
    const check = checkRequirements(p, "v6", 6);
    const on = (text: string) => check.suggestions.filter((s) => s.text === text);
    // still found, with the line asking for what they need, and no tap to its opposite
    for (const text of [...rules, "Cannot work Saturdays"]) expect(on(text), text).toEqual([expect.objectContaining({ kind: "rules_out", fixes: [], why: expect.stringMatching(/Write it as what they need\.$/) })]);
    expect(() => applyRequirementFixes(p, ["rules_out:mustHaves:mh_rule0:replace_text"])).toThrow(RequirementFixError);
    // a credential someone lacks is turned round whoever wrote it
    expect(on("Without a current BLS certification")[0]?.fixes).toEqual([expect.objectContaining({ op: "replace_text", label: 'Change it to "Current BLS certification"', after: "Current BLS certification" })]);
    // the very words of one of the deal-breakers (case and punctuation aside) are turned round
    const deal = structuredClone(p);
    deal.preferences.dealBreakersInTheirWords = ["cannot work Saturdays."];
    expect(checkRequirements(deal, "v7", 7).suggestions.find((s) => s.id === "rules_out:niceToHaves:nh_saturdays")?.fixes).toEqual([expect.objectContaining({ op: "replace_text", label: 'Change it to "Able to work Saturdays"', after: "Able to work Saturdays" })]);
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
    // judged in the interview only: never read from a résumé or a chat, never in the match score (known bug 18)
    expect(scoredSkill(added)).toBe(false);
    expect(triageAssessPrompt.system({ packet: out.packet, extraction: null, resumeText: null, applicationAnswers: { eligibility: {} }, eligibility: null }).map((b) => b.text).join("\n")).not.toContain(`[${added.key}]`);
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
