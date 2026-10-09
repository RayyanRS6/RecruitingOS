import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The pool board on the Talent page (plan F6-F10; founder decisions B2, B4, B5, B6) as the server first draws it, from
 * answers shaped like the API's: the "Sort the pool" strip and the Board / List switch, the board's header and counts,
 * the green summary with next steps naming people, three columns of cards, Review and apply with its groups, ticks,
 * reasons and private footer, the one-click questions panel, Today's pool card, and the board a recruiter is asked to
 * check.
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
const { Home } = await import("@ros/web/src/pages/Home");
const { AskPool, AnswerView } = await import("@ros/web/src/pages/board/AskPool");
const { BoardSnapshotCard } = await import("@ros/web/src/pages/board/BoardSnapshot");
const { MustHavesCard } = await import("@ros/web/src/pages/RoleReport");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const owner = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } };

function score(value: number, over: Record<string, unknown> = {}) {
  const band = value >= 85 ? "very_high" : value >= 70 ? "high" : value >= 55 ? "medium" : "low";
  return { score: value, band, bandLabel: null, coverage: { known: 2, total: 2, words: "Based on 2 of 2 requirements" }, breakdown: [], unknown: [], fullMarks: 2, missingMustHave: [], capped: false, confidence: "high", basedOn: "resume", packetVersion: 1, ...over };
}
function placed(column: string, over: Record<string, unknown> = {}) {
  return { column, state: "suggested", doneLabel: null, confident: true, needsYourEye: null, reason: "Match score 91: every requirement judged so far is met.", nextStep: { kind: "interview", label: "Interview", reason: "Strong evidence on every must-have." }, suggestedAction: column, declineReason: null, ...over };
}
function card(id: string, name: string, placement: Record<string, unknown>, s: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    applicationId: id, name, appliedAt: daysAgo(3), waitingDays: 3, stage: "triaged", stageLabel: "Ready for your review", ownerStage: "new", ownerStageLabel: "New", mark: null, score: s, mustHaves: null, confidence: "high", reading: "Strong match",
    strengths: [{ claim: "Active CA RDH license", quote: "RDH license CA active", source: "resume", unquoted: false }, { claim: "Periodontal charting", quote: "Periodontal charting, scaling", source: "resume", unquoted: false }],
    gap: { claim: "Patient communication: partly shown", quote: null, source: "screen", unquoted: true },
    placement, readingVersion: null, facts: { openScreen: false, invitedAutomatically: false, suggestionWaiting: false, stillApplying: false, lowConfidence: false, needsCloserLook: false }, open: `/roles/r1/talent?open=${id}`, ...over,
  };
}
const maria = card("a1", "Maria Reyes", placed("shortlist"), score(91), { mustHaves: { total: 2, shown: 2, partly: 0, notShown: 0, unknown: 0, gaps: [], words: "Must-haves: 2 of 2 shown" }, facts: { openScreen: false, invitedAutomatically: true, suggestionWaiting: false, stillApplying: false, lowConfidence: false, needsCloserLook: false } });
const ben = card("a2", "Ben Ortiz", placed("longlist", { confident: false, needsYourEye: "The assistant was not confident about this reading; read it yourself.", nextStep: { kind: "read_yourself", label: "Read it yourself", reason: "Your own read counts most here." } }), score(76));
const eve = card("a3", "Eve Lund", placed("shortlist", { state: "done", doneLabel: "Shortlist", confident: false, reason: "Already sorted by a person: Shortlist.", nextStep: null, suggestedAction: null }), score(88));
const luis = card("a4", "Luis Ortega", placed("not_moving_forward", { reason: "Missing must-have: Active CA RDH license.", nextStep: { kind: "not_moving_forward", label: "Not moving forward", reason: "Their own words show they do not meet Active CA RDH license." }, declineReason: { reason: "not_a_match_skills", note: "Missing must-have: Active CA RDH license. Their own words: \"RDH license CA expired in 2021\"" } }), score(40, { missingMustHave: [{ key: "mh_1", label: "Active CA RDH license", quote: "RDH license CA expired in 2021" }], capped: true }));
const sofia = card("a5", "Sofia Lind", placed("shortlist", { column: null, state: "waiting", doneLabel: "Still applying", suggestedAction: null, nextStep: null }), null);
const summary = {
  total: 4, counts: { shortlist: 1, longlist: 1, not_moving_forward: 1 }, toSort: 3, done: 1, stillApplying: 1, showEveryMustHave: 2, mostMissing: { key: "mh_2", label: "Periodontal charting", notShowing: 1, of: 4 }, longestWaiting: { applicationId: "a2", name: "Ben Ortiz", days: 3 },
  nextSteps: [{ applicationId: "a1", name: "Maria Reyes", kind: "interview", label: "Interview", reason: "Strong evidence on every must-have." }, { applicationId: "a2", name: "Ben Ortiz", kind: "read_yourself", label: "Read it yourself", reason: "Your own read counts most here." }],
  mustHaves: [], stricter: null,
  sentences: ["4 people on the board: 2 on the shortlist, 1 on the longlist, 1 not moving forward. 1 more is still applying.", "2 of 4 show every must-have.", "The must-have shown least often is \"Periodontal charting\": 1 of 4 don't show it.", "Ben Ortiz has waited longest: 3 days."],
};
const board = { role: { id: "r1", title: "Dental Hygienist", status: "open", currentPacketVersion: 1 }, columns: { shortlist: [maria, eve], longlist: [ben], not_moving_forward: [luis] }, stillApplying: [sofia], summary, generatedAt: "2026-10-09T10:42:00.000Z" };

