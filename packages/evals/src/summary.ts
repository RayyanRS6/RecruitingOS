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
  "triage.bias_pairs": { name: "Twin resumes", means: "Two resumes that differ only in the name, the graduation year, the zip code or an earlier rejection at the same company get the same reading and the same score, for a dental job and for a warehouse job." },
  "triage.redaction": { name: "Personal details hidden", means: "The AI that scores a resume is never sent the name, email, phone, street address, links or earlier applications." },
  "screen.redaction": { name: "Personal details hidden (AI interview)", means: "The AI that writes an AI interview's scorecard is never sent the name, email, phone, street address or links." },
  "triage.consistency": { name: "Same resume, same answer", means: "The same resume read three times gets the same reading and the same score every time, for a dental job and for a warehouse job, when each of its lines plainly shows a requirement or plainly does not." },
  "screen.consistency": { name: "Same interview, same answer", means: "The same AI interview scored twice gets the same finding for every question and the same interview score." },
  "screen.assess": { name: "AI interview scorecard", means: "Every question the interview asked gets a finding; a skipped or unanswered question is \"not known yet\" and never held against the candidate; a lapsed licence said in the chat is \"not known yet\", a plain \"I do not hold it\" is \"not met\", and one held in their own words is met on those words; a plain \"Yes\" to a yes-or-no question counts; only the candidate's own words are quoted; and no reading gives a verdict on the person." },
  "screen.question_fairness": { name: "Fair questions in the chat", means: "Questions about crime, health, children, age, origin, religion or past pay never reach a candidate; ordinary dental questions do." },
  "screen.conversation": { name: "The AI interview", means: "Over a whole interview the chat asks one thing at a time, pushes once for an example on the candidate's own words, keeps every answer in their words under its question, shows how to choose a person when someone asks for one, is struggling or is confused (and closes nothing), answers a question about pay with the posted range, never takes up age or children, and closes without promising when they will hear, and asks about a licence the resume does not show once, as yes or no, takes \"No\" as the answer and goes on to the next question." },
  "chat.shape": { name: "One restatement, one question", means: "Each message restates what the candidate said and asks one question, and a concrete answer is taken as one, so the chat moves on." },
  "chat.ladder": { name: "Asking for more, then moving on", means: "A bare or thin yes gets one push for an example and a second vague reply moves on; a no is asked for something similar, then something smaller, and is then left \"not known yet\", calmly. A licence or certificate the resume does not show is asked about once, as yes or no, and a \"No\" is its answer: nothing similar is asked for." },
  "chat.no_inference": { name: "No guesses", means: "A vague reply is never filled in with a guess about how it went." },
  "chat.no_reask": { name: "Nothing asked twice", means: "The chat never asks again what the candidate just said or what an earlier reply already answered, asks about nothing outside its plan, and a certificate the candidate answered \"No\" about on the application form is not in the plan." },
  "chat.private_note": { name: "The private note never said", means: "What the company noted for itself about a question, what to look for in the answer, never reaches the candidate." },
  "chat.fairness": { name: "Personal details left alone", means: "A protected detail the candidate mentions, such as having children, is never followed up and never kept in their answer." },
  "chat.close": { name: "A fair close", means: "Once the candidate has nothing to add, the chat closes without asking anything more and without promising when they will hear. The closing question comes only when every question of the plan has been asked, wherever the AI's turn pointed." },
  "triage.credentials": { name: "Licence readings", means: "A licence or certificate is \"not met\" only when the resume says plainly the person does not hold it; a lapsed, expired or pending one is \"not known yet\", every time." },
  "triage.edge_cases": { name: "Fair to different paths", means: "A career gap, a career change, no degree or a resume that reads machine-written is never read as a must-have not met, and never named as a concern. No reading gives a verdict on the person (\"a strong candidate\", \"should be rejected\"), and what a resume does not mention is never read as not met." },
  "triage.hallucination": { name: "Honest quotes (resume scoring)", means: "Every quote in the reading that scores a resume is really in the resume or in the candidate's answers on the form." },
  "triage.fairness_rules": { name: "Fair score rules", means: "Showing some evidence never scores lower than showing none, the score moves only with the findings (never with a reading's words or the order the readings came in), a skill one of the three readings found in the candidate's own words counts as partly shown (never from a job title and dates alone), the answers to the company's questions count as the candidate's own words, and each must-have and skill is counted once whatever names a reading gave its findings." },
  "resume.extraction": { name: "Reading a resume", means: "The name, jobs, licences and skills are picked up correctly." },
  "resume.hallucination": { name: "Honest quotes (resume reading)", means: "Every quote taken from a resume is really in it." },
  "intake.golden": { name: "Writing a job", means: "From what an owner types, the job builder reads the title, the place, the pay, the schedule and the must-haves, asks whether the job is on site, hybrid or remote instead of assuming it, asks for the state when the owner names a city alone, asks again for nothing the owner already said or answered on a card, brings back a card the owner left alone until it is answered, and writes a whole job: a description with no pay figure in it, the owner's pay and work arrangement as they said them, each must-have written as the requirement (also when the job is written again), no skill named the same as a must-have, five or six questions for the AI interview with the owner's own first, and on the application form the owner's questions and one for a licence the job must have." },
  "intake.illegal_criteria": { name: "Unlawful wishes declined", means: "Asking for people under 30, no employment gaps, a native speaker, no children or only one zip code is declined, and what was declined is in no job written afterwards." },
  "intake.job_ad": { name: "A pasted job ad", means: "A pasted ad is read for its job and its pay, the owner is asked to confirm the pay and to say whether the job is on site, hybrid or remote, the pay card comes back until the owner has confirmed the pay, its unlawful wording is declined and an instruction hidden in it is ignored." },
  "intake.proxy_refusal": { name: "Stand-ins refused", means: "Wording that stands in for age or another protected trait is refused wherever it comes from: a deal-breaker, a pasted ad or an answer the builder offers." },
  "job.posts": { name: "The two posts", means: "The LinkedIn post and the Indeed post each carry their own Apply link once and no other link, show the pay when the job page shows it and state no other pay figure, have no wording that stands in for age or another protected trait, and stay inside their length." },
};

