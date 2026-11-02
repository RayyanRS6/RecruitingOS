import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGING_PROJECT_REF } from "./cli/environment";

/**
 * The database tools' own refusals, run for real as the setup scripts run them (tsx, one process each): no database
 * named, a string from another Supabase project, production strings asked to show on screen. Each must stop with exit
 * code 2 before anything connects. The owner string points at 127.0.0.1 port 1, where nothing answers: a tool that
 * connected first would fail differently (exit 1, "could not connect"), so a check moved after the connection fails
 * here. The pure rules are in db-environment.test.ts; this holds each tool to calling them first.
 */
const DB_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
const PROD_REF = "abcdefghijklmnopqrst";
/** A Session pooler string for a project, at an address where nothing answers (joined in parts for the secret scan). */
const owner = (ref: string) => ["postgresql://postgres.", ref, ":", "not-a-real-password", "@127.0.0.1:1/postgres"].join("");

/** The process's environment without anything a tool reads, so the outer shell cannot steer a case. */
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ROS_|MIGRATE_DATABASE_URL$|DATABASE_URL$|DATABASE_SSL_CA)/.test(k)));

function run(tool: string, env: Record<string, string>, input = ""): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, join("src", "cli", tool)], { cwd: DB_PACKAGE, env: { ...clean, NODE_ENV: "test", ...env }, input, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("the database tools refuse before anything connects", () => {
  it("status, provision and fill-password refuse to run without ROS_DB_ENV", () => {
    for (const tool of ["status.ts", "provision.ts"]) {
      const r = run(tool, { MIGRATE_DATABASE_URL: owner(STAGING_PROJECT_REF) });
      expect(r.status, tool).toBe(2);
      expect(r.stderr, tool).toMatch(/ROS_DB_ENV must name the database, staging or production; it is not set, so nothing was done/);
      expect(r.stdout + r.stderr, tool).not.toMatch(/connect/i);
    }
    const filled = run("fill-password.ts", { ROS_OWNER_URI: owner(STAGING_PROJECT_REF).replace("not-a-real-password", "[YOUR-PASSWORD]") }, "typed-password-123\n");
    expect(filled.status).toBe(2);
    expect(filled.stderr).toMatch(/fill-password: ROS_DB_ENV must name the database/);
    expect(filled.stdout).toBe(""); // no completed string
    expect(filled.stderr).not.toContain("typed-password-123");
  });

  it("refuses an owner string from another Supabase project: status and migrate, either way round", () => {
    const status = run("status.ts", { ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: PROD_REF, MIGRATE_DATABASE_URL: owner(STAGING_PROJECT_REF) });
    expect(status.status).toBe(2);
    expect(status.stderr).toContain(`status: the connection string is for the staging project (${STAGING_PROJECT_REF}), not the production project ${PROD_REF}`);
    const migrate = run("migrate.ts", { ROS_DB_ENV: "staging", MIGRATE_DATABASE_URL: owner(PROD_REF) });
    expect(migrate.status).toBe(2);
    expect(migrate.stderr).toContain(`migrate: the connection string is for the Supabase project ${PROD_REF}, not the staging project ${STAGING_PROJECT_REF}`);
    for (const r of [status, migrate]) {
      expect(r.stdout + r.stderr).not.toContain("not-a-real-password");
      expect(r.stdout + r.stderr).not.toMatch(/could not connect/);
    }
  });

  it("never shows production connection strings on screen: provision refuses print delivery before the passwords change", () => {
    const password = "A".repeat(30);
    const r = run("provision.ts", { ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: PROD_REF, MIGRATE_DATABASE_URL: owner(PROD_REF), ROS_APP_PASSWORD: password, ROS_WORKER_PASSWORD: password });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/provision: production connection strings are never shown on screen; nothing was changed/);
    expect(r.stdout + r.stderr).not.toMatch(/could not connect|passwords set/);
  });
});
