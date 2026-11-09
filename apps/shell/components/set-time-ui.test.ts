import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * "Set a date and time" as the shell first draws it (the owner's words, 6 November 2026: "nadine sets date and time from
 * the shortlisted candidates and he/she will get the mail"): the form on a candidate's panel, its button and why it is
 * greyed, what it says about the email before the press, the card for an interview with no time, and the Interviews page
 * with one word per interview worked out from what is true of it, and the same form on its sheet. Nothing here promises
 * times nobody has the hours for, and nothing says "Waiting on the candidate" when nothing reached them.
 */
const nav = vi.hoisted(() => ({ params: { id: "iv1" } as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/interviews/iv1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");
const { Interviews } = await import("@ros/web/src/pages/Interviews");
const { SetTimeForm } = await import("@ros/web/src/components/SetTimeForm");
const { freshForm } = await import("@ros/web/src/interview-time");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const owner = (role = "owner") => ({ user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
const confirmed = { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" }, timezone: "America/Chicago" };
const waiting = { settings: {}, timezone: "America/Chicago" };

function client(data: Array<[unknown[], unknown]>, opts: { company?: unknown; role?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], owner(opts.role));
  qc.setQueryData(["company"], opts.company ?? confirmed);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}

const shortlist = { id: "m1", mark: "shortlist", label: "Shortlist", remindAt: null, note: null, source: "person", setAt: daysAgo(1), setBy: { kind: "user", id: "u1" } };
const maria = (over: Record<string, unknown> = {}) => ({
  id: "a1", roleId: "r1", stage: "screen_complete", stageLabel: "AI interview done", group: "waiting_on_you", source: "careers_page", createdAt: daysAgo(4), ownerStage: "shortlist", ownerStageLabel: "Shortlist", mark: shortlist, tags: [], stageMoves: [], toldState: null, cancelled: null, score: null,
  eligibility: { passed: true, failedRules: [], unverifiable: [] }, candidateToldAt: null, rejectReason: null, rejectNote: null, declineMessage: "sends", allowedActions: ["interview", "reject", "record_outcome", "set_mark"], blockedReasons: {}, interviews: [],
  interviewPlan: [{ key: "r1", title: "Working interview", durationMinutes: 30, format: "video", interviewerUserIds: [], purpose: "" }],
  candidate: { firstName: "Maria", lastName: "Reyes", email: "maria@example.com", phone: null, locationText: "Tustin, CA", consent: {}, preferences: {} },
  documents: [], screens: [], communications: [], extraction: null, answers: {}, assessments: [], pendingApprovals: [], packetLabels: { mustHaves: [], competencies: [], questions: [] }, timeline: [],
  ...over,
});
const plan = { version: 1, status: "approved", rounds: [{ key: "r1", title: "Working interview", purpose: "", durationMinutes: 30, format: "video", interviewerRoles: [], interviewers: [] }], team: [] };
const members = (schedulable: boolean) => [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", role: "owner", status: "active", schedulable, calendar: null }];
const panel = (d: ReturnType<typeof maria>, opts: { step?: "interview" | null; schedulable?: boolean; company?: unknown; role?: string } = {}) =>
  render(client([[["application", "a1"], d], [["interview-plan", "r1"], plan], [["members"], members(!!opts.schedulable)]], opts), createElement(CandidatePanel, { id: "a1", roleId: "r1", tab: "overview", onTab: () => undefined, step: opts.step ?? null, onStep: () => undefined, ids: ["a1"], onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));

describe("Set a date and time on a candidate's panel", () => {
  it("is the form itself, with few words: the day, the time on the company's clock, how long, where, and one button", () => {
    const html = panel(maria(), { step: "interview" });
    const t = text(html);
    expect(html).toMatch(/<section class="card needs-you lift grid gap-3 p-5 sm:p-6 \[&amp;&gt;\.card-title\]:mb-0"><div class="card-title"><h2>Set a date and time<\/h2><\/div>/);
    // native controls, the company's zone named beside the time, the round's own length chosen
    expect(html).toMatch(/<label for="iv-date">Date<\/label><input id="iv-date" class="input" type="date" min="\d{4}-\d{2}-\d{2}" value=""\/>/);
    expect(html).toContain('<label for="iv-time">Time (America/Chicago)</label><input id="iv-time" class="input" type="time" value=""/>');
    expect(html).toContain('<option value="30" selected="">30 minutes</option>');
    expect(html).toMatch(/<legend class="small muted mb-2">Where<\/legend>/);
    expect(html).toContain('<label class="option-row"><input type="radio" name="iv-place" checked="" value="link"/><span class="min-w-0">Video link</span></label>');
    expect(t).toContain("Address");
    expect(t).toContain("By phone");
    // a round of one: no Round field; who interviews is folded, the person pressing ticked when the plan names nobody
    expect(html).not.toContain('id="iv-round"');
    expect(html).toContain('<summary id="iv-with">With Dana Whitfield</summary>');
    expect(html).toContain('<input type="checkbox" checked=""/><span class="min-w-0 wrap-anywhere">Dana Whitfield</span>');
    // greyed with its reason beside it, still a button a press can reach (it takes the keyboard to the date)
    expect(html).toContain('<button type="submit" class="btn primary sm" aria-busy="false" aria-disabled="true" aria-describedby="iv-missing">Book and email Maria</button>');
    expect(html).toContain('<p id="iv-missing" class="small muted">Choose a date and a time.</p>');
    expect(t).toContain("Not now");
    // nobody's hours are needed, so the old way is not offered without them, and nothing promises times
    expect(t).not.toContain("Or let them pick from your free times");
    expect(t).not.toMatch(/Approve|times go out|Times go out|no calendar or hours yet|availability known/);
  });

  it("keeps the old way one fold away, under the button, only where every interviewer has hours", () => {
    const t = text(panel(maria(), { step: "interview", schedulable: true }));
    expect(t).toContain("Or let them pick from your free times");
    expect(t).toContain("Maria gets times from the interviewers' hours by email and picks one.");
    expect(t).toContain("Offer times to pick from");
    expect(t.indexOf("Book and email Maria")).toBeLessThan(t.indexOf("Or let them pick from your free times"));
  });

  it("says Book, not Book and email, while the email would wait for the ITS check, and offers the round only when there are several", () => {
    const two = maria({ interviewPlan: [{ key: "r1", title: "Working interview", durationMinutes: 30, format: "video", interviewerUserIds: [], purpose: "" }, { key: "r2", title: "Meet the dentist", durationMinutes: 45, format: "onsite", interviewerUserIds: [], purpose: "" }] });
    const html = panel(two, { step: "interview", company: waiting });
    expect(html).toContain('aria-describedby="iv-missing">Book</button>');
    expect(html).toContain('<label for="iv-round">Round</label><select id="iv-round" class="select"><option value="r1" selected="">Working interview</option><option value="r2">Meet the dentist</option></select>');
  });

  it("on the shortlist the main button is Set a date and time; on New the next step offers Shortlist first", () => {
    const t = text(panel(maria()));
    expect(t).toContain("Ready to interview Maria is on your shortlist. Set a date and time");
    expect(t).not.toContain("Book and email");
  });
});

describe("the form once filled in", () => {
  const filled = { ...freshForm({ durationMinutes: 45, format: "onsite" }), date: "2030-11-12", time: "14:30", address: "120 Main Street, Tustin" };
  const form = (props: Record<string, unknown>, company: unknown = confirmed) => text(render(client([], { company }), createElement(SetTimeForm, { idBase: "t", firstName: "Maria", hasEmail: true, phone: null, timeZone: "America/Chicago", form: filled, onChange: () => undefined, roundMinutes: 45, submit: async () => ({}) as never, onDone: () => undefined, ...props })));

  it("says the time back on the company's clock, by name, and wakes the button", () => {
    const t = form({});
    expect(t).toContain("Tuesday, November 12, 2030 at 2:30 PM, America/Chicago");
    expect(t).toContain("Book and email Maria");
    expect(t).not.toContain("Choose a date");
  });

  it("says before the press when no email can go: the ITS check holds it, or there is no address", () => {
    expect(form({}, waiting)).toContain("Book The email to Maria waits for ITS to confirm your company.");
    expect(form({ hasEmail: false })).toContain("Book There is no email address on file: tell them yourself.");
    expect(form({})).not.toContain("waits for ITS");
  });

  it("asks for an optional reason when a booked time moves, which the candidate reads", () => {
    const t = form({ moving: true });
    expect(t).toContain("Reason (optional, Maria sees it)");
    expect(t).toContain("Move and email Maria");
  });

  it("says who calls whom by phone, from what is on file", () => {
    const phone = { ...filled, place: "phone" };
    expect(form({ form: phone })).toContain("The email asks Maria for a number to call.");
    expect(form({ form: phone, phone: "(714) 555-0100" })).toContain("You call Maria at (714) 555-0100.");
    expect(form({ form: phone, phone: undefined })).toContain("The email tells Maria you will call them.");
  });
});

describe("an interview with no time, on the panel", () => {
  const iv = (over: Record<string, unknown> = {}) => ({ id: "iv1", roundKey: "r1", title: "Working interview", format: "video", durationMinutes: 30, status: "proposed", startsAt: null, endsAt: null, timezone: "America/Chicago", meetingUrl: null, attempt: 1, outcome: null, decision: null, offeredSlots: [], createdAt: daysAgo(2), candidateEmail: null, ...over });
  const at = (interviews: unknown[]) => maria({ stage: "interview_recommended", ownerStage: "interviewing", mark: null, interviews, allowedActions: ["reject", "record_outcome"] });

  it("is never left with nothing to press: Set a date and time, on that interview", () => {
    const t = text(panel(at([iv()])));
    expect(t).toContain("The working interview has no time yet Set a date and time Open the interview");
    expect(panel(at([iv()]))).toContain('<a href="/interviews/iv1" class="btn quiet sm">Open the interview</a>');
    // where things stand says the same word as the Interviews page, never the raw status
    expect(t).toContain("Working interview · No time yet");
    expect(t).not.toMatch(/· proposed|Preparing times/);
  });

  it("says when the times never reached them, and never Waiting on the candidate", () => {
    const slots = [{ id: "s1", startsAt: inDays(3), endsAt: inDays(3), interviewerUserIds: ["u1"], source: "declared" }];
    const t = text(panel(at([iv({ status: "scheduling", offeredSlots: slots, candidateEmail: "failed" })])));
    expect(t).toContain("The times did not reach Maria The email to Maria could not be delivered. Tell them yourself. Set a date and time");
    expect(t).toContain("Working interview · Email failed · The times did not reach them");
    expect(t).not.toContain("Waiting on the candidate");
    // times that did reach them wait on the candidate, and nothing waits on a person
    const out = text(panel(at([iv({ status: "scheduling", offeredSlots: slots })])));
    expect(out).toContain("Working interview · Waiting on the candidate · 1 time offered");
    expect(out).not.toContain("Set a date and time");
  });

  it("is offered only to those who manage interviews", () => {
    expect(text(panel(at([iv()]), { role: "hr" }))).not.toContain("Set a date and time");
  });

  it("a booked time says what became of its email", () => {
    const t = text(panel(at([iv({ status: "scheduled", startsAt: "2030-11-12T20:30:00.000Z", candidateEmail: "held" })])));
    expect(t).toContain("Working interview · Scheduled · Tue, Nov 12, 2:30 PM · Email waits for the ITS check");
  });
});

describe("the Interviews page", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    id: "iv1", applicationId: "a1", roleId: "r1", roleTitle: "Dental Hygienist", roundKey: "r1", title: "Working interview", format: "video", durationMinutes: 30, status: "proposed", startsAt: null, endsAt: null, timezone: "America/Chicago", meetingUrl: null, linkSource: "calendar", attempt: 1,
    offeredSlots: [], selectedSlot: null, candidateAvailability: null, schedulingWindow: { fromDate: "2026-11-10", toDate: "2026-11-23" }, rescheduleCountCandidate: 0, outcome: null, decision: null, decisionNote: null, reminders: {}, cancelReason: null, scheduleTokenExpiresAt: null, createdAt: daysAgo(1),
    candidate: { firstName: "Maria", lastName: "Reyes", timezone: null, hasEmail: true, stage: "interview_recommended", stageLabel: "Interview to set up" }, participants: [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", status: "invited" }], calendarRefs: {}, followUp: null, candidateEmail: null,
    timeline: [], availabilitySources: [{ userId: "u1", source: "none" as string, calendarStatus: null }], brief: null,
    ...over,
  });
  const slots = [1, 2, 3].map((n) => ({ id: `s${n}`, startsAt: inDays(n + 1), endsAt: inDays(n + 1), interviewerUserIds: ["u1"], source: "declared" }));
  const page = (i: ReturnType<typeof base>, list: unknown[] = [i], company: unknown = confirmed) => render(client([[["interviews"], list], [["interview", "iv1"], i]], { company }), createElement(Interviews));

  it("gives each interview one word from what is true of it", () => {
    const rows = [
      base({ id: "p1" }),
      base({ id: "p2", status: "scheduling", offeredSlots: slots, candidateEmail: "failed" }),
      base({ id: "p3", status: "scheduling", offeredSlots: slots }),
      base({ id: "p4", status: "scheduled", startsAt: inDays(5), candidateEmail: "failed" }),
    ];
    nav.params = {};
    const html = render(client([[["interviews"], rows]]), createElement(Interviews));
    const t = text(html);
    expect(html).toContain('<span class="pill caution sm"><span class="dot" aria-hidden="true"></span>No time yet</span>');
    expect(t).toContain("Email failed");
    expect(t).toContain("The times did not reach them");
    expect(t).toContain("Waiting on the candidate");
    expect(t).toContain("3 times offered");
    expect(t).toContain("Email not delivered");
    expect(t).not.toContain("Preparing times");
    // while ITS has not confirmed the company, times out wait for it, not for the candidate
    const held = text(render(client([[["interviews"], [rows[2]]]], { company: waiting }), createElement(Interviews)));
    expect(held).toContain("Waiting for the ITS check");
    expect(held).not.toContain("Waiting on the candidate");
    nav.params = { id: "iv1" };
  });

  it("an interview with no time: the sheet's first card is the same form, posting to that interview", () => {
    const html = page(base());
    const t = text(html);
    expect(t).toContain("No time yet");
    expect(html).toMatch(/<section class="card needs-you sm:p-5"><div class="card-title"><h2>Set the date and time<\/h2><\/div><form class="grid gap-3" novalidate="">/i);
    expect(html).toContain('<label for="set-iv1-time">Time (America/Chicago)</label>');
    expect(t).toContain("Book and email Maria");
    // Change it: only Cancel here; the old way not offered with nobody's hours
    expect(t).toContain("Cancel interview");
    expect(t).not.toContain("Move it");
    expect(t).not.toContain("Offer new times");
    // hours are optional now: never a warning for having none
    expect(t).toContain("no hours set");
    expect(html).not.toContain('class="chip caution">no availability');
  });

  it("a time a person set: Move it and Cancel interview, its place, and no hours or window that never mattered", () => {
    const booked = base({ status: "scheduled", startsAt: "2030-11-12T20:30:00.000Z", endsAt: "2030-11-12T21:00:00.000Z", format: "onsite", selectedSlot: { id: "x", startsAt: "2030-11-12T20:30:00.000Z", endsAt: "2030-11-12T21:00:00.000Z", interviewerUserIds: ["u1"], source: "person", address: "120 Main Street, Tustin" }, participants: [{ userId: "u1", name: "Dana Whitfield", email: "dana@bright.test", status: "confirmed" }] });
    const t = text(page(booked));
    expect(t).toContain("Scheduled");
    expect(t).toContain("Where 120 Main Street, Tustin");
    expect(t).toContain("Move it");
    expect(t).toContain("Cancel interview");
    expect(t).not.toContain("Set the date and time");
    expect(t).not.toContain("Window");
    expect(t).not.toContain("no hours set");
    // what became of its email, said once on the sheet
    const failed = text(page({ ...booked, candidateEmail: "failed" }));
    expect(failed).toContain("The email to Maria could not be delivered. Tell them yourself.");
    const noEmail = text(page({ ...booked, candidateEmail: "no_email" }));
    expect(noEmail).toContain("There is no email address on file: tell them yourself.");
  });

  it("times that lapsed get the form too, while it is their newest interview", () => {
    const lapsed = base({ status: "offer_expired", offeredSlots: slots, createdAt: daysAgo(3) });
    expect(text(page(lapsed))).toContain("Set the date and time");
    // a newer interview set up since: nothing to set here
    const newer = base({ id: "iv2", status: "scheduled", startsAt: inDays(4), createdAt: daysAgo(1) });
    expect(text(page(lapsed, [lapsed, newer]))).not.toContain("Set the date and time");
  });

  it("after a cancellation, the way on is Set a new date and time", () => {
    const t = text(page(base({ status: "cancelled", cancelReason: "Clash" })));
    expect(t).toContain("Interview again? This interview was cancelled. Set a new date and time");
    expect(t).not.toMatch(/approve a new interview|fresh times go out/i);
  });
});
