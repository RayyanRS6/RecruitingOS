import { describe, expect, it } from "vitest";
import type { ScreenTurn } from "@ros/contracts";
import { FakeProvider, callPrompt, screenTurnPrompt } from "@ros/ai";
import { chatPlanFor, registerFakeHandlers } from "@ros/agents";
import { CHAT_CV, CHAT_PACKET, chatCaseContext, chatCaseFailures, chatCaseNotes, chatCaseProgress, chatCaseReading, chatCases, runChatSuite, sharesFiveWords, shownAfterAnUnfairFollowUp } from "./chat-suite";

/**
 * The chat.* suites on the local stand-in model: every case passes, so the harness is sound; the real model
 * runs them from the runner. And the checks themselves catch what they are for: a turn that breaks a rule fails.
 */
describe("chat.* suites", () => {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  const run = async (ctx: Parameters<typeof screenTurnPrompt.system>[0]) => {
    const r = await callPrompt(rt, screenTurnPrompt, ctx, { companyId: null });
    return r.result.kind === "ok" ? r.result.output : null;
  };

  it("gives the model the plan and the CV's lines, as the app does, and not the form's answers", () => {
    const ctx = chatCaseContext(chatCases[0]);
    expect(ctx.chat.cv).toEqual(CHAT_CV);
    expect(ctx.chat.current).toBe("arduino");
    // the plan as the app builds it: the job's own questions, already asked here, then the must-haves the resume does not show
    expect(ctx.chat.items.map((i) => [i.key, i.kind, i.state])).toEqual([["wq_explain", "question", "covered"], ["wq_room", "question", "covered"], ["wq_transport", "question", "covered"], ["arduino", "gap", "asking"], ["english", "gap", "open"]]);
    const system = screenTurnPrompt.system(ctx).map((b) => b.text).join("\n");
    expect(system).toContain("Chat plan (JSON):");
    // what the form already settled is left out of the plan in code, so the model is told nothing of the form (the code
    // check of 25 November 2026: told "never ask again what the form asked", it passed over an item of the plan)
    expect(ctx.chat).not.toHaveProperty("formAnswers");
    for (const gone of ["form_answers", "Form answers", "application form"]) expect(system, gone).not.toContain(gone);
    expect(system).toContain("\n- Never ask about anything outside the plan.\n");
    expect(screenTurnPrompt.version).toBe(10);
    // the job description is the chat's context, as data
    expect(system).toContain("<job_description>\nYou teach robotics and AI classes");
    // never asks for what the candidate already said, above all in their last reply
    expect(system).toContain("Never ask for anything the candidate already said in this chat, above all in their last reply.");
    // doubt is only about what was already said: a must-have not plainly shown keeps its push, and an item already
    // answered in full gets a short check, never its own question again
    expect(system).toContain('a reply that does not plainly show a must-have ("I\'ve done some of that") is still "vague" and still gets its one push.');
    expect(system).toContain("when they already gave all of it, ask one short check about what they said (one detail of it), never the item's question again.");
    expect(system).toContain("but it must ask the same thing, or, when their earlier replies already gave part of it, only the part still missing (below).");
    expect(system).not.toContain("When in doubt between a push and moving on, move on.");
  });

  it("every case passes on the local stand-in", async () => {
    const results = await runChatSuite(run);
    const failed = Object.values(results).flatMap((s) => s.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.failures.join("; ")}`));
    expect(failed).toEqual([]);
    expect(Object.keys(results).sort()).toEqual(["chat.close", "chat.fairness", "chat.ladder", "chat.no_inference", "chat.no_reask", "chat.private_note", "chat.shape"]);
    expect(Object.values(results).every((s) => s.passRate === 1)).toBe(true);
    // the cases of the three suites that hold the code check of 25 November 2026
    expect(results["chat.ladder"]?.cases.map((c) => c.id)).toContain("certificate_no_is_taken");
    expect(results["chat.no_reask"]?.cases.map((c) => c.id)).toEqual(["form_answer_not_asked_again", "just_said_not_asked_again", "earlier_reply_not_asked_again"]);
    expect(results["chat.close"]?.cases.map((c) => c.id)).toEqual(["close_names_one_thing", "closing_question_only_after_every_item"]);
  });

  const turnBase: ScreenTurn = { messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
  const CERTIFICATE_ASK = "This is one of the things the job needs: Current first-aid certificate. Do you have it?";

  // Round 1's rule had no evaluation: a licence or a certificate the resume does not show is asked about once, as yes or
  // no, and "No" is taken. Nothing "similar" is asked, whatever the model does.
  it("a certificate the resume does not show is asked once, as yes or no, and 'No' is its answer: the case passes on the stand-in and fails a model that keeps asking", async () => {
    const c = chatCases.find((x) => x.id === "certificate_no_is_taken")!;
    const ctx = chatCaseContext(c);
    // the model is told the certificate has no ladder, and its question is the yes-or-no one; a skill keeps its ladder
    expect(ctx.chat.items.at(-1)).toMatchObject({ key: "first_aid", kind: "gap", state: "asking", ladder: false, question: CERTIFICATE_ASK });
    expect(c.transcript[0]?.content).toBe(CERTIFICATE_ASK);
    expect(chatCaseContext(chatCases[0]).chat.items.filter((i) => i.kind === "gap").map((i) => [i.key, i.ladder])).toEqual([["arduino", true], ["english", true]]);
    const own = await run(ctx);
    expect(own).toMatchObject({ questionKey: "wrap_up", followUpReason: null });
    expect(chatCaseFailures(c, own!)).toEqual([]);
    // a model that climbs the ladder all the same: the candidate is still asked nothing "similar" (the code moves on and
    // keeps the "No"), and the case says what the model did
    expect(chatCaseFailures(c, { ...turnBase, reading: "not_done", followUpReason: "the analog", messageToCandidate: "Not done that exactly? Tell me about something similar from your own work." })).toEqual([expect.stringMatching(/^the model kept asking after a plain "No" about a certificate: /)]);
    expect(chatCaseFailures(c, { ...turnBase, reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: 'You said "No".\n\nCould you tell me about one specific time?' })).toEqual([expect.stringMatching(/^the model kept asking after a plain "No" about a certificate: /)]);
  });

  // What the form settled is the plan's to leave out, in code; the model is not told what the form asked.
  it("what the form settled is left out of the plan by the app's own rules, and the case fails a model that asks about it all the same", async () => {
    const c = chatCases.find((x) => x.id === "form_answer_not_asked_again")!;
    // the reading the plan is built from, as the app's rules leave it: the two skills shown on the resume's own lines, and
    // the certificate not known on their "No" to the form's question (the licence rule: a lapsed one is not current either)
    expect(chatCaseReading(c).requirementFindings).toEqual([
      { requirementKey: "arduino", met: "yes", evidence: { source: "resume", quote: "Built and wired Arduino line-following robots for a school club" } },
      { requirementKey: "english", met: "yes", evidence: { source: "resume", quote: "Taught weekly technical workshops in English to first-year students" } },
      { requirementKey: "first_aid", met: "unknown", evidence: { source: "application", quote: "Do you hold a current first-aid certificate? No." } },
    ]);
    // so the plan is the job's own questions and nothing else; without the form's answers the same reading keeps the certificate
    expect(chatCaseProgress(c).chat?.items.map((i) => i.key)).toEqual(["wq_explain", "wq_room", "wq_transport"]);
    expect(chatPlanFor(CHAT_PACKET, chatCaseReading(c), "2026-10-15T10:00:00.000Z").items.map((i) => i.key)).toEqual(["wq_explain", "wq_room", "wq_transport", "first_aid"]);
    // the model is given the job's must-haves, the certificate among them, and nothing of the form
    const system = screenTurnPrompt.system(chatCaseContext(c)).map((b) => b.text).join("\n");
    expect(system).toContain("[first_aid] Current first-aid certificate");
    for (const gone of ["Do you hold a current first-aid certificate?", "fq_first_aid", "application form", "Form answers"]) expect(system, gone).not.toContain(gone);
    expect(chatCaseFailures(c, (await run(chatCaseContext(c)))!)).toEqual([]);
    // a model that names the closing question and asks about the certificate in its own words: the candidate would read it
    expect(chatCaseFailures(c, { ...turnBase, reading: "concrete", questionKey: "wrap_up", messageToCandidate: "You ride a motorbike.\n\nDo you hold a current first-aid certificate?" })).toEqual([
      expect.stringMatching(/^the model asks about the certificate, which is outside the plan: /),
      expect.stringMatching(/^asks again what the form asked: You ride a motorbike\.\n\nDo you hold a current first-aid certificate\?$/),
    ]);
  });

  // The plan is the code's: the closing question comes only once every item is asked. The turn is written in the case, so
  // the real-AI run checks the code here and pays for no model call.
  it("a turn that goes to the closing question with the certificate still open is put right, with no model call, and the case fails a turn left where the model put it", async () => {
    const c = chatCases.find((x) => x.id === "closing_question_only_after_every_item")!;
    expect(chatCaseProgress(c).chat?.items.map((i) => [i.key, i.state])).toEqual([["wq_explain", "covered"], ["wq_room", "covered"], ["wq_transport", "asking"], ["first_aid", "open"]]);
    expect(c.scripted).toMatchObject({ questionKey: "wrap_up", messageToCandidate: "You ride a motorbike and can reach any school in the city.\n\nMeerub, is there anything else you would like the hiring team to know before we finish?" });
    expect(chatCaseFailures(c, c.scripted!)).toEqual([]);
    const called: string[] = [];
    const results = await runChatSuite(async (ctx, x) => { called.push(x.id); return run(ctx); }, (s) => s === "chat.close");
    expect(called).toEqual(["close_names_one_thing"]);
    expect(results["chat.close"]?.cases).toEqual([{ id: "close_names_one_thing", pass: true, failures: [] }, { id: "closing_question_only_after_every_item", pass: true, failures: [] }]);
    // what the case says of a turn the code let through as the model wrote it
    const through = c.expect({ raw: c.scripted!, turn: { ...c.scripted!, answerRecorded: null }, move: { key: "wq_transport", move: "covered" }, plan: chatCaseProgress(c).chat });
    expect(through).toEqual(["went to wrap_up with the certificate still open", expect.stringMatching(/^not the restatement and then the open item's question in the job's words: /), "the plan does not say the certificate is being asked"]);
    // and a failing scripted case's notes say that no model wrote the turn
    expect(chatCaseNotes(c, c.scripted!).some((n) => n.startsWith("scripted turn (no model call): {"))).toBe(true);
  });

  it("catches a model that breaks the rules the code cannot fix", () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const bareYes = chatCases.find((c) => c.id === "bare_yes_gets_one_push")!;
    // moving on after a bare "yes" (the code accepts moving on early, so the bare "Yes" stands as the answer; the eval says the model did not push)
    expect(chatCaseFailures(bareYes, { ...base, questionKey: "english", reading: "concrete", messageToCandidate: "Noted." })).toEqual(expect.arrayContaining(["a bare yes did not get a push for specifics", "a bare yes was recorded as the answer"]));
    // a push: the code records nothing while it asks
    expect(chatCaseFailures(bareYes, { ...base, reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: "Could you tell me about one specific time: what you did, and what came of it?" })).toEqual([]);
    // a failing case says what the model did and what the code made of it (the answer on record is the code's)
    const notes = chatCaseNotes(bareYes, { ...base, questionKey: "english", reading: "concrete", messageToCandidate: "Noted." });
    expect(notes[0]).toBe("item: arduino (gap, step direct, pushes 0); prompt screen.turn v10");
    expect(notes.some((n) => n.startsWith("model: {") && n.includes('"reading":"concrete"') && !n.includes("answerRecorded"))).toBe(true);
    expect(notes.at(-1)).toBe("turn: move=covered questionKey=wrap_up recorded=arduino: Yes done=false | Is there anything else you would like the hiring team to know before we finish?");
    const analog = chatCases.find((c) => c.id === "no_gets_the_analog")!;
    expect(chatCaseFailures(analog, { ...base, questionKey: "wq_explain", reading: "concrete", messageToCandidate: "Fine." })).toContain("the model moved on instead of asking for something similar");
    const close = chatCases.find((c) => c.id === "close_names_one_thing")!;
    // a close with nothing but a question: the code keeps none of it, and the eval says so
    expect(chatCaseFailures(close, { ...base, done: true, messageToCandidate: "Anything else before we finish?" })).toContain("the close is empty");
    // a time promised in the close never reaches the candidate (the code leaves it out), so the case still passes
    expect(chatCaseFailures(close, { ...base, done: true, messageToCandidate: "Thank you, Meerub. You will hear back within a few days." })).toEqual([]);
    expect(sharesFiveWords("would you use a concrete everyday analogy and", "uses a concrete everyday analogy and checks understanding")).toBe(true);
    expect(sharesFiveWords("How would you explain a sensor?", "uses a concrete everyday analogy and checks understanding")).toBe(false);
  });

  // What the candidate already said is never asked again, while a correct move to the next item passes whatever its own
  // question asks ("what came of it", "how long"), and a thin must-have still gets its push
  it("tells asking again from moving on, and keeps the push on a thin must-have", () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const toEnglish = (messageToCandidate: string): ScreenTurn => ({ ...base, reading: "concrete", questionKey: "english", messageToCandidate });
    const justSaid = chatCases.find((c) => c.id === "just_said_not_asked_again")!;
    // moving on correctly: the restatement names the fault, the next item's question may say "what came of it" or "how long"
    expect(chatCaseFailures(justSaid, toEnglish("You traced the dropouts to a loose ground wire and resoldered it.\n\nTell me about one time you explained a technical idea in English to beginners: what did you do, and what came of it?"))).toEqual([]);
    expect(chatCaseFailures(justSaid, toEnglish("You traced the dropouts to a loose ground wire and resoldered it.\n\nHow long have you been explaining technical ideas in English, and to whom?"))).toEqual([]);
    // moving on, but asking about the fault again
    expect(chatCaseFailures(justSaid, toEnglish("You traced the dropouts to a loose ground wire.\n\nWhat was the cause of the dropouts?"))).toEqual([expect.stringMatching(/^asks again what was just said: /)]);
    // staying on the item to ask how they found it and the fix, which the reply already gave
    expect(chatCaseFailures(justSaid, { ...base, reading: "vague", followUpReason: "how they found it", messageToCandidate: "You mentioned the soil sensor readings dropping out.\n\nHow did you find the cause, and what did you do to fix it?" })).toEqual([
      expect.stringMatching(/^the model pushed for what the reply already gave: /),
      "a reply that covers the item should move on, got push",
      expect.stringMatching(/^asks again what was just said: /),
    ]);
    const earlier = chatCases.find((c) => c.id === "earlier_reply_not_asked_again")!;
    // no question of the model's: the code asks the item's own question word for word, which the reply already answered
    expect(chatCaseFailures(earlier, toEnglish("You built a soil-moisture pump on an Arduino."))).toEqual([expect.stringMatching(/^asks the next item again after the reply gave it: [\s\S]*from your own work\?$/)]);
    expect(chatCaseFailures(earlier, toEnglish("You ran a weekend robotics club for two years.\n\nHow long have you been explaining technical ideas in English?"))).toEqual([expect.stringMatching(/^asks the next item again after the reply gave it: /)]);
    // one short check on what they said passes
    expect(chatCaseFailures(earlier, toEnglish("You ran a weekend robotics club for two years, explaining technical ideas in English to beginners.\n\nWhat did the beginners find hardest to follow?"))).toEqual([]);
    // however it is worded, and whatever words the restatement uses (the code never swaps a short check for the item's question)
    expect(chatCaseFailures(earlier, toEnglish("You ran a weekend club for beginners for two years.\n\nHow did that go?"))).toEqual([]);
    expect(chatCaseFailures(earlier, toEnglish("You ran a weekend robotics club for two years, telling beginners a sensor is like a finger.\n\nWhat came of it?"))).toEqual([]);
    // a restatement that opens with a word like "Explained" is no request, so it is never read as asking
    expect(chatCaseFailures(justSaid, toEnglish("Explained the dropouts: a loose ground wire, resoldered.\n\nTell me about one time you explained a technical idea in English to beginners: what did you do, and what came of it?"))).toEqual([]);
    // a reply that names the must-have without showing it, taken as covered: the eval says the push was lost
    const thin = chatCases.find((c) => c.id === "thin_must_have_still_pushed")!;
    expect(chatCaseFailures(thin, toEnglish("You have done some Arduino work."))).toEqual(["a reply that names the must-have without showing it did not get its push", "expected one push, got covered", "a thin reply was recorded as a full answer"]);
  });

  // The "no question" check reads a request as the shaping does (`asksByRequest` from @ros/agents): "Think of a time…" and
  // a restatement that only looks like a request ask nothing. Here no item's question stands in, so the words are shown as written.
  it("fails a message with no question, and a request counts as one", () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const offPlan = { ...chatCases.find((c) => c.id === "bare_yes_gets_one_push")!, asking: "not_on_the_plan", expect: () => [] };
    const shown = (messageToCandidate: string) => chatCaseFailures(offPlan, { ...base, messageToCandidate });
    for (const none of ["Think of a time you made a mistake.", "Test, think of a time you made a mistake.", "Picture a class of twenty.", "Explained it as a thirsty finger.", "Described the fix to the team.", "Shared a list with the team.", "Tell users to restart.", "Give a warm welcome."]) expect(shown(none), none).toEqual([`no question: ${none}`]);
    for (const asks of ["Tell us about a time you made a mistake.", "Now, walk us through a mistake.", "Give an example of a mistake.", "Test, describe your last job.", "How did it go?"]) expect(shown(asks), asks).toEqual([]);
  });

  // screen.question_fairness reads this: the model's follow-up asks about a conviction, and the candidate is shown the
  // chat's next question in the job's own words instead
  it("never shows a follow-up that asks something unfair", () => {
    const shown = shownAfterAnUnfairFollowUp();
    expect(shown).not.toMatch(/convicted|crime/i);
    expect(shown).toBe(CHAT_PACKET.screening.questions.find((q) => q.key === "wq_transport")?.question);
  });

  // A failing case keeps its full record in the result file (the chat, the model's turn and the turn after the rules); a
  // passing case keeps nothing, and a failed call says why
  it("keeps the record of a failing case only", async () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const moveOn: ScreenTurn = { ...base, questionKey: "english", reading: "concrete", messageToCandidate: "Noted." };
    const results = await runChatSuite(async (ctx, c) => (c.id === "bare_yes_gets_one_push" ? moveOn : c.id === "restates_then_asks" ? "invalid: no valid output" : run(ctx)), (s) => s === "chat.ladder" || s === "chat.shape");
    const bareYes = results["chat.ladder"]?.cases.find((x) => x.id === "bare_yes_gets_one_push");
    expect(bareYes?.pass).toBe(false);
    expect(bareYes?.diagnostics?.transcript).toEqual([{ role: "assistant", text: expect.stringContaining("Hands-on Arduino"), questionKey: "arduino" }, { role: "candidate", text: "Yes" }]);
    expect(bareYes?.diagnostics?.turns).toEqual([
      {
        // the model's turn as it returned it: no record of an answer; the turn after the rules: what the code recorded
        model: { questionKey: "english", followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, reading: "concrete", message: "Noted." },
        afterRules: expect.objectContaining({ questionKey: "wrap_up", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: true }, message: "Is there anything else you would like the hiring team to know before we finish?" }),
        move: "covered",
      },
    ]);
    expect(results["chat.ladder"]?.cases.filter((x) => x.pass).every((x) => !x.diagnostics && !x.notes)).toBe(true);
    const failed = results["chat.shape"]?.cases.find((x) => x.id === "restates_then_asks");
    expect(failed?.failures).toEqual(["the model call failed: invalid: no valid output"]);
    expect(failed?.diagnostics?.turns).toBeUndefined();
    expect(failed?.diagnostics?.transcript).toHaveLength(2);
  });
});
