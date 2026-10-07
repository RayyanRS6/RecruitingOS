import { describe, expect, it } from "vitest";
import type { ApplicationDetail, CandidateNotice } from "../../apps/web/src/api/client";
import { NO_QUOTE_LABEL, competencyUnquoted, isUnquoted, requirementUnquoted, scorecardUnavailable } from "../../apps/web/src/evidence";
import { actionToast, declineConfirmText, decisionToast, noticeText, outcomeToast } from "../../apps/web/src/talent-actions";

/**
 * The Talent page's words (plans 0.5, 0.6 and 0.9; founder decision B6: decisions are private, so every toast says
 * exactly whether the candidate was told): the toasts after each choice, the decline confirm step under each setting,
 * the "no quote" marks and the scorecard that could not be written. Pure functions, tested here.
 */
const NOTICES: CandidateNotice[] = ["queued", "already_sent", "pending_approval", "not_sent_settings", "not_sent_no_email", "not_sent", "not_told"];

describe("what the page says after a decision", () => {
  it("gives every outcome of the decline message its own words, and says 'not told' whenever nothing went", () => {
    const texts = NOTICES.map(noticeText);
    expect(new Set(texts).size).toBe(NOTICES.length);
    for (const n of ["pending_approval", "not_sent_settings", "not_sent_no_email", "not_sent", "not_told"] as CandidateNotice[]) expect(noticeText(n), n).toMatch(/not (been )?told/);
    expect(noticeText("queued")).toMatch(/on its way/);
    expect(noticeText("already_sent")).toMatch(/nothing new was sent/);
  });

  it("a decline toast never promises a message that did not go", () => {
    expect(actionToast("reject", { candidateNotice: "queued" })).toBe("Declined. A short, courteous message to the candidate is on its way.");
    expect(actionToast("reject", { candidateNotice: "pending_approval" })).toBe("Declined. The message to the candidate is waiting for approval; they have not been told yet.");
    expect(actionToast("reject", { candidateNotice: "not_sent_settings" })).toBe("Declined. No message was sent under your settings; the candidate has not been told.");
    expect(actionToast("reject", { candidateNotice: "not_sent_no_email" })).toBe("Declined. There is no email address on file, so the candidate has not been told.");
    // an older answer without the notice falls back on whether it went, and never says "on its way" when it did not
    expect(actionToast("reject", { dispositionSent: false })).toBe("Declined. No message has gone to the candidate yet.");
    for (const n of NOTICES) if (n !== "queued") expect(actionToast("reject", { candidateNotice: n })).not.toMatch(/on its way/);
  });

  it("a hold, a mark for interview and a move to the talent pool say the candidate was not told", () => {
    expect(actionToast("hold", { candidateNotice: "not_told" })).toBe("Saved. The candidate was not told.");
    expect(actionToast("advance_to_interview", { candidateNotice: "not_told" })).toMatch(/^Marked for interview\. The candidate was not told/);
    expect(actionToast("move_to_talent_pool", {})).toBe("Added to your talent pool. The candidate was not told.");
    // someone who asked not to be kept is never "added": the page says their choice stands
    const keptOut = actionToast("move_to_talent_pool", { candidateNotice: "not_told", talentPoolOptOut: true });
    expect(keptOut).toMatch(/^Moved out of this role\. They asked not to be kept for future roles, so they are not in your talent pool/);
    expect(keptOut).not.toMatch(/Added to your talent pool/);
    expect(keptOut).toMatch(/The candidate was not told\.$/);
    expect(actionToast("invite_screen", {})).toBe("Invitation on its way.");
    expect(actionToast("ask_in_screen", { next: "Invitation on its way. The screen starts with the open questions." })).toBe("Invitation on its way. The screen starts with the open questions.");
  });

  it("the interview decision and a recorded outcome report the message the same way", () => {
    expect(decisionToast("finalist", {})).toBe("Marked as a finalist.");
    expect(decisionToast("not_moving_forward", { candidateNotice: "pending_approval" })).toBe("Recorded. The message to the candidate is waiting for approval; they have not been told yet.");
    expect(outcomeToast("employer_declined", { candidateNotice: "not_sent_settings" })).toBe("Outcome recorded with your name. No message was sent under your settings; the candidate has not been told.");
    expect(outcomeToast("candidate_withdrew", {})).toBe("Outcome recorded with your name.");
  });
});

describe("the decline confirm step", () => {
  it("says before the click what the candidate will get under the company's settings", () => {
    expect(declineConfirmText("sends", { hasEmail: true })).toBe("Declining is your decision and is recorded with your reason. The candidate gets a short, courteous email.");
    expect(declineConfirmText("needs_approval", { hasEmail: true })).toMatch(/waits for approval before it goes out\.$/);
    expect(declineConfirmText("not_sent", { hasEmail: true })).toMatch(/no message is sent, so the candidate is not told\.$/);
    expect(declineConfirmText("sends", { hasEmail: false })).toMatch(/no email address on file/);
    // the eligibility decline names what its message says
    expect(declineConfirmText("sends", { hasEmail: true, eligibility: true })).toMatch(/their answers did not show/);
    for (const p of ["sends", "needs_approval", "not_sent"] as const) expect(declineConfirmText(p, { hasEmail: true })).not.toMatch(/respectful message/);
  });
});

describe("evidence marks", () => {
  it("marks a claim about the candidate with nothing quoted, and leaves sources that are not about them alone", () => {
    expect(NO_QUOTE_LABEL).toBe("no quote");
    expect(isUnquoted({ source: "resume", unquoted: true })).toBe(true);
    // readings written before the mark are read by the same rule
    expect(isUnquoted({ source: "resume" })).toBe(true);
    expect(isUnquoted({ source: "screen", quote: "  " })).toBe(true);
    expect(isUnquoted({ source: "resume", quote: "RDH license CA active" })).toBe(false);
    expect(isUnquoted({ source: "benchmark" })).toBe(false);
    expect(isUnquoted(undefined)).toBe(false);
    expect(requirementUnquoted({ met: "yes" })).toBe(true);
    expect(requirementUnquoted({ met: "unknown" })).toBe(false);
    expect(requirementUnquoted({ met: "partially", evidence: { source: "resume", quote: "perio charting" } })).toBe(false);
    expect(competencyUnquoted({ finding: "evidenced", evidence: { source: "resume" } })).toBe(true);
    expect(competencyUnquoted({ finding: "not_evidenced" })).toBe(false);
  });

  it("says the scorecard could not be written only when the latest screen's run gave up", () => {
    const withScreens = (screens: Array<Partial<ApplicationDetail["screens"][number]>>) => ({ screens } as unknown as ApplicationDetail);
    expect(scorecardUnavailable(withScreens([{ scorecard: "unavailable", recruiterAsked: true }]))).toEqual({ unavailable: true, recruiterAsked: true });
    expect(scorecardUnavailable(withScreens([{ scorecard: "writing" }]))).toEqual({ unavailable: false, recruiterAsked: false });
    // an older screen's failure is not the one on the page
    expect(scorecardUnavailable(withScreens([{ scorecard: "ready" }, { scorecard: "unavailable", recruiterAsked: true }]))).toEqual({ unavailable: false, recruiterAsked: false });
    expect(scorecardUnavailable(withScreens([]))).toEqual({ unavailable: false, recruiterAsked: false });
  });
});
