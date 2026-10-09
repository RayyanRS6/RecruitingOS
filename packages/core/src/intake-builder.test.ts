import { describe, expect, it } from "vitest";
import { IntakeServerState, type IntakeFacts, type IntakeMessage, type IntakeQuestion } from "@ros/contracts";
import { IntakeEditError, amountsIn, applyAnswers, applyFactsPatch, basisFromText, dealBreakerOffer, draftFactsKey, intakeReadiness, looksLikePastedAd, payCard, payTyped, startDateFor, typedCeiling } from "./intake-builder";

const empty = (): IntakeFacts => ({ mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] });
const owner = (content: string, kind?: IntakeMessage["kind"]): IntakeMessage => ({ role: "owner", content, at: "2026-10-08T09:00:00.000Z", ...(kind ? { kind } : {}) });
const state = (over: Partial<IntakeServerState> = {}): IntakeServerState => ({ ...IntakeServerState.parse({}), ...over });
const dana = { kind: "user" as const, id: "u-dana", name: "Dana" };

describe("hourly or salary, before the first market check (plan C2)", () => {
  it("reads the basis from the owner's own words, or from the size of the amounts, and says so when it cannot tell", () => {
    expect(basisFromText("$45 to $55 an hour")).toBe("hourly");
    expect(basisFromText("pays $28/hr")).toBe("hourly");
    expect(basisFromText("salary $95,000 to $115,000")).toBe("salary");
    expect(basisFromText("$60,000 to $70,000, in the office")).toBe("salary");
    expect(basisFromText("$80k-$90k")).toBe("salary");
    expect(basisFromText("$22 to $26")).toBe("hourly");
    expect(basisFromText("a marketing manager in Phoenix")).toBeNull();
  });

  it("reads amounts the way people write them", () => {
    expect(amountsIn("$60,000 to $70,000")).toEqual([60000, 70000]);
    expect(amountsIn("60k-75k, ceiling $80k")).toEqual([60000, 75000, 80000]);
    expect(amountsIn("$45.50 an hour")).toEqual([45.5]);
  });
});

