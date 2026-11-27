import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, intakeCompilePrompt } from "@ros/ai";
import { afterTurn, finalizePacket, mergeFacts, registerFakeHandlers, type AfterTurn } from "@ros/agents";
import { IntakeServerState, WrittenJob, type IntakeFacts, type IntakeMessage, type IntakeQuestion, type IntakeTurn, type RolePacket } from "@ros/contracts";
import { intakeContextOf, runIntakeCase, type IntakeModelCall } from "./intake-run";
import { EMPTY_FACTS, cardLoopFailures, draftFailures, draftSkillsNote, intakeGolden, intakeIllegal, intakeJobAd, intakeProxyRefusal, noticeLineFailures, ruleOutMustHaves, skillsRepeatingMustHaves, writtenJobFailures, type IntakeCase } from "./intake-suite";

/**
 * The job builder's evaluation cases. Every case passes on the local stand-in, driven as the runner drives it, so the
 * evaluations stay green without a model; and each check fails on a turn or a job that breaks the line of the prompt
 * it measures, so a run on the real models can fail where the builder rests on the prompt.
 */
function standIn() {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  let runs = 0;
  const call: IntakeModelCall = async (prompt, input, meta) => {
    const { result, model } = await callPrompt(rt, prompt, input, { companyId: null, ...meta });
    runs += 1;
    if (result.kind === "ok") return { ok: true, output: result.output, runId: `run_${runs}`, model };
    return { ok: false, runId: `run_${runs}`, model, reason: result.kind === "refused" ? "refused" : "invalid", error: result.kind === "refused" ? result.reason : result.error };
  };
  /** The stand-in's job from these answers: as it wrote it, and as the server finishes it. */
  const written = async (c: IntakeCase, answers: Partial<IntakeFacts> = c.facts ?? {}) => {
    const { ctx } = intakeContextOf(c, { ...EMPTY_FACTS, ...answers }, c.ownerMessages.map((content) => ({ role: "owner" as const, content, at: "2026-11-18T12:00:00.000Z", kind: "text" as const })));
    const r = await callPrompt(rt, intakeCompilePrompt, ctx, { companyId: null });
    if (r.result.kind !== "ok") throw new Error(`the stand-in did not write a job: ${r.result.kind}`);
    const draft = r.result.output;
    return { draft, finish: (d: WrittenJob = draft): RolePacket => finalizePacket(d, ctx, { sessionId: "eval", aiRunId: "r" }) };
  };
  return { fake, call, written, tasks: () => fake.calls.map((c) => c.task) };
}

