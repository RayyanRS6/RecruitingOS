import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { inspectResumeFile, type Actor } from "@ros/contracts";
import { sendRepeatApplicationNotice, sendStatusLinks } from "@ros/agents";
import { audit, dedupeKey, emit, normalizeEmailForDedupe, normalizePhone, transition } from "@ros/core";
import { applications, candidates, companies, documents, events, lowercaseToken, randomToken, rolePackets, roles, uuidv7, withPlatform, withTenant, type ApplicationAcknowledgment, type Db, type Tx } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import type { Container } from "../container";
import { quarantineKey } from "../uploads";

type Application = typeof applications.$inferSelect;
type Candidate = typeof candidates.$inferSelect;

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
 * Creates the candidate (when the address is new) and the application, stores the resume, records consent, emits
 * the facts, and starts the application_intake workflow. Shared by the apply page, the inbound-email webhook, and
 * manual adds. Must run inside a tenant transaction.
 *
 * A submission never changes a person the company already has (Wave 0 item 0.1): anyone can type anyone's address
 * into a public form, so an existing record keeps its consent, phone, location and résumé exactly as they were. A
 * repeat submission for the same role creates nothing at all: the uploaded file is discarded, the team sees
 * `application.duplicate_detected`, and the address on file gets its own status link by email (at most once a day).
 * The caller shows the same receipt either way and never the existing application's link.
 *
 * Only a role that is open and taking applications admits a submission, the same rule as the apply form; email that
 * arrives while a role is paused or switched off is held by the webhook instead (C19) and replayed later.
 *
 * `intoTalentPool` is for an application that arrived by email while the role was paused or closed to applications
 * and was held (C19), when the role then closes instead of reopening: it is admitted to the closed role and moved at
 * once to the talent pool, exactly where the role's other active candidates went when it closed. It is never
 * acknowledged as if the role were still hiring (the intake workflow only acknowledges a fresh application); its
 * résumé is still scanned and read so the person can be found for a later opening.
 */
export async function createApplication(tx: Tx, container: Container, input: NewApplication, actor: Actor, opts: { intoTalentPool?: boolean } = {}) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) throw new Error("role not found");
  const admits = (role.status === "open" && role.acceptingApplications) || (!!opts.intoTalentPool && role.status === "closed");
  if (!admits || !role.currentPacketVersion) throw new Error("role is not accepting applications");

  const email = input.email ? input.email.trim().toLowerCase() : null;
  const phone = normalizePhone(input.phone);
  const key = dedupeKey(email, phone);
  const now = new Date().toISOString();

  let candidate = key ? (await tx.select().from(candidates).where(and(eq(candidates.companyId, input.companyId), eq(candidates.dedupeKey, key))).limit(1))[0] : undefined;
  if (!candidate) {
    const consent = {
      application_terms: { granted: true, at: now, source: input.consentSource, ip: input.ip, ...(input.acknowledgment ? { acknowledged: true } : {}) },
      ai_notice: { granted: true, at: now, source: input.consentSource, noticeVersion: input.noticeVersionsShown.join(",") },
      ...(input.smsConsent ? { sms: { granted: true, at: now, source: input.consentSource, ip: input.ip } } : {}),
    };
    [candidate] = await tx
      .insert(candidates)
      .values({ companyId: input.companyId, firstName: input.firstName, lastName: input.lastName, email, phone, locationText: input.locationText ?? null, dedupeKey: key, firstSource: input.source, consent })
      .returning();
    await emit(tx, { type: "candidate.created", companyId: input.companyId, actor, subject: { type: "candidate", id: candidate.id }, payload: { source: input.source } });
    if (input.smsConsent) await emit(tx, { type: "consent.granted", companyId: input.companyId, actor: { kind: "candidate", id: candidate.id }, subject: { type: "candidate", id: candidate.id }, payload: { purpose: "sms", source: input.consentSource } });
  }

  const [existing] = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
  if (existing) {
    await settleRepeatSubmission(tx, container, { input, actor, application: existing, candidate, roleTitle: role.title });
    return { application: existing, candidate, duplicate: true };
  }
  let [application] = await tx
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
      // The reply address's token (F12): its own random value, never the status token, lowercase because it travels in an email address.
      replyToken: lowercaseToken(16),
    })
    .returning();

  if (input.resume) {
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

  await emit(tx, { type: "application.received", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { roleId: role.id, source: input.source, linkId: input.linkId ?? null, hasResume: !!application.resumeDocumentId, note: input.note ?? null } });
  if (opts.intoTalentPool) {
    await transition(tx, { applicationId: application.id, companyId: input.companyId, to: "talent_pool", by: "system", actor, reason: "the role closed while this emailed application was held" });
    application = { ...application, stage: "talent_pool" };
  }
  await container.engine.start(tx, {
    workflowKey: "application_intake",
    companyId: input.companyId,
    subject: { type: "application", id: application.id },
    state: { applicationId: application.id, roleId: role.id },
    idempotencyKey: `application_intake:${application.id}`,
    actor,
  });
  return { application, candidate, duplicate: false };
}

