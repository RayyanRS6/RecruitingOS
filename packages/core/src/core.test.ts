import { describe, expect, it } from "vitest";
import { ApplicationStage as ApplicationStageEnum, CANDIDATE_STEP_LABEL, OWNER_STAGE_LABEL, type ApplicationStage, type OwnerStage } from "@ros/contracts";
import { REOPEN_TARGETS, canTransition, candidateStep, decisionTold, groupFor, holdEnded, holdRunning, markBlockedReason, mayWithdraw, ownerGroup, ownerStage, ownerStageLabel, ownerTags, reopenStage } from "./stages";
import { MarkError, holdUntil } from "./marks";
import { evaluateEligibility } from "./eligibility";
import { dedupeKey, normalizePhone } from "./dedupe";
import { DEFAULT_POLICIES, HARD_HUMAN_ONLY } from "./policy";
import { can } from "./permissions";
import { noticesFor, resolveJurisdictions } from "./compliance";
import { alertHeadline } from "./notify-email";

describe("state machine", () => {
  it("never lets the system reject on judgment", () => {
    expect(canTransition("triaged", "rejected", "system")).toBe(false);
    expect(canTransition("screen_complete", "rejected", "agent")).toBe(false);
    expect(canTransition("triaged", "rejected", "owner")).toBe(true);
  });
  it("never lets the system decline on an eligibility answer either; the hold is for a person", () => {
    expect(canTransition("ineligible", "rejected", "system")).toBe(false);
    expect(canTransition("ineligible", "rejected", "owner")).toBe(true);
    expect(canTransition("ineligible", "eligible", "owner")).toBe(true);
    expect(canTransition("ineligible", "eligible", "system")).toBe(false);
  });
  it("hire decisions are human", () => {
    expect(canTransition("debrief", "finalist", "system")).toBe(false);
    expect(canTransition("debrief", "finalist", "hiring_manager")).toBe(true);
  });
  it("candidates can withdraw from any active stage", () => {
    expect(canTransition("screening", "withdrawn", "candidate")).toBe(true);
    expect(canTransition("hired", "withdrawn", "candidate")).toBe(false);
  });
  it("groups stages for owners; someone held on an eligibility answer waits on a person (plan A2)", () => {
    expect(ownerGroup("triaged")).toBe("waiting_on_you");
    expect(ownerGroup("screening")).toBe("in_process");
    expect(ownerGroup("rejected")).toBe("not_moving_forward");
    expect(ownerGroup("ineligible")).toBe("waiting_on_you");
    expect(ownerTags({ stage: "ineligible" })).toEqual(["Check eligibility"]);
    expect(ownerTags({ stage: "triaged" })).toEqual([]);
  });
  it("lets a person take back a decision the candidate was never told, to the step it was made from, and nothing else (plan G1)", () => {
    const undo = (toldState: string) => ({ undoDecision: true, toldState });
    expect(canTransition("rejected", "triaged", "owner", undo("not_told"))).toBe(true);
    expect(canTransition("talent_pool", "interview_recommended", "hiring_manager", undo("not_told"))).toBe(true);
    for (const told of ["queued", "sent", "told_in_person", "before_tracking"]) expect(canTransition("rejected", "triaged", "owner", undo(told)), told).toBe(false);
    // never without the flag, never for the system, never to a step that is not a safe place to go back to
    expect(canTransition("rejected", "triaged", "owner")).toBe(false);
    expect(canTransition("rejected", "triaged", "system", undo("not_told"))).toBe(false);
    expect(canTransition("rejected", "screening", "owner", undo("not_told"))).toBe(false);
    expect(canTransition("triaged", "screen_complete", "owner", undo("not_told"))).toBe(false);
    // where they go back to: screens and interviews the decision called off are not reopened
    expect(reopenStage(null)).toBe("triaged");
    expect(reopenStage("screen_invited")).toBe("triaged");
    expect(reopenStage("screening")).toBe("triaged");
    expect(reopenStage("screen_complete")).toBe("screen_complete");
    expect(reopenStage("interview_scheduled")).toBe("interview_recommended");
    expect(reopenStage("finalist")).toBe("finalist");
    expect(reopenStage("offer_approval")).toBe("finalist");
    expect(reopenStage("withdrawn")).toBeNull();
    expect(reopenStage("hired")).toBeNull();
    for (const s of ApplicationStageEnum.options) {
      const to = reopenStage(s);
      if (to) expect(REOPEN_TARGETS, s).toContain(to);
    }
  });
  it("lets someone withdraw from a decision they were never told, and nobody else (plan A1)", () => {
    expect(canTransition("rejected", "withdrawn", "candidate", { decisionTold: false })).toBe(true);
    expect(canTransition("talent_pool", "withdrawn", "candidate", { decisionTold: false })).toBe(true);
    expect(canTransition("rejected", "withdrawn", "candidate", { decisionTold: true })).toBe(false);
    expect(canTransition("rejected", "withdrawn", "candidate")).toBe(false);
    expect(canTransition("rejected", "withdrawn", "owner", { decisionTold: false })).toBe(false);
    expect(mayWithdraw("rejected", "not_told")).toBe(true);
    expect(mayWithdraw("rejected", "queued")).toBe(true);
    expect(mayWithdraw("rejected", "sent")).toBe(false);
    expect(mayWithdraw("talent_pool", "told_in_person")).toBe(false);
    // a decision made before decisions became private was already on their status page
    expect(mayWithdraw("rejected", "before_tracking")).toBe(false);
    expect(decisionTold("before_tracking")).toBe(true);
    expect(mayWithdraw("screening", "not_told")).toBe(true);
    expect(mayWithdraw("hired", "not_told")).toBe(false);
  });
});