describe("pay a person set (plan C7)", () => {
  const facts = { ...empty(), compensationBasis: "hourly", compensationMin: 45, compensationMax: 55 };

  it("counts pay a person typed, figure for figure, and never pay read from a pasted ad", () => {
    expect(payTyped([owner("I need a hygienist, $45 to $55 an hour.")], facts)).toBe(true);
    expect(payTyped([owner("Front desk\nPay: $45 - $55 per hour", "pasted_ad")], facts)).toBe(false);
    expect(payTyped([owner("Pay: $45–$55 an hour", "answers")], facts)).toBe(false);
    expect(payTyped([owner("I need a hygienist, $45 to $50 an hour.")], facts)).toBe(false);
  });

  it("the pay card names the market figure and its source, labels the ITS estimate, and says plainly when there is none", () => {
    const market = payCard(facts, state({ benchmark: { basis: "hourly", p25: 48, p50: 55, p75: 63, source: "BLS OEWS 2025, SOC 291292, area 0031080", metro: "irvine area", asOf: "2025", origin: "market" } }));
    expect(market.benchmark?.label).toBe("Market pay, 2025");
    expect(market.summary).toMatch(/Source: BLS OEWS 2025/);
    expect(market.belowMarket).toBe(false);
    const estimate = payCard({ ...facts, compensationMax: 52 }, state({ benchmark: { basis: "hourly", p25: 50, p50: 57, p75: 64, source: "ITS dental playbook (ITS playbook estimate)", metro: "Los Angeles-Long Beach-Anaheim, CA", origin: "its_estimate" } }));
    expect(estimate.benchmark?.label).toBe("ITS estimate");
    expect(estimate.summary).toMatch(/not government wage data/);
    expect(estimate.belowMarket).toBe(true);
    expect(payCard({ ...empty(), locationText: "Reno" }, state({ benchmarkGap: "basis_unknown" })).gap?.reason).toBe("basis_unknown");
    expect(payCard({ ...facts, locationText: "Reno" }, state({ benchmarkGap: "no_market_figure" })).summary).toBe("We have no market pay figure for this job in Reno, so pay was not checked against the market.");
  });

  it("names the place as people write it, and tells a figure for a broader group of jobs as a rough guide (polish list)", () => {
    const salary = { ...empty(), compensationBasis: "salary", compensationMin: 65000, compensationMax: 80000 };
    const close = payCard(salary, state({ benchmark: { basis: "salary", p25: 121130, p50: 164920, p75: 212050, source: "BLS OEWS 2025, SOC 112021, area 0012420", metro: "Austin area", asOf: "2025", origin: "market" } }));
    expect(close.summary).toBe("Market pay for the Austin area: $121,130–$212,050 a year (middle $164,920). Source: BLS OEWS 2025, SOC 112021, area 0012420. Your range tops out below the middle of the market, which can slow the search.");
    // a figure stored before places were capitalised still reads properly
    expect(payCard(salary, state({ benchmark: { basis: "salary", p25: 1, p50: 2, p75: 3, source: "x", metro: "austin area", origin: "market" } })).summary).toMatch(/^Market pay for the Austin area:/);
    expect(payCard(salary, state({ benchmark: { basis: "salary", p25: 1, p50: 2, p75: 3, source: "x", metro: "US national", origin: "market" } })).summary).toMatch(/^Market pay for the US as a whole:/);
    const rough = payCard(salary, state({ benchmark: { basis: "salary", p25: 58000, p50: 71000, p75: 90000, source: "BLS OEWS 2025, SOC 131161, area 0012420", metro: "Austin area", asOf: "2025", origin: "market", approximate: true, occupation: "Market research analysts and marketing specialists" } }));
    expect(rough.belowMarket).toBe(false);
    expect(rough.summary).toContain("so this one is for a broader group (market research analysts and marketing specialists): take it as a rough guide.");
    const roughBelow = payCard({ ...salary, compensationMax: 70000 }, state({ benchmark: { basis: "salary", p25: 58000, p50: 71000, p75: 90000, source: "BLS", metro: "Austin area", origin: "market", approximate: true, occupation: "Market research analysts and marketing specialists" } }));
    expect(roughBelow.belowMarket).toBe(true);
    expect(roughBelow.summary).toMatch(/below its middle, which is worth knowing but not a worry on its own\.$/);
    expect(roughBelow.summary).not.toMatch(/slow the search/);
  });
});

