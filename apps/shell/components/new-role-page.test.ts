import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeSessionView } from "@ros/contracts";

/**
 * The job builder at /roles/new (plan Wave C) and Today's hand-off to it, as the server first draws them from answers
 * shaped like the API's: "Who are you hiring?" with the quick starts our hiring guide knows; then the conversation with
 * a question card docked at its foot beside the draft, "Ask for approval" greyed with what is missing; and after the
 * draft is written, the message box asking for changes.
 */
const nav = vi.hoisted(() => ({ search: "", path: "/roles/new" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { NewRole } = await import("@ros/web/src/pages/NewRole");
const { Home } = await import("@ros/web/src/pages/Home");
const { checkSignature } = await import("@ros/web/src/pages/new-role/refine-api");
const { samplePacket } = await import("../../../packages/agents/src/fixtures/sample-packet");
const { StepBody } = await import("@ros/web/src/pages/new-role/QuickStart");
const { emptyQuickAnswers, STEP_HINT } = await import("@ros/web/src/pages/new-role/quick-start");
const { suggestKey } = await import("@ros/web/src/pages/new-role/quick-suggest");
type QuickAnswersT = import("@ros/web/src/pages/new-role/quick-start").QuickAnswers;

const me = (role: string) => ({ user: { id: "u-dana", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
const room = { ok: true, limit: 5, used: 1, holding: [], message: null };
const essentials = (done: Record<string, string | null>) => (["title", "location", "compensation_range", "reason_for_hire", "interviewers", "decision_maker"] as const).map((key) => ({ key, label: { title: "Job title", location: "Where the job is", compensation_range: "Pay", reason_for_hire: "Why you are hiring", interviewers: "Who interviews", decision_maker: "Who makes the final decision" }[key], done: !!done[key], value: done[key] ?? null, note: null }));

function session(over: Partial<IntakeSessionView> = {}): IntakeSessionView {
  return {
    id: "s1",
    status: "active",
    roleId: null,
    createdAt: "2026-10-08T09:00:00Z",
    updatedAt: "2026-10-08T09:01:00Z",
    startedBy: { userId: "u-dana", name: "Dana Whitfield", mine: true },
    messages: [
      { role: "owner", content: "I need a dental hygienist in Irvine.", at: "2026-10-08T09:00:00Z", kind: "text" },
      { role: "assistant", content: "Got it. I've put 2 quick questions beside this.", at: "2026-10-08T09:00:05Z" },
    ],
    facts: { title: "Dental Hygienist", locationText: "Irvine, CA", mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] },
    missingFacts: ["reason_for_hire"],
    questions: [
      { id: "q1_1", field: "reason_for_hire", prompt: "Why are you hiring?", mode: "single", options: [{ label: "A new position", value: "new_position", origin: "assistant" }, { label: "Replacing someone who left", value: "replacement", origin: "assistant" }], allowOwn: true, why: "A replacement and a new position call for different questions." },
      { id: "q1_2", field: "decision_maker", prompt: "Who has the final say?", mode: "team", options: [{ label: "Dana Whitfield", value: "u-dana", origin: "team" }, { label: "Someone not on the team yet", value: "__someone_new", origin: "team" }], allowOwn: true, why: "Their approval opens the role." },
    ],
    readiness: { essentials: essentials({ title: "Dental Hygienist", location: "Irvine, CA" }), missing: ["compensation_range", "reason_for_hire", "interviewers", "decision_maker"], payConfirmed: false, mayDraft: false, draftBlocker: "Answer the question cards first, or say \"draft it\".", hasDraft: false, draftOutOfDate: false, draftEdits: 0, openFlags: 0, mayAskForApproval: false, approvalBlockers: ["Not set yet: pay.", "Not set yet: why you are hiring.", "Set the pay on the pay card.", "Write the draft first, so you can check it."] },
    pay: { basis: "hourly", benchmark: { basis: "hourly", p25: 50, p50: 57, p75: 63, source: "BLS OEWS (ITS playbook estimate)", metro: "Anaheim metro", asOf: "2025", origin: "its_estimate", label: "ITS estimate" }, gap: null, stated: { min: null, max: null, ceiling: null }, confirmed: null, belowMarket: false, summary: "ITS estimate for Anaheim metro." },
    draft: null,
    flags: [],
    ad: null,
    fromRole: null,
    progress: null,
    ...over,
  };
}

function render(element: ReturnType<typeof createElement>, seed: Array<[readonly unknown[], unknown]>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, element));
}

describe("the job builder", () => {
  beforeEach(() => {
    nav.search = "";
    nav.path = "/roles/new";
  });

  it("opens on 'Who are you hiring?' with two ways to start: the quick questions first, then one big box and the roles our hiring guide knows", () => {
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "mine"], { sessions: [], room }], [["company"], { name: "Bright Dental", vertical: "dental", settings: {} }]]);
    // fewer words (23 October 2026): no eyebrow and no line under the title
    expect(html).not.toContain("New job");
    expect(html).toContain("<h1>Who are you hiring?</h1>");
    expect(html).not.toContain("Two ways to start");
    // the quick questions are the main button, and come first: the kit's hero card sizes the title
    expect(html).toContain('<section class="card needs-you hero" aria-labelledby="start-quick-h"><div class="card-title"><h2 id="start-quick-h">Answer a few quick questions</h2>');
    expect(html).not.toContain("Ten short steps");
    expect(html).toMatch(/class="btn primary"[^>]*>Start the quick questions<svg/);
    expect(html.indexOf("Start the quick questions")).toBeLessThan(html.indexOf("Or describe it, or paste a job ad"));
    expect(html).toContain(">Or describe it, or paste a job ad</h2>");
    expect(html).toMatch(/<textarea[^>]*aria-label="Describe the role, or paste a job ad"/);
    expect(html).not.toContain("up to 20,000 characters");
    // the keys are no line on screen: at a desk the Send button announces Enter as its shortcut (the kit's
    // keyshortcuts) and a mouse sees the keys as its tooltip; the box is described by them for screen readers only
    expect(html).toMatch(/<button type="button" class="btn primary [^"]*"[^>]* title="Enter sends · Shift\+Enter for a new line"[^>]* aria-keyshortcuts="Enter">/);
    const keys = html.match(/<span class="sr-only" id="([^"]+)">Enter sends · Shift\+Enter for a new line<\/span>/);
    expect(keys).not.toBeNull();
    expect(html).toMatch(new RegExp(`<textarea[^>]*aria-describedby="${keys![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    expect(html).not.toMatch(/<p[^>]*>Enter sends · Shift\+Enter for a new line</);
    // the roles our hiring guide knows: the list is named, with no line above it
    expect(html).toContain('aria-label="Start from a role our hiring guide knows"');
    expect(html).not.toContain("Roles our hiring guide knows:");
    expect(html).toContain(">Dental hygienist</button>");
    expect(html).toContain(">Associate dentist</button>");
    // the AI-use line stays
    expect(html).toContain("You are talking with an AI assistant. It drafts; you decide.");
  });

  it("says when the plan has no room, with the roles holding the places, before anything is typed", () => {
    const full = { ok: false, limit: 2, used: 2, holding: [{ roleId: "r1", title: "Front Desk Lead", status: "open" }, { roleId: "r2", title: "Hygienist", status: "paused" }], message: "Your plan includes 2 roles at a time, and all are in use: Front Desk Lead, Hygienist (paused). A role uses a place while it is open, paused or waiting for approval, and closing a role gives its place back. Close a role you no longer need, or talk to ITS about adding more." };
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "mine"], { sessions: [], room: full }], [["company"], { name: "Bright Dental", vertical: "veterinary", settings: {} }]]);
    // closing a role gives its place back (polish list: the count once only went up)
    expect(html).toContain("closing a role gives its place back");
    expect(html).toContain('href="/roles/r1"');
    // each role using a place is a link to it, with its state when it is not simply open
    expect(html).toMatch(/href="\/roles\/r2"[^>]*>Hygienist<\/a><span class="muted"> \(<!-- -->paused<!-- -->\)<\/span>|href="\/roles\/r2"[^>]*>Hygienist<\/a><span class="muted"> \(paused\)<\/span>/);
    expect(html).not.toMatch(/Front Desk Lead<\/a><span class="muted">/);
    expect(html).not.toContain("Roles our hiring guide knows");
    // neither way can start a draft while the plan is full
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start the quick questions/);
  });

  it("when the trial has ended (L-02 B), says the owner's one line and asks ITS to choose a plan, with no roles to close", () => {
    const ended = { ok: false, limit: 1, used: 1, holding: [], message: "Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.", trialEnded: true };
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "mine"], { sessions: [], room: ended }], [["company"], { name: "Bright Dental", vertical: "dental", settings: {} }]]);
    expect(html).toContain("Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.");
    expect(html).toContain("Ask ITS to choose a plan");
    expect(html).not.toContain("Talk to ITS about more roles");
    expect(html).not.toContain('href="/roles/r1"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start the quick questions/);
  });

  it("opens the quick questions at ?way=quick: one question a screen, Step 1 of 10, a job ad to fill in the steps, and the other way back", () => {
    nav.search = "way=quick";
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "mine"], { sessions: [{ id: "s9", status: "active", title: "Hygienist", startedBy: { userId: "u-dana", name: "Dana" }, mine: true, createdAt: "", updatedAt: "", ownerMessages: 1, hasDraft: false, missing: [] }], room }], [["company"], { name: "Bright Dental", vertical: "dental", settings: {} }]]);
    // a draft in progress does not take the person away from the quick questions they asked for
    // fewer words: no eyebrow, the step without its name (the question says it), no hint under the question
    expect(html).not.toContain("New job");
    expect(html.replace(/<!-- -->/g, "")).toContain(">Step 1 of 10</p>");
    expect(html).toContain('<h1 tabindex="-1">What is the job title?</h1>');
    expect(html).not.toContain("Or paste a job ad you already have");
    expect(html).toMatch(/<label for="qs-title">Job title<\/label>/);
    expect(html).toContain("<summary>Paste a job ad instead</summary>");
    expect(html).toMatch(/<textarea[^>]*aria-label="Paste a job ad"/);
    expect(html).toContain('href="/roles/new?new=1"');
    expect(html).toContain(">Other ways to start</a>");
    expect(html).toMatch(/<button type="submit" class="btn primary"[^>]*>Next<svg/);
    // Enter moves on: the Next button's tooltip, not a line; where the answers are kept stays said
    expect(html).toMatch(/<button type="submit" class="btn primary" title="Press Enter to go on\."[^>]*>Next<svg/);
    expect(html).not.toContain("Press Enter to go on. Your answers");
    expect(html).toContain("Your answers are kept in this browser.");
    expect(html).not.toContain("Start over");
    expect(html).not.toContain("Who are you hiring?");
  });

  it("tells someone who may not start a hire, plainly", () => {
    const html = render(createElement(NewRole), [[["me"], me("interviewer")]]);
    expect(html).toContain("Starting a hire is not part of your role");
    expect(html).not.toContain("<textarea");
  });

  it("puts the conversation and its question card beside the draft, with Ask for approval greyed and what is missing listed", () => {
    nav.search = "session=s1";
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "session", "s1"], { session: session() }], [["members"], [{ userId: "u-dana", role: "owner", status: "active", email: "dana@bright.test", name: "Dana Whitfield" }]]]);
    // fewer words: no "Drafting · company" eyebrow over the title
    expect(html).not.toContain("Drafting ·");
    expect(html).toContain("<h1>Dental Hygienist</h1>");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Ask for approval<\/button>/);
    expect(html).toContain("Before you can ask for approval:");
    expect(html).toContain("Set the pay on the pay card.");
    // the conversation, then the card: the question, "Pick one", the pager, the answers, "Why we ask", Next
    expect(html).toContain("I need a dental hygienist in Irvine.");
    expect(html).toContain('data-testid="intake-announcer"');
    expect(html).toContain("Why are you hiring?");
    expect(html).toContain(">Pick one</span>");
    expect(html).toContain("1 of 2");
    expect(html).toContain("Replacing someone who left");
    // the assistant's own answers carry the sparkle (its words read out and as a tooltip), not a word on every row
    expect(html).toContain('<span class="icon-label" title="AI suggestion">');
    expect(html).not.toContain(">Suggestion</span>");
    expect(html).toContain("<summary>Why we ask</summary>");
    expect(html).toContain("Or type your own answer…");
    expect(html).toMatch(/>Next<svg/);
    // the draft: what we know and what is missing, the title and who sees it, the pay card with the ITS estimate
    expect(html).toContain("What we know");
    expect(html).toContain("Still missing");
    // who sees each part: the eye or the lock, its words for screen readers and the tooltip
    expect(html).toContain('<span class="icon-label" title="Candidates see this">');
    expect(html).toContain('<span class="icon-label" title="Only your team sees this">');
    expect(html).toContain('<span class="sr-only">Candidates see this</span>');
    expect(html).toContain('<span class="sr-only">Only your team sees this</span>');
    expect(html).toContain('<span class="icon-label" title="Candidates see the range; only your team sees the most you would pay">');
    expect(html).toContain("Market pay here:");
    expect(html).toContain("ITS estimate for Anaheim metro, 2025.");
    expect(html).toContain("Pay not set yet");
    // pay transparency is said on the pay card before any pay is set; the line on how to set it is gone
    expect(html).toContain('<p class="small muted">Pay is always shown on the job ad.</p>');
    expect(html).not.toContain("Set it here, or tell the assistant.");
    // a phone shows one pane at a time, with a switch
    expect(html).toContain(">Conversation</button>");
    expect(html).toContain(">Draft</button>");
  });

  it("says what to do next in one small line under the message box, in the server's words, only while the draft cannot be written", () => {
    nav.search = "session=s1";
    const seed = (s: IntakeSessionView) => [[["me"], me("owner")], [["intake", "session", "s1"], { session: s }], [["members"], []]] as Array<[readonly unknown[], unknown]>;
    // the question cards closed (none left): the message box is in the dock
    const blocked = session({ questions: [], readiness: { ...session().readiness, draftBlocker: "Tell me the job title first, or say \"draft it\"." } });
    const html = render(createElement(NewRole), seed(blocked));
    const line = html.match(/<p class="px-1\.5 text-\[12\.5px\] leading-snug text-ink-3" id="([^"]+)">Tell me the job title first, or say &quot;draft it&quot;\.<\/p>/);
    expect(line).not.toBeNull();
    // read with the box by screen readers
    expect(html).toMatch(new RegExp(`<textarea[^>]*aria-label="Message to the assistant" aria-describedby="${line![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [^"]+"`));
    expect(html.match(/Tell me the job title first/g)).toHaveLength(1);
    // the other blocker reads the same way
    const cards = render(createElement(NewRole), seed(session({ questions: [] })));
    expect(cards).toContain(">Answer the question cards first, or say &quot;draft it&quot;.</p>");
    // once a draft may be written, the line goes (the "Write the draft" offer says it instead)
    const ready = render(createElement(NewRole), seed(session({ questions: [], readiness: { ...session().readiness, mayDraft: true, draftBlocker: null } })));
    expect(ready).not.toContain("or say &quot;draft it&quot;.</p>");
    // with nothing blocking, the box is described by the keys alone (screen readers only)
    expect(ready).toMatch(/<textarea[^>]*aria-describedby="[^" ]+"/);
    expect(ready).toContain(">Write the draft</button>");
  });

  it("once the draft is written, the box asks for changes and the draft shows what candidates will read", () => {
    nav.search = "session=s1";
    const draft = samplePacket();
    const written = session({
      questions: [],
      draft,
      readiness: { ...session().readiness, hasDraft: true, mayDraft: true, mayAskForApproval: true, approvalBlockers: [], payConfirmed: true, missing: [], essentials: essentials({ title: "Dental Assistant", location: "Irvine, CA", compensation_range: "$24–$28 an hour", reason_for_hire: "replacement", interviewers: "Dana Whitfield", decision_maker: "Dana Whitfield" }) },
      progress: { stage: "done", startedAt: "2026-10-08T09:02:00Z", at: "2026-10-08T09:02:30Z" },
    });
    const check = { base: "dabc", version: null, summary: "One suggestion.", suggestions: [{ id: "c1", kind: "unprovable", title: "Hard to check before someone starts", path: "requirements.mustHaves[mh_chairside]", text: "Chairside experience in a dental office", why: "It can be shown in a short practical task instead.", fixes: [{ id: "c1-int", label: "Ask about it in the interview", op: "to_interview", after: null }], flagId: null }] };
    const html = render(createElement(NewRole), [[["me"], me("owner")], [["intake", "session", "s1"], { session: written }], [["members"], []], [["intake", "check", "s1", checkSignature(draft)], check]]);
    expect(html).toContain("Ask me to change anything: make it warmer, drop the weekend requirement…");
    // no helper line under the box: the proposal itself says it is not saved yet, and a blocker the server still sends
    // is not said while the box asks for changes
    expect(html).not.toContain("A change is shown to you before it is saved.");
    expect(html).not.toContain("Answer the question cards first");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Ask for approval/);
    expect(html).toContain(draft.description.publicJobDescription.slice(0, 40));
    expect(html).toContain("What we&#x27;re looking for");
    expect(html).toContain("Quick questions on the application form");
    expect(html).not.toContain("Still missing");
    // the requirements check's suggestion sits under the part it is about, with its one-tap fix
    expect(html).toContain("Hard to check before someone starts:");
    expect(html).toContain(">Ask about it in the interview</button>");
    expect(html).toContain(">Leave it</button>");
  });
});

