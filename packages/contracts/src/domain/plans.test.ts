import { describe, expect, it } from "vitest";
import { AI_CREDIT_MONTHLY_CENTS, AI_CREDIT_TOTAL_CENTS, FREE_PLAN_KEY, PLAN_LIMIT_KEYS, PUBLIC_PLAN_KEYS, isAiCreditKey, isPublicPlanKey, jobsTotalLine, limitsForCustomers, publicPlanView } from "./plans";

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
});
