import { describe, expect, it } from "vitest";
import { can, type Permission } from "../../packages/core/src/permissions";
import { defaultInterviewers } from "../../apps/web/src/interview-defaults";
import { actorWords, describeRoleEvent, roleWords } from "../../apps/web/src/role-words";
import { canDecideInterviews, canEditPacket, canManageInterviews, canManageRole, canRecordOutcome, canRequestInterviews, canSeeActivity, canSeeTalent, canStartHire } from "../../apps/web/src/roles";

/**
 * The signed-in pages decide what to show from apps/web/src/roles.ts, a copy of the permission matrix (the pages do not
 * depend on @ros/core). A copy drifts; this pins it to the matrix, so a button is never offered to a role the API
 * refuses (the role page's posting controls, Edit, Close, the Talent link and the Report tab), and never hidden from a
 * role the API allows. The role page's words and the interview defaults are pure functions, tested here too.
 */
const ROLES = ["owner", "admin", "hiring_manager", "hr", "interviewer", "recruiter"] as const;
const MIRRORS: Array<[string, (role: string) => boolean, Permission]> = [
  ["canManageRole", canManageRole, "role.manage"],
  ["canEditPacket", canEditPacket, "packet.edit"],
  ["canRecordOutcome", canRecordOutcome, "outcome.record"],
  ["canSeeTalent", canSeeTalent, "application.read"],
  ["canSeeActivity", canSeeActivity, "events.read"],
  ["canStartHire", canStartHire, "role.create"],
  ["canRequestInterviews", canRequestInterviews, "interview.request"],
  ["canManageInterviews", canManageInterviews, "interview.manage"],
  ["canDecideInterviews", canDecideInterviews, "interview.decide"],
];

describe("the web pages' copy of the permission matrix", () => {
  for (const [name, fn, permission] of MIRRORS) {
    it(`${name} matches ${permission} for every team role`, () => {
      for (const role of ROLES) expect(fn(role), `${name}(${role})`).toBe(can(role, permission));
    });
  }
  it("nothing is offered while the role is unknown", () => {
    for (const [, fn] of MIRRORS) {
      expect(fn(null as unknown as string)).toBe(false);
      expect(fn(undefined as unknown as string)).toBe(false);
    }
  });
  it("hiring managers and HR see postings read-only; HR may close a role, a recruiter may not", () => {
    expect(canManageRole("hiring_manager")).toBe(false);
    expect(canManageRole("hr")).toBe(false);
    expect(canRecordOutcome("hr")).toBe(true);
    expect(canRecordOutcome("recruiter")).toBe(false);
    expect(canEditPacket("hr")).toBe(false);
    expect(canSeeTalent("interviewer")).toBe(false);
  });
});

describe("the role page's Activity words", () => {
  const ev = (type: string, payload: Record<string, unknown> = {}, actor: { kind: string; id: string; name?: string } = { kind: "system", id: "workflow:publish_role" }) => ({ id: 1, type, occurredAt: "2026-09-30T10:00:00.000Z", actor, subjectType: "posting", subjectId: "p1", payload });

  it("names the board and says what each posting state means, never a raw state name", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["posting.ready_to_post", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: ready for you to post"],
      ["posting.ready_to_post", { channel: "careers_page", roleId: "r" }, "Careers page: prepared"],
      ["posting.posted_manually", { channel: "indeed", roleId: "r" }, "Indeed: address recorded, being checked"],
      ["posting.posted_manually", { channel: "indeed", roleId: "r", corrected: true }, "Indeed: a different address recorded, being checked"],
      ["posting.submitted_integration", { channel: "google_jobs", roleId: "r" }, "Google for Jobs: submitted, waiting to be listed"],
      ["posting.live_verified", { channel: "ziprecruiter", roleId: "r" }, "ZipRecruiter: checked and live"],
      ["posting.verification_failed", { channel: "linkedin_basic", roleId: "r", final: false }, "LinkedIn: the check did not pass; it is checked again shortly"],
      ["posting.verification_failed", { channel: "linkedin_basic", roleId: "r", final: true }, "LinkedIn: the last check did not pass"],
      ["posting.failed", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: could not be verified"],
      ["posting.paused", { channel: "indeed", roleId: "r" }, "Indeed: paused"],
      ["posting.closed", { channel: "email_in", roleId: "r" }, "Applications by email: closed"],
      ["posting.closure_required", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: still to be taken down"],
      ["posting.closure_confirmed", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: confirmed taken down"],
      ["posting.published", { channel: "indeed", roleId: "r" }, "Indeed: posting updated"],
    ];
    for (const [type, payload, words] of cases) {
      const said = describeRoleEvent(ev(type, payload));
      expect(said, type).toBe(words);
      expect(said, type).not.toMatch(/_|posting\./);
    }
  });

  it("shows an AI step as the assistant, never its internal id; people by name", () => {
    expect(actorWords({ kind: "agent", id: "triage-agent-7" })).toBe("the assistant");
    expect(actorWords({ kind: "agent", id: "triage-agent-7" })).not.toContain("triage");
    expect(actorWords({ kind: "system", id: "workflow:publish_role" })).toBe("the system");
    expect(actorWords({ kind: "user", id: "u1", name: "Olivia Owner" })).toBe("Olivia Owner");
    expect(actorWords({ kind: "user", id: "u1" })).toBe("a team member");
  });

  it("names the planned interviewers by role in words", () => {
    expect(roleWords(["hiring_manager", "owner"])).toBe("a hiring manager, an owner");
    expect(roleWords(["hr", "interviewer"])).toBe("someone from HR, an interviewer");
    expect(roleWords(["office_lead"])).toBe("office lead");
  });
});

describe("who is ticked when an interview is approved", () => {
  const active = new Set(["hank", "priya", "owen"]);
  const applicationPlan = [{ key: "r1", interviewerUserIds: ["hank", "removed-rita"] }, { key: "r2", interviewerUserIds: ["owen"] }];

  it("never ticks someone who is no longer on the team, so the request cannot be refused for them", () => {
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan, activeMemberIds: active })).toEqual(["hank"]);
    // unticking someone else keeps the removed member out too
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan, picked: ["removed-rita", "priya"], activeMemberIds: active })).toEqual(["priya"]);
  });

  it("takes the round's people from the role's current plan, so assignments made after someone applied reach them", () => {
    const currentPlan = [{ key: "r1", interviewerUserIds: ["priya", "owen"] }];
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan, currentPlan, activeMemberIds: active })).toEqual(["priya", "owen"]);
    // a round the current plan no longer has falls back to the application's own plan
    expect(defaultInterviewers({ roundKey: "r2", applicationPlan, currentPlan, activeMemberIds: active })).toEqual(["owen"]);
    // what the person ticked by hand wins
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan, currentPlan, picked: ["hank"], activeMemberIds: active })).toEqual(["hank"]);
  });

  it("ticks nobody until the team list is known", () => {
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan, activeMemberIds: null })).toEqual([]);
  });
});
