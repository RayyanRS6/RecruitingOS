import { describe, expect, it } from "vitest";
import { CHAT_WRAP_KEY, CHAT_WRAP_QUESTION, type EvidenceAssessment, type RolePacket, type ScreenAssessment, type ScreeningQuestion, type ScreenProgress, type ScreenTranscriptEntry, type ScreenTurn } from "@ros/contracts";
import type { RunOutcome } from "@ros/ai";
import { chatCounter, tapFormatFor } from "@ros/core";
import { SAMPLE_QUESTIONS } from "./fixtures/sample-questions";
import { unfairQuestion } from "./fair-question";
import {
  CHAT_CALM_LINE, CHAT_LADDER_QUESTION, EMPTY_SCREEN_PROGRESS, PERSON_OFFER, SCORECARD_READINGS, WITHDRAW_CONFIRM_KEY, advanceProgress, askedQuestions, asksByRequest, candidateWordsOf, chatClosingMessage, chatCodeLead, chatGaps, chatNextLine, chatOpening, chatPacket, chatPlanFor, chatPromptOf, currentTapFormat, enforceChatTurn, formAnswersSent, gapQuestion,
  nextQuestion, redactProtected, reviewItems, saidByCandidate, scorecardOutcome, scorecardReadings, screenCommand, screenIntro, tapWords, withdrawPending, yesNoFormAnswers,
} from "./screening";

/**
 * The AI interview's rules in code: what the chat asks and in which order, what each turn of the model is held to, what
 * the candidate checks before sending, and what the scorecard may rest on. The scenario test
 * (tests/scenario/hiring.test.ts) walks the whole interview on the stand-in AI.
 */
