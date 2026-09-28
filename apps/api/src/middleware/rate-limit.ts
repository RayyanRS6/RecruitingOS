import type { Context, MiddlewareHandler } from "hono";
import { audit, raiseAlert, rateLimitKey, type RateLimitDecision, maskTokenPath } from "@ros/core";
import { clientIp, type Vars } from "./session";

/**
 * Rate limiting on every public and authenticated surface (21 Sep, item 5). Policies name what they protect; each rule
 * picks a subject (address, user, tenant, link token, email, role, provider) and a fixed window. The limiter only ever
 * sees a keyed hash of the subject. A trip answers 429 with a Retry-After, records a security event, and after repeated
 * trips raises an alert for the ITS console. Webhooks are limited generously and never refuse a provider's valid retry.
 */
export type SubjectKind = "ip" | "user" | "tenant" | "token" | "email" | "role" | "provider" | "auth_failure";
export type Rule = { by: SubjectKind; windowMs: number; limit: number; /** route param holding the token or role id */ param?: string; /** JSON body field holding the email */ field?: string };
export type Policy = { name: string; rules: Rule[] };

const MIN = 60_000;
const HOUR = 3_600_000;

/** The policy table. Limits are per subject per window; overrides come from RATE_LIMIT_OVERRIDES (tests, staging rehearsals). */
export const POLICIES = {
  authSession: { name: "auth.session", rules: [{ by: "ip", windowMs: 15 * MIN, limit: 30 }] },
  /** Code entry for the staff second factor: the transaction itself allows five tries; this bounds the address. */
  authMfa: { name: "auth.mfa", rules: [{ by: "ip", windowMs: 15 * MIN, limit: 40 }] },
  authMagicLink: { name: "auth.magic_link", rules: [{ by: "ip", windowMs: 15 * MIN, limit: 10 }, { by: "email", windowMs: 15 * MIN, limit: 5, field: "email" }] },
  apply: { name: "apply", rules: [{ by: "ip", windowMs: HOUR, limit: 30 }, { by: "role", windowMs: HOUR, limit: 600, param: "roleId" }] },
  screen: { name: "candidate.screen", rules: [{ by: "token", windowMs: HOUR, limit: 120, param: "token" }, { by: "ip", windowMs: HOUR, limit: 240 }] },
  screenHuman: { name: "candidate.screen_human", rules: [{ by: "token", windowMs: HOUR, limit: 30, param: "token" }, { by: "ip", windowMs: HOUR, limit: 60 }] },
  privacy: { name: "candidate.privacy_request", rules: [{ by: "token", windowMs: HOUR, limit: 5, param: "token" }, { by: "ip", windowMs: HOUR, limit: 10 }] },
  withdraw: { name: "candidate.withdraw", rules: [{ by: "token", windowMs: HOUR, limit: 5, param: "token" }, { by: "ip", windowMs: HOUR, limit: 20 }] },
  smsPref: { name: "candidate.sms_pref", rules: [{ by: "token", windowMs: HOUR, limit: 10, param: "token" }, { by: "ip", windowMs: HOUR, limit: 30 }] },
  schedule: { name: "candidate.schedule", rules: [{ by: "token", windowMs: HOUR, limit: 30, param: "token" }, { by: "ip", windowMs: HOUR, limit: 60 }] },
  scheduleNoneWork: { name: "candidate.schedule_none", rules: [{ by: "token", windowMs: HOUR, limit: 20, param: "token" }] },
  reschedule: { name: "candidate.reschedule", rules: [{ by: "token", windowMs: HOUR, limit: 10, param: "token" }] },
  cancelInterview: { name: "candidate.cancel_interview", rules: [{ by: "token", windowMs: HOUR, limit: 10, param: "token" }] },
  apiUser: { name: "api.user", rules: [{ by: "user", windowMs: MIN, limit: 600 }] },
  apiTenant: { name: "api.tenant", rules: [{ by: "tenant", windowMs: MIN, limit: 3000 }] },
  apiAnonymous: { name: "api.anonymous", rules: [{ by: "ip", windowMs: MIN, limit: 300 }] },
  webhookProvider: { name: "webhook.provider", rules: [{ by: "provider", windowMs: MIN, limit: 6000 }] },
  webhookAuthFailed: { name: "webhook.auth_failed", rules: [{ by: "auth_failure", windowMs: 10 * MIN, limit: 60 }] },
  cspReport: { name: "csp.report", rules: [{ by: "ip", windowMs: MIN, limit: 60 }] },
  /** Every candidate-facing page and feed, read or written, per address: generous, but not unbounded. */
  candidatePages: { name: "candidate.pages", rules: [{ by: "ip", windowMs: MIN, limit: 240 }] },
} satisfies Record<string, Policy>;

