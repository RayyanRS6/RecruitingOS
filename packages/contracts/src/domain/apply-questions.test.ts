import { describe, expect, it } from "vitest";
import { CHAT_WRAP_KEY, CHAT_WRAP_QUESTION, ChatItem, FORM_QUESTION_KIND_LABEL, FormAnswers, FormQuestion, answerKeyWords, formAnswerView, formAnswerViews, formQuestionsOfStored } from "./apply-questions";

const yesNo = FormQuestion.parse({ kind: "yes_no", key: "license", question: "Do you hold an active RDA license?" });
const choice = FormQuestion.parse({ kind: "choice", key: "shift", question: "Which shift do you prefer?", options: ["Morning", "Afternoon"] });
const number = FormQuestion.parse({ kind: "number", key: "years", question: "Years of chairside experience?", unit: "years", required: false });

describe("the application form's questions", () => {
  it("are of three kinds, yes or no, a choice or a number, and never a written one", () => {
    expect(Object.keys(FORM_QUESTION_KIND_LABEL)).toEqual(["yes_no", "choice", "number"]);
    expect(yesNo).toEqual({ kind: "yes_no", key: "license", question: "Do you hold an active RDA license?", required: true });
    expect(FormQuestion.safeParse({ kind: "written", key: "why", question: "Why this job?" }).success).toBe(false);
    expect(FormQuestion.safeParse({ kind: "choice", key: "one", question: "Pick one", options: ["Only"] }).success).toBe(false);
    expect(FormQuestion.safeParse({ kind: "days", key: "days", question: "Which days?" }).success).toBe(false);
  });

  it("take the answers by question key, as short words", () => {
    expect(FormAnswers.parse({ license: "yes", shift: "Morning", years: "6" })).toEqual({ license: "yes", shift: "Morning", years: "6" });
    expect(FormAnswers.safeParse({ license: "x".repeat(201) }).success).toBe(false);
  });
});

describe("a screening answer as the team reads it", () => {
  it("flags a No to a yes/no question, and only that", () => {
    expect(formAnswerView(yesNo, "no")).toEqual({ key: "license", question: "Do you hold an active RDA license?", kind: "yes_no", answer: "No", flagged: true, flag: "Answered No: Do you hold an active RDA license?" });
    expect(formAnswerView(yesNo, "yes")).toEqual({ key: "license", question: "Do you hold an active RDA license?", kind: "yes_no", answer: "Yes", flagged: false, flag: null });
    for (const no of [false, "No", " NO ", "n", "false", "0"]) expect(formAnswerView(yesNo, no), String(no)).toMatchObject({ answer: "No", flagged: true });
    for (const yes of [true, "Yes", "y", "TRUE", "1"]) expect(formAnswerView(yesNo, yes), String(yes)).toMatchObject({ answer: "Yes", flagged: false });
  });

  it("never reads a missing answer, a choice or a number as a no", () => {
    for (const none of [undefined, null, "", "   ", []]) expect(formAnswerView(yesNo, none)).toMatchObject({ answer: null, flagged: false, flag: null });
    expect(formAnswerView(choice, "Afternoon")).toMatchObject({ kind: "choice", answer: "Afternoon", flagged: false });
    expect(formAnswerView(choice, "No")).toMatchObject({ answer: "No", flagged: false, flag: null });
    expect(formAnswerView(number, "0")).toMatchObject({ kind: "number", answer: "0 years", flagged: false });
    expect(formAnswerView(number, 6)).toMatchObject({ answer: "6 years" });
    expect(formAnswerView(number, undefined)).toMatchObject({ answer: null });
  });

  it("shows an answer an older form stored as a list of days as its words", () => {
    expect(formAnswerView(yesNo, ["Mon", "Sat"])).toMatchObject({ answer: "Mon, Sat", flagged: false, flag: null });
  });

  it("lists every question in the form's order, answered or not", () => {
    expect(formAnswerViews([yesNo, choice, number], { shift: "Morning", license: "no" }).map((a) => [a.key, a.answer, a.flagged])).toEqual([["license", "No", true], ["shift", "Morning", false], ["years", null, false]]);
    expect(formAnswerViews([yesNo], null)).toEqual([{ key: "license", question: "Do you hold an active RDA license?", kind: "yes_no", answer: null, flagged: false, flag: null }]);
  });
});

describe("the form's questions of a job version stored before there was one list", () => {
  it("are its yes/no questions and then the company's choice and number questions", () => {
    const out = formQuestionsOfStored({
      requirements: { eligibility: [{ key: "auth", type: "work_authorization", question: "Are you authorized to work in the U.S.?", rationale: "The law asks", knockout: true, expectation: {} }, { key: "", question: "no key" }, "junk", { key: "days", type: "schedule_availability", question: "Which days can you work?", expectation: { days: ["Sat"] } }] },
      companyQuestions: { quick: [{ kind: "choice", key: "cq_shift", question: "Shift?", options: ["AM", "PM"] }], written: [{ key: "wq_1", question: "Why us?" }] },
    });
    expect(out).toEqual([
      { kind: "yes_no", key: "auth", question: "Are you authorized to work in the U.S.?", help: "The law asks", required: true },
      { kind: "yes_no", key: "days", question: "Which days can you work?", required: false },
      { kind: "choice", key: "cq_shift", question: "Shift?", options: ["AM", "PM"] },
    ]);
    expect(formQuestionsOfStored({})).toEqual([]);
    expect(formQuestionsOfStored({ requirements: null, companyQuestions: "x" })).toEqual([]);
  });
});

describe("the AI interview's plan", () => {
  it("holds the job's own questions and the must-haves the CV did not show, and no written question", () => {
    expect(ChatItem.parse({ key: "sq_1", kind: "question", required: true })).toEqual({ key: "sq_1", kind: "question", required: true, state: "open", step: "direct", pushes: 0 });
    expect(ChatItem.parse({ key: "mh_1_rda", kind: "gap" }).required).toBe(false);
    expect(ChatItem.safeParse({ key: "wq_1", kind: "written" }).success).toBe(false);
  });

  it("names an answer by its question, never by a key", () => {
    expect(answerKeyWords(CHAT_WRAP_KEY)).toBe(CHAT_WRAP_QUESTION);
    expect(answerKeyWords("mh_1_rda", [{ key: "mh_1_rda", text: " Active RDA license " }])).toBe("Active RDA license");
    expect(answerKeyWords("sq_shift_swaps")).toBe("Shift swaps");
    expect(answerKeyWords("mh_2_x_ray")).toBe("X ray");
    expect(answerKeyWords("pay")).toBe("Pay");
  });
});
