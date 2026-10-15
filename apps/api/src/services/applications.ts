import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { SCREEN_PERSON_ROUTE_STATUSES, inspectResumeFile, type Actor } from "@ros/contracts";
import { fromAddress, queueCommunication, replyToFor, sendPrivacyCompletion, sendRepeatApplicationNotice, sendStatusLinks, statusUrlFor } from "@ros/agents";
import { CLOSING_DATE_REASON, audit, createDataRequest, dedupeKey, emit, fulfilWithdrawal, normalizeEmailForDedupe, normalizePhone, transition } from "@ros/core";
import { applications, candidates, companies, documents, events, interviews, lowercaseToken, randomToken, rolePackets, roles, screens, uuidv7, withPlatform, withTenant, type ApplicationAcknowledgment, type ConsentRecord, type Db, type Tx } from "@ros/db";
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
export async function createApplication(tx: Tx, container: Container, input: NewApplication, actor: Actor, opts: { intoTalentPool?: boolean; closingGrace?: boolean } = {}) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) throw new Error("role not found");
  // `closingGrace`: a form opened before the role's closing date passed may still be sent (plan D7; services/closing-date.ts).
  const admits = (role.status === "open" && role.acceptingApplications) || (!!opts.intoTalentPool && role.status === "closed") || (!!opts.closingGrace && role.status === "open" && role.applicationsClosedReason === CLOSING_DATE_REASON);
  if (!admits || !role.currentPacketVersion) throw new Error("role is not accepting applications");

  const email = input.email ? input.email.trim().toLowerCase() : null;
  const phone = normalizePhone(input.phone);
  const key = dedupeKey(email, phone);
  const now = new Date().toISOString();

  let candidate = key ? (await tx.select().from(candidates).where(and(eq(candidates.companyId, input.companyId), eq(candidates.dedupeKey, key))).limit(1))[0] : undefined;
  // Whether the company already had this person before this submission: the one-visit flow then never greets the name on
  // file nor adds what was typed to their record without the address owner's say-so (services/apply-conversation.ts).
  let knownPerson = !!candidate;
  if (!candidate) {
    const created = await insertCandidateOnce(tx, { companyId: input.companyId, firstName: input.firstName, lastName: input.lastName, email, phone, locationText: input.locationText ?? null, dedupeKey: key, firstSource: input.source, consent: consentOf(input, now) });
    candidate = created.candidate;
    knownPerson = !created.inserted;
    if (created.inserted) {
      await emit(tx, { type: "candidate.created", companyId: input.companyId, actor, subject: { type: "candidate", id: candidate.id }, payload: { source: input.source } });
      if (input.smsConsent) await emit(tx, { type: "consent.granted", companyId: input.companyId, actor: { kind: "candidate", id: candidate.id }, subject: { type: "candidate", id: candidate.id }, payload: { purpose: "sms", source: input.consentSource } });
    }
  }

  const [existing] = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
  if (existing) {
    await settleRepeatSubmission(tx, container, { input, actor, application: existing, candidate, roleTitle: role.title });
    return { application: existing, candidate, duplicate: true, knownPerson: true };
  }
  // Two submissions for the same role and person at the same moment (a double press): the second waits for the first's
  // row, finds it, and is settled as a repeat instead of failing on the unique key (known-bugs row 78).
  const [inserted] = await tx
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
    .onConflictDoNothing({ target: [applications.roleId, applications.candidateId] })
    .returning();
  if (!inserted) {
    const [raced] = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
    if (!raced) throw new Error("the application could not be recorded");
    await settleRepeatSubmission(tx, container, { input, actor, application: raced, candidate, roleTitle: role.title });
    return { application: raced, candidate, duplicate: true, knownPerson: true };
  }
  let application = inserted;

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
  return { application, candidate, duplicate: false, knownPerson };
}

/**
 * What the new person's consent record says, honestly by channel (known-bugs row 16). The apply form showed the
 * application terms and the AI notice and the person ticked the box, so both are recorded with the versions shown. An
 * application that arrived by email saw no form: nothing is recorded as granted. What they do get is the acknowledgment
 * email, queued in the intake workflow's first step, which carries the AI disclosure line and their status link (whose
 * page has "How AI is used"); `notices_by_email` says so, with `granted: false` because nothing was agreed to. No AI
 * reads their application until that email has actually gone (the intake workflow's `ai_notice` step, which then moves
 * `at` to when it went); if it never goes, nothing is read by AI and the team reviews it.
 */
export function consentOf(input: Pick<NewApplication, "consentSource" | "acknowledgment" | "noticeVersionsShown" | "smsConsent" | "ip">, now: string): ConsentRecord {
  const out: ConsentRecord = {};
  if (input.consentSource === "email_in") out.notices_by_email = { granted: false, at: now, source: input.consentSource, noticeVersion: "acknowledgment_email" };
  else {
    out.application_terms = { granted: true, at: now, source: input.consentSource, ip: input.ip, ...(input.acknowledgment ? { acknowledged: true } : {}) };
    out.ai_notice = { granted: true, at: now, source: input.consentSource, noticeVersion: input.noticeVersionsShown.join(",") };
  }
  if (input.smsConsent) out.sms = { granted: true, at: now, source: input.consentSource, ip: input.ip };
  return out;
}

/**
 * Adds a person under their address key, or finds the one another submission added at the same moment (known-bugs row
 * 78): the insert waits for the other transaction's row on the company's unique key and then does nothing, and the
 * person is read again. `inserted` says which happened.
 */
