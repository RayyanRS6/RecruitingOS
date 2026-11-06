import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { CANDIDATES_PER_JOB, MORE_CANDIDATES_LINE, moreAppliedTitle } from "@ros/contracts";
import { applications, candidates, companies, events, notifications, type Queryable } from "@ros/db";
import { zonedParts } from "./business-hours";
import { limitOf, planOf } from "./entitlements";
import { notify } from "./notifications";

/**
 * Locked candidates, the plans of 5 November 2026, Rule 2. A plan's `candidates_per_job` is how many people applying to one
 * job the team can read. Who is past it is decided once, when the application is created, in arrival order and for no other
 * reason, and stored on the application (`locked_at`), so nothing a person does later moves anyone: a withdrawal, a decline
 * or a deletion gives no place back, and a move down to a smaller plan locks nobody who could already be read. Only a
 * change of plan opens anyone (`unlockApplicants`, @ros/workflows). Someone locked gets no AI and no team work, and is told
 * nothing about a plan or money. A company with no limit takes no lock here, and is read as it always was.
 */

/** Who the lock is decided by, on the record: arrival order and the plan's numbers, never a person. */
export const CANDIDATE_LOCK_ACTOR = { kind: "system", id: "candidate_lock" } as const;

/** Applications to one job take turns while their place is decided (held to the end of the caller's transaction). */
export async function lockApplicants(q: Queryable, roleId: string): Promise<void> {
  await q.execute(sql`select pg_advisory_xact_lock(hashtext(${`applicants:${roleId}`}))`);
}

/** Everyone who has applied to a job, whatever became of them: a place is taken once and never comes back. */
export async function applicantsOnRole(q: Queryable, roleId: string): Promise<number> {
  const [row] = await q.select({ n: count() }).from(applications).where(eq(applications.roleId, roleId));
  return Number(row?.n ?? 0);
}

/** Why an application is locked, as it is recorded: its place in arrival order, the limit and the plan. Never a name, a score or a source. */
export type LockDecision = { position: number; limit: number; plan: string | null };

/**
 * Whether the next application to this job is past the limit, or null. The caller creates that application in the same
 * transaction, which holds the job's lock until it commits, so two people applying at the same moment take different places.
 * A company with no limit takes no lock at all, and its applicants never wait for each other.
 */
export async function decideLock(q: Queryable, input: { companyId: string; roleId: string }): Promise<LockDecision | null> {
  if ((await limitOf(q, input.companyId, CANDIDATES_PER_JOB)) === null) return null;
  await lockApplicants(q, input.roleId);
  // Read again behind the lock: a change of plan that held it has taken effect by now, and has opened what it could.
  const limit = await limitOf(q, input.companyId, CANDIDATES_PER_JOB);
  if (limit === null) return null;
  const applied = await applicantsOnRole(q, input.roleId);
  if (applied < limit) return null;
  return { position: applied + 1, limit, plan: (await planOf(q, input.companyId))?.key ?? null };
}

/**
 * Whether a new application to this job would be locked now: what its pages say before anyone applies, and what a repeat
 * submission reads, because the words depend on the job and never on the address typed (Q14, R20-12).
 */
export async function jobPastItsLimit(q: Queryable, input: { companyId: string; roleId: string }): Promise<boolean> {
  const limit = await limitOf(q, input.companyId, CANDIDATES_PER_JOB);
  return limit !== null && (await applicantsOnRole(q, input.roleId)) >= limit;
}

/** Whether this application is locked now. */
export async function applicationLocked(q: Queryable, applicationId: string): Promise<boolean> {
  const [row] = await q.select({ lockedAt: applications.lockedAt }).from(applications).where(eq(applications.id, applicationId)).limit(1);
  return !!row?.lockedAt;
}

