import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { INTAKE_ESSENTIALS, INTAKE_ESSENTIAL_LABEL, IntakeFacts, type IntakeQuestion, type IntakeReadiness, type IntakeSessionSummary, type IntakeSessionView, type MembershipRole, type PlanRoom } from "@ros/contracts";
import { jobPacket } from "../../../tests/web/job-fixture";

/**
 * The job builder as the shell first draws it from answers shaped like the API's: the one way in, the conversation with
 * its question cards beside what is known and still needed, and, once the job is written, the job with what still holds
 * publishing. "Write the job" and "Publish job" wait, greyed, for the server's word, and say its reasons.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/new",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { JobBuilder } = await import("@ros/web/src/pages/JobBuilder");
const { QuestionCard } = await import("@ros/web/src/pages/builder/QuestionCard");
const { AI_LINE } = await import("@ros/web/src/pages/builder/Conversation");
const { initialCards, togglePick } = await import("@ros/web/src/builder");
const { ApiError } = await import("@ros/web/src/api/client");

const plain = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const text = (html: string) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const me = (role: MembershipRole) => ({ user: { id: "u1", email: "owner@bright.test", name: "Sam Sample", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", ai: { provider: "fake" } });
const room: PlanRoom = { ok: true, limit: 3, used: 1, holding: [], message: null, ask: null };

const q = (over: Partial<IntakeQuestion> & Pick<IntakeQuestion, "id" | "field" | "mode">): IntakeQuestion => ({ prompt: "A question?", options: [], allowOwn: true, why: "Because.", ...over });
const arrangement = q({ id: "q1", field: "remote_policy", mode: "single", prompt: "Where is the work done?", options: [{ label: "On site", value: "onsite", origin: "assistant" }, { label: "Hybrid", value: "hybrid", origin: "owner" }] });
const must = q({ id: "q2", field: "must_haves", mode: "multi", prompt: "What must they have?", options: [{ label: "Active RDA licence", value: "Active RDA licence", origin: "assistant" }, { label: "Two years chairside", value: "Two years chairside", origin: "assistant" }] });
const pay = q({ id: "q3", field: "compensation", mode: "pay", prompt: "What does the job pay?" });

const readiness = (done: Partial<Record<(typeof INTAKE_ESSENTIALS)[number], string>>, over: Partial<IntakeReadiness> = {}): IntakeReadiness => {
  const essentials = INTAKE_ESSENTIALS.map((key) => ({ key, label: INTAKE_ESSENTIAL_LABEL[key], done: key in done, value: done[key] ?? null }));
  const missing = essentials.filter((e) => !e.done).map((e) => e.key);
  return { essentials, missing, payConfirmed: "compensation_range" in done, mayDraft: missing.length === 0, draftBlocker: missing.length ? "Still needed before the job can be written: the pay and a must-have." : null, hasDraft: false, draftOutOfDate: false, draftEdits: 0, openFlags: 0, publish: { allowed: false, blockers: [{ code: "no_draft", message: "Write the job first." }] }, ...over };
};
const session = (over: Partial<IntakeSessionView> = {}): IntakeSessionView => ({
  id: "s1", status: "active", roleId: null, createdAt: "2026-11-18T10:00:00.000Z", updatedAt: "2026-11-18T10:05:00.000Z", startedBy: { userId: "u1", name: "Sam Sample", mine: true },
  messages: [{ role: "owner", content: "A dental assistant for our Irvine office.", at: "2026-11-18T10:00:00.000Z" }, { role: "assistant", content: "Got it. A few questions.", at: "2026-11-18T10:00:05.000Z" }],
  facts: IntakeFacts.parse({ title: "Dental Assistant", locationText: "Irvine, CA" }), questions: [arrangement, must, pay],
  readiness: readiness({ title: "Dental Assistant", location: "Irvine, CA" }), pay: { basis: null, stated: { min: null, max: null }, confirmed: null, summary: "Not set yet" },
  draft: null, flags: [], legalCheck: null, closesOn: null, ad: null, progress: null, ...over,
});
const everything = { title: "Dental Assistant", location: "Irvine, CA", remote_policy: "On site", compensation_range: "$24–$28 an hour", employment_type: "Full time", schedule: "Weekdays", must_haves: "2 must-haves" };
const written = (over: Partial<IntakeSessionView> = {}, ready: Partial<IntakeReadiness> = {}) => session({ questions: [], draft: jobPacket(), readiness: readiness(everything, { hasDraft: true, publish: { allowed: true, blockers: [] }, ...ready }), pay: { basis: "hourly", stated: { min: 24, max: 28 }, confirmed: { byName: "Sam Sample", at: "2026-11-18T10:04:00.000Z", via: "pay_card" }, summary: "$24–$28 an hour" }, ...over });

function client(role: MembershipRole, seed: Array<[unknown[], unknown]> = []): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me(role));
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const builder = (view: IntakeSessionView, role: MembershipRole = "owner") => {
  nav.search = `session=${view.id}`;
  return render(client(role, [[["intake", "session", view.id], { session: view }]]), createElement(JobBuilder));
};
/** The page's one main button, as drawn. */
const mainButton = (html: string) => /<button type="button" class="btn primary"([^>]*)>(Write the job|Publish job)<\/button>/.exec(html);

