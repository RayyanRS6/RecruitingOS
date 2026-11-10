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

describe("the API contracts", () => {
  it("say GET /applications/:id/interview-draft gives the \"Set a date and time\" form's defaults, not an approval card", () => {
    const draft = row(read("docs/12-api-contracts.md"), "GET", "/applications/:id/interview-draft");
    expect(draft).not.toBe("");
    expect(draft).toContain("The \"Set a date and time\" form's defaults");
    expect(draft).not.toMatch(/approval card filled in|is the one approval/);
  });
});
