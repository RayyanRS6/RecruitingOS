import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * What live testing on staging found on the team's pages (13 Oct 2026), as the shell first draws them from answers
 * shaped like the API's: the approval card while the worker catches up (after sending a role back too), Setup's calendar
 * line when calendars are not switched on, the interview approval's meeting link with and without a working calendar,
 * an interview's Link line, and the admin console's alerts, Queue and Business calendar tabs.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { CatchingUpCard, PacketApprovalCard } = await import("@ros/web/src/pages/RolePlan");
const { Interviews, noLinkText } = await import("@ros/web/src/pages/Interviews");
const { CALENDAR_OFF_LINE, Setup } = await import("@ros/web/src/pages/Setup");
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");
const { dayKey } = await import("@ros/web/src/pages/candidate-panel/helpers");
const { ACK_FOR_ANOTHER, CalendarAdmin, Failures, Queue } = await import("@ros/web/src/pages/Admin");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const owner = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } };
const admin = { ...owner, user: { ...owner.user, id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, memberships: [], activeCompanyId: null };

function client(data: Array<[unknown[], unknown]> = [], me: unknown = owner) {
  // A query that failed stays failed while the page is drawn (nothing is fetched on the server).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  qc.setQueryData(["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } });
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
function failed(qc: QueryClient, queryKey: unknown[]) {
  qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error: new Error("The server did not answer."), fetchStatus: "idle" });
  return qc;
}

describe("the approval card while the worker catches up", () => {
  const role = (status: string, latest: unknown = null) => ({ id: "r1", title: "Dental hygienist", status, packetApproval: { pending: null, latest }, currentPacket: { version: 1, status: "proposed", packet: { provenance: { assumptions: [] } } }, proposedPacket: null, boards: [], autoActionsOnOpen: { lines: [], changeHref: "/setup#setup-rules" } });
  const card = (r: ReturnType<typeof role>) => render(client(), createElement(PacketApprovalCard, { role: r as never, onEdit: () => undefined, canEdit: true, canManage: true, canSeePay: true, showingProposed: false, onShowProposed: () => undefined, onApproved: () => undefined }));

  it("says the approval is on its way just after 'Ask for approval', instead of showing nothing", () => {
    const html = card(role("pending_approval"));
    expect(text(html)).toContain("Getting the approval ready");
    expect(text(html)).toContain("The approval shows here in a few seconds. This page updates on its own; if it does not, reload it.");
    expect(html).toContain('role="status"');
    expect(html).toContain('<span class="spinner" aria-hidden="true"></span>');
  });

  it("says the job is opening just after it was approved", () => {
    const html = card(role("pending_approval", { id: "ap1", status: "approved", version: 1, decisionNote: null, decidedAt: daysAgo(0), decidedBy: { id: "u1", name: "Dana" } }));
    expect(text(html)).toContain("Approved: the job is opening");
    expect(text(html)).not.toContain("Getting the approval ready");
  });

  it("shows nothing on a role with nothing waiting", () => {
    expect(card(role("open"))).toBe("");
  });

  it("says the role was sent back, not that the approval is coming, after 'Send back with a note' on this page", () => {
    // The API still says the role waits for approval until the worker makes it a draft, with the request now rejected.
    const rejected = { id: "ap1", status: "rejected", version: 1, decisionNote: "Raise the ceiling", decidedAt: daysAgo(0), decidedBy: { id: "u1", name: "Dana" } };
    const html = render(client(), createElement(CatchingUpCard, { latest: rejected, sentBackHere: true }));
    expect(text(html)).toContain("Sent back");
    expect(text(html)).toContain("The role goes back to a draft in a few seconds. This page updates on its own; if it does not, reload it.");
    expect(text(html)).not.toContain("Getting the approval ready");
    expect(html).toContain('role="status"');
    // the same answer after "Request approval again" (not sent back from here) is the approval on its way
    expect(text(render(client(), createElement(CatchingUpCard, { latest: rejected, sentBackHere: false })))).toContain("Getting the approval ready");
  });
});

