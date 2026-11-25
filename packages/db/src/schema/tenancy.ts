import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Actor, Location, TrialTerm } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";

export type CompanySettings = {
  website?: string;
  /**
   * Where the team's own pages load the logo. For a logo uploaded in Setup (plan D10) it is the signed-in path
   * `/api/v1/companies/current/logo?v=<file>`; the public pages and the structured data build the public address from
   * `logo` instead (apps/api services/company-settings-profile.ts).
   */
  logoUrl?: string;
  /** The logo as stored by us (plan D10): the file under the company's careers address, its type, size and who uploaded it. */
  logo?: { file: string; key: string; contentType: string; sizeBytes: number; width: number | null; height: number | null; uploadedAt: string; uploadedBy: Actor };
  /** The text about the company a person approved in Setup (founder decision Q13); the only one candidates ever see. */
  about?: { text: string; approvedAt: string; approvedBy: Actor; aiAssisted: boolean };
  /**
   * The assistant's draft of that text, waiting for a person; never shown to candidates. `basedOn`: only on a draft
   * stored before 25 November 2026, when the assistant was also asked for the facts it used; nothing ever read it, and
   * it is no longer asked for or written.
   */
  aboutDraft?: { text: string; draftedAt: string; draftedBy: Actor; aiRunId: string | null; basedOn?: string[] };
  /** Who candidates may write to before applying (plan D10); without it, the ITS inbox that answers for the company. */
  hiringContact?: { email: string; name: string | null; setAt: string; setBy: Actor };
  benefitsSummary?: string;
  notices?: Record<string, { version: string; text: string; jurisdictions: string[] }>;
  careersPage?: { enabled: boolean; intro?: string };
  /** Design Partner pilot term (founder decision F8): roles in progress are never cut off when it ends. */
  pilot?: { startedAt: string; endsAt: string; extendedUntil?: string };
  /**
   * The Trial plan's 30 days (founder decision L-02 B): set when the company is accepted, by the hourly check for a
   * company already on Trial, and by ITS from the console (an extension, a change back to Trial); never by the customer.
   * Read only while the company is on the Trial plan (`trialStanding` in @ros/contracts). Every write is one JSON-merge
   * statement.
   */
  trial?: TrialTerm;
  /** The one gate: when the company went live. Written only by `setCompanyLive` (packages/core/src/company-live.ts). */
  verifiedAt?: string;
  /**
   * When the email saying a request for access was sent really left (apps/api services/access-requests.ts), so the waiting
   * screen claims it only when true. Never who is waiting: that is the owner's membership status.
   */
  accessRequestEmailedAt?: string;
  /**
   * Which period of the AI credit the owner was told about, at 80% and when it was used up, so each is told once
   * (packages/core/src/ai-credit.ts: "total" or the month's start, never an amount, because this object reaches the
   * browser). Written by one JSON-merge statement; Change plan clears it, so a new plan's lines are told again.
   */
  aiCreditTold?: { warnedFor?: string; usedUpFor?: string };
};

export const companies = pgTable(
  "companies",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    vertical: text("vertical").notNull(),
    sizeBand: text("size_band").notNull(),
    timezone: text("timezone").notNull().default("America/Los_Angeles"),
    locations: jsonb("locations").$type<Location[]>().notNull().default([]),
    settings: jsonb("settings").$type<CompanySettings>().notNull().default({}),
    planKey: text("plan_key").notNull().default("trial"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("companies_slug_idx").on(t.slug)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name"),
    platformRole: text("platform_role").notNull().default("none"), // none | platform_admin
    /** The managed identity service's subject and the provider it came through (D19). Null until the first delegated sign-in. */
    authProvider: text("auth_provider"),
    authSubject: text("auth_subject"),
    /** When the person first verified an authenticator app with the identity service (staff second factor). */
    mfaEnrolledAt: ts("mfa_enrolled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email), uniqueIndex("users_auth_subject_idx").on(t.authProvider, t.authSubject)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // owner | admin | hiring_manager
    status: text("status").notNull().default("active"), // active | removed | requested | declined (a request for access: ACCESS_REQUEST_STATUSES in @ros/contracts)
    invitedBy: uuid("invited_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("memberships_company_user_idx").on(t.companyId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    activeCompanyId: uuid("active_company_id"),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** How the session was opened (magic_link, azure, google, email) and its assurance level; ITS staff need a second factor (D25). */
    identityProvider: text("identity_provider"),
    aal: text("aal"),
    mfaVerifiedAt: ts("mfa_verified_at"),
    /** When the holder last confirmed with their sign-in provider inside this session (migration 0024); needed shortly before making someone an admin or an owner. */
    reauthenticatedAt: ts("reauthenticated_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const magicLinks = pgTable(
  "magic_links",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("magic_links_token_idx").on(t.tokenHash), index("magic_links_email_idx").on(t.email)],
);

/**
 * A team invitation (migration 0022): who was invited to which company, as what, by whom. The emailed link carries a
 * random token; only its hash is kept. Accepted by a Google or Microsoft sign-in (or the email link where enabled) with
 * the invited address; never deleted, it ends as accepted, revoked or expired.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Lower-cased; the sign-in compares it with the verified address, case-insensitively. */
    email: text("email").notNull(),
    role: text("role").notNull(), // owner | admin | hiring_manager
    name: text("name"),
    invitedBy: jsonb("invited_by").$type<Actor>().notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | revoked | expired
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedUserId: uuid("accepted_user_id"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("invitations_token_hash_idx").on(t.tokenHash), index("invitations_company_status_idx").on(t.companyId, t.status), index("invitations_email_status_idx").on(t.email, t.status)],
);

export const plans = pgTable("plans", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  prices: jsonb("prices").$type<Record<string, number>>().notNull().default({}),
  limits: jsonb("limits").$type<Record<string, number | null>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const entitlements = pgTable(
  "entitlements",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    limit: integer("limit"),
    used: integer("used").notNull().default(0),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    source: text("source").notNull().default("plan"), // plan | addon | credit | trial
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("entitlements_company_key_idx").on(t.companyId, t.key)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    quantity: integer("quantity").notNull(),
    unit: text("unit").notNull(),
    ref: jsonb("ref").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("usage_events_company_idx").on(t.companyId, t.occurredAt)],
);
