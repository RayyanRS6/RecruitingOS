# 15. Rate limiting: what is built, and the shared-store choice for the founder

Status: built and tested locally on 21 September 2026 (founder instruction, item 5). No provider selected or connected.

## What is built

- A provider-neutral interface (`RateLimitStore` in `packages/core/src/rate-limit.ts`): a store counts hits per key in a
  fixed window and says whether the limit is exceeded. Keys are HMAC-SHA256 hashes of the policy and the subject under
  the deployment's session secret; no address, email, token or id is stored in the limiter, and nobody without the
  secret can compute a key.
- Two implementations: in-process memory (local development, single process) and a shared store on a Redis-shaped
  counter (`INCR` with expiry, `GET`). The shared store ships with a **fake counter** so tests and local rehearsals run
  several API processes against one table; a real adapter is a few lines against the same `SharedCounter` interface.
- Configuration: one setting, `RATE_LIMIT_STORE=memory|upstash|fake` (`fake` is the in-process stand-in for tests and
  is refused in production). In production without the shared store the API starts, warns, and raises a console alert.
- Policies (`apps/api/src/middleware/rate-limit.ts`): sign-in per address and per email; application submission per
  address and per role; each candidate link action per token and per address (screening, privacy request, withdrawal,
  text preference, scheduling, reschedule, cancel); every candidate-facing page and feed per address; authenticated API
  per user and per tenant; anonymous API per address; webhooks per provider (generous, and only accepted deliveries
  spend it) plus a separate counter for authentication failures per address.
- The client address is the one the trusted proxy reports: the entry `TRUST_PROXY_HOPS` (default 1) from the right of
  `X-Forwarded-For`. A client cannot rotate its way around a limit by writing that header, and an empty header still
  counts as one subject.
- Responses: `429` with `Retry-After`; JSON on the API, a plain-language page on candidate surfaces.
- Security events: the first refusal of a key in a window writes `security.rate_limited` (policy, subject kind, key
  hash, path with the token removed, address); the trip count lives in the same store as the limits, so several
  processes see one count, and the fifth trip raises a `security.suspicious_activity` alert in the console. A flood of
  refused requests costs the database nothing after those two rows.
- Webhook retries: a provider re-sending a delivered event is de-duplicated by receipt and never refused; only floods of
  bad secrets from one address are refused.

## The choice for the founder

Several API processes (Vercel functions) must share one counter, or limits are per process and nearly meaningless.
Options, with the pricing the team last saw; **verify at sign-up, prices change**:

| Option | Fit | Cost (as last seen) | Notes |
|---|---|---|---|
| Upstash Redis (Vercel Marketplace) | Best fit: serverless Redis over HTTPS, one INCR per check | Free tier (a daily command allowance), then pay-per-command in the low cents per hundred thousand commands; a fixed plan from roughly $10 per month | Adds one subprocessor (Upstash). Same vendor Vercel uses for its own KV product. |
| Redis Cloud (Redis Inc.) | Good | Free 30 MB tier; paid from roughly $5 per month | Needs a TCP connection from functions; less convenient than HTTPS. |
| Postgres counters in Supabase | No new vendor | Included in the Supabase plan; costs database load | One `INSERT … ON CONFLICT … RETURNING` per check on every request; acceptable at pilot scale, not beyond. |
| Cloudflare in front of Vercel | Edge limits | Free tier includes basic rate limiting rules | A different architecture (DNS moves to Cloudflare); not proposed for release 1. |

Recommendation for staging: **Upstash Redis through the Vercel Marketplace**, region matching the Vercel functions,
created by the ITS-owned Vercel account (governing-account rule). The adapter is `incr` and `get` over the REST API.
Until the founder decides, staging runs `RATE_LIMIT_STORE=memory`, which is honest about being per process.

## Not done on purpose

- No provider account was created or connected.
- No limits were placed on the ITS queue email or on outbound email (that is the email provider's domain).


## Record (22 and 23 September 2026)

- 22 Sep: the founder approved Upstash (decision 4, `docs/spec/00` section Q; requirements: staging first, United States
  region, HMAC subjects only, an expiry on every key, the fail-safe documented, webhook retries safe).
- 23 Sep: the founder created the staging database `recruiting-os-staging-rate-limit` (AWS Oregon, us-west-2, Free plan,
  REST endpoint `https://complete-narwhal-292092.upstash.io`); the token stays with the founder. Eviction was created On
  and is to be turned Off: counters carry their own expiry, and eviction would drop them first under memory pressure.
- 23 Sep: the adapter is built (`UpstashSharedCounter`, `packages/core/src/rate-limit.ts`): one REST request per hit
  running a Lua script that increments the window key and sets its expiry on the first hit, atomically, so no key can
  outlive its window; keys are the keyed hashes only; the token travels as a bearer header and is registered for
  scrubbing. **Fail-safe:** if Upstash cannot be reached or refuses (network error, 5xx, 429), the process keeps counting
  the affected keys in its own memory for the rest of the window and raises the alert `rate_limit.shared_unavailable`
  once an hour; limits then apply per process, nothing is refused because the store is down, and nothing passes
  uncounted. Webhook retries stay safe: only accepted deliveries are counted (unchanged). Proof on staging is Phase 3.
- Variables (Vercel Preview and Railway, both): `RATE_LIMIT_STORE=upstash`, `UPSTASH_REDIS_REST_URL` (the endpoint
  above), `UPSTASH_REDIS_REST_TOKEN` (sensitive; sealed on Railway). The earlier spelling (`RATE_LIMIT_STORE=shared`
  with `RATE_LIMIT_SHARED_PROVIDER=upstash`) is still understood, with a warning at boot, until the variables are updated.
