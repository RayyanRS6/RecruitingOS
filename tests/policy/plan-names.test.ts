import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What a plan may do is read from its limits, by key (packages/core/src/entitlements.ts), so a number is one edit in
 * packages/db/src/seed.ts and a new plan needs no code. Nothing may decide by comparing a company's plan to Free, Basic,
 * Pro or Ultra. Trial and Design Partner keep their old comparisons, each behind its own rule.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPARES_A_PLAN = /(?:planKey|plan_key|plan\??\.key)\s*(?:===|!==|==|!=)\s*(?:["'](?:free|basic|pro|ultra)["']|FREE_PLAN_KEY)|(?:["'](?:free|basic|pro|ultra)["']|FREE_PLAN_KEY)\s*(?:===|!==|==|!=)\s*\S*(?:planKey|plan_key)/;

describe("plan names in product code", () => {
  it("nothing compares a company's plan to one of the public plans: limits are read by key", async () => {
    const found: string[] = [];
    for (const pattern of ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]) {
      for await (const file of glob(pattern, { cwd: ROOT })) {
        const path = file.split("\\").join("/");
        if (path.includes("node_modules") || path.includes("/.next/") || /\.test\.tsx?$/.test(path)) continue;
        readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
          if (COMPARES_A_PLAN.test(line)) found.push(`${path}:${i + 1}`);
        });
      }
    }
    expect(found, `read the limit by key instead: ${found.join(", ")}`).toEqual([]);
  });

  it("the check catches the comparison it is there to catch", () => {
    for (const line of ['if (company.planKey === "free") return;', "const onFree = co.plan_key === FREE_PLAN_KEY;", 'const paid = plan?.key !== "basic";', '"ultra" === company.planKey']) expect(COMPARES_A_PLAN.test(line), line).toBe(true);
    for (const line of ['planKey === "design_partner"', "onTrialPlan(planKey)", "planKey: FREE_PLAN_KEY,", 'const key = "free";']) expect(COMPARES_A_PLAN.test(line), line).toBe(false);
  });
});