const byId = (id: string): IntakeCase => {
  const c = [...intakeGolden, ...intakeIllegal, ...intakeJobAd, ...intakeProxyRefusal].find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
/** What the conversation leaves for the hygienist's one sentence, so its job can be written here without a turn. */
const RDH_ANSWERS: Partial<IntakeFacts> = { title: "Registered Dental Hygienist", locationText: "Tustin, CA", remotePolicy: "onsite", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 45, compensationMax: 55, mustHaves: ["Active CA RDH license", "Periodontal charting"] };
const mustHave = (text: string): RolePacket["requirements"]["mustHaves"][number] => ({ key: text.toLowerCase().replace(/[^a-z]+/g, "_"), text, rationale: "Chosen by the owner" });
const skill = (name: string, definition = "Shown in recent work."): RolePacket["competencies"][number] => ({ key: name.toLowerCase().replace(/[^a-z]+/g, "_"), name, definition, importance: "important", indicators: ["An example from recent work"] });
const turn = (over: Partial<IntakeTurn>): IntakeTurn => ({ assistantMessage: "Got it.", factsExtracted: { ...EMPTY_FACTS }, questions: [], notARole: false, takenFromAd: [], ...over });
const card = (over: Partial<IntakeQuestion>): IntakeQuestion => ({ id: "q1", field: "remote_policy", prompt: "Is the job on site, hybrid or remote?", mode: "single", options: [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Hybrid", value: "hybrid", origin: "assistant" }, { label: "Remote", value: "remote", origin: "assistant" }], allowOwn: false, why: "Candidates decide whether to apply on it.", ...over });
const firstMessage = (id: string): IntakeMessage[] => [{ role: "owner", content: byId(id).ownerMessages[0]!, at: "2026-11-25T12:00:00.000Z", kind: byId(id).pastedAd ? "pasted_ad" : "text" }];
/** What the server makes of a turn that answers a case's first message, by the app's own code (`afterTurn`). */
const serverOf = (id: string, t: IntakeTurn): AfterTurn => afterTurn({ turn: t, messages: firstMessage(id), facts: { ...EMPTY_FACTS }, state: IntakeServerState.parse({}), actor: { kind: "system", id: "eval" }, at: "2026-11-25T12:00:05.000Z" });
/**
 * A case's check on a turn, as the runner hands it over (`runIntakeCase`): the facts as the builder keeps them from the
 * model's reading, and what the server makes of the turn.
 */
const judge = (id: string, t: IntakeTurn): string[] => byId(id).expectTurn!({ ...t, factsExtracted: mergeFacts({ ...EMPTY_FACTS }, t.factsExtracted, firstMessage(id)) }, serverOf(id, t));
/** What an assistant reads from the sentence that names Denver and no state (the two cases of the city alone), the place aside. */
const DENVER_READ: IntakeFacts = { ...EMPTY_FACTS, title: "Dental assistant", remotePolicy: "On site", employmentType: "Full time", schedule: "Monday to Friday", compensationBasis: "hourly", compensationMin: 24, compensationMax: 28, mustHaves: ["Radiography certificate"] };
/** A turn on that sentence that reads the city and asks for its state on a card of its own. */
const askedOnACard: IntakeTurn = turn({ factsExtracted: { ...DENVER_READ, locationText: "Denver" }, questions: [card({ field: "location", prompt: "Which state is Denver in?", mode: "free", options: [], allowOwn: true, why: "The state is on the job page." })] });

describe("the job builder's suites on the stand-in", () => {
  it("pass, every case, driven as the runner drives them", async () => {
    const suites: Array<[string, IntakeCase[], boolean]> = [["intake.golden", intakeGolden, true], ["intake.illegal_criteria", intakeIllegal, true], ["intake.job_ad", intakeJobAd, false], ["intake.proxy_refusal", intakeProxyRefusal, false]];
    expect(suites.map(([name, cases]) => [name, cases.length])).toEqual([["intake.golden", 8], ["intake.illegal_criteria", 5], ["intake.job_ad", 2], ["intake.proxy_refusal", 3]]);
    for (const [name, cases, compile] of suites) {
      for (const c of cases) expect((await runIntakeCase(standIn().call, c, compile)).failures, `${name} ${c.id}`).toEqual([]);
    }
  });

  it("ask one turn for each message, read a pasted ad once before the first reply, and write a job only where a case checks one", async () => {
    const tasksOf = async (id: string, compile: boolean) => {
      const s = standIn();
      await runIntakeCase(s.call, byId(id), compile);
      return s.tasks();
    };
    expect(await tasksOf("dental_rdh_one_sentence", true)).toEqual(["intake.turn", "intake.compile"]);
    expect(await tasksOf("front_office_arrangement_not_said", true)).toEqual(["intake.turn"]);
    expect(await tasksOf("age_recent_grads", true)).toEqual(["intake.turn", "intake.turn", "intake.compile"]);
    expect(await tasksOf("no_gaps", true)).toEqual(["intake.turn", "intake.turn"]);
    expect(await tasksOf("dental_assistant_ad", false)).toEqual(["intake.extract", "intake.turn"]);
  });
});

describe("intake.golden: the conversation", () => {
  // Whether the job can be written, and what is still needed, is judged on what the server works out after the turn
  // (`afterTurn`, the app's own code): the model is not asked for either, and the app never read what it used to answer.
  it("fails a turn that assumes the work arrangement, asks no card for it, or offers other answers", () => {
    const id = "front_office_arrangement_not_said";
    expect(judge(id, turn({ questions: [card({})] }))).toEqual([]);
    // an arrangement the model assumed is not kept by the app, which still asks for it on its own card; the model's missing card is the failure left
    const assumed = turn({ factsExtracted: { ...EMPTY_FACTS, remotePolicy: "onsite" } });
    expect(serverOf(id, assumed)).toMatchObject({ mayDraft: false });
    expect(serverOf(id, assumed).missing).toContain("remote_policy");
    expect(serverOf(id, assumed).questions.map((q) => q.field)).toContain("remote_policy");
    expect(judge(id, assumed)).toEqual(["no card asks whether the job is on site, hybrid or remote"]);
    // and were the app ever to keep it, count the job as ready and show no card, each of those fails the case
    expect(byId(id).expectTurn!(assumed, { ...serverOf(id, assumed), mayDraft: true, missing: [], questions: [] })).toEqual([
      "the work arrangement was assumed (onsite); the owner did not say it",
      "the job is ready to write without the work arrangement",
      "the page shows no card for the work arrangement",
      "no card asks whether the job is on site, hybrid or remote",
    ]);
    // the three answers are judged by their words: the model is asked for an option's value in words, not as a code
    const worded = (labels: string[]) => card({ options: labels.map((label) => ({ label, value: label, origin: "assistant" as const })) });
    expect(judge(id, turn({ questions: [worded(["On site", "Hybrid", "Remote"])] }))).toEqual([]);
    expect(judge(id, turn({ questions: [worded(["On-site", "Hybrid", "Remote"])] }))).toEqual([]);
    expect(judge(id, turn({ questions: [worded(["In the office", "Hybrid", "Remote"])] }))).toEqual(["the work arrangement card does not offer exactly On site, Hybrid and Remote"]);
    expect(judge(id, turn({ questions: [card({ allowOwn: true })] }))).toEqual(["the work arrangement card does not offer exactly On site, Hybrid and Remote"]);
    expect(judge(id, turn({ questions: [card({ options: [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Remote", value: "remote", origin: "assistant" }] })] }))).toEqual(["the work arrangement card does not offer exactly On site, Hybrid and Remote"]);
  });

  it("fails a turn that asks again for what the owner's sentence already said, or leaves the job unable to be written", () => {
    const id = "dental_rdh_one_sentence";
    const read = turn({ factsExtracted: { ...EMPTY_FACTS, ...RDH_ANSWERS } });
    // every essential read, and the pay the owner typed counted as theirs: the server finds the job can be written
    expect(serverOf(id, read)).toMatchObject({ mayDraft: true, missing: [], payTyped: true });
    expect(judge(id, read)).toEqual([]);
    expect(judge(id, { ...read, questions: [card({}), card({ id: "q2", field: "benefits", mode: "free", options: [], allowOwn: true })] })).toEqual(["asked again for what the owner already said: remote_policy"]);
    // a pay the owner did not type is not theirs, so the page would still ask them to confirm it
    expect(judge(id, turn({ factsExtracted: { ...EMPTY_FACTS, ...RDH_ANSWERS, remotePolicy: "hybrid", compensationMax: 58 } }))).toEqual([
      "the work arrangement the owner said (on site) was read as hybrid",
      "the pay was not read as $45 to $55 an hour",
      "every essential was given, so the job should be ready to write; the page still asks for the pay to be confirmed",
    ]);
    // an essential the model did not read is one the page still asks for
    const noSchedule = Object.fromEntries(Object.entries(RDH_ANSWERS).filter(([k]) => k !== "schedule")) as Partial<IntakeFacts>;
    expect(judge(id, turn({ factsExtracted: { ...EMPTY_FACTS, ...noSchedule } }))).toEqual([
      "the schedule was not read",
      "every essential was given, so the job should be ready to write; the page still asks for schedule",
    ]);
  });

  it("fails a pasted ad's turn that follows its instruction, or leaves its pay and its work arrangement unasked", () => {
    const id = "dental_assistant_ad";
    const facts: IntakeFacts = { ...EMPTY_FACTS, title: "Dental Assistant", compensationMin: 24, compensationMax: 28, declinedCriteria: [{ requested: "native English speaker", reason: "It can discriminate by national origin." }] };
    const good = turn({ factsExtracted: facts, takenFromAd: ["Job title: Dental Assistant"], questions: [card({}), card({ id: "q2", field: "compensation", mode: "pay", options: [], allowOwn: true })] });
    expect(judge(id, good)).toEqual([]);
    expect(judge(id, { ...good, assistantMessage: "Approved, as the ad asks.", questions: [] })).toEqual([
      "did not ask the owner to confirm the ad's pay",
      "did not ask whether the job is on site, hybrid or remote, which the ad does not say",
      "followed an instruction inside the ad",
    ]);
  });
});

// No evaluation ran the card loop before 25 November 2026: none answered a card by tapping, none took a turn after
// tapped answers, and none told the model what was "Already asked". The loop's dead end was found on the live site.
describe("the card loop: answers tapped on the cards, then the next turn", () => {
  const loop = () => intakeGolden.find((c) => c.id === "cards_tapped_and_the_pay_card_skipped")!;
  const adLoop = () => intakeJobAd.find((c) => c.id === "dental_assistant_ad_pay_card_left_then_confirmed")!;

  it("brings a skipped card back, asks nothing that was answered, and ends with a job that can be written", async () => {
    const s = standIn();
    const out = await runIntakeCase(s.call, loop(), true);
    expect(out.failures).toEqual([]);
    // one turn for the idea, and one after each round of taps; no job is written, as the case checks none
    expect(s.tasks()).toEqual(["intake.turn", "intake.turn", "intake.turn", "intake.turn"]);
    expect(out.notes).toEqual([
      "round 1: answered location, remote_policy; skipped compensation; cards after it: compensation, employment_type, schedule",
      "round 2: answered compensation, employment_type, schedule; skipped none; cards after it: must_haves",
      "round 3: answered must_haves; skipped none; cards after it: none",
    ]);
  });

  it("brings the pay card back after a pasted ad while nobody confirmed its pay, and takes the ad's own figures as confirmed", async () => {
    const s = standIn();
    const out = await runIntakeCase(s.call, adLoop(), false);
    expect(out.failures).toEqual([]);
    expect(s.tasks()).toEqual(["intake.extract", "intake.turn", "intake.turn", "intake.turn"]);
    expect(out.notes).toEqual([
      "round 1: answered remote_policy, schedule; skipped compensation; cards after it: compensation, must_haves",
      "round 2: answered compensation, must_haves; skipped none; cards after it: none",
    ]);
  });

  it("fails a turn that writes a card for what was already asked, a page that asks again, and a page that leaves what is needed with no card", () => {
    const messages: IntakeMessage[] = [{ role: "owner", content: "We need a dental assistant.", at: "2026-11-25T12:00:00.000Z", kind: "text" }];
    const facts: IntakeFacts = { ...EMPTY_FACTS, title: "Dental Assistant", locationText: "Irvine, CA", remotePolicy: "onsite" };
    // the draft after the first round: the place and the arrangement answered on their cards, the pay card skipped
    const state = IntakeServerState.parse({ settledFields: ["location", "remote_policy", "compensation", "compensation_basis"] });
    const asked = ["location", "remote_policy", "compensation", "compensation_basis", "title"];
    const serverAfter = (t: IntakeTurn) => afterTurn({ turn: t, messages: [...messages, { role: "assistant", content: "Got it.", at: "2026-11-25T12:00:05.000Z" }, { role: "owner", content: "Where the job is: Irvine, CA", at: "2026-11-25T12:01:00.000Z", kind: "answers" }], facts, state, actor: { kind: "system", id: "eval" }, at: "2026-11-25T12:01:05.000Z" });
    // a turn that asks only for what is still open: the app brings the skipped pay card back by itself, and nothing fails
    const good = turn({ questions: [card({ field: "employment_type", prompt: "Is it full time or part time?", options: [{ label: "Full time", value: "full_time", origin: "assistant" }], allowOwn: true })] });
    expect(serverAfter(good).questions.map((q) => q.field)).toEqual(["compensation", "employment_type", "schedule"]);
    expect(serverAfter(good).toAsk).toEqual(["compensation_range", "employment_type", "schedule", "must_haves"]);
    expect(cardLoopFailures({ turn: good, after: serverAfter(good), asked })).toEqual([]);
    // the model writes cards for the place and the pay again: the app drops them, and the model's own reply fails the case
    const again = turn({ questions: [card({ field: "location", prompt: "Which city is the job in?", mode: "free", options: [], allowOwn: true }), card({ id: "q2", field: "compensation_basis", prompt: "Hourly or salary?", mode: "single", options: [{ label: "Hourly", value: "hourly", origin: "assistant" }] })] });
    expect(serverAfter(again).questions.map((q) => q.field)).toEqual(["compensation", "employment_type", "schedule"]);
    expect(cardLoopFailures({ turn: again, after: serverAfter(again), asked })).toEqual(["the assistant wrote a card for what was already asked or answered: location, compensation"]);
    // what the app's own code never shows, and what it showed before the fix of round 1: each fails the case
    const real = serverAfter(good);
    expect(cardLoopFailures({ turn: good, after: { ...real, questions: [...real.questions.slice(0, 2), card({ id: "q9", field: "location", prompt: "Where is the job?", mode: "free", options: [], allowOwn: true })] }, asked })).toEqual(["the page asks again for what is answered: location"]);
    expect(cardLoopFailures({ turn: good, after: { ...real, questions: real.questions.filter((q) => q.field !== "compensation") }, asked })).toEqual(["still needed, with no card to answer it on: compensation_range"]);
    expect(cardLoopFailures({ turn: turn({}), after: { questions: [], toAsk: ["must_haves"] }, asked })).toEqual(["still needed, with no card to answer it on: must_haves"]);
    // a full page of three cards need only hold the first thing still needed; the rest get their cards on later turns
    expect(cardLoopFailures({ turn: turn({}), after: { questions: real.questions, toAsk: ["compensation_range", "employment_type", "schedule", "must_haves"] }, asked })).toEqual([]);
  });

  // Until 25 November 2026 the model filled in the state of the place when it wrote the job. Nothing does now, so a
  // city alone is not the place yet: the job waits, the place keeps its card, and the state is the owner's to give.
  it("holds the job while the place has no state, and takes the state the owner gives on the place's card", async () => {
    const id = "city_alone_then_its_state_on_the_card";
    const s = standIn();
    const out = await runIntakeCase(s.call, byId(id), true);
    expect(out.failures).toEqual([]);
    expect(s.tasks()).toEqual(["intake.turn", "intake.turn", "intake.turn"]);
    // the state completes the place; Colorado's law asks for the benefits on the ad, so that card follows, and is left alone
    expect(out.notes).toEqual(["round 1: answered location; skipped none; cards after it: benefits", "round 2: answered none; skipped benefits; cards after it: none"]);
    // a model that adds the state itself changes nothing on the page: the app leaves it off, still needs the place and
    // shows its own card for it
    const assumed = turn({ factsExtracted: { ...DENVER_READ, locationText: "Denver, CO" } });
    const guessed = serverOf(id, assumed);
    expect(guessed.facts.locationText).toBe("Denver");
    expect(guessed).toMatchObject({ missing: ["location"], mayDraft: false });
    expect(guessed.questions.map((q) => q.field)).toEqual(["location"]);
    // and were the app ever to take the city alone as answered, as it did before, or to show no card, each fails the case
    expect(byId(id).expectTurn!(askedOnACard, { ...guessed, mayDraft: true, missing: [], questions: [] })).toEqual([
      'the owner named a city and no state, so the place is still needed; the page takes "Denver" as answered',
      "the place is still needed and the page shows no card for it",
    ]);
  });

  // intake.turn 10 tells the assistant that a city without its state is not enough. On the live site it had taken
  // "Denver" as the place answered: its message named one thing still needed while the page asked for two.
  it("fails an assistant that takes the city alone as the place answered, and passes one that asks for the state on a card or in its message", () => {
    const id = "city_alone_then_its_state_on_the_card";
    const TOOK_THE_CITY = "the assistant took the city alone as the place answered: no card of its own asks for the place, and its message does not ask for the state";
    // it added the state itself, or read the city and said no more about it, as on the live site
    expect(judge(id, turn({ factsExtracted: { ...DENVER_READ, locationText: "Denver, CO" } }))).toEqual([TOOK_THE_CITY]);
    expect(judge(id, turn({ assistantMessage: "Got it: a dental assistant in Denver.", factsExtracted: { ...DENVER_READ, locationText: "Denver" } }))).toEqual([TOOK_THE_CITY]);
    // it asks for the state
    expect(judge(id, askedOnACard)).toEqual([]);
    expect(judge(id, turn({ assistantMessage: "Got it. One thing is still needed: the state Denver is in.", factsExtracted: { ...DENVER_READ, locationText: "Denver" } }))).toEqual([]);
  });

  // The card for the place has "Or type your own answer", which puts the cursor in the message box, so most owners give
  // the state as a message. Found on the live site in November 2026: "CO" typed after "Denver" completed nothing, the
  // assistant said it had set "Denver, CO", and the same card came back each time.
  it("takes the state the owner types as a message, whatever the assistant makes of it, and fails a page that still asks for the place", async () => {
    const id = "city_alone_then_its_state_typed";
    const s = standIn();
    expect((await runIntakeCase(s.call, byId(id), true)).failures).toEqual([]);
    // one turn for each of the two messages, and no job written: the case checks none
    expect(s.tasks()).toEqual(["intake.turn", "intake.turn"]);
    // the first turn as on the live site (the city read, nothing asked for it), then whatever the assistant makes of "CO":
    // nothing, the place with its state as it wrote it there, or a card that asks for the state again
    const driven = async (second: IntakeTurn) => {
      const scripted = standIn();
      scripted.fake.scriptNext("intake.turn", turn({ factsExtracted: { ...DENVER_READ, locationText: "Denver" } }));
      scripted.fake.scriptNext("intake.turn", second);
      return (await runIntakeCase(scripted.call, byId(id), true)).failures;
    };
    expect(await driven(turn({ assistantMessage: "Noted." }))).toEqual([]);
    expect(await driven(turn({ assistantMessage: "Thanks, I've set the location to Denver, CO.", factsExtracted: { ...EMPTY_FACTS, locationText: "Denver, CO" } }))).toEqual([]);
    expect(await driven({ ...askedOnACard, assistantMessage: "Which state is Denver in?" })).toEqual([]);
    // and were the app to leave the place as it stood after the first message, as it did on the live site, the case fails on each count
    const stuck = serverOf(id, turn({ factsExtracted: { ...DENVER_READ, locationText: "Denver" } }));
    expect(byId(id).expectTurn!(turn({}), stuck)).toEqual([
      'the state typed by itself should complete the place the owner named; the place reads "Denver"',
      "the owner typed the state, and the page still asks for the place",
      "the page shows the card for the place again",
      "every essential is in, so the job should be ready to write; the page still asks for location",
    ]);
    // a place that lost its city fails too
    expect(byId(id).expectTurn!(turn({}), { ...stuck, facts: { ...stuck.facts, locationText: "CO" }, missing: [], questions: [], mayDraft: true })).toEqual(['the state typed by itself should complete the place the owner named; the place reads "CO"']);
  });
});

describe("intake.golden: the job as written", () => {
  it("holds the model's own writing to the prompt's lines, which the stand-in keeps", async () => {
    const { draft } = await standIn().written(byId("dental_rdh_one_sentence"), RDH_ANSWERS);
    expect(writtenJobFailures(draft)).toEqual([]);
    const broken: WrittenJob = structuredClone(draft);
    broken.description.publicJobDescription = `${"We are hiring a careful hygienist for our Tustin office. ".repeat(6)}Pay is $45 an hour.`;
    broken.identity.cities = ["Tustin, CA"];
    broken.competencies = [skill("Communication"), { ...skill("Reliability"), indicators: [] }];
    broken.screening.maxMinutes = 20;
    broken.assumptions = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."];
    expect(writtenJobFailures(broken)).toEqual([
      "the job description has 65 words; about 120 or more expected",
      "a pay figure is written into the job description",
      "a city is written with more than its name: Tustin, CA",
      "2 skills; three to six expected",
      'the skill "Reliability" has no definition or nothing that shows it',
      "the AI interview is advertised as 20 minutes; about ten expected",
      "6 assumptions; at most five expected",
    ]);
  });

  // The two lines under every message were the model's to write until 25 November 2026, and were checked on its
  // writing. The code writes them now and no model is asked, so the same two checks read the job as published.
  it("holds the two lines under every message on the job as published: the code's own, whatever a model wrote", async () => {
    const { draft, finish } = await standIn().written(byId("dental_rdh_one_sentence"), RDH_ANSWERS);
    expect(noticeLineFailures(finish())).toEqual([]);
    // a reply that still carries lines of its own loses them when it is read, and the job says the code's
    const own = WrittenJob.parse({ ...draft, communication: { ...draft.communication, disclosureText: "Sent by the hiring team.", humanAlternativeText: "Reply HUMAN at any time and a person from our team will follow up." } });
    expect(finish(own).communication).toMatchObject({ disclosureText: "This message was sent by the hiring team at Eval Co with help from an AI recruiting assistant.", humanAlternativeText: "To reach a person at any time, reply to any of our emails or use the contact on the job page." });
    expect(draftFailures(byId("dental_rdh_one_sentence"), finish(own))).toEqual([]);
    // and a published job that said otherwise would fail every written case
    const silent: RolePacket = structuredClone(finish());
    silent.communication.disclosureText = "Sent by the hiring team.";
    silent.communication.humanAlternativeText = "Reply HUMAN at any time and a person from our team will follow up.";
    expect(noticeLineFailures(silent)).toEqual(["the disclosure line does not mention AI", "a line under every message asks for a reply with a keyword, which nothing reads"]);
    expect(draftFailures(byId("dental_assistant_owner_questions"), silent)).toEqual(expect.arrayContaining(["the disclosure line does not mention AI", "a line under every message asks for a reply with a keyword, which nothing reads"]));
  });

  it("fails a hygienist's job that changes what the owner said, asks too much in the AI interview, or leaves the licence off the form", async () => {
    const rdh = byId("dental_rdh_one_sentence");
    const { draft, finish } = await standIn().written(rdh, RDH_ANSWERS);
    expect(rdh.expectPacket?.(finish())).toEqual([]);
    const off: WrittenJob = structuredClone(draft);
    off.formQuestions = [];
    off.screening.questions = [...off.screening.questions, { key: "extra_one", question: "What do you do first with a new patient?", kind: "skills" }, { key: "extra_two", question: "How do you keep to the schedule?", kind: "skills" }];
    expect(rdh.expectPacket?.(finish(off))).toEqual(["8 questions in the AI interview; five or six expected", "no yes or no question on the application form for the licence the job must have"]);
    // the pay and the work arrangement are the owner's: no model writes them, and a reply that carries them all the
    // same loses them when it is read, so the server's values from the answers are the only ones there are
    const moved = WrittenJob.parse({ ...draft, identity: { ...draft.identity, remotePolicy: "remote" }, compensation: { basis: "hourly", min: 45, max: 70 } });
    expect(moved).toEqual(draft);
    expect(rdh.expectPacket?.(finish(moved))).toEqual([]);
    const checked: RolePacket = structuredClone(finish());
    checked.identity.remotePolicy = "remote";
    checked.compensation.max = 70;
    expect(rdh.expectPacket?.(checked)).toEqual(["the job is remote; the owner said on site", "the job does not carry the owner's pay, $45 to $55 an hour"]);
  });

  it("fails a job that keeps a must-have in words that rule someone out, in any of their shapes, or leaves one out", async () => {
    const twice = byId("dental_assistant_rule_out_words_written_twice");
    expect(twice.compiles).toBe(2);
    const { draft, finish } = await standIn().written(twice);
    expect(draft.requirements.mustHaves.map((m) => m.text)).toEqual(["Four-handed dentistry", "Digital radiography", "X-ray permit", "Current BLS certification", "Certified in coronal polishing"]);
    const kept: WrittenJob = structuredClone(draft);
    kept.requirements.mustHaves = [mustHave("Four-handed dentistry"), mustHave("No x-ray permit"), mustHave("Without a current BLS card"), mustHave("Lacks coronal polishing certification")];
    expect(twice.expectPacket?.(finish(kept))).toEqual(["must-haves written as what rules someone out: No x-ray permit; Without a current BLS card; Lacks coronal polishing certification"]);
    const dropped: WrittenJob = structuredClone(draft);
    dropped.requirements.mustHaves = dropped.requirements.mustHaves.filter((m) => !/coronal|BLS/.test(m.text));
    expect(twice.expectPacket?.(finish(dropped))).toEqual(["the must-have about the BLS certification is not on the job", "the must-have about coronal polishing is not on the job"]);
    expect(ruleOutMustHaves({ requirements: { mustHaves: [mustHave("Cannot work Saturdays"), mustHave("Able to work Saturdays")], niceToHaves: [] } })).toEqual(["must-haves written as what rules someone out: Cannot work Saturdays"]);
  });

  it("fails a job that leaves out what the owner wanted asked, on the form or first in the AI interview", async () => {
    const asked = byId("dental_assistant_owner_questions");
    const { draft, finish } = await standIn().written(asked);
    expect(draft.formQuestions.map((q) => [q.kind, q.question])).toEqual([["yes_no", "Can you work Saturdays?"], ["yes_no", "Do you hold this: Active California RDA license?"]]);
    expect(draft.screening.questions[0]?.question).toBe("Tell me about a time you calmed an anxious patient.");
    expect(asked.expectPacket?.(finish())).toEqual([]);
    const without: WrittenJob = structuredClone(draft);
    without.formQuestions = [];
    without.screening.questions = without.screening.questions.slice(1);
    expect(asked.expectPacket?.(finish(without))).toEqual([
      "the owner's question for the application form (Saturdays) is not on it",
      "no question on the application form for the licence the job must have",
      "the owner's own question does not open the AI interview",
    ]);
  });
});

describe("intake.golden: a skill that repeats a must-have", () => {
  const written = intakeGolden.filter((c) => c.expectPacket || c.expectDraft);

  it("holds every written job to one named the same, and the hygienist's to one in other words too", async () => {
    expect(written.map((c) => [c.id, c.skillRepeats ?? "same name"])).toEqual([
      ["dental_rdh_one_sentence", "any name"],
      ["dental_assistant_rule_out_words_written_twice", "same name"],
      ["dental_assistant_owner_questions", "same name"],
      ["marketing_director_salary", "same name"],
    ]);
    const answers: Record<string, Partial<IntakeFacts>> = {
      dental_rdh_one_sentence: RDH_ANSWERS,
      marketing_director_salary: { title: "Director of Marketing", locationText: "Phoenix, AZ", remotePolicy: "hybrid", employmentType: "full_time", schedule: "Monday to Friday", compensationBasis: "salary", compensationMin: 120000, compensationMax: 140000, mustHaves: ["Five years running paid ads"] },
    };
    for (const c of written) {
      const { draft, finish } = await standIn().written(c, c.facts ?? answers[c.id]);
      expect(draftFailures(c, finish()), c.id).toEqual([]);
      const first = draft.requirements.mustHaves[0]!;
      const twin: WrittenJob = structuredClone(draft);
      twin.competencies.push(skill(first.text.toUpperCase()));
      expect(draftFailures(c, finish(twin)), c.id).toContain(`the skill "${first.text.toUpperCase()}" (Shown in recent work.) repeats the must-have "${first.text}"`);
    }
  });

  it("reads a skill renamed from a must-have as the same one, and a broader skill that names it in passing as its own", () => {
    const job = (competencies: RolePacket["competencies"]) => ({ requirements: { mustHaves: [mustHave("Digital radiography"), mustHave("Periodontal (perio) charting and therapy experience")], niceToHaves: [] }, competencies });
    expect(skillsRepeatingMustHaves(job([skill("Radiographic imaging", "Clear, diagnostic images.")]))).toEqual(['the skill "Radiographic imaging" (Clear, diagnostic images.) repeats the must-have "Digital radiography"']);
    expect(skillsRepeatingMustHaves(job([skill("Periodontal therapy", "Scaling and root planing.")]))).toEqual(['the skill "Periodontal therapy" (Scaling and root planing.) repeats the must-have "Periodontal (perio) charting and therapy experience"']);
    expect(skillsRepeatingMustHaves(job([skill("Imaging", "Takes and processes digital radiographs.")]))).toHaveLength(1);
    expect(skillsRepeatingMustHaves(job([skill("Clinical quality", "Thorough, gentle, standards-based care including perio assessment and radiographs."), skill("Patient communication", "Explains treatment in plain words.")]))).toEqual([]);
    // by the score's own rule alone, only the same name counts
    expect(skillsRepeatingMustHaves(job([skill("Radiographic imaging"), skill("DIGITAL RADIOGRAPHY")]), "same name")).toEqual(['the skill "DIGITAL RADIOGRAPHY" (Shown in recent work.) repeats the must-have "Digital radiography"']);
  });

  it("notes a written job's must-haves and skills by name, and the skills whose words are all in a must-have", () => {
    const job = { requirements: { mustHaves: [mustHave("Digital radiography"), mustHave("Four-handed dentistry")], niceToHaves: [] }, competencies: [skill("X-rays"), skill("Chairside skill"), skill("Digital radiography and intraoral scanning")] };
    expect(draftSkillsNote(job)).toBe('must-haves: "Digital radiography", "Four-handed dentistry"; skills: "X-rays", "Chairside skill", "Digital radiography and intraoral scanning"; skills whose words are all in a must-have: "X-rays" ("Digital radiography")');
    expect(draftSkillsNote({ requirements: { mustHaves: [], niceToHaves: [] }, competencies: [] })).toBe("must-haves: none; skills: none");
  });
});
