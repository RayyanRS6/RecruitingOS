import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, intakeTurnPrompt, type IntakeContext } from "@ros/ai";
import { DraftRolePacket, IntakeQuestion, IntakeServerState, IntakeTurn, type IntakeFacts, type IntakeMessage } from "@ros/contracts";
import { unresolvedFlags } from "@ros/core";
import { registerFakeHandlers } from "./fake-handlers";
import { fieldsKnownFromFacts, finalizeDraft, finalizePacket, inThePagesWords, mergeFacts, prepareQuestions, sameQuestion, typedSinceReply, withoutCardCount } from "./intake";

const OWNERS_SENTENCE = "Software Engineer required with 3 years of hands-on experience in Python and Flask";
const HYGIENIST = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";

const facts = (more: Partial<IntakeFacts> = {}): IntakeFacts => ({ mustHaves: [], niceToHaves: [], formQuestions: [], dealBreakers: [], declinedCriteria: [], ...more });
const said = (content: string, kind: IntakeMessage["kind"] = "text"): IntakeMessage => ({ role: "owner", content, at: "2026-11-18T09:00:00.000Z", kind });
const replied = (content: string): IntakeMessage => ({ role: "assistant", content, at: "2026-11-18T09:00:05.000Z" });
const company = { name: "Harbor Dental", vertical: "dental", sizeBand: "10-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] };
const ctx = (messages: IntakeMessage[], f: IntakeFacts = facts(), more: Partial<IntakeContext> = {}): IntakeContext => ({ company, facts: f, messages, ...more });

const fake = new FakeProvider();
registerFakeHandlers(fake);
const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };

async function turn(c: IntakeContext): Promise<IntakeTurn> {
  const r = await callPrompt(rt, intakeTurnPrompt, c, { companyId: null });
  if (r.result.kind !== "ok") throw new Error(`the stand-in did not answer: ${r.result.kind}`);
  return IntakeTurn.parse(r.result.output);
}

