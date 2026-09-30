import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, candidates } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The load script (docs/spec/20 item 18) run for real, as a separate process with tsx, against this API served over
 * a local socket: it reads the form, posts made-up applications at the asked rate, meets the apply rate limit (four an
 * hour here), honours the Retry-After without failing, and reports the counts the staging run records.
 */
describe("scripts/load-apply.ts", () => {
  let container: Container;
  let server: Server;
  let base = "";
  let slug = "";
  let roleId = "";
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const script = join(repoRoot, "scripts", "load-apply.ts");
  /** Runs the script as its own process while this one keeps serving the API (a blocking spawn would starve the server). */
  const runScript = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, script, ...args], { cwd: repoRoot, env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the script did not finish in time\n${stdout}\n${stderr}`)); }, 110_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", RATE_LIMIT_OVERRIDES: JSON.stringify({ apply: 4 }) } });
    const app = createApp(container);
    // The Hono app on a plain node socket, the way the shell serves it, so the script talks real HTTP.
    server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) { if (typeof v === "string") headers.set(k, v); else if (Array.isArray(v)) for (const x of v) headers.append(k, x); }
        const method = req.method ?? "GET";
        const response = await app.fetch(new Request(`${base}${req.url}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(Buffer.concat(chunks)) }));
        const out: Record<string, string | string[]> = {};
        response.headers.forEach((value, key) => { out[key] = value; });
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@load.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    const owner = r2.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Load Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { slug: string };
    slug = co.slug;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.close();
  });

  it("posts synthetic applications at the asked rate, records the rate limit's refusals with their Retry-After, and reports the counts and latencies", async () => {
    const url = `${base}/careers/${slug}/jobs/${roleId}/apply`;
    const run = await runScript(["--url", url, "--count", "6", "--per-minute", "600", "--max-wait", "1", "--json"]);
    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1)!;
    const summary = JSON.parse(line) as { runId: string; requested: number; accepted: number; rateLimited: number; refused: number; serverErrors: number; errors: number; firstRateLimitAtRequest: number | null; retryAfterSeconds: { min: number; max: number } | null; waitedSeconds: number; latencyMs: { p50: number; p95: number; max: number; samples: number }; statuses: Record<string, number>; elapsedSeconds: number };
    expect(summary).toMatchObject({ requested: 6, accepted: 4, rateLimited: 2, refused: 0, serverErrors: 0, errors: 0, firstRateLimitAtRequest: 5 });
    expect(summary.retryAfterSeconds!.min).toBeGreaterThan(0);
    expect(summary.waitedSeconds).toBeGreaterThanOrEqual(1.5); // two refusals, each waited the capped second
    expect(summary.latencyMs.samples).toBe(4);
    expect(summary.latencyMs.p50).toBeGreaterThan(0);
    expect(summary.latencyMs.p95).toBeGreaterThanOrEqual(summary.latencyMs.p50);
    expect(summary.latencyMs.max).toBeGreaterThanOrEqual(summary.latencyMs.p95);
    expect(summary.statuses).toEqual({ "302": 4, "429": 2 });
    // the four that got through are ordinary careers-page applications by made-up people on the sink domain
    await container.drain();
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    expect(rows).toHaveLength(4);
    for (const a of rows) {
      expect(a.source).toBe("careers_page");
      expect((a.answers as { acknowledgment?: { noticeVersions: string[] } }).acknowledgment?.noticeVersions.length).toBeGreaterThan(0);
      const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
      expect(cand.email).toMatch(new RegExp(`^load-${summary.runId}-000[1-4]@blackhole\\.postmarkapp\\.com$`));
    }
  });

  it("refuses a production-looking address unless the host is named again, an address that is not an apply page, and a rate of zero", async () => {
    const foreign = await runScript(["--url", "https://jobs.example.com/careers/x/jobs/y/apply", "--count", "1"]);
    expect(foreign.status).toBe(2);
    expect(foreign.stderr).toContain("--confirm-host jobs.example.com");
    // a zero rate is a usage error, not one request followed by a silent hundred-minute wait
    const zeroRate = await runScript(["--url", `${base}/careers/${slug}/jobs/${roleId}/apply`, "--count", "1", "--per-minute", "0"]);
    expect(zeroRate.status).toBe(2);
    expect(zeroRate.stderr).toContain("--per-minute must be greater than 0");
    const wrongPath = await runScript(["--url", `${base}/careers/${slug}`, "--count", "1"]);
    expect(wrongPath.status).toBe(2);
    expect(wrongPath.stderr).toContain("apply address");
    const noArgs = await runScript([]);
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toContain("usage:");
  });
});
