# 19. External account inventory (Phase 2)

Written 22 September 2026 for the founder's approval. Inventory only: nothing was created, connected, configured or
entered. Prices and plan limits were read from each provider's official pages on 22 September 2026 (URLs at the end)
and go stale; verify at sign-up. Governing rules: `docs/spec/00` section Q. Ownership: Nadine is the sole owner of
every account for the pilot; nobody else is invited. Where the older worksheet (`docs/spec/13`) names Paul or
`platform@` as a second owner, that line is superseded by the founder's 22 September correction.

## A. Status of what exists

| Service | Status | Evidence |
|---|---|---|
| 1Password Business | **Complete** (founder): Nadine and Paul owners, MFA on, five vaults; GitHub recovery codes in "Recovery and Emergency" | founder attestation, `docs/spec/00` section Q |
| GitHub | **Complete** (Phase 1): organization `identified-talent-solutions`, private `recruiting-os`, sole owner `nmotaweh`, organization MFA required, protected `main`, CI green, tag `release-1-baseline` | Phase 1 checkpoint |
| Microsoft 365 | **Exists** (ITS tenant); the sign-in app registration for staff has not been created | `docs/spec/12` section 0 |
| GoDaddy | **Exists**; secured access and zone copy in progress (gate 1.3) | `docs/readiness/16` |
| Everything else below | **Not created** | this inventory |

## B. The inventory

Columns: purpose · account exists · plan for the pilot · estimated monthly cost · staging project · production project ·
MFA · spend limit · non-secret identifier Claude will eventually need · founder action · launch priority.

### Required before a synthetic staging environment can come online

| Service | Purpose | Exists | Plan for the pilot | Monthly cost (as printed) | Staging | Production | MFA | Spend limit | Non-secret identifier for Claude | Founder action | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GitHub | code, CI, protected main | yes | Team | $4 per seat (1 seat) | n/a | n/a | required at the organization (verified) | Actions minutes alert at 2,000 (worksheet) | repository URL (have) | none | done |
| 1Password Business | vault for every secret and recovery code | yes | Business | about $8 per user | n/a | n/a | on (founder) | n/a | none | none | done |
| Supabase | Postgres with row-level security, Auth (Microsoft, Google, TOTP), Vault, later Storage | no | **Pro** ($25 per organization) so the Spend Cap, backups and MFA enforcement are available; staging on Micro compute (covered by the $10 monthly compute credit) | $25 now; production adds Small compute (~$15) and point-in-time recovery 7 days (~$100) before real data | project `recruiting-os-staging` | project `recruiting-os-production` (before real data) | TOTP on the account; organization can require it | Spend Cap on (Pro, on by default); note it does not cap compute or PITR | project ref and URL for each project; the anon (publishable) key is entered by Nadine into Vercel, not sent to Claude | create the organization and the staging project | 1 |
| Microsoft Entra sign-in registration | staff sign-in (Microsoft + second factor) through Supabase Auth; also customer Microsoft sign-in | tenant exists; registration not created | none (part of Microsoft 365) | $0 | one registration with the staging redirect address; production address added later | same registration, second redirect | tenant MFA (Security defaults) | n/a | application (client) id and tenant id; the client secret is entered by Nadine into Supabase | create the registration in the ITS tenant (scopes openid, profile, email, User.Read; no calendar scope) | 2 |
| Anthropic (Claude API) | the AI runtime; production-mode boot refuses the fake provider | no | Console organization, pay-as-you-go prepaid credits; workspaces `staging` and `production` | usage: roughly $20 to $50 during synthetic staging, $40 to $100 in the pilot (my estimate from printed per-token rates; Sonnet 5 $2 in / $10 out per million tokens) | workspace `staging`, spend limit $50 | workspace `production`, spend limit set before real data | not offered natively (Google sign-in or emailed link); protect the Google or Microsoft account behind it | per-workspace spend limits plus the automatic tier cap | organization and workspace names; the API key is entered by Nadine into Vercel and the worker host | create the organization, buy a small credit, create the two workspaces with limits | 3 |
| Vercel | hosts the Next.js application (`recruiting.identifiedtalent.com`); preview and production environments | no | **Pro** ($20 per month, 1 seat); Hobby is non-commercial by Vercel's rules | $20 plus on-demand beyond the $20 usage credit (pilot: none expected) | preview environment of the one project | production environment of the same project | TOTP or passkey on the account | Spend Management budget (set $100, pause at limit) | team and project names, preview and production hostnames | create the team and project, connect the private repository | 4 |
| Worker host (decision 1.9c) | runs `apps/api/src/worker.ts`, the always-on poller for jobs, reminders and timers; Vercel cannot host it | no | **Railway Hobby** ($5, includes $5 usage; services never sleep; hard usage limit available), or Render (0.5 CPU worker $7) | $5 to $15 for one or two small workers | staging worker service | production worker service (before real data) | TOTP or passkey on the account | Railway hard usage limit (minimum $10) with alerts at 75/90/100% | project and service names | **choose the host** (Railway recommended; Trigger.dev stays deferred: no Trigger.dev code exists) | 5 |

