import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EvidenceAssessment, ResumeExtraction, ScreenAssessment } from "./assessment";
import { EventType } from "./events";
import { SCREEN_ACTIVE_STATUSES, SCREEN_LINK_OPEN_DAYS, SCREEN_REMINDER_AFTER_HOURS, ScreenProgress, ScreenStatus, ScreenTranscriptEntry, ScreenTurn, aiInterviewStatusOf } from "./screen";

describe("where an AI interview stands for the team", () => {
  it("comes from its stored status: sent, started, link closed, chose not to do it, done", () => {
    expect(ScreenStatus.options.map((s) => [s, aiInterviewStatusOf(s)])).toEqual([
      ["invited", "sent"],
      ["reminded", "sent"],
      ["in_progress", "started"],
      ["completed", "done"],
      ["expired", "link_closed"],
      ["declined_by_candidate", "opted_out"],
      ["cancelled", null],
    ]);
    expect(SCREEN_ACTIVE_STATUSES).toEqual(["invited", "reminded", "in_progress"]);
    for (const gone of ["paused", "human_requested", "unfinished", "abandoned"]) expect(ScreenStatus.safeParse(gone).success, gone).toBe(false);
  });

  it("is open five days, with one reminder after 48 hours", () => {
    expect([SCREEN_LINK_OPEN_DAYS, SCREEN_REMINDER_AFTER_HOURS]).toEqual([5, 48]);
  });

  it("is a web chat between the assistant and the candidate, with nothing of the removed ways in its record", () => {
    expect(ScreenTranscriptEntry.safeParse({ role: "recruiter", content: "Call notes", at: "2026-11-18T10:00:00.000Z" }).success).toBe(false);
    expect(ScreenTranscriptEntry.safeParse({ role: "candidate", content: "Hello", at: "2026-11-18T10:00:00.000Z", source: "sms" }).success).toBe(false);
    const progress = ScreenProgress.parse({ flow: "one_visit", pausedAt: "2026-11-01T00:00:00.000Z", writeup: { v: 1 }, focusQuestions: [{ key: "unknown_1", question: "x" }], asks: "written", submittedAt: "2026-11-18T10:00:00.000Z" });
    expect(progress).toEqual({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0, submittedAt: "2026-11-18T10:00:00.000Z" });
  });

  // The code check of 25 November 2026: the model was asked to record each answer (its words, whether it was complete, a
  // status) and the code used none of it, building the answer on record from the candidate's own replies.
  it("a turn as the model writes it carries no record of an answer: the model is not asked for one, and a turn written before still parses, without it", () => {
    const written = { messageToCandidate: "You see nine patients a day.\n\nWhich software do you chart in?", questionKey: "software", followUpReason: null, candidateAskedAbout: null, sentiment: "fine", done: false, humanRequested: false, reading: "concrete" };
    expect(ScreenTurn.parse({ ...written, answerRecorded: { questionKey: "recent", answer: "I see nine patients a day.", complete: true, status: "answered" } })).toEqual(written);
    expect(ScreenTurn.parse({ ...written, answerRecorded: null })).toEqual(written);
    // the shape the model is sent: the message, and what the code reads of the turn
    const asked = z.toJSONSchema(ScreenTurn) as { properties?: Record<string, unknown> };
    expect(Object.keys(asked.properties ?? {}).sort()).toEqual(["candidateAskedAbout", "done", "followUpReason", "humanRequested", "messageToCandidate", "questionKey", "reading", "sentiment"]);
    expect(JSON.stringify(asked)).not.toMatch(/"(?:answerRecorded|answer|complete|status)"/);
  });
});

