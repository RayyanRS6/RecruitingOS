#!/usr/bin/env bash
# The CI workflow (.github/workflows/ci.yml) run by hand: the same steps in the same order, the same stand-in providers,
# no credentials. gitleaks runs only if it is installed; the repository pattern scan always runs.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=test CI=1 AI_PROVIDER=fake EMAIL_PROVIDER=fake AUTH_PROVIDER=fake ANALYTICS_PROVIDER=fake
export STORAGE_PROVIDER=memory PGLITE_DIR="memory://" WORKER_INLINE=true MAGIC_LINK_ENABLED=true
export RATE_LIMIT_STORE=fake CSP_MODE=report-only
step() { printf '\n== %s ==\n' "$1"; }
# One run of the browser journeys with a dev server of its own, as each of CI's runs has: e2e <report folder> <arguments>
e2e() { local report="$1"; shift; E2E_REPORT_DIR="report/$report" pnpm --filter @ros/e2e exec playwright test "$@"; }

step "install from the lockfile only";        pnpm install --frozen-lockfile
if command -v gitleaks >/dev/null 2>&1; then
  step "gitleaks"
  gitleaks git --config .gitleaks.toml --redact --no-banner --exit-code 1 .
  gitleaks dir --config .gitleaks.toml --redact --no-banner --exit-code 1 .
else
  echo "gitleaks not installed locally; CI runs it"
fi
step "secret scan (repository patterns)";     pnpm secret-scan
step "dependency audit";                      pnpm audit --audit-level high
step "typecheck";                             pnpm typecheck
step "lint";                                  pnpm lint
step "migration validation";                  pnpm db:validate
step "tests";                                 pnpm test
step "evals (stand-in AI)";                   pnpm eval
step "next build";                            pnpm --filter @ros/shell build
step "Playwright browser";                    pnpm --filter @ros/e2e exec playwright install chromium

# The `checks` job's four runs.
step "browser journeys, first half";          e2e 1 --project=chromium --project=phone --shard=1/2 --grep-invert "route inventory"
step "browser journeys, second half";         e2e 2 --project=chromium --project=phone --shard=2/2 --grep-invert "route inventory"
step "route inventory";                       e2e 3 specs/routes.spec.ts
step "sign-up by approval";                   (export SIGNUP_MODE=approval; e2e 4 specs/access-approval.spec.ts)

# The `flows` job's four parts.
for part in 1 2 3; do
  step "the whole flows, part $part of 3";    e2e "flows-$part" --project=flows --project=flows-phone "--shard=$part/3"
done
step "the whole flows, email down";           (export E2E_EMAIL_PROVIDER=postmark; e2e flows-email --project=flows --project=flows-phone specs/flow-email-down.spec.ts)

echo; echo "ci-local: all steps passed"
