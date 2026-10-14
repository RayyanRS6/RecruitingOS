import { formatPayRange } from "@ros/contracts";
import type { RolePacket, ShareView } from "./api/client";
import type { CompanyCheck } from "./company-check";

/**
 * The LinkedIn post on the Share tab (Wave S2, slice K3), the pure parts: three tones of ready-made words built only
 * from the job's own facts (title, company, place, how it is worked, the kind of job, the pay when the job page shows
 * it, up to three must-haves and the link), the character count and the link swap. No AI, no LinkedIn API: the person
 * copies the words, LinkedIn opens in a new tab and they post it themselves. Same facts, same words, every time, so
 * tests/web/linkedin-post.test.ts can check every sentence without a browser.
 */

export type PostTone = "proud" | "straight" | "friendly";

/** The tones, in the order they are offered, each with a short line saying how it reads. */
export const POST_TONES: ReadonlyArray<{ key: PostTone; label: string; hint: string }> = [
  { key: "proud", label: "Proud", hint: "Upbeat: big news, we're hiring" },
  { key: "straight", label: "Straight", hint: "Just the facts" },
  { key: "friendly", label: "Friendly", hint: "Warm: asks people to share it" },
];

/** The longest post LinkedIn takes, in characters. */
export const LINKEDIN_MAX = 3000;

/** Where "Copy and open LinkedIn" goes: the person's own feed, with the box for a new post open. */
export const LINKEDIN_OPEN_URL = "https://www.linkedin.com/feed/?shareActive=true";

/**
 * Whether the Share tab offers the post, and the addresses it uses. The Share tab's rule for the public link: a live
 * job (open) whose company ITS has confirmed (founder decision B7), so the address in the post never answers "not
 * found". `linkUrl` is the job's own LinkedIn link once one was made (the LinkedIn share button makes the same one).
 */
export function linkedInPostLink(input: { roleStatus: string; check: CompanyCheck; publishing?: { state: string } | null; share?: Pick<ShareView, "jobUrl" | "places"> | null; jobUrl?: string | null }): { jobUrl: string; linkUrl: string | null } | null {
  if (input.roleStatus !== "open" || input.check === "waiting" || input.publishing?.state === "waiting_for_company_check") return null;
  const jobUrl = input.share?.jobUrl || input.jobUrl || "";
  if (!jobUrl) return null;
  return { jobUrl, linkUrl: input.share?.places?.find((p) => p.place === "linkedin")?.link?.url ?? null };
}

/** The Share tab opened at the LinkedIn post (the jobs list's "Post on LinkedIn" goes to the same place). */
export function linkedInPostHref(roleId: string): string {
  return `/roles/${encodeURIComponent(roleId)}?tab=share#linkedin`;
}

/** The most must-haves a post lists; the job page has the rest. */
const MAX_MUST_HAVES = 3;

/** What a post is made of: the job's own facts, nothing invented. Empty parts are left out of the words. */
export type PostFacts = { title: string; company: string | null; place: string | null; workModel: string | null; employment: string | null; pay: string | null; mustHaves: string[]; url: string };

const WORK_MODEL: Record<string, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const EMPLOYMENT: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };

/** One line, no doubled spaces: what a fact looks like once it is in the post. */
function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The post's facts from the job as GET /roles/:id answers it. The pay goes in only when the job page shows it
 * (`payShown`, the server's rule; the owner's own choice on an older answer), so a post never says more than the ad.
 */
export function postFactsOf(input: { title: string; companyName: string | null | undefined; packet?: Pick<RolePacket, "identity" | "compensation" | "requirements"> | null; payShown?: boolean | null; url: string }): PostFacts {
  // an older or partial answer may leave a part out: every part is read with care
  const p = input.packet ?? null;
  const identity = p?.identity;
  const places = (identity?.locations ?? []).map((l) => clean([l.city, l.region].filter(Boolean).join(", "))).filter(Boolean);
  const more = places.length - 1;
  const place = places.length ? (more > 0 ? `${places[0]} and ${more} more ${more === 1 ? "place" : "places"}` : places[0]) : null;
  const comp = p?.compensation;
  const shown = comp ? (input.payShown ?? comp.discloseRange ?? false) : false;
  const kind = identity?.employmentType ?? "";
  return {
    title: clean(identity?.title) || clean(input.title),
    company: clean(input.companyName) || null,
    place,
    workModel: identity?.remotePolicy ? WORK_MODEL[identity.remotePolicy] ?? null : null,
    employment: kind ? EMPLOYMENT[kind] ?? (clean(kind.replace(/_/g, " ")) || null) : null,
    pay: shown && comp ? formatPayRange(comp) : null,
    mustHaves: (p?.requirements?.mustHaves ?? []).map((m) => clean(m.text)).filter(Boolean).slice(0, MAX_MUST_HAVES),
    url: input.url,
  };
}