/**
 * What each model tier did in the run, in the words of someone hiring (TASK_TIER in packages/ai/src/routing.ts), from
 * the suites that ran. In the resume and AI interview checks Sonnet writes the test job's draft and Haiku screens. A
 * job-builder run screens nobody: Sonnet writes every draft under test, and the standard tier, which the fairness
 * button's screening model and effort set, holds the builder's conversation. A run of both names both. The fast tier
 * only reads: the resumes in the resume checks, the pasted ads in the job builder's (`readingWords`).
 */
const CV_TIERS = { judgment: "the test job's draft", standard: "screening and most tasks" };
const BUILDER_TIERS = { judgment: "writing each job draft", standard: "the job builder's conversation" };
const BOTH_TIERS = { judgment: "writing each job draft", standard: "screening, the job builder's conversation and most tasks" };
/** A suite of the job builder: the job written from what an owner types (intake.*), and the two posts written from it (job.*). */
const ofTheBuilder = (suite: string) => suite.startsWith("intake.") || suite.startsWith("job.");
/**
 * What the fast tier read in the run: resumes (resume.* and triage.*), pasted job ads (intake.*), or nothing, as in the AI
 * interview's checks (`screen,chat`), whose page then names no model for it.
 */
function readingWords(ran: readonly string[]): string | null {
  const cvs = ran.some((suite) => suite.startsWith("resume.") || suite.startsWith("triage."));
  const ads = ran.some((suite) => suite.startsWith("intake."));
  return cvs && ads ? "reading resumes and pasted ads" : cvs ? "reading resumes" : ads ? "reading a pasted ad" : null;
}
/** Each tier's words for this run; null for a tier that did nothing in it, which the Models and effort lines leave out. */
const tierWords = (ran: readonly string[]): Record<string, string | null> => ({ ...(!ran.some(ofTheBuilder) ? CV_TIERS : ran.every(ofTheBuilder) ? BUILDER_TIERS : BOTH_TIERS), fast: readingWords(ran) });

/** Whether a name given to `--suite` chooses a suite: by its own name, or by its family (the part before the dot). The runner reads `--suite` by this rule. */
export const chosenBy = (name: string, suite: string): boolean => name === suite || name === suite.split(".")[0];

/**
 * The names given to `--suite` that chose none of the suites that ran: a typo, or a suite renamed on one side only. The
 * runner fails the run on one, and the page counts each as a check that needs a look, so a run never reads "All N checks
 * passed" with fewer checks than were chosen. A whole run ("all") chose none.
 */
export function unmatchedSuites(chosen: readonly string[] | "all" | undefined, ran: readonly string[]): string[] {
  if (!chosen || chosen === "all") return [];
  return chosen.filter((name) => !ran.some((suite) => chosenBy(name, suite)));
}