describe("what the AI writes about a candidate", () => {
  const evidence = { source: "resume", quote: "RDA license, Colorado" };
  const words = { summary: "Experienced assistant.", strengths: [{ claim: "Licensed", evidence }], concerns: [], unknowns: [{ question: "Weekend availability?", whyItMatters: "The office opens Saturdays." }] };

  it("is findings with quotes and words for the CV reading: no verdict, no number, no recommendation", () => {
    const stored = { ...words, overall: "strong", confidence: "high", confidenceReasons: ["Clear CV"], secondaryScore: 88, recommendation: "screen", rationale: "Looks good.", anomalies: [{ kind: "other", detail: "x" }], requirementFindings: [{ requirementKey: "mh_1", met: "yes", evidence }], competencyFindings: [{ competencyKey: "chairside", finding: "partially_evidenced", note: "Some" }] };
    const reading = EvidenceAssessment.parse(stored);
    expect(Object.keys(reading).sort()).toEqual(["competencyFindings", "concerns", "requirementFindings", "strengths", "summary", "unknowns"]);
    expect(reading.requirementFindings).toEqual([{ requirementKey: "mh_1", met: "yes", evidence }]);
    expect(EvidenceAssessment.parse({ summary: "Nothing to go on." })).toEqual({ summary: "Nothing to go on.", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [] });
  });

  it("is one finding per question and words for the AI interview's scorecard, and nothing else", () => {
    const stored = { ...words, overall: "potential", confidence: "medium", recommendation: "interview", compensationExpectation: { withinRange: "yes" }, availability: { matchesSchedule: "yes" }, eligibilityConfirmations: [{ key: "license", confirmed: "yes" }], requirementFindings: [{ requirementKey: "mh_1", met: "yes" }], questionFindings: [{ questionKey: "sq_1", answered: true, finding: "Gave a concrete day.", evidence: { source: "screen", quote: "We saw 40 patients" }, meetsModelAnswer: "yes" }, { questionKey: "sq_2", answered: false, finding: "Skipped." }] };
    const scorecard = ScreenAssessment.parse(stored);
    expect(Object.keys(scorecard).sort()).toEqual(["concerns", "questionFindings", "strengths", "summary", "unknowns"]);
    expect(scorecard.questionFindings.map((q) => [q.questionKey, q.meetsModelAnswer])).toEqual([["sq_1", "yes"], ["sq_2", "unknown"]]);
    // Whether each question was answered was asked of the model and read by nothing (the code check of 25 November
    // 2026): the record says it. A scorecard stored before still parses, without it, and the model is no longer asked.
    expect(scorecard.questionFindings).toEqual([{ questionKey: "sq_1", finding: "Gave a concrete day.", evidence: { source: "screen", quote: "We saw 40 patients" }, meetsModelAnswer: "yes" }, { questionKey: "sq_2", finding: "Skipped.", meetsModelAnswer: "unknown" }]);
    const asked = z.toJSONSchema(ScreenAssessment) as { properties?: { questionFindings?: { items?: { properties?: Record<string, unknown> } } } };
    expect(Object.keys(asked.properties?.questionFindings?.items?.properties ?? {}).sort()).toEqual(["evidence", "finding", "meetsModelAnswer", "questionKey"]);
    expect(JSON.stringify(asked)).not.toContain('"answered"');
  });

  it("a quote is its source and the words quoted: the model is asked for no confidence, verdict or number, and none is kept", () => {
    const stored = { ...words, strengths: [{ claim: "Licensed", evidence: { ...evidence, confidence: "high", context: "Coastal, 2019", ref: "line 3" } }], questionFindings: [{ questionKey: "sq_1", answered: true, finding: "Gave a concrete day.", evidence: { source: "screen", quote: "We saw 40 patients", confidence: "low" } }] };
    expect(EvidenceAssessment.parse(stored).strengths[0]?.evidence).toEqual(evidence);
    expect(ScreenAssessment.parse(stored).questionFindings[0]?.evidence).toEqual({ source: "screen", quote: "We saw 40 patients" });
    // the shape each reading is asked for, as the model is sent it
    for (const asked of [EvidenceAssessment, ScreenAssessment]) expect(JSON.stringify(z.toJSONSchema(asked))).not.toMatch(/"(?:confidence|context|ref|overall|recommendation|score|rationale|anomalies)"/);
  });

  it("never quotes a source the product no longer has", () => {
    for (const gone of ["recruiter_note", "interview", "playbook", "benchmark"]) expect(EvidenceAssessment.safeParse({ summary: "x", strengths: [{ claim: "c", evidence: { source: gone } }] }).success, gone).toBe(false);
  });

  it("a resume's facts keep only what something reads: an older stored row still parses, and the model is asked for nothing else", () => {
    const stored = {
      fullName: "Dana Kim", email: "dana.kim@example.com", phone: "(303) 555-0100", locationText: "Denver, CO", headline: "Registered Dental Hygienist",
      positions: [{ title: "Hygienist", employer: "Mile High Dental", startDate: "2019", current: true, quote: "Hygienist at Mile High Dental 2019 - present" }],
      education: [{ institution: "Cypress College", credential: "A.S.", field: "Dental Hygiene" }],
      licenses: [{ name: "RDH", jurisdiction: "CO", number: "RDH-1", expires: "2027-01-31", quote: "RDH license CO active" }], certifications: [{ name: "BLS" }], skills: ["Dentrix"], languages: ["Spanish"],
      yearsOfExperienceEstimate: 6, anomalies: [{ kind: "other", detail: "x" }], confidence: "high",
    };
    // the years of experience, a licence's number and its expiry date had no reader either (the code check of 25 November 2026)
    expect(ResumeExtraction.parse(stored)).toEqual({
      fullName: "Dana Kim", locationText: "Denver, CO",
      positions: [{ title: "Hygienist", employer: "Mile High Dental", startDate: "2019", current: true, quote: "Hygienist at Mile High Dental 2019 - present" }],
      licenses: [{ name: "RDH", jurisdiction: "CO", quote: "RDH license CO active" }], certifications: [{ name: "BLS" }], skills: ["Dentrix"],
    });
    // no part of the shape the model is sent has one of those names (a name is a key: "number" may still be a value's type)
    expect(JSON.stringify(z.toJSONSchema(ResumeExtraction))).not.toMatch(/"(?:email|phone|headline|education|languages|anomalies|confidence|yearsOfExperienceEstimate|number|expires)":/);
  });
});

describe("the facts the product records", () => {
  it("has no event of a removed feature", () => {
    const gone = /^(interview|offer|posting|approval|note|policy|pool|calendar|scorecard|debrief|reference|background_check|onboarding|employee|intervention|integration|application_link)\./;
    expect(EventType.options.filter((t) => gone.test(t))).toEqual([]);
    for (const t of ["company.verified", "company.unverified", "application.ineligible", "application.marked", "application.moved_to_talent_pool", "screen.paused", "screen.human_requested", "message.held", "message.received", "role.sent_back", "outcome.corrected"]) expect(EventType.safeParse(t).success, t).toBe(false);
    expect(new Set(EventType.options).size).toBe(EventType.options.length);
  });

  it("still records the simple flow from start to end", () => {
    for (const t of ["company.access_accepted", "intake.started", "role.opened", "application.received", "assessment.created", "application.triaged", "screen.invited", "screen.completed", "screen.assessed", "application.stage_changed", "application.told", "outcome.recorded"]) expect(EventType.safeParse(t).success, t).toBe(true);
  });
});