async function subjectOf(c: Context<Vars>, rule: Rule): Promise<string | undefined> {
  switch (rule.by) {
    case "ip": case "auth_failure": return clientIp(c) ?? "unknown";
    case "user": return c.get("session")?.user.id;
    case "tenant": return c.get("tenant")?.companyId;
    case "token": case "role": return c.req.param(rule.param ?? "token");
    case "provider": return c.req.path.split("/")[2] ?? "unknown";
    case "email": {
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const v = body[rule.field ?? "email"];
        return typeof v === "string" ? v.trim().toLowerCase() : undefined;
      } catch { return undefined; }
    }
  }
}

function isCandidateSurface(path: string): boolean {
  return path.startsWith("/c/") || path.startsWith("/careers/") || path.startsWith("/api/v1/auth/mfa");
}

function refuse(c: Context<Vars>, d: RateLimitDecision) {
  c.header("Retry-After", String(d.retryAfterSeconds));
  c.header("Cache-Control", "no-store");
  const minutes = Math.max(1, Math.ceil(d.retryAfterSeconds / 60));
  if (isCandidateSurface(c.req.path) && (c.req.header("accept") ?? "").includes("text/html")) {
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Please try again shortly</title></head><body style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:48px auto;padding:0 18px"><h1>Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}</h1><p>Too many attempts arrived in a short time. Nothing was lost. Wait a little and use your link again; if this keeps happening, reply to any of our emails and a person will help.</p></body></html>`, 429);
  }
  return c.json({ error: { code: "rate_limited", message: `Too many requests. Try again in ${d.retryAfterSeconds} seconds.`, retryAfterSeconds: d.retryAfterSeconds } }, 429);
}

const ALERT_AFTER_TRIPS = 5;
const alerted = new Set<string>();

/**
 * A trip is recorded once per key and window (the first refusal), not on every refused request, so a flood costs the
 * database nothing after the first row. Repeated trips are counted in the shared store, so several processes see one
 * count; the alert is raised when the count reaches the threshold.
 */
