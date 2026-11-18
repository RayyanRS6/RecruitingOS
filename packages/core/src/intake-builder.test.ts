import { describe, expect, it } from "vitest";
import { INTAKE_ESSENTIALS, IntakeQuestion, IntakeServerState, RolePacket, type DraftRolePacket, type IntakeFacts, type IntakeMessage } from "@ros/contracts";
import {
  IntakeEditError, amountsIn, applyAnswers, basisFromText, dealBreakerOffer, draftFactsKey, intakeReadiness, looksLikePastedAd, normalizeFacts, payCard, payConfirmed, payKey, payTyped, sameRequirement,
  storedAnswer, typedByOwner,
} from "./intake-builder";

const facts = (more: Partial<IntakeFacts> = {}): IntakeFacts => ({ mustHaves: [], niceToHaves: [], formQuestions: [], dealBreakers: [], declinedCriteria: [], ...more });
const complete = (more: Partial<IntakeFacts> = {}): IntakeFacts => facts({ title: "Registered Dental Hygienist", locationText: "Tustin, CA", remotePolicy: "onsite", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, mustHaves: ["Active CA RDH license"], ...more });
const state = (more: Record<string, unknown> = {}): IntakeServerState => IntakeServerState.parse(more);
const paid = { pay: { by: { kind: "user", id: "u1", name: "Dana" }, at: "2026-11-18T09:10:00.000Z", via: "pay_card", basis: "hourly", min: 45, max: 55 } };
const said = (content: string, kind: IntakeMessage["kind"] = "text"): IntakeMessage => ({ role: "owner", content, at: "2026-11-18T09:00:00.000Z", kind });
const card = (more: Partial<IntakeQuestion> & Pick<IntakeQuestion, "id" | "field">): IntakeQuestion => IntakeQuestion.parse({ prompt: `About ${more.field}?`, mode: "free", options: [], allowOwn: true, ...more });
const answer = (questionId: string, more: Partial<{ selected: string[]; own: string[]; skipped: boolean; pay: { basis: "hourly" | "salary"; min: number; max: number } }> = {}) => ({ questionId, selected: [], own: [], skipped: false, ...more });

function written(more: (p: RolePacket) => void = () => {}): DraftRolePacket {
  const p = RolePacket.parse({
    identity: { title: "Registered Dental Hygienist", locations: [{ city: "Tustin", region: "CA", country: "US" }], employmentType: "full_time", remotePolicy: "onsite" },
    compensation: { basis: "hourly", min: 45, max: 55 },
    description: { publicJobDescription: "Harbor Dental is hiring a registered dental hygienist in Tustin to care for a loyal patient base, five days a week." },
    requirements: { mustHaves: [{ key: "license", text: "Active CA RDH license" }] },
    screening: { questions: ["One?", "Two?", "Three?"].map((question, i) => ({ key: `q${i}`, question })) },
    communication: { companyBlurb: "A friendly practice.", signature: "The team", disclosureText: "Written with help from an AI assistant.", humanAlternativeText: "Reply HUMAN for a person." },
    compliance: {},
    provenance: {},
  });
  more(p);
  return p;
}

