import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider, companyAboutPrompt, createRuntime, intakeCompilePrompt, intakeExtractPrompt, intakeTurnPrompt, messageLinePrompt, packetRevisePrompt, resumeExtractPrompt, runPrompt, screenAssessPrompt, screenTurnPrompt, triageAssessPrompt, type AiRuntime, type IntakeContext, type ScreenContext } from "@ros/ai";
import {
  INTAKE_COMPILE_MAX_TOKENS, REVISABLE_FOR_DRAFT, REVISABLE_FOR_ROLE, advanceProgress, basisFor, editableView, enforceTurnRules, factsFromExtraction, finalizePacket, mergeFacts, mergeRevision, redactProtected, registerFakeHandlers,
  resolveBenchmark, verifyQuotes, type BenchmarkResult,
} from "@ros/agents";
import type { EvidenceAssessment, IntakeFacts, IntakeMessage, RolePacket, ScreenProgress, ScreenTurn } from "@ros/contracts";
import { createDb, migrate } from "@ros/db";
import { findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import { CONSISTENCY_READS, EMPTY_FACTS, RDH_FACTS, aboutCases, lineCases, assessmentQuotesGrounded, biasPairDifferences, biasPairs, boardCaseFailures, boardCases, consistencyCases, consistencyDifferences, intakeBenchmarkBasis, intakeGolden, intakeIllegal, intakeJobAd, intakeProxyRefusal, quotesAreGrounded, resumeCases, reviseCases, screenAssessCases, screenPersonas, triageEdgeCases, type IntakeCase } from "./suites";

/**
 * Evaluation runner (docs/11). `pnpm eval` runs every suite against the configured provider
 * (fake by default; AI_PROVIDER=anthropic with a key runs the real models) and writes a result file.
 * A prompt version is promoted only when suites meet thresholds.json and a human signs the result.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
/**
 * `--suite triage` runs one suite or family; `--suite resume,triage` runs several (the fairness tests run on the real
 * models from .github/workflows/fairness.yml). A family name runs every suite whose name starts with it.
 */
const onlySuites = args.includes("--suite") ? (args[args.indexOf("--suite") + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
/** Whether a suite runs: chosen by its own name, or by its family (the part before the dot). */
const runs = (name: string) => !onlySuites || onlySuites.some((s) => s === name || s === name.split(".")[0]);
/** Whether a block that writes several suites of one family runs: chosen by the family or by any suite in it. */
const familyRuns = (family: string) => !onlySuites || onlySuites.some((s) => s === family || s.startsWith(`${family}.`));

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
  /** `notes`: what each reading decided, with its quotes, so a failed fairness case can be traced to the words. */
  const results: Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; costUsd?: number; notes?: string[] }>; passRate: number }> = {};
  const findingsOf = (label: string, a: EvidenceAssessment) => `${label}: ${a.overall}; ${a.requirementFindings.map((x) => `${x.requirementKey}=${x.met}${x.evidence?.quote ? ` ("${x.evidence.quote}")` : ""}`).join("; ")}`;

  // The eval has no live wage service: the market check falls back to the playbook's table, as production does when the
  // service is down. The basis comes first (plan C2), and the pay the owner typed counts as confirmed.
  const noLiveWages = { id: "eval", status: "disabled" as const, benchmark: async () => null };
  const buildCtx = async (c: IntakeCase, facts: IntakeFacts, messages: IntakeMessage[]): Promise<{ ctx: IntakeContext; basis: "hourly" | "salary" | null; bench: BenchmarkResult }> => {
    const playbook = findPlaybook(c.vertical);
    const typed = messages.filter((m) => m.role === "owner" && (!m.kind || m.kind === "text")).map((m) => m.content);
    const title = facts.title ?? typed[0] ?? "";
    const role = playbook && title ? matchPlaybookRole(playbook, title) : null;
    const basis = basisFor(facts, typed, role);
    const bench = await resolveBenchmark(noLiveWages, { basis, playbookRole: role, titleGuess: title, locationText: facts.locationText ?? "Irvine, CA" });
    const ad = messages.find((m) => m.kind === "pasted_ad");
    const pay = facts.compensationBasis && facts.compensationMin !== undefined && facts.compensationMax !== undefined && !ad ? { basis: facts.compensationBasis, min: facts.compensationMin, max: facts.compensationMax, ...(facts.compensationCeiling !== undefined ? { ceiling: facts.compensationCeiling } : {}) } : null;
    return {
      ctx: {
        company: { name: "Eval Co", vertical: c.vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
        playbook, playbookRole: role,
        benchmark: bench.benchmark, benchmarkGap: bench.gap,
        facts, messages,
        ad: ad ? { text: ad.content } : null,
        confirmedPay: pay,
      },
      basis,
      bench,
    };
  };

  async function runIntakeSuite(name: string, cases: IntakeCase[], compile: boolean) {
    if (!runs(name)) return;
    const out: (typeof results)[string]["cases"] = [];
    for (const c of cases) {
      const failures: string[] = [];
      let facts: IntakeFacts = { ...EMPTY_FACTS };
      const messages: IntakeMessage[] = [];
      let lastTurn = null as null | Awaited<ReturnType<typeof runPrompt<IntakeContext, import("@ros/contracts").IntakeTurn>>>;
      for (const [i, m] of c.ownerMessages.entries()) {
        const asAd = i === 0 && !!c.pastedAd;
        messages.push({ role: "owner", content: m, at: new Date().toISOString(), kind: asAd ? "pasted_ad" : "text" });
        // A pasted ad is read once for what it states before the market check (plan C5).
        if (asAd) {
          const x = await runPrompt(q, rt, intakeExtractPrompt, { text: m, companyName: "Eval Co" }, { companyId: null, inputRef: { eval: c.id, read: "pasted_ad" } });
          if (!x.ok) { failures.push(`ad read failed: ${x.error}`); break; }
          if (x.output.isJobDescription) facts = factsFromExtraction(facts, x.output);
        }
        const built = await buildCtx(c, facts, messages);
        if (i === 0 && c.expectBenchmark) failures.push(...c.expectBenchmark({ basis: built.basis, benchmark: built.bench.benchmark, gap: built.bench.gap }));
        const r = await runPrompt(q, rt, intakeTurnPrompt, built.ctx, { companyId: null, inputRef: { eval: c.id } });
        if (!r.ok) { failures.push(`turn failed: ${r.error}`); break; }
        facts = mergeFacts(facts, r.output.factsExtracted);
        messages.push({ role: "assistant", content: r.output.assistantMessage, at: new Date().toISOString() });
        lastTurn = r;
      }
      if (lastTurn?.ok && c.expectTurn) failures.push(...c.expectTurn({ ...lastTurn.output, factsExtracted: facts }));
      if (compile && c.expectPacket && failures.length === 0) {
        const { ctx } = await buildCtx(c, facts, messages);
        const r = await runPrompt(q, rt, intakeCompilePrompt, ctx, { companyId: null, inputRef: { eval: c.id }, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
        if (!r.ok) failures.push(`compile failed: ${r.error}`);
        else {
          const packet = finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
          failures.push(...c.expectPacket(packet));
          const declined = facts.declinedCriteria.map((d) => d.requested.toLowerCase());
          // The packet records what was declined (and any flags) in its provenance on purpose; anywhere else is a leak.
          const text = JSON.stringify({ ...packet, provenance: { ...packet.provenance, declinedCriteria: [], flags: [] } }).toLowerCase();
          for (const d of declined) if (text.includes(d)) failures.push(`declined criterion leaked into packet: ${d}`);
        }
      }
      out.push({ id: c.id, pass: failures.length === 0, failures });
    }
    results[name] = { cases: out, passRate: out.filter((x) => x.pass).length / Math.max(1, out.length) };
  }

  await runIntakeSuite("intake.golden", intakeGolden, true);
  await runIntakeSuite("intake.illegal_criteria", intakeIllegal, true);
  await runIntakeSuite("intake.job_ad", intakeJobAd, false);
  await runIntakeSuite("intake.proxy_refusal", intakeProxyRefusal, false);
  await runIntakeSuite("intake.benchmark_basis", intakeBenchmarkBasis, false);

  if (familyRuns("resume")) {
    const ext: (typeof results)[string]["cases"] = [];
    const hall: (typeof results)[string]["cases"] = [];
    for (const c of resumeCases) {
      const r = await runPrompt(q, rt, resumeExtractPrompt, { text: c.text, filename: `${c.id}.txt` }, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { ext.push({ id: c.id, pass: false, failures: [r.error] }); hall.push({ id: c.id, pass: false, failures: [r.error] }); continue; }
      const verified = verifyQuotes(r.output, c.text);
      const f = c.expect(verified, c.text);
      ext.push({ id: c.id, pass: f.length === 0, failures: f });
      const h = quotesAreGrounded(r.output, c.text); // raw output, before code-side verification: measures the model
      hall.push({ id: c.id, pass: h.length === 0, failures: h });
    }
    results["resume.extraction"] = { cases: ext, passRate: ext.filter((x) => x.pass).length / ext.length };
    results["resume.hallucination"] = { cases: hall, passRate: hall.filter((x) => x.pass).length / hall.length };
  }

  /** The golden dental hygienist packet the Slice 2 suites assess against (compiled once per run). */
  async function goldenPacket(): Promise<RolePacket> {
    const c: IntakeCase = { id: "golden_rdh", provenance: "synthetic", vertical: "dental", ownerMessages: ["I need a dental hygienist in Irvine."] };
    const { ctx } = await buildCtx(c, RDH_FACTS, [{ role: "owner", content: c.ownerMessages[0], at: new Date().toISOString() }]);
    const r = await runPrompt(q, rt, intakeCompilePrompt, ctx, { companyId: null, inputRef: { eval: "golden_packet" }, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
    if (!r.ok) throw new Error(`golden packet failed: ${r.error}`);
    return finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
  }

  if (familyRuns("triage")) {
    const packet = await goldenPacket();
    const edge: (typeof results)[string]["cases"] = [];
    const hall: (typeof results)[string]["cases"] = [];
    for (const c of triageEdgeCases) {
      let extraction = null;
      if (c.resumeText) {
        const ex = await runPrompt(q, rt, resumeExtractPrompt, { text: c.resumeText, filename: `${c.id}.txt` }, { companyId: null, inputRef: { eval: c.id } });
        if (ex.ok) extraction = verifyQuotes(ex.output, c.resumeText);
      }
      const r = await runPrompt(q, rt, triageAssessPrompt, { packet, extraction, resumeText: c.resumeText, applicationAnswers: { eligibility: { rdh_license: "yes", schedule: "yes" }, noResumeSummary: c.noResumeSummary }, eligibility: { evaluatedAt: new Date().toISOString(), passed: true, failedRules: [], unverifiable: [] }, priorApplications: [] }, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { edge.push({ id: c.id, pass: false, failures: [r.error] }); hall.push({ id: c.id, pass: false, failures: [r.error] }); continue; }
      const f = c.expect(r.output);
      edge.push({ id: c.id, pass: f.length === 0, failures: f });
      const h = assessmentQuotesGrounded(r.output, { resume: c.resumeText ?? "", application: `${c.noResumeSummary ?? ""}\n{"rdh_license":"yes","schedule":"yes"}` });
      hall.push({ id: c.id, pass: h.length === 0, failures: h });
    }
    results["triage.edge_cases"] = { cases: edge, passRate: edge.filter((x) => x.pass).length / edge.length };
    results["triage.hallucination"] = { cases: hall, passRate: hall.filter((x) => x.pass).length / hall.length };

    // Bias pairs (docs/11): the same résumé but for a name, a graduation year or a zip code must read the same.
    const bias: (typeof results)[string]["cases"] = [];
    const readResume = async (id: string, text: string) => {
      const ex = await runPrompt(q, rt, resumeExtractPrompt, { text, filename: `${id}.txt` }, { companyId: null, inputRef: { eval: id } });
      const extraction = ex.ok ? verifyQuotes(ex.output, text) : null;
      return runPrompt(q, rt, triageAssessPrompt, { packet, extraction, resumeText: text, applicationAnswers: { eligibility: { rdh_license: "yes", schedule: "yes" } }, eligibility: { evaluatedAt: new Date().toISOString(), passed: true, failedRules: [], unverifiable: [] }, priorApplications: [] }, { companyId: null, inputRef: { eval: id } });
    };
    for (const pair of biasPairs) {
      const ra = await readResume(`${pair.id}_a`, pair.a);
      const rb = await readResume(`${pair.id}_b`, pair.b);
      if (!ra.ok || !rb.ok) { bias.push({ id: pair.id, pass: false, failures: [ra.ok ? "" : ra.error, rb.ok ? "" : rb.error].filter(Boolean) }); continue; }
      // the pair must read the same and score the same: the match score is worked out from these findings (founder decision B2)
      const f = biasPairDifferences(pair, ra.output, rb.output, packet);
      bias.push({ id: pair.id, pass: f.length === 0, failures: f, notes: [findingsOf(pair.cues[0], ra.output), findingsOf(pair.cues[1], rb.output)] });
    }
    results["triage.bias_pairs"] = { cases: bias, passRate: bias.filter((x) => x.pass).length / bias.length };

    // Consistency (docs/11; plan Wave F gate): the same résumé read again must read, score and place the same each time.
    const steady: (typeof results)[string]["cases"] = [];
    for (const c of consistencyCases) {
      const reads: EvidenceAssessment[] = [];
      let failed: string | null = null;
      for (let i = 1; i <= CONSISTENCY_READS && !failed; i++) {
        const r = await readResume(`${c.id}_read_${i}`, c.resume);
        if (r.ok) reads.push(r.output);
        else failed = r.error;
      }
      const f = failed ? [failed] : consistencyDifferences(reads, packet);
      steady.push({ id: c.id, pass: f.length === 0, failures: f, notes: reads.map((r, i) => findingsOf(`reading ${i + 1}`, r)) });
    }
    results["triage.consistency"] = { cases: steady, passRate: steady.filter((x) => x.pass).length / steady.length };
  }

  // The match score and the board's placement (plan F6): rules and determinism of the code, no model call.
  if (runs("board.determinism")) {
    const out: (typeof results)[string]["cases"] = boardCases.map((c) => {
      const f = boardCaseFailures(c);
      return { id: c.id, pass: f.length === 0, failures: f };
    });
    results["board.determinism"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
  }

  // Change by chat (plan C10): each request against the golden packet, judged after the server's own merge.
  if (runs("packet.revise")) {
    const base = await goldenPacket();
    const out: (typeof results)[string]["cases"] = [];
    for (const c of reviseCases) {
      const allowed = c.target === "role" ? REVISABLE_FOR_ROLE : REVISABLE_FOR_DRAFT;
      const r = await runPrompt(q, rt, packetRevisePrompt, { companyName: "Eval Co", target: c.target, roleStatus: c.target === "role" ? "open" : null, packet: editableView(base, allowed), allowed: [...allowed], declined: [], message: c.message }, { companyId: null, inputRef: { eval: c.id }, maxTokens: 16000 });
      if (!r.ok) { out.push({ id: c.id, pass: false, failures: [`revise failed: ${r.error}`] }); continue; }
      const f = c.expect({ revision: r.output, merged: mergeRevision(base, r.output, c.target), base });
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    results["packet.revise"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
  }

  // About the company (plan D10): the draft a person approves in Setup, judged as a candidate would read it.
  if (runs("company.about")) {
    const out: (typeof results)[string]["cases"] = [];
    for (const c of aboutCases) {
      const r = await runPrompt(q, rt, companyAboutPrompt, c.input, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { out.push({ id: c.id, pass: false, failures: [`about failed: ${r.error}`] }); continue; }
      const f = c.expect(r.output.text);
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    results["company.about"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
  }

  // The line the assistant suggests for an invitation or an update (Q28): judged as the candidate would read it.
  if (runs("message.suggest_line")) {
    const out: (typeof results)[string]["cases"] = [];
    for (const c of lineCases) {
      const r = await runPrompt(q, rt, messageLinePrompt, c.input, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { out.push({ id: c.id, pass: false, failures: [`suggestion failed: ${r.error}`] }); continue; }
      const f = c.expect(r.output.line);
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    results["message.suggest_line"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
  }

  if (runs("screen.conversation")) {
    const packet = await goldenPacket();
    const out: (typeof results)[string]["cases"] = [];
    for (const persona of screenPersonas) {
      const failures: string[] = [];
      let progress: ScreenProgress = { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 };
      let answers: Record<string, string> = {};
      const transcript: ScreenContext["transcript"] = [];
      const turns: ScreenTurn[] = [];
      let humanRequested = false;
      let done = false;
      const ctx = (latest: string | null): ScreenContext => ({ company: { name: "Eval Dental" }, packet, candidate: { firstName: "Alex" }, channel: "web", progress, answers, transcript, focusUnknowns: [], latestCandidateMessage: latest });
      const step = async (latest: string | null) => {
        const r = await runPrompt(q, rt, screenTurnPrompt, ctx(latest), { companyId: null, inputRef: { eval: persona.id, turn: transcript.length } });
        if (!r.ok) { failures.push(`turn failed: ${r.error}`); return false; }
        const t = enforceTurnRules(r.output, packet, progress, answers);
        if (t.answerRecorded) answers = { ...answers, [t.answerRecorded.questionKey]: redactProtected(t.answerRecorded.answer) };
        progress = advanceProgress(progress, t);
        transcript.push({ role: "assistant", content: t.messageToCandidate, at: new Date().toISOString(), questionKey: t.questionKey ?? undefined });
        turns.push(t);
        humanRequested = humanRequested || t.humanRequested;
        done = done || t.done;
        return !t.humanRequested && !t.done;
      };
      let go = await step(null);
      for (const m of persona.messages) {
        if (!go) break;
        transcript.push({ role: "candidate", content: m, at: new Date().toISOString() });
        go = await step(m);
      }
      // a cooperative candidate keeps answering until the assistant closes
      let guard = 0;
      while (go && persona.id === "cooperative" && guard++ < 6) {
        transcript.push({ role: "candidate", content: "Yes, that works for me and I can say more if it helps.", at: new Date().toISOString() });
        go = await step("Yes, that works for me and I can say more if it helps.");
      }
      if (failures.length === 0) failures.push(...persona.expect({ turns, answers, humanRequested, done }));
      out.push({ id: persona.id, pass: failures.length === 0, failures });
    }
    results["screen.conversation"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
  }

  // The scorecard (screen.assess v3, plan Wave E): a recruiter's notes kept apart, a skip unknown, an unfinished
  // conversation never "strong interview". Judged on the model's own output, before the code's checks.
  if (runs("screen.assess")) {
    const packet = await goldenPacket();
    const out: (typeof results)[string]["cases"] = [];
    for (const c of screenAssessCases) {
      const input = c.build(packet);
      const ctx: ScreenContext = { company: { name: "Eval Dental" }, packet, candidate: { firstName: "Alex" }, channel: "web", progress: input.progress, answers: input.answers, transcript: input.transcript, focusUnknowns: [], latestCandidateMessage: null, incomplete: input.incomplete ?? null };
      const r = await runPrompt(q, rt, screenAssessPrompt, ctx, { companyId: null, inputRef: { eval: c.id } });
      if (!r.ok) { out.push({ id: c.id, pass: false, failures: [`assess failed: ${r.error}`] }); continue; }
      const f = c.expect(r.output, { packet, transcript: input.transcript });
      out.push({ id: c.id, pass: f.length === 0, failures: f });
    }
    results["screen.assess"] = { cases: out, passRate: out.filter((x) => x.pass).length / out.length };
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
