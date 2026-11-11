import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The wall of the plans of 5 November 2026, Rule 3, is only as good as the places that read a person. The canary sweep
 * (apps/api/src/candidate-lock.test.ts) reads every route's answer. These two hold the line in the source, where a machine can
 * see a new reader before anyone runs anything.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of ["apps/api/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"]) {
    for await (const file of glob(pattern, { cwd: ROOT })) {
      const path = file.split("\\").join("/");
      if (path.includes("node_modules") || /\.test\.tsx?$/.test(path)) continue;
      out.push(path);
    }
  }
  return out.sort();
}

const READS_A_PERSON = /\b(?:from|leftJoin|innerJoin|rightJoin|fullJoin)\(candidates\b/g;

/**
 * Who reads the `candidates` table, per file, as of Rule 3. Lower is fine; higher needs a line here saying why that read cannot
 * reach the team, or which filter it goes through (`visibleTo`, `notLocked`, `hiddenAmong`, or the path guard).
 */
const CANDIDATE_READERS: Record<string, number> = {
  // Behind the path guard (middleware/candidate-lock.ts): only ever reached with an application the reader may read.
  "apps/api/src/services/application-actions.ts": 1,
  "apps/api/src/services/interview-create.ts": 1,
  "apps/api/src/services/interview-cancel.ts": 1,
  "apps/api/src/services/interviewer-view.ts": 2,
  "apps/api/src/services/messages.ts": 1,
  "apps/api/src/services/screens.ts": 1,
  // Lists and body ids, each filtered in its query: `visibleTo` or `notLocked` beside the read of applications that names the people.
  "apps/api/src/routes/compare.ts": 1,
  "apps/api/src/routes/interviews.ts": 4,
  "apps/api/src/routes/roles.ts": 2,
  "apps/api/src/services/brief.ts": 8,
  // Home's "emails to candidates did not arrive": `notLocked` in the query that names them.
  "apps/api/src/services/email-health.ts": 1,
  // The backups (`notLocked`), and the name of the person hired on the backups card and on "Close this job?" (never someone locked).
  "apps/api/src/services/hire-sheet.ts": 3,
  "apps/api/src/services/new-times.ts": 2,
  "apps/api/src/services/pool.ts": 1,
  "apps/api/src/services/role-report.ts": 2,
  // `/escalations/mine`: only the applications `hiddenAmong` left in.
  "apps/api/src/routes/approvals-escalations-events.ts": 1,
  // The console and privacy requests: ITS is not the paying customer (Rule 3, item 6).
  "apps/api/src/routes/privacy-requests.ts": 3,
  "packages/core/src/privacy-requests.ts": 6,
  // A candidate's own pages behind their own token, and their own replies, texts and opt-outs: they read themselves.
  "apps/api/src/pages/application-record.tsx": 6,
  "apps/api/src/pages/candidate-shared.tsx": 1,
  "apps/api/src/pages/privacy-request.tsx": 1,
  "apps/api/src/pages/schedule.tsx": 1,
  "apps/api/src/services/applications.ts": 6,
  "apps/api/src/services/apply-conversation.ts": 1,
  "apps/api/src/services/email-subscriptions.ts": 1,
  "apps/api/src/services/profile-facts.ts": 4,
  "apps/api/src/services/replies.ts": 3,
  "apps/api/src/services/talent-pool.ts": 3,
  "apps/api/src/webhooks/twilio.ts": 1,
  // Its consent check reads them to write to them; the notice that an email did not arrive names them through `notify`'s `about`.
  "packages/agents/src/outbox.ts": 2,
  // What a test does for itself.
  "apps/api/src/test-helpers.ts": 1,
  // Workflows and the daily job: they read a person to write to them. What they say to the team goes through `notify`'s `about`, or names only `notLocked` people.
  "packages/agents/src/decision-messages.ts": 5,
  "packages/agents/src/email-failures.ts": 3,
  "packages/agents/src/orchestrator.ts": 3,
  "packages/agents/src/screening.ts": 1,
  "packages/core/src/escalations.ts": 1,
  "packages/core/src/interview-followups.ts": 1,
  "packages/workflows/src/definitions/application-intake.ts": 1,
  "packages/workflows/src/definitions/new-times.ts": 1,
  "packages/workflows/src/definitions/schedule-interview.ts": 1,
  "packages/workflows/src/definitions/screen.ts": 1,
  "packages/workflows/src/new-times-reopen.ts": 3,
};

/** Where the parenthesis opened at `open` closes: strings and templates skipped, a template's `${...}` read as code, so a template inside one is too. */
function closingParen(source: string, open: number): number {
  const modes: Array<"code" | "template"> = ["code"];
  const braces: number[] = [0];
  let parens = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (modes[modes.length - 1] === "template") {
      if (ch === "\\") i += 1;
      else if (ch === "`") modes.pop();
      else if (ch === "$" && source[i + 1] === "{") {
        modes.push("code");
        braces.push(0);
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) if (source[i] === "\\") i += 1;
    } else if (ch === "`") modes.push("template");
    else if (ch === "{") braces[braces.length - 1] += 1;
    else if (ch === "}") {
      if (braces[braces.length - 1] === 0 && modes.length > 1) {
        modes.pop();
        braces.pop();
      } else braces[braces.length - 1] -= 1;
    } else if (ch === "(") parens += 1;
    else if (ch === ")") {
      parens -= 1;
      if (parens === 0 && modes.length === 1) return i;
    }
  }
  return source.length;
}