const counts = { total: 5, byOwnerStage: { new: 4, longlist: 0, shortlist: 1, interviewing: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0 }, byGroup: { waiting_on_you: 3, in_process: 2, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0, stillApplying: 1 };
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], owner);
  qc.setQueryData(["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), counts: { total: 5 }, needsYou: 3, daysOpen: 7 }]);
  qc.setQueryData(["applications", "r1"], { applications: [], counts });
  qc.setQueryData(["applications", "r1", "board"], board);
  qc.setQueryData(["applications", "r1", "questions"], { questions: [
    { id: "missing_must_have", kind: "missing_must_have", label: "Who is missing a must-have, and why?", mustHaveKey: null },
    { id: "strongest_evidence:mh_1", kind: "strongest_evidence", label: "Strongest evidence for \"Active CA RDH license\"", mustHaveKey: "mh_1" },
    { id: "overlooked", kind: "overlooked", label: "Who might I be overlooking?", mustHaveKey: null },
    { id: "compare", kind: "compare", label: "Compare these", mustHaveKey: null },
  ] });
  qc.setQueryData(["company"], { settings: { verifiedAt: daysAgo(30) } });
  return qc;
}

describe("the pool board on the Talent page", () => {
  it("offers to sort the pool from the list, with the Board / List switch, and says nothing is sent", () => {
    nav.search = "";
    const words = text(render(client(), createElement(People)));
    expect(words).toContain("Sort the pool Sorts everyone who has finished applying into Shortlist, Longlist and Not moving forward, and explains every call.");
    expect(words).toContain("nothing is sent to anyone");
  });

  it("draws the board: header, counts, the summary with next steps naming people, three columns and the cards", () => {
    nav.search = "view=board";
    const html = render(client(), createElement(People));
    const words = text(html);
    // the switch shows the board; the strip says when it was sorted, and that nothing moves until applied
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">Board<\/button>/);
    expect(words).toMatch(/The pool, sorted Sorted at \d{1,2}:\d{2}/);
    expect(words).toContain("Sort again");
    // the header: eyebrow, role, counts, the ways in
    expect(html).toContain('<p class="eyebrow">Board</p>');
    expect(html).toContain('<h2 id="board-title" tabindex="-1">Dental Hygienist</h2>');
    expect(words).toContain("To sort: 1 shortlist · 1 longlist · 1 not moving forward · 1 already sorted or decided");
    expect(words).toContain("Ask about this pool");
    expect(words).toContain("Have a recruiter check this");
    expect(html).toMatch(/<button type="button" class="btn primary">Review and apply (<!-- -->)?3<\/button>/);
    // on the board, the list's own Compare and recruiter buttons give way to the board's
    expect(words).not.toContain("Bring in a recruiter");
    expect(html).not.toContain('aria-label="Stages"');
    // the summary: two plain sentences, then the next steps naming people
    expect(words).toContain("What the pool looks like 2 of 4 show every must-have. The must-have shown least often is \"Periodontal charting\": 1 of 4 don't show it.");
    expect(words).toContain("Suggested next steps Interview Maria Reyes : Strong evidence on every must-have.");
    // three columns with their lines and counts
    expect(words).toContain("Shortlist 2 Good evidence on the must-haves");
    expect(words).toContain("Longlist 1 Some evidence, or more to find out");
    expect(words).toContain("Not moving forward 1 A must-have shown missing, or a low score on what is known");
    // Maria: initials, name, band and score, Ready to apply and the confidence apart, the reason, the facts, two strengths and the gap with sources, the next step
    expect(html).toContain('<span class="avatar" aria-hidden="true">MR</span>');
    expect(html).toContain('class="board-card-name">Maria Reyes</button>');
    expect(words).toContain("Match score 91 out of 100 (very high) Very high · 91");
    expect(html).toContain('<span class="chip neutral">Ready to apply</span>');
    expect(html).toContain('<span class="chip neutral">High confidence</span>');
    expect(html).not.toContain('<span class="chip good">');
    expect(html).toContain('<ul class="board-card-facts"><li>Must-haves: 2 of 2 shown</li><li>From the résumé reading</li><li>Invited to the screening conversation automatically</li></ul>');
    expect(words).toContain("Strength: Active CA RDH license · résumé");
    expect(words).toContain("Gap: Patient communication: partly shown · screening conversation, no quote");
    expect(words).toContain("Interview Strong evidence on every must-have.");
    // Ben needs your eye, Luis is missing a must-have (the only red), Eve is done
    expect(html).toContain('<span class="chip caution">Needs your eye</span>');
    expect(html).toContain('<span class="chip critical">Missing must-have: Active CA RDH license</span>');
    expect(words).toContain("Done Shortlist");
    // the people still applying are apart, never placed
    expect(words).toContain("1 more person is still applying: Sofia Lind. They join the board when they finish.");
  });

  it("opens Review and apply from the address: three groups, ticks, reasons, warnings and the private footer", () => {
    nav.search = "view=board&review=1";
    const html = render(client(), createElement(People));
    const words = text(html);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Review and apply"/);
    // groups with n/m and where they go, privately
    expect(words).toContain("Shortlist 1/1 1 of 1 ticked Added to your Shortlist. Private, the candidate is not told.");
    expect(words).toContain("Longlist 0/1 0 of 1 ticked Kept warm on your Longlist. Private, no email.");
    expect(words).toContain("Not moving forward 1/1 1 of 1 ticked Filed privately. Nobody is emailed now; you will be reminded to send the decision message from the Talent page. If nobody tells them within 5 working days, the standard message goes by itself");
    expect(words).toContain("Untick anyone you want to decide yourself, change a reason if needed, then apply. Unticked people stay where they are.");
    // Maria and Luis start ticked; Ben, who needs your eye, does not
    expect(html).toContain('<input id="review-a1" type="checkbox" aria-describedby="review-a1-why" checked=""/>');
    expect(html).toContain('<input id="review-a4" type="checkbox" aria-describedby="review-a4-why" checked=""/>');
    expect(html).toContain('<input id="review-a2" type="checkbox" aria-describedby="review-a2-why"/>');
    expect(words).toContain("Needs your eye: read before applying");
    expect(words).toContain("Missing must-have: Active CA RDH license");
    // Luis's reason, pre-filled from his own evidence, can be changed
    expect(html).toContain('<option value="not_a_match_skills" selected="">Skills not a match</option>');
    expect(words).toContain("From their evidence: Missing must-have: Active CA RDH license.");
    // Eve is done: not in the window
    expect(html).not.toContain('id="review-a3"');
    // the footer: private, the live counter, Cancel and Apply
    expect(words).toContain("This files people into your pipeline privately. Nobody is emailed.");
    expect(words).toContain("2 decisions ready (1 shortlist · 0 longlist · 1 not moving forward)");
    expect(words).toContain("Cancel");
    expect(words).toContain("Apply 2 decisions");
  });
});

describe("Ask about this pool", () => {
  it("is a side panel with the assistant's mark, the intro, the questions as buttons and the box for later", () => {
    const html = render(client(), createElement(AskPool, { roleId: "r1", board: board as never, onClose: () => undefined, onOpen: () => undefined, onShow: () => undefined }));
    const words = text(html);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-label="Ask about this pool"/);
    expect(html).toContain('<span class="ask-mark" aria-hidden="true">');
    expect(words).toContain("Answers come from the checked findings already on file for everyone who finished applying. Pick a question; each answer says what it looked at.");
    expect(html).toContain('role="group" aria-label="Questions you can ask"');
    expect(words).toContain("Who is missing a must-have, and why?");
    expect(words).toContain("Strongest evidence for \"Active CA RDH license\"");
    expect(words).toContain("Who might I be overlooking?");
    expect(words).toContain("Compare these");
    // no box that does nothing: one line says typing a question is not available yet
    expect(html).not.toContain("<textarea");
    expect(words).toContain("Typing your own question is not available yet. Pick a question above, or bring in a recruiter.");
  });

  it("answers with the people as chips that open their panel, why, the quotes, and what it looked at", () => {
    const answer = {
      kind: "missing_must_have", question: "Who is missing a must-have, and why?", answer: "1 person shows, in their own words, that they do not meet a must-have.",
      people: [{ applicationId: "a4", name: "Luis Ortega", score: 40, band: "low", placement: "not_moving_forward", why: "Missing must-have: Active CA RDH license.", quotes: [{ criterion: "Active CA RDH license", quote: "RDH license CA expired in 2021", source: "resume" }], open: "/roles/r1/talent?open=a4" }],
      applicationIds: ["a4"], lookedAt: { people: 4, resumeReadings: 4, screenReadings: 1, requirements: ["Active CA RDH license", "Periodontal charting"], words: "" },
    };
    const qc = client();
    const html = render(qc, createElement(AnswerView, { answer: answer as never, onOpen: () => undefined, onShow: () => undefined, onCompareAgain: null }));
    const words = text(html);
    expect(html).toContain('<button type="button" class="person-chip"><span class="avatar sm" aria-hidden="true">LO</span><span>Luis Ortega</span>');
    expect(words).toContain("Missing must-have: Active CA RDH license.");
    expect(words).toContain("“RDH license CA expired in 2021” Active CA RDH license · résumé");
    expect(words).toContain("Looked at: 4 people (4 résumé readings and 1 screening conversation), against 2 must-haves. Nothing new was asked of the AI.");
    expect(words).toContain("Show this person on the board");
  });
});

