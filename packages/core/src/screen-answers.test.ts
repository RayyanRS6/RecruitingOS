import { describe, expect, it } from "vitest";
import type { ScreenProgress, ScreenTranscriptEntry } from "@ros/contracts";
import { HANDED_TO_A_PERSON, WITHHELD_RUN_OUTPUT, conversationMessageOf, isUnsentConversationReading, screenAnswersSent, teamScreenView, unsentScreenReadings, withoutSentimentWords, withoutUnsentConversation, withoutUnsentInContext, withoutUnsentRunOutput, withoutUnsentScreenEvents } from "./screen-answers";

/**
 * "Hide them until they send" (founder decision, 9 October 2026; counsel register item 20): the pure rules every team
 * view reads a screening conversation through.
 */
const at = "2026-10-09T10:00:00.000Z";
const progress = (over: Partial<ScreenProgress> = {}): ScreenProgress => ({ askedKeys: ["license", "pay"], currentQuestionKey: "pay", followUps: { license: 1 }, confusedTurns: 0, failures: 0, flow: "one_visit", declined: ["pay"], edits: { license: 1 }, focusQuestions: [{ key: "unknown_1", question: "Is your license active?", whyItMatters: "Must-have", answer: "Yes, since 2019" }], ...over });
const transcript: ScreenTranscriptEntry[] = [
  { role: "assistant", content: "Is your license active?", at, questionKey: "license" },
  { role: "candidate", content: "Yes, CA RDH 12345", at, questionKey: "license", source: "tap" },
  { role: "system", content: "Skipped this question.", at, questionKey: "pay", source: "skip" },
  { role: "recruiter", content: "Called: license confirmed on the state site.", at, source: "recruiter_call", by: "Rae" },
];
const screen = (status: string, over: Partial<ScreenProgress> = {}) => ({ id: `s-${status}`, status, transcript, answers: { license: "Yes, CA RDH 12345" }, progress: progress(over) });

describe("whether the team may read a conversation", () => {
  it("only once the candidate sent it: complete, and not finished from a recruiter's call", () => {
    expect(screenAnswersSent({ status: "completed", progress: progress() })).toBe(true);
    for (const status of ["invited", "reminded", "in_progress", "paused", "unfinished", "declined_by_candidate", "human_requested", "abandoned", "expired", "cancelled"]) expect(screenAnswersSent({ status, progress: progress() }), status).toBe(false);
    expect(screenAnswersSent({ status: "completed", progress: progress({ completedBy: "recruiter_call" }) })).toBe(false);
  });

  it("an unsent conversation shows no answer, no line of the candidate's or the assistant's, and nothing about how far they got", () => {
    const view = teamScreenView(screen("in_progress"));
    expect(view.answersShared).toBe(false);
    expect(view.answers).toEqual({});
    expect(view.transcript).toEqual([transcript[3]]);
    expect(view.progress).toEqual({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0, flow: "one_visit", focusQuestions: [{ key: "unknown_1", question: "Is your license active?", whyItMatters: "Must-have" }] });
    expect(JSON.stringify(view)).not.toContain("RDH 12345");
    expect(JSON.stringify(view)).not.toContain("Yes, since 2019");
    // which list it asks (Wave S8) is no answer of theirs: it stays, so a recruiter's call notes go under those questions
    expect(teamScreenView(screen("human_requested", { asks: "written" })).progress.asks).toBe("written");
  });

  it("a sent conversation is shown whole", () => {
    const sent = screen("completed");
    expect(teamScreenView(sent)).toEqual({ ...sent, answersShared: true });
  });

  it("a reading of a conversation nobody sent is never shown; a complete one's is", () => {
    expect([...unsentScreenReadings([{ status: "unfinished", assessmentId: "a1" }, { status: "declined_by_candidate", assessmentId: "a2" }, { status: "completed", assessmentId: "a3" }, { status: "in_progress", assessmentId: null }])]).toEqual(["a1", "a2"]);
  });

  it("a reading written of an unsent conversation stays hidden once nothing links it, because it says so itself", () => {
    const incomplete = { anomalies: [{ kind: "incomplete_screen", detail: "The candidate stopped part-way and did not come back: 2 of 5 questions answered." }] };
    // finished on a recruiter's call: the screen is complete and no longer points at the old reading
    const screens = [{ status: "completed", assessmentId: "notes" }];
    const readings = [{ id: "old", kind: "screen", result: incomplete }, { id: "notes", kind: "screen", result: { anomalies: [] } }, { id: "resume", kind: "triage", result: incomplete }];
    expect([...unsentScreenReadings(screens, readings)]).toEqual(["old"]);
    expect(isUnsentConversationReading(readings[0])).toBe(true);
    // only a screening scorecard: a résumé reading is never one, whatever it carries
    expect(isUnsentConversationReading(readings[2])).toBe(false);
    expect(isUnsentConversationReading({ kind: "screen", result: null })).toBe(false);
    expect(isUnsentConversationReading({ kind: "screen", result: { anomalies: "x" } })).toBe(false);
  });
});

