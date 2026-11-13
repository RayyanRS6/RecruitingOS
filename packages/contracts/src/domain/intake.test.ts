import { describe, expect, it } from "vitest";
import { IntakeFacts, IntakeTurn, askedKind, lacksCredential, mustHaveOf, restatementsOf, rulesOut } from "./intake";
import { withoutOwnersCallMark } from "./playbook";

/**
 * A deal-breaker as the must-have it rules people out on (live test, 12 November 2026: "No active California RDA
 * license" became a must-have in those very words). Only clear shapes are turned round; anything else stays as written,
 * so the fairness check still reads the owner's own words, and it is never turned into its opposite (review of the live
 * test, 12 Nov 2026).
 */
describe("a deal-breaker as the must-have it counts as", () => {
  it("turns round a missing licence, certificate or permit, and what someone cannot or will not do", () => {
    expect(mustHaveOf("No active California RDA license")).toBe("Active California RDA license");
    expect(mustHaveOf("no current BLS certification")).toBe("Current BLS certification");
    expect(mustHaveOf("Does not have an X-ray permit")).toBe("X-ray permit");
    expect(mustHaveOf("Without a valid driver's licence")).toBe("Valid driver's licence");
    expect(mustHaveOf("Cannot work Saturdays")).toBe("Able to work Saturdays");
    expect(mustHaveOf("Can't lift 50 pounds")).toBe("Able to lift 50 pounds");
    expect(mustHaveOf("Unable to start within two weeks")).toBe("Able to start within two weeks");
    expect(mustHaveOf("Not licensed in California")).toBe("Licensed in California");
    expect(mustHaveOf("not available on weekends")).toBe("Available on weekends");
    expect(mustHaveOf("Won't work weekends")).toBe("Willing to work weekends");
    expect(mustHaveOf("  No   active  CA RDH license ")).toBe("Active CA RDH license");
    // the credential named last, in the singular or the plural, a full stop after it too
    expect(mustHaveOf("No RDA license")).toBe("RDA license");
    expect(mustHaveOf("Without an RDA license")).toBe("RDA license");
    expect(mustHaveOf("Lacks a ServSafe certificate")).toBe("ServSafe certificate");
    expect(mustHaveOf("Missing CPR certification.")).toBe("CPR certification.");
    expect(mustHaveOf("No ASE certifications")).toBe("ASE certifications");
    expect(mustHaveOf("No state nursing licensure")).toBe("State nursing licensure");
    expect(mustHaveOf("No notary registration")).toBe("Notary registration");
  });

  it("keeps everything else as written, so a proxy is still refused in the owner's own words", () => {
    for (const same of ["Must work Saturdays", "No recent grads", "No felons", "Smokers", "No kids", "No RDA", "Active CA RDH license"]) expect(mustHaveOf(same), same).toBe(same);
  });

  // review of the live test, 12 Nov 2026: each of these became its opposite ("No expired RDH license" asked for an
  // "Expired RDH license"), or a bare short form became a must-have
  it("never turns a deal-breaker into its opposite: a licence not in force, the problem itself, or a rule comes back as typed", () => {
    const asTyped = [
      // a licence word inside what rules people out (#3)
      "No felonies or license suspensions", "No criminal record or license discipline", "No gaps in license", "No kids or lapsed licenses", "No health issues or expired certifications",
      // a licence not in force (#14, #62)
      "No expired RDH license", "No lapsed X-ray permit", "No RDH license that has expired", "No suspended or revoked license", "No pending BLS certification",
      "No expired BLS certification", "No lapsed CPR certification", "No suspended license", "No license suspensions", "No drivers with suspended licenses",
      // the problem itself, or a licence word that is part of another word (#35, #62)
      "No license issues", "No unlicensed assistants", "No expired or suspended license", "No out-of-state licenses", "No registered sex offenders",
      "No smoking permitted", "No phones permitted", "No expired license", "No lapsed certification", "No uncertified staff", "No license violations",
      "No unlicensed contractors", "No uncertified techs", "No one without a valid driver's license",
      // a rule, not what someone is unable to do (#35)
      "Cannot be late", "Cannot have a criminal record", "Can't be on call",
      // short forms and other shapes, which the owner words as what they need (#11, #37)
      "No RDA", "No x-ray cert", "No BLS", "No CPR", "No RDH", "No DUI", "Cant work weekends", "Wont travel", "Doesnt drive", "Never late", "Must not smoke", "No weekends", "No experience", "No reliable transportation",
    ];
    for (const same of asTyped) expect(mustHaveOf(same), same).toBe(same);
    expect(mustHaveOf("No expired BLS certification")).not.toBe("Expired BLS certification");
  });

  it("knows the must-haves a deal-breaker can come back as, its opposite too, so a refused one is refused in each", () => {
    expect(restatementsOf("No felonies or license suspensions")).toEqual(["No felonies or license suspensions", "Felonies or license suspensions"]);
    expect(restatementsOf("No gaps in license")).toEqual(["No gaps in license", "Gaps in license"]);
    expect(restatementsOf("No recent grads")).toEqual(["No recent grads", "Recent grads"]);
    expect(restatementsOf(" No  active California RDA license")).toEqual(["Active California RDA license"]);
    expect(restatementsOf("Cannot work Saturdays")).toEqual(["Able to work Saturdays"]);
    expect(restatementsOf("Smokers")).toEqual(["Smokers"]);
  });

  // review of the hire-again fix, 12 Nov 2026: only a credential someone lacks is turned round whoever wrote the words; "Will
  // not share patient information" is a rule worded in the negative, and its opposite is no requirement
  it("knows the one shape it turns round whoever wrote it: a credential someone lacks", () => {
    for (const t of ["No active California RDA license", "no current BLS certification", "Does not have an X-ray permit", "Without a valid driver's licence", "Missing CPR certification.", "  No   active  CA RDH license "]) {
      expect(lacksCredential(t), t).toBe(true);
      expect(mustHaveOf(t), t).not.toBe(t.trim().replace(/\s+/g, " "));
    }
    for (const t of ["Cannot work Saturdays", "Won't work weekends", "Not licensed in California", "Will not share patient information", "Not registered as a sex offender", "No RDA", "No expired RDH license", "No license issues", "No felonies or license suspensions", "Active California RDA license", ""]) expect(lacksCredential(t), t).toBe(false);
  });
});

