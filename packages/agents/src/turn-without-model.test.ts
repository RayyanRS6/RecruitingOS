import { describe, expect, it } from "vitest";
import type { RolePacket, ScreenProgress, ScreenTranscriptEntry } from "@ros/contracts";
import { CHAT_CALM_LINE, EMPTY_SCREEN_PROGRESS, PERSON_OFFER, turnWithoutModel } from "./screening";

/**
 * A turn of the AI interview with no model, when the company's AI help is used up. The candidate is never stuck and
 * never told: what they typed is the answer, the next question comes in the job's own words, and it ends on the same
 * screen as ever. Only a reply that is no answer stays on the question.
 */
const Q1 = { key: "q1", question: "What did you do at your last job?", kind: "behavioral" };
const Q2 = { key: "q2", question: "Which software have you used?", kind: "skills" };
/** The chat's own packet (`chatPacket`): its questions, and the job's must-haves (the first item, as a must-have, is `q1`). */
const packetWith = (mustHave: string) => ({ screening: { questions: [Q1, Q2], maxMinutes: 10 }, requirements: { mustHaves: [{ key: "q1", text: mustHave }], niceToHaves: [] } }) as unknown as RolePacket;
const packet = packetWith("Front desk experience");
const at = "2026-11-05T10:00:00.000Z";
const plan = (kind: "gap" | "question"): NonNullable<ScreenProgress["chat"]> => ({ v: 1, section: kind === "gap" ? "experience" : "required", items: [{ key: "q1", kind, required: kind === "question", state: "asking", step: "direct", pushes: 0 }, { key: "q2", kind: "question", required: true, state: "open", step: "direct", pushes: 0 }], current: "q1", builtAt: at });
const progress = (over: Partial<ScreenProgress> = {}): ScreenProgress => ({ ...EMPTY_SCREEN_PROGRESS, askedKeys: ["q1"], currentQuestionKey: "q1", chat: plan("question"), ...over });
const asked = (key: string): ScreenTranscriptEntry => ({ role: "assistant", content: `Asked ${key}`, at, questionKey: key });
const said = (content: string): ScreenTranscriptEntry => ({ role: "candidate", content, at });
const turn = (latest: string, over: { progress?: ScreenProgress; transcript?: ScreenTranscriptEntry[]; answers?: Record<string, string> } = {}) =>
  turnWithoutModel({ packet, progress: over.progress ?? progress(), answers: over.answers ?? {}, transcript: over.transcript ?? [asked("q1"), said(latest)], latest });

describe("a turn with no model", () => {
  it("takes what they typed as the answer and asks the next question in the job's own words, after a plain Thanks", () => {
    const r = turn("I ran the front desk.")!;
    expect(r.turn).toMatchObject({ answerRecorded: { questionKey: "q1", answer: "I ran the front desk.", complete: true }, questionKey: "q2", done: false, humanRequested: false });
    expect(r.turn.messageToCandidate).toBe(`Thanks.\n\n${Q2.question}`);
    expect(r.move).toEqual({ key: "q1", move: "covered" });
  });

  it("never says their words back: the lead is the same whatever they typed", () => {
    const r = turn("I earned $900 a week and hated my boss.")!;
    expect(r.turn.messageToCandidate).toBe(`Thanks.\n\n${Q2.question}`);
    expect(r.turn.messageToCandidate).not.toContain("hated");
  });

  it("keeps every usable reply since the question was asked: an answer begun with the model is not lost", () => {
    const transcript = [asked("q1"), said("I ran the front desk."), { role: "assistant" as const, content: "Tell me more.", at }, said("For five years.")];
    expect(turn("For five years.", { transcript })!.turn.answerRecorded?.answer).toBe("I ran the front desk. For five years.");
  });

  it("a reply that only asks something or only shows confusion is no answer: the question again, with how to choose a person", () => {
    for (const latest of ["What does it pay?", "Ok. What are the hours?", "What do you mean?", "???", "I don't understand"]) {
      const r = turn(latest)!;
      expect(r.turn.answerRecorded, latest).toBeNull();
      expect(r.turn.questionKey, latest).toBeNull();
      expect(r.turn.done, latest).toBe(false);
      expect(r.turn.messageToCandidate, latest).toBe(`${Q1.question}\n\n${PERSON_OFFER}`);
      expect(r.move, latest).toBeNull();
    }
    // an answer with a question in it keeps the answer, without the question
    expect(turn("I ran the front desk. What does it pay?")!.turn.answerRecorded?.answer).toBe("I ran the front desk.");
  });

  it("a question of theirs after an answer stays on the question and keeps the answer for when it settles", () => {
    const transcript = [asked("q1"), said("I ran the front desk."), said("What does it pay?")];
    const stays = turn("What does it pay?", { transcript })!;
    expect(stays.turn.answerRecorded).toBeNull();
    expect(stays.turn.questionKey).toBeNull();
    const then = [...transcript, said("For five years.")];
    expect(turn("For five years.", { transcript: then })!.turn.answerRecorded?.answer).toBe("I ran the front desk. For five years.");
  });

  it("the last question ends the questions, in the words the model's turn would end on", () => {
    const r = turn("Dentrix and Eaglesoft.", { progress: progress({ askedKeys: ["q1", "q2"], currentQuestionKey: "q2" }), answers: { q1: "I ran the front desk." }, transcript: [asked("q2"), said("Dentrix and Eaglesoft.")] })!;
    expect(r.turn).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: "q2", answer: "Dentrix and Eaglesoft." } });
  });

  it("with nothing being asked it says so, and the caller ends the chat as at the cap", () => {
    expect(turn("Hello?", { progress: progress({ currentQuestionKey: null }) })).toBeNull();
    expect(turn("Hello?", { progress: progress({ currentQuestionKey: "gone" }) })).toBeNull();
  });

  it("a plain No about a must-have records nothing and settles it as not known, as its ladder does in the end: never a no for a skill", () => {
    const r = turn("No, I haven't.", { progress: progress({ chat: plan("gap") }) })!;
    expect(r.turn.answerRecorded).toBeNull();
    expect(r.move).toEqual({ key: "q1", move: "unknown" });
    expect(r.turn.messageToCandidate).toBe(`${CHAT_CALM_LINE}\n\n${Q2.question}`);
    // a No with something in it is an answer
    expect(turn("No, but at my last job I did something like it.", { progress: progress({ chat: plan("gap") }) })!.turn.answerRecorded?.answer).toBe("No, but at my last job I did something like it.");
    // and a plain No to one of the job's own questions is its answer
    expect(turn("No.")!.turn.answerRecorded?.answer).toBe("No.");
  });

  it("a plain No about a licence the job needs is its answer, as with the model: recorded, and the next question follows a plain Thanks", () => {
    const transcript = [asked("q1"), said("No, I haven't.")];
    const r = turnWithoutModel({ packet: packetWith("Active CA RDH license"), progress: progress({ chat: plan("gap") }), answers: {}, transcript, latest: "No, I haven't." })!;
    expect(r.turn.answerRecorded).toEqual({ questionKey: "q1", answer: "No, I haven't.", complete: true });
    expect(r.move).toEqual({ key: "q1", move: "covered" });
    expect(r.turn.messageToCandidate).toBe(`Thanks.\n\n${Q2.question}`);
  });
});