### Required before real candidate data (after the synthetic staging is online)

| Service | Purpose | Exists | Plan for the pilot | Monthly cost (as printed) | Staging | Production | MFA | Spend limit | Non-secret identifier for Claude | Founder action | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Postmark | outbound email with a dedicated sending domain, inbound applications, bounce and complaint webhooks | no | **Pro** ($16.50, 10,000 emails; Basic has no inbound email) | $16.50; extra emails $1.30 per 1,000; no spend cap exists on paid plans | server `recruiting-os-staging` | server `recruiting-os-production` | on (app or SMS; account-wide requirement available) | none available: watch volume through the delivery webhooks | server names, verified sending and inbound domains | create the account; DNS records follow gate 2.5 (shown to you first) | 6 |
| Supabase production project | production database, Auth, Vault, with point-in-time recovery | no | Small compute + PITR 7 days | ~$115 added to the organization | n/a | `recruiting-os-production` | as above | PITR and compute are outside the Spend Cap | project ref and URL | approve PITR (gate 3.8); create the project | 7 |
| Google Cloud | Google sign-in for customers and the Google Calendar connection (only if the first partner needs Google) | no | none needed; Cloud Identity Free organization on the ITS domain; two projects; no billing account required for the Calendar API | $0 (Calendar API standard use is free) | project `recruiting-os-staging` | project `recruiting-os-production` | 2-Step Verification enforced by Google | budget alerts only (no cap needed at $0) | project ids, OAuth client id | create Cloud Identity on the domain (needs one DNS TXT record, gate 2.5), then the projects and the OAuth consent screen | 8, conditional |
| Upstash Redis | the shared rate-limit counter across Vercel instances | no | Free (500K commands a month) | $0; pay-as-you-go $0.20 per 100K commands beyond | one database `recruiting-os-staging` | one database `recruiting-os-production` | not documented on official pages; protect the sign-in account | per-database monthly budget on pay-as-you-go | database name and region; the REST token is entered by Nadine | create through the Vercel Marketplace or upstash.com; **the adapter is not written yet** (see conflicts) | 9 |
| Sentry | error reports with scrubbing | no | Developer (free, one user, unlimited projects) | $0 | project `recruiting-os-staging` | project `recruiting-os-production` | TOTP or key on the account | none needed on Developer (no overage) | organization and project slugs; the DSN is entered by Nadine | create the organization; **the SDK is not wired yet** (see conflicts) | 10 |
| PostHog | server-side product metrics for the owner, recruiter and administrator interfaces only | no | pay-as-you-go with a card (free up to 1M events; two projects need the card on file) | $0 at pilot volume | project `recruiting-os-staging` | project `recruiting-os-production` | TOTP on the account | per-product billing limit ($20) | host and project key (the key is a publishable value; Nadine enters it) | create the organization and two projects | 11 |

### Optional or deferred (not for the pilot unless separately authorized)

| Service | Purpose | Status | Note |
|---|---|---|---|
| Twilio | text messaging to candidates | deferred (decision M2) | account, A2P 10DLC registration and counsel item 10 only when texting is authorized; the code's Twilio adapter exists but stays off |
| Trigger.dev | managed background tasks (decision D22) | deferred (gate 1.9b) | no Trigger.dev code exists; the free plan has no staging environment and hourly schedules only; not on the pilot path |
| Microsoft Entra calendar registration | Microsoft Calendar | deferred (decision M3) | separate registration with `Calendars.ReadWrite`; only when a design partner requires it |
| Job boards (Indeed, ZipRecruiter, LinkedIn) | automated posting | not in release 1 | the adapters report "manual action required"; their variables are never read |
| Bureau of Labor Statistics key | compensation benchmarks | off (`COMP_BLS_ENABLED=false`) | optional later |

## C. Minimum account set for a synthetic staging environment

Because every deployment runs in production mode (the code refuses to boot with the fake AI, without Supabase sign-in,
without the Supabase-backed secret store, without a database URL, or with the inline worker), the minimum is:

