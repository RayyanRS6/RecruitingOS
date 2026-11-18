import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

/**
 * Synthetic application load.
 * Posts N made-up applications to one job's apply address at a steady rate, exactly as the form does (the
 * acknowledgment, an answer to every question on the form, a small text resume, unique addresses), honours a 429 by
 * waiting for the Retry-After the server names (capped by --max-wait), and prints what happened: accepted, refused by
 * the rate limit, refused otherwise, server errors, and the latency percentiles. Nothing here is a real person and
 * nothing is read back but the status codes.
 *
 *   tsx scripts/load-apply.ts --url http://localhost:3010/careers/<slug>/jobs/<roleId>/apply --count 200 --per-minute 5
 *
 * A host other than localhost must be named again with --confirm-host <host>, so the script cannot be pointed at a
 * production address by a slip of the hand. Run it only against a local server or staging, never production.
 */
export type LoadOptions = {
  url: string;
  count: number;
  perMinute: number;
  emailDomain: string;
  maxWaitSeconds: number;
  timeoutMs: number;
  json: boolean;
  confirmHost: string | null;
  /** Injected by the test; the real fetch otherwise. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export type LoadSummary = {
  url: string;
  runId: string;
  requested: number;
  accepted: number;
  rateLimited: number;
  refused: number;
  serverErrors: number;
  errors: number;
  elapsedSeconds: number;
  targetPerMinute: number;
  achievedPerMinute: number;
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  firstRateLimitAtRequest: number | null;
  retryAfterSeconds: { min: number; max: number } | null;
  waitedSeconds: number;
  statuses: Record<string, number>;
  refusals: string[];
};

const FIRST_NAMES = ["Maria", "Luis", "Ana", "Ben", "Chloe", "Dana", "Elena", "Femi", "Grace", "Hugo", "Iris", "Jonas", "Keiko", "Leo", "Mira", "Noor", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Victor", "Wren", "Yara", "Zoe"];
const LAST_NAMES = ["Reyes", "Ortega", "Silva", "Okafor", "Nguyen", "Whitfield", "Kim", "Patel", "Lee", "Rivera", "Chen", "Haddad", "Moreau", "Novak", "Osei", "Quintero", "Sato", "Torres", "Varga", "Walsh"];

/** Names from a fixed list, in order, so every run is the same set of made-up people. */
export function syntheticApplicant(runId: string, i: number, emailDomain: string) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
  return {
    firstName: first,
    lastName: last,
    email: `load-${runId}-${String(i + 1).padStart(4, "0")}@${emailDomain}`,
    resume: `${first} ${last}\nRegistered Dental Hygienist at Harbor Point Dental 2019 - present\nDental Hygienist at Coastal Family Dentistry 2015 - 2019\nRDH license CA active\nBLS current\nSkills: Dentrix, periodontal charting, digital radiography\n(synthetic load-test applicant ${runId}, not a real person)`,
  };
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1].replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
};

/**
 * What the apply page asks, and an answer to each of its questions: the first choice a question offers ("yes" for a yes
 * or no question), or for a number its smallest allowed value (1 when it names none). `formOpened`: the sealed moment
 * the page was opened, which the form sends back.
 */
