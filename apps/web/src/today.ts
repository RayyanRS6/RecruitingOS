import type { GettingStartedAction, GettingStartedStep } from "@ros/contracts";
import { jobHref, RAIL_ROLE_LIMIT, rolesInProgress } from "./rail";

/**
 * Home's pure pieces (plans B2 and B9; the simple, Kanvis-like Home of 14 October 2026), kept out of the page so they
 * can be checked without a browser. (The file keeps its old name: Home was called Today.)
 *
 * Home keeps itself current: its cards and updates are asked for again when the window comes back into focus, and
 * every minute while the page is open and visible (never in a hidden tab). The app's default is neither
 * (apps/shell/components/Providers.tsx), so a half-filled form elsewhere is never reloaded under someone.
 */
export const TODAY_REFRESH = { refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false } as const;

/** The step whose first button is the primary one: the first that is not done yet. */
export function nextStep(steps: readonly GettingStartedStep[]): GettingStartedStep | undefined {
  return steps.find((s) => !s.done);
}

/** What a getting-started button says it did, in two short lines (a request to ITS is answered by the API's own words). */
export function setupActionToast(action: GettingStartedAction): { title: string; detail?: string } {
  if (action.path.includes("/escalations")) return { title: "Sent to ITS." };
  if (action.body?.action === "dismiss") return { title: "Steps hidden.", detail: "Only for you; the rest of your team still sees theirs." };
  if (action.body?.action === "policies_reviewed") return { title: "Marked as reviewed.", detail: "You can change the AI rules in Settings at any time." };
  return { title: "Done." };
}

/** How many rows "Needs you" shows before "Show N more". */
export const HOME_ROWS = 5;

/** How long a row's one visible line may be before it is cut (the whole text stays behind "Why"). */
export const LINE_MAX = 120;

/** Cards that only say what is happening (a recruiter has a request, people are answering the screening chat): listed last, never counted as needing you. */
const FYI_KINDS: ReadonlySet<string> = new Set(["escalation", "screening"]);
export const isFyi = (kind: string): boolean => FYI_KINDS.has(kind);

/**
 * The brief's cards as Home lays them out: getting started in a card of its own, the "nothing waiting" card only when
 * nothing else is listed, and every other card a row under "Needs you", the ones that need a person first (the
 * server's order kept within each).
 */
export function homeRows<T extends { kind: string }>(cards: readonly T[]): { setup: T | null; rows: T[]; empty: T | null } {
  const setup = cards.find((c) => c.kind === "getting_started") ?? null;
  const empty = cards.find((c) => c.kind === "empty") ?? null;
  const rest = cards.filter((c) => c.kind !== "getting_started" && c.kind !== "empty");
  return { setup, rows: [...rest.filter((c) => !isFyi(c.kind)), ...rest.filter((c) => isFyi(c.kind))], empty };
}

/** The one line under the greeting: how many things need this person, or that nothing does. */
export function homeHeadline(needs: number, opts: { firstRun?: boolean } = {}): string {
  if (needs > 0) return `${needs} ${needs === 1 ? "thing needs" : "things need"} you`;
  return opts.firstRun ? "Start with your first hire" : "All caught up";
}

