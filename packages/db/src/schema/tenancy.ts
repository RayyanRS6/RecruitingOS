import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Actor, CompanyOnboarding, Location } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";

export type CompanySettings = {
  website?: string;
  /** A public logo URL for the JobPosting structured data (docs/spec/20 item 4); optional. */
  logoUrl?: string;
  benefitsSummary?: string;
  notices?: Record<string, { version: string; text: string; jurisdictions: string[] }>;
  retention?: Record<string, number>;
  careersPage?: { enabled: boolean; intro?: string };
  brief?: { channel: "email" | "in_app" | "sms"; hourLocal: number };
  /**
   * When the company wants candidates contacted (audit finding J16): days 0 (Sunday) to 6, and local times "HH:MM".
   * Narrows the legal quiet-hours window for texts (packages/core/src/contact-hours.ts); never widens it.
   */
  businessHours?: { days: number[]; start: string; end: string };
  /** Design Partner pilot term (founder decision F8): roles in progress are never cut off when it ends. */
  pilot?: { startedAt: string; endsAt: string; extendedUntil?: string };
  /** The one-time ITS check (founder decision B7): set and cleared from the admin console only (apps/api services/company-trust.ts). */
  verifiedAt?: string;
  verifiedBy?: Actor;
  /** Getting started (plan B2): who hid the card, the AI rules reviewed, job-board access confirmed by ITS. */
  onboarding?: CompanyOnboarding;
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
    status: text("status").notNull().default("trial"),
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
    phone: text("phone"),
    platformRole: text("platform_role").notNull().default("none"), // none | its_recruiter | platform_admin
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
    role: text("role").notNull(), // owner | admin | hiring_manager | interviewer | hr | recruiter
    status: text("status").notNull().default("active"), // invited | active | removed
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
    /** How the session was opened (magic_link, azure, google, email) and its assurance level; a second factor unlocks break-glass (D25). */
    identityProvider: text("identity_provider"),
    aal: text("aal"),
    mfaVerifiedAt: ts("mfa_verified_at"),
    /** When the holder last confirmed with their sign-in provider inside this session (migration 0024); unlocks policy and notice changes for ten minutes. */
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
    /** No longer written or read: invitations are rows of their own (migration 0022). Kept because migrations are append-only. */
    inviteCompanyId: uuid("invite_company_id"),
    inviteRole: text("invite_role"),
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
    role: text("role").notNull(), // owner | admin | hiring_manager | interviewer | hr
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
