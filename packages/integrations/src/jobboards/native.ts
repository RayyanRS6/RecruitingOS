import type { JobBoardAdapter, PostingInput, PublishResult } from "../types";

/** The careers page is served by the API itself: live, and verified by construction. */
export class CareersPageAdapter implements JobBoardAdapter {
  readonly channel = "careers_page";
  readonly status = "live" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return { status: "live_verified", externalUrl: input.jobUrl };
  }
  async expire(): Promise<void> {}
}

/**
 * Google for Jobs reads the schema.org JobPosting data on the public job page on its own schedule. We can submit
 * valid data; we cannot verify indexing ourselves, so the channel reports "submitted, awaiting verification"
 * (founder decision F4) with the way to confirm it.
 */
export class GoogleJobsAdapter implements JobBoardAdapter {
  readonly channel = "google_jobs";
  readonly status = "awaiting_verification" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return {
      status: "awaiting_verification",
      externalUrl: input.jobUrl,
      instructions: "The job page carries valid JobPosting structured data. Google indexes it on its own schedule; confirm with the URL inspection tool in Google Search Console. No further action is needed for the data itself.",
    };
  }
  async expire(): Promise<void> {}
}

/**
 * Email-in: the per-role intake address applications can be forwarded to (Indeed-hosted jobs, agencies, referrals).
 * Live and verified only when the inbound mail domain is actually configured; otherwise "not connected".
 */
export class EmailInAdapter implements JobBoardAdapter {
  readonly channel = "email_in";
  readonly status: "live" | "not_connected";
  constructor(private configured: boolean) {
    this.status = configured ? "live" : "not_connected";
  }
  async publish(input: PostingInput): Promise<PublishResult> {
    if (!this.configured) {
      return { status: "not_connected", instructions: "Email-in capture is not connected yet: the inbound mail domain must be configured before forwarded applications can arrive here. Until then, share the apply link directly." };
    }
    return {
      status: "live_verified",
      externalId: input.intakeAddress,
      instructions: `Forward any application email (for example from a job you posted on Indeed from your own account) to ${input.intakeAddress}. Each one becomes an applicant here.`,
    };
  }
  async expire(): Promise<void> {}
}

export function jobPostingJsonLd(input: PostingInput & { datePosted: string; validThrough?: string }): Record<string, unknown> {
  const p = input.packet;
  const loc = p.identity.locations[0];
  const comp = p.compensation;
  return {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: p.identity.title,
    description: p.description.publicJobDescription,
    identifier: { "@type": "PropertyValue", name: input.companyName, value: input.roleId },
    datePosted: input.datePosted,
    validThrough: input.validThrough,
    employmentType: p.identity.employmentType.toUpperCase(),
    hiringOrganization: { "@type": "Organization", name: input.companyName, sameAs: undefined },
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
