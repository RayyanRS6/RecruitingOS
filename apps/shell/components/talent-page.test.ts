import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The Talent page and the candidate panel (Wave A; founder decisions B3 and B6) as the server first draws them, from
 * answers shaped like the API's: the job's header, the stage strip with its counts, the calm rows, the "waiting on
 * you" view it opens on, the panel's header with the stage button, what needs you, and the steps a stage choice opens.
 */
const nav = vi.hoisted(() => ({ search: "", params: { id: "r1" } as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1/talent",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { People } = await import("@ros/web/src/pages/People");
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");

const STAGES = ["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"] as const;
const LABEL: Record<string, string> = { new: "New", longlist: "Longlist", shortlist: "Shortlist", interviewing: "Interviewing", cancelled: "Cancelled", on_hold: "On hold", offer: "Offer", hired: "Hired", not_moving_forward: "Not moving forward" };
// Nobody is moved to Cancelled by hand: only the candidate's own cancel, or an interview they missed, puts them there.
const ONLY_THE_CANDIDATE = "Only the candidate's own cancellation, or an interview they missed, puts someone here.";
function moves(current: string, blockedHere: Record<string, string> = {}) {
  const via: Record<string, string> = { new: "none", longlist: "set_mark", shortlist: "set_mark", interviewing: "interview", cancelled: "none", on_hold: "set_mark", offer: "offer", hired: "record_hire", not_moving_forward: "decline" };
  const blocked: Record<string, string> = { cancelled: ONLY_THE_CANDIDATE, ...blockedHere };
  return STAGES.map((to) => ({ to, label: LABEL[to], via: to === current ? "none" : via[to], ...(via[to] === "set_mark" ? { mark: to } : {}), allowed: to !== current && !blocked[to], current: to === current, ...(to === current ? { blockedReason: "They are here now." } : blocked[to] ? { blockedReason: blocked[to] } : {}) }));
}
const evidence = { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const maria = {
  id: "a1", stage: "triaged", stageLabel: "Ready for your review", group: "waiting_on_you", source: "careers_page", createdAt: daysAgo(4), eligibility: { passed: true, failedRules: [], unverifiable: [] },
  ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [] as string[], stageMoves: moves("new", { offer: 'Record an offer once they are a finalist (they are at "Ready for your review").' }), toldState: null as string | null,
  candidate: { id: "c1", name: "Maria Reyes", email: "maria@example.com", phone: null, locationText: "Tustin, CA" }, extractionSummary: null,
  assessment: { overall: "strong", confidence: "high", summary: "Active RDH license.", strengths: [], concerns: [] }, evidence,
  appliedAt: daysAgo(4), stageChangedAt: daysAgo(3), daysInStage: 3, candidateToldAt: null, decisionMessageWaiting: false, score: 91 as number | null, cancelled: null,
};
const luis = {
  ...maria, id: "a2", stage: "rejected", stageLabel: "Not moving forward", group: "not_moving_forward", ownerStage: "not_moving_forward", ownerStageLabel: "Not moving forward", stageMoves: moves("not_moving_forward"), toldState: "not_told",
  candidate: { id: "c2", name: "Luis Ortega", email: "luis@example.com", phone: null, locationText: null }, assessment: null, daysInStage: 1, score: null,
};
const counts = { total: 2, byOwnerStage: { new: 1, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 1 }, byGroup: { waiting_on_you: 1, waiting_on_candidate: 0, in_process: 0, not_moving_forward: 1, hired: 0 }, notTold: 1, holdsEnded: 0 };

type Row = { id: string; stage: string; candidate: { name: string; email: string; locationText: string | null }; assessment: unknown; [field: string]: unknown };
function detail(row: Row, over: Record<string, unknown> = {}) {
  const [firstName, lastName] = row.candidate.name.split(" ");
  return {
    ...row, roleId: "r1", candidateToldAt: null, rejectReason: row.stage === "rejected" ? "not_a_match_skills" : null, rejectNote: null, declineMessage: "sends",
    allowedActions: row.stage === "rejected" ? ["send_decision", "told_in_person"] : ["invite_screen", "interview", "advance_to_interview", "hold", "reject", "record_outcome", "set_mark"],
    blockedReasons: {}, interviews: [], interviewPlan: [{ key: "r1", title: "Working interview", durationMinutes: 45, format: "in_person", interviewerUserIds: [], purpose: "" }],
    candidate: { firstName, lastName, email: row.candidate.email, phone: null, locationText: row.candidate.locationText, consent: {}, preferences: {} },
    documents: [], screens: [], communications: [], extraction: null, answers: {},
    assessments: row.assessment ? [{ id: "as1", kind: "triage", overall: "strong", confidence: "high", createdAt: daysAgo(3), result: { summary: "Active RDH license and four years of hygiene work.", strengths: [{ claim: "Licensed", evidence: { source: "resume", quote: "RDH, CA" } }], concerns: [], unknowns: [{ question: "Can they work Saturdays?", whyItMatters: "The schedule includes Saturdays." }], rationale: "Meets the must-haves.", recommendation: "screen", requirementFindings: [{ requirementKey: "mh_1", met: "yes", evidence: { source: "resume", quote: "RDH, CA" } }] } }] : [],
    pendingApprovals: row.stage === "triaged" ? [{ id: "p1", actionType: "application.invite_screen", rationale: "Strong résumé; a screen would confirm Saturdays.", createdAt: daysAgo(1), requiredRoles: ["owner", "admin"] }] : [],
    packetLabels: { mustHaves: [{ key: "mh_1", text: "Active CA RDH license" }], competencies: [], questions: [] },
    timeline: [
      { type: "application.received", occurredAt: daysAgo(4), actor: { kind: "candidate", id: "c" }, payload: {} },
      { type: "application.triaged", occurredAt: daysAgo(3), actor: { kind: "agent", id: "triage-agent" }, payload: { recommendation: "screen" } },
      ...(row.stage === "rejected" ? [{ type: "application.rejected", occurredAt: daysAgo(1), actor: { kind: "user", id: "u1", name: "Dana Whitfield" }, payload: { reason: "not_a_match_skills", byHuman: true, candidateTold: false } }] : []),
    ],
    ...over,
  };
}

function client(details: Array<ReturnType<typeof detail>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
  qc.setQueryData(["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), counts: { total: 2, waiting_on_you: 1, not_moving_forward: 1 }, stageCounts: counts.byOwnerStage, needsYou: 1, daysOpen: 7 }]);
  qc.setQueryData(["applications", "r1"], { applications: [maria, luis], counts });
  for (const d of details) qc.setQueryData(["application", d.id], d);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the Talent page", () => {
  it("heads the page with the job, its status and the count, and opens on the people waiting on you", () => {
    nav.search = "";
    const html = render(client([]), createElement(People));
    expect(html).toContain("Job · Bright Dental");
    expect(html).toMatch(/<h1>Dental Hygienist<\/h1>/);
    expect(text(html)).toContain("Live");
    expect(html).toContain("2 applicants · 1 waiting on you");
    // the strip: every stage with its count, the count a separate word for a screen reader
    expect(html).toContain('role="tablist" aria-label="Stages"');
    expect(html).toContain('<span class="tab-label" data-label="All">All</span> <span class="count">2</span>');
    expect(html).toContain('<span class="tab-label" data-label="Not moving forward">Not moving forward</span> <span class="count">1</span>');
    // waiting on you is on, so only Maria is listed; the decision nobody has told is one click away
    expect(html).toMatch(/<button type="button" class="toggle-chip" aria-pressed="true">Waiting on you/);
    expect(html).toContain('class="talent-name">Maria Reyes</button>');
    expect(html).not.toContain('class="talent-name">Luis Ortega</button>');
    expect(text(html)).toContain("Not told yet 1");
    expect(text(html)).toContain("Waiting on you 3 days");
    expect(text(html)).toContain("Applied 4 days ago");
    expect(text(html)).toContain("Strong match");
    // the stage button on the row, and the match score's badge (founder decision B2)
    expect(html).toContain('aria-label="Stage: New. Move to another stage"');
    expect(html).toMatch(/<span class="score-slot"><span class="score good sm" title="Match score 91 out of 100">/);
    // the list sorts by the score too, and the strip above it offers to sort the pool onto the board
    expect(html).toContain('<option value="score">Score</option>');
    expect(text(html)).toContain("Sort the pool");
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">List<\/button>/);
  });

  it("shows 'No score yet' on a row nothing could be judged for", () => {
    nav.search = "ownerStage=not_moving_forward";
    const html = render(client([]), createElement(People));
    expect(html).toContain('<span class="score-slot"><span class="score none sm">No score yet</span></span>');
  });

  it("says on a row what the score rests on, and when the reading was made against an earlier version of the role", () => {
    nav.search = "";
    const qc = client([]);
    const label = "Read against version 1 of the role; the role is now on version 2.";
    qc.setQueryData(["applications", "r1"], { applications: [{ ...maria, coverage: { known: 3, total: 4, words: "Based on 3 of 4 requirements" }, readingVersion: { readAgainst: 1, current: 2, label } }, luis], counts });
    const html = render(qc, createElement(People));
    expect(html).toContain('<span class="score-slot" title="Based on 3 of 4 requirements"><span class="score good sm"');
    expect(html).toMatch(new RegExp(`<span title="${label.replace(/[.;]/g, "\\$&")}">Read against version (<!-- -->)?1</span>`));
  });

  it("follows a link to the people not told yet, with the way to send them the decision message", () => {
    nav.search = "ownerStage=not_moving_forward&told=not_told";
    const html = render(client([]), createElement(People));
    expect(html).toContain('class="talent-name">Luis Ortega</button>');
    expect(html).not.toContain('class="talent-name">Maria Reyes</button>');
    expect(text(html)).toContain("1 person has not been told your decision.");
    expect(text(html)).toContain("Review and send");
  });

  it("opens the panel from the address: header, stage button, what needs you, and the Overview", () => {
    nav.search = "open=a1";
    const html = render(client([detail(maria)]), createElement(People));
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Maria Reyes"/);
    expect(text(html)).toMatch(/Applied \w{3} \d{1,2}, \d{4} · Dental Hygienist/);
    expect(text(html)).toContain("Email");
    expect(html.match(/aria-label="Stage: New\. Move to another stage"/g)?.length).toBe(2);
    // the list it opened from: one person, so next and previous say so
    expect(text(html)).toContain("1 of 1");
    // the assistant's suggestion, with Yes and Not now
    expect(text(html)).toContain("The assistant suggests a screen");
    expect(text(html)).toContain("Yes, invite to a screen");
    expect(text(html)).toContain("Not now");
    // sections, the Overview's latest reading and recent activity, who did what
    expect(html).toContain('aria-label="Candidate sections"');
    expect(text(html)).toContain("Latest reading: the résumé");
    expect(text(html)).toContain("Active CA RDH license");
    expect(text(html)).toContain("Recent activity");
    expect(text(html)).toContain("Assessed the résumé: Worth a screen");
    expect(text(html)).toContain("The assistant");
    expect(text(html)).not.toContain("triage-agent");
  });

  it("keeps Previous and Next in place while the next person loads, so the button pressed keeps the focus", () => {
    // a2 is not loaded yet (nothing is fetched ahead for the neighbours)
    const html = render(client([detail(maria)]), createElement(CandidatePanel, { id: "a2", roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step: null, onStep: () => undefined, ids: ["a1", "a2"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Candidate"/);
    expect(html).toContain('aria-label="Previous candidate (Alt+Up)"');
    expect(html).toContain('aria-label="Next candidate (Alt+Down)"');
    expect(text(html)).toContain("2 of 2");
    // the person's own controls wait for them
    expect(html).not.toContain("Stage:");
    // one live region stays mounted, empty until someone has moved and the next person has loaded
    expect(html).toContain('<span class="sr-only" aria-live="polite"></span>');
    expect(html.match(/aria-live="polite"/g)?.length).toBe(1);
  });

  it("says a decision nobody has told yet is private, with Send message and I told them myself", () => {
    nav.search = "open=a2";
    const html = render(client([detail(luis)]), createElement(People));
    expect(html).toContain('aria-label="Stage: Not moving forward. Move to another stage"');
    expect(text(html)).toContain("Luis has not been told yet");
    expect(text(html)).toContain("Your decision is private: nothing has been sent to Luis.");
    expect(text(html)).toContain("Send message");
    expect(text(html)).toContain("I told them myself");
    expect(text(html)).toContain("Private: the candidate was not told.");
  });
});

describe("the steps a stage choice opens", () => {
  const panel = (step: "hold" | "decline" | "interview" | "hire", d = detail(maria)) =>
    render(client([d]), createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step, onStep: () => undefined, ids: ["a1", "a2"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));

  it("On hold asks for the day they come back, inside eight weeks", () => {
    const html = panel("hold");
    expect(text(html)).toContain("Put on hold");
    expect(html).toMatch(/<input id="hold-until" class="input" type="date" min="\d{4}-\d{2}-\d{2}" max="\d{4}-\d{2}-\d{2}" value="\d{4}-\d{2}-\d{2}"\/>/);
    expect(text(html)).toContain("Private: nothing is sent to the candidate.");
    expect(text(html)).toContain("1 of 2");
  });

  it("Not moving forward is private, names a booked interview the candidate is told now is off, and offers the fixed reasons", () => {
    const html = panel("decline", detail(maria, { interviews: [{ id: "iv1", roundKey: "r1", title: "Working interview", status: "scheduled", startsAt: "2026-10-14T18:00:00.000Z", endsAt: null, timezone: "America/Los_Angeles", meetingUrl: null, attempt: 1, outcome: null, decision: null, offeredSlots: [], createdAt: daysAgo(2) }] }));
    expect(text(html)).toContain("It is private: the decision itself is only sent to the candidate when you choose to send it.");
    expect(text(html)).toMatch(/This cancels the Working interview on Wednesday, October 14(,| at) 11:00\sAM, and the candidate is told now, in a short note that gives no reason, that it is off\./);
    expect(html).toContain('<option value="candidate_unresponsive">They stopped responding</option>');
    expect(text(html)).toContain("Confirm: not moving forward");
  });

  it("someone already at the interview step, with nothing in motion, can still have an interview approved", () => {
    const iv = (over: Record<string, unknown>) => ({ id: "iv1", roundKey: "r1", title: "Working interview", status: "cancelled", startsAt: null, endsAt: null, timezone: null, meetingUrl: null, attempt: 1, outcome: null, decision: null, offeredSlots: [], createdAt: daysAgo(2), ...over });
    const at = (stage: string, interviews: unknown[], over: Record<string, unknown> = {}) => detail({ ...maria, stage }, { interviews, ...over });
    const open = (d: ReturnType<typeof detail>, step: "interview" | null = null) => text(render(client([d]), createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step, onStep: () => undefined, ids: ["a1"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));
    // an interview cancelled from the Interviews page
    const cancelled = open(at("interview_recommended", [iv({})]));
    expect(cancelled).toContain("The interview was cancelled");
    expect(cancelled).toContain("The Working interview with Maria was cancelled. Approve a new interview and fresh times go out to them.");
    expect(cancelled).toContain("Approve an interview");
    // times the candidate let expire
    expect(open(at("interview_recommended", [iv({ status: "offer_expired" })]))).toContain("Maria did not pick a time for the Working interview.");
    // "Next round" recorded, with the round still to approve
    const next = open(at("interview_complete", [iv({ status: "completed", outcome: "happened", decision: "next_round" })]));
    expect(next).toContain("Set up the next round");
    expect(next).toContain("Approve the next round");
    // recommended after a screen (no suggestion card when the company's settings let that through on its own)
    expect(open(at("interview_recommended", []))).toContain("Maria is ready to interview.");
    // the approval itself replaces the card while it is open
    const step = open(at("interview_recommended", [iv({})]), "interview");
    expect(step).toContain("Approve and offer times");
    expect(step).not.toContain("The interview was cancelled");
  });

  it("does not offer a new interview while a decision waits, one is in motion, or the role may not request one", () => {
    const iv = { id: "iv1", roundKey: "r1", title: "Working interview", status: "completed", startsAt: null, endsAt: null, timezone: null, meetingUrl: null, attempt: 1, outcome: "happened", decision: null, offeredSlots: [], createdAt: daysAgo(2) };
    const open = (d: ReturnType<typeof detail>) => text(render(client([d]), createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step: null, onStep: () => undefined, ids: ["a1"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));
    // a finished interview nobody has decided about: the decision card, not a new interview
    const deciding = open(detail({ ...maria, stage: "interview_complete" }, { interviews: [iv], allowedActions: ["interview", "record_decision", "reject", "record_outcome", "set_mark"] }));
    expect(deciding).toContain("How did the interview go?");
    expect(deciding).not.toContain("Approve an interview");
    // the role cannot request interviews (the API leaves "interview" out)
    expect(open(detail({ ...maria, stage: "interview_recommended" }, { interviews: [], allowedActions: ["reject", "record_outcome"] }))).not.toContain("Ready to interview");
    // on hold: nothing waits on anyone until the date
    expect(open(detail({ ...maria, stage: "interview_recommended" }, { interviews: [], mark: { id: "m1", mark: "on_hold", label: "On hold", remindAt: "2026-12-01", note: null, source: "person", setAt: daysAgo(1), setBy: { kind: "user", id: "u1" } } }))).not.toContain("Ready to interview");
  });

  it("Interviewing opens the interview approval, and Hired the one-sheet hire (plan H1)", () => {
    expect(text(panel("interview"))).toContain("Approve an interview");
    const hire = text(panel("hire"));
    expect(hire).toContain("Hire Maria Reyes");
    expect(hire).toContain("Start date (agreed with them)");
    expect(hire).toContain("The day they accepted the offer (optional)");
    expect(hire).toContain("the platform never makes or sends an offer");
  });
});

describe("the Cancelled column (founder decisions 1A to 4A)", () => {
  // React writes an apostrophe as an entity; the reader sees the character.
  const plain = (html: string) => text(html).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const view = (over: Record<string, unknown> = {}) => ({
    id: "f1", reason: "asked_new_times", label: "Asked for new times", since: daysAgo(1), interviewId: "iv1", times: "none", lastSentAt: null, lastSentVia: null, status: "New times go out automatically Thu, Oct 15",
    auto: { state: "waiting", reason: null, reasonText: null, dueAt: "2026-10-15T16:00:00.000Z", dueDay: "2026-10-15", sentAt: null },
    ...over,
  });
  const ana = {
    ...maria, id: "a3", stage: "interview_recommended", stageLabel: "Recommended for interview", group: "in_process", ownerStage: "cancelled", ownerStageLabel: "Asked for new times", stageMoves: moves("cancelled"), score: 70,
    candidate: { id: "c3", name: "Ana Lopez", email: "ana@example.com", phone: null, locationText: null }, cancelled: view(),
  };
  const cleo = {
    ...maria, id: "a4", stage: "interview_complete", stageLabel: "Interview done: decision needed", group: "waiting_on_you", ownerStage: "cancelled", ownerStageLabel: "No-show", stageMoves: moves("cancelled"), score: 64,
    candidate: { id: "c4", name: "Cleo Park", email: "cleo@example.com", phone: null, locationText: null },
    cancelled: view({ id: "f2", reason: "no_show", label: "No-show", status: "Waiting for you", auto: { state: "none", reason: "no_show", reasonText: null, dueAt: null, dueDay: null, sentAt: null } }),
  };
  const columnCounts = { ...counts, total: 4, byOwnerStage: { ...counts.byOwnerStage, cancelled: 2 }, byGroup: { ...counts.byGroup, waiting_on_you: 2, in_process: 1 }, cancelled: { askedNewTimes: 1, notInterested: 0, noShow: 1 } };
  const withColumn = (auto: boolean | null, details: Array<ReturnType<typeof detail>> = []) => {
    const qc = client(details);
    qc.setQueryData(["applications", "r1"], { applications: [maria, luis, ana, cleo], counts: columnCounts });
    if (auto !== null) qc.setQueryData(["new-times-setting"], { auto, workingDays: 3, pending: 1, companyConfirmed: true });
    return qc;
  };
  const iv = (over: Record<string, unknown> = {}) => ({ id: "iv1", roundKey: "r1", title: "Working interview", status: "cancelled", startsAt: null, endsAt: null, timezone: null, meetingUrl: null, attempt: 2, outcome: null, decision: null, offeredSlots: [], createdAt: daysAgo(3), ...over });
  const open = (d: ReturnType<typeof detail>, step: "hold" | null = null) => plain(render(client([d]), createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step, onStep: () => undefined, ids: [d.id], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));

  it("sits right after Interviewing on the strip, split by what each person chose, each row saying where their new times stand", () => {
    nav.search = "ownerStage=cancelled";
    const html = render(withColumn(true), createElement(People));
    expect(html).toContain('<span class="tab-label" data-label="Interviewing">Interviewing</span> <span class="count">0</span>');
    expect(html.indexOf('data-label="Interviewing">Interviewing</span>')).toBeGreaterThan(-1);
    expect(html.indexOf('data-label="Interviewing">Interviewing</span>')).toBeLessThan(html.indexOf('data-label="Cancelled">Cancelled</span>'));
    expect(html).toContain('<span class="tab-label" data-label="Cancelled">Cancelled</span> <span class="count">2</span>');
    expect(html).toMatch(/<button type="button" class="toggle-chip" aria-pressed="false">Asked for new times <span class="count">1<\/span><\/button>/);
    expect(plain(html)).toContain("No longer interested 0");
    expect(plain(html)).toContain("No-show 1");
    expect(html).toContain('class="talent-name">Ana Lopez</button>');
    expect(html).toContain('class="talent-name">Cleo Park</button>');
    expect(html).not.toContain('class="talent-name">Maria Reyes</button>');
    // the row: where the new times stand, and the stage button's sub-label
    expect(plain(html)).toContain("New times go out automatically Thu, Oct 15");
    expect(plain(html)).toContain("Waiting for you");
    expect(html).toContain('aria-label="Stage: No-show. Move to another stage"');
    expect(html).toContain('aria-label="Stage: Asked for new times. Move to another stage"');
    // the alert follows the company's setting, with the way to send new times to many people
    expect(plain(html)).toContain("2 people are under Cancelled. Only people who asked for new times get one set automatically; everyone else waits for you.");
    expect(plain(html)).toContain("Send new times…");
  });

  it("says everyone waits for the team when automatic times are off, and opens on one reason from a link", () => {
    nav.search = "ownerStage=cancelled&cancelled=no_show";
    const html = render(withColumn(false), createElement(People));
    expect(plain(html)).toContain("2 people are under Cancelled. Automatic new times are off, so everyone here waits for you.");
    expect(html).toMatch(/<button type="button" class="toggle-chip" aria-pressed="true">No-show <span class="count">1<\/span><\/button>/);
    expect(html).toContain('class="talent-name">Cleo Park</button>');
    expect(html).not.toContain('class="talent-name">Ana Lopez</button>');
  });

  it("never offers the batch to someone who may not manage interviews", () => {
    nav.search = "ownerStage=cancelled";
    const qc = withColumn(true);
    qc.setQueryData(["me"], { user: { id: "u2", email: "hr@bright.test", name: "Hana Ruiz", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "hr" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
    const html = plain(render(qc, createElement(People)));
    expect(html).toContain("Cleo Park");
    expect(html).not.toContain("Send new times…");
  });

  it("the panel's card says the promised day, with Send new times and Don't send automatically; no second card offers an interview", () => {
    const panel = open(detail(ana, { interviews: [iv()], allowedActions: ["interview", "reject", "record_outcome", "set_mark", "send_new_times", "stop_new_times"] }));
    expect(panel).toContain("Ana cancelled and asked for new times");
    expect(panel).toContain("New times go to them automatically on Thursday, October 15, as your settings say. Send them now instead, or stop the automatic set.");
    expect(panel).toContain("Send new times");
    expect(panel).toContain("Don't send automatically");
    expect(panel).not.toContain("The interview was cancelled");
    expect(panel).not.toContain("Approve an interview");
    // without the API's leave, the buttons are not offered
    const quiet = open(detail(ana, { interviews: [iv()], allowedActions: ["interview", "reject"] }));
    expect(quiet).toContain("Ana cancelled and asked for new times");
    expect(quiet).not.toContain("Send new times");
  });

  it("a no-show: new times for the same round or a decision below, and never 'Next round' from the decision card", () => {
    const plan = [{ key: "r1", title: "Working interview", durationMinutes: 45, format: "in_person", interviewerUserIds: [], purpose: "" }, { key: "r2", title: "Meet the dentist", durationMinutes: 30, format: "in_person", interviewerUserIds: [], purpose: "" }];
    const panel = open(detail(cleo, { interviews: [iv({ status: "no_show", outcome: "no_show_candidate", attempt: 1 })], interviewPlan: plan, allowedActions: ["interview", "record_decision", "reject", "record_outcome", "set_mark", "send_new_times"] }));
    expect(panel).toContain("Cleo did not come to the interview");
    expect(panel).toContain("The working interview was booked and they did not come. Nothing goes to them automatically. Send new times for the same round, or decide below.");
    expect(panel.indexOf("Cleo did not come to the interview")).toBeLessThan(panel.indexOf("How did the interview go?"));
    expect(panel).toContain("(the candidate did not attend)");
    expect(panel).not.toContain("Next round");
    expect(panel).toContain("Finalist");
    // back under Cancelled after a decision was taken back, the missed interview already decided: no decision card, so
    // the card points to the stage at the top instead of "below"
    const decided = open(detail(cleo, { interviews: [iv({ status: "no_show", outcome: "no_show_candidate", attempt: 1, decision: "not_moving_forward" })], interviewPlan: plan, allowedActions: ["interview", "reject", "record_outcome", "set_mark", "send_new_times"] }));
    expect(decided).toContain("Send new times for the same round, or choose their next stage at the top.");
    expect(decided).not.toContain("decide below");
    expect(decided).not.toContain("How did the interview go?");
  });

  it("before ITS confirms the company, the alert and the card promise nothing automatic and offer no send until it does", () => {
    nav.search = "ownerStage=cancelled";
    const qc = withColumn(true);
    qc.setQueryData(["new-times-setting"], { auto: true, workingDays: 3, pending: 0, companyConfirmed: false });
    const html = plain(render(qc, createElement(People)));
    expect(html).toContain("2 people are under Cancelled. Nothing goes to anyone here automatically until ITS confirms your company. You can send new times after that.");
    expect(html).not.toContain("Send new times…");
    const notChecked = view({ status: "Waiting for you", auto: { state: "none", reason: "company_not_checked", reasonText: "ITS had not confirmed your company in time, so nothing was sent automatically.", dueAt: null, dueDay: null, sentAt: null } });
    const d = detail({ ...ana, cancelled: notChecked }, { interviews: [iv()], allowedActions: ["interview", "reject", "record_outcome", "set_mark", "send_new_times"] });
    const cards = client([d]);
    cards.setQueryData(["new-times-setting"], { auto: true, workingDays: 3, pending: 0, companyConfirmed: false });
    const panel = plain(render(cards, createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab: "overview", onTab: () => undefined, step: null, onStep: () => undefined, ids: [d.id], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));
    expect(panel).toContain("ITS had not confirmed your company in time, so nothing was sent automatically. You can send new times once ITS confirms your company, or decide.");
    // the API refuses a send until then, so the card offers none
    expect(panel).not.toContain("Send new times");
  });

  it("putting someone under Cancelled on hold says it takes them out of it", () => {
    expect(open(detail(ana, { interviews: [iv()] }), "hold")).toContain("Putting them on hold takes them out of Cancelled; nothing is sent to them automatically.");
    expect(open(detail(maria), "hold")).not.toContain("takes them out of Cancelled");
  });
});
