#!/usr/bin/env bash
# Recruiting OS: one-time staging database setup, run by the founder in her own Terminal app from the repository root.
#
# Asks for two things, separately: the Session pooler connection string exactly as Supabase shows it (with the
# [YOUR-PASSWORD] placeholder still in it; it holds no secret) and the database password (typed without echo). The
# password is percent-encoded and put in place of the one placeholder by packages/db/src/cli/fill-password.ts, which
# receives it on standard input: it is never on a command line, never in this shell's history, never written to disk,
# and never printed. The completed string lives only in this process and the migration and provisioning steps it runs.
# A pasted string without the placeholder, or with it more than once, stops the script before the password is asked for.
#
# Then: migrations, generated passwords for ros_app and ros_worker, the Vault grants, verification of each role, and the
# two application connection strings printed once for 1Password, Vercel and Railway.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/its-toolchain/node/bin" ]; then export PATH="$HOME/.local/its-toolchain/node/bin:$PATH"; fi
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is not on the PATH of this terminal."; exit 1; }

PLACEHOLDER='[YOUR-PASSWORD]'
echo "Recruiting OS: staging database setup."
echo
echo "Step 1 of 2. In Supabase open the project, Connect, Session pooler, and copy the connection string exactly as"
echo "shown, with ${PLACEHOLDER} still in it. Do not fill the password in. Paste it here (it holds no secret):"
read -r -p "> " URI
URI="${URI#"${URI%%[![:space:]]*}"}"
URI="${URI%"${URI##*[![:space:]]}"}"
case "$URI" in
  postgres://*|postgresql://*) ;;
  *) echo "That does not look like a Postgres connection string (it must start with postgresql://)."; exit 1 ;;
esac
STRIPPED="${URI//"$PLACEHOLDER"/}"
COUNT=$(( (${#URI} - ${#STRIPPED}) / ${#PLACEHOLDER} ))
if [ "$COUNT" -ne 1 ]; then
  echo "The connection string must contain ${PLACEHOLDER} exactly once (found ${COUNT}). Copy it again from Supabase without filling in the password."
  exit 1
fi

echo
echo "Step 2 of 2. Type the database password from the Recruiting OS Staging vault and press Return."
echo "Nothing you type is shown, saved to history, written to disk, or sent anywhere but the database:"
read -rs -p "> " PASSWORD
echo
if [ -z "$PASSWORD" ]; then echo "The password was empty."; exit 1; fi

# printf is a shell builtin, so the password goes straight down the pipe and never appears as a process argument.
if ! OWNER="$(printf '%s' "$PASSWORD" | ROS_OWNER_URI="$URI" pnpm --silent --filter @ros/db exec tsx src/cli/fill-password.ts)"; then
  echo "The connection string could not be completed. Nothing was changed."
  exit 1
fi
unset PASSWORD

gen() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40; }
export MIGRATE_DATABASE_URL="$OWNER" ROS_APP_PASSWORD="$(gen)" ROS_WORKER_PASSWORD="$(gen)"
unset OWNER
echo
echo "1/3 applying migrations"
pnpm --silent db:migrate
echo "2/3 application roles, vault grants, verification"
pnpm --silent --filter @ros/db provision
echo "3/3 done"
