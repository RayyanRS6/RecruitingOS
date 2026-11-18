import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, appPaths, inspectResumeFile, trialPaused, type Actor, type FormAnswers } from "@ros/contracts";
import { fromAddress, queueCommunication, replyToFor, sendPrivacyCompletion, sendRepeatApplicationNotice, sendStatusLinks, statusUrlFor } from "@ros/agents";
import { CANDIDATE_LOCK_ACTOR, CLOSING_DATE_REASON, audit, createDataRequest, decideLock, dedupeKey, emit, errorForLog, fulfilWithdrawal, jobPastItsLimit, mayWithdraw, normalizeEmailForDedupe, normalizePhone, notify, tellMoreApplied, transition } from "@ros/core";
import { applications, candidates, companies, documents, events, randomToken, rolePackets, roles, screens, uuidv7, withPlatform, withTenant, type ApplicationAcknowledgment, type ConsentRecord, type Db, type Tx } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { cancelAiInterview } from "@ros/workflows";
import type { Container } from "../container";
import { quarantineKey } from "../uploads";

type Application = typeof applications.$inferSelect;
type Candidate = typeof candidates.$inferSelect;

export type NewApplication = {
  companyId: string;
  roleId: string;
  /** Where they came from: the job page's `?src=` word (`applySourceLabel` names it); also the candidate's first source when new. */
  source: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  consentSource: string;
  noticeVersionsShown: string[];
  /** The apply form's affirmative acknowledgment: when it was ticked, and which notice versions stood above it. */
  acknowledgment: ApplicationAcknowledgment;
  /** Their answers to the job's screening questions, by question key. */
  answers: FormAnswers;
  resume?: ResumeInput | null;
  ip?: string;
};

/**
 * A CV arrives one of two ways: as bytes the application received itself (the apply form sent without script), or
 * already in storage under a quarantine key the browser uploaded to directly. Either way the
 * document starts as `quarantined`; the worker inspects and scans it, moves it to its final key and extracts the text.
 */
export type ResumeInput =
  | { kind: "bytes"; filename: string; mime: string; bytes: Uint8Array; via: "server" }
  | { kind: "stored"; filename: string; mime: string; storageKey: string; sizeBytes: number; via: "direct" };

/**
 * Creates the candidate (when the address is new) and the application, stores the CV, records the consent, emits the
 * facts, and starts the application_intake workflow. Must run inside a tenant transaction.
 *
 * A submission never changes a person the company already has: anyone can type anyone's address into a public form, so
 * an existing record keeps its consent, phone and CV exactly as they were. A repeat submission for the same job creates
 * nothing at all: the uploaded file is discarded, the fact is recorded, and the address on file gets its own status link
 * by email (at most once a day). The caller shows the same receipt either way and never the existing application's link.
 *
 * Only a job that is open and taking applications admits a submission, the same rule as the apply form.
 *
 * The only place applications are born, so the only place a place is decided: past the plan's candidates per job, in
 * arrival order, the application is locked. A repeat is not a new row and keeps what it has. `onFile`: what the page
 * says next, from the job and never from the address typed, so a repeat on a job past its limit reads as a new address does.
 */
