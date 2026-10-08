import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isCompanyVerified, type Actor, type Location } from "@ros/contracts";
import { companyAboutPrompt, runPromptDetached, type CompanyAboutDraft, type CompanyAboutInput, type RunOutcome } from "@ros/ai";
import { PROXY_RULES, type CriterionCheck } from "@ros/core";
import { companies, rolePackets, roles, withTenant, type CompanySettings, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Env } from "../env";
import { jobUrls } from "./job-urls";

/**
 * What a company shows candidates about itself (plan D10, founder decision Q13): a few sentences about the company,
 * drafted by the assistant and approved once in Setup by a person; a logo we store and serve ourselves; and the contact
 * a candidate can reach before applying. They live on `companies.settings` next to the rest of the company's choices
 * (no schema change: the column is JSON). Only the approved text is ever shown; a draft, and the role plans' own company
 * line (`communication.companyBlurb`, which no person approved), never are.
 */
export type CompanyAbout = NonNullable<CompanySettings["about"]>;
export type CompanyAboutDraftRecord = NonNullable<CompanySettings["aboutDraft"]>;
export type CompanyLogo = NonNullable<CompanySettings["logo"]>;
export type HiringContact = NonNullable<CompanySettings["hiringContact"]>;
export type PublicProfileSettings = { about?: CompanyAbout; aboutDraft?: CompanyAboutDraftRecord; logo?: CompanyLogo; hiringContact?: HiringContact };
export type SettingsWithProfile = CompanySettings & PublicProfileSettings;

/** The profile part of a company's settings. */
export function profileOf(settings: CompanySettings | null | undefined): PublicProfileSettings {
  return (settings ?? {}) as SettingsWithProfile;
}

/** The text a person approved, or null. Never a draft and never a role plan's own company line. */
export function approvedAbout(settings: CompanySettings | null | undefined): string | null {
  const about = profileOf(settings).about;
  return about?.approvedAt && about.text.trim() ? about.text.trim() : null;
}

/** Where candidates load the logo: under the company's careers address, on whichever host serves the page. */
export function logoPublicPath(slug: string, logo: Pick<CompanyLogo, "file">): string {
  return `/careers/${slug}/logo/${logo.file}`;
}

/** Where the team (Setup, and the preview pages before the company is public) loads the logo, signed in. */
export const MEMBER_LOGO_PATH = "/api/v1/companies/current/logo";
export function logoMemberPath(logo: Pick<CompanyLogo, "file">): string {
  return `${MEMBER_LOGO_PATH}?v=${encodeURIComponent(logo.file)}`;
}

/** An image response that can only ever be an image: its exact type, no sniffing, and a policy that runs nothing. */
export function logoResponse(bytes: Uint8Array, contentType: string, cacheControl: string): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": contentType, "cache-control": cacheControl, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" },
  });
}

/** The logo's full public address, for search engines and link previews (JobPosting `logo`, `og:image`). */
export function logoPublicUrl(env: Pick<Env, "JOBS_BASE_URL">, slug: string, logo: Pick<CompanyLogo, "file">): string {
  return `${env.JOBS_BASE_URL}${logoPublicPath(slug, logo)}`;
}

/**
 * Who a candidate can reach before applying (for help, or a change to how they apply because of a disability): the
 * company's own hiring contact when it set one in Setup, otherwise the Identified Talent Solutions inbox that answers
 * for the company (the reply-to address of every message we send).
 */
export type ContactLine = { email: string; name: string | null; kind: "company" | "its" };
export function contactLineFor(settings: CompanySettings | null | undefined, env: Pick<Env, "EMAIL_REPLY_TO">): ContactLine {
  const own = profileOf(settings).hiringContact;
  return own?.email ? { email: own.email, name: own.name, kind: "company" } : { email: env.EMAIL_REPLY_TO, name: null, kind: "its" };
}

/**
 * The wording check for the text about the company: the packet guard's phrase list (packages/core/src/packet-guard.ts),
 * without the rules about years of experience and pay history, which judge requirements, not a description of a business
 * ("twenty years of experience serving Irvine" is a fact about the company, not a demand on candidates).
 */
const ABOUT_RULES = PROXY_RULES.filter((r) => !["experience_floor", "experience_cap", "pay_history"].includes(r.rule));
export function aboutWordingProblem(text: string): CriterionCheck | null {
  for (const r of ABOUT_RULES) {
    const hit = r.find(text);
    if (hit) return { rule: r.rule, text: hit, reason: r.reason, alternative: r.alternative };
  }
  return null;
}

export const ABOUT_MIN = 40;
export const ABOUT_MAX = 1200;

