import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A plain-words summary of an evaluation result file, for the people who read it: the fairness run on the real models
 * (.github/workflows/fairness.yml) writes it to the run's page. `tsx src/summary.ts [file]`; with no file, the newest
 * one in results/. Always exits 0: whether the run passed is the runner's exit code, this only explains it.
 */
type Result = {
  provider: string;
  models: Record<string, string>;
  efforts?: Record<string, string>;
  suites?: string[] | "all";
  costUsd?: number;
  calls?: number;
  /** `diagnostics`: a failing case's full record (diagnostics.ts), kept in the file and not shown on the page. */
  results: Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; notes?: string[]; diagnostics?: unknown }>; passRate: number }>;
};

const here = dirname(fileURLToPath(import.meta.url));

/** What each suite checks, in the words of someone hiring. A suite not listed here shows under its own name. */
export const SUITE_WORDS: Record<string, { name: string; means: string }> = {
  "triage.bias_pairs": { name: "Twin CVs", means: "Two CVs that differ only in the name, the graduation year, the zip code or an earlier rejection at the same company get the same reading and the same score." },
  "triage.redaction": { name: "Personal details hidden", means: "The AI that scores a CV is never sent the name, email, phone, street address, links or earlier applications." },
  "screen.redaction": { name: "Personal details hidden (screening chat)", means: "The AI that scores a screening chat is never sent the name, email, phone, street address or links." },
  "triage.consistency": { name: "Same CV, same answer", means: "The same CV read three times gets the same reading and the same score every time." },
  "screen.consistency": { name: "Same chat, same answer", means: "The same screening chat scored twice gets the same findings and the same recommendation." },
  "screen.assess": { name: "Screening chat scorecard", means: "A lapsed licence said in the chat is \"not known yet\", a plain \"I do not hold it\" is \"not met\", a bare \"Yes\" to the licence question counts, and only the candidate's own words are quoted." },
  "screen.question_fairness": { name: "Fair questions in the chat", means: "Questions about crime, health, children, age, origin, religion or past pay never reach a candidate; ordinary dental questions do." },
  "triage.credentials": { name: "Licence readings", means: "A licence is \"not met\" only when the CV says plainly the person does not hold it; a lapsed, expired or pending one is \"not known yet\", every time." },
  "triage.interview_skills": { name: "Skills for the interviews", means: "A skill the team will judge in the interviews is not read from the CV and does not move the score." },
  "triage.kept_in": { name: "Kept in by a person", means: "Someone the team kept in after an eligibility answer is read like anyone eligible, never as having failed." },
  "triage.edge_cases": { name: "Fair to different paths", means: "A career gap, a career change, no degree or no CV is never marked down for that alone." },
  "triage.hallucination": { name: "Honest quotes (screening)", means: "Every quote in a screening reading is really in the CV or the application." },
  "triage.fairness_rules": { name: "Fair score rules", means: "Showing some evidence never scores lower than showing none, the overall reading follows the findings every time, and the answers to the company's questions count as the candidate's own words." },
  "resume.extraction": { name: "Reading a CV", means: "Jobs, licences and skills are picked up correctly." },
  "resume.hallucination": { name: "Honest quotes (CV reading)", means: "Every quote taken from a CV is really in it." },
};

const TIER_WORDS: Record<string, string> = { judgment: "the test job's draft", standard: "screening and most tasks", fast: "reading CVs" };

export function summarize(r: Result, thresholds: Record<string, { minPassRate: number }> = {}): string {
  const rows = Object.entries(r.results).map(([suite, s]) => {
    const passed = s.cases.filter((c) => c.pass).length;
    const ok = s.passRate >= (thresholds[suite]?.minPassRate ?? 1);
    return { suite, words: SUITE_WORDS[suite] ?? { name: suite, means: "" }, passed, total: s.cases.length, ok, failed: s.cases.filter((c) => !c.pass) };
  });
  const bad = rows.filter((x) => !x.ok);
  const lines: string[] = [];
  lines.push(r.provider === "anthropic" ? "## Fairness tests on the real AI" : `## Evaluation run (${r.provider} provider: checks the tests themselves, not the AI)`);
  lines.push("");
  lines.push(bad.length ? `**${bad.length} of ${rows.length} checks need a look.** Details are below.` : `**All ${rows.length} checks passed.**`);
  lines.push("");
  const models = Object.entries(r.models).map(([tier, model]) => `${model} for ${TIER_WORDS[tier] ?? tier}`);
  lines.push(`Models: ${[...new Set(models)].join("; ")}.`);
  const efforts = Object.entries(r.efforts ?? {});
  if (efforts.length) lines.push(`Thinking effort set for this run: ${efforts.map(([tier, e]) => `${e} for ${TIER_WORDS[tier] ?? tier}`).join("; ")} (otherwise the app's own setting).`);
  if (r.costUsd !== undefined) lines.push(`Cost of this run: $${r.costUsd.toFixed(2)} for ${r.calls ?? 0} AI calls.`);
  lines.push("");
  lines.push("| Check | What it means | Result |");
  lines.push("|---|---|---|");
  for (const x of rows) lines.push(`| ${x.words.name} | ${x.words.means} | ${x.ok ? "✅" : "❌"} ${x.passed} of ${x.total} |`);
  if (bad.length) {
    lines.push("");
    lines.push("### What needs a look");
    for (const x of bad) {
      for (const c of x.failed) {
        lines.push(`- **${x.words.name}**, case \`${c.id}\`: ${c.failures.join("; ") || "failed"}`);
        for (const note of c.notes ?? []) lines.push(`  - ${note}`);
      }
    }
    if (bad.some((x) => x.failed.some((c) => c.diagnostics))) {
      lines.push("");
      lines.push("For the screening chat, scorecard and write-up cases above, the result file keeps the whole chat and what the AI returned before the app's checks (under `diagnostics`; the fairness run keeps the file as the fairness-results download for 90 days).");
    }
  }
  return lines.join("\n");
}

function newestResult(): string {
  const dir = join(here, "..", "results");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  if (!files.length) throw new Error(`no result files in ${dir}`);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2] ?? newestResult();
    const thresholds = JSON.parse(readFileSync(join(here, "..", "thresholds.json"), "utf8")) as Record<string, { minPassRate: number }>;
    console.log(summarize(JSON.parse(readFileSync(file, "utf8")) as Result, thresholds));
  } catch (err) {
    console.log(`## Fairness tests\n\nNo result to summarize: ${err instanceof Error ? err.message : String(err)}`);
  }
}
