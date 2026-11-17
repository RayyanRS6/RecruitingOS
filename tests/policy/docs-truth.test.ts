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

describe("the fairness runbook", () => {
  /**
   * The second review of the live-test fixes (12 November 2026, #7 and #9): step 2 said "or the last option for both" once
   * the job builder's choice had been added last, so someone who wanted the CV and chat checks together ran only the job
   * builder's. The runbook names each "Which tests" choice by its value, which a later choice never moves, and the model
   * and effort it says to keep for the job builder are the workflow's own defaults.
   */
  it("names every Which tests choice by its value, never by its place, and the model and effort it says to keep", () => {
    const yml = read(".github/workflows/fairness.yml").replace(/\r\n/g, "\n");
    /** One input of the dispatch form: from its key to the line `next` starts. */
    const input = (id: string, next: string) => {
      const at = yml.indexOf(`\n      ${id}:\n`);
      return at < 0 ? "" : yml.slice(at, yml.indexOf(next, at + 1));
    };
    const choices: string[] = JSON.parse(/\n\s+options: (\[.*\])/.exec(input("tests", "\n      screening_model:\n"))?.[1] ?? "[]");
    expect(choices).toContain("intake,packet.revise");
    const runbook = read("docs/runbooks/fairness-tests.md").replace(/\r\n/g, "\n");
    const runIt = runbook.slice(runbook.indexOf("## Run it"), runbook.indexOf("## If a check fails"));
    expect(runIt).toContain("**Which tests**");
    // in backticks, so `resume,triage` is never satisfied by `resume,triage,screen,chat`
    for (const choice of choices) expect(runIt, choice).toContain(`\`${choice}\``);
    expect(runbook).not.toMatch(/\b(?:first|second|third|fourth|fifth|last) option\b/i);
    for (const [id, next] of [["screening_model", "\n      screening_effort:\n"], ["screening_effort", "\npermissions:"]] as const) {
      const value = /\n\s+default: (.+)/.exec(input(id, next))?.[1]?.trim().replace(/^"(.*)"$/, "$1");
      expect(value, id).toBeTruthy();
      expect(runIt, id).toContain(`\`${value}\``);
    }
  });

  /**
   * The review of the live-test fixes (17 November 2026): the decisions register's row, the runbook's table and the release
   * checklist said the button runs only the résumé and scoring checks, though it has offered the screening chat since Wave S7
   * and the job builder since the live test. Someone working through the checklist would never press it with `screen,chat`,
   * which must pass on the real model before any real candidate.
   */
  it("the release checklist, the decisions register and the runbook's table name every Which tests choice the button offers", () => {
    const yml = read(".github/workflows/fairness.yml").replace(/\r\n/g, "\n");
    const tests = yml.slice(yml.indexOf("\n      tests:\n"), yml.indexOf("\n      screening_model:\n"));
    const choices: string[] = JSON.parse(/\n\s+options: (\[.*\])/.exec(tests)?.[1] ?? "[]");
    expect(choices).toEqual(expect.arrayContaining(["resume,triage", "screen,chat", "intake,packet.revise"]));
    const checklist = read("docs/regression-checklist.md").replace(/\r\n/g, "\n");
    const at = checklist.indexOf("- [ ] **The fairness test button.**");
    expect(at).toBeGreaterThan(-1);
    const button = checklist.slice(at, checklist.indexOf("\n- [ ] **", at + 1));
    // in backticks, so `resume,triage` is never satisfied by `resume,triage,screen,chat`
    for (const choice of choices) expect(button, choice).toContain(`\`${choice}\``);
    expect(checklist).not.toMatch(/runs the résumé and reading suites|runs only the résumé|Not covered by the button: the screening/);
    const register = read("docs/workflow-decisions.md").split("\n").find((l) => l.startsWith('| A "Run fairness tests" GitHub Actions button on the real model |')) ?? "";
    expect(register).not.toBe("");
    for (const choice of choices) expect(register, choice).toContain(`\`${choice}\``);
    expect(register).not.toMatch(/does not run the screening-chat tests/);
    const runbook = read("docs/runbooks/fairness-tests.md").replace(/\r\n/g, "\n");
    const checks = runbook.slice(runbook.indexOf("## What it checks"), runbook.indexOf("## Set it up once"));
    for (const rowName of ["| Twin CVs |", "| Screening chat |", "| Job builder |"]) expect(checks, rowName).toContain(rowName);
  });
});

describe("the API contracts", () => {
  it("say GET /applications/:id/interview-draft gives the \"Set a date and time\" form's defaults, not an approval card", () => {
    const draft = row(read("docs/12-api-contracts.md"), "GET", "/applications/:id/interview-draft");
    expect(draft).not.toBe("");
    expect(draft).toContain("The \"Set a date and time\" form's defaults");
    expect(draft).not.toMatch(/approval card filled in|is the one approval/);
  });

  /**
   * The second review of the live-test fixes (12 November 2026, #34): LT-8 and the contracts said every answer to a private
   * decision names the safety net's day, but Review and apply names none, and a job close names it only when someone the
   * team can see moved. A change that trusted them would fall back to the reader's own calendar, the live test's L5.
   */
  it("say which answers name the safety net's day: a decision on one person, a job close only when someone the team can see moved, never Review and apply", () => {
    const lt8 = read("docs/workflow-decisions.md").split("\n").find((l) => l.startsWith("| LT-8 |")) ?? "";
    expect(lt8).toContain("Every answer to a private decision made on one person");
    expect(lt8).toContain("closing a job carries it only when someone the team can see moved, and Review and apply carries none");
    expect(lt8).not.toContain("closing a job) carries the day");
    const doc = read("docs/12-api-contracts.md");
    expect(row(doc, "POST", "/roles/:id/outcome")).toContain("only when someone the team can see moved");
    expect(row(doc, "POST", "/roles/:id/batch")).toContain("Its results name no safety-net day (no `untoldFallbackOn`");
    expect(row(doc, "GET", "/applications/:id")).toContain("not Review and apply, `POST /roles/:id/batch`, whose results name none, and a job close only when someone the team can see moved");
  });

  /**
   * The review of the employer-verbs fix (17 November 2026): the requirements check's row said only a deal-breaker about
   * what the employer does to the people applying loses its one tap, but every deal-breaker whose words `mustHaveOf` leaves
   * as typed does, "Can't take x-rays" among them, since "take" and "use" count (LT-32).
   */
  it("say the requirements check gives no one tap for a deal-breaker's very words that mustHaveOf leaves as typed, take and use among its verbs", () => {
    const check = row(read("docs/12-api-contracts.md"), "GET", "/roles/:id/requirements-check");
    expect(check).not.toBe("");
    for (const said of ["a deal-breaker whose words `mustHaveOf` leaves as typed (LT-32", '"take" and "use" among them', "\"Can't take x-rays\""]) expect(check, said).toContain(said);
    expect(check).not.toContain("a deal-breaker about what the employer does to the people applying");
  });
});
