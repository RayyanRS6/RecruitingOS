import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Audit OPS-2: drizzle wraps every failed query as "Failed query: <sql>\nparams: <values>", and Postgres names the values
 * it refused, so an error's message can carry a candidate's name, address or answers. Vercel and Railway keep every log
 * line. So an error reaches a console call only through a scrubber: errorForLog or redactString (@ros/core),
 * redactDatabaseValues or withoutDatabaseValues (@ros/contracts), redact, describeFailure (apps/api/src/failure-reports.ts),
 * describeConnectionError, or the engine's errorText. A console call that names an error's message or stack, String(err)
 * or the error itself outside one of them fails this test, and so does console passed as a callback, which would print
 * whatever error it is handed. Console calls are written one to a line here; the check reads them line by line.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = ["apps/api/src", "apps/shell/app", "apps/shell/lib", "apps/shell/instrumentation.ts", "apps/shell/instrumentation-node.ts", "apps/shell/middleware.ts", "packages"];
/** Where console output is not a hosted process's log line, each with its reason. */
const EXEMPT: Record<string, string> = {
  "packages/db/src/cli/": "the founder's own database tools print to her terminal, through describeConnectionError and messages of their own",
  "packages/db/src/client.ts": "a pooled connection's own socket error carries no query values: drizzle wraps query failures, not these",
  "packages/evals/": "evaluation runs print to CI and a developer's terminal, on made-up fixtures",
};

const CONSOLE_CALL = /\bconsole\.(?:log|info|warn|error|debug)\(/;
const CONSOLE_AS_CALLBACK = /[(,]\s*console\.(?:log|info|warn|error|debug)\s*[),]/;
/** A scrubber's call with everything inside it (two levels of nested parentheses, as in `x(err instanceof Error ? err.message : String(err))`). */
const SCRUBBED = /\b(?:errorForLog|redactString|redactText|redactDatabaseValues|withoutDatabaseValues|redact|describeFailure|describeConnectionError|errorText)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;
/** An error's own words, or the error itself handed to the console. */
const RAW_ERROR = /\.message\b|\.stack\b|\bString\((?:err|error|e|cause|reason)\)|[(,]\s*(?:err|error|e|cause)\s*\)/;

/** Whether a line prints an error's words unscrubbed: read from the console call on (a `.catch((err) =>` before it is not printed). */
const unscrubbedLine = (line: string) => {
  const at = line.search(CONSOLE_CALL);
  return (at >= 0 && RAW_ERROR.test(line.slice(at).replace(SCRUBBED, ""))) || CONSOLE_AS_CALLBACK.test(line);
};

/** Repo-relative with forward slashes on every platform. */
const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

function walk(path: string, out: string[] = []): string[] {
  if (!statSync(path).isDirectory()) {
    out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === ".data" || name === "results") continue;
    const p = join(path, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every console call in server code that would print an error's words unscrubbed, as "file:line: text". */
function unscrubbed(): string[] {
  const hits: string[] = [];
  for (const file of SERVER.flatMap((d) => walk(join(ROOT, d))).map(rel).sort()) {
    if (Object.keys(EXEMPT).some((e) => file === e || (e.endsWith("/") && file.startsWith(e)))) continue;
    for (const [i, line] of readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).entries()) {
      if (unscrubbedLine(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  }
  return hits;
}

describe("error text in log lines (audit OPS-2)", () => {
  it("reaches a console call only through a scrubber, so a failed query's values never reach the hosts' logs", () => {
    expect(unscrubbed(), "Wrap the error in errorForLog(err) from @ros/core (or another scrubber named in tests/policy/log-scrubbing.test.ts).").toEqual([]);
  });

  it("tells a scrubbed call from a raw one", () => {
    for (const raw of [
      'console.warn("[x] failed: " + (err instanceof Error ? err.message : String(err)));',
      '.catch((err) => console.warn("[x] failed: " + (err instanceof Error ? err.message : String(err))));',
      'console.error("[x] failed", err);',
      "console.error(err);",
      'console.warn("[x] " + error.message);',
      'console.warn("[x] " + redactString(other) + " " + err.message);',
      "promise.catch(console.error);",
    ]) expect(unscrubbedLine(raw), raw).toBe(true);
    for (const scrubbed of [
      'console.warn("[x] failed: " + errorForLog(err));',
      '.catch((err) => console.warn("[x] failed: " + errorForLog(err)));',
      'console.error("[x] " + redactString(err instanceof Error ? err.message : String(err)));',
      'console.error("[worker] tick failed", redact(safe));',
      'console.error("[worker] tick failed", withoutDatabaseValues(err));',
      'console.warn("[privacy] could not be sent: " + describeFailure(err instanceof Error ? err.message : String(err)));',
      'console.log("[worker] started (db: " + kind + ")");',
    ]) expect(unscrubbedLine(scrubbed), scrubbed).toBe(false);
  });
});
