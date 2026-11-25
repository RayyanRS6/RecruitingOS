import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt, intakeTurnPrompt, type IntakeContext } from "@ros/ai";
import { IntakeQuestion, IntakeServerState, IntakeTurn, WrittenJob, type IntakeFacts, type IntakeMessage } from "@ros/contracts";
import { adverseDecisionLineApplies, cvScoreFromReading, jobNoticesFor, unresolvedFlags } from "@ros/core";
import { registerFakeHandlers } from "./fake-handlers";
import { afterAnswers, afterTurn, alreadyAskedOf, draftFromWritten, fieldsKnownFromFacts, finalizeDraft, finalizePacket, inThePagesWords, mergeFacts, prepareQuestions, sameQuestion, typedSinceReply, withoutCardCount, withoutReadyClaim } from "./intake";

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

// The two halves of the card loop with no database, as the app runs them (`applyIntakeAnswers`, `runIntakeTurn`) and as
// the evaluations drive them: tapped answers, then the assistant's next turn with no new words typed.
describe("tapped answers and the turn after them, with no database", () => {
  const dana = { kind: "user" as const, id: "u1", name: "Dana" };
  const at = "2026-11-25T09:05:00.000Z";

  it("closes the cards that were sent, settles their fields, puts one summary in the conversation, and brings a skipped essential's card back", async () => {
    const idea = [said("We need a dental assistant.")];
    const first = after(await turn(ctx(idea)), idea);
    expect(first.questions.map((q) => q.field)).toEqual(["location", "remote_policy", "compensation"]);
    const [place, arrangement, pay] = first.questions;
    const conversation = [...idea, replied(first.message)];
    const answered = afterAnswers({ answers: [{ questionId: place.id, selected: [], own: ["Irvine, CA"], skipped: false }, { questionId: arrangement.id, selected: ["onsite"], own: [], skipped: false }, { questionId: pay.id, selected: [], own: [], skipped: true }], messages: conversation, facts: first.facts, state: first.state, actor: dana, at });
    expect(answered.facts).toMatchObject({ title: "dental assistant", locationText: "Irvine, CA", remotePolicy: "onsite" });
    expect(answered.summary).toEqual(["Where the job is: Irvine, CA", "On site, hybrid or remote: On site"]);
    expect(answered.messages.at(-1)).toEqual({ role: "owner", content: "Where the job is: Irvine, CA\nOn site, hybrid or remote: On site", at, kind: "answers" });
    expect(answered.state).toMatchObject({ openQuestions: [], answeredRounds: 1, settledFields: ["location", "remote_policy", "compensation", "compensation_basis"] });
    expect(answered.payConfirmed).toEqual([]);
    // the assistant is told all of it was asked or answered, the title included; the server asks for the pay again all the same
    const asked = alreadyAskedOf(answered.facts, answered.state);
    expect(asked).toEqual(["location", "remote_policy", "compensation", "compensation_basis", "title"]);
    const next = await turn(ctx(answered.messages, answered.facts, { alreadyAsked: asked }));
    expect(next.questions.map((q) => q.field)).toEqual(["employment_type", "schedule", "must_haves"]);
    const second = afterTurn({ turn: next, messages: answered.messages, facts: answered.facts, state: answered.state, actor: dana, at });
    expect(second.questions.map((q) => [q.field, q.mode])).toEqual([["compensation", "pay"], ["employment_type", "single"], ["schedule", "single"]]);
    expect(second.toAsk).toEqual(["compensation_range", "employment_type", "schedule", "must_haves"]);
    // nothing was typed since the last reply, so the facts stay exactly as the answers set them
    expect(second.facts).toEqual(answered.facts);
  });

  // The assistant is asked for an option's value in words, never a code ("Full time", not "full_time"): nothing reads
  // one as a code. The server draws the work arrangement's three answers itself, whatever the assistant offered, and
  // reads the kind of job from the words of the answer that was ticked.
  it("takes a ticked answer whose value is words: the kind of job is read from them, and the work arrangement's answers are the server's own", async () => {
    const messages = [said(OWNERS_SENTENCE)];
    const t = await turn(ctx(messages, facts(), { alreadyAsked: ["location", "compensation", "compensation_basis"] }));
    // as the stand-in writes its cards, the way the prompt asks: the value is the label's words
    expect(t.questions.map((q) => [q.field, q.options.map((o) => o.value)])).toEqual([["remote_policy", ["On site", "Hybrid", "Remote"]], ["employment_type", ["Full time", "Part time"]], ["schedule", ["Monday to Friday, daytime"]]]);
    const shown = prepareQuestions(t.questions, { turnNo: 2, payConfirmed: true, dealBreakers: [] });
    expect(shown.map((q) => [q.field, q.options.map((o) => o.value)])).toEqual([["remote_policy", ["onsite", "hybrid", "remote"]], ["employment_type", ["Full time", "Part time"]], ["schedule", ["Monday to Friday, daytime"]]]);
    const answered = afterAnswers({
      answers: [{ questionId: shown[0].id, selected: ["hybrid"], own: [], skipped: false }, { questionId: shown[1].id, selected: ["Full time"], own: [], skipped: false }, { questionId: shown[2].id, selected: [], own: [], skipped: true }],
      messages, facts: facts({ title: "Software Engineer" }), state: IntakeServerState.parse({ openQuestions: shown }), actor: dana, at,
    });
    expect(answered.facts).toMatchObject({ remotePolicy: "hybrid", employmentType: "full_time" });
    expect(answered.summary).toEqual(["On site, hybrid or remote: Hybrid", "Full time or part time: Full time"]);
    expect(answered.refused).toEqual([]);
  });

  it("records pay set on the pay card as set by that person, the same figures as an ad's as confirmed, and pay typed beside the cards as typed", () => {
    const payCard = IntakeQuestion.parse({ id: "q1_1", field: "compensation", prompt: "What will you pay?", mode: "pay" });
    const open = IntakeServerState.parse({ openQuestions: [payCard] });
    const base = { messages: [said("We need a dental assistant.")], actor: dana, at };
    const set = afterAnswers({ ...base, answers: [{ questionId: "q1_1", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 24, max: 28 } }], facts: facts({ title: "Dental Assistant" }), state: open });
    expect(set.payConfirmed).toEqual(["pay_card"]);
    expect(set.state.pay).toEqual({ by: dana, at, via: "pay_card", basis: "hourly", min: 24, max: 28 });
    const fromAd = facts({ title: "Dental Assistant", compensationBasis: "hourly", compensationMin: 24, compensationMax: 28 });
    expect(afterAnswers({ ...base, answers: [{ questionId: "q1_1", selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 24, max: 28 } }], facts: fromAd, state: open }).payConfirmed).toEqual(["confirmed"]);
    // the pay card skipped, and the figures the draft holds typed in the box beside the cards: typed by them, so theirs too
    const skipped = afterAnswers({ ...base, answers: [{ questionId: "q1_1", selected: [], own: [], skipped: true }], note: "It pays $24 to $28 an hour.", facts: fromAd, state: open });
    expect(skipped.messages.slice(-2).map((m) => [m.kind, m.content])).toEqual([["answers", "Skipped those questions."], ["text", "It pays $24 to $28 an hour."]]);
    expect(skipped.payConfirmed).toEqual(["typed"]);
    expect(skipped.state.pay).toMatchObject({ via: "typed", min: 24, max: 28 });
  });
});

