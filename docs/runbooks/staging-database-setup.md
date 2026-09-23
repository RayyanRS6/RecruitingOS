# Staging database setup: what each step does, what an interruption leaves, how to resume

Status: revised 22 September 2026 after the founder's first run of `scripts/staging-db-setup.sh` exited with code 1
(error text not received). Every step is now safe to repeat, and a read-only report shows where things stand. Nothing
here drops, resets or deletes anything in the staging database.

## The two commands

| Command | Changes the database? | Use it when |
|---|---|---|
| `bash scripts/staging-db-status.sh` | no | you want to know what is applied, what is pending, and what the next run will do; its output holds no secret and can be pasted back in full |
| `bash scripts/staging-db-setup.sh` | yes | first setup, or a rerun after an interruption; safe to repeat |
| `bash scripts/staging-db-setup.sh grants` | yes (grants only) | after enabling Supabase Vault, when the setup reported the Vault grants as skipped |

Both ask for the Session pooler connection string with `[YOUR-PASSWORD]` still in it, then for the password without
echo (`docs/spec/13` §9, PR 9), then for the path to the Supabase CA certificate (below). The completed string lives
only in that process.

## TLS: why the first run most likely failed, and the certificate

Supabase signs its database and pooler certificates with its own authority ("Supabase Root 2021 CA"), not one that
computers trust by themselves. Checked on 22 Sep from the team's machine with no credentials: the pooler at
`aws-0-us-west-2.pooler.supabase.com` presents a chain ending in that root, and Node.js refuses it with
`SELF_SIGNED_CERT_IN_CHAIN` unless the certificate is supplied. The provisioning step insists on `sslmode=verify-full`
(right), but nothing supplied the certificate, so the first query of step 2 was refused before any SQL ran. The
migration step, by contrast, connected without TLS at all (the pasted string carries no `sslmode`), which is why it
most likely completed; that gap is closed too: every owner connection now verifies.

What to do once: Supabase, Project Settings, Database, SSL Configuration, **Download certificate** (a file named
`prod-ca-2021.crt`; it is public, not a secret). Both scripts offer the file if it sits in Downloads or on the Desktop,
or take a path. Verification is never switched off. The status report prints the fingerprint of the certificate you
gave and the fingerprint of the root the server presented, and says whether they match.

The hosted environments need the same trust: alongside `DATABASE_URL` in Vercel and `WORKER_DATABASE_URL` in Railway,
enter `DATABASE_SSL_CA` (not sensitive) with the certificate's text. `DATABASE_SSL_CA_FILE` is the path form for a
person's machine.

