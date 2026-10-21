import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The answers to the company's questions on the candidate panel (Wave S7, slice S7-H), as the signed-in app first draws
 * them from an answer shaped like the API's: on the Screening chat tab, each company question with the answer written
 * up from the candidate's replies and where its words come from, the assistant's note in its own labelled box (never
 * inside the answer), a recruiter's call notes kept apart, and that question's part of the chat one click away; the
 * must-haves the résumé did not show with where the chat left them; and one line about it on the Overview. Nothing of
 * it shows while the answers are hidden (founder decision of 9 October 2026).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1/talent",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const at = new Date(Date.now() - 86_400_000).toISOString();

const owner = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } };
const STAGES = ["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"] as const;
const moves = STAGES.map((to) => ({ to, label: to, via: to === "new" || to === "cancelled" ? "none" : "set_mark", allowed: to !== "new" && to !== "cancelled", current: to === "new" }));
const evidence = { needsCloserLook: false, reason: null, assessmentUnavailable: false, resumeUnreadable: false, unknowns: [], unknownCount: 0, topStrength: null, topConcern: null, confidenceReasons: [] };

const NOTE = "No example of charting work was given.";
const DRAFT = "I calmed a scared boy by letting him hold the mirror and counting down with him.";
const screen = {
  id: "s1", channel: "web", status: "completed", invitedAt: at, startedAt: at, completedAt: at, remindedAt: null, invitedVia: "apply", assessmentId: null, scorecard: "writing", recruiterAsked: false, answersShared: true,
  answers: { wq_patient: "A boy was scared of the scaler, so I let him hold the mirror and counted down with him.", wq_tools: "I have not used any charting software yet.", q_start: "Monday" },
  transcript: [
    { role: "assistant", content: "Tell me about a time you calmed a nervous patient.", at, questionKey: "wq_patient" },
    { role: "candidate", content: "A boy was scared of the scaler, so I let him hold the mirror and counted down with him.", at, questionKey: "wq_patient" },
    { role: "recruiter", content: "Said the same on the phone.", at, questionKey: "wq_patient", source: "recruiter_call", by: "Rae Recruiter" },
    { role: "system", content: "Skipped this question.", at, questionKey: "wq_why", source: "skip" },
    { role: "assistant", content: "Which charting software have you used?", at, questionKey: "wq_tools" },
    { role: "candidate", content: "I have not used any.", at, questionKey: "wq_tools" },
    { role: "candidate", content: "I have not used any charting software yet.", at, questionKey: "wq_tools", source: "edit" },
    { role: "assistant", content: "When could you start?", at, questionKey: "q_start" },
    { role: "candidate", content: "Monday", at, questionKey: "q_start" },
  ],
  progress: {
    askedKeys: ["wq_patient", "wq_why", "wq_tools", "q_start"], currentQuestionKey: null, flow: "one_visit", declined: ["wq_why"], edits: { wq_tools: 1 }, submittedAt: at,
    chat: { v: 1, section: "wrapping_up", current: null, builtAt: at, items: [
      { key: "mh_1_license", kind: "gap", required: false, state: "unknown", step: "smaller", pushes: 1 },
      { key: "wq_patient", kind: "written", required: true, state: "covered", step: "direct", pushes: 0 },
    ] },
    writeup: { v: 1, writtenAt: at, aiRunId: "run1", promptVersion: 1, answers: [
      { questionKey: "wq_patient", answer: DRAFT, status: "answered", quotes: ["let him hold the mirror"], note: null, by: "writeup" },
      { questionKey: "wq_why", answer: "", status: "skipped", quotes: [], note: null, by: "writeup" },
      { questionKey: "wq_tools", answer: "I have not used any charting software yet.", status: "partly", quotes: ["I have not used any."], note: NOTE, by: "candidate", editedAt: at },
    ] },
  },
};

function detail(over: Record<string, unknown> = {}) {
  return {
    id: "a2", stage: "screen_complete", stageLabel: "AI interview done", group: "waiting_on_you", source: "careers_page", createdAt: at, eligibility: { passed: true, failedRules: [], unverifiable: [] },
    ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [], stageMoves: moves, toldState: null, extractionSummary: null, assessment: null, evidence,
    appliedAt: at, stageChangedAt: at, daysInStage: 1, decisionMessageWaiting: false, stillApplying: false,
    roleId: "r1", candidateToldAt: null, rejectReason: null, rejectNote: null, declineMessage: "sends",
    allowedActions: ["interview", "hold", "reject", "set_mark"], blockedReasons: {}, interviews: [], interviewPlan: [],
    candidate: { firstName: "Sofia", lastName: "Lind", email: "a2@example.com", phone: null, locationText: null, consent: {}, preferences: {} },
    documents: [], communications: [], extraction: null, answers: {}, assessments: [], pendingApprovals: [],
    packetLabels: {
      mustHaves: [{ key: "mh_1_license", text: "An active CA RDH license" }], competencies: [],
      questions: [{ key: "q_start", question: "When could you start?" }],
      written: [
        { key: "wq_patient", question: "Tell us about a time you calmed a nervous patient.", required: true, source: "company" },
        { key: "wq_why", question: "Why this practice?", required: false, source: "company" },
        { key: "wq_tools", question: "Which charting software have you used?", required: true, source: "company" },
      ],
    },
    timeline: [{ type: "screen.invited", occurredAt: at, actor: { kind: "system", id: "apply_page" }, payload: { invitedBy: "apply", invitedVia: "apply" } }],
    screens: [screen],
    ...over,
  };
}