1. **Supabase** organization on Pro with the `recruiting-os-staging` project (database roles, Auth, Vault).
2. **Microsoft Entra sign-in registration** in the existing ITS tenant, entered as the Microsoft provider in Supabase Auth (staff sign-in with a second factor; also usable by a Microsoft-based customer).
3. **Anthropic** Console organization with a `staging` workspace and a spend limit.
4. **Vercel** Pro team with the project connected to the private repository.
5. **A worker host** (Railway Hobby recommended) running the worker with the worker database role.

Not needed for the first synthetic deploy: Postmark (email stays on the fake adapter, honestly labelled), Google Cloud
(no Google sign-in or calendar until Phase 4), Upstash (the fake shared counter runs with its console alert), Sentry and
PostHog (no adapters wired or needed to boot).

## D. Expected costs

| When | Item | Monthly |
|---|---|---|
| Already paying | GitHub Team (1 seat), 1Password Business (2 users) | about $4 + $16 |
| Synthetic staging (Phase 3) | Supabase Pro $25; Vercel Pro $20; Railway Hobby $5; Anthropic usage $20 to $50 (prepaid) | **about $50 recurring plus $20 to $50 of AI credit** |
| Before real candidate data (Phases 4 and 8) | add Supabase production compute and PITR ~$115; Postmark Pro $16.50; Upstash, Sentry, PostHog, Google Cloud $0 | **about $180 recurring plus $40 to $100 of AI usage** |
| Initial one-time | Anthropic prepaid credit (suggest $50 to start; limits set per workspace); first month of Supabase, Vercel and Railway | about $100 to $150 |

PITR is the single largest line and is only needed on production, before the first real candidate.

## E. Recommended creation order

1. Supabase organization and `recruiting-os-staging` (everything else needs its URL).
2. Microsoft Entra sign-in registration, entered into Supabase Auth.
3. Anthropic organization, `staging` workspace, spend limit, small credit.
4. Vercel Pro team and project, connected to the repository.
5. Worker host (Railway Hobby), one staging service.
   Then Phase 3 can begin.
6. Postmark (Pro), then the DNS records for review (gate 2.5).
7. Google Cloud (only if the first partner needs Google sign-in or Google Calendar; decided in Phase 4).
8. Upstash, Sentry, PostHog, in that order, as their code lands (see F).
9. Supabase production project with PITR, before the first real candidate.

## F. Conflicts between the current architecture and the fastest safe pilot path

1. **Worker hosting.** The architecture (decisions D20, D22) named Trigger.dev; no Trigger.dev code exists and the founder deferred it. The shipped worker is a plain long-running Node process; the fastest safe path is a small always-on host (Railway Hobby, $5). This adds one subprocessor to the list counsel sees (gate 4.6) and needs the founder's choice (gate 1.9c).
2. **No staging mode in the code.** Every hosted deployment runs with the production guards, so the first synthetic deploy already needs real Supabase Auth and Vault, a real Anthropic key with a spend limit, and a separate worker. There is no cheaper "fake staging" step.
3. **Resume storage.** The code has only local-disk and in-memory storage adapters; Vercel's filesystem is ephemeral, so uploaded résumés would not persist. A Supabase Storage adapter (S3-compatible, using scoped storage credentials, never the service-role key) is needed before real candidate data and to make the staging demo honest. It is infrastructure, not a product feature, but the scope is frozen, so it needs your authorization.
4. **Upload size.** The application accepts résumés up to 8 MB; Vercel functions cap request bodies at 4.5 MB. Either the limit drops to 4 MB for the pilot or uploads go directly to storage. Founder decision; a one-line change either way.
5. **Sentry is not wired.** Only a scrubbing helper exists; there is no Sentry SDK in the code. Phase 3 step 11 ("configure Sentry and verify scrubbing") needs the SDK added, a small infrastructure change under the freeze, with your authorization.
6. **The shared rate-limit adapter is not written.** Only the fake shared counter exists. An Upstash REST adapter is a few lines; without it staging runs with per-process limits and a standing console alert. Needed before real data (gate 3.6).
7. **Postmark needs the Pro tier** ($16.50), not Basic, because inbound email is required; and its sending domain needs the DNS records of gate 2.5, which wait on GoDaddy access (gate 1.3).
8. **Google sign-in dependency chain.** Customer Google sign-in and Google Calendar need Google Cloud, which needs a DNS TXT record for Cloud Identity, which needs GoDaddy. If the first design partner signs in with Microsoft and needs no Google Calendar, the whole chain moves out of the pilot's critical path. Also, an unverified OAuth consent screen in testing mode expires calendar connections weekly.
9. **Vercel Hobby is unusable**: it is non-commercial by Vercel's rules, so Pro ($20) from the first deploy.
10. **Ownership wording.** `docs/spec/13` and `17` still list Paul or `platform@` as second owners on several services; the founder's 22 September correction supersedes them for the pilot. The worksheet cards are updated as each account is created.

