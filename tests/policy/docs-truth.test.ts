import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The documents say what the product does now (the lead's small fixes of 10 November 2026): a row or a setup step that
 * still describes a flow the hiring build replaced, or a protection nobody checked, misleads whoever reads it next.
 */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("the setup documents", () => {
  it("name the Microsoft app registration as the sign-in page names the product, the name IT sees on Microsoft's consent screen", () => {
    const product = /const PRODUCT = "([^"]+)";/.exec(read("apps/web/src/pages/Login.tsx"))?.[1];
    expect(product).toBe("Recruiting OS");
    const runbook = read("docs/runbooks/production-setup.md");
    const microsoft = runbook.slice(runbook.indexOf("### Microsoft and Google sign-in"), runbook.indexOf("**Google**", runbook.indexOf("### Microsoft and Google sign-in")));
    expect(microsoft).toContain(`- Name: \`${product}\`, the product name the sign-in page uses`);
    // one Name line
    expect(microsoft.match(/^- Name: /gm)).toHaveLength(1);
  });
});

describe("the release runbook", () => {
  const SIMPLE_PRODUCT = ["0038_role_posts.sql", "0039_one_scoring_system.sql", "0040_states_the_code_knows.sql", "0041_storage_nothing_uses.sql"];

  /**
   * The release of the simple product (November 2026) drops what the build before it reads and writes (migrations 0039 to
   * 0041), and 0041 cannot be undone by a migration. So that release notes the point in time first, then stops the old
   * worker and the old app, and only then migrates. The rule for every later release stays: a migration that changes
   * what the live worker relies on stops that worker first (the release review of 11 November 2026).
   */
  it("for the simple product: the point in time, then the old worker and the old app stopped, then the migrations, each one named", () => {
    const runbook = read("docs/runbooks/production-setup.md");
    const release = runbook.slice(runbook.indexOf("### The release of the simple product"), runbook.indexOf("### The check with made-up people"));
    expect(release).not.toBe("");
    const steps = ["**Count what the drops leave behind, and note the point in time.**", "**Stop the old worker first.**", "**Stop the old app**", "**Actions**, **migrate**, **Run workflow**"].map((said) => release.indexOf(said));
    for (const at of steps) expect(at).toBeGreaterThan(-1);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    for (const file of SIMPLE_PRODUCT) {
      expect(release, file).toContain(`\`${file}\``);
      expect(read(`packages/db/migrations/${file}`).length, file).toBeGreaterThan(0);
    }
    expect(release).toContain("No migration can undo it");
    // the first release's note no longer says an older worker running beside the new app makes nothing fail
    expect(runbook).not.toContain("an older worker leaves work it does not know in the queue, and nothing fails");
    const later = runbook.slice(runbook.indexOf("## Every later release"), runbook.indexOf("### The release of the simple product"));
    expect(later).toContain("stop the old worker first");
  });

  /** No build from before the simple product can run on its database, so the Rollback section sends nobody back past it. */
  it("says nothing rolls back past the release of the simple product, and how that one release is undone while it is checked", () => {
    const runbook = read("docs/runbooks/production-setup.md");
    const rollback = runbook.slice(runbook.indexOf("## Rollback"), runbook.indexOf("## Hotfix")).split("\n- ");
    const never = rollback.find((b) => b.startsWith("**Never past the release of the simple product.**")) ?? "";
    for (const said of ["`0039_one_scoring_system.sql`", "`0041_storage_nothing_uses.sql`", "fix forward"]) expect(never, said).toContain(said);
    const database = rollback.find((b) => b.startsWith("**The database is never rolled back.**")) ?? "";
    expect(database).toContain("restore the database to the point in time");
    // the step for a worker older than 0037 went with the builds it was about
    expect(runbook).not.toContain("The worker back past 0037");
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
    expect(choices).toContain("intake");
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
   * The review of the live-test fixes (17 November 2026): the runbook's table said the button runs only the resume and
   * scoring checks, though it also offers the AI interview's chat and the job builder. Someone working from it would
   * never press it with `screen,chat`, which must pass on the real model before any real candidate.
   */
  it("the runbook's table names every Which tests choice the button offers", () => {
    const yml = read(".github/workflows/fairness.yml").replace(/\r\n/g, "\n");
    const tests = yml.slice(yml.indexOf("\n      tests:\n"), yml.indexOf("\n      screening_model:\n"));
    const choices: string[] = JSON.parse(/\n\s+options: (\[.*\])/.exec(tests)?.[1] ?? "[]");
    expect(choices).toEqual(expect.arrayContaining(["resume,triage", "screen,chat", "intake"]));
    const runbook = read("docs/runbooks/fairness-tests.md").replace(/\r\n/g, "\n");
    const checks = runbook.slice(runbook.indexOf("## What it checks"), runbook.indexOf("## Set it up once"));
    for (const rowName of ["| Twin resumes |", "| The AI interview |", "| Job builder |"]) expect(checks, rowName).toContain(rowName);
  });
});
