import { describe, expect, it } from "vitest";
import { ApplyRequest, MeResponse } from "./index";
import { DataRequestKind, accessDecisionsFor, adminCompanyStatus } from "./admin";
import { ApplicationAction, BulkApplicationAction, CandidateListQuery } from "./candidates";
import { CloseRole, DraftFieldEdit, IntakeAnswersRequest, PacketFieldEdit, ROLE_ACTION_BLOCKED, StartIntake, draftStillNeeds, draftTitleOf, roleActions } from "./jobs";
import { ALWAYS_EMAILED, NotificationKind, UpdateNotificationPreferences, emailsUpdate } from "./notifications";
import { InviteMember, UpdateCompany, UpdateMember } from "./settings";
import { appPaths } from "../domain/app-paths";
import { MEMBERSHIP_ROLE_LABEL, MembershipRole, PlatformRole, isOwnerOrAdmin } from "../domain/company";
import { JobPosts, PostChannel, RolePosts, SHARE_LINE, applyLinkFor, applySourceLabel } from "../domain/publishing";

describe("who people are", () => {
  it("a team has owners, admins and members, and nobody else", () => {
    expect(MembershipRole.options.map((r) => [r, MEMBERSHIP_ROLE_LABEL[r]])).toEqual([["owner", "Owner"], ["admin", "Admin"], ["hiring_manager", "Member"]]);
    for (const gone of ["hr", "interviewer", "recruiter"]) expect(MembershipRole.safeParse(gone).success, gone).toBe(false);
    expect(PlatformRole.options).toEqual(["none", "platform_admin"]);
    expect(PlatformRole.safeParse("its_recruiter").success).toBe(false);
  });

  it("an owner or an admin is told apart from a member in one place, and nobody else counts as either", () => {
    expect(MembershipRole.options.filter(isOwnerOrAdmin)).toEqual(["owner", "admin"]);
    for (const other of ["hiring_manager", "platform_admin", "Owner", "", null, undefined]) expect(isOwnerOrAdmin(other), String(other)).toBe(false);
    // the same test words a job's actions: what a member may not press is what an owner or an admin may
    const blocked = (role: MembershipRole) => roleActions({ status: "open", role, trialEnded: false }).filter((a) => a.reason === ROLE_ACTION_BLOCKED.ownerOrAdmin).map((a) => a.action);
    for (const role of MembershipRole.options) expect(blocked(role), role).toEqual(isOwnerOrAdmin(role) ? [] : ["pause", "set_closing_date", "close"]);
  });

  it("the signed-in person carries those roles", () => {
    const me = { user: { id: "u1", email: "sam@example.com", name: "Sam", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "c1", companyName: "Smile Dental", companySlug: "smile-dental", role: "hiring_manager" }], activeCompanyId: "c1", ai: { provider: "fake" } };
    expect(MeResponse.parse(me)).toEqual(me);
    expect(MeResponse.safeParse({ ...me, memberships: [{ ...me.memberships[0], role: "hr" }] }).success).toBe(false);
  });
});

describe("applying", () => {
  const form = { firstName: "Ana", lastName: "Diaz", email: "ana@example.com", answers: { license: "yes", years: "6" }, noticeVersionsShown: ["ai_use@2026-09-01"], acknowledged: true };

  it("takes who they are, their screening answers and the acknowledgment, and nothing about texting or a reading of the CV", () => {
    expect(ApplyRequest.parse({ ...form, smsConsent: true, workSummary: "x", fromCv: ["firstName"], noResumeAnswers: { a: "b" }, locationText: "Denver" })).toEqual(form);
    expect(ApplyRequest.parse({ firstName: "Ana", lastName: "Diaz", email: "ana@example.com", acknowledged: true })).toMatchObject({ answers: {}, noticeVersionsShown: [] });
  });

  it("is refused without the acknowledgment tick, and with the honeypot filled", () => {
    expect(ApplyRequest.safeParse({ ...form, acknowledged: false }).error?.issues[0]?.message).toBe("Please confirm you have read the notice.");
    const { acknowledged: _tick, ...unticked } = form;
    expect(ApplyRequest.safeParse(unticked).success).toBe(false);
    expect(ApplyRequest.safeParse({ ...form, website: "http://spam.example" }).success).toBe(false);
  });
});