/**
 * A second submission for a role the person already applied to. Nothing about the existing application or person
 * changes. A file the browser uploaded straight to storage for this submission is removed (only when no document
 * points at it); its grant was spent by this submission, so reusing it is refused the same way whatever happened here
 * (`uploadAlreadyUsed`). The fact is recorded, and the address on file, not the one typed, gets a short email with its
 * own status link.
 */
async function settleRepeatSubmission(tx: Tx, container: Container, input: { input: NewApplication; actor: Actor; application: Application; candidate: Candidate; roleTitle: string }): Promise<void> {
  const { application, candidate, actor } = input;
  const resume = input.input.resume;
  if (resume?.kind === "stored") {
    const [inUse] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.storageKey, resume.storageKey)).limit(1);
    if (!inUse) await container.integrations.storage.delete(resume.storageKey);
  }
  await emit(tx, { type: "application.duplicate_detected", companyId: application.companyId, actor, subject: { type: "application", id: application.id }, payload: { source: input.input.source } });
  const [company] = await tx.select().from(companies).where(eq(companies.id, application.companyId)).limit(1);
  if (!company || candidate.anonymizedAt) return;
  const [pv] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, application.roleId), eq(rolePackets.version, application.packetVersion))).limit(1);
  await sendRepeatApplicationNotice(tx, container.integrations, { application, candidate, company, roleTitle: pv?.packet.identity.title ?? input.roleTitle, signature: pv?.packet.communication.signature, appBaseUrl: container.env.JOBS_BASE_URL, actor: { kind: "system", id: "repeat_application" }, now: container.engine.clock() });
}

/**
 * A direct upload's grant attaches its file to one submission only (Wave 0 item 0.1). Used again, the apply page refuses
 * it like an expired one before the file is looked at. Otherwise the answer would depend on what the first submission
 * did with the file (a repeat discards it at once, a new application keeps it until the worker moves it) and so tell
 * whoever reused the grant whether the address they typed had applied before. The use is a fact on the role
 * (`document.upload_used`), recorded in the submission's own transaction.
 */
export async function uploadAlreadyUsed(tx: Tx, input: { roleId: string; uploadId: string }): Promise<boolean> {
  const [used] = await tx.select({ id: events.id }).from(events).where(and(eq(events.subjectType, "role"), eq(events.subjectId, input.roleId), eq(events.type, "document.upload_used"), sql`${events.payload}->>'uploadId' = ${input.uploadId}`)).limit(1);
  return !!used;
}

export async function markUploadUsed(tx: Tx, input: { companyId: string; roleId: string; uploadId: string }): Promise<void> {
  await emit(tx, { type: "document.upload_used", companyId: input.companyId, actor: { kind: "candidate", id: "applicant" }, subject: { type: "role", id: input.roleId }, payload: { uploadId: input.uploadId } });
}

/** The queue job that answers a "Lost your link?" request (registered in container.ts). */
export const LINK_REQUEST_JOB_KIND = "candidate.link_request";

/**
 * "Lost your link?" (Wave 0 item 0.1): the page only queues the request, the same single write whatever the address,
 * and answers at once; how long it takes says nothing about whether the address is known. The worker then runs
 * `emailStatusLinks`. The typed address lives in the job until the daily sweep removes finished jobs.
 */
export async function queueLinkRequest(container: Container, typedEmail: string): Promise<void> {
  await container.engine.enqueue(container.db, { kind: LINK_REQUEST_JOB_KIND, payload: { email: typedEmail.trim().toLowerCase() }, maxAttempts: 3 });
}

/**
 * The worker's half of "Lost your link?": every company that holds an application under this address emails the person
 * their own links there, to the address it has on file, at most once an hour per person. Whoever asked learns nothing:
 * the page answered the same whether or not anything was found. Returns how many emails were queued (for tests only).
 */
export async function emailStatusLinks(deps: { db: Db; integrations: Integrations; jobsBaseUrl: string }, typedEmail: string, now: Date): Promise<number> {
  const key = dedupeKey(typedEmail, null);
  if (!key) return 0;
  // No tenant is known yet: the address is looked up across companies, then each company's part runs as that company.
  const people = await withPlatform(deps.db, (tx) => tx.select({ id: candidates.id, companyId: candidates.companyId }).from(candidates).where(and(eq(candidates.dedupeKey, key), isNull(candidates.anonymizedAt))).limit(20));
  let queued = 0;
  for (const person of people) {
    await withTenant(deps.db, person.companyId, async (tx) => {
      const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, person.id)).limit(1);
      const [company] = await tx.select().from(companies).where(eq(companies.id, person.companyId)).limit(1);
      if (!candidate?.email || !company) return;
      const apps = await tx.select().from(applications).where(eq(applications.candidateId, candidate.id)).orderBy(desc(applications.createdAt)).limit(10);
      if (!apps.length) return;
      const titles = await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...new Set(apps.map((a) => a.roleId))]));
      const items = apps.map((application) => ({ application, roleTitle: titles.find((t) => t.id === application.roleId)?.title ?? "A role" }));
      if (await sendStatusLinks(tx, deps.integrations, { candidate, company, items, appBaseUrl: deps.jobsBaseUrl, actor: { kind: "system", id: "link_request" }, now })) queued += 1;
    });
  }
  return queued;
}

export { normalizeEmailForDedupe };