export async function createApplication(tx: Tx, container: Container, input: NewApplication, actor: Actor, opts: { closingGrace?: boolean; trialGrace?: boolean; files?: KeptBytes[] } = {}) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId)).limit(1);
  if (!role) throw new Error("role not found");
  // `closingGrace`: a form opened before the job's closing date passed may still be sent (services/closing-date.ts).
  const admits = (role.status === "open" && role.acceptingApplications) || (!!opts.closingGrace && role.status === "open" && role.applicationsClosedReason === CLOSING_DATE_REASON);
  if (!admits || !role.currentPacketVersion) throw new Error("role is not accepting applications");
  // A trial that ended takes no new application, refused the way a job not taking applications is; `trialGrace` is for a
  // form opened before the end (pages/apply-form.tsx).
  if (!opts.trialGrace) {
    const [company] = await tx.select({ planKey: companies.planKey, settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    if (company && trialPaused(company, container.engine.clock())) throw new Error("role is not accepting applications");
  }

  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const key = dedupeKey(email, phone);
  const now = new Date().toISOString();

  let candidate = key ? (await tx.select().from(candidates).where(and(eq(candidates.companyId, input.companyId), eq(candidates.dedupeKey, key))).limit(1))[0] : undefined;
  if (!candidate) {
    const created = await insertCandidateOnce(tx, { companyId: input.companyId, firstName: input.firstName, lastName: input.lastName, email, phone, dedupeKey: key, firstSource: input.source, consent: consentOf(input, now) });
    candidate = created.candidate;
    if (created.inserted) await emit(tx, { type: "candidate.created", companyId: input.companyId, actor, subject: { type: "candidate", id: candidate.id }, payload: { source: input.source } });
  }

  const [existing] = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
  if (existing) {
    await settleRepeatSubmission(tx, container, { input, actor, application: existing, candidate, roleTitle: role.title });
    return { application: existing, candidate, duplicate: true, onFile: await jobPastItsLimit(tx, { companyId: input.companyId, roleId: role.id }) };
  }
  // A file the application received itself is stored before the job's lock, never behind it: a slow write would hold up everyone
  // applying to the job until they time out. Nothing keeps the file if what follows fails (`dropKept`), a lock timeout included,
  // or if the caller's transaction then does not commit (`opts.files`, from `withNewApplication`).
  const kept = input.resume?.kind === "bytes" ? await keepResumeBytes(container, input.companyId, role.id, input.resume) : null;
  try {
    const placed = await placeApplication(tx, container, { input, actor, role, packetVersion: role.currentPacketVersion, candidate, kept });
    if (kept && !placed.duplicate) opts.files?.push(kept);
    return placed;
  } catch (err) {
    await dropKept(container, kept);
    throw err;
  }
}

/**
 * The transaction an application is born in. Storage is no part of a transaction, so a file it received itself and stored goes
 * if this one does not commit, whatever stopped it after the application was made: nothing would ever point at that file, and
 * no privacy request could find it.
 */
export async function withNewApplication<T>(container: Container, companyId: string, run: (tx: Tx, files: KeptBytes[]) => Promise<T>): Promise<T> {
  const files: KeptBytes[] = [];
  try {
    return await withTenant(container.db, companyId, (tx) => run(tx, files));
  } catch (err) {
    for (const kept of files) await dropKept(container, kept);
    throw err;
  }
}

/** What became of a file the application received itself: stored in quarantine, or refused by the quick look before anything was kept. */
type KeptBytes = { stored: { storageKey: string; sizeBytes: number; sha256: string; mime: string } | null; refusal: { reason: string; detail: string } | null };

/** A quick look at the bytes before anything is kept; the worker repeats it in quarantine together with the scan. */
async function keepResumeBytes(container: Container, companyId: string, roleId: string, r: Extract<ResumeInput, { kind: "bytes" }>): Promise<KeptBytes> {
  const look = inspectResumeFile(r.bytes, { mime: r.mime, filename: r.filename });
  if (!look.ok) return { stored: null, refusal: { reason: look.reason, detail: look.detail } };
  const storageKey = quarantineKey(companyId, roleId, uuidv7(), look.extension);
  await container.integrations.storage.put(storageKey, r.bytes, look.mime);
  return { stored: { storageKey, sizeBytes: r.bytes.byteLength, sha256: createHash("sha256").update(r.bytes).digest("hex"), mime: look.mime }, refusal: null };
}

/** A stored file nothing will point at. A failure here never hides what went wrong: it is only left for the bucket's own rules. */
async function dropKept(container: Container, kept: KeptBytes | null): Promise<void> {
  if (!kept?.stored) return;
  try {
    await container.integrations.storage.delete(kept.stored.storageKey);
  } catch (err) {
    console.warn(`[applications] could not remove a file nothing points at: ${errorForLog(err)}`);
  }
}

/** The new application behind the job's lock, with its place, its résumé and its intake (`createApplication`). */
async function placeApplication(tx: Tx, container: Container, args: { input: NewApplication; actor: Actor; role: typeof roles.$inferSelect; packetVersion: number; candidate: Candidate; kept: KeptBytes | null }) {
  const { input, actor, role, packetVersion, candidate, kept } = args;
  // Decided behind the job's lock, held until this commits: two people applying at the same moment take different places.
  const locked = await decideLock(tx, { companyId: input.companyId, roleId: role.id });
  // Two submissions for the same role and person at the same moment (a double press): the second waits for the first's
  // row, finds it, and is settled as a repeat instead of failing on the unique key.
  const [inserted] = await tx
    .insert(applications)
    .values({
      companyId: input.companyId,
      roleId: role.id,
      candidateId: candidate.id,
      packetVersion,
      source: input.source,
      stage: "applied",
      answers: { form: input.answers, noticeVersionsShown: input.noticeVersionsShown, acknowledgment: input.acknowledgment },
      statusToken: randomToken(24),
      lockedAt: locked ? container.engine.clock().toISOString() : null,
    })
    .onConflictDoNothing({ target: [applications.roleId, applications.candidateId] })
    .returning();
  if (!inserted) {
    const [raced] = await tx.select().from(applications).where(and(eq(applications.roleId, role.id), eq(applications.candidateId, candidate.id))).limit(1);
    if (!raced) throw new Error("the application could not be recorded");
    await dropKept(container, kept);
    await settleRepeatSubmission(tx, container, { input, actor, application: raced, candidate, roleTitle: role.title });
    return { application: raced, candidate, duplicate: true, onFile: await jobPastItsLimit(tx, { companyId: input.companyId, roleId: role.id }) };
  }
  let application = inserted;

  if (input.resume) {
    const r = input.resume;
    let stored: { storageKey: string; sizeBytes: number; sha256: string; mime: string } | null = null;
    let refusal: { reason: string; detail: string } | null = null;
    if (r.kind === "stored") {
      stored = { storageKey: r.storageKey, sizeBytes: r.sizeBytes, sha256: "pending", mime: r.mime };
    } else if (kept) {
      ({ stored, refusal } = kept);
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

  await emit(tx, { type: "application.received", companyId: input.companyId, actor, subject: { type: "application", id: application.id }, payload: { roleId: role.id, source: input.source, hasResume: !!application.resumeDocumentId } });
  // The reason must be provable, and is arrival order alone: the place, the limit and the plan. No name, never a score.
  if (locked) {
    await emit(tx, { type: "application.locked", companyId: input.companyId, actor: CANDIDATE_LOCK_ACTOR, subject: { type: "application", id: application.id }, payload: locked });
    await audit(tx, { companyId: input.companyId, actor: CANDIDATE_LOCK_ACTOR, action: "application.locked", target: { type: "application", id: application.id }, details: locked });
    // All the team hears of it: behind the job's lock, so two at the same moment send one.
    await tellMoreApplied(tx, { companyId: input.companyId, roleId: role.id, roleTitle: role.title });
  }
  await container.engine.start(tx, { workflowKey: "application_intake", companyId: input.companyId, subject: { type: "application", id: application.id }, state: { applicationId: application.id, roleId: role.id }, idempotencyKey: `application_intake:${application.id}`, actor });
  return { application, candidate, duplicate: false, onFile: !!locked };
}

/** What the new person's consent record says: the apply form showed the application terms and the AI notice and the person ticked the box, so both are recorded with the versions shown. */
export function consentOf(input: Pick<NewApplication, "consentSource" | "noticeVersionsShown" | "ip">, now: string): ConsentRecord {
  return {
    application_terms: { granted: true, at: now, source: input.consentSource, ip: input.ip, acknowledged: true },
    ai_notice: { granted: true, at: now, source: input.consentSource, noticeVersion: input.noticeVersionsShown.join(",") },
  };
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
 * A direct upload's grant attaches its file to one submission only. Used again, the apply page refuses
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
 * "Lost your link?": the page only queues the request, the same single write whatever the address,
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
 * The one address-matching rule for finding a person by a typed address, shared by "Lost your link?"
 * and the public privacy form: the folded key the company de-duplicates on (case, Gmail's dots, a plus part), or the
 * exact address on file (a record written before its key was re-keyed). Null for something that is not an address.
 */
export function addressMatch(typedEmail: string): SQL | null {
  const key = dedupeKey(typedEmail, null);
  if (!key) return null;
  return or(eq(candidates.dedupeKey, key), eq(candidates.email, typedEmail.trim().toLowerCase())) ?? null;
}

/**
 * "Get a new link" on the status page: the private link is replaced by a new random one, the old one
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
    // The link the old status page showed to an open AI interview stops working too: it gets a new random one, which the
    // new status page shows; the old one could still carry on the chat.
    for (const s of await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, [...SCREEN_ACTIVE_STATUSES])))) {
      await tx.update(screens).set({ token: randomToken(24) }).where(eq(screens.id, s.id));
    }
    if (!candidate?.email || !company) return { emailedTo: null };
    const roleTitle = role?.title ?? "your application";
    const text = `Hi ${candidate.firstName},

You asked for a new link to your application for ${roleTitle} at ${company.name}. Here it is:
${statusUrlFor(container.env.JOBS_BASE_URL, fresh)}

The old link no longer works, so anyone you shared it with can no longer open your status page. The link in our earlier emails to your AI interview has changed too: open it from your status page. Keep this email: there is no account or password.

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
      replyTo: replyToFor(container.integrations),
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
 * The candidate withdraws, from their status page or inside the AI interview: the application moves to Withdrew, an AI
 * interview still open is closed with its run, and the team gets one update saying they withdrew. In the caller's
 * transaction; the recorded request and its confirmation email follow the commit (`recordWithdrawal`). False, and
 * nothing done, when they may not withdraw any more (they were hired, told the decision, or already withdrew).
 */
export async function withdrawApplication(tx: Tx, container: Pick<Container, "engine">, input: { applicationId: string; via: "status_page" | "ai_interview" }): Promise<boolean> {
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1).for("update");
  if (!app || !mayWithdraw(app.stage, app.toldState)) return false;
  const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const actor = { kind: "candidate" as const, id: app.candidateId };
  const now = container.engine.clock();
  await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "withdrawn", by: "candidate", actor, reason: input.via === "ai_interview" ? "withdrawn in the AI interview" : "withdrawn from the status page", now });
  await emit(tx, { type: "application.withdrawn", companyId: app.companyId, actor, subject: { type: "application", id: app.id }, payload: { via: input.via, fromStage: app.stage } });
  await cancelAiInterview(tx, container.engine, { applicationId: app.id, actor, reason: "the candidate withdrew", now });
  await notify(tx, { companyId: app.companyId, about: app.id, kind: "candidate.withdrawn", title: `${`${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim() || "A candidate"} withdrew`, body: `They withdrew their application for ${role?.title ?? "the job"}${input.via === "ai_interview" ? " during the AI interview" : ""}.`, action: { label: "Open the candidate", href: appPaths.candidate(app.roleId, app.id) } });
  return true;
}

/**
 * A withdrawal is also a recorded request, fulfilled at once, so the audit trail and the confirmation email are the same
 * however the candidate withdrew: the status page's button, or "Yes, withdraw my application" in the AI interview. Runs
 * as the platform after the withdrawal committed (the tenant role cannot write that table).
 */
export async function recordWithdrawal(container: Container, app: { id: string; companyId: string; candidateId: string }, via: "status_page" | "ai_interview"): Promise<void> {
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
      ...(via === "ai_interview" ? { details: "Withdrawn in the AI interview.", verificationNote: "the request came through the candidate's own AI interview link" } : {}),
      actor,
      now: container.engine.clock(),
    });
    const done = await fulfilWithdrawal(tx, req, actor, container.engine.clock());
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
    if (cand?.email) await sendPrivacyCompletion(tx, container.integrations, { row: done, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
  });
}

export { normalizeEmailForDedupe };