describe("readiness, computed on the server (plan C7, founder decision Q8)", () => {
  const six = { ...empty(), title: "Registered Dental Hygienist", locationText: "Irvine", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, reason: "replacement", decisionMaker: "the owner" };
  const typed = [owner("Hygienist in Irvine, $45 to $55 an hour.")];

  it("an empty draft is not ready for anything (the reload that once said it was)", () => {
    const r = intakeReadiness({ facts: empty(), state: state(), messages: [], draft: null });
    expect(r.mayDraft).toBe(false);
    expect(r.mayAskForApproval).toBe(false);
    expect(r.missing).toHaveLength(6);
  });

  it("the first draft waits for the essentials, one round of answers, or 'draft it'", () => {
    const partial = { ...empty(), title: "Hygienist" };
    expect(intakeReadiness({ facts: partial, state: state(), messages: [owner("Hygienist")], draft: null }).mayDraft).toBe(false);
    expect(intakeReadiness({ facts: partial, state: state({ answeredRounds: 1 }), messages: [owner("Hygienist")], draft: null }).mayDraft).toBe(true);
    expect(intakeReadiness({ facts: partial, state: state({ draftRequestedAt: "2026-10-08" }), messages: [owner("Hygienist")], draft: null }).mayDraft).toBe(true);
    expect(intakeReadiness({ facts: six, state: state(), messages: typed, draft: null }).mayDraft).toBe(true);
  });

  it("'Ask for approval' needs the six essentials and pay a person set or confirmed; who interviews defaults to who decides, shown as an assumption", () => {
    const unconfirmed = intakeReadiness({ facts: six, state: state(), messages: typed, draft: null, draftRequired: false });
    expect(unconfirmed.missing).toEqual([]);
    expect(unconfirmed.mayAskForApproval).toBe(false);
    expect(unconfirmed.approvalBlockers).toEqual(["Confirm the pay on the pay card."]);
    expect(unconfirmed.essentials.find((e) => e.key === "interviewers")).toMatchObject({ done: true, value: "the owner", note: expect.stringMatching(/decides interviews/) });
    const confirmed = intakeReadiness({ facts: six, state: state({ pay: { by: dana, at: "2026-10-08", via: "typed", basis: "hourly", min: 45, max: 55 } }), messages: typed, draft: null, draftRequired: false });
    expect(confirmed.mayAskForApproval).toBe(true);
    // a confirmation of other figures does not count
    const stale = intakeReadiness({ facts: { ...six, compensationMax: 60 }, state: state({ pay: { by: dana, at: "2026-10-08", via: "typed", basis: "hourly", min: 45, max: 55 } }), messages: typed, draft: null });
    expect(stale.payConfirmed).toBe(false);
  });

  it("the job builder asks for approval only of a written draft that is up to date with the answers", () => {
    const pay = { by: dana, at: "2026-10-08", via: "typed" as const, basis: "hourly" as const, min: 45, max: 55 };
    // nothing written yet: the person checks the draft before anyone is asked to approve it
    expect(intakeReadiness({ facts: six, state: state({ pay }), messages: typed, draft: null }).approvalBlockers).toEqual(["Write the draft first, so you can check it."]);
    const draft = { provenance: { flags: [] } } as unknown as Parameters<typeof intakeReadiness>[0]["draft"];
    const written = state({ pay, draft: { at: "2026-10-08", aiRunId: "run", by: dana, payKey: null, factsKey: draftFactsKey(six), edits: 2 } });
    const ok = intakeReadiness({ facts: six, state: written, messages: typed, draft });
    expect(ok).toMatchObject({ mayAskForApproval: true, draftOutOfDate: false, draftEdits: 2 });
    // pay, who decides and who interviews, and the deal-breakers are set on the draft by rule: never out of date
    const byRule = { ...six, decisionMaker: "Jane", decisionMakerUserId: "u-jane", interviewers: ["Jane"], dealBreakers: ["Weekends"], compensationCeiling: 60 };
    expect(intakeReadiness({ facts: byRule, state: written, messages: typed, draft }).draftOutOfDate).toBe(false);
    // anything the words are written from (the title, the reason, a must-have) makes it out of date, and approval waits
    for (const changed of [{ ...six, title: "Office manager" }, { ...six, reason: "growth" }, { ...six, mustHaves: ["Dentrix"] }]) {
      const r = intakeReadiness({ facts: changed, state: written, messages: typed, draft });
      expect(r.draftOutOfDate).toBe(true);
      expect(r.approvalBlockers).toEqual(["You changed answers after the draft was written. Write it again with them first."]);
    }
    // a draft written before the key existed is never called out of date
    expect(intakeReadiness({ facts: { ...six, title: "Other" }, state: state({ pay, draft: { at: "x", aiRunId: "r", by: dana, payKey: null, edits: 0 } }), messages: typed, draft }).draftOutOfDate).toBe(false);
  });

  it("a ceiling counts as the person's only when they typed that figure, and never below the top of the range", () => {
    const f = { ...six, compensationCeiling: 58 };
    expect(typedCeiling([owner("$45 to $55 an hour, at most $58")], f)).toBe(58);
    expect(typedCeiling([owner("$45 to $55 an hour")], f)).toBeUndefined();
    expect(typedCeiling([owner("Front desk, ceiling $58", "pasted_ad")], f)).toBeUndefined();
    expect(typedCeiling([owner("$45 to $55 an hour, start within 30 days")], { ...six, compensationCeiling: 30 })).toBeUndefined();
  });

  it("knows a pasted ad from a typed sentence", () => {
    expect(looksLikePastedAd("I need a hygienist in Irvine, $45 to $55 an hour.")).toBe(false);
    expect(looksLikePastedAd(["Front Desk Coordinator", "Location: Irvine, CA", "Full time, Monday to Friday, 8am to 5pm", "Pay: $22-$26 per hour", "About us: we are a family dental practice that has served Irvine for twenty years.", "Responsibilities: greet patients, answer the phones, schedule appointments and confirm them the day before.", "Verify insurance and collect payments at checkout.", "Requirements: two years of front desk work in a medical or dental office, and comfort with practice software."].join("\n"))).toBe(true);
    expect(looksLikePastedAd("x".repeat(1500))).toBe(true);
  });
});

