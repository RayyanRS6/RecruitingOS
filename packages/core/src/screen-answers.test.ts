import { describe, expect, it } from "vitest";
import { ScreenStatus, type ScreenProgress } from "@ros/contracts";
import { screenAnswersSent, storedScreenWords, withoutCandidateWords } from "./screen-answers";

describe("what a candidate said in an AI interview", () => {
  it("is the team's to read only once the candidate sent it", () => {
    expect(screenAnswersSent({ status: "completed" })).toBe(true);
    for (const status of ScreenStatus.options.filter((s) => s !== "completed")) expect(screenAnswersSent({ status }), status).toBe(false);
  });

  it("is all in a copy of their data: the answers by question, and what an older row keeps in its progress", () => {
    expect(storedScreenWords({ answers: { q_explain: "I draw it on the whiteboard." }, progress: { askedKeys: ["q_explain"], currentQuestionKey: null } })).toEqual({ answers: { q_explain: "I draw it on the whiteboard." }, openingQuestions: [], writtenUp: [] });
    const older = storedScreenWords({
      answers: { license: "Yes, CA RDH 12345" },
      progress: {
        focusQuestions: [{ key: "unknown_1", question: "Is your license active?", whyItMatters: "Must-have", answer: "Yes, since 2019" }, { key: "unknown_2", question: "Which software do you chart in?" }, "not a question"],
        writeup: { answers: [{ key: "license", answer: "Holds an active CA RDH license." }] },
      },
    });
    expect(older.answers).toEqual({ unknown_1: "Yes, since 2019", license: "Yes, CA RDH 12345" });
    expect(older.openingQuestions).toEqual([{ key: "unknown_1", question: "Is your license active?" }, { key: "unknown_2", question: "Which software do you chart in?" }]);
    expect(older.writtenUp).toEqual([{ key: "license", answer: "Holds an active CA RDH license." }]);
    expect(storedScreenWords({ answers: {}, progress: null })).toEqual({ answers: {}, openingQuestions: [], writtenUp: [] });
  });

  it("is gone from the progress after an anonymization, which keeps only where the chat stood", () => {
    const plan = { v: 1 as const, section: "required" as const, items: [{ key: "q_explain", kind: "question" as const, required: true, state: "covered" as const, step: "direct" as const, pushes: 0 }], current: null, builtAt: "2026-11-18T10:00:00.000Z" };
    const stored = {
      askedKeys: ["q_explain", "wrap_up"], currentQuestionKey: null, followUps: { q_explain: 1 }, confusedTurns: 1, failures: 0,
      phase: "review", declined: ["q_room"], edits: { q_explain: 1 }, submittedAt: "2026-11-18T11:00:00.000Z", countedAt: "2026-11-18T10:05:00.000Z", chat: plan,
      typedFacts: { cv: ["Taught robotics at Lincoln Middle School, 2021 to 2024"], formAnswers: ["Can you work Saturdays? Yes."] },
      // what a row stored by an earlier version of the chat may still carry
      focusQuestions: [{ key: "unknown_1", question: "Is your license active?", answer: "Yes, since 2019" }],
      writeup: { answers: [{ key: "license", answer: "Holds an active CA RDH license." }] },
    } as ScreenProgress;
    const kept = withoutCandidateWords(stored);
    expect(kept).toEqual({
      askedKeys: ["q_explain", "wrap_up"], currentQuestionKey: null, followUps: { q_explain: 1 }, confusedTurns: 1, failures: 0,
      phase: "review", declined: ["q_room"], edits: { q_explain: 1 }, submittedAt: "2026-11-18T11:00:00.000Z", countedAt: "2026-11-18T10:05:00.000Z", chat: plan,
    });
    for (const words of ["Lincoln", "Saturdays", "since 2019", "RDH"]) expect(JSON.stringify(kept), words).not.toContain(words);
    // a bare row keeps its shape
    expect(withoutCandidateWords({} as ScreenProgress)).toEqual({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 });
  });
});
