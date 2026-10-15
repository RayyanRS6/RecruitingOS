import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * "Questions every applicant answers" on the job's Scoring tab (Wave S7), as the server first draws it: the quick
 * questions on the form (the yes/no ones that may hold an application first, then the company's own), the written
 * questions the chat asks (the screening questions until the company sets its own), what a good answer shows marked as
 * for the team only, the fairness line, and the editor's rows. The editor's pure parts (the rows, the first problem in
 * plain words, the body the PUT takes, the server's refusals by row) are checked here too.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { ApplicantQuestions, QuestionsEditor } = await import("@ros/web/src/pages/role/ApplicantQuestions");
const aq = await import("@ros/web/src/pages/role/applicant-questions");
const { samplePacket } = await import("../../../packages/agents/src/fixtures/sample-packet");
type Packet = import("@ros/web/src/pages/role/applicant-questions").PacketWithQuestions;

const plain = samplePacket() as unknown as Packet;
const withQuestions = samplePacket((p) => {
  p.companyQuestions = {
    quick: [
      { kind: "choice", key: "cq_transport", question: "How will you get to work?", help: "We open at 7am.", required: true, options: ["My own car", "Public transport", "Bike or on foot"] },
      { kind: "choice", key: "cq_saturday", question: "Can you work one Saturday a month?", required: true, options: ["Yes", "No"] },
      { kind: "number", key: "cq_dentrix", question: "How many years have you used Dentrix?", required: false, unit: "years", min: 0, max: 40 },
    ],
    written: [{ key: "wq_calm", question: "Tell us about a time you calmed a nervous patient.", required: true, lookFor: "A real patient: what they noticed, what they did" }],
  };
}) as unknown as Packet;

function render(element: ReturnType<typeof createElement>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, element));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the questions card on the Scoring tab", () => {
  it("before the company sets any: the yes/no questions on the form, and the chat asking the screening questions", () => {
    const html = render(createElement(ApplicantQuestions, { roleId: "r1", packet: plain, editBase: { version: 3, packet: plain }, whoPosts: "its", onEditEligibility: () => undefined }));
    const t = text(html);
    expect(t).toContain("Questions every applicant answers");
    expect(t).toContain("Candidates are asked this");
    expect(t).toContain("Quick questions, on the application form");
    expect(t).toContain('Are you available Monday to Friday, 8 to 5? Yes or no A "no" holds it for your decision');
    expect(t).toContain("Written questions, asked in the chat");
    expect(t).toContain(aq.SCREENING_FALLBACK_LINE);
    for (const q of plain.screening.questions) expect(t).toContain(q.question);
    expect(t).toContain(aq.FAIRNESS_LINE);
    expect(t).toContain("Change these questions");
    expect(t).toContain("Change the yes/no questions that may hold an application");
  });

  it("with the company's own: each quick question with what may be answered, and the written ones with what a good answer shows, for the team only", () => {
    const t = text(render(createElement(ApplicantQuestions, { roleId: "r1", packet: withQuestions, editBase: null, whoPosts: "its" })));
    expect(t).toContain("How will you get to work? Choose one: My own car · Public transport · Bike or on foot");
    expect(t).toContain("We open at 7am.");
    expect(t).toContain("Can you work one Saturday a month? Yes or no");
    expect(t).toContain("How many years have you used Dentrix? A number, in years, 0 to 40 They may skip it");
    expect(t).toContain("Tell us about a time you calmed a nervous patient.");
    expect(t).toContain("What a good answer shows (only your team sees this): A real patient: what they noticed, what they did");
    expect(t).not.toContain(aq.SCREENING_FALLBACK_LINE);
    // the screening questions are not listed as asked in the chat any more
    expect(t).not.toContain("Which days and hours are you available?");
    // someone who may not change the job is offered nothing to press
    expect(t).not.toContain("Change these questions");
    expect(t).not.toContain("Change the yes/no questions");
  });

  it("the editor: a row per question, with its kind, its answers, whether it must be answered, and the fairness line", () => {
    const t = text(render(createElement(QuestionsEditor, { roleId: "r1", baseVersion: 3, packet: withQuestions, whoPosts: "its", onDone: () => undefined })));
    expect(t).toContain("Quick questions, on the application form (up to 8)");
    expect(t).toContain("Written questions, asked in the chat (up to 5)");
    expect(t).toContain("1. Question");
    expect(t).toContain("Answered with");
    expect(t).toContain("The answers to choose from, one a line (2 to 8)");
    expect(t).toContain("Unit (optional)");
    expect(t).toContain("What a good answer shows (only your team sees this)");
    expect(t).toContain("Every applicant must answer it");
    expect(t).toContain("Add a quick question");
    expect(t).toContain("Add a written question");
    expect(t).toContain(aq.FAIRNESS_LINE);
    expect(t).toContain("Save as a new version");
    // started from the screening questions when the company has none of its own, said so
    expect(text(render(createElement(QuestionsEditor, { roleId: "r1", baseVersion: 3, packet: plain, whoPosts: "its", onDone: () => undefined })))).toContain(aq.SCREENING_FALLBACK_LINE);
  });
});

