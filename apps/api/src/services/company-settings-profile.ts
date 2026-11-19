import { desc, eq } from "drizzle-orm";
import { mayOfferUpgrade, trialStanding, type Actor, type CompanyView, type Location } from "@ros/contracts";
import { companyAboutPrompt, runPromptDetached, type CompanyAboutDraft, type CompanyAboutInput, type RunOutcome } from "@ros/ai";
import { PROXY_RULES, aiCreditView, can, entitlements, type CriterionCheck } from "@ros/core";
import { companies, rolePackets, roles, withPlatform, withTenant, type CompanySettings, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Env } from "../env";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { jobUrls } from "./job-urls";
import { openPlanRequest } from "./plan-request";

/**
 * What a company shows candidates about itself: a few sentences about the company, drafted by the assistant and approved
 * in Settings by a person; a logo we store and serve ourselves; and the contact a candidate can reach before applying.
 * They live on `companies.settings` next to the rest of the company's details. Only the approved text is ever shown to a
 * candidate; a draft never is.
 */
type CompanyLogo = NonNullable<CompanySettings["logo"]>;

/** The text a person approved, or null. Never a draft. */
export function approvedAbout(settings: CompanySettings | null | undefined): string | null {
  const about = settings?.about;
  return about?.approvedAt && about.text.trim() ? about.text.trim() : null;
}

/** Where candidates load the logo: under the company's careers address, on whichever host serves the page. */
export function logoPublicPath(slug: string, logo: Pick<CompanyLogo, "file">): string {
  return `/careers/${slug}/logo/${logo.file}`;
}

/** Where the team (Settings, and the job-page preview) loads the logo, signed in. */
export function logoMemberPath(logo: Pick<CompanyLogo, "file">): string {
  return `/api/v1/companies/current/logo?v=${encodeURIComponent(logo.file)}`;
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
 * company's own hiring contact when it set one in Settings, otherwise the Identified Talent Solutions inbox that answers
 * for the company (the reply-to address of every message we send).
 */
export type ContactLine = { email: string; name: string | null; kind: "company" | "its" };
export function contactLineFor(settings: CompanySettings | null | undefined, env: Pick<Env, "EMAIL_REPLY_TO">): ContactLine {
  const own = settings?.hiringContact;
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

const placeText = (l: Location) => [l.city, l.region].filter(Boolean).join(", ");

/** What the assistant drafts from: what the company told us, its job titles, and the jobs' own company lines as background. */
async function aboutInputs(tx: Tx, companyId: string, notes: string | null): Promise<CompanyAboutInput> {
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

/**
 * The company as its own people read it in Settings (GET /companies/current, and the answer to every change of its
 * details): the details, what candidates see about it, and its plan with the usage lines, the AI help as a percentage
 * and words (never an amount), the trial's standing and the open request for a bigger plan. `viewer.mayEdit`: this
 * person may change the details (an owner or an admin).
 */
export async function companyView(container: Pick<Container, "db" | "env" | "engine">, tenant: Tenant): Promise<CompanyView> {
  const now = container.engine.clock();
  const view = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [co] = await tx.select().from(companies).where(eq(companies.id, tenant.companyId)).limit(1);
    if (!co) throw new HttpError(404, "not_found", "Company not found.");
    const { about, aboutDraft, logo, hiringContact } = co.settings;
    return {
      id: co.id,
      name: co.name,
      slug: co.slug,
      vertical: co.vertical,
      sizeBand: co.sizeBand,
      timezone: co.timezone,
      locations: co.locations,
      website: co.settings.website ?? null,
      logoUrl: logo ? logoMemberPath(logo) : null,
      about: about ? { text: about.text, approvedAt: about.approvedAt, aiAssisted: about.aiAssisted } : null,
      aboutDraft: aboutDraft ? { text: aboutDraft.text, draftedAt: aboutDraft.draftedAt, check: aboutWordingProblem(aboutDraft.text) } : null,
      benefitsSummary: co.settings.benefitsSummary ?? null,
      hiringContact: hiringContact ? { email: hiringContact.email, name: hiringContact.name } : null,
      contactShown: contactLineFor(co.settings, container.env),
      careersUrl: jobUrls(container.env, { slug: co.slug, roleId: "-" }).careers,
      plan: {
        key: co.planKey,
        name: (await entitlements.planOf(tx, co.id))?.name ?? co.planKey,
        usage: await entitlements.usageOf(tx, co.id, { now }),
        aiCredit: await aiCreditView(tx, co.id, { now, timeZone: co.timezone, planKey: co.planKey }),
        trial: trialStanding(co, now),
        mayUpgrade: mayOfferUpgrade(co.planKey),
      },
      viewer: { mayEdit: can(tenant.role, "company.update") },
    };
  });
  // The request is an alert the administrators read, and the company's own role cannot read alerts: looked up on the platform side.
  const open = await withPlatform(container.db, (tx) => openPlanRequest(tx, tenant.companyId));
  return { ...view, plan: { ...view.plan, upgradeRequestedAt: open?.requestedAt ?? null } };
}