export function readApplyForm(html: string): { answers: Array<{ field: string; value: string }>; formOpened: string } {
  const answers = new Map<string, string>();
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const field = attr(m[0], "name");
    if (!field?.startsWith("q_") || answers.has(field)) continue;
    const type = attr(m[0], "type");
    if (type === "radio") answers.set(field, attr(m[0], "value") ?? "");
    else if (type === "number") answers.set(field, attr(m[0], "min") ?? "1");
  }
  const opened = html.match(/<input\b[^>]*\bname="formOpened"[^>]*>/)?.[0];
  return { answers: [...answers.entries()].map(([field, value]) => ({ field, value })), formOpened: opened ? attr(opened, "value") ?? "" : "" };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runLoad(opts: LoadOptions): Promise<LoadSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => { if (!opts.json) console.log(line); });
  const target = new URL(opts.url);
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(target.hostname) || target.hostname.endsWith(".localhost");
  if (!local && opts.confirmHost !== target.hostname) throw new Error(`refusing to run against ${target.hostname}: name it again with --confirm-host ${target.hostname} (never a production address)`);
  if (!/\/careers\/[^/]+\/jobs\/[^/]+\/apply$/.test(target.pathname)) throw new Error(`--url must be a job's apply address (/careers/<slug>/jobs/<roleId>/apply), not ${target.pathname}`);
  // A rate of zero would mean one request and then a silent wait forever; it is refused here as well as in parseArgs.
  if (!(opts.perMinute > 0)) throw new Error(`the rate must be more than 0 applications a minute, got ${opts.perMinute}`);
  const runId = randomBytes(3).toString("hex");

  const page = await fetchImpl(target, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(opts.timeoutMs) });
  if (page.status === 404) throw new Error("the apply page answers 404: the role is not open or not accepting applications");
  if (!page.ok) throw new Error(`the apply page answered ${page.status}`);
  const form = readApplyForm(await page.text());
  log(`run ${runId}: ${opts.count} applications to ${target.pathname} at ${opts.perMinute} a minute; ${form.answers.length} question${form.answers.length === 1 ? "" : "s"} on the form; a 429 pauses up to ${opts.maxWaitSeconds}s`);

  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const refusals: string[] = [];
  const retryAfters: number[] = [];
  let accepted = 0;
  let rateLimited = 0;
  let refused = 0;
  let serverErrors = 0;
  let errors = 0;
  let waitedMs = 0;
  let firstRateLimitAtRequest: number | null = null;
  const interval = 60_000 / opts.perMinute;
  const started = performance.now();

  for (let i = 0; i < opts.count; i++) {
    const due = started + i * interval;
    const now = performance.now();
    if (due > now) await sleep(due - now);
    const person = syntheticApplicant(runId, i, opts.emailDomain);
    const fd = new FormData();
    fd.set("firstName", person.firstName);
    fd.set("lastName", person.lastName);
    fd.set("email", person.email);
    fd.set("resume", new File([person.resume], "resume.txt", { type: "text/plain" }));
    for (const q of form.answers) fd.set(q.field, q.value);
    if (form.formOpened) fd.set("formOpened", form.formOpened);
    fd.set("acknowledged", "yes");
    const t0 = performance.now();
    let status = 0;
    try {
      const r = await fetchImpl(target, { method: "POST", body: fd, redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(opts.timeoutMs) });
      status = r.status;
      const ms = performance.now() - t0;
      statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
      // an accepted application ends on the receipt page: the status link only ever travels by email
      if (status === 302 && (r.headers.get("location") ?? "").endsWith("/applied")) {
        accepted++;
        latencies.push(ms);
      } else if (status === 429) {
        rateLimited++;
        firstRateLimitAtRequest ??= i + 1;
        const retryAfter = Number(r.headers.get("retry-after") ?? "0");
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfters.push(retryAfter);
        const wait = Math.min(Math.max(0, retryAfter), opts.maxWaitSeconds) * 1000;
        log(`#${i + 1} refused by the rate limit (Retry-After ${retryAfter}s); pausing ${Math.round(wait / 1000)}s`);
        if (wait > 0) { await sleep(wait); waitedMs += wait; }
      } else if (status >= 500) {
        serverErrors++;
        refusals.push(`#${i + 1}: ${status}`);
        log(`#${i + 1} server error ${status}`);
      } else {
        refused++;
        const text = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const why = text.match(/(Please [^.]+\.|One more step[^.]+\.|Resume files [^.]+\.)/)?.[1] ?? text.slice(0, 120);
        refusals.push(`#${i + 1}: ${status} ${why}`);
        log(`#${i + 1} refused (${status}): ${why}`);
      }
    } catch (err) {
      errors++;
      refusals.push(`#${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      log(`#${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 25 === 0) log(`${i + 1} sent: ${accepted} accepted, ${rateLimited} rate-limited, ${refused} refused, ${serverErrors} server errors, ${errors} errors`);
  }

  const elapsed = (performance.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const summary: LoadSummary = {
    url: target.toString(),
    runId,
    requested: opts.count,
    accepted,
    rateLimited,
    refused,
    serverErrors,
    errors,
    elapsedSeconds: Math.round(elapsed * 10) / 10,
    targetPerMinute: opts.perMinute,
    achievedPerMinute: elapsed > 0 ? Math.round((opts.count / elapsed) * 600) / 10 : 0,
    latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: Math.round(sorted.at(-1) ?? 0), samples: sorted.length },
    firstRateLimitAtRequest,
    retryAfterSeconds: retryAfters.length ? { min: Math.min(...retryAfters), max: Math.max(...retryAfters) } : null,
    waitedSeconds: Math.round(waitedMs / 100) / 10,
    statuses,
    refusals: refusals.slice(0, 50),
  };
  return summary;
}

export function describeSummary(s: LoadSummary): string {
  return [
    `Load run ${s.runId}: ${s.requested} applications to ${s.url}`,
    `  accepted ${s.accepted}, refused by the rate limit ${s.rateLimited}${s.firstRateLimitAtRequest ? ` (first at #${s.firstRateLimitAtRequest}; Retry-After ${s.retryAfterSeconds?.min}s to ${s.retryAfterSeconds?.max}s)` : ""}, refused otherwise ${s.refused}, server errors ${s.serverErrors}, failed requests ${s.errors}`,
    `  ${s.elapsedSeconds}s elapsed (target ${s.targetPerMinute} a minute, achieved ${s.achievedPerMinute}; paused ${s.waitedSeconds}s for the rate limit)`,
    `  latency of accepted applications: p50 ${s.latencyMs.p50} ms, p95 ${s.latencyMs.p95} ms, max ${s.latencyMs.max} ms (${s.latencyMs.samples} samples)`,
    `  status codes: ${Object.entries(s.statuses).map(([k, v]) => `${k} x${v}`).join(", ") || "none"}`,
    ...(s.refusals.length ? ["  refusals and errors:", ...s.refusals.map((r) => `    ${r}`)] : []),
  ].join("\n");
}

export function parseArgs(argv: string[]): LoadOptions {
  const get = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string, fallback: number): number => { const v = get(name); if (v === undefined) return fallback; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number, got ${v}`); return n; };
  const url = get("url");
  if (!url) throw new Error("usage: tsx scripts/load-apply.ts --url <apply address> [--count 200] [--per-minute 5] [--email-domain blackhole.postmarkapp.com] [--max-wait 60] [--timeout-ms 30000] [--confirm-host <host>] [--json]");
  const perMinute = num("per-minute", 5);
  if (perMinute <= 0) throw new Error(`--per-minute must be greater than 0, got ${perMinute}`);
  return {
    url,
    count: Math.max(1, Math.floor(num("count", 200))),
    perMinute,
    // Postmark's blackhole domain accepts and discards mail, so a staging run sends real acknowledgments nowhere.
    emailDomain: get("email-domain") ?? "blackhole.postmarkapp.com",
    maxWaitSeconds: num("max-wait", 60),
    timeoutMs: num("timeout-ms", 30_000),
    json: argv.includes("--json"),
    confirmHost: get("confirm-host") ?? null,
  };
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && /load-apply\.(ts|js|mjs)$/.test(process.argv[1]); } catch { return false; }
})();
if (invokedDirectly) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const summary = await runLoad(opts);
    if (opts.json) console.log(JSON.stringify(summary));
    else console.log(describeSummary(summary));
    process.exit(summary.serverErrors || summary.errors ? 1 : 0);
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