describe("the questions editor's rows", () => {
  it("reads the packet into rows: Yes and No read as a yes-or-no question; the screening questions start the written list, as new ones", () => {
    const quick = aq.quickRowsFrom(withQuestions);
    expect(quick.map((r) => r.kind)).toEqual(["choice", "yes_no", "number"]);
    expect(quick[2]).toMatchObject({ key: "cq_dentrix", unit: "years", min: "0", max: "40", required: false });
    expect(aq.writtenRowsFrom(withQuestions)).toEqual([{ key: "wq_calm", question: "Tell us about a time you calmed a nervous patient.", lookFor: "A real patient: what they noticed, what they did", required: true }]);
    expect(aq.writtenRowsFrom(plain).map((r) => r.key)).toEqual(plain.screening.questions.map(() => null));
    expect(aq.writtenSource(plain)).toBe("screening");
    expect(aq.writtenSource(withQuestions)).toBe("company");
    expect(aq.quickRowsFrom(plain)).toEqual([]);
  });

  it("changing the kind keeps the words; yes or no fills its two answers", () => {
    const row = { ...aq.newQuickRow("choice"), question: "Which shift?", options: "Morning\nEvening" };
    expect(aq.withKind(row, "yes_no")).toMatchObject({ question: "Which shift?", options: "Yes\nNo" });
    expect(aq.withKind(aq.withKind(row, "yes_no"), "choice").options).toBe("");
    expect(aq.withKind(row, "number")).toMatchObject({ question: "Which shift?", options: "Morning\nEvening" });
  });

  it("says the first thing wrong in plain words; empty rows are dropped, not counted", () => {
    const ok = aq.quickRowsFrom(withQuestions);
    expect(aq.questionsProblem(ok, aq.writtenRowsFrom(withQuestions))).toBeNull();
    expect(aq.questionsProblem([...ok, aq.newQuickRow()], [])).toBeNull();
    expect(aq.questionsProblem([{ ...aq.newQuickRow("choice"), question: "Which shift?", options: "Morning\nmorning" }], [])).toBe("Quick question 1: give between 2 and 8 different answers to choose from, one a line.");
    expect(aq.questionsProblem([{ ...aq.newQuickRow("number"), question: "How many years?", min: "5", max: "1" }], [])).toBe("Quick question 1: the smallest number is above the largest.");
    expect(aq.questionsProblem([{ ...aq.newQuickRow("number"), question: "How many years?", min: "five" }], [])).toBe("Quick question 1: the smallest and largest numbers must be numbers.");
    expect(aq.questionsProblem([{ ...aq.newQuickRow(), question: "Car?" }, { ...aq.newQuickRow(), question: "car?" }], [])).toBe("Quick question 2 is the same as an earlier one.");
    expect(aq.questionsProblem(Array.from({ length: 9 }, (_, i) => ({ ...aq.newQuickRow(), question: `Question number ${i}` })), [])).toBe("Keep at most 8 quick questions.");
    expect(aq.questionsProblem([], aq.writtenRowsFrom(samplePacket((p) => { p.screening.questions = [...p.screening.questions, ...p.screening.questions.map((q) => ({ ...q, key: `${q.key}_2`, question: `${q.question} Again.` }))]; }) as unknown as Packet))).toBe("Keep at most 5 written questions.");
    expect(aq.questionsProblem([], [{ ...aq.newWrittenRow(), question: "Why?" }])).toBe("Written question 1: write the question.");
  });

  it("sends only the lists that were changed, yes or no as a choice of Yes and No, numbers as numbers", () => {
    const quick = [...aq.quickRowsFrom(withQuestions), { ...aq.newQuickRow("number"), question: " Patients a day? ", min: "", max: "1,000" }, aq.newQuickRow()];
    const body = aq.questionsPayload({ baseVersion: 4, quick, written: aq.writtenRowsFrom(plain), quickChanged: true, writtenChanged: false });
    expect(body).toEqual({
      baseVersion: 4,
      quick: [
        { kind: "choice", key: "cq_transport", question: "How will you get to work?", help: "We open at 7am.", required: true, options: ["My own car", "Public transport", "Bike or on foot"] },
        { kind: "choice", key: "cq_saturday", question: "Can you work one Saturday a month?", required: true, options: ["Yes", "No"] },
        { kind: "number", key: "cq_dentrix", question: "How many years have you used Dentrix?", required: false, unit: "years", min: 0, max: 40 },
        { kind: "number", question: "Patients a day?", required: true, max: 1000 },
      ],
    });
    // opening the editor on a job without its own written questions and saving the quick ones never sends the screening questions
    expect(body.written).toBeUndefined();
    const both = aq.questionsPayload({ baseVersion: 4, quick: [], written: [{ key: null, question: "Tell us about your last job.", lookFor: " ", required: false }], quickChanged: true, writtenChanged: true });
    expect(both).toEqual({ baseVersion: 4, quick: [], written: [{ question: "Tell us about your last job.", required: false }] });
  });

  it("puts each of the server's refusals beside its row, counting rows as they were sent", () => {
    const quick = [aq.newQuickRow(), { ...aq.newQuickRow("choice"), question: "Which describes you?", options: "Male\nFemale" }];
    const written = [{ ...aq.newWrittenRow(), question: "Tell us about your last job." }, { ...aq.newWrittenRow(), question: "Do you have children?" }];
    const details = { problems: [
      { list: "quick", index: 0, key: null, part: "option", rule: "asks_trait_option", text: "Male", reason: "An answer names a protected characteristic.", alternative: "Ask only about the work.", words: "" },
      { list: "quick", index: 0, key: null, part: "option", rule: "asks_trait_option", text: "Female", reason: "Again.", alternative: "Again.", words: "" },
      { list: "written", index: 1, key: null, part: "question", rule: "asks_family", text: "Do you have children", reason: "Not about family.", alternative: "Ask about the schedule.", words: "" },
      { list: "nowhere", index: 0 },
    ] };
    const byRow = aq.refusalsByRow(details, { quick, written });
    expect([...byRow.entries()]).toEqual([["quick:1", "An answer names a protected characteristic. Ask only about the work."], ["written:1", "Not about family. Ask about the schedule."]]);
    expect(aq.refusalsByRow(null, { quick, written }).size).toBe(0);
  });

  it("reads what may be answered in a few words", () => {
    const [transport, saturday, dentrix] = withQuestions.companyQuestions?.quick ?? [];
    expect(aq.quickAnswerWords(transport)).toBe("Choose one: My own car · Public transport · Bike or on foot");
    expect(aq.quickAnswerWords(saturday)).toBe("Yes or no");
    expect(aq.quickAnswerWords(dentrix)).toBe("A number, in years, 0 to 40");
    expect(aq.quickAnswerWords({ kind: "number", key: "cq_n", question: "How many?", required: true, min: 1 })).toBe("A number, at least 1");
  });
});
