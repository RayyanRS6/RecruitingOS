/**
 * Every candidate-facing job URL (careers page, job page, apply page; the feeds, the sitemap and the posting packages
 * build on these) comes from one base, JOBS_BASE_URL (docs/spec/20 item 1), so the public host can differ from the
 * application's. The API passes its normalized value; the publish workflow gets it through `services.env.jobsBaseUrl`.
 */
export type JobUrls = { careers: string; job: string; apply: string };

export function jobUrlsFor(jobsBaseUrl: string, ref: { slug: string; roleId: string }): JobUrls {
  const base = jobsBaseUrl.replace(/\/+$/, "");
  const careers = `${base}/careers/${ref.slug}`;
  const job = `${careers}/jobs/${ref.roleId}`;
  return { careers, job, apply: `${job}/apply` };
}
