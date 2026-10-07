import type { JobBoardAdapter, PostingInput, PublishResult } from "../types";

/**
 * External boards in release 1 are manual (docs/spec/20; founder decision F4): ITS posts the job by hand under the
 * customer's own account, points the board at the board's own tracked apply link, verifies the public URL and records
 * it here. No adapter posts anything, reads a board's API or claims a live connection. Partner integrations (Indeed
 * Job Sync, ZipRecruiter partner API, LinkedIn Apply Connect) arrive as separate, verified adapters if approved.
 */
type BoardText = {
  name: string;
  signIn: string;
  applyMethod: string;
  billing: string;
};

function boardSteps(board: BoardText, input: PostingInput): string[] {
  const intake = input.intakeAddress ? ` If ${board.name} insists on sending applications by email instead, use ${input.intakeAddress} so each one still lands here.` : "";
  return [
    `${board.signIn} Post the job from ${input.companyName}'s own account: ${input.companyName} is the hiring employer.`,
    `Paste the posting package from the role's Posting tab: the title "${input.packet.identity.title}", the location, the pay range, the employment type and the description. Add the screening questions only if the board insists on its own.`,
    `${board.applyMethod} ${input.applyUrl}${intake}`,
    `${board.billing} Recruiting OS never spends on your behalf.`,
    `When the listing is public, copy its URL from the browser and record it here under "Record the public URL". The posting is shown as "Live and verified" only after the link has been checked.`,
  ];
}

function manual(board: BoardText, input: PostingInput): PublishResult {
  return {
    status: "ready_to_post",
    instructions: `Post this job on ${board.name} from ${input.companyName}'s own account with ${board.name}'s apply link ${input.applyUrl}, then record the public URL here.`,
    steps: boardSteps(board, input),
  };
}

const INDEED: BoardText = {
  name: "Indeed",
  signIn: "Sign in to Indeed for Employers (employers.indeed.com) and choose \"Post a job\".",
  applyMethod: "Under how you want to receive applications, choose to direct applicants to an external site and paste this apply link:",
  billing: "Sponsoring the post is optional and is billed by Indeed to your own account.",
};

const ZIPRECRUITER: BoardText = {
  name: "ZipRecruiter",
  signIn: "Sign in to ZipRecruiter for Employers and choose \"Post a job\".",
  applyMethod: "Under how candidates apply, choose your own application URL (a custom apply URL) and paste this apply link:",
  billing: "The listing runs on your ZipRecruiter plan; any promotion is billed by ZipRecruiter to your own account.",
};

const LINKEDIN: BoardText = {
  name: "LinkedIn",
  signIn: "Sign in to LinkedIn as an administrator of the company page and choose \"Post a free job\" (Jobs, then Post a job).",
  applyMethod: "Under how you want to receive applicants, choose \"External website\" and paste this apply link:",
  billing: "The free listing costs nothing; promoting it is optional and is billed by LinkedIn to your own account.",
};

export class IndeedAdapter implements JobBoardAdapter {
  readonly channel = "indeed";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual(INDEED, input);
  }
  async expire(): Promise<void> {}
}

export class ZipRecruiterAdapter implements JobBoardAdapter {
  readonly channel = "ziprecruiter";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual(ZIPRECRUITER, input);
  }
  async expire(): Promise<void> {}
}

/** LinkedIn: a free listing posted from the company page. The XML feed exists but is not advertised until LinkedIn confirms ingestion. */
export class LinkedInBasicJobsAdapter implements JobBoardAdapter {
  readonly channel = "linkedin_basic";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual(LINKEDIN, input);
  }
  async expire(): Promise<void> {}
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Feeds (docs/spec/20 item 6). Text goes out in CDATA; a "]]>" inside it is split so it cannot end the block.  */
/* ------------------------------------------------------------------------------------------------------------ */

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

