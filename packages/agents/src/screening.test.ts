import { describe, expect, it } from "vitest";
import type { RolePacket, ScreenProgress, ScreenTurn } from "@ros/contracts";
import { EMPTY_SCREEN_PROGRESS, WITHDRAW_CONFIRM_KEY, advanceProgress, enforceTurnRules, screenCommand, withdrawPending } from "./screening";

/**
 * The follow-up cap (docs/05; docs/spec/21 section 7, P0 row "follow-up cap test"): whatever the model says, a question
 * gets at most two follow-ups. The third follow-up becomes the next packet question, or the close when nothing is
 * left. These are the code-side rules the real model is held to.
 */
const packet = { screening: { questions: [{ key: "experience", question: "Tell me about your most recent work.", kind: "skills" }, { key: "availability", question: "Which days and hours are you available?", kind: "availability" }], maxMinutes: 15 } } as unknown as RolePacket;
const followUp: ScreenTurn = { messageToCandidate: "Could you say a bit more about that?", questionKey: null, answerRecorded: null, followUpReason: "answer too short", candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };
const asking = (key: string, followUps: Record<string, number> = {}, askedKeys = [key]): ScreenProgress => ({ ...EMPTY_SCREEN_PROGRESS, askedKeys, currentQuestionKey: key, followUps });

describe("enforceTurnRules: the follow-up cap", () => {
  it("under the cap a follow-up passes through unchanged and is counted", () => {
    const t = enforceTurnRules(followUp, packet, asking("experience", { experience: 1 }), {});
    expect(t).toEqual(followUp);
    const p = advanceProgress(asking("experience", { experience: 1 }), t);
    expect(p.followUps.experience).toBe(2);
    expect(p.currentQuestionKey).toBe("experience");
  });

  it("at the cap the follow-up is replaced by the next question, said plainly", () => {
    const progress = asking("experience", { experience: 2 });
    const t = enforceTurnRules(followUp, packet, progress, {});
    expect(t.questionKey).toBe("availability");
    expect(t.followUpReason).toBeNull();
    expect(t.messageToCandidate).toBe("Thanks, that helps. Next: Which days and hours are you available?");
    expect(t.done).toBe(false);
    // an empty stand-in answer is never recorded
    expect(t.answerRecorded).toBeNull();
    const p = advanceProgress(progress, t);
    expect(p.currentQuestionKey).toBe("availability");
    expect(p.askedKeys).toEqual(["experience", "availability"]);
    expect(p.followUps.experience).toBe(2);
  });

  it("at the cap with nothing left to ask the conversation closes politely", () => {
    const progress = asking("availability", { availability: 2 }, ["experience", "availability"]);
    const t = enforceTurnRules(followUp, packet, progress, { experience: "Six years in a family practice." });
    expect(t.done).toBe(true);
    expect(t.questionKey).toBeNull();
    expect(t.followUpReason).toBeNull();
    expect(t.messageToCandidate).toMatch(/that is everything I needed/);
    expect(t.messageToCandidate).toMatch(/HUMAN/);
    expect(advanceProgress(progress, t).currentQuestionKey).toBeNull();
  });

  it("three follow-ups in a row on one question: two are asked, the third moves on", () => {
    let progress = asking("experience");
    const turns: ScreenTurn[] = [];
    for (let i = 0; i < 3; i++) {
      const t = enforceTurnRules(followUp, packet, progress, {});
      progress = advanceProgress(progress, t);
      turns.push(t);
    }
    expect(turns.slice(0, 2).every((t) => t.followUpReason && !t.questionKey)).toBe(true);
    expect(turns[2].messageToCandidate).toMatch(/^Thanks, that helps\. Next: /);
    expect(turns[2].questionKey).toBe("availability");
    expect(progress.followUps.experience).toBe(2);
    expect(progress.currentQuestionKey).toBe("availability");
  });

  it("a hand-off or a close is never treated as a follow-up, and unknown question keys are dropped", () => {
    const human = { ...followUp, humanRequested: true, messageToCandidate: "A person will follow up. We are available on business days." };
    expect(enforceTurnRules(human, packet, asking("experience", { experience: 2 }), {}).humanRequested).toBe(true);
    expect(enforceTurnRules(human, packet, asking("experience", { experience: 2 }), {}).questionKey).toBeNull();
    const stray = { ...followUp, followUpReason: null, questionKey: "not_in_packet", answerRecorded: { questionKey: "not_in_packet", answer: "x", complete: true } };
    const t = enforceTurnRules(stray, packet, asking("experience"), {});
    expect(t.questionKey).toBeNull();
    expect(t.answerRecorded).toBeNull();
  });
});

/**
 * The keyword commands (Wave 0 item 0.7): only a message that is the command itself counts, so an answer that happens to
 * start with one of the words is recorded as an answer; WITHDRAW asks first, and the reply to that question decides.
 */
describe("screenCommand: whole-message keywords", () => {
  it("an answer that starts with a keyword is an answer", () => {
    expect(screenCommand("Representative at a phone store for two years")).toBeNull();
    expect(screenCommand("Withdraw cash from the till at closing and count the drawer")).toBeNull();
    expect(screenCommand("Agent for a travel company, 2019 to 2022")).toBeNull();
    expect(screenCommand("Person-centred care is how I work")).toBeNull();
    expect(screenCommand("Yes")).toBeNull(); // nothing is pending: an ordinary answer
  });

  it("the command alone, in any case, with a full stop or an exclamation mark, is the command", () => {
    for (const m of ["HUMAN", "human", " Human. ", "person!", "Agent", "representative", "a person"]) expect(screenCommand(m), m).toBe("human");
    expect(screenCommand("Could I talk to a real person about the schedule?")).toBe("human");
    expect(screenCommand("I'd rather speak with a human")).toBe("human");
    for (const m of ["WITHDRAW", "withdraw.", "Withdraw my application"]) expect(screenCommand(m), m).toBe("withdraw");
  });

  it("while a withdrawal waits, CONFIRM or YES confirms it, NO keeps the application, anything else is an answer", () => {
    for (const m of ["CONFIRM", "yes", "Y", "withdraw"]) expect(screenCommand(m, true), m).toBe("confirm_withdraw");
    for (const m of ["no", "No.", "keep", "keep going", "Keep my application"]) expect(screenCommand(m, true), m).toBe("keep_application");
    expect(screenCommand("Sorry, I meant I have worked weekends for three years", true)).toBeNull();
    expect(screenCommand("HUMAN", true)).toBe("human");
  });

  it("a withdrawal is pending only while the latest assistant message is the question", () => {
    const at = "2026-10-07T10:00:00.000Z";
    const asked = [{ role: "assistant" as const, content: "First question", at }, { role: "candidate" as const, content: "WITHDRAW", at }, { role: "assistant" as const, content: "Do you want to withdraw?", at, questionKey: WITHDRAW_CONFIRM_KEY }];
    expect(withdrawPending(asked)).toBe(true);
    expect(withdrawPending([...asked, { role: "candidate" as const, content: "hmm", at }])).toBe(true);
    expect(withdrawPending([...asked, { role: "candidate" as const, content: "no", at }, { role: "assistant" as const, content: "No problem.", at }])).toBe(false);
    expect(withdrawPending([])).toBe(false);
  });
});
