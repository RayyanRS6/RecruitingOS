import { eq } from "drizzle-orm";
import { MAX_RESUME_BYTES, inspectResumeFile, type QuickQuestionView, type ResumeExtraction } from "@ros/contracts";
import { resumeExtractPrompt, runPromptDetached, type AiRuntime } from "@ros/ai";
import { cvLinesOf, documentToText, verifyQuotes } from "@ros/agents";
import { scrubAiRun } from "@ros/core";
import { aiRuns, documents, withTenant, type Db, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { DISCARD_OBJECT_JOB_KIND, type WorkflowEngine } from "@ros/workflows";

/**
 * Reading a résumé for the apply form (Wave S7, spec steps 2 to 4, slice S7-B): the candidate chooses their résumé
 * first and the form fills in their name, email, phone, place and a short summary of their work, each marked "From your
 * resume — check it", and suggests answers to the company's quick questions where the résumé says so plainly.
 *
 * The reading is the existing `resume.extract` task (Haiku 5.5, the existing schema), run by the worker as a job: the
 * app never opens a file that has not been scanned (founder decision 2; the malware engine is reachable from the worker
 * only), so the job inspects the bytes, scans them, extracts the text and then asks the model, exactly as the intake
 * workflow does. Its result is a small JSON record next to the quarantined file (`readingKey`), which the form reads;
 * nothing about the person is written to an event. When the application is sent, the reading's AI run is tied to the
 * application and its résumé document (`linkResumeReading`), so the intake workflow reuses it instead of reading the
 * file a second time, and a deletion request finds and scrubs it with the rest. A reading nobody sent is removed after a
 * day: the record and the file by the existing discard job, the AI run's words by `RESUME_READING_EXPIRE_JOB_KIND`.
 */

/** The job that reads one uploaded résumé for the form. */
export const RESUME_READING_JOB_KIND = "apply.read_resume";
/** The job that, a day later, scrubs the words of a reading that never became part of an application. */
export const RESUME_READING_EXPIRE_JOB_KIND = "apply.read_resume_expire";
/** How long a reading and its file are kept when nobody sends the application. */
export const RESUME_READING_KEEP_MS = 24 * 3_600_000;
/** How long the form may still attach a résumé it has read (the grant the form carries), so checking the details is never rushed. */
export const READ_GRANT_TTL_SECONDS = 2 * 3600;
/** How long the request that asked for a reading waits for it before showing "Reading your resume…" with a Continue button. */
export const READ_WAIT_MS = 25_000;
const READ_POLL_MS = 700;

/** Which upload a reading is about: the sealed grant's own fields. */
export type ResumeReadRef = { companyId: string; roleId: string; uploadId: string; key: string; filename: string; mime: string };

/** The details the form fills in. Empty strings for what the résumé does not say. */
export type ResumeDetails = { firstName: string; lastName: string; email: string; phone: string; locationText: string; workSummary: string };

/** What the suggestions for the quick questions may rest on: only what the résumé states. */
export type ResumeFacts = {
  locationText: string;
  years: number | null;
  credentials: Array<{ name: string; jurisdiction: string | null; expires: string | null; quote: string }>;
  skills: string[];
  languages: string[];
};

/**
 * The reading, as the form sees it. `read`: the details were filled in; `unreadable`: no words could be read from the
 * file (a scan without a text layer); `refused`: the file is not a résumé file or the scanner flagged it; `failed`: the
 * reading could not run (the assistant or the scanner did not answer). The candidate fills in the form themselves in
 * every case but `read`. `cvLines`: the résumé's positions, licences and skills as the chat names them (`cvLinesOf`,
 * the same lines an application's chat reads), so the chat offered in this visit can name the CV and ask about what it
 * does not show; absent on a reading written before Wave S7's fixes.
 */
export type ResumeReading = { v: 1; uploadId: string; outcome: "read" | "unreadable" | "refused" | "failed"; aiRunId: string | null; readAt: string; details: ResumeDetails | null; facts: ResumeFacts | null; cvLines?: string[] };

export type ReadingDeps = { db: Db; ai: AiRuntime; integrations: Integrations; engine: Pick<WorkflowEngine, "enqueue"> };

/** Where a reading's record lives: beside its quarantined file, under the company's own quarantine area. */
export function readingKey(ref: Pick<ResumeReadRef, "companyId" | "roleId" | "uploadId">): string {
  return `quarantine/${ref.companyId}/${ref.roleId}/${ref.uploadId}.read.json`;
}

/** The reading for an upload, once the worker wrote it; null while it runs (or when it never ran). */
export async function readingFor(storage: Integrations["storage"], ref: Pick<ResumeReadRef, "companyId" | "roleId" | "uploadId">): Promise<ResumeReading | null> {
  const bytes = await storage.get(readingKey(ref));
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ResumeReading;
    return parsed && parsed.v === 1 && parsed.uploadId === ref.uploadId ? parsed : null;
  } catch {
    return null;
  }
}