/** POST /companies/current/about/draft: what the person wants it to say, optionally. */
export const AboutDraftRequest = z.object({ notes: z.string().trim().max(1000).optional() }).strict();
/** POST /companies/current/about/approve: the words as the person left them. */
export const AboutApproval = z.object({ text: z.string().trim().min(ABOUT_MIN, `Write at least ${ABOUT_MIN} characters about the company.`).max(ABOUT_MAX, `Keep it under ${ABOUT_MAX} characters.`) }).strict();
/** PUT /companies/current/hiring-contact: an address candidates may write to before applying, or null for the ITS inbox. */
export const HiringContactInput = z.object({ email: z.email("Use an email address like jobs@acme.com.").max(254).nullable(), name: z.string().trim().max(120).nullable().optional() }).strict();

const placeText = (l: Location) => [l.city, l.region].filter(Boolean).join(", ");

/** What the assistant drafts from: what the company told us, its role titles, and the role plans' unapproved company lines as background. */
export async function aboutInputs(tx: Tx, companyId: string, notes: string | null): Promise<CompanyAboutInput> {
  const [co] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const recent = await tx.select({ title: roles.title, packet: rolePackets.packet }).from(rolePackets).innerJoin(roles, eq(roles.id, rolePackets.roleId)).where(eq(roles.companyId, companyId)).orderBy(desc(rolePackets.createdAt)).limit(20);
  const unique = (xs: string[], n: number) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, n);
  return {
    companyName: co?.name ?? "",
    vertical: co?.vertical ?? "",
    sizeBand: co?.sizeBand ?? null,
    places: unique((co?.locations ?? []).map(placeText), 6),
    website: co?.settings.website ?? null,
    careersIntro: co?.settings.careersPage?.intro ?? null,
    benefits: co?.settings.benefitsSummary ?? null,
    roleTitles: unique(recent.map((r) => r.title), 5),
    earlierDescriptions: unique(recent.map((r) => r.packet.communication.companyBlurb), 3),
    notes,
  };
}

/** Asks the assistant for a draft, with no transaction open while it writes; the run is recorded on `ai_runs` as every call is. */
export async function draftAbout(container: Container, input: { companyId: string; actor: Actor; notes: string | null }): Promise<RunOutcome<CompanyAboutDraft>> {
  const prepared = await withTenant(container.db, input.companyId, (tx) => aboutInputs(tx, input.companyId, input.notes));
  return runPromptDetached(container.db, container.ai, companyAboutPrompt, prepared, { companyId: input.companyId, inputRef: { requestedBy: input.actor.id, withNotes: !!input.notes } });
}

/** What Setup shows: the approved text, a draft waiting for a person, the logo, and the contact candidates see. */
export type PublicProfileView = {
  about: { text: string; approvedAt: string; approvedBy: string | null; aiAssisted: boolean } | null;
  draft: { text: string; draftedAt: string; basedOn: string[]; check: CriterionCheck | null } | null;
  logo: { url: string; publicUrl: string; contentType: string; width: number | null; height: number | null; uploadedAt: string } | null;
  hiringContact: { email: string; name: string | null } | null;
  contactShown: ContactLine;
  careersUrl: string;
  /** False until ITS has checked the company (founder decision B7): nothing is public before then. */
  public: boolean;
};

export function publicProfileView(company: { slug: string; settings: CompanySettings }, env: Pick<Env, "JOBS_BASE_URL" | "EMAIL_REPLY_TO">): PublicProfileView {
  const p = profileOf(company.settings);
  return {
    about: p.about ? { text: p.about.text, approvedAt: p.about.approvedAt, approvedBy: p.about.approvedBy.name ?? null, aiAssisted: p.about.aiAssisted } : null,
    draft: p.aboutDraft ? { text: p.aboutDraft.text, draftedAt: p.aboutDraft.draftedAt, basedOn: p.aboutDraft.basedOn, check: aboutWordingProblem(p.aboutDraft.text) } : null,
    logo: p.logo ? { url: logoMemberPath(p.logo), publicUrl: logoPublicUrl(env, company.slug, p.logo), contentType: p.logo.contentType, width: p.logo.width, height: p.logo.height, uploadedAt: p.logo.uploadedAt } : null,
    hiringContact: p.hiringContact ? { email: p.hiringContact.email, name: p.hiringContact.name } : null,
    contactShown: contactLineFor(company.settings, env),
    careersUrl: jobUrls(env, { slug: company.slug, roleId: "-" }).careers,
    public: isCompanyVerified(company.settings),
  };
}
