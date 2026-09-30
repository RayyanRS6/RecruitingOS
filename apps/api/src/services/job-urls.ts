import { applyLinkUrl, jobUrlsFor, type JobUrls } from "@ros/core";
import type { Env } from "../env";

/**
 * The public job URLs of one role, built from JOBS_BASE_URL (docs/spec/20 item 1). The careers page, the job page,
 * the apply page, the sitemap, the feeds, the posting packages and the tracked links all come through here (the
 * publish workflow uses the same builder through `services.env.jobsBaseUrl`), so the public host changes in one place.
 */
export function jobUrls(env: Pick<Env, "JOBS_BASE_URL">, ref: { slug: string; roleId: string }): JobUrls {
  return jobUrlsFor(env.JOBS_BASE_URL, ref);
}

/** The public redirect of a tracked application link, on the same host. */
export function trackedLinkUrl(env: Pick<Env, "JOBS_BASE_URL">, token: string): string {
  return applyLinkUrl(env.JOBS_BASE_URL, token);
}
