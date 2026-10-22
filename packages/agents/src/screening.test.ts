import { describe, expect, it } from "vitest";
import type { RolePacket, ScreenAssessment, ScreenProgress, ScreenTranscriptEntry, ScreenTurn } from "@ros/contracts";
import { FakeProvider, screenAssessPrompt, screenTurnPrompt, type RunOutcome, type ScreenContext } from "@ros/ai";
import { CHAT_WRAP_KEY, chatCounter } from "@ros/core";
import {
  CHAT_CALM_LINE, CHAT_LADDER_QUESTION, CHAT_WRAP_QUESTION, CONFUSED_OFFER, EMPTY_SCREEN_PROGRESS, NOT_ASKED_NOTE, SCORECARD_READINGS, SCREEN_COMPLETE_MESSAGE, SCREEN_NEXT_LINE, TURN_CAP_CLOSE_MESSAGE, WITHDRAW_CONFIRM_KEY, advanceProgress, candidateWordsOf, chatClosingMessage, chatCodeLead, chatFactsFor, chatGaps, chatNextLine, chatOpening, chatPacket, enforceChatTurn, enforceTurnRules, gapQuestion,
  newScreenProgress, nextQuestion, onlyQuestions, plainCredentialAnswers, recruiterNotesOf, redactProtected, reviewItems, saidByCandidate, scorecardReadings, screenAnswerOf, screenCommand, screenContextOf, screenIntro, seemsConfused, settledScreenRecommendation, verifyScreenQuotes, withAskedSkills, withChatPlan, withdrawPending, type ChatFacts,
} from "./screening";
import { answerInContext, credentialMustHaves } from "./triage";
import { FOCUS_INTRO, focusQuestionsFrom, focusedPacket, packetForFocusedInvite, unfairQuestion } from "./screen-focus";
import { registerFakeHandlers } from "./fake-handlers";

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

  it("every close the code writes says people decide and they will hear either way, never when", () => {
    const progress = asking("availability", { availability: 2 }, ["experience", "availability"]);
    const closes = [enforceTurnRules(followUp, packet, progress, { experience: "Six years." }).messageToCandidate, SCREEN_COMPLETE_MESSAGE, TURN_CAP_CLOSE_MESSAGE, `No problem. That is everything I needed. ${SCREEN_NEXT_LINE}`];
    for (const close of closes) {
      expect(close).toMatch(/you will hear from them either way/);
      expect(close).not.toMatch(/few days|within|shortly|soon/);
      // still short enough for one text message
      expect(close.length).toBeLessThan(300);
    }
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

/**
 * Wave E: the packet's questions in the packet's own words (E2), skipped questions left alone (E11), the progress the
 * code keeps (the flow, skips, edits, the allowance count) carried through every turn, and the "check your answers" page.
 */
describe("the conversation offered with the application", () => {
  const three = { screening: { questions: [{ key: "license", question: "Is your RDH license active in California?", kind: "eligibility" }, { key: "experience", question: "Tell me about your most recent work.", kind: "skills" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 }, compensation: { basis: "hourly", currency: "USD", min: 45, max: 55 }, identity: { title: "Registered Dental Hygienist" }, communication: { humanAlternativeText: "Reply HUMAN to reach a person.", disclosureText: "Sent with help from an AI assistant." } } as unknown as RolePacket;
  const move: ScreenTurn = { messageToCandidate: "Thanks, that helps.", questionKey: "experience", answerRecorded: { questionKey: "license", answer: "Yes, active since 2015.", complete: true }, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false };

  it("adds the next packet question word for word after the model's acknowledgment, and never twice", () => {
    const t = enforceTurnRules(move, three, { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license"], currentQuestionKey: "license" }, {});
    expect(t.messageToCandidate).toBe("Thanks, that helps. Tell me about your most recent work.");
    const already = enforceTurnRules({ ...move, messageToCandidate: "Thanks. Tell me about your most recent work." }, three, { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license"], currentQuestionKey: "license" }, {});
    expect(already.messageToCandidate).toBe("Thanks. Tell me about your most recent work.");
    // how an answer was recorded is the code's to say: a status the model sets is dropped
    const claimed = enforceTurnRules({ ...move, answerRecorded: { ...move.answerRecorded!, status: "edited" } }, three, { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license"], currentQuestionKey: "license" }, {});
    expect(claimed.answerRecorded).toEqual({ questionKey: "license", answer: "Yes, active since 2015.", complete: true });
  });

  it("a skipped question is never asked again, and counts toward the end of the questions", () => {
    const progress: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license", "experience"], currentQuestionKey: "experience", declined: ["license"] };
    const backToSkipped = enforceTurnRules({ ...move, answerRecorded: { questionKey: "experience", answer: "Eight patients a day.", complete: true }, questionKey: "license" }, three, progress, {});
    expect(backToSkipped.questionKey).toBeNull();
    expect(nextQuestion(three, progress, { experience: "Eight patients a day." })?.key).toBe("pay");
    expect(nextQuestion(three, { ...progress, askedKeys: ["license", "experience", "pay"] }, { experience: "x", pay: "y" })).toBeNull();
  });

  it("every turn carries over what the code keeps", () => {
    const progress: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit", declined: ["pay"], edits: { license: 1 }, countedAt: "2026-10-08T10:00:00.000Z", askedKeys: ["license"], currentQuestionKey: "license" };
    const next = advanceProgress(progress, enforceTurnRules(move, three, progress, {}));
    expect(next).toMatchObject({ flow: "one_visit", declined: ["pay"], edits: { license: 1 }, countedAt: "2026-10-08T10:00:00.000Z", currentQuestionKey: "experience", askedKeys: ["license", "experience"] });
  });

  it("the check-your-answers page lists every question with its answer and how it came to be", () => {
    const items = reviewItems({ answers: { license: "Yes", experience: "Eight patients a day." }, progress: { ...EMPTY_SCREEN_PROGRESS, declined: ["pay"], edits: { experience: 1 } } }, three);
    expect(items.map((i) => [i.key, i.status, i.answer])).toEqual([["license", "answered", "Yes"], ["experience", "edited", "Eight patients a day."], ["pay", "declined", null]]);
    expect(items[0].tap).toEqual({ kind: "yes_no" });
    expect(items[2].tap).toMatchObject({ kind: "pay_range" });
  });

  it("the fixed introduction is built from the notice, the packet and the counts, never by the model", () => {
    const intro = screenIntro({ companyName: "Harbor Dental", firstName: "Dana", packet: three });
    expect(intro.disclosure).toContain("Harbor Dental's hiring assistant, a software program");
    expect(intro.disclosure).toContain("3 short questions");
    expect(intro.disclosure).toMatch(/people on the team make every decision/i);
    expect(intro.aiNotice?.text).toMatch(/artificial intelligence/);
    expect(intro).toMatchObject({ questions: 3, minutes: 10, humanAlternative: "Reply HUMAN to reach a person.", packetDisclosure: "Sent with help from an AI assistant." });
    expect(intro.disclosure).not.toContain("about your background");
    // a conversation that starts with the résumé reading's open questions says so, as an emailed invitation's always did
    expect(screenIntro({ companyName: "Harbor Dental", firstName: "Dana", packet: three, focus: true }).disclosure).toContain("We will start with a few quick questions about your background, then the usual screening questions.");
  });
});

describe("the scorecard keeps a recruiter's call notes apart from the candidate's words (E3) and skipped questions unknown (E11)", () => {
  const screen = {
    transcript: [
      { role: "assistant" as const, content: "Is your license active?", at: "t", questionKey: "license" },
      { role: "candidate" as const, content: "Yes, active since 2015.", at: "t" },
      { role: "recruiter" as const, content: "Called her: she has done perio maintenance for six years.", at: "t", source: "recruiter_call" as const },
    ],
    answers: { license: "Yes, active since 2015." },
    progress: { ...EMPTY_SCREEN_PROGRESS, declined: ["pay"] },
  };
  const card = (over: Partial<ScreenAssessment>): ScreenAssessment => ({ overall: "potential", confidence: "high", summary: "s", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", rationale: "r", ...over });

  it("the candidate's words never include the notes; the notes are checked as their own source", () => {
    expect(candidateWordsOf(screen)).not.toContain("perio maintenance");
    expect(recruiterNotesOf(screen)).toContain("perio maintenance");
    const out = verifyScreenQuotes(card({
      strengths: [
        { claim: "Perio experience", evidence: { source: "recruiter_note", quote: "she has done perio maintenance for six years" } },
        { claim: "Perio experience in her words", evidence: { source: "screen", quote: "she has done perio maintenance for six years" } },
      ],
      requirementFindings: [{ requirementKey: "mh_perio", met: "no", evidence: { source: "recruiter_note", quote: "she has done perio maintenance for six years" } }],
      questionFindings: [{ questionKey: "pay", answered: true, finding: "Wants $60", evidence: { source: "screen", quote: "Yes, active since 2015." }, meetsModelAnswer: "no" }],
    }), candidateWordsOf(screen), { recruiterNotes: recruiterNotesOf(screen), declined: ["pay"] });
    // the note stands as a note; the same words passed off as the candidate's are dropped
    expect(out.strengths.map((s) => s.evidence.source)).toEqual(["recruiter_note"]);
    // a recruiter's note never makes a must-have "no"
    expect(out.requirementFindings[0].met).toBe("unknown");
    // a skipped question is unknown, whatever the model wrote
    expect(out.questionFindings[0]).toEqual({ questionKey: "pay", answered: false, finding: "Skipped by the candidate: unknown.", meetsModelAnswer: "unknown" });
  });

  it("a question with an answer on record keeps it, even if it was also marked skipped (a skip during a follow-up moves on)", () => {
    const finding = { questionKey: "license", answered: true, finding: "Active since 2015", evidence: { source: "screen" as const, quote: "Yes, active since 2015." }, meetsModelAnswer: "yes" as const };
    const out = verifyScreenQuotes(card({ questionFindings: [finding] }), candidateWordsOf(screen), { declined: ["license"], answered: ["license"] });
    expect(out.questionFindings[0]).toEqual(finding);
  });

  it("the assistant writing to the candidate never sees a recruiter's call notes; the scorecard does, labelled as notes", () => {
    const packet = { identity: { title: "Registered Dental Hygienist", employmentType: "full_time", locations: [{ city: "Irvine", region: "CA" }] }, compensation: { basis: "hourly", min: 45, max: 55, currency: "USD", discloseRange: true }, screening: { questions: [{ key: "license", question: "Is your license active?", kind: "eligibility" }], maxMinutes: 10 }, competencies: [], requirements: { mustHaves: [] }, communication: { candidateMayBeTold: [], tone: "warm", humanAlternativeText: "Reply HUMAN." }, interviews: { plan: [] } } as unknown as RolePacket;
    const ctx: ScreenContext = { company: { name: "Harbor Dental" }, packet, candidate: { firstName: "Dana" }, channel: "web", progress: { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["license"], currentQuestionKey: "license" }, answers: {}, transcript: screen.transcript, focusUnknowns: [], latestCandidateMessage: "Is the job still open?" };
    const turn = screenTurnPrompt.messages(ctx).map((m) => m.content).join("\n");
    expect(turn).toContain("candidate: Yes, active since 2015.");
    expect(turn).not.toContain("perio maintenance for six years");
    expect(turn).not.toContain("recruiter note");
    expect(screenAssessPrompt.messages(ctx).map((m) => m.content).join("\n")).toContain("recruiter note: Called her: she has done perio maintenance for six years.");
  });
});

describe("the scorecard trusts only what the candidate sent (known bug 13)", () => {
  const card = (over: Partial<ScreenAssessment>): ScreenAssessment => ({ overall: "potential", confidence: "high", summary: "s", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", rationale: "r", ...over });
  const screen = {
    transcript: [
      { role: "assistant" as const, content: "Tell me about your most recent work.", at: "t", questionKey: "experience" },
      { role: "candidate" as const, content: "Hygiene at a family practice.", at: "t" },
      { role: "assistant" as const, content: "How many patients a day?", at: "t" },
      { role: "candidate" as const, content: "About nine a day, with perio charting.", at: "t" },
    ],
    // as the assistant recorded it: the two messages joined, and a paraphrase it made up for another question
    answers: { experience: "Hygiene at a family practice. About nine a day, with perio charting.", leadership: "I led a team of six hygienists" },
    progress: EMPTY_SCREEN_PROGRESS,
  };

  it("never counts the assistant's recorded answers as the candidate's words, but finds a whole answer they sent over two messages", () => {
    expect(candidateWordsOf(screen)).not.toContain("led a team");
    expect(saidByCandidate("I led a team of six hygienists", candidateWordsOf(screen))).toBe(false);
    expect(saidByCandidate("Hygiene at a family practice. About nine a day, with perio charting.", candidateWordsOf(screen))).toBe(true);
    const out = verifyScreenQuotes(card({ strengths: [{ claim: "Leads a team", evidence: { source: "screen", quote: "I led a team of six hygienists" } }, { claim: "Busy practice", evidence: { source: "screen", quote: "About nine a day, with perio charting" } }] }), candidateWordsOf(screen));
    expect(out.strengths.map((s) => s.claim)).toEqual(["Busy practice"]);
  });

  it("finds an answer with a personal sentence left out, sentence by sentence", () => {
    const said = "I have six years in hygiene. My kids are at school till three. I do perio charting daily.";
    expect(saidByCandidate("I have six years in hygiene. I do perio charting daily.", said)).toBe(true);
    expect(saidByCandidate("I have six years in hygiene. I run the practice.", said)).toBe(false);
  });

  it("a lone 'yes' is no quote: the claim stays, marked 'no quote', and never scores in full", () => {
    const out = verifyScreenQuotes(card({ requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "screen", quote: "Yes" } }, { requirementKey: "perio", met: "no", evidence: { source: "screen", quote: "No." } }] }), "Yes\nNo.");
    expect(out.requirementFindings[0]).toEqual({ requirementKey: "licence", met: "yes", evidence: { source: "screen", unquoted: true } });
    expect(out.requirementFindings[1].met).toBe("unknown");
  });

  it("reads a short answer with the closed question it replies to, when that question is about the finding (review of Wave S5)", () => {
    const chat = [
      { role: "assistant" as const, content: "Thanks. Next: Do you hold a California RDH license?", at: "t", questionKey: "licence" },
      { role: "candidate" as const, content: "Yes", at: "t" },
      { role: "assistant" as const, content: "Can you work Saturdays?", at: "t", questionKey: "saturdays" },
      { role: "candidate" as const, content: "No.", at: "t" },
    ];
    const subjects = new Map([["licence", "Active California RDH license"], ["perio", "Periodontal charting"]]);
    const opts = { transcript: chat, subjects, credentials: new Set(["licence"]) };
    const said = candidateWordsOf({ transcript: chat, answers: {}, progress: EMPTY_SCREEN_PROGRESS });
    const yes = verifyScreenQuotes(card({ requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "screen", quote: "Yes" } }] }), said, opts);
    // the "Yes" answers the licence question: it stays, quoted, so it counts in full
    expect(yes.requirementFindings[0]).toEqual({ requirementKey: "licence", met: "yes", evidence: { source: "screen", quote: "Yes" } });
    // a "No." to a question about something else is still too short to show anything about periodontal charting
    const other = verifyScreenQuotes(card({ requirementFindings: [{ requirementKey: "perio", met: "no", evidence: { source: "screen", quote: "No." } }] }), said, opts);
    expect(other.requirementFindings[0].met).toBe("unknown");
    // a bare "No" to the licence question says plainly the licence is not held
    const no = [chat[0]!, { role: "candidate" as const, content: "No", at: "t" }];
    const plain = verifyScreenQuotes(card({ requirementFindings: [{ requirementKey: "licence", met: "no", evidence: { source: "screen", quote: "No" } }] }), "No", { ...opts, transcript: no });
    expect(plain.requirementFindings[0]).toMatchObject({ met: "no", evidence: { source: "screen", quote: "No" } });
    expect(screenAnswerOf("No", "Active California RDH license", no)).toBe("I do not hold a California RDH license");
    expect(screenAnswerOf("No", null, no)).toBeNull();
    expect(answerInContext("Is your license active?", "Maybe")).toBeNull();
  });
});

/**
 * Wave S9 (the first real-model run of the scorecard): a plain "Yes" or "No" to the closed question about a credential
 * is a plain answer, settled in code whatever each reading wrote (the founder's licence rule: a plain yes is yes, a
 * plain no is no), and left to the model whenever the candidate said anything more about it.
 */
describe("a plain yes or no to the licence question settles the licence", () => {
  const packet = { requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["screen"] }, { key: "perio", text: "Periodontal charting", rationale: "r", evidencedBy: ["screen"] }], niceToHaves: [], eligibility: [] }, competencies: [] } as unknown as RolePacket;
  const subjects = new Map([["licence", "Active CA RDH license"], ["permit", "California local anesthesia permit"]]);
  const at = "2026-10-15T10:00:00.000Z";
  const asked = (content: string, questionKey?: string): ScreenTranscriptEntry => ({ role: "assistant", content, at, ...(questionKey ? { questionKey } : {}) });
  const said = (content: string, over: Partial<ScreenTranscriptEntry> = {}): ScreenTranscriptEntry => ({ role: "candidate", content, at, ...over });
  const LICENCE_Q = asked("Do you hold a California RDH license?", "licence_check");
  const card = (requirementFindings: ScreenAssessment["requirementFindings"]): ScreenAssessment => ({ overall: "potential", confidence: "medium", summary: "s", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings, anomalies: [], questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", rationale: "r" });
  const ok = (output: ScreenAssessment, runId: string): RunOutcome<ScreenAssessment> => ({ ok: true, output, runId, model: "m" });
  const shown = (transcript: ScreenTranscriptEntry[], readings: ScreenAssessment[]) => {
    const out = scorecardReadings(readings.map((r, i) => ok(r, `r${i + 1}`)), { restore: (s: string) => s }, { transcript, answers: {}, progress: EMPTY_SCREEN_PROGRESS }, packet);
    if (!out.ok) throw new Error("expected a scorecard");
    return out.output.requirementFindings.find((f) => f.requirementKey === "licence");
  };
  // what the real model wrote (15 Oct 2026): "unknown" with nothing quoted, or the licence left out
  const unread = [card([{ requirementKey: "licence", met: "unknown" }]), card([]), card([{ requirementKey: "licence", met: "unknown", evidence: { source: "screen", quote: "Yes" } }])];

  it("a bare 'Yes' is 'yes', quoted as sent, whatever each reading wrote; a bare 'No' is 'no'", () => {
    expect(shown([LICENCE_Q, said("Yes")], unread)).toEqual({ requirementKey: "licence", met: "yes", evidence: { source: "screen", quote: "Yes" } });
    expect(shown([LICENCE_Q, said("No")], unread)).toEqual({ requirementKey: "licence", met: "no", evidence: { source: "screen", quote: "No" } });
    // a model quote with a full stop the candidate never typed fails the quote check, and the answer still settles it
    expect(shown([LICENCE_Q, said("Yes")], [0, 1, 2].map(() => card([{ requirementKey: "licence", met: "yes", evidence: { source: "screen", quote: "Yes." } }])))).toMatchObject({ met: "yes", evidence: { quote: "Yes" } });
    // and the reasons say why
    const out = scorecardReadings(unread.map((r, i) => ok(r, `r${i + 1}`)), { restore: (s: string) => s }, { transcript: [LICENCE_Q, said("Yes")], answers: {}, progress: EMPTY_SCREEN_PROGRESS }, packet);
    if (out.ok) expect(out.output.confidenceReasons?.at(-1)).toBe("a licence or certificate is read from the candidate's plain yes or no to the question about it");
  });

  it("is left to the model when they said more about it, changed it, or said elsewhere it lapsed", () => {
    // a lapse said while the question was asked, or later in the chat
    expect(plainCredentialAnswers([LICENCE_Q, said("Yes"), asked("Is it current?"), said("It lapsed in June.")], credentialMustHaves(packet), subjects).size).toBe(0);
    expect(plainCredentialAnswers([LICENCE_Q, said("Yes"), asked("Which days can you work?", "days"), said("Monday to Friday. My RDH license lapsed in June though.")], credentialMustHaves(packet), subjects).size).toBe(0);
    expect(shown([LICENCE_Q, said("Yes"), asked("Is it current?"), said("It lapsed in June.")], unread)).toMatchObject({ met: "unknown" });
    // an answer changed on "check your answers"
    expect(plainCredentialAnswers([LICENCE_Q, said("Yes"), asked("Which days can you work?", "days"), said("Monday to Friday."), said("No", { questionKey: "licence_check", source: "edit" })], credentialMustHaves(packet), subjects).size).toBe(0);
    // a plain "No" with anything else said about the licence elsewhere
    expect(plainCredentialAnswers([LICENCE_Q, said("No"), asked("Which days can you work?", "days"), said("Any day. I have an RDH license in Nevada.")], credentialMustHaves(packet), subjects).size).toBe(0);
    // a question of their own or a confused reply on the way changes nothing
    expect([...plainCredentialAnswers([LICENCE_Q, said("What do you mean?"), asked("Do you hold a California RDH license? Reply HUMAN for a person."), said("Yes I do")], credentialMustHaves(packet), subjects)]).toEqual([["licence", { met: "yes", quote: "Yes I do" }]]);
    // a yes or no with another word in it is not plain: the model reads it, so a lapsed, pending or out-of-state licence
    // is never settled as "yes" or "no" from its first word (Wave S9 review; the licence rule)
    for (const m of ["Yes, lapsed", "Yes, expired", "Yes, pending", "Yes, in Nevada", "Yes, Nevada.", "No, pending", "No, it lapsed", "No, expired"]) expect(plainCredentialAnswers([LICENCE_Q, said(m)], credentialMustHaves(packet), subjects).size, m).toBe(0);
    expect(shown([LICENCE_Q, said("Yes, lapsed")], unread)).toMatchObject({ met: "unknown" });
    expect(shown([LICENCE_Q, said("No, pending")], unread)).toMatchObject({ met: "unknown" });
    for (const m of ["Yes", "Yes.", "Yes I do", "yes, I have.", "Yep!", "No, I don't", "No", "I do"]) expect(plainCredentialAnswers([LICENCE_Q, said(m)], credentialMustHaves(packet), subjects).size, m).toBe(1);
  });

  it("a 'Yes' to another question never settles the licence, and a 'Yes' to the licence question never settles a permit", () => {
    expect(plainCredentialAnswers([asked("Can you work Saturdays?", "saturdays"), said("Yes")], credentialMustHaves(packet), subjects).size).toBe(0);
    expect(shown([asked("Can you work Saturdays?", "saturdays"), said("Yes")], unread)).toMatchObject({ met: "unknown" });
    const two = plainCredentialAnswers([LICENCE_Q, said("Yes")], new Set(["licence", "permit"]), subjects);
    expect([...two.keys()]).toEqual(["licence"]);
    expect([...plainCredentialAnswers([asked("Do you hold a local anesthesia permit?", "permit_check"), said("No")], new Set(["licence", "permit"]), subjects)]).toEqual([["permit", { met: "no", quote: "No" }]]);
    // a must-have worded apart from the question ("CA dental hygienist" for "California RDH") is still the only licence
    const worded = new Map([["hyg", "Active CA dental hygienist license"], ["driver", "Valid driver's license"]]);
    expect([...plainCredentialAnswers([LICENCE_Q, said("Yes")], new Set(["hyg"]), worded)]).toEqual([["hyg", { met: "yes", quote: "Yes" }]]);
    // and with two licences it fits neither better: left to the model
    expect(plainCredentialAnswers([LICENCE_Q, said("Yes")], new Set(["hyg", "driver"]), worded).size).toBe(0);
    // a "No" to an active licence is not said plainly: unknown (the licence rule), never "no"
    expect(plainCredentialAnswers([asked("Do you have an active RDH license?", "licence_check"), said("No")], credentialMustHaves(packet), subjects).get("licence")).toEqual({ met: "unknown", quote: "No" });
    // a question about an everyday licence of another kind is never about the job's only licence (Wave S9 review)
    expect(plainCredentialAnswers([asked("Do you have a valid driver's license?", "drive"), said("Yes")], credentialMustHaves(packet), subjects).size).toBe(0);
    const rn = new Map([["rn", "Active RN license"]]);
    for (const q of ["Do you have a valid driver's license and a reliable car?", "Are you licensed to drive a forklift?"]) expect(plainCredentialAnswers([asked(q, "drive"), said("Yes")], new Set(["rn"]), rn).size, q).toBe(0);
    // while the question about the job's own licence still settles it
    expect([...plainCredentialAnswers([asked("Do you hold an RN license?", "rn_check"), said("Yes")], new Set(["rn"]), rn)]).toEqual([["rn", { met: "yes", quote: "Yes" }]]);
  });
});

describe("the scorecard is read three times, like the résumé (known bugs 20 and 106)", () => {
  const packet = { requirements: { mustHaves: [{ key: "licence", text: "Active CA RDH license", rationale: "law", evidencedBy: ["screen"] }], niceToHaves: [], eligibility: [] }, competencies: [{ key: "chairside", name: "Chairside", definition: "d", weight: 5, evaluatedIn: "both", indicators: ["x"] }, { key: "leadership", name: "Leadership", definition: "d", weight: 3, evaluatedIn: "interview", indicators: ["x"] }] } as unknown as RolePacket;
  const said = "My RDH license expired last spring and the renewal is in progress.\nI anticipate the next instrument every time.";
  const screen = { transcript: said.split("\n").map((content) => ({ role: "candidate" as const, content, at: "t" })), answers: {}, progress: EMPTY_SCREEN_PROGRESS };
  const view = { restore: (s: string) => s };
  const card = (met: "yes" | "no" | "unknown", chairside: "evidenced" | "partially_evidenced", over: Partial<ScreenAssessment> = {}): ScreenAssessment => ({ overall: "potential", confidence: "medium", summary: `licence ${met}`, strengths: [], concerns: [], unknowns: [], competencyFindings: [{ competencyKey: "chairside", finding: chairside, evidence: { source: "screen", quote: "I anticipate the next instrument every time" } }, { competencyKey: "leadership", finding: "evidenced", evidence: { source: "screen", quote: "I anticipate the next instrument every time" } }], requirementFindings: [{ requirementKey: "licence", met, ...(met === "unknown" ? {} : { evidence: { source: "screen" as const, quote: "My RDH license expired last spring" } }) }], anomalies: [], questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", rationale: "r", ...over });
  const ok = (output: ScreenAssessment, runId: string): RunOutcome<ScreenAssessment> => ({ ok: true, output, runId, model: "m" });

  it("keeps the middle answer, holds the licence to the licence rule, and leaves out skills for the interviews", () => {
    const out = scorecardReadings([ok(card("no", "evidenced"), "r1"), ok(card("yes", "partially_evidenced"), "r2"), ok(card("unknown", "evidenced"), "r3")], view, screen, packet);
    if (!out.ok) throw new Error("expected a scorecard");
    // an expired licence is "unknown" whatever each reading said, so the middle is too
    expect(out.output.requirementFindings.map((f) => `${f.requirementKey}:${f.met}`)).toEqual(["licence:unknown"]);
    expect(out.output.competencyFindings.map((f) => `${f.competencyKey}:${f.finding}`)).toEqual(["chairside:evidenced"]);
    expect(out.runId).toBe("r1");
    // and the same whatever order they come back in
    const again = scorecardReadings([ok(card("unknown", "evidenced"), "r3"), ok(card("no", "evidenced"), "r1"), ok(card("yes", "partially_evidenced"), "r2")], view, screen, packet);
    if (!again.ok) throw new Error("expected a scorecard");
    expect(again.output.requirementFindings).toEqual(out.output.requirementFindings);
    expect(again.output.competencyFindings).toEqual(out.output.competencyFindings);
  });

  it("uses the first reading when fewer came back, saying so, and fails on an outage", () => {
    const invalid: RunOutcome<ScreenAssessment> = { ok: false, runId: "r8", model: "m", reason: "invalid", error: "no valid output" };
    const outage: RunOutcome<ScreenAssessment> = { ok: false, runId: "r9", model: "m", reason: "error", error: "provider error: 529" };
    const one = scorecardReadings([invalid, ok(card("unknown", "evidenced"), "r2"), invalid], view, screen, packet);
    expect(one).toMatchObject({ ok: true, runId: "r2" });
    if (one.ok) expect(one.output.confidenceReasons).toContain(`the assistant could read this AI interview once instead of ${SCORECARD_READINGS}`);
    expect(scorecardReadings([invalid, outage, invalid], view, screen, packet)).toBe(outage);
  });
});

/**
 * Wave S9 round 3 (real-model run 38784488452): the same cooperative chat read twice gave reliability, which no question
 * asked about, "partly evidenced" from the answer to the question about efficiency in one read and "not evidenced" in
 * the other, and the recommendation followed. Each answer is now read for the question it answers, and an interview or
 * a strong one is settled from the findings in code.
 */
describe("the scorecard reads each answer for its own question, and settles a strong interview from its findings", () => {
  const at = "2026-10-15T10:00:00.000Z";
  const question = (key: string, kind: string, text: string, competencyKey?: string) => ({ key, kind, question: text, ...(competencyKey ? { competencyKey } : {}) });
  const QUESTIONS = [
    question("license_confirm", "eligibility", "Can you confirm your RDH license state and whether it is currently active?"),
    question("perio_approach", "skills", "Walk me through how you handle a new patient with generalized moderate periodontitis.", "clinical_quality"),
    question("anxious_patient", "behavioral", "Tell me about a time a patient was anxious or resistant. What did you do?", "patient_communication"),
    question("appointment_length", "skills", "What appointment length are you used to for an adult prophy, and how do you handle running behind?", "efficiency_time"),
    question("availability_start", "availability", "Which days and hours are you available, and when could you start?"),
    question("pay_expectation", "compensation", "What hourly range are you looking for?"),
  ] as Array<{ key: string; kind: "skills"; question: string; competencyKey?: string }>;
  // the cooperative chat of the real-model run, word for word
  const REPLIES = [
    "Yes, my RDH license is active in California.",
    "For moderate perio I do full perio charting and radiographs, go over the plan with the dentist, then scaling and root planing by quadrant and a re-evaluation.",
    "A patient panicked at the ultrasonic scaler, so I slowed down and explained each step; she came back to me.",
    "An adult prophy takes me 60 minutes; when I run behind I tell the front desk and keep the next patient informed.",
    "Monday to Saturday, any hours, and I can start in two weeks.",
    "I'm looking for $52 an hour.",
  ];
  const CHAT: ScreenTranscriptEntry[] = QUESTIONS.flatMap((x, i) => [{ role: "assistant" as const, content: x.question, at, questionKey: x.key }, { role: "candidate" as const, content: REPLIES[i]!, at }]);
  const skill = (key: string) => ({ key, name: key, definition: "d", weight: 4, evaluatedIn: "both", indicators: [] });
  const PACKET = {
    requirements: { mustHaves: [{ key: "ca_rdh_license", text: "Active California RDH license", rationale: "law", evidencedBy: ["resume", "application", "screen"] }, { key: "perio_experience", text: "Experience with periodontal charting and therapy", rationale: "r", evidencedBy: ["resume", "screen", "interview"] }], niceToHaves: [], eligibility: [] },
    competencies: [skill("clinical_quality"), skill("patient_communication"), skill("efficiency_time"), skill("reliability")],
    screening: { questions: QUESTIONS, maxMinutes: 10 },
  } as unknown as RolePacket;
  type Finding = ScreenAssessment["competencyFindings"][number]["finding"];
  const reading = (efficiency: Finding, reliability: Finding, recommendation: ScreenAssessment["recommendation"], over: Partial<ScreenAssessment> = {}): ScreenAssessment => ({
    overall: "strong", confidence: "medium", summary: `efficiency ${efficiency}, reliability ${reliability}`, strengths: [], concerns: [], unknowns: [],
    competencyFindings: [
      { competencyKey: "clinical_quality", finding: "evidenced", evidence: { source: "screen", quote: "I do full perio charting and radiographs" } },
      { competencyKey: "patient_communication", finding: "evidenced", evidence: { source: "screen", quote: "I slowed down and explained each step" } },
      { competencyKey: "efficiency_time", finding: efficiency, evidence: { source: "screen", quote: "when I run behind I tell the front desk" } },
      reliability === "not_evidenced" ? { competencyKey: "reliability", finding: reliability, note: "Punctuality and consistency are not described." } : { competencyKey: "reliability", finding: reliability, evidence: { source: "screen", quote: "when I run behind I tell the front desk and keep the next patient informed" } },
    ],
    requirementFindings: [{ requirementKey: "ca_rdh_license", met: "yes", evidence: { source: "screen", quote: "Yes, my RDH license is active in California." } }, { requirementKey: "perio_experience", met: "yes", evidence: { source: "screen", quote: "I do full perio charting and radiographs" } }],
    anomalies: [], questionFindings: [], compensationExpectation: { stated: "I'm looking for $52 an hour.", withinRange: "yes" }, availability: { stated: "Monday to Saturday, any hours", matchesSchedule: "yes" }, eligibilityConfirmations: [], recommendation, rationale: `Recommend ${recommendation}.`, ...over,
  });
  const ok = (output: ScreenAssessment, runId: string): RunOutcome<ScreenAssessment> => ({ ok: true, output, runId, model: "m" });
  const shown = (readings: ScreenAssessment[], transcript = CHAT, opts: { incomplete?: boolean } = {}) => {
    const out = scorecardReadings(readings.map((r, i) => ok(r, `r${i + 1}`)), { restore: (s: string) => s }, { transcript, answers: {}, progress: EMPTY_SCREEN_PROGRESS }, PACKET, opts);
    if (!out.ok) throw new Error("expected a scorecard");
    return out.output;
  };
  const skills = (a: ScreenAssessment) => a.competencyFindings.map((f) => `${f.competencyKey}:${f.finding}`).sort().join(", ");
  const relOf = (a: ScreenAssessment) => a.competencyFindings.find((f) => f.competencyKey === "reliability");

  it("reads reliability, which no question asked about, the same in both reads of the real-model run: not from the answer about efficiency", () => {
    const one = shown([reading("evidenced", "partially_evidenced", "strong_interview"), reading("evidenced", "partially_evidenced", "strong_interview", { summary: "b" }), reading("evidenced", "partially_evidenced", "strong_interview", { summary: "c" })]);
    const two = shown([reading("partially_evidenced", "not_evidenced", "interview"), reading("evidenced", "not_evidenced", "strong_interview"), reading("partially_evidenced", "not_evidenced", "interview", { summary: "c" })]);
    expect(relOf(one)).toEqual({ competencyKey: "reliability", finding: "not_evidenced", note: NOT_ASKED_NOTE });
    expect(relOf(two)?.finding).toBe("not_evidenced");
    // read 1: three skills of four evidenced; read 2: efficiency's middle reading was "partly", two of four
    expect(one.recommendation).toBe("strong_interview");
    expect(two.recommendation).toBe("interview");
    // with efficiency read the same (screen.assess v10: an answer that gives what its own question asks shows the skill),
    // the reads agree whatever each reading recommended, and the words come from a reading that recommended the same
    const again = shown([reading("evidenced", "not_evidenced", "interview"), reading("evidenced", "not_evidenced", "interview", { summary: "b" }), reading("evidenced", "partially_evidenced", "strong_interview", { summary: "c" })]);
    expect(skills(again)).toBe(skills(one));
    expect(again.recommendation).toBe("strong_interview");
    expect(again.rationale).toBe("Recommend strong_interview.");
    expect(again.overall).toBe(one.overall);
  });

  it("never reads a skill nobody asked about from another skill's answer or from pay, availability or eligibility", () => {
    const rel = (quote: string, finding: Finding = "partially_evidenced", source: "screen" | "recruiter_note" = "screen") => reading("evidenced", "not_evidenced", "interview", { competencyFindings: [{ competencyKey: "reliability", finding, evidence: { source, quote } }] });
    const read = (a: ScreenAssessment, transcript = CHAT, questions = QUESTIONS) => withAskedSkills(a, questions, transcript).competencyFindings[0];
    expect(read(rel("when I run behind I tell the front desk"))).toEqual({ competencyKey: "reliability", finding: "not_evidenced", note: NOT_ASKED_NOTE });
    expect(read(rel("Monday to Saturday, any hours, and I can start in two weeks.", "evidenced"))).toMatchObject({ finding: "not_evidenced" });
    expect(read(rel("my RDH license is active in California"))).toMatchObject({ finding: "not_evidenced" });
    // a contradiction taken from another question's answer is not read either
    expect(read(rel("when I run behind I tell the front desk", "contradicted"))).toMatchObject({ finding: "not_evidenced" });
    // an availability question that names the skill is still about the schedule: its answer shows no skill
    const tagged = QUESTIONS.map((x) => (x.key === "availability_start" ? { ...x, competencyKey: "reliability" } : x));
    expect(read(rel("Monday to Saturday, any hours"), CHAT, tagged)).toMatchObject({ finding: "not_evidenced" });
    // a follow-up stays on its question: the reply to it is read for that question
    const followed: ScreenTranscriptEntry[] = [...CHAT.slice(0, 8), { role: "assistant", content: "You mentioned running behind: what do you tell the next patient?", at }, { role: "candidate", content: "That I am about ten minutes late and why.", at }];
    expect(read(rel("I am about ten minutes late and why"), followed)).toMatchObject({ finding: "not_evidenced" });
  });

  it("leaves to the model a skill asked about, words said outside another question's answer, a recruiter's note, and a quote it cannot place", () => {
    const rel = (quote: string, finding: Finding = "partially_evidenced", source: "screen" | "recruiter_note" = "screen") => reading("evidenced", "not_evidenced", "interview", { competencyFindings: [{ competencyKey: "reliability", finding, evidence: { source, quote } }] });
    const read = (a: ScreenAssessment, transcript = CHAT, questions = QUESTIONS) => withAskedSkills(a, questions, transcript).competencyFindings[0];
    // an open question listed with no skill (what they look for, a company's own written question, the closing one)
    const withOpen = [...QUESTIONS, question("next_office", "motivation", "What are you looking for in your next office?")] as typeof QUESTIONS;
    const said: ScreenTranscriptEntry[] = [...CHAT, { role: "assistant", content: "What are you looking for in your next office?", at, questionKey: "next_office" }, { role: "candidate", content: "A team that plans ahead. In eight years I have never missed a shift.", at }];
    expect(read(rel("In eight years I have never missed a shift.", "evidenced"), said, withOpen)).toMatchObject({ finding: "evidenced", evidence: { quote: "In eight years I have never missed a shift." } });
    // a quote put together from the efficiency answer and that open one is not only another question's answer
    expect(read(rel("when I run behind I tell the front desk. In eight years I have never missed a shift."), said, withOpen)).toMatchObject({ finding: "partially_evidenced" });
    // while the efficiency answer's own sentence, full stop and all, is that answer's
    expect(read(rel("when I run behind I tell the front desk."), said, withOpen)).toMatchObject({ finding: "not_evidenced" });
    // a skill a question asked about keeps whichever answer the reading quoted
    const asked = [...QUESTIONS, question("schedule_change", "behavioral", "How do you handle a change to your schedule?", "reliability")] as typeof QUESTIONS;
    const askedChat: ScreenTranscriptEntry[] = [...CHAT, { role: "assistant", content: "How do you handle a change to your schedule?", at, questionKey: "schedule_change" }, { role: "candidate", content: "I tell the office as soon as I know.", at }];
    expect(read(rel("when I run behind I tell the front desk"), askedChat, asked)).toMatchObject({ finding: "partially_evidenced" });
    // listed with the skill but never asked in this chat: not asked about
    expect(read(rel("when I run behind I tell the front desk"), CHAT, asked)).toMatchObject({ finding: "not_evidenced" });
    expect(read(rel("Called her: never late in two years", "evidenced", "recruiter_note"))).toMatchObject({ finding: "evidenced" });
    expect(read(rel("Always on time at my last office", "evidenced"))).toMatchObject({ finding: "evidenced" });
    // a chat whose questions the packet does not list (a Kanvis-style chat's own items): nothing to read it against
    expect(read(rel("when I run behind I tell the front desk"), CHAT, [])).toMatchObject({ finding: "partially_evidenced" });
    // a question naming a skill the role does not have (the draft renamed "efficiency") is about no skill: its own
    // skill's answer is never lost through it, and nothing is taken from another skill on its account
    const renamed = QUESTIONS.map((x) => (x.key === "appointment_length" ? { ...x, competencyKey: "efficiency" } : x));
    const keys = new Set(["clinical_quality", "patient_communication", "efficiency_time", "reliability"]);
    const own = reading("evidenced", "not_evidenced", "interview", { competencyFindings: [{ competencyKey: "efficiency_time", finding: "evidenced", evidence: { source: "screen", quote: "when I run behind I tell the front desk" } }] });
    expect(withAskedSkills(own, renamed, CHAT, keys).competencyFindings[0]).toMatchObject({ finding: "evidenced" });
    expect(withAskedSkills(rel("when I run behind I tell the front desk"), renamed, CHAT, keys).competencyFindings[0]).toMatchObject({ finding: "partially_evidenced" });
    // while through the app's own path (scorecardOutcome, the role's skills given) the tagged question still counts
    expect(relOf(shown([rel("when I run behind I tell the front desk"), rel("when I run behind I tell the front desk"), rel("when I run behind I tell the front desk")]))?.finding).toBe("not_evidenced");
  });

  it("settles an interview or a strong one by the prompt's own rule, and leaves hold and decline to the readings", () => {
    const strong = reading("evidenced", "not_evidenced", "interview");
    expect(settledScreenRecommendation(strong, PACKET)).toBe("strong_interview");
    // two skills of four is not most
    expect(settledScreenRecommendation(reading("partially_evidenced", "not_evidenced", "strong_interview"), PACKET)).toBe("interview");
    // a must-have the chat was to confirm not shown in full, or shown with nothing quoted
    expect(settledScreenRecommendation({ ...strong, requirementFindings: [strong.requirementFindings[0]!, { requirementKey: "perio_experience", met: "partially", evidence: { source: "screen", quote: "I do full perio charting and radiographs" } }] }, PACKET)).toBe("interview");
    expect(settledScreenRecommendation({ ...strong, requirementFindings: [strong.requirementFindings[0]!, { requirementKey: "perio_experience", met: "yes", evidence: { source: "screen", unquoted: true } }] }, PACKET)).toBe("interview");
    // logistics that do not fit
    expect(settledScreenRecommendation({ ...strong, compensationExpectation: { withinRange: "above" } }, PACKET)).toBe("interview");
    expect(settledScreenRecommendation({ ...strong, availability: { matchesSchedule: "partially" } }, PACKET)).toBe("interview");
    // pay or availability not known yet do not hold it back
    expect(settledScreenRecommendation({ ...strong, compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" } }, PACKET)).toBe("strong_interview");
    // a conversation that was not finished is never a strong interview
    const said = { ...strong, recommendation: "strong_interview" as const };
    expect(settledScreenRecommendation(said, PACKET, { incomplete: true })).toBe("interview");
    expect(shown([said, said, said], CHAT, { incomplete: true }).recommendation).toBe("interview");
    expect(shown([said, said, said]).recommendation).toBe("strong_interview");
    // hold and decline are the readings' own
    expect(settledScreenRecommendation({ ...strong, recommendation: "hold" }, PACKET)).toBe("hold");
    expect(settledScreenRecommendation({ ...strong, recommendation: "decline_recommended" }, PACKET)).toBe("decline_recommended");
    // nothing shown at all is never a strong interview
    const bare = { ...PACKET, requirements: { ...PACKET.requirements, mustHaves: [] }, competencies: [] } as unknown as RolePacket;
    expect(settledScreenRecommendation(strong, bare)).toBe("interview");
  });
});

describe("AI-written questions pass the code's fairness check before a candidate sees them (known bug 29)", () => {
  const two = { screening: { questions: [{ key: "experience", question: "Tell me about your most recent work.", kind: "skills" }, { key: "availability", question: "Which days and hours are you available?", kind: "availability" }], maxMinutes: 15 } } as unknown as RolePacket;
  const ask = (messageToCandidate: string, over: Partial<ScreenTurn> = {}): ScreenTurn => ({ ...followUp, messageToCandidate, ...over });

  it("a follow-up about a protected trait is never sent: the chat moves on to the next question in the packet's words", () => {
    for (const unfair of ["You mentioned school runs. How old are your kids?", "Thanks! Where are you originally from?", "Are you planning to have children soon?", "What year did you graduate?", "What is your current salary?", "Do you attend church on Sundays?"]) {
      const t = enforceTurnRules(ask(unfair), two, asking("experience"), {});
      expect(t.messageToCandidate, unfair).toBe("Thanks. Which days and hours are you available?");
      expect(t.questionKey).toBe("availability");
      expect(t.followUpReason).toBeNull();
    }
    // a fair follow-up passes as it was
    expect(enforceTurnRules(ask("You mentioned nine patients a day: how long is each visit?"), two, asking("experience"), {}).messageToCandidate).toBe("You mentioned nine patients a day: how long is each visit?");
    expect(unfairQuestion("You said 12 years of experience in perio: what changed most?")).toBeNull();
  });

  it("catches criminal history, health, graduation, children and workers' comp, and lets ordinary dental questions through (review of Wave S5)", () => {
    for (const unfair of [
      "Have you ever been convicted of a crime?", "Do you have a criminal record?", "Do you have any health issues that would affect your work?", "Do you have any medical conditions we should know about?",
      "When did you graduate from high school?", "How many kids do you have?", "Do you have reliable childcare?", "Have you ever filed a workers' comp claim?", "What is your current pay?", "How much do you make now?",
    ]) expect(unfairQuestion(unfair), unfair).not.toBeNull();
    for (const fair of [
      "How do you review their medical history and their medications before a cleaning?", "How do you explain gum disease to patients and their health risks?",
      "Thanks, that is within the current pay range for this role.", "How many children do you see in a typical day?", "How do you adjust care for a patient with a medical condition?",
    ]) expect(unfairQuestion(fair), fair).toBeNull();
  });

  it("an unfair acknowledgment is replaced, the packet's own question kept; with nothing left the chat closes", () => {
    const moved = enforceTurnRules(ask("Great, and congratulations on the pregnancy!", { questionKey: "availability", followUpReason: null }), two, asking("experience"), {});
    expect(moved.messageToCandidate).toBe("Thanks. Which days and hours are you available?");
    const last = enforceTurnRules(ask("How old are you, if you don't mind me asking?"), two, asking("availability", {}, ["experience", "availability"]), { experience: "Six years." });
    expect(last).toMatchObject({ done: true, questionKey: null, followUpReason: null });
    expect(last.messageToCandidate).toMatch(/that is everything I needed/);
  });

  it("the résumé reading's open questions are asked only when they pass", () => {
    const qs = focusQuestionsFrom([
      { question: "Is your CA RDH license active?", whyItMatters: "must-have" },
      { question: "How old are you?", whyItMatters: "x" },
      { question: "Do you have kids at home?", whyItMatters: "x" },
      { question: "Can you tell me about your perio charting?", whyItMatters: "must-have" },
    ]);
    expect(qs.map((q) => [q.key, q.question])).toEqual([["unknown_1", "Is your CA RDH license active?"], ["unknown_2", "Can you tell me about your perio charting?"]]);
  });
});

/**
 * Wave S9 (the first real-model run of the screening chat, 15 Oct 2026): in a chat without a plan, what the candidate
 * wrote decides what is recorded, and the code decides what kind of turn it is, whatever the model labelled. Each case
 * here is a turn the real model could write.
 */
describe("a chat without a plan holds every turn to what the candidate wrote (Wave S9)", () => {
  const rdh = { screening: { questions: [{ key: "licence", question: "Can you confirm your RDH license state and whether it is currently active?", kind: "eligibility" }, { key: "experience", question: "Tell me about your most recent work.", kind: "skills" }, { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" }], maxMinutes: 10 } } as unknown as RolePacket;
  const at = "2026-10-15T10:00:00.000Z";
  const turnOf = (over: Partial<ScreenTurn>): ScreenTurn => ({ messageToCandidate: "Thanks.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, ...over });
  /** The conversation: a string is the candidate's, `ask` the assistant's (with the question it moved to). */
  const chat = (...lines: Array<string | { ask: string; key?: string }>): ScreenTranscriptEntry[] => lines.map((l) => (typeof l === "string" ? { role: "candidate" as const, content: l, at } : { role: "assistant" as const, content: l.ask, at, ...(l.key ? { questionKey: l.key } : {}) }));
  const askExperience = { ask: "Tell me about your most recent work.", key: "experience" };
  const onExperience: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["licence", "experience"], currentQuestionKey: "experience" };
  const rules = (t: ScreenTurn, progress: ScreenProgress, transcript: ScreenTranscriptEntry[], answers: Record<string, string> = { licence: "Yes, active in California." }) => enforceTurnRules(t, rdh, progress, answers, { transcript, latest: [...transcript].reverse().find((x) => x.role === "candidate")?.content ?? null });

  it("a question the candidate asks is never their answer; an answer in the same message is kept; their question answered, the question comes back", () => {
    const pay = rules(turnOf({ candidateAskedAbout: "pay", messageToCandidate: "The posted range is $45 to $55 an hour.", answerRecorded: { questionKey: "experience", answer: "Before I go on, what does this pay per hour?", complete: false } }), onExperience, chat(askExperience, "Before I go on, what does this pay per hour?"));
    expect(pay).toMatchObject({ answerRecorded: null, followUpReason: null, questionKey: null });
    expect(pay.messageToCandidate).toBe("The posted range is $45 to $55 an hour. Tell me about your most recent work.");
    // an earlier answer recorded again on that turn is not this message's (it is kept when the question settles), and
    // "moving on" to the question it is on is going back to it, not a follow-up
    const back = rules(turnOf({ candidateAskedAbout: "pay", questionKey: "experience", messageToCandidate: "The posted range is $45 to $55 an hour. Back to my question:", answerRecorded: { questionKey: "experience", answer: "Six years in a family practice.", complete: true } }), onExperience, chat(askExperience, "Six years in a family practice.", { ask: "How many patients a day?" }, "Ok. What does it pay?"));
    expect(back).toMatchObject({ answerRecorded: null, followUpReason: null, questionKey: null });
    expect(back.messageToCandidate).toBe("The posted range is $45 to $55 an hour. Back to my question: Tell me about your most recent work.");
    const onLicence: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["licence"], currentQuestionKey: "licence" };
    const mixed = rules(turnOf({ candidateAskedAbout: "pay", messageToCandidate: "The posted range is $45 to $55 an hour.", answerRecorded: { questionKey: "licence", answer: "Yes, active in CA. What does it pay?", complete: true } }), onLicence, chat({ ask: "Can you confirm your RDH license state and whether it is currently active?", key: "licence" }, "Yes, active in CA. What does it pay?"), {});
    expect(mixed.answerRecorded).toEqual({ questionKey: "licence", answer: "Yes, active in CA.", complete: true });
    for (const m of ["Before I go on, what does this pay per hour?", "Ok. What are the hours?", "Is it full time?", "Hi, what does it pay?", "Ok, so isn’t it full time?", "???"]) expect(onlyQuestions(m), m).toBe(true);
    for (const m of ["Yes. What are the hours?", "Six years.", "??? what do you mean"]) expect(onlyQuestions(m), m).toBe(false);
    // an answer said with a rising "?" is still their answer, recorded as they wrote it (Wave S9 review)
    for (const m of ["I'm looking for $52 an hour, is that ok?", "Yes, I have an active CA license, why?", "5 years, why?", "Monday to Friday?", "Yes?", "Around $50 an hour?", "Maybe 50 to 54?"]) expect(onlyQuestions(m), m).toBe(false);
    const onPay: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["licence", "experience", "pay"], currentQuestionKey: "pay" };
    const rising = rules(turnOf({ done: true, answerRecorded: { questionKey: "pay", answer: "Around $50 an hour?", complete: true } }), onPay, chat({ ask: "What hourly range are you looking for?", key: "pay" }, "Around $50 an hour?"), { licence: "Yes", experience: "Nine a day." });
    expect(rising).toMatchObject({ done: true, answerRecorded: { questionKey: "pay", answer: "Around $50 an hour?", complete: true } });
    const unasked = rules(turnOf({ questionKey: "pay" }), onExperience, chat(askExperience, "5 years, why?"));
    expect(unasked).toMatchObject({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "5 years, why?" } });
    // and a question of theirs after an answer in the same message leaves the answer
    const okay = rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Six years in a family practice. Is that enough?", complete: true } }), onExperience, chat(askExperience, "Six years in a family practice. Is that enough?"));
    expect(okay.answerRecorded).toEqual({ questionKey: "experience", answer: "Six years in a family practice.", complete: true });
  });

  it("a follow-up is counted whatever the model labelled: one that stays and asks, or the question asked again; the cap still moves on with what they said", () => {
    const thin = chat(askExperience, "Cleanings mostly");
    const unlabelled = rules(turnOf({ messageToCandidate: "You mentioned cleanings: how many patients a day?" }), onExperience, thin);
    expect(unlabelled).toMatchObject({ questionKey: null, followUpReason: "asked for more", answerRecorded: null });
    expect(advanceProgress(onExperience, unlabelled).followUps.experience).toBe(1);
    // the model "moves on" to the question it is already on: a follow-up, and the question is not added a second time
    const reasked = rules(turnOf({ questionKey: "experience", messageToCandidate: "You mentioned cleanings. Tell me about your most recent work." }), onExperience, thin);
    expect(reasked).toMatchObject({ questionKey: null, followUpReason: "asked again" });
    expect(reasked.messageToCandidate).toBe("You mentioned cleanings. Tell me about your most recent work.");
    expect(rules(turnOf({ questionKey: "experience", messageToCandidate: "Thanks." }), onExperience, thin).messageToCandidate).toBe("Thanks. Tell me about your most recent work.");
    // two follow-ups asked already: the third moves on, and every reply about the question is its answer
    const capped = rules(turnOf({ messageToCandidate: "And how many of those a day?" }), { ...onExperience, followUps: { experience: 2 } }, chat(askExperience, "Cleanings mostly", { ask: "Which cleanings?" }, "Adult prophies", { ask: "How long each?" }, "An hour"));
    expect(capped).toMatchObject({ questionKey: "pay", followUpReason: null, answerRecorded: { questionKey: "experience", answer: "Cleanings mostly Adult prophies An hour", complete: false } });
    expect(capped.messageToCandidate).toBe("Thanks, that helps. Next: What hourly range are you looking for?");
    // and so does a follow-up the fairness check stops
    const unfair = rules(turnOf({ followUpReason: "push", messageToCandidate: "You mentioned school runs. How old are your kids?" }), onExperience, chat(askExperience, "Cleanings, around the school runs"));
    expect(unfair).toMatchObject({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Cleanings, around the school runs", complete: false } });
  });

  it("a confused reply gets the same question again and the offer of a person: never recorded, never moved past, never closed", () => {
    const lost = chat(askExperience, "??? what do you mean");
    // read as an answer and moved on: the code stays on the question, records nothing and offers a person
    const t = rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "??? what do you mean", complete: false } }), onExperience, lost);
    expect(t).toMatchObject({ sentiment: "confused", questionKey: null, followUpReason: "the candidate seemed confused", answerRecorded: null, done: false, humanRequested: false });
    expect(t.messageToCandidate).toBe(`No problem. Tell me about your most recent work. ${CONFUSED_OFFER}`);
    expect(advanceProgress(onExperience, t)).toMatchObject({ currentQuestionKey: "experience", confusedTurns: 1, followUps: { experience: 1 } });
    // a rephrasing the model wrote stays as it is, and offers a person once
    const own = rules(turnOf({ sentiment: "confused", followUpReason: "confused", messageToCandidate: "Sorry, I meant: what did a usual day at your last job look like? You can also reply HUMAN for a person." }), onExperience, lost);
    expect(own.messageToCandidate).toBe("Sorry, I meant: what did a usual day at your last job look like? You can also reply HUMAN for a person.");
    expect(rules(turnOf({ done: true, sentiment: "confused", messageToCandidate: "Thanks, that is all." }), onExperience, lost)).toMatchObject({ done: false, questionKey: null, messageToCandidate: `No problem. Tell me about your most recent work. ${CONFUSED_OFFER}` });
    // a first confusion is offered a person, not handed over unasked; one right after another may be
    const handed = turnOf({ humanRequested: true, sentiment: "confused", messageToCandidate: "A person from the hiring team will follow up with you." });
    expect(rules(handed, onExperience, lost)).toMatchObject({ humanRequested: false, sentiment: "confused", questionKey: null, messageToCandidate: `No problem. Tell me about your most recent work. ${CONFUSED_OFFER}` });
    expect(rules(handed, { ...onExperience, confusedTurns: 1 }, lost)).toMatchObject({ humanRequested: true, messageToCandidate: "A person from the hiring team will follow up with you." });
    for (const m of ["???", "What do you mean?", "Sorry, I don't understand", "huh?", "I'm confused.", "??? what do you mean"]) expect(seemsConfused(m), m).toBe(true);
    for (const m of ["What do you mean by perio charting?", "Yes", "I see nine patients a day.", ""]) expect(seemsConfused(m), m).toBe(false);
    // the reply after it is the answer; the confused one is never part of it
    const after = rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Hygiene at a family practice, nine patients a day.", complete: true } }), { ...onExperience, followUps: { experience: 1 }, confusedTurns: 1 }, [...lost, { role: "assistant", content: t.messageToCandidate, at }, { role: "candidate", content: "Hygiene at a family practice, nine patients a day.", at }]);
    expect(after.answerRecorded).toEqual({ questionKey: "experience", answer: "Hygiene at a family practice, nine patients a day.", complete: true });
  });

  it("every question is asked: a close before the end goes on, an acknowledgment that asks nothing moves on once the question has an answer (and asks it again before), a question written out is the move to it, and the opening asks the first", () => {
    const answered = chat(askExperience, "Nine patients a day.");
    const early = rules(turnOf({ done: true, messageToCandidate: "Thanks Alex, that is everything I needed.", answerRecorded: { questionKey: "experience", answer: "Nine patients a day.", complete: true } }), onExperience, answered);
    expect(early).toMatchObject({ done: false, questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Nine patients a day." } });
    expect(early.messageToCandidate).toBe("Thanks. What hourly range are you looking for?");
    const ack = rules(turnOf({ messageToCandidate: "Got it, thanks.", answerRecorded: { questionKey: "experience", answer: "Nine patients a day.", complete: true } }), onExperience, answered);
    expect(ack).toMatchObject({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Nine patients a day.", complete: true } });
    expect(ack.messageToCandidate).toBe("Got it, thanks. What hourly range are you looking for?");
    // an answer recorded on an earlier turn (before a follow-up) counts too
    expect(rules(turnOf({ messageToCandidate: "Got it, thanks." }), onExperience, answered, { licence: "Yes", experience: "Nine patients a day." })).toMatchObject({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Nine patients a day." } });
    expect(rules(turnOf({ messageToCandidate: "Thanks. What hourly range are you looking for?" }), onExperience, answered)).toMatchObject({ questionKey: "pay", followUpReason: null });
    // after the last question, an acknowledgment is the close, with the answer kept
    const last: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["licence", "experience", "pay"], currentQuestionKey: "pay" };
    const end = rules(turnOf({ messageToCandidate: "Thanks.", answerRecorded: { questionKey: "pay", answer: "I'm looking for $52 an hour.", complete: true } }), last, chat({ ask: "What hourly range are you looking for?", key: "pay" }, "I'm looking for $52 an hour."), { licence: "Yes", experience: "Nine a day." });
    expect(end).toMatchObject({ done: true, questionKey: null, answerRecorded: { questionKey: "pay", answer: "I'm looking for $52 an hour." } });
    expect(end.messageToCandidate).toBe(`Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.`);
    // Wave S9 review: before the question has an answer, an acknowledgment that asks nothing is the question asked again
    // (a follow-up, so the cap holds), never a move on or a close with "One sec" as the answer
    const wait = rules(turnOf({ messageToCandidate: "Sure, take your time." }), onExperience, chat(askExperience, "One sec, let me check my notes."));
    expect(wait).toMatchObject({ questionKey: null, done: false, followUpReason: "asked again", answerRecorded: null });
    expect(wait.messageToCandidate).toBe("Sure, take your time. Tell me about your most recent work.");
    const lastWait = rules(turnOf({ messageToCandidate: "Sure, take your time." }), last, chat({ ask: "What hourly range are you looking for?", key: "pay" }, "One sec, let me check my notes."), { licence: "Yes", experience: "Nine a day." });
    expect(lastWait).toMatchObject({ done: false, questionKey: null, answerRecorded: null });
    expect(lastWait.messageToCandidate).toBe("Sure, take your time. What hourly range are you looking for?");
    // and a close before it has an answer goes back to it, never on to the next question with that line as the answer
    const gone = rules(turnOf({ done: true, messageToCandidate: "Understood, thank you for your time." }), onExperience, chat(askExperience, "I'm no longer interested, thanks"));
    expect(gone).toMatchObject({ done: false, questionKey: null, followUpReason: "asked again", answerRecorded: null });
    expect(gone.messageToCandidate).toBe("Thanks. Tell me about your most recent work.");
    const opening = enforceTurnRules(turnOf({ messageToCandidate: "Hi Alex, this is the hiring team's AI assistant. Reply HUMAN at any time to reach a person." }), rdh, EMPTY_SCREEN_PROGRESS, {}, { transcript: [], latest: null });
    expect(opening.questionKey).toBe("licence");
    expect(opening.messageToCandidate).toBe("Hi Alex, this is the hiring team's AI assistant. Reply HUMAN at any time to reach a person. Can you confirm your RDH license state and whether it is currently active?");
  });

  it("an answer recorded is the candidate's own words: reworded, or missing their first words, it is what they wrote; a personal detail left out stays out", () => {
    const two = chat(askExperience, "Cleanings mostly", { ask: "You mentioned cleanings: how many a day?" }, "I see 9 patients a day and chart perio maintenance in Dentrix.");
    const followed: ScreenProgress = { ...onExperience, followUps: { experience: 1 } };
    const reworded = rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "Mostly cleanings; about nine patients daily, charting in Dentrix.", complete: true } }), followed, two);
    expect(reworded.answerRecorded).toEqual({ questionKey: "experience", answer: "Cleanings mostly I see 9 patients a day and chart perio maintenance in Dentrix.", complete: true });
    const lastOnly = rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "I see 9 patients a day and chart perio maintenance in Dentrix.", complete: true } }), followed, two);
    expect(lastOnly.answerRecorded?.answer).toBe("Cleanings mostly I see 9 patients a day and chart perio maintenance in Dentrix.");
    // the pay answer, word for word, however the model copied it
    const pay: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["licence", "experience", "pay"], currentQuestionKey: "pay" };
    expect(rules(turnOf({ done: true, answerRecorded: { questionKey: "pay", answer: "$52/hour", complete: true } }), pay, chat({ ask: "What hourly range are you looking for?", key: "pay" }, "I'm looking for $52 an hour."), { licence: "Yes", experience: "Nine a day." }).answerRecorded?.answer).toBe("I'm looking for $52 an hour.");
    const personal = chat(askExperience, "I'm 52 and I chart perio in Dentrix every day.");
    expect(rules(turnOf({ questionKey: "pay", answerRecorded: { questionKey: "experience", answer: "I chart perio in Dentrix every day.", complete: true } }), onExperience, personal).answerRecorded?.answer).toBe("I chart perio in Dentrix every day.");
    // and the code never puts the detail back
    expect(rules(turnOf({ questionKey: "pay" }), onExperience, personal).answerRecorded?.answer).toBe("(answer recorded; personal details omitted)");
  });
});

/**
 * Wave S7, the Kanvis-style chat (scratchpad kanvis-2/spec-s7-apply-flow.md step 6): the plan built in code, the gaps
 * between the CV and the must-haves, the company's written questions, and the rules every turn is held to after the
 * model answered: one neutral restatement and one question, one push, the analog and the smaller version, "No" settled
 * as not known with a calm line, no filler or inference, the closing question, and no private note ever said.
 */
describe("the Kanvis-style chat", () => {
  const role = {
    identity: { title: "Robotics Trainer", employmentType: "full_time", locations: [{ city: "Lahore", region: "PB" }] },
    compensation: { basis: "salary", min: 50000, max: 70000, currency: "USD", discloseRange: false },
    requirements: {
      eligibility: [{ key: "laptop", type: "physical_requirement_bona_fide", question: "Do you have your own laptop for teaching?", expectation: {}, rationale: "Classes run on it.", knockout: false }],
      mustHaves: [
        { key: "arduino", text: "Hands-on Arduino or robotics hardware work", rationale: "r", evidencedBy: ["resume", "screen"] },
        { key: "english", text: "Explaining technical ideas in English", rationale: "r", evidencedBy: ["screen"] },
        { key: "own_laptop", text: "Own laptop for teaching", rationale: "r", evidencedBy: ["application"] },
        { key: "panel", text: "A strong teaching demo", rationale: "r", evidencedBy: ["interview"] },
      ],
      niceToHaves: [],
    },
    companyQuestions: { quick: [], written: [
      { key: "wq_explain", question: "How would you explain what a sensor is to six-year-olds?", required: true, lookFor: "uses a concrete everyday analogy and checks understanding with the children" },
      { key: "wq_room", question: "Several kits fail at once in a class of twenty. How do you handle the room?", required: true },
    ] },
    screening: { questions: [{ key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 },
    competencies: [],
    communication: { candidateMayBeTold: [], tone: "warm", humanAlternativeText: "Reply HUMAN.", disclosureText: "" },
    interviews: { plan: [] },
  } as unknown as RolePacket;
  const facts: ChatFacts = { cv: ["Software engineer at CallsFlow (2023 to now): WebRTC calls platform", "Skills: TypeScript, WebRTC, IoT"], formAnswers: ["Do you have your own laptop for teaching? Yes."] };
  const at = "2026-10-15T10:00:00.000Z";
  const start = (gaps: string[]) => withChatPlan(role, { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, { channel: "web", gaps, at });
  const turnOf = (over: Partial<ScreenTurn>): ScreenTurn => ({ messageToCandidate: "", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, ...over });
  /** The progress with the chat asking `key`, with the item's ladder where given. */
  const askingNow = (progress: ScreenProgress, key: string, asked: string[], item: Partial<{ step: "direct" | "analog" | "smaller"; pushes: number }> = {}): ScreenProgress => {
    const p = advanceProgress({ ...progress, askedKeys: asked.slice(0, -1) }, turnOf({ questionKey: key, messageToCandidate: "x" }));
    return { ...p, chat: p.chat ? { ...p.chat, items: p.chat.items.map((i) => (i.key === key ? { ...i, ...item } : i)) } : p.chat };
  };
  const said = (question: string, ...replies: string[]): ScreenTranscriptEntry[] => [{ role: "assistant", content: question, at, questionKey: "q" }, ...replies.map((r) => ({ role: "candidate" as const, content: r, at }))];

  it("finds the gaps in code: must-haves the CV does not show, never one checked in the interviews only, one the form asked, or one the reading settled", () => {
    const written = ["wq_explain", "wq_room"];
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: null, facts, written })).toEqual(["arduino", "english"]);
    // with the résumé reading: what it found partly or not at all; a must-have their own words settled either way is left alone
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: { arduino: "unknown", english: "yes" }, facts, written })).toEqual(["arduino"]);
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: { arduino: "no", english: "partially" }, facts, written })).toEqual(["english"]);
    // the CV shows it: not a gap
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: null, facts: { ...facts, cv: [...facts.cv, "Built Arduino robotics hardware kits for a school club"] }, written })).toEqual(["english"]);
    // the résumé reading's open questions the team asked for come first
    expect(chatGaps({ packet: role, progress: { focusQuestions: [{ key: "unknown_1", question: "Is your teaching certificate current?" }] }, triageMet: null, facts, written })[0]).toBe("unknown_1");
    // no CV to read and no reading yet: no gaps; the chat starts at the required questions
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: null, facts: { cv: [], formAnswers: [] }, written })).toEqual([]);
    expect(chatGaps({ packet: role, progress: EMPTY_SCREEN_PROGRESS, triageMet: null, facts: null, written })).toEqual([]);
  });

  it("is planned only for the chat offered with the application on the web; its questions are the plan's items, then the closing question; reading it twice gives the same", () => {
    expect(withChatPlan(role, EMPTY_SCREEN_PROGRESS, { channel: "web", gaps: [], at }).chat).toBeUndefined();
    expect(withChatPlan(role, { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, { channel: "sms", gaps: [], at }).chat).toBeUndefined();
    const p = start(["arduino", "english"]);
    expect(p.chat?.items.map((i) => [i.key, i.kind, i.required])).toEqual([["arduino", "gap", false], ["english", "gap", false], ["wq_explain", "written", true], ["wq_room", "written", true]]);
    const asked = chatPacket(role, p).screening.questions;
    expect(asked.map((q) => q.key)).toEqual(["arduino", "english", "wq_explain", "wq_room", CHAT_WRAP_KEY]);
    expect(asked[0].question).toBe(gapQuestion("Hands-on Arduino or robotics hardware work"));
    expect(asked[0].question).toBe("This is one of the things the job needs: Hands-on Arduino or robotics hardware work. What can you tell me about it from your own work?");
    // the private note goes to the models as the model answer, never into the question
    expect(asked[2]).toMatchObject({ question: "How would you explain what a sensor is to six-year-olds?", modelAnswer: "uses a concrete everyday analogy and checks understanding with the children" });
    expect(asked[4].question).toBe(CHAT_WRAP_QUESTION);
    expect(chatPacket(chatPacket(role, p), p).screening.questions).toEqual(asked);
    // a job saved before Wave S7 asks its own screening questions, under their own keys
    const old = { ...role, companyQuestions: undefined } as unknown as RolePacket;
    expect(chatPacket(old, withChatPlan(old, { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, { channel: "web", gaps: [], at })).screening.questions.map((q) => [q.key, q.kind])).toEqual([["pay", "compensation"], [CHAT_WRAP_KEY, "motivation"]]);
    // Review & send lists the written questions, and every other answer the chat will send (about the CV, the closing
    // question), so all of it can be checked and changed; an item that recorded nothing is not listed
    expect(reviewItems({ answers: { arduino: "x", wq_explain: "y" }, progress: p }, role).map((i) => i.key)).toEqual(["arduino", "wq_explain", "wq_room"]);
    expect(reviewItems({ answers: { wq_explain: "y", [CHAT_WRAP_KEY]: "Nothing more." }, progress: p }, role).map((i) => i.key)).toEqual(["wq_explain", "wq_room", CHAT_WRAP_KEY]);
  });

  it("opens personal, in code: the first name, one line from the CV, then the first question word for word", () => {
    expect(chatOpening({ firstName: "Meerub", cv: facts.cv, question: "Q?" })).toBe("Hi Meerub. Your resume shows your work as Software engineer at CallsFlow (2023 to now).\n\nQ?");
    // the form's own words about their work are never named as a résumé line
    expect(chatOpening({ firstName: "Kai", cv: ["Their own words about their work: Hygienist for five years."], question: "Q?" })).toBe("Hi Kai. Thanks for applying.\n\nQ?");
    expect(chatOpening({ firstName: "Kai", cv: [], question: "Q?" })).toBe("Hi Kai. Thanks for applying.\n\nQ?");
    expect(chatOpening({ firstName: "Kai", cv: ["Skills: TypeScript"], question: "Q?" })).toBe("Hi Kai. Thanks for applying.\n\nQ?");
  });

  it("names only what was typed in the visit for a chat offered with the application, so a repeat submission's reads the same", () => {
    // without what the visit typed, its form answers only (a repeat submission's chat has the same from its form)
    expect(chatFactsFor(facts, {}, "apply")).toEqual({ cv: [], formAnswers: facts.formAnswers });
    expect(chatFactsFor(null, {}, "apply")).toBeNull();
    expect(chatFactsFor(facts, { ownFacts: true }, "apply")).toBe(facts);
    expect(chatFactsFor(null, { typedFacts: facts }, "apply")).toBe(facts);
    expect(chatFactsFor(facts, {}, null)).toBe(facts);
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
    expect(chatCounter(p.chat)?.label).toBe("0 of 2 required · Required questions");
  });

  it("records nothing while an item is still being asked, whatever the model put in answerRecorded (Wave S9: the real model recorded a bare 'yes' on the push)", () => {
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
    expect(lost.turn.messageToCandidate).toBe(`No problem.\n\nHow would you explain what a sensor is to six-year-olds?\n\n${CONFUSED_OFFER}`);
    expect(advanceProgress(p, lost.turn, lost.move).currentQuestionKey).toBe("wq_explain");
    // their own question: nothing read, nothing recorded, the item still asked
    const asks = enforceChatTurn(turnOf({ reading: "vague", followUpReason: "push", answerRecorded: { questionKey: "wq_explain", answer: "Is it full time?", complete: false }, messageToCandidate: "A person can tell you more about that. How would you explain a sensor to six-year-olds?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "Is it full time?"), latest: "Is it full time?" });
    expect(asks.move).toBeNull();
    expect(asks.turn.answerRecorded).toBeNull();
    expect(advanceProgress(p, asks.turn, asks.move).chat?.items.find((i) => i.key === "wq_explain")).toMatchObject({ state: "asking", pushes: 0 });
  });

  it("a written question: the analog, then not known, keeping their own words; a yes-or-no question takes 'No' as its answer", () => {
    const p = askingNow(start([]), "wq_room", ["wq_explain", "wq_room"], { step: "analog" });
    const r = enforceChatTurn(turnOf({ followUpReason: "again", reading: "not_done", messageToCandidate: "Could you try once more?" }), chatPacket(role, p), p, {}, { transcript: said("Q", "No", "No"), latest: "No" });
    expect(r.move).toEqual({ key: "wq_room", move: "unknown" });
    expect(r.turn).toMatchObject({ questionKey: CHAT_WRAP_KEY, answerRecorded: { questionKey: "wq_room", answer: "No No", complete: false } });
    const old = { ...role, companyQuestions: undefined, screening: { questions: [{ key: "weekends", question: "Can you work weekends?", kind: "availability" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 } } as unknown as RolePacket;
    const q = askingNow(withChatPlan(old, { ...EMPTY_SCREEN_PROGRESS, flow: "one_visit" }, { channel: "web", gaps: [], at }), "weekends", ["weekends"]);
    const yn = enforceChatTurn(turnOf({ questionKey: "pay", reading: "not_done", answerRecorded: { questionKey: "weekends", answer: "No", complete: true }, messageToCandidate: "Noted, weekends are out." }), chatPacket(old, q), q, {}, { transcript: said("Q", "No"), latest: "No" });
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
    expect(chatNextLine("Robotronics")).toBe("Next, check what you are sending and change anything you like, then press Send. Nothing goes to Robotronics until you do.");
    // done too early: the code's plan goes on
    const early = askingNow(start([]), "wq_explain", ["wq_explain"]);
    const r = enforceChatTurn(turnOf({ done: true, reading: "concrete", messageToCandidate: "Thanks, that's everything." }), chatPacket(role, early), early, {}, { transcript: said("Q", "Like a thirsty finger that feels the water"), latest: "Like a thirsty finger that feels the water" });
    expect(r.turn).toMatchObject({ done: false, questionKey: "wq_room" });
    expect(r.turn.messageToCandidate).toBe("Several kits fail at once in a class of twenty. How do you handle the room?");
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

  it("the local stand-in runs the chat end to end: the push, the ladder, the counter, the close", async () => {
    const fake = new FakeProvider();
    registerFakeHandlers(fake);
    const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
    const { callPrompt } = await import("@ros/ai");
    let progress = start(["arduino", "english"]);
    let pk = chatPacket(role, progress);
    const first = nextQuestion(pk, progress, {})!;
    const opening = chatOpening({ firstName: "Meerub", cv: facts.cv, question: first.question });
    progress = advanceProgress(progress, turnOf({ questionKey: first.key, messageToCandidate: opening }));
    const transcript: ScreenTranscriptEntry[] = [{ role: "assistant", content: opening, at, questionKey: first.key }];
    const answers: Record<string, string> = {};
    const labels: string[] = [chatCounter(progress.chat)!.label];
    const replies = ["Yes", "I built a water pump with an Arduino and moisture sensors at CUST", "No", "No", "No", "Like a thirsty finger that feels when the soil is dry", "No", "Once three builds failed at once and I fixed the one blocking the most people first", "No, nothing else"];
    let last: ScreenTurn | null = null;
    for (const reply of replies) {
      transcript.push({ role: "candidate", content: reply, at });
      const ctx = screenContextOf({ companyName: "Robotronics", companyLocations: [], noticeOverrides: undefined, packet: pk, firstName: "Meerub", focusUnknowns: [], facts }, { channel: "web", progress, answers, transcript }, reply);
      expect(ctx.chat?.formAnswers).toEqual(facts.formAnswers);
      const r = await callPrompt(rt, screenTurnPrompt, ctx, { companyId: null });
      if (r.result.kind !== "ok") throw new Error(r.result.kind);
      const { turn, move } = enforceChatTurn(r.result.output, pk, progress, answers, { transcript, latest: reply });
      progress = advanceProgress(progress, turn, move);
      if (turn.answerRecorded) answers[turn.answerRecorded.questionKey] = turn.answerRecorded.answer;
      transcript.push({ role: "assistant", content: turn.messageToCandidate, at, questionKey: turn.questionKey ?? undefined });
      pk = chatPacket(role, progress);
      labels.push(chatCounter(progress.chat)!.label);
      last = turn;
      // one question at most, and never the private note
      expect((turn.messageToCandidate.match(/\?/g) ?? []).length, turn.messageToCandidate).toBeLessThanOrEqual(1);
      expect(turn.messageToCandidate).not.toMatch(/everyday analogy/);
    }
    expect(last?.done).toBe(true);
    expect(last?.messageToCandidate).toBe('Thank you, Meerub. You told me "Once three builds failed at once and I fixed the one blocking…".');
    // the analog is the question and its request, nothing cut
    expect(transcript[6].content).toBe("Not done that exactly? Tell me about something similar from your own work.");
    // the push on a bare "yes", then a concrete answer; three "No"s settle English as not known; the room question takes the analog
    expect(transcript[2].content).toMatch(/^You said "Yes"\.\n\nCould you tell me about one specific time/);
    expect(progress.chat?.items.map((i) => [i.key, i.state])).toEqual([["arduino", "covered"], ["english", "unknown"], ["wq_explain", "covered"], ["wq_room", "covered"]]);
    expect(answers.arduino).toBe("Yes I built a water pump with an Arduino and moisture sensors at CUST");
    expect(answers.english).toBeUndefined();
    expect(answers.wq_room).toBe("No Once three builds failed at once and I fixed the one blocking the most people first");
    expect(labels).toEqual([
      "0 of 2 required · About your experience", "0 of 2 required · About your experience", "0 of 2 required · About your experience", "0 of 2 required · About your experience", "0 of 2 required · About your experience",
      "0 of 2 required · Required questions", "1 of 2 required · Required questions", "1 of 2 required · Required questions", "2 of 2 required · Wrapping up", "2 of 2 required · Wrapping up",
    ]);
  });

  /**
   * Wave S8 (spec-s8-followups.md section A): a chat without a plan, by text or on the web from an emailed link, asks
   * what the web chat asks, the company's written questions, after the résumé reading's open questions; a chat created
   * before keeps the list it began with; and the private note never reaches the candidate there either.
   */
  describe("without a plan (Wave S8: by text, or from an emailed link)", () => {
    const focus = [{ key: "unknown_1", question: "Is your teaching certificate current?" }];
    const noted = /everyday analogy|checks understanding/;

    it("asks the company's written questions after the open questions, each as written, its note only as the model answer, and no closing question", () => {
      const fresh = newScreenProgress();
      expect(fresh).toEqual({ ...EMPTY_SCREEN_PROGRESS, asks: "written" });
      const asked = chatPacket(role, fresh).screening.questions;
      expect(asked).toEqual([
        { key: "wq_explain", question: "How would you explain what a sensor is to six-year-olds?", kind: "behavioral", modelAnswer: "uses a concrete everyday analogy and checks understanding with the children" },
        { key: "wq_room", question: "Several kits fail at once in a class of twenty. How do you handle the room?", kind: "behavioral" },
      ]);
      const opened = newScreenProgress(focus);
      expect(chatPacket(role, opened).screening.questions.map((q) => q.key)).toEqual(["unknown_1", "wq_explain", "wq_room"]);
      // reading it twice gives the same
      expect(chatPacket(chatPacket(role, opened), opened).screening.questions).toEqual(chatPacket(role, opened).screening.questions);
      // the invitation and the web page's introduction count the questions it asks
      expect(packetForFocusedInvite(role, fresh).screening.questions).toHaveLength(2);
      expect(packetForFocusedInvite(role, fresh).communication.humanAlternativeText).toBe("Reply HUMAN.");
      expect(packetForFocusedInvite(role, opened).screening.questions).toHaveLength(3);
      expect(packetForFocusedInvite(role, opened).communication.humanAlternativeText).toBe(`${FOCUS_INTRO}\n\nReply HUMAN.`);
      expect(screenIntro({ companyName: "Robotronics", firstName: "Meerub", packet: chatPacket(role, fresh) }).questions).toBe(2);
    });

    it("a chat created before keeps the list it began with, and a job with no written questions asks exactly what it did", () => {
      expect(chatPacket(role, EMPTY_SCREEN_PROGRESS)).toBe(role);
      expect(chatPacket(role, { ...EMPTY_SCREEN_PROGRESS, focusQuestions: focus }).screening.questions.map((q) => q.key)).toEqual(["unknown_1", "pay"]);
      expect(packetForFocusedInvite(role, EMPTY_SCREEN_PROGRESS)).toBe(role);
      const old = { ...role, companyQuestions: undefined } as unknown as RolePacket;
      const none = { ...role, companyQuestions: { quick: [], written: [] } } as unknown as RolePacket;
      expect(chatPacket(old, newScreenProgress())).toBe(old);
      expect(chatPacket(none, newScreenProgress())).toBe(none);
      expect(chatPacket(old, newScreenProgress(focus))).toEqual(focusedPacket(old, { focusQuestions: focus }));
    });

    it("never says a question's private note, even in part: the model's sentences that repeat it are left out, the disclosure and the packet's question stay", () => {
      const p: ScreenProgress = { ...newScreenProgress(), askedKeys: ["wq_explain"], currentQuestionKey: "wq_explain" };
      const pk = chatPacket(role, p);
      // a follow-up that repeats the note goes back to the question in its own words, as a planned chat's does
      const push = enforceTurnRules(turnOf({ followUpReason: "push", messageToCandidate: "Thanks. Would you use a concrete everyday analogy and checks understanding with the children?" }), pk, p, {});
      expect(push.messageToCandidate).toBe("How would you explain what a sensor is to six-year-olds?");
      // one that still asks something of its own keeps it
      const own = enforceTurnRules(turnOf({ followUpReason: "push", messageToCandidate: "The team wants someone who uses a concrete everyday analogy and checks understanding with the children. Which sensor would you start with?" }), pk, p, {});
      expect(own.messageToCandidate).toBe("Which sensor would you start with?");
      // moving on: what is left of the acknowledgment, then the next question in the packet's words
      const moved = enforceTurnRules(turnOf({ questionKey: "wq_room", answerRecorded: { questionKey: "wq_explain", answer: "Like a thirsty finger.", complete: true }, messageToCandidate: "That uses a concrete everyday analogy and checks understanding with the children." }), pk, p, {});
      expect(moved.messageToCandidate).toBe("Thanks. Several kits fail at once in a class of twenty. How do you handle the room?");
      // the opening by text keeps its disclosure and the first question
      const start = newScreenProgress();
      const opening = enforceTurnRules(turnOf({ questionKey: "wq_explain", messageToCandidate: "Hi Meerub, this is the hiring team at Robotronics, using an AI assistant for a short screening. Reply HUMAN at any time to reach a person.\n\nWe look for someone who uses a concrete everyday analogy and checks understanding with the children.\n\nFirst question: How would you explain what a sensor is to six-year-olds?" }), chatPacket(role, start), start, {});
      expect(opening.messageToCandidate).toBe("Hi Meerub, this is the hiring team at Robotronics, using an AI assistant for a short screening. Reply HUMAN at any time to reach a person. First question: How would you explain what a sensor is to six-year-olds?");
      // a close and a hand-over that repeat it say the code's words
      const last: ScreenProgress = { ...p, askedKeys: ["wq_explain", "wq_room"], currentQuestionKey: "wq_room" };
      const close = enforceTurnRules(turnOf({ done: true, answerRecorded: { questionKey: "wq_room", answer: "I fix the kit blocking the most people first.", complete: true }, messageToCandidate: "Thank you. You uses a concrete everyday analogy and checks understanding with the children." }), pk, last, { wq_explain: "Like a thirsty finger." });
      expect(close.messageToCandidate).toBe(`Thanks, that is everything I needed. ${SCREEN_NEXT_LINE} Reply HUMAN at any time to reach a person.`);
      const human = enforceTurnRules(turnOf({ humanRequested: true, messageToCandidate: "Sure. Someone who uses a concrete everyday analogy and checks understanding with the children will call." }), pk, p, {});
      expect(human.messageToCandidate).toBe("Understood. A person from the hiring team will follow up with you.");
      for (const t of [push, own, moved, opening, close, human]) expect(t.messageToCandidate).not.toMatch(noted);
      // words that do not repeat it pass as they were
      expect(enforceTurnRules(turnOf({ followUpReason: "push", messageToCandidate: "You mentioned a thirsty finger. What did the children say?" }), pk, p, {}).messageToCandidate).toBe("You mentioned a thirsty finger. What did the children say?");
    });

    it("a written question as long as a company may write it (400 characters) is asked by text as it is, in full", () => {
      const long = `Tell us ${"about the kits, the room and the children, ".repeat(8)}and how you start the lesson?`;
      expect(long.length).toBeLessThanOrEqual(400);
      const wordy = { ...role, companyQuestions: { quick: [], written: [{ key: "wq_long", question: long, required: true }] } } as unknown as RolePacket;
      const start = newScreenProgress();
      expect(enforceTurnRules(turnOf({ questionKey: "wq_long", messageToCandidate: "Hi Meerub, this is the hiring team at Robotronics. Reply HUMAN at any time to reach a person." }), chatPacket(wordy, start), start, {}).messageToCandidate).toBe(`Hi Meerub, this is the hiring team at Robotronics. Reply HUMAN at any time to reach a person. ${long}`);
    });

    it("a question of several sentences that shares words with its own note is asked once, whole, when another note is left out", () => {
      const room = "Several kits fail at once in a class of twenty. How do you handle the room?";
      const both = { ...role, companyQuestions: { quick: [], written: [...(role.companyQuestions?.written ?? []).filter((w) => w.key === "wq_explain"), { key: "wq_room", question: room, required: true, lookFor: "notices when several kits fail at once and triages calmly" }] } } as unknown as RolePacket;
      const p: ScreenProgress = { ...newScreenProgress(), askedKeys: ["wq_explain"], currentQuestionKey: "wq_explain" };
      const pk = chatPacket(both, p);
      const moved = enforceTurnRules(turnOf({ questionKey: "wq_room", answerRecorded: { questionKey: "wq_explain", answer: "Like a thirsty finger.", complete: true }, messageToCandidate: `That uses a concrete everyday analogy and checks understanding with the children. ${room}` }), pk, p, {});
      expect(moved.messageToCandidate).toBe(`Thanks. ${room}`);
      // a follow-up on it that repeats the other note goes back to it, whole
      const onRoom: ScreenProgress = { ...p, askedKeys: ["wq_explain", "wq_room"], currentQuestionKey: "wq_room" };
      const push = enforceTurnRules(turnOf({ followUpReason: "push", messageToCandidate: `We look for someone who uses a concrete everyday analogy and checks understanding with the children. ${room}` }), pk, onRoom, { wq_explain: "Like a thirsty finger." });
      expect(push.messageToCandidate).toBe(room);
      for (const t of [moved, push]) expect(t.messageToCandidate).not.toMatch(/everyday analogy|triages calmly/);
    });

    it("the local stand-in asks the written questions by text, records each answer under its key, and closes", async () => {
      const fake = new FakeProvider();
      registerFakeHandlers(fake);
      const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
      const { callPrompt } = await import("@ros/ai");
      let progress = newScreenProgress();
      const pk = chatPacket(role, progress);
      const transcript: ScreenTranscriptEntry[] = [];
      const answers: Record<string, string> = {};
      const say = async (latest: string | null): Promise<ScreenTurn> => {
        if (latest !== null) transcript.push({ role: "candidate", content: latest, at, channel: "sms" });
        const ctx = screenContextOf({ companyName: "Robotronics", companyLocations: [], noticeOverrides: undefined, packet: pk, firstName: "Meerub", focusUnknowns: [], facts: null }, { channel: "sms", progress, answers, transcript }, latest);
        expect(ctx.chat).toBeNull();
        const r = await callPrompt(rt, screenTurnPrompt, ctx, { companyId: null });
        if (r.result.kind !== "ok") throw new Error(r.result.kind);
        const turn = enforceTurnRules(r.result.output, pk, progress, answers);
        progress = advanceProgress(progress, turn);
        if (turn.answerRecorded) answers[turn.answerRecorded.questionKey] = turn.answerRecorded.answer;
        transcript.push({ role: "assistant", content: turn.messageToCandidate, at, channel: "sms", questionKey: turn.questionKey ?? undefined });
        return turn;
      };
      const opening = await say(null);
      expect(opening.questionKey).toBe("wq_explain");
      expect(opening.messageToCandidate).toContain("How would you explain what a sensor is to six-year-olds?");
      const explain = "In 2024 I told 20 children a sensor is like a thirsty finger that feels the soil.";
      const room = "In 2023 I paired the 6 working kits with the broken ones and fixed them in turn.";
      expect((await say(explain)).messageToCandidate).toBe("Thanks. Several kits fail at once in a class of twenty. How do you handle the room?");
      expect((await say(room)).done).toBe(true);
      expect(answers).toEqual({ wq_explain: explain, wq_room: room });
      expect(transcript.filter((t) => t.role === "assistant" && t.questionKey).map((t) => t.questionKey)).toEqual(["wq_explain", "wq_room"]);
      // never the job's own screening question, never the note
      expect(transcript.some((t) => /pay range/.test(t.content))).toBe(false);
      expect(transcript.some((t) => noted.test(t.content))).toBe(false);
    });
  });
});

describe("the local stand-in for screen.turn v3", () => {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  const packet = { identity: { title: "Registered Dental Hygienist", employmentType: "full_time", locations: [{ city: "Irvine", region: "CA" }] }, compensation: { basis: "hourly", min: 45, max: 55, currency: "USD", discloseRange: true }, screening: { questions: [{ key: "experience", question: "Tell me about your most recent work.", kind: "skills" }, { key: "pay", question: "What pay range are you looking for?", kind: "compensation" }], maxMinutes: 10 }, competencies: [], requirements: { mustHaves: [] }, communication: { candidateMayBeTold: [], tone: "warm", humanAlternativeText: "Reply HUMAN." }, interviews: { plan: [] } } as unknown as RolePacket;
  const ctx = (progress: ScreenProgress, transcript: ScreenContext["transcript"], latest: string): ScreenContext => ({ company: { name: "Harbor Dental" }, packet, candidate: { firstName: "Dana" }, channel: "web", progress, answers: {}, transcript, focusUnknowns: [], latestCandidateMessage: latest });
  const turn = async (c: ScreenContext) => {
    const { callPrompt } = await import("@ros/ai");
    const r = await callPrompt(rt, screenTurnPrompt, c, { companyId: null });
    if (r.result.kind !== "ok") throw new Error(r.result.kind);
    return r.result.output;
  };

  it("follows up once on a thin answer about work, in the candidate's own words, then records the whole answer", async () => {
    const asked: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["experience"], currentQuestionKey: "experience" };
    const first = await turn(ctx(asked, [{ role: "assistant", content: "Tell me about your most recent work.", at: "t" }, { role: "candidate", content: "Cleanings and charting", at: "t" }], "Cleanings and charting"));
    expect(first.followUpReason).toBeTruthy();
    expect(first.messageToCandidate).toBe("You mentioned cleanings and charting. Could you give one example of how that went?");
    expect(first.answerRecorded).toBeNull();
    const after: ScreenProgress = { ...asked, followUps: { experience: 1 } };
    const second = await turn(ctx(after, [{ role: "assistant", content: "Tell me about your most recent work.", at: "t" }, { role: "candidate", content: "Cleanings and charting", at: "t" }, { role: "assistant", content: first.messageToCandidate, at: "t" }, { role: "candidate", content: "I see 9 patients a day and do perio charting in Dentrix.", at: "t" }], "I see 9 patients a day and do perio charting in Dentrix."));
    expect(second.answerRecorded?.answer).toBe("Cleanings and charting I see 9 patients a day and do perio charting in Dentrix.");
    // moving on: only the acknowledgment; the code adds the question word for word
    expect(second.questionKey).toBe("pay");
    expect(second.messageToCandidate).toBe("Thanks.");
    expect(enforceTurnRules(second, packet, after, {}).messageToCandidate).toBe("Thanks. What pay range are you looking for?");
  });

  it("asks one follow-up that quotes a fuller answer's own words, once in the conversation, so a local run shows it (polish list)", async () => {
    const asked: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["experience"], currentQuestionKey: "experience" };
    const said = "I ran the Instagram and TikTok accounts for a local skincare brand and grew both a lot.";
    const first = await turn(ctx(asked, [{ role: "assistant", content: "Tell me about your most recent work.", at: "t" }, { role: "candidate", content: said, at: "t" }], said));
    expect(first.followUpReason).toBeTruthy();
    expect(first.messageToCandidate).toBe("You said \"I ran the Instagram and TikTok accounts for a local skincare brand…\". Could you give one example of what that looked like, and what came of it?");
    expect(first.answerRecorded).toBeNull();
    // after it, the whole answer is recorded and the conversation moves on
    const after: ScreenProgress = { ...asked, followUps: { experience: 1 } };
    const more = "We ran a weekly creator series and the account went from a few hundred followers to several thousand.";
    const second = await turn(ctx(after, [{ role: "assistant", content: "Tell me about your most recent work.", at: "t" }, { role: "candidate", content: said, at: "t" }, { role: "assistant", content: first.messageToCandidate, at: "t" }, { role: "candidate", content: more, at: "t" }], more));
    expect(second.answerRecorded?.answer).toBe(`${said} ${more}`);
    expect(second.questionKey).toBe("pay");
    // once in the conversation: a later claim like it moves straight on
    const later: ScreenProgress = { ...EMPTY_SCREEN_PROGRESS, askedKeys: ["experience"], currentQuestionKey: "experience", followUps: { why: 1 } };
    expect((await turn(ctx(later, [{ role: "candidate", content: said, at: "t" }], said))).messageToCandidate).toBe("Thanks.");
    // an answer that already gives a figure or an example moves straight on too
    const withFigure = "I ran the Instagram for a skincare brand and grew it to 40,000 followers.";
    expect((await turn(ctx(asked, [{ role: "candidate", content: withFigure, at: "t" }], withFigure))).messageToCandidate).toBe("Thanks.");
    // screen.turn v8 (22 Oct 2026 try-out): an answer that already says how they found the cause and the fix is never
    // asked about again in other words
    const fixed = "I traced the slow checkout to a missing index on the orders table and added it during a quiet hour.";
    const after8 = await turn(ctx(asked, [{ role: "candidate", content: fixed, at: "t" }], fixed));
    expect(after8).toMatchObject({ followUpReason: null, questionKey: "pay", messageToCandidate: "Thanks." });
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