describe("the job builder and the one editor", () => {
  it("starts from the idea or a pasted ad, and answers up to three cards at a time", () => {
    expect(StartIntake.safeParse({}).error?.issues[0]?.message).toBe("Describe the job first: a sentence or two, or paste a job ad you already have.");
    expect(StartIntake.parse({ initialMessage: "  Software engineer, 3 years of Python and Flask  " })).toEqual({ initialMessage: "Software engineer, 3 years of Python and Flask" });
    expect(IntakeAnswersRequest.parse({ answers: [{ questionId: "q1", selected: ["remote"] }] }).answers[0]).toEqual({ questionId: "q1", selected: ["remote"], own: [], skipped: false });
    expect(IntakeAnswersRequest.safeParse({ answers: [] }).success).toBe(false);
    expect(IntakeAnswersRequest.safeParse({ answers: [{ questionId: "pay", pay: { basis: "hourly", min: 24, max: 28 } }] }).success).toBe(true);
  });

  it("changes only what is sent, section by section, and refuses anything that is not the job's", () => {
    const edit = PacketFieldEdit.parse({ baseVersion: 3, identity: { title: "  Senior dental assistant ", remotePolicy: "hybrid" }, formQuestions: [{ kind: "yes_no", question: "Can you work Saturdays?" }, { kind: "choice", key: "shift", question: "Which shift?", options: ["AM", "PM"] }], screening: { maxMinutes: 15 }, competencies: [{ name: "Chairside assisting", importance: "essential" }] });
    expect(edit).toEqual({ baseVersion: 3, identity: { title: "Senior dental assistant", remotePolicy: "hybrid" }, formQuestions: [{ kind: "yes_no", question: "Can you work Saturdays?" }, { kind: "choice", key: "shift", question: "Which shift?", options: ["AM", "PM"] }], screening: { maxMinutes: 15 }, competencies: [{ name: "Chairside assisting", importance: "essential" }] });
    expect(PacketFieldEdit.safeParse({ baseVersion: 3, provenance: { flags: [] } }).success).toBe(false);
    expect(PacketFieldEdit.safeParse({ baseVersion: 3, identity: { reportsTo: "Sam" } }).success).toBe(false);
    expect(PacketFieldEdit.safeParse({ baseVersion: 3, formQuestions: [{ kind: "written", question: "Why this job?" }] }).success).toBe(false);
    expect(PacketFieldEdit.safeParse({ baseVersion: 3, competencies: [{ name: "Chairside assisting", weight: 5 }] }).success).toBe(false);
    expect(PacketFieldEdit.safeParse({ identity: { title: "No base version" } }).success).toBe(false);
  });

  it("keeps a flagged phrase on a published job only with a reason, sent with the edit", () => {
    expect(PacketFieldEdit.parse({ baseVersion: 2, keepFlags: [{ flagId: "f1", reason: "  A real requirement of the job " }] }).keepFlags).toEqual([{ flagId: "f1", reason: "A real requirement of the job" }]);
    expect(PacketFieldEdit.safeParse({ baseVersion: 2, keepFlags: [{ flagId: "f1", reason: "ok" }] }).error?.issues[0]?.message).toBe("Say why in a few words (at least five characters).");
  });

  it("edits a written draft with the same shape, without a version", () => {
    expect(DraftFieldEdit.parse({ description: "A busy family practice is looking for a dental assistant who enjoys patient care.", requirements: { mustHaves: [{ key: "mh_1", text: "Active RDA license" }, { text: "X-ray certified" }] } })).toMatchObject({ requirements: { mustHaves: [{ key: "mh_1", text: "Active RDA license" }, { text: "X-ray certified" }] } });
    expect(DraftFieldEdit.safeParse({ baseVersion: 1 }).success).toBe(false);
    expect(DraftFieldEdit.safeParse({ keepFlags: [{ flagId: "f1", reason: "A real requirement of the job" }] }).success).toBe(false);
    expect(DraftFieldEdit.safeParse({ description: "Too short." }).error?.issues[0]?.message).toBe("The job description needs at least 50 characters.");
  });

  it("names a draft one way everywhere: by the written job's title once it is written, by the title from the answers before, and by nothing until one is known", () => {
    const answers = { title: "Hygienist" };
    expect(draftTitleOf({ facts: answers, draft: null })).toBe("Hygienist");
    expect(draftTitleOf({ facts: answers })).toBe("Hygienist");
    // the written job's title wins, also when a person changed it in the editor and the answers still say the first one
    expect(draftTitleOf({ facts: answers, draft: { identity: { title: "Senior Dental Hygienist" } } })).toBe("Senior Dental Hygienist");
    expect(draftTitleOf({ facts: {}, draft: { identity: { title: " Dental Hygienist " } } })).toBe("Dental Hygienist");
    expect(draftTitleOf({ facts: answers, draft: { identity: { title: " " } } })).toBe("Hygienist");
    for (const none of [{ facts: {} }, { facts: { title: "  " }, draft: null }, { facts: { title: null }, draft: { identity: {} } }]) expect(draftTitleOf(none)).toBeNull();
  });

  it("says what a draft still needs one way: the essentials that are missing, and the pay while it is stated and nobody has confirmed it", () => {
    // nothing stated yet: the missing essentials, as the server lists them
    expect(draftStillNeeds({ missing: ["location", "compensation_range", "must_haves"], payConfirmed: false })).toEqual(["location", "compensation_range", "must_haves"]);
    // the pay is stated (a pasted ad) and waits for a person: it is still needed, in the essentials' own place
    expect(draftStillNeeds({ missing: ["location", "must_haves"], payConfirmed: false })).toEqual(["location", "compensation_range", "must_haves"]);
    expect(draftStillNeeds({ missing: [], payConfirmed: false })).toEqual(["compensation_range"]);
    // confirmed: only what is missing
    expect(draftStillNeeds({ missing: ["schedule"], payConfirmed: true })).toEqual(["schedule"]);
    expect(draftStillNeeds({ missing: [], payConfirmed: true })).toEqual([]);
    // the pay is never counted twice, and what the server calls missing is never dropped
    for (const missing of [[], ["compensation_range"], ["title", "schedule"]] as const) {
      for (const payConfirmed of [true, false]) {
        const needs = draftStillNeeds({ missing, payConfirmed });
        expect(needs.filter((k) => k === "compensation_range").length).toBeLessThanOrEqual(1);
        for (const key of missing) expect(needs).toContain(key);
      }
    }
  });

  it("closes a job only with a confirmation", () => {
    expect(CloseRole.safeParse({}).success).toBe(false);
    expect(CloseRole.parse({ confirm: true })).toEqual({ confirm: true });
  });
});