/** Takes the text of each `notify(...)` call, with the line it starts on. */
function notifyCalls(source: string): Array<{ line: number; text: string }> {
  const calls: Array<{ line: number; text: string }> = [];
  const finder = /\bnotify\(/g;
  for (let m = finder.exec(source); m; m = finder.exec(source)) {
    const end = closingParen(source, m.index + "notify".length);
    calls.push({ line: source.slice(0, m.index).split("\n").length, text: source.slice(m.index, end + 1) });
  }
  return calls;
}

/** Whether a notice's words use a person's name: an interpolation of one of these, which is not the team's or ITS's own. */
const NAMES_SOMEONE = /\$\{[^}]*\b(?:firstName|lastName|candidateName|name|who)\b[^}]*\}/g;
const NOT_A_CANDIDATE = /\b(?:actor|recruiter|r\.recruiter|user|member|author|sender|p|u)\??\.name\b|\bsenderName\b|\bactor\.name\b|\bwho\.map\b/;

/** Notices that use one of those words for someone who is not a candidate, by what they are about. Add one with a reason. */
const ABOUT_THE_TEAM: ReadonlySet<string> = new Set([
  // `who` is the team member who left.
  "member.left",
  // `who` is the team member who switched applications on or off.
  "applications.reopened",
  // `who` is who may decide the job's approval.
  "approval.requested",
  // A count, and the word "who" in a sentence about everyone.
  "volume.high",
]);

/** A call's `kind`, the first one when it is worked out in code: what the allow list above goes by. */
const kindOf = (text: string) => /kind: (?:[^,"]*\? )?"([^"]+)"/.exec(text)?.[1] ?? "";

describe("who reads a person", () => {
  it("does not grow: a new read of candidates needs an entry here saying why it cannot reach the team, or which filter it goes through", async () => {
    const counts: Record<string, number> = {};
    for (const file of await sourceFiles()) {
      const n = (readFileSync(join(ROOT, file), "utf8").match(READS_A_PERSON) ?? []).length;
      if (n) counts[file] = n;
    }
    const over = Object.entries(counts).filter(([file, n]) => n > (CANDIDATE_READERS[file] ?? 0));
    expect(over, `a new read of candidates in: ${over.map(([f, n]) => `${f} (${n}, allowed ${CANDIDATE_READERS[f] ?? 0})`).join("; ")}. Filter it by the lock (visibleTo, notLocked), or put it behind the path guard, and say so in tests/policy/candidate-readers.test.ts.`).toEqual([]);
    // Lower is fine, and the list says so: an entry with nothing left to count is taken off.
    const stale = Object.keys(CANDIDATE_READERS).filter((f) => !(f in counts));
    expect(stale, `entries for files that no longer read candidates: ${stale.join(", ")}`).toEqual([]);
  });

  it("the check catches a read of a person", () => {
    for (const line of ["tx.select().from(candidates)", "q.select({ id: x }).from(applications).innerJoin(candidates, eq(a, b))", "q.leftJoin(candidates, on)"]) expect(line.match(READS_A_PERSON)?.length, line).toBe(1);
    for (const line of ["tx.update(candidates).set({})", "tx.insert(candidates).values({})", "const candidates = 1;"]) expect(line.match(READS_A_PERSON), line).toBeNull();
  });
});

describe("a notice that names someone", () => {
  it("says which application it is about, so nothing is written for someone the team cannot read", async () => {
    const missing: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === "packages/core/src/notifications.ts") continue;
      const source = readFileSync(join(ROOT, file), "utf8");
      if (!source.includes("notify(")) continue;
      for (const call of notifyCalls(source)) {
        const names = [...call.text.matchAll(NAMES_SOMEONE)].map((m) => m[0]).filter((x) => !NOT_A_CANDIDATE.test(x));
        if (!names.length || /\babout:/.test(call.text) || ABOUT_THE_TEAM.has(kindOf(call.text))) continue;
        missing.push(`${file}:${call.line} (${kindOf(call.text) || "a kind worked out in code"}) uses ${names.join(", ")}`);
      }
    }
    expect(missing, `give each of these \`about: <application id>\`, or, if the name is the team's own and no candidate's, a line in ABOUT_THE_TEAM: ${missing.join("; ")}`).toEqual([]);
  });

  it("the check catches the call it is there to catch, however it is written", () => {
    const named = (source: string) => notifyCalls(source).flatMap((c) => (/\babout:/.test(c.text) ? [] : [...c.text.matchAll(NAMES_SOMEONE)].map((m) => m[0]).filter((x) => !NOT_A_CANDIDATE.test(x))));
    expect(named('await notify(tx, { companyId, kind: "x", title: `${cand.firstName} withdrew`, body: "b" });')).toEqual(["${cand.firstName}"]);
    expect(named('await notify(q, {\n  companyId,\n  kind: "x",\n  title: `${name} wrote back`,\n  body: "b",\n});')).toEqual(["${name}"]);
    expect(named('notify(tx, { companyId, about: app.id, kind: "x", title: `${name} wrote back`, body: "b" });')).toEqual([]);
    expect(named('notify(tx, { companyId, kind: "x", title: `${actor.name} picked up your request`, body: "b" });')).toEqual([]);
    expect(named('notify(tx, { companyId, kind: "x", title: `${role.title} is live`, body: "(see below)" });')).toEqual([]);
    // A template inside a template, a closing parenthesis in the words, and the next call's `about` not counting for this one.
    expect(named('await notify(q, { kind: "x", title: `${a ? `${cand.firstName} (new)` : ")"} left`, body: "b" });\nawait notify(q, { about: app.id, kind: "y", title: "t", body: "b" });')).toEqual(["${a ? `${cand.firstName}"]);
  });
});
