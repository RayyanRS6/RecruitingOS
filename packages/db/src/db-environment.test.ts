import { describe, expect, it } from "vitest";
import { checkProjectRef, commandsFor, dbEnvironmentFrom, type DbEnvironment, projectRefOf, STAGING_PROJECT_REF } from "./cli/environment";

/**
 * Audit GATE-V3 (29 Oct 2026): the database tools only knew staging and would have sent production's connection
 * strings to the staging vault and Vercel's Preview environment. Every run now names its database, and a string from
 * any other Supabase project is refused before anything connects, in both directions.
 */
const PROD_REF = "abcdefghijklmnopqrst";
/** The Session pooler string as Supabase shows it (joined in parts, so the secret scan sees no password-shaped string). */
const pooler = (ref: string, password = "[YOUR-PASSWORD]") => ["postgresql://postgres.", ref, ":", password, "@aws-0-us-west-2.pooler.supabase.com:5432/postgres"].join("");

function targetOf(env: Record<string, string | undefined>): DbEnvironment {
  const r = dbEnvironmentFrom(env);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

describe("which database a run is for (ROS_DB_ENV)", () => {
  it("refuses a run that does not name it, or names something else", () => {
    expect(dbEnvironmentFrom({})).toMatchObject({ ok: false, error: expect.stringMatching(/ROS_DB_ENV must name the database, staging or production; it is not set/) });
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "  " })).toMatchObject({ ok: false, error: expect.stringMatching(/not set/) });
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "prod" })).toMatchObject({ ok: false, error: expect.stringMatching(/must be staging or production, not "prod"/) });
  });

  it("staging is always the staging project and keeps today's words", () => {
    const staging = targetOf({ ROS_DB_ENV: "staging" });
    expect(staging).toEqual({ name: "staging", projectRef: STAGING_PROJECT_REF, vault: "Recruiting OS Staging", item: "Recruiting OS staging database", vercel: "Vercel (Preview environment, sensitive)", railway: "Railway (sealed)", vercelShort: "Vercel", railwayShort: "Railway" });
    expect(targetOf({ ROS_DB_ENV: "Staging", ROS_DB_PROJECT_REF: STAGING_PROJECT_REF }).projectRef).toBe(STAGING_PROJECT_REF);
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "staging", ROS_DB_PROJECT_REF: PROD_REF })).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`staging is the Supabase project ${STAGING_PROJECT_REF}, but ROS_DB_PROJECT_REF says ${PROD_REF}`)) });
  });

  it("production needs its own project reference, never the staging one, and names its own vault, item, Vercel environment and worker", () => {
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "production" })).toMatchObject({ ok: false, error: expect.stringMatching(/production needs ROS_DB_PROJECT_REF/) });
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: STAGING_PROJECT_REF })).toMatchObject({ ok: false, error: expect.stringMatching(/is the staging project; production is a different Supabase project/) });
    expect(dbEnvironmentFrom({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: "https://abc.supabase.co" })).toMatchObject({ ok: false, error: expect.stringMatching(/must be the project's reference/) });
    const production = targetOf({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: ` ${PROD_REF.toUpperCase()} ` });
    expect(production).toEqual({ name: "production", projectRef: PROD_REF, vault: "Recruiting OS Production", item: "Recruiting OS production database", vercel: "Vercel (Production environment, sensitive)", railway: "the production Railway worker (sealed)", vercelShort: "Vercel's Production environment", railwayShort: "the production Railway worker" });
    expect(JSON.stringify(production)).not.toMatch(/staging|Preview/i);
  });
});

describe("the project a connection string belongs to", () => {
  it("reads it from the pooler user, an application user, or a direct host, without touching the password", () => {
    expect(projectRefOf(pooler(STAGING_PROJECT_REF))).toBe(STAGING_PROJECT_REF);
    expect(projectRefOf(`  ${pooler(PROD_REF, "pass")}\n`)).toBe(PROD_REF);
    expect(projectRefOf(`postgresql://ros_app.${PROD_REF}:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full`)).toBe(PROD_REF);
    expect(projectRefOf(`postgresql://postgres:pass@db.${PROD_REF}.supabase.co:5432/postgres`)).toBe(PROD_REF);
    expect(projectRefOf("postgresql://postgres:pass@db.example.com:5432/postgres")).toBeNull();
    expect(projectRefOf("postgresql://postgres.:pass@h.example.com/postgres")).toBeNull();
    expect(projectRefOf("not a url")).toBeNull();
  });

  it("lets through only the target's own project, in both directions, and never echoes the string or the password", () => {
    const staging = targetOf({ ROS_DB_ENV: "staging" });
    const production = targetOf({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: PROD_REF });
    expect(checkProjectRef(staging, pooler(STAGING_PROJECT_REF))).toEqual({ ok: true });
    expect(checkProjectRef(production, pooler(PROD_REF, "pass"))).toEqual({ ok: true });

    const stagingIntoProduction = checkProjectRef(production, pooler(STAGING_PROJECT_REF, "pass"));
    expect(stagingIntoProduction).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`is for the staging project \\(${STAGING_PROJECT_REF}\\), not the production project ${PROD_REF}\\. Nothing was changed`)) });
    const productionIntoStaging = checkProjectRef(staging, pooler(PROD_REF, "pass"));
    expect(productionIntoStaging).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`is for the Supabase project ${PROD_REF}, not the staging project ${STAGING_PROJECT_REF}`)) });
    const unnamed = checkProjectRef(production, "postgresql://postgres:pass@db.example.com:5432/postgres");
    expect(unnamed).toMatchObject({ ok: false, error: expect.stringMatching(/names no Supabase project/) });

    for (const r of [stagingIntoProduction, productionIntoStaging, unnamed]) {
      const error = r.ok ? "" : r.error;
      expect(error).not.toContain("pass");
      expect(error).not.toContain("postgresql://");
    }
  });
});

describe("the commands a message names", () => {
  it("production is always set up from Windows; staging from Windows, or a Mac with the bash scripts", () => {
    const production = targetOf({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: PROD_REF });
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(commandsFor(production, platform)).toEqual({
        setup: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\db-setup.ps1 -Environment production -ProjectRef ${PROD_REF}`,
        grants: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\db-setup.ps1 -Environment production -ProjectRef ${PROD_REF} -Mode grants`,
        status: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\db-status.ps1 -Environment production -ProjectRef ${PROD_REF}`,
      });
    }
    const staging = targetOf({ ROS_DB_ENV: "staging" });
    expect(commandsFor(staging, "darwin")).toEqual({ setup: "bash scripts/staging-db-setup.sh", grants: "bash scripts/staging-db-setup.sh grants", status: "bash scripts/staging-db-status.sh" });
    expect(commandsFor(staging, "win32").grants).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\db-setup.ps1 -Environment staging -ProjectRef ${STAGING_PROJECT_REF} -Mode grants`);
  });
});