describe("what can be done with a job", () => {
  const names = (status: "draft" | "open" | "paused" | "closed", role: "owner" | "admin" | "hiring_manager", trialEnded = false) => roleActions({ status, role, trialEnded }).map((a) => `${a.action}:${a.allowed ? "yes" : "no"}`);

  it("lets everyone on the team edit and publish, and an owner or an admin pause, resume, set the closing date and close", () => {
    expect(names("draft", "hiring_manager")).toEqual(["edit:yes", "publish:yes", "set_closing_date:no", "close:no"]);
    expect(names("draft", "owner")).toEqual(["edit:yes", "publish:yes", "set_closing_date:yes", "close:yes"]);
    expect(names("open", "admin")).toEqual(["edit:yes", "pause:yes", "set_closing_date:yes", "close:yes"]);
    expect(names("open", "hiring_manager")).toEqual(["edit:yes", "pause:no", "set_closing_date:no", "close:no"]);
    expect(names("paused", "owner")).toEqual(["edit:yes", "resume:yes", "set_closing_date:yes", "close:yes"]);
    expect(roleActions({ status: "open", role: "hiring_manager", trialEnded: false }).find((a) => a.action === "pause")?.reason).toBe(ROLE_ACTION_BLOCKED.ownerOrAdmin);
  });

  it("changes nothing on a closed job, and starts nothing new once a trial has ended", () => {
    expect(roleActions({ status: "closed", role: "owner", trialEnded: false })).toEqual([{ action: "edit", label: "Edit", allowed: false, reason: ROLE_ACTION_BLOCKED.closed }]);
    expect(names("draft", "owner", true)).toEqual(["edit:yes", "publish:no", "set_closing_date:yes", "close:yes"]);
    expect(names("paused", "owner", true)).toEqual(["edit:yes", "resume:no", "set_closing_date:yes", "close:yes"]);
    expect(names("open", "owner", true)).toEqual(["edit:yes", "pause:yes", "set_closing_date:yes", "close:yes"]);
  });
});