// Until 25 November 2026 the AI filled in the state of the place when it wrote the job, so an owner who typed "Denver"
// still got Colorado's notices. It is no longer asked, and nothing else fills one in. So the place is answered only when
// the owner's own words say the state, and its card comes back until they do: a required notice never goes missing.
describe("the place of a job: its state is the owner's to say, and the card comes back until they do", () => {
  const dana = { kind: "user" as const, id: "u1", name: "Dana" };
  const at = "2026-11-25T10:00:00.000Z";
  const assistantIn = (place: string) => `I need a dental assistant in ${place}, on site, full time, Monday to Friday, $24 to $28 an hour. Must-haves: radiography certificate.`;
  const PLACE_CARD = "Where is the job? Give the city and state.";
  /** The stand-in's turn on the owner's sentence, and what the server makes of it. */
  const first = async (sentence: string) => {
    const messages = [said(sentence)];
    const t = await turn(ctx(messages));
    return { messages, t, server: after(t, messages) };
  };
  const places = async (f: IntakeFacts, messages: IntakeMessage[]) => {
    const record = draftFromWritten(await written(ctx(messages, f)), f, company.name);
    const done = finalizeDraft(record, ctx(messages, f), { sessionId: "s1", aiRunId: "r1", state: IntakeServerState.parse({ pay: { by: dana, at, via: "typed", basis: "hourly", min: 24, max: 28 } }) });
    // What the job's own place brings, the company's places aside: the notices on its page, and Colorado's line on a decision message.
    return { locations: done.identity.locations, jurisdictions: done.compliance.jurisdictions, pageNotices: jobNoticesFor({ jobLocations: done.identity.locations }).map((n) => n.key), coloradoLine: adverseDecisionLineApplies({ jobLocations: done.identity.locations }) };
  };

  it("keeps the place card and holds the job for 'Denver' alone, also when it is answered with the city again, until the state is said", async () => {
    const { messages, t, server } = await first(assistantIn("Denver"));
    expect(t.factsExtracted.locationText).toBe("Denver");
    // every other essential is in the sentence: only the place is still needed, it has its card, and the job cannot be written
    expect(server).toMatchObject({ missing: ["location"], toAsk: ["location"], mayDraft: false });
    expect(server.questions.map((q) => [q.field, q.prompt])).toEqual([["location", PLACE_CARD]]);
    expect(fieldsKnownFromFacts(server.facts, true)).not.toContain("location");
    // the city again is no state: the same card comes back, as often as it takes
    const conversation = [...messages, replied(server.message)];
    const again = afterAnswers({ answers: [{ questionId: server.questions[0].id, selected: [], own: ["Denver"], skipped: false }], messages: conversation, facts: server.facts, state: server.state, actor: dana, at });
    expect(again.facts.locationText).toBe("Denver");
    const second = afterTurn({ turn: await turn(ctx(again.messages, again.facts, { alreadyAsked: alreadyAskedOf(again.facts, again.state) })), messages: again.messages, facts: again.facts, state: again.state, actor: dana, at });
    expect(second).toMatchObject({ missing: ["location"], mayDraft: false });
    expect(second.questions.map((q) => [q.field, q.prompt])).toEqual([["location", PLACE_CARD]]);
    // the state alone completes the place the owner already gave, and the job can be written
    const stated = afterAnswers({ answers: [{ questionId: second.questions[0].id, selected: [], own: ["CO"], skipped: false }], messages: [...again.messages, replied(second.message)], facts: second.facts, state: second.state, actor: dana, at });
    expect(stated.facts.locationText).toBe("Denver, CO");
    expect(stated.summary).toEqual(["Where the job is: CO"]);
    const third = afterTurn({ turn: await turn(ctx(stated.messages, stated.facts, { alreadyAsked: alreadyAskedOf(stated.facts, stated.state) })), messages: stated.messages, facts: stated.facts, state: stated.state, actor: dana, at });
    expect(third).toMatchObject({ missing: [], mayDraft: true });
    // Colorado's own rule now applies: its law asks the ad to describe the benefits, so that card is offered
    expect(third.questions.map((q) => q.field)).toEqual(["benefits"]);
    // and the job written from it is in Colorado, with Colorado's notices
    const job = await places(third.facts, stated.messages);
    expect(job.locations).toEqual([{ city: "Denver", region: "CO", country: "US" }]);
    expect(job.jurisdictions).toContain("US-CO");
    expect(job.pageNotices).toEqual(["ai_use", "privacy", "pay_transparency", "adverse_decision_explanation"]);
    expect(job.coloradoLine).toBe(true);
  });

  it("passes 'Denver, CO' at once, and the written job's place has the state and Colorado's notices", async () => {
    const { messages, server } = await first(assistantIn("Denver, CO"));
    expect(server.facts.locationText).toBe("Denver, CO");
    expect(server).toMatchObject({ missing: [], mayDraft: true });
    expect(server.questions.map((q) => q.field)).toEqual(["benefits"]);
    const job = await places(server.facts, messages);
    expect(job.locations).toEqual([{ city: "Denver", region: "CO", country: "US" }]);
    expect(job.jurisdictions).toContain("US-CO");
    expect(job.pageNotices).toEqual(["ai_use", "privacy", "pay_transparency", "adverse_decision_explanation"]);
    expect(job.coloradoLine).toBe(true);
    // the city alone, had it been written so, would carry neither of Colorado's
    expect(jobNoticesFor({ jobLocations: [{ city: "Denver", country: "US" }] }).map((n) => n.key)).toEqual(["ai_use", "privacy"]);
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Denver", country: "US" }] })).toBe(false);
  });

  it("asks again for 'Kansas City', which names no state, and reads Missouri from 'Kansas City, MO'", async () => {
    const alone = await first(assistantIn("Kansas City"));
    expect(alone.server.facts.locationText).toBe("Kansas City");
    expect(alone.server).toMatchObject({ missing: ["location"], mayDraft: false });
    expect(alone.server.questions.map((q) => q.prompt)).toEqual([PLACE_CARD]);
    const withState = await first(assistantIn("Kansas City, MO"));
    expect(withState.server).toMatchObject({ missing: [], mayDraft: true, questions: [] });
    const job = await places(withState.server.facts, withState.messages);
    expect(job.locations).toEqual([{ city: "Kansas City", region: "MO", country: "US" }]);
    expect(job.jurisdictions).toContain("US-MO");
    expect(job.jurisdictions).not.toContain("US-KS");
  });

  // The assistant is told to write what the owner gave, and it knows where cities are. A state it adds is not the
  // owner's: it is left off, and the card asks. A state the owner did write stays, however the assistant spells it.
  it("leaves off a state the assistant added to a city the owner named without one, and keeps one the owner wrote", async () => {
    const merged = (ownerSaid: string[], assistantRead: string, before: IntakeFacts = facts()) => mergeFacts(before, facts({ locationText: assistantRead }), ownerSaid.map((s) => said(s))).locationText;
    expect(merged([assistantIn("Denver")], "Denver, CO")).toBe("Denver");
    expect(merged([assistantIn("Denver")], "Denver, Colorado")).toBe("Denver");
    expect(merged([assistantIn("Kansas City")], "Kansas City, MO")).toBe("Kansas City");
    expect(merged([assistantIn("Kansas City")], "Kansas City, Kansas")).toBe("Kansas City");
    // the owner wrote it: after the city in any of the usual ways, or by itself in a later message
    expect(merged([assistantIn("Denver, CO")], "Denver, CO")).toBe("Denver, CO");
    expect(merged([assistantIn("Denver, CO")], "Denver, Colorado")).toBe("Denver, Colorado");
    expect(merged([assistantIn("denver co")], "Denver, CO")).toBe("Denver, CO");
    expect(merged([assistantIn("Denver, Colorado")], "Denver, CO")).toBe("Denver, CO");
    expect(merged([assistantIn("Denver"), "It is in Colorado."], "Denver, CO", facts({ locationText: "Denver" }))).toBe("Denver, CO");
    expect(merged([assistantIn("Denver"), "Denver, CO"], "Denver, CO", facts({ locationText: "Denver" }))).toBe("Denver, CO");
    // so with a state the assistant added, the server still asks for the place and holds the job
    const { messages, t } = await first(assistantIn("Denver"));
    const guessed = after({ ...t, factsExtracted: { ...t.factsExtracted, locationText: "Denver, CO" } }, messages);
    expect(guessed.facts.locationText).toBe("Denver");
    expect(guessed).toMatchObject({ missing: ["location"], mayDraft: false });
    expect(guessed.questions.map((q) => q.prompt)).toEqual([PLACE_CARD]);
  });

  // A wrong state is worse than none: it puts another state's notices on the job and leaves the right ones off, and
  // nothing on the page shows the owner how the place was read. "LA" is Los Angeles as often as Louisiana, and "OK" and
  // "OR" are everyday words in capitals: without a comma they say no state, and the card for the place asks.
  it("reads no state from 'Downtown LA', 'East LA', 'LA', 'Remote OK' or 'Portland OR': the place card comes back for each", async () => {
    for (const place of ["Downtown LA", "East LA", "LA", "Remote OK", "Portland OR"]) {
      const messages = [said(assistantIn(place))];
      const t = await turn(ctx(messages));
      // the assistant read the place as the owner wrote it; the rest is in the sentence
      const server = after({ ...t, factsExtracted: { ...t.factsExtracted, locationText: place, remotePolicy: "On site" } }, messages);
      expect(server.facts.locationText, place).toBe(place);
      expect(server.missing, place).toEqual(["location"]);
      expect(server.mayDraft, place).toBe(false);
      expect(server.questions.map((q) => q.prompt), place).toEqual([PLACE_CARD]);
    }
    // with the comma the same codes are the state, and so is any other code as the last word
    for (const [place, state] of [["Baton Rouge, LA", "LA"], ["Tulsa, OK", "OK"], ["Austin TX", "TX"]] as const) {
      const messages = [said(assistantIn(place))];
      const t = await turn(ctx(messages));
      const server = after({ ...t, factsExtracted: { ...t.factsExtracted, locationText: place, remotePolicy: "On site" } }, messages);
      expect(server.missing, place).toEqual([]);
      const job = await places(server.facts, messages);
      expect(job.locations.map((l) => l.region), place).toEqual([state]);
      expect(job.jurisdictions, place).toContain(`US-${state}`);
    }
  });

  it("keeps asking through 'LA' given twice on the card, and takes California once the owner says Los Angeles and then CA", async () => {
    const { messages, t, server } = await first(assistantIn("Downtown LA"));
    expect(t.factsExtracted.locationText).toBe("Downtown LA");
    expect(server).toMatchObject({ missing: ["location"], mayDraft: false });
    /** The place card answered with these words, and the turn after it. */
    const answer = async (from: { server: ReturnType<typeof afterTurn>; messages: IntakeMessage[] }, own: string) => {
      const answered = afterAnswers({ answers: [{ questionId: from.server.questions[0].id, selected: [], own: [own], skipped: false }], messages: [...from.messages, replied(from.server.message)], facts: from.server.facts, state: from.server.state, actor: dana, at });
      const next = afterTurn({ turn: await turn(ctx(answered.messages, answered.facts, { alreadyAsked: alreadyAskedOf(answered.facts, answered.state) })), messages: answered.messages, facts: answered.facts, state: answered.state, actor: dana, at });
      return { server: next, messages: answered.messages };
    };
    // "LA" completes nothing and says no state, the first time and the second
    let draft = await answer({ server, messages }, "LA");
    expect(draft.server.facts.locationText).toBe("LA");
    expect(draft.server.questions.map((q) => q.prompt)).toEqual([PLACE_CARD]);
    draft = await answer(draft, "LA");
    expect(draft.server.facts.locationText).toBe("LA");
    expect(draft.server).toMatchObject({ missing: ["location"], mayDraft: false });
    expect(draft.server.questions.map((q) => q.prompt)).toEqual([PLACE_CARD]);
    // the city by its name is still no state
    draft = await answer(draft, "Los Angeles");
    expect(draft.server.facts.locationText).toBe("Los Angeles");
    expect(draft.server.questions.map((q) => q.prompt)).toEqual([PLACE_CARD]);
    // "CA" completes it: California, and the job can be written
    draft = await answer(draft, "CA");
    expect(draft.server.facts.locationText).toBe("Los Angeles, CA");
    expect(draft.server).toMatchObject({ missing: [], mayDraft: true });
    const job = await places(draft.server.facts, draft.messages);
    expect(job.locations).toEqual([{ city: "Los Angeles", region: "CA", country: "US" }]);
    expect(job.jurisdictions).toEqual(["US-CA"]);
  });

  // The assistant may put the comma in itself ("Downtown, LA"): the owner's own words still have no comma, so no state.
  it("does not let a comma the assistant added turn 'Downtown LA' into Louisiana", () => {
    const merged = (ownerSaid: string, assistantRead: string) => mergeFacts(facts(), facts({ locationText: assistantRead }), [said(ownerSaid)]).locationText;
    expect(merged(assistantIn("Downtown LA"), "Downtown, LA")).toBe("Downtown");
    expect(merged(assistantIn("Portland OR"), "Portland, OR")).toBe("Portland");
    // the owner's own comma, or the state's name, says it
    expect(merged(assistantIn("Baton Rouge, LA"), "Baton Rouge, LA")).toBe("Baton Rouge, LA");
    expect(merged(assistantIn("Portland, Oregon"), "Portland, OR")).toBe("Portland, OR");
  });

  // The same principle for a state's name. Fort Washington is in Maryland and in Pennsylvania, Port Washington in New
  // York and in Wisconsin: a name at the end of a longer place name is not the state, and asking again costs one tap.
  // "Washington" by itself is the state or the capital, so it says neither.
  it("reads no state from 'Fort Washington', 'East Texas', 'Reno Nevada' or 'Washington' alone, and reads it once the name stands after its comma", async () => {
    for (const place of ["Fort Washington", "Port Washington", "Mount Washington", "East Texas", "Reno Nevada", "Washington"]) {
      const messages = [said(assistantIn(place))];
      const t = await turn(ctx(messages));
      const server = after({ ...t, factsExtracted: { ...t.factsExtracted, locationText: place, remotePolicy: "On site" } }, messages);
      expect(server.facts.locationText, place).toBe(place);
      expect(server.missing, place).toEqual(["location"]);
      expect(server.mayDraft, place).toBe(false);
      expect(server.questions.map((q) => q.prompt), place).toEqual([PLACE_CARD]);
    }
    for (const [place, state] of [["Fort Washington, Maryland", "MD"], ["Fort Washington, PA", "PA"], ["Reno, Nevada", "NV"], ["Seattle, Washington", "WA"], ["Washington, DC", "DC"]] as const) {
      const messages = [said(assistantIn(place))];
      const t = await turn(ctx(messages));
      const server = after({ ...t, factsExtracted: { ...t.factsExtracted, locationText: place, remotePolicy: "On site" } }, messages);
      expect(server.facts.locationText, place).toBe(place);
      expect(server.missing, place).toEqual([]);
      const job = await places(server.facts, messages);
      expect(job.locations.map((l) => l.region), place).toEqual([state]);
      expect(job.jurisdictions, place).toContain(`US-${state}`);
    }
  });

  // A state the owner says away from the city, in a typed message, keeps the state the assistant then writes with the
  // city. That holds for every state but a bare "Washington", which is the state or the capital.
  it("keeps a state the owner said by itself in a typed message, but never on a bare 'Washington'", () => {
    const merged = (ownerSaid: string[], assistantRead: string, before: string) => mergeFacts(facts({ locationText: before }), facts({ locationText: assistantRead }), ownerSaid.map((s) => said(s))).locationText;
    expect(merged([assistantIn("Denver"), "It is in Colorado."], "Denver, CO", "Denver")).toBe("Denver, CO");
    expect(merged([assistantIn("Fort Washington"), "It is in Maryland."], "Fort Washington, MD", "Fort Washington")).toBe("Fort Washington, MD");
    expect(merged([assistantIn("Charleston"), "That is West Virginia."], "Charleston, WV", "Charleston")).toBe("Charleston, WV");
    expect(merged([assistantIn("Reno"), "Nevada"], "Reno, NV", "Reno")).toBe("Reno, NV");
    // a bare "Washington" keeps neither the state nor the capital, and a name inside a longer one keeps nothing
    expect(merged([assistantIn("Seattle"), "It is in Washington."], "Seattle, WA", "Seattle")).toBe("Seattle");
    expect(merged([assistantIn("Georgetown"), "It is in Washington."], "Georgetown, DC", "Georgetown")).toBe("Georgetown");
    expect(merged([assistantIn("Fort Washington")], "Fort Washington, WA", "")).toBe("Fort Washington");
    expect(merged([assistantIn("Reno Nevada")], "Reno, Nevada", "")).toBe("Reno");
    // said so that it can only be one of the two, it is kept
    expect(merged([assistantIn("Seattle"), "It is in WA."], "Seattle, WA", "Seattle")).toBe("Seattle, WA");
    expect(merged([assistantIn("Georgetown"), "It is in Washington DC."], "Georgetown, DC", "Georgetown")).toBe("Georgetown, DC");
    expect(merged([assistantIn("Seattle, Washington")], "Seattle, WA", "")).toBe("Seattle, WA");
  });

  // As before this rule: a remote job whose owner names no place has no state of its own, and is not asked for one.
  it("asks a remote job with no place for no state, and writes it with no state of its own", async () => {
    const sentence = "I need a support agent, remote, full time, Monday to Friday, $20 to $24 an hour. Must-haves: two years in customer support.";
    const { messages, t, server } = await first(sentence);
    expect(t.factsExtracted.locationText).toBeUndefined();
    expect(server.facts.remotePolicy).toBe("remote");
    expect(server).toMatchObject({ missing: ["location"], mayDraft: false });
    const answered = afterAnswers({ answers: [{ questionId: server.questions[0].id, selected: [], own: ["Anywhere in the US"], skipped: false }], messages: [...messages, replied(server.message)], facts: server.facts, state: server.state, actor: dana, at });
    const next = afterTurn({ turn: await turn(ctx(answered.messages, answered.facts, { alreadyAsked: alreadyAskedOf(answered.facts, answered.state) })), messages: answered.messages, facts: answered.facts, state: answered.state, actor: dana, at });
    expect(next.facts.locationText).toBe("Anywhere in the US");
    expect(next).toMatchObject({ missing: [], mayDraft: true });
    expect(fieldsKnownFromFacts(next.facts, true)).toContain("location");
    // a remote job answers to every state with a rule for job ads, whatever its place: the benefits card, as before
    expect(next.questions.map((q) => q.field)).toEqual(["benefits"]);
    // written with no city named, its one place has no state of its own
    const record = draftFromWritten({ ...(await written(ctx(answered.messages, next.facts))), identity: { title: "Support agent", cities: [], employmentType: "full_time" } }, next.facts, company.name);
    expect(record.identity.locations).toEqual([{ country: "US" }]);
    expect(record.identity.remotePolicy).toBe("remote");
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
    expect(await places("Orange County, CA", ["Irvine"])).toEqual([{ city: "Irvine", region: "CA", country: "US" }]);
    expect(await places("California", [])).toEqual([{ region: "CA", country: "US" }]);
    // a state's name inside a city's name is not the state: the code after the comma is, and a city named like a state is not taken for it
    expect(await places("Kansas City, MO", ["Kansas City"])).toEqual([{ city: "Kansas City", region: "MO", country: "US" }]);
    expect(await places("Washington, DC", ["Washington"])).toEqual([{ city: "Washington", region: "DC", country: "US" }]);
    expect(await places("Kansas City", ["Kansas City"])).toEqual([{ city: "Kansas City", country: "US" }]);
    // a code written with no comma is read after its city, in one state or in two
    expect(await places("Austin TX", ["Austin"])).toEqual([{ city: "Austin", region: "TX", country: "US" }]);
    expect(await places("Austin TX and Reno NV", ["Austin", "Reno"])).toEqual([{ city: "Austin", region: "TX", country: "US" }, { city: "Reno", region: "NV", country: "US" }]);
    // places in different states: each city gets the state written with it, never the one written last for all of them
    const [tustin, reno] = [{ city: "Tustin", region: "CA", country: "US" }, { city: "Reno", region: "NV", country: "US" }];
    expect(await places("Tustin, CA and Reno, NV", ["Tustin", "Reno"])).toEqual([tustin, reno]);
    expect(await places("Tustin, California; Reno, Nevada", ["Tustin, California", "Reno, Nevada"])).toEqual([tustin, reno]);
    expect(await places("Tustin, CA / Reno, NV", ["Reno", "Tustin"])).toEqual([reno, tustin]);
    expect(await places("Irvine, Tustin, CA and Reno, NV", ["Irvine", "Tustin", "Reno"])).toEqual([{ city: "Irvine", region: "CA", country: "US" }, tustin, reno]);
    // a city is found as a word of its own: "Reno" is not the end of "Moreno Valley"
    expect(await places("Moreno Valley, CA and Reno, NV", ["Reno", "Moreno Valley"])).toEqual([reno, { city: "Moreno Valley", region: "CA", country: "US" }]);
    // among places in different states, a city with no state written from its name on has none, and so has one the answer does not name
    expect(await places("Tustin, CA and Reno, NV, and Boise", ["Tustin", "Reno", "Boise"])).toEqual([tustin, reno, { city: "Boise", country: "US" }]);
    expect(await places("Tustin, CA and Reno, NV", ["Tustin", "Sparks"])).toEqual([tustin, { city: "Sparks", country: "US" }]);
    // an answer that names no state gives the job none: the code never guesses one, and the model is not asked
    expect(await places("Tustin", ["Tustin"])).toEqual([{ city: "Tustin", country: "US" }]);
    expect(await places("Tustin", ["Tustin, CA"])).toEqual([{ city: "Tustin", country: "US" }]);
    // and the notices and legal places follow the same reading, through the guard
    const colorado = { ...answered, locationText: "Denver, CO" };
    const done = finalizeDraft(await record(colorado), ctx([], colorado), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(done.compliance.jurisdictions).toEqual(["US-CO", "US-CA"]);
    expect(done.compliance.notices).toEqual(expect.arrayContaining(["ai_use", "privacy", "pay_transparency"]));
  });

  // The model is asked for keys that are unique in their list, and nothing held it to that. A reading's findings are
  // matched to a job's must-haves and skills by key, so two must-haves written under one key shared one finding.
  it("gives every item of a job the model wrote a key of its own, so each must-have is read on its own finding", async () => {
    const job = await written(ctx([said(HYGIENIST)], answered));
    const twins = { ...job, requirements: { ...job.requirements, mustHaves: job.requirements.mustHaves.map((m) => ({ ...m, key: "must_have" })) }, competencies: job.competencies.map((c) => ({ ...c, key: "skill" })) };
    const done = finalizeDraft(draftFromWritten(twins, answered, company.name), ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(done.requirements.mustHaves.map((m) => [m.key, m.text])).toEqual([["must_have", "Active CA RDH license"], ["must_have_2", "Periodontal charting"]]);
    expect(done.competencies.map((c) => c.key)).toEqual(["skill", "skill_2", "skill_3"]);
    // a reading that shows the licence and says nothing of the charting: one must-have shown of two, by the real score
    const reading = { requirementFindings: [{ requirementKey: "must_have", met: "yes" as const, evidence: { source: "resume" as const, quote: "RDH license CA active" } }], competencyFindings: [] };
    expect(cvScoreFromReading(reading, done).mustHaves).toEqual({ shown: 1, total: 2 });
    // the same reading against the job as the model keyed it would have shown both
    expect(cvScoreFromReading(reading, twins).mustHaves).toEqual({ shown: 2, total: 2 });
    // a job whose keys are already its own keeps every one of them
    const own = finalizeDraft(await record(), ctx([], answered), { sessionId: "s1", aiRunId: "r1", state: payState() });
    expect(own.requirements.mustHaves.map((m) => m.key)).toEqual(job.requirements.mustHaves.map((m) => m.key));
    expect(own.screening.questions.map((q) => q.key)).toEqual(job.screening.questions.map((q) => q.key));
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