describe("the builder's first page", () => {
  const drafts = (sessions: IntakeSessionSummary[], r: PlanRoom = room) => {
    nav.search = "";
    return render(client("owner", [[["intake", "sessions", "mine"], { sessions, room: r }]]), createElement(JobBuilder));
  };

  it("is one way in: a box for a sentence or a pasted job ad, the line that an AI assistant drafts and a person decides, and this person's drafts", () => {
    const html = drafts([{ id: "s9", status: "active", title: "Front Desk Lead", startedBy: { userId: "u1", name: "Sam Sample" }, mine: true, createdAt: "", updatedAt: new Date().toISOString(), ownerMessages: 1, hasDraft: false, missing: ["must_haves"] }]);
    expect(html).toContain("<h1>Who are you hiring?</h1>");
    expect(html).toMatch(/<textarea[^>]*placeholder="For example: a dental assistant for our Irvine office, full time, \$24 to \$28 an hour"[^>]*aria-label="Describe the job, or paste a job ad"|<textarea[^>]*aria-label="Describe the job, or paste a job ad"[^>]*placeholder="For example: a dental assistant for our Irvine office, full time, \$24 to \$28 an hour"/);
    expect(text(html)).toContain(AI_LINE);
    expect(AI_LINE).toBe("You are talking with an AI assistant. It drafts; you decide. Nothing is posted until you publish the job.");
    expect(html).toMatch(/<a href="\/roles\/new\?session=s9" class="list-row-title[^"]*">Front Desk Lead<\/a>/);
    // nothing else to choose: no templates, no quick questions, no hire again
    const words = text(html);
    for (const gone of ["Quick start", "template", "Hire again", "Answer a few questions"]) expect(words.toLowerCase(), gone).not.toContain(gone.toLowerCase());
    expect(html.match(/<textarea/g)).toHaveLength(1);
  });

  it("holds the box with the plan's own line when there is no room for another job, with the request the plan's room carries", () => {
    const full: PlanRoom = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", ask: { label: "Upgrade", reason: "We would like to post more jobs." }, upgrade: true };
    const html = drafts([], full);
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more. Upgrade");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toContain("<h2>Your drafts</h2>");
    // the button says the room's own words: once the trial has ended, the way on is ITS choosing a plan
    const ended = drafts([], { ok: false, limit: 3, used: 1, holding: [], message: "Your trial has ended.", ask: { label: "Ask ITS to choose a plan", reason: "Our trial has ended. We would like to choose a plan." }, trialEnded: true });
    expect(text(ended)).toContain("Your trial has ended. Ask ITS to choose a plan");
    expect(ended).not.toContain(">Upgrade</button>");
  });
});

