import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider, createRuntime, intakeCompilePrompt, intakeTurnPrompt, resumeExtractPrompt, runPrompt, screenTurnPrompt, triageAssessPrompt, type AiRuntime, type IntakeContext, type ScreenContext } from "@ros/ai";
import { advanceProgress, enforceTurnRules, finalizePacket, mergeFacts, redactProtected, registerFakeHandlers, verifyQuotes } from "@ros/agents";
import type { IntakeFacts, IntakeMessage, RolePacket, ScreenProgress, ScreenTurn } from "@ros/contracts";
import { createDb, migrate } from "@ros/db";
import { compensationFor, findPlaybook, matchPlaybookRole } from "@ros/playbooks";
import { EMPTY_FACTS, RDH_FACTS, assessmentQuotesGrounded, intakeGolden, intakeIllegal, quotesAreGrounded, resumeCases, screenPersonas, triageEdgeCases, type IntakeCase } from "./suites";

/**
 * Evaluation runner (docs/11). `pnpm eval` runs every suite against the configured provider
 * (fake by default; AI_PROVIDER=anthropic with a key runs the real models) and writes a result file.
 * A prompt version is promoted only when suites meet thresholds.json and a human signs the result.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const onlySuite = args.includes("--suite") ? args[args.indexOf("--suite") + 1] : null;

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
  const results: Record<string, { cases: Array<{ id: string; pass: boolean; failures: string[]; costUsd?: number }>; passRate: number }> = {};

  const buildCtx = (c: IntakeCase, facts: IntakeFacts, messages: IntakeMessage[]): IntakeContext => {
    const playbook = findPlaybook(c.vertical);
    const role = playbook ? matchPlaybookRole(playbook, facts.title ?? c.ownerMessages[0]) : null;
    const comp = role ? compensationFor(role, facts.locationText ?? "Irvine, CA") : null;
    return {
      company: { name: "Eval Co", vertical: c.vertical, sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }] },
      playbook, playbookRole: role,
      benchmark: comp ? { basis: comp.basis, p25: comp.p25, p50: comp.p50, p75: comp.p75, source: comp.source, metro: comp.metro } : null,
      facts, messages,
    };
  };

  async function runIntakeSuite(name: string, cases: IntakeCase[], compile: boolean) {
    if (onlySuite && onlySuite !== name) return;
    const out: (typeof results)[string]["cases"] = [];
    for (const c of cases) {
      const failures: string[] = [];
      let facts: IntakeFacts = { ...EMPTY_FACTS };
      const messages: IntakeMessage[] = [];
      let lastTurn = null as null | Awaited<ReturnType<typeof runPrompt<IntakeContext, import("@ros/contracts").IntakeTurn>>>;
      for (const m of c.ownerMessages) {
        messages.push({ role: "owner", content: m, at: new Date().toISOString() });
        const r = await runPrompt(q, rt, intakeTurnPrompt, buildCtx(c, facts, messages), { companyId: null, inputRef: { eval: c.id } });
        if (!r.ok) { failures.push(`turn failed: ${r.error}`); break; }
        facts = mergeFacts(facts, r.output.factsExtracted);
        messages.push({ role: "assistant", content: r.output.assistantMessage, at: new Date().toISOString() });
        lastTurn = r;
      }
      if (lastTurn?.ok && c.expectTurn) failures.push(...c.expectTurn({ ...lastTurn.output, factsExtracted: facts }));
      if (compile && c.expectPacket && failures.length === 0) {
        const ctx = buildCtx(c, facts, messages);
        const r = await runPrompt(q, rt, intakeCompilePrompt, ctx, { companyId: null, inputRef: { eval: c.id }, maxTokens: 24000 });
        if (!r.ok) failures.push(`compile failed: ${r.error}`);
        else {
          const packet = finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
          failures.push(...c.expectPacket(packet));
          const declined = facts.declinedCriteria.map((d) => d.requested.toLowerCase());
          const text = JSON.stringify(packet).toLowerCase();
          for (const d of declined) if (text.includes(d)) failures.push(`declined criterion leaked into packet: ${d}`);
        }
      }
      out.push({ id: c.id, pass: failures.length === 0, failures });
    }
    results[name] = { cases: out, passRate: out.filter((x) => x.pass).length / Math.max(1, out.length) };
  }

  await runIntakeSuite("intake.golden", intakeGolden, true);
  await runIntakeSuite("intake.illegal_criteria", intakeIllegal, true);

  if (!onlySuite || onlySuite.startsWith("resume")) {
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
    const ctx = buildCtx(c, RDH_FACTS, [{ role: "owner", content: c.ownerMessages[0], at: new Date().toISOString() }]);
    const r = await runPrompt(q, rt, intakeCompilePrompt, ctx, { companyId: null, inputRef: { eval: "golden_packet" }, maxTokens: 24000 });
    if (!r.ok) throw new Error(`golden packet failed: ${r.error}`);
    return finalizePacket(r.output, ctx, { sessionId: "eval", aiRunId: r.runId });
  }

  if (!onlySuite || onlySuite.startsWith("triage")) {
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
  }

  if (!onlySuite || onlySuite.startsWith("screen")) {
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

  const thresholds = JSON.parse(readFileSync(join(here, "..", "thresholds.json"), "utf8")) as Record<string, { minPassRate: number }>;
  let ok = true;
  for (const [suite, r] of Object.entries(results)) {
    const min = thresholds[suite]?.minPassRate ?? 1;
    const pass = r.passRate >= min;
    ok = ok && pass;
    console.log(`${pass ? "PASS" : "FAIL"} ${suite}: ${(r.passRate * 100).toFixed(0)}% (min ${(min * 100).toFixed(0)}%)`);
    for (const c of r.cases) if (!c.pass) console.log(`   × ${c.id}: ${c.failures.join("; ")}`);
  }
  const dir = join(here, "..", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${rt.provider.id}.json`);
  writeFileSync(file, JSON.stringify({ provider: rt.provider.id, models: rt.models, results }, null, 2));
  console.log(`results: ${file}`);
  await handle.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