describe("the Share tab's posts and links", () => {
  it("has a LinkedIn post and an Indeed post, each carrying the job page's address with its source", () => {
    expect(PostChannel.options).toEqual(["linkedin", "indeed"]);
    expect(applyLinkFor("https://jobs.example.com/careers/smile/jobs/r1", "linkedin")).toBe("https://jobs.example.com/careers/smile/jobs/r1?src=linkedin");
    expect(applyLinkFor("https://jobs.example.com/careers/smile/jobs/r1?x=1", "indeed")).toBe("https://jobs.example.com/careers/smile/jobs/r1?x=1&src=indeed");
    expect(["linkedin", "indeed", "", null, "direct", "newsletter"].map(applySourceLabel)).toEqual(["LinkedIn", "Indeed", "Job page", "Job page", "Job page", "Newsletter"]);
  });

  it("stores the two texts, whether a person edited each, and where the writing stands", () => {
    expect(JobPosts.safeParse({ linkedin: "We are hiring.", indeed: "" }).success).toBe(false);
    expect(RolePosts.parse({ state: "writing" })).toEqual({ linkedin: null, indeed: null, state: "writing", version: null });
    expect(RolePosts.parse({ linkedin: { text: "We are hiring.", writtenAt: "2026-11-18T10:00:00.000Z" }, indeed: null, state: "ready", version: 2 }).linkedin).toEqual({ text: "We are hiring.", edited: false, writtenAt: "2026-11-18T10:00:00.000Z" });
  });

  it("says in plain words why there is no post, and never tells anyone to pay", () => {
    expect(SHARE_LINE.noAi).toBe("Your plan's AI help is used up. You can write these posts yourself.");
    for (const line of Object.values(SHARE_LINE)) expect(line).not.toMatch(/\$|\bdollars?\b|\bcredit\b/i);
  });
});

describe("acting on candidates", () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it("takes one action for one person, and nothing else with it", () => {
    expect(ApplicationAction.parse({ action: "shortlist" })).toEqual({ action: "shortlist" });
    for (const gone of ["invite_screen", "set_mark", "hold", "move_to_talent_pool", "advance_to_interview", "told_in_person"]) expect(ApplicationAction.safeParse({ action: gone }).success, gone).toBe(false);
    expect(ApplicationAction.safeParse({ action: "reject", reason: "other" }).success).toBe(false);
  });

  it("takes Shortlist, Not selected, Email the decision and its undo for several people, each once", () => {
    expect(BulkApplicationAction.safeParse({ action: "unsend_decision", applicationIds: [id(1)] }).success).toBe(true);
    expect(BulkApplicationAction.parse({ action: "shortlist", applicationIds: [id(1), id(2)] }).applicationIds).toHaveLength(2);
    expect(BulkApplicationAction.safeParse({ action: "hire", applicationIds: [id(1)] }).success).toBe(false);
    expect(BulkApplicationAction.safeParse({ action: "reject", applicationIds: [] }).error?.issues[0]?.message).toBe("Choose at least one person.");
    expect(BulkApplicationAction.safeParse({ action: "reject", applicationIds: [id(1), id(1)] }).error?.issues[0]?.message).toBe("Each person can appear once.");
  });

  it("asks for one tab of the list, New when none is named", () => {
    expect(CandidateListQuery.parse({})).toEqual({ tab: "new" });
    expect(CandidateListQuery.parse({ tab: "interviewed" })).toEqual({ tab: "interviewed" });
    expect(CandidateListQuery.safeParse({ tab: "longlist" }).success).toBe(false);
  });
});

