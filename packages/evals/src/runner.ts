import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider, companyAboutPrompt, createRuntime, intakeCompilePrompt, resumeExtractPrompt, runPrompt, screenAssessPrompt, screenTurnPrompt, triageAssessPrompt, type AiRuntime } from "@ros/ai";
import {
  INTAKE_COMPILE_MAX_TOKENS, SCORECARD_READINGS, SCORING_VIEW_VERSION, TRIAGE_READINGS, chatPacket, credentialMustHaves, finalizePacket, hasPlaceholder, readingsOutcome, registerFakeHandlers, scorecardOutcome, scorecardReadings,
  unfairQuestion, verifyQuotes, type ScoringIdentity,
} from "@ros/agents";
import { importanceOf, skillsInScore, type EvidenceAssessment, type ResumeExtraction, type RolePacket, type ScreenAssessment } from "@ros/contracts";
import { createDb, migrate } from "@ros/db";
import { runChatSuite, shownAfterAnUnfairFollowUp } from "./chat-suite";
import { runConversationSuite } from "./conversation-suite";
import { clipText, traceOutcome, traceTranscript, type CaseDiagnostics } from "./diagnostics";
import { intakeCaseResult, intakeContextOf, type IntakeModelCall } from "./intake-run";
import { postsCaseResult, postsCases } from "./posts-suite";
import { leakedDetails, lostEvidence, modelInputDifference, scorecardModelInput, triageModelInput, type EarlierApplication, type EvalApplication, type EvalInterview } from "./scoring-inputs";
import { chosenBy, suiteNameFailures } from "./summary";
import {
  CONSISTENCY_READS, RDH_FACTS, aboutCases, assessmentQuotesGrounded, biasPairDifferences, biasPairs, consistencyCases, consistencyDifferences, credentialCases, credentialFailures, fairnessRuleCases, formAnswersFor, intakeGolden,
  intakeIllegal, intakeJobAd, intakeProxyRefusal, questionFairnessCases, quotesAreGrounded, redactionCases, resumeCases, scoreCaseFailures, scoreCases, scoreOf, scorecardDifferences, screenAssessCases, screenConsistencyCases,
  screenRedactionCases, scriptedCredentialCases, scriptedReading, triageEdgeCases, verdictWords, type IntakeCase,
} from "./suites";

/**
 * Evaluation runner (docs/11). `pnpm eval` runs every suite against the configured provider
 * (fake by default; AI_PROVIDER=anthropic with a key runs the real models) and writes a result file.
 * A prompt version is promoted only when suites meet thresholds.json and a human signs the result.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
/**
 * `--suite triage` runs one suite or family; `--suite resume,triage` runs several (the fairness tests run on the real
 * models from .github/workflows/fairness.yml). A family name runs every suite whose name starts with it. A name that
 * chooses no suite fails the run.
 */