## G. Reconciliation with the worksheet and the gates

- Worksheet (`docs/spec/13`) and sequence (`docs/spec/12` section 12) match this inventory except: Trigger.dev is deferred (step 11), Twilio is deferred (step 18), a worker host is added, Sentry and Upstash are recorded as "adapter not yet in code", and every second-owner line is superseded.
- Gates (`docs/readiness/16`): 1.6 (rate-limit counter: Upstash Free, adapter to write), 1.9 (Twilio later, Trigger.dev later, worker host: Railway), 2.1 (accounts), 2.2 (sign-in registrations), 2.9 (test identities: a Google test customer only if Google is on the path; a Microsoft staff test account with a second factor; a candidate test mailbox), 3.6, 3.15.
- Register (`docs/readiness/01`) section D is updated when accounts exist; today it lists GitHub and 1Password done and the rest not created.

## I. Founder decisions of 22 September 2026 (inventory approved subject to these)

**Decision 1, worker host: Railway approved** for the staging and pilot worker. Requirements: one staging worker service
first; GitHub authentication with MFA; a hard usage limit and a billing alert; staging and production separate;
only the existing worker process (`apps/api/src/worker.ts`) runs there; Railway recorded as a subprocessor for
counsel; no production service yet; Railway never hosts the primary database or the web application.

**Decision 2, résumé storage: a Supabase Storage adapter is authorized as release-1 infrastructure.** Direct-to-storage
uploads (files never pass through Vercel); the 8 MB maximum stays. Requirements: private bucket only, no public bucket
and no permanent public file URL; tenant- and candidate-scoped object paths; random, non-guessable object names;
short-lived upload and download authorization; the application never receives the service-role key; allowed file
types enforced by extension, MIME type and file signature; executable, encrypted, malformed and oversized files
refused; uploads quarantined until validation and malware scanning pass; upload, read, replacement and deletion
recorded in the audit log; disconnect and deletion workflows remove inaccessible files per the approved retention
policy; tests prove one tenant cannot read, list, replace or delete another tenant's files; synthetic files only until
every real-data gate passes. If the design cannot avoid exposing the service-role key, stop and present a safer scoped
design first. Malware scanning and the retention policy are real-data blockers, not synthetic-staging blockers.

**Decision 3, Sentry: the official SDK is authorized as release-1 infrastructure.** Staging first; United States region
if selectable; sensitive-data collection disabled; request bodies, authorization headers, cookies, tokens, emails,
phone numbers, résumé contents and candidate identifiers scrubbed; source maps protected; a synthetic test error must
prove scrubbing before approval; no Sentry recording, replay or candidate-page session capture; production stays
unconfigured until staging passes.

**Decision 4, shared rate limiting: the Upstash adapter is authorized as release-1 infrastructure.** Staging first;
United States region; HMAC-derived subjects only; no raw email address, phone number, candidate token or IP address
stored as a key; expiration on every key; fail-safe behaviour documented and tested; webhook retries never rejected
incorrectly; Upstash recorded as a subprocessor for counsel; production stays unconfigured until staging passes.

**Deferred, unchanged:** Trigger.dev; Twilio and SMS; Microsoft Calendar; recording; automated offers; onboarding;
passive sourcing; job-board APIs; Google Cloud unless a design partner requires Google sign-in or Google Calendar.
Postmark stays required before real candidate communications. Supabase production and point-in-time recovery stay
required before real candidate data.

**First design-partner path:** the manual availability and ICS workflow unless a partner requires a connected calendar;
calendar OAuth must not delay the initial pilot; a Microsoft 365 partner is preferred if that keeps Google Cloud off
the critical path; Microsoft Calendar itself stays deferred because manual scheduling exists.

**Next action approved:** merge this record; then create Supabase (organization and `recruiting-os-staging`) one screen
at a time, one action per message, no secret ever pasted in chat, each value's 1Password vault named; stop after the
Supabase organization and staging project exist and give a checkpoint. Broad Phase 3 deployment waits for that
checkpoint's approval.

## H. Sources (official pages read 22 September 2026)

supabase.com/pricing · supabase.com/docs/guides/platform/backups · vercel.com/pricing · vercel.com/docs/plans/hobby ·
postmarkapp.com/pricing · platform.claude.com/docs/en/about-claude/pricing · claude.com/pricing · sentry.io/pricing ·
posthog.com/product-analytics/pricing · upstash.com/pricing/redis · trigger.dev/pricing · trigger.dev/docs/limits ·
developers.google.com/workspace/calendar/api/guides/quota · railway.com/pricing · render.com/pricing · fly.io/pricing
