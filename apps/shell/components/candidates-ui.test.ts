import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_BLOCKED, candidateActions, cvScoreOf, cvScoreSummary, interviewScoreOf, interviewScoreSummary, noCvScore, noInterviewScore,
  type CandidateActionFacts, type CandidateList, type CandidatePanel as PanelView, type CandidateRow, type CandidateTab, type ScoredRequirement,
} from "@ros/contracts";
import { jobCounts, jobDetail } from "../../../tests/web/job-fixture";

/**
 * A job's Candidates tab, Candidates in the rail and the candidate panel, as the shell first draws them from answers
 * shaped like the API's. The actions are made with the contracts' own rule (`candidateActions`), as the API makes them:
 * the page draws a button for each action it is given, greyed with the reason when it is not allowed, and nothing for
 * an action it is not given.
 */
const nav = vi.hoisted(() => ({ path: "/roles/r1/talent", params: { id: "r1" } as Record<string, string>, search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Candidates } = await import("@ros/web/src/pages/Candidates");
const { SelectionBar } = await import("@ros/web/src/pages/candidates/CandidateList");
const { CandidatePanel } = await import("@ros/web/src/pages/candidates/CandidatePanel");
const { bulkButtons } = await import("@ros/web/src/candidates");
const { ApiError } = await import("@ros/web/src/api/client");

const plain = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const text = (html: string) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
/** A sentence as it is written inside an attribute. */
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const req = (key: string, label: string, mustHave: boolean, finding: ScoredRequirement["finding"], quote: string | null = null): ScoredRequirement => ({ key, label, mustHave, importance: mustHave ? null : "important", finding, quote, source: quote ? "resume" : null });
const strong = cvScoreOf([req("m1", "Active RDA licence", true, "shown", "RDA licence, renewed 2025"), req("m2", "Two years chairside", true, "shown", "three years chairside"), req("s1", "Digital radiography", false, "partly")]);
const missing = cvScoreOf([req("m1", "Active RDA licence", true, "not_met", "my licence lapsed in 2023"), req("m2", "Two years chairside", true, "shown", "three years chairside"), req("s1", "Digital radiography", false, "shown", "digital x-rays daily")]);
const interview = interviewScoreOf([{ key: "q1", question: "Tell us about a busy day.", finding: "shown", quote: "we saw forty patients", note: "A concrete example." }, { key: "q2", question: "How do you sterilise instruments?", finding: "partly", quote: null, note: null }]);

const facts = (over: Partial<CandidateActionFacts>): CandidateActionFacts => ({ stage: "triaged", aiInterview: null, toldState: null, decisionEmailWaiting: false, reachable: true, remindedRecently: false, roleStatus: "open", planStop: null, ...over });
const row = (id: string, name: string, over: Partial<CandidateRow> = {}): CandidateRow => ({
  id, name, appliedAt: daysAgo(2), stage: "triaged", tab: "new", label: "New", cvScore: cvScoreSummary(strong), interviewScore: null, aiInterview: null, flags: [], toldState: null, toldLabel: null, actions: candidateActions(facts({})), ...over,
});
const rows = [
  row("a1", "Alex Example", { flags: ["Answered No: Can you work Saturdays?"] }),
  row("a2", "Blake Sample", { cvScore: cvScoreSummary(missing) }),
  row("a3", "Casey Placeholder", { stage: "received", cvScore: cvScoreSummary(noCvScore("being_read")), actions: candidateActions(facts({ stage: "received" })) }),
];
const list = (tab: CandidateTab, people: CandidateRow[], over: Partial<CandidateList> = {}): CandidateList => ({
  role: { id: "r1", title: "Dental Assistant", status: "open", version: 2 }, tab, counts: jobCounts({ new: 3, shortlisted: 1, interviewed: 1, not_selected: 2 }), rows: people, locked: { count: 0, cards: [] }, ...over,
});

function client(seed: Array<[unknown[], unknown]> = []): QueryClient {
  // retryOnMount off: an answer that was a refusal is drawn as it stands, as the browser draws it once it has arrived
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["role", "r1"], jobDetail("r1", "open", "owner", { counts: jobCounts({ new: 3, shortlisted: 1, interviewed: 1, not_selected: 2 }) }));
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
function page(tab: CandidateTab, data: CandidateList, search = tab === "new" ? "" : `tab=${tab}`): string {
  nav.path = "/roles/r1/talent";
  nav.params = { id: "r1" };
  nav.search = search;
  return render(client([[["candidates", "r1", tab], data]]), createElement(Candidates));
}
/** One row of the list, cut out by the application it is for. */
const rowOf = (html: string, id: string) => html.slice(html.indexOf(`data-application="${id}"`)).split("</li>")[0];

describe("a job's Candidates tab", () => {
  it("shows the job's header and tabs, the five tabs with their counts, and the people in the order received", () => {
    const html = page("new", list("new", rows));
    const words = text(html);
    expect(words).toContain("Dental Assistant");
    // the job's own tabs are links, Candidates the current one, with how many applied
    expect(html).toMatch(/<a href="\/roles\/r1\/talent" class="tab" aria-current="page"><span class="tab-label" data-label="Candidates">Candidates<\/span> <span class="count">7<\/span><\/a>/);
    expect(html).toContain('<a href="/roles/r1" class="tab">');
    expect(html).toContain('<a href="/roles/r1?tab=share" class="tab">');
    // the five tabs, in the API's words and order, each with its count
    const tabs = [...html.matchAll(/role="tab"[^>]*>(?:(?!<\/button>)[\s\S])*?data-label="([^"]+)"(?:(?!<\/button>)[\s\S])*?<span class="count">(\d+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(tabs).toEqual(["New 3", "Shortlisted 1", "Interviewed 1", "Hired 0", "Not selected 2"]);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>(?:(?!<\/button>)[\s\S])*?data-label="New"/);
    // the rows, in the order the API sent them (it ranks; the page never sorts)
    expect([...html.matchAll(/data-application="([^"]+)"/g)].map((m) => m[1])).toEqual(["a1", "a2", "a3"]);
    expect(html).toContain('<ul class="list-card" aria-label="New candidates">');
  });

  it("gives each row a tick, the name, when they applied, the resume score with its band word and must-have line, and any flag", () => {
    const html = page("new", list("new", rows));
    const first = rowOf(html, "a1");
    expect(first).toContain('<input type="checkbox"/><span class="sr-only">Select Alex Example</span>');
    expect(first).toContain('<button type="button" class="candidate-name">Alex Example</button>');
    expect(text(first)).toContain("Applied 2 days ago");
    // the number with its one band word, said in full to a screen reader
    expect(first).toContain('<span class="score-wrap"><span class="score good sm" title="Resume match 90 out of 100">');
    expect(first).toContain('<span class="score-band">Very high</span>');
    expect(text(first)).toContain("2 of 2 must-haves shown");
    expect(text(first)).toContain("Answered No: Can you work Saturdays?");
    // a missing must-have is said in words, in red; the number itself is never red
    const second = rowOf(html, "a2");
    expect(second).toMatch(/<span class="[^"]*text-critical[^"]*">Missing a must-have: Active RDA licence<\/span>/);
    expect(second).toContain('<span class="score neutral sm" title="Resume match 54 out of 100">');
    expect(second).toContain('<span class="score-band">Low</span>');
    // a resume still being read: the words for why there is no number, and no number
    const third = rowOf(html, "a3");
    expect(third).toContain('<span class="score none sm">Reading the resume</span>');
    expect(third).not.toContain("/100");
  });

  it("draws the first action the API lists as the row's button and the rest under More; one that is not allowed is greyed with its reason", () => {
    const html = page("new", list("new", rows));
    const first = rowOf(html, "a1");
    expect(first).toContain('<button type="button" class="btn secondary sm" aria-label="Shortlist: Alex Example" aria-busy="false">Shortlist</button>');
    expect(first).toMatch(/<button type="button" class="btn quiet sm"[^>]*aria-label="More for Alex Example"/);
    // the resume is still being read: Shortlist stays, greyed, focusable, with the API's reason read with it
    const third = rowOf(html, "a3");
    expect(third).toMatch(new RegExp(`<button type="button" class="btn secondary sm" title="${ACTION_BLOCKED.beingRead}" aria-label="Shortlist: Casey Placeholder" aria-disabled="true" aria-describedby="([^"]+)">Shortlist</button><span id="\\1" class="sr-only">${ACTION_BLOCKED.beingRead}</span>`));
    expect(third).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Shortlist/);
  });

  it("draws no button and no menu for someone the API lists no action for", () => {
    const withdrew = row("w1", "Devon Sample", { stage: "withdrawn", tab: "not_selected", label: "Withdrew", actions: candidateActions(facts({ stage: "withdrawn" })) });
    const told = row("t1", "Emery Example", { stage: "rejected", tab: "not_selected", label: "Not selected", toldState: "sent", toldLabel: "Told by email", actions: candidateActions(facts({ stage: "rejected", toldState: "sent" })) });
    const html = page("not_selected", list("not_selected", [withdrew, told]));
    const gone = rowOf(html, "w1");
    expect(text(gone)).toContain("Withdrew");
    expect(gone.match(/<button/g)).toHaveLength(1); // the name alone
    expect(gone).not.toContain("More for");
    // told already: both actions stay, greyed, with why
    const done = rowOf(html, "t1");
    expect(text(done)).toContain("Told by email");
    expect(done).toMatch(new RegExp(`title="${ACTION_BLOCKED.toldAlready}" aria-label="Email the decision: Emery Example" aria-disabled="true"`));
  });

  it("under Shortlisted says where the AI interview stands; under Interviewed shows the interview score first, beside the resume score", () => {
    const shortlisted = row("s1", "Finley Sample", { stage: "screen_invited", tab: "shortlisted", label: "AI interview sent", aiInterview: { status: "sent", label: "AI interview sent", sentAt: daysAgo(1), linkOpenUntil: new Date(Date.now() + 4 * 86_400_000).toISOString(), lastEmailAt: daysAgo(1), startedAt: null, completedAt: null }, actions: candidateActions(facts({ stage: "screen_invited", aiInterview: "sent" })) });
    const short = rowOf(page("shortlisted", list("shortlisted", [shortlisted])), "s1");
    expect(text(short)).toMatch(/AI interview sent Link open until [A-Z][a-z]{2} \d+/);
    expect(short).toContain('aria-label="Send a reminder: Finley Sample" aria-busy="false">Send a reminder</button>');
    const interviewed = row("i1", "Gray Example", { stage: "screen_complete", tab: "interviewed", label: "Interviewed", interviewScore: interviewScoreSummary(interview), actions: candidateActions(facts({ stage: "screen_complete", aiInterview: "done" })) });
    const done = rowOf(page("interviewed", list("interviewed", [interviewed])), "i1");
    expect(done).toContain('title="AI interview 75 out of 100"');
    expect(done.indexOf('title="AI interview 75 out of 100"')).toBeLessThan(done.indexOf('title="Resume match 90 out of 100"'));
    expect(done).toContain('aria-label="Hire: Gray Example" aria-busy="false">Hire</button>');
    // still being scored: the words, no number
    const scoring = rowOf(page("interviewed", list("interviewed", [{ ...interviewed, interviewScore: interviewScoreSummary(noInterviewScore("being_scored")) }])), "i1");
    expect(scoring).toContain('<span class="score none sm">Scoring the AI interview</span>');
  });

  it("shows the people past the plan's limit as locked cards under New, never a name or a score, with the way to upgrade", () => {
    const html = page("new", list("new", rows, { locked: { count: 5, cards: [{ position: 26, appliedAt: daysAgo(1) }, { position: 27, appliedAt: daysAgo(1) }, { position: 28, appliedAt: daysAgo(0) }, { position: 29, appliedAt: daysAgo(0) }] } }), "");
    const locked = html.slice(html.indexOf('aria-label="Locked candidates"'));
    expect(locked.match(/class="locked-card/g)).toHaveLength(4);
    const words = text(locked);
    expect(words).toContain("Locked Applied yesterday · Upgrade to view more candidates.");
    expect(words).toContain("2 more candidates are locked");
    expect(locked).not.toContain("/100");
    // and never under another tab
    expect(page("hired", list("hired", [], { locked: { count: 5, cards: [] } }))).not.toContain("Locked candidates");
  });
});

describe("a tab with nobody in it", () => {
  const empty = (tab: CandidateTab, counts: ReturnType<typeof jobCounts>, status: "open" | "closed" = "open") => page(tab, { ...list(tab, []), role: { id: "r1", title: "Dental Assistant", status, version: 2 }, counts });

  it("offers to share a job nobody has applied to, as one link", () => {
    const html = empty("new", jobCounts());
    expect(text(html)).toContain("Nobody has applied yet");
    expect(html).toContain('<a href="/roles/r1?tab=share" class="btn primary">Share the job</a>');
    expect(html).not.toContain("Select all");
    // a closed job: the words alone
    const closed = empty("new", jobCounts(), "closed");
    expect(text(closed)).toContain("Nobody has applied yet");
    expect(closed).not.toContain("Share the job");
  });

  it("says nobody is new once everyone was reviewed, and points a later tab at the tab its people come from", () => {
    const reviewed = empty("new", jobCounts({ shortlisted: 2 }));
    expect(text(reviewed)).toContain("Nobody new to review");
    expect(reviewed).not.toContain('class="empty-action"');
    const none = empty("shortlisted", jobCounts({ new: 3 }));
    expect(text(none)).toContain("Nobody is shortlisted");
    expect(none).toContain('<button type="button" class="btn primary">Review new candidates</button>');
    expect(text(empty("interviewed", jobCounts({ shortlisted: 1 })))).toContain("Nobody has finished the AI interview yet See who is shortlisted");
    expect(text(empty("hired", jobCounts()))).toContain("Nobody hired yet");
  });
});

describe("the bar for several ticked people", () => {
  const bar = (ticked: string[], confirming: boolean = false, people: CandidateRow[] = rows) => {
    const buttons = bulkButtons(people, new Set(ticked));
    const props = { total: people.length, ticked: ticked.length, buttons, confirming: confirming ? buttons.find((b) => b.action === "send_decision") ?? null : null, busy: null, onToggleAll: () => undefined, onRun: () => undefined, onCancel: () => undefined };
    return renderToStaticMarkup(createElement(SelectionBar, props));
  };

  it("is only Select all until someone is ticked", () => {
    const html = bar([]);
    expect(html).toMatch(/<fieldset class="[^"]*" aria-label="Actions for the people you ticked"><label[^>]*><input type="checkbox" data-select-all=""\/>Select all<\/label><\/fieldset>/);
    expect(html).not.toContain("<button");
  });

  it("says how many are ticked and offers the actions some of them allow, with the line that Shortlist sends the AI interview", () => {
    const html = bar(["a1", "a2"]);
    expect(text(html)).toContain("2 selected");
    expect([...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Shortlist", "Not selected"]);
    expect(html).toContain('<button type="button" class="btn primary sm" aria-busy="false">Shortlist</button>');
    expect(text(html)).toContain("Shortlist sends the AI interview.");
    expect(html).toContain('data-on="true"');
  });

  it("says how many of the ticked an action reaches when it is not all of them", () => {
    const html = bar(["a1", "a2", "a3"]);
    expect([...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Shortlist (2 of 3)", "Not selected"]);
  });

  it("draws nothing for an action no ticked person allows", () => {
    // only someone whose resume is still being read: no Shortlist button, and no line about it
    const html = bar(["a3"]);
    expect([...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Not selected"]);
    expect(html).not.toContain("Shortlist");
    // someone hired allows nothing for several: no button at all
    const hired = [row("h1", "Harper Example", { stage: "hired", tab: "hired", label: "Hired", actions: candidateActions(facts({ stage: "hired" })) })];
    const none = bar(["h1"], false, hired);
    expect(text(none)).toContain("1 selected");
    expect(none).not.toContain("<button");
  });

  it("asks once before the decision email goes to several people", () => {
    const people = [
      row("n1", "Indigo Sample", { stage: "rejected", tab: "not_selected", actions: candidateActions(facts({ stage: "rejected", toldState: "not_told" })) }),
      row("n2", "Jules Example", { stage: "rejected", tab: "not_selected", actions: candidateActions(facts({ stage: "rejected", toldState: "not_told" })) }),
    ];
    expect([...bar(["n1", "n2"], false, people).matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Email the decision"]);
    const asking = bar(["n1", "n2"], true, people);
    expect(text(asking)).toContain("Email the decision to 2 people?");
    expect([...asking.matchAll(/<button[^>]*>(?:<svg(?:(?!<\/svg>)[\s\S])*<\/svg>)?([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Send", "Cancel"]);
  });
});

describe("Candidates in the rail", () => {
  it("is the same list with a job picker, opening on the first open job", () => {
    nav.path = "/talent";
    nav.params = {};
    nav.search = "";
    const jobs = [jobDetail("r0", "draft"), jobDetail("r1", "open"), jobDetail("r2", "paused")].map((j, i) => ({ ...j, title: ["Front Desk Lead", "Dental Assistant", "Office Manager"][i] }));
    const html = render(client([[["roles"], jobs], [["candidates", "r1", "new"], list("new", rows)]]), createElement(Candidates));
    expect(html).toContain("<h1>Candidates</h1>");
    expect(html).toMatch(/<option value="r1" selected="">Dental Assistant<\/option>/);
    expect(html).toContain('<option value="r0">Front Desk Lead (Draft)</option>');
    expect(html).toContain('<option value="r2">Office Manager (Paused)</option>');
    expect([...html.matchAll(/data-application="([^"]+)"/g)].map((m) => m[1])).toEqual(["a1", "a2", "a3"]);
    // no job's header here: the job's own tabs belong to the job's page
    expect(html).not.toContain('aria-label="Job sections"');
    // with no job at all, the one way on
    const none = render(client([[["roles"], []]]), createElement(Candidates));
    expect(text(none)).toContain("No jobs yet");
    expect(none).toContain('<a href="/roles/new" class="btn primary">Start a hire</a>');
  });
});

describe("the candidate panel", () => {
  const panel = (over: Partial<PanelView> = {}): PanelView => ({
    id: "a1", role: { id: "r1", title: "Dental Assistant", status: "open" }, candidate: { firstName: "Alex", lastName: "Example", name: "Alex Example", email: "alex@example.com", phone: "(555) 010-0100" },
    appliedAt: daysAgo(2), source: "linkedin", sourceLabel: "LinkedIn", stage: "triaged", tab: "new", label: "New", toldState: null, toldLabel: null, toldAt: null,
    cv: { id: "d1", filename: "resume.pdf", mime: "application/pdf", sizeBytes: 1000, status: "clean", statusLabel: "Checked", hasText: true },
    cvScore: strong, cvReview: { summary: "A strong fit on paper.", strengths: [{ claim: "Licensed and experienced", quote: "RDA licence, renewed 2025", from: "from the resume" }], concerns: [], openQuestions: [{ question: "Why leave the current practice?", whyItMatters: "Tenure matters here." }] },
    screeningAnswers: [{ key: "f1", question: "Can you work Saturdays?", kind: "yes_no", answer: "No", flagged: true, flag: "Answered No: Can you work Saturdays?" }, { key: "f3", question: "Years of chairside experience?", kind: "number", answer: "3", flagged: false, flag: null }],
    aiInterview: null, actions: candidateActions(facts({})), ...over,
  });
  const noop = { one: { isPending: false, variables: undefined, mutate: () => undefined }, many: { isPending: false }, problem: null, refused: [], clear: () => undefined } as never;
  const open = (data: PanelView, decisionOpen = false, seed: Array<[unknown[], unknown]> = []) => render(client([[["candidate", data.id], data], ...seed]), createElement(CandidatePanel, { id: data.id, actions: noop, decisionOpen, onDecisionOpen: () => undefined, onClose: () => undefined }));
  /** The panel's action buttons, by their words and whether each can be pressed. */
  const actions = (html: string) => {
    const group = /<fieldset class="[^"]*" aria-label="Actions for [^"]*">([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";
    return [...group.matchAll(/<button type="button" class="btn (\w+)"([^>]*)>([^<]+)<\/button>/g)].map((m) => `${plain(m[3])}:${m[1]}:${m[2].includes('aria-disabled="true"') ? "off" : "on"}`);
  };
  const at = (stage: Partial<CandidateActionFacts>, over: Partial<PanelView> = {}) => open(panel({ stage: stage.stage ?? "triaged", actions: candidateActions(facts(stage)), ...over }));

  it("is a side sheet named for the person, with where they stand and when they applied", () => {
    const html = open(panel());
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Alex Example"');
    expect(text(html)).toContain("New · Applied 2 days ago");
  });

  it("draws exactly the actions the API lists for each stage, in its order", () => {
    expect(actions(at({ stage: "triaged" }))).toEqual(["Shortlist:primary:on", "Hire:secondary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "received" }))).toEqual(["Shortlist:secondary:off", "Hire:primary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "screen_invited", aiInterview: "sent" }))).toEqual(["Send a reminder:primary:on", "Cancel the AI interview:ghost:on", "Hire:secondary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "screen_invited", aiInterview: "link_closed" }))).toEqual(["Send a new link:primary:on", "Cancel the AI interview:ghost:on", "Hire:secondary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "screen_invited", aiInterview: "opted_out" }))).toEqual(["Cancel the AI interview:ghost:on", "Hire:primary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "screen_complete", aiInterview: "done" }))).toEqual(["Hire:primary:on", "Not selected:secondary:on"]);
    expect(actions(at({ stage: "hired" }))).toEqual(["Undo:ghost:on"]);
    expect(actions(at({ stage: "rejected", toldState: "not_told" }, { toldState: "not_told" }))).toEqual(["Email the decision:primary:on", "Undo:ghost:on"]);
    expect(actions(at({ stage: "rejected", toldState: "queued", decisionEmailWaiting: true }, { toldState: "queued" }))).toEqual(["Don't send:primary:on", "Undo:ghost:off"]);
    expect(actions(at({ stage: "rejected", toldState: "sent" }, { toldState: "sent" }))).toEqual(["Email the decision:secondary:off", "Undo:ghost:off"]);
  });

  it("says beside Shortlist that it sends the AI interview, and says the API's reason beside an action that is not allowed", () => {
    expect(text(at({ stage: "triaged" }))).toContain("Shortlist sends the AI interview.");
    const reading = at({ stage: "received" });
    expect(text(reading)).toContain(`Shortlist: ${ACTION_BLOCKED.beingRead}`);
    expect(text(reading)).not.toContain("Shortlist sends the AI interview.");
    const used = at({ stage: "triaged", planStop: "ai_interviews_used_up" });
    expect(text(used)).toContain(`Shortlist: ${ACTION_BLOCKED.interviewsUsedUp}`);
    expect(used).toContain(`title="${attr(ACTION_BLOCKED.interviewsUsedUp)}" aria-label="Shortlist: Alex Example" aria-disabled="true"`);
  });

  it("draws no action at all for someone who withdrew, or for an action the API does not list", () => {
    const html = at({ stage: "withdrawn" }, { label: "Withdrew" });
    expect(html).not.toContain('aria-label="Actions for');
    expect(actions(html)).toEqual([]);
    // New: nothing of a decision email or an undo; Hired: nothing but Undo
    const fresh = at({ stage: "triaged" });
    for (const absent of ["Email the decision", "Undo", "Send a reminder", "Don't send"]) expect(fresh, absent).not.toContain(`>${absent}</button>`);
    const hired = at({ stage: "hired" });
    for (const absent of ["Shortlist", "Hire", "Not selected", "Email the decision"]) expect(hired, absent).not.toContain(`>${absent}</button>`);
  });

  it("says plainly that a decision nobody has emailed is private, and shows the exact email before it is sent", () => {
    const notTold = { stage: "rejected" as const, toldState: "not_told" as const };
    const html = at(notTold, { toldState: "not_told", toldLabel: "Not told yet", label: "Not selected" });
    expect(text(html)).toContain("Private: Alex has not been told.");
    // "Email the decision" pressed: the email as it will go, with one Send
    const preview = { to: "alex@example.com", subject: "Your application to Bright Dental", text: "Thank you for applying.\n\nWe will not be moving forward.", adverseDecisionLine: false, toldState: "not_told" };
    const sending = open(panel({ ...notTold, toldLabel: "Not told yet", actions: candidateActions(facts(notTold)) }), true, [[["decision-message", "a1"], preview]]);
    const words = text(sending);
    expect(words).toContain("To alex@example.com");
    expect(words).toContain("Subject Your application to Bright Dental");
    expect(words).toContain("Thank you for applying. We will not be moving forward.");
    expect(sending).toMatch(/<button type="button" class="btn primary"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Send the email<\/button>/);
    expect(actions(sending)).toEqual([]);
    // once told, nothing says private
    expect(text(at({ stage: "rejected", toldState: "sent" }, { toldState: "sent", toldLabel: "Told by email" }))).not.toContain("Private:");
  });

  it("has three sections: the resume match with every requirement, the application, and the AI interview", () => {
    const html = open(panel());
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Alex Example", "Resume match", "Application", "AI interview"]);
    const words = text(html);
    // the number large with its band word, the must-have line, then each requirement with its finding and quote
    expect(html).toContain('<span class="score lg" title="Resume match 90 out of 100">');
    expect(words).toContain("2 of 2 must-haves shown");
    expect(words).toContain("Active RDA licence Must-have 40 points Shown \"RDA licence, renewed 2025\", from the resume");
    expect(words).toContain("Digital radiography Important 20 points Partly shown");
    // the AI's own words, folded
    expect(html).toContain("<summary>AI review</summary>");
    expect(words).toContain("A strong fit on paper.");
    // the application: a "No" is flagged, the contact details, where they came from, and the resume in a frame of this site
    expect(html).toMatch(/Can you work Saturdays\?<\/span><span class="pill caution sm">(?:(?!<\/span>)[\s\S])*No<\/span>/);
    expect(html).toContain('<a href="mailto:alex@example.com">alex@example.com</a>');
    expect(words).toContain("Came from LinkedIn");
    expect(html).toContain('<iframe src="/api/v1/applications/a1/documents/d1/inline" title="Resume: resume.pdf"');
    expect(html).toContain('href="/api/v1/applications/a1/documents/d1/file"');
    // nobody shortlisted them yet
    expect(words).toContain("AI interview Not sent.");
    // the word people read is resume
    expect(words).not.toMatch(/\bCV\b|résumé/);
  });

  it("shows nothing of an AI interview before the candidate sent it, and afterwards its score, each question and their answers", () => {
    const sent = open(panel({ stage: "screen_invited", tab: "shortlisted", label: "AI interview sent", aiInterview: { status: "sent", label: "AI interview sent", sentAt: daysAgo(1), linkOpenUntil: new Date(Date.now() + 4 * 86_400_000).toISOString(), lastEmailAt: daysAgo(1), startedAt: null, completedAt: null, score: null, review: null, answers: [] }, actions: candidateActions(facts({ stage: "screen_invited", aiInterview: "sent" })) }));
    const before = text(sent.slice(sent.lastIndexOf("<h2>AI interview</h2>")));
    expect(before).toMatch(/AI interview sent Sent [A-Z][a-z]{2} \d+ · Link open until [A-Z][a-z]{2} \d+/);
    expect(before).not.toMatch(/out of 100|Their answers/);
    const done = open(panel({ stage: "screen_complete", tab: "interviewed", label: "Interviewed", aiInterview: { status: "done", label: "AI interview done", sentAt: daysAgo(3), linkOpenUntil: null, lastEmailAt: daysAgo(3), startedAt: daysAgo(1), completedAt: daysAgo(1), score: interview, review: null, answers: [{ key: "q1", question: "Tell us about a busy day.", answer: "We saw forty patients.", skipped: false }, { key: "wrap_up", question: "Anything else?", answer: null, skipped: true }] }, actions: candidateActions(facts({ stage: "screen_complete", aiInterview: "done" })) }));
    const after = done.slice(done.lastIndexOf("<h2>AI interview</h2>"));
    expect(after).toContain('<span class="score lg" title="AI interview 75 out of 100">');
    const words = text(after);
    expect(words).toContain("1 of 2 questions answered to the job's standard");
    expect(words).toContain("Tell us about a busy day. Shown A concrete example. \"we saw forty patients\"");
    expect(words).toContain("How do you sterilise instruments? Partly shown");
    expect(after).toContain("<summary>Their answers (2)</summary>");
    expect(words).toContain("Anything else? Skipped");
  });

  it("shows a resume that cannot be opened as the API's line, with nothing to open", () => {
    const html = open(panel({ cv: { id: "d1", filename: "resume.pdf", mime: "application/pdf", sizeBytes: 1000, status: "quarantined", statusLabel: "This file is still being checked.", hasText: false } }));
    expect(text(html)).toContain("This file is still being checked.");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("/documents/d1/file");
  });

  it("shows someone past the plan's limit as the locked card and nothing else: never a name, a score or an action", async () => {
    const qc = client();
    await qc.prefetchQuery({ queryKey: ["candidate", "x9"], queryFn: () => Promise.reject(new ApiError(402, "candidate_locked", "Upgrade to view more candidates.", { upgrade: true, ask: null })) });
    const html = render(qc, createElement(CandidatePanel, { id: "x9", actions: noop, decisionOpen: false, onDecisionOpen: () => undefined, onClose: () => undefined }));
    expect(html).toContain('aria-label="Locked candidate"');
    const words = text(html);
    expect(words).toContain("Locked Upgrade to view more candidates.");
    expect(html).not.toContain("/100");
    expect(html).not.toContain('aria-label="Actions for');
    expect(html).not.toContain("Could not load");
  });
});