describe("an interview's Link line", () => {
  const interview = (over: Record<string, unknown> = {}) => ({
    id: "iv1", applicationId: "a1", roleId: "r1", roleTitle: "Dental Hygienist", roundKey: "r1", title: "Conversation with the office manager", format: "video", durationMinutes: 30, status: "scheduling", startsAt: null, endsAt: null, timezone: null, meetingUrl: null, linkSource: "calendar", attempt: 1,
    offeredSlots: [], selectedSlot: null, candidateAvailability: null, schedulingWindow: { fromDate: "2026-10-14", toDate: "2026-10-23" }, rescheduleCountCandidate: 0, outcome: null, decision: null, decisionNote: null, reminders: {}, cancelReason: null, scheduleTokenExpiresAt: null, createdAt: daysAgo(1),
    candidate: { firstName: "Maria", lastName: "Reyes", timezone: null, stage: "interview_recommended", stageLabel: "Recommended for interview" }, participants: [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", status: "invited" }], calendarRefs: {}, followUp: null,
    timeline: [], availabilitySources: [{ userId: "u1", source: "declared" as "calendar" | "declared" | "none", calendarStatus: null as string | null }], brief: null,
    ...over,
  });
  // The page's route is /interviews/:id; the mocked params give "r1", so the sheet reads that interview.
  const sheet = (i: ReturnType<typeof interview>) => text(render(client([[["interviews"], [i]], [["interview", "r1"], i]]), createElement(Interviews)));

  it("without a working calendar, says there is no link instead of one 'created with the calendar event'", () => {
    const words = sheet(interview());
    expect(words).toContain("Link none yet: send the candidate the video link yourself");
    expect(words).not.toContain("created with the calendar event");
    expect(noLinkText(interview({ format: "onsite" }))).toBe("none: the invitation says what kind of interview it is");
  });

  it("with an interviewer's working calendar, or an event it booked, says the calendar makes the link", () => {
    expect(sheet(interview({ availabilitySources: [{ userId: "u1", source: "calendar", calendarStatus: "live" }] }))).toContain("Link created with the calendar event");
    expect(noLinkText(interview({ calendarRefs: { u1: { provider: "google", eventId: "e1", htmlLink: null, meetingUrl: null } } }))).toBe("created with the calendar event");
    // a link someone pasted shows as the link itself
    expect(sheet(interview({ linkSource: "pasted", meetingUrl: "https://meet.example.com/abc" }))).toContain("https://meet.example.com/abc");
  });
});

describe("Setup's calendar line", () => {
  const setupCompany = { id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "pilot", status: "active", locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: "2026-10-01T00:00:00.000Z" }, integrations: [], ai: { provider: "fake" } };
  const page = (calendar: unknown) => text(render(client([
    [["company"], setupCompany],
    [["public-profile"], { hiringContact: null, contactShown: { email: "help@its.test", name: null, kind: "its" } }],
    [["me", "calendar"], calendar],
  ]), createElement(Setup)));

  it("offers no Connect button with the development stand-in, and says how interviews are scheduled instead", () => {
    const words = page({ connection: null, availability: null, providers: [{ key: "google", status: "fake" }] });
    expect(words).toContain(CALENDAR_OFF_LINE);
    expect(words).not.toContain("Connect Google Calendar");
    expect(words).not.toContain("not configured for this deployment");
    expect(words).not.toContain("We ask only for events on your calendar");
  });

  it("offers Connect Google Calendar once the real Google provider is set up", () => {
    const words = page({ connection: null, availability: null, providers: [{ key: "google", status: "live" }] });
    expect(words).toContain("Connect Google Calendar");
    expect(words).toContain("We ask only for events on your calendar and free/busy times.");
    expect(words).not.toContain(CALENDAR_OFF_LINE);
  });
});