const onlySuites = args.includes("--suite") ? (args[args.indexOf("--suite") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
/** Whether a suite runs: chosen by its own name, or by its family (the part before the dot; `chosenBy` in summary.ts). */
const runs = (name: string) => !onlySuites || onlySuites.some((s) => chosenBy(s, name));
/** Whether a block that writes several suites of one family runs: chosen by the family or by any suite in it. */
const familyRuns = (family: string) => !onlySuites || onlySuites.some((s) => s === family || s.startsWith(`${family}.`));

type CaseResult = { id: string; pass: boolean; failures: string[]; costUsd?: number; notes?: string[]; diagnostics?: CaseDiagnostics };
const passRateOf = (cases: readonly CaseResult[]) => cases.filter((x) => x.pass).length / Math.max(1, cases.length);

async function main() {
  const handle = await createDb({ pgliteDir: "memory://" });
  await migrate(handle);
  const env = { ...process.env, AI_PROVIDER: process.env.AI_PROVIDER ?? "fake" };
  let rt: AiRuntime;
  if (env.AI_PROVIDER === "fake") {
    const fake = new FakeProvider();
    registerFakeHandlers(fake);
    rt = await createRuntime(env, fake);
  } else rt = await createRuntime(env);
  const q = handle.db;
  /**
   * `notes`: what each reading found, with its quotes, so a failed fairness case can be traced to the words.
   * `diagnostics`: on a failing case only, the chat and what the model returned before the code's checks
   * (diagnostics.ts; synthetic data).
   */
  const results: Record<string, { cases: CaseResult[]; passRate: number }> = {};
  const record = (suite: string, cases: CaseResult[]) => {
    results[suite] = { cases, passRate: passRateOf(cases) };
  };

  // The job builder's suites: each case as intake-run.ts drives it, every model call recorded in ai_runs.
  const intakeCall: IntakeModelCall = (prompt, input, meta) => runPrompt(q, rt, prompt, input, { companyId: null, ...meta });
  async function runIntakeSuite(name: string, cases: IntakeCase[], compile: boolean) {
    if (!runs(name)) return;
    const out: CaseResult[] = [];
    for (const c of cases) out.push(await intakeCaseResult(intakeCall, c, compile));
    record(name, out);
  }

  await runIntakeSuite("intake.golden", intakeGolden, true);
  await runIntakeSuite("intake.illegal_criteria", intakeIllegal, true);
  await runIntakeSuite("intake.job_ad", intakeJobAd, false);
  await runIntakeSuite("intake.proxy_refusal", intakeProxyRefusal, false);

  // The two posts on a job's Share tab: each post judged as the model wrote it, before the Share service finishes it by
  // rule (posts-suite.ts). One model call per case writes both posts.
  if (runs("job.posts")) {
    const out: CaseResult[] = [];
    for (const c of postsCases) out.push(await postsCaseResult(intakeCall, c));
    record("job.posts", out);
  }

  if (familyRuns("resume")) {
    const ext: CaseResult[] = [];
    const hall: CaseResult[] = [];
    for (const c of resumeCases) {
      const r = await runPrompt(q, rt, resumeExtractPrompt, { text: c.text }, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { ext.push({ id: c.id, pass: false, failures: [r.error] }); hall.push({ id: c.id, pass: false, failures: [r.error] }); continue; }
      const verified = verifyQuotes(r.output, c.text);
      const f = c.expect(verified, c.text);
      ext.push({ id: c.id, pass: f.length === 0, failures: f });
      const h = quotesAreGrounded(r.output, c.text); // raw output, before code-side verification: measures the model
      hall.push({ id: c.id, pass: h.length === 0, failures: h });
    }
    record("resume.extraction", ext);
    record("resume.hallucination", hall);
  }

  /** The golden dental hygienist job the CV and AI interview suites read against (written once per run). */
  let golden: Promise<RolePacket> | null = null;
  const goldenPacket = (): Promise<RolePacket> => {
    golden ??= (async () => {
      const c: IntakeCase = { id: "golden_rdh", provenance: "synthetic", vertical: "dental", ownerMessages: ["I need a dental hygienist in Irvine."] };
      const { ctx } = intakeContextOf(c, RDH_FACTS, [{ role: "owner", content: c.ownerMessages[0], at: new Date().toISOString() }]);
      const r = await runPrompt(q, rt, intakeCompilePrompt, ctx, { companyId: null, inputRef: { eval: "golden_packet" }, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      if (!r.ok) throw new Error(`golden packet failed: ${r.error}`);
      return finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
    })();
    return golden;
  };

  if (familyRuns("triage")) {
    /** The dental job of the run. A case with a job of its own (`WAREHOUSE_JOB`) is read against that one instead. */
    const packet = await goldenPacket();
    /** A reading's findings with their quotes, and the CV score the code works out from them against the job it was read for. */
    const findingsOf = (label: string, a: EvidenceAssessment, job: RolePacket = packet) =>
      `${label}: resume score ${scoreOf(a, job).score ?? "none"}; ${a.requirementFindings.map((x) => `${x.requirementKey}=${x.met}${x.evidence?.quote ? ` ("${x.evidence.quote}")` : ""}`).join("; ")} | skills: ${a.competencyFindings.map((x) => `${x.competencyKey}=${x.finding}${x.evidence?.quote ? ` ("${x.evidence.quote.slice(0, 50)}")` : ""}`).join("; ")}`;
    /** The CV read for its facts, from the original text, as the app does: the record is filled from it. */
    const extract = async (id: string, text: string): Promise<ResumeExtraction | null> => {
      const ex = await runPrompt(q, rt, resumeExtractPrompt, { text }, { companyId: null, inputRef: { eval: id } });
      return ex.ok ? verifyQuotes(ex.output, text) : null;
    };
    /**
     * Who applied, the earlier applications on their record, and an extraction already read (the same CV file).
     * `licenceHeld` false: their CV says the job's licence is lapsed, pending or not held, and so does their answer on
     * the form.
     */
    type Applied = { candidate: ScoringIdentity; earlier?: readonly EarlierApplication[]; extraction?: ResumeExtraction | null; licenceHeld?: boolean };
    /**
     * An application read as the app reads it (`assessApplication` in packages/agents): the CV's facts read from the
     * original, the reading's input built by `scoringInput` (name, email, phone, street address and links hidden; earlier
     * applications never sent; every answer on the form as a sentence), TRIAGE_READINGS readings side by side, each with
     * its quotes mapped back to the original words, through the evidence rules, combined into the middle answer. `raws`
     * are the model's own readings before any check, and `seen` the texts it was given, which the hallucination suite
     * measures them against; `modelInput` is everything the model was sent, and `app` the application as stored.
     */
    const assess = async (id: string, text: string, who: Applied, job: RolePacket = packet) => {
      const extraction = who.extraction !== undefined ? who.extraction : await extract(id, text);
      const app: EvalApplication = { packet: job, extraction, resumeText: text, formAnswers: formAnswersFor(job, { licenceHeld: who.licenceHeld ?? true }), identity: who.candidate, earlierApplications: who.earlier ?? [] };
      const { promptInput, view, text: modelInput } = triageModelInput(app);
      const calls = await Promise.all(Array.from({ length: TRIAGE_READINGS }, (_, i) => runPrompt(q, rt, triageAssessPrompt, promptInput, { companyId: null, inputRef: { eval: id, reading: i + 1, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() } })));
      // what the app does once the model has answered (`readingsOutcome`), not a copy of it
      return { combined: readingsOutcome(calls, view, app), raws: calls.flatMap((r) => (r.ok ? [r.output] : [])), calls, seen: { resume: promptInput.resumeText, application: promptInput.answerSentences.join("\n") }, modelInput, app };
    };
    type Assessed = Awaited<ReturnType<typeof assess>>;
    /** Each model call of one read as the model wrote it (on the scoring view, before the checks), or why it gave nothing. */
    const callNotes = (read: number, calls: Assessed["calls"], job: RolePacket = packet): string[] => calls.map((r, j) => (r.ok ? findingsOf(`read ${read} call ${j + 1}`, r.output, job) : `read ${read} call ${j + 1}: none (${r.reason})`));
    /** A job as the CV reading is shown it: its must-haves, and each skill the score counts with its importance. */
    const jobNote = (job: RolePacket) =>
      `job: must-haves: ${job.requirements.mustHaves.map((m) => `${m.key} "${clipText(m.text, 120)}"`).join(" | ") || "none"} || skills: ${skillsInScore(job).map((c) => `${c.key} [${importanceOf(c)}] "${clipText(c.definition, 200)}" indicators: ${clipText(c.indicators.join("; "), 200)}`).join(" | ") || "none"}`;
    const jobRole = (job: RolePacket): NonNullable<CaseDiagnostics["role"]> => ({
      questions: [],
      mustHaves: job.requirements.mustHaves.map((m) => ({ key: m.key, text: clipText(m.text) })),
      skills: skillsInScore(job).map((c) => ({ key: c.key, name: c.name, definition: clipText(c.definition), importance: importanceOf(c), indicators: c.indicators.map((x) => clipText(x)) })),
    });
    /** What a failing edge case needs to be diagnosed: each reading's findings, concerns and summary as the model wrote them, and the reading the team sees. */
    const edgeRecord = (a: Assessed): { notes: string[]; diagnostics: CaseDiagnostics } => {
      const words = (r: EvidenceAssessment) => `concerns: ${r.concerns.map((c) => clipText(c.claim, 120)).join("; ") || "none"} | summary: ${clipText(r.summary, 200)}`;
      return {
        notes: [
          ...a.calls.map((r, i) => (r.ok ? `${findingsOf(`reading ${i + 1}`, r.output)} | ${words(r.output)}` : `reading ${i + 1}: none (${r.reason}: ${clipText(r.error, 200)})`)),
          ...(a.combined.ok ? [`${findingsOf("shown", a.combined.output)} | ${words(a.combined.output)}`] : []),
        ],
        diagnostics: { readings: a.calls.map((r, i) => ({ label: `reading ${i + 1}`, ...traceOutcome(r) })), shown: [{ label: "shown", ...traceOutcome(a.combined) }], role: jobRole(packet) },
      };
    };
    /** A quote the model wrote is grounded when it is in what the model was given (the scoring view, placeholders and all). */
    const groundedIn = (raws: EvidenceAssessment[], seen: Assessed["seen"]) => raws.flatMap((raw, i) => assessmentQuotesGrounded(raw, seen).map((x) => `reading ${i + 1}: ${x}`));

    const edge: CaseResult[] = [];
    const hall: CaseResult[] = [];
    for (const c of triageEdgeCases) {
      const read = await assess(c.id, c.resumeText, { candidate: c.candidate, licenceHeld: c.licenceHeld });
      const { combined: r, raws, seen } = read;
      if (!r.ok) { edge.push({ id: c.id, pass: false, failures: [r.error], ...edgeRecord(read) }); hall.push({ id: c.id, pass: false, failures: [r.error] }); continue; }
      // what the case expects of the reading the team sees, and no verdict in any reading's own words as the model wrote them
      const f = [...c.expect(r.output, scoreOf(r.output, packet)), ...raws.flatMap((raw, i) => verdictWords(raw).map((x) => `reading ${i + 1}: ${x}`))];
      edge.push({ id: c.id, pass: f.length === 0, failures: f, ...(f.length ? edgeRecord(read) : {}) });
      const h = groundedIn(raws, seen);
      hall.push({ id: c.id, pass: h.length === 0, failures: h });
    }
    record("triage.edge_cases", edge);
    record("triage.hallucination", hall);

    // Twin CVs (docs/11): the same CV but for a name, a graduation year, a zip code or an earlier rejection at the same
    // company must read the same and score the same. Where the scoring view hides the cue or never sends it, the model
    // must be sent the very same input for both (`sameModelInput`).
    const bias: CaseResult[] = [];
    for (const pair of biasPairs) {
      const job = pair.job ?? packet;
      // The same CV file is read for its facts once, as it would be stored once.
      const shared = pair.a === pair.b ? { extraction: await extract(`${pair.id}_resume`, pair.a) } : {};
      const a = await assess(`${pair.id}_a`, pair.a, { candidate: pair.candidates[0], earlier: pair.earlier?.[0], ...shared }, job);
      const b = await assess(`${pair.id}_b`, pair.b, { candidate: pair.candidates[1], earlier: pair.earlier?.[1], ...shared }, job);
      // The reading is never sent the CV's facts as another model read them, but they tell the scoring view which name to
      // hide and which words to keep, and with two CV files each has its own, which a real model may word differently
      // from one read to the next: then the candidate's texts are compared as the reading gets them with none behind the view.
      const inputDiff = !pair.sameModelInput ? [] : "extraction" in shared ? modelInputDifference(a.modelInput, b.modelInput) : modelInputDifference(triageModelInput({ ...a.app, extraction: null }).text, triageModelInput({ ...b.app, extraction: null }).text);
      const ra = a.combined;
      const rb = b.combined;
      if (!ra.ok || !rb.ok) { bias.push({ id: pair.id, pass: false, failures: [...inputDiff, ra.ok ? "" : ra.error, rb.ok ? "" : rb.error].filter(Boolean) }); continue; }
      // the pair must read the same and score the same: the CV score is worked out from these findings
      const f = [...inputDiff, ...biasPairDifferences(pair, ra.output, rb.output, job)];
      bias.push({ id: pair.id, pass: f.length === 0, failures: f, notes: [findingsOf(pair.cues[0], ra.output, job), findingsOf(pair.cues[1], rb.output, job)] });
    }
    record("triage.bias_pairs", bias);

    // Consistency (docs/11): the same CV read again must give the same findings and the same score each time. Each
    // read's combined reading, then each of its model calls as the model wrote it. A job is noted with the first case read
    // against it.
    const steady: CaseResult[] = [];
    const noted = new Set<RolePacket>();
    for (const c of consistencyCases) {
      const job = c.job ?? packet;
      const reads: EvidenceAssessment[] = [];
      const notes: string[] = noted.has(job) ? [] : [jobNote(job)];
      noted.add(job);
      let failed: string | null = null;
      for (let i = 1; i <= CONSISTENCY_READS && !failed; i++) {
        const a = await assess(`${c.id}_read_${i}`, c.resume, { candidate: c.candidate, licenceHeld: c.licenceHeld }, job);
        if (a.combined.ok) {
          reads.push(a.combined.output);
          notes.push(findingsOf(`reading ${i}`, a.combined.output, job));
        } else failed = a.combined.error;
        notes.push(...callNotes(i, a.calls, job));
      }
      const f = failed ? [failed] : consistencyDifferences(reads, job);
      steady.push({ id: c.id, pass: f.length === 0, failures: f, notes, ...(f.length ? { diagnostics: { role: jobRole(job) } } : {}) });
    }
    record("triage.consistency", steady);

    // Licence readings: a credential is "no" only when the candidate says plainly they do not hold it; lapsed, expired,
    // pending or in training is "unknown". Each CV is read as the app reads it (three readings and their middle
    // answer), twice, and both must give the expected finding.
    const credentials = credentialMustHaves(packet);
    const licence: CaseResult[] = [];
    for (const c of credentialCases) {
      const job = c.job ?? packet;
      const reads: EvidenceAssessment[] = [];
      const notes: string[] = [];
      const f: string[] = [];
      for (let i = 1; i <= 2; i++) {
        const a = await assess(`${c.id}_licence_${i}`, c.resume, { candidate: c.candidate, licenceHeld: c.expect === "yes" }, job);
        const r = a.combined;
        if (!r.ok) f.push(r.error);
        else {
          reads.push(r.output);
          notes.push(findingsOf(`reading ${i}`, r.output, job));
          f.push(...credentialFailures(r.output, credentialMustHaves(job), c.expect).map((x) => `reading ${i}: ${x}`));
        }
        notes.push(...callNotes(i, a.calls, job));
      }
      if (reads.length > 1) f.push(...consistencyDifferences(reads, job));
      licence.push({ id: c.id, pass: f.length === 0, failures: f, notes, ...(f.length ? { diagnostics: { role: jobRole(job) } } : {}) });
    }
    // Readings that disagree, scripted (no model call): the finding the team sees rests on the candidate's words, so it
    // is the same whatever each reading said and whichever part of the licence line it quoted.
    const asIs = { restore: (s: string) => s };
    for (const c of scriptedCredentialCases) {
      const scripted = c.readings.map((r, i) => ({ ok: true as const, output: scriptedReading([...credentials], r), runId: `${c.id}_${i + 1}`, model: "scripted" }));
      const r = readingsOutcome(scripted, asIs, { resumeText: c.resume, formAnswers: {}, packet });
      const f = r.ok ? credentialFailures(r.output, credentials, c.expect) : [r.error];
      licence.push({ id: `scripted_${c.id}`, pass: f.length === 0, failures: f, ...(r.ok ? { notes: [findingsOf("combined", r.output)] } : {}) });
    }
    record("triage.credentials", licence);

    // What the CV reading is sent: a CV full of personal details, from someone with an earlier application. None of the
    // details, and nothing of the earlier application, may be in the model's input; the words the job is judged on must
    // be; and no placeholder may reach the team in the reading they see.
    const hidden: CaseResult[] = [];
    for (const c of redactionCases) {
      const { combined: r, modelInput, app } = await assess(c.id, c.resumeText, { candidate: c.candidate, earlier: c.earlier });
      const f = [...leakedDetails(modelInput, c.personal), ...lostEvidence(triageModelInput(app).messages, c.kept)];
      if (!r.ok) f.push(r.error);
      else if (hasPlaceholder(JSON.stringify(r.output))) f.push("a placeholder reached the reading the team sees");
      hidden.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    record("triage.redaction", hidden);
  }

  // The fairness rules in code: a monotonic score that moves only with the findings, the answers on the form as the
  // candidate's own words, and the skill floor. No model call; it runs with the "triage" family, so the fairness
  // workflow (--suite resume,triage) checks it on every run.
  if (runs("triage.fairness_rules")) {
    record("triage.fairness_rules", fairnessRuleCases.map((c) => {
      const f = c.failures();
      return { id: c.id, pass: f.length === 0, failures: f };
    }));
  }

  // The CV score: the rules of the code that works it out from a reading's findings. No model call.
  if (runs("score.rules")) {
    record("score.rules", scoreCases.map((c) => {
      const f = scoreCaseFailures(c);
      return { id: c.id, pass: f.length === 0, failures: f };
    }));
  }

  // About the company: the draft a person approves in Settings, judged as a candidate would read it.
  if (runs("company.about")) {
    const out: CaseResult[] = [];
    for (const c of aboutCases) {
      const r = await runPrompt(q, rt, companyAboutPrompt, c.input, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { out.push({ id: c.id, pass: false, failures: [`about failed: ${r.error}`] }); continue; }
      const f = c.expect(r.output.text);
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    record("company.about", out);
  }

  // A whole AI interview, turn after turn, each turn held to the code's rules as the app holds it (conversation-suite.ts).
  if (runs("screen.conversation")) {
    const packet = await goldenPacket();
    results["screen.conversation"] = await runConversationSuite(packet, async (ctx, persona) => {
      const r = await runPrompt(q, rt, screenTurnPrompt, ctx, { companyId: null, inputRef: { eval: persona.id, turn: ctx.transcript.length } });
      return r.ok ? r.output : `${r.reason}: ${clipText(r.error)}`;
    });
  }

  /**
   * A sent AI interview scored as the app scores it (`assessScreen` in packages/agents): the scorecard's input built by
   * `scorecardInput` (no name, email, phone, street or link), SCORECARD_READINGS readings side by side, each through the
   * code's checks, combined into the middle answer (`scorecardReadings`). `raws` are the model's own readings before any
   * check.
   */
  const scoreChat = async (id: string, interview: EvalInterview) => {
    const { ctx, view } = scorecardModelInput(interview);
    const readings = await Promise.all(Array.from({ length: SCORECARD_READINGS }, (_, i) => runPrompt(q, rt, screenAssessPrompt, ctx, { companyId: null, inputRef: { eval: id, reading: i + 1, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() } })));
    return { shown: scorecardReadings(readings, view, interview.screen, ctx.asked), raws: readings.flatMap((r) => (r.ok ? [r.output] : [])), readings, view, asked: ctx.asked };
  };
  type ScoredChat = Awaited<ReturnType<typeof scoreChat>>;

  /**
   * What a failing scorecard case needs to be diagnosed (synthetic data): the chat, the questions the scorecard reads
   * (a must-have's own words decide how the licence rule reads its answer), each reading's finding for each question as
   * the model wrote it and after the code's checks, and what was shown.
   */
  const questionsOf = (a: Pick<ScreenAssessment, "questionFindings">) => a.questionFindings.map((x) => `${x.questionKey}=${x.meetsModelAnswer}${x.evidence?.quote ? ` ("${clipText(x.evidence.quote, 80)}")` : ""}`).join("; ") || "none written";
  const scorecardNotes = (interview: EvalInterview, chat: ScoredChat): string[] => [
    ...interview.screen.transcript.slice(0, 30).map((t) => `${t.role}: ${clipText(t.content, 200)}`),
    `asked: ${chat.asked.map((a) => `${a.key}${a.mustHave ? ` (must-have "${clipText(a.mustHave, 80)}")` : ""}${a.skipped ? " skipped" : ""}`).join(" | ") || "nothing"}`,
    ...chat.readings.flatMap((r, i) =>
      r.ok
        ? [`reading ${i + 1}: ${questionsOf(r.output)} | unknowns: ${clipText(r.output.unknowns.map((u) => u.question).join("; "), 200)}`, `reading ${i + 1} after the checks: ${questionsOf(scorecardOutcome(r.output, chat.view, interview.screen, chat.asked))}`]
        : [`reading ${i + 1}: none (${r.reason}: ${clipText(r.error, 200)})`],
    ),
    ...(chat.shown.ok ? [`shown: ${questionsOf(chat.shown.output)}`] : []),
  ];
  /** And the full record behind those lines (diagnostics.ts): the chat, each reading as the model wrote it, and what was shown; `chats`: each read of it. */
  const scorecardDiagnostics = (interview: EvalInterview, chats: ScoredChat[]): CaseDiagnostics => {
    const read = (n: number) => (chats.length > 1 ? `read ${n + 1}, ` : "");
    return {
      transcript: traceTranscript(interview.screen.transcript),
      readings: chats.flatMap((chat, n) => chat.readings.map((r, i) => ({ label: `${read(n)}reading ${i + 1}`, ...traceOutcome(r) }))),
      shown: chats.map((chat, n) => ({ label: `${read(n)}shown`, ...traceOutcome(chat.shown) })),
      role: {
        questions: chatPacket(interview.packet, interview.screen.progress).screening.questions.map((x) => ({ key: x.key, kind: x.kind, text: clipText(x.question) })),
        mustHaves: interview.packet.requirements.mustHaves.map((m) => ({ key: m.key, text: clipText(m.text) })),
        skills: [],
      },
    };
  };

  // The scorecard: one finding for every question asked, a skip not known, the licence rule, and only the candidate's
  // own words quoted. `expect` reads the model's own first reading; `expectShown` what the team sees. And no reading
  // gives a verdict on the person in its own words (`verdictWords`, as for the resume reading), in any case.
  if (runs("screen.assess")) {
    const packet = await goldenPacket();
    const out: CaseResult[] = [];
    for (const c of screenAssessCases) {
      const interview = c.build(packet);
      const chat = await scoreChat(c.id, interview);
      const { shown, raws } = chat;
      if (!shown.ok || !raws[0]) { out.push({ id: c.id, pass: false, failures: [`assess failed: ${shown.ok ? "no reading came back" : shown.error}`], notes: scorecardNotes(interview, chat), diagnostics: scorecardDiagnostics(interview, [chat]) }); continue; }
      const f = [...(c.expect?.(raws[0], interview) ?? []), ...(c.expectShown?.(shown.output, interview) ?? []).map((x) => `shown: ${x}`), ...raws.flatMap((raw, i) => verdictWords(raw).map((x) => `reading ${i + 1}: ${x}`))];
      out.push({ id: c.id, pass: f.length === 0, failures: f, ...(f.length ? { notes: scorecardNotes(interview, chat), diagnostics: scorecardDiagnostics(interview, [chat]) } : {}) });
    }
    record("screen.assess", out);
  }

  // The scorecard read again: the same interview, scored as the app scores it, twice, must give the same findings and
  // the same interview score.
  if (runs("screen.consistency")) {
    const packet = await goldenPacket();
    const out: CaseResult[] = [];
    for (const c of screenConsistencyCases) {
      const interview = c.build(packet);
      const one = await scoreChat(`${c.id}_read_1`, interview);
      const two = await scoreChat(`${c.id}_read_2`, interview);
      if (!one.shown.ok || !two.shown.ok) { out.push({ id: c.id, pass: false, failures: [one.shown, two.shown].flatMap((x) => (x.ok ? [] : [x.error])), diagnostics: scorecardDiagnostics(interview, [one, two]) }); continue; }
      const f = scorecardDifferences(one.shown.output, two.shown.output, interview);
      // a case that read differently keeps both reads' notes and full record
      out.push({ id: c.id, pass: f.length === 0, failures: f, ...(f.length ? { notes: [...scorecardNotes(interview, one).map((n) => `read 1 ${n}`), ...scorecardNotes(interview, two).filter((n) => n.startsWith("reading") || n.startsWith("shown")).map((n) => `read 2 ${n}`)], diagnostics: scorecardDiagnostics(interview, [one, two]) } : {}) });
    }
    record("screen.consistency", out);
  }

  // The code's fairness check on what the AI writes for a candidate to read (no model call): protected questions caught,
  // ordinary dental ones let through, and an unfair follow-up never shown.
  if (runs("screen.question_fairness")) {
    const out: CaseResult[] = questionFairnessCases.map((c) => {
      const said = unfairQuestion(c.text);
      const f = c.unfair && !said ? [`not caught: "${c.text}"`] : !c.unfair && said ? [`blocked an ordinary question: "${c.text}" (${said})`] : [];
      return { id: c.id, pass: f.length === 0, failures: f };
    });
    const shown = shownAfterAnUnfairFollowUp();
    const sent = unfairQuestion(shown) ? [`an unfair follow-up reached the candidate: "${shown}"`] : [];
    out.push({ id: "unfair_follow_up_never_sent", pass: sent.length === 0, failures: sent });
    record("screen.question_fairness", out);
  }

  // The scorecard's side of what the readings are sent: an interview full of personal details. None may be in the
  // model's input, the answers must be, and the scorecard the team sees (quotes mapped back and checked as the app
  // does) holds no placeholder.
  if (runs("screen.redaction")) {
    const packet = await goldenPacket();
    const out: CaseResult[] = [];
    for (const c of screenRedactionCases) {
      const interview = c.build(packet);
      const { ctx, view, text, messages } = scorecardModelInput(interview);
      const f = [...leakedDetails(text, c.personal), ...lostEvidence(messages, c.kept)];
      const r = await runPrompt(q, rt, screenAssessPrompt, ctx, { companyId: null, inputRef: { eval: c.id, scoringView: SCORING_VIEW_VERSION, hidden: view.counts() } });
      if (!r.ok) f.push(`assess failed: ${r.error}`);
      // what the app does once the model has answered (`scorecardOutcome`), not a copy of it
      else if (hasPlaceholder(JSON.stringify(scorecardOutcome(r.output, view, interview.screen, ctx.asked)))) f.push("a placeholder reached the scorecard the team sees");
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    record("screen.redaction", out);
  }

  // One turn of the AI interview (chat-suite.ts): one restatement and one question, the push and the analog steps, no
  // guesses, no form answer asked again, no private note, the fairness check and the close.
  if (familyRuns("chat")) {
    const chat = await runChatSuite(async (ctx, c) => {
      const r = await runPrompt(q, rt, screenTurnPrompt, ctx, { companyId: null, inputRef: { eval: `chat_${c.id}` } });
      return r.ok ? r.output : `${r.reason}: ${clipText(r.error)}`;
    }, runs);
    Object.assign(results, chat);
  }

  const thresholds = JSON.parse(readFileSync(join(here, "..", "thresholds.json"), "utf8")) as Record<string, { minPassRate: number }>;
  let ok = true;
  for (const [suite, r] of Object.entries(results)) {
    const min = thresholds[suite]?.minPassRate ?? 1;
    const pass = r.passRate >= min;
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"} ${suite}: ${(r.passRate * 100).toFixed(0)}% (min ${(min * 100).toFixed(0)}%)`);
    for (const c of r.cases) if (!c.pass) console.log(`   × ${c.id}: ${c.failures.join("; ")}`);
  }
  // A `--suite` that names nothing, or a name in it that chose no suite (a typo, or a suite renamed on one side only),
  // fails the run: the fairness button never passes with fewer checks than were chosen. The summary names each such
  // name as a check that needs a look. A whole run also fails when its suites and thresholds.json disagree, so CI's
  // `pnpm eval` catches a suite renamed here alone (`suiteNameFailures`).
  for (const line of suiteNameFailures(onlySuites, Object.keys(results), Object.keys(thresholds))) {
    ok = false;
    console.log(`FAIL ${line}`);
  }
  // What the run cost: every model call is recorded in ai_runs with its estimated cost (packages/ai/src/pricing.ts).
  const [spent] = await handle.query("SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total, COUNT(*)::int AS calls FROM ai_runs", []);
  const costUsd = Math.round(Number(spent?.total ?? 0) * 10_000) / 10_000;
  const calls = Number(spent?.calls ?? 0);
  console.log(`cost: $${costUsd.toFixed(4)} over ${calls} model calls`);
  const dir = join(here, "..", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${rt.provider.id}.json`);
  writeFileSync(file, JSON.stringify({ provider: rt.provider.id, models: rt.models, efforts: rt.efforts ?? {}, suites: onlySuites ?? "all", costUsd, calls, results }, null, 2));
  console.log(`results: ${file}`);
  await handle.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
