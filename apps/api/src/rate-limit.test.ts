import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FakeSharedCounter, MemoryRateLimitStore, SharedRateLimitStore, UpstashSharedCounter, createRateLimitStore, entitlements, rateLimitKey } from "@ros/core";
import { adminAlerts, applications, auditRecords } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { loadEnv } from "./env";

/**
 * Founder instruction of 21 September 2026, item 5: shared, provider-neutral rate limiting on every public surface,
 * keyed by hashes (never by a person's data), answering 429 with a Retry-After, recording security events, and never
 * refusing a provider's valid webhook retry.
 */
describe("rate limiting", () => {
  it("the memory store counts fixed windows and resets", async () => {
    const s = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    expect((await s.hit("k", 1000, 2, t0)).allowed).toBe(true);
    expect((await s.hit("k", 1000, 2, t0 + 10)).allowed).toBe(true);
    const third = await s.hit("k", 1000, 2, t0 + 20);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBe(1);
    expect((await s.peek("k", 1000, 2, t0 + 30)).count).toBe(3);
    expect((await s.hit("k", 1000, 2, t0 + 1001)).allowed).toBe(true);
  });

  it("the shared store makes separate processes see one counter; different stores stay apart", async () => {
    FakeSharedCounter.reset();
    const a = new SharedRateLimitStore(new FakeSharedCounter("fake://one"));
    const b = new SharedRateLimitStore(new FakeSharedCounter("fake://one"));
    const other = new SharedRateLimitStore(new FakeSharedCounter("fake://two"));
    const t0 = 60_000 * 1234;
    expect((await a.hit("k", 60_000, 2, t0)).count).toBe(1);
    expect((await b.hit("k", 60_000, 2, t0 + 5)).count).toBe(2);
    expect((await a.hit("k", 60_000, 2, t0 + 6)).allowed).toBe(false);
    expect((await other.hit("k", 60_000, 2, t0 + 6)).allowed).toBe(true);
    expect((await b.peek("k", 60_000, 2, t0 + 7)).count).toBe(3);
    // next window
    expect((await a.hit("k", 60_000, 2, t0 + 60_000)).count).toBe(1);
  });

  it("keys are keyed hashes: no address, email or token survives into the store, and nobody without the secret can predict a key", () => {
    const k = rateLimitKey("secret-a", "candidate.privacy_request", "token", "AbCdEfGh1234567890abcdefghijk");
    expect(k).toMatch(/^[0-9a-f]{40}$/);
    expect(k).not.toContain("AbCd");
    expect(rateLimitKey("secret-a", "x", "ip", "203.0.113.5")).not.toContain("203");
    expect(rateLimitKey("secret-a", "x", "email", "a@b.test")).not.toBe(rateLimitKey("secret-a", "y", "email", "a@b.test"));
    expect(rateLimitKey("secret-a", "x", "email", "a@b.test")).not.toBe(rateLimitKey("secret-b", "x", "email", "a@b.test"));
  });

  it("the Upstash counter increments and expires a window key in one atomic script, shares counts across stores, and never puts the token or a subject in a key", async () => {
    const calls: Array<{ url: string; body: unknown[]; auth: string }> = [];
    const table = new Map<string, number>();
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown[];
      calls.push({ url, body, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? "" });
      if (body[0] === "EVAL") { const key = String(body[3]); const n = (table.get(key) ?? 0) + 1; table.set(key, n); return new Response(JSON.stringify({ result: n })); }
      if (body[0] === "GET") return new Response(JSON.stringify({ result: table.has(String(body[1])) ? String(table.get(String(body[1]))) : null }));
      return new Response(JSON.stringify({ error: "unknown" }));
    }) as unknown as typeof fetch;
    const mk = () => new SharedRateLimitStore(new UpstashSharedCounter({ url: "https://complete-narwhal-292092.upstash.io", token: "upstash-token-for-tests-abcdefghij", fetch: fakeFetch }));
    const a = mk();
    const b = mk();
    const now = 1_760_000_000_000;
    const key = rateLimitKey("s", "auth.mfa", "ip", "203.0.113.5");
    expect((await a.hit(key, 60_000, 3, now)).count).toBe(1);
    expect((await b.hit(key, 60_000, 3, now)).count).toBe(2);
    expect((await a.peek(key, 60_000, 3, now)).count).toBe(2);
    expect((await b.hit(key, 60_000, 3, now)).allowed).toBe(true);
    expect((await a.hit(key, 60_000, 3, now)).allowed).toBe(false);
    const first = calls[0]!;
    expect(first.url).toBe("https://complete-narwhal-292092.upstash.io");
    expect(first.auth).toBe("Bearer upstash-token-for-tests-abcdefghij");
    expect(first.body[0]).toBe("EVAL");
    expect(String(first.body[1])).toContain("PEXPIRE");
    expect(first.body[2]).toBe(1);
    expect(String(first.body[3])).toMatch(/^rl:[0-9a-f]{40}:\d+$/);
    // the expiry is the rest of the window plus a second, never longer than the window
    expect(Number(first.body[4])).toBeLessThanOrEqual(61_000);
    expect(Number(first.body[4])).toBeGreaterThan(0);
    for (const c of calls) { expect(JSON.stringify(c.body)).not.toContain("203.0.113.5"); expect(JSON.stringify(c.body)).not.toContain("upstash-token"); }
  });

  it("when Upstash is unreachable the counter keeps counting in this process, reports the degradation once, and refuses nothing for that reason", async () => {
    let fail = true;
    const fakeFetch = (async () => { if (fail) throw new Error("ECONNRESET"); return new Response(JSON.stringify({ result: 1 })); }) as unknown as typeof fetch;
    const reports: string[] = [];
    const counter = new UpstashSharedCounter({ url: "https://x.upstash.io", token: "upstash-token-for-tests-abcdefghij", fetch: fakeFetch, onDegraded: (r) => reports.push(r), degradedReportEveryMs: 3_600_000 });
    const store = new SharedRateLimitStore(counter);
    const now = 1_760_000_000_000;
    expect((await store.hit("k", 60_000, 2, now)).count).toBe(1);
    expect((await store.hit("k", 60_000, 2, now)).count).toBe(2);
    expect((await store.hit("k", 60_000, 2, now)).allowed).toBe(false);
    expect(reports.length).toBe(1);
    // a 429 or 5xx from the service degrades the same way
    fail = false;
    const refusing = new UpstashSharedCounter({ url: "https://x.upstash.io", token: "upstash-token-for-tests-abcdefghij", fetch: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch, onDegraded: (r) => reports.push(r) });
    expect(await refusing.incr("k2", 1000, now)).toBe(1);
    expect(await refusing.incr("k2", 1000, now)).toBe(2);
    expect(reports.length).toBe(2);
    expect(reports[1]).toContain("429");
  });

  it("the store factory: memory, the fake shared counter, upstash, and a refusal for anything else", () => {
    expect(createRateLimitStore({ RATE_LIMIT_STORE: "memory" }).id).toBe("memory");
    expect(createRateLimitStore({ RATE_LIMIT_STORE: "fake" }).id).toBe("shared:fake");
    expect(() => createRateLimitStore({ RATE_LIMIT_STORE: "somethingelse" })).toThrow(/memory.*upstash.*fake/);
    expect(() => createRateLimitStore({ RATE_LIMIT_STORE: "shared" })).toThrow(/memory.*upstash.*fake/);
    expect(() => createRateLimitStore({ RATE_LIMIT_STORE: "upstash" })).toThrow(/UPSTASH_REDIS_REST_URL/);
    expect(createRateLimitStore({ RATE_LIMIT_STORE: "upstash", UPSTASH_REDIS_REST_URL: "https://complete-narwhal-292092.upstash.io", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-tests-abcdefghij" }).id).toBe("shared:upstash");
    // the earlier spelling is still understood by the environment loader
    expect(loadEnv({ RATE_LIMIT_STORE: "shared", RATE_LIMIT_SHARED_PROVIDER: "upstash" }).RATE_LIMIT_STORE).toBe("upstash");
    expect(loadEnv({ RATE_LIMIT_STORE: "shared" }).RATE_LIMIT_STORE).toBe("fake");
  });

  describe("on the API and the candidate pages", () => {
    let container: Container;
    let app: ReturnType<typeof createApp>;
    let second: ReturnType<typeof createApp>;
    let owner = "";
    let companySlug = "";
    let roleId = "";
    let statusToken = "";
    const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", RATE_LIMIT_OVERRIDES: JSON.stringify({ "api.user": 6, "webhook.auth_failed": 3, "auth.magic_link": 4 }), POSTMARK_WEBHOOK_SECRET: "whsec-test" };
    const post = (a: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) => a.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", ...headers }, body: new URLSearchParams(fields).toString() });
    const signIn = async (email: string) => {
      const r1 = await post(app, "/api/v1/auth/magic-link", { email }, { "x-forwarded-for": "198.51.100.9" });
      const { devLink } = (await r1.json()) as { devLink: string };
      const token = new URL(devLink).searchParams.get("token")!;
      const r2 = await post(app, "/api/v1/auth/magic-link/consume", { token });
      return r2.headers.get("set-cookie")!.split(";")[0];
    };
    const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

    beforeAll(async () => {
      FakeSharedCounter.reset();
      container = await createContainer({ memory: true, env });
      app = createApp(container);
      // a second process sharing the same store (same URL), as two API instances would
      const other = await createContainer({ memory: true, env });
      second = createApp(other);
      owner = await signIn("owner@limits.test");
      const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Limits Inc", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
      companySlug = co.slug;
      await entitlements.applyPlan(container.db, co.id, "growth");
      const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
      roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
      await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
      const fd = new FormData();
      fd.set("firstName", "Rosa"); fd.set("lastName", "Diaz"); fd.set("email", "rosa.diaz@example.com"); fd.set("phone", "(949) 555-0100"); fd.set("smsConsent", "no"); fd.set("locationText", "Tustin, CA");
      fd.set("resume", new File(["Rosa Diaz, RDH"], "rosa.txt", { type: "text/plain" }));
      for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
      fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
      const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": "198.51.100.10" } });
      statusToken = r.headers.get("location")!.split("/c/status/")[1].split("?")[0];
      await container.drain();
    });
    afterAll(async () => {
      await container.close();
    });

    it("sign-in requests are limited per address and per email, with a clear 429 and Retry-After; another address is unaffected", async () => {
      const ip = { "x-forwarded-for": "203.0.113.1" };
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await post(app, "/api/v1/auth/magic-link", { email: `p${i}@limits.test` }, ip)).status);
      expect(statuses.slice(0, 4).every((s) => s === 200)).toBe(true);
      expect(statuses[4]).toBe(429);
      const r = await post(app, "/api/v1/auth/magic-link", { email: "p9@limits.test" }, ip);
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = (await r.json()) as { error: { code: string; retryAfterSeconds: number; message: string } };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.error.message).toMatch(/Try again in/);
      // a different address still works; the same email from many addresses trips the email rule (4 with the override)
      expect((await post(app, "/api/v1/auth/magic-link", { email: "fresh@limits.test" }, { "x-forwarded-for": "203.0.113.2" })).status).toBe(200);
      const perEmail: number[] = [];
      for (let i = 0; i < 6; i++) perEmail.push((await post(app, "/api/v1/auth/magic-link", { email: "target@limits.test" }, { "x-forwarded-for": `203.0.113.${20 + i}` })).status);
      expect(perEmail.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    });

    it("limits are shared across API processes", async () => {
      const ip = { "x-forwarded-for": "203.0.113.50" };
      for (let i = 0; i < 4; i++) expect((await post(app, "/api/v1/auth/magic-link", { email: `s${i}@limits.test` }, ip)).status).toBe(200);
      // the fifth request arrives at the other process and is refused there too
      expect((await post(second, "/api/v1/auth/magic-link", { email: "s5@limits.test" }, ip)).status).toBe(429);
    });

    it("candidate link endpoints are limited per token and per address; the page answers in plain language; the audit carries no token", async () => {
      const ip = { "x-forwarded-for": "203.0.113.77" };
      const results: number[] = [];
      for (let i = 0; i < 6; i++) results.push((await form(`/c/status/${statusToken}/privacy`, { kind: "access", details: `attempt ${i}` }, ip)).status);
      expect(results.slice(0, 5).every((s) => s === 302)).toBe(true);
      expect(results[5]).toBe(429);
      const r = await form(`/c/status/${statusToken}/privacy`, { kind: "access", details: "again" }, ip);
      expect(r.status).toBe(429);
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      expect(r.headers.get("retry-after")).toBeTruthy();
      expect(await r.text()).toMatch(/Please try again in \d+ minute/);
      const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "security.rate_limited"));
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const mine = audits.filter((a) => (a.details as { policy: string }).policy === "candidate.privacy_request");
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(mine)).not.toContain(statusToken);
      expect((mine[0].details as { path: string }).path).toBe("/c/status/[token]/privacy");
      expect((mine[0].details as { keyHash: string }).keyHash).toMatch(/^[0-9a-f]{16}$/);
      // repeated trips raise an alert for the console
      for (let i = 0; i < 5; i++) await form(`/c/status/${statusToken}/privacy`, { kind: "access", details: "again" }, ip);
      const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "security.suspicious_activity"));
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(alerts)).not.toContain(statusToken);
      // the application itself is untouched by the refused requests
      const [a] = await container.db.select().from(applications).where(eq(applications.statusToken, statusToken));
      expect(a.stage).not.toBe("withdrawn");
    });

    it("authenticated API calls are limited per user (override 6 per minute here) and answer JSON with Retry-After; another user is untouched", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await json(owner, "GET", "/api/v1/auth/me")).status);
      expect(statuses).toContain(429);
      const r = await json(owner, "GET", "/api/v1/auth/me");
      expect(r.status).toBe(429);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
      expect(r.headers.get("retry-after")).toBeTruthy();
      const otherUser = await signIn("someone-else@limits.test");
      expect((await json(otherUser, "GET", "/api/v1/auth/me")).status).toBe(200);
    });

    it("an empty forwarded-for header is not a way around per-address limits", async () => {
      const empty = { "x-forwarded-for": "" };
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await post(app, "/api/v1/auth/magic-link", { email: `e${i}@limits.test` }, empty)).status);
      expect(statuses).toContain(429);
    });

    it("the tenant tier, the provider tier, the application form and the candidate pages each answer 429 (never 500) when they trip", async () => {
      // each scenario gets its own process with its own overrides
      const mk = async (overrides: Record<string, number>, url: string) => { const c = await createContainer({ memory: true, env: { ...env, RATE_LIMIT_SHARED_URL: url, RATE_LIMIT_OVERRIDES: JSON.stringify(overrides) } }); return { c, a: createApp(c) }; };
      // tenant tier: the whole company shares a budget
      {
        const { c, a } = await mk({ "api.user": 100, "api.tenant": 3 }, "fake://tenant-tier");
        const r1 = await post(a, "/api/v1/auth/magic-link", { email: "t-owner@limits.test" }, { "x-forwarded-for": "198.51.100.30" });
        const { devLink } = (await r1.json()) as { devLink: string };
        const r2 = await post(a, "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token")! });
        const cookie = r2.headers.get("set-cookie")!.split(";")[0];
        await a.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Tenant Tier Co", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] }) });
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) statuses.push((await a.request("/api/v1/companies/current", { headers: { cookie } })).status);
        expect(statuses.filter((s) => s === 500)).toEqual([]);
        expect(statuses).toContain(429);
        await c.close();
      }
      // provider tier: only accepted deliveries spend the provider's budget; junk never does
      {
        const { c, a } = await mk({ "webhook.provider": 2, "webhook.auth_failed": 50 }, "fake://provider-tier");
        const bounce = (id: number) => JSON.stringify({ RecordType: "Bounce", ID: id, Type: "HardBounce", Email: "nobody@example.com", MessageID: `pm-${id}`, BouncedAt: new Date().toISOString(), Description: "mailbox does not exist" });
        const bad = { "content-type": "application/json", authorization: `Basic ${Buffer.from("postmark:wrong").toString("base64")}`, "x-forwarded-for": "192.0.2.5" };
        for (let i = 0; i < 5; i++) expect((await a.request("/webhooks/postmark/bounces", { method: "POST", headers: bad, body: bounce(100 + i) })).status).toBe(401);
        const good = { "content-type": "application/json", authorization: `Basic ${Buffer.from("postmark:whsec-test").toString("base64")}`, "x-forwarded-for": "192.0.2.6" };
        expect((await a.request("/webhooks/postmark/bounces", { method: "POST", headers: good, body: bounce(1) })).status).toBe(200);
        expect((await a.request("/webhooks/postmark/bounces", { method: "POST", headers: good, body: bounce(2) })).status).toBe(200);
        const third = await a.request("/webhooks/postmark/bounces", { method: "POST", headers: good, body: bounce(3) });
        expect(third.status).toBe(429);
        expect(third.headers.get("retry-after")).toBeTruthy();
        expect(((await third.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
        await c.close();
      }
      // the application form and the public candidate pages
      {
        const { c, a } = await mk({ apply: 1, "candidate.pages": 3 }, "fake://public-tier");
        const ip = { "x-forwarded-for": "203.0.113.200" };
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await a.request("/privacy", { headers: { ...ip, accept: "text/html" } })).status);
        expect(statuses).toEqual([200, 200, 200, 429]);
        const fd = new FormData(); fd.set("firstName", "X");
        expect((await a.request(`/careers/nowhere/jobs/00000000-0000-0000-0000-000000000000/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": "203.0.113.201" } })).status).not.toBe(429);
        expect((await a.request(`/careers/nowhere/jobs/00000000-0000-0000-0000-000000000000/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": "203.0.113.201" } })).status).toBe(429);
        await c.close();
      }
    });

    it("webhooks: a provider's valid retries are never refused; a flood of bad secrets from one address is", async () => {
      const bounce = { RecordType: "Bounce", ID: 42, Type: "HardBounce", Email: "nobody@example.com", MessageID: "pm-1", BouncedAt: new Date().toISOString(), Description: "mailbox does not exist" };
      const good = { "content-type": "application/json", authorization: `Basic ${Buffer.from("postmark:whsec-test").toString("base64")}`, "x-forwarded-for": "192.0.2.10" };
      for (let i = 0; i < 3; i++) {
        const r = await app.request("/webhooks/postmark/bounces", { method: "POST", headers: good, body: JSON.stringify(bounce) });
        expect(r.status).toBe(200);
      }
      const bad = { "content-type": "application/json", authorization: `Basic ${Buffer.from("postmark:wrong").toString("base64")}`, "x-forwarded-for": "192.0.2.99" };
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await app.request("/webhooks/postmark/bounces", { method: "POST", headers: bad, body: JSON.stringify(bounce) })).status);
      expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
      expect(statuses[4]).toBe(429);
      // the provider's own address keeps working
      expect((await app.request("/webhooks/postmark/bounces", { method: "POST", headers: good, body: JSON.stringify({ ...bounce, ID: 43, MessageID: "pm-2" }) })).status).toBe(200);
    });
  });
});
