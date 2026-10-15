import { describe, expect, it } from "vitest";
import type { Screen, ScreeningFunnel, TimelineEvent } from "../../apps/web/src/api/client";
import { APPLIED_IN_ONE_VISIT, DIDNT_FINISH_LINE, SCREEN_STATUS_LABEL, STILL_APPLYING_LINE, answerLines, callNotesBody, callNotesMayStayOpen, callNotesQuestions, callNotesState, callNotesToast, funnelLines, generalNotes, hiddenAnswersLine, isRecruiterNote, minutesWords, offeredWithApplication, overviewScreenLine, recruiterNoteLabel, screenOrigin, shareWords, transcriptBubble, unansweredWords } from "../../apps/web/src/screen-view";

/**
 * The screening conversation as the team reads it (plan Wave E): "Applied and talked in one visit", questions the
 * candidate chose not to answer, answers changed before sending, a recruiter's call notes kept apart from the
 * candidate's own words, who may add those notes, and a role's figures in plain words.
 */
const at = "2026-10-08T10:00:00.000Z";
const questions = [
  { key: "q_saturdays", question: "Can you work Saturdays?" },
  { key: "q_pay", question: "What pay are you looking for?" },
  { key: "q_start", question: "When could you start?" },
  { key: "q_never", question: "A question nobody reached" },
];
function screen(over: Partial<Screen> = {}): Screen {
  return {
    id: "s1", channel: "web", status: "completed", invitedAt: at, startedAt: at, completedAt: at, remindedAt: null,
    transcript: [], answers: {}, progress: { askedKeys: [], currentQuestionKey: null }, assessmentId: null,
    ...over,
  };
}
const invitedEvent = (payload: Record<string, unknown>, subjectId?: string): TimelineEvent & { subjectId?: string } => ({ type: "screen.invited", occurredAt: at, actor: { kind: "system", id: "apply_page" }, payload, ...(subjectId ? { subjectId } : {}) });

