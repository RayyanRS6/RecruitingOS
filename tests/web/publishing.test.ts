import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JobPreview } from "../../packages/contracts/src/api/packet-tools";
import { closingDateRequired, postingLegalCheck } from "../../packages/core/src/compliance";
import { materialChanges } from "../../apps/api/src/services/packet-versions";
import { shareTargets } from "../../apps/api/src/services/job-urls";
import type { PostingView, PostingsResponse, RolePacket } from "../../apps/web/src/api/client";
import {
  aboutDraftOf, aboutProblem, addDays, autoActionsLine, boardStatus, boardTicksToast, careersStatus, closingDateLine, closingDateProblem, closingDateRequiredFor,
  closingDateToast, dayWords, destinationsOf, draftClosingDateKey, googleStatus, interviewersNote, isClosingDateAction, isLegalReason, isPostingTaskKind, legalLines,
  liveEditWords, logoProblem, logoUrlOf, materialChangesOf, noBoardsLine, opensOwnApp, outdatedBoardsLine, pollInterval, previewHref, previewOfEdit, previewPageHref, queueKindLabel,
  readDraftClosingDate, savedVersionToast, shareSubject, shareTargetsFor, shareTextFor, todayIn, writeDraftClosingDate,
} from "../../apps/web/src/publishing";