function panel(d: ReturnType<typeof detail>, tab: "overview" | "screen") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], owner);
  qc.setQueryData(["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: at, counts: { total: 1 }, needsYou: 1, daysOpen: 7 }]);
  qc.setQueryData(["applications", "r1"], { applications: [], counts: { total: 0 } });
  qc.setQueryData(["company"], { settings: { verifiedAt: at }, planKey: "starter", usage: {} });
  qc.setQueryData(["application", d.id], d);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(CandidatePanel, { id: d.id, roleId: "r1", roleTitle: "Dental Hygienist", tab, onTab: () => undefined, step: null, onStep: () => undefined, ids: null, onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })));
}

describe("the company's questions on the AI interview tab (Wave S7)", () => {
  it("shows each question, numbered, with the drafted answer and where its words come from", () => {
    const html = panel(detail(), "screen");
    const words = text(html);
    expect(html).toContain('<section class="match-section" aria-label="Answers to your questions">');
    expect(html).toContain("<h3>Answers to your questions</h3>");
    expect(words).toContain("2 of 3 answered (1 partly).");
    // in the write-up's order, inside one numbered list
    const list = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
    expect(list.indexOf("Tell us about a time you calmed a nervous patient.")).toBeLessThan(list.indexOf("Why this practice?"));
    expect(list.indexOf("Why this practice?")).toBeLessThan(list.indexOf("Which charting software have you used?"));
    expect(list).toContain('<strong>Why this practice?</strong><span class="muted"> (optional)</span>');
    expect(list).toContain(`${DRAFT}</p><p class="muted" style="margin:2px 0 0">Drafted by the assistant from their replies; they could change it before sending.</p>`);
    expect(text(list)).toContain("Their own words: they changed this before sending.");
    expect(list).toContain('<span class="chip good">Answered</span>');
    expect(list).toContain('<span class="chip accent">Partly answered</span>');
    expect(list).toContain('<p class="muted" style="margin:4px 0 0"><em>Chose not to answer</em></p>');
  });

  it("keeps the assistant's note in its own labelled box, never inside the answer", () => {
    const html = panel(detail(), "screen");
    expect(html).toContain(`<div class="bubble assistant" style="margin-top:6px"><span class="bubble-label">Note from the assistant. Not the candidate&#x27;s own words.</span>${NOTE}</div>`);
    expect(html.match(/Note from the assistant\./g)).toHaveLength(1);
    // the answer paragraph itself carries no note
    expect(html).toContain('<p style="margin:4px 0 0;white-space:pre-wrap">I have not used any charting software yet.</p>');
    // and a recruiter's call notes stay theirs
    expect(html).toContain('<span class="bubble-label">Notes from a call by Rae Recruiter. Not the candidate&#x27;s own words.</span>Said the same on the phone.');
  });

  it("puts each question's part of the chat, and the words the answer rests on, one click away", () => {
    const html = panel(detail(), "screen");
    expect(html).toContain("<summary>Read this part of the chat (2 messages)</summary>");
    expect(html).toContain("<summary>Read this part of the chat (1 message)</summary>");
    expect(html).toContain("<summary>Read this part of the chat (3 messages)</summary>");
    expect(html).toContain("<summary>Their words it rests on (1)</summary>");
    expect(html).toContain('<li class="muted">&quot;let him hold the mirror&quot;</li>');
    // the whole chat stays at the bottom, open on the latest screen
    expect(html).toMatch(/<details style="margin-top:8px" open=""><summary class="small">Read the chat \(9 messages\)<\/summary>/);
  });

  it("lists the must-haves the résumé did not show, and the other answers apart", () => {
    const words = text(panel(detail(), "screen"));
    expect(words).toContain("Must-haves the résumé did not show, asked about in the chat: An active CA RDH license Not known yet: never counted as a no");
    // a question that is not one of the company's written questions keeps its line, once
    expect(words).toContain("Their other answers When could you start? Monday");
    expect(words.match(/Tell us about a time you calmed a nervous patient\./g)).toHaveLength(1);
  });

  it("says it in one line on the Overview", () => {
    const words = text(panel(detail(), "overview"));
    expect(words).toContain("Answers to your questions: 2 of 3 answered (1 partly), 1 with a note from the assistant. Read them on the AI interview tab.");
  });

  it("shows none of it while the answers are hidden, and the old look for a chat without a write-up", () => {
    const hidden = detail({ stage: "screening", screens: [{ ...screen, status: "in_progress", completedAt: null, answersShared: false, answers: {}, transcript: [], progress: { askedKeys: [], currentQuestionKey: null } }] });
    const words = text(panel(hidden, "screen"));
    expect(words).toContain("AI interview not sent yet: their answers appear here once they send them.");
    expect(words).not.toContain("Answers to your questions");
    expect(text(panel(hidden, "overview"))).not.toContain("Answers to your questions");
    const older = detail({ packetLabels: { mustHaves: [], competencies: [], questions: [{ key: "q_start", question: "When could you start?" }] }, screens: [{ ...screen, progress: { ...screen.progress, chat: undefined, writeup: undefined } }] });
    const old = text(panel(older, "screen"));
    expect(old).not.toContain("Answers to your questions");
    expect(old).not.toContain("Must-haves the résumé did not show");
    expect(old).toContain("Their answers When could you start? Monday");
  });
});
