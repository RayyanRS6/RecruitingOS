import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Telling candidates and interviews to hire (plan Waves G and H; founder decisions B6, Q24, Q27-Q30) on the candidate
 * panel, as the server first draws it from answers shaped like the API's: the "not told yet" card with its safety net,
 * the Send screen's approved wordings and personal line, the conversation thread, the Notes tab, the finalist's next
 * step, "Offer made", the wait on the candidate's answer, the hire sheet, the résumé inside the panel, the role's closing
 * message and the close card, and the team's notes in Compare.
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
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");
const { SendDecisionStep } = await import("@ros/web/src/pages/candidate-panel/telling");
const { ClosingMessageCard, CloseRoleCard } = await import("@ros/web/src/components/ClosingMessage");
const { CompareTable } = await import("@ros/web/src/pages/compare/ComparePanel");
const { QuestionCard } = await import("@ros/web/src/pages/new-role/QuestionCard");
const { Interviews } = await import("@ros/web/src/pages/Interviews");

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const STAGES = ["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"] as const;
// nobody is moved to Cancelled by hand (founder decision 1A)
const moves = (current: string) => STAGES.map((to) => ({ to, label: to, via: to === current || to === "cancelled" ? "none" : "set_mark", allowed: to !== current && to !== "cancelled", current: to === current }));

function detail(over: Record<string, unknown> = {}) {
  return {
    id: "a1", roleId: "r1", stage: "triaged", stageLabel: "Ready for your review", group: "waiting_on_you", source: "careers_page", createdAt: daysAgo(10), stageChangedAt: daysAgo(2), eligibility: { passed: true, failedRules: [], unverifiable: [] },
    ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [] as string[], stageMoves: moves("new"), toldState: null as string | null, candidateToldAt: null, rejectReason: null, rejectNote: null, declineMessage: "sends",
    allowedActions: [] as string[], blockedReasons: {}, interviews: [] as unknown[], interviewPlan: [{ key: "working", title: "Working interview", durationMinutes: 45, format: "in_person", interviewerUserIds: [], purpose: "" }],
    candidate: { firstName: "Maria", lastName: "Reyes", email: "maria@example.com", phone: null, locationText: "Tustin, CA", consent: {}, preferences: {} },
    documents: [] as unknown[], screens: [], communications: [] as unknown[], extraction: null, answers: {}, assessments: [], pendingApprovals: [] as unknown[],
    packetLabels: { mustHaves: [], competencies: [], questions: [] }, timeline: [] as unknown[],
    ...over,
  };
}