export async function insertCandidateOnce(tx: Tx, values: typeof candidates.$inferInsert): Promise<{ candidate: Candidate; inserted: boolean }> {
  const [row] = await tx.insert(candidates).values(values).onConflictDoNothing({ target: [candidates.companyId, candidates.dedupeKey] }).returning();
  if (row) return { candidate: row, inserted: true };
  const [found] = values.dedupeKey ? await tx.select().from(candidates).where(and(eq(candidates.companyId, values.companyId), eq(candidates.dedupeKey, values.dedupeKey))).limit(1) : [];
  if (!found) throw new Error("the candidate could not be recorded");
  return { candidate: found, inserted: false };
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
  const match = addressMatch(typedEmail);
  if (!match) return 0;
  // No tenant is known yet: the address is looked up across companies, then each company's part runs as that company.
  const people = await withPlatform(deps.db, (tx) => tx.select({ id: candidates.id, companyId: candidates.companyId }).from(candidates).where(and(match, isNull(candidates.anonymizedAt))).limit(20));
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

/**
 * The one address-matching rule for finding a person by a typed address (known-bugs row 68), shared by "Lost your link?"
 * and the public privacy form: the folded key the company de-duplicates on (case, Gmail's dots, a plus part), or the
 * exact address on file (a record written before its key was re-keyed). Null for something that is not an address.
 */
export function addressMatch(typedEmail: string): SQL | null {
  const key = dedupeKey(typedEmail, null);
  if (!key) return null;
  return or(eq(candidates.dedupeKey, key), eq(candidates.email, typedEmail.trim().toLowerCase())) ?? null;
}

/**
 * "Get a new link" on the status page (known-bugs row 48): the private link is replaced by a new random one, the old one
 * stops working at once, and the new one goes by email to the address on file, never to the page (whoever pressed the
 * button may be someone the link was forwarded to). The email is recorded like every other candidate email. Returns the
 * masked-ready address it went to, or null when there is no address on file (the page then says to reply to an email).
 */
export async function rotateStatusLink(container: Container, applicationId: string, companyId: string): Promise<{ emailedTo: string | null }> {
  const now = container.engine.clock();
  return withTenant(container.db, companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, applicationId)).limit(1).for("update");
    if (!app) return { emailedTo: null };
    const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
    const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
    const token = randomToken(24);
    const [fresh] = await tx.update(applications).set({ statusToken: token }).where(eq(applications.id, app.id)).returning();
    // The links the old status page showed stop working too (Wave S5 review): the open screening chat and the interview
    // scheduling pages get new random links, which the new status page shows; the old ones could still cancel or
    // reschedule an interview, or carry on the chat.
    for (const iv of await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["scheduling", "scheduled"]), isNotNull(interviews.scheduleToken)))) {
      await tx.update(interviews).set({ scheduleToken: randomToken(24) }).where(eq(interviews.id, iv.id));
    }
    for (const s of await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, [...SCREEN_PERSON_ROUTE_STATUSES])))) {
      await tx.update(screens).set({ token: randomToken(24) }).where(eq(screens.id, s.id));
    }
    if (!candidate?.email || !company) return { emailedTo: null };
    const roleTitle = role?.title ?? "your application";
    const text = `Hi ${candidate.firstName},

You asked for a new link to your application for ${roleTitle} at ${company.name}. Here it is:
${statusUrlFor(container.env.JOBS_BASE_URL, fresh)}

The old link no longer works, so anyone you shared it with can no longer open your status page. The links in our earlier emails to your screening chat or your interview times have changed too: open them from your application page. Keep this email: there is no account or password.

If you did not ask for this, reply to this email and a person will look into it.

The hiring team at ${company.name}`;
    // The key names the rotation by a hash of the new link, never the link itself.
    await queueCommunication(tx, container.integrations, {
      channel: "email",
      companyId: company.id,
      candidateId: candidate.id,
      applicationId: app.id,
      to: candidate.email,
      from: fromAddress(company, container.integrations),
      replyTo: replyToFor(fresh, container.integrations),
      subject: `Your new application link: ${company.name}`,
      text,
      templateKey: "status_link_new",
      idempotencyKey: `status_link_new:${app.id}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
      tags: { template: "status_link_new", applicationId: app.id },
      actor: { kind: "candidate", id: candidate.id },
      disclosureIncluded: false,
    }, now);
    return { emailedTo: candidate.email };
  });
}

/**
 * A withdrawal is also a recorded request, fulfilled at once, so the audit trail and the confirmation email are the same
 * however the candidate withdrew: the status page's button, or "Yes, withdraw my application" in the screening chat
 * (known-bugs row 74). Runs as the platform after the withdrawal committed (the tenant role cannot write that table).
 */
export async function recordWithdrawal(container: Container, app: { id: string; companyId: string; candidateId: string }, via: "status_page" | "screening_chat"): Promise<void> {
  await withPlatform(container.db, async (tx) => {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const actor = { kind: "candidate" as const, id: app.candidateId };
    const req = await createDataRequest(tx, {
      companyId: app.companyId,
      kind: "withdrawal",
      requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`,
      candidateId: app.candidateId,
      applicationId: app.id,
      channel: "status_page",
      verified: true,
      ...(via === "screening_chat" ? { details: "Withdrawn in the screening chat.", verificationNote: "the request came through the candidate's own screening chat link" } : {}),
      actor,
      now: container.engine.clock(),
    });
    const done = await fulfilWithdrawal(tx, req, actor, container.engine.clock());
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
    if (cand?.email) await sendPrivacyCompletion(tx, container.integrations, { row: done, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
  });
}

export { normalizeEmailForDedupe };