describe("the stage strip (founder decision B3)", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const later = "2026-10-20T15:00:00.000Z";
  const earlier = "2026-10-01T15:00:00.000Z";
  it("maps every internal stage to one owner stage: from applying until the AI interview is sent, 'No AI interview yet' (R20-7)", () => {
    const expected: Record<ApplicationStage, OwnerStage> = {
      applied: "no_ai_interview", received: "no_ai_interview", eligible: "no_ai_interview", screen_invited: "no_ai_interview", screening: "no_ai_interview",
      ineligible: "new", triaged: "new", screen_complete: "new",
      interview_recommended: "interviewing", interview_scheduled: "interviewing", interview_complete: "interviewing", debrief: "interviewing", finalist: "interviewing", reference_check: "interviewing",
      offer_draft: "offer", offer_approval: "offer", offer_sent: "offer", negotiation: "offer", accepted: "offer", onboarding: "offer",
      hired: "hired", rejected: "not_moving_forward", withdrawn: "not_moving_forward", declined: "not_moving_forward", talent_pool: "not_moving_forward",
    };
    for (const s of ApplicationStageEnum.options) expect(ownerStage({ stage: s }), s).toBe(expected[s]);
  });
  it("lets marks overlay the step underneath: holds anywhere in the process, longlist and shortlist only on 'No AI interview yet' and New", () => {
    expect(ownerStage({ stage: "triaged" }, { mark: "shortlist" })).toBe("shortlist");
    expect(ownerStage({ stage: "screening" }, { mark: "longlist" })).toBe("longlist");
    expect(ownerStage({ stage: "screen_invited" }, { mark: "on_hold", remindAt: later })).toBe("on_hold");
    expect(markBlockedReason("screen_invited", "shortlist")).toBeNull();
    expect(markBlockedReason("eligible", "longlist")).toBeNull();
    // the sub-label under "No AI interview yet" is where they stand with it
    expect(ownerStageLabel("no_ai_interview", null, null, { label: "Link expired" })).toBe("Link expired");
    expect(ownerStageLabel("no_ai_interview")).toBe("No AI interview yet");
    expect(ownerStage({ stage: "interview_scheduled" }, { mark: "shortlist" })).toBe("interviewing");
    expect(ownerStage({ stage: "interview_scheduled" }, { mark: "on_hold", remindAt: later })).toBe("on_hold");
    expect(ownerStage({ stage: "triaged" }, { mark: "not_a_fit_for_now" })).toBe("not_moving_forward");
    expect(ownerStageLabel("not_moving_forward", { mark: "not_a_fit_for_now" })).toBe("Not a fit for now");
    // out of the process, no mark counts
    expect(ownerStage({ stage: "rejected" }, { mark: "shortlist" })).toBe("not_moving_forward");
    expect(ownerStage({ stage: "hired" }, { mark: "on_hold", remindAt: later })).toBe("hired");
    expect(OWNER_STAGE_LABEL.not_moving_forward).toBe("Not moving forward");
  });
  it("parks a running hold, brings it back when its date comes, and sets aside not a fit for now", () => {
    expect(groupFor({ stage: "triaged" }, { mark: "on_hold", remindAt: later }, now)).toBe("in_process");
    expect(holdRunning({ mark: "on_hold", remindAt: later }, now)).toBe(true);
    expect(groupFor({ stage: "screen_invited" }, { mark: "on_hold", remindAt: earlier }, now)).toBe("waiting_on_you");
    expect(holdEnded({ mark: "on_hold", remindAt: earlier }, now)).toBe(true);
    expect(ownerTags({ stage: "triaged" }, { mark: "on_hold", remindAt: earlier }, now)).toEqual(["Hold ended"]);
    expect(groupFor({ stage: "triaged" }, { mark: "not_a_fit_for_now" }, now)).toBe("not_moving_forward");
    expect(groupFor({ stage: "triaged" }, { mark: "shortlist" }, now)).toBe("waiting_on_you");
    expect(groupFor({ stage: "hired" }, { mark: "on_hold", remindAt: later }, now)).toBe("hired");
  });
  it("shows someone with an open follow-up as Cancelled only while recommended for interview or interview done", () => {
    const asked = { reason: "asked_new_times", autoState: "none", interviewOpen: false } as const;
    expect(ownerStage({ stage: "interview_recommended" }, null, asked)).toBe("cancelled");
    expect(ownerStage({ stage: "interview_complete" }, null, asked)).toBe("cancelled");
    for (const stage of ["interview_scheduled", "finalist", "debrief", "triaged", "offer_sent", "hired", "rejected", "withdrawn", "talent_pool"] as const) {
      expect(ownerStage({ stage }, null, asked), stage).toBe(ownerStage({ stage }));
    }
    // without a follow-up nothing changes, and the follow-up comes before a mark (the two never coexist)
    expect(ownerStage({ stage: "interview_recommended" })).toBe("interviewing");
    expect(ownerStage({ stage: "interview_recommended" }, { mark: "on_hold", remindAt: later }, asked)).toBe("cancelled");
    expect(ownerStage({ stage: "interview_recommended" }, { mark: "on_hold", remindAt: later }, null)).toBe("on_hold");
  });
  it("labels Cancelled with why they are there", () => {
    expect(OWNER_STAGE_LABEL.cancelled).toBe("Cancelled");
    expect(ownerStageLabel("cancelled", null, { reason: "asked_new_times", autoState: "waiting", interviewOpen: false })).toBe("Asked for new times");
    expect(ownerStageLabel("cancelled", null, { reason: "not_interested", autoState: "none", interviewOpen: false })).toBe("No longer interested");
    expect(ownerStageLabel("cancelled", null, { reason: "no_show", autoState: "none", interviewOpen: false })).toBe("No-show");
    expect(ownerStageLabel("cancelled")).toBe("Cancelled");
    expect(ownerStageLabel("interviewing", null, { reason: "no_show", autoState: "none", interviewOpen: false })).toBe("Interviewing");
  });
  it("counts someone under Cancelled as waiting on you only when nothing is in motion for them", () => {
    const at = (stage: ApplicationStage, autoState: "none" | "waiting" | "waiting_check" | "preparing" | "sent" | "not_sent", interviewOpen: boolean) => groupFor({ stage }, null, now, { reason: "asked_new_times", autoState, interviewOpen });
    expect(at("interview_recommended", "waiting", false)).toBe("in_process");
    expect(at("interview_recommended", "waiting_check", false)).toBe("in_process");
    expect(at("interview_recommended", "preparing", true)).toBe("in_process");
    expect(at("interview_recommended", "sent", true)).toBe("in_process");
    expect(at("interview_complete", "none", true)).toBe("in_process");
    expect(at("interview_recommended", "none", false)).toBe("waiting_on_you");
    expect(at("interview_recommended", "not_sent", false)).toBe("waiting_on_you");
    expect(at("interview_complete", "sent", false)).toBe("waiting_on_you");
    // out of the column the follow-up is not read: a booked interview is in process, a decline is not moving forward
    expect(at("interview_scheduled", "none", false)).toBe("in_process");
    expect(at("rejected", "waiting", false)).toBe("not_moving_forward");
    expect(groupFor({ stage: "interview_recommended" }, null, now)).toBe("waiting_on_you");
  });
  it("gives the Cancelled column's alerts headlines that name nobody", () => {
    expect(alertHeadline("interview.no_show")).toBe("A candidate did not come to an interview");
    expect(alertHeadline("interview.new_times_sent")).toBe("New interview times went to a candidate who asked for them");
    expect(alertHeadline("interview.new_times_not_sent")).toBe("New interview times a candidate asked for were not sent");
    expect(alertHeadline("interview.new_times")).toBe("New times are going to a candidate for your interview");
    // a candidate moving an interview keeps its own words
    expect(alertHeadline("interview.rescheduled")).toBe("A candidate asked to move an interview");
  });
  it("says why a mark cannot be set at this step", () => {
    expect(markBlockedReason("triaged", "shortlist")).toBeNull();
    expect(markBlockedReason("interview_scheduled", "on_hold")).toBeNull();
    expect(markBlockedReason("interview_scheduled", "shortlist")).toBe("They are interviewing already.");
    expect(markBlockedReason("ineligible", "on_hold")).toMatch(/^Check their eligibility answer first/);
    expect(markBlockedReason("rejected", "on_hold")).toBe("Not available at this step (Not moving forward).");
    expect(markBlockedReason("offer_sent", "longlist")).toBe("Not available at this step (Offer out).");
  });
  it("works out when a hold ends: 14 days by default, a chosen date, never in the past or beyond 8 weeks", () => {
    expect(holdUntil(undefined, now)).toBe("2026-10-22T12:00:00.000Z");
    expect(holdUntil("2026-10-20", now)).toBe("2026-10-20T15:00:00.000Z");
    expect(holdUntil("2026-10-09T08:30:00Z", now)).toBe("2026-10-09T08:30:00.000Z");
    expect(() => holdUntil("2026-10-01", now)).toThrow(/after today/);
    expect(() => holdUntil("2027-01-30", now)).toThrow(/8 weeks at most/);
    expect(() => holdUntil("next week", now)).toThrow(MarkError);
  });
});

