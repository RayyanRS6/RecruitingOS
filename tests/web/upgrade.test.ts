import { describe, expect, it } from "vitest";
import { AI_HELP_LINE, type PublicPlan } from "../../packages/contracts/src";
import { boardLockedWords, cannotSeeYetWords, firstChoice, isPlanAsk, moreLockedWords, planFacts, priceWords, reasonOf, reportLockedLabel, requestSentWords } from "../../apps/web/src/upgrade";
import { draftNoRoom, problemAsk, turnProblem } from "../../apps/web/src/pages/new-role/rules";

/**
 * The upgrade path's words and rules (the plans of 5 November 2026, Rule 5), as a page reads them without a browser. The sheet
 * compares the four plans with prices in dollars and the AI help in words, never in dollars; a request about the plan opens
 * the sheet instead of going in one click; and running out of AI help or of jobs offers an upgrade, never "try again".
 */
const plan = (over: Partial<PublicPlan>): PublicPlan => ({ key: "basic", name: "Basic", monthlyUsd: 49, activeRoles: 3, jobsTotal: null, candidatesPerJob: 25, seats: 3, aiHelp: "About 600 candidates a month", current: false, ...over });
const free = plan({ key: "free", name: "Free", monthlyUsd: 0, activeRoles: 1, jobsTotal: 1, candidatesPerJob: 5, seats: 2, aiHelp: "Included, up to a limit" });
const basic = plan({});
const pro = plan({ key: "pro", name: "Pro", monthlyUsd: 149, activeRoles: 10, candidatesPerJob: 100, seats: 10, aiHelp: "About 1,800" });
const ultra = plan({ key: "ultra", name: "Ultra", monthlyUsd: 399, activeRoles: 30, candidatesPerJob: null, seats: null, aiHelp: "About 6,000" });

describe("what the sheet says of each plan", () => {
  it("the price in dollars, and what it includes in the sheet's order: one job ever, jobs at a time, no limit", () => {
    expect(priceWords(0)).toEqual({ amount: "$0", per: null });
    expect(priceWords(49)).toEqual({ amount: "$49", per: "a month" });
    expect(priceWords(1499)).toEqual({ amount: "$1,499", per: "a month" });
    expect(planFacts(free)).toEqual([{ label: "Jobs", value: "1" }, { label: "Candidates per job", value: "5" }, { label: "People", value: "2" }, { label: "AI help", value: "Included, up to a limit" }]);
    expect(planFacts(basic).map((f) => f.value)).toEqual(["3 at a time", "25", "3", "About 600 candidates a month"]);
    expect(planFacts(ultra).map((f) => f.value)).toEqual(["30 at a time", "No limit", "No limit", "About 6,000"]);
    expect(planFacts(plan({ activeRoles: null })).find((f) => f.label === "Jobs")?.value).toBe("No limit");
  });

  it("no dollars for the AI help, anywhere it could be said", () => {
    for (const p of [free, basic, pro, ultra]) expect(JSON.stringify(planFacts(p))).not.toMatch(/\$|cents/);
  });

  it("chooses the next plan up to start with; on the top, or on a plan not in the list, none is chosen, so nobody is moved down by default", () => {
    const all = (current: string) => [free, basic, pro, ultra].map((p) => ({ ...p, current: p.key === current }));
    expect(firstChoice(all("free"))?.key).toBe("basic");
    expect(firstChoice(all("basic"))?.key).toBe("pro");
    expect(firstChoice(all("pro"))?.key).toBe("ultra");
    expect(firstChoice(all("ultra"))).toBeNull();
    for (const elsewhere of ["growth", "trial", "design_partner"]) expect(firstChoice(all(elsewhere)), elsewhere).toBeNull();
    expect(firstChoice([])).toBeNull();
  });
});

describe("what a request about the plan is", () => {
  it("an action about the plan opens the sheet, with why; anything else stays as it was", () => {
    const upgrade = { label: "Upgrade", method: "POST", path: "/api/v1/plans/request", body: { reason: "We would like more AI help." } };
    expect(isPlanAsk(upgrade)).toBe(true);
    expect(reasonOf(upgrade.body)).toBe("We would like more AI help.");
    expect(reasonOf({})).toBeUndefined();
    expect(isPlanAsk({ path: "/api/v1/roles/r1/pause" })).toBe(false);
    expect(isPlanAsk({ path: "/roles/r1/talent" })).toBe(false);
  });

  it("while a request is with ITS, the day it was sent stands in the button's place", () => {
    expect(requestSentWords("2026-11-18T12:00:00Z")).toBe("Request sent on November 18, 2026");
  });
});

describe("out of AI help, or out of jobs, in the job builder", () => {
  const upgrade = { label: "Upgrade", path: "/api/v1/plans/request", body: { reason: "We would like more AI help." } };

  it("a turn with no AI help left says its own line, with no 'could not reply', and the way on is the Upgrade", () => {
    const p = turnProblem({ error: "AI credit used up", recovery: AI_HELP_LINE.turn, proposedActions: [upgrade], upgrade: true });
    expect(p?.message).toBe(AI_HELP_LINE.turn);
    expect(p?.message).not.toContain("could not reply");
    expect(p).toMatchObject({ upgrade: true, ask: { label: "Upgrade", reason: "We would like more AI help." } });
    // any other failure reads as it always did
    expect(turnProblem({ error: "provider", recovery: "Try again." })).toEqual({ message: "The assistant could not reply just now. Try again.", ask: null });
    expect(turnProblem({})).toBeNull();
  });

  it("a refusal carries its own request about the plan; any other failure offers none", () => {
    expect(problemAsk({ details: { upgrade: true, actions: [upgrade] } })).toMatchObject({ label: "Upgrade" });
    expect(problemAsk({ details: { upgrade: true, actions: [] } })).toBeNull();
    expect(problemAsk({ details: {} })).toBeNull();
    expect(problemAsk(null)).toBeNull();
  });
});

describe("what the builder says as a draft opens", () => {
  const oneJob = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
  const noHelp = { ...oneJob, used: 0, message: "Your plan's AI help is used up. Upgrade to keep going.", aiHelp: true };

  it("no room for another job, written or not; no AI help only before it is written, since sending a draft for approval uses none", () => {
    expect(draftNoRoom(oneJob, false)).toBe(oneJob);
    expect(draftNoRoom(oneJob, true)).toBe(oneJob);
    expect(draftNoRoom(noHelp, false)).toBe(noHelp);
    expect(draftNoRoom(noHelp, true)).toBeNull();
  });

  it("nothing while there is room, or when closing a role could still free one", () => {
    expect(draftNoRoom({ ok: true, limit: 1, used: 0, holding: [], message: null }, false)).toBeNull();
    expect(draftNoRoom({ ok: false, limit: 2, used: 2, holding: [], message: "Your plan includes 2 roles at a time." }, false)).toBeNull();
    expect(draftNoRoom(undefined, false)).toBeNull();
  });
});

describe("the words about people the team cannot read", () => {
  it("a count, never who", () => {
    expect(moreLockedWords(1)).toBe("1 more candidate is locked");
    expect(moreLockedWords(4)).toBe("4 more candidates are locked");
    expect(boardLockedWords(1)).toBe("1 more is locked");
    expect(boardLockedWords(3)).toBe("3 more are locked");
    expect(reportLockedLabel(1)).toBe("person is locked");
    expect(reportLockedLabel(2)).toBe("people are locked");
    expect(cannotSeeYetWords(2)).toBe("and 2 more you cannot see yet");
  });
});
