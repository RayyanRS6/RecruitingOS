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

  // review of the must-haves fix, 12 Nov 2026: a problem joined to the licence ("points on", "a lapse in"), a noun form of
  // a word that says it is not in force, and a ban with a verb only the employer does were each turned into their opposite
  it("never turns round a problem joined to the licence, any form of a word that says it is not in force, or an employer's ban", () => {
    const asTyped = [
      // a problem joined to the licence, or a kind of licence that is not in force, in any form of the word
      "No points on driver's license", "No DUIs on license", "No restrictions on license", "No lapse in BLS certification", "No revocation of license", "No probation on license",
      "No sanctions on license", "No tickets on driver's license", "No board action against license", "No encumbered license", "No hardship license", "No conditional license",
      "No suspension of license", "No expiration on CPR certification", "No proof of license", "No felony convictions or license",
      // a verb only the employer does: the owner's rule, never what the candidate is willing to do
      "Won't hire smokers", "Won’t hire smokers", "Will not hire smokers", "Won't consider anyone without a license", "Will not accept applicants without a CDL",
      "Won't tolerate tardiness", "Not willing to hire anyone with a DUI", "Unwilling to sponsor visas",
    ];
    for (const t of asTyped) {
      expect(mustHaveOf(t), t).toBe(t);
      // still worded as what rules someone out: asked of the owner as what they need
      expect(rulesOut(mustHaveOf(t)), t).toBe(true);
      expect(lacksCredential(t), t).toBe(false);
    }
    // the shapes that are a credential someone lacks, or what the candidate will not do, are still turned round
    expect(mustHaveOf("Won't work weekends")).toBe("Willing to work weekends");
    expect(mustHaveOf("Unwilling to travel")).toBe("Willing to travel");
    expect(mustHaveOf("Will not relocate")).toBe("Willing to relocate");
    expect(mustHaveOf("No in-state license")).toBe("In-state license");
    expect(mustHaveOf("No CPR or BLS certification")).toBe("CPR or BLS certification");
    expect(mustHaveOf("No up-to-date BLS certification")).toBe("Up-to-date BLS certification");
  });

  // left out by the repair of the must-haves (lead's decision, 17 Nov 2026): "Can't accept applicants without a license"
  // became "Able to accept applicants without a license", and "Cannot hire anyone who smokes" "Able to hire anyone who
  // smokes", which the AI interview then asked about
  it("never turns round what the employer does to the people applying, or words naming them, and still turns round what the candidate cannot do", () => {
    const asTyped = [
      "Can't accept applicants without a license", "Cannot hire anyone who smokes",
      // a verb an employer does to applicants, after each way of saying cannot, a word such as "currently" before it too
      "Cannot accept walk-in applications", "Can't hire smokers", "Can’t take walk-ins", "Can not take on new grads", "Unable to consider résumés without a license",
      "Not able to employ minors", "Cannot interview on weekends", "Can't onboard before the license arrives", "Unable to sponsor visas", "Cannot bring on staff without a license",
      "Can't use temps", "Cannot allow phones on the floor", "Unable to offer relocation", "Can't pay more than $25 an hour", "Cannot currently sponsor visas",
      // words naming the people applying, whatever the verb
      "Cannot let applicants start without a license", "Cannot let an applicant start without a license", "Can't work with candidates who smoke", "Unable to start anyone without a license",
      "Cannot train anybody on the job", "Can't keep someone without experience", "Cannot work with somebody who smokes", "Unable to work with people who smoke",
      "Cannot keep those without a license", "Can't train new hires", "Can't train a new hire",
      // a hire, or a new hire, after a word that picks one out, is a person too
      "Can't keep a hire who is late", "Cannot train the new hire", "Can't let any new hire work alone",
      // the verb after "afford to", "just", "even", "ever" or "by law", "re-hire" and "rehire", and "hire" after another
      // verb and "or", "and" or "to" (final check of the employer-verbs repair, 17 Nov 2026: "Can't afford to hire
      // inexperienced staff" became "Able to afford to hire inexperienced staff")
      "Can't afford to hire inexperienced staff", "Can't just hire temps", "Can't even hire part-timers", "Can't ever hire smokers", "Cannot by law hire minors",
      "Unable to afford to hire part-timers", "Cannot afford to pay overtime", "Can't re-hire former employees", "Cannot rehire former employees",
      "Can't recruit or hire minors", "Cannot train and hire new graduates", "Can't continue to hire temps",
    ];
    for (const t of asTyped) {
      expect(mustHaveOf(t), t).toBe(t);
      // still worded as what rules someone out: asked of the owner as what they need, as "No RDA" is
      expect(rulesOut(mustHaveOf(t)), t).toBe(true);
      expect(restatementsOf(t), t).toEqual([t]);
      expect(lacksCredential(t), t).toBe(false);
    }
    // what the candidate does is still turned round
    expect(mustHaveOf("Cannot work Saturdays")).toBe("Able to work Saturdays");
    expect(mustHaveOf("Unable to lift 50 lbs")).toBe("Able to lift 50 lbs");
    expect(mustHaveOf("Can't work with children")).toBe("Able to work with children");
    expect(mustHaveOf("Not able to drive a stick shift")).toBe("Able to drive a stick shift");
    expect(mustHaveOf("Can't reliably lift 50 lbs")).toBe("Able to reliably lift 50 lbs");
    // after a word such as "even" too, and a verb other than "hire" after "or" is still read as the candidate's
    expect(mustHaveOf("Can't even lift 25 lbs")).toBe("Able to even lift 25 lbs");
    expect(mustHaveOf("Can't drive or take the bus")).toBe("Able to drive or take the bus");
    // and so is what the candidate does around the hiring itself, which names nobody (review of the employer-verbs fix,
    // 17 Nov 2026: "Unable to get BLS certified within 30 days of hire" stayed as typed)
    const aroundTheHiring: Array<[string, string]> = [
      ["Unable to get BLS certified within 30 days of hire", "Able to get BLS certified within 30 days of hire"],
      ["Can't pass a drug screen before hire", "Able to pass a drug screen before hire"],
      ["Cannot work in a contract-to-hire role", "Able to work in a contract-to-hire role"],
      ["Unable to attend new hire orientation", "Able to attend new hire orientation"],
      ["Cannot get licensed upon hire", "Able to get licensed upon hire"],
      ["Unable to start on the hire date", "Able to start on the hire date"],
      ["Unable to pass a pre-hire skills test", "Able to pass a pre-hire skills test"],
      ["Can't complete new hire paperwork", "Able to complete new hire paperwork"],
      ["Unable to pass a drug test at offer or hire", "Able to pass a drug test at offer or hire"],
    ];
    for (const [t, need] of aroundTheHiring) {
      expect(mustHaveOf(t), t).toBe(need);
      expect(restatementsOf(t), t).toEqual([need]);
    }
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