describe("the candidate's steps (plan A1)", () => {
  it("shows four plain steps and hides the team's internal ones", () => {
    expect(candidateStep("applied", "not_told")).toBe("received");
    expect(candidateStep("received", "not_told")).toBe("received");
    for (const s of ["ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete", "interview_recommended", "finalist", "reference_check", "offer_draft", "offer_approval"] as const) expect(candidateStep(s, "not_told"), s).toBe("under_review");
    for (const s of ["interview_scheduled", "interview_complete", "debrief"] as const) expect(candidateStep(s, "not_told"), s).toBe("interview");
    for (const s of ["hired", "withdrawn", "declined", "offer_sent"] as const) expect(candidateStep(s, "not_told"), s).toBe("decision");
    expect(CANDIDATE_STEP_LABEL.under_review).toBe("Under review");
  });
  it("shows a private decision only once the candidate was told, and the step before it until then", () => {
    expect(candidateStep("rejected", "not_told")).toBe("under_review");
    expect(candidateStep("rejected", "queued", "interview_complete")).toBe("interview");
    expect(candidateStep("talent_pool", "not_told", "applied")).toBe("received");
    expect(candidateStep("rejected", "sent")).toBe("decision");
    expect(candidateStep("talent_pool", "told_in_person")).toBe("decision");
    expect(candidateStep("rejected", "before_tracking")).toBe("decision");
    expect(decisionTold("queued")).toBe(false);
  });
});

