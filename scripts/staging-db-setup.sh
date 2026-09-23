#!/usr/bin/env bash
# Recruiting OS: staging database setup, run by the founder in her own Terminal app from the repository root.
#
# Safe to run again after an interruption (founder request, 22 Sep 2026): migrations already applied are skipped, a
# migration that an earlier run left half-applied is completed, the application role passwords are set afresh, the
# Vault grants are re-applied, and every role is verified. Running it again replaces the application passwords, so a
# DATABASE_URL or WORKER_DATABASE_URL entered earlier into Vercel or Railway must be replaced with the new values.
#
# Modes:  bash scripts/staging-db-setup.sh          full setup (default); also the way to rotate the passwords
#         bash scripts/staging-db-setup.sh grants   Vault grants and checks only, after enabling Supabase Vault;
#                                                   passwords and connection strings are left alone
#         bash scripts/staging-db-status.sh         read-only report of where things stand
#
# The two connection strings are never printed on a Mac: each goes to the clipboard in turn for 1Password and the
# clipboard is cleared afterwards. Add --print to show them once instead (not recommended).
#
# Asks for two things, separately: the Session pooler connection string exactly as Supabase shows it (with the
# [YOUR-PASSWORD] placeholder still in it; it holds no secret) and the database password (typed without echo). The
# password is percent-encoded and put in place of the one placeholder by packages/db/src/cli/fill-password.ts, which
# receives it on standard input: never on a command line, never in this shell's history, never written to disk, and
# never printed. The completed string lives only in this process and the steps it runs.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/its-toolchain/node/bin" ]; then export PATH="$HOME/.local/its-toolchain/node/bin:$PATH"; fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on the PATH of this terminal."; exit 1; }
MODE="full"; DELIVERY="print"
command -v pbcopy >/dev/null 2>&1 && DELIVERY="clipboard"
for arg in "$@"; do
  case "$arg" in
    full|grants) MODE="$arg" ;;
    --print) DELIVERY="print" ;;
    *) echo "Usage: bash scripts/staging-db-setup.sh [full|grants] [--print]"; exit 1 ;;
  esac
done
export ROS_PROVISION_DELIVERY="$DELIVERY"
# shellcheck source=scripts/lib/db-owner-url.sh
. scripts/lib/db-owner-url.sh
echo "Recruiting OS: staging database setup (${MODE} mode). Safe to run again; every full run sets fresh passwords."
[ "$MODE" = "full" ] && { [ "$DELIVERY" = "clipboard" ] && echo "The new connection strings will go to the clipboard for 1Password, one at a time, never shown." || echo "The new connection strings will be shown once (--print)."; }
echo
read_owner_url || exit 1
echo

if [ "$MODE" = "grants" ]; then
  echo "1/1 Vault grants and checks (passwords and connection strings unchanged)"
  ROS_PROVISION_MODE=grants pnpm --silent --filter @ros/db provision
  exit $?
fi

gen() { local s; s="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 || true)"; [ "${#s}" -eq 40 ] || { echo 'could not generate a password'; exit 1; }; printf '%s' "$s"; }
export ROS_APP_PASSWORD="$(gen)" ROS_WORKER_PASSWORD="$(gen)"
echo "1/3 applying migrations (already-applied ones are skipped; an interrupted one is completed)"
if ! pnpm --silent db:migrate; then
  echo
  echo "The migrations stopped (see the line above for the file, the statement and the code). Nothing from the failed"
  echo "migration was kept. Run: bash scripts/staging-db-status.sh for a read-only report, then run this script again."
  exit 1
fi
echo "2/3 application roles, Vault grants, verification"
if ! pnpm --silent --filter @ros/db provision; then
  echo
  echo "Provisioning stopped (see the lines above). Run: bash scripts/staging-db-status.sh for a read-only report, then"
  echo "run this script again; it is safe to repeat."
  exit 1
fi
echo "3/3 done"
