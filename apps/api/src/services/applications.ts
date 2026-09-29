import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { inspectResumeFile, type Actor } from "@ros/contracts";
import { audit, dedupeKey, emit, normalizeEmailForDedupe, normalizePhone } from "@ros/core";
import { applications, candidates, documents, randomToken, roles, uuidv7, type ApplicationAcknowledgment, type Tx } from "@ros/db";
import type { Container } from "../container";
import { quarantineKey } from "../uploads";

export type NewApplication = {
  companyId: string;
  roleId: string;
  /** The source vocabulary of packages/core/src/application-links.ts; also the candidate's first source when new. */
  source: string;
  /** A referrer's name, a campaign label; never a tracking token (docs/spec/20 item 19). */
  sourceDetail?: string | null;
  /** The tracked link the candidate came through, resolved from the sealed cookie; never the token. */
  linkId?: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locationText?: string | null;
  smsConsent: boolean;
  consentSource: string;
  noticeVersionsShown: string[];
  /** The apply form's affirmative acknowledgment (docs/readiness/20 section D item 10); absent for email-in and manual adds, which have no form. */
  acknowledgment?: ApplicationAcknowledgment | null;
  eligibilityAnswers: Record<string, unknown>;
  noResumeAnswers?: Record<string, string>;
  resume?: ResumeInput | null;
  ip?: string;
  note?: string;
};

/**
 * A résumé arrives one of two ways: as bytes the application received itself (the no-script apply form, an inbound
 * email attachment), or already in storage under a quarantine key the browser uploaded to directly. Either way the
 * document starts as `quarantined`; the worker inspects and scans it, moves it to its final key and extracts the text.
 */
export type ResumeInput =
  | { kind: "bytes"; filename: string; mime: string; bytes: Uint8Array; via: "server" | "email" }
  | { kind: "stored"; filename: string; mime: string; storageKey: string; sizeBytes: number; via: "direct" };

/**
 * Creates (or updates) the candidate and application, stores the resume, records consent, emits the facts,
 * and starts the application_intake workflow. Shared by the apply page, the inbound-email webhook, and manual adds.
 * Must run inside a tenant transaction.
 */