describe("eligibility", () => {
  const rules = [
    { key: "rdh_license", type: "license" as const, question: "Do you hold an active RDH license in California?", expectation: { license: "RDH", jurisdiction: "CA" }, rationale: "Required to practice", knockout: true },
    { key: "saturdays", type: "schedule_availability" as const, question: "Can you work Saturdays?", expectation: { days: ["Sat"] }, rationale: "Clinic is open Saturdays", knockout: true },
    { key: "start", type: "start_date" as const, question: "Can you start within 30 days?", expectation: { withinDays: 30 }, rationale: "Coverage gap", knockout: true },
  ];
  it("passes when answers meet every rule", () => {
    const r = evaluateEligibility(rules, { rdh_license: "yes", saturdays: ["Sat", "Mon"], start: true });
    expect(r.passed).toBe(true);
    expect(r.failedRules).toHaveLength(0);
  });
  it("fails on a no, and treats missing answers as unverifiable rather than failed", () => {
    const r = evaluateEligibility(rules, { rdh_license: "no" });
    expect(r.passed).toBe(false);
    expect(r.failedRules.map((f) => f.key)).toEqual(["rdh_license"]);
    expect(r.unverifiable.map((u) => u.key).sort()).toEqual(["saturdays", "start"]);
  });
});

describe("dedupe", () => {
  it("normalizes gmail dots and plus suffixes", () => {
    expect(dedupeKey("Jane.Doe+jobs@Gmail.com", null)).toBe("email:janedoe@gmail.com");
    expect(dedupeKey("Jane.Doe+jobs@example.com", null)).toBe("email:jane.doe@example.com");
  });
  it("falls back to phone", () => {
    expect(dedupeKey(null, "(949) 555-0100")).toBe("phone:+19495550100");
    expect(normalizePhone("1 949 555 0100")).toBe("+19495550100");
  });
});