describe("a draft being built", () => {
  it("shows the conversation with the question cards in its dock, and beside it what is known and what is still needed", () => {
    const html = builder(session());
    expect(html).toContain("<h1>Dental Assistant</h1>");
    expect(html).toContain('<span class="pill caution sm"><span class="dot" aria-hidden="true"></span>Draft</span>');
    const words = text(html);
    expect(words).toContain(AI_LINE);
    expect(words).toContain("A dental assistant for our Irvine office.");
    expect(words).toContain("Got it. A few questions.");
    // the first card of three
    expect(html).toContain('aria-label="Questions from the assistant"');
    expect(words).toContain("Pick one 1 of 3");
    expect(words).toContain("Where is the work done?");
    // the server's list, as two lists
    expect(words).toContain("What we know Job title : Dental Assistant");
    expect(words).toMatch(/Still needed .*Pay/);
    expect(html).not.toContain(">Edit</button>");
  });

  it("keeps Write the job greyed but pressable until the server says it may run, with its reason read beside it", () => {
    const html = builder(session());
    const main = mainButton(html);
    expect(main?.[2]).toBe("Write the job");
    expect(main?.[1]).toContain('aria-disabled="true"');
    expect(main?.[1]).not.toContain('disabled=""');
    const helpId = /aria-describedby="([^"]+)"/.exec(main?.[1] ?? "")?.[1];
    expect(html).toContain(`<div id="${helpId}" class="sr-only">`);
    expect(text(html)).toContain("Still needed before the job can be written: the pay and a must-have.");
    // every essential in, the pay confirmed by a person: the button is ready, and the conversation offers it too
    const ready = builder(session({ questions: [], readiness: readiness(everything) }));
    expect(mainButton(ready)?.[1]).not.toContain("aria-disabled");
    expect(text(ready)).toContain("Everything needed is in. Write the job");
    expect(ready.match(/>Write the job<\/button>/g)).toHaveLength(2);
  });

  it("says who started a teammate's draft, and offers to take it over only to an owner or an admin", () => {
    const theirs = session({ startedBy: { userId: "u2", name: "Alex Example", mine: false } });
    const owner = builder(theirs, "owner");
    expect(text(owner)).toContain("Alex Example started this draft. Take it over");
    const member = builder(theirs, "hiring_manager");
    expect(text(member)).toContain("Alex Example started this draft.");
    expect(member).not.toContain(">Take it over</button>");
  });

  it("says a draft that became a job, was discarded or is not there, each with one way on", async () => {
    expect(builder(session({ status: "compiled", roleId: "r7" }))).toContain('<a href="/roles/r7" class="btn primary">Open the job</a>');
    const discarded = builder(session({ status: "abandoned" }));
    expect(text(discarded)).toContain("This draft was discarded");
    expect(discarded).toContain('<a href="/roles/new" class="btn primary">Start a hire</a>');
    nav.search = "session=gone";
    const qc = client("owner");
    await qc.prefetchQuery({ queryKey: ["intake", "session", "gone"], queryFn: () => Promise.reject(new ApiError(404, "not_found", "Not found.")) });
    expect(text(render(qc, createElement(JobBuilder)))).toContain("We could not find that draft");
  });
});

