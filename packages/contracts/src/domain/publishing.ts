import { z } from "zod";
import { CalendarDate } from "./common";
import { AI_HELP_LINE } from "./plans";

/**
 * Publishing a job, and what the company shares. A person on the team (owner, admin or member) publishes with one
 * button once the checks below pass: the job opens, and its job page and the careers page are public at once. Nobody
 * else approves it. The company then posts on LinkedIn and Indeed itself, with our job page as the Apply link.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The job's public addresses.                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** The careers page, the job page and the application form of one job. */
export type JobUrls = { careers: string; job: string; apply: string };

/**
 * Where an applicant came from: a short word carried as `?src=<word>` on the job page and the application form
 * (letters, digits and dashes), and recorded as the application's source.
 */
export const ApplySource = z.string().regex(/^[A-Za-z0-9-]{1,40}$/);

/** The Apply link a post carries: the job page's address with the source on it, so candidates land on the job page. */
export function applyLinkFor(jobUrl: string, source: string): string {
  return `${jobUrl}${jobUrl.includes("?") ? "&" : "?"}src=${encodeURIComponent(source)}`;
}

/** How a source reads on screen: "LinkedIn", "Indeed", "Job page" when someone came with no source, else the word itself. */
export function applySourceLabel(source: string | null | undefined): string {
  const s = (source ?? "").trim().toLowerCase();
  if (!s || s === "direct" || s === "careers_page") return "Job page";
  if (s === "linkedin" || s === "linkedin_basic") return "LinkedIn";
  if (s === "indeed") return "Indeed";
  return `${s[0].toUpperCase()}${s.slice(1)}`.replace(/[-_]+/g, " ");
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The two posts on a job's Share tab.                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** The places a job's Share tab has a ready post for. Each post's Apply link carries the channel as its source. */
export const PostChannel = z.enum(["linkedin", "indeed"]);
export type PostChannel = z.infer<typeof PostChannel>;
export const POST_CHANNEL_LABEL: Record<PostChannel, string> = { linkedin: "LinkedIn post", indeed: "Indeed post" };

export const POST_TEXT_MAX = 8000;

/**
 * What the AI stage `job.posts` writes for a published job, from the job's public facts only: a short LinkedIn post in
 * the company's voice and a listing text in Indeed's usual shape, each carrying its Apply link. Both pass the fairness
 * guard on wording, and both show the pay where a pay transparency law asks for it.
 */
export const JobPosts = z.object({ linkedin: z.string().trim().min(1).max(POST_TEXT_MAX), indeed: z.string().trim().min(1).max(POST_TEXT_MAX) });
export type JobPosts = z.infer<typeof JobPosts>;

/** One post as stored on the job. `edited`: a person changed the words; an automatic rewrite never replaces an edited post. */
export const StoredPost = z.object({ text: z.string().max(POST_TEXT_MAX), edited: z.boolean().default(false), writtenAt: z.string() });
export type StoredPost = z.infer<typeof StoredPost>;

/**
 * Where the writing of the posts stands. `writing`: the background job is running (ask again in a few seconds);
 * `ready`: written; `no_ai`: the plan's AI help is used up, so the person writes their own; `failed`: the writing did
 * not work, and "Write again" tries once more.
 */
export const PostsState = z.enum(["writing", "ready", "no_ai", "failed"]);
export type PostsState = z.infer<typeof PostsState>;

/**
 * The plain lines a job's Share tab shows. The API sends the one that applies (`ShareView.stateLine` for `no_ai` and
 * `failed`, `ShareView.notPublicLine` for a draft and a closed job); a screen shows what it gets.
 */
export const SHARE_LINE = {
  noAi: AI_HELP_LINE.posts,
  failed: "The posts could not be written. Press Write again, or write your own.",
  draft: "Publish the job to share it.",
  closed: "This job is closed, so its job page is no longer public.",
} as const;

/** The two posts of a job (`roles.posts`): the texts, and where their writing stands. Null on a job never published. */
export const RolePosts = z.object({
  linkedin: StoredPost.nullable().default(null),
  indeed: StoredPost.nullable().default(null),
  state: PostsState,
  /** The job version the posts were last written from. */
  version: z.number().int().nullable().default(null),
});
export type RolePosts = z.infer<typeof RolePosts>;

/* ------------------------------------------------------------------------------------------------------------ */
/* The closing date.                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * POST /api/v1/roles/:id/closing-date and PUT /api/v1/intake/sessions/:id/closing-date: the last day new applications
 * are taken, in the company's time zone, or null to take the date off. A later date also takes applications again when
 * the earlier date had stopped them.
 */
export const SetClosingDate = z.object({ closesOn: CalendarDate.nullable() });
export type SetClosingDate = z.infer<typeof SetClosingDate>;

/**
 * A job's closing date. `closesAt` is the moment applications stop (the end of `closesOn` in `timeZone`); `applyBy` is
 * the line the job and careers pages show; `defaultIfMissing` is the date a job gets when it is published without one
 * where a state's law asks for a date; `applicationsClosedByDate` says the date has passed and stopped applications.
 */
export type ClosingDateView = {
  closesOn: string | null;
  closesAt: string | null;
  applyBy: string | null;
  timeZone: string;
  requiredByLaw: boolean;
  defaultIfMissing: string | null;
  passed: boolean;
  applicationsClosedByDate: boolean;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* The checks before publishing.                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * One thing the law asks of the job ad in the job's places. `blocking` items stop publishing until they are met;
 * `pendingCounsel` names places our lawyer has not confirmed yet, which never block.
 */
export type LegalCheckItem = {
  key: "pay_range" | "benefits" | "closing_date";
  label: string;
  met: boolean;
  blocking: boolean;
  /** The places whose law asks for it (US-CO, ...); for a remote job, every place with such a law. */
  jurisdictions: string[];
  pendingCounsel: string[];
  /** What is wrong or what will happen, in plain words. */
  detail: string;
  /** How to fix it, in plain words; null when nothing is needed. */
  fix: string | null;
};
/** The legal check of a job or a draft: `missing` are the blocking items not met. */
export type LegalCheck = { jurisdictions: string[]; remote: boolean; items: LegalCheckItem[]; missing: LegalCheckItem[] };

/**
 * Why a job cannot be published yet. `essential_missing`: one of the builder's essentials is not set (one blocker
 * each); `pay_not_confirmed`: no person has set or confirmed the pay; `no_draft`: the job has not been written;
 * `draft_out_of_date`: answers changed after it was written; `open_flags`: a flagged phrase is neither reworded nor
 * kept with a reason; `legal_check`: the law of the job's places asks for something it lacks (one blocker each);
 * `plan`: the plan has no room for another job; `trial_ended`: the trial ended and no plan was chosen.
 */
export const PublishBlockerCode = z.enum(["essential_missing", "pay_not_confirmed", "no_draft", "draft_out_of_date", "open_flags", "legal_check", "plan", "trial_ended"]);
export type PublishBlockerCode = z.infer<typeof PublishBlockerCode>;
export type PublishBlocker = { code: PublishBlockerCode; message: string };

/** Whether "Publish job" may be pressed now, and each plain reason when not. Worked out on the server; a screen only shows it. */
export type PublishCheck = { allowed: boolean; blockers: PublishBlocker[] };
