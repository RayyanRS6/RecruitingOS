import { randomInt } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { applicationLinks, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * Tracked application links (docs/spec/20 items 7, 8 and 19). Each board, referral, direct or other link is a short
 * random token that redirects to the apply page and sets a sealed cookie; the application records the source and the
 * detail, never the token. The same source vocabulary is written to `applications.source` and `candidates.first_source`.
 */
export const SOURCES = ["careers_page", "email_in", "linkedin", "indeed", "ziprecruiter", "referral", "direct", "other"] as const;
export type ApplicationSource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<ApplicationSource, string> = {
  careers_page: "Careers page",
  email_in: "Email",
  linkedin: "LinkedIn",
  indeed: "Indeed",
  ziprecruiter: "ZipRecruiter",
  referral: "Referral",
  direct: "Direct",
  other: "Other",
};

/** The sources a person may create a link for; boards get theirs from the publish workflow. */
export const PERSON_LINK_SOURCES: readonly ApplicationSource[] = ["referral", "direct", "other"];

export function isSource(value: string): value is ApplicationSource {
  return (SOURCES as readonly string[]).includes(value);
}

/** Posting channel to application source: `linkedin_basic` is `linkedin`; Google for Jobs sends people to the job page itself. */
export function sourceForChannel(channel: string): ApplicationSource {
  switch (channel) {
    case "careers_page":
    case "google_jobs":
      return "careers_page";
    case "email_in":
      return "email_in";
    case "linkedin_basic":
      return "linkedin";
    case "indeed":
      return "indeed";
    case "ziprecruiter":
      return "ziprecruiter";
    default:
      return "other";
  }
}

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const LINK_TOKEN_LENGTH = 12;

/** Twelve lower-case letters and digits, each drawn without bias; never derived from a role or company id. */
export function newLinkToken(): string {
  let out = "";
  for (let i = 0; i < LINK_TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return out;
}

export function isLinkToken(value: string): boolean {
  return /^[a-z0-9]{12}$/.test(value);
}

/** The public redirect for a token, on the job-page host. */
export function applyLinkUrl(jobsBaseUrl: string, token: string): string {
  return `${jobsBaseUrl.replace(/\/+$/, "")}/a/${token}`;
}

export type ApplicationLinkRow = typeof applicationLinks.$inferSelect;

export async function createApplicationLink(
  q: Queryable,
  input: { companyId: string; roleId: string; postingId?: string | null; source: ApplicationSource; sourceDetail?: string | null; label: string; actor: Actor; now?: Date },
): Promise<ApplicationLinkRow> {
  const now = (input.now ?? new Date()).toISOString();
  const [row] = await q
    .insert(applicationLinks)
    .values({ companyId: input.companyId, roleId: input.roleId, postingId: input.postingId ?? null, token: newLinkToken(), source: input.source, sourceDetail: input.sourceDetail ?? null, label: input.label, createdBy: input.actor, createdAt: now, updatedAt: now })
    .returning();
  // The event carries the label and the source, never the token.
  await emit(q, { type: "application_link.created", companyId: input.companyId, actor: input.actor, subject: { type: "application_link", id: row.id }, payload: { roleId: input.roleId, postingId: row.postingId, source: row.source, label: row.label } });
  return row;
}

/**
 * The token lookup for the public redirect. Runs with whatever scope the caller holds: a platform transaction sees
 * every company's links (the redirect knows no tenant yet); a tenant transaction sees only its own.
 */
export async function findLinkByToken(q: Queryable, token: string): Promise<ApplicationLinkRow | null> {
  if (!isLinkToken(token)) return null;
  const [row] = await q.select().from(applicationLinks).where(eq(applicationLinks.token, token)).limit(1);
  return row ?? null;
}

export async function recordLinkVisit(q: Queryable, id: string, now: Date): Promise<void> {
  await q.update(applicationLinks).set({ visits: sql`${applicationLinks.visits} + 1`, lastVisitedAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(applicationLinks.id, id));
}

export async function disableApplicationLink(q: Queryable, input: { linkId: string; companyId: string; actor: Actor; now?: Date }): Promise<ApplicationLinkRow | null> {
  const now = (input.now ?? new Date()).toISOString();
  const [row] = await q.update(applicationLinks).set({ disabledAt: now, updatedAt: now }).where(and(eq(applicationLinks.id, input.linkId), eq(applicationLinks.companyId, input.companyId), isNull(applicationLinks.disabledAt))).returning();
  if (!row) return null;
  await emit(q, { type: "application_link.disabled", companyId: input.companyId, actor: input.actor, subject: { type: "application_link", id: row.id }, payload: { roleId: row.roleId, source: row.source, label: row.label } });
  return row;
}

export async function listApplicationLinks(q: Queryable, roleId: string): Promise<ApplicationLinkRow[]> {
  return q.select().from(applicationLinks).where(eq(applicationLinks.roleId, roleId)).orderBy(desc(applicationLinks.createdAt));
}

/** The active tracked link of a board posting, if one exists. */
export async function findPostingLink(q: Queryable, postingId: string): Promise<ApplicationLinkRow | null> {
  const [row] = await q.select().from(applicationLinks).where(and(eq(applicationLinks.postingId, postingId), isNull(applicationLinks.disabledAt))).orderBy(desc(applicationLinks.createdAt)).limit(1);
  return row ?? null;
}
