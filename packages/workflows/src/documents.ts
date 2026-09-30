import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { extensionFor, inspectResumeFile, MAX_RESUME_BYTES, type Actor } from "@ros/contracts";
import { audit, emit } from "@ros/core";
import { documents, uuidv7, withTenant, type Db, type Queryable } from "@ros/db";
import { documentToText } from "@ros/agents";
import type { Integrations } from "@ros/integrations";
import type { WorkflowEngine } from "./engine";

export type QuarantineOutcome = { outcome: "clean"; documentId: string; textLength: number } | { outcome: "rejected"; documentId: string; reason: string } | { outcome: "retry"; documentId: string; error: string } | { outcome: "skipped"; documentId: string };

/**
 * What the worker found in a quarantined file, before anything about it is written. `storageKey` is the quarantine key
 * the finding is about: the row is only updated while it still points there.
 */
export type QuarantineExamination =
  | { documentId: string; verdict: "skipped" }
  | { documentId: string; storageKey: string; verdict: "retry"; error: string }
  | { documentId: string; storageKey: string; verdict: "rejected"; reason: string; detail: string; infected: { engine: string } | null }
  | { documentId: string; storageKey: string; verdict: "clean"; finalKey: string; kind: string; mime: string; sizeBytes: number; sha256: string; text: string; scanEngine: string; scannerStatus: string };

/** The queued job that removes a stored object no live document row points at (payload `{ companyId, key }`). */
export const DISCARD_OBJECT_JOB_KIND = "document.discard_object";
/** How long a clean copy written before its row moved waits before the sweep looks at it; the step that wrote it is long done by then. */
const UNUSED_COPY_SWEEP_MS = 60 * 60_000;

type ScanDeps = { db: Db; integrations: Integrations; engine: Pick<WorkflowEngine, "enqueue" | "clock"> };

/**
 * The worker's half of résumé intake (founder decision 2), phase one, with no transaction open: read the quarantined
 * bytes, judge them by signature and structure, scan them (a network call to the malware engine that can take seconds),
 * and for a clean file write the copy at its fresh, unguessable tenant- and candidate-scoped key and extract the text.
 * Nothing about the row is written here and the quarantine copy stays where it is, so a phase two that never commits
 * leaves the row pointing at a file that still exists. A sweep is queued before the clean copy is written; it removes
 * that copy later unless a row by then points at it. Safe to repeat.
 */
export async function examineQuarantinedDocument(deps: ScanDeps, input: { documentId: string; companyId: string; now?: Date }): Promise<QuarantineExamination> {
  const { integrations } = deps;
  const doc = await withTenant(deps.db, input.companyId, async (q) => (await q.select().from(documents).where(eq(documents.id, input.documentId)).limit(1))[0]);
  if (!doc || doc.companyId !== input.companyId || doc.status !== "quarantined") return { documentId: input.documentId, verdict: "skipped" };
  const base = { documentId: doc.id, storageKey: doc.storageKey };
  const reject = (reason: string, detail: string, infected: { engine: string } | null = null): QuarantineExamination => ({ ...base, verdict: "rejected", reason, detail, infected });

  const bytes = await integrations.storage.get(doc.storageKey);
  if (!bytes) return reject("missing", "the uploaded file was not found in quarantine");
  if (bytes.byteLength > MAX_RESUME_BYTES) return reject("too_large", "the file is larger than 8 MB");
  const look = inspectResumeFile(bytes, { mime: doc.mime, filename: doc.filename });
  if (!look.ok) return reject(look.reason, look.detail);

  const scan = await integrations.scanner.scan(bytes, { filename: doc.filename, mime: look.mime });
  if (scan.verdict === "error") return { ...base, verdict: "retry", error: scan.detail ?? "scanner unavailable" };
  if (scan.verdict === "infected") return reject("infected", `the file was flagged by the scanner${scan.signature ? ` (${scan.signature})` : ""}`, { engine: scan.engine });

  const finalKey = `${doc.companyId}/${doc.candidateId ?? "no-candidate"}/${doc.applicationId ?? "no-application"}/${uuidv7()}.${extensionFor(look.kind, doc.filename)}`;
  const now = input.now ?? deps.engine.clock();
  await deps.engine.enqueue(deps.db, { kind: DISCARD_OBJECT_JOB_KIND, payload: { companyId: doc.companyId, key: finalKey }, runAt: new Date(now.getTime() + UNUSED_COPY_SWEEP_MS) });
  await integrations.storage.put(finalKey, bytes, look.mime);
  const text = await documentToText(bytes, look.mime, doc.filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ...base, verdict: "clean", finalKey, kind: look.kind, mime: look.mime, sizeBytes: bytes.byteLength, sha256, text, scanEngine: scan.engine, scannerStatus: integrations.scanner.status };
}

/**
 * Phase two, inside the caller's tenant transaction: the verdict is written only if the row is still quarantined at the
 * key that was examined (another worker, or an earlier attempt, may have finished it). A refused file is recorded with
 * its reason; a clean one moves to its final key with its checksum and text. Nothing about the file's contents goes
 * into an event or an audit record. Returns the objects no row uses any more: the caller removes them only after this
 * transaction commits (`queueObjectDiscard`), so a rollback never leaves the row pointing at a deleted object.
 */