/**
 * Approving and publishing (plan Wave D) on the team's pages: the screen right after approval never calls anything
 * done before it was checked; the card says what the law still asks for and what starts on its own; a change to a live
 * job says whether it needs approval, by the server's own rule; the closing date and the share links are worded plainly;
 * and the share buttons are plain links built exactly as the server builds them, with no script from any network.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const packet = (over: Partial<{ title: string; min: number; max: number; region: string; remote: "onsite" | "hybrid" | "remote"; description: string; schedule: string; eligibility: RolePacket["requirements"]["eligibility"] }> = {}): RolePacket => ({
  identity: { title: over.title ?? "Dental hygienist", locations: [{ city: "Irvine", region: over.region ?? "CA" }], employmentType: "full_time", schedule: over.schedule ?? "Mon to Thu", remotePolicy: over.remote ?? "onsite" },
  business: { reason: "replacement", timeline: { urgency: "soon" } },
  compensation: { basis: "hourly", min: over.min ?? 45, max: over.max ?? 55, ceiling: 58, discloseRange: true, sources: [], ownerStated: true },
  description: { publicJobDescription: over.description ?? "We are a friendly practice looking for a hygienist to join our team." },
  requirements: { mustHaves: [], niceToHaves: [], eligibility: over.eligibility ?? [{ key: "license", type: "license", question: "Do you hold an active RDH license?", rationale: "Required by law", knockout: true }] },
  competencies: [],
  screening: { questions: [], maxMinutes: 10 },
  interviews: { plan: [{ key: "r1", title: "Meet the dentist", purpose: "Fit", durationMinutes: 30, format: "video", interviewerUserIds: [], interviewerRoles: [], competencyKeys: [] }] },
  communication: { disclosureText: "AI is used to read applications.", humanAlternativeText: "Ask for a person at any time.", signature: "The team" },
  sourcing: { summary: "", channels: ["indeed"] },
  compliance: { jurisdictions: ["US-CA"], notices: [] },
  preferences: { dealBreakersInTheirWords: [], schedulingWindows: [] },
  provenance: { assumptions: [], sources: [] },
});

const posting = (over: Partial<PostingView>): PostingView => ({
  id: "p1", channel: "indeed", status: "ready_to_post", externalUrl: null, intakeToken: null, instructions: null, steps: [], error: null, publishedAt: null, publicUrlRecordedAt: null, verifiedAt: null, verifiedBy: null,
  verificationNote: null, verificationError: null, verificationAttempts: 0, pausedAt: null, closedAt: null, closureRequired: false, closureConfirmedAt: null, closureConfirmedBy: null,
  name: "Indeed", stateLabel: "Ready to post", isBoard: true, link: null, package: null, stillUp: false, chosen: true, postedBy: "its", task: null, showsOldVersion: false, ...over,
});

const READY = { state: "ready", pollAfterSeconds: null, message: "Everything is prepared.", checksPending: 0 } as const;

describe("the job page preview (D1)", () => {
  it("opens the version waiting, from the app's own address, never under /careers", () => {
    expect(previewHref("r 1", 3)).toBe("/api/v1/roles/r%201/preview?version=3");
    // the in-app previews open the real page in a new tab: the same address with /page
    expect(previewPageHref("/api/v1/roles/r1/preview?version=3")).toBe("/api/v1/roles/r1/preview/page?version=3");
    expect(previewPageHref("/api/v1/intake/sessions/s1/preview")).toBe("/api/v1/intake/sessions/s1/preview/page");
    const plan = read("../../apps/web/src/pages/RolePlan.tsx");
    expect(plan).toContain('href={previewHref(role.id, pending.version)} target="_blank" rel="noopener noreferrer"');
    // only those who see pay (the preview shows it)
    expect(plan).toContain("{canSeePay ? (");
  });
});

describe("the screen right after approval (D2)", () => {
  it("asks again while publishing is under way, and stops when nothing is left to wait for", () => {
    expect(pollInterval({ state: "preparing", pollAfterSeconds: 2, message: "", checksPending: 0 })).toBe(2000);
    expect(pollInterval({ state: "ready", pollAfterSeconds: 10, message: "", checksPending: 1 })).toBe(10_000);
    expect(pollInterval({ ...READY })).toBe(false);
    expect(pollInterval(undefined)).toBe(false);
  });

  it("never ticks the careers page, Google or a board before it was checked", () => {
    for (const status of ["ready_to_post", "posted_manually", "submitted_integration"]) expect(careersStatus({ status }, READY)).toMatchObject({ label: "Checking it is up", done: false, working: true });
    expect(careersStatus({ status: "live_verified" }, READY)).toMatchObject({ label: "Up and checked", tone: "good", done: true });
    expect(googleStatus({ status: "submitted_integration" }, READY)).toMatchObject({ label: "Sent to Google", done: false });
    expect(googleStatus({ status: "live_verified" }, READY)).toMatchObject({ label: "Found in Google", done: true });
    expect(boardStatus(posting({ status: "posted_manually" }), READY)).toMatchObject({ label: "Checking it is up", done: false });
    expect(boardStatus(posting({ status: "live_verified" }), READY)).toMatchObject({ label: "Up and checked", done: true });
    // a board an approved edit left behind is not "up and checked" any more
    expect(boardStatus(posting({ status: "live_verified", showsOldVersion: true }), READY)).toMatchObject({ label: "Shows the earlier version", done: false });
    // while ITS confirms the company, everything waits for that
    for (const s of [careersStatus(undefined, { state: "waiting_for_company_check" }), googleStatus(undefined, { state: "waiting_for_company_check" }), boardStatus(undefined, { state: "waiting_for_company_check" })]) expect(s.label).toBe("Waits for the ITS check");
    expect(careersStatus(undefined, { state: "preparing" })).toMatchObject({ label: "Getting it ready", working: true });
  });

  it("says who has a board: waiting for ITS, the ITS recruiter by name, or the team", () => {
    expect(boardStatus(posting({}), READY).label).toBe("Waiting for ITS");
    expect(boardStatus(posting({ task: { id: "t", kind: "post_job", status: "claimed", label: "Post the job on Indeed", recruiterName: "Pat Poster", createdAt: "", resolvedAt: null, notDone: false, note: null } }), READY).label).toBe("Pat Poster at ITS is posting it");
    // a task ITS closed as not possible is never shown as under way or done
    expect(boardStatus(posting({ task: { id: "t", kind: "post_job", status: "resolved", label: "Post the job on Indeed", recruiterName: "Pat Poster", createdAt: "", resolvedAt: "2026-10-08T10:00:00.000Z", notDone: true, note: "No job slots left." } }), READY)).toMatchObject({ label: "ITS could not post it", tone: "caution", done: false });
    expect(boardStatus(posting({ postedBy: "you" }), READY)).toMatchObject({ label: "Waiting for you to post it", tone: "caution" });
    expect(boardStatus(posting({ status: "closed", closureRequired: true }), READY)).toMatchObject({ label: "Still up: to be taken down", tone: "critical" });
  });

  const view = (over: Partial<PostingsResponse> = {}): Pick<PostingsResponse, "postings" | "publishing" | "urls" | "emailIn" | "boards" | "closingDate"> => ({
    postings: [posting({ id: "c", channel: "careers_page", name: "Careers page", isBoard: false, postedBy: null, status: "posted_manually" }), posting({ id: "g", channel: "google_jobs", name: "Google for Jobs", isBoard: false, postedBy: null, status: "submitted_integration" }), posting({ id: "i" })],
    publishing: READY,
    urls: { careers: "https://jobs.test/c/acme", job: "https://jobs.test/c/acme/jobs/r1", apply: "https://jobs.test/c/acme/jobs/r1/apply" },
    emailIn: { address: "r1@in.test", connected: false, shown: false, status: "failed", error: null },
    boards: [{ channel: "linkedin_basic", name: "LinkedIn", chosen: false, available: true, reason: null, inRolePlan: false }, { channel: "indeed", name: "Indeed", chosen: true, available: true, reason: null, inRolePlan: true }, { channel: "ziprecruiter", name: "ZipRecruiter", chosen: false, available: false, reason: "needs a plan", inRolePlan: false }],
    closingDate: { closesOn: "2026-10-30", closesAt: null, applyBy: "Apply by Friday, October 30, 2026", timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false },
    ...over,
  });

  it("lists the careers page with its address, Google, the email address only while it works, and each chosen board with who posts it", () => {
    const list = destinationsOf(view());
    expect(list.map((d) => d.key)).toEqual(["careers_page", "google_jobs", "indeed"]);
    expect(list[0]).toMatchObject({ name: "Your careers page", url: "https://jobs.test/c/acme/jobs/r1", copy: { text: "https://jobs.test/c/acme/jobs/r1" } });
    expect(list[0].detail).toContain("Apply by Friday, October 30, 2026");
    expect(list[1].detail).toMatch(/Marked found once someone sees it in a Google search/);
    expect(list[2].detail).toBe("ITS is posting this on Indeed from your company's own account.");
    const withEmail = destinationsOf(view({ emailIn: { address: "r1@in.test", connected: true, shown: true, status: "live_verified", error: null } }));
    expect(withEmail.map((d) => d.key)).toEqual(["careers_page", "google_jobs", "email_in", "indeed"]);
    // a chosen board not prepared yet shows as being got ready; a board a person closed (never up) is left out
    expect(destinationsOf(view({ postings: [] })).find((d) => d.key === "indeed")?.status.label).toBe("Getting it ready");
    expect(destinationsOf(view({ postings: [posting({ status: "closed" })] })).some((d) => d.key === "indeed")).toBe(false);
    expect(noBoardsLine(view().boards)).toBeNull();
    expect(noBoardsLine(view().boards.map((b) => ({ ...b, chosen: false })))).toBe("No job boards were chosen for this job. You can add LinkedIn or Indeed from the Share tab at any time.");
  });

  it("says when no interviewers are set, and which boards still show the earlier version after an approved change", () => {
    expect(interviewersNote({ rounds: 2, roundsWithoutInterviewers: 2 })).toMatch(/^Nobody is set to interview yet\./);
    expect(interviewersNote({ rounds: 3, roundsWithoutInterviewers: 1 })).toMatch(/^1 of the 3 interview rounds have nobody/);
    expect(interviewersNote({ rounds: 2, roundsWithoutInterviewers: 0 })).toBeNull();
    expect(outdatedBoardsLine(["indeed"], "its")).toBe("Indeed still shows the earlier version. ITS has a task to update it from your company's account.");
    expect(outdatedBoardsLine(["linkedin_basic", "indeed"], "self")).toBe("LinkedIn, Indeed still show the earlier version. Update them from your own account, then confirm on the Share tab.");
    expect(outdatedBoardsLine([], "its")).toBeNull();
  });

  it("is a calm confirmation with a tick, 'Go to your role' as the main button and 'Share it now'", () => {
    const screen = read("../../apps/web/src/pages/AfterApproval.tsx");
    expect(screen).toContain('title={props.editWhileOpen ? "Your change is approved" : "Your job is approved"}');
    expect(screen).toContain('mark="check"');
    expect(screen).toContain('<Button variant="primary" onClick={props.onClose}>Go to your role</Button>');
    expect(screen).toContain(">Share it now</Button>");
    expect(screen).toContain("pollInterval(query.state.data?.publishing)");
    expect(screen).toContain("props.editWhileOpen && Date.now() - openedAt.current < EDIT_SETTLE_MS ? 3000");
    // the approval card opens it once the approval went through
    expect(read("../../apps/web/src/pages/RolePlan.tsx")).toContain("onApproved({ editWhileOpen })");
    expect(read("../../apps/web/src/pages/RoleDetail.tsx")).toContain("<AfterApproval open");
  });
});

describe("what starts on its own, and the legal check, on the approval card (D9, D5)", () => {
  it("puts what starts on its own once the job is live in one plain line", () => {
    expect(autoActionsLine({ lines: [{ actionType: "message.send_templated", level: "auto", text: "Every applicant gets an email confirming their application." }, { actionType: "application.invite_screen", level: "approval", text: "Invitations to the screening conversation wait for your approval." }] }))
      .toBe("Once it is live: Every applicant gets an email confirming their application. Invitations to the screening conversation wait for your approval.");
    expect(autoActionsLine({ lines: [] })).toBeNull();
    expect(read("../../apps/web/src/pages/RolePlan.tsx")).toContain("<Link to={role.autoActionsOnOpen.changeHref}>Change these rules</Link>");
  });

  it("lists what the law of a Colorado job still asks for, then what is in order", () => {
    const base = packet({ region: "CO" });
    const check = postingLegalCheck({ packet: base as never, companySettings: {}, closesOn: null, defaultClosesOn: "2026-11-07", today: "2026-10-08" });
    const lines = legalLines(check);
    expect(lines.missing.map((i) => i.key)).toEqual(["benefits"]);
    expect(lines.inOrder.map((i) => i.key)).toEqual(["pay_range", "closing_date"]);
    expect(legalLines(null)).toEqual({ missing: [], inOrder: [] });
    // the card lists the items instead of repeating the server's sentence
    expect(isLegalReason("Before this job can go live, the law where it is asks for: a short description of the benefits.")).toBe(true);
    expect(isLegalReason("You started this role, so someone else approves it.")).toBe(false);
  });
});

describe("a change to a live job (D4, founder decision Q10)", () => {
  it("needs approval for the pay, the title, the place or the application form's questions, by the server's own rule", () => {
    const before = packet();
    const cases: Array<[RolePacket, string[]]> = [
      [packet({ description: "We are a friendly practice looking for a hygienist to join us. Updated words." }), []],
      [packet({ schedule: "Tue to Fri" }), []],
      [packet({ min: 47 }), ["pay"]],
      [packet({ title: "Registered dental hygienist" }), ["title"]],
      [packet({ region: "NV" }), ["location"]],
      [packet({ remote: "remote" }), ["location"]],
      [packet({ eligibility: [] }), ["eligibility"]],
      [packet({ min: 47, title: "Hygienist (RDH)" }), ["pay", "title"]],
    ];
    for (const [after, want] of cases) {
      expect(materialChangesOf(before, after)).toEqual(want);
      expect(materialChanges(before as never, after as never)).toEqual(want);
    }
    // a packet read back with its keys in another order is not a change
    const reordered = JSON.parse(JSON.stringify(before)) as RolePacket;
    reordered.identity.locations = [{ region: "CA", city: "Irvine" }];
    expect(materialChangesOf(before, reordered)).toEqual([]);
  });

  it("says what confirming does before anything is saved, and what saving did after", () => {
    expect(liveEditWords([])).toMatchObject({ heading: "This change goes live when you confirm", confirm: "Make it live" });
    expect(liveEditWords(["pay", "title"]).body).toMatch(/^It changes the pay and the job title, so it needs the same approval as a new role/);
    expect(liveEditWords(["pay"]).confirm).toBe("Save and ask for approval");
    expect(savedVersionToast({ version: 4, outcome: "approved_current", boardsShowingOldVersion: ["indeed"] }, "its")).toEqual({ title: "Version 4 is live.", detail: "Indeed still shows the earlier version. ITS has a task to update it from your company's account." });
    expect(savedVersionToast({ version: 4, outcome: "approved_current", boardsShowingOldVersion: [] }, "its")).toEqual({ title: "Version 4 is live.", detail: "The job page shows it now." });
    expect(savedVersionToast({ version: 5, outcome: "proposed_pending_approval", needsApproval: { changes: ["pay"], words: "This changes the pay, so it needs the same approval as a new role before it goes live.", youMayConfirm: true } }, "its").detail).toMatch(/As the company's only owner, you confirm it yourself on the approval card/);
    expect(savedVersionToast({ version: 5, outcome: "proposed_pending_approval", needsApproval: null }, "its").title).toBe("Saved as version 5. It takes effect once an approver says yes.");
    expect(savedVersionToast({ version: 2, outcome: "proposed", guardChanges: ["The ceiling was raised to the top of the range."] }, "self")).toEqual({ title: "Saved as version 2 with the draft.", detail: "The ceiling was raised to the top of the range." });
  });

  it("shows the job page with the unsaved words laid over the saved version's preview", () => {
    const base: JobPreview = {
      source: { kind: "version", roleId: "r1", version: 2, status: "approved", current: true }, notPublicYet: false, banner: "This is the live version of the job page.",
      company: { name: "Bright Dental", slug: "bright", website: null, logoUrl: null, verified: true, about: "A family practice." },
      job: { title: "Dental hygienist", facts: [], locations: ["Irvine, CA"], description: "Old words", mustHaves: ["Old must-have"], niceToHaves: [], benefits: "Health and dental.", steps: ["Apply in about 15 minutes, including a short written conversation with Bright Dental's AI assistant. We confirm by email.", "The conversation: 9 questions, about 10 minutes. It is not a test. You can skip a question, stop and come back later, or ask for a person instead.", "Meet the dentist (30 minutes)", "A decision, and a real answer either way."], notices: [] },
      pay: { shown: true, text: "$45–$55 an hour", requiredByLaw: true, note: null },
      apply: { questions: [], notices: [], disclosure: "AI", humanAlternative: "Person" },
      gaps: [],
    };
    const edited = packet({ description: "New words for the job page, a little longer than before." });
    edited.screening.maxMinutes = 15;
    const p = previewOfEdit(base, edited);
    expect(p.notPublicYet).toBe(true);
    expect(p.banner).toMatch(/^Your changes, not saved yet/);
    expect(p.job.description).toBe("New words for the job page, a little longer than before.");
    expect(p.job.facts.map((f) => f.key)).toEqual(["location", "workplace", "job_type", "pay", "schedule"]);
    expect(p.job.facts.find((f) => f.key === "pay")?.text).toBe("$45–$55 an hour");
    // applying in one visit: the total time and the conversation's questions and minutes follow the edit (plan E8)
    expect(p.job.steps[0]).toBe("Apply in about 20 minutes, including a short written conversation with Bright Dental's AI assistant. We confirm by email.");
    expect(p.job.steps[1]).toBe(`The conversation: ${edited.screening.questions.length} questions, about 15 minutes. It is not a test. You can skip a question, stop and come back later, or ask for a person instead.`);
    // the later path: the form's own time stays; the conversation's minutes follow the edit
    const later = previewOfEdit({ ...base, job: { ...base.job, steps: ["Send a short form, about 3 minutes. We confirm by email.", "Possibly a short written conversation with Bright Dental's AI assistant (online, about 10 minutes). If so, we email you the link.", "A decision, and a real answer either way."] } }, edited);
    expect(later.job.steps[0]).toBe("Send a short form, about 3 minutes. We confirm by email.");
    expect(later.job.steps[1]).toBe("Possibly a short written conversation with Bright Dental's AI assistant (online, about 15 minutes). If so, we email you the link.");
    expect(later.job.steps.join(" ")).not.toMatch(/three minutes|looks like a fit/);
    expect(p.apply.questions).toEqual([{ key: "license", question: "Do you hold an active RDH license?", help: "Required by law", answer: "yes_no" }]);
    // the lists come from the edited words, as the job page shows them; the company's text and the benefits carry over (plan D10)
    expect(p.job.mustHaves).toEqual(edited.requirements.mustHaves.map((m) => m.text));
    expect(p.job.niceToHaves).toEqual(edited.requirements.niceToHaves.map((m) => m.text));
    expect(p.job.benefits).toBe(edited.compensation.benefitsSummary?.trim() || "Health and dental.");
    expect(p.company.about).toBe("A family practice.");
    // pay hidden on the saved page stays hidden
    expect(previewOfEdit({ ...base, pay: { ...base.pay, shown: false } }, edited).job.facts.some((f) => f.key === "pay")).toBe(false);
  });

  it("the editor asks first only for an approver's change to the live version", () => {
    const editor = read("../../apps/web/src/pages/RoleEditor.tsx");
    expect(editor).toContain('const liveEdit = roleStatus === "open" && mayApprove && !proposed;');
    expect(editor).toContain("if (liveEdit) setReviewing(true);");
    // what the change needs is read from the fields as they are now, so a later edit is never saved stale
    expect(editor).toContain("review = { next, material: materialChangesOf(packet, next) };");
    expect(editor).toContain("const confirmLive = () => { if (check()) save.mutate(build()); };");
    expect(editor).toContain("See the job page with your changes");
  });
});

describe("the closing date (D7, founder decision Q12)", () => {
  const view = { closesOn: "2026-10-30", closesAt: "2026-10-31T07:00:00.000Z", applyBy: "Apply by Friday, October 30, 2026", timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false };

  it("says when applications stop, that nobody is turned away, and the Colorado default", () => {
    expect(closingDateLine(view)).toMatch(/^Apply by Friday, October 30, 2026\. New applications stop at the end of that day \(.+\); anyone part-way through can still finish\.$/);
    expect(closingDateLine({ ...view, passed: true, applicationsClosedByDate: true })).toMatch(/has passed, so new applications stopped\. Nobody was turned away/);
    expect(closingDateLine({ ...view, closesOn: null, applyBy: null, requiredByLaw: true, defaultIfMissing: "2026-11-07" })).toMatch(/Colorado asks the job ad to say when applications close\. Without a date of your own it will be Saturday, November 7, 2026/);
    expect(closingDateLine({ ...view, closesOn: null, applyBy: null })).toBe("No closing date: the job takes applications until you stop them.");
  });

  it("refuses a date in the past and says what saving did", () => {
    expect(closingDateProblem("2026-10-07", "2026-10-08")).toMatch(/today or a later date/);
    expect(closingDateProblem("2026-10-08", "2026-10-08")).toBeNull();
    expect(closingDateProblem("", "2026-10-08")).toBe("Choose a date.");
    expect(closingDateToast({ reopened: true, closingDate: view })).toEqual({ title: "Taking applications again until Friday, October 30.", detail: "The job page shows the apply button again. Emails that arrived meanwhile were added." });
    expect(closingDateToast({ reopened: false, closingDate: view }).title).toBe("Applications close at the end of Friday, October 30.");
    expect(closingDateToast({ reopened: false, closingDate: { ...view, closesOn: null } }).title).toBe("Closing date taken off.");
  });

  it("counts days in the company's zone, never the browser's", () => {
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(dayWords("2026-10-30")).toBe("Friday, October 30, 2026");
    expect(dayWords("2026-10-30", false)).toBe("Friday, October 30");
    // 03:00 UTC on 9 October is still 8 October in Los Angeles
    expect(todayIn("America/Los_Angeles", new Date("2026-10-09T03:00:00Z"))).toBe("2026-10-08");
    expect(todayIn("Not/AZone", new Date("2026-10-09T03:00:00Z"))).toBe("2026-10-09");
  });

  it("Today's 'Extend' posts the date as the card has it; 'Close the role' opens the close form, nothing more", () => {
    expect(isClosingDateAction({ method: "POST", path: "/api/v1/roles/r1/closing-date" })).toBe(true);
    expect(isClosingDateAction({ method: "GET", path: "/roles/r1?tab=posting#closing-date" })).toBe(false);
    const home = read("../../apps/web/src/pages/Home.tsx");
    expect(home).toContain("isClosingDateAction(a) ? a.body ?? {}");
    expect(home).toContain('closing_date: "Closing date"');
    expect(read("../../apps/web/src/pages/RoleDetail.tsx")).toContain('const wantsClose = search.get("close") === "1";');
  });

  it("knows before the role exists when the law asks for a date, by the server's rule", () => {
    for (const input of [{ locations: [{ region: "CO" }] }, { locations: [{ region: "CA" }] }, { locations: [{ region: "CA" }], remotePolicy: "remote" }, { locations: [] }]) {
      expect(closingDateRequiredFor(input)).toBe(closingDateRequired({ jobLocations: input.locations.map((l) => ({ city: "X", region: l.region, country: "US" })) as never, remotePolicy: (input as { remotePolicy?: string }).remotePolicy }));
    }
    expect(closingDateRequiredFor({ locationText: "Denver, Colorado" })).toBe(true);
    expect(closingDateRequiredFor({ locationText: "Costa Mesa, CA" })).toBe(false);
  });

  it("keeps a draft's date in this browser until the role exists, and survives a browser that keeps nothing", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    writeDraftClosingDate(storage, "s1", "2026-11-01");
    expect(store.get(draftClosingDateKey("s1"))).toBe("2026-11-01");
    expect(readDraftClosingDate(storage, "s1")).toBe("2026-11-01");
    writeDraftClosingDate(storage, "s1", "");
    expect(readDraftClosingDate(storage, "s1")).toBe("");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => writeDraftClosingDate(broken, "s1", "2026-11-01")).not.toThrow();
    expect(readDraftClosingDate(broken, "s1")).toBe("");
  });
});

describe("sharing (D8)", () => {
  it("builds every share button's address exactly as the server does", () => {
    const input = { url: "https://jobs.test/a/abc123", text: "Bright Dental is hiring: Dental hygienist in Irvine, CA. Know someone? https://jobs.test/a/abc123", subject: "Bright Dental is hiring: Dental hygienist" };
    expect(shareTargetsFor(input)).toEqual(shareTargets(input));
    expect(shareTargetsFor(input).map((t) => t.url.split(":")[0])).toEqual(["mailto", "sms", "https", "https", "https", "https"]);
  });

  it("puts a place's own link in the text in place of the job page's address", () => {
    expect(shareTextFor({ text: "Join us: https://jobs.test/c/x/jobs/r1", jobUrl: "https://jobs.test/c/x/jobs/r1" }, "https://jobs.test/a/zz")).toBe("Join us: https://jobs.test/a/zz");
    expect(shareTextFor({ text: "Join us", jobUrl: "https://jobs.test/c/x/jobs/r1" }, "https://jobs.test/a/zz")).toBe("Join us https://jobs.test/a/zz");
    expect(shareSubject("Bright Dental", "Hygienist")).toBe("Bright Dental is hiring: Hygienist");
    expect(shareSubject(null, "Hygienist")).toBe("We are hiring: Hygienist");
    expect(opensOwnApp("email")).toBe(true);
    expect(opensOwnApp("whatsapp")).toBe(false);
  });

  it("loads nothing from any network: plain links that open in a new tab without access back to our page", () => {
    const share = read("../../apps/web/src/components/ShareJob.tsx");
    expect(share).not.toMatch(/<script|<iframe|connect\.facebook|platform\.linkedin|widgets\.js/);
    expect(share).toContain('target="_blank" rel="noopener noreferrer"');
    expect(share).toContain("tab.opener = null;");
    // the share block on the Posting tab (Today links to #share) and in the empty applicant list
    // focusable from code only, so following Today's link puts the keyboard there too
    expect(read("../../apps/web/src/pages/RolePosting.tsx")).toContain('<section id="share" className="setup-section" tabIndex={-1}>');
    expect(read("../../apps/web/src/pages/People.tsx")).toContain("<ShareJob roleId={roleId}");
  });
});

describe("board ticks and ITS posting tasks (D6, D3)", () => {
  it("says what saving the ticks does", () => {
    expect(boardTicksToast({ before: ["indeed"], after: ["indeed", "linkedin_basic"], roleStatus: "open", whoPosts: "its" })).toEqual({ title: "Boards saved: Indeed, LinkedIn.", detail: "ITS posts the job on LinkedIn from your company's account." });
    expect(boardTicksToast({ before: ["indeed"], after: [], roleStatus: "open", whoPosts: "self" })).toEqual({ title: "No job boards for this job.", detail: "Indeed closed; take the listing down from your own account if it was up." });
    expect(boardTicksToast({ before: [], after: ["indeed"], roleStatus: "pending_approval", whoPosts: "its" }).detail).toMatch(/^Nothing is posted until the job is approved/);
  });

  it("names the posting tasks in the queue in words", () => {
    expect(queueKindLabel("post_job")).toBe("Post a job");
    expect(queueKindLabel("take_down_job")).toBe("Take a job listing down");
    expect(queueKindLabel("stuck_role")).toBe("stuck role");
    expect(isPostingTaskKind("update_job")).toBe(true);
    expect(isPostingTaskKind("ask")).toBe(false);
    const queue = read("../../apps/web/src/pages/RecruiterQueue.tsx");
    expect(queue).toContain("<PostingTaskPanel id={e.id} task={e.postingTask}");
    expect(queue).toContain(`/api/v1/escalations/\${id}/posting/\${input.path}`);
  });

  it("the Posting tab says ITS is posting, never 'from your own account', when ITS posts", () => {
    const tab = read("../../apps/web/src/pages/RolePosting.tsx");
    expect(tab).toContain(`ITS is posting this on \${p.name} from your company's own account`);
    expect(tab).toContain('"Posted by ITS from your company\'s own account"');
  });
});

describe("Setup: the logo and the 'about the company' text (Q13)", () => {
  it("takes a small picture, never a typed address", () => {
    expect(logoProblem({ type: "image/png", size: 40_000 })).toBeNull();
    expect(logoProblem({ type: "image/svg+xml", size: 4_000 })).toBe("Use a PNG, JPG or WebP picture.");
    expect(logoProblem({ type: "image/jpeg", size: 3 * 1024 * 1024 })).toMatch(/larger than 2 MB/);
    expect(logoProblem({ type: "image/webp", size: 0 })).toBe("That file is empty.");
    expect(logoUrlOf({ logoUrl: "/files/logo/abc.png" })).toBe("/files/logo/abc.png");
    expect(logoUrlOf({ settings: { logoUrl: "/c/acme/logo" } })).toBe("/c/acme/logo");
    expect(logoUrlOf({})).toBeNull();
    const setup = read("../../apps/web/src/pages/Setup.tsx");
    expect(setup).not.toContain("Logo address (https)");
    expect(setup).toContain('form.append("file", f)');
  });

  it("shows only words a person approved; the assistant's draft is marked until then", () => {
    expect(aboutProblem("Short.")).toMatch(/at least 40 characters/);
    expect(aboutProblem("We are a family dental practice in Irvine serving the community since 1998.")).toBeNull();
    expect(aboutDraftOf({ text: "Drafted words" })).toBe("Drafted words");
    expect(aboutDraftOf({ draft: { text: "Nested" } })).toBe("Nested");
    expect(aboutDraftOf(null)).toBe("");
    const setup = read("../../apps/web/src/pages/Setup.tsx");
    expect(setup).toContain("Drafted by the assistant (AI)");
    expect(setup).toContain("Approve and show it");
    expect(setup).not.toContain("companyBlurb");
  });
});
