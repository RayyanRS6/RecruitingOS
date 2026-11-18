import { describe, expect, it } from "vitest";
import { ApplicationStage as ApplicationStageEnum, CANDIDATE_STEP_LABEL, type ApplicationStage, type OwnerStage } from "@ros/contracts";
import { REOPEN_TARGETS, canTransition, candidateStep, decisionTold, mayWithdraw, ownerGroup, ownerStage, ownerTags, reopenStage } from "./stages";
import { evaluateEligibility } from "./eligibility";
import { dedupeKey, normalizePhone } from "./dedupe";
import { can } from "./permissions";
import { noticesFor, resolveJurisdictions } from "./compliance";

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
});

describe("the candidate's steps (plan A1)", () => {
  it("shows four plain steps and hides the team's internal ones", () => {
    expect(candidateStep("applied", "not_told")).toBe("received");
    expect(candidateStep("received", "not_told")).toBe("received");
    for (const s of ["ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete", "interview_recommended"] as const) expect(candidateStep(s, "not_told"), s).toBe("under_review");
    // after a real interview the step stays Interview (6 November 2026): a finalist read Review again, as if it never happened
    for (const s of ["interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check", "offer_draft", "offer_approval"] as const) expect(candidateStep(s, "not_told"), s).toBe("interview");
    // a private decline after the finalist step keeps the page at Interview too, so nothing hints at it
    expect(candidateStep("rejected", "not_told", "finalist")).toBe("interview");
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

describe("permissions", () => {
  it("a member builds, edits and publishes jobs and acts on candidates; only an owner or an admin manages jobs, the company and its people", () => {
    for (const p of ["role.create", "packet.edit", "role.publish", "application.read", "application.act", "application.reject", "compensation.read", "plan.request"] as const) {
      for (const role of ["owner", "admin", "hiring_manager"] as const) expect(can(role, p), `${role} ${p}`).toBe(true);
    }
    for (const p of ["role.manage", "company.update", "members.manage"] as const) {
      expect(can("owner", p), p).toBe(true);
      expect(can("admin", p), p).toBe(true);
      expect(can("hiring_manager", p), p).toBe(false);
    }
    expect(can(null, "role.read")).toBe(false);
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
