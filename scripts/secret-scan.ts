import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_VALUE_PATTERNS } from "../packages/contracts/src/security/redact";

/**
 * Repository secret scan (21 Sep, item 7): the same patterns the runtime uses to keep credentials out of logs, applied
 * to every tracked text file, plus private-key and connection-string shapes. Runs locally (`pnpm secret-scan`) and in
 * CI next to gitleaks. Known fake values are listed here so the scan stays meaningful.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".data", "dist", "results", "playwright-report", "test-results", "report", ".git", "coverage"]);
/** Value-shaped patterns only (tokens, keys, JWTs); the runtime's context rules for query strings, JSON and link paths are for logs, not source. */
const VALUE_PATTERNS = SECRET_VALUE_PATTERNS.filter((re) => !re.source.startsWith("(?:^|[?&;") && !re.source.startsWith('("(?:') && !re.source.startsWith("(?<="));
/** Test files hold fake tokens on purpose (each named "fake" or "scrub" in the value); they are scanned for keys and connection strings only. gitleaks covers them separately. */
const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const SKIP_FILES = [/pnpm-lock\.yaml$/, /\.gitleaks\.toml$/, /\.(png|jpg|jpeg|gif|webp|ico|pdf|docx|zip|woff2?)$/i];
const EXTRA: Array<{ name: string; re: RegExp }> = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "connection string with password", re: /\b(?:postgres|postgresql|redis|rediss|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s/]{4,}@/i },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Supabase service-role JWT reference", re: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']?ey/ },
];
/**
 * `[YOUR-PASSWORD]` is the Supabase dashboard's own placeholder: a connection string still holding it carries no secret.
 * `DELIBERATE-TEST-VALUE` is the fake key the observability test error carries on purpose (apps/api/src/routes/observability.ts)
 * so staging can prove the error reporter scrubs key-shaped values.
 */
const ALLOW = [/dev-only-[a-z-]+/, /fake-issuer-development-secret-not-for-prod/, /whsec-test/, /DELIBERATE-TEST-VALUE/, /example\.(com|test|invalid)/, /:(?:pass|password|CHANGE_ME|<[^>]+>|\[YOUR-PASSWORD\])@/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.size <= 1_000_000 && !SKIP_FILES.some((re) => re.test(name))) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const matches: Array<{ name: string; value: string }> = [];
    for (const e of EXTRA) { const m = line.match(e.re); if (m) matches.push({ name: e.name, value: m[0] }); }
    if (!isTest(file)) for (const re of VALUE_PATTERNS) { re.lastIndex = 0; for (const m of line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) matches.push({ name: "credential-shaped value", value: m[0] }); }
    // the allowance applies to the matched value itself, never to the whole line
    const real = matches.filter((m) => !ALLOW.some((re) => re.test(m.value)) && !ALLOW.some((re) => re.test(line.slice(Math.max(0, line.indexOf(m.value) - 40), line.indexOf(m.value) + m.value.length + 40))));
    for (const r of real) findings.push(`${relative(ROOT, file)}:${i + 1}: ${r.name}`);
  });
}
if (findings.length) {
  console.error(`secret scan: ${findings.length} finding(s)\n${findings.join("\n")}`);
  process.exit(1);
}
console.log("secret scan: clean");