async function written(c: IntakeContext): Promise<DraftRolePacket> {
  const r = await callPrompt(rt, intakeCompilePrompt, c, { companyId: null });
  if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a job: ${r.result.kind}`);
  return DraftRolePacket.parse(r.result.output);
}

describe("the stand-in assistant's turn (intake.turn)", () => {
  it("reads the owner's sentence and asks for the place, the work arrangement and the pay first", async () => {
    const t = await turn(ctx([said(OWNERS_SENTENCE)]));
    expect(t.factsExtracted.title).toBe("Software Engineer");
    expect(t.factsExtracted.mustHaves).toEqual(["3 years of hands-on experience in Python and Flask"]);
    // "experience in Python" names a skill, never a place; nothing is assumed about where or how the job is done
    expect(t.factsExtracted.locationText).toBeUndefined();
    expect(t.factsExtracted.remotePolicy).toBeUndefined();
    expect(t.factsExtracted.compensationMin).toBeUndefined();
    expect(t.missingFacts).toEqual(["location", "remote_policy", "compensation_range", "employment_type", "schedule"]);
    expect(t.questions.map((q) => q.field)).toEqual(["location", "remote_policy", "compensation"]);
    expect(t.questions[2].mode).toBe("pay");
    expect(t.readyToCompile).toBe(false);
    expect(t.notARole).toBe(false);
  });

  it("has nothing left to ask after one sentence that names every essential", async () => {
    const t = await turn(ctx([said(HYGIENIST)]));
    expect(t.factsExtracted).toMatchObject({ title: "registered dental hygienist", locationText: "Tustin, CA", remotePolicy: "onsite", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55 });
    expect(t.factsExtracted.mustHaves).toEqual(["Active CA RDH license", "Periodontal charting"]);
    expect(t.missingFacts).toEqual([]);
    expect(t.questions).toEqual([]);
    expect(t.readyToCompile).toBe(true);
  });

  it("never asks again what the notes list as already asked", async () => {
    const t = await turn(ctx([said(OWNERS_SENTENCE)], facts(), { alreadyAsked: ["location", "compensation", "compensation_basis"] }));
    expect(t.questions.map((q) => q.field)).toEqual(["remote_policy", "employment_type", "schedule"]);
  });

  it("starts no draft for a question about the day, and declines a criterion that stands in for age", async () => {
    expect((await turn(ctx([said("Did we hire anyone this week?")]))).notARole).toBe(true);
    const t = await turn(ctx([said("Front desk coordinator in Tustin, CA."), replied("Got it."), said("Only recent grads please.")], facts({ title: "Front desk coordinator", locationText: "Tustin, CA" })));
    expect(t.factsExtracted.declinedCriteria.map((d) => d.requested.toLowerCase())).toEqual(["recent grads"]);
    expect(t.assistantMessage).toContain("I can't build");
  });
});

describe("the cards as the server stores them", () => {
  const card = (more: Partial<IntakeQuestion> & Pick<IntakeQuestion, "field">): IntakeQuestion => IntakeQuestion.parse({ id: "x", prompt: `About ${more.field}?`, mode: "free", options: [], allowOwn: true, ...more });
  const prepare = (raw: IntakeQuestion[], more: Partial<Parameters<typeof prepareQuestions>[1]> = {}) => prepareQuestions(raw, { turnNo: 1, payConfirmed: false, dealBreakers: [], ...more });

  it("numbers the cards, keeps three at most and puts the essentials in their order", () => {
    const out = prepare([card({ field: "schedule" }), card({ field: "benefits", prompt: "What benefits come with it?" }), card({ field: "title", prompt: "What is the title?" }), card({ field: "location", prompt: "Where is it?" })]);
    expect(out.map((q) => [q.id, q.field])).toEqual([["q1_1", "title"], ["q1_2", "location"], ["q1_3", "schedule"]]);
  });

  it("drops a card whose field is settled, one that asks which company it is for, and one worded like a card already shown", () => {
    const out = prepare([card({ field: "title" }), card({ field: "location", prompt: "Which company is this for?" }), card({ field: "schedule", prompt: "Which days and hours does the person work?" })], { settled: ["title"], askedPrompts: ["Which days and hours would the person work?"] });
    expect(out).toEqual([]);
  });

  it("draws the pay card itself, whatever the assistant offered, and never once the pay is confirmed", () => {
    const pay = card({ field: "compensation_basis", prompt: "Hourly or salary?", mode: "single", options: [{ label: "$20 an hour", value: "20", origin: "assistant" }] });
    expect(prepare([pay])).toMatchObject([{ field: "compensation", mode: "pay", options: [], allowOwn: true }]);
    expect(prepare([pay], { payConfirmed: true })).toEqual([]);
  });

  it("gives the work arrangement exactly its three choices and no box for other words", () => {
    const [q] = prepare([card({ field: "remote_policy", prompt: "Where is the work done?", mode: "free" })]);
    expect(q).toMatchObject({ mode: "single", allowOwn: false });
    expect(q.options.map((o) => o.value)).toEqual(["onsite", "hybrid", "remote"]);
  });

  it("asks for an essential that is missing when the assistant wrote no card for it", () => {
    const out = prepare([], { missing: ["location", "remote_policy", "compensation_range", "employment_type"] });
    expect(out.map((q) => q.field)).toEqual(["location", "remote_policy", "compensation"]);
  });

  // Found on the live site in November 2026: a draft read "Still needed before the job can be written: at least one
  // must-have" with no card, because a card for the field had been shown once (skipped, or answered in words that could
  // not be used) and nothing asked for it again.
  it("never shows the assistant's own card for a field twice, and keeps offering its own card for an essential until it is answered", () => {
    const asked = ["location", "remote_policy", "must_haves"] as const;
    const again = prepare([card({ field: "location", prompt: "Which city is the job in?" }), card({ field: "must_haves", prompt: "Which of these must they have?", mode: "multi" })], { missing: ["location", "remote_policy", "must_haves"], settled: asked });
    // the assistant's two cards are dropped: it asked for those fields before; the server's own three stand in their place
    expect(again.map((q) => [q.id, q.field, q.prompt])).toEqual([["q1_1", "location", "Where is the job? Give the city and state."], ["q1_2", "remote_policy", "Is the job on site, hybrid or remote?"], ["q1_3", "must_haves", "What must the person have?"]]);
    // an essential that is answered is asked by nobody, whoever asked before
    expect(prepare([card({ field: "location" })], { missing: ["must_haves"], settled: asked }).map((q) => q.field)).toEqual(["must_haves"]);
    expect(prepare([card({ field: "location" })], { missing: [], settled: asked })).toEqual([]);
    // three at most, in the essentials' order, however many are still missing
    expect(prepare([], { missing: ["title", "location", "remote_policy", "compensation_range", "employment_type", "schedule", "must_haves"], settled: ["title", "location", "remote_policy", "compensation", "compensation_basis", "employment_type", "schedule", "must_haves"] }).map((q) => q.field)).toEqual(["title", "location", "remote_policy"]);
  });

  it("brings the pay card back while the pay is stated and nobody has confirmed it, and never once it is confirmed", () => {
    const shown = ["compensation", "compensation_basis"] as const;
    expect(prepare([], { missing: ["compensation_range"], settled: shown }).map((q) => [q.field, q.mode, q.options])).toEqual([["compensation", "pay", []]]);
    expect(prepare([], { missing: [], settled: shown, payConfirmed: true })).toEqual([]);
  });

  it("drops an offered answer that stands in for a protected trait, and says whose words an answer is in", () => {
    const [q] = prepare([card({ field: "must_haves", prompt: "Which of these must they have?", mode: "multi", options: [{ label: "Recent graduates", value: "Recent graduates", origin: "assistant" }, { label: "Active RDH license", value: "Active RDH license", origin: "owner" }, { label: "Dentrix", value: "Dentrix", origin: "owner" }] })], { ownerWords: new Set(["active", "rdh", "license"]) });
    expect(q.options).toEqual([{ label: "Active RDH license", value: "Active RDH license", origin: "owner" }, { label: "Dentrix", value: "Dentrix", origin: "assistant" }]);
  });

  it("offers a deal-breaker back as the requirement it rules people out on, and names one it cannot turn round", () => {
    const out = prepare([card({ field: "must_haves", prompt: "What must they have?" }), card({ field: "schedule" })], { dealBreakers: ["No active California RDA license", "No RDA"] });
    expect(out.map((q) => q.field)).toEqual(["schedule", "must_haves"]);
    const deal = out[1];
    expect(deal.options).toEqual([{ label: "Active California RDA license", value: "Active California RDA license", origin: "assistant" }]);
    expect(deal.prompt).toBe('From your deal-breakers: which should count openly as must-haves? To count "No RDA", write it as what they need.');
  });

  it("asks for the benefits when the law of the job's place wants them described, once there is room", () => {
    expect(prepare([], { benefitsNeeded: true }).map((q) => q.field)).toEqual(["benefits"]);
    expect(prepare([], { benefitsNeeded: true, settled: ["benefits"] })).toEqual([]);
  });

  it("knows what the facts already answer", () => {
    expect(fieldsKnownFromFacts(facts({ title: "Hygienist", remotePolicy: "onsite", compensationMin: 45, compensationMax: 55, compensationBasis: "hourly", mustHaves: ["RDH license"] }), false)).toEqual(["title", "remote_policy", "must_haves"]);
    expect(fieldsKnownFromFacts(facts({ compensationMin: 45, compensationMax: 55, compensationBasis: "hourly" }), true)).toEqual(["compensation", "compensation_basis"]);
    expect(fieldsKnownFromFacts(facts({ employmentType: "part_time" }), false)).toEqual(["employment_type"]);
  });

  // Found on the live site on 19 November 2026. The real model writes facts in plain words; the stand-in writes codes,
  // so only a scripted turn can tell.
  it("reads the assistant's plain words for the kind of job and the pay basis, and never counts unreadable ones as answered", () => {
    const read = mergeFacts(facts(), facts({ title: "Front desk coordinator", employmentType: "Full time", compensationBasis: "per hour", compensationMin: 22, compensationMax: 26 }), [said("Front desk coordinator, full time, 22 to 26 dollars an hour.")]);
    expect(read).toMatchObject({ employmentType: "full_time", compensationBasis: "hourly", compensationMin: 22, compensationMax: 26 });
    expect(fieldsKnownFromFacts(read, false)).toEqual(["title", "employment_type"]);
    // words that name no kind of job are not kept, are not settled, and so the server's own card asks for it
    const unread = mergeFacts(facts(), facts({ title: "Front desk coordinator", employmentType: "flexible" }));
    expect(unread.employmentType).toBeUndefined();
    expect(fieldsKnownFromFacts({ ...unread, employmentType: "flexible", remotePolicy: "wherever" }, false)).toEqual(["title"]);
    expect(prepare([], { missing: ["employment_type"], settled: fieldsKnownFromFacts(unread, false) }).map((q) => [q.field, q.options.map((o) => o.value)])).toEqual([["employment_type", ["full_time", "part_time"]]]);
  });

  it("tells two cards that ask the same thing from a must-have and a nice-to-have card", () => {
    expect(sameQuestion("Which days and hours does the person work?", "Which days and hours would the person work?")).toBe(true);
    expect(sameQuestion("Which skills are must-haves for this hire?", "Which skills are nice to have for this hire?")).toBe(false);
  });

  it("takes a count of the cards out of the assistant's message", () => {
    expect(withoutCardCount("Please answer the three questions beside this.")).toBe("Please answer the questions beside this.");
    expect(withoutCardCount("I have 3 quick questions for you.")).toBe("I have some quick questions for you.");
    expect(withoutCardCount("Three more cards are beside this.")).toBe("Some more cards are beside this.");
  });

  it("says a job is ready to be written, in the page's word, never ready to compile", () => {
    expect(inThePagesWords("All the essentials are in place, so the job is ready to compile.")).toBe("All the essentials are in place, so the job is ready to be written.");
    expect(inThePagesWords("Everything is in. It is ready to be compiled.")).toBe("Everything is in. It is ready to be written.");
    expect(inThePagesWords("I can compile the job now.")).toBe("I can write the job now.");
    // an owner's own must-have keeps its words
    expect(inThePagesWords("Must-have noted: can compile and ship a C++ service.")).toBe("Must-have noted: can compile and ship a C++ service.");
    // and it says "resume", the page's word, however the model spelt it
    expect(inThePagesWords("Applicants send a résumé. Résumés are read once; work can resume on Monday.")).toBe("Applicants send a resume. Resumes are read once; work can resume on Monday.");
  });
});

describe("the facts after a turn", () => {
  it("adds to a list and replaces a single value", () => {
    const merged = mergeFacts(facts({ title: "Hygienist", mustHaves: ["RDH license"] }), facts({ title: "Dental hygienist", mustHaves: ["rdh license", "Perio charting"] }));
    expect(merged).toMatchObject({ title: "Dental hygienist", mustHaves: ["RDH license", "Perio charting"] });
  });

  it("keeps the place only when it is in the owner's words, never copied from the company profile", () => {
    const next = facts({ title: "Software Engineer", locationText: "Irvine, CA" });
    expect(mergeFacts(facts(), next, [said(OWNERS_SENTENCE)]).locationText).toBeUndefined();
    expect(mergeFacts(facts(), next, [said("Software engineer in Irvine, CA")]).locationText).toBe("Irvine, CA");
  });

  it("keeps the work arrangement only when the owner typed one: asked, never assumed", () => {
    const next = facts({ remotePolicy: "onsite" });
    expect(mergeFacts(facts(), next, [said(OWNERS_SENTENCE)]).remotePolicy).toBeUndefined();
    expect(mergeFacts(facts(), next, [said("Remote is fine. Apply today.", "pasted_ad")]).remotePolicy).toBeUndefined();
    expect(mergeFacts(facts(), next, [said("It is on site.")]).remotePolicy).toBe("onsite");
    expect(mergeFacts(facts(), facts({ remotePolicy: "sometimes" }), [said("It is on site sometimes.")]).remotePolicy).toBeUndefined();
  });

  it("reads new facts only after words the owner typed or pasted, not after tapped answers alone", () => {
    expect(typedSinceReply([said("A job ad", "pasted_ad")])).toBe(true);
    expect(typedSinceReply([said("An idea"), replied("Got it."), said("Where the job is: Irvine, CA", "answers")])).toBe(false);
    expect(typedSinceReply([said("An idea"), replied("Got it."), said("Where the job is: Irvine, CA", "answers"), said("And it is hybrid.")])).toBe(true);
  });
});

describe("the job as written and then finished by the server", () => {
  const answered = facts({ title: "Registered Dental Hygienist", locationText: "Tustin, CA", remotePolicy: "hybrid", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, benefits: "Health cover", mustHaves: ["No active CA RDH license", "Periodontal charting"], formQuestions: ["Can you work Saturdays"], screeningQuestions: ["How do you explain perio findings to a patient?"] });
  const payState = (via: "typed" | "pay_card" = "pay_card") => IntakeServerState.parse({ pay: { by: { kind: "user", id: "u1", name: "Dana" }, at: "2026-11-18T09:10:00.000Z", via, basis: "hourly", min: 45, max: 55 } });

  it("writes what the record holds: the owner's must-haves as what the person needs, three skills, six questions, the form's questions, no pay in the words", async () => {
    const draft = await written(ctx([said(HYGIENIST)], answered, { confirmedPay: { basis: "hourly", min: 45, max: 55 } }));
    expect(draft.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Periodontal charting"]);
    expect(draft.competencies).toHaveLength(3);
    expect(draft.competencies.every((c) => ["essential", "important", "helpful"].includes(c.importance))).toBe(true);
    expect(draft.screening.questions).toHaveLength(6);
    expect(draft.screening.questions[0].question).toBe("How do you explain perio findings to a patient?");
    expect(draft.screening.maxMinutes).toBe(10);
    expect(draft.formQuestions.map((q) => [q.kind, q.question])).toEqual([["yes_no", "Can you work Saturdays?"], ["yes_no", "Do you hold this: Active CA RDH license?"]]);
    expect(draft.description.publicJobDescription.split(/\s+/).length).toBeGreaterThanOrEqual(120);
    expect(draft.description.publicJobDescription).not.toMatch(/\$\s?\d/);
    expect(draft.compensation).toMatchObject({ basis: "hourly", min: 45, max: 55 });
    expect(Object.keys(draft).sort()).toEqual(["communication", "compensation", "competencies", "compliance", "description", "formQuestions", "identity", "provenance", "requirements", "schemaVersion", "screening"]);
  });

  it("leaves the pay out when nobody confirmed one", async () => {
    const draft = await written(ctx([said(HYGIENIST)], answered));
    expect(draft.compensation).toBeUndefined();
    expect(finalizeDraft(draft, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: IntakeServerState.parse({}) }).compensation).toBeUndefined();
  });

  it("sets the pay and the benefits line by rule, with who confirmed it, whatever the model wrote", async () => {
    const draft = await written(ctx([said(HYGIENIST)], answered, { confirmedPay: { basis: "hourly", min: 45, max: 55 } }));
    const tampered = { ...draft, compensation: { ...draft.compensation!, min: 10, max: 99, benefitsSummary: "A pony" } };
    const done = finalizeDraft(tampered, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(done.compensation).toEqual({ basis: "hourly", currency: "USD", min: 45, max: 55, benefitsSummary: "Health cover", discloseRange: true });
    expect(done.provenance.payConfirmedBy).toEqual({ by: { kind: "user", id: "u1", name: "Dana" }, at: "2026-11-18T09:10:00.000Z", via: "pay_card" });
    expect(done.provenance).toMatchObject({ intakeSessionId: "s1", aiRunIds: ["r1"], payOrigin: "pay_card" });
    expect(done.compliance.jurisdictions).toContain("US-CA");
    expect(done.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
  });

  it("drops a 'keep' the model wrote on a flagged phrase: it stays open, and a person's earlier keep of it carries over", async () => {
    const draft = await written(ctx([said(HYGIENIST)], answered));
    const flagged = { ...draft, description: { publicJobDescription: `${draft.description.publicJobDescription} We want a digital native.` } };
    const once = finalizeDraft(flagged, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() });
    const [flag] = unresolvedFlags(once);
    expect(flag).toMatchObject({ path: "description.publicJobDescription", rule: "age" });
    const byModel = { ...flagged, provenance: { ...flagged.provenance, flags: [{ ...flag, kept: { reason: "fine", by: { kind: "agent" as const, id: "intake" }, at: "2026-11-18T09:00:00.000Z" } }] } };
    expect(unresolvedFlags(finalizeDraft(byModel, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() }))).toHaveLength(1);
    const kept = { ...flag, kept: { reason: "Our own wording", by: { kind: "user" as const, id: "u1" }, at: "2026-11-18T09:20:00.000Z" } };
    expect(unresolvedFlags(finalizeDraft(flagged, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState(), previousFlags: [kept] }))).toEqual([]);
  });

  it("publishes the work arrangement the owner answered, and never a form question about a protected characteristic", async () => {
    const draft = await written(ctx([said(HYGIENIST)], answered));
    const wrong = { ...draft, identity: { ...draft.identity, remotePolicy: "onsite" as const }, formQuestions: [...draft.formQuestions, { kind: "yes_no" as const, key: "kids", question: "Do you have children?", required: true }] };
    const packet = finalizePacket(wrong, ctx([], answered), { sessionId: "eval", aiRunId: "r1" });
    expect(packet.identity.remotePolicy).toBe("hybrid");
    expect(packet.formQuestions.map((q) => q.key)).not.toContain("kids");
    expect(packet.formQuestions).toHaveLength(2);
    expect(packet.compensation).toMatchObject({ min: 45, max: 55 });
  });
});
