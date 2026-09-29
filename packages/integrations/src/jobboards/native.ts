import type { JobBoardAdapter, PostingInput, PublishResult } from "../types";

/**
 * The careers page is served by the API itself. It is prepared as `ready_to_post` with the job page as its public
 * URL; the publish workflow records that URL and queues the same verification a board gets (docs/spec/20 item 12),
 * so nothing is called live by construction.
 */
export class CareersPageAdapter implements JobBoardAdapter {
  readonly channel = "careers_page";
  readonly status = "live" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return {
      status: "ready_to_post",
      externalUrl: input.jobUrl,
      instructions: `Your careers page lists this job at ${input.jobUrl}. The link is checked automatically and the posting is shown as live once the page answers with the job title.`,
    };
  }
  async expire(): Promise<void> {}
}

/**
 * Google for Jobs reads the schema.org JobPosting data on the public job page on its own schedule. We can submit
 * valid data; we cannot verify indexing ourselves, so the channel is "submitted through an integration" until a
 * person confirms it in Search Console and marks it verified with a note (founder decision F4).
 */
export class GoogleJobsAdapter implements JobBoardAdapter {
  readonly channel = "google_jobs";
  readonly status = "awaiting_verification" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return {
      status: "submitted_integration",
      externalUrl: input.jobUrl,
      instructions: "The job page carries valid JobPosting structured data. Google indexes it on its own schedule; confirm with the URL inspection tool in Google Search Console, then mark it verified here with a note. No further action is needed for the data itself.",
    };
  }
  async expire(): Promise<void> {}
}

export const EMAIL_IN_NOT_CONFIGURED = "Inbound mail domain not configured yet";

/**
 * Email-in: the per-role intake address applications can be forwarded to (Indeed-hosted jobs, agencies, referrals).
 * Not a board. Live and verified only when the inbound mail domain is actually configured; otherwise a failed
 * channel with its reason, which the UI shows as "Not connected".
 */
export class EmailInAdapter implements JobBoardAdapter {
  readonly channel = "email_in";
  readonly status: "live" | "not_connected";
  constructor(private configured: boolean) {
    this.status = configured ? "live" : "not_connected";
  }
  async publish(input: PostingInput): Promise<PublishResult> {
    if (!this.configured) return { status: "failed", error: EMAIL_IN_NOT_CONFIGURED, retryable: false };
    return {
      status: "live_verified",
      externalId: input.intakeAddress,
      instructions: `Forward any application email (for example from a job you posted on Indeed from your own account) to ${input.intakeAddress}. Each one becomes an applicant here.`,
    };
  }
  async expire(): Promise<void> {}
}

/* ------------------------------------------------------------------------------------------------------------ */
/* JobPosting structured data (docs/spec/20 item 4).                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** schema.org employmentType tokens for the packet's employment types; anything unknown is OTHER. */
export const SCHEMA_EMPLOYMENT_TYPE: Record<string, string> = {
  full_time: "FULL_TIME",
  part_time: "PART_TIME",
  contract: "CONTRACTOR",
  temporary: "TEMPORARY",
  internship: "INTERN",
  per_diem: "PER_DIEM",
};

export function schemaEmploymentType(employmentType: string): string {
  return SCHEMA_EMPLOYMENT_TYPE[employmentType] ?? "OTHER";
}

/** How long an open job stays valid from the day it was posted; recomputed on every request, so renewal is automatic. */
export const JOB_VALID_DAYS = 60;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `validThrough`: the day the role closed when it is closed (so the block stays on the page, in the past), otherwise
 * sixty days after the posting date, recomputed each time the page is rendered.
 */
export function jobValidThrough(input: { datePosted: string; closedAt?: string | null }): string {
  if (input.closedAt) return isoDate(new Date(input.closedAt));
  const posted = new Date(input.datePosted);
  return isoDate(new Date(posted.getTime() + JOB_VALID_DAYS * 86_400_000));
}

export type JobPostingJsonLdInput = PostingInput & {
  datePosted: string;
  /** Overrides the computed value; the page normally leaves it to `jobValidThrough`. */
  validThrough?: string;
  /** When the role is closed: the block stays on the page with `validThrough` in the past. */
  closedAt?: string | null;
  /** The employer's website (`hiringOrganization.sameAs`) and logo, when the company set them. */
  companyWebsite?: string | null;
  companyLogoUrl?: string | null;
};

export function jobPostingJsonLd(input: JobPostingJsonLdInput): Record<string, unknown> {
  const p = input.packet;
  const loc = p.identity.locations[0];
  const comp = p.compensation;
  const hiringOrganization: Record<string, unknown> = { "@type": "Organization", name: input.companyName };
  if (input.companyWebsite) hiringOrganization.sameAs = input.companyWebsite;
  if (input.companyLogoUrl) hiringOrganization.logo = input.companyLogoUrl;
  return {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: p.identity.title,
    description: p.description.publicJobDescription,
    identifier: { "@type": "PropertyValue", name: input.companyName, value: input.roleId },
    datePosted: input.datePosted,
    validThrough: input.validThrough ?? jobValidThrough({ datePosted: input.datePosted, closedAt: input.closedAt }),
    employmentType: schemaEmploymentType(p.identity.employmentType),
    hiringOrganization,
    jobLocation: loc
      ? { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: loc.address1, addressLocality: loc.city, addressRegion: loc.region, postalCode: loc.postalCode, addressCountry: loc.country ?? "US" } }
      : undefined,
    jobLocationType: p.identity.remotePolicy === "remote" ? "TELECOMMUTE" : undefined,
    baseSalary: comp.discloseRange
      ? { "@type": "MonetaryAmount", currency: comp.currency, value: { "@type": "QuantitativeValue", minValue: comp.min, maxValue: comp.max, unitText: comp.basis === "hourly" ? "HOUR" : "YEAR" } }
      : undefined,
    directApply: true,
    url: input.jobUrl,
  };
}
