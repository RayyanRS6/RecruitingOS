#!/usr/bin/env bash
# The CI workflow, run by hand on a laptop (21 Sep, item 7). Same steps, same fake providers, no credentials.
# gitleaks runs only if installed; the repository pattern scan always runs.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=test CI=1 AI_PROVIDER=fake EMAIL_PROVIDER=fake SMS_PROVIDER=fake AUTH_PROVIDER=fake CALENDAR_PROVIDER=fake ANALYTICS_PROVIDER=fake
export SECRET_STORE=memory STORAGE_PROVIDER=memory PGLITE_DIR="memory://" WORKER_INLINE=true COMP_BLS_ENABLED=false MAGIC_LINK_ENABLED=true
export RATE_LIMIT_STORE=fake CSP_MODE=report-only
step() { printf '\n== %s ==\n' "$1"; }
step "install from the lockfile only";        pnpm install --frozen-lockfile
if command -v gitleaks >/dev/null 2>&1; then step "gitleaks"; gitleaks detect --no-git --config .gitleaks.toml --redact; else echo "gitleaks not installed locally; CI runs it"; fi
step "secret scan (repository patterns)";     pnpm secret-scan
step "dependency audit";                      pnpm audit --audit-level high
step "typecheck";                             pnpm typecheck
step "lint";                                  pnpm lint
step "migration validation";                  pnpm db:validate
step "tests (rls, tenancy, guards, all)";     pnpm test
step "evals (fake provider)";                 pnpm eval
step "next build";                            pnpm --filter @ros/shell build
step "end-to-end with accessibility checks";  pnpm e2e
echo; echo "ci-local: all steps passed"
