import type { RolePacket } from "@ros/contracts";

/**
 * The schema.org JobPosting data the public job page carries, which Google reads to list the job.
 */

/** schema.org employmentType tokens for the job record's employment types; anything unknown is OTHER. */
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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * `validThrough`, only ever a real date: the day the job closed; otherwise the day it stopped taking applications
 * (paused, or stopped by its closing date); otherwise the job's closing date, when one is set. Applications stopped by
 * the closing date itself stop at the midnight after it, which is already the next day in UTC: the closing date is the
 * real last day, so it is used. An open job with no closing date has none, and the value is left out rather than
 * invented.
 */
export function jobValidThrough(input: { closedAt?: string | null; stoppedAt?: string | null; closesOn?: string | null }): string | undefined {
  const closesOn = input.closesOn ? input.closesOn.slice(0, 10) : null;
  if (input.closedAt) return isoDate(new Date(input.closedAt));
  if (input.stoppedAt) {
    const stopped = isoDate(new Date(input.stoppedAt));
    return closesOn && stopped > closesOn ? closesOn : stopped;
  }
  if (closesOn) return closesOn;
  return undefined;
}

export type JobPostingJsonLdInput = {
  roleId: string;
  companyName: string;
  packet: RolePacket;
  jobUrl: string;
  datePosted: string;
  /** Overrides the computed value; the page normally passes the dates and leaves it to `jobValidThrough`. */
  validThrough?: string | null;
  /** When the job is closed: the block stays on the page with `validThrough` in the past. */
  closedAt?: string | null;
  /** When the job stopped taking applications without closing. */
  stoppedAt?: string | null;
  /** The job's closing date (`roles.applications_close_on`, YYYY-MM-DD), when one is set. */
  closesOn?: string | null;
  /** Whether the pay range is shown; defaults to the job record's own choice. A page in a pay-transparency jurisdiction shows it regardless. */
  showPay?: boolean;
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
    validThrough: input.validThrough ?? jobValidThrough({ closedAt: input.closedAt, stoppedAt: input.stoppedAt, closesOn: input.closesOn }),
    employmentType: schemaEmploymentType(p.identity.employmentType),
    hiringOrganization,
    jobLocation: loc
      ? { "@type": "Place", address: { "@type": "PostalAddress", streetAddress: loc.address1, addressLocality: loc.city, addressRegion: loc.region, postalCode: loc.postalCode, addressCountry: loc.country ?? "US" } }
      : undefined,
    jobLocationType: p.identity.remotePolicy === "remote" ? "TELECOMMUTE" : undefined,
    baseSalary: (input.showPay ?? comp.discloseRange)
      ? { "@type": "MonetaryAmount", currency: comp.currency, value: { "@type": "QuantitativeValue", minValue: comp.min, maxValue: comp.max, unitText: comp.basis === "hourly" ? "HOUR" : "YEAR" } }
      : undefined,
    directApply: true,
    url: input.jobUrl,
  };
}
