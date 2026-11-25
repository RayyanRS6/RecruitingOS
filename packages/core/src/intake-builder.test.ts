import { describe, expect, it } from "vitest";
import { INTAKE_ESSENTIALS, IntakeQuestion, IntakeServerState, RolePacket, type DraftRolePacket, type IntakeFacts, type IntakeMessage } from "@ros/contracts";
import {
  IntakeEditError, amountsIn, applyAnswers, basisFromText, dealBreakerOffer, draftFactsKey, intakeReadiness, looksLikePastedAd, namesWorkArrangement, normalizeFacts, payCard, payConfirmed, payKey, payTyped,
  placeAnswered, sameRequirement, storedAnswer, typedByOwner,
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
    communication: { companyBlurb: "A friendly practice.", signature: "The team", disclosureText: "Written with help from an AI assistant.", humanAlternativeText: "Reply to any of our emails to reach a person." },
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

  // Found by an audit in November 2026: "45-55k" was read as 45 and 55,000, so the range the assistant read from it
  // (45,000 to 55,000) was not found in the owner's own words, and pay they had just typed waited for the pay card.
  it("reads a range that says its thousand once, and leaves every other figure as it is written", () => {
    for (const typed of ["45-55k", "$45-55k", "$45 - $55K a year", "45 to 55k", "45–55k", "between 45 and 55 thousand"]) expect(amountsIn(typed), typed).toEqual([45000, 55000]);
    expect(amountsIn("45.5-55k")).toEqual([45500, 55000]);
    // each figure with its own thousand, with commas, or with none: as they were read before
    for (const typed of ["$45k-$55k", "45k to 55k", "$45,000 to $55,000", "$45,000 - $55,000", "45 thousand to 55 thousand"]) expect(amountsIn(typed), typed).toEqual([45000, 55000]);
    expect(amountsIn("$22–$26 an hour")).toEqual([22, 26]);
    expect(amountsIn("20 dollars an hour")).toEqual([20]);
    // the thousand is taken only by the figure it is joined to, and only by one under a thousand
    expect(amountsIn("$22-26 an hour, or 45-55k a year")).toEqual([22, 26, 45000, 55000]);
    expect(amountsIn("3 to 5 years of experience, 60k")).toEqual([3, 5, 60000]);
    expect(amountsIn("Monday to Friday, 8 to 5, 55 kg boxes")).toEqual([8, 5, 55]);
    expect(amountsIn("$60,000 to 75k")).toEqual([60000, 75000]);
  });

  it("counts pay typed the ways people type a range, and one figure when the facts carry it as both the lowest and the highest", () => {
    const salary = facts({ compensationBasis: "salary", compensationMin: 45000, compensationMax: 55000 });
    for (const typed of ["45-55k", "$45-55k", "$45k-$55k", "45k to 55k", "$45,000 to $55,000", "$45,000 - $55,000", "The pay is 45 to 55 thousand a year."]) expect(payTyped([said(typed)], salary), typed).toBe(true);
    expect(payTyped([said("$22–$26 an hour")], facts({ compensationBasis: "hourly", compensationMin: 22, compensationMax: 26 }))).toBe(true);
    // one figure typed: the lowest and the highest are the same, as a single figure in a pasted ad is kept
    expect(payTyped([said("20 dollars an hour")], facts({ compensationBasis: "hourly", compensationMin: 20, compensationMax: 20 }))).toBe(true);
    // a lowest figure alone is no range: the pay card asks for the rest
    expect(payTyped([said("20 dollars an hour")], facts({ compensationBasis: "hourly", compensationMin: 20 }))).toBe(false);
    // still only the owner's own typed words, and still figure for figure
    expect(payTyped([said("45-55k", "pasted_ad")], salary)).toBe(false);
    expect(payTyped([said("Pay: $45,000–$55,000 a year", "answers")], salary)).toBe(false);
    expect(payTyped([said("45-55k")], facts({ compensationBasis: "salary", compensationMin: 45000, compensationMax: 60000 }))).toBe(false);
    expect(payTyped([said("45-55k")], facts({ compensationBasis: "salary", compensationMin: 45, compensationMax: 55000 }))).toBe(false);
    expect(payTyped([said("45-55k")], facts({ compensationMin: 45000, compensationMax: 55000 }))).toBe(false);
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

  // Until 25 November 2026 the AI filled in the state of a job's place when it wrote the job, so "Denver" alone still
  // got Colorado's notices. It is no longer asked, and nothing else fills one in: the place is answered only once the
  // owner's own words say the state, and until then it is still needed, with its card.
  it("takes the place as answered only when the owner's words say the state", () => {
    const place = (locationText: string, more: Partial<IntakeFacts> = {}) => {
      const r = intakeReadiness({ facts: complete({ locationText, ...more }), state: state(paid), draft: null });
      return { ...r.essentials.find((e) => e.key === "location")!, missing: r.missing, mayDraft: r.mayDraft, draftBlocker: r.draftBlocker, blockers: r.publish.blockers.map((b) => b.message) };
    };
    // a city alone: the words stay on the checklist, the place is still needed and the job cannot be written
    expect(place("Denver")).toEqual({ key: "location", label: "Where the job is", done: false, value: "Denver", missing: ["location"], mayDraft: false, draftBlocker: "Still needed before the job can be written: where the job is.", blockers: ["Not set yet: where the job is.", "Write the job first, so you can check it."] });
    expect(place("Denver, CO")).toMatchObject({ done: true, value: "Denver, CO", missing: [], mayDraft: true, draftBlocker: null });
    for (const said of ["Denver, Colorado", "Denver CO", "Colorado", "Austin TX", "New York", "Tustin, CA 92780"]) expect(place(said), said).toMatchObject({ done: true, mayDraft: true });
    // a state's name inside a city's name is no state: the card comes back for "Kansas City", and not for "Kansas City, MO"
    for (const said of ["Kansas City", "Nevada City", "Oklahoma City", "Virginia Beach", "New York City", "Tustin", "Downtown"]) expect(place(said), said).toMatchObject({ done: false, missing: ["location"], mayDraft: false });
    expect(place("Kansas City, MO")).toMatchObject({ done: true, mayDraft: true });
    expect(placeAnswered({ locationText: "   " })).toBe(false);
    expect(placeAnswered({})).toBe(false);
  });

  // A wrong state is worse than none: another state's notices would be on the job and the right ones off. "LA" is Los
  // Angeles as often as Louisiana, and "OK" and "OR" are words: without a comma they answer nothing, and the card asks.
  it("takes no state from a code that is also a word or a city's short name, unless it stands after a comma", () => {
    const answered = (locationText: string) => {
      const r = intakeReadiness({ facts: complete({ locationText }), state: state(paid), draft: null });
      return { done: r.essentials.find((e) => e.key === "location")!.done, missing: r.missing, mayDraft: r.mayDraft };
    };
    for (const said of ["Downtown LA", "East LA", "LA", "Remote OK", "Portland OR"]) expect(answered(said), said).toEqual({ done: false, missing: ["location"], mayDraft: false });
    for (const said of ["Baton Rouge, LA", "Tulsa, OK", "Portland, OR", "Austin TX", "Los Angeles, CA", "New Orleans, Louisiana"]) expect(answered(said), said).toEqual({ done: true, missing: [], mayDraft: true });
  });

  // The one way out, as before this rule: a job the owner said is remote, when the answer names no place at all.
  it("asks a remote job for no state when its answer names no place, and for the state when it names one", () => {
    const remote = (locationText: string) => placeAnswered({ locationText, remotePolicy: "remote" });
    for (const said of ["Remote", "remote", "Fully remote", "100% remote", "Anywhere in the US", "Anywhere", "Nationwide", "Work from home", "Remote (US only)", "Remote, United States", "U.S.A.", "N/A"]) expect(remote(said), said).toBe(true);
    for (const said of ["Denver", "Remote, team in Denver", "Kansas City", "Remote but near Austin"]) expect(remote(said), said).toBe(false);
    expect(remote("Remote, Denver, CO")).toBe(true);
    // only for a job the owner said is remote: on site and hybrid jobs are somewhere, and an unknown arrangement decides nothing
    for (const remotePolicy of ["onsite", "hybrid", "wherever", undefined]) expect(placeAnswered({ locationText: "Remote", remotePolicy }), String(remotePolicy)).toBe(false);
    const r = intakeReadiness({ facts: complete({ locationText: "Anywhere in the US", remotePolicy: "remote" }), state: state(paid), draft: null });
    expect(r).toMatchObject({ missing: [], mayDraft: true });
    expect(r.essentials.find((e) => e.key === "location")).toEqual({ key: "location", label: "Where the job is", done: true, value: "Anywhere in the US" });
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
    expect(edit.summary).toEqual(["Job title: Software Engineer", "Where the job is: Austin, TX", "On site, hybrid or remote: Hybrid", "Schedule: Monday to Friday, 9 to 5", "Benefits: Health cover", "Full time or part time: Part-time, mornings"]);
    expect(edit.refused).toEqual([]);
    expect(edit.pay).toBeNull();
  });

  // The card for the place comes back while the place has no state, and the plain answer to that is the state alone.
  // It completes the place already given, so the city is kept and the card is not asked a third time.
  it("completes a place that lacks its state when the answer is a state alone, and takes any other answer as the place", () => {
    const where = card({ id: "l", field: "location" });
    const after = (before: string | undefined, own: string) => applyAnswers(facts({ locationText: before }), [where], [answer("l", { own: [own] })]);
    expect(after("Denver", "CO").facts.locationText).toBe("Denver, CO");
    expect(after("Denver", "co").facts.locationText).toBe("Denver, co");
    expect(after("Denver", "Colorado").facts.locationText).toBe("Denver, Colorado");
    expect(after("Kansas City", "MO").facts.locationText).toBe("Kansas City, MO");
    // the summary line in the conversation is the owner's answer, as they typed it
    expect(after("Denver", "CO").summary).toEqual(["Where the job is: CO"]);
    // and each place now says its state, by the test the checklist uses
    for (const [before, own] of [["Denver", "CO"], ["Denver", "co"], ["Denver", "Colorado"], ["Kansas City", "MO"]] as const) expect(placeAnswered(after(before, own).facts), `${before} + ${own}`).toBe(true);
    // any other answer is the place: another city, the whole place again, a city alone once more, or a state when no place was given
    expect(after("Denver", "Aurora, CO").facts.locationText).toBe("Aurora, CO");
    expect(after("Denver", "Denver, CO").facts.locationText).toBe("Denver, CO");
    expect(after("Denver", "Boulder").facts.locationText).toBe("Boulder");
    expect(after(undefined, "Colorado").facts.locationText).toBe("Colorado");
  });

  // "LA" by itself is Los Angeles as often as Louisiana: it completes nothing and says no state, however often it is
  // given. The owner says which: the state by a code that is not a word, by its name, or after the city and a comma.
  it("never takes 'LA' alone for a state: the place still has none, until the owner says California or Louisiana", () => {
    const where = card({ id: "l", field: "location" });
    const after = (before: string | undefined, own: string) => applyAnswers(facts({ locationText: before }), [where], [answer("l", { own: [own] })]).facts;
    for (const before of ["LA", "Downtown LA", "Los Angeles", "New Orleans", undefined]) {
      for (const own of ["LA", "la", "LA."]) {
        expect(after(before, own).locationText, `${before} + ${own}`).toBe(own);
        expect(placeAnswered(after(before, own)), `${before} + ${own}`).toBe(false);
      }
    }
    // Los Angeles, then the state: California
    expect(after("Los Angeles", "CA").locationText).toBe("Los Angeles, CA");
    expect(after("Los Angeles", "California").locationText).toBe("Los Angeles, California");
    expect(placeAnswered(after("Los Angeles", "CA"))).toBe(true);
    // and Louisiana, said so that it can only be the state
    expect(after("New Orleans", "Louisiana").locationText).toBe("New Orleans, Louisiana");
    expect(after("LA", "New Orleans, LA").locationText).toBe("New Orleans, LA");
    expect(placeAnswered(after("LA", "New Orleans, LA"))).toBe(true);
    // the other codes that are also words are still a state when they are the whole answer on the card
    expect(after("Tulsa", "OK").locationText).toBe("Tulsa, OK");
    expect(placeAnswered(after("Tulsa", "OK"))).toBe(true);
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

describe("facts the assistant wrote in plain words", () => {
  // Found on the live site on 19 November 2026: the real model wrote "Full time", the cards took it as answered, the job
  // took it as missing, nothing asked for it, and "Write the job" stayed shut whatever the owner typed.
  it("reads the kind of job and the pay basis from the words they came in", () => {
    for (const words of ["full_time", "Full time", "full-time", "Full-time, permanent", " FULL TIME "]) expect(normalizeFacts({ employmentType: words }).employmentType, words).toBe("full_time");
    expect(normalizeFacts({ employmentType: "Part time" }).employmentType).toBe("part_time");
    expect(normalizeFacts({ employmentType: "Per diem" }).employmentType).toBe("per_diem");
    for (const words of ["hourly", "per hour", "an hour", "Hourly rate"]) expect(normalizeFacts({ compensationBasis: words }).compensationBasis, words).toBe("hourly");
    for (const words of ["salary", "Salary", "annual salary", "per year"]) expect(normalizeFacts({ compensationBasis: words }).compensationBasis, words).toBe("salary");
  });

  it("drops words that name no kind or basis, or more than one, so the essential is asked and never half-known", () => {
    expect(normalizeFacts({ employmentType: "gig" })).toEqual(facts());
    expect(normalizeFacts({ employmentType: "Full time or part time" })).toEqual(facts());
    expect(normalizeFacts({ compensationBasis: "weekly", compensationMin: 900, compensationMax: 1100 })).toEqual(facts({ compensationMin: 900, compensationMax: 1100 }));
    expect(normalizeFacts({ compensationBasis: "hourly, with a yearly bonus" }).compensationBasis).toBeUndefined();
  });

  // Found by an audit in November 2026: the real model wrote "On site", which is no code, so the arrangement the owner
  // had just said was dropped and asked for again.
  it("reads the work arrangement from the words it came in, like the kind of job", () => {
    for (const words of ["onsite", "On site", "On-site", "on_site", "On‑site", "In office", "In the office", "In person", "In-person", "Office-based", " ONSITE "]) expect(normalizeFacts({ remotePolicy: words }).remotePolicy, words).toBe("onsite");
    for (const words of ["remote", "Remote", "Fully remote", "Work from home", "Working from home", "work-from-home", "WFH", "Home-based"]) expect(normalizeFacts({ remotePolicy: words }).remotePolicy, words).toBe("remote");
    for (const words of ["hybrid", "Hybrid", "Hybrid schedule"]) expect(normalizeFacts({ remotePolicy: words }).remotePolicy, words).toBe("hybrid");
  });

  it("drops words that name no work arrangement, or more than one, so it is asked and never half-known", () => {
    for (const words of ["wherever", "flexible", "sometimes", "Tustin office", "On site or remote", "Hybrid: two days in the office, three remote"]) expect(normalizeFacts({ remotePolicy: words }), words).toEqual(facts());
    // and a job is never written on one that was not read
    expect(intakeReadiness({ facts: normalizeFacts({ ...complete(), remotePolicy: "On site or remote" }), state: state(paid), draft: null }).missing).toEqual(["remote_policy"]);
  });

  it("knows the ordinary ways people say a work arrangement, and that a place, a skill or a building site names none", () => {
    for (const typed of ["We all work from home.", "They would be working from home most days", "it's WFH", "Everyone works remotely", "Remote is fine", "It is in the office, five days a week", "in person only", "On-site at our Tustin practice", "onsite", "hybrid, two days in", "It is a home-based job"]) expect(namesWorkArrangement(typed), typed).toBe(true);
    for (const typed of ["Software Engineer required with 3 years of hands-on experience in Python and Flask", "A dental assistant for our Tustin office", "Front desk coordinator at our Irvine office", "Foreman for a construction site in Reno", "Homeowner outreach", "A personal assistant", "Workers' compensation claims"]) expect(namesWorkArrangement(typed), typed).toBe(false);
  });

  it("writes the job once the owner's sentence gave every essential, whichever words the assistant kept them in", () => {
    const asWritten = normalizeFacts({ ...complete(), employmentType: "Full time", compensationBasis: "per hour", remotePolicy: "On site" });
    const r = intakeReadiness({ facts: asWritten, state: state(paid), draft: null });
    expect(r.missing).toEqual([]);
    expect(r.essentials.find((e) => e.key === "employment_type")).toMatchObject({ done: true, value: "Full time" });
    expect(r.essentials.find((e) => e.key === "remote_policy")).toMatchObject({ done: true, value: "On site" });
    expect(r).toMatchObject({ payConfirmed: true, mayDraft: true, draftBlocker: null });
    // and pay the owner typed counts as typed, so the pay card is not shown again
    expect(payTyped([said("$45 to $55 an hour")], asWritten)).toBe(true);
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