describe("settings", () => {
  it("changes the company's own details and nothing an administrator sets", () => {
    expect(UpdateCompany.parse({ name: " Smile Dental ", benefitsSummary: "Health and dental" })).toEqual({ name: "Smile Dental", benefitsSummary: "Health and dental" });
    for (const notTheirs of [{ planKey: "ultra" }, { status: "active" }, { settings: { verifiedAt: "2026-01-01" } }]) expect(UpdateCompany.safeParse(notTheirs).success).toBe(false);
    expect(UpdateCompany.safeParse({ timezone: "Mars/Olympus" }).error?.issues[0]?.message).toBe("Choose a time zone from the list.");
  });

  it("invites and changes people only in the three roles", () => {
    expect(InviteMember.parse({ email: "pat@example.com", role: "hiring_manager" })).toEqual({ email: "pat@example.com", role: "hiring_manager" });
    expect(InviteMember.safeParse({ email: "pat@example.com", role: "interviewer" }).success).toBe(false);
    expect(UpdateMember.safeParse({}).success).toBe(false);
    expect(UpdateMember.parse({ status: "removed" })).toEqual({ status: "removed" });
  });

  it("has one switch for email updates, and always emails account notices", () => {
    expect(UpdateNotificationPreferences.parse({ emailUpdates: false })).toEqual({ emailUpdates: false });
    expect(UpdateNotificationPreferences.safeParse({ preferences: [{ group: "candidates", cadence: "daily" }] }).success).toBe(false);
    expect(emailsUpdate("screen.completed", true)).toBe(true);
    expect(emailsUpdate("screen.completed", false)).toBe(false);
    for (const kind of ALWAYS_EMAILED) expect(emailsUpdate(kind, false), kind).toBe(true);
    for (const kind of NotificationKind.options) if (/^(company|member)\./.test(kind)) expect(ALWAYS_EMAILED.has(kind), kind).toBe(true);
    for (const gone of ["interview.confirmed", "approval.requested", "stuck.no_applicants", "message.received", "company.verified"]) expect(NotificationKind.safeParse(gone).success, gone).toBe(false);
  });
});

describe("the app's addresses the server links to", () => {
  it("are spelled in one place: a job, its candidates, one candidate, a draft, settings and the dashboard", () => {
    expect(appPaths.job("r1")).toBe("/roles/r1");
    expect(appPaths.jobShare("r1")).toBe("/roles/r1?tab=share");
    expect(appPaths.candidates("r1")).toBe("/roles/r1/talent");
    expect(appPaths.candidates("r1", "interviewed")).toBe("/roles/r1/talent?tab=interviewed");
    expect(appPaths.candidate("r1", "a1")).toBe("/roles/r1/talent?open=a1");
    expect(appPaths.draft("s1")).toBe("/roles/new?session=s1");
    expect([appPaths.home, appPaths.jobs, appPaths.newJob, appPaths.allCandidates, appPaths.settings, appPaths.updates]).toEqual(["/", "/roles", "/roles/new", "/talent", "/setup", "/updates"]);
    expect([appPaths.admin, appPaths.adminCompany("c1"), appPaths.adminPrivacy, appPaths.adminSystem]).toEqual(["/admin", "/admin?open=c1", "/admin/privacy", "/admin/system"]);
    expect([appPaths.login, appPaths.companyDetails]).toEqual(["/login", "/setup/company"]);
  });
});

describe("the admin dashboard", () => {
  it("shows a company as Active, Waiting or Declined, from its one gate", () => {
    expect(adminCompanyStatus(null)).toBe("active");
    expect(adminCompanyStatus({ status: "requested" })).toBe("waiting");
    expect(adminCompanyStatus({ status: "declined" })).toBe("declined");
    expect([accessDecisionsFor("waiting"), accessDecisionsFor("declined"), accessDecisionsFor("active")]).toEqual([["accept", "decline"], ["accept"], ["remove"]]);
  });

  it("records the privacy requests a candidate can still make", () => {
    expect(DataRequestKind.options).toEqual(["access", "correct", "delete", "human_review", "withdrawal"]);
  });
});
