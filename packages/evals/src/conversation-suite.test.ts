import { describe, expect, it } from "vitest";
import { CHAT_WRAP_KEY, type RolePacket, type ScreenTurn } from "@ros/contracts";
import { FakeProvider, callPrompt, intakeCompilePrompt, screenTurnPrompt, type ScreenContext } from "@ros/ai";
import { PERSON_OFFER, chatNextLine, finalizePacket, registerFakeHandlers } from "@ros/agents";
import { personas, runConversation, runConversationSuite, withPayQuestion, withoutLicenceQuestions } from "./conversation-suite";
import { intakeContextOf } from "./intake-run";
import { COOPERATIVE_PAY, RDH_FACTS } from "./suites";

/**
 * screen.conversation on the local stand-in model: every persona passes, so the harness is sound (the real model runs
 * them from the runner), and the checks catch what they are for: a turn that breaks a rule the code cannot fix fails.
 */
describe("screen.conversation", () => {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  const run = async (ctx: ScreenContext): Promise<ScreenTurn | string> => {
    const r = await callPrompt(rt, screenTurnPrompt, ctx, { companyId: null });
    return r.result.kind === "ok" ? r.result.output : "no valid output";
  };
  /** The golden job, written by the stand-in as the runner has it written. */
  const goldenJob = async () => {
    const { ctx } = intakeContextOf({ vertical: "dental" }, RDH_FACTS, [{ role: "owner", content: "I need a dental hygienist in Irvine.", at: "2026-11-18T10:00:00.000Z" }]);
    const r = await callPrompt(rt, intakeCompilePrompt, ctx, { companyId: null });
    if (r.result.kind !== "ok") throw new Error("the stand-in wrote no job");
    return finalizePacket(r.result.output, ctx, { sessionId: "eval", aiRunId: "run" });
  };
  const persona = (id: string) => personas.find((p) => p.id === id)!;

  it("every persona passes on the local stand-in", async () => {
    const { cases, passRate } = await runConversationSuite(await goldenJob(), run);
    expect(cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.failures.join("; ")}`)).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(["cooperative", "asks_for_a_person", "asks_about_pay", "volunteers_protected_information", "pushes_once_on_their_own_words", "never_follows_up_on_protected", "distressed", "pay_answer_recorded", "confused", "licence_not_on_the_resume"]);
    expect(passRate).toBe(1);
    // a passing persona keeps no record
    expect(cases.every((c) => !c.notes && !c.diagnostics)).toBe(true);
  });

  // A job as the real models write it asks about the work only. The stand-in's job always has a pay question, so only
  // a job without one can tell: the pay persona is given an owner's pay question, first, and its answer is recorded.
  it("gives the pay persona a job that asks about pay when the job as written does not", async () => {
    const job = await goldenJob();
    expect(withPayQuestion(job)).toBe(job);
    const workOnly: RolePacket = { ...job, screening: { ...job.screening, questions: job.screening.questions.filter((q) => q.kind !== "compensation") } };
    const asked = withPayQuestion(workOnly);
    expect(asked.screening.questions[0]).toEqual({ key: "owner_pay", question: "What hourly range are you looking for?", kind: "compensation" });
    expect(asked.screening.questions.slice(1)).toEqual(workOnly.screening.questions);
    const { conversation, failed } = await runConversation(persona("pay_answer_recorded"), asked, run);
    expect(failed).toBeNull();
    expect(conversation.answers.owner_pay).toBe(COOPERATIVE_PAY);
    const { cases } = await runConversationSuite(workOnly, run);
    expect(cases.find((c) => c.id === "pay_answer_recorded")).toMatchObject({ pass: true, failures: [] });
  });

  it("drives a chat as the app does: the first question in code, the job's questions, the must-have the CV did not show, the closing question, the close", async () => {
    const job = await goldenJob();
    const { conversation: c, failed } = await runConversation(persona("cooperative"), job, run);
    expect(failed).toBeNull();
    expect(c.done).toBe(true);
    // the job's licence is shown on the CV, so the chat asks about the other must-have only
    const [licence, perio] = job.requirements.mustHaves.map((m) => m.key);
    expect(c.questions.map((q) => q.key)).toEqual([...job.screening.questions.map((q) => q.key), perio, CHAT_WRAP_KEY]);
    expect(c.questions.map((q) => q.key)).not.toContain(licence);
    // one reply to each, none asked twice, and an answer under each question's own key
    expect(c.turns.map((t) => t.asking)).toEqual(c.questions.map((q) => q.key));
    expect(Object.keys(c.answers).sort()).toEqual(c.questions.map((q) => q.key).sort());
    expect(c.answers[job.screening.questions.find((q) => q.kind === "compensation")?.key ?? ""]).toBe(COOPERATIVE_PAY);
    // the first message is written in code and asks the job's first question word for word
    expect(c.transcript[0]).toMatchObject({ role: "assistant", source: "system", questionKey: job.screening.questions[0]?.key });
    expect(c.transcript[0]?.content.endsWith(job.screening.questions[0]?.question ?? "?")).toBe(true);
    // and the last says what happens next
    expect(c.transcript.at(-1)?.content.endsWith(chatNextLine("Eval Dental"))).toBe(true);
  });

  // Round 1's rule had no evaluation over a whole chat (the code check of 25 November 2026): a licence the resume does not
  // show is asked about once, as yes or no, "No" is taken, and nothing "similar" is asked.
  it("asks about a licence the resume does not show once, as yes or no, and takes 'No'; a model that climbs the ladder is named, while the candidate is still asked nothing similar", async () => {
    const golden = await goldenJob();
    const p = persona("licence_not_on_the_resume");
    // Their job asks about the licence in the must-have only. The stand-in's job also asks about it in a question of its
    // own, which is left out for them: asked twice, the second ask is a check on the first answer, and a "No" to it
    // can be read either way.
    expect(p.job).toBe(withoutLicenceQuestions);
    const job = withoutLicenceQuestions(golden);
    expect(golden.screening.questions.filter((q) => /license/i.test(q.question)).map((q) => q.key)).toEqual(["must_have"]);
    expect(job.screening.questions).toEqual(golden.screening.questions.filter((q) => q.key !== "must_have"));
    expect(job.requirements).toBe(golden.requirements);
    expect(withoutLicenceQuestions(job)).toBe(job);
    const [licence = "", perio = ""] = job.requirements.mustHaves.map((m) => m.key);
    const { conversation: c, failed } = await runConversation(p, job, run);
    expect(failed).toBeNull();
    // the plan: the job's own questions, then both must-haves (their resume shows neither), then the closing question
    expect(c.questions.map((q) => q.key)).toEqual([...job.screening.questions.map((q) => q.key), licence, perio, CHAT_WRAP_KEY]);
    expect(c.questions.find((q) => q.key === licence)?.question).toBe(`This is one of the things the job needs: ${job.requirements.mustHaves[0]?.text}. Do you have it?`);
    // they answered each of the job's questions, then "No" about the licence, and stopped there
    expect(c.turns.map((t) => t.asking)).toEqual([...job.screening.questions.map((q) => q.key), licence]);
    expect(c.turns.at(-1)).toMatchObject({ said: "No", asking: licence, stayed: false });
    expect(c.answers[licence]).toBe("No");
    // the chat went on to the next thing in its plan, the other must-have, asked from their own work
    expect(c.progress.currentQuestionKey).toBe(perio);
    expect(c.turns.at(-1)?.shown).toMatch(/What can you tell me about it from your own work\?$/);
    expect(p.expect(c)).toEqual([]);
    // a model that asks for "something similar" after the No: the code moves on all the same and keeps the No, and the
    // persona says what the model did
    const climbs = await runConversation(p, job, async (ctx) => {
      const turn = await run(ctx);
      return typeof turn === "string" || ctx.progress.currentQuestionKey !== licence ? turn : { ...turn, questionKey: null, reading: "not_done" as const, followUpReason: "the analog", messageToCandidate: "Not done that exactly? Tell me about something similar from your own work." };
    });
    expect(p.expect(climbs.conversation)).toEqual([expect.stringMatching(/^the model kept asking after a plain "No" about the licence: /)]);
    expect(climbs.conversation.turns.at(-1)?.shown).not.toMatch(/similar/);
    expect(climbs.conversation.answers[licence]).toBe("No");
    // the cooperative candidate's resume shows the licence: their chat never asks about it
    const shown = await runConversation(persona("cooperative"), job, run);
    expect(shown.conversation.questions.map((q) => q.key)).not.toContain(licence);
    // on the job as written the chat would ask about the licence twice: the persona says so, and judges nothing else
    const twice = await runConversation(p, golden, run);
    expect(p.expect(twice.conversation)).toEqual(["the job asks about the licence in a question of its own too, so this chat asks twice: This job needs: Active CA RDH license. Tell me about your experience with that."]);
  });

  // The persona's own setup must not be what fails on a real model. What the model is told of their resume names no
  // licence and no licensed title, so a "No" about it contradicts nothing; and a model that words the question "Can you
  // tell me whether you hold …?" still asks yes or no, where "Could you tell me about your licence?" asks for an account.
  it("gives the model a resume with no licence on it for that persona, and reads 'Can you tell me whether you hold it?' as a yes-or-no question", async () => {
    const job = withoutLicenceQuestions(await goldenJob());
    const [licence = ""] = job.requirements.mustHaves.map((m) => m.key);
    const p = persona("licence_not_on_the_resume");
    const seen: ScreenContext[] = [];
    const { conversation: c } = await runConversation(p, job, async (ctx) => {
      seen.push(ctx);
      return run(ctx);
    });
    expect(seen).toHaveLength(c.turns.length);
    for (const ctx of seen) expect(ctx.chat.cv).toEqual(["Dental assistant at Harbor Dental (2019 to now)", "Skills: Dentrix, chairside assisting"]);
    expect(c.transcript[0]?.content.startsWith("Hi Alex. Your resume shows your work as Dental assistant at Harbor Dental (2019 to now).\n\n")).toBe(true);
    // every other persona's resume shows the licence, as the reading their plan is built from found
    const others: ScreenContext[] = [];
    await runConversation(persona("cooperative"), job, async (ctx) => {
      others.push(ctx);
      return run(ctx);
    });
    expect(others[0]?.chat.cv[0]).toBe("Registered Dental Hygienist at Harbor Dental (2019 to now)");
    // the model's own wording of the licence question, as the candidate is shown it
    const asksAs = (question: string) => runConversation(p, job, async (ctx) => {
      const turn = await run(ctx);
      return typeof turn === "string" || turn.questionKey !== licence ? turn : { ...turn, messageToCandidate: `You see nine patients a day.\n\n${question}` };
    });
    const whether = await asksAs("Can you tell me whether you hold an active California RDH license?");
    expect(whether.conversation.transcript.find((t) => t.role === "assistant" && t.questionKey === licence)?.content).toMatch(/\n\nCan you tell me whether you hold an active California RDH license\?$/);
    expect(p.expect(whether.conversation)).toEqual([]);
    const account = await asksAs("Could you tell me about your RDH license?");
    expect(p.expect(account.conversation)).toEqual(["the licence was not asked as one yes-or-no question: Could you tell me about your RDH license?"]);
  });

  it("catches a model that does not read a request for a person, and one that closes on it", async () => {
    const job = await goldenJob();
    // the model moves on as if the request were an answer
    const deaf = await runConversation(persona("asks_for_a_person"), job, async (ctx) => {
      const turn = await run(ctx);
      return typeof turn === "string" ? turn : { ...turn, humanRequested: false };
    });
    expect(persona("asks_for_a_person").expect(deaf.conversation)).toEqual(expect.arrayContaining(["the model did not read that they would rather have a person", expect.stringMatching(/^they were not shown how to choose a person: /)]));
    // the model reads it: the code shows how to choose a person and closes nothing, whatever else the model's turn said
    const closing = await runConversation(persona("asks_for_a_person"), job, async (ctx) => {
      const turn = await run(ctx);
      return typeof turn === "string" || !turn.humanRequested ? turn : { ...turn, done: true, questionKey: CHAT_WRAP_KEY };
    });
    expect(persona("asks_for_a_person").expect(closing.conversation)).toEqual([]);
    expect(closing.conversation.turns.at(-1)?.shown).toContain(PERSON_OFFER);
  });

  it("catches a model that takes up what the candidate volunteered about themselves", async () => {
    const job = await goldenJob();
    const { conversation } = await runConversation(persona("never_follows_up_on_protected"), job, async (ctx) => {
      const turn = await run(ctx);
      return typeof turn === "string" ? turn : { ...turn, messageToCandidate: "At 52 you have seen a lot." };
    });
    expect(persona("never_follows_up_on_protected").expect(conversation)).toEqual(["the assistant raised the candidate's age"]);
  });

  it("says why a model call failed, and keeps the record of a failing persona", async () => {
    const job = await goldenJob();
    const { cases } = await runConversationSuite(job, async (ctx, p) => (p.id === "confused" ? "invalid: no valid output" : p.id === "asks_about_pay" ? { messageToCandidate: "We pay well.", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false } : run(ctx)));
    const confused = cases.find((c) => c.id === "confused");
    expect(confused?.failures).toEqual(["the model call failed: invalid: no valid output"]);
    const pay = cases.find((c) => c.id === "asks_about_pay");
    expect(pay?.pass).toBe(false);
    expect(pay?.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^the pay was not answered with the posted range: /), "the model did not read it as a question about pay"]));
    expect(pay?.notes?.[0]).toMatch(/^questions: /);
    expect(pay?.diagnostics?.transcript?.[0]).toMatchObject({ role: "assistant" });
    expect(pay?.diagnostics?.turns?.length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.pass).every((c) => !c.notes && !c.diagnostics)).toBe(true);
  });
});
