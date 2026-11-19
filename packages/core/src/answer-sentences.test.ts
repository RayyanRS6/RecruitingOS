import { describe, expect, it } from "vitest";
import type { FormQuestion } from "@ros/contracts";
import { answerSentence, formAnswerSentences, formAnswersOf } from "./answer-sentences";

const questions: FormQuestion[] = [
  { kind: "yes_no", key: "rdh_license", question: "Do you hold an active CA RDH license?", required: true },
  { kind: "choice", key: "transport", question: "How will you get to work?", options: ["Own car", "Public transport", "Other"], required: true },
  { kind: "number", key: "years", question: "How many years have you worked as a hygienist", unit: "years", required: false },
  { kind: "yes_no", key: "saturdays", question: "Can you work Saturdays?", required: false },
];

describe("the form's answers as plain sentences", () => {
  it("the question as asked and the answer given, for every answered question in the form's order; nothing for one left empty", () => {
    expect(formAnswerSentences(questions, { saturdays: "no", years: "6", rdh_license: "yes", transport: "Own car" })).toEqual([
      { key: "rdh_license", sentence: "Do you hold an active CA RDH license? Yes." },
      { key: "transport", sentence: "How will you get to work? Own car." },
      { key: "years", sentence: "How many years have you worked as a hygienist: 6 years." },
      { key: "saturdays", sentence: "Can you work Saturdays? No." },
    ]);
    expect(formAnswerSentences(questions, { rdh_license: "no", transport: " ", other: "not a question of this form" })).toEqual([{ key: "rdh_license", sentence: "Do you hold an active CA RDH license? No." }]);
    expect(formAnswerSentences(questions, null)).toEqual([]);
    expect(answerSentence("Licence number", "RDH 12345")).toBe("Licence number: RDH 12345.");
    expect(answerSentence(" Anything else? ", " No thanks! ")).toBe("Anything else? No thanks!");
  });

  it("reads the answers of an application from an older form from where it kept them, and the new form's over them", () => {
    expect(formAnswersOf({ form: { rdh_license: "yes" } })).toEqual({ rdh_license: "yes" });
    expect(formAnswersOf({ eligibility: { rdh_license: "yes", schedule: ["Sat", "Sun"] }, quick: { transport: "Own car" } })).toEqual({ rdh_license: "yes", schedule: ["Sat", "Sun"], transport: "Own car" });
    expect(formAnswersOf({ eligibility: { rdh_license: "no" }, form: { rdh_license: "yes" } })).toEqual({ rdh_license: "yes" });
    expect(formAnswersOf(null)).toEqual({});
    // a list of days an older form stored is read as its words
    expect(formAnswerSentences([{ kind: "yes_no", key: "schedule", question: "Which days can you work?", required: false }], formAnswersOf({ eligibility: { schedule: ["Sat", "Sun"] } }))).toEqual([{ key: "schedule", sentence: "Which days can you work? Sat, Sun." }]);
  });
});
