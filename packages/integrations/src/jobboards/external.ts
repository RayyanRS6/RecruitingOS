import type { JobBoardAdapter, PostingInput, PublishResult } from "../types";

/**
 * External boards in release 1 are manual (founder decision F4): the customer posts from their own account and either
 * points the board at the apply link or forwards applications to the role's intake address. No adapter claims a live
 * connection until an ingestion is confirmed. Partner integrations (Indeed Job Sync, ZipRecruiter feed, LinkedIn feed
 * registration) arrive as separate, verified adapters later.
 */
function manual(board: string, input: PostingInput, extra: string): PublishResult {
  const intake = input.intakeAddress ? ` If ${board} asks where to send applications, use ${input.intakeAddress} so each one lands here.` : "";
  return { status: "manual_action_required", instructions: `Post this job on ${board} from your own account (copy the description from the job page). Set the application method to ${input.applyUrl}.${intake} ${extra}`.trim() };
}

export class IndeedAdapter implements JobBoardAdapter {
  readonly channel = "indeed";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual("Indeed", input, "Sponsored spend on Indeed is billed by Indeed to your account.");
  }
  async expire(): Promise<void> {}
}

export class ZipRecruiterAdapter implements JobBoardAdapter {
  readonly channel = "ziprecruiter";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual("ZipRecruiter", input, "");
  }
  async expire(): Promise<void> {}
}

/** LinkedIn: a free listing posted from the company page. The XML feed exists but is not advertised until LinkedIn confirms ingestion. */
export class LinkedInBasicJobsAdapter implements JobBoardAdapter {
  readonly channel = "linkedin_basic";
  readonly status = "manual_action_required" as const;
  async publish(input: PostingInput): Promise<PublishResult> {
    return manual("LinkedIn (a free listing from your company page)", input, "");
  }
  async expire(): Promise<void> {}
}

export function linkedInFeedXml(jobs: Array<{ partnerJobId: string; company: string; title: string; description: string; location: string; applyUrl: string; salaryText?: string }>): string {
  const esc = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]] >")}]]>`;
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n<source>\n  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n  <publisherUrl>${esc("")}</publisherUrl>\n${items}\n</source>\n`;
}