/** Waits for the worker's reading for up to `waitMs` (none when the worker runs inline and has already drained). */
export async function waitForReading(storage: Integrations["storage"], ref: Pick<ResumeReadRef, "companyId" | "roleId" | "uploadId">, waitMs: number): Promise<ResumeReading | null> {
  const until = Date.now() + waitMs;
  let found = await readingFor(storage, ref);
  while (!found && Date.now() + READ_POLL_MS <= until) {
    await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS));
    found = await readingFor(storage, ref);
  }
  return found;
}

/** Asks the worker to read an uploaded résumé. Safe to call twice: the job does nothing once a reading exists. */
export async function startResumeReading(deps: { db: Db; engine: Pick<WorkflowEngine, "enqueue"> }, ref: ResumeReadRef): Promise<void> {
  await deps.engine.enqueue(deps.db, { kind: RESUME_READING_JOB_KIND, payload: { ...ref }, maxAttempts: 3 });
}

function refOf(payload: Record<string, unknown>): ResumeReadRef | null {
  const s = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");
  const ref = { companyId: s("companyId"), roleId: s("roleId"), uploadId: s("uploadId"), key: s("key"), filename: s("filename"), mime: s("mime") };
  // Only the company's own quarantine area, and only the file the grant named.
  if (!ref.companyId || !ref.roleId || !ref.uploadId || !ref.key.startsWith(`quarantine/${ref.companyId}/${ref.roleId}/${ref.uploadId}.`)) return null;
  return ref;
}

/**
 * The worker's job: inspect, scan, extract the text, read it with `resume.extract`, check every quote against the text,
 * and write the reading. A scanner or an assistant that does not answer is tried again; on the last try the reading
 * says so, and the candidate fills in the form themselves. The clean-up of a reading nobody sends is queued with it.
 */
export async function runResumeReading(deps: ReadingDeps, payload: Record<string, unknown>, ctx: { attempt: number; maxAttempts: number; now: Date }): Promise<void> {
  const ref = refOf(payload);
  if (!ref) return;
  const { storage } = deps.integrations;
  if (await readingFor(storage, ref)) return;
  const last = ctx.attempt >= ctx.maxAttempts;
  const finish = async (outcome: ResumeReading["outcome"], aiRunId: string | null = null, extraction: ResumeExtraction | null = null) => {
    const reading: ResumeReading = { v: 1, uploadId: ref.uploadId, outcome, aiRunId, readAt: ctx.now.toISOString(), details: extraction ? detailsFrom(extraction) : null, facts: extraction ? factsFrom(extraction) : null, ...(extraction ? { cvLines: cvLinesOf(extraction) } : {}) };
    await storage.put(readingKey(ref), new TextEncoder().encode(JSON.stringify(reading)), "application/json");
    const runAt = new Date(ctx.now.getTime() + RESUME_READING_KEEP_MS);
    // The record always goes; the file only if no document row points at it by then (the discard job checks).
    for (const key of [readingKey(ref), ref.key]) await deps.engine.enqueue(deps.db, { kind: DISCARD_OBJECT_JOB_KIND, payload: { companyId: ref.companyId, key }, runAt });
    if (aiRunId) await deps.engine.enqueue(deps.db, { kind: RESUME_READING_EXPIRE_JOB_KIND, payload: { companyId: ref.companyId, aiRunId }, runAt });
  };
  try {
    await readAndFinish(deps, ref, last, finish);
  } catch (err) {
    // An unexpected failure (a corrupt file, an error nobody planned for) on the last try still writes the reading, so
    // the form stops waiting, and still queues the clean-up of the file and the record.
    if (!last) throw err;
    console.warn(`[apply] the résumé reading failed for good: ${err instanceof Error ? err.message : String(err)}`);
    await finish("failed");
  }
}