describe("Today's pool card", () => {
  it("names the people to start with, links each to their panel over the board, and says nothing moves until applied", () => {
    const qc = client();
    qc.setQueryData(["brief"], { generatedAt: daysAgo(0), summary: "One role to sort.", cards: [{ kind: "pool_ready", title: "3 people to sort for Dental Hygienist", body: summary.sentences.join("\n"), roleId: "r1", actions: [{ label: "Open the board", method: "GET", path: "/roles/r1/talent?view=board" }, { label: "Review and apply", method: "GET", path: "/roles/r1/talent?view=board&review=1" }], pool: summary }] });
    qc.setQueryData(["notifications", "unread"], []);
    const html = render(qc, createElement(Home));
    const words = text(html);
    expect(words).toContain("3 people to sort for Dental Hygienist Ready to sort");
    expect(words).toContain("2 of 4 show every must-have.");
    expect(words).toContain("Suggested next steps");
    expect(html).toContain('<a href="/roles/r1/talent?view=board&amp;open=a1">Maria Reyes</a>');
    expect(html).toContain('<a href="/roles/r1/talent?view=board" class="btn secondary sm">Open the board</a>');
    expect(html).toContain('<a href="/roles/r1/talent?view=board&amp;review=1" class="btn primary sm">Review and apply</a>');
    expect(words).toContain("Nothing moves until you apply it, and nobody is emailed.");
  });
});