describe("words that rule someone out", () => {
  it("start with a no, a not or a cannot, in any case, with an apostrophe or without", () => {
    const out = [
      "No RDA", "  NO x-ray cert", "not licensed", "Never late", "Without a car", "Lacks a CDL", "Lacking BLS", "Missing BLS", "Cannot work Saturdays", "Can not work Saturdays",
      "Can't work Saturdays", "Can’t work Saturdays", "Cant work weekends", "Won't travel", "Wont travel", "Will not travel", "Unable to lift 50 pounds", "Unwilling to travel",
      "Does not drive", "Doesn't drive", "Doesnt drive", "Do not smoke", "Don't smoke", "Dont smoke", "Must not smoke", "Mustn't smoke",
    ];
    for (const t of out) expect(rulesOut(t), t).toBe(true);
    for (const t of ["Able to work Saturdays", "Active California RDA license", "Willing to travel", "Notary registration", "Nothing to add", "Non-smoker", "Smokers", "Must work Saturdays", "Knows Dentrix", "Cantonese speaker", ""]) expect(rulesOut(t), t).toBe(false);
  });

  it("are never what a deal-breaker turned round reads as", () => {
    for (const d of ["No active California RDA license", "Cannot work Saturdays", "Not licensed in California", "Won't work weekends", "Missing CPR certification."]) expect(rulesOut(mustHaveOf(d)), d).toBe(false);
  });
});

// Review of the live-test fixes, 12 Nov 2026: a note the assistant read was taken for the owner's choice of the form's
// questions, and the draft prompt's mark could reach a card the owner reads.
describe("what only the server sets, and words only the AI reads", () => {
  it("never takes the marker that the owner went through the questions for the form from what the assistant extracts", () => {
    const turn = IntakeTurn.parse({ assistantMessage: "Noted.", factsExtracted: { eligibilityNotes: ["Able to work Saturdays"], formQuestionsChosen: true }, missingFacts: [], readyToCompile: false, confidence: "low" });
    expect(turn.factsExtracted.eligibilityNotes).toEqual(["Able to work Saturdays"]);
    expect("formQuestionsChosen" in turn.factsExtracted).toBe(false);
    // the facts themselves keep it, as the server set it
    expect(IntakeFacts.parse({ formQuestionsChosen: true }).formQuestionsChosen).toBe(true);
  });

  it("takes the owner's-call mark, or any '(ask only when …)', out of words a model wrote, and leaves other words alone", () => {
    const rda = "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?";
    expect(withoutOwnersCallMark(`${rda} (ask only when the owner requires it)`)).toBe(rda);
    expect(withoutOwnersCallMark("Are you available on Saturdays? (Ask only when the office opens then)")).toBe("Are you available on Saturdays?");
    expect(withoutOwnersCallMark("Which certifications do you hold (ask only when the owner requires it)?")).toBe("Which certifications do you hold?");
    for (const t of [rda, "  Words as typed  ", "Do you hold a CDL (class A)?"]) expect(withoutOwnersCallMark(t), t).toBe(t);
  });
});

// Review of the form-questions fix, 12 Nov 2026: no short form names the schedule or the right to work, so a model's own
// wording of one left unticked stayed on the form, and the quick start offered the assistant's second copy of each.
describe("the kind of rule a question for the form asks, by its words", () => {
  it("reads the schedule and the right to work in any words, and nothing else as either", () => {
    for (const q of ["Are you available for the days this office is open?", "Which of these days can you work: Mon, Tue, Wed, Thu, Fri?", "Are you able to work Saturdays?", "Can you work our regular hours?", "Are you available for the posted schedule and work model?"]) expect(askedKind(q), q).toBe("schedule_availability");
    for (const q of ["Are you legally authorized to work in the United States for any employer?", "Are you authorized to work in the U.S.?", "Will you now or in the future require visa sponsorship?"]) expect(askedKind(q), q).toBe("work_authorization");
    for (const q of ["Can you start within 30 days?", "Are you available to start within two weeks?", "Can you get to the workplace on the days the job needs?", "Do you hold current CPR/BLS certification?", "Can you stand for an 8-hour shift?", "Do you have reliable transportation available for your shifts?", "Can you lift 50 lb?"]) expect(askedKind(q), q).toBeNull();
  });
});
