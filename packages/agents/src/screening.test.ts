import { describe, expect, it } from "vitest";
import type { RolePacket, ScreenAssessment, ScreenProgress, ScreenTurn } from "@ros/contracts";
import { FakeProvider, screenAssessPrompt, screenTurnPrompt, type RunOutcome, type ScreenContext } from "@ros/ai";
import { EMPTY_SCREEN_PROGRESS, SCORECARD_READINGS, SCREEN_COMPLETE_MESSAGE, SCREEN_NEXT_LINE, TURN_CAP_CLOSE_MESSAGE, WITHDRAW_CONFIRM_KEY, advanceProgress, candidateWordsOf, enforceTurnRules, nextQuestion, recruiterNotesOf, reviewItems, saidByCandidate, scorecardReadings, screenAnswerOf, screenCommand, screenIntro, verifyScreenQuotes, withdrawPending } from "./screening";
import { answerInContext } from "./triage";
import { focusQuestionsFrom, unfairQuestion } from "./screen-focus";
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
    if (one.ok) expect(one.output.confidenceReasons).toContain(`the assistant could read this screening chat once instead of ${SCORECARD_READINGS}`);
    expect(scorecardReadings([invalid, outage, invalid], view, screen, packet)).toBe(outage);
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
  });
});