describe("the messages of a conversation", () => {
  const comm = (over: Record<string, unknown>) => ({ direction: "inbound", channel: "web", templateKey: null as string | null, tags: {} as Record<string, string>, idempotencyKey: null as string | null, bodyText: "x", ...over });

  it("knows which messages belong to a conversation, and to which one when they say", () => {
    expect(conversationMessageOf(comm({ tags: { screenId: "s1" }, channel: "sms" }))).toEqual({ screenId: "s1" });
    expect(conversationMessageOf(comm({}))).toEqual({ screenId: null });
    expect(conversationMessageOf(comm({ direction: "outbound", channel: "sms", templateKey: "screen_turn", idempotencyKey: "screen_turn:s2:7" }))).toEqual({ screenId: "s2" });
    expect(conversationMessageOf(comm({ channel: "email" }))).toBeNull();
    expect(conversationMessageOf(comm({ direction: "outbound", channel: "email", templateKey: "acknowledgment" }))).toBeNull();
  });

  it("holds back a conversation's messages until it is sent, and nothing else", () => {
    const typed = comm({ tags: { screenId: "s-open" }, bodyText: "my unsent answer" });
    const texted = comm({ channel: "sms", tags: { screenId: "s-done" }, bodyText: "my sent answer" });
    const reply = comm({ channel: "email", bodyText: "an email reply" });
    const untagged = comm({ bodyText: "an older web message" });
    const screens = [{ id: "s-open", status: "in_progress" }, { id: "s-done", status: "completed" }];
    expect(withoutUnsentConversation([typed, texted, reply, untagged], screens).map((m) => m.bodyText)).toEqual(["my sent answer", "an email reply"]);
    expect(withoutUnsentConversation([untagged], [{ id: "s-done", status: "completed" }]).map((m) => m.bodyText)).toEqual(["an older web message"]);
  });

  it("holds back the reminders that say how far they got ('you answered every question') while the conversation is unsent", () => {
    const review = comm({ direction: "outbound", channel: "email", templateKey: "screen_review_reminder", idempotencyKey: "screen_review_reminder:s-open", bodyText: "You answered every question" });
    const idle = comm({ direction: "outbound", channel: "email", templateKey: "screen_idle_reminder", idempotencyKey: "screen_idle_reminder:s-open", bodyText: "You stopped part-way" });
    const invite = comm({ direction: "outbound", channel: "email", templateKey: "screen_invite", idempotencyKey: "screen_invite:s-open", bodyText: "Here is the link" });
    expect(conversationMessageOf(review)).toEqual({ screenId: "s-open" });
    expect(conversationMessageOf(idle)).toEqual({ screenId: "s-open" });
    expect(conversationMessageOf(invite)).toBeNull();
    expect(withoutUnsentConversation([review, idle, invite], [{ id: "s-open", status: "in_progress" }]).map((m) => m.bodyText)).toEqual(["Here is the link"]);
    // closed without being sent: still held back
    expect(withoutUnsentConversation([review, idle], [{ id: "s-open", status: "unfinished" }])).toEqual([]);
    // sent: shown with the rest of the conversation
    expect(withoutUnsentConversation([review, idle], [{ id: "s-open", status: "completed" }])).toHaveLength(2);
  });
});

