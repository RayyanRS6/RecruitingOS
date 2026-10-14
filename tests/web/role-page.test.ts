import { describe, expect, it } from "vitest";
import { can, type Permission } from "../../packages/core/src/permissions";
import { againChoice, defaultInterviewers } from "../../apps/web/src/interview-defaults";
import { jobActions, jobTabFrom, jobTabHref, jobTabs, roleStatus } from "../../apps/web/src/role-status";
import { actorWords, describeRoleEvent, payShownLabel, roleWords } from "../../apps/web/src/role-words";
import { canApproveRole, canChangeCompany, canDecideInterviews, canDecline, canEditPacket, canManageInterviews, canManageRole, canRecordOutcome, canRequestInterviews, canSeeActivity, canSeePay, canSeeTalent, canShareJob, canStartHire } from "../../apps/web/src/roles";

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
  ["canDecline", canDecline, "application.reject"],
  ["canApproveRole", canApproveRole, "role.approve"],
  ["canSeePay", canSeePay, "compensation.read"],
  ["canChangeCompany", canChangeCompany, "company.update"],
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
  it("sharing a job is open to those who manage postings and to those who approve roles (plan D8)", () => {
    for (const role of ROLES) expect(canShareJob(role), role).toBe(can(role, "role.manage") || can(role, "role.approve"));
    expect(canShareJob("hiring_manager")).toBe(true);
    expect(canShareJob("interviewer")).toBe(false);
    expect(canShareJob(null)).toBe(false);
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

describe("the Pay card's 'Shown to candidates'", () => {
  it("follows the public pages' rule: the owner's choice, or a pay transparency law where the job is", () => {
    expect(payShownLabel({ payShown: true, payRequiredByLaw: false }, true)).toBe("Yes");
    expect(payShownLabel({ payShown: true, payRequiredByLaw: true }, true)).toBe("Yes");
    // the owner chose not to show it, but the law where the job is shows it anyway, and the page says why
    expect(payShownLabel({ payShown: true, payRequiredByLaw: true }, false)).toBe("Yes: the law where this job is requires it");
    expect(payShownLabel({ payShown: false, payRequiredByLaw: false }, false)).toBe("No");
    // an older answer without the fields reads the owner's choice
    expect(payShownLabel({}, true)).toBe("Yes");
    expect(payShownLabel({}, false)).toBe("No");
  });
});

describe("the role page's Activity words", () => {
  const ev = (type: string, payload: Record<string, unknown> = {}, actor: { kind: string; id: string; name?: string } = { kind: "system", id: "workflow:publish_role" }) => ({ id: 1, type, occurredAt: "2026-09-30T10:00:00.000Z", actor, subjectType: "posting", subjectId: "p1", payload });

  it("names the board and says what each posting state means, never a raw state name", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["posting.ready_to_post", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: ready to post"],
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
      // an approved edit left a board behind, and it was brought up to date (plan D4)
      ["posting.update_required", { channel: "indeed", roleId: "r" }, "Indeed: still shows the earlier version, to be updated"],
      ["posting.updated", { channel: "linkedin_basic", roleId: "r" }, "LinkedIn: brought up to date with the new version"],
    ];
    for (const [type, payload, words] of cases) {
      const said = describeRoleEvent(ev(type, payload));
      expect(said, type).toBe(words);
      expect(said, type).not.toMatch(/_|posting\./);
    }
  });

  it("says how long an approval had before it ran out, and why a screen was closed", () => {
    expect(describeRoleEvent(ev("approval.expired", { actionType: "application.invite_screen", windowDays: 7 }))).toBe("The approval ran out of time (7 days)");
    expect(describeRoleEvent(ev("approval.expired", { actionType: "role_packet.approve" }))).toBe("The approval ran out of time (14 days)");
    expect(describeRoleEvent(ev("screen.cancelled", { reason: "stopped_by_team" }))).toBe("A screening chat invitation was stopped by the team");
    expect(describeRoleEvent(ev("screen.cancelled", { reason: "left_process" }))).toBe("A screening chat was closed: the candidate is no longer in the process");
    expect(describeRoleEvent(ev("screen.cancelled", { reason: "deletion_request" }))).toBe("A screening chat was closed: the candidate's information was deleted");
    expect(describeRoleEvent(ev("screen.invited", {}))).toBe("A candidate was invited to a screening chat");
    expect(describeRoleEvent(ev("screen.completed", {}))).toBe("A candidate finished the screening chat");
  });

  it("says which boards were chosen and when applications close (plan D6, D7)", () => {
    expect(describeRoleEvent(ev("role.boards_chosen", { channels: ["linkedin_basic", "indeed"] }))).toBe("Job boards chosen: LinkedIn, Indeed");
    expect(describeRoleEvent(ev("role.boards_chosen", { channels: [] }))).toBe("No job boards chosen");
    expect(describeRoleEvent(ev("role.closing_date_set", { closesOn: "2026-10-30" }))).toBe("Closing date set: last day to apply October 30, 2026");
    expect(describeRoleEvent(ev("role.closing_date_set", { closesOn: null }))).toBe("Closing date taken off");
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

describe("what an interview that never took place offers next", () => {
  const at = (status: string, stage = "interview_recommended", over: Record<string, string> = {}) => ({ id: "iv1", applicationId: "a1", status, createdAt: "2026-10-01T10:00:00.000Z", candidate: { stage }, ...over });

  it("offers times again when the candidate let them expire, and a new interview after a cancellation", () => {
    expect(againChoice(at("offer_expired"), [at("offer_expired")], "owner")).toBe("offer_again");
    expect(againChoice(at("cancelled"), [at("cancelled")], "hiring_manager")).toBe("approve_new");
    expect(againChoice(at("cancelled", "interview_complete"), [], "recruiter")).toBe("approve_new");
  });

  it("offers nothing once they have moved on, another interview exists, or the role may not do it", () => {
    expect(againChoice(at("cancelled", "rejected"), [], "owner")).toBeNull();
    expect(againChoice(at("offer_expired", "talent_pool"), [], "owner")).toBeNull();
    // a newer interview for the same candidate, in motion or not, is where things stand now
    expect(againChoice(at("cancelled"), [at("cancelled"), { id: "iv2", applicationId: "a1", status: "scheduling", createdAt: "2026-10-02T10:00:00.000Z" }], "owner")).toBeNull();
    expect(againChoice(at("cancelled"), [{ id: "iv2", applicationId: "a1", status: "completed", createdAt: "2026-10-03T10:00:00.000Z" }], "owner")).toBeNull();
    // someone else's interviews do not count
    expect(againChoice(at("cancelled"), [{ id: "iv9", applicationId: "a9", status: "scheduling", createdAt: "2026-10-03T10:00:00.000Z" }], "owner")).toBe("approve_new");
    expect(againChoice(at("cancelled"), [], "hr")).toBeNull();
    expect(againChoice(at("offer_expired"), [], "interviewer")).toBeNull();
    // finished or in motion: the sheet's other cards cover it
    expect(againChoice(at("completed"), [], "owner")).toBeNull();
    expect(againChoice(at("scheduling"), [], "owner")).toBeNull();
  });

  it("offers 'Send new times' for someone under Cancelled with nothing in motion, before offering times again or a new interview", () => {
    const under = (status: string, times: string, stage = "interview_recommended") => ({ ...at(status, stage), followUp: { id: "f1", reason: "asked_new_times" as const, times } });
    expect(againChoice(under("cancelled", "none"), [], "owner")).toBe("send_new_times");
    expect(againChoice(under("offer_expired", "expired"), [], "recruiter")).toBe("send_new_times");
    // a candidate who did not come: a new interview for the same round, from the same card
    expect(againChoice(under("no_show", "none", "interview_complete"), [], "hiring_manager")).toBe("send_new_times");
    // new times already being prepared, held, out or not delivered: nothing more to send from here
    for (const times of ["preparing", "held", "out", "not_reached"]) expect(againChoice(under("offer_expired", times), [], "owner")).toBe("offer_again");
    expect(againChoice(under("cancelled", "out"), [], "owner")).toBe("approve_new");
    // a role that may not manage interviews keeps what it had; an older interview of theirs offers nothing
    expect(againChoice(under("cancelled", "none"), [], "interviewer")).toBeNull();
    expect(againChoice(under("cancelled", "none"), [{ id: "iv2", applicationId: "a1", status: "cancelled", createdAt: "2026-10-03T10:00:00.000Z" }], "owner")).toBeNull();
    expect(againChoice(under("cancelled", "none", "rejected"), [], "owner")).toBeNull();
  });
});

describe("the role's activity: new times for several people under Cancelled", () => {
  it("says how many the team sent new times for and how many went ahead, never as if the candidates asked", () => {
    const ev = (payload: Record<string, unknown>) => describeRoleEvent({ id: 1, type: "interview.new_times_batch", occurredAt: "2026-10-10T10:00:00.000Z", actor: { kind: "user", id: "u1", name: "Dana" }, subjectType: "role", subjectId: "r1", payload });
    expect(ev({ roleId: "r1", requested: 4, sent: 3, notSent: 1 })).toBe("New times for 4 people under Cancelled: 3 going ahead, 1 not sent");
    expect(ev({ roleId: "r1", requested: 1, sent: 1, notSent: 0 })).toBe("New times for 1 person under Cancelled: 1 going ahead");
    expect(ev({ roleId: "r1", requested: 2, sent: 0, notSent: 2 })).not.toMatch(/asked/);
  });
});

describe("the job's words in its activity (Wave S1 glossary)", () => {
  const ev = (type: string, payload: Record<string, unknown> = {}) => describeRoleEvent({ id: 1, type, occurredAt: "2026-10-10T10:00:00.000Z", actor: { kind: "user", id: "u1", name: "Dana" }, subjectType: "role", subjectId: "r1", payload });

  it("says 'version 3' and 'the job', never 'packet v3' or 'the intake conversation'", () => {
    expect(ev("role.created")).toBe("Job drafted in the job builder");
    expect(ev("role_packet.approved", { version: 3 })).toBe("Version 3 approved");
    expect(ev("role_packet.approved", { version: 3, via: "edit_while_open" })).toBe("Version 3 approved and made current");
    expect(ev("role_packet.proposed", { version: 2, again: true })).toBe("Version 2 sent for approval again");
    expect(ev("role_packet.edited", { version: 4, changeSummary: "Pay raised" })).toBe("Version 4 edited: Pay raised");
    expect(ev("role_packet.edited", {})).toBe("The job edited");
    expect(ev("packet.revision_applied", { version: 5 })).toBe("A change asked for in the chat was saved as version 5");
    expect(ev("packet.revision_applied", {})).toBe("A change asked for in the chat was saved");
    expect(ev("packet.check_applied", { version: 6 })).toBe("Fixes from the requirements check were saved as version 6");
    expect(ev("role.sent_back", { wasOpen: true, version: 2 })).toBe("Proposed version 2 retired");
    for (const [type, words] of [["role.approved", "Job approved"], ["role.opened", "Job opened"], ["role.paused", "Job paused"], ["role.resumed", "Job resumed"], ["role.closed", "Job closed"], ["role.filled", "Job filled"]] as const) expect(ev(type)).toBe(words);
    for (const type of ["role.created", "role_packet.approved", "packet.revision_proposed", "packet.revision_applied"]) expect(ev(type, { version: 1 })).not.toMatch(/packet|intake/i);
  });
});

describe("the job's one header, tab strip and More menu (Wave S1)", () => {
  it("reads an open job as Live, the word both of its pages use", () => {
    expect(roleStatus("open")).toEqual({ label: "Live", tone: "good" });
  });

  it("lists Candidates first, then Job, Scoring, Interview plan, Share, Report and Activity", () => {
    expect(jobTabs({ seesCandidates: true, candidates: 12 }).map((t) => t.label)).toEqual(["Candidates", "Job", "Scoring", "Interview plan", "Share", "Report", "Activity"]);
    expect(jobTabs({ seesCandidates: true, candidates: 12 })[0]).toEqual({ id: "candidates", label: "Candidates", count: 12 });
    // the count waits until it is known
    expect(jobTabs({ seesCandidates: true, candidates: null })[0]).toEqual({ id: "candidates", label: "Candidates" });
    // an interviewer sees no candidates and no report; the versions under Activity are for everyone
    expect(jobTabs({ seesCandidates: false }).map((t) => t.id)).toEqual(["job", "scoring", "plan", "share", "activity"]);
  });

  it("links each tab: Candidates is its own page, the rest are ?tab= on the job page", () => {
    expect(jobTabHref("r1", "candidates")).toBe("/roles/r1/talent");
    expect(jobTabHref("r1", "job")).toBe("/roles/r1");
    expect(jobTabHref("r1", "scoring")).toBe("/roles/r1?tab=scoring");
    expect(jobTabHref("r1", "share")).toBe("/roles/r1?tab=share");
  });

  it("opens the tab that now holds what an older link asked for, so every notification and email still lands", () => {
    expect(jobTabFrom(null)).toBe("job");
    expect(jobTabFrom("")).toBe("job");
    expect(jobTabFrom("overview")).toBe("job");
    expect(jobTabFrom("requirements")).toBe("scoring");
    expect(jobTabFrom("evaluation")).toBe("scoring");
    expect(jobTabFrom("posting")).toBe("share");
    expect(jobTabFrom("history")).toBe("activity");
    expect(jobTabFrom("plan")).toBe("plan");
    expect(jobTabFrom("report")).toBe("report");
    expect(jobTabFrom("something-else")).toBe("job");
  });

  const all = { manage: true, edit: true, preview: true, close: true, tell: true, hireAgain: true };
  const none = { manage: false, edit: false, preview: false, close: false, tell: false, hireAgain: false };
  const ids = (input: Parameters<typeof jobActions>[0]) => jobActions(input).map((a) => a.id);

  it("puts what the header once showed as buttons in one More menu, everyday ones first and closing last", () => {
    expect(jobActions({ status: "open", accepting: true, can: all, comparing: false }).map((a) => a.label)).toEqual(["Edit", "Candidate view", "Compare", "Pause", "Stop accepting applications", "Close the job"]);
    expect(jobActions({ status: "open", accepting: true, can: all }).at(-1)).toEqual({ id: "close", label: "Close the job", danger: true });
    expect(ids({ status: "paused", accepting: true, can: all })).toEqual(["edit", "preview", "resume", "stop-accepting", "close"]);
    // the accepting switch: take them again, or (after the closing date) a later date; left out until the job is read
    expect(ids({ status: "open", accepting: false, can: all })).toContain("accept-again");
    expect(ids({ status: "open", accepting: false, closedByDate: true, can: all })).toContain("extend-date");
    expect(ids({ status: "open", accepting: null, can: all })).not.toContain("stop-accepting");
    // Compare only where it is offered, and its label says when it is on
    expect(jobActions({ status: "open", can: none, comparing: true })).toEqual([{ id: "compare", label: "Done comparing" }]);
    expect(ids({ status: "open", can: none, comparing: null })).toEqual([]);
  });

  it("offers a closed job's own steps: hire again, and the closing message unless it is already open", () => {
    expect(ids({ status: "closed", can: all })).toEqual(["edit", "preview", "hire-again", "closing-message"]);
    expect(ids({ status: "closed", can: all, closingMessageOpen: true })).not.toContain("closing-message");
    expect(ids({ status: "filled", can: all })).toContain("hire-again");
    expect(ids({ status: "draft", can: all })).toEqual(["edit", "preview"]);
  });

  it("offers nothing the person's team role cannot do (apps/web/src/roles.ts)", () => {
    expect(ids({ status: "open", accepting: true, can: none })).toEqual([]);
    expect(ids({ status: "open", accepting: true, can: { ...none, close: true } })).toEqual(["close"]);
    expect(ids({ status: "closed", can: { ...none, tell: true } })).toEqual(["closing-message"]);
  });
});