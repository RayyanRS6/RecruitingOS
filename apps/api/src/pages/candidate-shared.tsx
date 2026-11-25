/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { readStoredPacket, trialPaused, type RolePacket } from "@ros/contracts";
import { isCompanyLive, jobNoticesFor, jobPastItsLimit, type Notice } from "@ros/core";
import { candidates, companies, rolePackets, roles, withTenant } from "@ros/db";
import type { Vars } from "../middleware/session";
import type { Container } from "../container";
import { acceptingApplications } from "../services/closing-date";
import { Layout } from "./layout";

/**
 * What every part of the candidate pages shares: the job a public address names, the company it belongs to, the AI
 * interview's address, the masked email, and the page a link shows once the person behind it was deleted.
 */

/** The notices a public page of this job carries, for its jurisdictions and the company's own wording. */
export function jobNotices(packet: RolePacket, company: Pick<typeof companies.$inferSelect, "locations" | "settings">): Notice[] {
  return jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
}

/** The request on the status page, by the name its fold carries there. */
export const CORRECTION_REQUEST = "Ask for a copy, a fix, deletion, or a person's review";

/**
 * How a candidate corrects what went with their form, as "Check your answers" says it: the request on their status
 * page, whose link is in the email about their application. The status page itself points at that request further down.
 */
export const CORRECTION_LINE = `To correct something, use "${CORRECTION_REQUEST}" on your status page; its link is in the email we sent you when you applied.`;

/** "a***@example.com": enough for the person to recognise their own address, nothing more. */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return "the email address you gave";
  return `${e[0]}***@${e.slice(at + 1)}`;
}

export function screenPath(token: string): string {
  return `/c/screen/${token}`;
}

/** A job's own rule for taking a new application (services/closing-date.ts, the one copy), named here for the candidate pages. */
export { acceptingApplications };

/**
 * Whether this job takes a new application now: the job's own rule above, and the company's trial not ended. A trial
 * that ended reads to candidates exactly like a job that is not taking applications: the same neutral line, never a
 * word about a trial or a plan.
 */
export function jobTakesApplications(job: { role: { status: string; acceptingApplications: boolean }; company: { planKey: string; settings: unknown } }, now: Date): boolean {
  return acceptingApplications(job.role) && !trialPaused(job.company, now);
}

/**
 * A company's public pages (the careers page, its job pages, the apply form and its receipt) exist only while the
 * company is live (`isCompanyLive`). Otherwise they answer exactly as a company that does not exist, so nothing about it
 * is public, its JobPosting data included.
 */
export async function loadPublicCompany(db: Vars["Variables"]["container"]["db"], slug: string) {
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
  return company && isCompanyLive(company.settings) ? company : null;
}

export async function loadJob(db: Vars["Variables"]["container"]["db"], slug: string, roleId: string) {
  const company = await loadPublicCompany(db, slug);
  if (!company) return null;
  const [role] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.companyId, company.id))).limit(1);
  if (!role?.currentPacketVersion) return null;
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
  if (!pv) return null;
  return { company, role, packet: readStoredPacket(pv.packet) };
}
export type Job = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

/**
 * Whether this job is past its plan's candidates per job: a new applicant is then kept on file, and nobody reads their
 * resume, a person or the AI. Its public pages say so in the on-file words (packages/core/src/candidate-lock.ts), read
 * from the job and never from who is asking, the same for everyone, and never with a word about a plan.
 */
export function pastItsLimit(container: Pick<Container, "db">, job: { company: { id: string }; role: { id: string } }): Promise<boolean> {
  return withTenant(container.db, job.company.id, (tx) => jobPastItsLimit(tx, { companyId: job.company.id, roleId: job.role.id }));
}

/** After a fulfilled deletion the link is dead: the page says so and nothing is recorded or sent. */
export async function anonymizedFor(container: Container, candidateId: string): Promise<boolean> {
  const [cand] = await container.db.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, candidateId)).limit(1);
  return !!cand?.anonymizedAt;
}
export function linkGone(c: Context<Vars>) {
  return c.html(<Layout title="This link is no longer active"><h1>This link is no longer active</h1><p>The information behind it was removed at your request. Nothing more can be sent or changed through this page.</p></Layout>, 410);
}