One driver detail, found on the founder's second run (22 Sep): node-postgres parses the connection string after the
explicit options and lets the parsed values win, so an `sslmode` in the string turned the certificate we passed into
an empty `ssl` object, and verification ran against the operating system's store again. The client now strips
`sslmode` (and `sslrootcert`, whose file it reads instead) from the string whenever it holds a certificate, and hands
the driver one trust object: the certificate, full verification, host name checked. Proven through the exact
`bash scripts/staging-db-status.sh` path against the staging pooler with a deliberately wrong password: with the
certificate the server answers "password authentication failed" (TLS verified, then refused at the password);
without it, the certificate refusal. Every way of weakening TLS in the string is refused outright, certificate or
not: `sslmode=disable` or `no-verify`, the driver's own `ssl=0`, `ssl=false` or `ssl=no-verify`, and `uselibpqcompat`.
A certificate given explicitly (`DATABASE_SSL_CA_FILE` or `DATABASE_SSL_CA`) wins over an `sslrootcert` in the string,
and two different certificates are refused. A pasted certificate is normalised first (Windows line endings, a trailing
newline, or a hosted environment's one-line field with literal `\n`), then parsed; a value the TLS layer would have
silently ignored is refused with a clear message. The proof ran four ways through the exact command path: with the
certificate (password refused, so TLS verified), with the certificate as one-line text in `DATABASE_SSL_CA` (the
hosted shape; same), with a string carrying `ssl=no-verify` (refused before connecting), and without a certificate
(certificate refusal).

## What the setup does, step by step, and what an interruption leaves behind

| Step | What it does | If it fails here | Rerun |
|---|---|---|---|
| 0. complete the string | percent-encodes the password into the placeholder | nothing was sent to the database | just run again |
| 1. migrations | applies each `packages/db/migrations/*.sql` not yet in `_migrations`, **each file in one transaction together with its ledger row** | the failing file is rolled back whole; the report names the file, the statement number and the Postgres code | skipped files stay skipped; the failed file is applied again |
| 1a. the first pending migration | applied with "already exists" statements skipped and counted (a file the old, non-transactional runner left half-applied) | as above | the rerun completes it and records it; the report says how many statements were already there |
| 2. roles present | checks `ros_app`, `ros_worker`, `app_tenant` exist (migration 0003 creates them) | nothing changed | run again after step 1 succeeds |
| 3. passwords | `ALTER ROLE … LOGIN PASSWORD` with fresh random passwords, in one transaction with the Vault grants | nothing changed | always sets both afresh; any `DATABASE_URL` already entered elsewhere must be replaced |
| 4. Vault grants | the grants in `packages/db/scripts/vault-grants.sql` (the EXECUTE grants resolve Vault's real function signatures at run time); skipped with a clear line when the `vault` schema is absent | nothing changed (same transaction as step 3) | reapplied; or `grants` mode after enabling Vault |
| 5. verification | connects as each role through the same Session pooler host and port the application will use, checks not superuser, no RLS bypass, `ros_app` can enter `app_tenant`; retries for up to 30 seconds while the pooler picks up the new password | reported as `verified: <role>: FAILED: <plain diagnosis>`; passwords and grants stay | run again after fixing the cause |
| 6. print | the two connection strings, once | | printed again on the rerun, with the new passwords |

Before this revision, step 1 ran statement by statement with no transaction and recorded a file only after its last
statement, so a failure mid-file left earlier statements applied and the file unrecorded, and a rerun failed on
"already exists". That is exactly the case step 1a now repairs.

## Reading a failure

Every error is reported as a short diagnosis with the driver's code and what to do, never with the connection string
or the password. The kinds:

| Diagnosis says | Meaning | What to do |
|---|---|---|
| this computer does not trust the database server's certificate | TLS verification (`sslmode=verify-full`, the default the tools add) failed | download the CA certificate from Supabase (Project Settings, Database, SSL certificate) and run again with `DATABASE_SSL_CA_FILE=/path/to/the.crt` in front of the command, or add `sslrootcert=/path/to/the.crt` to the pasted string. Never switch verification off. |
| the database refused the user name or password | wrong password or user | check the vault; the pooler user is `postgres.<project-ref>` |
| the connection pooler does not recognise this user | Supavisor did not find `<role>.<project-ref>` | the role must exist with LOGIN (setup full mode sets it); check the project reference |
| the database host could not be reached | network, or the project is paused | check the host and port, the network, the project state |
| the connected user lacks a privilege | not the owner | use the owner's pooler string |
| the pooler has no free connection | pooler saturated | wait a minute, close other clients |
| migration X failed at statement N of M (code) | a statement Postgres refused; the file was rolled back | paste the line back; nothing sensitive is in it |

## Two decisions recorded here

- **The application connects through the Session pooler (port 5432), not the transaction pooler (6543).** The
  application sets `app.platform` once per connection and the boot check reads it back; transaction pooling does not
  keep per-connection state, so the check could fail at random and platform reads could run without it. Session mode
  keeps it. The cost is one server connection per pooled client; the pool size is bounded by `DATABASE_POOL_MAX`
  (default 5). Moving to transaction mode needs every platform read to run inside `withPlatform` first; recorded in
  the register as a follow-up.
- **Supabase's Data API roles are locked out of the schema.** On Supabase every table created in `public` is granted
  to `anon`, `authenticated` and `service_role` by the project's default privileges, so the platform tables (which
  have no row-level security because only the application role reaches them) would be readable through the Data API
  with the publishable key. Migration `0017_supabase_api_roles.sql` revokes those privileges and the defaults (a no-op
  where the roles do not exist). The status report shows the three roles' remaining access. Founder action after the
  setup: Supabase, Project Settings, Data API, remove `public` from the exposed schemas (the application never uses
  the Data API).

## How the two connection strings reach 1Password (never the screen)

On a Mac the setup no longer prints the strings. After verification it places each one on the clipboard in turn,
tells you which 1Password field to paste it into (item "Recruiting OS staging database", vault Recruiting OS
Staging, fields `DATABASE_URL` and `WORKER_DATABASE_URL`), and waits until you type `pasted` and press Return: a bare
Return, or keystrokes typed before the prompt appeared, do not count. The clipboard is cleared at the end, after ten
minutes without confirmation, when the input closes, when the copy fails, and when the process is interrupted (Ctrl-C
or the window closing: a signal handler clears it before exit). Nothing is written to the terminal, a log or a file,
so there is nothing to photograph or copy by mistake. `--print` shows them once instead; not recommended. Two things
the script cannot control: if Universal Clipboard is on, a value also reaches your other Apple devices' clipboards
until it is cleared; and a clipboard-history app (Raycast, Alfred, Paste, Maccy) records every clipboard change, so
pause it first and clear its history afterwards.

## Rotating the application passwords after an exposure

Every full run is a rotation: `ALTER ROLE … PASSWORD` gives `ros_app` and `ros_worker` fresh random passwords, every
session those roles had is ended where the owner may end them (the report says how many of how many; if the server
refuses, it says so and the run continues), the old strings stop working at once (the pooler may honour them for a
few more seconds), and the new strings are delivered as above. Nothing is reset or deleted. So, after an exposure:

1. Run `bash scripts/staging-db-setup.sh` (full mode). Paste each new string into 1Password when asked.
2. Replace the strings anywhere the old ones had been entered (nothing, on 22 Sep).
3. `bash scripts/staging-db-status.sh` afterwards lists the application roles' sessions. Idle pooler connections left
   by the verification step are normal for a few minutes; active sessions while the application is not running are
   not, and are worth a look.

The owner's own password is a separate credential (the one you type at the prompt). It is not printed or delivered by
these scripts; if it were ever exposed, reset it in Supabase (Project Settings, Database, Reset database password) and
update the vault.

## When a host refuses an application string (28P01 "password authentication failed")

Three copies of each application string exist: the one the setup delivered to 1Password, and the ones entered into
Vercel (`DATABASE_URL`) and Railway (`WORKER_DATABASE_URL`). Find the wrong copy before rotating:

```bash
bash scripts/staging-db-check-role.sh
```

Paste the value from 1Password (hidden), give the certificate, and read one line: "this string works" means 1Password
is right and the copy on the host differs (re-paste it there, sealed, and deploy again); "FAILED: the database
refused the user name or password" means the 1Password value itself is stale (for example the field kept the value
from an earlier run), and the only way to a working pair is `bash scripts/staging-db-setup.sh` again: it sets fresh
passwords for both roles and delivers both strings; then replace both host copies. Nothing else resets or reveals a
password.

## After a successful run

The two strings are in 1Password (Recruiting OS Staging). Enter `DATABASE_URL` into Vercel (Preview environment,
sensitive) and `WORKER_DATABASE_URL` into Railway (sealed), each with `DATABASE_SSL_CA` beside it. Paste back only the
`provision:` and `verified:` lines and the status report.
If the Vault grants were skipped, enable Supabase Vault (Dashboard, Database, Extensions, `supabase_vault`) and run
`bash scripts/staging-db-setup.sh grants`; the `status` command confirms the grants afterwards.

## Tests

`packages/db/src/migrate.test.ts` (atomic files, repair of an interrupted file, strictness for later files, non-duplicate
errors never skipped, status report, the real migrations on a fresh database), `packages/db/src/provisioning.test.ts`
(role string derivation, TLS default, Vault grant statements, the diagnosis of every error kind with no secret in it),
`packages/db/src/connection-string.test.ts` (the two prompts' encoding). Both scripts were exercised under macOS
`/bin/bash` 3.2 with a stand-in for the database steps: full mode, grants mode, an unknown mode, a failing migration,
a failing provision, and the refusals.