describe("a question card", () => {
  const card = (questions: IntakeQuestion[], state = initialCards()) => renderToStaticMarkup(createElement(QuestionCard, { questions, state, onState: () => undefined, onSend: () => undefined, onClose: () => undefined, onTypeInstead: () => undefined, sending: false, pay: { basis: null, stated: { min: null, max: null }, confirmed: null, summary: "Not set yet" } }));

  it("names every radio and checkbox by its option, never by the input's default value, and ticks nothing for the person", () => {
    const one = card([arrangement]);
    expect(one).toMatch(/<input type="radio"(?=[^>]*name="card-q1")(?=[^>]*aria-label="On site")(?=[^>]*value="onsite")[^>]*\/>/);
    expect(one).toMatch(/<input type="radio"(?=[^>]*name="card-q1")(?=[^>]*aria-label="Hybrid")(?=[^>]*value="hybrid")[^>]*\/>/);
    expect(one.match(/<input type="radio"[^>]*\/>/g)?.every((input) => /value="(onsite|hybrid)"/.test(input) && /aria-label="[^"]+"/.test(input))).toBe(true);
    expect(one).not.toContain('checked=""');
    const any = card([must]);
    expect(any).toMatch(/<input type="checkbox"(?=[^>]*name="card-q2")(?=[^>]*aria-label="Active RDA licence")[^>]*\/>/);
    expect(any.match(/type="checkbox"/g)).toHaveLength(2);
    // an idea of the assistant's own says so; the person's own words do not
    expect(one.match(/Suggested by the AI assistant/g)?.length).toBe(2);
    expect(one).toMatch(/<legend class="sr-only">Where is the work done\?<\/legend>/);
  });

  it("shows a pick once it is made, sends on the last card, and offers typing instead", () => {
    const picked = card([arrangement, must], togglePick(initialCards(), arrangement, "hybrid"));
    expect(picked.match(/<input type="radio"[^>]*checked=""[^>]*\/>/g)).toHaveLength(1);
    expect(picked).toMatch(/<input type="radio"(?=[^>]*aria-label="Hybrid")(?=[^>]*checked="")[^>]*\/>/);
    expect(text(picked)).toContain("1 answered");
    expect(picked).toMatch(/>Next<svg/);
    expect(card([arrangement])).toMatch(/>Send<svg/);
    expect(picked).toContain(">Or type your own answer…</button>");
    expect(picked).toContain("<summary>Why we ask</summary>");
  });

  it("draws the pay card as two boxes and a choice of by the hour or a yearly salary; nothing suggests a figure", () => {
    const html = card([pay]);
    expect(text(html)).toContain("Set the pay");
    expect([...html.matchAll(/<button type="button" class="" aria-pressed="false">([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["By the hour", "A yearly salary"]);
    expect(html).toContain('<label for="card-q3-min">Lowest</label>');
    expect(html).toContain('<label for="card-q3-max">Highest</label>');
    expect(html).toMatch(/<input id="card-q3-min" class="input" inputMode="decimal" placeholder="e\.g\. 24" value=""\/>/);
  });
});

describe("a written job, before it is published", () => {
  it("shows the job itself with one Edit and the way to see the job page, and Publish job ready when the server says so", () => {
    const html = builder(written());
    expect(mainButton(html)?.[2]).toBe("Publish job");
    expect(mainButton(html)?.[1]).not.toContain("aria-disabled");
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(expect.arrayContaining(["Job description", "Details", "Requirements", "Skills", "Screening questions", "AI interview (about 10 minutes)"]));
    expect(html).toMatch(/<button type="button" class="btn secondary sm"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Edit<\/button>/);
    expect(html).toContain('href="/api/v1/intake/sessions/s1/preview/page" target="_blank"');
    expect(text(html)).not.toContain("Before you can publish");
    // no cards left: the message box is back
    expect(html).toMatch(/<textarea[^>]*aria-label="Message to the assistant"/);
  });

  it("lists every reason the server gives for not publishing yet, and holds Publish job greyed", () => {
    const html = builder(written({}, { publish: { allowed: false, blockers: [{ code: "legal_check", message: "Add the benefits: California asks for them." }, { code: "open_flags", message: "Change or keep the flagged wording first." }] } }));
    expect(mainButton(html)?.[1]).toContain('aria-disabled="true"');
    expect(text(html)).toContain("Before you can publish Add the benefits: California asks for them. Change or keep the flagged wording first.");
  });

  it("shows flagged wording with its reason, the alternative, and the two ways on: change it, or keep it with a reason", () => {
    const flag = { id: "f1", path: "description.publicJobDescription", rule: "age", text: "young and energetic", reason: "It can stand in for age.", alternative: "energetic" };
    const html = builder(written({ flags: [flag, { ...flag, id: "f2", text: "digital native", kept: { reason: "It is the course's own name.", by: { kind: "user", id: "u1" }, at: "2026-11-18T10:00:00.000Z" } }] as never }, { openFlags: 1 }));
    const words = text(html);
    expect(words).toContain("Check this wording before publishing \"young and energetic\" It can stand in for age. Instead: energetic Change the wording Keep it…");
    // a phrase already kept with a reason holds nothing
    expect(words).not.toContain("digital native");
  });

  it("says when the answers changed since it was written, and warns before writing again replaces saved edits", () => {
    const html = builder(written({}, { draftOutOfDate: true, draftEdits: 2 }));
    expect(text(html)).toContain("Your answers changed after the job was written. Write the job again");
    // the page's main button stays Publish job: writing again is asked for where its warning is
    expect(mainButton(html)?.[2]).toBe("Publish job");
  });

  it("lets an owner set the closing date before publishing, and shows a member the date alone", () => {
    const owner = builder(written({ closesOn: "2026-11-30" }), "owner");
    expect(owner).toMatch(/<input id="draft-closes-on" class="input[^"]*" type="date"[^>]*value="2026-11-30"\/>/);
    expect(owner).toContain(">Take the date off</button>");
    const member = builder(written({ closesOn: "2026-11-30" }), "hiring_manager");
    expect(member).not.toContain('id="draft-closes-on"');
    expect(text(member)).toContain("Last day to apply: November 30, 2026");
  });

  it("shows what the law of the job's places asks of the ad, item by item, as the server checked it", () => {
    const item = { key: "benefits" as const, label: "Benefits", met: false, blocking: true, jurisdictions: ["US-CA"], pendingCounsel: [], detail: "California asks the ad to describe the benefits.", fix: "Add a benefits line in the editor." };
    const html = builder(written({ legalCheck: { jurisdictions: ["US-CA"], remote: false, items: [{ ...item, key: "pay_range", label: "Pay range", met: true, detail: "Shown on the job page.", fix: null }, item], missing: [item] } }));
    const words = text(html);
    expect(words).toContain("Legal check");
    expect(words).toContain("Pay range Shown on the job page.");
    expect(words).toContain("Benefits California asks the ad to describe the benefits. Add a benefits line in the editor.");
  });
});
