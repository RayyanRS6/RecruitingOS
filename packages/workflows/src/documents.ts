import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { extensionFor, inspectResumeFile, MAX_RESUME_BYTES, type Actor } from "@ros/contracts";
import { audit, emit } from "@ros/core";
import { documents, uuidv7, type Queryable } from "@ros/db";
import { documentToText } from "@ros/agents";
import type { Integrations } from "@ros/integrations";

export type QuarantineOutcome = { outcome: "clean"; documentId: string; textLength: number } | { outcome: "rejected"; documentId: string; reason: string } | { outcome: "retry"; documentId: string; error: string } | { outcome: "skipped"; documentId: string };

/**
 * The worker's half of résumé intake (founder decision 2): read the quarantined bytes, judge them by signature and
 * structure, scan them, and only then move the file to its final tenant- and candidate-scoped key, record the checksum
 * and extract the text. A refused file is removed and the reason recorded; a scanner outage leaves the file in
 * quarantine for another attempt. Nothing about the file's contents is written to an event or an audit record.
 */
export async function processQuarantinedDocument(q: Queryable, integrations: Integrations, input: { documentId: string; companyId: string; actor: Actor; correlationId?: string; now?: Date }): Promise<QuarantineOutcome> {
  const now = input.now ?? new Date();
  const [doc] = await q.select().from(documents).where(eq(documents.id, input.documentId)).limit(1);
  if (!doc || doc.companyId !== input.companyId) return { outcome: "skipped", documentId: input.documentId };
  if (doc.status !== "quarantined") return { outcome: "skipped", documentId: doc.id };
  const subject = { type: "application" as const, id: doc.applicationId ?? doc.id };

  const reject = async (reason: string, detail: string): Promise<QuarantineOutcome> => {
    await integrations.storage.delete(doc.storageKey);
    await q.update(documents).set({ status: "rejected", rejectedReason: reason, validatedAt: now.toISOString(), textExtracted: null, sha256: doc.sha256 === "pending" ? "rejected" : doc.sha256 }).where(eq(documents.id, doc.id));
    await emit(q, { type: "document.rejected", companyId: doc.companyId, actor: input.actor, subject, payload: { documentId: doc.id, reason, detail, via: doc.uploadedVia }, correlationId: input.correlationId });
    await audit(q, { companyId: doc.companyId, actor: input.actor, action: "document.rejected", target: { type: "document", id: doc.id }, reason, details: { applicationId: doc.applicationId, via: doc.uploadedVia, detail } });
    return { outcome: "rejected", documentId: doc.id, reason };
  };

  const bytes = await integrations.storage.get(doc.storageKey);
  if (!bytes) return reject("missing", "the uploaded file was not found in quarantine");
  if (bytes.byteLength > MAX_RESUME_BYTES) return reject("too_large", "the file is larger than 8 MB");
  const look = inspectResumeFile(bytes, { mime: doc.mime, filename: doc.filename });
  if (!look.ok) return reject(look.reason, look.detail);

  const scan = await integrations.scanner.scan(bytes, { filename: doc.filename, mime: look.mime });
  if (scan.verdict === "error") return { outcome: "retry", documentId: doc.id, error: scan.detail ?? "scanner unavailable" };
  if (scan.verdict === "infected") {
    await q.update(documents).set({ scanEngine: scan.engine, scanVerdict: "infected" }).where(eq(documents.id, doc.id));
    return reject("infected", `the file was flagged by the scanner${scan.signature ? ` (${scan.signature})` : ""}`);
  }

  // Clean: a fresh, unguessable final key under the tenant and candidate; the quarantine copy goes away.
  const finalKey = `${doc.companyId}/${doc.candidateId ?? "no-candidate"}/${doc.applicationId ?? "no-application"}/${uuidv7()}.${extensionFor(look.kind, doc.filename)}`;
  await integrations.storage.put(finalKey, bytes, look.mime);
  await integrations.storage.delete(doc.storageKey);
  const text = await documentToText(bytes, look.mime, doc.filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await q.update(documents).set({ status: "clean", storageKey: finalKey, mime: look.mime, sizeBytes: bytes.byteLength, sha256, textExtracted: text || null, validatedAt: now.toISOString(), scanEngine: scan.engine, scanVerdict: "clean", rejectedReason: null }).where(eq(documents.id, doc.id));
  await emit(q, { type: "document.validated", companyId: doc.companyId, actor: input.actor, subject, payload: { documentId: doc.id, kind: look.kind, sizeBytes: bytes.byteLength, scanner: scan.engine, scannerStatus: integrations.scanner.status, textLength: text.length }, correlationId: input.correlationId });
  return { outcome: "clean", documentId: doc.id, textLength: text.length };
}
