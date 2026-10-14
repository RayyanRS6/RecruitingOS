import { describe, expect, it } from "vitest";
import { plainRequestText, stoppedRunQuestion } from "./stopped-runs";

/**
 * A stopped run's request in plain words. Rows stored before 13 October 2026 carried the technical error; wherever a
 * request is shown (Today, the customer's requests, the recruiter's full view) they read in today's words instead.
 */
describe("a stopped run's request, in plain words", () => {
  it("says what stopped and after how many tries", () => {
    expect(stoppedRunQuestion("application_intake", 4)).toBe("Processing this application stopped after 4 tries and needs a person to take over.");
    expect(stoppedRunQuestion("schedule_interview", 1)).toBe("Scheduling this interview stopped after the first try and needs a person to take over.");
    expect(stoppedRunQuestion("something_else", 3)).toBe("An automatic step stopped after 3 tries and needs a person to take over.");
  });

  it("turns the two requests seen on staging into plain words", () => {
    expect(plainRequestText('Workflow application_intake failed at step "extract" after 4 attempts: provider error: 400 {"type":"error","error":{...}}. Please take over.')).toBe("Processing this application stopped after 4 tries and needs a person to take over.");
    expect(plainRequestText('Workflow application_intake failed at step "extract" after 4 attempts: provider error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: Input should be a valid list. Please check."}}. Please take over.')).toBe("Processing this application stopped after 4 tries and needs a person to take over.");
    expect(plainRequestText('Workflow application_intake failed at step "eligibility" after 4 attempts: required.filter is not a function. Please take over.')).toBe("Processing this application stopped after 4 tries and needs a person to take over.");
  });

  it("handles one attempt, an error over several lines, and a workflow it has no words for", () => {
    expect(plainRequestText('Workflow screen failed at step "assess" after 1 attempts: boom. Please take over.')).toBe("The screening chat stopped after the first try and needs a person to take over.");
    expect(plainRequestText('Workflow schedule_interview failed at step "offer" after 2 attempts: Error: calendar said no\n    at offer (schedule.ts:10)\n    at run (engine.ts:20). Please take over.')).toBe("Scheduling this interview stopped after 2 tries and needs a person to take over.");
    expect(plainRequestText('Workflow nightly_cleanup failed at step "sweep" after 3 attempts: timeout. Please take over.')).toBe("An automatic step stopped after 3 tries and needs a person to take over.");
  });

  it("leaves everything else exactly as written", () => {
    const middle = 'We saw "Workflow application_intake failed at step "extract" after 4 attempts: boom. Please take over." in an email; can you check Maria?';
    expect(plainRequestText(middle)).toBe(middle);
    const ownWords = "Is Maria Reyes worth a working interview? She wants $60 an hour. Please take over.";
    expect(plainRequestText(ownWords)).toBe(ownWords);
    const today = "Processing this application stopped after 4 tries and needs a person to take over.";
    expect(plainRequestText(today)).toBe(today);
    expect(plainRequestText("")).toBe("");
    // the end of the old words must be the end of the text
    const trailing = 'Workflow application_intake failed at step "extract" after 4 attempts: boom. Please take over. And call me.';
    expect(plainRequestText(trailing)).toBe(trailing);
  });
});