describe("tapped answers and panel edits (plan C6, C15)", () => {
  const team = [{ userId: "u-owner", name: "Dana Owner", role: "owner" }, { userId: "u-hm", name: "Hank Manager", role: "hiring_manager" }, { userId: "u-int", name: "Ivy Interviewer", role: "interviewer" }];
  const q = (over: Partial<IntakeQuestion>): IntakeQuestion => ({ id: "q1", field: "must_haves", prompt: "Which are must-haves?", mode: "multi", options: [], allowOwn: true, ...over });
  const must = q({ options: [{ label: "Active RDH license", value: "Active RDH license", origin: "playbook" }, { label: "Two years of experience", value: "Two years of experience", origin: "playbook" }, { label: "Dentrix", value: "Dentrix", origin: "assistant" }] });

  it("ticked answers set the fact; unticked ones become suggestions, never nice-to-haves, and come out of the fact", () => {
    const facts = { ...empty(), mustHaves: ["Dentrix"] };
    const edit = applyAnswers(facts, [must], [{ questionId: "q1", selected: ["Active RDH license"], own: ["Perio charting"], skipped: false }], team);
    expect(edit.facts.mustHaves).toEqual(["Active RDH license", "Perio charting"]);
    expect(edit.facts.niceToHaves).toEqual([]);
    expect(edit.facts.suggestions?.map((s) => s.text)).toEqual(["Two years of experience", "Dentrix"]);
    expect(edit.removed).toEqual([{ field: "mustHaves", value: "Dentrix" }]);
    expect(edit.summary).toEqual(["Must-haves: Active RDH license; Perio charting"]);
  });

  it("refuses what a person typed when it fails the fairness check, with the reason, and records it as declined", () => {
    const edit = applyAnswers(empty(), [must], [{ questionId: "q1", selected: [], own: ["Recent graduates only"], skipped: false }], team);
    expect(edit.facts.mustHaves).toEqual([]);
    expect(edit.refused).toEqual([expect.objectContaining({ field: "must_haves", text: "Recent graduates only", reason: expect.stringMatching(/stands in for age/) })]);
    expect(edit.facts.declinedCriteria.map((d) => d.requested)).toEqual(["Recent graduates only"]);
  });

  it("refuses an answer that was not offered, a seventh must-have, and a question that is no longer open", () => {
    expect(() => applyAnswers(empty(), [must], [{ questionId: "q1", selected: ["Something else"], own: [], skipped: false }], team)).toThrow(IntakeEditError);
    expect(() => applyAnswers({ ...empty(), mustHaves: ["a", "b", "c", "d", "e"] }, [must], [{ questionId: "q1", selected: ["Active RDH license", "Dentrix"], own: [], skipped: false }], team)).toThrow(/six must-haves/);
    expect(() => applyAnswers(empty(), [must], [{ questionId: "gone", selected: [], own: [], skipped: false }], team)).toThrow(/replaced/);
  });

  it("the pay card sets the pay as set by this person, or confirms the figures already there", () => {
    const pay = q({ id: "p", field: "compensation", mode: "pay" });
    const set = applyAnswers(empty(), [pay], [{ questionId: "p", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55, ceiling: 58 } }], team);
    expect(set.facts).toMatchObject({ compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, compensationCeiling: 58 });
    expect(set.pay?.via).toBe("pay_card");
    const confirmed = applyAnswers(set.facts, [pay], [{ questionId: "p", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55 } }], team);
    expect(confirmed.pay?.via).toBe("confirmed");
    expect(() => applyAnswers(empty(), [pay], [{ questionId: "p", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55, ceiling: 50 } }], team)).toThrow(/not be below the top/);
  });

  it("team cards take real team members: the decision maker by id (no more name matching), interviewers by name and id", () => {
    const dm = q({ id: "d", field: "decision_maker", mode: "team" });
    const iv = q({ id: "i", field: "interviewers", mode: "team" });
    const edit = applyAnswers(empty(), [dm, iv], [{ questionId: "d", selected: ["u-hm"], own: [], skipped: false }, { questionId: "i", selected: ["u-int", "__someone_new"], own: ["Dr. Chen"], skipped: false }], team);
    expect(edit.facts).toMatchObject({ decisionMakerUserId: "u-hm", decisionMaker: "Hank Manager", interviewerUserIds: ["u-int"], interviewers: ["Ivy Interviewer", "Dr. Chen"] });
    expect(() => applyAnswers(empty(), [dm], [{ questionId: "d", selected: ["u-int"], own: [], skipped: false }], team)).toThrow(/cannot approve roles/);
  });

  it("a start date card gives a date", () => {
    expect(startDateFor("within_30_days", new Date("2026-10-08T00:00:00Z"))).toEqual({ targetStartDate: "2026-11-07" });
    expect(startDateFor("asap", new Date("2026-10-08T00:00:00Z"))).toEqual({ targetStartDate: "2026-10-22", urgency: "high" });
  });

  it("the panel's edits: set, add, remove, clear; pay from the panel counts as set by a person", () => {
    const facts = { ...empty(), title: "Hygienist", mustHaves: ["Dentrix"], niceToHaves: ["Spanish"] };
    const edit = applyFactsPatch(facts, { set: { title: "Registered Dental Hygienist", employmentType: "Full time", pay: { basis: "hourly", min: 46, max: 56 } }, add: [{ field: "mustHaves", value: "Active RDH license" }, { field: "niceToHaves", value: "No gaps in employment" }], remove: [{ field: "mustHaves", value: "dentrix" }], clear: ["schedule"] }, team);
    expect(edit.facts).toMatchObject({ title: "Registered Dental Hygienist", employmentType: "full_time", mustHaves: ["Active RDH license"], niceToHaves: ["Spanish"], compensationMin: 46 });
    expect(edit.pay?.via).toBe("edited");
    expect(edit.refused.map((r) => r.text)).toEqual(["No gaps in employment"]);
    expect(edit.removed).toEqual([{ field: "mustHaves", value: "dentrix" }]);
    expect(() => applyFactsPatch(facts, { set: { remotePolicy: "sometimes" } }, team)).toThrow(/work model/);
  });

  it("the summary of a panel edit goes into the conversation in plain words: no field names, no stored codes", () => {
    const edit = applyFactsPatch({ ...empty(), mustHaves: ["Dentrix"] }, { set: { locationText: "Irvine, CA", employmentType: "full_time", remotePolicy: "onsite", reason: "new_position", targetStartDate: "2026-11-03" }, add: [{ field: "mustHaves", value: "Active RDH license" }], remove: [{ field: "mustHaves", value: "Dentrix" }], clear: ["decisionMaker"] }, team);
    expect(edit.summary).toEqual([
      "Where the job is: Irvine, CA",
      "Full or part time: Full time",
      "Work model: On site",
      "Why you are hiring: A new position",
      "Start: by November 3, 2026",
      "Must-haves, added: Active RDH license",
      "Must-haves, taken out: Dentrix",
      "Final decision: taken out",
    ]);
    for (const line of edit.summary) expect(line).not.toMatch(/_|[a-z][A-Z]|\d{4}-\d{2}-\d{2}/);
  });

  it("a pay card sent without a ceiling leaves none (the top of the range), not one read earlier", () => {
    const pay = q({ id: "p", field: "compensation", mode: "pay" });
    const edit = applyAnswers({ ...empty(), compensationCeiling: 70 }, [pay], [{ questionId: "p", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55 } }], team);
    expect(edit.facts.compensationCeiling).toBeUndefined();
    expect(edit.pay).not.toHaveProperty("ceiling");
  });
});

describe("deal-breakers offered back as must-haves (plan C17, founder decision Q19)", () => {
  it("offers each lawful one once, declines the rest with the reason, and skips what is already a must-have", () => {
    const facts = { ...empty(), mustHaves: ["Active RDH license"], dealBreakers: ["Must work Saturdays", "No job hoppers under 30", "Active RDH license"] };
    const first = dealBreakerOffer(facts, []);
    expect(first.offer).toEqual(["Must work Saturdays"]);
    expect(first.declined).toEqual([expect.objectContaining({ requested: "No job hoppers under 30", rule: "age" })]);
    expect(dealBreakerOffer(facts, first.offer).offer).toEqual([]);
  });
});
