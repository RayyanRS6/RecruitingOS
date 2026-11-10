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

describe("the API contracts", () => {
  it("say GET /applications/:id/interview-draft gives the \"Set a date and time\" form's defaults, not an approval card", () => {
    const draft = row(read("docs/12-api-contracts.md"), "GET", "/applications/:id/interview-draft");
    expect(draft).not.toBe("");
    expect(draft).toContain("The \"Set a date and time\" form's defaults");
    expect(draft).not.toMatch(/approval card filled in|is the one approval/);
  });
});
