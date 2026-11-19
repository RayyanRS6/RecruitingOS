import type { JobUrls } from "@ros/contracts";
import { jobUrlsFor } from "@ros/core";
import type { Env } from "../env";

/**
 * The public job URLs of one job, built from JOBS_BASE_URL. The careers page, the job page, the apply page and the
 * sitemap all come through here, so the public host changes in one place.
 */
export function jobUrls(env: Pick<Env, "JOBS_BASE_URL">, ref: { slug: string; roleId: string }): JobUrls {
  return jobUrlsFor(env.JOBS_BASE_URL, ref);
}