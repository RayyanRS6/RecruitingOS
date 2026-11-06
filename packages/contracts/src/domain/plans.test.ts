import { describe, expect, it } from "vitest";
import { AI_CREDIT_MONTHLY_CENTS, AI_CREDIT_TOTAL_CENTS, AI_HELP_BUSY_LINE, AI_HELP_LINE, FREE_PLAN_KEY, MORE_CANDIDATES_UPGRADE_QUESTION, PLAN_LIMIT_KEYS, PUBLIC_PLAN_KEYS, aiCreditNoticeWords, isAiCreditKey, isPublicPlanKey, jobsTotalLine, limitsForCustomers, mayOfferUpgrade, planChangedWords, planRequestQuestion, publicPlanView } from "./plans";

describe("asking for a bigger plan", () => {
  it("offers an upgrade on every plan but the last public one and the private pilot, read from the list", () => {
    for (const key of ["free", "basic", "pro", "trial", "core", "growth", "company"]) expect(mayOfferUpgrade(key), key).toBe(true);
    for (const key of ["ultra", "design_partner"]) expect(mayOfferUpgrade(key), key).toBe(false);
  });

  it("the question names the plan, then why, then the person's own note", () => {
    expect(planRequestQuestion("Pro")).toBe("We would like to move to the Pro plan.");
    expect(planRequestQuestion("Pro", { reason: MORE_CANDIDATES_UPGRADE_QUESTION, note: "  From next month.  " })).toBe("We would like to move to the Pro plan. We would like to view more candidates. From next month.");
    expect(planRequestQuestion("Ultra", { note: "   " })).toBe("We would like to move to the Ultra plan.");
    // nothing above theirs to name, and they can still talk with ITS
    expect(planRequestQuestion(null, { reason: "We would like more AI help." })).toBe("We would like to talk about our plan. We would like more AI help.");
  });

  it("what the team is told when ITS changes the plan: no dollars, and how many it opened", () => {
    expect(planChangedWords("Pro")).toEqual({ title: "Your plan is now Pro", body: "Your company is on the Pro plan now. The new limits apply at once.", answer: "Your company is on the Pro plan now." });
    expect(planChangedWords("Pro", 1).body).toContain("1 candidate who was locked is open now.");
    expect(planChangedWords("Pro", 3).body).toContain("3 candidates who were locked are open now.");
  });
});

describe("the public plans", () => {
  it("lists Free, Basic, Pro and Ultra, in that order, and starts a new company on Free", () => {
    expect(PUBLIC_PLAN_KEYS).toEqual(["free", "basic", "pro", "ultra"]);
    expect(FREE_PLAN_KEY).toBe("free");
    expect(isPublicPlanKey(FREE_PLAN_KEY)).toBe(true);
  });

  it("never lists a private or retired plan", () => {
    for (const key of ["design_partner", "trial", "core", "growth", "company", "", null, undefined]) expect(isPublicPlanKey(key)).toBe(false);
  });

  it("names the keys a plan must name, the AI credit among them", () => {
    expect(new Set(PLAN_LIMIT_KEYS).size).toBe(PLAN_LIMIT_KEYS.length);
    expect(PLAN_LIMIT_KEYS).toContain(AI_CREDIT_TOTAL_CENTS);
    expect(PLAN_LIMIT_KEYS).toContain(AI_CREDIT_MONTHLY_CENTS);
    expect(PLAN_LIMIT_KEYS.filter(isAiCreditKey)).toEqual([AI_CREDIT_TOTAL_CENTS, AI_CREDIT_MONTHLY_CENTS]);
  });
});

