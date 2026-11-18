import { describe, expect, it } from "vitest";
import { AI_HELP_UPGRADE_QUESTION, MORE_JOBS_UPGRADE_QUESTION, type PlanRoom, type PublicPlan } from "../../packages/contracts/src/index";
import { ApiError, errorCode, errorWords, isCandidateLocked, planLimitOf } from "../../apps/web/src/api/client";
import { TRIAL_ASK } from "../../apps/web/src/trial";
import { firstChoice, moreLockedWords, planFacts, priceWords, requestSentWords, roomAsk } from "../../apps/web/src/upgrade";

/**
 * The upgrade path's words and rules, as a page reads them without a browser. The sheet compares the plans with prices
 * in dollars and the AI help in words, never in dollars; a refusal by the plan carries the request to offer; and running
 * out of AI help or of jobs offers an upgrade, never "try again".
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

  it("while a request is with ITS, the day it was sent stands in the button's place", () => {
    expect(requestSentWords("2026-11-18T12:00:00Z")).toBe("Request sent on November 18, 2026");
  });
});

describe("a refusal by the plan", () => {
  it("carries the request about the plan to offer, with its words; any other failure offers none", () => {
    const ask = { label: "Upgrade", reason: AI_HELP_UPGRADE_QUESTION };
    expect(planLimitOf(new ApiError(402, "ai_credit_used_up", "Your plan's AI help is used up.", { upgrade: true, ask }))).toEqual({ upgrade: true, ask });
    // someone who may not ask (the API sends no request): the words alone
    expect(planLimitOf(new ApiError(402, "limit_reached", "Your plan includes one job.", { upgrade: false, ask: null }))).toEqual({ upgrade: false, ask: null });
    expect(planLimitOf(new ApiError(402, "trial_ended", "Your trial has ended.", undefined))).toEqual({ upgrade: false, ask: null });
    // a request that is not whole is not offered
    expect(planLimitOf(new ApiError(402, "limit_reached", "x", { upgrade: true, ask: { label: "Upgrade" } }))?.ask).toBeNull();
    for (const other of [new ApiError(409, "action_not_allowed", "This job is closed."), new ApiError(403, "forbidden", "No."), new TypeError("Failed to fetch"), null]) expect(planLimitOf(other)).toBeNull();
  });

  it("carries the plan's room with it when the API sends it", () => {
    const room: PlanRoom = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
    expect(planLimitOf(new ApiError(402, "limit_reached", room.message ?? "", { upgrade: true, ask: null, room }))?.room).toEqual(room);
  });

  it("says the API's own sentence for a refusal, and a line about the connection when there is none", () => {
    expect(errorWords(new ApiError(409, "role_closed", "This job is closed."))).toBe("This job is closed.");
    expect(errorWords(new TypeError("Failed to fetch"))).toMatch(/Check your connection/);
    expect(errorWords(new TypeError("Failed to fetch"), "Could not save.")).toBe("Could not save.");
    expect(errorCode(new ApiError(409, "stale_version", "Someone else saved this job."))).toBe("stale_version");
    expect(errorCode(new TypeError("Failed to fetch"))).toBeNull();
  });

  it("knows someone past the plan's candidates per job is locked, a state to draw and never a failure to retry", () => {
    expect(isCandidateLocked(new ApiError(402, "candidate_locked", "Upgrade to view more candidates."))).toBe(true);
    expect(isCandidateLocked(new ApiError(402, "limit_reached", "x"))).toBe(false);
    expect(isCandidateLocked(new ApiError(404, "not_found", "x"))).toBe(false);
  });
});

describe("no room for another job, as the start box says it", () => {
  const room = (over: Partial<PlanRoom>): PlanRoom => ({ ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", ...over });

  it("offers an upgrade for more jobs, or for more AI help when that is what ran out", () => {
    expect(roomAsk(room({ upgrade: true }))).toEqual({ label: "Upgrade", reason: MORE_JOBS_UPGRADE_QUESTION });
    expect(roomAsk(room({ upgrade: true, aiHelp: true }))).toEqual({ label: "Upgrade", reason: AI_HELP_UPGRADE_QUESTION });
  });

  it("asks ITS to choose a plan once a trial has ended, and to talk when no plan is above theirs", () => {
    expect(roomAsk(room({ trialEnded: true }))).toEqual({ label: "Ask ITS to choose a plan", reason: TRIAL_ASK });
    expect(roomAsk(room({ nothingAbove: true }))).toEqual({ label: "Talk to ITS", reason: MORE_JOBS_UPGRADE_QUESTION });
  });
});

describe("the words about people the team cannot read", () => {
  it("a count, never who", () => {
    expect(moreLockedWords(1)).toBe("1 more candidate is locked");
    expect(moreLockedWords(4)).toBe("4 more candidates are locked");
  });
});