describe("the interview approval's meeting link", () => {
  const maria = {
    id: "a1", roleId: "r1", stage: "interview_recommended", stageLabel: "Recommended for interview", group: "waiting_on_you", source: "careers_page", createdAt: daysAgo(4), ownerStage: "interviewing", ownerStageLabel: "Interviewing", mark: null, tags: [], stageMoves: [], toldState: null, cancelled: null, score: null,
    eligibility: { passed: true, failedRules: [], unverifiable: [] }, evidence: { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] },
    candidateToldAt: null, rejectReason: null, rejectNote: null, declineMessage: "sends", allowedActions: ["interview", "reject", "record_outcome", "set_mark"], blockedReasons: {}, interviews: [],
    interviewPlan: [{ key: "r1", title: "Conversation with the office manager", durationMinutes: 30, format: "video", interviewerUserIds: ["u1"], purpose: "" }],
    candidate: { firstName: "Maria", lastName: "Reyes", email: "maria@example.com", phone: null, locationText: "Tustin, CA", consent: {}, preferences: {} },
    documents: [], screens: [], communications: [], extraction: null, answers: {}, assessments: [], pendingApprovals: [], packetLabels: { mustHaves: [], competencies: [], questions: [] }, timeline: [],
  };
  const plan = { version: 1, status: "approved", rounds: [{ key: "r1", title: "Conversation with the office manager", purpose: "", durationMinutes: 30, format: "video", interviewerRoles: [], interviewers: [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", role: "owner", schedulable: true }] }], team: [] };
  const step = (calendar: { status: string } | null) => text(render(client([
    [["application", "a1"], maria],
    [["interview-plan", "r1"], plan],
    [["members"], [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", role: "owner", status: "active", schedulable: true, calendar }]],
  ]), createElement(CandidatePanel, { id: "a1", roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step: "interview", onStep: () => undefined, ids: ["a1"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));

  it("without a working calendar, asks for the link instead of promising one the calendar cannot make", () => {
    const words = step(null);
    expect(words).toContain("Approve an interview");
    expect(words).not.toContain("Create it with the calendar event");
    expect(words).toContain("Meeting link (optional)");
    expect(words).toContain("A link is made with the calendar event only for an interviewer who connected their calendar in Settings.");
    expect(words).toContain("This round is a video call. Without a link here, the invitation names the format only, so send Maria the link yourself.");
    // a calendar that needs attention makes no link either
    expect(step({ status: "manual_action_required" })).not.toContain("Create it with the calendar event");
  });

  it("with the interviewer's working calendar, offers the calendar's link first", () => {
    const words = step({ status: "live" });
    expect(words).toContain("Create it with the calendar event");
    expect(words).toContain("I'll paste a link");
    expect(words).not.toContain("Meeting link (optional)");
    expect(words).not.toContain("This round is a video call");
  });
});

describe("the admin console", () => {
  const alert = (id: string, kind: string, title: string, details: Record<string, unknown> = {}) => ({ id, kind, severity: "critical", title, body: "Details.", status: "open", companyId: null, target: null, details, createdAt: daysAgo(0) });
  const failures = (alerts: unknown[]) => render(client([
    [["admin", "failures"], { failedRuns: [], failedJobs: [], failedAi: [], alerts, pendingDeletions: [] }],
    [["admin", "suppressions"], []],
    [["admin", "csp"], { mode: "report-only", reports: [] }],
  ], admin), createElement(Failures));

  it("offers no Acknowledge on a platform-role alert about the signed-in administrator, and says who acknowledges it", () => {
    const html = failures([alert("al1", "platform_role.granted", "Platform role granted", { actorId: "s1" }), alert("al2", "secret.delete_failed", "A credential could not be deleted")]);
    const own = html.slice(html.indexOf("Platform role granted"), html.indexOf("A credential could not be deleted"));
    expect(text(own)).toContain(ACK_FOR_ANOTHER);
    expect(own).not.toContain(">Acknowledge</button>");
    // another alert keeps its button
    expect(html.slice(html.indexOf("A credential could not be deleted"))).toContain("Acknowledge");
  });

  it("shows an error with a way to try again when the Queue or the Business calendar cannot load", () => {
    const queue = render(failed(client([], admin), ["admin", "queue"]), createElement(Queue));
    expect(text(queue)).toContain("Could not load the queue.");
    expect(queue).not.toContain('aria-busy="true"');
    const calendar = render(failed(client([], admin), ["admin", "calendar"]), createElement(CalendarAdmin));
    expect(text(calendar)).toContain("Could not load the business calendar.");
    expect(calendar).not.toContain('aria-busy="true"');
  });

  it("starts a new calendar version on today's date in the administrator's own calendar", () => {
    const dto = { current: { timeZone: "America/Los_Angeles", hours: {}, holidays: [], closures: [], coverageChanges: [] }, version: null, effectiveFrom: null, description: "Monday to Friday, 9 to 5", upcoming: [], versions: [], preview: [] };
    const html = render(client([[["admin", "calendar"], dto]], admin), createElement(CalendarAdmin));
    expect(html).toContain(`<input id="cal-eff" class="input" type="date" value="${dayKey(new Date())}"/>`);
  });
});
