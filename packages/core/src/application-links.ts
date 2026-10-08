import { randomInt } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Actor, SharePlace } from "@ros/contracts";
import { applicationLinks, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * Tracked application links (docs/spec/20 items 7, 8 and 19). Each board, referral, direct or other link is a short
 * random token that redirects to the job page (a shared link) or the apply page (a board's link, plan D8) and sets a
 * sealed cookie; the application records the source and the
 * detail, never the token. The same source vocabulary is written to `applications.source` and `candidates.first_source`.
 */
export const SOURCES = ["careers_page", "email_in", "linkedin", "indeed", "ziprecruiter", "referral", "school", "community", "shared_email", "shared_text", "whatsapp", "linkedin_post", "facebook", "x", "direct", "other"] as const;
export type ApplicationSource = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<ApplicationSource, string> = {
  careers_page: "Careers page",
  email_in: "Email",
  linkedin: "LinkedIn",
  indeed: "Indeed",
  ziprecruiter: "ZipRecruiter",
  referral: "Referral",
  school: "School or training program",
  community: "Community group",
  shared_email: "Shared by email",
  shared_text: "Shared by text message",
  whatsapp: "WhatsApp",
  linkedin_post: "LinkedIn post",
  facebook: "Facebook",
  x: "X",
  direct: "Direct",
  other: "Other",
};

/** The sources a person may create a link for; boards get theirs from the publish workflow. */
export const PERSON_LINK_SOURCES: readonly ApplicationSource[] = ["referral", "direct", "other"];

/**
 * The ready-made places a job is shared to (plan D8): one tap each, no form, each with its own tracked link that opens
 * the job page. The same place reuses its link, so a second tap counts into the same row.
 */
export const SHARE_PLACES: Readonly<Record<SharePlace, { label: string; source: ApplicationSource }>> = {
  referral: { label: "Referral from your team", source: "referral" },
  school: { label: "A school or training program", source: "school" },
  community: { label: "A community group", source: "community" },
  email: { label: "Shared by email", source: "shared_email" },
  text: { label: "Shared by text message", source: "shared_text" },
  whatsapp: { label: "Shared on WhatsApp", source: "whatsapp" },
  linkedin: { label: "Shared on LinkedIn", source: "linkedin_post" },
  facebook: { label: "Shared on Facebook", source: "facebook" },
  x: { label: "Shared on X", source: "x" },
};

/** Where a link lands: a board's link goes straight to the form, every shared link opens the job page first (plan D8). */
export type LinkLanding = "job" | "apply";

/**
 * Link-preview fetchers, search crawlers and our own link check: a pasted link is fetched by the app it was pasted
 * into before anyone clicks it. They are sent to the job page (its preview card), never counted as visits and never
 * given the source cookie. Every such fetcher names itself; a request with no user agent at all (some privacy tools
 * strip it) is counted like a person.
 */
const PREVIEW_AGENTS = /facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|skypeuripreview|google web preview|google-inspectiontool|applebot|embedly|iframely|vkshare|redditbot|pinterest|mastodon|bluesky|cardyb|bytespider|headlesschrome|recruitingos-linkcheck/i;
const CRAWLER_AGENTS = /\b(\w+bot|crawler|spider)\/[\d.]/i;

export function isLinkPreviewBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return false;
  return PREVIEW_AGENTS.test(ua) || CRAWLER_AGENTS.test(ua);
}

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
  input: { companyId: string; roleId: string; postingId?: string | null; source: ApplicationSource; sourceDetail?: string | null; label: string; actor: Actor; now?: Date; landing?: LinkLanding },
): Promise<ApplicationLinkRow> {
  const now = (input.now ?? new Date()).toISOString();
  const landing: LinkLanding = input.landing ?? (input.postingId ? "apply" : "job");
  const [row] = await q
    .insert(applicationLinks)
    .values({ companyId: input.companyId, roleId: input.roleId, postingId: input.postingId ?? null, token: newLinkToken(), source: input.source, sourceDetail: input.sourceDetail ?? null, label: input.label, landing, createdBy: input.actor, createdAt: now, updatedAt: now })
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