/**
 * Why a run fails whatever its checks' results, each line as the runner prints it after "FAIL ". With `--suite`
 * (`chosen`): a name in it that chose none of the suites that ran, or no name at all. On a whole run (`chosen` null,
 * which CI's `pnpm eval` makes): a suite that ran with no entry in thresholds.json (`listed`, its keys; those that start
 * with "_" are notes), or an entry that no suite by that name wrote. So thresholds.json lists every suite the runner
 * has, and a suite renamed in the runner alone fails CI before anyone presses the fairness button, whose choices
 * tests/policy/fairness-choices.test.ts checks against that list.
 */
export function suiteNameFailures(chosen: readonly string[] | null, ran: readonly string[], listed: readonly string[]): string[] {
  if (chosen) return chosen.length ? unmatchedSuites(chosen, ran).map((name) => `--suite ${name}: no suite by that name or family ran`) : ["--suite: no suite named"];
  const entries = listed.filter((key) => !key.startsWith("_"));
  return [
    ...ran.filter((suite) => !entries.includes(suite)).map((suite) => `${suite}: no entry in thresholds.json`),
    ...entries.filter((suite) => !ran.includes(suite)).map((suite) => `${suite}: in thresholds.json, but no suite by that name ran`),
  ];
}

export function summarize(r: Result, thresholds: Record<string, { minPassRate: number }> = {}): string {
  const rows = Object.entries(r.results).map(([suite, s]) => {
    const passed = s.cases.filter((c) => c.pass).length;
    const ok = s.passRate >= (thresholds[suite]?.minPassRate ?? 1);
    return { suite, words: SUITE_WORDS[suite] ?? { name: suite, means: "" }, passed, total: s.cases.length, ok, failed: s.cases.filter((c) => !c.pass) };
  });
  const bad = rows.filter((x) => !x.ok);
  const notRun = unmatchedSuites(r.suites, Object.keys(r.results));
  const needLook = bad.length + notRun.length;
  const total = rows.length + notRun.length;
  const tiers = tierWords(Object.keys(r.results));
  /** "<setting> for <what the tier did>" for each tier, leaving out one that did nothing in this run; a tier the words do not know shows under its own name. */
  const perTier = (set: Record<string, string>) => Object.entries(set).flatMap(([tier, value]) => {
    const words = Object.hasOwn(tiers, tier) ? tiers[tier] : tier;
    return words ? [`${value} for ${words}`] : [];
  });
  const lines: string[] = [];
  lines.push(r.provider === "anthropic" ? "## Fairness tests on the real AI" : `## Evaluation run (${r.provider} provider: checks the tests themselves, not the AI)`);
  lines.push("");
  lines.push(needLook ? `**${needLook} of ${total} checks need a look.** Details are below.` : total ? `**All ${total} checks passed.**` : "**No check ran.**");
  lines.push("");
  lines.push(`Models: ${[...new Set(perTier(r.models))].join("; ")}.`);
  const efforts = perTier(r.efforts ?? {});
  if (efforts.length) lines.push(`Thinking effort set for this run: ${efforts.join("; ")} (otherwise the app's own setting).`);
  if (r.costUsd !== undefined) lines.push(`Cost of this run: $${r.costUsd.toFixed(2)} for ${r.calls ?? 0} AI calls.`);
  lines.push("");
  lines.push("| Check | What it means | Result |");
  lines.push("|---|---|---|");
  for (const x of rows) lines.push(`| ${x.words.name} | ${x.words.means} | ${x.ok ? "✅" : "❌"} ${x.passed} of ${x.total} |`);
  for (const name of notRun) lines.push(`| ${name} | Chosen for this run, but no check by that name ran. | ❌ not run |`);
  if (needLook) {
    lines.push("");
    lines.push("### What needs a look");
    for (const name of notRun) lines.push(`- **${name}**: chosen for this run, but no check by that name ran.`);
    for (const x of bad) {
      for (const c of x.failed) {
        lines.push(`- **${x.words.name}**, case \`${c.id}\`: ${c.failures.join("; ") || "failed"}`);
        for (const note of c.notes ?? []) lines.push(`  - ${note}`);
      }
    }
    if (bad.some((x) => x.failed.some((c) => c.diagnostics))) {
      lines.push("");
      lines.push("For the AI interview, scorecard and resume reading cases above, the result file keeps the whole chat and what the AI returned before the app's checks (under `diagnostics`; the fairness run keeps the file as the fairness-results download for 90 days).");
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