async function readAndFinish(deps: ReadingDeps, ref: ResumeReadRef, last: boolean, finish: (outcome: ResumeReading["outcome"], aiRunId?: string | null, extraction?: ResumeExtraction | null) => Promise<void>): Promise<void> {
  const { storage, scanner } = deps.integrations;
  const bytes = await storage.get(ref.key);
  if (!bytes) return finish("failed");
  if (bytes.byteLength > MAX_RESUME_BYTES) return finish("refused");
  const look = inspectResumeFile(bytes, { mime: ref.mime, filename: ref.filename });
  if (!look.ok) return finish("refused");
  const scan = await scanner.scan(bytes, { filename: ref.filename, mime: look.mime });
  if (scan.verdict === "error") {
    if (!last) throw new Error(`the résumé scanner did not answer: ${scan.detail ?? "unavailable"}`);
    return finish("failed");
  }
  if (scan.verdict === "infected") return finish("refused");
  const text = await documentToText(bytes, look.mime, ref.filename);
  if (!text.trim()) return finish("unreadable");
  const out = await runPromptDetached(deps.db, deps.ai, resumeExtractPrompt, { text, filename: ref.filename }, { companyId: ref.companyId, workflowRunId: null, inputRef: { uploadId: ref.uploadId, roleId: ref.roleId, purpose: "apply_form", chars: text.length } });
  if (!out.ok) {
    if (out.reason === "error" && !last) throw new Error(out.error);
    return finish("failed", out.runId);
  }
  return finish("read", out.runId, verifyQuotes(out.output, text));
}

/**
 * A day later: a reading that did not become part of an application (nobody sent it, or it was a repeat submission)
 * keeps only its bookkeeping in the AI run log; what the model read and wrote goes. One tied to an application stays
 * with it, and leaves with it on a deletion request.
 */
export async function expireResumeReading(db: Db, payload: Record<string, unknown>): Promise<void> {
  const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
  const aiRunId = typeof payload.aiRunId === "string" ? payload.aiRunId : "";
  if (!companyId || !aiRunId) return;
  await withTenant(db, companyId, async (q) => {
    const [run] = await q.select({ id: aiRuns.id, inputRef: aiRuns.inputRef, toolCalls: aiRuns.toolCalls, structuredOutput: aiRuns.structuredOutput, policyDecision: aiRuns.policyDecision, humanOverride: aiRuns.humanOverride, finalOutcome: aiRuns.finalOutcome, error: aiRuns.error }).from(aiRuns).where(eq(aiRuns.id, aiRunId)).limit(1);
    if (!run || run.inputRef.purpose !== "apply_form" || run.inputRef.applicationId) return;
    const { id, ...before } = run;
    await q.update(aiRuns).set(scrubAiRun(before)).where(eq(aiRuns.id, id));
  });
}

/** Registers both jobs on an engine: every process that may queue a reading, and the worker that runs it. */
export function registerApplyDetailsJobs(engine: Pick<WorkflowEngine, "registerJob" | "enqueue">, deps: Omit<ReadingDeps, "engine">): void {
  engine.registerJob(RESUME_READING_JOB_KIND, (payload, ctx) => runResumeReading({ ...deps, engine }, payload, ctx));
  engine.registerJob(RESUME_READING_EXPIRE_JOB_KIND, (payload) => expireResumeReading(deps.db, payload));
}