/** "#DentalHygienist": the job title as one hashtag, or "" when it has no letters to make one from. */
export function titleHashtag(title: string): string {
  const words = title.normalize("NFKD").replace(/[^A-Za-z0-9 ]+/g, " ").split(" ").filter(Boolean);
  const tag = words.map((w) => (w === w.toUpperCase() ? w : `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`)).join("");
  return tag && tag.length <= 40 && /[A-Za-z]/.test(tag) ? `#${tag}` : "";
}

/** The facts as short lines ("Where: Irvine, CA · On site"), each left out when it is not known. */
function factLines(f: PostFacts, labelled: boolean): string[] {
  const where = [f.place, f.workModel].filter(Boolean).join(" · ");
  if (!labelled) {
    return [[where, f.employment].filter(Boolean).join(" · "), f.pay ? `Pay: ${f.pay}` : ""].filter(Boolean);
  }
  return [where ? `Where: ${where}` : "", f.employment ? `Type: ${f.employment}` : "", f.pay ? `Pay: ${f.pay}` : ""].filter(Boolean);
}

function bullets(items: readonly string[]): string[] {
  return items.map((m) => `• ${m}`);
}

/** Paragraphs joined by a blank line; an empty one is dropped, so a missing fact never leaves a gap. */
function paragraphs(parts: ReadonlyArray<string | readonly string[]>): string {
  return parts
    .map((p) => (typeof p === "string" ? p : p.filter(Boolean).join("\n")))
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The words of the post in a tone, from the job's own facts. */
export function linkedInPostText(tone: PostTone, f: PostFacts): string {
  const tags = ["#hiring", titleHashtag(f.title)].filter(Boolean).join(" ");
  const musts = f.mustHaves.length ? bullets(f.mustHaves) : [];
  switch (tone) {
    case "proud":
      return paragraphs([
        // only the job's facts: "growing" is not one of them (a replacement hire is not growth)
        f.company ? `Big news: ${f.company} is hiring.` : "Big news: we're hiring.",
        [`Job: ${f.title}`, ...factLines(f, true)],
        musts.length ? ["What you'll bring:", ...musts] : "",
        `We're proud of our team and can't wait to meet the next person to join it. Apply here: ${f.url}`,
        tags,
      ]);
    case "straight":
      return paragraphs([
        f.company ? `${f.company} is hiring: ${f.title}` : `We're hiring: ${f.title}`,
        factLines(f, false),
        musts.length ? ["Must-haves:", ...musts] : "",
        `Apply: ${f.url}`,
        tags,
      ]);
    case "friendly":
      return paragraphs([
        "Know someone who would love this job? We'd be glad of the introduction.",
        [f.company ? `${f.company} is looking for someone to join the team as ${f.title}.` : `We're looking for someone to join the team as ${f.title}.`, ...factLines(f, true)],
        musts.length ? ["It helps if you have:", ...musts] : "",
        [`Have a look and apply here: ${f.url}`, "Sharing this post helps too. Thank you!"],
        tags,
      ]);
    default:
      return "";
  }
}

/** How long the post is as LinkedIn counts it: characters, so an emoji or an accented letter counts once. */
export function postLength(text: string): number {
  return Array.from(text).length;
}

/** "1,204 of 3,000 characters", or how far over LinkedIn's limit it is. */
export function postLengthLine(text: string): { line: string; over: boolean } {
  const n = postLength(text);
  const max = LINKEDIN_MAX.toLocaleString("en-US");
  if (n > LINKEDIN_MAX) return { line: `${n.toLocaleString("en-US")} of ${max} characters: ${(n - LINKEDIN_MAX).toLocaleString("en-US")} too many for LinkedIn.`, over: true };
  return { line: `${n.toLocaleString("en-US")} of ${max} characters`, over: false };
}

/**
 * The post with the LinkedIn link of its own in place of the job page's address, wherever the address is in the words,
 * so applicants who come from the post show LinkedIn as their source. Words without the address are left as they are.
 */
export function withTrackedLink(text: string, jobUrl: string, linkUrl: string): string {
  if (!jobUrl || !linkUrl || jobUrl === linkUrl) return text;
  return text.split(jobUrl).join(linkUrl);
}

/** The preview's pieces: plain words, and the web addresses (drawn in the link colour, as LinkedIn shows them). */
export function previewParts(text: string): Array<{ text: string; link: boolean }> {
  const out: Array<{ text: string; link: boolean }> = [];
  const re = /https?:\/\/[^\s]+/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), link: false });
    out.push({ text: m[0], link: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), link: false });
  return out;
}
