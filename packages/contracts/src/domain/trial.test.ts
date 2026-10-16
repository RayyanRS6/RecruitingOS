import { describe, expect, it } from "vitest";
import { TRIAL_DAYS, TRIAL_ENDED_LINE, TrialExtensionRequest, newTrialTerm, onTrialPlan, seatsFullLine, trialPaused, trialStanding, trialTermOf, type TrialTerm } from "./trial";

/** The Trial plan's 30 days (founder decision L-02 B, 16 October 2026): where a trial stands is worked out in code from its dates. */
const DAY = 86_400_000;
const start = new Date("2026-10-01T15:00:00.000Z");
const at = (days: number) => new Date(start.getTime() + days * DAY);
const onTrial = (term: TrialTerm | undefined) => ({ planKey: "trial", settings: term ? { trial: term } : {} });

describe("where a trial stands", () => {
  it("is nothing at all for a company on another plan, whatever dates it kept", () => {
    expect(trialStanding({ planKey: "growth", settings: { trial: newTrialTerm(start, "its_check") } }, at(40))).toBeNull();
    expect(trialStanding({ planKey: "design_partner", settings: {} }, at(1))).toBeNull();
    expect(trialPaused({ planKey: "growth", settings: { trial: newTrialTerm(start, "its_check") } }, at(40))).toBe(false);
    expect(onTrialPlan("trial")).toBe(true);
    expect(onTrialPlan("core")).toBe(false);
    expect(onTrialPlan(null)).toBe(false);
  });

  it("has not started, and so never ends, while a company on Trial waits for the ITS check", () => {
    const s = trialStanding(onTrial(undefined), at(400));
    expect(s).toEqual({ started: false, startedAt: null, endsAt: null, daysLeft: null, endingSoon: false, ended: false, extendedDays: 0 });
    expect(trialPaused(onTrial(undefined), at(400))).toBe(false);
  });

  it("runs exactly 30 days from its start", () => {
    const term = newTrialTerm(start, "its_check");
    expect(TRIAL_DAYS).toBe(30);
    expect(term).toEqual({ startedAt: "2026-10-01T15:00:00.000Z", endsAt: "2026-10-31T15:00:00.000Z", startedBy: "its_check" });
    expect(trialStanding(onTrial(term), at(0))).toMatchObject({ started: true, startedAt: term.startedAt, endsAt: term.endsAt, daysLeft: 30, endingSoon: false, ended: false });
  });

  it("is ending soon from 7 days before the end, not at 8", () => {
    const term = newTrialTerm(start, "its_check");
    expect(trialStanding(onTrial(term), at(22))?.endingSoon).toBe(false);
    expect(trialStanding(onTrial(term), at(23))).toMatchObject({ endingSoon: true, ended: false, daysLeft: 7 });
    expect(trialStanding(onTrial(term), at(29.9))?.endingSoon).toBe(true);
  });

  it("has ended exactly at its end, and is no longer ending soon then", () => {
    const term = newTrialTerm(start, "its_check");
    expect(trialStanding(onTrial(term), new Date(Date.parse(term.endsAt) - 1))?.ended).toBe(false);
    expect(trialStanding(onTrial(term), new Date(term.endsAt))).toMatchObject({ ended: true, endingSoon: false, daysLeft: 0 });
    expect(trialPaused(onTrial(term), new Date(term.endsAt))).toBe(true);
  });

  it("adds up its extensions", () => {
    const by = { kind: "user" as const, id: "u1", name: "Sam at ITS" };
    const term: TrialTerm = { ...newTrialTerm(start, "switched_on"), endsAt: at(51).toISOString(), extensions: [{ days: 14, reason: "Kick-off moved", by, at: at(10).toISOString(), from: at(30).toISOString(), to: at(44).toISOString() }, { days: 7, reason: "Owner away", by, at: at(40).toISOString(), from: at(44).toISOString(), to: at(51).toISOString() }] };
    expect(trialStanding(onTrial(term), at(31))).toMatchObject({ extendedDays: 21, ended: false });
    expect(trialStanding(onTrial(term), at(51))?.ended).toBe(true);
  });

  it("reads dates it cannot use as none", () => {
    expect(trialTermOf({ trial: { startedAt: "x" } })).toBeNull();
    expect(trialTermOf({ trial: { startedAt: "2026-10-01", endsAt: "not a date" } })).toBeNull();
    expect(trialTermOf(null)).toBeNull();
  });
});

describe("the words and the extension request", () => {
  it("says the owner's one line and the seat refusal in plain words", () => {
    expect(TRIAL_ENDED_LINE).toBe("Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.");
    expect(seatsFullLine(3)).toBe("Your trial includes 3 people. Choose a plan to add more.");
  });

  it("takes 1 to 90 whole days, a reason of five characters and a confirmation, and nothing else", () => {
    expect(TrialExtensionRequest.parse({ days: 14, reason: "  Kick-off call moved  ", confirm: true })).toEqual({ days: 14, reason: "Kick-off call moved", confirm: true });
    expect(TrialExtensionRequest.safeParse({ days: 0, reason: "Kick-off call moved", confirm: true }).success).toBe(false);
    expect(TrialExtensionRequest.safeParse({ days: 91, reason: "Kick-off call moved", confirm: true }).success).toBe(false);
    expect(TrialExtensionRequest.safeParse({ days: 1.5, reason: "Kick-off call moved", confirm: true }).success).toBe(false);
    expect(TrialExtensionRequest.safeParse({ days: 14, reason: "ok", confirm: true }).error?.issues[0]?.message).toBe("Say why the trial is extended (at least five characters).");
    expect(TrialExtensionRequest.safeParse({ days: 14, reason: "Kick-off call moved" }).success).toBe(false);
    expect(TrialExtensionRequest.safeParse({ days: 14, reason: "Kick-off call moved", confirm: true, endsAt: "2027-01-01" }).success).toBe(false);
  });
});
