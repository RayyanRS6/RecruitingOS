#!/usr/bin/env bash
# Recruiting OS: read-only report of the staging database, run by the founder in her own Terminal app from the
# repository root. Changes nothing. Prints which migrations are applied, whether the next one was interrupted halfway,
# whether the application roles exist and can log in, and whether Supabase Vault is present and granted. The output
# holds no connection string, password or row data, so it can be pasted back in full.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/its-toolchain/node/bin" ]; then export PATH="$HOME/.local/its-toolchain/node/bin:$PATH"; fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on the PATH of this terminal."; exit 1; }
# shellcheck source=scripts/lib/db-owner-url.sh
. "$(dirname "$0")/lib/db-owner-url.sh"
echo "Recruiting OS: staging database status (read-only)."
echo
read_owner_url || exit 1
echo
pnpm --silent db:status
