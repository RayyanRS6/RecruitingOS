import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Applying and the screening conversation in one visit (plan Wave E) as the signed-in app first draws it, from answers
 * shaped like the API's: "Still applying" beside the stage strip and never as waiting on you (E6); the candidate panel's
 * "Applied and talked in one visit", questions the candidate chose not to answer, answers changed before sending and a
 * recruiter's call notes kept apart (E3, E10, E11); the call-notes form for a recruiter when the candidate asked for a
 * person (E3); the role report's conversation figures (E13); the ITS-only switch for a role and a company (E1); and the
 * 80% allowance card on Today and in the ITS console (Q17).
 */
const nav = vi.hoisted(() => ({ search: "", params: { id: "r1" } as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1/talent",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
// The pages as the browser shows them once they are its own: Candidates reads the job's status (its Live pill) from the
// rail's jobs list, which the first draw leaves out on both sides (first-draw.test.ts).
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { People } = await import("@ros/web/src/pages/People");
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");
const { ScreeningCard } = await import("@ros/web/src/pages/RoleReport");
const { RoleApplyMode } = await import("@ros/web/src/components/ApplyMode");
const { Home } = await import("@ros/web/src/pages/Home");
const { CustomersSection } = await import("@ros/web/src/pages/admin/customers");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const STAGES = ["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"] as const;
// nobody is moved to Cancelled by hand (founder decision 1A)
const moves = STAGES.map((to) => ({ to, label: to, via: to === "new" || to === "cancelled" ? "none" : "set_mark", allowed: to !== "new" && to !== "cancelled", current: to === "new" }));
const evidence = { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] };
const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, stage: "triaged", stageLabel: "Ready for your review", group: "waiting_on_you", source: "careers_page", createdAt: daysAgo(2), eligibility: { passed: true, failedRules: [], unverifiable: [] },
  ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [], stageMoves: moves, toldState: null,
  candidate: { id: `c-${id}`, name, email: `${id}@example.com`, phone: null, locationText: null }, extractionSummary: null, assessment: null, evidence,
  appliedAt: daysAgo(2), stageChangedAt: daysAgo(2), daysInStage: 2, candidateToldAt: null, decisionMessageWaiting: false, stillApplying: false, ...over,
});
const maria = row("a1", "Maria Reyes");
const ai = (state: "invited" | "started", label: string) => ({ state, group: state === "invited" ? "not_started" : "started", label, since: daysAgo(0), linkOpenUntil: null, lastEmailAt: daysAgo(0), canRemind: false, canResend: false });
const sofia = row("a2", "Sofia Lind", { stage: "screen_invited", stageLabel: "Invited to the AI interview", ownerStage: "no_ai_interview", ownerStageLabel: "Invited (not started)", group: "in_process", stillApplying: true, daysInStage: 0, aiInterview: ai("invited", "Invited (not started)") });
// Theo's hold ended while he was still answering: the API says "waiting on you"; the page never does while he is in the column
const theo = row("a3", "Theo Park", { stage: "screening", stageLabel: "In the AI interview", ownerStage: "no_ai_interview", ownerStageLabel: "Started (not finished)", group: "waiting_on_you", stillApplying: true, aiInterview: ai("started", "Started (not finished)") });
const counts = { total: 3, byOwnerStage: { no_ai_interview: 2, new: 1, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0 }, byGroup: { waiting_on_you: 2, in_process: 1, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0, stillApplying: 2, aiInterview: { not_started: 1, started: 1, asked_person: 0, closed: 0 } };

const owner = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } };
const itsRecruiter = { user: { id: "s1", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" }, auth: { provider: "azure", aal: "aal2", mfaVerifiedAt: daysAgo(0) }, memberships: [], activeCompanyId: "co1", staffAccess: { grantId: "g1", kind: "escalation", purpose: "candidate asked for a person", expiresAt: daysAgo(-1), companyName: "Bright Dental", scope: { escalationId: "e1", roleId: "r1", applicationId: "a2" } }, ai: { provider: "fake" } };

function client(me: unknown = owner) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  qc.setQueryData(["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), counts: { total: 3 }, needsYou: 1, daysOpen: 7 }]);
  qc.setQueryData(["applications", "r1"], { applications: [maria, sofia, theo], counts });
  qc.setQueryData(["company"], { settings: { verifiedAt: daysAgo(30) }, planKey: "starter", usage: { text_screens: { used: 122, limit: 150 }, active_roles: { used: 1, limit: 3 } } });
  return qc;
}

describe("No AI interview yet, the strip's first column (20 Oct 2026, R20-7; it replaced plan E6's 'Still applying' toggle)", () => {
  it("counts them in their own column and in the header, never as waiting on you, with no 'Still applying' toggle", () => {
    nav.search = "";
    const html = render(client(), createElement(People));
    expect(html).toContain("3 applicants · 1 waiting on you · 2 without an AI interview yet");
    expect(html).toMatch(/<div class="talent-strip"><div role="tablist" aria-label="Stages"/);
    expect(html).toContain('<span class="tab-label" data-label="No AI interview yet">No AI interview yet</span> <span class="count">2</span>');
    expect(html).toContain('<span class="tab-label" data-label="New">New</span> <span class="count">1</span>');
    expect(text(html)).not.toContain("Still applying");
    // the page opens on "waiting on you": Maria only; never Theo, whose group says so
    expect(text(html)).toContain("Waiting on you 1");
    expect(html).toContain('class="talent-name">Maria Reyes</button>');
    expect(html).not.toContain('class="talent-name">Theo Park</button>');
  });

  it("shows the column with its chips and one calm line, each row saying where they stand (also from an older 'still applying' link)", () => {
    for (const search of ["ownerStage=no_ai_interview", "applying=1"]) {
      nav.search = search;
      const html = render(client(), createElement(People));
      const words = text(html);
      expect(html).toContain('class="talent-name">Sofia Lind</button>');
      expect(html).toContain('class="talent-name">Theo Park</button>');
      expect(html).not.toContain('class="talent-name">Maria Reyes</button>');
      expect(words).toContain("Not started 1");
      expect(words).toContain("Started 1");
      expect(words).toContain("Link closed 0");
      expect(words).toContain("1 not started · 1 started. Everyone who applies gets the AI interview by email and moves to New once they send it. Nothing here waits on you");
      expect(html).toMatch(/<span class="pill neutral sm" title="Invited \(not started\)"><span class="dot" aria-hidden="true"><\/span>Invited /);
      expect(html).toContain('<span class="pill neutral sm" title="Started (not finished)"><span class="dot" aria-hidden="true"></span>Started (not finished)</span>');
      expect(words).not.toContain("Waiting on you 2 days");
    }
  });

  it("filters the column by a chip from a link (Home's line)", () => {
    nav.search = "ownerStage=no_ai_interview&aiInterview=started";
    const html = render(client(), createElement(People));
    expect(html).toContain('class="talent-name">Theo Park</button>');
    expect(html).not.toContain('class="talent-name">Sofia Lind</button>');
    expect(html).toMatch(/class="toggle-chip" aria-pressed="true">Started <span class="count">1<\/span>/);
  });
});
const at = daysAgo(1);
const screenBase = { id: "s1", channel: "web", invitedAt: at, startedAt: at, remindedAt: null, assessmentId: null, scorecard: "writing", recruiterAsked: false };
function detail(over: Record<string, unknown> = {}) {
  return {
    ...sofia, roleId: "r1", stage: "screen_complete", ownerStage: "new", ownerStageLabel: "New", aiInterview: null, candidateToldAt: null, rejectReason: null, rejectNote: null, declineMessage: "sends",
    allowedActions: ["interview", "hold", "reject", "set_mark"], blockedReasons: {}, interviews: [], interviewPlan: [],
    candidate: { firstName: "Sofia", lastName: "Lind", email: "a2@example.com", phone: null, locationText: null, consent: {}, preferences: {} },
    documents: [], communications: [], extraction: null, answers: {}, assessments: [], pendingApprovals: [],
    packetLabels: { mustHaves: [], competencies: [], questions: [{ key: "q_sat", question: "Can you work Saturdays?" }, { key: "q_pay", question: "What pay are you looking for?" }, { key: "q_start", question: "When could you start?" }] },
    timeline: [{ type: "screen.invited", occurredAt: at, actor: { kind: "system", id: "apply_page" }, payload: { invitedBy: "apply", invitedVia: "apply" } }],
    screens: [{
      ...screenBase, status: "completed", completedAt: at, invitedVia: "apply",
      answers: { q_sat: "Yes", q_start: "I can start on Monday, November 2, 2026." },
      progress: { askedKeys: ["q_sat", "q_pay", "q_start"], currentQuestionKey: null, flow: "one_visit", declined: ["q_pay"], edits: { q_start: 1 }, submittedAt: at },
      transcript: [
        { role: "assistant", content: "Can you work Saturdays?", at, questionKey: "q_sat" },
        { role: "candidate", content: "Yes", at, questionKey: "q_sat", source: "tap" },
        { role: "system", content: "Skipped this question.", at, questionKey: "q_pay", source: "skip" },
        { role: "candidate", content: "I can start on Monday, November 2, 2026.", at, questionKey: "q_start", source: "edit" },
      ],
    }],
    ...over,
  };
}
const panel = (qc: QueryClient, d: ReturnType<typeof detail>, tab: "overview" | "screen") => {
  qc.setQueryData(["application", d.id], d);
  return render(qc, createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab, onTab: () => undefined, step: null, onStep: () => undefined, ids: null, onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));
};

describe("the candidate panel (plan E3, E10, E11)", () => {
  it("says 'Applied and talked in one visit' on the Overview and the Screen tab", () => {
    expect(text(panel(client(), detail(), "overview"))).toContain("Applied and talked in one visit: the AI interview was answered after the form.");
    expect(panel(client(), detail(), "screen")).toContain('<span class="chip good">Applied and talked in one visit</span>');
  });

  it("shows a skipped question as 'Chose not to answer', marks a changed answer, and labels the transcript", () => {
    const html = panel(client(), detail(), "screen");
    const words = text(html);
    expect(words).toContain("2 answered, 1 not answered by choice");
    expect(words).toContain('"Chose not to answer" is never held against them');
    expect(html).toContain("<dt>What pay are you looking for?</dt><dd style=\"white-space:pre-wrap\"><span class=\"muted\"><em>Chose not to answer</em></span></dd>");
    expect(html).toMatch(/I can start on Monday, November 2, 2026\. <span class="chip neutral">Changed before sending<\/span>/);
    expect(words).toContain("Yes (picked from the choices)");
    expect(html).toContain('<div class="bubble system" style="white-space:pre-wrap">Chose not to answer this question.</div>');
    expect(html).toContain('<span class="bubble-label">Changed on the check-your-answers page</span>');
  });

  it("labels a recruiter's call notes as theirs, never as the candidate's words", () => {
    const d = detail({ screens: [{ ...detail().screens[0], transcript: [...detail().screens[0].transcript, { role: "recruiter", content: "Prefers Saturday mornings.", at, questionKey: "q_sat", source: "recruiter_call", by: "Rae Recruiter" }] }] });
    const html = panel(client(), d, "screen");
    expect(html).toContain("Finished on a call with a recruiter");
    expect(html.match(/<span class="bubble-label">Notes from a call by Rae Recruiter\. Not the candidate&#x27;s own words\.<\/span>/g)?.length).toBe(2);
    expect(html).toContain('class="bubble recruiter"');
  });

  it("asks a recruiter for the notes from their call when the candidate chose a person, and never an owner", () => {
    const asked = detail({ stage: "screen_invited", screens: [{ ...screenBase, status: "human_requested", completedAt: null, invitedVia: "apply", answers: {}, progress: { askedKeys: ["q_sat"], currentQuestionKey: "q_sat" }, transcript: [] }] });
    const recruiter = panel(client(itsRecruiter), asked, "overview");
    expect(text(recruiter)).toContain("Sofia asked to talk to a person");
    expect(text(recruiter)).toContain("never shown or quoted as Sofia's own words");
    expect(recruiter).toContain('<label for="call-note-q_sat">Can you work Saturdays?</label>');
    expect(recruiter).toContain('id="call-note-other"');
    expect(recruiter).toMatch(/<input type="checkbox" checked=""\/>Finish the AI interview with these notes/);
    expect(text(recruiter)).toContain("Add the notes");
    const ownerView = panel(client(), asked, "overview");
    expect(text(ownerView)).not.toContain("asked to talk to a person");
    expect(ownerView).not.toContain("call-note-q_sat");
    expect(text(ownerView)).toContain("Asked to talk to a person instead of the assistant. A recruiter contacts them and adds notes from the call.");
  });
});

describe("the role report and the ITS controls", () => {
  it("shows how the conversation goes for the role (plan E13), counts only", () => {
    const qc = client();
    qc.setQueryData(["role", "r1", "screening"], { offered: 10, started: 8, finished: 6, unfinished: 1, stillApplying: 2, medianMinutes: 6.4, personChosen: { contactMe: 1, sendWithout: 1 }, skipped: [{ key: "q_pay", question: "What pay are you looking for?", count: 3 }] });
    const words = text(render(qc, createElement(ScreeningCard, { roleId: "r1" })));
    expect(words).toContain("The AI interview");
    expect(words).toContain("Started it 8 of 10 (80%)");
    expect(words).toContain("Typical time to finish about 6 minutes");
    // never where anyone stopped: a conversation that stopped was never sent (founder decision of 9 October 2026)
    expect(words).not.toContain("Most people who stopped");
    expect(words).toContain("Chose a person instead 2: 1 asked to be contacted, 1 sent their application without it");
    expect(words).toContain("What pay are you looking for? 3");
    expect(render(qc, createElement(ScreeningCard, { roleId: "r1" }))).toContain('href="/roles/r1/talent?ownerStage=no_ai_interview"');
  });

  it("lets ITS switch a role between one visit and the later path, with the company's default named", () => {
    const qc = client(itsRecruiter);
    qc.setQueryData(["role", "r1", "apply-mode"], { roleId: "r1", applyMode: null, companyDefault: "one_visit", effective: "one_visit" });
    const html = render(qc, createElement(RoleApplyMode, { roleId: "r1", roleTitle: "Dental Hygienist" }));
    expect(text(html)).toContain("How people apply (ITS only)");
    expect(text(html)).toContain("Now: Apply and talk in one visit, the company's default .");
    expect(html).toContain("<option value=\"default\" selected=\"\">The company&#x27;s default (apply and talk in one visit)</option>");
    expect(html).toContain("<option value=\"form_then_screen\">Form now, conversation later</option>");
    expect(text(html)).toContain("always uses the later path");
  });

  it("warns an owner on Today at 80% of the month's screening conversations, with a way to ask ITS", () => {
    nav.search = "";
    const words = text(render(client(), createElement(Home)));
    expect(words).toContain("122 of this month's 150 AI interviews used");
    expect(words).toContain("80% used");
    expect(words).toContain("Nothing has stopped.");
    expect(words).toContain("Ask ITS about adding more");
    // nobody else sees it
    const hm = { ...owner, memberships: [{ ...owner.memberships[0], role: "hiring_manager" }] };
    expect(text(render(client(hm), createElement(Home)))).not.toContain("AI interviews used");
  });

  it("shows ITS who is running low, and that every company's people apply the same way", () => {
    const qc = client({ ...itsRecruiter, user: { ...itsRecruiter.user, platformRole: "platform_admin" }, staffAccess: null });
    qc.setQueryData(["admin", "customers"], [{ id: "co1", name: "Bright Dental", slug: "bright", vertical: "dental", sizeBand: "20-49", planKey: "starter", status: "active", roles: 1, applications: 3, aiCostUsd: 0, lastActivityAt: daysAgo(0), escalations: 0, createdAt: daysAgo(30), settings: {}, verifiedAt: daysAgo(29), verifiedBy: null, heldMessages: 0, jobBoardsConfirmedAt: null, applyFlowDefault: "form_then_screen", screeningConversations: { used: 122, limit: 150 } }]);
    qc.setQueryData(["admin", "alerts"], [{ id: "al1", kind: "billing.screens_warning", severity: "info", title: "", body: "", status: "open", companyId: "co1", target: null, details: { used: 122, limit: 150 }, createdAt: daysAgo(1) }]);
    // the Customers section under its "Running low" pill, with the company's drawer open on its Overview (Wave S6)
    nav.search = "show=low&open=co1";
    const words = text(render(qc, createElement(CustomersSection, { view: null, onView: () => undefined })));
    nav.search = "";
    expect(words).toContain("AI interviews running low");
    expect(words).toContain("Bright Dental : 80% of AI interviews used (122 of 150), since");
    // and on the drawer's Overview, beside its plan and this month's chats
    expect(words).toContain("Starter · Active Change plan 122 of 150 AI interviews this month 80% of AI interviews used (122 of 150)");
    // how the company's people apply: the same for everyone since 20 Oct 2026 (R20-12), whatever the old switch says
    expect(words).toContain("How people apply The same for everyone: the form, then the AI interview");
  });
});
