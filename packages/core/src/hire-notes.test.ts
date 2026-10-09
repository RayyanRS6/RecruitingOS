import { describe, expect, it } from "vitest";
import type { MembershipRole } from "@ros/contracts";
import { baseOwnerStage, canTransition, candidateStep, groupFor, ownerGroup, ownerStage } from "./stages";
import { can } from "./permissions";

const ROLES: MembershipRole[] = ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"];

describe("Offer made, record-only (founder decision Q29; plan H2)", () => {
  it("moves a finalist to Offer by the roles that record outcomes, never by the system or anyone else", () => {
    for (const by of ["owner", "admin", "hiring_manager", "hr"] as const) {
      expect(canTransition("finalist", "offer_sent", by), by).toBe(true);
      expect(canTransition("reference_check", "offer_sent", by), by).toBe(true);
      expect(can(by, "outcome.record"), by).toBe(true);
    }
    for (const by of ["recruiter", "interviewer", "system", "agent", "candidate"] as const) expect(canTransition("finalist", "offer_sent", by), by).toBe(false);
    // only from a finalist: an interview still to decide, or anyone earlier, records no offer
    expect(canTransition("interview_complete", "offer_sent", "owner")).toBe(false);
    expect(canTransition("triaged", "offer_sent", "owner")).toBe(false);
  });
  it("then waits on the candidate's answer, recorded as an outcome: accepted is a hire, declined is declined", () => {
    expect(ownerGroup("offer_sent")).toBe("waiting_on_candidate");
    expect(groupFor({ stage: "offer_sent" })).toBe("waiting_on_candidate");
    expect(baseOwnerStage("offer_sent")).toBe("offer");
    expect(ownerStage({ stage: "offer_sent" })).toBe("offer");
    expect(canTransition("offer_sent", "hired", "hiring_manager")).toBe(true);
    expect(canTransition("offer_sent", "declined", "hr")).toBe(true);
    expect(canTransition("offer_sent", "hired", "system")).toBe(false);
    // a finalist and a counter-offer still wait on the team
    expect(ownerGroup("finalist")).toBe("waiting_on_you");
    expect(ownerGroup("negotiation")).toBe("waiting_on_you");
  });
  it("a hold over an offer still pauses it like any other step", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(groupFor({ stage: "offer_sent" }, { mark: "on_hold", remindAt: "2026-10-20T15:00:00.000Z" }, now)).toBe("in_process");
    expect(groupFor({ stage: "offer_sent" }, { mark: "on_hold", remindAt: "2026-10-01T15:00:00.000Z" }, now)).toBe("waiting_on_you");
  });
  it("the candidate's own page reads an offer they hold as a decision step; nothing about the app sending it", () => {
    expect(candidateStep("offer_sent", "not_told")).toBe("decision");
  });
});

describe("team note permissions (founder decision Q24; plan H3)", () => {
  it("owners, admins, hiring managers, HR and an ITS recruiter read and write notes; an interviewer holds neither", () => {
    const readers = ROLES.filter((r) => can(r, "note.read"));
    const writers = ROLES.filter((r) => can(r, "note.write"));
    expect(readers).toEqual(["owner", "admin", "hiring_manager", "hr", "recruiter"]);
    expect(writers).toEqual(readers);
    expect(can("interviewer", "note.read")).toBe(false);
    expect(can("interviewer", "note.write")).toBe(false);
    expect(can(null, "note.read")).toBe(false);
  });
});