async function recordTrip(c: Context<Vars>, policy: string, rule: Rule, key: string, d: RateLimitDecision) {
  const container = c.get("container");
  const now = Date.now();
  const trips = await container.rateLimits.hit(`trip:${key}`, rule.windowMs, ALERT_AFTER_TRIPS, now);
  if (trips.count !== 1 && trips.count !== ALERT_AFTER_TRIPS) return;
  const companyId = c.get("tenant")?.companyId ?? null;
  const keyHash = key.slice(0, 16);
  await audit(container.db, { companyId, actor: { kind: "system", id: "rate_limit" }, action: "security.rate_limited", reason: policy, ip: clientIp(c), details: { policy, subject: rule.by, keyHash, path: maskTokenPath(c.req.path), count: d.count, limit: d.limit, trips: trips.count } }).catch((err) => console.warn(`[rate-limit] could not record the security event: ${err instanceof Error ? err.message : String(err)}`));
  const mark = `${key}:${trips.resetAt}`;
  if (trips.count >= ALERT_AFTER_TRIPS && !alerted.has(mark)) {
    alerted.add(mark);
    if (alerted.size > 5000) alerted.clear();
    await raiseAlert(container.db, { kind: "security.suspicious_activity", severity: "high", title: `Repeated rate-limit trips: ${policy}`, body: `The same ${rule.by} tripped the ${policy} limit ${trips.count} times in one window. Key hash ${keyHash}. Check the security audit records for the path and address.`, companyId, details: { policy, subject: rule.by, keyHash, trips: trips.count } }).catch((err) => console.warn(`[rate-limit] could not raise the suspicious-activity alert: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Checks every rule of every policy; the first trip answers with the refusal. Null means the request may proceed. */
export async function checkRateLimits(c: Context<Vars>, policies: Policy[], opts: { consume?: boolean } = {}): Promise<Response | null> {
  const container = c.get("container");
  const now = Date.now();
  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (rule.by === "auth_failure") continue; // counted after the handler answers
      const subject = await subjectOf(c, rule);
      if (!subject) continue;
      const limit = container.env.RATE_LIMIT_OVERRIDES[policy.name] ?? rule.limit;
      const key = rateLimitKey(container.env.SESSION_SECRET, policy.name, rule.by, subject);
      // a look without a hit refuses once the budget is fully spent (the hit comes later, when the delivery is accepted)
      const d = opts.consume === false ? await container.rateLimits.peek(key, rule.windowMs, limit, now) : await container.rateLimits.hit(key, rule.windowMs, limit, now);
      const over = opts.consume === false ? d.count >= limit : !d.allowed;
      if (over) {
        await recordTrip(c, policy.name, rule, key, d);
        return refuse(c, d);
      }
    }
  }
  return null;
}

/** Applies one policy as middleware. */
export function rateLimit(policy: Policy): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const refused = await checkRateLimits(c, [policy]);
    if (refused) return refused;
    await next();
  };
}

/**
 * Webhooks: the per-provider budget counts only deliveries the handler accepted (authenticated), so junk from anyone
 * cannot exhaust a provider's allowance, and a provider's valid retry of a delivered event is de-duplicated by receipt,
 * never refused. Authentication failures have their own per-address counter, checked before any work.
 */
export function webhookRateLimit(): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const container = c.get("container");
    const now = Date.now();
    const failRule = POLICIES.webhookAuthFailed.rules[0];
    const failKey = rateLimitKey(container.env.SESSION_SECRET, POLICIES.webhookAuthFailed.name, "auth_failure", clientIp(c) ?? "unknown");
    const failLimit = container.env.RATE_LIMIT_OVERRIDES[POLICIES.webhookAuthFailed.name] ?? failRule.limit;
    const peek = await container.rateLimits.peek(failKey, failRule.windowMs, failLimit, now);
    if (!peek.allowed) {
      await recordTrip(c, POLICIES.webhookAuthFailed.name, failRule, failKey, peek);
      return refuse(c, peek);
    }
    const overBudget = await checkRateLimits(c, [POLICIES.webhookProvider], { consume: false });
    if (overBudget) return overBudget;
    await next();
    if (c.res.status === 401 || c.res.status === 403) {
      const d = await container.rateLimits.hit(failKey, failRule.windowMs, failLimit, now);
      if (!d.allowed) await recordTrip(c, POLICIES.webhookAuthFailed.name, failRule, failKey, d);
    } else if (c.res.status < 400) {
      const rule = POLICIES.webhookProvider.rules[0];
      const subject = await subjectOf(c, rule);
      if (subject) await container.rateLimits.hit(rateLimitKey(container.env.SESSION_SECRET, POLICIES.webhookProvider.name, rule.by, subject), rule.windowMs, container.env.RATE_LIMIT_OVERRIDES[POLICIES.webhookProvider.name] ?? rule.limit, now);
    }
  };
}

/** Authenticated API: per user, then per tenant; anonymous API calls per address. Runs after the session middleware. */
export function apiRateLimit(): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const refused = await checkRateLimits(c, c.get("session") ? [POLICIES.apiUser, POLICIES.apiTenant] : [POLICIES.apiAnonymous]);
    if (refused) return refused;
    await next();
  };
}
