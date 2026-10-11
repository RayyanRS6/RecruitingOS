import type { ShareTarget } from "@ros/contracts";
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

/**
 * The share buttons' addresses for one tracked link (plan D8): the person's own email or text app, or the network's own
 * share page in a new tab. Plain links only: nothing from these networks ever loads on our pages, so the candidate
 * pages' content-security policy stays as it is. `text` already ends with the link; X and LinkedIn take the link apart.
 */
export function shareTargets(input: { url: string; text: string; subject: string }): ShareTarget[] {
  const enc = encodeURIComponent;
  const withoutUrl = input.text.endsWith(input.url) ? input.text.slice(0, -input.url.length).trim() : input.text;
  return [
    { key: "email", label: "Email", url: `mailto:?subject=${enc(input.subject)}&body=${enc(input.text)}` },
    { key: "text", label: "Text message", url: `sms:?&body=${enc(input.text)}` },
    { key: "whatsapp", label: "WhatsApp", url: `https://wa.me/?text=${enc(input.text)}` },
    { key: "linkedin", label: "LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(input.url)}` },
    { key: "facebook", label: "Facebook", url: `https://www.facebook.com/sharer/sharer.php?u=${enc(input.url)}` },
    { key: "x", label: "X", url: `https://x.com/intent/post?text=${enc(withoutUrl)}&url=${enc(input.url)}` },
  ];
}
