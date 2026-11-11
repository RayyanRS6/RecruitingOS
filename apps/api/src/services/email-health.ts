import { and, desc, eq, gte, inArray, isNull, notLike, sql } from "drizzle-orm";
import { notLocked } from "@ros/core";
import { applications, candidates, communications, roles, type Tx } from "@ros/db";

/**
 * Emails to candidates that did not arrive (6 November 2026, the dead ends' rank 1). Every candidate step after the first
 * page lives in an email, and only the outbox knew when one failed: the owner read nothing on a main screen, and Settings
 * said the opposite. Home gets one card from the failed sends, naming each person with their address and phone to hand,
 * and Settings reads the same sends instead of "a token exists".
 *
 * Only emails about an application the team may read (`notLocked`, the plans' Rule 3), never a deleted person, and never a
 * decision message: one that did not arrive puts the candidate back to "not told", which has its own card and its own way
 * to send it again. A message that failed for good (`failed`, a row with no address included) or bounced counts; one that
 * may have arrived (`unknown`), was withdrawn on purpose (`cancelled`) or waits for the ITS check (`held`) does not.
 */

/** How far back Home and Settings look. */
export const UNREACHED_DAYS = 7;
/** The outbox statuses of an email that never reached its person. */
export const DID_NOT_ARRIVE: readonly string[] = ["failed", "bounced"];
/** The statuses of an email that left us and was not refused. */
export const LEFT_US: readonly string[] = ["sent", "delivered", "opened", "clicked"];

/** One person an email did not reach, as Home lists them. `emails`: how many of theirs did not arrive in the window. */
export type UnreachedPerson = { applicationId: string; roleId: string; roleTitle: string; name: string; email: string | null; phone: string | null; emails: number };

/**
 * The people whose email did not arrive in the last `UNREACHED_DAYS`, newest first, each once. A failure is left out once
 * a later email to the same application left us: they have a working address again, and later mail carries their link.
 * `inScope`: an ITS recruiter's grant (staff-scope.ts); everyone else reads the whole company.
 */
export async function unreachedCandidates(tx: Tx, input: { companyId: string; now: Date; inScope?: (x: { roleId: string; applicationId: string }) => boolean }): Promise<UnreachedPerson[]> {
  const since = new Date(input.now.getTime() - UNREACHED_DAYS * 86_400_000).toISOString();
  const failed = await tx
    .select({ applicationId: applications.id, roleId: applications.roleId, at: communications.createdAt, firstName: candidates.firstName, lastName: candidates.lastName, email: candidates.email, phone: candidates.phone })
    .from(communications)
    .innerJoin(applications, eq(applications.id, communications.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .where(and(eq(communications.companyId, input.companyId), eq(communications.direction, "outbound"), eq(communications.channel, "email"), inArray(communications.status, [...DID_NOT_ARRIVE]), gte(communications.createdAt, since), notLike(sql`coalesce(${communications.templateKey}, '')`, "disposition:%"), notLocked(), isNull(candidates.anonymizedAt)))
    .orderBy(desc(communications.createdAt));
  const shown = failed.filter((f) => !input.inScope || input.inScope({ roleId: f.roleId, applicationId: f.applicationId }));
  if (!shown.length) return [];
  const ids = [...new Set(shown.map((f) => f.applicationId))];
  // The newest email to each of them that left us: a failure older than it is behind them.
  const left = await tx.select({ applicationId: communications.applicationId, at: sql<string>`max(${communications.createdAt})` }).from(communications).where(and(inArray(communications.applicationId, ids), eq(communications.direction, "outbound"), eq(communications.channel, "email"), inArray(communications.status, [...LEFT_US]))).groupBy(communications.applicationId);
  const lastLeft = new Map(left.map((l) => [l.applicationId, instant(l.at)]));
  const still = shown.filter((f) => !(instant(f.at) < (lastLeft.get(f.applicationId) ?? Number.NEGATIVE_INFINITY)));
  if (!still.length) return [];
  const titles = new Map((await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...new Set(still.map((f) => f.roleId))]))).map((r) => [r.id, r.title]));
  const people = new Map<string, UnreachedPerson>();
  for (const f of still) {
    const known = people.get(f.applicationId);
    if (known) { known.emails += 1; continue; }
    people.set(f.applicationId, { applicationId: f.applicationId, roleId: f.roleId, roleTitle: titles.get(f.roleId) ?? "a job", name: `${f.firstName} ${f.lastName}`.trim() || "A candidate", email: f.email ?? null, phone: f.phone ?? null, emails: 1 });
  }
  return [...people.values()];
}

/** A time as the database hands it back from an aggregate (a string, or a Date on some drivers), in milliseconds. */
const instant = (at: string | Date) => new Date(at).getTime();

/** How many emails these are, in all. */
export const emailsOf = (people: readonly UnreachedPerson[]) => people.reduce((n, p) => n + p.emails, 0);

/**
 * What Settings says about candidate email (GET /companies/current `candidateEmail`): over the same window and the same
 * emails as Home's card, how many left us and how many did not arrive, and when the last of each was. Counts only; never
 * who, and never anyone the team may not read.
 */
export type CandidateEmailHealth = { days: number; left: number; failed: number; lastLeftAt: string | null; lastFailedAt: string | null };

export async function candidateEmailHealth(tx: Tx, input: { companyId: string; now: Date }): Promise<CandidateEmailHealth> {
  const since = new Date(input.now.getTime() - UNREACHED_DAYS * 86_400_000).toISOString();
  const rows = await tx
    .select({ status: communications.status, n: sql<number>`count(*)`, last: sql<string>`max(${communications.createdAt})` })
    .from(communications)
    .innerJoin(applications, eq(applications.id, communications.applicationId))
    .where(and(eq(communications.companyId, input.companyId), eq(communications.direction, "outbound"), eq(communications.channel, "email"), inArray(communications.status, [...DID_NOT_ARRIVE, ...LEFT_US]), gte(communications.createdAt, since), notLocked()))
    .groupBy(communications.status);
  const sum = (statuses: readonly string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + Number(r.n), 0);
  const last = (statuses: readonly string[]) => rows.filter((r) => statuses.includes(r.status)).map((r) => new Date(r.last).toISOString()).sort().at(-1) ?? null;
  return { days: UNREACHED_DAYS, left: sum(LEFT_US), failed: sum(DID_NOT_ARRIVE), lastLeftAt: last(LEFT_US), lastFailedAt: last(DID_NOT_ARRIVE) };
}