describe("the quick start's suggestions for any job (Wave S3, G3)", () => {
  type Suggest = { kind: "guide" } | { kind: "waiting" } | { kind: "ai"; mustHaves: string[]; questions: string[] } | { kind: "none" };
  const driver = { ...emptyQuickAnswers(), title: "Delivery driver", employmentType: "part_time", remotePolicy: "onsite", place: "Austin, TX", experience: "2", below: "consider" as const };
  const draw = (suggest: Suggest, step: "musts" | "questions" = "musts", a: QuickAnswersT = driver, vertical = "logistics") =>
    renderToStaticMarkup(createElement(StepBody, { step, a, set: () => undefined, vertical, suggest, onEdit: () => undefined }));

  it("shows our hiring guide's must-haves at once when it knows the job, and never waits on the assistant", () => {
    const html = draw({ kind: "guide" }, "musts", { ...emptyQuickAnswers(), title: "Dental hygienist" }, "dental");
    expect(html).toContain("Digital radiography and intraoral scanning");
    // where each came from is a mark at the row's end, its words read out and shown as a tooltip
    expect(html).toContain('<span class="icon-label" title="Our hiring guide">');
    expect(html).toContain("Our hiring guide");
    expect(html).not.toContain("AI suggestion");
    expect(html).not.toContain("Suggesting skills from your answers…");
  });

  it("says it is suggesting while the assistant works, with add your own still there", () => {
    const html = draw({ kind: "waiting" });
    expect(html).toContain('<p class="small muted" role="status">Suggesting skills from your answers…</p>');
    expect(html).toMatch(/<input id="qs-must-own"/);
    expect(html).not.toContain('name="qs-musts"');
  });

  it("offers the assistant's must-haves as tick boxes, none ticked, so the person chooses", () => {
    const html = draw({ kind: "ai", mustHaves: ["Valid driver's licence", "Route planning"], questions: [] });
    expect(html).toMatch(/<input type="checkbox" aria-label="Valid driver&#x27;s licence" name="qs-musts" value="Valid driver&#x27;s licence"\/>/);
    expect(html).toMatch(/<input type="checkbox" aria-label="Route planning" name="qs-musts" value="Route planning"\/>/);
    expect(html).not.toMatch(/name="qs-musts"[^>]*checked/);
    // an AI-use notice: each says "AI suggestion" on screen, with the sparkle, and its row lets the words drop below on a phone
    expect(html.match(/<span class="option-tag inline-flex items-center gap-1"><svg[^>]*>.*?<\/svg>AI suggestion<\/span>/g)).toHaveLength(2);
    expect(html).toMatch(/<label class="option-row flex-wrap gap-y-1\.5"><input type="checkbox" aria-label="Route planning"/);
    expect(html).not.toContain('<span class="sr-only">AI suggestion</span>');
    expect(html).not.toContain("Suggesting skills");
    // ticked ones stay ticked
    expect(draw({ kind: "ai", mustHaves: ["Route planning"], questions: [] }, "musts", { ...driver, mustHaves: ["Route planning"] })).toMatch(/aria-label="Route planning" name="qs-musts" checked=""/);
  });

  it("shows nothing beyond add your own when the assistant failed or was slow", () => {
    const html = draw({ kind: "none" });
    expect(html).not.toContain('name="qs-musts"');
    expect(html).not.toContain("Suggesting");
    expect(html).toMatch(/<input id="qs-must-own"[^>]*placeholder="e.g. Two years in a busy dental office"/);
  });

  it("offers the assistant's questions ticked, after the general ones, and says while it works", () => {
    const aiSuggest = { key: suggestKey(driver), mustHaves: [], questions: ["Do you hold a valid driver's licence?"] };
    const html = draw({ kind: "ai", mustHaves: [], questions: aiSuggest.questions }, "questions", { ...driver, aiSuggest });
    expect(html).toMatch(/<input type="checkbox" aria-label="Do you hold a valid driver&#x27;s licence\?" name="qs-questions" checked=""/);
    // only the assistant's question says "AI suggestion" on screen; the general ones carry nothing
    expect(html.match(/<\/svg>AI suggestion<\/span>/g)).toHaveLength(1);
    expect(html).toContain("Are you legally authorized to work in the United States for any employer?");
    // the person's own questions go to the AI interview: said by the box's visible label, not a hint line
    expect(html).toContain('<div class="field"><label for="qs-question-own">Add a question for the AI interview</label>');
    const waiting = draw({ kind: "waiting" }, "questions");
    expect(waiting).toContain('role="status">Suggesting questions from your answers…</p>');
    expect(waiting).toContain("Are you legally authorized to work in the United States for any employer?");
  });
});