/** "Dana" from "Dana Whitfield", for the greeting; nothing when the name is not known. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Titles and short forms whose full stop does not end a sentence ("Dr. Lee Dental", "Sr. Hygienist", "e.g. a crown"). */
const TITLE_BEFORE = /(?:^|[^\p{L}.])(?:Dr|Mrs?|Ms|Sr|Jr|St)$/u;
const SHORT_FORM_BEFORE = /(?:^|[\s("“])(?:e\.g|i\.e)$/i;

/** Whether the text just before a full stop is a title or short form ("Sr", "e.g"), so the stop does not end the sentence. */
export function abbreviationBefore(before: string): boolean {
  return TITLE_BEFORE.test(before) || SHORT_FORM_BEFORE.test(before);
}

/** Where the first sentence of a line ends (just past its mark and any closing quote), or -1 when it is all one sentence. */
export function firstSentenceEnd(text: string): number {
  const mark = /[.!?]["”')]?(?=\s|$)/g;
  for (let m = mark.exec(text); m; m = mark.exec(text)) {
    if (m.index === 0 || (m[0][0] === "." && abbreviationBefore(text.slice(0, m.index)))) continue;
    return m.index + m[0].length;
  }
  return -1;
}

/**
 * A card's one visible line and the rest, which goes behind "Why": the first sentence of the first paragraph (a title
 * such as "Dr." or "Sr." does not end it). A sentence longer than `max` is cut at a word and the whole text goes behind
 * "Why", so nothing is lost.
 */
export function cardLine(body: string | null | undefined, max = LINE_MAX): { line: string; rest: string } {
  const text = (body ?? "").trim();
  if (!text) return { line: "", rest: "" };
  const first = text.split("\n")[0].trim();
  const end = firstSentenceEnd(first);
  const sentence = end > 0 ? first.slice(0, end) : first;
  if (sentence.length <= max) return { line: sentence, rest: text.slice(sentence.length).trim() };
  const cut = sentence.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return { line: `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`, rest: text };
}

/** What a row's fold says it opens: the message itself on a card asking to send one, else why the card is there. */
export function moreLabel(card: { kind: string; body: string }): string {
  return card.kind === "decision" && /\n\s*\n/.test(card.body) ? "Read the message" : "Why";
}

/** A row's buttons: up to three on the row; past three, the first two and the rest under "More". */
export function splitActions<T>(actions: readonly T[]): { shown: T[]; more: T[] } {
  return actions.length <= 3 ? { shown: [...actions], more: [] } : { shown: actions.slice(0, 2), more: actions.slice(2) };
}

type JobLike = { id: string; title: string; status: string; openedAt?: string | null; createdAt?: string | null; counts?: (Record<string, number> & { total?: number }) | null; stageCounts?: Partial<Record<string, number>> | null; countsHidden?: boolean; needsYou?: number };

/** One row of "Your jobs" on Home: where it opens and its few facts ("3 new · 2 to review"). */
export type HomeJob = { id: string; title: string; status: string; href: string; facts: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The facts on a job's row: for a job that has gone live, how many are new and how many wait for review (or how many
 * applied, or that nobody has yet); for a draft or a job waiting for approval, that it is not live yet; and any
 * decisions waiting on the job. An interviewer's list carries no counts, so their rows say nothing more. The Jobs page's
 * line (talent-list.ts jobCardFacts) uses the same words and also leaves out a count of nothing.
 */
export function homeJobFacts(r: JobLike, viewer: { role: string | null }): string {
  if (viewer.role === "interviewer" || r.countsHidden) return "";
  const parts: string[] = [];
  if (r.status === "draft" || r.status === "pending_approval") parts.push("Not live yet");
  else {
    const total = r.counts?.total ?? 0;
    const fresh = r.stageCounts?.new ?? 0;
    const review = r.counts?.waiting_on_you ?? 0;
    if (!total) parts.push("No applicants yet");
    else {
      if (fresh) parts.push(`${fresh} new`);
      if (review) parts.push(`${review} to review`);
      if (!fresh && !review) parts.push(plural(total, "applicant", "applicants"));
    }
  }
  if (r.needsYou) parts.push(plural(r.needsYou, "decision waiting", "decisions waiting"));
  return parts.join(" · ");
}

/** "Your jobs" on Home: the same jobs as under Jobs in the rail, in the same order, each opening where the rail's does. */
export function homeJobs(roles: ReadonlyArray<JobLike>, viewer: { role: string | null }, limit = RAIL_ROLE_LIMIT): HomeJob[] {
  return rolesInProgress(roles, limit).map((r) => ({ id: r.id, title: r.title, status: r.status, href: jobHref(r, { talent: viewer.role !== "interviewer" }), facts: homeJobFacts(r, viewer) }));
}
