import { jobPostsPrompt, type JobPostsInput } from "@ros/ai";
import { wordingProblems } from "@ros/agents";
import { POST_CHANNEL_LABEL, POST_TEXT_MAX, PostChannel, applyLinkFor, formatPayRange } from "@ros/contracts";
import type { IntakeModelCall } from "./intake-run";

/**
 * The two posts on a job's Share tab (job.posts, docs/11): the LinkedIn post and the Indeed listing the AI writes from a
 * published job's public facts. No evaluation read them before 25 November 2026. Each case is a job as the Share
 * service hands it to the model (`jobFacts` in apps/api/src/services/share.ts), and each post is judged as the model
 * wrote it, before the service finishes it by rule (`finishPost` adds a missing pay or link and takes flagged lines
 * out): the suite measures the prompt, so a model that leans on those repairs fails here.
 *
 * Not registered in runner.ts by this file: the lines to add are in the round's report.
 */

export type PostsCase = {
  id: string;
  provenance: "synthetic";
  /** The job's public facts, in the job page's own words. `pay` is null when the job page shows none. */
  job: Omit<JobPostsInput, "applyLinks">;
  /** The pay as figures, for the guard's check of any dollar amount a post states; null when the job page shows none. */
  compensation: { min: number; max: number } | null;
};

/** The most words each post may run to, as the prompt asks ("60 to 130 words", "150 to 350 words"). */
export const POST_WORDS_MAX: Record<PostChannel, number> = { linkedin: 130, indeed: 350 };

/** A made-up job page: each post's Apply link is this address with the post's own source on it. */
const JOB_URL = "https://jobs.example.test/careers/eval-co/jobs/00000000-0000-4000-8000-000000000001";
export const applyLinksOf = (jobUrl = JOB_URL): Record<PostChannel, string> => ({ linkedin: applyLinkFor(jobUrl, "linkedin"), indeed: applyLinkFor(jobUrl, "indeed") });

/** Every dollar amount a text states: "$45", "$45.00", "$90,000" and "$90k" all count (as `finishPost` reads them). */
const amountsIn = (text: string): number[] => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi)].map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));

/**
 * What one post fails on, as the model wrote it:
 * - its own Apply link is not in it exactly once, or it carries another link (the other post's, or any other address);
 * - the job page shows a pay and the post does not state both ends of it;
 * - it has wording the fairness guard would take out of a job description, what the owner was told could not be used
 *   aside (`wordingProblems`): a stand-in for a protected trait, or a dollar figure that is neither the job's pay nor in
 *   its benefits line (so a job that shows no pay may state none);
 * - it runs past its length: the words the prompt allows, or the characters the Share tab stores.
 */
export function postFailures(channel: PostChannel, text: string, c: Pick<PostsCase, "job" | "compensation">, links: Record<PostChannel, string> = applyLinksOf()): string[] {
  const f: string[] = [];
  const what = `the ${POST_CHANNEL_LABEL[channel]}`;
  const own = links[channel];
  const times = text.split(own).length - 1;
  if (times !== 1) f.push(`${what} carries its Apply link ${times === 0 ? "nowhere" : `${times} times`}; once expected`);
  const others = [...new Set((text.match(/https?:\/\/[^\s)>\]"']+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")).filter((url) => url !== own))];
  if (others.length) f.push(`${what} carries another link: ${others.join(", ")}`);
  if (c.job.pay && c.compensation) {
    const said = amountsIn(text);
    if (![c.compensation.min, c.compensation.max].every((amount) => said.includes(amount))) f.push(`${what} does not show the pay (${c.job.pay})`);
  }
  for (const p of wordingProblems(text, { compensation: c.compensation, benefits: c.job.benefits, provenance: {} })) f.push(`${what} has wording the fairness guard would take out: "${p.text}" (${p.rule})`);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > POST_WORDS_MAX[channel]) f.push(`${what} has ${words} words; at most ${POST_WORDS_MAX[channel]} expected`);
  if (text.length > POST_TEXT_MAX) f.push(`${what} has ${text.length} characters; the Share tab keeps at most ${POST_TEXT_MAX}`);
  return f;
}

const HYGIENIST_DESCRIPTION =
  "Harbor Dental is hiring a Registered Dental Hygienist in Tustin, CA. This is an on-site job, full time, Monday to Friday. You will care for a loyal patient base, chart periodontal findings and explain them in plain words. You will work with two dentists and a team that keeps to its schedule. What the job needs: an active CA RDH license and periodontal charting.";

/** The pay of the two cases that show one. Each is given to the model as the job page writes it (`formatPayRange`). */
const HOURLY_45_TO_55 = { basis: "hourly", min: 45, max: 55 } as const;
const SALARY_120K_TO_140K = { basis: "salary", min: 120000, max: 140000 } as const;

/** A job with its pay shown and a dollar figure in its benefits line, a salaried hybrid job, and a job whose page shows no pay. */
export const postsCases: PostsCase[] = [
  {
    id: "hygienist_hourly_pay_shown",
    provenance: "synthetic",
    job: {
      companyName: "Harbor Dental", title: "Registered Dental Hygienist", places: ["Tustin, CA"], workArrangement: "On site", employmentType: "Full time", schedule: "Monday to Friday",
      pay: formatPayRange(HOURLY_45_TO_55), benefits: "Health cover and a $500 uniform allowance", description: HYGIENIST_DESCRIPTION, mustHaves: ["Active CA RDH license", "Periodontal charting"],
    },
    compensation: HOURLY_45_TO_55,
  },
  {
    id: "marketing_director_salary_hybrid",
    provenance: "synthetic",
    job: {
      companyName: "Northside Home Services", title: "Director of Marketing", places: ["Phoenix, AZ"], workArrangement: "Hybrid", employmentType: "Full time", schedule: "Monday to Friday",
      pay: formatPayRange(SALARY_120K_TO_140K), benefits: null,
      description: "Northside Home Services is hiring a Director of Marketing in Phoenix, AZ. This is a hybrid job, full time, Monday to Friday. You will run paid ads across three markets and report what each one brings in. You will work with the owner and two coordinators. What the job needs: five years running paid ads.",
      mustHaves: ["Five years running paid ads"],
    },
    compensation: SALARY_120K_TO_140K,
  },
  {
    id: "front_desk_no_pay_shown",
    provenance: "synthetic",
    job: {
      companyName: "Harbor Dental", title: "Front Desk Coordinator", places: ["Austin, TX"], workArrangement: "On site", employmentType: "Part time", schedule: "Tuesday to Saturday",
      pay: null, benefits: null,
      description: "Harbor Dental is hiring a Front Desk Coordinator in Austin, TX. This is an on-site job, part time, Tuesday to Saturday. You will greet patients, book their visits and keep the day's schedule moving. You will work beside the office manager. What the job needs: two years at a dental front desk.",
      mustHaves: ["Two years at a dental front desk"],
    },
    compensation: null,
  },
];

/** A case run and written as the runner writes a case into the result file: both posts asked for in one call, each judged on its own. */
export async function postsCaseResult(call: IntakeModelCall, c: PostsCase): Promise<{ id: string; pass: boolean; failures: string[] }> {
  const applyLinks = applyLinksOf();
  const r = await call(jobPostsPrompt, { ...c.job, applyLinks }, { inputRef: { eval: c.id } });
  const failures = r.ok ? PostChannel.options.flatMap((channel) => postFailures(channel, r.output[channel], c, applyLinks)) : [`the posts were not written: ${r.error}`];
  return { id: c.id, pass: failures.length === 0, failures };
}
