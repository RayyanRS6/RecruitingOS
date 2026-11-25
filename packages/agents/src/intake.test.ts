import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, intakeTurnPrompt, type IntakeContext } from "@ros/ai";
import { IntakeQuestion, IntakeServerState, IntakeTurn, WrittenJob, type IntakeFacts, type IntakeMessage } from "@ros/contracts";
import { unresolvedFlags } from "@ros/core";
import { registerFakeHandlers } from "./fake-handlers";
import { afterTurn, draftFromWritten, fieldsKnownFromFacts, finalizeDraft, finalizePacket, inThePagesWords, mergeFacts, prepareQuestions, sameQuestion, typedSinceReply, withoutCardCount, withoutReadyClaim } from "./intake";

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

/** The job as the stand-in writes it: only what the model is asked for (`WrittenJob`). */
async function written(c: IntakeContext): Promise<WrittenJob> {
  const r = await callPrompt(rt, intakeCompilePrompt, c, { companyId: null });
  if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a job: ${r.result.kind}`);
  return WrittenJob.parse(r.result.output);
}

/** What the server makes of a turn the assistant answered to these messages, in a draft with nothing in it yet (the real `afterTurn`). */
const after = (t: IntakeTurn, messages: IntakeMessage[], f: IntakeFacts = facts()) => afterTurn({ turn: t, messages, facts: f, state: IntakeServerState.parse({}), actor: { kind: "user", id: "u1", name: "Dana" }, at: "2026-11-25T09:00:00.000Z" });

describe("the stand-in assistant's turn (intake.turn)", () => {
  it("reads the owner's sentence and asks for the place, the work arrangement and the pay first", async () => {
    const t = await turn(ctx([said(OWNERS_SENTENCE)]));
    expect(t.factsExtracted.title).toBe("Software Engineer");
    expect(t.factsExtracted.mustHaves).toEqual(["3 years of hands-on experience in Python and Flask"]);
    // "experience in Python" names a skill, never a place; nothing is assumed about where or how the job is done
    expect(t.factsExtracted.locationText).toBeUndefined();
    expect(t.factsExtracted.remotePolicy).toBeUndefined();
    expect(t.factsExtracted.compensationMin).toBeUndefined();
    expect(t.questions.map((q) => q.field)).toEqual(["location", "remote_policy", "compensation"]);
    expect(t.questions[2].mode).toBe("pay");
    expect(t.notARole).toBe(false);
    // what is still missing, and whether the job can be written, is the server's to say from the facts: the assistant is not asked
    expect(t).not.toHaveProperty("missingFacts");
    expect(t).not.toHaveProperty("readyToCompile");
    expect(after(t, [said(OWNERS_SENTENCE)])).toMatchObject({ missing: ["location", "remote_policy", "compensation_range", "employment_type", "schedule"], mayDraft: false });
  });

  it("has nothing left to ask after one sentence that names every essential, and does not say that the job can be written", async () => {
    const t = await turn(ctx([said(HYGIENIST)]));
    // every fact in plain words, as the prompt asks: "Full time", not "full_time"
    expect(t.factsExtracted).toMatchObject({ title: "registered dental hygienist", locationText: "Tustin, CA", remotePolicy: "On site", employmentType: "Full time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55 });
    expect(t.factsExtracted.mustHaves).toEqual(["Active CA RDH license", "Periodontal charting"]);
    expect(t.questions).toEqual([]);
    // the server reads the arrangement and the kind of job from those words, finds every essential in and the pay typed by
    // the owner, so the page says the job can be written; the reply does not
    const done = after(t, [said(HYGIENIST)]);
    expect(done.facts).toMatchObject({ remotePolicy: "onsite", employmentType: "full_time", compensationBasis: "hourly" });
    expect(done).toMatchObject({ missing: [], mayDraft: true, payTyped: true, questions: [], message: "Got it: registered dental hygienist in Tustin, CA." });
    expect(withoutReadyClaim(t.assistantMessage)).toBe(t.assistantMessage);
    // a later turn with nothing to ask and nothing new understood says no more than that it was noted
    const later = await turn(ctx([said(HYGIENIST), replied("Got it."), said("Thanks.")], t.factsExtracted));
    expect(later.assistantMessage).toBe("Noted.");
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

  // Found on the live site on 19 November 2026. The real model writes facts in plain words, and in more ways than the
  // stand-in does ("per hour", "flexible"), so these facts are scripted.
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

// Seen on the live site on 25 November 2026: the assistant wrote "The job can be written now." while the page still
// asked for the work arrangement. The model wrote its message before the server worked out what is missing; it is no
// longer asked, is told never to say it, and the code holds that: the page alone says whether the job can be written.
describe("the assistant's reply never says that the job can be written: the page does", () => {
  const LIVE = "The job can be written now.";

  it("takes out a sentence that says the job can be written, is ready, or that everything is in", () => {
    expect(withoutReadyClaim(`Got it: a front desk coordinator in Tustin. ${LIVE}`)).toBe("Got it: a front desk coordinator in Tustin.");
    for (const claim of [
      LIVE, "The job can now be written.", "You can now write the job.", "I can write the job now.", "The job is ready to be written.", "I'm ready to write the job.", "The job is ready.", "Your job is good to go.",
      "You're all set.", "Everything is in.", "Everything needed is in.", "All the essentials are in place.", "All the essentials are covered, so you can press Write the job.", "I have everything I need.",
      "I have what the job needs.", "I now have all the essentials.", "That's everything I need to write the job.", "You've given me everything.", "Nothing is missing.", "Nothing else is needed.",
      "I don't need anything else.", "Press Write the job when you are ready.", "If you're happy with that, press Write the job.",
      // what follows in a later part of the sentence is about something else, and does not turn the claim round
      "The job can be written now, and you can check every word before you publish.", "Everything is in, but you can still add nice-to-haves.",
    ]) expect(withoutReadyClaim(`Thanks for the schedule. ${claim}`), claim).toBe("Thanks for the schedule.");
    // "ready to compile" is put in the page's words first, and then goes the same way
    expect(withoutReadyClaim(inThePagesWords("Thanks. All the essentials are in place, so the job is ready to compile."))).toBe("Thanks.");
  });

  it("keeps a question, and a sentence that says what is still needed", () => {
    for (const stays of [
      "Is the job on site, hybrid or remote?", "What is still missing?", "Can the job be written without a schedule?",
      "Still needed before the job can be written: the work arrangement.", "Still needed before the job can be written: on site, hybrid or remote, pay. You can type them here.",
      "Once you confirm the pay, the job can be written.", "The job can be written once the pay is confirmed.", "The job cannot be written yet.", "The job can't be written until the pay is confirmed.",
      "The job isn't ready to be written yet.", "Not everything is in yet.", "Everything is in except the schedule.", "Everything is in, except the schedule.", "Everything but the pay is in.", "Everything else is in.",
      "I have everything except the pay.", "I still need the pay before I can write the job.", "I need the schedule, then the job can be written.", "When you add the pay, press Write the job.",
      "The pay is missing, otherwise everything is in.", "I've put what's still missing beside this. Tap an answer, add your own, or just type.",
      // words that only look like the claim
      "You can write the job title in your own words.", "You can type them here.", "Got it: must be ready to write reports every week.", "Everything is done on site.", "Monday to Friday, 8 a.m. to 5 p.m. is noted.",
      "That doesn't sound like a job to fill, so I haven't started a draft. When you're ready to hire, describe the job: the title, where it is and what the person needs.",
    ]) expect(withoutReadyClaim(stays), stays).toBe(stays);
    expect(withoutReadyClaim(`${LIVE} Is the job on site, hybrid or remote?`)).toBe("Is the job on site, hybrid or remote?");
  });

  it("says only that it was noted when nothing else is left, and keeps the rest of a longer reply as it was written", () => {
    expect(withoutReadyClaim(LIVE)).toBe("Noted.");
    expect(withoutReadyClaim("I have what the job needs. Press Write the job when you are ready.")).toBe("Noted.");
    expect(withoutReadyClaim(`I took these from your ad: Job title: Dental Assistant; Where: Irvine, CA.\n\n${LIVE}\n\nThe hours are 8 a.m. to 5 p.m. as the ad says.`)).toBe("I took these from your ad: Job title: Dental Assistant; Where: Irvine, CA.\n\nThe hours are 8 a.m. to 5 p.m. as the ad says.");
    expect(withoutReadyClaim("Got it.\n- Title: Dental Assistant\n- Pay: to confirm")).toBe("Got it.\n- Title: Dental Assistant\n- Pay: to confirm");
  });

  it("is held on the turn as it is stored: the live reply, beside what the server itself still asks for", () => {
    const t = IntakeTurn.parse({ assistantMessage: `Got it: a software engineer. ${LIVE}`, factsExtracted: { title: "Software Engineer", mustHaves: ["3 years of hands-on experience in Python and Flask"] }, questions: [] });
    const done = after(t, [said(OWNERS_SENTENCE)]);
    expect(done.message).toBe("Got it: a software engineer.");
    expect(done).toMatchObject({ mayDraft: false, missing: ["location", "remote_policy", "compensation_range", "employment_type", "schedule"] });
    // the server's own cards ask for what is missing, whatever the reply said
    expect(done.questions.map((q) => q.field)).toEqual(["location", "remote_policy", "compensation"]);
    // and the reply that says nothing else is only "Noted."
    expect(after(IntakeTurn.parse({ assistantMessage: LIVE, factsExtracted: {}, questions: [] }), [said(OWNERS_SENTENCE)]).message).toBe("Noted.");
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

  // Found by an audit in November 2026. The real model writes the arrangement in plain words ("On site"), which was
  // dropped as no code; and "we all work from home" did not count as the owner naming one. The stand-in writes only "On
  // site", "Hybrid" and "Remote", so the other ways of saying it are scripted.
  it("reads the arrangement the assistant wrote in plain words, once the owner's typed words name one", () => {
    const typed = [said("It is on site two days and remote three, so hybrid.")];
    for (const [written, code] of [["On site", "onsite"], ["On-site", "onsite"], ["In office", "onsite"], ["Hybrid", "hybrid"], ["Remote", "remote"], ["Work from home", "remote"]] as const) {
      const read = mergeFacts(facts(), facts({ remotePolicy: written }), typed);
      expect(read.remotePolicy, written).toBe(code);
      expect(fieldsKnownFromFacts(read, false), written).toEqual(["remote_policy"]);
    }
    // words that name two arrangements are not one: nothing is kept, and the card asks
    expect(mergeFacts(facts(), facts({ remotePolicy: "On site or remote" }), typed).remotePolicy).toBeUndefined();
  });

  it("takes the arrangement when the owner says it the way people do", () => {
    for (const [typed, written, code] of [
      ["We all work from home.", "Remote", "remote"], ["Everyone works remotely.", "Remote", "remote"], ["They would be working from home.", "Work from home", "remote"], ["It's WFH.", "remote", "remote"],
      ["It is in the office.", "In office", "onsite"], ["In person, five days a week.", "On site", "onsite"], ["On-site only.", "onsite", "onsite"], ["Hybrid, two days in.", "Hybrid", "hybrid"],
    ] as const) expect(mergeFacts(facts(), facts({ remotePolicy: written }), [said(typed)]).remotePolicy, typed).toBe(code);
    // typed beside the cards, it counts the same
    expect(mergeFacts(facts(), facts({ remotePolicy: "Remote" }), [said(OWNERS_SENTENCE), replied("Got it."), said("Where the job is: Austin, TX", "answers"), said("And we all work from home.")]).remotePolicy).toBe("remote");
  });

  it("still asks, never assumes: an arrangement nobody typed is not taken, in whatever words the assistant wrote it, and one the owner gave is not lost", () => {
    expect(mergeFacts(facts(), facts({ remotePolicy: "On site" }), [said(OWNERS_SENTENCE)]).remotePolicy).toBeUndefined();
    expect(mergeFacts(facts(), facts({ remotePolicy: "On site" }), [said("A dental assistant for our Tustin office, full time")]).remotePolicy).toBeUndefined();
    expect(mergeFacts(facts(), facts({ remotePolicy: "Work from home" }), [said("Work from home. Apply today.", "pasted_ad")]).remotePolicy).toBeUndefined();
    expect(mergeFacts(facts(), facts({ remotePolicy: "Remote" }), [said("On site, hybrid or remote: Remote", "answers")]).remotePolicy).toBeUndefined();
    // answered on a card, then repeated by the assistant in its own words on a later turn: kept as it was
    expect(mergeFacts(facts({ remotePolicy: "hybrid" }), facts({ remotePolicy: "Hybrid" }), [said("Remote days are Monday and Friday.")]).remotePolicy).toBe("hybrid");
    expect(mergeFacts(facts({ remotePolicy: "hybrid" }), facts({ remotePolicy: "On site" }), [said("Nice to have: Dentrix")]).remotePolicy).toBe("hybrid");
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
  /** The job record the server builds from the stand-in's writing and these answers, before the pay and the guard (`draftFromWritten`). */
  const record = async (f: IntakeFacts = answered) => draftFromWritten(await written(ctx([said(HYGIENIST)], f)), f, company.name);

  it("writes only the words: the owner's must-haves as what the person needs, three skills, six questions, the form's questions, the city by its name", async () => {
    const job = await written(ctx([said(HYGIENIST)], answered));
    expect(job.requirements.mustHaves.map((m) => m.text)).toEqual(["Active CA RDH license", "Periodontal charting"]);
    expect(job.competencies).toHaveLength(3);
    expect(job.competencies.every((c) => ["essential", "important", "helpful"].includes(c.importance))).toBe(true);
    expect(job.screening.questions).toHaveLength(6);
    expect(job.screening.questions[0].question).toBe("How do you explain perio findings to a patient?");
    expect(job.screening.maxMinutes).toBe(10);
    expect(job.formQuestions.map((q) => [q.kind, q.question])).toEqual([["yes_no", "Can you work Saturdays?"], ["yes_no", "Do you hold this: Active CA RDH license?"]]);
    expect(job.description.publicJobDescription.split(/\s+/).length).toBeGreaterThanOrEqual(120);
    expect(job.description.publicJobDescription).not.toMatch(/\$\s?\d/);
    expect(job.identity).toEqual({ title: "Registered Dental Hygienist", cities: ["Tustin"], employmentType: "full_time", schedule: "Monday to Friday" });
    // nothing the server sets is written: no pay, no notices, no work arrangement, none of the three lines under an email
    expect(Object.keys(job).sort()).toEqual(["assumptions", "communication", "competencies", "description", "formQuestions", "identity", "requirements", "screening"]);
    expect(Object.keys(job.communication).sort()).toEqual(["candidateMayBeTold", "companyBlurb", "tone"]);
  });

  // Until 25 November 2026 the model wrote these too and the code overwrote them. It is no longer asked (the shape it is
  // sent has none of them), so the server's values are the only ones there are.
  it("builds the job record from the writing and the owner's answers: the arrangement they gave, the state their words name, the code's three lines", async () => {
    const job = await record();
    expect(job.identity).toEqual({ title: "Registered Dental Hygienist", locations: [{ city: "Tustin", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday", remotePolicy: "hybrid" });
    expect(job.communication).toMatchObject({ signature: "The hiring team at Harbor Dental", disclosureText: "This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant.", humanAlternativeText: "To reach a person at any time, reply to any of our emails or use the contact on the job page." });
    expect(job.compliance).toEqual({ jurisdictions: [], notices: [] });
    expect(job.provenance).toEqual({ aiRunIds: [], assumptions: ["You did not name any nice-to-haves, so none are listed."] });
    expect(job.compensation).toBeUndefined();
    expect(Object.keys(job).sort()).toEqual(["communication", "competencies", "compliance", "description", "formQuestions", "identity", "provenance", "requirements", "schemaVersion", "screening"]);
    // a reply that carries them all the same loses them when it is read, so the owner's answer stands
    const wrote = WrittenJob.parse({ ...(await written(ctx([said(HYGIENIST)], answered))), compensation: { basis: "hourly", min: 10, max: 99 }, compliance: { jurisdictions: ["US-NV"], notices: [] }, identity: { title: "Registered Dental Hygienist", cities: ["Tustin"], employmentType: "full_time", remotePolicy: "onsite" } });
    expect(draftFromWritten(wrote, answered, company.name)).toMatchObject({ identity: { remotePolicy: "hybrid", locations: [{ city: "Tustin", region: "CA" }] }, compliance: { jurisdictions: [] } });
    expect(draftFromWritten(wrote, answered, company.name).compensation).toBeUndefined();
  });

  // The state decides which notices the job page carries and what the law asks of the ad. The model read it from the
  // place while the builder's own benefits card went by the code's reader, so the two could disagree. One reader now.
  it("reads the state of the job's place from the owner's answer with the code's own reader, never from the model", async () => {
    const places = async (locationText: string, cities: string[]) => draftFromWritten({ ...(await written(ctx([said(HYGIENIST)], answered))), identity: { title: "Registered Dental Hygienist", cities, employmentType: "full_time" } }, { ...answered, locationText }, company.name).identity.locations;
    expect(await places("Denver, CO", ["Denver"])).toEqual([{ city: "Denver", region: "CO", country: "US" }]);
    expect(await places("Boulder, Colorado 80302", ["Boulder"])).toEqual([{ city: "Boulder", region: "CO", country: "US" }]);
    // a state the model added to the city all the same is not kept beside the code's
    expect(await places("Kansas City, MO", ["Kansas City, MO"])).toEqual([{ city: "Kansas City", region: "MO", country: "US" }]);
    expect(await places("Portland, Oregon", ["Portland, Oregon"])).toEqual([{ city: "Portland", region: "OR", country: "US" }]);
    // two places in one state each get it; with no city written, the place is the state alone
    expect(await places("Irvine and Tustin, CA", ["Irvine", "Tustin"])).toEqual([{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }]);
    expect(await places("California", [])).toEqual([{ region: "CA", country: "US" }]);
    // an answer that names no state gives the job none: the code never guesses one, and the model is not asked
    expect(await places("Tustin", ["Tustin"])).toEqual([{ city: "Tustin", country: "US" }]);
    expect(await places("Tustin", ["Tustin, CA"])).toEqual([{ city: "Tustin", country: "US" }]);
    // and the notices and legal places follow the same reading, through the guard
    const colorado = { ...answered, locationText: "Denver, CO" };
    const done = finalizeDraft(await record(colorado), ctx([], colorado), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(done.compliance.jurisdictions).toEqual(["US-CO", "US-CA"]);
    expect(done.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
  });

  it("leaves the pay out when nobody confirmed one", async () => {
    expect(finalizeDraft(await record(), ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: IntakeServerState.parse({}) }).compensation).toBeUndefined();
  });

  it("sets the pay and the benefits line by rule, with who confirmed it, whatever the record held", async () => {
    const tampered = { ...(await record()), compensation: { basis: "hourly" as const, currency: "USD", min: 10, max: 99, benefitsSummary: "A pony", discloseRange: false } };
    const done = finalizeDraft(tampered, ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(done.compensation).toEqual({ basis: "hourly", currency: "USD", min: 45, max: 55, benefitsSummary: "Health cover", discloseRange: true });
    expect(done.provenance.payConfirmedBy).toEqual({ by: { kind: "user", id: "u1", name: "Dana" }, at: "2026-11-18T09:10:00.000Z", via: "pay_card" });
    expect(done.provenance).toMatchObject({ intakeSessionId: "s1", aiRunIds: ["r1"], payOrigin: "pay_card" });
    expect(done.compliance.jurisdictions).toContain("US-CA");
    expect(done.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
    // the pay is on a job as soon as a person confirmed it, though no model ever writes one
    expect(finalizeDraft(await record(), ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState("typed") }).compensation).toEqual({ basis: "hourly", currency: "USD", min: 45, max: 55, benefitsSummary: "Health cover", discloseRange: true });
  });

  it("drops a 'keep' the model wrote on a flagged phrase: it stays open, and a person's earlier keep of it carries over", async () => {
    const draft = await record();
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
    const job = await written(ctx([said(HYGIENIST)], answered));
    const wrong = { ...job, formQuestions: [...job.formQuestions, { kind: "yes_no" as const, key: "kids", question: "Do you have children?", required: true }] };
    const packet = finalizePacket(wrong, ctx([], answered), { sessionId: "eval", aiRunId: "r1" });
    expect(packet.identity.remotePolicy).toBe("hybrid");
    expect(packet.formQuestions.map((q) => q.key)).not.toContain("kids");
    expect(packet.formQuestions).toHaveLength(2);
    expect(packet.compensation).toMatchObject({ min: 45, max: 55 });
    // a job whose answers hold no arrangement reads as on site, the record's own rule, and no draft like it can be written or published
    const { remotePolicy: _none, ...unanswered } = answered;
    expect(draftFromWritten(job, unanswered, company.name).identity.remotePolicy).toBe("onsite");
  });
});