describe("what the owner's own words say", () => {
  it("tells a pasted job ad from a typed idea by its length or its lines", () => {
    expect(looksLikePastedAd("Software Engineer required with 3 years of hands-on experience in Python and Flask")).toBe(false);
    expect(looksLikePastedAd("x".repeat(1200))).toBe(true);
    expect(looksLikePastedAd(Array.from({ length: 8 }, (_, i) => `Line ${i} of the ad, which says a good deal about the job and the team.`).join("\n"))).toBe(true);
  });

  it("reads amounts and hourly or salary as people write them", () => {
    expect(amountsIn("$60,000 to 75k, or $45.50")).toEqual([60000, 75000, 45.5]);
    expect(basisFromText("$45 an hour")).toBe("hourly");
    expect(basisFromText("$85,000")).toBe("salary");
    expect(basisFromText("$24 to $28")).toBe("hourly");
    expect(basisFromText("$500 a week")).toBeNull();
    expect(basisFromText("good pay")).toBeNull();
  });

  it("counts pay as typed only when both figures are in words the owner typed, never in a pasted ad or a summary of answers", () => {
    const f = complete();
    expect(typedByOwner([said("typed"), said("pasted", "pasted_ad"), said("Pay: $45-$55", "answers")])).toEqual(["typed"]);
    expect(payTyped([said("$45 to $55 an hour")], f)).toBe(true);
    expect(payTyped([said("Pay: $45 - $55 per hour", "pasted_ad")], f)).toBe(false);
    expect(payTyped([said("up to $55")], f)).toBe(false);
    expect(payTyped([said("$45 to $55")], facts({ compensationMin: 45, compensationMax: 55 }))).toBe(false);
  });

  it("holds a confirmation only while the facts still carry the figures confirmed", () => {
    expect(payConfirmed(complete(), state(paid))).toBe(true);
    expect(payConfirmed(complete({ compensationMax: 60 }), state(paid))).toBe(false);
    expect(payConfirmed(complete(), state())).toBe(false);
    expect(payKey(state(paid))).toBe("hourly:45:55");
    expect(payKey(state())).toBeNull();
  });
});

describe("readiness: what a job needs before it is written and published", () => {
  it("lists the seven essentials in order, each with its label and its value in words", () => {
    const r = intakeReadiness({ facts: complete(), state: state(paid), draft: null });
    expect(r.essentials.map((e) => e.key)).toEqual([...INTAKE_ESSENTIALS]);
    expect(r.essentials.map((e) => [e.label, e.done, e.value])).toEqual([
      ["Job title", true, "Registered Dental Hygienist"],
      ["Where the job is", true, "Tustin, CA"],
      ["On site, hybrid or remote", true, "On site"],
      ["Pay", true, "$45–$55 an hour"],
      ["Full time or part time", true, "Full time"],
      ["Schedule", true, "Monday to Friday"],
      ["At least one must-have", true, "Active CA RDH license"],
    ]);
    expect(r).toMatchObject({ missing: [], payConfirmed: true, mayDraft: true, draftBlocker: null, hasDraft: false });
  });

  it("asks the owner's sentence for the place, the work arrangement, the pay, the type and the schedule before the job is written", () => {
    const r = intakeReadiness({ facts: facts({ title: "Software Engineer", mustHaves: ["3 years of hands-on experience in Python and Flask"] }), state: state(), draft: null });
    expect(r.missing).toEqual(["location", "remote_policy", "compensation_range", "employment_type", "schedule"]);
    expect(r.mayDraft).toBe(false);
    expect(r.draftBlocker).toBe("Still needed before the job can be written: where the job is, on site, hybrid or remote, pay, full time or part time, schedule.");
  });

  it("never takes a work arrangement or a kind of job it does not know as answered", () => {
    const r = intakeReadiness({ facts: complete({ remotePolicy: "wherever", employmentType: "gig" }), state: state(paid), draft: null });
    expect(r.missing).toEqual(["remote_policy", "employment_type"]);
  });

  it("needs the pay set or confirmed by a person, not only stated", () => {
    const r = intakeReadiness({ facts: complete(), state: state(), draft: null });
    expect(r).toMatchObject({ missing: [], payConfirmed: false, mayDraft: false, draftBlocker: "Confirm the pay on the pay card before the job is written." });
    expect(r.publish.blockers.map((b) => b.code)).toEqual(["pay_not_confirmed", "no_draft"]);
  });

  it("lists every reason a draft cannot be published, each with its code, the plan first and the law last", () => {
    const lacking = intakeReadiness({
      facts: facts({ title: "Software Engineer" }), state: state(), draft: null,
      planBlockers: [{ code: "plan", message: "Your plan has no room for another job." }], legalBlockers: [{ code: "legal_check", message: "Colorado asks for a benefits description." }],
    });
    expect(lacking.publish.allowed).toBe(false);
    expect(lacking.publish.blockers.map((b) => [b.code, b.message])).toEqual([
      ["plan", "Your plan has no room for another job."],
      ["essential_missing", "Not set yet: where the job is."],
      ["essential_missing", "Not set yet: on site, hybrid or remote."],
      ["essential_missing", "Not set yet: pay."],
      ["essential_missing", "Not set yet: full time or part time."],
      ["essential_missing", "Not set yet: schedule."],
      ["essential_missing", "Not set yet: at least one must-have."],
      ["no_draft", "Write the job first, so you can check it."],
      ["legal_check", "Colorado asks for a benefits description."],
    ]);
  });

  it("publishes a written job that is up to date and has no open flag, and holds one whose answers changed or whose wording is flagged", () => {
    const f = complete();
    const upToDate = state({ ...paid, draft: { at: "2026-11-18T09:20:00.000Z", aiRunId: "r1", by: { kind: "user", id: "u1" }, payKey: "hourly:45:55", factsKey: draftFactsKey(f), edits: 2 } });
    const ready = intakeReadiness({ facts: f, state: upToDate, draft: written() });
    expect(ready).toMatchObject({ hasDraft: true, draftOutOfDate: false, draftEdits: 2, openFlags: 0 });
    expect(ready.publish).toEqual({ allowed: true, blockers: [] });
    const moved = intakeReadiness({ facts: complete({ schedule: "Weekends" }), state: upToDate, draft: written() });
    expect(moved.draftOutOfDate).toBe(true);
    expect(moved.publish.blockers).toEqual([{ code: "draft_out_of_date", message: "Your answers changed after the job was written. Write the job again first." }]);
    const flagged = written((p) => { p.provenance.flags = [{ id: "age:x", path: "description.publicJobDescription", rule: "age", text: "digital native", reason: "r" }]; });
    expect(intakeReadiness({ facts: f, state: upToDate, draft: flagged }).publish.blockers).toEqual([{ code: "open_flags", message: "One phrase in this job needs a decision first: edit it out, or keep it and say why." }]);
  });

  it("keeps a written job up to date when only what the server sets by rule changes: the pay, the benefits, a deal-breaker, a refusal", () => {
    const key = draftFactsKey(complete());
    expect(draftFactsKey(complete({ compensationMin: 50, compensationMax: 60, benefits: "Health cover", dealBreakers: ["No RDA"], declinedCriteria: [{ requested: "recent grads", reason: "r" }] }))).toBe(key);
    for (const change of [{ title: "Hygienist" }, { locationText: "Irvine, CA" }, { remotePolicy: "hybrid" }, { employmentType: "part_time" }, { schedule: "Weekends" }, { mustHaves: ["Active CA RDH license", "Perio charting"] }, { niceToHaves: ["Dentrix"] }, { formQuestions: ["Can you work Saturdays?"] }, { screeningQuestions: ["Why us?"] }]) {
      expect(draftFactsKey(complete(change)), JSON.stringify(change)).not.toBe(key);
    }
  });
});

