<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Tests, CI, baseline run and known gaps

Audit of `recruiting-os` on branch `kanvis-reaudit` (= origin/main `dafb730`, merge of PR #38), 14 October 2026. Read only: nothing in the repository was changed (`git status` before and after the run shows only the pre-existing untracked `tests/e2e/playwright.local.config.ts`).

Raw evidence produced for this section (all in the scratchpad `audit` folder):
- `vitest-baseline.txt`: the full vitest run (output verbatim, exit code and timings appended).
- `vitest-per-file.tsv`: tests and skips per test file, taken from that run.
- `tsc-summary.txt` and `tsc-<package>.txt`: the TypeScript check per package.
- `test-files.tsv`: static inventory of every test file.

## 1. Summary

The automated safety net is large and, at this commit, green. One full vitest run, set up the same way as the CI test job (every provider fake, in-memory database, inline worker), ran **204 test files and 2,154 tests: 2,148 passed, 6 skipped, 0 failed** (exit code 0, 954 seconds on this machine). The five skips are the "deferred to release 2/3" placeholders in the hiring scenario. The sixth is a real-Postgres pool test that only runs when `TEST_DATABASE_URL` is set. The TypeScript check is clean (0 errors) in all 15 workspace packages that CI type-checks.

The two test folders CI never type-checks are a different story. `tests/policy` is clean, but `tests/web` has **26 type errors**. On inspection (verification pass) none of them changes what a test proves today: 13 come from the Cancelled test's own fixture helper being typed too strictly (it fills every field at run time), 10 are Talent-count fixtures missing the `waiting_on_candidate` group that the functions under test never read, and 3 are an excess-property check and two module-resolution errors from the scratch setup. The real problem is that 414 tests have no type check at all, so future drift would go unnoticed.

CI (`.github/workflows/ci.yml`, one required job called `verify`) runs on every pull request and every push to `main`. Its steps are: lockfile install, secret scans, dependency audit, typecheck, lint, migration validation, the vitest suite, the AI evals on the fake provider, the production build, and 32 Playwright browser runs with accessibility (axe) checks, split over three dev-server runs. Two more workflows are started by hand: `migrate.yml` applies database migrations to a chosen environment, and `fairness.yml` (the "fairness test button") runs the CV-reading and CV-screening fairness suites against the real Claude Haiku 5.5 / Sonnet 5.5 models.

What the tests do **not** prove matters as much as what they do:
- Everything runs against fakes: AI, email, SMS, sign-in, calendar, storage, scanning, rate limiting.
- Tenant isolation is proven on PGlite running as a superuser. The real-Postgres path is optional and manual.
- The real-AI fairness check covers only the CV-reading and screening suites, is manual, and has left no committed result in the repository (and the repository's `.gitignore` excludes result files, so none can be committed without forcing it).
- 94 of the 101 signed-in web app modules are reached by vitest (63 imported directly, mostly as static markup through `apps/shell/components/*.test.ts`); only 7 pages are reached by nothing but browser journeys. No vitest test clicks or moves focus, so all interaction depends on the browser journeys, which could not be run in this audit.
- Several critical paths have no automated test or only a seeded stand-in: worker crash recovery (re-claiming a job a dead worker held; detecting a dead worker *is* tested), a recruiter "takeover" (tested only by writing rows straight into the database, which the product itself never does, by recorded decision), and the owner-side Cancelled column in a browser.

The docs about testing (`docs/STATUS.md`, `docs/readiness/17-skipped-tests.md`, `docs/13-test-plan.md`, `docs/spec/10-test-and-deployment-plan.md`, `packages/evals/README.md`) are stale in several places (section 10).

## 2. Feature inventory

| id | feature | status | who | evidence |
|---|---|---|---|---|
| TESTS-01 | Unit and integration test suite (vitest) | fully_implemented | ITS engineering; protects every user | `vitest.config.ts:5-10` (include globs, `fileParallelism: false`, 60 s timeouts); `package.json:14` (`test: vitest run`); baseline 204 files, 2,154 tests, 0 failed |
| TESTS-02 | API integration tests through `app.request()` on in-memory PGlite with fake providers | fully_implemented | owners, hiring teams, candidates, ITS recruiters, platform admins (all API behaviour) | 86 files / 799 tests in `apps/api/src/*.test.ts`; `apps/api/src/test-helpers.ts` (`testContainerOptions`, `signInAs`, `statusTokenFor`) |
| TESTS-03 | Tenant isolation and row-level security proof | partial | every customer company (data separation) | `packages/db/src/rls.test.ts:10-16` (proof inside `withTenant` only), `:171-172`, `:194-195` (conditional skips), `:217` (PGlite is superuser); `apps/api/src/tenancy.test.ts`, `security-coverage.test.ts`; real Postgres only via `TEST_DATABASE_URL`, never in CI |
| TESTS-04 | Policy guards: no service-role key in app code; raw-database-query ratchet | fully_implemented | platform admin / security | `tests/policy/service-role-guard.test.ts:11-20,36-53`; `tests/policy/raw-db-access.test.ts:7-13,18-30,33-46`. Scope (verification): the ratchet scans only `apps/api/src/**` and only the spellings `container.db`, `c.get("container").db`, `handle.db` (`:15,35`); raw queries in `packages/*` (for example `packages/workflows/src/engine.ts:146,168`) are outside it |
| TESTS-05 | End-to-end hiring scenarios on PGlite (Brightline dental; consumer playbook) | partial | owner, candidate, ITS recruiter | `tests/scenario/lifecycle.test.ts` (23 tests, steps 1 to 13), `tests/scenario/consumer-lifecycle.test.ts` (5 tests); steps 12b, 13b, 14, 15, 16 skipped at `lifecycle.test.ts:495-499` |
| TESTS-06 | Web app logic tests (`tests/web`: pure helpers behind the signed-in pages) | partial | owners and hiring teams (Today, Talent, board, panel, job builder, publishing, telling) | 30 files / 414 tests; import `apps/web/src/**` helpers only; no DOM; **not type-checked in CI**, 26 type errors (section 9) |
| TESTS-07 | Shell tests: React components rendered to static markup; CSP, headers, fonts, Hono mount, container | fully_implemented | all signed-in users; candidates (headers) | 16 files / 161 tests in `apps/shell/components/*.test.ts` (use `renderToStaticMarkup`) and `apps/shell/lib/*.test.ts` |
| TESTS-08 | Playwright browser journeys with axe accessibility checks (desktop and iPhone 13) | fully_implemented (in CI; not run in this audit) | owner, candidate on phone, ITS staff, platform admin | 18 specs, 28 tests, 32 runs (`tests/e2e/playwright.config.ts:32-36`); `.github/workflows/ci.yml:104-120`; last local run `tests/e2e/test-results/.last-run.json` = passed (12 Oct 2026 01:01). Caveat: that file records only pass/fail, not how many tests ran, and the local run used an untracked temporary Edge config (`tests/e2e/playwright.local.config.ts`), so it does not prove all 32 runs passed at `dafb730` |
| TESTS-09 | AI evaluation harness on the fake provider (`pnpm eval` in CI) | fully_implemented | ITS engineering (proves the harness and code-side rules, not the prompts) | `packages/evals/src/runner.ts` (17 suites), `thresholds.json`, `ci.yml:90-91`; `packages/evals/README.md:5` |
| TESTS-10 | Real-AI fairness tests (GitHub "Run workflow" button) | partial | platform owner / founder; protects candidates from unfair screening | `.github/workflows/fairness.yml:9-21,49-70` (manual, `--suite resume,triage` only); `packages/evals/src/summary.ts`; `docs/runbooks/fairness-tests.md`; **no `-anthropic.json` result in the repository** (`packages/evals/results/*.json` is git-ignored, `.gitignore:66`) |
| TESTS-11 | Real-model evaluation of the other prompts (job draft on Sonnet 5.5, screening conversation, scorecard, change by chat, company "about" text, suggested message line) | partial (was planned_not_implemented) | owners (job draft), candidates (screening conversation) | The runner already runs every one of the 17 suites on the real models when started by hand with `AI_PROVIDER=anthropic` (`packages/evals/src/runner.ts:34-40,116-310`; `packages/evals/README.md:6`). Missing: any workflow or schedule that runs them, and any recorded result; `docs/STATUS.md:56,69` lists real-model runs as still open |
| TESTS-12 | CI `verify` job on every PR and push to `main` | fully_implemented | ITS engineering; gate before anything merges | `.github/workflows/ci.yml:6-9,37-129` |
| TESTS-13 | TypeScript check in CI | partial | ITS engineering | `package.json:16` (`pnpm -r typecheck`) covers the 15 workspace packages; `tests/web` and `tests/policy` have no `package.json` / `tsconfig.json`, so they are never type-checked |
| TESTS-14 | Lint (Biome, recommended rules) | fully_implemented (CI only) | ITS engineering | `ci.yml:81-82`; `biome.json` (formatter disabled, `:7`); cannot run on the team's Windows machine (Biome binary blocked) |
| TESTS-15 | Secret scanning (pinned gitleaks over history and tree; repository pattern scan) and dependency audit | fully_implemented | platform admin / security | `ci.yml:63-76`; `scripts/secret-scan.ts`; `.gitleaks.toml` |
| TESTS-16 | Migration validation and data-migration tests | fully_implemented | every customer (schema safety) | `packages/db/src/cli/validate.ts:16,45-49,60` (numbering, destructive statements, RLS); `ci.yml:84-85`; `migrate.yml:48-49`; `packages/db/src/{marks-told,company-verification,followups}-migration.test.ts`, `migrate.test.ts`, `schema-drift.test.ts` |
| TESTS-17 | Release migration workflow (manual) | fully_implemented | founder (runs it), every customer (affected) | `.github/workflows/migrate.yml:8-14,48-58` |
| TESTS-18 | Smoke against a deployed address (`E2E_BASE_URL`) | partial | founder / ITS on staging | `tests/e2e/playwright.config.ts:9-18,38`; `tests/e2e/specs/helpers.ts:5-13` (every sign-in journey skips itself); manual only |
| TESTS-19 | Isolation suites on a real Postgres test database (`TEST_DATABASE_URL`) | partial | every customer company | `packages/db/src/rls.test.ts:47-50`, `pool.test.ts:116-117`; `docs/handoff/developer-onboarding.md:70-76`; optional manual step (`docs/STATUS.md:140`) |
| TESTS-20 | Synthetic load script for the apply form | fully_implemented (manual tool) | candidates (apply under load) | `scripts/load-apply.ts`; proved locally by `apps/api/src/load-apply.test.ts` (2 tests) |
| TESTS-21 | Local CI rehearsal script | partial | ITS engineering | `scripts/ci-local.sh` (bash and pnpm, neither usable on the team's machine; gitleaks dir-only; e2e as one run) |
| TESTS-22 | Deferred scenario steps: interview recording and draft scorecards (12b), debrief (13b), automated offers (14), onboarding (15), recruiter takeover overlay and handback (16) | planned_not_implemented | owner, interviewer, ITS recruiter | `tests/scenario/lifecycle.test.ts:476-499`; `docs/readiness/17-skipped-tests.md` |
| TESTS-23 | Pull-request template with the definition-of-done checklist | planned_not_implemented | ITS engineering | Claimed in `docs/13-test-plan.md:42`; `.github/` holds only `workflows/ci.yml`, `fairness.yml`, `migrate.yml` |
| TESTS-24 | Nightly real-model evals, migration test from the previous tag, tag-triggered staging deploy | planned_not_implemented | founder, ITS engineering | Planned in `docs/spec/10-test-and-deployment-plan.md:23-25`; absent from `.github/workflows` |
| TESTS-25 | Dead-worker and stuck-queue detection tests (heartbeat, worker `/healthz`, `worker.stale` and `queue.stale` alerts) | fully_implemented | ITS admins (alerted); candidates and owners (whose messages wait on the worker) | Added in verification. `apps/api/src/worker-health.test.ts:60-139` (the worker's own `/healthz` turns 503 once polls stop; the app raises the `worker.stale` alert with `workerInline: false`); `apps/api/src/maintenance.test.ts:80-122` (`checkOperationalHealth`, `HEARTBEAT_STALE_MS`, `queue.stale`). Detection is tested; the re-claim of the dead worker's job is not (section 9 item 4) |
| TESTS-26 | Staging database check scripts (set up roles, test one connection string, read-only status) | fully_implemented (manual tool, untested wrappers) | founder (runs them); every customer company (correct roles) | Added in verification. `scripts/staging-db-setup.sh`, `scripts/staging-db-check-role.sh`, `scripts/staging-db-status.sh`, `scripts/lib/db-owner-url.sh`, `packages/db/src/cli/check-role.ts`; the role judgement they print is tested (`packages/db/src/rls.test.ts:215-226`, `problemsWithConnectionRole`), the bash wrappers are not, and they need bash and pnpm (the founder's Mac, not the team's Windows machine) |

## 3. Workflows traced step by step

### 3.1 A pull request is checked (actor: developer or Claude Code; GitHub Actions)
1. A push to a pull request branch, or to `main`, starts `ci.yml` (`:6-9`). Concurrency cancels an older run on the same ref (`:14-16`). The runner is pinned to `ubuntu-24.04` (`:43`), with a 90-minute limit (`:46`).
2. The job sets fake providers only (`:18-35`): `AI_PROVIDER`, `EMAIL_PROVIDER`, `SMS_PROVIDER`, `AUTH_PROVIDER`, `CALENDAR_PROVIDER`, `ANALYTICS_PROVIDER=fake`; `SECRET_STORE=memory`, `STORAGE_PROVIDER=memory`, `PGLITE_DIR=memory://`, `WORKER_INLINE=true`, `COMP_BLS_ENABLED=false`, `MAGIC_LINK_ENABLED=true`, `RATE_LIMIT_STORE=fake`, `CSP_MODE=report-only`. No secret is used, and forks get the same checks.
3. Install from the lockfile (`:60-61`). Then gitleaks v8.30.1, checksum-verified, over git history and the working tree (`:63-70`), and `pnpm secret-scan` (`:72-73`).
4. `pnpm audit --audit-level high` (`:75-76`), then `pnpm typecheck` = `pnpm -r typecheck`: every workspace package's `tsc -p tsconfig.json`, which does not include `tests/web` or `tests/policy` (`:78-79`).
5. `pnpm lint` = `biome lint` (`:81-82`), then `pnpm db:validate`. The validator applies every migration to a fresh PGlite and checks numbering, destructive statements, row-level security and tenant grants (`:84-85`).
6. `pnpm test` = `vitest run` over `packages/*/src`, `apps/api/src`, `apps/shell` and `tests/**` (`:87-88`).
7. `pnpm eval` runs every eval suite on the fake provider (`:90-91`), then the Next.js production build of `apps/shell` (`:93-94`).
8. Chromium is installed, and Playwright runs in three passes, each with its own `next dev --turbopack` server: shard 1/2 and shard 2/2 (excluding the route inventory), then `specs/routes.spec.ts` alone (`:104-120`). Passes 2 and 3 run even when pass 1 fails, but only once pass 1 has started (`:111,117`). On CI one retry is allowed per test (`playwright.config.ts:28`).
9. The HTML report is uploaded as an artifact, kept 7 days (`:122-129`). The job's name, `verify`, is documented as the required check on `main` (`:39`; `docs/handoff/developer-onboarding.md:24-27`). The branch protection setting itself is not visible in the repository.

### 3.2 The baseline run done for this audit (actor: auditor, Windows 11, PowerShell 5.1)
1. Every CI variable from `ci.yml:18-35` was set in the shell, plus `NO_COLOR`/`FORCE_COLOR=0`. No `.env` is loaded by vitest; nothing in the repo calls `dotenv`.
2. `node_modules\.bin\vitest.cmd run` ran from the repository root. Output is in `vitest-baseline.txt`.
3. Result: `Test Files 204 passed (204)`, `Tests 2148 passed | 6 skipped (2154)`, duration 953.72 s. The slowest files were `new-times.test.ts` (125 s), `interview-loop.test.ts` (45 s) and `candidate-cancel.test.ts` (27 s).
4. Skipped: the five `it.skip` steps in `tests/scenario/lifecycle.test.ts:495-499`, and `packages/db/src/pool.test.ts:117` ("on a real Postgres: every connection is in platform mode…", skipped without `TEST_DATABASE_URL`). The font tests ran, because the fonts are committed under `apps/shell/public/fonts`. The RLS role tests ran, because PGlite is a superuser.
5. All 32 stderr blocks in the output are deliberate negative tests: same-site refusals, retired environment variables, error-reporting tests, a simulated database failure. None of them signals a defect.
6. `tsc.cmd -p <pkg>\tsconfig.json --noEmit` ran for each of the 15 packages (0 errors each). Scratch tsconfigs extending `tsconfig.base.json` were used for `tests/web` (26 errors) and `tests/policy` (0).

### 3.3 The founder runs the real-AI fairness check (actor: founder or ITS admin with repository write access)
1. In GitHub: Actions, then **fairness**, then **Run workflow**. The runner can choose the screening model (`claude-haiku-5-5` or `claude-sonnet-5-5`) and the effort (`fairness.yml:9-21`).
2. The job fails at once, with plain guidance, if the repository secret `ANTHROPIC_API_KEY` is missing (`:49-56`).
3. `tsx src/runner.ts --suite resume,triage` runs with `AI_PROVIDER=anthropic`, `AI_MODEL_STANDARD` and `AI_EFFORT_STANDARD` (`:58-66`). In `runner.ts` only the `resume.*` and `triage.*` families run (`:25-29,122-205`):
   - CV extraction, plus quote grounding checked on the model's raw output.
   - Triage edge cases and their hallucination check.
   - Bias pairs (`triage.bias_pairs`).
   - Consistency (`triage.consistency`).
   Each application is read `TRIAGE_READINGS` times and combined with `combineOutcomes` (`:156-166`). The golden job packet is compiled first with the job-draft prompt (`:139-145`).
4. Every case is scored against `thresholds.json` (mostly a 100 % pass rate). The cost is read from `ai_runs` (`:312-325`). A result file goes to `packages/evals/results/<timestamp>-<provider>.json` (`:326-329`), and the exit code is 1 if any suite misses its threshold.
5. `summary.ts` writes a plain-words table to the run's Summary page (`fairness.yml:68-70`; `summary.ts:34-66`).
6. The results folder is uploaded as an artifact, kept 90 days (`:72-79`). Nothing is committed back to the repository, and `.gitignore:66` (`packages/evals/results/*.json`) keeps result files out of git. If the run dies before writing a result (for example the golden packet fails, `runner.ts:143,335`), the fresh checkout has no results folder, so the summary step prints "No result to summarize: …" (`summary.ts:68-71,80-82`) rather than an old result.

### 3.4 Migrations are released (actor: founder)
1. Actions, then **migrate**, then **Run workflow**, choosing a GitHub environment, which holds `MIGRATE_DATABASE_URL` and `DATABASE_SSL_CA` (`migrate.yml:8-14,31-34`).
2. Install, then `pnpm db:validate`, then `pnpm db:status --report-only`, then `pnpm db:migrate`, then `pnpm db:status --fail-on-pending-migrations` (`:45-58`). The production app refuses to boot while a migration is pending (comment `:1-5`).

### 3.5 The hiring scenario as a test (actor: test, standing in for owner Dana and candidates)
`tests/scenario/lifecycle.test.ts` boots one container on PGlite with fakes and `SMS_ENABLED=true` (`:44`). It signs in by magic link (`:35-40`), creates "Brightline Dental Group" and then walks the steps:
- intake, with unlawful criteria refused, and an invalid AI output retried once and then reported (steps 1 to 1c)
- the role packet with dental playbook rules, owner-only approval, posting with URL verification and an ITS posting task (steps 2 to 4)
- a phone application with acknowledgment, deterministic eligibility, and a résumé read with verified quotes, where the AI never rejects (steps 5 and 6)
- the brief, and "ask a recruiter" (steps 7 and 8)
- an audited view, and a decline that needs a reason (step 9)
- the SMS screen, the hand-off to a person within 4 hours, and the stuck-role ladder (steps 10 to 10c)
- scheduling in the candidate's own time zone, the interview recorded by a person, and the decision by a person (steps 11 to 13)

Steps 12b to 16 are recorded as deferred, each with its reason, risk, owner and release (`:476-493`), and are skipped (`:495-499`).

### 3.6 A browser journey: the candidate on a phone (actor: Playwright, standing in for a candidate)
`tests/e2e/specs/candidate-phone.spec.ts` runs on the "phone" project only (iPhone 13 viewport, `playwright.config.ts:35`):
1. The owner signs in through the fake Google consent page and creates the company.
2. The ITS admin switches the company to the one-visit flow (`helpers.ts:92-102`).
3. A role is seeded through the API.
4. The candidate opens the job page, applies with the acknowledgment, and goes through the screening conversation (introduction, taps, a skip, "Check your answers", Send).
5. The candidate books from the schedule page, then cancels it, choosing what they would like next (`:269-288`).
6. Every page is checked with axe (WCAG 2.1 A/AA plus best practice, `helpers.ts:30-37`) and for sideways scrolling.

### 3.7 Smoke against staging (actor: founder or ITS)
1. Set `E2E_BASE_URL=https://…`.
2. No local server starts (`playwright.config.ts:38`), and every journey that needs the fake sign-in skips itself (`helpers.ts:11-13`).
3. What a deployment can still prove: public pages, headers, CSP, and the signed-out redirects (`routes.spec.ts:16-50`). This step is manual and not part of CI.

## 4. Routes and screens relevant to testing

| path / entry | kind | purpose | audience |
|---|---|---|---|
| `.github/workflows/ci.yml` (job `verify`) | CI workflow, automatic | every check before merge | ITS engineering |
| `.github/workflows/fairness.yml` | CI workflow, manual button | real-AI CV reading and screening fairness checks | founder / ITS admin |
| `.github/workflows/migrate.yml` | CI workflow, manual | apply pending migrations to one environment | founder |
| `/dev/outbox`, `/dev/sms-outbox` | test-only API route (`apps/api/src/app.ts:162-170`) | what the fake email/SMS adapters "sent"; journeys read magic links and status links from it (`helpers.ts:153-162`) | tests; exists only when `NODE_ENV` is not production and the adapter is the fake |
| fake identity consent page ("Continue with Google/Microsoft", "Second factor verified (TOTP)") | test-only sign-in page | sign in as anyone in journeys (`helpers.ts:43-68`) | tests |
| `/api/v1/integrations/calendar/fake/authorize` | test-only API route (`apps/api/src/routes/integrations.ts:117,134`) | fake calendar connection | tests |
| `/api/v1/admin/observability/test-error` | staff API route (`apps/api/src/routes/observability.ts:39`) | deliberate error to prove Sentry scrubbing; tested by `observability-route.test.ts` | platform admin on staging |
| `/healthz` | health route | Playwright waits on it before starting (`playwright.config.ts:44`) | infrastructure |
| `/`, `/roles`, `/roles/new`, `/talent`, `/interviews`, `/setup`, `/updates`, `/recruiter/queue`, `/admin` | signed-in screens | route inventory: signed-out redirect, wrong-role redirect, right role renders and passes axe (`routes.spec.ts:45-132`) | owner, ITS recruiter, platform admin |
| `/careers/<slug>/jobs/<id>`, `/careers/<slug>/jobs/<id>/apply`, `/c/screen/<token>`, `/c/schedule/<token>`, `/c/status/<token>`, `/privacy` | candidate pages | phone journey and route inventory | candidate |

## 5. Data models and dependencies

- **Test database**: PGlite (Postgres compiled to WebAssembly) in memory (`PGLITE_DIR=memory://`). Each test file builds its own container through `createContainer(testContainerOptions(...))` and runs every migration. That makes API files slow: about 6 to 125 s each, and 710 s in total for `apps/api`. PGlite runs as a superuser, so row-level security is exercised only inside `withTenant`/`withPlatform`, where the code switches role. A query that forgets the wrapper is caught only by the count ratchet in `tests/policy/raw-db-access.test.ts:18-30`.
- **Fake providers**: `FakeProvider` for AI, with `container.fake.scriptNext(task, output)` to script one reply (`packages/ai/src/providers/fake.ts`; `developer-onboarding.md:76-77`). Also fake email and SMS adapters with in-memory "sent" lists, a fake identity provider, a fake Google calendar, fake analytics, a memory secret store, memory storage, and a fake rate-limit store.
- **`takeovers` table** (`packages/db/src/schema/platform.ts:188`): read by `packages/core/src/policy.ts:162-166` and `packages/core/src/interview-followups.ts:384`. It is written **only by tests**, by direct insert:
  - `apps/api/src/new-times.test.ts:502,700,749,819`
  - `apps/api/src/telling-candidates.test.ts:336`
  - `apps/api/src/candidate-cancel.test.ts:353`
  - `apps/api/src/approvals-access.test.ts:127`
  - `apps/api/src/policy-floors.test.ts:88`
  - `packages/core/src/interview-followups.test.ts:466` (added in verification)
  - `packages/agents/src/new-times.test.ts:157` (added in verification)
  - `packages/workflows/src/new-times.test.ts:264` (added in verification)

  No product code inserts or updates it. This is a recorded decision, not an oversight: `docs/spec/00-decisions-and-risks.md:109` (P10) says the overlay exists and there is no takeover flow or UI in release 1.
- **Eval artifacts**: `packages/evals/thresholds.json` (minimum pass rate per suite), and `packages/evals/results/*.json` (provider, models, efforts, suites, cost, per-case results). Seven `-fake.json` files (28 Sep to 13 Oct 2026) exist **on this machine only**: the folder is git-ignored (`.gitignore:66`) and `git ls-files packages/evals/results` is empty, so nothing in it is committed. Model calls and their costs are recorded in the `ai_runs` table during the run.
- **Playwright artifacts**: `tests/e2e/report/<n>` (HTML) and `tests/e2e/test-results/.last-run.json` (git-ignored; locally `passed`, 12 Oct 2026 01:01).
- **Tooling dependencies**: vitest 4.1.11 (`package.json:36`), TypeScript ^5.9, `@playwright/test` ^1.55 and `@axe-core/playwright` ^4.10 (`tests/e2e/package.json`), Biome 2.5.14, Node 24, pnpm 12.3.4.

## 6. Roles and permissions specific to this area

- **Anyone opening a pull request**, forks included: CI runs automatically with no secrets (`ci.yml:2-3,11-12`, `permissions: contents: read`).
- **Repository writers** (founder, ITS engineering): only they can press **Run workflow** for `fairness` and `migrate` (`workflow_dispatch`).
  - `fairness` needs the repository secret `ANTHROPIC_API_KEY`. It never runs on a pull request, so a fork's code never sees the key (`fairness.yml:5-6`).
  - `migrate` needs environment secrets and runs under the chosen GitHub environment, whose protection rules (if any) are not visible from the repository.
- **Product roles exercised by tests**: owner; admin; hiring manager; HR (refused decisions and closing-message sends); interviewer (sees only their own interviews); ITS recruiter under a scoped, time-limited grant (one candidate or a whole role); platform administrator (bootstrapped by `BOOTSTRAP_ADMIN_EMAILS=admin-e2e@identifiedtalent.com` in the Playwright server, `playwright.config.ts:56`, with mandatory second factor); and the candidate, through token links.

  Permission-focused suites: `permission-hardening.test.ts`, `posting-access.test.ts`, `approvals-access.test.ts`, `staff-access.test.ts`, `platform-roles.test.ts`, `team.test.ts`, `mfa.test.ts`, `same-site.test.ts`, `security-coverage.test.ts`, and the wrong-role redirects in `routes.spec.ts:52-132`.

## 7. Integrations and AI behaviour under test

- **AI in CI is always fake.** The 17 eval suites prove the harness, the schemas and the code-side rules: quote grounding, the follow-up cap, the hand-off, and match-score determinism (`board.determinism` runs code only). The README itself says they do not test the prompts (`packages/evals/README.md:5`).
- **Model allow-list**: `packages/ai/src/routing.test.ts:11-48` proves only Haiku 5.5 and Sonnet 5.5 are accepted, with Sonnet only for the job draft. It also checks the effort per tier and the refusal of any other model.
- **Anthropic adapter**: tested against a stubbed client (`packages/ai/src/providers/anthropic.test.ts`, 34 tests: streaming, fallback without constrained decoding, correction turn, time budget and deadlines, no assistant turn last for Haiku/Sonnet 5.5, cache-write costs).
- **Fairness and evidence rules** (PRs #37/#38):
  - `packages/agents/src/triage-readings.test.ts`: three readings, the middle answer, order independence, fewer than three readings, outage retry, and the expired-credential rule.
  - `packages/agents/src/evidence-rules.test.ts`: an unquoted "no" becomes unknown, quotes are verified, there are no model-supplied numbers, and confidence steps down.
  - The bias-pair and consistency suites (`runner.ts:178-204`).
- **Real AI** runs only in the manual `fairness` workflow, and only for the CV-reading and triage families.
- **External services**: Postmark (email webhooks and inbound), Twilio, Google/Microsoft sign-in and calendar, Supabase Storage (S3 SigV4), Upstash, Sentry, BLS wages and ClamAV are tested with fakes, recorded fixtures or local stand-ins:
  - `packages/integrations/src/*` (71 tests; `scanning/clamav.test.ts` against a stand-in clamd; `storage/sigv4.test.ts`)
  - `apps/api/src/postmark-*.test.ts`, `inbound-auth.test.ts`
  - `supabase-signin.test.ts`, `identity.test.ts`

  None is exercised live by any automated job. Live checks are the manual staging checklist (`docs/readiness/03`).

## 8. Tests present, and what is missing

### Present (counts from the baseline run)
| group | files | tests | main areas |
|---|---|---|---|
| `apps/api` | 86 | 799 | every API area: auth/MFA/same-site/CSP/rate limits; companies, team, settings, company check; job builder, packets, approvals, publishing, postings, job pages and feeds; apply form, one-visit conversation, repeat applications, unsent answers; screening, intelligence, pool board, marks, telling candidates, decisions; interviews, scheduling, cancel, Cancelled column, new times; hire sheet and notes; recruiter requests and loop, staff access; notifications; privacy requests; storage uploads; outbox, email failures, worker health, maintenance, boot checks; role report; observability |
| `packages/core` | 18 | 269 | state machine, stage strip, eligibility, dedupe, policy, permissions, business hours/calendar, match score, board, pool summary, postings, publishing, packet guard, intake builder, interview follow-ups, hire notes, screen answers, notify, secrets |
| `packages/agents` | 12 | 127 | intake finalize, packet revise, requirements check, screening, telling, interview messages, new times, company about, documents (PDF/Word), evidence rules, triage readings |
| `packages/db` | 14 | 102 (1 skipped) | RLS, API roles, migrations, migration ledger, data migrations 0026/0027/0035, schema drift, TLS, connection strings, pool, provisioning, deliver |
| `packages/integrations` | 8 | 71 | adapters, Postmark, ClamAV, BLS, job boards and feeds, storage, SigV4, logo |
| `packages/ui` | 7 | 86 | tokens, board CSS, menus, sheets, score bars, weight guard, helpers |
| `packages/ai` | 5 | 59 | routing allow-list, Anthropic adapter, runner, pricing, intake prompt |
| `packages/evals` | 2 | 18 | board suite, plain-words summary |
| `packages/workflows` | 1 | 10 | new-times workflow |
| `packages/contracts` | 1 | 6 | file inspection |
| `packages/playbooks` | 0 | 0 | only indirectly through intake tests |
| `apps/shell` | 16 | 161 | static-markup UI (shell, new role, one visit, pool board, publishing, report tables, stage button, tables, talent page, telling/hiring, demo fixes); CSP, headers, fonts, Hono mount, container |
| `tests/web` | 30 | 414 | pure page logic for allowance, apply flow, board, Cancelled, candidate panel, company check, compare, first screen, focus, hiring, job builder, match panel, motion, notes, notifications, publishing, recruiter requests, role page, screen view, setup, shell rail, polish, skills form, start hire, talent actions/list, telling, toast, Today, demo fixes |
| `tests/scenario` | 2 | 28 (5 skipped) | Brightline dental lifecycle; consumer lifecycle |
| `tests/policy` | 2 | 4 | service-role guard, raw-DB ratchet |
| `tests/e2e` (Playwright, not vitest) | 18 specs | 28 tests / 32 runs | see list below |

Playwright specs (`tests/e2e/specs`), with the journey each covers:
- `journey.spec.ts`: from sign-in to a booked interview and a reschedule. Staff sign-in policy: Google refused for staff, Microsoft without a second factor goes to the authenticator page, staff with it land on the queue.
- `job-builder.spec.ts`: from Today's box to a role waiting for approval; phone layout with one pane at a time; "Start a hire" resumes the draft, and "Start a different role".
- `publishing.spec.ts`: approve, see where the job is going, share, set a closing date. Setup: logo, "about the company" text, who posts on the boards.
- `company-check.spec.ts`: getting started; ITS taking back its confirmation takes the careers page offline, and Today says why.
- `candidate-phone.spec.ts` (phone only): job page, apply with acknowledgment, one-visit conversation, scheduling, cancel; axe and no sideways scroll.
- `one-visit-owner.spec.ts`: "still applying" on the list, the panel and the report; ITS switches the company and a role between flows.
- `stage-strip.spec.ts`: strip counts, a private shortlist from the row, the panel's address, next/previous, the unsent-text guard.
- `pool-board.spec.ts`: Today's card, the board, one-click questions, Review and apply privately, the board on a phone.
- `match-panel.spec.ts`: the match card, importance tags, the skills editor opened at a section.
- `talent-actions.spec.ts`: hold with a date, private decline, decision message after a preview, eligibility "Decline now"; "Stop this screen".
- `closing-message.spec.ts`: the close card lists who is still in process; one closing message with a single Send.
- `decision.spec.ts`: outcome on the interview sheet, then the decision on the candidate sheet through the deep link.
- `panels.spec.ts`: Escape closes the top panel first; scrolling restored; Back.
- `recruiter-requests.spec.ts`: ask, read the answer on Today, reopen; loosening an AI rule asks first, and planned rules fold under "Coming later".
- `revoke-access.spec.ts`: the owner sees who has access, confirms with a reason, and access ends at once.
- `notifications.spec.ts`: choose which updates are emailed; earlier updates from Today.
- `staff-mfa.spec.ts`: enrol an authenticator, backup code, next sign-in asks for a code; five wrong codes end the attempt.
- `routes.spec.ts` (desktop and phone): one CSP with a nonce on every page; signed-out redirects; owner sees company routes and is sent home from recruiter/admin routes; seeded platform admin reaches queue and console with axe.

### Critical workflows with weak or no automated coverage
1. **Tenant isolation on the real database.** CI proves row-level security only on PGlite, inside `withTenant` (which switches to the non-superuser `app_tenant` role, so the policies really are judged there). The real-Postgres runs (`TEST_DATABASE_URL`) are optional and manual, and `pool.test.ts:117` is skipped in every CI run. A forgotten tenant wrapper is caught only by a count ratchet, not by a behavioural test, and that ratchet only scans `apps/api/src` (not `packages/*`). *Who is affected:* every customer company, if one company's candidates ever showed up for another.
2. **The real AI.** CI evals use the fake model. The fairness button covers only CV reading and screening. No real-model result is committed. The job draft (Sonnet 5.5), the screening conversation, the screening scorecard, change by chat, the "about" text and suggested message lines have no real-model check at all. *Who is affected:* candidates (fair screening, honest conversation) and owners (job drafts).
3. **Live integrations.** Email delivery and inbound replies, SMS, Google/Microsoft sign-in, calendars, storage, the virus scanner, rate limiting and error reporting are covered only with fakes and stand-ins. *Who is affected:* every candidate message and every sign-in.
4. **The worker as a separate process, and crash recovery.** Almost every test uses `WORKER_INLINE=true`; the exception is the health checks (`worker-health.test.ts`, `maintenance.test.ts`, with `workerInline: false`), which prove a dead worker is *noticed* (503 on its `/healthz`, a `worker.stale` alert for ITS). What is not tested is recovery: the stale-lease re-claim in `packages/workflows/src/engine.ts:145-156` (a job held by a dead worker becoming claimable again after `leaseMs`, 5 minutes by default, `:51`). No test sets an expired `locked_at` and runs the queue, although `docs/13-test-plan.md:6,38` and `docs/spec/10-test-and-deployment-plan.md:15` describe worker-crash recovery as tested. *Who is affected:* candidates and owners waiting on acknowledgments, screens and reminders if the Railway worker dies mid-step.
5. **The recruiter takeover.** Every "during an ITS takeover" rule (no automatic new times, recruiter approves messages, policy overlay) is tested only with rows inserted straight into `takeovers`. No route or service creates one, so the tests prove guards for a state the product cannot reach. *Who is affected:* ITS recruiters, and owners expecting a takeover to work.
6. **The signed-in UI as a person uses it.** (Corrected in verification; the first count missed the `@ros/web/src/...` imports in `apps/shell/components/*.test.ts`.) Of the 101 modules in `apps/web/src`, 63 are imported directly by a vitest test and 94 are reached through those imports. For example `People`, `CandidatePanel`, `RoleReport`, `ComparePanel`, `Interviews`, `Admin`, `AdminCustomerReport`, `RecruiterQueue` and `Setup` are rendered by `one-visit-ui.test.ts:25-30`, `telling-hiring-ui.test.ts:24-29`, `report-tables.test.ts:24-32` and `publishing-ui.test.ts:23-29`. Only 7 are reached by no vitest test at all:
   - `pages/CompanySetup.tsx`, `pages/Login.tsx`, `pages/Roles.tsx`
   - `pages/RoleDetail.tsx`, `pages/RoleEditor.tsx`, `pages/new-role/RoleRefine.tsx`
   - `pages/Updates.tsx`

   (Script: scratchpad `audit/webcov.mjs`.) But "reached" means rendered to static markup or called as a pure helper: React components are never clicked or focused in vitest. Interaction depends on the 32 Playwright runs. Those take about 50 minutes on CI, get one retry each (so flakiness can pass unnoticed), and could not be run in this audit. *Who is affected:* owners and hiring teams.
7. **Screens with no browser journey at all.** The owner-side Cancelled column and "Send new times" (API-tested by `new-times.test.ts`, 28 tests, and `cancelled-column.test.ts`); the compare view; the role report CSV downloads; the admin privacy-request handling; team invitations in the UI; and most admin-console actions beyond the company check and plan or flow switches done through the API in helpers.
8. **Type safety of the web tests.** `tests/web` (414 tests) is never type-checked and has 26 errors (section 9). Today's errors do not change any test's result, but nothing would flag the next drift.
9. **Upgrades of a live database.** `db:validate` applies all migrations to an empty database. There is no "upgrade from the previous release" test (planned in `docs/spec/10:23`). The data migrations 0026, 0027 and 0035 do have their own tests.
10. **Load and performance.** Only the manual `scripts/load-apply.ts`. There is no automated load check, and no performance budget.
11. **No coverage measurement.** No coverage tool or threshold is configured (no `--coverage` in `vitest.config.ts` or in CI), so the share of code exercised is unknown.
12. **Deferred product steps.** Interview recording and scorecards, debrief, automated offers, onboarding, and the takeover overlay and handback are skipped by decision (`lifecycle.test.ts:495-499`).
13. **No automated dependency updates** (added in verification). There is no Dependabot or Renovate configuration in the repository; `pnpm audit --audit-level high` in CI only fails a run once an advisory exists, and the overrides in `pnpm-workspace.yaml:11-14` are maintained by hand.
14. **Deploys are not visibly gated by CI** (added in verification). Vercel (`apps/shell/vercel.json`) and Railway (`railway.json`) build from their own integrations; nothing in the repository shows that a deploy waits for the `verify` job. This is a GitHub/Vercel/Railway setting (section 11).

## 9. Bugs and incomplete features

1. **`tests/web` is not type-checked, and has 26 type errors** (low; was medium, downgraded in verification). CI's `pnpm -r typecheck` only reaches workspace packages (`pnpm-workspace.yaml:2-4` lists `tests/*`, but `tests/web` has neither a `package.json` nor a `tsconfig.json`, so pnpm does not see it). Errors by file (`tsc-tests-web.txt`), with what each one really means:
   - `tests/web/cancelled.test.ts`: 13 errors, lines 100-167. The cause is the test's own helper type: `view()` takes `Partial<CancelledView> & { auto?: Partial<…> }` (`:15`), and the intersection makes TypeScript demand a complete `auto`. At run time the helper fills every missing field with defaults (`:20`), so the data the tests use is complete. This is not data drift.
   - `tests/web/talent-list.test.ts`: 10 errors, lines 51-213. The `byGroup` fixtures lack the `waiting_on_candidate` group, which `StageStripCounts` now requires (`apps/web/src/api/client.ts:153`). This is real drift, but the functions under test read only `byGroup.waiting_on_you` (`apps/web/src/talent-list.ts:97,121`), so no result depends on the missing key.
   - `tests/web/job-builder.test.ts:324`: an excess-property check. The test passes `{ assistantMessage: "Hi" }` to `turnProblem`, whose parameter type omits that field (`apps/web/src/pages/new-role/rules.ts:519`). Harmless.
   - `tests/web/compare-view.test.ts:2` and `tests/web/match-panel.test.ts:3`: `@ros/contracts` cannot be resolved from the scratch tsconfig (type-only imports, so the tests still run). This is an artefact of the audit's setup.

   *Effect:* nothing is wrong today. The risk is forward-looking: 414 tests behind the Talent page, the Cancelled column, the job builder and publishing have no type check, so the next real change to an API shape would not be flagged by these tests. Owners could then see wrong counts or labels without CI noticing.
2. ~~The fairness summary can describe an old stand-in result after a failed real-AI run~~ **Refuted in verification.** The premise was that seven `-fake.json` files are committed. They are not: `.gitignore:66` ignores `packages/evals/results/*.json`, and `git ls-files packages/evals` lists no result file. On the fresh checkout in `fairness.yml`, a run that dies before `runner.ts:326-329` leaves no results folder. `summary.ts:68-71` then throws, and `:80-82` prints "No result to summarize: …", which is honest. The artifact upload (`fairness.yml:72-79`) finds only the new run's file, or warns that there is none.
3. **No committed evidence that the real AI was checked** (low; process). `packages/evals/README.md:9` and `docs/11-evaluation-framework.md:44` say a `-anthropic.json` result is the evidence, committed with the PR that changes a prompt or model. PRs #36 (switch to Haiku 5.5 / Sonnet 5.5) and #38 (three readings, high effort, new rules) changed both, yet no result file of any kind is in git. The repository's own `.gitignore:66` excludes them, so following the README needs `git add -f`, and the fairness workflow only uploads a 90-day artifact. *Effect:* the owner cannot show from the repository that screening was checked for fairness on the models in use. The seven `-fake.json` files seen here are local to this machine.
4. **The recruiter takeover cannot be started in the product; the tests exercise its rules through rows they insert themselves** (low; incomplete feature, deferred by recorded decision). See section 5: `takeovers` is only ever inserted by tests (eight test files). `docs/spec/00-decisions-and-risks.md:109` (P10) records that the overlay exists but has no flow or UI in release 1, so this is dormant code rather than a broken feature. Classified as planned_not_implemented under TESTS-22 (step 16). *Effect:* ITS recruiters cannot take over a role. The green "during a takeover" tests prove guards for a state no one can reach yet.
5. **Worker crash recovery is untested** (low; test gap). See item 4 in section 8: detection of a dead worker is tested, but not the re-claim of its job.
6. **No failing tests and no type errors in the 15 CI-checked packages** at `dafb730`. The baseline is green.

## 10. Doc/code drift

- `docs/STATUS.md:53` says "172 test files, 1,725 tests: 1,720 passed and 5 skipped". The code now has **204 files, 2,154 tests (2,148 passed, 6 skipped)**. STATUS is dated 9 October (`:3`) and predates PRs #28 to #38: clean style, security hardening, pool fixes, demo fixes, model allow-list, fairness.
- `docs/readiness/17-skipped-tests.md:3,17` says "exactly five" skips and "5 skipped" in every run. Every CI-like run shows **6 skipped**: it omits `packages/db/src/pool.test.ts:117` (skipped without `TEST_DATABASE_URL`) and the conditional skips in `packages/db/src/rls.test.ts:172,195`. Its line numbers (493 to 497) are now 495 to 499.
- `docs/STATUS.md:60-64`, `docs/spec/20-job-distribution.md:42` and `docs/handoff/developer-onboarding.md:139-140` say Playwright cannot run on the team's Windows machine. `docs/readiness/18-content-security-policy.md:80` says all 32 journeys ran locally on Microsoft Edge, and the untracked `tests/e2e/playwright.local.config.ts` plus `tests/e2e/test-results/.last-run.json` (passed, 12 Oct) confirm local runs.
- `docs/STATUS.md:63` mentions "Biome lint and formatting". `biome.json:7` disables the formatter, so CI checks lint only.
- (Corrected in verification.) `docs/STATUS.md:54` says "Typecheck clean in all 15 packages", which is accurate. `docs/spec/14-slice-5-report.md:54` says "0 errors across every package including the shell and the browser tests". "Browser tests" there means `tests/e2e`, which *is* a type-checked package. Neither doc claims `tests/web`; the gap is that no doc says `tests/web` is outside the type check.
- `docs/10-repository-structure.md:61-65` lists `tests/scenario`, `tests/policy`, `tests/e2e`, but not `tests/web` (30 files, 414 tests). No doc mentions `tests/web` at all.
- `docs/13-test-plan.md`:
  - `:34` says unfinished steps are marked `todo`; they are `it.skip`.
  - `:8` says evals run "nightly with the real provider when a key is present"; there is no schedule, and fairness is manual and limited to two suite families.
  - `:9` points to `docs/acceptance/<slice>.md`, which does not exist.
  - `:42` says "The pull-request template lists these as checkboxes"; there is no PR template.
  - `:38` lists worker-crash failure injection; there is no such test.
- `docs/spec/10-test-and-deployment-plan.md`:
  - `:3` still says "71 automated tests … no CI pipeline".
  - `:23` plans "migration test from the previous tag".
  - `:24` plans nightly real-provider evals that open an issue.
  - `:25` plans a tag-triggered image build and disposable-Postgres migration check.
  - `:16` plans a k6/autocannon load test.

  None is in `.github/workflows`; load testing is the manual `scripts/load-apply.ts`.
- `packages/evals/README.md:9` and `docs/11-evaluation-framework.md:44`: the "commit the `-anthropic.json`" rule conflicts with `.gitignore:66` (`packages/evals/results/*.json`, so a plain `git add` skips it) and with `fairness.yml:72-79`, which uploads an artifact and commits nothing. No result file of any provider is in git.
- `docs/11-evaluation-framework.md:3` says results are "summarized in CI". CI's `pnpm eval` (`ci.yml:90-91`) prints to the log only; the plain-words summary runs only in the manual `fairness.yml`.
- `docs/spec/10-test-and-deployment-plan.md:15` lists "worker crash" under failure injection that already **exists**, and `docs/13-test-plan.md:6` lists "crash recovery" among the integration tests. No test re-claims a crashed worker's job (section 8 item 4).
- `scripts/ci-local.sh` claims "Same steps" as CI (`:2`), and `docs/handoff/developer-onboarding.md:27` says `pnpm ci:local` "runs the same steps on your machine". It runs gitleaks on the directory only (no history), Playwright as one run instead of three servers, and needs bash and pnpm, which are blocked on the team's Windows machine.
- (Withdrawn in verification.) The first draft listed `docs/readiness/17-skipped-tests.md:11` and `docs/STATUS.md:197` as drift for calling the takeover deferred. They are accurate: STATUS says takeover *mode* is deferred, and `docs/spec/00-decisions-and-risks.md:109` (P10) explicitly records that the policy overlay exists with no flow or UI.

## 11. Unknowns

- Whether CI is green on `main` at `dafb730`: GitHub Actions results are not visible from the repository. Lint, the production build, the dependency audit, gitleaks and the 32 Playwright runs were not run in this audit (by instruction, or blocked on this machine).
- Whether branch protection really requires the `verify` check, and whether the `migrate` environments have reviewers: these are GitHub settings and cannot be seen in the repository.
- Whether the fairness workflow has ever run against the real models since PRs #36 to #38, and with what result: only 90-day artifacts would show it.
- Whether the isolation suites were ever run on a real Postgres via `TEST_DATABASE_URL` (STATUS item 10 calls it optional).
- Whether this machine's results match CI exactly. `node_modules` here is a deeply nested, junction-linked layout rather than pnpm's (git warns of over-long paths under `apps/api/node_modules/@ros/...`). `apps/shell/.next/types` exists locally from an earlier build, and CI type-checks before any build.
- Local vitest took about 16 minutes against the 4 to 6 minutes expected. Whether the 60-second test timeout is ever close on slower CI runners is unknown: the slowest single tests here were about 13.6 s.
- How the 26 `tests/web` type errors would change with an official `tsconfig` for that folder (for example, the two `@ros/contracts` resolution errors would go away with a `package.json` declaring the dependency).
- Whether Vercel and Railway deploys wait for a green `verify` (a hosting-side setting, not visible in the repository).

## Verification notes

A skeptical second pass, on 14 Oct 2026. Read only on the repository. No tests were re-run, because no failure was reported. One helper script was written to the scratchpad (`audit/webcov.mjs`, which counts the `apps/web/src` modules reached from vitest test files).

What changed, and why:
- **Bug "fairness summary describes an old fake result": refuted and struck through.** `.gitignore:66` ignores `packages/evals/results/*.json`, and `git ls-files packages/evals` lists no result file. On the workflow's fresh checkout, a run that dies early leaves no results folder, so `summary.ts:80-82` prints "No result to summarize". The "seven committed `-fake.json` files" (sections 5 and 9, and the JSON data model) are in fact local, git-ignored files on this machine. Those statements were corrected.
- **Bug "`tests/web` 26 type errors": kept, downgraded from medium to low, and the effect rewritten.** The count is confirmed (13+10+1+1+1). But the 13 Cancelled errors come from the test's own helper type, while the run-time data is complete (`cancelled.test.ts:15-21`). The 10 Talent errors concern a key the tested functions never read (`talent-list.ts:97,121`). The real issue is the missing type check, not drifted data.
- **Bug "no committed real-AI evidence": kept**, and strengthened: the repository's own `.gitignore` blocks the README's commit rule.
- **Bug "takeover written only by tests": kept.** Three more inserting test files were added (`packages/core/src/interview-followups.test.ts:466`, `packages/agents/src/new-times.test.ts:157`, `packages/workflows/src/new-times.test.ts:264`), and the recorded decision is cited (`docs/spec/00-decisions-and-risks.md:109`, P10). The matching doc-drift item was withdrawn, because the docs are accurate.
- **Bug "worker crash recovery untested": kept.** Confirmed: no test sets an expired `locked_at`. Added that dead-worker *detection* is tested (new TESTS-25).
- **Gap "56 of 101 web modules not imported by any vitest test": corrected.** The count missed the `@ros/web/src/...` dynamic imports in `apps/shell/components/*.test.ts`. The true figures are 63 imported directly and 94 reached, with 7 unreached.
- **Doc drift "STATUS / spec 14 say typecheck includes browser tests": corrected.** "Browser tests" means `tests/e2e`, which is type-checked.
- **Added drift:** `docs/11:3` (results "summarized in CI"), `docs/11:44` (versus `.gitignore`), `docs/spec/10:15` and `docs/13:6` (worker-crash injection "exists"), `docs/handoff/developer-onboarding.md:27` (`ci:local` "same steps").
- **TESTS-11 status: planned_not_implemented changed to partial.** The runner already runs all 17 suites on the real models when started by hand. Only the automation and any recorded result are missing.
- **TESTS-04 note:** the raw-query ratchet scans only `apps/api/src` and three variable spellings.
- **TESTS-08 caveat:** `.last-run.json` does not say how many journeys ran.
- **Added features:** TESTS-25 (dead-worker and stuck-queue detection tests) and TESTS-26 (staging database check scripts).
- **Added gaps:** no automated dependency updates (no Dependabot or Renovate), and deploy gating not visible in the repository.
- **Confirmed unchanged:** baseline totals (204 files; 2,148 passed, 6 skipped; skips at `lifecycle.test.ts:495-499` and `pool.test.ts:117` via `it.skipIf`); 15 type-checked packages (`tests/scenario` and `tests/e2e` among them); no PR template; no coverage tooling; the CI steps and line numbers in `ci.yml`; the `fairness.yml` flow; 17 eval suites; `ci-local.sh` differences; the `docs/13` claims (`todo` versus `it.skip`, nightly evals, `docs/acceptance/` missing, PR template).