describe("how the conversation reached them", () => {
  it("reads the screen's own invitedVia when the API sends it, never the flow alone", () => {
    expect(offeredWithApplication(screen({ invitedVia: "apply" }))).toBe(true);
    expect(offeredWithApplication(screen({ invitedVia: null }))).toBe(false);
    // a conversation in the one-visit flow whose link went by email (the allowance was used up) was not in the same visit
    expect(offeredWithApplication(screen({ invitedVia: null, progress: { askedKeys: [], currentQuestionKey: null, flow: "one_visit" } }))).toBe(false);
  });

  it("falls back on the invitation's history entry for an older answer, matched to this screen", () => {
    expect(offeredWithApplication(screen(), [invitedEvent({ invitedVia: "apply" })])).toBe(true);
    expect(offeredWithApplication(screen(), [invitedEvent({ invitedVia: "apply" }, "s1")])).toBe(true);
    expect(offeredWithApplication(screen(), [invitedEvent({ invitedVia: "apply" }, "s-other")])).toBe(false);
    expect(offeredWithApplication(screen(), [invitedEvent({ invitedBy: "system" })])).toBe(false);
  });

  it("says 'Applied and talked in one visit' once it is complete, and what happened otherwise", () => {
    expect(screenOrigin(screen({ invitedVia: "apply" }))).toBe(APPLIED_IN_ONE_VISIT);
    expect(APPLIED_IN_ONE_VISIT).toBe("Applied and talked in one visit");
    expect(screenOrigin(screen({ invitedVia: "apply", status: "in_progress" }))).toBe("Still applying");
    expect(screenOrigin(screen({ invitedVia: "apply", status: "paused" }))).toBe("Still applying");
    expect(screenOrigin(screen({ invitedVia: "apply", status: "declined_by_candidate" }))).toBe("Sent the application without the conversation");
    expect(screenOrigin(screen({ invitedVia: "apply", status: "human_requested" }))).toBe("Asked for a person while applying");
    expect(screenOrigin(screen({ invitedVia: "apply", status: "unfinished" }))).toBe("Didn't finish while applying");
    expect(screenOrigin(screen({ invitedVia: "apply", transcript: [{ role: "recruiter", content: "Can do Saturdays.", at, source: "recruiter_call", by: "Rae" }] }))).toBe("Finished on a call with a recruiter");
    expect(screenOrigin(screen({ invitedVia: "apply", answersShared: false, progress: { askedKeys: [], currentQuestionKey: null, completedBy: "recruiter_call" } }))).toBe("Finished on a call with a recruiter");
    expect(screenOrigin(screen({ invitedVia: "confirmed_repeat" }))).toBe("Added after they confirmed a second application");
    expect(screenOrigin(screen({ invitedVia: null }))).toBeNull();
  });

  it("puts one plain sentence on the Overview", () => {
    const a = (s: Screen) => ({ screens: [s], timeline: [], candidate: { firstName: "Sofia" } });
    expect(overviewScreenLine(a(screen({ invitedVia: "apply" })))).toMatch(/^Applied and talked in one visit/);
    expect(overviewScreenLine(a(screen({ invitedVia: "apply", status: "invited" })))).toBe("Still applying: their answers appear here once they send them. Nothing about Sofia waits on you until then.");
    expect(overviewScreenLine(a(screen({ invitedVia: "apply", status: "paused" })))).toContain("paused while the assistant is not working");
    expect(overviewScreenLine(a(screen({ status: "declined_by_candidate" })))).toContain("never held against them");
    expect(overviewScreenLine(a(screen({ status: "human_requested" })))).toContain("A recruiter contacts them");
    expect(overviewScreenLine(a(screen({ status: "human_requested" })))).toContain("was not sent, so you won't see it");
    // closed unfinished: that it happened, never what they said nor how far they got (founder decision of 9 October 2026)
    expect(overviewScreenLine(a(screen({ status: "unfinished" })))).toBe("Didn't finish the conversation: they did not send their answers, even after one reminder, so you won't see them. The AI review and match score use their application only.");
    // closed part-way when they withdrew or were declined while still applying
    expect(overviewScreenLine(a(screen({ status: "cancelled", answersShared: false })))).toBe("The screening chat closed before they sent their answers, so you won't see them. The AI review and match score use their application only.");
    expect(overviewScreenLine(a(screen({ status: "cancelled", answersShared: false, startedAt: null })))).toBeNull();
    expect(overviewScreenLine(a(screen({ invitedVia: null })))).toBeNull();
    expect(overviewScreenLine({ screens: [], timeline: [], candidate: { firstName: "Sofia" } })).toBeNull();
  });

  it("names every state in plain words", () => {
    expect(SCREEN_STATUS_LABEL.declined_by_candidate).toBe("Sent without it");
    expect(SCREEN_STATUS_LABEL.unfinished).toBe("Didn't finish the conversation");
    expect(SCREEN_STATUS_LABEL.paused).toBe("Paused");
  });
});

