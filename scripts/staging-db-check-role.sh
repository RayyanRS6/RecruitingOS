#!/usr/bin/env bash
# Recruiting OS: read-only test of one application connection string (DATABASE_URL or WORKER_DATABASE_URL), run by
# the founder in her own Terminal app from the repository root. Paste the value from 1Password; it is read without
# echo and handed to packages/db/src/cli/check-role.ts on standard input, never as an argument, in history, on disk
# or in output. The report names only the role, the host and the outcome. Changes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/its-toolchain/node/bin" ]; then export PATH="$HOME/.local/its-toolchain/node/bin:$PATH"; fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on the PATH of this terminal."; exit 1; }
# shellcheck source=scripts/lib/db-owner-url.sh
. scripts/lib/db-owner-url.sh
echo "Recruiting OS: test an application connection string (read-only)."
echo
echo "Step 1 of 2. Paste the connection string to test, exactly as stored in 1Password (DATABASE_URL or"
echo "WORKER_DATABASE_URL), and press Return. Nothing you paste is shown, saved to history, or sent anywhere but the database:"
read -rs -p "> " VALUE
echo
if [ -z "$VALUE" ]; then echo "Nothing was pasted."; exit 1; fi
read_ca_file
echo
printf '%s' "$VALUE" | pnpm --silent --filter @ros/db exec tsx src/cli/check-role.ts
