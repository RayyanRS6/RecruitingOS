import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { dedupeKey, emit, normalizeEmailForDedupe, normalizePhone } from "@ros/core";
import { applications, candidates, documents, randomToken, roles, uuidv7, type Tx } from "@ros/db";
import { documentToText } from "@ros/agents";
import type { Container } from "../container";

export type NewApplication = {
  companyId: string;
  roleId: string;
  source: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  locationText?: string | null;
  smsConsent: boolean;
  consentSource: string;
  noticeVersionsShown: string[];
  eligibilityAnswers: Record<string, unknown>;
  noResumeAnswers?: Record<string, string>;
  resume?: { filename: string; mime: string; bytes: Uint8Array } | null;
  ip?: string;
  note?: string;
};

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
    application_terms: { granted: true, at: now, source: input.consentSource, ip: input.ip },
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
        stage: "applied",
        answers: { eligibility: input.eligibilityAnswers, noResume: input.noResumeAnswers, noticeVersionsShown: input.noticeVersionsShown },
        statusToken: randomToken(24),
      })
      .returning();
  }

  if (input.resume && !application.resumeDocumentId) {
    const sha256 = createHash("sha256").update(input.resume.bytes).digest("hex");
    const storageKey = `${input.companyId}/${application.id}/${uuidv7()}-${input.resume.filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    await container.integrations.storage.put(storageKey, input.resume.bytes, input.resume.mime);
    const text = await documentToText(input.resume.bytes, input.resume.mime, input.resume.filename);
    const [doc] = await tx
      .insert(documents)
      .values({ companyId: input.companyId, candidateId: candidate.id, applicationId: application.id, kind: "resume", filename: input.resume.filename, mime: input.resume.mime, sizeBytes: input.resume.bytes.byteLength, storageKey, sha256, textExtracted: text || null })
      .returning();
    await tx.update(applications).set({ resumeDocumentId: doc.id }).where(eq(applications.id, application.id));
    application = { ...application, resumeDocumentId: doc.id };
  }

  if (!duplicate) {
    await emit(tx, { type: "application.received", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { roleId: role.id, source: input.source, hasResume: !!application.resumeDocumentId, note: input.note ?? null } });
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
