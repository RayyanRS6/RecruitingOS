#!/usr/bin/env bash
# Recruiting OS: one-time staging database setup, run by the founder in her own Terminal app from the repository root.
# Applies the migrations, sets the application role passwords, applies the Vault grants, verifies each role, and prints
# the two connection strings once. The owner connection string is read without echo and lives only in this process.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/its-toolchain/node/bin" ]; then export PATH="$HOME/.local/its-toolchain/node/bin:$PATH"; fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on the PATH of this terminal."; exit 1; }
echo "Recruiting OS: staging database setup."
echo "In Supabase open the project, Connect, Session pooler, and copy the connection string with the database password filled in."
echo "Paste it below. Nothing you type is shown, saved to history, or sent anywhere but the database."
read -rs -p "> " OWNER; echo
case "$OWNER" in postgres://*|postgresql://*) ;; *) echo "That does not look like a Postgres connection string."; exit 1;; esac
gen() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40; }
export MIGRATE_DATABASE_URL="$OWNER" ROS_APP_PASSWORD="$(gen)" ROS_WORKER_PASSWORD="$(gen)"
echo "1/3 applying migrations"
pnpm --silent db:migrate
echo "2/3 application roles, vault grants, verification"
pnpm --silent --filter @ros/db provision
echo "3/3 done"