describe("policy defaults", () => {
  it("keep the human-decision boundary", () => {
    for (const a of HARD_HUMAN_ONLY) expect(DEFAULT_POLICIES[a].level).toBe("human_only");
    expect(DEFAULT_POLICIES["role_packet.approve"].level).toBe("approval");
    expect(DEFAULT_POLICIES["message.send_templated"].level).toBe("auto");
    // founder decision B6: declining sends nothing; the decision message goes when a person presses Send
    expect(DEFAULT_POLICIES["disposition.send"].level).toBe("auto");
    // founder decision of 9 October 2026: the 30-day "still reviewing" note is off unless a company switches it on
    expect(DEFAULT_POLICIES["message.still_reviewing"].level).toBe("human_only");
    expect(DEFAULT_POLICIES["message.still_reviewing"].params).toEqual({ afterDays: 30 });
  });
});

describe("permissions", () => {
  it("interviewers cannot see compensation or act on applications", () => {
    expect(can("interviewer", "compensation.read")).toBe(false);
    expect(can("interviewer", "application.act")).toBe(false);
    expect(can("interviewer", "scorecard.write")).toBe(true);
  });
});

describe("compliance", () => {
  it("resolves jurisdictions and picks notices", () => {
    const j = resolveJurisdictions([{ country: "US", region: "CA" }], "NV");
    expect(j).toEqual(["US-CA", "US-NV"]);
    const keys = noticesFor(j).map((n) => n.key);
    expect(keys).toContain("ai_use");
    expect(keys).toContain("pay_transparency");
    expect(keys).not.toContain("adverse_decision_explanation");
  });
});

describe("business hours (founder decision F12)", async () => {
  const { addBusinessHours, humanResponseExpectation, isBusinessTime, nextBusinessOpen, slaBusinessHours } = await import("./business-hours");
  // 2026-09-18 is a Friday. 16:30 Pacific (PDT, UTC-7) = 23:30Z.
  const fridayLate = new Date("2026-09-18T23:30:00Z");
  it("knows when the business is open", () => {
    expect(isBusinessTime(fridayLate)).toBe(true);
    expect(isBusinessTime(new Date("2026-09-19T17:00:00Z"))).toBe(false); // Saturday 10:00 Pacific
    expect(isBusinessTime(new Date("2026-09-07T17:00:00Z"))).toBe(false); // Labor Day
    expect(isBusinessTime(new Date("2026-09-16T15:30:00Z"))).toBe(false); // Wednesday 8:30 Pacific
    expect(isBusinessTime(new Date("2026-09-16T16:00:00Z"))).toBe(true); // Wednesday 9:00 Pacific
  });
  it("carries a four-hour SLA over a weekend", () => {
    // Friday 16:30 + 4 business hours = Monday 12:30 Pacific = 19:30Z
    expect(addBusinessHours(fridayLate, 4).toISOString()).toBe("2026-09-21T19:30:00.000Z");
  });
  it("skips holidays and starts the clock at the next opening", () => {
    // Friday 2026-09-04 16:00 Pacific + 8 business hours: 1h Friday, then Labor Day is skipped, then 7h on Tuesday → 16:00 Tuesday
    expect(addBusinessHours(new Date("2026-09-04T23:00:00Z"), 8).toISOString()).toBe("2026-09-08T23:00:00.000Z");
    // A request at 2:00 on a Sunday starts counting Monday at 9:00
    expect(nextBusinessOpen(new Date("2026-09-20T09:00:00Z")).toISOString()).toBe("2026-09-21T16:00:00.000Z");
  });
  it("maps escalation kinds to the approved SLAs", () => {
    expect(slaBusinessHours("candidate_issue")).toBe(4);
    expect(slaBusinessHours("negotiation")).toBe(2);
    expect(slaBusinessHours("review")).toBe(8);
    expect(slaBusinessHours("unknown_kind")).toBe(8);
  });
  it("tells candidates an expectation that is true when written", () => {
    expect(humanResponseExpectation(fridayLate)).toMatch(/four business hours/);
    expect(humanResponseExpectation(new Date("2026-09-19T17:00:00Z"))).toMatch(/next business day/);
  });
});