const hygienist = {
  identity: { title: "Registered Dental Hygienist" },
  compensation: { basis: "hourly", currency: "USD", min: 45, max: 55 },
  requirements: { mustHaves: [{ key: "mh_license", text: "Active CA RDH license" }, { key: "mh_perio", text: "Periodontal charting" }, { key: "mh_xray", text: "Digital x-rays" }, { key: "mh_dentrix", text: "Dentrix" }, { key: "mh_nitrous", text: "Nitrous monitoring" }, { key: "mh_permit", text: "Local anesthesia permit" }], niceToHaves: [] },
  screening: { questions: [{ key: "license", question: "Is your RDH license active in California?", kind: "eligibility" }, { key: "experience", question: "Tell me about your most recent work.", kind: "skills", modelAnswer: "names the practice and what they did day to day" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 },
  communication: { humanAlternativeText: "Reply to reach a person.", disclosureText: "Sent with help from an AI assistant." },
} as unknown as RolePacket;
const startedAt = "2026-11-18T10:00:00.000Z";
/** A resume reading that found these must-haves shown on a checked quote, and `others` as given. */
const readingOf = (shown: string[], others: Array<{ requirementKey: string; met: string; evidence?: unknown }> = []) => ({ requirementFindings: [...shown.map((requirementKey) => ({ requirementKey, met: "yes", evidence: { source: "resume", quote: "as the resume says" } })), ...others] }) as unknown as Pick<EvidenceAssessment, "requirementFindings">;

describe("what an AI interview asks", () => {
  it("the job's interview questions, then up to four must-haves the resume reading did not find shown, then the closing question", () => {
    // shown only on a checked quote: a must-have met in part, or met with nothing quoted, is still asked about
    const reading = readingOf(["mh_license"], [{ requirementKey: "mh_perio", met: "partially", evidence: { source: "resume", quote: "charting" } }, { requirementKey: "mh_xray", met: "yes", evidence: { source: "resume", unquoted: true } }]);
    expect(chatGaps(hygienist, reading)).toEqual(["mh_perio", "mh_xray", "mh_dentrix", "mh_nitrous", "mh_permit"]);
    // nothing was read: every must-have is asked about, and the plan still takes four
    expect(chatGaps(hygienist, null)).toHaveLength(6);
    expect(chatPlanFor(hygienist, null, startedAt).items.filter((i) => i.kind === "gap").map((i) => i.key)).toEqual(["mh_license", "mh_perio", "mh_xray", "mh_dentrix"]);
    const plan = chatPlanFor(hygienist, reading, startedAt);
    expect(plan.items.map((i) => [i.key, i.kind, i.required])).toEqual([["license", "question", true], ["experience", "question", true], ["pay", "question", true], ["mh_perio", "gap", false], ["mh_xray", "gap", false], ["mh_dentrix", "gap", false], ["mh_nitrous", "gap", false]]);
    const asked = chatPacket(hygienist, { chat: plan }).screening.questions;
    expect(asked.map((q) => q.key)).toEqual(["license", "experience", "pay", "mh_perio", "mh_xray", "mh_dentrix", "mh_nitrous", CHAT_WRAP_KEY]);
    expect(asked[3].question).toBe(gapQuestion("Periodontal charting"));
    expect(asked[3].question).toBe("This is one of the things the job needs: Periodontal charting. What can you tell me about it from your own work?");
    // a licence, certificate, permit or registration is held or it is not: a plain yes or no, never "from your own work"
    const unread = chatPacket(hygienist, { chat: chatPlanFor(hygienist, null, startedAt) }).screening.questions;
    expect(unread.find((q) => q.key === "mh_license")?.question).toBe("This is one of the things the job needs: Active CA RDH license. Do you have it?");
    expect(unread.find((q) => q.key === "mh_perio")?.question).toBe(asked[3].question);
    expect(gapQuestion("Local anesthesia permit.")).toBe("This is one of the things the job needs: Local anesthesia permit. Do you have it?");
    expect(gapQuestion("Radiography certificate")).toBe("This is one of the things the job needs: Radiography certificate. Do you have it?");
    expect(gapQuestion("Registration with the state dental board")).toBe("This is one of the things the job needs: Registration with the state dental board. Do you have it?");
    // the team's private note of a good answer goes to the models with its question, never into the question
    expect(asked[1]).toMatchObject({ question: "Tell me about your most recent work.", modelAnswer: "names the practice and what they did day to day" });
    expect(asked.at(-1)!.question).toBe(CHAT_WRAP_QUESTION);
    // reading it twice gives the same, and before the chat has a plan the job is as it is
    expect(chatPacket(chatPacket(hygienist, { chat: plan }), { chat: plan }).screening.questions).toEqual(asked);
    expect(chatPacket(hygienist, EMPTY_SCREEN_PROGRESS)).toBe(hygienist);
  });

  // The code check of 25 November 2026: the plan read only whether the stored reading found a must-have shown, so
  // someone who had answered "No" on the form to the question about a licence was asked about that licence again.
  it("does not ask again about a must-have the candidate answered 'no' about on the application form, where the stored reading rests on that answer, and only there", () => {
    const LICENCE_NO = "Do you hold an active CA RDH license? No.";
    const SUSPENDED_NO = "Has your RDH license ever been suspended? No.";
    const CHARTING_NO = "Do you have experience of periodontal charting? No.";
    const form = [LICENCE_NO, "Can you take digital x-rays? Yes.", SUSPENDED_NO, CHARTING_NO];
    const others = ["mh_perio", "mh_xray", "mh_dentrix", "mh_nitrous", "mh_permit"];
    const found = (met: string, evidence?: unknown, requirementKey = "mh_license") => readingOf([], [{ requirementKey, met, ...(evidence ? { evidence } : {}) }]);
    // not met on their own "no" to the form's question: the chat does not ask about the licence again
    const answeredNo = found("no", { source: "application", quote: LICENCE_NO });
    expect(chatGaps(hygienist, answeredNo, form)).toEqual(others);
    expect(chatPlanFor(hygienist, answeredNo, startedAt, form).items.filter((i) => i.kind === "gap").map((i) => i.key)).toEqual(others.slice(0, 4));
    // spacing and case aside, and a quote of part of their answer's line
    expect(chatGaps(hygienist, found("no", { source: "application", quote: "do you hold an  active CA RDH license? no." }), form)).toEqual(others);
    expect(chatGaps(hygienist, found("no", { source: "application", quote: "active CA RDH license? No." }), form)).toEqual(others);
    // "No" to holding an *active* licence is stored as not known (a lapsed one is not active either: the licence rule),
    // and that is how a job's own form mostly asks. The form asked what the chat would ask, and they answered it: the
    // chat does not ask again (the live site, 25 November 2026: it stayed in the plan, and the counter counted it)
    const notKnown = found("unknown", { source: "application", quote: LICENCE_NO });
    expect(chatGaps(hygienist, notKnown, form)).toEqual(others);
    expect(chatGaps(hygienist, found("unknown", { source: "application", quote: "active CA RDH license? No." }), form)).toEqual(others);
    expect(chatPlanFor(hygienist, notKnown, startedAt, form).items.map((i) => i.key)).not.toContain("mh_license");
    // a "yes" on their own answer is shown, and was never asked about
    expect(chatGaps(hygienist, found("yes", { source: "application", quote: "Can you take digital x-rays? Yes." }), form)).toEqual(others);
    // without the form's answers nothing links the two, and the plan is as it was
    expect(chatGaps(hygienist, answeredNo)).toEqual(["mh_license", ...others]);
    expect(chatGaps(hygienist, notKnown)).toEqual(["mh_license", ...others]);
    expect(chatPlanFor(hygienist, answeredNo, startedAt).items.map((i) => i.key)).toContain("mh_license");
    // still asked about wherever that link is not certain
    const uncertain: Array<[string, Pick<EvidenceAssessment, "requirementFindings">]> = [
      ["the same words quoted from the resume", found("no", { source: "resume", quote: LICENCE_NO })],
      ["not known on the same words quoted from the resume", found("unknown", { source: "resume", quote: LICENCE_NO })],
      ["not known on a 'no' that is not about holding it", found("unknown", { source: "application", quote: SUSPENDED_NO })],
      ["not known on a 'yes' to another question", found("unknown", { source: "application", quote: "Can you take digital x-rays? Yes." })],
      ["their answer covers part of it", found("partially", { source: "application", quote: LICENCE_NO })],
      ["the quote did not pass the check", found("no", { source: "application", unquoted: true })],
      ["not known, and the quote did not pass the check", found("unknown", { source: "application", unquoted: true })],
      ["the quote is in no answer of the form", found("no", { source: "application", quote: "Do you hold a Nevada RDH license? No." })],
      ["not known, and the quote is in no answer of the form", found("unknown", { source: "application", quote: "Do you hold a Nevada RDH license? No." })],
      ["the reading says nothing about it", readingOf([])],
    ];
    for (const [why, reading] of uncertain) expect(chatGaps(hygienist, reading, form), why).toEqual(["mh_license", ...others]);
    // not known on their "yes" to holding it (the reading did not take it as shown) is still asked about
    expect(chatGaps(hygienist, found("unknown", { source: "application", quote: "Do you hold an active CA RDH license? Yes." }), ["Do you hold an active CA RDH license? Yes."])).toEqual(["mh_license", ...others]);
    // only a licence, certificate, permit or registration is held or not: not known on a "no" about a skill keeps its question
    expect(chatGaps(hygienist, found("unknown", { source: "application", quote: CHARTING_NO }, "mh_perio"), form)).toEqual(["mh_license", ...others]);
    expect(chatGaps(hygienist, found("no", { source: "application", quote: CHARTING_NO }, "mh_perio"), form)).toEqual(["mh_license", ...others.slice(1)]);
    // nothing is guessed from words: a must-have worded like a question of the form is asked about all the same
    expect(chatGaps(hygienist, readingOf([]), form)).toContain("mh_xray");
    // only a yes or a no counts: a choice or a number is not among the form's answers the plan reads, nor a question left unanswered
    const applied = { formQuestions: [
      { kind: "yes_no", key: "fq_license", question: "Do you hold an active CA RDH license?", required: true },
      { kind: "number", key: "fq_years", question: "How many years have you charted?", unit: "years", required: true },
      { kind: "choice", key: "fq_software", question: "Which software do you chart in?", options: ["Dentrix", "Eaglesoft"], required: true },
      { kind: "yes_no", key: "fq_saturdays", question: "Can you work Saturdays?", required: false },
    ] } as unknown as Pick<RolePacket, "formQuestions">;
    expect(yesNoFormAnswers(applied, { answers: { form: { fq_license: "no", fq_years: "1", fq_software: "Eaglesoft" } } } as never)).toEqual([LICENCE_NO]);
    // "Check your answers" lists every answer they sent with the form, in the form's order, each as its sentence; the
    // chat's model is given none of them
    expect(formAnswersSent(applied, { answers: { form: { fq_license: "no", fq_years: "1", fq_software: "Eaglesoft" } } } as never)).toEqual([LICENCE_NO, "How many years have you charted? 1 years.", "Which software do you chart in? Eaglesoft."]);
    expect(formAnswersSent(applied, { answers: null } as never)).toEqual([]);
  });

  it("a skipped question is never asked again, and counts toward the end of the questions", () => {
    const progress: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license", "experience"], currentQuestionKey: "experience", declined: ["license"] };
    expect(nextQuestion(hygienist, progress, { experience: "Eight patients a day." })?.key).toBe("pay");
    expect(nextQuestion(hygienist, { ...progress, askedKeys: ["license", "experience", "pay"] }, { experience: "x", pay: "y" })).toBeNull();
  });

  it("the check-your-answers page lists every question of the job with its answer and how it came to be, then what else the chat recorded", () => {
    const plan = chatPlanFor(hygienist, readingOf(["mh_license", "mh_xray", "mh_dentrix", "mh_nitrous", "mh_permit"]), startedAt);
    const items = reviewItems({ answers: { license: "Yes", experience: "Eight patients a day." }, progress: { ...EMPTY_SCREEN_PROGRESS, chat: plan, declined: ["pay"], edits: { experience: 1 } } }, hygienist);
    expect(items.map((i) => [i.key, i.status, i.answer])).toEqual([["license", "answered", "Yes"], ["experience", "edited", "Eight patients a day."], ["pay", "declined", null]]);
    expect(items[0].tap).toEqual({ kind: "yes_no" });
    expect(items[2].tap).toMatchObject({ kind: "pay_range" });
    // an answer about a must-have and the closing answer are listed once they are recorded; a must-have settled as not known is not
    const more = reviewItems({ answers: { license: "Yes", mh_perio: "Six points a tooth.", [CHAT_WRAP_KEY]: "Nothing more." }, progress: { ...EMPTY_SCREEN_PROGRESS, chat: plan } }, hygienist);
    expect(more.map((i) => [i.key, i.status])).toEqual([["license", "answered"], ["experience", "unanswered"], ["pay", "unanswered"], ["mh_perio", "answered"], [CHAT_WRAP_KEY, "answered"]]);
  });

  it("the fixed introduction is built from the notice, the code's own lines and the job's title and length, never by the model", () => {
    const intro = screenIntro({ companyName: "Harbor Dental", firstName: "Dana", packet: hygienist });
    expect(intro.title).toBe("A few questions about the Registered Dental Hygienist role");
    expect(intro.disclosure).toContain("Harbor Dental's hiring assistant, a software program");
    expect(intro.disclosure).toContain("Your answers go to the hiring team only when you press Send my answers");
    expect(intro.disclosure).toMatch(/people on the team make every decision/i);
    expect(intro.disclosure).toContain("You can ask for a person at any time.");
    expect(intro.aiNotice?.text).toMatch(/artificial intelligence/);
    // how to reach a person is the code's line, the same for every job: this job stores other words for it and for the
    // AI disclosure, as a model wrote them, and none of those words is in the introduction
    expect(hygienist.communication).toMatchObject({ humanAlternativeText: "Reply to reach a person.", disclosureText: "Sent with help from an AI assistant." });
    expect(intro).toMatchObject({ minutes: 10, humanAlternative: "To reach a person at any time, reply to any of our emails or use the contact on the job page." });
    expect(JSON.stringify(intro)).not.toMatch(/Reply to reach a person|Sent with help from an AI assistant/);
    expect(Object.keys(intro).sort()).toEqual(["aiNotice", "disclosure", "humanAlternative", "minutes", "title"]);
  });
});

describe("the scorecard rests only on what the candidate sent", () => {
  const plan = chatPlanFor(hygienist, readingOf(["mh_license", "mh_xray", "mh_dentrix", "mh_nitrous", "mh_permit"]), startedAt);
  const said = (content: string): ScreenTranscriptEntry => ({ role: "candidate", content, at: startedAt });
  const screen = {
    progress: { ...EMPTY_SCREEN_PROGRESS, chat: plan, askedKeys: ["license", "experience", "pay", "mh_perio"], declined: ["pay"] } as ScreenProgress,
    answers: { license: "Yes, active since 2015.", experience: "At Harbor Dental I see nine patients a day. I chart in Dentrix.", mh_perio: "I chart six points a tooth." } as Record<string, string>,
    transcript: [said("Yes, active since 2015."), said("At Harbor Dental I see nine patients a day."), said("My kids are at school by then."), said("I chart in Dentrix."), said("I chart six points a tooth.")],
  };
  const view = { restore: (text: string) => text } as never;
  const asked = askedQuestions(screen, hygienist);
  const finding = (questionKey: string, meetsModelAnswer: string, quote?: string) => ({ questionKey, finding: `About ${questionKey}.`, meetsModelAnswer, ...(quote ? { evidence: { source: "screen", quote } } : {}) });
  const card = (findings: unknown[], over: Record<string, unknown> = {}) => ({ summary: "A hygienist with recent work.", strengths: [], concerns: [], unknowns: [], questionFindings: findings, ...over }) as unknown as ScreenAssessment;

  it("lists what was asked: the job's own questions and each must-have the chat got to, never the closing question", () => {
    expect(asked).toEqual([
      { key: "license", question: "Is your RDH license active in California?", skipped: false },
      { key: "experience", question: "Tell me about your most recent work.", standard: "names the practice and what they did day to day", skipped: false },
      { key: "pay", question: "What pay range are you looking for?", skipped: true },
      { key: "mh_perio", question: gapQuestion("Periodontal charting"), mustHave: "Periodontal charting", skipped: false },
    ]);
    // a must-have the chat never got to is not on the list, and an interview that never started asked nothing
    expect(askedQuestions({ ...screen, progress: { ...screen.progress, askedKeys: ["license", "experience", "pay"] } }, hygienist).map((a) => a.key)).toEqual(["license", "experience", "pay"]);
    expect(askedQuestions({ answers: {}, progress: EMPTY_SCREEN_PROGRESS }, hygienist)).toEqual([]);
  });

  it("never counts the assistant's recorded answers as the candidate's words, but finds a whole answer they sent over two messages", () => {
    const words = candidateWordsOf(screen);
    expect(words).toContain("My kids are at school by then.");
    expect(saidByCandidate("I see nine patients a day", words)).toBe(true);
    // the answer as recorded, put together from two of their messages with the personal sentence left out
    expect(saidByCandidate("At Harbor Dental I see nine patients a day. I chart in Dentrix.", words)).toBe(true);
    expect(saidByCandidate("I supervised three assistants.", words)).toBe(false);
    expect(saidByCandidate("At Harbor Dental I see nine patients a day. I supervised three assistants.", words)).toBe(false);
  });

  it("one finding for each question asked: a quote that is not theirs is taken off, a yes without one is partly, a no without one is not known, a skipped question is not known", () => {
    const out = scorecardOutcome(card([
      finding("license", "yes", "Yes, active since 2015."),
      finding("experience", "yes", "I supervised three assistants."),
      finding("pay", "yes", "I chart in Dentrix."),
      finding("mh_perio", "no"),
      finding(CHAT_WRAP_KEY, "yes", "I chart in Dentrix."),
      finding("made_up", "yes", "I chart in Dentrix."),
    ], { strengths: [{ claim: "Charts in Dentrix", evidence: { source: "screen", quote: "I chart in Dentrix." } }, { claim: "Leads a team", evidence: { source: "screen", quote: "I supervised three assistants." } }] }), view, screen, asked);
    expect(out.questionFindings).toEqual([
      { questionKey: "license", finding: "About license.", meetsModelAnswer: "yes", evidence: { source: "screen", quote: "Yes, active since 2015." } },
      { questionKey: "experience", finding: "About experience.", meetsModelAnswer: "partially" },
      { questionKey: "pay", finding: "Skipped by the candidate.", meetsModelAnswer: "unknown" },
      { questionKey: "mh_perio", finding: "About mh_perio.", meetsModelAnswer: "unknown" },
    ]);
    expect(out.strengths.map((s) => s.claim)).toEqual(["Charts in Dentrix"]);
  });

  it("gives every question asked a finding: one the model left out is not known, with no words of the model's", () => {
    const out = scorecardOutcome(card([finding("license", "yes", "Yes, active since 2015."), finding("mh_perio", "no", "I chart six points a tooth.")]), view, screen, asked);
    expect(out.questionFindings.map((f) => [f.questionKey, f.meetsModelAnswer, f.finding])).toEqual([
      ["license", "yes", "About license."],
      ["experience", "unknown", ""],
      ["pay", "unknown", "Skipped by the candidate."],
      // a must-have that names no licence stands as the model read it, on their own quoted words
      ["mh_perio", "no", "About mh_perio."],
    ]);
    // a question with no answer on record is not known, whatever the model wrote about it
    const unanswered = scorecardOutcome(card([finding("experience", "yes", "I chart in Dentrix.")]), view, { ...screen, answers: { license: "Yes, active since 2015." } }, asked);
    expect(unanswered.questionFindings.find((f) => f.questionKey === "experience")).toEqual({ questionKey: "experience", finding: "About experience.", meetsModelAnswer: "unknown", evidence: { source: "screen", quote: "I chart in Dentrix." } });
    // Whether a question was answered is read from the record, and the model is no longer asked (the code check of 25
    // November 2026: nothing read its answer). A reading that still says so, as a model of an earlier build did, changes
    // nothing, and no finding the team sees carries it.
    const said = (answered: boolean) => scorecardOutcome(card([{ ...finding("experience", "yes", "I chart in Dentrix."), answered }, { ...finding("pay", "yes", "I chart in Dentrix."), answered }]), view, { ...screen, answers: { license: "Yes, active since 2015." } }, asked);
    expect(said(true)).toEqual(said(false));
    expect(said(true).questionFindings.map((f) => [f.questionKey, f.meetsModelAnswer])).toEqual([["license", "unknown"], ["experience", "unknown"], ["pay", "unknown"], ["mh_perio", "unknown"]]);
    for (const f of [...out.questionFindings, ...said(true).questionFindings]) expect(f).not.toHaveProperty("answered");
  });

  it("holds a question about a licence the job needs to the licence rule, whatever the model answered", () => {
    const meets = (answer: string, model: string, quote = answer) => {
      const chat = {
        progress: { ...EMPTY_SCREEN_PROGRESS, chat: chatPlanFor(hygienist, readingOf(["mh_perio", "mh_xray", "mh_dentrix", "mh_nitrous", "mh_permit"]), startedAt), askedKeys: ["license", "experience", "pay", "mh_license"] } as ScreenProgress,
        answers: { mh_license: answer } as Record<string, string>,
        transcript: [said(answer)],
      };
      const about = askedQuestions(chat, hygienist);
      expect(about.at(-1)).toEqual({ key: "mh_license", question: gapQuestion("Active CA RDH license"), mustHave: "Active CA RDH license", skipped: false });
      return scorecardOutcome(card([finding("mh_license", model, quote)]), view, chat, about).questionFindings.at(-1)?.meetsModelAnswer;
    };
    // lapsed, expired or pending is not known: never met, partly met or not met
    for (const model of ["yes", "partially", "no", "unknown"]) expect(meets("My RDH license lapsed last year and I have not renewed it yet.", model), model).toBe("unknown");
    // said plainly, it is not met, also when the model read it otherwise or quoted only part of their sentence
    expect(meets("I do not hold a California RDH license.", "unknown")).toBe("no");
    expect(meets("I do not hold a California RDH license.", "yes", "a California RDH license")).toBe("no");
    // a "no" their words do not say plainly is not known, and one they hold stands as read
    expect(meets("My license is from Nevada and I am moving next month.", "no")).toBe("unknown");
    expect(meets("Yes, my RDH license is active in California.", "yes")).toBe("yes");
  });

  it("is read three times: the middle answer for each question; the first reading when fewer came back; an outage fails", () => {
    expect(SCORECARD_READINGS).toBe(3);
    const ok = (output: ScreenAssessment, runId: string) => ({ ok: true, output, runId }) as unknown as RunOutcome<ScreenAssessment>;
    const reading = (license: string, experience: string, summary: string) => card([finding("license", license, "Yes, active since 2015."), finding("experience", experience, "I see nine patients a day"), finding("mh_perio", "yes", "I chart six points a tooth.")], { summary });
    const three = [ok(reading("yes", "no", "One."), "r1"), ok(reading("yes", "partially", "Two."), "r2"), ok(reading("partially", "yes", "Three."), "r3")];
    const out = scorecardReadings(three, view, screen, asked);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.questionFindings.map((f) => [f.questionKey, f.meetsModelAnswer])).toEqual([["license", "yes"], ["experience", "partially"], ["pay", "unknown"], ["mh_perio", "yes"]]);
    // the words are those of the reading that agrees with the most middle answers, whatever order they came back in
    expect(out.output.summary).toBe("Two.");
    expect(scorecardReadings([...three].reverse(), view, screen, asked)).toMatchObject({ output: { summary: "Two." } });
    // fewer usable readings: the first one, held to the same rules
    const failed = { ok: false, reason: "invalid_output", error: "no usable answer" } as unknown as RunOutcome<ScreenAssessment>;
    expect(scorecardReadings([failed, three[2], failed], view, screen, asked)).toMatchObject({ ok: true, output: { summary: "Three." } });
    // none: the outage, so the step is tried again
    const outage = { ok: false, reason: "error", error: "provider outage" } as unknown as RunOutcome<ScreenAssessment>;
    expect(scorecardReadings([failed, outage, failed], view, screen, asked)).toBe(outage);
  });
});


describe("screenCommand: whole-message keywords", () => {
  it("an answer that starts with a keyword is an answer", () => {
    expect(screenCommand("Representative at a phone store for two years")).toBeNull();
    expect(screenCommand("Withdraw cash from the till at closing and count the drawer")).toBeNull();
    expect(screenCommand("Agent for a travel company, 2019 to 2022")).toBeNull();
    expect(screenCommand("Person-centred care is how I work")).toBeNull();
    expect(screenCommand("Yes")).toBeNull(); // nothing is pending: an ordinary answer
  });

  it("the command alone, in any case, with a full stop or an exclamation mark, is the command", () => {
    for (const m of ["HUMAN", "human", " Human. ", "person!", "Agent", "representative", "a person"]) expect(screenCommand(m), m).toBe("person");
    expect(screenCommand("Could I talk to a real person about the schedule?")).toBe("person");
    expect(screenCommand("I'd rather speak with a human")).toBe("person");
    for (const m of ["WITHDRAW", "withdraw.", "Withdraw my application"]) expect(screenCommand(m), m).toBe("withdraw");
  });

  it("while a withdrawal waits, CONFIRM or YES confirms it, NO keeps the application, anything else is an answer", () => {
    for (const m of ["CONFIRM", "yes", "Y", "withdraw"]) expect(screenCommand(m, true), m).toBe("confirm_withdraw");
    for (const m of ["no", "No.", "keep", "keep going", "Keep my application"]) expect(screenCommand(m, true), m).toBe("keep_application");
    expect(screenCommand("Sorry, I meant I have worked weekends for three years", true)).toBeNull();
    expect(screenCommand("HUMAN", true)).toBe("person");
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

describe("questions the AI interview may never ask", () => {
  it("catches criminal history, health, graduation, children and workers' comp, and lets ordinary dental questions through (review of Wave S5)", () => {
    for (const unfair of [
      "Have you ever been convicted of a crime?", "Do you have a criminal record?", "Do you have any health issues that would affect your work?", "Do you have any medical conditions we should know about?",
      "When did you graduate from high school?", "How many kids do you have?", "Do you have reliable childcare?", "Have you ever filed a workers' comp claim?", "What is your current pay?", "How much do you make now?",
    ]) expect(unfairQuestion(unfair), unfair).not.toBeNull();
    for (const fair of [
      "How do you review their medical history and their medications before a cleaning?", "How do you explain gum disease to patients and their health risks?",
      "Thanks, that is within the current pay range for this role.", "How many children do you see in a typical day?", "How do you adjust care for a patient with a medical condition?",
      // review of the criminal-record fix, 17 Nov 2026: the work's own words were replaced with "Thanks."
      "Thanks. Were you charged with training the new hygienists?", "How did you follow up on any pending charges before month end?",
      // and its final check: a medical "arrest" was read as one
      "Thanks. Have you received any cardiac arrest training?",
    ]) expect(unfairQuestion(fair), fair).toBeNull();
    // and a question about the candidate's record in the words that got past it
    for (const unfair of ["Are you a person with a criminal record?", "Do you have a clean record?", "Do you have any fraud convictions?"]) expect(unfairQuestion(unfair), unfair).not.toBeNull();
  });
});

describe("what each turn of the chat is held to", () => {
  /** One of a job's interview questions as these cases write it: `lookFor` is the team's private note of a good answer. */
  type Asked = { key: string; question: string; required?: boolean; lookFor?: string };
  const base = {
    identity: { title: "Robotics Trainer", employmentType: "full_time", locations: [{ city: "Lahore", region: "PB" }] },
    compensation: { basis: "salary", min: 50000, max: 70000, currency: "USD", discloseRange: false },
    requirements: {
      mustHaves: [
        { key: "arduino", text: "Hands-on Arduino or robotics hardware work", rationale: "r" },
        { key: "english", text: "Explaining technical ideas in English", rationale: "r" },
      ],
      niceToHaves: [],
    },
    competencies: [],
    communication: { candidateMayBeTold: [], tone: "warm", humanAlternativeText: "Reply to reach a person.", disclosureText: "" },
  };
  /** The robotics job with these interview questions. */
  const jobWith = (questions: Asked[]): RolePacket => ({ ...base, screening: { questions: questions.map((x) => ({ key: x.key, question: x.question, kind: "behavioral", required: x.required ?? true, ...(x.lookFor ? { modelAnswer: x.lookFor } : {}) })), maxMinutes: 10 } }) as unknown as RolePacket;
  const role = jobWith([
    { key: "wq_explain", question: "How would you explain what a sensor is to six-year-olds?", required: true, lookFor: "uses a concrete everyday analogy and checks understanding with the children" },
    { key: "wq_room", question: "Several kits fail at once in a class of twenty. How do you handle the room?", required: true },
  ]);
  const facts = { cv: ["Software engineer at CallsFlow (2023 to now): WebRTC calls platform", "Skills: TypeScript, WebRTC, IoT"] };
  const at = "2026-10-15T10:00:00.000Z";
  /**
   * A chat on `job` whose plan asks about these must-haves and then the job's questions. These cases are about what one
   * turn may do, whatever the order: the order a real chat is planned in is the case above ("what an AI interview asks").
   */
  const planOf = (job: RolePacket, gaps: string[]): ScreenProgress => ({
    ...EMPTY_SCREEN_PROGRESS,
    chat: { v: 1, section: gaps.length ? "experience" : "required", items: [...gaps.map((key) => ({ key, kind: "gap" as const, required: false, state: "open" as const, step: "direct" as const, pushes: 0 })), ...job.screening.questions.map((x) => ({ key: x.key, kind: "question" as const, required: true, state: "open" as const, step: "direct" as const, pushes: 0 }))], current: null, builtAt: at },
  });
  const start = (gaps: string[]) => planOf(role, gaps);

  /**
   * A turn as the model returns it. `answerRecorded`: the model's own record of the answer, which an earlier build asked
   * for and a turn may still carry (the real model wrote it wrongly more than once): the code never reads it.
   */
  const turnOf = (over: Partial<ScreenTurn> & { answerRecorded?: { questionKey: string; answer: string; complete: boolean; status?: string } }): ScreenTurn => ({ messageToCandidate: "", questionKey: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, ...over });
  /** The progress with the chat asking `key`, with the item's ladder where given. */
  const askingNow = (progress: ScreenProgress, key: string, asked: string[], item: Partial<{ step: "direct" | "analog" | "smaller"; pushes: number }> = {}): ScreenProgress => {
    const p = advanceProgress({ ...progress, askedKeys: asked.slice(0, -1) }, turnOf({ questionKey: key, messageToCandidate: "x" }));
    return { ...p, chat: p.chat ? { ...p.chat, items: p.chat.items.map((i) => (i.key === key ? { ...i, ...item } : i)) } : p.chat };
  };
  const said = (question: string, ...replies: string[]): ScreenTranscriptEntry[] => [{ role: "assistant", content: question, at, questionKey: "q" }, ...replies.map((r) => ({ role: "candidate" as const, content: r, at }))];

  it("opens personal, in code: the first name, one line from the CV, then the first question word for word", () => {
    expect(chatOpening({ firstName: "Meerub", cv: facts.cv, question: "Q?" })).toBe("Hi Meerub. Your resume shows your work as Software engineer at CallsFlow (2023 to now).\n\nQ?");
    expect(chatOpening({ firstName: "Kai", cv: [], question: "Q?" })).toBe("Hi Kai. Thanks for applying.\n\nQ?");
    expect(chatOpening({ firstName: "Kai", cv: ["Skills: TypeScript"], question: "Q?" })).toBe("Hi Kai. Thanks for applying.\n\nQ?");
  });

  it("each message is one neutral restatement and one question: no filler, no praise about their experience, no inference, nothing after the first question", () => {
    const p = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
    const { turn, move } = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "no detail", messageToCandidate: "Great! So you built a pump with an Arduino. That's impressive. What did the sensor trigger? And which board did you use?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "I built a pump"), latest: "I built a pump" });
    expect(turn.messageToCandidate).toBe("So you built a pump with an Arduino.\n\nWhat did the sensor trigger?");
    expect(move).toEqual({ key: "arduino", move: "push" });
    expect(advanceProgress(p, turn, move).chat?.items[0]).toMatchObject({ state: "asking", pushes: 1 });
    // an inference never reaches the candidate
    const guessed = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "no detail", messageToCandidate: "It sounds like the build was straightforward for you. What was hardest about it?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "It went fine"), latest: "It went fine" });
    expect(guessed.turn.messageToCandidate).toBe("What was hardest about it?");
    // a follow-up the model wrote without a question gets the push in code's words
    const flat = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "no detail", messageToCandidate: "You said you built a pump." }), chatPacket(role, p), p, {}, { transcript: said("Q", "I built a pump"), latest: "I built a pump" });
    expect(flat.turn.messageToCandidate).toBe(`You said you built a pump.\n\n${CHAT_LADDER_QUESTION.push}`);
  });

  // Seen with the real model on 19 November 2026: it recorded two replies joined its own way ("… | …"), which is not
  // what the candidate sent, and it wrote "résumé" where every page says "resume". On 25 November 2026 it recorded only
  // the latest of two replies, and the first one's words about their work were gone from the record. Since the code
  // check of that day the model is not asked for a record at all: the answer is every reply of theirs about the
  // question, built in code, and a record that a turn still carries is never read.
  it("records every reply of the candidate's about a question, as they sent them: the model returns no record, one that a turn still carries is never read; and says resume as the pages do", () => {
    const p = askingNow(start([]), "wq_explain", ["wq_explain"], { pushes: 1 });
    const first = "I show them a light sensor.";
    const second = "Last week a class covered it with a hand and saw the lamp go on.";
    const transcript = said("Q", first, second);
    const MOVES_ON = { reading: "concrete" as const, questionKey: "wq_room", messageToCandidate: "You showed them a light sensor. Several kits fail at once in a class of twenty. How do you handle the room?" };
    // the turn as the model returns it now, with no record: their two replies are the answer, joined as the code joins them
    expect(enforceChatTurn(turnOf(MOVES_ON), chatPacket(role, p), p, {}, { transcript, latest: second }).turn.answerRecorded).toEqual({ questionKey: "wq_explain", answer: `${first} ${second}`, complete: true });
    const settle = (answer: string, questionKey = "wq_explain") => enforceChatTurn(turnOf({ ...MOVES_ON, answerRecorded: { questionKey, answer, complete: true, status: "answered" } }), chatPacket(role, p), p, {}, { transcript, latest: second }).turn.answerRecorded;
    // a turn that still carries a record, joined the model's own way or reworded in their name: none of its words is used
    expect(settle(`${first} | ${second}`)).toEqual({ questionKey: "wq_explain", answer: `${first} ${second}`, complete: true });
    expect(settle("The candidate demonstrates a light sensor to the class.")?.answer).toBe(`${first} ${second}`);
    // their own words in full: the same when it carried both replies, and when it kept only the latest one
    expect(settle(`${first} ${second}`)?.answer).toBe(`${first} ${second}`);
    expect(settle(second)).toMatchObject({ questionKey: "wq_explain", answer: `${first} ${second}`, complete: true });
    // nor is the question it names: the answer is recorded for the question that was being asked
    expect(settle("I would calm the room first.", "wq_room")).toEqual({ questionKey: "wq_explain", answer: `${first} ${second}`, complete: true });
    // and the assistant's own message says "resume" (a first push, on a question not pushed yet)
    const fresh = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const spelt = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "no detail", messageToCandidate: "Your résumé lists a robotics club. What did you build there?" }), chatPacket(role, fresh), fresh, {}, { transcript: said("Q", "A few things"), latest: "A few things" });
    expect(spelt.turn.messageToCandidate).toBe("Your resume lists a robotics club.\n\nWhat did you build there?");
  });

  /**
   * The live smoke test of 4 Nov 2026: two questions lost their first sentence, because "Tell us…" and "Give an
   * example…" did not read as asking, so a candidate was shown only "What did you do, and how did it turn out?" after a
   * restatement of something else, and answered the wrong thing. The real model's raw messages (ai_runs, screen.turn v8)
   * had the blank line the prompt asks for and the whole question: the code threw the paragraphs away and cut it.
   */
  describe("a question of two sentences keeps its first one (live smoke test, 4 Nov 2026)", () => {
    const HELP = "Tell us about a time you helped someone who was frustrated or confused. What did you do and how did it turn out?";
    const MISTAKE = "Give an example of a time you made a mistake at work. What did you do about it?";
    const live = jobWith([{ key: "wq_track", question: "Describe how you keep track of tasks and deadlines when several things need attention at once.", required: true }, { key: "wq_help", question: HELP, required: true }, { key: "wq_mistake", question: MISTAKE, required: true, lookFor: "owns the mistake and says what changed afterwards" }]);
    const startLive = () => planOf(live, []);
    /** What the candidate is shown when the model moves on to `to` from the question before it. */
    const moveTo = (to: "wq_help" | "wq_mistake", messageToCandidate: string) => {
      const from = to === "wq_help" ? "wq_track" : "wq_help";
      const p = askingNow(startLive(), from, to === "wq_help" ? ["wq_track"] : ["wq_track", "wq_help"]);
      return enforceChatTurn(turnOf({ reading: "concrete", questionKey: to, messageToCandidate }), chatPacket(live, p), p, {}, { transcript: said("Q", "I keep one shared task list and a calendar."), latest: "I keep one shared task list and a calendar." }).turn.messageToCandidate;
    };
    const TASKS = "You keep one shared task list and a calendar, check them each morning, and move urgent items to the top.";
    const VISITOR = "You helped a visitor with a missed appointment by listening, apologizing, and getting them a new time that same week.";
    const REQUESTED = "Tell us about a time you helped someone who was frustrated or confused.";
    /** What the candidate is shown when the model keeps asking about `on`, the question being asked. */
    const stayOn = (on: "wq_help" | "wq_mistake", messageToCandidate: string) => {
      const p = askingNow(startLive(), on, on === "wq_help" ? ["wq_track", "wq_help"] : ["wq_track", "wq_help", "wq_mistake"]);
      return enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", messageToCandidate }), chatPacket(live, p), p, {}, { transcript: said("Q", "I sorted it out."), latest: "I sorted it out." }).turn.messageToCandidate;
    };
    /** What the candidate is shown when the model moves on to the room question of the robotics job. */
    const moveToRoom = (messageToCandidate: string) => {
      const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
      return enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_room", messageToCandidate }), chatPacket(role, p), p, {}, { transcript: said("Q", "Like a thirsty finger"), latest: "Like a thirsty finger" }).turn.messageToCandidate;
    };
    /** What the candidate is shown when the model moves on to a job's question in these words, with this private note. */
    const moveToOwn = (question: string, messageToCandidate: string, lookFor?: string) => {
      const job = jobWith([{ key: "wq_first", question: "What do you do first?", required: true }, { key: "wq_own", question, required: true, ...(lookFor ? { lookFor } : {}) }]);
      const p = askingNow(planOf(job, []), "wq_first", ["wq_first"]);
      return enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_own", messageToCandidate }), chatPacket(job, p), p, {}, { transcript: said("Q", "I keep a list."), latest: "I keep a list." }).turn.messageToCandidate;
    };

    it("shows the real model's messages from the live test exactly as it wrote them", () => {
      const scenario = "You keep one shared task list and a calendar, check them each morning, and move urgent items to the top.\n\nTest, think of a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?";
      const mistake = "You helped a visitor with a missed appointment by listening, apologizing, and getting them a new time that same week.\n\nThink of a time you made a mistake at work. What happened, and what did you do about it?";
      const inOne = "You finished the invoices first when two deadlines fell on the same day, and told your manager about the supply order.\n\nNow, can you tell me about a time you helped someone who was frustrated or confused, and what you did?";
      expect(moveTo("wq_help", scenario)).toBe(scenario);
      expect(moveTo("wq_mistake", mistake)).toBe(mistake);
      expect(moveTo("wq_help", inOne)).toBe(inOne);
    });

    it("says the model's whole question, with or without the blank line before it", () => {
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?`);
      expect(moveTo("wq_help", `${TASKS} Tell us about a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nGive an example of a time you made a mistake at work. What happened, and what did you do about it?`)).toBe(`${VISITOR}\n\nGive an example of a time you made a mistake at work. What happened, and what did you do about it?`);
      expect(moveTo("wq_mistake", `${VISITOR} Give an example of a time you made a mistake at work. What happened, and what did you do about it?`)).toBe(`${VISITOR}\n\nGive an example of a time you made a mistake at work. What happened, and what did you do about it?`);
      // the other ways of asking, and a request said on its own
      expect(moveTo("wq_mistake", `${VISITOR}\n\nThink of a time you made a mistake at work. What did you do about it?`)).toBe(`${VISITOR}\n\nThink of a time you made a mistake at work. What did you do about it?`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nNow, walk us through a mistake you made at work.`)).toBe(`${VISITOR}\n\nNow, walk us through a mistake you made at work.`);
    });

    it("keeps a scenario set before the question, and the words of a question of the job's own", () => {
      const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
      const shown = (messageToCandidate: string) => enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_room", messageToCandidate }), chatPacket(role, p), p, {}, { transcript: said("Q", "Like a thirsty finger that feels the water"), latest: "Like a thirsty finger that feels the water" }).turn.messageToCandidate;
      const LEAD = "You explained it as a thirsty finger.";
      expect(shown(`${LEAD}\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?`)).toBe(`${LEAD}\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?`);
      expect(shown(`${LEAD} Several kits fail at once in a class of twenty. How do you handle the room?`)).toBe(`${LEAD}\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?`);
      expect(shown(`${LEAD}\n\nPicture a class of twenty where several kits stop working. How do you handle the room?`)).toBe(`${LEAD}\n\nPicture a class of twenty where several kits stop working. How do you handle the room?`);
      // the question a gap asks, as the model is free to write it
      const g = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
      const gap = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: `You built a water pump.\n\n${gapQuestion("Explaining technical ideas in English")}` }), chatPacket(role, g), g, {}, { transcript: said("Q", "I built a water pump with an Arduino at CUST"), latest: "I built a water pump with an Arduino at CUST" });
      expect(gap.turn.messageToCandidate).toBe(`You built a water pump.\n\n${gapQuestion("Explaining technical ideas in English")}`);
    });

    it("asks in the job's words when all the model wrote for a new question is exactly the job's last sentence, and only then", () => {
      expect(moveTo("wq_help", `${TASKS}\n\nWhat did you do, and how did it turn out?`)).toBe(`${TASKS}\n\n${HELP}`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nWhat did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      // in the model's own words it stays as written, even when it is short: a short check is what screen.turn v8 asks for
      expect(moveTo("wq_mistake", `${VISITOR}\n\nWhat happened, and what did you do about it?`)).toBe(`${VISITOR}\n\nWhat happened, and what did you do about it?`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nHow did you handle it?`)).toBe(`${VISITOR}\n\nHow did you handle it?`);
      // what the model set it up with counts: the question is then not only the end of the job's
      expect(moveTo("wq_mistake", `${VISITOR}\n\nPicture your last bad day. What did you do about it?`)).toBe(`${VISITOR}\n\nPicture your last bad day. What did you do about it?`);
      const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
      const room = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_room", messageToCandidate: "You explained it as a thirsty finger.\n\nHow do you handle the room?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Like a thirsty finger"), latest: "Like a thirsty finger" });
      expect(room.turn.messageToCandidate).toBe("You explained it as a thirsty finger.\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?");
      const g = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
      const gap = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: "You built a water pump.\n\nWhat can you tell me about it from your own work?" }), chatPacket(role, g), g, {}, { transcript: said("Q", "I built a water pump with an Arduino at CUST"), latest: "I built a water pump with an Arduino at CUST" });
      expect(gap.turn.messageToCandidate).toBe(`You built a water pump.\n\n${gapQuestion("Explaining technical ideas in English")}`);
      // however the restatement is worded: one word in common with the job's first sentence changes nothing
      for (const lead of ["You keep a shared list and help the team stay on track.", "You keep tasks on one list so nobody gets confused."]) expect(moveTo("wq_help", `${lead}\n\nWhat did you do, and how did it turn out?`), lead).toBe(`${lead}\n\n${HELP}`);
      expect(moveToRoom("You would explain it to the class as a thirsty finger.\n\nHow do you handle the room?")).toBe("You would explain it to the class as a thirsty finger.\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?");
    });

    it("leaves alone a question that stands by itself, a short check on what they said, and a follow-up on the same question", () => {
      // the model's own words for the question, in one sentence
      expect(moveTo("wq_help", `${TASKS}\n\nCan you tell me about a time you helped someone who was upset, and what you did?`)).toBe(`${TASKS}\n\nCan you tell me about a time you helped someone who was upset, and what you did?`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nWhich tool did you use to book the new time?`)).toBe(`${VISITOR}\n\nWhich tool did you use to book the new time?`);
      // the item was already answered: the restatement names it and the question is one short check (screen.turn v8), never the item's question again
      expect(moveTo("wq_mistake", "You said you made a mistake with the vendor's order.\n\nWhat did you do next?")).toBe("You said you made a mistake with the vendor's order.\n\nWhat did you do next?");
      // a short check stands whatever the restatement says, its words in the job's or not
      for (const check of ["What did you do next?", "How long did the fix take?", "How did it turn out?", "What came of it?", "How did that go?"]) {
        const message = `You sent a client the wrong invoice and fixed it the same day.\n\n${check}`;
        expect(moveTo("wq_mistake", message), check).toBe(message);
      }
      expect(moveTo("wq_help", "You got a visitor who was upset a new appointment.\n\nHow did it turn out?")).toBe("You got a visitor who was upset a new appointment.\n\nHow did it turn out?");
      const toEnglish = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
      for (const check of ["What came of it?", "How did that go?"]) {
        const message = `You ran a weekend robotics club for two years, telling beginners a sensor is like a finger.\n\n${check}`;
        const club = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: message }), chatPacket(role, toEnglish), toEnglish, {}, { transcript: said("Q", "I ran a weekend club"), latest: "I ran a weekend club" });
        expect(club.turn.messageToCandidate, check).toBe(message);
      }
      // staying on a question: what came of it is the push, and the question it follows is already on the screen
      const p = askingNow(startLive(), "wq_help", ["wq_track", "wq_help"]);
      const push = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: "You helped a visitor.\n\nWhat did you do, and how did it turn out?" }), chatPacket(live, p), p, {}, { transcript: said(HELP, "I helped a visitor."), latest: "I helped a visitor." });
      expect(push.turn.messageToCandidate).toBe("You helped a visitor.\n\nWhat did you do, and how did it turn out?");
    });

    it("keeps the real question after a sentence that only sets the scene, and never takes that sentence for the question", () => {
      for (const question of ["Think back to your last job at the clinic. Which tool did you use to book the new time?", "Think of your last busy day. Who did you help first?", "Think of your last busy day. Did you ask anyone for help?", "Imagine a visitor who missed their slot. How would you book them in?", "Now, suppose two deadlines fall on one day. How do you choose?", "Let's say a kit fails. How do you find the fault?"]) {
        expect(moveTo("wq_mistake", `${VISITOR}\n\n${question}`), question).toBe(`${VISITOR}\n\n${question}`);
        // in one paragraph it still sets the question up, and the restatement goes before it
        expect(moveTo("wq_mistake", `${VISITOR} ${question}`), question).toBe(`${VISITOR}\n\n${question}`);
      }
      // a request, with the question that follows from it
      expect(moveTo("wq_mistake", `${VISITOR}\n\nTell us about your last busy day. Which task did you do first?`)).toBe(`${VISITOR}\n\nTell us about your last busy day. Which task did you do first?`);
      // on a follow-up
      expect(stayOn("wq_help", "You keep a task list.\n\nThink of your last busy day. Which task did you do first?")).toBe("You keep a task list.\n\nThink of your last busy day. Which task did you do first?");
      // a job's own question that opens this way, word for word
      expect(moveToOwn("Think of a busy day at the clinic. Which task do you do first?", `${TASKS}\n\nThink of a busy day at the clinic. Which task do you do first?`)).toBe(`${TASKS}\n\nThink of a busy day at the clinic. Which task do you do first?`);
      // "Think of…" is no question: asked on its own, the candidate gets the question it stands for
      expect(moveTo("wq_mistake", `${VISITOR}\n\nThink of a time you made a mistake at work.`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      expect(moveTo("wq_mistake", "Think of a time you made a mistake at work.")).toBe(MISTAKE);
      expect(stayOn("wq_mistake", "You made a mistake.\n\nThink of the last one.")).toBe(`You made a mistake.\n\n${CHAT_LADDER_QUESTION.push}`);
    });

    it("reads a first paragraph that only has a request as the restatement, when a later paragraph asks too", () => {
      for (const lead of ["Think of a sensor as a thirsty finger.", "Explain it as a thirsty finger.", "Share it with them as a thirsty finger."]) {
        const message = `${lead}\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?`;
        expect(moveToRoom(message), lead).toBe(message);
      }
      const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
      const room = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_room", messageToCandidate: "Think of a sensor as a thirsty finger.\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Like a thirsty finger"), latest: "Like a thirsty finger" });
      expect(room.turn.questionKey).toBe("wq_room");
      for (const message of ["Share the plan with the team each morning.\n\nWhich tool do you use?", "First, explain the problem to the customer, then offer a new time.\n\nWhich tool do you use to book?"]) expect(moveTo("wq_mistake", message), message).toBe(message);
      // a question in the first paragraph is the question, whatever follows; and so is a request when nothing later asks
      expect(moveTo("wq_mistake", "Which tool do you use?\n\nHow long have you used it?")).toBe("Which tool do you use?");
      expect(moveTo("wq_mistake", "Walk me through a mistake you made at work.\n\nTake your time.")).toBe("Walk me through a mistake you made at work.");
      // "First," or "Then," opens a step they told us about, never a request of ours
      expect(moveTo("wq_mistake", "Then, describe the fix to the customer. Which tool do you use?")).toBe("Then, describe the fix to the customer.\n\nWhich tool do you use?");
    });

    it("still says one restatement and one question: a second question is cut, and what does not belong to the question is left out", () => {
      // a question that has nothing to do with the request before it
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What pay are you looking for?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused.`);
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. And which days can you work?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused.`);
      for (const second of ["What do you expect to be paid?", "How do you feel about weekend shifts?", "What pay do you expect for this role?", "Which days can you work this month?", "Can you start next week, or is that too soon?", "What pay are you looking for in this role?"]) {
        expect(moveTo("wq_help", `${TASKS}\n\n${REQUESTED} ${second}`), second).toBe(`${TASKS}\n\n${REQUESTED}`);
        expect(moveTo("wq_help", `${TASKS}\n\nDescribe a day that went badly. ${second}`), second).toBe(`${TASKS}\n\nDescribe a day that went badly.`);
        expect(moveTo("wq_help", `${TASKS}\n\nTell me about a time you helped someone who was frustrated. ${second}`), second).toBe(`${TASKS}\n\nTell me about a time you helped someone who was frustrated.`);
      }
      // a question about what happened there, or that ends by pointing back at it, is the same question
      for (const same of ["Which task did you do first?", "Who was on the team?", "How would you handle it?", "What steps did you take?", "What steps did you take to fix it?", "What came of it?", "How did it turn out?"]) expect(moveTo("wq_help", `${TASKS}\n\n${REQUESTED} ${same}`), same).toBe(`${TASKS}\n\n${REQUESTED} ${same}`);
      // however the request opens: a lead-in or the candidate's name, not "then", "first", "finally" or "lastly"
      for (const opening of ["Please tell us about a mistake.", "Now, walk us through a mistake.", "And share a mistake.", "Next: give us a mistake.", "So, give one example of a mistake.", "Also give a real example of a mistake.", "Test, tell me about a mistake.", "Now, Test, please describe a mistake."]) expect(moveTo("wq_mistake", `${VISITOR}\n\n${opening} What did you do?`), opening).toBe(`${VISITOR}\n\n${opening} What did you do?`);
      // a question keeps the request after it only in the words it always did: the wider wordings are a second ask
      expect(moveTo("wq_help", `${TASKS}\n\nNot done that exactly? Tell me about something similar from your own work.`)).toBe(`${TASKS}\n\nNot done that exactly? Tell me about something similar from your own work.`);
      expect(moveTo("wq_help", `${TASKS}\n\nWhat pay are you looking for? ${REQUESTED}`)).toBe(`${TASKS}\n\nWhat pay are you looking for?`);
      expect(moveTo("wq_help", `${TASKS}\n\nWhat pay are you looking for? ${REQUESTED} Give an example of a time you made a mistake at work. Think of a time you were late.`)).toBe(`${TASKS}\n\nWhat pay are you looking for?`);
      // two questions after the request
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do? And what pay are you looking for?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do?`);
      // a second restatement in one breath with the question is still left out
      expect(moveTo("wq_help", `${TASKS} You also check your email first. Tell us about a time you helped someone who was frustrated or confused. What did you do and how did it turn out?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do and how did it turn out?`);
      // a guess or praise in the question's own paragraph never reaches the candidate
      expect(moveTo("wq_help", `${TASKS}\n\nIt sounds like you stay calm. That is a strong habit. Tell us about a time you helped someone who was frustrated. What did you do?`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated. What did you do?`);
      // anything after the question is left out, as before
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do and how did it turn out? Take your time.`)).toBe(`${TASKS}\n\nTell us about a time you helped someone who was frustrated or confused. What did you do and how did it turn out?`);
    });

    it("leaves out of the question's paragraph a sentence that judges them, and keeps one about anything else", () => {
      const ASK = "Tell us about a time you helped someone who was frustrated. What did you do?";
      for (const judged of ["You seem very organized.", "You clearly stay calm.", "You obviously plan ahead.", "Sounds like you stay calm under pressure.", "That sounds like a lot to manage.", "That seems hard.", "That looks like a busy week.", "That must have been hard.", "That is a good habit.", "This was a nice touch.", "It was a fun project.", "You were very capable there.", "Your plan is very organised.", "You seem very capable with people.", "Your list was a strong idea.", "Thanks for sharing that with me.", "Thanks for sharing with me.", "A good answer says what you did.", "The best answers name a real person.", "We want someone who plans.", "We are looking for a real example.", "We're looking for a real example."]) {
        expect(moveTo("wq_help", `${TASKS}\n\n${judged} ${ASK}`), judged).toBe(`${TASKS}\n\n${ASK}`);
      }
      // before the job's own words too, or when what is left is only the end of them
      expect(moveTo("wq_mistake", `You helped a visitor.\n\nYou seem very capable with people. ${MISTAKE}`)).toBe(`You helped a visitor.\n\n${MISTAKE}`);
      expect(moveTo("wq_mistake", "You helped a visitor.\n\nA good answer says what changed afterwards. What did you do about it?")).toBe(`You helped a visitor.\n\n${MISTAKE}`);
      // on a follow-up too, and what is about the work stays
      expect(stayOn("wq_help", "You built a pump.\n\nIt had two sensors. That sounds fun. What did the sensor trigger?")).toBe("You built a pump.\n\nIt had two sensors. What did the sensor trigger?");
      // a word of praise in a sentence about something else is not praise
      const wind = "You run each class from a printed plan.\n\nA strong wind knocks out the power during class. What would you do first?";
      expect(moveToRoom(wind)).toBe(wind);
      expect(moveToOwn("A strong wind knocks out the power during class. What would you do first?", wind)).toBe(wind);
      expect(moveToRoom("You run each class from a printed plan.\n\nA great storm starts. A clear plan fails. How do you handle the room?")).toBe("You run each class from a printed plan.\n\nA great storm starts. A clear plan fails. How do you handle the room?");
      // the restatement keeps the rule it always had: in "About your experience" no praise reaches the candidate
      const g = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
      const experience = (messageToCandidate: string) => enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate }), chatPacket(role, g), g, {}, { transcript: said("Q", "I built a pump with an Arduino"), latest: "I built a pump with an Arduino" }).turn.messageToCandidate;
      expect(experience("You did impressive work.\n\nHow long have you explained it in English?")).toBe("How long have you explained it in English?");
      expect(experience("You built a pump.\n\nA great class wants to know. How long have you explained it in English?")).toBe("You built a pump.\n\nHow long have you explained it in English?");
    });

    it("all in one paragraph, a sentence after the restatement is left out unless it sets the scene", () => {
      expect(moveTo("wq_help", `${TASKS} You help your team with it. ${HELP}`)).toBe(`${TASKS}\n\n${HELP}`);
      const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"]);
      const close = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: `You finished the report. Your team liked it. ${CHAT_WRAP_QUESTION}` }), chatPacket(role, p), p, {}, { transcript: said("Q", "I finished the report."), latest: "I finished the report." });
      expect(close.turn.messageToCandidate).toBe(`You finished the report.\n\n${CHAT_WRAP_QUESTION}`);
      expect(moveToRoom("You explained it as a finger. Picture a class of twenty where several kits stop working. How do you handle the room?")).toBe("You explained it as a finger.\n\nPicture a class of twenty where several kits stop working. How do you handle the room?");
      // two sentences of setup at most, the last two
      expect(moveToRoom("You explained it as a finger.\n\nA kit fails. A second kit fails. A third kit fails. How do you handle the room?")).toBe("You explained it as a finger.\n\nA second kit fails. A third kit fails. How do you handle the room?");
    });

    it("says a sentence once when the restatement, what sets the question up and the question all have it", () => {
      expect(stayOn("wq_help", "You built a pump.\n\nYou built a pump. What did the sensor trigger?")).toBe("You built a pump.\n\nWhat did the sensor trigger?");
      const ROOM = "Several kits fail at once in a class of twenty. How do you handle the room?";
      expect(moveToRoom(`Several kits fail at once in a class of twenty.\n\n${ROOM}`)).toBe(ROOM);
      expect(moveToRoom(`Several kits fail at once in a class of twenty. ${ROOM}`)).toBe(ROOM);
      // the restatement is what the job's question opens with, and the job's words come back: said once
      expect(moveToRoom("Several kits fail at once in a class of twenty.\n\nHow do you handle the room?")).toBe(ROOM);
      expect(moveToRoom("Several kits fail at once in a class of twenty.")).toBe(ROOM);
      expect(moveTo("wq_mistake", "Tell us about a time you were late.\n\nTell us about a time you were late. What did you do?")).toBe("Tell us about a time you were late. What did you do?");
    });

    it("keeps a job's own question whole when the model wrote it word for word, whatever it says", () => {
      const LEAD = "You said it is like a finger.";
      for (const question of [
        "Tell us about a time you helped someone who was frustrated. What steps did you take?",
        "Walk us through your last project. Who was on the team?",
        "Give an example of a time you made a mistake at work. Be specific about what you changed.",
        "What was the hardest bug you fixed? How did you find it?",
        "Several kits fail at once. Pupils start shouting. The head teacher walks in. How do you handle the room?",
        "A strong wind cuts the power. The class is clearly scared. You seem to be the only adult. A great crowd starts to shout. What would you do first?",
      ]) {
        expect(moveToOwn(question, `${LEAD}\n\n${question}`), question).toBe(`${LEAD}\n\n${question}`);
        expect(moveToOwn(question, `${LEAD} ${question}`), question).toBe(`${LEAD}\n\n${question}`);
        expect(moveToOwn(question, question), question).toBe(question);
        // and with a blank line inside it, or something after it
        expect(moveToOwn(question, `${LEAD}\n\n${question.split(/(?<=[.?])\s+/).join("\n\n")}\n\nTake your time.`), question).toBe(`${LEAD}\n\n${question}`);
      }
      // case and spacing aside: the model's own letters are shown
      expect(moveToOwn("Several kits fail at once. How do you handle the room?", `${LEAD}\n\nSeveral  kits fail at once. how do you handle the room?`)).toBe(`${LEAD}\n\nSeveral  kits fail at once. how do you handle the room?`);
      // the sentences must be next to each other: otherwise it is read as the model's own
      expect(moveToOwn("Several kits fail at once. How do you handle the room?", `${LEAD}\n\nSeveral kits fail at once. Pupils shout. How do you handle the room?`)).toBe(`${LEAD}\n\nSeveral kits fail at once. Pupils shout. How do you handle the room?`);
      // what is before it is still held to the rules: a judgement goes, a second restatement in one breath goes, and the first restatement stays
      expect(moveToOwn("Several kits fail at once. How do you handle the room?", `${LEAD}\n\nYou seem calm. Several kits fail at once. How do you handle the room?`)).toBe(`${LEAD}\n\nSeveral kits fail at once. How do you handle the room?`);
      expect(moveToOwn("Several kits fail at once. How do you handle the room?", `${LEAD} You seem calm. Several kits fail at once. How do you handle the room?`)).toBe(`${LEAD}\n\nSeveral kits fail at once. How do you handle the room?`);
      expect(moveToOwn("Give an example of a time you made a mistake at work. What did you do about it?", `${LEAD}\n\nYou seem very capable with people. Give an example of a time you made a mistake at work. What did you do about it?`)).toBe(`${LEAD}\n\nGive an example of a time you made a mistake at work. What did you do about it?`);
    });

    it("a confused candidate, or one who asked something, gets the whole question again, on a two-sentence question and on a gap", () => {
      const ROOM = "Several kits fail at once in a class of twenty. How do you handle the room?";
      const onRoom = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"]);
      const onGap = askingNow(start(["arduino", "english"]), "english", ["arduino", "english"]);
      const lost = (p: ScreenProgress, messageToCandidate: string, questionKey: string | null) => enforceChatTurn(turnOf({ reading: "vague", questionKey, messageToCandidate }), chatPacket(role, p), p, {}, { transcript: said("Q", "What do you mean?"), latest: "What do you mean?" }).turn.messageToCandidate;
      // the model tries to move on, so the code writes "No problem. <the question>"
      expect(lost(onRoom, "Noted. Is there anything else you would like the team to know?", CHAT_WRAP_KEY)).toBe(`No problem.\n\n${ROOM}\n\n${PERSON_OFFER}`);
      expect(lost(onGap, "Noted. How would you explain a sensor?", "wq_explain")).toBe(`No problem.\n\n${gapQuestion("Explaining technical ideas in English")}\n\n${PERSON_OFFER}`);
      // the model stays and says the question itself, or in its own words
      expect(lost(onRoom, `No problem. ${ROOM}`, null)).toBe(`No problem.\n\n${ROOM}\n\n${PERSON_OFFER}`);
      expect(lost(onRoom, "No problem. Picture several kits failing at the same moment in a class of twenty. What would you do with the room?", null)).toBe(`No problem.\n\nPicture several kits failing at the same moment in a class of twenty. What would you do with the room?\n\n${PERSON_OFFER}`);
      expect(lost(onRoom, "No problem.\n\nSeveral kits stop working at the same moment. What would you do with the room?", null)).toBe(`No problem.\n\nSeveral kits stop working at the same moment. What would you do with the room?\n\n${PERSON_OFFER}`);
      // their own question is answered, and the question they were asked comes back whole
      const asks = enforceChatTurn(turnOf({ candidateAskedAbout: "schedule", messageToCandidate: `It is full time. The hours are nine to five. ${ROOM}` }), chatPacket(role, onRoom), onRoom, {}, { transcript: said("Q", "Is it full time?"), latest: "Is it full time?" });
      expect(asks.turn.messageToCandidate).toBe(`It is full time. The hours are nine to five.\n\n${ROOM}`);
      // and a push the ladder turns into a move on: what the model said of the question is no restatement
      const pushed = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"], { pushes: 1 });
      const moved = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "still vague", messageToCandidate: ROOM }), chatPacket(role, pushed), pushed, {}, { transcript: said("Q", "It was fine", "Really fine"), latest: "Really fine" });
      expect(moved.turn.messageToCandidate).toBe(CHAT_WRAP_QUESTION);
    });

    it("never says five words of a private note in a row, nor three in a sentence before the question", () => {
      const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"]);
      const leak = enforceChatTurn(turnOf({ followUpReason: "push", reading: "vague", messageToCandidate: "You calmed the room.\n\nA good trainer uses a concrete everyday analogy and checks understanding with the children. What did you do?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "I'd calm the room"), latest: "I'd calm the room" });
      expect(leak.turn.messageToCandidate).not.toMatch(/everyday analogy|checks understanding/);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nA good answer owns the mistake and says what changed afterwards. What did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      // reworded, or sharing only three words in a row with the note: left out of what sets the question up
      expect(moveTo("wq_mistake", `${VISITOR}\n\nA good answer says what changed afterwards. What did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nWe want someone who owns the mistake and explains what changed. What did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      expect(moveTo("wq_mistake", `${VISITOR} We want someone who owns the mistake and explains what changed. What did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nThe person who says what changed does well here. What did you do about it?`)).toBe(`${VISITOR}\n\n${MISTAKE}`);
      expect(stayOn("wq_mistake", "You made a mistake.\n\nA good answer says what changed afterwards. What did you do?")).toBe("You made a mistake.\n\nWhat did you do?");
      expect(stayOn("wq_mistake", "You made a mistake.\n\nThe person who says what changed does well here. What did you do?")).toBe("You made a mistake.\n\nWhat did you do?");
      // two words in common is not the note: it stays
      expect(stayOn("wq_mistake", "You made a mistake.\n\nThe mistake cost a day. What did you do?")).toBe("You made a mistake.\n\nThe mistake cost a day. What did you do?");
      // a note shorter than the run: the whole of it, even of two words, and never one word
      const HARD = "Tell us about a hard customer. What did you do?";
      expect(moveToOwn(HARD, `${TASKS}\n\nWe want someone who stays calm and listens. ${HARD}`, "stays calm and listens")).toBe(`${TASKS}\n\n${HARD}`);
      expect(moveToOwn(HARD, `${TASKS}\n\nPeople who stay calm and listen do best. ${HARD}`, "stay calm and listen")).toBe(`${TASKS}\n\n${HARD}`);
      expect(moveToOwn(HARD, `${TASKS}\n\nPeople here stay calm. ${HARD}`, "stay calm")).toBe(`${TASKS}\n\n${HARD}`);
      expect(moveToOwn(HARD, `${TASKS}\n\nPeople here stay calm. ${HARD}`, "calm")).toBe(`${TASKS}\n\nPeople here stay calm. ${HARD}`);
      // the check on the whole message reads five words in a row, as it always did: the candidate's words or the job's can
      // share a shorter run with a note by chance, and neither loses the restatement or the push for it
      expect(moveToOwn(HARD, `You stay calm and listen.\n\n${HARD}`, "stay calm and listen")).toBe(`You stay calm and listen.\n\n${HARD}`);
      expect(moveToOwn("How do you stay calm with an upset customer?", "You keep a list.\n\nHow do you stay calm with an upset customer?", "stay calm")).toBe("You keep a list.\n\nHow do you stay calm with an upset customer?");
      expect(moveToOwn(HARD, `You keep a list.\n\n${HARD}`, "they stay calm with an upset customer and listen")).toBe(`You keep a list.\n\n${HARD}`);
      // the job's own question is the company's to ask, whatever words it shares with its note: saying it is not saying the note
      expect(moveToOwn("How do you stay calm with an upset customer?", "You keep a list.\n\nHow do you stay calm with an upset customer?", "they stay calm with an upset customer and listen")).toBe("You keep a list.\n\nHow do you stay calm with an upset customer?");
      // five words of the note in the model's own words: the question goes back to its own words, alone
      expect(moveToOwn(HARD, `You stay calm with an upset customer and listen.\n\n${HARD}`, "they stay calm with an upset customer and listen")).toBe(HARD);
    });

    it("keeps the question that goes with a request, unless it asks for something else", () => {
      const LIST = "You keep a list.";
      const BUSY = "Describe a busy day. How do you decide what comes first and what can wait?";
      // a lead-in or a comma of the model's own, on a job's question that is not about the past
      expect(moveToOwn(BUSY, `${LIST}\n\nTest, describe a busy day. How do you decide what comes first and what can wait?`)).toBe(`${LIST}\n\nTest, describe a busy day. How do you decide what comes first and what can wait?`);
      expect(moveToOwn(BUSY, `${LIST}\n\nDescribe a busy day. How do you decide what comes first, and what can wait?`)).toBe(`${LIST}\n\nDescribe a busy day. How do you decide what comes first, and what can wait?`);
      expect(moveToOwn(BUSY, `${LIST}\n\nNow, describe a busy day. How do you decide what comes first, and what can wait?`)).toBe(`${LIST}\n\nNow, describe a busy day. How do you decide what comes first, and what can wait?`);
      expect(moveToOwn("Describe a time you disagreed with a coworker. What would you do differently?", `${LIST}\n\nNow, describe a time you disagreed with a coworker. What would you do differently?`)).toBe(`${LIST}\n\nNow, describe a time you disagreed with a coworker. What would you do differently?`);
      expect(moveToOwn("A patient cancels a two-hour appointment tomorrow morning. What do you do?", `${LIST}\n\nTell us about a patient cancelling a two-hour appointment tomorrow morning. What do you do?`)).toBe(`${LIST}\n\nTell us about a patient cancelling a two-hour appointment tomorrow morning. What do you do?`);
      expect(moveToRoom("You explained it as a finger.\n\nTell us about a class of twenty where several kits fail at once. How would you handle the room?")).toBe("You explained it as a finger.\n\nTell us about a class of twenty where several kits fail at once. How would you handle the room?");
      // not the job's, and in the model's own words
      expect(moveTo("wq_help", `${TASKS}\n\nTell us about your approach. What would you say to an upset customer?`)).toBe(`${TASKS}\n\nTell us about your approach. What would you say to an upset customer?`);
      // the job's own question about pay stays, however the model opens it; the model's own does not
      const PAY = "Tell us about your last job. What pay are you looking for?";
      expect(moveToOwn(PAY, `${LIST}\n\nNow, tell us about your last job. What pay are you looking for?`)).toBe(`${LIST}\n\nNow, tell us about your last job. What pay are you looking for?`);
      expect(moveToOwn(BUSY, `${LIST}\n\nNow, tell us about your last job. What pay are you looking for?`)).toBe(`${LIST}\n\nNow, tell us about your last job.`);
      // past a scene the request leads into
      expect(moveTo("wq_mistake", `${VISITOR}\n\nTell us about another day. Think of a mistake you made at work. What happened, and what did you do about it?`)).toBe(`${VISITOR}\n\nTell us about another day. Think of a mistake you made at work. What happened, and what did you do about it?`);
    });

    it("a sentence that moves on is no question: the real one still comes, whether the model wrote it or the code adds it", () => {
      const WAYS_IN = ["Let's talk about how you help people next.", "Next, let's talk about how you help people.", "I'd like to hear about how you help people.", "We'd love to hear about a different situation.", "We would love to hear more."];
      const THINK = "Test, think of a time you helped someone who was frustrated or confused. What did you do, and how did it turn out?";
      for (const way of WAYS_IN) {
        // beside the restatement, with the question in its own paragraph
        expect(moveTo("wq_help", `${TASKS} ${way}\n\n${THINK}`), way).toBe(`${TASKS}\n\n${THINK}`);
        // in the question's own paragraph: it stays, as what leads into it
        expect(moveTo("wq_help", `${TASKS}\n\n${way} ${THINK}`), way).toBe(`${TASKS}\n\n${way} ${THINK}`);
        // and with no question from the model, the code asks the job's
        expect(moveTo("wq_help", `${TASKS}\n\n${way}`), way).toBe(`${TASKS}\n\n${HELP}`);
      }
      // a question about pay, when pay is what is being asked
      const asksPay = (messageToCandidate: string) => {
        const job = jobWith([{ key: "wq_first", question: "What do you do first?", required: true }, { key: "wq_pay", question: "What pay range are you looking for?", required: true }]);
        const p = askingNow(planOf(job, []), "wq_first", ["wq_first"]);
        return enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_pay", messageToCandidate }), chatPacket(job, p), p, {}, { transcript: said("Q", "I keep a list."), latest: "I keep a list." }).turn.messageToCandidate;
      };
      expect(asksPay("You keep a list. Let's talk about pay.\n\nWhat salary are you hoping for?")).toBe("You keep a list.\n\nWhat salary are you hoping for?");
      // a job's own question of one sentence, written word for word
      expect(moveToOwn("Describe how you keep track of tasks.", "You keep a list. Let's talk about how you stay on top of things.\n\nDescribe how you keep track of tasks.")).toBe("You keep a list.\n\nDescribe how you keep track of tasks.");
      // a request said to them as the way in: nothing of the ask is lost
      for (const way of ["Tell us a bit more.", "Give an example of a hard day."]) {
        expect(moveTo("wq_help", `${way}\n\n${THINK}`), way).toBe(`${way} ${THINK}`);
        expect(moveTo("wq_mistake", `${way}\n\n${REQUESTED} What did you do and how did it turn out?`), way).toBe(`${way} ${REQUESTED} What did you do and how did it turn out?`);
        expect(moveTo("wq_mistake", `${way}\n\nDescribe a busy day. How do you decide what comes first?`), way).toBe(`${way} Describe a busy day. How do you decide what comes first?`);
        // a scene in other words leads the next paragraph, so that paragraph is the question
        expect(moveTo("wq_mistake", `${way}\n\nA patient cancels a two-hour slot tomorrow morning. What do you do?`), way).toBe("A patient cancels a two-hour slot tomorrow morning. What do you do?");
        expect(moveTo("wq_mistake", `${way}\n\nThink of a busy day. A patient cancels a slot. What do you do?`), way).toBe("Think of a busy day. A patient cancels a slot. What do you do?");
        // and a scene with no question after it is not kept
        expect(moveTo("wq_mistake", `${way}\n\nThink of a busy day.`), way).toBe(way);
      }
      // beside the restatement, the blank line one sentence later: the same one ask
      expect(moveTo("wq_mistake", `${VISITOR} Tell me about a time you made a mistake at work.\n\nWhat happened, and what did you do about it?`)).toBe(`${VISITOR}\n\nTell me about a time you made a mistake at work. What happened, and what did you do about it?`);
      expect(moveToOwn("Tell me about a time you handled an angry customer.", "You keep a list. Tell me about a time you handled an angry customer.\n\nWhat did you do?")).toBe("You keep a list.\n\nTell me about a time you handled an angry customer. What did you do?");
      expect(stayOn("wq_help", "You have not done that exactly. Tell me about something similar from your own work.\n\nWhat did you do, and what came of it?")).toBe("You have not done that exactly.\n\nTell me about something similar from your own work. What did you do, and what came of it?");
      expect(moveTo("wq_mistake", `${VISITOR} Tell me about a time you made a mistake at work.\n\nWalk me through what you did about it.`)).toBe(`${VISITOR}\n\nTell me about a time you made a mistake at work. Walk me through what you did about it.`);
      // a pay question there stays out, unless it is the job's
      expect(moveTo("wq_mistake", `${VISITOR} Tell me about a time you made a mistake at work.\n\nWhat pay are you looking for?`)).toBe(`${VISITOR}\n\nTell me about a time you made a mistake at work.`);
      // a scene a request leads through is held to the rules of any setup
      expect(moveTo("wq_mistake", `${VISITOR}\n\nTell us about another day. Think of the person who says what changed afterwards. What happened?`)).toBe(`${VISITOR}\n\nTell us about another day. What happened?`);
      expect(moveTo("wq_mistake", `${VISITOR}\n\nTell us about another day. Think of how you will hear from the team within a few days. What happened?`)).toBe(`${VISITOR}\n\nTell us about another day. What happened?`);
      // "About your experience": a word of praise in a sentence that moves on is left out like any other
      const g = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
      const experience = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: "You built a pump.\n\nI'd love to hear more about that impressive project. How do you explain it in English?" }), chatPacket(role, g), g, {}, { transcript: said("Q", "I built a pump with an Arduino"), latest: "I built a pump with an Arduino" });
      expect(experience.turn.messageToCandidate).toBe("You built a pump.\n\nHow do you explain it in English?");
    });

    it("answers the candidate's own question, whatever words the answer uses", () => {
      const AGAIN = "Now, what did you do when that person was frustrated, and how did it turn out?";
      const p = askingNow(startLive(), "wq_help", ["wq_track", "wq_help"]);
      const answering = (messageToCandidate: string, latest: string) => enforceChatTurn(turnOf({ candidateAskedAbout: "other", messageToCandidate }), chatPacket(live, p), p, {}, { transcript: said(HELP, latest), latest }).turn.messageToCandidate;
      for (const [answer, asked] of [["A person from the hiring team will get back to you about pay.", "What does it pay?"], ["Someone from the team will be in touch about pay.", "What does it pay?"], ["It is easy to reach by bus.", "Can I get there by bus?"], ["That is well within the posted range.", "Is 70k ok?"], ["You will work in a few different rooms.", "Where would I work?"]] as const) {
        expect(answering(`${answer}\n\n${AGAIN}`, asked), answer).toBe(`${answer}\n\n${AGAIN}`);
      }
      // a judgement or a time is still left out
      expect(answering(`You seem very capable.\n\n${AGAIN}`, "What does it pay?")).toBe(AGAIN);
      expect(answering(`The team will get back to you within a few days.\n\n${AGAIN}`, "When will I hear?")).toBe(AGAIN);
      expect(answering(`The team will reply in a few days.\n\n${AGAIN}`, "When will I hear?")).toBe(AGAIN);
    });

    it("keeps a scene in the second person, and one that opens with a word of praise", () => {
      const ASK = "What do you do?";
      for (const scene of ["You have two toddlers fighting over a toy.", "You have 12 kids in your class and two kits fail at once.", "You are 15 minutes late for a client meeting.", "You have a customer who does not speak English well.", "It is a busy Monday and the booking system is not working well."]) {
        expect(moveTo("wq_mistake", `${VISITOR}\n\n${scene} ${ASK}`), scene).toBe(`${VISITOR}\n\n${scene} ${ASK}`);
      }
      expect(moveTo("wq_mistake", `${VISITOR}\n\nGreat, think of a time you made a mistake at work. What happened?`)).toBe(`${VISITOR}\n\nGreat, think of a time you made a mistake at work. What happened?`);
    });

    it("never asks two things where the model wrote one: a request said to them is the question, never a restatement", () => {
      // the request and its question over two paragraphs are one ask
      expect(moveTo("wq_mistake", "Tell me about a time you made a mistake.\n\nWhat did you do about it?")).toBe("Tell me about a time you made a mistake. What did you do about it?");
      expect(moveTo("wq_help", "Tell me about a time you helped someone.\n\nWhat pay are you looking for?")).toBe("Tell me about a time you helped someone.");
      expect(stayOn("wq_help", "Give an example of a time you helped.\n\nWhat did you do?")).toBe("Give an example of a time you helped. What did you do?");
      // a second vague reply, and the model stays: the plan moves on, and the request does not go with it
      const pushed = askingNow(startLive(), "wq_help", ["wq_track", "wq_help"], { pushes: 1 });
      const second = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "still vague", messageToCandidate: "Tell me about one specific time.\n\nWhat did you do?" }), chatPacket(live, pushed), pushed, {}, { transcript: said("Q", "I sorted it out.", "I just did."), latest: "I just did." });
      expect(second.turn.messageToCandidate).toBe(MISTAKE);
      // one that could be a step they told us about is still read as one
      expect(moveTo("wq_mistake", "Share the plan with the team each morning.\n\nWhich tool do you use?")).toBe("Share the plan with the team each morning.\n\nWhich tool do you use?");
    });

    it("leaves out praise, filler, a guess, a time promise and a hint before the question, wherever the sentence stands", () => {
      const ASK = "What did you do about it next?";
      for (const out of ["Good work.", "Great work on that.", "Excellent work.", "Well done.", "Great, thanks for sharing.", "Got it, thanks.", "Okay, thank you.", "That's a smart approach.", "You handled that well.", "You're a perfect fit for this job.", "It went smoothly.", "That was easy for you.", "There were no major issues.", "The team will reply within a few days.", "The team will get back to you within a few days.", "We look for someone who stays calm under pressure.", "A great answer names the customer.", "The ideal answer names the customer.", "The hiring team is looking for someone who takes responsibility."]) {
        // in the question's own paragraph
        expect(moveTo("wq_mistake", `${VISITOR}\n\n${out} ${ASK}`), out).toBe(`${VISITOR}\n\n${ASK}`);
        // as the restatement
        expect(moveTo("wq_mistake", `${out}\n\n${ASK}`), out).toBe(ASK);
        expect(moveTo("wq_mistake", `${out} ${ASK}`), out).toBe(ASK);
      }
      // moving to the closing question too
      const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"]);
      const wrap = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: `You finished the report.\n\nThe team will get back to you within a few days. ${CHAT_WRAP_QUESTION}` }), chatPacket(role, p), p, {}, { transcript: said("Q", "I finished the report."), latest: "I finished the report." });
      expect(wrap.turn.messageToCandidate).toBe(`You finished the report.\n\n${CHAT_WRAP_QUESTION}`);
      // a scene about someone else keeps its words
      for (const scene of ["The team wants a new rota by Friday.", "A customer is looking for a missing order.", "A client moves the launch to next week.", "A patient calls within minutes of closing."]) {
        expect(moveTo("wq_mistake", `${VISITOR}\n\n${scene} ${ASK}`), scene).toBe(`${VISITOR}\n\n${scene} ${ASK}`);
      }
    });

    it("says nothing personal back to them, in the restatement or before the question", () => {
      const ASK = "What did you do about it next?";
      for (const out of ["You have two kids, so mornings suit you best.", "You are 45, so you know this work.", "Since you have two children at home, mornings suit you.", "You're a mom of three."]) {
        expect(moveTo("wq_mistake", `${VISITOR}\n\n${out} ${ASK}`), out).toBe(`${VISITOR}\n\n${ASK}`);
        expect(moveTo("wq_mistake", `${out}\n\n${ASK}`), out).toBe(ASK);
      }
      // the fairness check stops one that names their family, and the job's question is asked instead
      expect(moveTo("wq_mistake", `Your kids are at school, so you can work mornings.\n\n${ASK}`)).toBe(MISTAKE);
    });

    it("says the calm line once", () => {
      const g = askingNow(start(["arduino", "english"]), "english", ["arduino", "english"], { step: "smaller" });
      const settle = (messageToCandidate: string) => enforceChatTurn(turnOf({ reading: "not_done", questionKey: "wq_explain", messageToCandidate }), chatPacket(role, g), g, {}, { transcript: said("Q", "No"), latest: "No" });
      for (const message of [`You have not done that.\n\n${CHAT_CALM_LINE} What do you do first?`, `Okay.\n\n${CHAT_CALM_LINE} What do you do first?`, `${CHAT_CALM_LINE}\n\nWhat do you do first?`]) {
        const { turn, move } = settle(message);
        expect(move?.move, message).toBe("unknown");
        expect(turn.messageToCandidate, message).toBe(`${CHAT_CALM_LINE}\n\nWhat do you do first?`);
      }
    });

    it("the eval reads a message's question as the shaping does: a request asks, and a sentence that sets the scene does not", () => {
      for (const asks of ["Tell us about a time you were late.", "Now, walk me through it.", "Give an example of a mistake.", "Test, describe your last job.", "You built a pump.\n\nNow, tell us more.", "Think of a mistake. Tell us what you did."]) expect(asksByRequest(asks), asks).toBe(true);
      for (const none of ["Think of a time you made a mistake.", "Test, think of a time you were late.", "Picture a class of twenty.", "First, explain the problem.", "Then, describe the fix.", "Finally, share a story.", "Lastly, tell me more.", "Explained it as a thirsty finger.", "Described the fix to the team.", "Shared a list with the team.", "Tell users to restart.", "Give a warm welcome.", "You said share it."]) expect(asksByRequest(none), none).toBe(false);
    });
  });

  it("one push only: a second push moves on to the next item, the candidate's own words recorded as the answer", () => {
    const p = askingNow(start(["arduino", "english"]), "arduino", ["arduino"], { pushes: 1 });
    const { turn, move } = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "still vague", messageToCandidate: "You handled the wiring. Can you say more?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Yes", "I handled it well"), latest: "I handled it well" });
    expect(move).toEqual({ key: "arduino", move: "covered" });
    expect(turn).toMatchObject({ questionKey: "english", followUpReason: null, done: false, answerRecorded: { questionKey: "arduino", answer: "Yes I handled it well", complete: true } });
    expect(turn.messageToCandidate).toBe(`You handled the wiring.\n\n${gapQuestion("Explaining technical ideas in English")}`);
    const next = advanceProgress(p, turn, move);
    expect(next.chat?.items.slice(0, 2).map((i) => i.state)).toEqual(["covered", "asking"]);
  });

  it("'No' climbs the ladder whatever the model read: the analog, the smaller version, then not known with a calm line, recording nothing for a skill", () => {
    let p = askingNow(start(["arduino", "english"]), "english", ["arduino", "english"]);
    const pk = chatPacket(role, p);
    // the model read "No" as an answer and moved on: the code holds it to the analog
    const a = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_explain", messageToCandidate: "Understood. How would you explain a sensor?" }), pk, p, {}, { transcript: said("Q", "No"), latest: "No" });
    // moving on early is fine (less pressing): settled as not known, with the calm line, nothing recorded
    expect(a.move).toEqual({ key: "english", move: "unknown" });
    expect(a.turn.messageToCandidate).toBe(`${CHAT_CALM_LINE}\n\nHow would you explain a sensor?`);
    expect(a.turn.answerRecorded).toBeNull();
    // a follow-up with no question: the analog in code's words
    const b = enforceChatTurn(turnOf({ followUpReason: "ladder", messageToCandidate: "Understood." }), pk, p, {}, { transcript: said("Q", "No, I haven't"), latest: "No, I haven't" });
    expect(b.move).toEqual({ key: "english", move: "analog" });
    expect(b.turn.messageToCandidate).toBe(CHAT_LADDER_QUESTION.analog);
    p = advanceProgress(p, b.turn, b.move);
    expect(p.chat?.items[1]).toMatchObject({ state: "asking", step: "analog" });
    const c = enforceChatTurn(turnOf({ followUpReason: "ladder", reading: "not_done", messageToCandidate: "Got it. Even a small moment?" }), pk, p, {}, { transcript: said("Q", "No", "Not really"), latest: "Not really" });
    expect(c.move).toEqual({ key: "english", move: "smaller" });
    expect(c.turn.messageToCandidate).toBe("Even a small moment?");
    p = advanceProgress(p, c.turn, c.move);
    // at the smaller version a third "No" settles it, even if the model asks again, and a recorded "No" is dropped
    const d = enforceChatTurn(turnOf({ followUpReason: "again", reading: "not_done", answerRecorded: { questionKey: "english", answer: "No", complete: true }, messageToCandidate: "It seems you lack English experience. Are you sure?" }), pk, p, {}, { transcript: said("Q", "No", "Not really", "No"), latest: "No" });
    expect(d.move).toEqual({ key: "english", move: "unknown" });
    expect(d.turn).toMatchObject({ questionKey: "wq_explain", answerRecorded: null, followUpReason: null });
    expect(d.turn.messageToCandidate).toBe(`${CHAT_CALM_LINE}\n\nHow would you explain what a sensor is to six-year-olds?`);
    p = advanceProgress(p, d.turn, d.move);
    expect(p.chat?.items[1].state).toBe("unknown");
    expect(p.chat?.section).toBe("required");
    expect(chatCounter(p.chat)?.label).toBe("Question 3 of 4");
  });

  // The code check of 25 November 2026: every must-have climbed the ladder, so someone who said they hold no licence was
  // asked for "something similar from your own work" and then for "a small moment". A licence is held or it is not.
  it("a must-have that names a licence is asked once and its answer taken: 'No' is the answer, with no analog and no smaller version; any other must-have keeps its ladder", () => {
    const licensed = { ...role, requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "r" }, ...base.requirements.mustHaves], niceToHaves: [] } } as unknown as RolePacket;
    const onLicence = askingNow(planOf(licensed, ["licence", "english"]), "licence", ["licence"]);
    const pk = chatPacket(licensed, onLicence);
    const LICENCE_ASK = "This is one of the things the job needs: Active CA RDH license. Do you have it?";
    const ENGLISH_ASK = gapQuestion("Explaining technical ideas in English");
    expect(pk.screening.questions.slice(0, 2).map((x) => x.question)).toEqual([LICENCE_ASK, ENGLISH_ASK]);
    // the model is told which items have a ladder: the licence has none, the other must-have and an open question do
    expect(chatPromptOf(pk, onLicence.chat!, "licence", facts.cv).items.map((i) => [i.key, i.ladder])).toEqual([["licence", false], ["english", true], ["wq_explain", true], ["wq_room", true]]);
    // a model that climbs the ladder all the same: the code moves on, and "No" is recorded as the answer
    const pressed = enforceChatTurn(turnOf({ reading: "not_done", followUpReason: "the analog", messageToCandidate: CHAT_LADDER_QUESTION.analog }), pk, onLicence, {}, { transcript: said("Q", "No"), latest: "No" });
    expect(pressed.move).toEqual({ key: "licence", move: "covered" });
    expect(pressed.turn).toMatchObject({ questionKey: "english", followUpReason: null, done: false, answerRecorded: { questionKey: "licence", answer: "No", complete: true } });
    expect(pressed.turn.messageToCandidate).toBe(ENGLISH_ASK);
    for (const smaller of [CHAT_LADDER_QUESTION.smaller, "Got it. Even a small moment?"]) {
      const again = enforceChatTurn(turnOf({ reading: "not_done", followUpReason: "the smaller version", messageToCandidate: smaller }), pk, onLicence, {}, { transcript: said("Q", "I don't"), latest: "I don't" });
      expect(again.move, smaller).toEqual({ key: "licence", move: "covered" });
      expect(again.turn.messageToCandidate, smaller).not.toMatch(/similar|small moment/i);
      expect(again.turn.answerRecorded, smaller).toEqual({ questionKey: "licence", answer: "I don't", complete: true });
    }
    // a model that takes the answer: its calm line stands, the next item is asked, and the "No" is on record
    const taken = enforceChatTurn(turnOf({ reading: "not_done", questionKey: "english", messageToCandidate: `${CHAT_CALM_LINE}\n\n${ENGLISH_ASK}` }), pk, onLicence, {}, { transcript: said("Q", "No"), latest: "No" });
    expect(taken.move).toEqual({ key: "licence", move: "covered" });
    expect(taken.turn.answerRecorded).toEqual({ questionKey: "licence", answer: "No", complete: true });
    expect(taken.turn.messageToCandidate).toBe(`${CHAT_CALM_LINE}\n\n${ENGLISH_ASK}`);
    const next = advanceProgress(onLicence, taken.turn, taken.move);
    expect(next.chat?.items.slice(0, 2).map((i) => [i.key, i.state, i.step])).toEqual([["licence", "covered", "direct"], ["english", "asking", "direct"]]);
    // a bare "Yes" is its answer too: asked once, with no push for a specific time
    const yes = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: `You said yes.\n\n${CHAT_LADDER_QUESTION.push}` }), pk, onLicence, {}, { transcript: said("Q", "Yes"), latest: "Yes" });
    expect(yes.move).toEqual({ key: "licence", move: "covered" });
    expect(yes.turn).toMatchObject({ questionKey: "english", answerRecorded: { questionKey: "licence", answer: "Yes", complete: true } });
    expect(yes.turn.messageToCandidate).toBe(`You said yes.\n\n${ENGLISH_ASK}`);
    // the other must-have of the same job, which names no licence, still gets "something similar"
    const onEnglish = askingNow(planOf(licensed, ["licence", "english"]), "english", ["licence", "english"]);
    const open = enforceChatTurn(turnOf({ followUpReason: "ladder", messageToCandidate: "Understood." }), chatPacket(licensed, onEnglish), onEnglish, {}, { transcript: said("Q", "No"), latest: "No" });
    expect(open.move).toEqual({ key: "english", move: "analog" });
    expect(open.turn.messageToCandidate).toBe(CHAT_LADDER_QUESTION.analog);
    expect(open.turn.answerRecorded).toBeNull();
  });

  it("records nothing while an item is still being asked, whatever a turn still carries in answerRecorded (Wave S9: the real model recorded a bare 'yes' on the push)", () => {
    const p = askingNow(start(["arduino", "english"]), "arduino", ["arduino"]);
    const push = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", answerRecorded: { questionKey: "arduino", answer: "Yes", complete: false }, messageToCandidate: "You said yes.\n\nCould you tell me about one specific time?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Yes"), latest: "Yes" });
    expect(push.move).toEqual({ key: "arduino", move: "push" });
    expect(push.turn.answerRecorded).toBeNull();
    // the analog and the smaller version too: a "No" on the way never stands as the answer for a skill
    const e = askingNow(start(["arduino", "english"]), "english", ["arduino", "english"]);
    const analog = enforceChatTurn(turnOf({ reading: "not_done", followUpReason: "ladder", answerRecorded: { questionKey: "english", answer: "No, I haven't", complete: true }, messageToCandidate: "Not done that exactly? Tell me about something similar from your own work." }), chatPacket(role, e), e, {}, { transcript: said("Q", "No, I haven't"), latest: "No, I haven't" });
    expect(analog.move).toEqual({ key: "english", move: "analog" });
    expect(analog.turn.answerRecorded).toBeNull();
    const s = advanceProgress(e, analog.turn, analog.move);
    const smaller = enforceChatTurn(turnOf({ reading: "not_done", followUpReason: "ladder", answerRecorded: { questionKey: "english", answer: "No, I haven't Not really", complete: true }, messageToCandidate: "Even a small moment?" }), chatPacket(role, s), s, {}, { transcript: said("Q", "No, I haven't", "Not really"), latest: "Not really" });
    expect(smaller.move).toEqual({ key: "english", move: "smaller" });
    expect(smaller.turn.answerRecorded).toBeNull();
    // words with something in them are kept while the push is asked, so "Keep my answer and move on" keeps them (E11)
    const some = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: "Could you tell me about one specific time?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Cleanings and charting"), latest: "Cleanings and charting" });
    expect(some.move).toEqual({ key: "arduino", move: "push" });
    expect(some.turn.answerRecorded).toEqual({ questionKey: "arduino", answer: "Cleanings and charting", complete: false });
    // once the item settles, every reply about it is its answer
    const q = advanceProgress(p, push.turn, push.move);
    const settled = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: "You built a pump." }), chatPacket(role, q), q, {}, { transcript: said("Q", "Yes", "I built a water pump with an Arduino at CUST"), latest: "I built a water pump with an Arduino at CUST" });
    expect(settled.turn.answerRecorded).toEqual({ questionKey: "arduino", answer: "Yes I built a water pump with an Arduino at CUST", complete: true });
    // a confused reply or a question of their own on the way is never part of it, and never keeps a bare "yes" on the
    // push from reading as nothing (Wave S9 review)
    const lostThenYes = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", answerRecorded: { questionKey: "arduino", answer: "??? what do you mean Yes", complete: false }, messageToCandidate: "Could you tell me about one specific time?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "??? what do you mean", "Yes"), latest: "Yes" });
    expect(lostThenYes.move).toEqual({ key: "arduino", move: "push" });
    expect(lostThenYes.turn.answerRecorded).toBeNull();
    const settledAfter = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: "You built a pump." }), chatPacket(role, q), q, {}, { transcript: said("Q", "??? what do you mean", "Yes", "Is it full time?", "I built a water pump with an Arduino."), latest: "I built a water pump with an Arduino." });
    expect(settledAfter.turn.answerRecorded).toEqual({ questionKey: "arduino", answer: "Yes I built a water pump with an Arduino.", complete: true });
  });

  it("a confused candidate gets the item's question again and the offer of a person; a question they ask is never read as their reply (Wave S9)", () => {
    const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const lost = enforceChatTurn(turnOf({ reading: "vague", questionKey: "wq_room", answerRecorded: { questionKey: "wq_explain", answer: "??? what do you mean", complete: false }, messageToCandidate: "Noted. Several kits fail at once in a class of twenty. How do you handle the room?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "??? what do you mean"), latest: "??? what do you mean" });
    expect(lost.move).toBeNull();
    expect(lost.turn).toMatchObject({ sentiment: "confused", questionKey: null, answerRecorded: null, done: false });
    expect(lost.turn.messageToCandidate).toBe(`No problem.\n\nHow would you explain what a sensor is to six-year-olds?\n\n${PERSON_OFFER}`);
    expect(advanceProgress(p, lost.turn, lost.move).currentQuestionKey).toBe("wq_explain");
    // their own question: nothing read, nothing recorded, the item still asked
    const asks = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "push", answerRecorded: { questionKey: "wq_explain", answer: "Is it full time?", complete: false }, messageToCandidate: "A person can tell you more about that. How would you explain a sensor to six-year-olds?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Is it full time?"), latest: "Is it full time?" });
    expect(asks.move).toBeNull();
    expect(asks.turn.answerRecorded).toBeNull();
    expect(advanceProgress(p, asks.turn, asks.move).chat?.items.find((i) => i.key === "wq_explain")).toMatchObject({ state: "asking", pushes: 0 });
  });

  // The code check of 25 November 2026: the model was asked for a record of each answer, and the code used it only when
  // no reply of the candidate's was usable. It is asked for none now, so with no usable reply nothing is recorded.
  it("with no usable reply nothing is recorded, whatever a turn still carries: one of the job's questions then shows as not answered on check-your-answers", () => {
    const p = askingNow(start([]), "wq_explain", ["wq_explain"], { pushes: 1 });
    // a reply that only shows they did not follow, which the model read as frustration and as an answer
    const r = enforceChatTurn(turnOf({ sentiment: "frustrated", reading: "concrete", questionKey: "wq_room", answerRecorded: { questionKey: "wq_explain", answer: "They would explain it with an example.", complete: true }, messageToCandidate: "You would explain it with an example.\n\nSeveral kits fail at once in a class of twenty. How do you handle the room?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Huh"), latest: "Huh" });
    expect(r.move).toEqual({ key: "wq_explain", move: "covered" });
    expect(r.turn.answerRecorded).toBeNull();
    expect(r.turn.questionKey).toBe("wq_room");
    expect(reviewItems({ answers: {}, progress: advanceProgress(p, r.turn, r.move) }, role).map((i) => [i.key, i.status, i.answer])).toEqual([["wq_explain", "unanswered", null], ["wq_room", "unanswered", null]]);
  });

  // "Their question is never their answer", and what else the same message says is still theirs. The model used to be
  // asked to record that part ("record only that part, in their words"); the code keeps it now.
  it("a message that answers and also asks something: the answer is kept as theirs, the question left out, whether the turn stays on the question or leaves it", () => {
    const job = { ...role, screening: { questions: [{ key: "weekends", question: "Can you work weekends?", kind: "availability" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 } } as unknown as RolePacket;
    const p = askingNow(planOf(job, []), "weekends", ["weekends"]);
    const pk = chatPacket(job, p);
    const both = "Yes, both days. What does it pay?";
    const ANSWERS = "The hiring team can discuss pay with you.";
    // the model answers their question and asks the same question again: their words are kept while it is asked
    const stays = enforceChatTurn(turnOf({ candidateAskedAbout: "pay", followUpReason: "back to the question", messageToCandidate: `${ANSWERS}\n\nCan you work weekends?` }), pk, p, {}, { transcript: said("Q", both), latest: both });
    expect(stays.move).toBeNull();
    expect(stays.turn).toMatchObject({ questionKey: null, done: false, answerRecorded: { questionKey: "weekends", answer: "Yes, both days.", complete: false } });
    expect(stays.turn.messageToCandidate).toBe(`${ANSWERS}\n\nCan you work weekends?`);
    // and when they answer again the answer is every reply of theirs, the question they asked still left out
    const again = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "pay", messageToCandidate: "You can work both days.\n\nWhat pay range are you looking for?" }), pk, advanceProgress(p, stays.turn, stays.move), { weekends: "Yes, both days." }, { transcript: said("Q", both, "Saturdays and Sundays."), latest: "Saturdays and Sundays." });
    expect(again.turn.answerRecorded).toEqual({ questionKey: "weekends", answer: "Yes, both days. Saturdays and Sundays.", complete: true });
    // the model answers their question and moves on: their words are the answer
    const leaves = enforceChatTurn(turnOf({ candidateAskedAbout: "pay", questionKey: "pay", messageToCandidate: `${ANSWERS}\n\nWhat pay range are you looking for?` }), pk, p, {}, { transcript: said("Q", both), latest: both });
    expect(leaves.turn).toMatchObject({ questionKey: "pay", answerRecorded: { questionKey: "weekends", answer: "Yes, both days.", complete: true } });
    // a message that only asks is no answer, whatever the turn does or still carries
    const asks = enforceChatTurn(turnOf({ candidateAskedAbout: "pay", questionKey: "pay", answerRecorded: { questionKey: "weekends", answer: "What does it pay?", complete: true }, messageToCandidate: `${ANSWERS}\n\nWhat pay range are you looking for?` }), pk, p, {}, { transcript: said("Q", "What does it pay?"), latest: "What does it pay?" });
    expect(asks.turn.answerRecorded).toBeNull();
    // a plain "No" about a skill, said beside a question, is never kept as its answer (as on the ladder)
    const g = askingNow(start(["arduino", "english"]), "english", ["arduino", "english"]);
    const no = enforceChatTurn(turnOf({ candidateAskedAbout: "pay", questionKey: "wq_explain", messageToCandidate: `${ANSWERS}\n\nHow would you explain what a sensor is to six-year-olds?` }), chatPacket(role, g), g, {}, { transcript: said("Q", "No. What does it pay?"), latest: "No. What does it pay?" });
    expect(no.turn).toMatchObject({ questionKey: "wq_explain", answerRecorded: null });
    // while "No" to a yes-or-no question is its answer there too
    const plainNo = enforceChatTurn(turnOf({ candidateAskedAbout: "pay", questionKey: "pay", messageToCandidate: `${ANSWERS}\n\nWhat pay range are you looking for?` }), pk, p, {}, { transcript: said("Q", "No. What does it pay?"), latest: "No. What does it pay?" });
    expect(plainNo.turn.answerRecorded).toEqual({ questionKey: "weekends", answer: "No.", complete: true });
  });

  it("the closing answer is every usable reply since the closing question was asked, never a question they asked on the way", () => {
    const p = askingNow(start([]), CHAT_WRAP_KEY, ["wq_explain", "wq_room", CHAT_WRAP_KEY]);
    const transcript: ScreenTranscriptEntry[] = [
      { role: "assistant", content: CHAT_WRAP_QUESTION, at, questionKey: CHAT_WRAP_KEY },
      { role: "candidate", content: "When will I hear back?", at },
      { role: "assistant", content: `The hiring team can tell you that.\n\n${CHAT_WRAP_QUESTION}`, at },
      { role: "candidate", content: "I can start in two weeks. Is that soon enough?", at },
    ];
    const end = enforceChatTurn(turnOf({ done: true, answerRecorded: { questionKey: CHAT_WRAP_KEY, answer: "Can start soon.", complete: true }, messageToCandidate: "Thank you, Meerub. You explained sensors as a thirsty finger." }), chatPacket(role, p), p, {}, { transcript, latest: "I can start in two weeks. Is that soon enough?" });
    expect(end.turn).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: CHAT_WRAP_KEY, answer: "I can start in two weeks.", complete: true } });
  });

  it("a written question: the analog, then not known, keeping their own words; a yes-or-no question takes 'No' as its answer", () => {
    const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"], { step: "analog" });
    const r = enforceChatTurn(turnOf({ followUpReason: "again", reading: "not_done", messageToCandidate: "Could you try once more?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "No", "No"), latest: "No" });
    expect(r.move).toEqual({ key: "wq_room", move: "unknown" });
    expect(r.turn).toMatchObject({ questionKey: CHAT_WRAP_KEY, answerRecorded: { questionKey: "wq_room", answer: "No No", complete: false } });
    const old = { ...role, screening: { questions: [{ key: "weekends", question: "Can you work weekends?", kind: "availability" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 } } as unknown as RolePacket;
    const q = askingNow(planOf(old, []), "weekends", ["weekends"]);
    const yn = enforceChatTurn(turnOf({ questionKey: "pay", reading: "not_done", messageToCandidate: "Noted, weekends are out." }), chatPacket(old, q), q, {}, { transcript: said("Q", "No"), latest: "No" });
    expect(yn.move).toEqual({ key: "weekends", move: "covered" });
    expect(yn.turn.answerRecorded).toEqual({ questionKey: "weekends", answer: "No", complete: true });
    expect(yn.turn.messageToCandidate).toBe("Noted, weekends are out.\n\nWhat pay range are you looking for?");
  });

  it("the closing question's answer brings the close (one concrete thing, never a question); a close before the end goes on to what is left", () => {
    const p = askingNow(start([]), CHAT_WRAP_KEY, ["wq_explain", "wq_room", CHAT_WRAP_KEY]);
    const end = enforceChatTurn(turnOf({ questionKey: null, messageToCandidate: "Thank you, Meerub. You explained sensors as a thirsty finger. It sounds like you would be a great teacher. Anything else?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "No, nothing else"), latest: "No, nothing else" });
    expect(end.turn).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: CHAT_WRAP_KEY, answer: "No, nothing else" } });
    expect(end.turn.messageToCandidate).toBe("Thank you, Meerub. You explained sensors as a thirsty finger.");
    expect(chatClosingMessage(end.turn.messageToCandidate, "Robotronics")).toBe(`Thank you, Meerub. You explained sensors as a thirsty finger.\n\n${chatNextLine("Robotronics")}`);
    expect(chatNextLine("Robotronics")).toBe("Next, check what you are sending and change anything you like, then press Send my answers. Nothing goes to Robotronics until you do.");
    // done too early: the code's plan goes on
    const early = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const r = enforceChatTurn(turnOf({ done: true, reading: "concrete", messageToCandidate: "Thanks, that's everything." }), chatPacket(role, early), early, {}, { transcript: said("Q", "Like a thirsty finger that feels the water"), latest: "Like a thirsty finger that feels the water" });
    expect(r.turn).toMatchObject({ done: false, questionKey: "wq_room" });
    expect(r.turn.messageToCandidate).toBe("Several kits fail at once in a class of twenty. How do you handle the room?");
  });

  /**
   * The plan is the code's (the code check of 25 November 2026). On the live site that day a job's form had asked about a
   * certificate, the plan still held it, and the model went past it to the closing question; the code held the plan only
   * against a close, so whether an item of the plan was asked rested on the model.
   */
  describe("where a turn goes is the plan's to say, never the model's", () => {
    /** The robotics job with a certificate among its must-haves, and its plan as the app builds it: the job's questions, then the must-haves the resume does not show. */
    const certified = { ...role, requirements: { mustHaves: [{ key: "cpr", text: "Current CPR certificate", rationale: "r" }, ...base.requirements.mustHaves], niceToHaves: [] } } as unknown as RolePacket;
    const planned = (): ScreenProgress => ({ ...EMPTY_SCREEN_PROGRESS, chat: chatPlanFor(certified, readingOf(["arduino"]), at) });
    const ROOM = "Several kits fail at once in a class of twenty. How do you handle the room?";
    const CPR_ASK = "This is one of the things the job needs: Current CPR certificate. Do you have it?";
    const PAPER = "I would get the class on a paper task and fix the kits one at a time.";
    const CLOSING = `Meerub, ${CHAT_WRAP_QUESTION[0]!.toLowerCase()}${CHAT_WRAP_QUESTION.slice(1)}`;

    it("the plan is the job's questions, then the must-haves to ask about", () => {
      expect(planned().chat?.items.map((i) => [i.key, i.kind])).toEqual([["wq_explain", "question"], ["wq_room", "question"], ["cpr", "gap"], ["english", "gap"]]);
    });

    it("a turn that goes to the closing question with a must-have still open asks that must-have: the model's restatement, then the question in the job's own words", () => {
      const p = askingNow(planned(), "wq_room", ["wq_explain", "wq_room"]);
      const early = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: `You would put the class on a paper task.\n\n${CLOSING}` }), chatPacket(certified, p), p, {}, { transcript: said("Q", PAPER), latest: PAPER });
      expect(early.move).toEqual({ key: "wq_room", move: "covered" });
      expect(early.turn).toMatchObject({ questionKey: "cpr", done: false, followUpReason: null, answerRecorded: { questionKey: "wq_room", answer: PAPER } });
      expect(early.turn.messageToCandidate).toBe(`You would put the class on a paper task.\n\n${CPR_ASK}`);
      const next = advanceProgress(p, early.turn, early.move);
      expect(next.currentQuestionKey).toBe("cpr");
      expect(next.chat?.items.map((i) => i.state)).toEqual(["covered", "covered", "asking", "open"]);
      expect(chatCounter(next.chat)?.label).toBe("Question 3 of 4");
      // all in one paragraph, and with no restatement at all: the same question, in the job's words
      const inOne = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: `You would put the class on a paper task. ${CLOSING}` }), chatPacket(certified, p), p, {}, { transcript: said("Q", PAPER), latest: PAPER });
      expect(inOne.turn.messageToCandidate).toBe(`You would put the class on a paper task.\n\n${CPR_ASK}`);
      const bare = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: CLOSING }), chatPacket(certified, p), p, {}, { transcript: said("Q", PAPER), latest: PAPER });
      expect(bare.turn).toMatchObject({ questionKey: "cpr", done: false });
      expect(bare.turn.messageToCandidate).toBe(CPR_ASK);
      // the last must-have answered: only now the closing question, as the model wrote it
      const last = askingNow(planned(), "english", ["wq_explain", "wq_room", "cpr", "english"]);
      const end = enforceChatTurn(turnOf({ reading: "concrete", questionKey: CHAT_WRAP_KEY, messageToCandidate: `You ran a weekend club in English.\n\n${CLOSING}` }), chatPacket(certified, last), last, {}, { transcript: said("Q", "For two years I ran a weekend robotics club in English."), latest: "For two years I ran a weekend robotics club in English." });
      expect(end.turn.questionKey).toBe(CHAT_WRAP_KEY);
      expect(end.turn.messageToCandidate).toBe(`You ran a weekend club in English.\n\n${CLOSING}`);
    });

    it("a turn that jumps over an item, or goes back to one already asked, asks the first one still open", () => {
      const p = askingNow(planned(), "wq_explain", ["wq_explain"]);
      const finger = "Like a thirsty finger that feels when the soil is dry.";
      const over = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "cpr", messageToCandidate: `You would call it a thirsty finger.\n\n${CPR_ASK}` }), chatPacket(certified, p), p, {}, { transcript: said("Q", finger), latest: finger });
      expect(over.move).toEqual({ key: "wq_explain", move: "covered" });
      expect(over.turn).toMatchObject({ questionKey: "wq_room", done: false });
      expect(over.turn.messageToCandidate).toBe(`You would call it a thirsty finger.\n\n${ROOM}`);
      // in the model's own words for the item it jumped to: none of them is said
      const reworded = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "english", messageToCandidate: "You would call it a thirsty finger.\n\nTell me about a time you explained something technical in English. What did you say?" }), chatPacket(certified, p), p, {}, { transcript: said("Q", finger), latest: finger });
      expect(reworded.turn.questionKey).toBe("wq_room");
      expect(reworded.turn.messageToCandidate).toBe(`You would call it a thirsty finger.\n\n${ROOM}`);
      // back to the first question, already asked and answered: the plan goes on
      const onRoom = askingNow(planned(), "wq_room", ["wq_explain", "wq_room"]);
      const back = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_explain", messageToCandidate: "You would put the class on a paper task.\n\nHow would you explain what a sensor is to six-year-olds?" }), chatPacket(certified, onRoom), onRoom, { wq_explain: finger }, { transcript: said("Q", PAPER), latest: PAPER });
      expect(back.turn).toMatchObject({ questionKey: "cpr", done: false });
      expect(back.turn.messageToCandidate).toBe(`You would put the class on a paper task.\n\n${CPR_ASK}`);
      // after "No" to an item with a ladder, settled as not known: the calm line, then the first one still open
      const onEnglish = askingNow(planned(), "english", ["wq_explain", "wq_room", "cpr", "english"], { step: "smaller" });
      const settled = enforceChatTurn(turnOf({ reading: "not_done", questionKey: "wq_room", messageToCandidate: "You have not done that.\n\nHow do you handle the room?" }), chatPacket(certified, onEnglish), onEnglish, {}, { transcript: said("Q", "No"), latest: "No" });
      expect(settled.move).toEqual({ key: "english", move: "unknown" });
      expect(settled.turn.questionKey).toBe(CHAT_WRAP_KEY);
      expect(settled.turn.messageToCandidate).toBe(`${CHAT_CALM_LINE}\n\n${CHAT_WRAP_QUESTION}`);
    });

    it("the model may still stay on the item where the ladder allows, and a turn that follows the plan is left as the model wrote it", () => {
      const p = askingNow(planned(), "wq_room", ["wq_explain", "wq_room"]);
      const push = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "nothing specific yet", messageToCandidate: "You would handle it.\n\nWhat would you do first?" }), chatPacket(certified, p), p, {}, { transcript: said("Q", "I'd handle it"), latest: "I'd handle it" });
      expect(push.move).toEqual({ key: "wq_room", move: "push" });
      expect(push.turn.questionKey).toBeNull();
      expect(push.turn.messageToCandidate).toBe("You would handle it.\n\nWhat would you do first?");
      const follows = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "cpr", messageToCandidate: "You would put the class on a paper task.\n\nThe job needs a current CPR certificate. Do you hold one?" }), chatPacket(certified, p), p, {}, { transcript: said("Q", PAPER), latest: PAPER });
      expect(follows.turn.questionKey).toBe("cpr");
      expect(follows.turn.messageToCandidate).toBe("You would put the class on a paper task.\n\nThe job needs a current CPR certificate. Do you hold one?");
    });

    it("at the closing question nothing is left to go to: a turn that names another question stays on it", () => {
      const p = askingNow(planned(), CHAT_WRAP_KEY, ["wq_explain", "wq_room", "cpr", "english", CHAT_WRAP_KEY]);
      const asks = "Is it full time?";
      const back = enforceChatTurn(turnOf({ candidateAskedAbout: "schedule", questionKey: "wq_room", messageToCandidate: `It is full time.\n\n${ROOM}` }), chatPacket(certified, p), p, {}, { transcript: said("Q", asks), latest: asks });
      expect(back.move).toBeNull();
      expect(back.turn).toMatchObject({ questionKey: null, done: false, answerRecorded: null });
      expect(back.turn.messageToCandidate).toBe(`It is full time.\n\n${CHAT_WRAP_QUESTION}`);
      expect(advanceProgress(p, back.turn, back.move).currentQuestionKey).toBe(CHAT_WRAP_KEY);
      // their answer to the closing question brings the close, wherever the model points
      const closes = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "wq_room", messageToCandidate: `Thank you, Meerub. You would put the class on a paper task.\n\n${ROOM}` }), chatPacket(certified, p), p, {}, { transcript: said("Q", "No, that is everything."), latest: "No, that is everything." });
      expect(closes.turn).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: CHAT_WRAP_KEY, answer: "No, that is everything." } });
      expect(closes.turn.messageToCandidate).toBe("Thank you, Meerub. You would put the class on a paper task.");
    });

    // A chat stored before the plan was held this way can stand on an item with the closing question already asked (the
    // model could go back). It carries on: the item's answer is taken, and with nothing left to ask the questions end.
    it("a chat from before that went back after the closing question ends when the item it stands on is answered, never on another question already asked", () => {
      const p = askingNow(planned(), "wq_room", ["wq_explain", "cpr", "english", CHAT_WRAP_KEY, "wq_room"]);
      expect(p.currentQuestionKey).toBe("wq_room");
      const again = enforceChatTurn(turnOf({ reading: "concrete", questionKey: "cpr", messageToCandidate: `You would put the class on a paper task.\n\n${CPR_ASK}` }), chatPacket(certified, p), p, { wq_explain: "a", cpr: "Yes", english: "b", [CHAT_WRAP_KEY]: "c" }, { transcript: said("Q", PAPER), latest: PAPER });
      expect(again.move).toEqual({ key: "wq_room", move: "covered" });
      expect(again.turn).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: "wq_room", answer: PAPER } });
      expect(again.turn.messageToCandidate).toBe("You would put the class on a paper task.");
      expect(advanceProgress(p, again.turn, again.move)).toMatchObject({ currentQuestionKey: null });
    });

    it("a whole chat follows the plan to the closing question and the close, whatever each turn of the model says about where to go", () => {
      let p = planned();
      const first = nextQuestion(chatPacket(certified, p), p, {})!;
      p = advanceProgress(p, turnOf({ questionKey: first.key, messageToCandidate: first.question }));
      const transcript: ScreenTranscriptEntry[] = [{ role: "assistant", content: first.question, at, questionKey: first.key }];
      const asked = [first.key];
      const answers: Record<string, string> = {};
      // a model that never follows the plan: the closing question, the last item, the first one again, a close, the closing question
      const strays: Array<Partial<ScreenTurn>> = [{ questionKey: CHAT_WRAP_KEY }, { questionKey: "english" }, { questionKey: "wq_explain" }, { done: true }, { questionKey: CHAT_WRAP_KEY }];
      let closed = false;
      for (let n = 0; n < strays.length && !closed; n++) {
        const reply = `Reply ${n + 1}: what I did, and what came of it.`;
        transcript.push({ role: "candidate", content: reply, at });
        const { turn, move } = enforceChatTurn(turnOf({ reading: "concrete", messageToCandidate: "You told me what you did.\n\nWhat else would you add?", ...strays[n] }), chatPacket(certified, p), p, answers, { transcript, latest: reply });
        if (turn.answerRecorded) answers[turn.answerRecorded.questionKey] = turn.answerRecorded.answer;
        p = advanceProgress(p, turn, move);
        transcript.push({ role: "assistant", content: turn.messageToCandidate || "(the close)", at, ...(turn.questionKey ? { questionKey: turn.questionKey } : {}) });
        if (turn.questionKey) asked.push(turn.questionKey);
        closed = turn.done;
      }
      expect(asked).toEqual(["wq_explain", "wq_room", "cpr", "english", CHAT_WRAP_KEY]);
      expect(closed).toBe(true);
      expect(p.chat?.items.map((i) => [i.key, i.state])).toEqual([["wq_explain", "covered"], ["wq_room", "covered"], ["cpr", "covered"], ["english", "covered"]]);
      expect(chatCounter(p.chat)?.label).toBe("All 4 questions done");
      expect(Object.keys(answers)).toEqual(["wq_explain", "wq_room", "cpr", "english", CHAT_WRAP_KEY]);
      // each question was asked in the job's own words, the certificate once and as yes or no
      const shown = transcript.filter((t) => t.role === "assistant").map((t) => t.content);
      expect(shown[1]).toBe(`You told me what you did.\n\n${ROOM}`);
      expect(shown[2]).toBe(`You told me what you did.\n\n${CPR_ASK}`);
      expect(shown[3]).toBe(`You told me what you did.\n\n${gapQuestion("Explaining technical ideas in English")}`);
      expect(shown[4]).toBe(CHAT_WRAP_QUESTION);
    });
  });

  it("never says the team's private note, even in part, and still runs the fairness check on every question", () => {
    const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const leak = enforceChatTurn(turnOf({ followUpReason: "push", reading: "vague", messageToCandidate: "Thanks. Would you use a concrete everyday analogy and checks understanding with the children?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "I'd explain it"), latest: "I'd explain it" });
    expect(leak.turn.messageToCandidate).toBe("How would you explain what a sensor is to six-year-olds?");
    expect(leak.turn.messageToCandidate).not.toMatch(/analogy|checks understanding/);
    const unfair = enforceChatTurn(turnOf({ followUpReason: "push", reading: "vague", messageToCandidate: "You mentioned school runs. How old are your kids?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "After school runs"), latest: "After school runs" });
    expect(unfair.turn.messageToCandidate).not.toMatch(/kids|old/);
    expect(unfair.turn.questionKey).toBe("wq_room");
    expect(unfair.turn.messageToCandidate).toBe("Several kits fail at once in a class of twenty. How do you handle the room?");
  });

  it("never says any question's note: not another question's while asking this one, and not in the close (review of Wave S7)", () => {
    // asking wq_room while quoting wq_explain's note
    const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"]);
    const other = enforceChatTurn(turnOf({ followUpReason: "push", reading: "vague", messageToCandidate: "Good. Did you use a concrete everyday analogy and check understanding with the children? What did you do first?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "I'd calm the room"), latest: "I'd calm the room" });
    expect(other.turn.messageToCandidate).not.toMatch(/everyday analogy|checks? understanding/);
    // a close that repeats a note says only what happens next
    const w = askingNow(start([]), CHAT_WRAP_KEY, ["wq_explain", "wq_room", CHAT_WRAP_KEY]);
    const end = enforceChatTurn(turnOf({ questionKey: null, messageToCandidate: "Thank you. You uses a concrete everyday analogy and checks understanding with the children." }), chatPacket(role, w), w, {}, { transcript: said("Q", "No, nothing else"), latest: "No, nothing else" });
    expect(end.turn.done).toBe(true);
    expect(end.turn.messageToCandidate).toBe("");
    expect(chatClosingMessage(end.turn.messageToCandidate, "Robotronics")).toBe(chatNextLine("Robotronics"));
  });

  it("holds the chat's own questions to the questions a company may never set (review of Wave S7)", () => {
    for (const unfair of ["Are you over 40?", "Are you a green card holder?", "Where did you grow up?", "Are you a veteran?", "Do you have any physical limitations?"]) expect(unfairQuestion(unfair), unfair).not.toBeNull();
    const p = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const turned = enforceChatTurn(turnOf({ followUpReason: "push", reading: "vague", messageToCandidate: "Thanks. Where did you grow up?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "I'd explain it"), latest: "I'd explain it" });
    expect(turned.turn.messageToCandidate).not.toMatch(/grow up/);
  });

  it("leaves out of what is recorded the ways people mention parenthood, military service and where they come from (review of Wave S7)", () => {
    for (const s of ["As a mom of three I know scheduling.", "I'm a veteran and I led a squad of 8.", "I moved here from Mexico in 2010 and have worked in dental since."]) {
      expect(redactProtected(s), s).toBe("(answer recorded; personal details omitted)");
      expect(redactProtected(`I chart in Dentrix every day. ${s}`), s).toBe("I chart in Dentrix every day.");
    }
    // work stays: a move between practices, and talking about patients' parents
    expect(redactProtected("I moved from Smile Bright to Coastal Dental last year.")).toBe("I moved from Smile Bright to Coastal Dental last year.");
    expect(redactProtected("I calm the parents of a nervous child.")).toBe("I calm the parents of a nervous child.");
  });
});

describe("the chat's line after a tap or a skip, in code (22 Oct 2026 try-out)", () => {
  it("says a tap back in the assistant's voice, neutral, never the candidate's own 'I'", () => {
    // the try-out read "Noted: I'm looking for $18 to $20 an hour." and "Noted: I can start on Monday, November 16, 2026."
    expect(chatCodeLead("I'm looking for $18 to $20 an hour.")).toBe("Noted: $18 to $20 an hour.");
    expect(chatCodeLead("I can start on Monday, November 16, 2026.")).toBe("Noted: you could start on Monday, November 16, 2026.");
    expect(chatCodeLead("I can work Monday, Tuesday and Saturday.")).toBe("Noted: you can work Monday, Tuesday and Saturday.");
    expect(chatCodeLead("Yes")).toBe("Noted: Yes.");
    expect(chatCodeLead("No")).toBe("Noted: No.");
    // words of any other shape in the first person are not said back
    expect(chatCodeLead("I'd rather discuss it on a call.")).toBe("Noted.");
    for (const line of ["I'm looking for $48 an hour.", "I can start on Friday, October 23, 2026.", "I can work Sunday."].map((w) => chatCodeLead(w))) {
      expect(line).not.toMatch(/\b(?:I|I'm|my)\b/);
      expect(line).not.toMatch(/\b(?:great|perfect|excellent|thanks)\b/i);
    }
    // a skip says the same as before
    expect(chatCodeLead(null)).toBe("No problem, we can leave that one.");
    expect(chatCodeLead(null, true)).toBe("No problem, your answer is kept.");
  });
});

/**
 * The live test of 12 November 2026: the Dental Assistant's "Which certifications do you hold, such as x-ray, coronal
 * polishing, RDA or BLS?" came with Yes and No, because every question of kind eligibility got them. Now only a question
 * whose words ask yes or no does, across the sample jobs, and a tap posted from a page that still showed them saves nothing.
 */
describe("Yes and No in the AI interview only for a question asked as yes or no (live test, 12 November 2026)", () => {
  const comp = { basis: "hourly" as const, currency: "USD" };
  const asQuestion = (q: { question: string; kind: string }) => q as Pick<ScreeningQuestion, "kind" | "question">;
  const dental = SAMPLE_QUESTIONS.find((p) => p.vertical === "dental")!;
  const roleQuestion = (role: string, key: string) => dental.roles.find((r) => r.key === role)!.screeningQuestions.find((q) => q.key === key)!;

  it("no sample question that asks them to name, list or describe something gets the buttons", () => {
    const all = SAMPLE_QUESTIONS.flatMap((p) => p.roles.flatMap((r) => r.screeningQuestions.map((q) => ({ role: `${p.vertical} ${r.key}`, ...q }))));
    expect(all.length).toBeGreaterThan(20);
    for (const q of all.filter((x) => /\b(which|what|how|who|tell|describe|list|explain)\b/i.test(x.question))) expect(tapFormatFor(asQuestion(q), comp)?.kind, `${q.role}: ${q.question}`).not.toBe("yes_no");
    // the Dental Assistant's certificates are typed, while the hygienist's licence question keeps its buttons
    const certs = roleQuestion("da", "certs");
    expect(certs.kind).toBe("eligibility");
    expect(tapFormatFor(asQuestion(certs), comp)).toBeNull();
    expect(tapFormatFor(asQuestion(roleQuestion("rdh", "license_confirm")), comp)).toEqual({ kind: "yes_no" });
  });

  // The review of the live-test fixes: the form's licence questions end "in the state where this office is located", and
  // a chat change or the owner can ask one in the AI interview instead, where its "where" took the buttons away.
  it("every sample form question asked in the AI interview keeps Yes and No", () => {
    const form = SAMPLE_QUESTIONS.flatMap((p) => p.roles.flatMap((r) => r.formQuestions.map((e) => ({ role: `${p.vertical} ${r.key}`, question: e.question }))));
    expect(form.filter((q) => /\bwhere\b/.test(q.question)).length).toBeGreaterThanOrEqual(3);
    for (const q of form) expect(tapFormatFor(asQuestion({ question: q.question, kind: "eligibility" }), comp), `${q.role}: ${q.question}`).toEqual({ kind: "yes_no" });
  });

  it("a Yes posted for the certificates question fits nothing, so nothing is saved; the check-your-answers page offers the box", () => {
    const certs = roleQuestion("da", "certs");
    const packet = { screening: { questions: [{ key: certs.key, question: "Which certifications do you hold, such as x-ray, coronal polishing, RDA or BLS?", kind: "eligibility" }], maxMinutes: 10 }, compensation: { basis: "hourly", currency: "USD", min: 23, max: 28 } } as unknown as RolePacket;
    const progress: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: [certs.key], currentQuestionKey: certs.key };
    expect(currentTapFormat(packet, progress)).toBeNull();
    expect(tapWords(packet, progress, { kind: "yes_no", choice: "yes" })).toBeNull();
    expect(reviewItems({ answers: { [certs.key]: "X-ray and BLS." }, progress }, packet)[0]).toMatchObject({ key: certs.key, answer: "X-ray and BLS.", tap: null });
  });
});
