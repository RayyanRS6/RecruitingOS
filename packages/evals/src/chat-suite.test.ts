import { describe, expect, it } from "vitest";
import type { ScreenTurn } from "@ros/contracts";
import { FakeProvider, callPrompt, screenTurnPrompt } from "@ros/ai";
import { registerFakeHandlers } from "@ros/agents";
import { CHAT_FACTS, chatCaseContext, chatCaseFailures, chatCaseNotes, chatCases, runChatSuite, sharesFiveWords } from "./chat-suite";

/**
 * The chat.* suites (Wave S7) on the local stand-in model: every case passes, so the harness is sound; the real model
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

  it("gives the model the plan, the CV and the form's answers, as the app does", () => {
    const ctx = chatCaseContext(chatCases[0]);
    expect(ctx.chat?.formAnswers).toEqual(CHAT_FACTS.formAnswers);
    expect(ctx.chat?.cv).toEqual(CHAT_FACTS.cv);
    expect(ctx.chat?.current).toBe("arduino");
    const system = screenTurnPrompt.system(ctx).map((b) => b.text).join("\n");
    expect(system).toContain("Chat plan (JSON):");
    expect(system).toContain("<form_answers>\nForm answers (already given; never ask them again):\nDo you have your own laptop for teaching? Yes.\n</form_answers>");
    expect(screenTurnPrompt.version).toBe(7);
  });

  it("every case passes on the local stand-in", async () => {
    const results = await runChatSuite(run);
    const failed = Object.values(results).flatMap((s) => s.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.failures.join("; ")}`));
    expect(failed).toEqual([]);
    expect(Object.keys(results).sort()).toEqual(["chat.close", "chat.fairness", "chat.ladder", "chat.no_inference", "chat.no_reask", "chat.private_note", "chat.shape"]);
    expect(Object.values(results).every((s) => s.passRate === 1)).toBe(true);
  });

  it("catches a model that breaks the rules the code cannot fix", () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const bareYes = chatCases.find((c) => c.id === "bare_yes_gets_one_push")!;
    // moving on after a bare "yes" (the code accepts moving on early; the eval says the model did not push)
    expect(chatCaseFailures(bareYes, { ...base, questionKey: "english", reading: "concrete", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: true }, messageToCandidate: "Noted." })).toEqual(expect.arrayContaining(["a bare yes did not get a push for specifics", "a bare yes was recorded as the answer"]));
    // a push that carries the bare "Yes" as its answer (the real model, run 38753792054): the code records nothing while it asks
    expect(chatCaseFailures(bareYes, { ...base, reading: "vague", followUpReason: "nothing specific yet", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: false }, messageToCandidate: "Could you tell me about one specific time: what you did, and what came of it?" })).toEqual([]);
    // a failing case says what the model did and what the code made of it (Wave S9)
    const notes = chatCaseNotes(bareYes, { ...base, questionKey: "english", reading: "concrete", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: true }, messageToCandidate: "Noted." });
    expect(notes[0]).toBe("item: arduino (gap, step direct, pushes 0); prompt screen.turn v7");
    expect(notes.some((n) => n.startsWith("model: {") && n.includes('"answer":"Yes"'))).toBe(true);
    expect(notes.at(-1)).toBe("turn: move=covered questionKey=wq_explain recorded=arduino: Yes done=false | How would you explain what a sensor is to six-year-olds?");
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

  // Wave S9: a failing case keeps its full record in the result file (the chat, the model's turn and the turn after the
  // rules); a passing case keeps nothing, and a failed call says why
  it("keeps the record of a failing case only", async () => {
    const base: ScreenTurn = { messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
    const moveOn: ScreenTurn = { ...base, questionKey: "english", reading: "concrete", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: true }, messageToCandidate: "Noted." };
    const results = await runChatSuite(async (ctx, c) => (c.id === "bare_yes_gets_one_push" ? moveOn : c.id === "restates_then_asks" ? "invalid: no valid output" : run(ctx)), (s) => s === "chat.ladder" || s === "chat.shape");
    const bareYes = results["chat.ladder"]?.cases.find((x) => x.id === "bare_yes_gets_one_push");
    expect(bareYes?.pass).toBe(false);
    expect(bareYes?.diagnostics?.transcript).toEqual([{ role: "assistant", text: expect.stringContaining("Hands-on Arduino"), questionKey: "arduino" }, { role: "candidate", text: "Yes" }]);
    expect(bareYes?.diagnostics?.turns).toEqual([
      {
        model: { questionKey: "english", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: true }, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, reading: "concrete", message: "Noted." },
        afterRules: expect.objectContaining({ questionKey: "wq_explain", answerRecorded: expect.objectContaining({ questionKey: "arduino", answer: "Yes" }), message: "How would you explain what a sensor is to six-year-olds?" }),
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