describe("editable business calendar (correction 12 of 18 September 2026)", async () => {
  const { DEFAULT_BUSINESS_CALENDAR, addBusinessHours, businessMinutesBetween, describeHours, humanResponseExpectation, isBusinessDay, isBusinessTime, nextBusinessOpen } = await import("./business-hours");
  const { calendarSourceFromVersions } = await import("./business-calendar");
  const cal = (over: Partial<import("./business-hours").BusinessCalendar>) => ({ ...DEFAULT_BUSINESS_CALENDAR, ...over });
  it("skips weekends", () => {
    // Saturday 2026-09-19 10:00 Pacific + 1 business hour = Monday 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-19T17:00:00Z"), 1).toISOString()).toBe("2026-09-21T17:00:00.000Z");
  });
  it("skips observed holidays", () => {
    // Thursday 2026-07-02 16:00 Pacific + 2h: 1h Thursday, Friday 3 July is the observed holiday, 1h Monday 6 July → 10:00 Pacific
    expect(isBusinessDay(new Date("2026-07-03T17:00:00Z"))).toBe(false);
    expect(addBusinessHours(new Date("2026-07-02T23:00:00Z"), 2).toISOString()).toBe("2026-07-06T17:00:00.000Z");
  });
  it("keeps wall-clock hours across the fall-back and spring-forward daylight-saving changes", () => {
    // Friday 2026-10-30 16:00 PDT (23:00Z) + 8h: 1h Friday, then Monday 2 November (PST) 09:00 → 16:00 PST = 00:00Z Tuesday
    expect(addBusinessHours(new Date("2026-10-30T23:00:00Z"), 8).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // Friday 2027-03-12 16:00 PST (00:00Z) + 8h: 1h Friday, then Monday 15 March (PDT) → 16:00 PDT = 23:00Z
    expect(addBusinessHours(new Date("2027-03-13T00:00:00Z"), 8).toISOString()).toBe("2027-03-15T23:00:00.000Z");
  });
  it("starts an outside-hours request at the next opening", () => {
    // Wednesday 2026-09-16 20:00 Pacific + 4h → Thursday 13:00 Pacific
    expect(addBusinessHours(new Date("2026-09-17T03:00:00Z"), 4).toISOString()).toBe("2026-09-17T20:00:00.000Z");
  });
  it("spreads multi-day deadlines over open hours only", () => {
    // Monday 2026-09-14 09:00 Pacific + 24 business hours = three full days → Wednesday 17:00 Pacific
    expect(addBusinessHours(new Date("2026-09-14T16:00:00Z"), 24).toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });
  it("honours ITS closures and temporary coverage changes", () => {
    const closed = cal({ closures: [{ from: "2026-09-21", to: "2026-09-25", name: "Team offsite" }] });
    // Friday 2026-09-18 16:00 Pacific + 2h: 1h Friday, the whole next week closed, 1h Monday 28 September → 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-18T23:00:00Z"), 2, closed).toISOString()).toBe("2026-09-28T17:00:00.000Z");
    const half = cal({ coverageChanges: [{ from: "2026-09-16", to: "2026-09-16", reason: "half day", hours: [{ start: "13:00", end: "17:00" }] }] });
    expect(isBusinessTime(new Date("2026-09-16T16:30:00Z"), half)).toBe(false); // 09:30 Pacific on the half day
    expect(nextBusinessOpen(new Date("2026-09-16T16:30:00Z"), half).toISOString()).toBe("2026-09-16T20:00:00.000Z");
    const dark = cal({ coverageChanges: [{ from: "2026-09-16", to: "2026-09-17", reason: "no coverage", hours: null }] });
    expect(isBusinessDay(new Date("2026-09-16T18:00:00Z"), dark)).toBe(false);
    expect(isBusinessDay(new Date("2026-09-18T18:00:00Z"), dark)).toBe(true);
  });
  it("works in another time zone", () => {
    const eastern = cal({ timeZone: "America/New_York" });
    expect(isBusinessTime(new Date("2026-09-14T13:00:00Z"), eastern)).toBe(true); // 09:00 Eastern
    expect(isBusinessTime(new Date("2026-09-14T13:00:00Z"))).toBe(false); // 06:00 Pacific
    expect(addBusinessHours(new Date("2026-09-14T13:00:00Z"), 8, eastern).toISOString()).toBe("2026-09-14T21:00:00.000Z");
    expect(describeHours(eastern)).toBe("Monday to Friday, 9 to 5 Eastern");
  });
  it("applies a version exactly from its effective date, even inside one deadline", () => {
    const row = (version: number, effectiveFrom: string, hours: import("./business-hours").WeeklyHours) => ({ id: String(version), calendarKey: "its", version, effectiveFrom, timeZone: "America/Los_Angeles", hours, holidays: [], closures: [], coverageChanges: [], note: "", createdBy: { kind: "system" as const, id: "t" }, createdAt: "2026-09-01T00:00:00Z" });
    const mornings = { ...DEFAULT_BUSINESS_CALENDAR.hours, thu: [{ start: "09:00", end: "12:00" }], fri: [{ start: "09:00", end: "12:00" }] };
    const src = calendarSourceFromVersions([row(1, "2026-09-01", DEFAULT_BUSINESS_CALENDAR.hours), row(2, "2026-09-17", mornings)], new Date("2026-09-16T20:00:00Z"));
    expect(src.version).toBe(1);
    // Wednesday 16 September 16:00 Pacific + 5h: 1h Wednesday (v1), 3h Thursday morning (v2), 1h Friday → Friday 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-16T23:00:00Z"), 5, src).toISOString()).toBe("2026-09-18T17:00:00.000Z");
    expect(addBusinessHours(new Date("2026-09-16T23:00:00Z"), 5).toISOString()).toBe("2026-09-17T20:00:00.000Z");
    const later = calendarSourceFromVersions(src.versions, new Date("2026-09-17T20:00:00Z"));
    expect(later.version).toBe(2);
    expect(describeHours(later, new Date("2026-09-17T20:00:00Z"))).toMatch(/Thursday 9 to 12/);
  });
  it("measures remaining business time in both directions", () => {
    // Friday 2026-09-18 16:00 Pacific → Monday 10:00 Pacific = 60 + 60 minutes
    expect(businessMinutesBetween(new Date("2026-09-18T23:00:00Z"), new Date("2026-09-21T17:00:00Z"))).toBe(120);
    expect(businessMinutesBetween(new Date("2026-09-21T17:00:00Z"), new Date("2026-09-18T23:00:00Z"))).toBe(-120);
    expect(businessMinutesBetween(new Date("2026-09-19T17:00:00Z"), new Date("2026-09-20T17:00:00Z"))).toBe(0); // weekend
  });
  it("writes customer copy from the calendar in force", () => {
    expect(describeHours()).toBe("Monday to Friday, 9 to 5 Pacific");
    expect(describeHours(cal({ hours: { ...DEFAULT_BUSINESS_CALENDAR.hours, mon: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:30" }] } }))).toBe("Monday 9 to 12 and 1 to 5:30, Tuesday 9 to 5, Wednesday 9 to 5, Thursday 9 to 5, Friday 9 to 5 Pacific");
    expect(humanResponseExpectation(new Date("2026-09-19T17:00:00Z"), cal({ hours: { ...DEFAULT_BUSINESS_CALENDAR.hours, sat: [{ start: "10:00", end: "14:00" }] } }))).toMatch(/^within four business hours/);
  });
});