describe("the role's Report tab: how the pool meets the must-haves (F7)", () => {
  it("shows the counts per must-have, how many show every one, and the 'stricter than needed?' note with the way to the must-haves", () => {
    const mustHaves = {
      people: 6, showEveryMustHave: 1,
      byMustHave: [{ key: "mh_1", label: "Active CA RDH license", shown: 5, partly: 0, notShown: 1, unknown: 0, total: 6 }, { key: "mh_2", label: "Periodontal charting", shown: 1, partly: 1, notShown: 0, unknown: 2, total: 4 }],
      stricter: { words: "\"Periodontal charting\" is not shown by 2 of 4 people. If it is stricter than the job needs, you could make it a nice-to-have in a new version of the role. Nobody is turned down because of this note.", editPath: "/roles/r1?tab=requirements&edit=must-haves" },
    };
    const html = render(client(), createElement(MustHavesCard, { mustHaves, links: true }));
    const words = text(html);
    expect(words).toContain("How the pool meets the must-haves");
    expect(words).toContain("1 of 6 people show every must-have.");
    expect(words).toContain("Active CA RDH license 5 0 1 0 6");
    expect(words).toContain("Periodontal charting 1 1 0 2 4");
    expect(html).toContain('<a href="/roles/r1?tab=requirements&amp;edit=must-haves">Look at the must-haves</a>');
    expect(words).toContain("Someone read before a must-have was added is left out of its count.");
    expect(words).not.toMatch(/Maria|Ben|Luis/);
    // the administrator's view has no link into the customer's role
    expect(render(client(), createElement(MustHavesCard, { mustHaves }))).not.toContain("Look at the must-haves</a>");
  });
});

