import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The documents say what the product does now (the lead's small fixes of 10 November 2026): a row or a setup step that
 * still describes a flow the hiring build replaced, or a protection nobody checked, misleads whoever reads it next.
 */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
/** The table row of the API contracts that documents one route. */
const row = (doc: string, method: string, path: string) => doc.split("\n").find((l) => l.startsWith(`| ${method} | \`${path}\` |`)) ?? "";

describe("the decisions register", () => {
  it("MS-2 counts only the protections we rely on, and says Microsoft's own default was not checked", () => {
    const ms2 = read("docs/workflow-decisions.md").split("\n").find((l) => l.startsWith("| MS-2 |")) ?? "";
    expect(ms2).not.toBe("");
    for (const relied of ["`xms_edov`", "**Confirm email**", "`email_unverified`"]) expect(ms2).toContain(relied);
    // never as fact: a single-tenant registration until 10 November, and nobody read authenticationBehaviors
    expect(ms2).not.toContain("And Microsoft's default for multi-tenant apps, which leaves out an email from a domain the person's company has not verified.");
    expect(ms2).toContain("it was not checked (the registration's `authenticationBehaviors` was not read)");
    expect(ms2).toContain("single-tenant until 10 November 2026");
  });
});

describe("the setup documents", () => {
  it("name the Microsoft app registration as the sign-in page names the product, the name IT sees on Microsoft's consent screen", () => {
    const product = /const PRODUCT = "([^"]+)";/.exec(read("apps/web/src/pages/Login.tsx"))?.[1];
    expect(product).toBe("Recruiting OS");
    const runbook = read("docs/runbooks/production-setup.md");
    const microsoft = runbook.slice(runbook.indexOf("### Microsoft and Google sign-in"), runbook.indexOf("**Google**", runbook.indexOf("### Microsoft and Google sign-in")));
    expect(microsoft).toContain(`- Name: \`${product}\`, the product name the sign-in page uses`);
    const worksheet = read("docs/spec/13-account-creation-worksheet.md");
    const section = worksheet.slice(worksheet.indexOf("## 4a."), worksheet.indexOf("## 5."));
    expect(section).toContain(`- Name: \`${product}\`, the same as the product name the sign-in page uses`);
    // one Name line each
    expect(microsoft.match(/^- Name: /gm)).toHaveLength(1);
    expect(section.match(/^- Name: /gm)).toHaveLength(1);
  });
});

describe("the release runbook", () => {
  /**
   * The release review (11 November 2026, L1-6 and L5-2): between the migrate step and the new worker, the worker already live
   * still moved people to "Interview to set up" under the old default, after 0037 had run once, and knew nothing of locked
   * applicants. The release stops it before the migrations, and 0037 says what it covers.
   */
  it("stops the old worker before the migrations that change its rules, and 0037 says it puts back only the moves made before it runs", () => {
    const runbook = read("docs/runbooks/production-setup.md");
    const release = runbook.slice(runbook.indexOf("### The release (migrations 0036 and 0037"), runbook.indexOf("**The plans check**"));
    const stop = release.indexOf("**Stop the old worker first.**");
    expect(stop).toBeGreaterThan(-1);
    expect(release.indexOf("**Actions**, **migrate**, **Run workflow**")).toBeGreaterThan(stop);
    // the first release's note no longer says an older worker running beside the new app makes nothing fail
    expect(runbook).not.toContain("an older worker leaves work it does not know in the queue, and nothing fails");
    const later = runbook.slice(runbook.indexOf("## Every later release"), runbook.indexOf("## Rollback"));
    expect(later).toContain("stop the old worker first");
    expect(read("packages/db/migrations/0037_person_decides_who_to_interview.sql")).toContain("It puts back only the moves made before it runs");
  });

  /**
   * The release review's second reading (11 November 2026, S-6): the Rollback section's own worker step brings back a build from
   * before 0037, which moves anyone who finishes an AI interview to "Interview to set up" under the old default again, and 0037
   * has already run, so nobody would put them back. The section says so, and how to put back only the people moved meanwhile.
   */
  it("says rolling the worker back past 0037 brings the old default back, and how to put back the people it moved meanwhile", () => {
    const runbook = read("docs/runbooks/production-setup.md");
    const rollback = runbook.slice(runbook.indexOf("## Rollback"), runbook.indexOf("## Hotfix"));
    const bullet = rollback.split("\n- ").find((b) => b.startsWith("**The worker back past 0037.**")) ?? "";
    expect(bullet).not.toBe("");
    for (const said of ["\"Interview to set up\"", "under the old default", "0037 has already run", "Prefer fixing forward", "`AND a.stage_changed_at >= '<when the rollback began>'`", "`workflow:screen`", "sends nothing"]) expect(bullet, said).toContain(said);
  });
});

describe("the API contracts", () => {
  it("say GET /applications/:id/interview-draft gives the \"Set a date and time\" form's defaults, not an approval card", () => {
    const draft = row(read("docs/12-api-contracts.md"), "GET", "/applications/:id/interview-draft");
    expect(draft).not.toBe("");
    expect(draft).toContain("The \"Set a date and time\" form's defaults");
    expect(draft).not.toMatch(/approval card filled in|is the one approval/);
  });
});