describe("the quick start's lines on how answers are used", () => {
  it("says the pay is always published, and how a deal-breaker judges applicants (Q19)", () => {
    // pay transparency, under the pay step's question
    expect(STEP_HINT.pay).toBe("Pay is always shown on your job ad.");
    const a = { ...emptyQuickAnswers(), title: "Delivery driver", dealBreakers: ["Cannot work Saturdays"] };
    const html = renderToStaticMarkup(createElement(StepBody, { step: "dealbreakers", a, set: () => undefined, vertical: "logistics", onEdit: () => undefined }));
    expect(html).toContain("Everyone is checked openly against must-haves. An unticked one is not used to judge anyone.");
    expect(html).toMatch(/<label class="option-row flex-wrap gap-y-1\.5">[\s\S]*?<span class="option-tag">Must-have<\/span><\/label>/);
  });
});

describe("Today's hand-off", () => {
  it("offers the 'Who are you hiring?' box and the draft in progress, asking before a discard", () => {
    nav.path = "/";
    const brief = { generatedAt: "2026-10-08T09:00:00Z", summary: "1 draft in progress.", cards: [{ kind: "draft", title: "Draft in progress: Dental Hygienist", body: "Pick up where you left off; nothing has been sent to anyone.", actions: [{ label: "Continue", method: "GET", path: "/roles/new?session=s1" }, { label: "Discard", method: "POST", path: "/api/v1/intake/sessions/s1/abandon" }] }] };
    const html = render(createElement(Home), [[["me"], me("owner")], [["brief"], brief], [["notifications", "unread"], []], [["escalations", "mine"], []]]);
    expect(html).toContain("Draft in progress: Dental Hygienist");
    expect(html).toContain(">Draft</span>");
    expect(html).toContain('href="/roles/new?session=s1"');
    expect(html).toContain("Who are you hiring?");
    expect(html).toContain(">Start drafting</button>");
    expect(html).toContain('href="/roles/new"');
    expect(html).not.toContain("Your recruiting chief of staff");
  });

  it("shows no box to someone who may not start a hire", () => {
    nav.path = "/";
    const html = render(createElement(Home), [[["me"], me("hr")], [["brief"], { generatedAt: "", summary: "", cards: [] }], [["notifications", "unread"], []]]);
    expect(html).not.toContain("Who are you hiring?");
    expect(html).not.toContain(">Start drafting</button>");
  });
});