describe("the pay card", () => {
  it("says what the owner stated and who set or confirmed it, and suggests nothing", () => {
    expect(payCard(facts(), state())).toEqual({ basis: null, stated: { min: null, max: null }, confirmed: null, summary: "Pay is not set yet." });
    expect(payCard(complete(), state())).toEqual({ basis: "hourly", stated: { min: 45, max: 55 }, confirmed: null, summary: "Pay: $45–$55 an hour. Nobody has confirmed it yet: confirm it or change it." });
    expect(payCard(complete(), state(paid))).toEqual({ basis: "hourly", stated: { min: 45, max: 55 }, confirmed: { byName: "Dana", at: "2026-11-18T09:10:00.000Z", via: "pay_card" }, summary: "Pay: $45–$55 an hour." });
  });
});

describe("answers to the question cards", () => {
  const arrangement = card({ id: "q1", field: "remote_policy", mode: "single", allowOwn: false, options: [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Hybrid", value: "hybrid", origin: "assistant" }, { label: "Remote", value: "remote", origin: "assistant" }] });
  const pay = card({ id: "q2", field: "compensation", mode: "pay" });

  it("sets each fact from a ticked answer or the owner's own words, with one summary line each", () => {
    const cards = [
      card({ id: "t", field: "title" }), card({ id: "l", field: "location" }), arrangement, card({ id: "s", field: "schedule" }), card({ id: "b", field: "benefits" }),
      card({ id: "e", field: "employment_type", mode: "single", options: [{ label: "Full time", value: "full_time", origin: "assistant" }, { label: "Part time", value: "part_time", origin: "assistant" }] }),
    ];
    const edit = applyAnswers(facts(), cards, [answer("t", { own: ["Software Engineer"] }), answer("l", { own: ["Austin, TX"] }), answer("q1", { selected: ["hybrid"] }), answer("s", { own: ["Monday to Friday, 9 to 5"] }), answer("b", { own: ["Health cover"] }), answer("e", { own: ["Part-time, mornings"] })]);
    expect(edit.facts).toMatchObject({ title: "Software Engineer", locationText: "Austin, TX", remotePolicy: "hybrid", schedule: "Monday to Friday, 9 to 5", benefits: "Health cover", employmentType: "part_time" });
    expect(edit.summary).toEqual(["Job title: Software Engineer", "Where the job is: Austin, TX", "On site, hybrid or remote: Hybrid", "Schedule: Monday to Friday, 9 to 5", "Benefits: Health cover", "Full or part time: Part-time, mornings"]);
    expect(edit.refused).toEqual([]);
    expect(edit.pay).toBeNull();
  });

  it("sets the pay from the pay card as set by a person, and as confirmed when the figures were already there", () => {
    const set = applyAnswers(facts(), [pay], [answer("q2", { pay: { basis: "hourly", min: 45, max: 55 } })]);
    expect(set.facts).toMatchObject({ compensationBasis: "hourly", compensationMin: 45, compensationMax: 55 });
    expect(set.pay).toEqual({ basis: "hourly", min: 45, max: 55, via: "pay_card" });
    expect(set.summary).toEqual(["Pay: $45–$55 an hour"]);
    expect(applyAnswers(complete(), [pay], [answer("q2", { pay: { basis: "hourly", min: 45, max: 55 } })]).pay?.via).toBe("confirmed");
    expect(() => applyAnswers(facts(), [pay], [answer("q2")])).toThrow(IntakeEditError);
    expect(() => applyAnswers(facts(), [pay], [answer("q2", { pay: { basis: "hourly", min: 60, max: 50 } })])).toThrow("The lowest pay must not be above the highest.");
  });

  it("adds ticked and typed must-haves, takes out one left unticked, and keeps six at most", () => {
    const must = card({ id: "m", field: "must_haves", mode: "multi", options: [{ label: "Active RDH license", value: "Active RDH license", origin: "owner" }, { label: "Dentrix", value: "Dentrix", origin: "assistant" }] });
    const edit = applyAnswers(facts({ mustHaves: ["Dentrix", "Perio charting"] }), [must], [answer("m", { selected: ["Active RDH license"], own: ["Two years chairside"] })]);
    expect(edit.facts.mustHaves).toEqual(["Perio charting", "Active RDH license", "Two years chairside"]);
    expect(edit.summary).toEqual(["Must-haves: Active RDH license; Two years chairside"]);
    const six = facts({ mustHaves: ["a1", "b2", "c3", "d4", "e5", "f6"] });
    expect(() => applyAnswers(six, [must], [answer("m", { own: ["One more"] })])).toThrow("Keep it to six must-haves; anything else can be a nice-to-have.");
  });

  it("refuses words that stand in for a protected trait, with the reason, and records the refusal", () => {
    const must = card({ id: "m", field: "must_haves", mode: "multi" });
    const breakers = card({ id: "d", field: "deal_breakers", mode: "multi" });
    const edit = applyAnswers(facts(), [must, breakers], [answer("m", { own: ["Recent grads only", "Active RDH license"] }), answer("d", { own: ["Felony convictions", "Cannot work Saturdays"] })]);
    expect(edit.facts.mustHaves).toEqual(["Active RDH license"]);
    expect(edit.facts.dealBreakers).toEqual(["Cannot work Saturdays"]);
    expect(edit.refused.map((r) => [r.field, r.text])).toEqual([["must_haves", "Recent grads only"], ["deal_breakers", "Felony convictions"]]);
    expect(edit.refused.every((r) => r.reason && r.alternative)).toBe(true);
    expect(edit.facts.declinedCriteria.map((d) => d.requested)).toEqual(["Recent grads only", "Felony convictions"]);
  });

  it("stores the words the person ticked when the assistant wrote a code as the value", () => {
    expect(storedAnswer({ label: "California RDA license", value: "rda_license" })).toBe("California RDA license");
    expect(storedAnswer({ label: "Weekdays", value: "Monday to Friday, office hours" })).toBe("Monday to Friday, office hours");
    const schedule = card({ id: "s", field: "schedule", mode: "single", options: [{ label: "Monday to Friday, daytime", value: "mon_fri_days", origin: "assistant" }] });
    expect(applyAnswers(facts(), [schedule], [answer("s", { selected: ["mon_fri_days"] })]).facts.schedule).toBe("Monday to Friday, daytime");
  });

  it("changes nothing for a skipped card, and refuses an answer that was not on the card", () => {
    const skipped = applyAnswers(complete(), [arrangement], [answer("q1", { skipped: true })]);
    expect(skipped.facts).toEqual(complete());
    expect(skipped.summary).toEqual([]);
    expect(() => applyAnswers(facts(), [arrangement], [answer("gone")])).toThrow("That question has been replaced by newer ones. Answer the questions showing now.");
    expect(() => applyAnswers(facts(), [arrangement], [answer("q1", { selected: ["anywhere"] })])).toThrow("That answer was not one of the choices on the card.");
    expect(() => applyAnswers(facts(), [arrangement], [answer("q1", { own: ["Mostly remote"] })])).toThrow("Pick one of the choices on this card.");
  });
});

describe("deal-breakers offered back as must-haves", () => {
  it("offers one that passes the fairness check once, never one already a must-have, and declines one that fails", () => {
    const f = facts({ mustHaves: ["Active California RDA license"], dealBreakers: ["No active California RDA license", "Cannot work Saturdays", "Felony convictions", "No recent grads", "Smokers"] });
    const { offer, declined } = dealBreakerOffer(f, ["Smokers"]);
    expect(offer).toEqual(["Cannot work Saturdays"]);
    expect(declined.map((d) => [d.requested, d.rule])).toEqual([["Felony convictions", "criminal_record"], ["No recent grads", "recent_graduate"]]);
  });
});

describe("facts as stored", () => {
  it("fills in every list, keeps six must-haves and drops what the builder no longer keeps", () => {
    const old = { title: "Hygienist", mustHaves: ["a", "b", "c", "d", "e", "f", "g"], reason: "growth", interviewers: ["Dana"], decisionMaker: "Dana", eligibilityNotes: ["RDH license"], compensationCeiling: 60 };
    expect(normalizeFacts(old)).toEqual({ title: "Hygienist", mustHaves: ["a", "b", "c", "d", "e", "f"], niceToHaves: [], formQuestions: [], dealBreakers: [], declinedCriteria: [] });
    expect(normalizeFacts(null)).toEqual(facts());
    // a value of the wrong kind is dropped on its own
    expect(normalizeFacts({ title: "Hygienist", compensationMin: "45" })).toEqual(facts({ title: "Hygienist" }));
  });
});

describe("the same requirement in other words", () => {
  it("reads the same words, most key words shared, or a credential's short form", () => {
    expect(sameRequirement("Active RDH license", "active rdh license!")).toBe(true);
    expect(sameRequirement("Active California RDA license", "Do you hold a Registered Dental Assistant (RDA) license in this state?")).toBe(true);
    expect(sameRequirement("Two years of chairside experience", "Chairside experience, two years")).toBe(true);
    expect(sameRequirement("Active RDH license", "Perio charting")).toBe(false);
    expect(sameRequirement("CPR CERTIFIED", "RDA LICENSED")).toBe(false);
  });
});