export async function createApplication(tx: Tx, container: Container, input: NewApplication, actor: Actor) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) throw new Error("role not found");
  if (!["open", "paused"].includes(role.status) || !role.currentPacketVersion) throw new Error("role is not accepting applications");

  const email = input.email ? input.email.trim().toLowerCase() : null;
  const phone = normalizePhone(input.phone);
  const key = dedupeKey(email, phone);
  const now = new Date().toISOString();

  let candidate = key ? (await tx.select().from(candidates).where(and(eq(candidates.companyId, input.companyId), eq(candidates.dedupeKey, key))).limit(1))[0] : undefined;
  const consent = {
    ...(candidate?.consent ?? {}),
    application_terms: { granted: true, at: now, source: input.consentSource, ip: input.ip, ...(input.acknowledgment ? { acknowledged: true } : {}) },
    ai_notice: { granted: true, at: now, source: input.consentSource, noticeVersion: input.noticeVersionsShown.join(",") },
    ...(input.smsConsent ? { sms: { granted: true, at: now, source: input.consentSource, ip: input.ip } } : {}),
  };
  if (!candidate) {
    [candidate] = await tx
      .insert(candidates)
      .values({ companyId: input.companyId, firstName: input.firstName, lastName: input.lastName, email, phone, locationText: input.locationText ?? null, dedupeKey: key, firstSource: input.source, consent })
      .returning();
    await emit(tx, { type: "candidate.created", companyId: input.companyId, actor, subject: { type: "candidate", id: candidate.id }, payload: { source: input.source } });
  } else {
    await tx.update(candidates).set({ consent, email: candidate.email ?? email, phone: candidate.phone ?? phone, locationText: candidate.locationText ?? input.locationText ?? null }).where(eq(candidates.id, candidate.id));
  }
  for (const [purpose] of Object.entries(consent)) {
    if (purpose === "sms" && input.smsConsent) await emit(tx, { type: "consent.granted", companyId: input.companyId, actor: { kind: "candidate", id: candidate.id }, subject: { type: "candidate", id: candidate.id }, payload: { purpose, source: input.consentSource } });
  }

  const existing = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
  let application = existing[0];
  let duplicate = false;
  if (application) {
    duplicate = true;
    await emit(tx, { type: "application.duplicate_detected", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { source: input.source } });
  } else {
    [application] = await tx
      .insert(applications)
      .values({
        companyId: input.companyId,
        roleId: role.id,
        candidateId: candidate.id,
        packetVersion: role.currentPacketVersion,
        source: input.source,
        sourceDetail: input.sourceDetail ?? null,
        linkId: input.linkId ?? null,
        stage: "applied",
        answers: { eligibility: input.eligibilityAnswers, noResume: input.noResumeAnswers, noticeVersionsShown: input.noticeVersionsShown, ...(input.acknowledgment ? { acknowledgment: input.acknowledgment } : {}) },
        statusToken: randomToken(24),
      })
      .returning();
  }

  if (input.resume && !application.resumeDocumentId) {
    const r = input.resume;
    let stored: { storageKey: string; sizeBytes: number; sha256: string; mime: string } | null = null;
    let refusal: { reason: string; detail: string } | null = null;
    if (r.kind === "stored") {
      stored = { storageKey: r.storageKey, sizeBytes: r.sizeBytes, sha256: "pending", mime: r.mime };
    } else {
      // A quick look at the bytes before anything is kept; the worker repeats it in quarantine together with the scan.
      const look = inspectResumeFile(r.bytes, { mime: r.mime, filename: r.filename });
      if (!look.ok) refusal = { reason: look.reason, detail: look.detail };
      else {
        const storageKey = quarantineKey(input.companyId, role.id, uuidv7(), look.extension);
        await container.integrations.storage.put(storageKey, r.bytes, look.mime);
        stored = { storageKey, sizeBytes: r.bytes.byteLength, sha256: createHash("sha256").update(r.bytes).digest("hex"), mime: look.mime };
      }
    }
    if (refusal) {
      // Nothing is kept. The application continues without a résumé; the owner sees why on the candidate's page.
      await emit(tx, { type: "document.rejected", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { stage: "received", reason: refusal.reason, detail: refusal.detail, via: r.via } });
    } else if (stored) {
      const [doc] = await tx
        .insert(documents)
        .values({ companyId: input.companyId, candidateId: candidate.id, applicationId: application.id, kind: "resume", filename: r.filename.slice(0, 200), mime: stored.mime, sizeBytes: stored.sizeBytes, storageKey: stored.storageKey, sha256: stored.sha256, textExtracted: null, status: "quarantined", uploadedVia: r.via })
        .returning();
      await tx.update(applications).set({ resumeDocumentId: doc.id }).where(eq(applications.id, application.id));
      application = { ...application, resumeDocumentId: doc.id };
      await emit(tx, { type: "document.uploaded", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { documentId: doc.id, via: r.via, sizeBytes: stored.sizeBytes, mime: stored.mime } });
      await audit(tx, { companyId: input.companyId, actor, action: "document.uploaded", target: { type: "document", id: doc.id }, ip: input.ip, details: { applicationId: application.id, via: r.via, sizeBytes: stored.sizeBytes, mime: stored.mime } });
    }
  }

  if (!duplicate) {
    await emit(tx, { type: "application.received", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { roleId: role.id, source: input.source, linkId: input.linkId ?? null, hasResume: !!application.resumeDocumentId, note: input.note ?? null } });
    await container.engine.start(tx, {
      workflowKey: "application_intake",
      companyId: input.companyId,
      subject: { type: "application", id: application.id },
      state: { applicationId: application.id, roleId: role.id },
      idempotencyKey: `application_intake:${application.id}`,
      actor,
    });
  }
  return { application, candidate, duplicate };
}

export { normalizeEmailForDedupe };
