import type { JobUrls } from "@ros/contracts";

/**
 * Every candidate-facing job URL (careers page, job page, apply page; the sitemap builds on these) comes from one
 * base, JOBS_BASE_URL, so the public host can differ from the application's. The API passes its normalized value.
 */
export function jobUrlsFor(jobsBaseUrl: string, ref: { slug: string; roleId: string }): JobUrls {
  const base = jobsBaseUrl.replace(/\/+$/, "");
  const careers = `${base}/careers/${ref.slug}`;
  const job = `${careers}/jobs/${ref.roleId}`;
  return { careers, job, apply: `${job}/apply` };
}