describe("a conversation's history entries", () => {
  const ev = (type: string, payload: Record<string, unknown>, subjectId = "s-open") => ({ type, subjectType: "screen", subjectId, payload });

  it("leave out single answers and counts for an unsent conversation, and how the candidate sounded", () => {
    const screens = [{ id: "s-open", status: "unfinished" }, { id: "s-done", status: "completed" }];
    const out = withoutUnsentScreenEvents([
      ev("screen.question_skipped", { questionKey: "pay" }),
      ev("screen.answer_tapped", { questionKey: "license" }),
      ev("screen.unfinished", { applicationId: "a1", answered: 2, questions: 5, stoppedAt: "pay" }),
      ev("screen.human_requested", { reason: "candidate sounded distressed" }),
      ev("screen.completed", { questionsAnswered: 5, skipped: 1 }, "s-done"),
      { type: "application.stage_changed", subjectType: "application", subjectId: "a1", payload: { to: "triaged" } },
    ], screens);
    expect(out.map((e) => e.type)).toEqual(["screen.unfinished", "screen.human_requested", "screen.completed", "application.stage_changed"]);
    expect(out[0].payload).toEqual({ applicationId: "a1", questions: 5 });
    expect(out[1].payload).toEqual({ reason: HANDED_TO_A_PERSON });
    // a sent conversation keeps its figures
    expect(out[2].payload).toEqual({ questionsAnswered: 5, skipped: 1 });
  });

  it("leave out every entry about a reading the team may not see, and what an unsent conversation's reading said", () => {
    const screens = [{ id: "s-open", status: "unfinished" }, { id: "s-call", status: "completed", progress: { completedBy: "recruiter_call" as const } }];
    const app = (type: string, payload: Record<string, unknown>) => ({ type, subjectType: "application", subjectId: "a1", payload });
    const out = withoutUnsentScreenEvents([
      app("assessment.created", { kind: "screen", assessmentId: "old", overall: "strong" }),
      ev("screen.assessed", { assessmentId: "old", recommendation: "strong_interview", confidence: "high", incomplete: true }),
      app("human.override", { action: "flag_assessment", assessmentId: "old", kind: "bias_concern" }),
      // without its id (an older entry): the screen being unread is enough
      ev("screen.assessed", { recommendation: "interview", confidence: "medium", incomplete: true }),
      ev("screen.unfinished", { applicationId: "a1", recommendation: "interview", questions: 5 }),
      // finished on a recruiter's call: its scorecard is read from the notes, and shown
      ev("screen.assessed", { assessmentId: "notes", recommendation: "interview", confidence: "medium" }, "s-call"),
      app("assessment.created", { kind: "screen", assessmentId: "notes", overall: "potential" }),
      app("assessment.created", { kind: "triage", assessmentId: "resume", overall: "strong" }),
    ], screens, new Set(["old"]));
    expect(out.map((e) => [e.type, e.payload.assessmentId ?? null])).toEqual([["screen.unfinished", null], ["screen.assessed", "notes"], ["assessment.created", "notes"], ["assessment.created", "resume"]]);
    expect(out[0].payload).toEqual({ applicationId: "a1", questions: 5 });
    expect(out[1].payload).toEqual({ assessmentId: "notes", recommendation: "interview", confidence: "medium" });
  });

  it("say a hand-over the same way whatever the assistant made of how the candidate sounded", () => {
    expect(withoutSentimentWords("Maria Reyes needs a person during the Hygienist screening (candidate sounded distressed). Please reach out.")).toBe(`Maria Reyes needs a person during the Hygienist screening (${HANDED_TO_A_PERSON}). Please reach out.`);
    expect(withoutSentimentWords("candidate sounded frustrated")).toBe(HANDED_TO_A_PERSON);
    expect(withoutSentimentWords("candidate asked for a person by email")).toBe("candidate asked for a person by email");
    expect(HANDED_TO_A_PERSON).not.toMatch(/sound|upset|distress|frustrat/i);
  });
});

describe("the ITS operations console", () => {
  const run = (task: string, screenId: string | null, out: Record<string, unknown> | null = { answerRecorded: { questionKey: "license", answer: "Yes, CA RDH 12345" } }) => ({ id: "r1", task, inputRef: screenId ? { screenId, turn: 3 } : {}, structuredOutput: out, status: "ok", latencyMs: 900 });
  const screens = [{ id: "s-open", status: "in_progress" }, { id: "s-done", status: "completed" }, { id: "s-call", status: "completed", progress: { completedBy: "recruiter_call" as const } }];

  it("withholds what an AI run read and wrote about a conversation the candidate has not sent, and keeps the rest", () => {
    const hidden = withoutUnsentRunOutput(run("screen.turn", "s-open"), screens);
    expect(hidden).toEqual({ ...run("screen.turn", "s-open"), structuredOutput: WITHHELD_RUN_OUTPUT });
    expect(JSON.stringify(hidden)).not.toContain("RDH 12345");
    // the candidate's own turns before a recruiter finished it on a call stay withheld; the notes' scorecard is shown
    expect(withoutUnsentRunOutput(run("screen.turn", "s-call"), screens).structuredOutput).toEqual(WITHHELD_RUN_OUTPUT);
    expect(withoutUnsentRunOutput(run("screen.assess", "s-call", { summary: "From the recruiter's notes." }), screens).structuredOutput).toEqual({ summary: "From the recruiter's notes." });
  });

  it("shows a sent conversation's runs, and runs about nothing of the kind, as they are", () => {
    expect(withoutUnsentRunOutput(run("screen.turn", "s-done"), screens)).toEqual(run("screen.turn", "s-done"));
    expect(withoutUnsentRunOutput(run("triage.read", null), screens)).toEqual(run("triage.read", null));
    expect(withoutUnsentRunOutput(run("screen.turn", "s-unknown"), screens)).toEqual(run("screen.turn", "s-unknown"));
  });

  it("withholds a repeat submission's turns and write-up until the address owner confirmed them (review of Wave S7)", () => {
    const detachedRun = (task: string) => ({ id: "r2", task, inputRef: { unconfirmedScreenId: "u1", turn: 1 }, structuredOutput: { answers: [{ answer: "I chart perio in Dentrix." }] }, status: "ok" });
    const rows = (confirmation: string | null) => [{ id: "u1", confirmation }];
    for (const task of ["screen.writeup", "screen.turn"]) {
      for (const confirmation of [null, "sent", "not_added", "discarded"]) expect(withoutUnsentRunOutput(detachedRun(task), screens, rows(confirmation)).structuredOutput, `${task} ${confirmation}`).toEqual(WITHHELD_RUN_OUTPUT);
      // not found: withheld too
      expect(withoutUnsentRunOutput(detachedRun(task), screens).structuredOutput).toEqual(WITHHELD_RUN_OUTPUT);
      expect(withoutUnsentRunOutput(detachedRun(task), screens, rows("confirmed"))).toEqual(detachedRun(task));
    }
  });
});