describe("the board a recruiter is asked to check (F9)", () => {
  it("shows the board as it stood: counts, the summary and each person's place, score, reason and next step", () => {
    const snapshot = { capturedAt: "2026-10-09T10:00:00.000Z", summary: { sentences: summary.sentences.slice(0, 2), counts: summary.counts }, people: [
      { applicationId: "a1", name: "Maria Reyes", column: "shortlist", state: "suggested", score: 91, reason: "Match score 91.", needsYourEye: null, nextStep: "Interview" },
      { applicationId: "a2", name: "Ben Ortiz", column: "longlist", state: "suggested", score: 76, reason: "Match score 76.", needsYourEye: "The assistant was not confident.", nextStep: "Read it yourself" },
      { applicationId: "a5", name: "Sofia Lind", column: null, state: "waiting", score: null, reason: "Still applying.", needsYourEye: null, nextStep: null },
    ] };
    const words = text(render(client(), createElement(BoardSnapshotCard, { snapshot: snapshot as never })));
    expect(words).toContain("The pool board when they asked");
    expect(words).toContain("To sort: 1 shortlist · 1 longlist · 1 not moving forward");
    expect(words).toContain("Maria Reyes Shortlist 91/100 Match score 91. Interview");
    expect(words).toContain("Ben Ortiz Longlist 76/100 Needs a person's eye: The assistant was not confident. Read it yourself");
    expect(words).toContain("Sofia Lind Still applying No score yet");
    expect(words).toContain("The board only suggests. The team applies it themselves, privately, in Review and apply.");
  });
});