export async function recordQuarantineVerdict(q: Queryable, examination: QuarantineExamination, input: { companyId: string; actor: Actor; correlationId?: string; now?: Date }): Promise<{ outcome: QuarantineOutcome; discard: string[] }> {
  const now = input.now ?? new Date();
  if (examination.verdict === "skipped") return { outcome: { outcome: "skipped", documentId: examination.documentId }, discard: [] };
  if (examination.verdict === "retry") return { outcome: { outcome: "retry", documentId: examination.documentId, error: examination.error }, discard: [] };
  const unused = examination.verdict === "clean" ? [examination.finalKey] : [];
  const [doc] = await q.select().from(documents).where(eq(documents.id, examination.documentId)).limit(1);
  if (!doc || doc.companyId !== input.companyId || doc.status !== "quarantined" || doc.storageKey !== examination.storageKey) return { outcome: { outcome: "skipped", documentId: examination.documentId }, discard: unused };
  const subject = { type: "application" as const, id: doc.applicationId ?? doc.id };
  const stillQuarantined = and(eq(documents.id, doc.id), eq(documents.status, "quarantined"), eq(documents.storageKey, examination.storageKey));

  if (examination.verdict === "rejected") {
    const { reason, detail, infected } = examination;
    const moved = await q.update(documents).set({ status: "rejected", rejectedReason: reason, validatedAt: now.toISOString(), textExtracted: null, sha256: doc.sha256 === "pending" ? "rejected" : doc.sha256, ...(infected ? { scanEngine: infected.engine, scanVerdict: "infected" } : {}) }).where(stillQuarantined).returning({ id: documents.id });
    if (!moved.length) return { outcome: { outcome: "skipped", documentId: doc.id }, discard: [] };
    await emit(q, { type: "document.rejected", companyId: doc.companyId, actor: input.actor, subject, payload: { documentId: doc.id, reason, detail, via: doc.uploadedVia }, correlationId: input.correlationId });
    await audit(q, { companyId: doc.companyId, actor: input.actor, action: "document.rejected", target: { type: "document", id: doc.id }, reason, details: { applicationId: doc.applicationId, via: doc.uploadedVia, detail } });
    return { outcome: { outcome: "rejected", documentId: doc.id, reason }, discard: [doc.storageKey] };
  }

  const e = examination;
  const moved = await q.update(documents).set({ status: "clean", storageKey: e.finalKey, mime: e.mime, sizeBytes: e.sizeBytes, sha256: e.sha256, textExtracted: e.text || null, validatedAt: now.toISOString(), scanEngine: e.scanEngine, scanVerdict: "clean", rejectedReason: null }).where(stillQuarantined).returning({ id: documents.id });
  if (!moved.length) return { outcome: { outcome: "skipped", documentId: doc.id }, discard: unused };
  await emit(q, { type: "document.validated", companyId: doc.companyId, actor: input.actor, subject, payload: { documentId: doc.id, kind: e.kind, sizeBytes: e.sizeBytes, scanner: e.scanEngine, scannerStatus: e.scannerStatus, textLength: e.text.length }, correlationId: input.correlationId });
  return { outcome: { outcome: "clean", documentId: doc.id, textLength: e.text.length }, discard: [doc.storageKey] };
}

/** Queues the removal of objects no row uses any more, inside the caller's transaction: the jobs exist only if it commits. */
export async function queueObjectDiscard(q: Queryable, engine: Pick<WorkflowEngine, "enqueue">, input: { companyId: string; keys: string[] }): Promise<void> {
  for (const key of input.keys) await engine.enqueue(q, { kind: DISCARD_OBJECT_JOB_KIND, payload: { companyId: input.companyId, key } });
}

/**
 * The discard job: removes a stored object unless a live document row (quarantined or clean) points at it. Only the
 * company's own objects are touched (its quarantine area and its own prefix). Removing a missing object is not an error.
 */
export async function discardUnusedObject(db: Db, storage: Integrations["storage"], payload: Record<string, unknown>): Promise<void> {
  const companyId = String(payload.companyId ?? "");
  const key = String(payload.key ?? "");
  if (!companyId || !key) return;
  if (!key.startsWith(`${companyId}/`) && !key.startsWith(`quarantine/${companyId}/`)) return;
  const inUse = await withTenant(db, companyId, async (q) => (await q.select({ id: documents.id }).from(documents).where(and(eq(documents.storageKey, key), inArray(documents.status, ["quarantined", "clean"]))).limit(1)).length > 0);
  if (inUse) return;
  await storage.delete(key);
}

/**
 * Both phases for one document outside a workflow step (a manual re-run, the tests): the examination runs with no
 * transaction open, the verdict is written in its own tenant transaction, and the objects nobody uses are removed after
 * that transaction has committed.
 */
export async function processQuarantinedDocument(deps: ScanDeps, input: { documentId: string; companyId: string; actor: Actor; correlationId?: string; now?: Date }): Promise<QuarantineOutcome> {
  const examination = await examineQuarantinedDocument(deps, input);
  const { outcome, discard } = await withTenant(deps.db, input.companyId, (q) => recordQuarantineVerdict(q, examination, input));
  for (const key of discard) await deps.integrations.storage.delete(key);
  return outcome;
}
