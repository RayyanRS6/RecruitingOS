import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GettingStartedStep } from "../../packages/contracts/src/domain/company";
import { TODAY_REFRESH, nextStep, setupActionToast } from "../../apps/web/src/today";

/**
 * Today (plans B2 and B9): its cards and updates refresh on focus and every minute while the page is visible, never in a
 * hidden tab, while the app's default stays off for every other page; the getting-started buttons say what they did.
 */
const home = readFileSync(new URL("../../apps/web/src/pages/Home.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../../apps/shell/components/Providers.tsx", import.meta.url), "utf8");

describe("Today keeps itself current", () => {
  it("refreshes on focus and once a minute, only while the page is visible", () => {
    expect(TODAY_REFRESH).toEqual({ refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false });
  });

  it("applies to the brief and to the updates on Today, and the app's default stays off", () => {
    expect(home).toMatch(/queryKey: \["brief"\], queryFn: \(\) => api\.get<Brief>\("\/api\/v1\/brief"\), \.\.\.TODAY_REFRESH \}/);
    expect(home).toMatch(/queryKey: \["notifications", "unread"\][^\n]*\.\.\.TODAY_REFRESH \}/);
    expect(providers).toContain("refetchOnWindowFocus: false");
  });
});

describe("the getting-started card's buttons", () => {
  const step = (key: GettingStartedStep["key"], done: boolean): GettingStartedStep => ({ key, title: key, why: "why", done, actions: [] });

  it("make the first step not done yet the one with the primary button", () => {
    expect(nextStep([step("company_details", true), step("team", false), step("ai_rules", false)])?.key).toBe("team");
    expect(nextStep([step("team", true)])).toBeUndefined();
  });

  it("say what they did in plain words", () => {
    expect(setupActionToast({ label: "Hide these steps", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "dismiss" } })).toEqual({ title: "Steps hidden.", detail: "Only for you; the rest of your team still sees theirs." });
    expect(setupActionToast({ label: "I've reviewed them", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "policies_reviewed" } }).title).toBe("Marked as reviewed.");
    expect(setupActionToast({ label: "Draft it with an ITS recruiter", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company" } }).title).toBe("Sent to ITS.");
  });
});
