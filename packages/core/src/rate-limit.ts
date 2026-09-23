import { createHmac } from "node:crypto";

/**
 * Shared rate limiting (founder instruction of 21 September 2026, item 5). The interface is provider-neutral: a store
 * answers "how many hits has this key had in this window" and nothing else. Locally the store is in-process memory; for
 * staging and production a shared store is configured so several API processes see the same counters. No paid provider
 * is selected here; the shared implementation runs on a counter interface with Redis semantics (INCR + PEXPIRE) and a
 * fake counter for tests. A real adapter is a few lines against that interface (see docs/readiness/15).
 *
 * Keys are keyed hashes of the policy and the subject: no address, token, email or id is ever stored in a limiter.
 */
export type RateLimitDecision = { allowed: boolean; count: number; limit: number; remaining: number; resetAt: number; retryAfterSeconds: number };

export interface RateLimitStore {
  readonly id: string;
  /** Counts one hit against the key in a fixed window and says whether it is still inside the limit. */
  hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision>;
  /** Reads the current count without counting a hit (used to refuse before doing work once a limit has tripped). */
  peek(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision>;
}

function decide(count: number, limit: number, resetAt: number, now: number): RateLimitDecision {
  return { allowed: count <= limit, count, limit, remaining: Math.max(0, limit - count), resetAt, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/** In-process store for local development and single-process tests. Not shared between processes. */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly id = "memory";
  private hits = new Map<string, { count: number; resetAt: number }>();
  async hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision> {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 20_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return decide(1, limit, now + windowMs, now);
    }
    cur.count += 1;
    return decide(cur.count, limit, cur.resetAt, now);
  }
  async peek(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision> {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) return decide(0, limit, now + windowMs, now);
    return decide(cur.count, limit, cur.resetAt, now);
  }
}

/** Redis-shaped counter: what a shared store must provide. INCR with an expiry set on first hit, and GET. */
export interface SharedCounter {
  readonly id: string;
  incr(key: string, ttlMs: number, now: number): Promise<number>;
  get(key: string, now: number): Promise<number>;
}

/** Fixed windows on a shared counter; every process computing the same window key sees the same count. */
export class SharedRateLimitStore implements RateLimitStore {
  readonly id: string;
  constructor(private readonly counter: SharedCounter) {
    this.id = `shared:${counter.id}`;
  }
  private windowOf(key: string, windowMs: number, now: number) {
    const w = Math.floor(now / windowMs);
    return { key: `rl:${key}:${w}`, resetAt: (w + 1) * windowMs };
  }
  async hit(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision> {
    const w = this.windowOf(key, windowMs, now);
    const count = await this.counter.incr(w.key, w.resetAt - now + 1000, now);
    return decide(count, limit, w.resetAt, now);
  }
  async peek(key: string, windowMs: number, limit: number, now: number): Promise<RateLimitDecision> {
    const w = this.windowOf(key, windowMs, now);
    return decide(await this.counter.get(w.key, now), limit, w.resetAt, now);
  }
}

/**
 * The fake shared counter for tests and local multi-process rehearsal: every instance created with the same URL shares
 * one table, exactly as separate API processes would share one Redis. Nothing leaves the process.
 */
export class FakeSharedCounter implements SharedCounter {
  private static tables = new Map<string, Map<string, { count: number; expiresAt: number }>>();
  readonly id = "fake";
  private readonly table: Map<string, { count: number; expiresAt: number }>;
  constructor(public readonly url: string) {
    let t = FakeSharedCounter.tables.get(url);
    if (!t) { t = new Map(); FakeSharedCounter.tables.set(url, t); }
    this.table = t;
  }
  async incr(key: string, ttlMs: number, now: number): Promise<number> {
    const cur = this.table.get(key);
    if (!cur || cur.expiresAt <= now) { this.table.set(key, { count: 1, expiresAt: now + ttlMs }); return 1; }
    cur.count += 1;
    return cur.count;
  }
  async get(key: string, now: number): Promise<number> {
    const cur = this.table.get(key);
    return !cur || cur.expiresAt <= now ? 0 : cur.count;
  }
  static reset(url?: string) { if (url) FakeSharedCounter.tables.delete(url); else FakeSharedCounter.tables.clear(); }
}

/**
 * Upstash Redis over its REST API (founder decision 4 of 22 September 2026). One request per hit: a Lua script that
 * increments the window key and, on the first hit, gives it the window's remaining time as its expiry, in one atomic
 * step, so no key can outlive its window. Keys are the keyed hashes the store builds; the token is sent as a bearer
 * header and never appears in a key, a URL or a log.
 *
 * Fail-safe, documented here and in docs/readiness/15: if the service cannot be reached or refuses (network error,
 * 5xx, 429), the counter keeps counting the affected keys in this process's own memory for the rest of the window and
 * reports the degradation once an hour through `onDegraded`. Limits then apply per process, never nowhere; nothing is
 * ever refused because the shared store is down, and nothing is ever let through without being counted.
 */
export class UpstashSharedCounter implements SharedCounter {
  readonly id = "upstash";
  private readonly local = new FakeSharedCounter(`local-fallback:${Math.random().toString(36).slice(2)}`);
  private lastDegradedAt = 0;
  constructor(private readonly cfg: { url: string; token: string; fetch?: typeof fetch; onDegraded?: (reason: string) => void; degradedReportEveryMs?: number }) {
    if (!/^https:\/\//.test(cfg.url)) throw new Error("UPSTASH_REDIS_REST_URL must be an https URL");
    if (!cfg.token) throw new Error("UPSTASH_REDIS_REST_TOKEN must be set for the upstash rate-limit provider");
  }
  /** INCR then PEXPIRE on the first hit, atomically. Returns the count. */
  private static readonly INCR_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return c";
  private async command(body: unknown[]): Promise<unknown> {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(this.cfg.url.replace(/\/$/, ""), { method: "POST", headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`upstash: ${json.error}`);
    return json.result;
  }
  private degraded(reason: string, now: number) {
    const every = this.cfg.degradedReportEveryMs ?? 3_600_000;
    if (now - this.lastDegradedAt >= every) {
      this.lastDegradedAt = now;
      try { this.cfg.onDegraded?.(reason); } catch { /* reporting must never fail a request */ }
    }
  }
  async incr(key: string, ttlMs: number, now: number): Promise<number> {
    try {
      const r = await this.command(["EVAL", UpstashSharedCounter.INCR_SCRIPT, 1, key, Math.max(1000, Math.ceil(ttlMs))]);
      return Number(r);
    } catch (err) {
      this.degraded(err instanceof Error ? err.message : String(err), now);
      return this.local.incr(key, ttlMs, now);
    }
  }
  async get(key: string, now: number): Promise<number> {
    try {
      const r = await this.command(["GET", key]);
      return r === null || r === undefined ? 0 : Number(r);
    } catch (err) {
      this.degraded(err instanceof Error ? err.message : String(err), now);
      return this.local.get(key, now);
    }
  }
}

export type RateLimitConfig = { RATE_LIMIT_STORE: string; RATE_LIMIT_SHARED_PROVIDER: string; RATE_LIMIT_SHARED_URL: string | null; UPSTASH_REDIS_REST_URL?: string | null; UPSTASH_REDIS_REST_TOKEN?: string | null };

/** Chooses the store from configuration: memory, the fake shared counter for rehearsal, or Upstash (decision 4). */
export function createRateLimitStore(cfg: RateLimitConfig, opts: { fetch?: typeof fetch; onDegraded?: (reason: string) => void } = {}): RateLimitStore {
  if (cfg.RATE_LIMIT_STORE === "memory") return new MemoryRateLimitStore();
  if (cfg.RATE_LIMIT_STORE !== "shared") throw new Error(`RATE_LIMIT_STORE must be "memory" or "shared", got "${cfg.RATE_LIMIT_STORE}"`);
  if (cfg.RATE_LIMIT_SHARED_PROVIDER === "fake") return new SharedRateLimitStore(new FakeSharedCounter(cfg.RATE_LIMIT_SHARED_URL ?? "fake://default"));
  if (cfg.RATE_LIMIT_SHARED_PROVIDER === "upstash") {
    if (!cfg.UPSTASH_REDIS_REST_URL || !cfg.UPSTASH_REDIS_REST_TOKEN) throw new Error("RATE_LIMIT_SHARED_PROVIDER=upstash needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    return new SharedRateLimitStore(new UpstashSharedCounter({ url: cfg.UPSTASH_REDIS_REST_URL, token: cfg.UPSTASH_REDIS_REST_TOKEN, fetch: opts.fetch, onDegraded: opts.onDegraded }));
  }
  throw new Error(`No shared rate-limit adapter is implemented for provider "${cfg.RATE_LIMIT_SHARED_PROVIDER}". Use "upstash" (docs/readiness/15-rate-limiting-provider.md) or "fake" for rehearsal.`);
}

/** Keyed hash (HMAC with a deployment secret) of policy and subject; the limiter never sees the subject, and nobody without the secret can guess a key. */
export function rateLimitKey(secret: string, policy: string, subjectKind: string, subject: string): string {
  return createHmac("sha256", secret).update(`${policy}\u0000${subjectKind}\u0000${subject}`).digest("hex").slice(0, 40);
}