describe("a recruiter's captured context", () => {
  it("shows a captured conversation the team could not read as a recruiter's notes alone, however old the capture", () => {
    const ctx = withoutUnsentInContext({
      screens: [
        { channel: "web", status: "human_requested", transcript, answers: { license: "Yes, CA RDH 12345" } },
        { channel: "web", status: "completed", transcript, answers: { license: "Yes" }, answersShared: true },
      ],
      communications: [{ direction: "inbound", channel: "web", body: "Yes, CA RDH 12345" }, { direction: "inbound", channel: "email", body: "a reply" }],
    });
    const screens = ctx.screens as Array<{ answers: Record<string, string>; transcript: ScreenTranscriptEntry[]; answersShared: boolean }>;
    expect(screens[0]).toMatchObject({ answers: {}, answersShared: false, transcript: [transcript[3]] });
    expect(screens[1].answers).toEqual({ license: "Yes" });
    expect(ctx.communications).toEqual([{ direction: "inbound", channel: "email", body: "a reply" }]);
  });

  it("drops an older capture's reading of an unsent conversation, the history of it, and how the candidate sounded", () => {
    const incomplete = { summary: "Read from what she said before she stopped: 'Yes, CA RDH 12345'.", anomalies: [{ kind: "incomplete_screen", detail: "2 of 5 questions answered." }] };
    const ctx = withoutUnsentInContext({
      screens: [{ channel: "web", status: "unfinished", transcript, answers: { license: "Yes, CA RDH 12345" } }],
      assessments: [{ kind: "triage", overall: "potential", result: { anomalies: [] } }, { kind: "screen", overall: "strong", result: incomplete }],
      timeline: [
        { type: "assessment.created", payload: { kind: "screen", assessmentId: "old", overall: "strong" } },
        { type: "assessment.created", payload: { kind: "triage", assessmentId: "resume", overall: "potential" } },
        { type: "screen.assessed", payload: { recommendation: "interview", incomplete: true } },
        { type: "application.stage_changed", payload: { to: "triaged", reason: "candidate sounded distressed" } },
      ],
    });
    expect(ctx.assessments).toEqual([{ kind: "triage", overall: "potential", result: { anomalies: [] } }]);
    expect((ctx.timeline as Array<{ type: string; payload: Record<string, unknown> }>).map((t) => [t.type, t.payload.kind ?? null])).toEqual([["assessment.created", "triage"], ["application.stage_changed", null]]);
    expect(JSON.stringify(ctx)).not.toContain("RDH 12345");
    expect(JSON.stringify(ctx)).not.toContain("sounded");
  });

  it("keeps a capture made since 9 October as it was filtered then: the notes' scorecard of a call stays", () => {
    const notes = { summary: "From the recruiter's notes.", anomalies: [] };
    const ctx = withoutUnsentInContext({
      screens: [{ channel: "web", status: "completed", transcript: [transcript[3]], answers: {}, answersShared: false }],
      assessments: [{ kind: "screen", overall: "potential", result: notes }],
      timeline: [{ type: "assessment.created", payload: { kind: "screen", assessmentId: "notes", overall: "potential" } }],
    });
    expect(ctx.assessments).toEqual([{ kind: "screen", overall: "potential", result: notes }]);
    expect(ctx.timeline).toHaveLength(1);
  });
});