/** Whether the team can read nothing of this person: they have applications here, and every one of them is locked. */
export async function onlyLockedApplications(q: Queryable, candidateId: string): Promise<boolean> {
  const rows = await q.select({ lockedAt: applications.lockedAt }).from(applications).where(eq(applications.candidateId, candidateId));
  return rows.length > 0 && rows.every((r) => !!r.lockedAt);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The applications among these that nobody may name to the team. One query; an empty list asks nothing, and anything that is not an id names nobody. */
export async function lockedAmong(q: Queryable, applicationIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(applicationIds)].filter((id) => UUID.test(id));
  if (!ids.length) return new Set();
  const rows = await q.select({ id: applications.id }).from(applications).where(and(inArray(applications.id, ids), isNotNull(applications.lockedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Filter for a query that reads applications for reminders or for the team's work: never someone locked. */
export const notLocked = () => isNull(applications.lockedAt);

/**
 * Who is reading, for the wall of Rule 3: someone on the team, or ITS staff under a grant. ITS is not the paying customer, but
 * a recruiter inside a customer's workspace reads the same lists as the customer, so they cannot name a locked person by
 * accident. Only two grants read past the lock: break glass, and one naming exactly this application, which is how a
 * candidate who asked for a person gets one. A grant for a role or for the whole company does not.
 */
export type LockReader = { staff?: { kind: string; scope: { applicationId: string | null } } | null } | null | undefined;

const readsEveryone = (reader: LockReader) => reader?.staff?.kind === "break_glass";

/** The filter for a query over applications, in the query, before anything is ordered or counted. Undefined for break glass, who reads everyone. */
export function visibleTo(reader: LockReader): SQL | undefined {
  if (readsEveryone(reader)) return undefined;
  const named = reader?.staff?.scope.applicationId;
  return named ? or(notLocked(), eq(applications.id, named)) : notLocked();
}

/**
 * Of those locked, who an upgrade could still open: not someone who withdrew or was deleted while locked. Their place was taken
 * once and never comes back, so `decideLock` goes on counting them; but they use no room when a change of plan opens people, and
 * they have no card, no place in "N more" and no part in "view more", because nobody would open. Nothing about them changes:
 * they stay as they are, and stay unread. (The owner's decision of 6 November 2026.)
 */
export function lockedAndWaiting(): SQL {
  return and(isNotNull(applications.lockedAt), ne(applications.stage, "withdrawn"), sql`not exists (select 1 from ${candidates} where ${candidates.id} = ${applications.candidateId} and ${candidates.anonymizedAt} is not null)`) as SQL;
}

/** The locked applications this reader may not read, to count them, if an upgrade could still open them (`lockedAndWaiting`). Null for break glass, who has none. */
export function hiddenFrom(reader: LockReader): SQL | null {
  if (readsEveryone(reader)) return null;
  const named = reader?.staff?.scope.applicationId;
  return named ? (and(lockedAndWaiting(), ne(applications.id, named)) as SQL) : lockedAndWaiting();
}

/** The applications among these this reader may not read. */
export async function hiddenAmong(q: Queryable, reader: LockReader, applicationIds: readonly string[]): Promise<Set<string>> {
  if (readsEveryone(reader)) return new Set();
  const locked = await lockedAmong(q, applicationIds);
  const named = reader?.staff?.scope.applicationId;
  if (named) locked.delete(named);
  return locked;
}

/** Whether anyone at this company is locked: a company with nobody locked reads every list as it always did. */
export async function companyHasLocked(q: Queryable, companyId: string): Promise<boolean> {
  const [row] = await q.select({ id: applications.id }).from(applications).where(and(eq(applications.companyId, companyId), isNotNull(applications.lockedAt))).limit(1);
  return !!row;
}

/** What the neutral notice is filed under. It carries no name, so it needs no `about`. */
export const MORE_APPLIED_KIND = "entitlement.more_applied";

/**
 * All the team hears of people applying past the limit: one notice per job per day, in the company's own days, naming nobody.
 * Called while the job's lock is held (`decideLock`), so two people applying at the same moment send one. An email, if someone
 * wants this group as it happens, says the same thing. Returns how many people it reached.
 */
export async function tellMoreApplied(q: Queryable, input: { companyId: string; roleId: string; roleTitle: string; now?: Date }): Promise<number> {
  const href = `/roles/${input.roleId}/talent`;
  const [last] = await q.select({ at: notifications.createdAt }).from(notifications).where(and(eq(notifications.companyId, input.companyId), eq(notifications.kind, MORE_APPLIED_KIND), sql`${notifications.action}->>'href' = ${href}`)).orderBy(desc(notifications.createdAt)).limit(1);
  const [company] = await q.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const zone = company?.timezone ?? "UTC";
  const now = input.now ?? new Date();
  if (last && zonedParts(new Date(last.at), zone).dayKey === zonedParts(now, zone).dayKey) return 0;
  return notify(q, { companyId: input.companyId, kind: MORE_APPLIED_KIND, title: moreAppliedTitle(input.roleTitle), body: MORE_CANDIDATES_LINE, action: { label: "See applicants", href } });
}

/**
 * When each of these applications was opened by a change of plan, for the ones that were (`application.unlocked`). What they
 * wait on the team for counts from then: until then the team could do nothing about them, so an upgrade never reads as
 * weeks of neglect.
 */
export async function unlockedAtFor(q: Queryable, applicationIds: readonly string[]): Promise<Map<string, string>> {
  if (!applicationIds.length) return new Map();
  const rows = await q.select({ id: events.subjectId, at: events.occurredAt, payload: events.payload }).from(events).where(and(eq(events.type, "application.unlocked"), eq(events.subjectType, "application"), inArray(events.subjectId, [...new Set(applicationIds)])));
  return new Map(rows.map((r) => [r.id, typeof r.payload.at === "string" ? r.payload.at : r.at]));
}

/** From when someone has waited on the team: the later of the moment they reached this stage and their unlock. */
export function waitingSince(stageChangedAt: string, unlockedAt: string | null | undefined): number {
  return Math.max(Date.parse(stageChangedAt), unlockedAt ? Date.parse(unlockedAt) : 0);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What a locked applicant reads                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** How long after applying a locked applicant hears, at the latest, if the job is still open. */
export const CLOSE_OUT_DAYS = 30;
/**
 * The note goes from this many days after applying. The daily check looks once a day, so a note due on day 30 could leave on
 * day 31 and break what the form, the email and the page all promise: "at the latest". It goes in the day before instead.
 */
export const CLOSE_OUT_SENDS_FROM_DAYS = CLOSE_OUT_DAYS - 1;

/** The moment by which someone who applied at `appliedAt` has heard. */
export function closeOutDueAt(appliedAt: string | Date): Date {
  return new Date(new Date(appliedAt).getTime() + CLOSE_OUT_DAYS * 86_400_000);
}

/** "Friday, December 4, 2026" in the company's time zone: the date the words below promise. */
export function closeOutDayWords(at: string | Date, timeZone: string | null | undefined): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone: timeZone || "America/Los_Angeles", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/**
 * DRAFT WORDING PENDING COUNSEL (docs/spec/11-counsel-register.md, the locked-applicant items): everything from here to the
 * end of this file, every word, until counsel signs off. A locked applicant is never told about a plan or money. These go
 * beside the required notices, never in place of them. The same words whether the address is new, repeat or known (Q14,
 * R20-12), so nothing here depends on what was typed.
 */
export const ON_FILE_NOTICE_VERSION = "2026-11-05";
/** How the line before Send is recorded among the notices shown. */
export const ON_FILE_NOTICE = `on_file@${ON_FILE_NOTICE_VERSION}`;

/** The job page's last step, on a job past its limit, in place of "A decision, and a real answer either way." */
export const ON_FILE_LAST_STEP = "We email you either way, at the latest 30 days after you apply.";

/** The line before Send, on a job past its limit. */
export function onFileFormLine(companyName: string): string {
  return `Many people have applied for this job. ${companyName} may not be able to review every application. If yours is not reviewed we will email you to say so, at the latest 30 days after you apply.`;
}

/** Beside "Software helps organize applications and works out a match score", on a job past its limit: none of that runs on what is not reviewed. */
export const ON_FILE_SOFTWARE_LINE = "On this job that happens only when your application is reviewed.";

/** The receipt, and the one email's words, for someone on file. */
export function onFileReceiptLine(companyName: string, byDay: string): string {
  return `${companyName} has your application on file. They may not be able to review every application. If they review yours, they will contact you. If not, we email you to say so when the job closes, or at the latest on ${byDay}.`;
}

/** The status page's next-step line while locked. */
export function onFileStatusLine(companyName: string, byDay: string): string {
  return `Your application is on file with ${companyName}. They may not be able to review every application. We will email you when the job closes, or by ${byDay}.`;
}

/** The status page's next-step line once the close-out note went: the date above has passed, and this is what they were told. */
export const CLOSED_OUT_STATUS_LINE = "Your application has not been reviewed, and we cannot say whether it will be. You do not need to do anything.";

/** The close-out note: what makes "a real answer either way" true for someone nobody may read. It declines nobody and moves no stage. */
export function closeOutNoteLine(input: { roleTitle: string; companyName: string; statusUrl: string }): string {
  return `Your application for ${input.roleTitle} at ${input.companyName} has not been reviewed, and we cannot say whether it will be. You do not need to do anything. If this changes, the team will contact you. You can withdraw or ask about your information from your page: ${input.statusUrl}`;
}

/** The line above the messages on the status page while locked: a reply reaches ITS, not the team. */
export const LOCKED_THREAD_LINE = "To write to us, reply to any of our emails.";