describe("answers the candidate has not sent (founder decision of 9 October 2026)", () => {
  const hidden = (over: Partial<Screen>) => screen({ answersShared: false, completedAt: null, ...over });

  it("says calmly why there is nothing to read while they are still applying", () => {
    expect(STILL_APPLYING_LINE).toBe("Still applying: their answers appear here once they send them.");
    for (const status of ["invited", "reminded", "in_progress", "paused"]) expect(hiddenAnswersLine(hidden({ invitedVia: "apply", status })), status).toBe(STILL_APPLYING_LINE);
    // a conversation from an emailed invitation: shown once it ends normally
    expect(hiddenAnswersLine(hidden({ invitedVia: null, status: "in_progress" }))).toBe("Still answering: their answers appear here once they finish the conversation.");
    expect(hiddenAnswersLine(hidden({ invitedVia: null, status: "invited" }))).toBe("Not started yet: their answers appear here once they finish the conversation.");
    // paused while the assistant is down: an emailed conversation is never called "still applying"
    expect(hiddenAnswersLine(hidden({ invitedVia: null, status: "paused" }))).toBe("Still answering: their answers appear here once they finish the conversation.");
  });

  it("says what happened when it closed without being sent, never what they said", () => {
    expect(hiddenAnswersLine(hidden({ status: "unfinished" }))).toBe(DIDNT_FINISH_LINE);
    expect(DIDNT_FINISH_LINE).toMatch(/^Didn't finish the conversation/);
    expect(hiddenAnswersLine(hidden({ status: "declined_by_candidate" }))).toBe("They sent their application without the conversation, so there are no answers to show.");
    expect(hiddenAnswersLine(hidden({ status: "human_requested" }))).toContain("a recruiter adds notes from the call");
    expect(hiddenAnswersLine(hidden({ status: "completed", progress: { askedKeys: [], currentQuestionKey: null, completedBy: "recruiter_call" } }))).toContain("only the recruiter's notes are shown");
    expect(hiddenAnswersLine(hidden({ status: "abandoned" }))).toContain("not sent");
    // started, then closed when they withdrew from their status page or the team declined them while still applying
    expect(hiddenAnswersLine(hidden({ status: "cancelled" }))).toBe("The conversation closed before they sent their answers, so you won't see them.");
    // nothing was ever there to hide: no line
    expect(hiddenAnswersLine(hidden({ status: "expired" }))).toBeNull();
    expect(hiddenAnswersLine(hidden({ status: "cancelled", startedAt: null }))).toBeNull();
  });

  it("says the same whether they stopped at the first question or answered everything and never pressed Send", () => {
    expect(DIDNT_FINISH_LINE).toBe("Didn't finish the conversation: they did not send their answers, even after one reminder, so you won't see them.");
    expect(DIDNT_FINISH_LINE).not.toMatch(/part-way|every question|answered/);
  });

  it("says nothing once the answers are sent, or for an older answer that does not say", () => {
    expect(hiddenAnswersLine(screen({ answersShared: true }))).toBeNull();
    expect(hiddenAnswersLine(screen({}))).toBeNull();
  });
});

describe("each answer and what they did with it", () => {
  const s = screen({
    answers: { q_saturdays: "Yes", q_start: "I can start on Monday, November 2, 2026." },
    progress: { askedKeys: ["q_saturdays", "q_pay", "q_start"], currentQuestionKey: null, declined: ["q_pay"], edits: { q_start: 1 } },
    transcript: [
      { role: "assistant", content: "Can you work Saturdays?", at, questionKey: "q_saturdays" },
      { role: "candidate", content: "Yes", at, questionKey: "q_saturdays", source: "tap" },
      { role: "system", content: "Skipped this question.", at, questionKey: "q_pay", source: "skip" },
      { role: "candidate", content: "In two weeks", at, questionKey: "q_start" },
      { role: "candidate", content: "I can start on Monday, November 2, 2026.", at, questionKey: "q_start", source: "edit" },
      { role: "recruiter", content: "Prefers mornings on Saturdays.", at, questionKey: "q_saturdays", source: "recruiter_call", by: "Rae Recruiter" },
      { role: "recruiter", content: "Very warm on the phone.", at, source: "recruiter_call", by: "Rae Recruiter" },
    ],
  });

  it("lists the questions that came up, in the packet's order, with what the candidate did", () => {
    const lines = answerLines(s, questions);
    expect(lines.map((l) => l.key)).toEqual(["q_saturdays", "q_pay", "q_start"]);
    expect(lines[0]).toMatchObject({ answer: "Yes", tapped: true, edited: false, declined: false, notes: [{ text: "Prefers mornings on Saturdays.", by: "Rae Recruiter" }] });
    // a skipped question is "chose not to answer", never an answer
    expect(lines[1]).toMatchObject({ answer: null, declined: true, edited: false, tapped: false, notes: [] });
    // an answer changed on the check-your-answers page is marked
    expect(lines[2]).toMatchObject({ answer: "I can start on Monday, November 2, 2026.", edited: true, tapped: false });
  });

  it("keeps a recruiter's notes that are not about one question apart", () => {
    expect(generalNotes(s, questions)).toEqual([{ text: "Very warm on the phone.", by: "Rae Recruiter" }]);
  });

  it("says a question with no answer is still to come while the conversation is open", () => {
    expect(unansweredWords("in_progress")).toBe("Not answered yet");
    expect(unansweredWords("paused")).toBe("Not answered yet");
    expect(unansweredWords("unfinished")).toBe("Not answered");
  });

  it("draws each transcript line with its label: a skip, a change, a tap, and a recruiter's notes", () => {
    const bubbles = s.transcript.map(transcriptBubble);
    expect(bubbles[1]).toEqual({ kind: "user", label: "Picked from the choices", text: "Yes" });
    expect(bubbles[2]).toEqual({ kind: "system", label: null, text: "Chose not to answer this question." });
    expect(bubbles[3]).toEqual({ kind: "user", label: null, text: "In two weeks" });
    expect(bubbles[4].label).toBe("Changed on the check-your-answers page");
    expect(bubbles[5]).toEqual({ kind: "recruiter", label: "Notes from a call by Rae Recruiter. Not the candidate's own words.", text: "Prefers mornings on Saturdays." });
    expect(bubbles[0].kind).toBe("assistant");
  });

  it("never passes a recruiter's notes off as the candidate's words", () => {
    expect(isRecruiterNote({ role: "recruiter" })).toBe(true);
    expect(isRecruiterNote({ role: "system", source: "recruiter_call" })).toBe(true);
    expect(isRecruiterNote({ role: "candidate", source: "chat" })).toBe(false);
    expect(recruiterNoteLabel(null)).toBe("Notes from a call by a recruiter. Not the candidate's own words.");
  });
});

describe("a recruiter's notes from a call (plan E3)", () => {
  const detail = (status: string | null, stage = "screen_invited") => ({ stage, screens: status ? [screen({ status })] : [] });

  it("is for recruiters only, the company's own or ITS under a grant", () => {
    for (const role of ["owner", "admin", "hiring_manager", "hr", "interviewer", null]) expect(callNotesState(detail("human_requested"), role).show, String(role)).toBe(false);
    expect(callNotesState(detail("human_requested"), "recruiter")).toEqual({ show: true, prominent: true });
  });

  it("waits at the top when the candidate asked for a person, and is a quiet choice otherwise", () => {
    expect(callNotesState(detail("in_progress"), "recruiter")).toEqual({ show: true, prominent: false });
    expect(callNotesState(detail("unfinished"), "recruiter")).toEqual({ show: true, prominent: false });
    expect(callNotesState(detail(null, "triaged"), "recruiter")).toEqual({ show: true, prominent: false });
  });

  it("with no conversation yet the notes are the screening and finish it; only an existing one can stay open", () => {
    expect(callNotesMayStayOpen(detail(null, "triaged"))).toBe(false);
    expect(callNotesMayStayOpen(detail("human_requested"))).toBe(true);
    expect(callNotesMayStayOpen(detail("in_progress"))).toBe(true);
  });

  it("is not offered once the conversation is complete, withdrawn or stopped, or past the screening step", () => {
    for (const status of ["completed", "abandoned", "cancelled"]) expect(callNotesState(detail(status), "recruiter").show, status).toBe(false);
    expect(callNotesState(detail("human_requested", "interview_scheduled"), "recruiter").show).toBe(false);
    expect(callNotesState(detail("human_requested", "rejected"), "recruiter").show).toBe(false);
  });

  it("sends only what was written, per question where it fits, and says what it did", () => {
    expect(callNotesBody({ q_saturdays: "  Yes, mornings.  ", q_pay: "   " }, " Warm. ", true)).toEqual({ notes: [{ questionKey: "q_saturdays", text: "Yes, mornings." }, { text: "Warm." }], complete: true });
    expect(callNotesBody({ q_pay: "" }, "", true)).toBeNull();
    expect(callNotesBody({}, "Left a voicemail.", false)).toEqual({ notes: [{ text: "Left a voicemail." }], complete: false });
    expect(callNotesToast({ completed: true }, "Sofia").detail).toContain("never as their own words");
    expect(callNotesToast({ completed: false }, "Sofia")).toEqual({ title: "Notes added.", detail: "The conversation stays open for Sofia." });
  });

  it("lists the questions the conversation asks, so each note keeps its question (Wave S8: the written ones on a conversation created since)", () => {
    const written = [{ key: "wq_calm", question: "Tell us about a time you calmed a nervous patient.", required: true, source: "company" as const }];
    const labels = { mustHaves: [], competencies: [], questions: questions.slice(0, 2), written };
    const keys = (screens: Screen[], packetLabels: typeof labels | Omit<typeof labels, "written"> = labels) => callNotesQuestions({ screens, packetLabels }).map((q) => q.key);
    // since Wave S8, and the conversation the notes start when there is none: the written questions
    expect(keys([screen({ status: "human_requested", progress: { askedKeys: [], currentQuestionKey: null, asks: "written" } })])).toEqual(["wq_calm"]);
    expect(keys([])).toEqual(["wq_calm"]);
    // its open questions first, as it asks them
    expect(keys([screen({ status: "in_progress", progress: { askedKeys: [], currentQuestionKey: null, asks: "written", focusQuestions: [{ key: "unknown_1", question: "Is your license current?" }] } })])).toEqual(["unknown_1", "wq_calm"]);
    // one from before asks the job's screening questions; an older answer without `written` gives them too
    expect(keys([screen({ status: "in_progress" })])).toEqual(["q_saturdays", "q_pay"]);
    expect(keys([], { mustHaves: [], competencies: [], questions: questions.slice(0, 2) })).toEqual(["q_saturdays", "q_pay"]);
  });
});

describe("how the conversation goes for a role (plan E13)", () => {
  const funnel: ScreeningFunnel = { offered: 10, started: 8, finished: 6, unfinished: 1, stillApplying: 1, medianMinutes: 6.4, personChosen: { contactMe: 1, sendWithout: 1 }, skipped: [{ key: "q_pay", question: "What pay are you looking for?", count: 3 }] };

  it("puts the figures in plain words, with each share of the step before, and never where anyone stopped", () => {
    expect(funnelLines(funnel)).toEqual([
      { label: "Offered the conversation", value: "10" },
      { label: "Started it", value: "8 of 10 (80%)" },
      { label: "Finished it", value: "6 of 8 (75%)" },
      { label: "Typical time to finish", value: "about 6 minutes" },
      { label: "Still applying now", value: "1" },
      { label: "Didn't finish the conversation", value: "1" },
      { label: "Chose a person instead", value: "2: 1 asked to be contacted, 1 sent their application without it" },
    ]);
    // every conversation that stopped was never sent, so where it stopped is theirs (founder decision of 9 October 2026)
    expect(JSON.stringify(funnelLines(funnel))).not.toMatch(/stopped/i);
  });

  it("says nothing while nobody has been offered it, and copes with nothing finished yet", () => {
    expect(funnelLines({ ...funnel, offered: 0 })).toEqual([]);
    const none = funnelLines({ offered: 2, started: 0, finished: 0, unfinished: 0, stillApplying: 2, medianMinutes: null, personChosen: { contactMe: 0, sendWithout: 0 }, skipped: [] });
    expect(none.find((l) => l.label === "Typical time to finish")?.value).toBe("nobody has finished yet");
    expect(none.find((l) => l.label === "Finished it")?.value).toBe("0");
    expect(none.find((l) => l.label === "Chose a person instead")?.value).toBe("nobody");
  });

  it("says minutes and shares the way people say them", () => {
    expect(minutesWords(null)).toBeNull();
    expect(minutesWords(0.4)).toBe("under a minute");
    expect(minutesWords(1.2)).toBe("about 1 minute");
    expect(minutesWords(9.6)).toBe("about 10 minutes");
    expect(shareWords(1, 3)).toBe("1 of 3 (33%)");
    expect(shareWords(0, 0)).toBe("0");
  });
});
