/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { isCompanyVerified, trialPaused, type RolePacket } from "@ros/contracts";
import { jobNoticesFor, type Notice } from "@ros/core";
import { candidates, companies, rolePackets, roles } from "@ros/db";
import type { Vars } from "../middleware/session";
import type { Container } from "../container";
import { Layout } from "./layout";

/**
 * What every part of the candidate pages shares (Wave S7, S7-0: moved as it was from pages/candidate.tsx): the job a
 * public address names, the company it belongs to, the conversation's address and its cookie, the masked email, and the
 * page a link shows once the person behind it was deleted. Owned by no slice: a change here goes through the integrator.
 */

/** The notices a public page of this job carries, for its jurisdictions and the company's own wording. */
export function jobNotices(packet: RolePacket, company: Pick<typeof companies.$inferSelect, "locations" | "settings">): Notice[] {
  return jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
}

/**
 * How a candidate corrects what went with their form, said the same way wherever they read it (Review & send and their
 * application's page): the request on their application's page, whose link is in the email about their application.
 */
export const CORRECTION_LINE = "To correct something, use \"Ask for a copy, a fix, deletion, or a person's review\" on your application's page; its link is in the email we sent you when you applied.";

/** "a***@example.com": enough for the person to recognise their own address, nothing more. */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return "the email address you gave";
  return `${e[0]}***@${e.slice(at + 1)}`;
}

/**
 * The conversation's introduction says the application went through, and where its link went, the way the receipt does
 * (plan E1): the masked address that was typed rides in a sealed cookie for that one conversation's pages, never in the
 * URL. A repeat submission's conversation gets the same, so the two read alike.
 */
export const CONVERSATION_COOKIE = "ros_applied_to";
export const CONVERSATION_PURPOSE = "application-conversation";
export type ConversationPayload = { v: 1; token: string; to: string; exp: number };

export function screenPath(token: string): string {
  return `/c/screen/${token}`;
}

/**
 * The "accepting applications" switch and a pause (docs/spec/20 item 16) both keep the job page up and close the form:
 * the page says so, the apply routes answer 404, and nobody already in the process is touched. A closing date (plan D7)
 * turns the same switch off at the end of its day; a form opened before then may still be sent for a while.
 */
export function acceptingApplications(role: { status: string; acceptingApplications: boolean }): boolean {
  return role.status === "open" && role.acceptingApplications;
}

/**
 * Whether this job takes a new application now: the job's own rule above, and the company's trial not ended (founder
 * decision L-02 B). A trial that ended reads to candidates exactly like a job that is not taking applications: the same
 * neutral line, never a word about a trial or a plan.
 */
export function jobTakesApplications(job: { role: { status: string; acceptingApplications: boolean }; company: { planKey: string; settings: unknown } }, now: Date): boolean {
  return acceptingApplications(job.role) && !trialPaused(job.company, now);
}

/**
 * A company's public pages (the careers page, its job pages, the apply form and its receipt) exist only once ITS has
 * confirmed the company (founder decision B7). Until then they answer exactly as a company that does not exist, so
 * nothing about an unconfirmed company is public, its JobPosting data included.
 */
export async function loadPublicCompany(db: Vars["Variables"]["container"]["db"], slug: string) {
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
  return company && isCompanyVerified(company.settings) ? company : null;
}

export async function loadJob(db: Vars["Variables"]["container"]["db"], slug: string, roleId: string) {
  const company = await loadPublicCompany(db, slug);
  if (!company) return null;
  const [role] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.companyId, company.id))).limit(1);
  if (!role?.currentPacketVersion) return null;
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
  if (!pv) return null;
  return { company, role, packet: pv.packet };
}
export type Job = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

/** After a fulfilled deletion the link is dead: the page says so and nothing is recorded or sent (docs/readiness/14). */
export async function anonymizedFor(container: Container, candidateId: string): Promise<boolean> {
  const [cand] = await container.db.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, candidateId)).limit(1);
  return !!cand?.anonymizedAt;
}
export function linkGone(c: Context<Vars>) {
  return c.html(<Layout title="This link is no longer active"><h1>This link is no longer active</h1><p>The information behind it was removed at your request. Nothing more can be sent or changed through this page.</p></Layout>, 410);
}