export function linkedInFeedXml(jobs: Array<{ partnerJobId: string; company: string; title: string; description: string; location: string; applyUrl: string; salaryText?: string }>, opts: { publisherUrl?: string; lastBuildDate?: Date } = {}): string {
  const esc = cdata;
  const items = jobs
    .map(
      (j) => `  <job>
    <partnerJobId>${esc(j.partnerJobId)}</partnerJobId>
    <company>${esc(j.company)}</company>
    <title>${esc(j.title)}</title>
    <description>${esc(j.description)}</description>
    <location>${esc(j.location)}</location>
    <applyUrl>${esc(j.applyUrl)}</applyUrl>${j.salaryText ? `\n    <salaries><salary><highEnd><amount>${esc(j.salaryText)}</amount></highEnd></salary></salaries>` : ""}
  </job>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<source>\n  <lastBuildDate>${(opts.lastBuildDate ?? new Date()).toUTCString()}</lastBuildDate>\n  <publisherUrl>${esc(opts.publisherUrl ?? "")}</publisherUrl>\n${items}\n</source>\n`;
}

/** One job in the public feed: public data only, the client company named as the employer, a canonical URL and an apply URL. */
export type FeedJob = {
  referenceNumber: string;
  title: string;
  url: string;
  applyUrl: string;
  company: string;
  city?: string;
  state?: string;
  country: string;
  postalCode?: string;
  description: string;
  /** ISO dates (YYYY-MM-DD). `validThrough` is left out when the job has no real end date (packages/integrations/src/jobboards/native.ts). */
  datePosted: string;
  validThrough?: string | null;
  /** A schema.org token: FULL_TIME, PART_TIME, CONTRACTOR, TEMPORARY, INTERN, PER_DIEM, OTHER. */
  employmentType: string;
  salary?: { min: number; max: number; currency: string; basis: "hourly" | "salary" } | null;
  category?: string;
  /** When set, the feed says whether the job is remote. */
  remote?: boolean;
};

export type FeedMeta = { publisher: string; publisherUrl: string; lastBuildDate?: Date };

const JOB_TYPE_WORD: Record<string, string> = { FULL_TIME: "full-time", PART_TIME: "part-time", CONTRACTOR: "contract", TEMPORARY: "temporary", INTERN: "internship", PER_DIEM: "per-diem", OTHER: "other" };

export function feedSalaryText(s: FeedJob["salary"]): string {
  if (!s) return "";
  const amount = (n: number) => n.toLocaleString("en-US");
  return `${s.currency} ${amount(s.min)}-${amount(s.max)} ${s.basis === "hourly" ? "per hour" : "per year"}`;
}

/** The common job-board XML (one <source> with <publisher>, <publisherurl> and a <job> per listing). */
export function jobFeedXml(jobs: FeedJob[], meta: FeedMeta): string {
  const items = jobs
    .map(
      (j) => `  <job>
    <title>${cdata(j.title)}</title>
    <date>${cdata(j.datePosted)}</date>
    <referencenumber>${cdata(j.referenceNumber)}</referencenumber>
    <url>${cdata(j.url)}</url>
    <applyurl>${cdata(j.applyUrl)}</applyurl>
    <company>${cdata(j.company)}</company>
    <city>${cdata(j.city ?? "")}</city>
    <state>${cdata(j.state ?? "")}</state>
    <country>${cdata(j.country)}</country>
    <postalcode>${cdata(j.postalCode ?? "")}</postalcode>
    <description>${cdata(j.description)}</description>
    <salary>${cdata(feedSalaryText(j.salary))}</salary>
    <jobtype>${cdata(JOB_TYPE_WORD[j.employmentType] ?? "other")}</jobtype>
    <category>${cdata(j.category ?? "")}</category>${j.validThrough ? `\n    <expirationdate>${cdata(j.validThrough)}</expirationdate>` : ""}${j.remote !== undefined ? `\n    <remote>${j.remote ? "yes" : "no"}</remote>` : ""}
  </job>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<source>\n  <publisher>${cdata(meta.publisher)}</publisher>\n  <publisherurl>${cdata(meta.publisherUrl)}</publisherurl>\n  <lastBuildDate>${(meta.lastBuildDate ?? new Date()).toUTCString()}</lastBuildDate>\n${items}\n</source>\n`;
}

/** The same listings as JSON, with the schema.org-shaped fields boards and aggregators read. */
export function jobFeedJson(jobs: FeedJob[], meta: FeedMeta): Record<string, unknown> {
  return {
    publisher: meta.publisher,
    publisherUrl: meta.publisherUrl,
    lastBuildDate: (meta.lastBuildDate ?? new Date()).toISOString(),
    jobs: jobs.map((j) => ({
      referenceNumber: j.referenceNumber,
      title: j.title,
      url: j.url,
      applyUrl: j.applyUrl,
      company: j.company,
      hiringOrganization: { name: j.company },
      city: j.city ?? null,
      state: j.state ?? null,
      country: j.country,
      postalCode: j.postalCode ?? null,
      description: j.description,
      datePosted: j.datePosted,
      ...(j.validThrough ? { validThrough: j.validThrough } : {}),
      employmentType: j.employmentType,
      jobType: JOB_TYPE_WORD[j.employmentType] ?? "other",
      salary: j.salary ? { minValue: j.salary.min, maxValue: j.salary.max, currency: j.salary.currency, unitText: j.salary.basis === "hourly" ? "HOUR" : "YEAR", text: feedSalaryText(j.salary) } : null,
      category: j.category ?? null,
      remote: j.remote ?? null,
    })),
  };
}