/**
 * When an application is created from a form whose résumé was read: the reading's AI run names the application and the
 * document (so a deletion request scrubs it, and the clean-up leaves it alone), and the document points at the run, so
 * the intake workflow reuses the reading once the file is checked instead of asking the model again. Only a run that
 * read exactly this upload, for this company, is tied.
 */
export async function linkResumeReading(q: Queryable, input: { aiRunId: string; uploadId: string; applicationId: string; documentId: string }): Promise<boolean> {
  const [run] = await q.select({ id: aiRuns.id, task: aiRuns.task, status: aiRuns.status, inputRef: aiRuns.inputRef }).from(aiRuns).where(eq(aiRuns.id, input.aiRunId)).limit(1);
  if (!run || run.task !== "resume.extract" || run.status !== "ok" || run.inputRef.uploadId !== input.uploadId || run.inputRef.purpose !== "apply_form") return false;
  await q.update(aiRuns).set({ inputRef: { ...run.inputRef, applicationId: input.applicationId, documentId: input.documentId } }).where(eq(aiRuns.id, run.id));
  await q.update(documents).set({ extractedByAiRunId: run.id }).where(eq(documents.id, input.documentId));
  return true;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* From the reading to the form                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

const clip = (s: string | undefined | null, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** "Dana Kept, RDH" → Dana / Kept: a credential after a comma is not part of the name. */
export function splitName(fullName: string | undefined): { firstName: string; lastName: string } {
  const fullNamePart = clip((fullName ?? "").split(",")[0], 160);
  if (!fullNamePart || /\d|@/.test(fullNamePart)) return { firstName: "", lastName: "" };
  const parts = fullNamePart.split(" ").filter(Boolean);
  if (parts.length < 2) return { firstName: clip(parts[0], 80), lastName: "" };
  return { firstName: clip(parts[0], 80), lastName: clip(parts.slice(1).join(" "), 80) };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The years of a position as the résumé gives them ("2019–present"); nothing when it gives none. */
function yearsOf(p: ResumeExtraction["positions"][number]): string {
  const start = clip(p.startDate, 20);
  const end = p.current ? "present" : clip(p.endDate, 20);
  if (!start && !end) return "";
  return ` (${start || "?"}–${end || "?"})`;
}

/**
 * The short summary of their work the form shows for checking: the résumé's own headline, its most recent positions,
 * its licenses and certificates, and the skills it names. Written in code from what the reading found; nothing added.
 */
export function workSummaryFrom(ex: ResumeExtraction): string {
  const lines: string[] = [];
  const headline = clip(ex.headline, 200);
  if (headline) lines.push(headline);
  for (const p of ex.positions.slice(0, 3)) {
    const title = clip(p.title, 100);
    if (!title) continue;
    const employer = clip(p.employer, 100);
    lines.push(`${title}${employer ? ` at ${employer}` : ""}${yearsOf(p)}`);
  }
  const creds = [...ex.licenses.map((l) => [clip(l.name, 40), clip(l.jurisdiction, 20)].filter(Boolean).join(", ")), ...ex.certifications.map((c) => clip(c.name, 40))].filter(Boolean);
  if (creds.length) lines.push(`Licenses and certificates: ${[...new Set(creds)].slice(0, 6).join("; ")}`);
  const skills = [...new Set(ex.skills.map((s) => clip(s, 40)).filter(Boolean))].slice(0, 8);
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
  return lines.join("\n").slice(0, 1000);
}

export function detailsFrom(ex: ResumeExtraction): ResumeDetails {
  const email = clip(ex.email, 120).toLowerCase();
  const phone = clip(ex.phone, 30);
  return {
    ...splitName(ex.fullName),
    email: EMAIL.test(email) ? email : "",
    phone: phone.replace(/\D/g, "").length >= 7 ? phone : "",
    locationText: clip(ex.locationText, 120),
    workSummary: workSummaryFrom(ex),
  };
}

export function factsFrom(ex: ResumeExtraction): ResumeFacts {
  return {
    locationText: clip(ex.locationText, 120),
    years: typeof ex.yearsOfExperienceEstimate === "number" && Number.isFinite(ex.yearsOfExperienceEstimate) && ex.yearsOfExperienceEstimate >= 0 ? Math.round(ex.yearsOfExperienceEstimate) : null,
    credentials: [
      ...ex.licenses.map((l) => ({ name: clip(l.name, 40), jurisdiction: clip(l.jurisdiction, 20) || null, expires: clip(l.expires, 30) || null, quote: clip(l.quote, 300) })),
      ...ex.certifications.map((c) => ({ name: clip(c.name, 40), jurisdiction: null, expires: null, quote: clip(c.quote, 300) })),
    ].filter((c) => !!c.name),
    skills: ex.skills.map((s) => clip(s, 60)).filter(Boolean).slice(0, 40),
    languages: ex.languages.map((s) => clip(s, 40)).filter(Boolean).slice(0, 10),
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Suggestions for the company's quick questions                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
/** A credential the résumé itself says is not current is never a "yes" (the licence rule of spec-s5: lapsed, expired, pending or unclear is not known). */
const NOT_CURRENT = /\b(?:expired|lapsed|inactive|pending|in progress|applied for|applying|will (?:sit|take)|exam (?:scheduled|in)|until \d{4}|suspended|revoked)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function credentialYes(question: string, facts: ResumeFacts, now: Date): boolean {
  const acronyms = [...new Set(question.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? [])];
  const states = acronyms.filter((a) => US_STATES.has(a));
  const named = acronyms.filter((a) => !US_STATES.has(a));
  if (!named.length) return false;
  return facts.credentials.some((c) => {
    if (!named.includes(c.name.toUpperCase())) return false;
    if (NOT_CURRENT.test(c.quote)) return false;
    if (c.expires) {
      const at = Date.parse(c.expires);
      if (!Number.isFinite(at) || at < now.getTime()) return false;
    }
    // A question about one state's licence is answered only by a licence the résumé places in that state.
    if (states.length && !(c.jurisdiction && states.includes(c.jurisdiction.toUpperCase()))) return false;
    return true;
  });
}

/**
 * An answer to suggest for one quick question, from what the résumé states plainly; null when it does not. Never a
 * "no" (a suggestion never puts an application on hold), never a schedule, and only one choice when exactly one fits:
 * yes to a credential question when the résumé names that credential as current (in the state the question names);
 * the option that is the résumé's own place, skill, credential or language; the years of experience for a number
 * question about years of experience. The candidate checks every suggestion ("Suggested from your resume — check it").
 */
export function suggestQuickAnswer(q: QuickQuestionView, facts: ResumeFacts | null, now: Date = new Date()): string | null {
  if (!facts) return null;
  if (q.kind === "yes_no") return credentialYes(q.question, facts, now) ? "yes" : null;
  if (q.kind === "choice") {
    const words = [facts.locationText, ...facts.locationText.split(","), ...facts.skills, ...facts.languages, ...facts.credentials.map((c) => c.name)].map(norm).filter((w) => w.length >= 2);
    const fits = q.options.filter((o) => {
      const opt = norm(o);
      return !!opt && words.some((w) => w === opt || ` ${w} `.includes(` ${opt} `));
    });
    return fits.length === 1 ? fits[0] : null;
  }
  if (q.kind === "number") {
    const aboutYears = /\byears?\b/i.test(`${q.unit ?? ""} ${q.question}`) && /\b(?:experience|worked|working|work)\b/i.test(q.question);
    if (!aboutYears || facts.years === null) return null;
    if ((q.min !== null && facts.years < q.min) || (q.max !== null && facts.years > q.max)) return null;
    return String(facts.years);
  }
  return null;
}