describe("what a customer may read about a plan", () => {
  const free = { key: "free", name: "Free", prices: { monthlyUsd: 0 }, limits: { active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, recruiter_asks: 1, seats: 2, its_work: 0 } };

  it("takes the AI credit out of the limits, because it is money", () => {
    const limits = limitsForCustomers(free.limits);
    expect(limits).not.toHaveProperty(AI_CREDIT_TOTAL_CENTS);
    expect(limits).not.toHaveProperty(AI_CREDIT_MONTHLY_CENTS);
    expect(limits).toMatchObject({ active_roles: 1, jobs_total: 1, candidates_per_job: 5, seats: 2 });
  });

  it("shows a public plan with its numbers and AI help in words, and marks the current one", () => {
    expect(publicPlanView(free, "free")).toEqual({ key: "free", name: "Free", monthlyUsd: 0, activeRoles: 1, jobsTotal: 1, candidatesPerJob: 5, seats: 2, aiHelp: "Included, up to a limit", current: true });
    expect(publicPlanView({ ...free, key: "pro", name: "Pro", prices: { monthlyUsd: 149 } }, "free")).toMatchObject({ key: "pro", monthlyUsd: 149, aiHelp: "About 1,800", current: false });
    // no number from the credit in the words, whichever plan
    expect(JSON.stringify(publicPlanView(free, "free"))).not.toContain("1000");
  });

  it("shows nothing for a plan customers are never shown", () => {
    expect(publicPlanView({ ...free, key: "design_partner", name: "Design Partner" }, "design_partner")).toBeNull();
    expect(publicPlanView({ ...free, key: "trial", name: "Trial" }, "trial")).toBeNull();
  });

  it("says the job limit in the owner's words, reading the plan's name and number", () => {
    expect(jobsTotalLine("Free", 1)).toBe("Your Free plan includes one job. Upgrade to post more.");
    expect(jobsTotalLine("Starter", 2)).toBe("Your Starter plan includes 2 jobs. Upgrade to post more.");
    expect(jobsTotalLine(null, 1)).toBe("Your plan includes one job. Upgrade to post more.");
  });

  it("says the AI credit in words, never in money, and never tells anyone to try again or to bring in a recruiter", () => {
    const lines = [...Object.values(AI_HELP_LINE), ...(["warning", "used_up"] as const).flatMap((level) => Object.values(aiCreditNoticeWords(level, { resetsOn: "Friday, December 4" })))];
    for (const line of lines) {
      expect(line).not.toMatch(/\$|\bdollars?\b|\bcents?\b|\bcredit\b/i);
      expect(line).not.toMatch(/try again|recruiter/i);
    }
    expect(AI_HELP_LINE.turn).toBe("Your plan's AI help is used up. Your draft is saved. Upgrade to keep going.");
    expect(AI_HELP_LINE.draft).toBe("Your plan's AI help is used up. Everything you confirmed is kept. Upgrade to write the draft.");
    expect(AI_HELP_LINE.revise).toBe("Your plan's AI help is used up. Nothing was changed. You can still make the change in the editor.");
    expect(AI_HELP_LINE.about).toBe("Your plan's AI help is used up. You can write this text yourself; it shows the same way.");
  });

  it("refused only for money held by work still running, it says to try again, and neither that anything is used up nor to upgrade", () => {
    for (const line of Object.values(AI_HELP_BUSY_LINE)) {
      expect(line).toMatch(/^Your plan's AI help is finishing other work\. /);
      expect(line).toMatch(/try again in a few minutes/i);
      expect(line).not.toMatch(/\$|\bdollars?\b|\bcents?\b|\bcredit\b|used up|upgrade|recruiter/i);
    }
  });

  it("says when a monthly credit starts again, and only then", () => {
    expect(aiCreditNoticeWords("used_up").body).toBe("Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade.");
    expect(aiCreditNoticeWords("used_up", { resetsOn: "Friday, December 4" }).body).toBe("Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade or it starts again on Friday, December 4.");
    expect(aiCreditNoticeWords("warning")).toEqual({ title: "80% of your plan's AI help used", body: "Nothing has stopped. Upgrade before it runs out." });
  });

  it("does not say nothing has stopped once a new job has", () => {
    expect(aiCreditNoticeWords("warning", { newJobsStopped: true })).toEqual({ title: "80% of your plan's AI help used", body: "New jobs have stopped: writing one needs more than is left. Upgrade before the rest runs out." });
    expect(aiCreditNoticeWords("warning", { newJobsStopped: false }).body).toContain("Nothing has stopped.");
    expect(aiCreditNoticeWords("used_up", { newJobsStopped: true }).body).not.toContain("Nothing has stopped");
  });
});
