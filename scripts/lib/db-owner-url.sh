# Shared by scripts/staging-db-setup.sh and scripts/staging-db-status.sh. Sourced, not executed.
# Asks for the Session pooler connection string with its [YOUR-PASSWORD] placeholder (no secret) and, separately and
# without echo, for the database password; completes the string with the password percent-encoded by
# packages/db/src/cli/fill-password.ts, which receives the password on standard input, never as an argument, in
# history, on disk or in output. Exports MIGRATE_DATABASE_URL for this process only.
read_owner_url() {
  local PLACEHOLDER='[YOUR-PASSWORD]' URI STRIPPED COUNT PASSWORD OWNER
  echo "Step 1 of 2. In Supabase open the project, Connect, Session pooler, and copy the connection string exactly as"
  echo "shown, with ${PLACEHOLDER} still in it. Do not fill the password in. Paste it here (it holds no secret):"
  read -r -p "> " URI
  URI="${URI#"${URI%%[![:space:]]*}"}"
  URI="${URI%"${URI##*[![:space:]]}"}"
  case "$URI" in
    postgres://*|postgresql://*) ;;
    *) echo "That does not look like a Postgres connection string (it must start with postgresql://)."; return 1 ;;
  esac
  STRIPPED="${URI//"$PLACEHOLDER"/}"
  COUNT=$(( (${#URI} - ${#STRIPPED}) / ${#PLACEHOLDER} ))
  if [ "$COUNT" -ne 1 ]; then
    echo "The connection string must contain ${PLACEHOLDER} exactly once (found ${COUNT}). Copy it again from Supabase without filling in the password."
    return 1
  fi
  echo
  echo "Step 2 of 2. Type the database password from the Recruiting OS Staging vault and press Return."
  echo "Nothing you type is shown, saved to history, written to disk, or sent anywhere but the database:"
  read -rs -p "> " PASSWORD
  echo
  if [ -z "$PASSWORD" ]; then echo "The password was empty."; return 1; fi
  # printf is a shell builtin, so the password goes straight down the pipe and never appears as a process argument.
  if ! OWNER="$(printf '%s' "$PASSWORD" | ROS_OWNER_URI="$URI" pnpm --silent --filter @ros/db exec tsx src/cli/fill-password.ts)"; then
    echo "The connection string could not be completed. Nothing was changed."
    return 1
  fi
  unset PASSWORD
  export MIGRATE_DATABASE_URL="$OWNER"
  unset OWNER
  read_ca_file
}

# Supabase signs its database and pooler certificates with its own authority, which this computer does not trust by
# itself. Verification stays on (sslmode=verify-full); the authority's certificate is downloaded once from the
# dashboard and its path given here. It holds no secret. A file named prod-ca-2021.crt in Downloads is offered.
read_ca_file() {
  local DEFAULT="" CA
  if [ -n "${DATABASE_SSL_CA_FILE:-}" ] && [ -f "$DATABASE_SSL_CA_FILE" ]; then echo "TLS: using the certificate at DATABASE_SSL_CA_FILE."; return 0; fi
  local DIRS="${ROS_CA_SEARCH_DIRS:-$HOME/Downloads:$HOME/Desktop}" d
  local OLDIFS="$IFS"; IFS=':'
  for d in $DIRS; do for f in "$d/prod-ca-2021.crt" "$d/prod-supabase.cer"; do if [ -z "$DEFAULT" ] && [ -f "$f" ]; then DEFAULT="$f"; fi; done; done
  IFS="$OLDIFS"
  echo
  echo "Step 3 of 3 (TLS). Supabase signs its database certificates with its own authority, which this computer does not"
  echo "trust by itself. Download it once: Supabase, Project Settings, Database, SSL Configuration, Download certificate"
  echo "(a file named prod-ca-2021.crt). Then give its path here. The certificate is public; it is not a secret."
  if [ -n "$DEFAULT" ]; then read -r -p "Path to the certificate [${DEFAULT}]: " CA; CA="${CA:-$DEFAULT}"; else read -r -p "Path to the certificate (press Return to continue without it): " CA; fi
  CA="${CA#"${CA%%[![:space:]]*}"}"; CA="${CA%"${CA##*[![:space:]]}"}"
  CA="${CA/#\~/$HOME}"
  if [ -z "$CA" ]; then echo "TLS: continuing without the certificate; a connection to Supabase will be refused with a certificate error until it is given."; return 0; fi
  if [ ! -f "$CA" ]; then echo "TLS: no file at ${CA}."; return 1; fi
  if ! grep -q "BEGIN CERTIFICATE" "$CA"; then echo "TLS: ${CA} is not a certificate file."; return 1; fi
  export DATABASE_SSL_CA_FILE="$CA"
  echo "TLS: verifying against ${CA}."
}