function client(details: Array<ReturnType<typeof detail>>, extra: Array<[unknown[], unknown]> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
  for (const d of details) qc.setQueryData(["application", d.id], d);
  for (const [key, value] of extra) qc.setQueryData(key, value);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const panel = (qc: QueryClient, opts: { tab?: string; step?: string | null } = {}) => render(qc, createElement(CandidatePanel, { id: "a1", roleId: "r1", roleTitle: "Dental Hygienist", tab: (opts.tab ?? "overview") as never, onTab: () => undefined, step: (opts.step ?? null) as never, onStep: () => undefined, ids: ["a1"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));

describe("telling a candidate the decision (Wave G)", () => {
  const declined = detail({ stage: "rejected", stageLabel: "Not moving forward", group: "not_moving_forward", ownerStage: "not_moving_forward", ownerStageLabel: "Not moving forward", toldState: "not_told", rejectReason: "not_a_match_skills", rejectedAt: daysAgo(1), stageChangedAt: daysAgo(1), allowedActions: ["send_decision", "told_in_person"] });

  it("the 'not told yet' card says the decision is private, and on which day the safety net acts", () => {
    const t = text(panel(client([declined])));
    expect(t).toContain("Maria has not been told yet");
    expect(t).toContain("Your decision is private: nothing has been sent to Maria.");
    expect(t).toMatch(/Safety net: the standard message goes to Maria by itself on \w+day, \w+ \d{1,2}, unless you send a message or mark it told before then\./);
    expect(t).toContain("Send message");
    expect(t).toContain("I told them myself");
  });

  it("under 'Ask me first' the safety net brings in a recruiter instead, and sends nothing", () => {
    expect(text(panel(client([{ ...declined, declineMessage: "needs_approval" }])))).toMatch(/an ITS recruiter is brought in to make sure they are\. Nothing is sent by itself\./);
  });

  it("a waiting approval names the chosen wording and the personal line to the approver", () => {
    const waiting = { ...declined, pendingApprovals: [{ id: "ar1", actionType: "disposition.send", rationale: null, createdAt: daysAgo(0), requiredRoles: ["owner"], proposal: { wording: "v2", personalLine: { text: "It was a pleasure to meet you." } } }] };
    const t = text(panel(client([waiting])));
    expect(t).toContain("Send the decision message to Maria?");
    expect(t).toContain('in the "Warmer" wording');
    expect(t).toContain("It was a pleasure to meet you.");
    expect(t).toContain("Yes, send it");
  });

  it("the Send screen offers the approved wordings, the suggested one first, a checked personal line and the exact message", () => {
    const preview = { to: "maria@example.com", subject: "Your application: Dental Hygienist at Bright Dental", text: "Hi Maria,\n\nThank you for meeting us.", wording: "after_interview", wordings: [{ id: "v1", label: "Standard", suggested: false }, { id: "v2", label: "Warmer", suggested: false }, { id: "after_interview", label: "After an interview", suggested: true }], personalLine: null, adverseDecisionLine: false, policy: "sends", toldState: "not_told", candidateToldAt: null, waitingApproval: false, undoSeconds: 30 };
    const html = render(client([declined], [[["decision-message", "a1"], preview]]), createElement(SendDecisionStep, { a: declined as never, roleId: "r1", onClose: () => undefined }));
    const t = text(html);
    expect(t).toContain("To maria@example.com. It goes when you press Send, after 30 seconds in which you can still undo it.");
    expect(html).toContain("<legend class=\"small\">Which approved wording?</legend>");
    // each radio is named by its wording, the suggested one first and chosen
    expect(html).toMatch(/<input type="radio" aria-label="After an interview \(suggested\)" name="wording-a1" checked="" value="after_interview"\/>/);
    expect(html).toContain('aria-label="Warmer"');
    expect(t).toContain("A personal line (optional)");
    expect(t).toContain("no scores, no reasons for the decision");
    expect(t).toContain("What Maria gets");
    expect(t).toContain("Thank you for meeting us.");
    expect(t).toContain("Send");
  });

  it("the Messages tab shows the conversation in order, who wrote each, and what was taken back", () => {
    const withThread = { ...declined, communications: [
      { id: "m2", direction: "inbound", channel: "email", subject: "Re: A question", bodyText: "Yes, Saturdays work.\n\nOn Mon, Bright Dental wrote:\n> Can you work Saturdays?", status: "received", createdAt: daysAgo(3), templateKey: null, sentBy: { kind: "candidate", id: "c1" } },
      { id: "m1", direction: "outbound", channel: "email", subject: "A question", bodyText: "Can you work Saturdays?", status: "sent", createdAt: daysAgo(4), templateKey: "freeform", sentBy: { kind: "user", id: "u1", name: "Dana Whitfield" } },
      { id: "m3", direction: "outbound", channel: "email", subject: "Your application", bodyText: "Hi Maria", status: "cancelled", createdAt: daysAgo(1), templateKey: "disposition:v1", sentBy: { kind: "user", id: "u1", name: "Dana Whitfield" } },
    ] };
    const html = panel(client([withThread]), { tab: "messages" });
    const t = text(html);
    expect(html).toContain('aria-label="Messages with Maria"');
    expect(t.indexOf("Can you work Saturdays?")).toBeLessThan(t.indexOf("Yes, Saturdays work."));
    expect(t).not.toContain("> Can you work Saturdays?");
    expect(t).toContain("Dana Whitfield");
    expect(t).toContain("Taken back before it was sent");
    expect(html).toContain('class="msg-item candidate"');
  });
});

describe("interviews to hire (Wave H)", () => {
  it("a finalist's card offers Offer made, the hire and not moving forward; nothing is sent from it", () => {
    const finalist = detail({ stage: "finalist", stageLabel: "Finalist", group: "waiting_on_you", ownerStage: "interviewing", allowedActions: ["record_outcome", "reject"] });
    const t = text(panel(client([finalist])));
    expect(t).toContain("Maria is a finalist: what next?");
    expect(t).toContain("the app never writes or sends an offer");
    expect(t).toContain("Offer made");
    expect(t).toContain("They accepted: hire");
  });

  it("Offer made asks for the day and a private note, and says nothing is sent", () => {
    const finalist = detail({ stage: "finalist", allowedActions: ["record_outcome"] });
    const html = panel(client([finalist]), { step: "offer" });
    expect(text(html)).toContain("Record that you made Maria an offer, outside the app. The app never writes, sends or changes an offer, and nothing is sent to Maria.");
    expect(html).toMatch(/<input id="offer-day" class="input" type="date" max="\d{4}-\d{2}-\d{2}" value="\d{4}-\d{2}-\d{2}"\/>/);
    expect(text(html)).toContain("Private note (kept internally, optional)");
    expect(text(html)).toContain("Record the offer");
  });

  it("an offer out waits on the candidate's answer: Accepted, Declined or Withdrew", () => {
    const out = detail({ stage: "offer_sent", stageLabel: "Offer out", group: "waiting_on_candidate", ownerStage: "offer", ownerStageLabel: "Offer", allowedActions: ["record_outcome"], timeline: [{ type: "offer.created", occurredAt: daysAgo(2), actor: { kind: "user", id: "u1", name: "Dana Whitfield" }, payload: { madeOn: "2026-10-07", note: "Start after notice" } }] });
    const t = text(panel(client([out])));
    expect(t).toContain("Waiting on Maria's answer");
    expect(t).toContain("You recorded an offer made on Wednesday, October 7");
    expect(t).toContain("Your note with the offer (kept internally): Start after notice");
    expect(t).toContain("They accepted");
    expect(t).toContain("They declined");
    expect(t).toContain("They withdrew");
    // the Overview says where things stand
    expect(t).toContain("Offer made on Wednesday, October 7, outside the app: waiting on their answer.");
  });

  it("'How did the interview go?' shows the team's notes and offers the hire beside next round and finalist", () => {
    const met = detail({ stage: "interview_complete", allowedActions: ["record_decision", "record_outcome", "reject"], interviews: [{ id: "iv1", roundKey: "working", title: "Working interview", status: "completed", startsAt: daysAgo(1), endsAt: null, timezone: null, meetingUrl: null, attempt: 1, outcome: "happened", decision: null, offeredSlots: [], createdAt: daysAgo(3) }] });
    const notes = { notes: [{ id: "n1", applicationId: "a1", author: { userId: "u2", name: "Sam Doyle" }, mine: false, starter: "after_interview", starterLabel: "After the interview", body: "Explained perio charting clearly.", createdAt: daysAgo(1), updatedAt: daysAgo(1), edited: false }], mine: null, canRead: "all", canWrite: true, writeBlockedReason: null, starters: [], privacy: "Private to your hiring team." };
    const t = text(panel(client([met], [[["notes", "a1"], notes]])));
    expect(t).toContain("How did the interview go?");
    expect(t).toContain("Team notes (private)");
    expect(t).toMatch(/Sam Doyle · After the interview ?: Explained perio charting clearly\./);
    expect(t).toContain("Add your note");
    expect(t).toMatch(/Finalist Hire Not moving forward/);
  });

  it("the Notes tab: the reminder, your own note with the starters, everyone else's", () => {
    const notes = { notes: [{ id: "n1", applicationId: "a1", author: { userId: "u2", name: "Sam Doyle" }, mine: false, starter: null, starterLabel: null, body: "Great with nervous patients.", createdAt: daysAgo(1), updatedAt: daysAgo(1), edited: false }, { id: "n2", applicationId: "a1", author: { userId: "u1", name: "Dana Whitfield" }, mine: true, starter: "before_interview", starterLabel: "Before the interview", body: "Ask about Saturdays.", createdAt: daysAgo(2), updatedAt: daysAgo(2), edited: true }], mine: { id: "n2", applicationId: "a1", author: { userId: "u1", name: "Dana Whitfield" }, mine: true, starter: "before_interview", starterLabel: "Before the interview", body: "Ask about Saturdays.", createdAt: daysAgo(2), updatedAt: daysAgo(2), edited: true }, canRead: "all", canWrite: true, writeBlockedReason: null, starters: [{ id: "before_interview", label: "Before the interview", prompt: "What do you want to find out?" }, { id: "after_interview", label: "After the interview", prompt: "How did it go? What did you see and hear?" }, { id: "for_and_against", label: "For and against", prompt: "What speaks for them, and what gives you pause?" }], privacy: "Private to your hiring team. The candidate never sees notes, and they are never given to the AI assistant." };
    const html = panel(client([detail()], [[["notes", "a1"], notes]]), { tab: "notes" });
    const t = text(html);
    expect(t).toContain("Private to your hiring team. The candidate never sees notes, and they are never given to the AI assistant.");
    expect(t).toContain("Stick to job-related facts");
    expect(t).toContain("Your note");
    expect(html).toMatch(/<fieldset class="row" style="[^"]*" aria-label="Start from"><button/);
    expect(t).toMatch(/Before the interview After the interview For and against/);
    // the starter the note is filed under is heard as pressed, not only seen by its fill, and said in words
    expect(html).toMatch(/<button type="button" class="btn primary sm" title="What do you want to find out\?" aria-pressed="true">Before the interview<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn secondary sm" title="How did it go\? What did you see and hear\?" aria-pressed="false">After the interview<\/button>/);
    expect(t).toContain("Filed under: Before the interview");
    expect(html).toContain(">Ask about Saturdays.</textarea>");
    expect(t).toContain("Changed since it was first written; the earlier words are kept on record.");
    expect(t).toContain("Your team's notes (1)");
    expect(t).toContain("Great with nervous patients.");
  });

  it("an interviewer's view of notes: only their own, with why they cannot write yet", () => {
    const notes = { notes: [], mine: null, canRead: "own", canWrite: false, writeBlockedReason: "You can write your note once the interview has started.", starters: [], privacy: "Private to your hiring team." };
    const t = text(panel(client([detail()], [[["notes", "a1"], notes]]), { tab: "notes" }));
    expect(t).toContain("You can write your note once the interview has started.");
    expect(t).toContain("You see your own note only.");
    expect(t).not.toContain("Your team's notes");
  });

  it("the résumé shows inside the panel, through this site's own address, with full screen and a new tab", () => {
    const withFile = detail({ resumeDocumentId: "d1", documents: [{ id: "d1", kind: "resume", filename: "maria.pdf", mime: "application/pdf", hasText: true, sizeBytes: 40960, status: "clean", uploadedVia: "apply_form", rejectedReason: null, validatedAt: daysAgo(9) }] });
    const html = panel(client([withFile]), { tab: "resume" });
    expect(html).toContain('<iframe src="/api/v1/applications/a1/documents/d1/inline" title="Résumé: maria.pdf" class="resume-frame"');
    expect(text(html)).toContain("Full screen");
    expect(html).toMatch(/<a href="\/api\/v1\/applications\/a1\/documents\/d1\/file" target="_blank" rel="noopener noreferrer" class="btn secondary sm">Open in a new tab<\/a>/);
  });
});

describe("closing a role and its one closing message (Q30)", () => {
  it("the close card lists who is still in process before anything is closed", () => {
    const apps = { applications: [{ id: "a1", stage: "triaged", ownerStage: "new", ownerStageLabel: "New", candidate: { id: "c1", name: "Maria Reyes" } }, { id: "a2", stage: "rejected", ownerStage: "not_moving_forward", ownerStageLabel: "Not moving forward", candidate: { id: "c2", name: "Luis Ortega" } }, { id: "a3", stage: "finalist", ownerStage: "interviewing", ownerStageLabel: "Interviewing", candidate: { id: "c3", name: "Ana Holt" } }], counts: {} };
    const t = text(render(client([], [[["applications", "r1"], apps]]), createElement(CloseRoleCard, { roleId: "r1", initialOutcome: "filled_outside_platform", mayTell: true, onClose: () => undefined })));
    expect(t).toContain("Close this role");
    expect(t).toContain("Still in process");
    expect(t).toContain("Maria Reyes");
    expect(t).toContain("Ana Holt");
    expect(t).not.toContain("Luis Ortega");
    expect(t).toContain("These 2 people move to your talent pool, privately");
    expect(t).toContain("Next you see the one closing message for all of them before anything goes.");
    // HR may close the role but not tell candidates: told who sends the message, never promised a Send of their own
    const hr = text(render(client([], [[["applications", "r1"], apps]]), createElement(CloseRoleCard, { roleId: "r1", initialOutcome: "filled_outside_platform", mayTell: false, onClose: () => undefined })));
    expect(hr).toContain("An owner, admin, hiring manager or recruiter then sends them the one closing message; it waits on their Today.");
    expect(hr).not.toContain("Next you see the one closing message");
  });

  it("the closing message names who gets it, shows the words once, and has a single Send", () => {
    const preview = { roleId: "r1", roleTitle: "Dental Hygienist", count: 2, people: [{ applicationId: "a1", name: "Maria Reyes", hasEmail: true, optedOut: false }, { applicationId: "a3", name: "Ana Holt", hasEmail: false, optedOut: true }], subject: "The Dental Hygienist role at Bright Dental", text: "Hi [first name],\n\nThe role has closed.", alreadyTold: 1, waitingApproval: 0, noEmail: 1, optedOut: 1, policy: "sends", waitingApprovalId: null, sendPath: "/api/v1/roles/r1/closing-message" };
    const t = text(render(client([]), createElement(ClosingMessageCard, { roleId: "r1", preview: preview as never, onDone: () => undefined })));
    expect(t).toContain("Tell the people Dental Hygienist left in process");
    expect(t).toContain("2 people were still in process when the role closed.");
    expect(t).toContain("No email address");
    expect(t).toContain("Asked not to be kept");
    expect(t).toContain("Hi [first name],");
    expect(t).toContain("Send to 2 people");
    expect(t).toContain("Not now");
    // "Not now" does not promise that nothing ever goes: the safety net (Q27) sends it by itself under these settings
    expect(t).toContain("Not now leaves them on Today as not told yet. If nobody tells them within 5 working days, the closing message goes to them by itself.");
    expect(t).not.toContain("nothing is sent until someone sends it");
    const asked = text(render(client([]), createElement(ClosingMessageCard, { roleId: "r1", preview: { ...preview, policy: "needs_approval" } as never, onDone: () => undefined })));
    expect(asked).toContain("Nothing is sent by itself: if nobody tells them within 5 working days, an ITS recruiter is brought in to make sure they are told.");
  });
});

describe("the team's notes in Compare (plan H3)", () => {
  it("adds a Team notes row with each person's notes when anyone has one", () => {
    const cand = (id: string, notes: unknown[]) => ({ applicationId: id, name: id === "a1" ? "Maria Reyes" : "Luis Ortega", stage: "triaged", stageLabel: "Ready", group: "waiting_on_you", mustHaves: {}, competencies: {}, screen: null, resume: null, unknownCount: 0, open: `/roles/r1/talent?open=${id}`, score: null, notes });
    const data = { role: { id: "r1", title: "Dental Hygienist" }, mustHaves: [], competencies: [], max: 5, reminder: "People decide.", candidates: [cand("a1", [{ id: "n1", applicationId: "a1", author: { userId: "u2", name: "Sam Doyle" }, mine: false, starter: null, starterLabel: null, body: "Calm and precise.", createdAt: daysAgo(1), updatedAt: daysAgo(1), edited: false }]), cand("a2", [])] };
    const t = text(render(client([]), createElement(CompareTable, { data: data as never })));
    expect(t).toContain("Team notes");
    expect(t).toMatch(/Sam Doyle ?: Calm and precise\./);
    expect(t).toContain("No notes yet");
  });

  it("gives every row a row header, so a screen reader names what each cell is about", () => {
    const cand = (id: string) => ({ applicationId: id, name: id === "a1" ? "Maria Reyes" : "Luis Ortega", stage: "triaged", stageLabel: "Ready", group: "waiting_on_you", mustHaves: {}, competencies: {}, screen: null, resume: null, unknownCount: 0, open: `/roles/r1/talent?open=${id}`, score: null, notes: [] });
    const data = { role: { id: "r1", title: "Dental Hygienist" }, mustHaves: [{ key: "mh_1", text: "Active CA RDH license" }], competencies: [{ key: "c1", name: "Patient care", definition: "Calm with patients", importance: "essential" }], max: 5, reminder: "People decide.", candidates: [cand("a1"), cand("a2")] };
    const html = render(client([]), createElement(CompareTable, { data: data as never }));
    expect(html).toContain('<th scope="col">Maria Reyes</th>');
    expect(html).toContain('<th scope="row" class="small muted">Match score</th>');
    expect(html).toMatch(/<th scope="row" class="small"><span class="sbar-tag must">Must-have<\/span> Active CA RDH license<\/th>/);
    expect(html).toMatch(/<th scope="row" class="small" title="Calm with patients">(<span class="sbar-tag">[^<]*<\/span> )?Patient care<\/th>/);
    expect(html).toContain('<th scope="row" class="small muted">Their panel</th>');
    // every body row starts with its header: no row is left with a plain first cell
    expect(html).not.toMatch(/<tr><td/);
  });
});

describe("the Interviews page for someone under Cancelled (founder decisions 1A to 4A)", () => {
  const iv = (over: Record<string, unknown> = {}) => ({
    id: "iv1", applicationId: "a1", roleId: "r1", roleTitle: "Dental Hygienist", roundKey: "working", title: "Working interview", format: "in_person", durationMinutes: 45, status: "cancelled", startsAt: null, endsAt: null, timezone: null, meetingUrl: null, linkSource: "calendar", attempt: 2,
    offeredSlots: [], selectedSlot: null, candidateAvailability: null, schedulingWindow: { fromDate: "2026-10-12", toDate: "2026-10-23" }, rescheduleCountCandidate: 0, outcome: null, decision: null, decisionNote: null, reminders: {}, cancelReason: "cancelled by the candidate", scheduleTokenExpiresAt: null, createdAt: daysAgo(3),
    candidate: { firstName: "Ana", lastName: "Lopez", timezone: null, stage: "interview_recommended", stageLabel: "Recommended for interview" }, participants: [], calendarRefs: {}, followUp: { id: "f1", reason: "asked_new_times", times: "none" },
    ...over,
  });
  const sheet = (i: ReturnType<typeof iv>, extra: Array<[unknown[], unknown]> = []) => {
    nav.params = { id: "iv1" };
    try {
      return text(render(client([], [[["interviews"], [i]], [["interview", "iv1"], { ...i, timeline: [], availabilitySources: [], brief: null }], ...extra]), createElement(Interviews)));
    } finally {
      nav.params = { id: "r1" };
    }
  };

  it("offers Send new times for the same round instead of approving a new interview, and only while nothing is in motion", () => {
    const asked = sheet(iv());
    expect(asked).toContain("Ana cancelled and asked for new times. New times go out for the same round.");
    expect(asked).toContain("Send new times");
    expect(asked).not.toContain("Interview again?");
    const noShow = sheet(iv({ status: "no_show", outcome: "no_show_candidate", candidate: { firstName: "Ana", lastName: "Lopez", timezone: null, stage: "interview_complete", stageLabel: "Interview done: decision needed" }, followUp: { id: "f2", reason: "no_show", times: "none" } }));
    expect(noShow).toContain("Ana did not come. New times go out for the same round.");
    // their new times are already out: the sheet's other cards cover it
    const out = sheet(iv({ followUp: { id: "f1", reason: "asked_new_times", times: "out" } }));
    expect(out).not.toContain("New times go out for the same round.");
    expect(out).toContain("Interview again?");
  });

  it("before ITS confirms the company, never offers a send it would refuse, and does not flag them as needing you", () => {
    const setting = (companyConfirmed: boolean): [unknown[], unknown] => [["new-times-setting"], { auto: true, workingDays: 3, pending: 0, companyConfirmed }];
    const waiting = sheet(iv(), [setting(false)]);
    expect(waiting).toContain("Ana cancelled and asked for new times. You can send new times once ITS confirms your company, or decide.");
    expect(waiting).not.toContain("Send new times");
    expect(waiting).not.toContain("New times go out for the same round.");
    const confirmed = sheet(iv(), [setting(true)]);
    expect(confirmed).toContain("Ana cancelled and asked for new times. New times go out for the same round.");
    expect(confirmed).toContain("Send new times");
  });

  it("names the decision a team send records on a missed interview", () => {
    const sent = sheet(iv({ status: "no_show", outcome: "no_show_candidate", decision: "new_times", decisionNote: "New times sent after the candidate did not attend", candidate: { firstName: "Ana", lastName: "Lopez", timezone: null, stage: "interview_recommended", stageLabel: "Recommended for interview" }, followUp: null }));
    expect(sent).toContain("Decision: New times sent");
    expect(sent).not.toContain("new_times");
  });
});

describe("the job builder's question card (signed-in polish)", () => {
  it("names every radio and checkbox by its option, never by the input's default value", () => {
    const q = { id: "q1", field: "reason_for_hire", prompt: "Why are you hiring?", mode: "single", options: [{ label: "A new position", value: "new_position", origin: "assistant" }, { label: "Replacing someone who left", value: "replacement", origin: "assistant" }], allowOwn: false, why: null };
    const html = render(client([]), createElement(QuestionCard, { questions: [q] as never, state: { index: 0, answers: {} } as never, onState: () => undefined, onSend: () => undefined, onClose: () => undefined, sending: false, pay: { basis: "hourly", stated: null, confirmed: false } as never }));
    expect(html).toContain('aria-label="A new position" name="card-q1" value="new_position"');
    expect(html).toContain('aria-label="Replacing someone who left" name="card-q1" value="replacement"');
  });
});
