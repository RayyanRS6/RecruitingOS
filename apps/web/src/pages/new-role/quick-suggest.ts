import type { QuickAnswers } from "./quick-start";
import { guideRoleFor } from "./quick-starts";

/**
 * AI suggestions in the quick start (Wave S3, G3). When one of our hiring guides knows the job, its must-haves and
 * questions show at once, as before. For any other job, the assistant suggests must-have skills and yes/no questions
 * from the answers so far (POST /api/v1/intake/suggestions: the title, the kind of job, the work model and place, the
 * least experience; never anything about a candidate). Every line passed the server's fairness check before it comes
 * back. The call runs once per set of answers: its answer is kept with the answers (`aiSuggest`, under the key of the
 * answers it was made from), so a reload or going back and forth never asks again, and changed answers ask once more.
 * It never holds anyone up: while it runs the step says so in one line, and when it fails or is slow nothing is shown
 * and "add your own" stays. Nothing here needs a browser, so tests/web/start-hire-quick-suggest.test.ts checks it.
 */

export const SUGGEST_PATH = "/api/v1/intake/suggestions";
/** The page stops waiting after this long and shows nothing (the server gives the model about 20 seconds). */
export const SUGGEST_TIMEOUT_MS = 25_000;
export const SUGGEST_MUST_HAVES_MAX = 8;
export const SUGGEST_QUESTIONS_MAX = 4;

/** What the step says while the assistant works. */
export const SUGGESTING_SKILLS = "Suggesting skills from your answers…";
export const SUGGESTING_QUESTIONS = "Suggesting questions from your answers…";
/** The note beside each of the assistant's suggestions (the guide's say "Our hiring guide"). */
export const AI_NOTE = "AI suggestion";

/** The assistant's suggestions, and the answers they were made from (`key`). */
export type AiSuggest = { key: string; mustHaves: string[]; questions: string[] };

/** The answers the suggestions are made from: the job's own facts only. */
export type SuggestBody = { title: string; employmentType?: string; remotePolicy?: string; place?: string; experience?: string };

type SuggestAnswers = Partial<Pick<QuickAnswers, "title" | "employmentType" | "remotePolicy" | "place" | "experience" | "aiSuggest">>;

const tidy = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The request's body, or null while there is no title to suggest from. */
export function suggestBody(a: SuggestAnswers): SuggestBody | null {
  const title = tidy(a.title).slice(0, 120);
  if (!title) return null;
  const out: SuggestBody = { title };
  if (a.employmentType) out.employmentType = a.employmentType;
  if (a.remotePolicy) out.remotePolicy = a.remotePolicy;
  const place = tidy(a.place).slice(0, 200);
  if (place) out.place = place;
  if (a.experience) out.experience = a.experience;
  return out;
}

/** The set of answers, as one key: the same answers, however spaced or capitalised, are the same set. */
export function suggestKey(a: SuggestAnswers): string {
  const b = suggestBody(a);
  if (!b) return "";
  return JSON.stringify([b.title, b.employmentType ?? "", b.remotePolicy ?? "", b.place ?? "", b.experience ?? ""].map((x) => x.toLowerCase()));
}

export const suggestQueryKey = (key: string) => ["intake", "suggest", key] as const;

/** Whether the assistant is asked: a title is typed and no hiring guide knows the job. */
export function wantsAiSuggestions(vertical: string | null | undefined, a: SuggestAnswers): boolean {
  return !!suggestBody(a) && !guideRoleFor(vertical, a.title ?? "");
}

/** The kept suggestions when they were made from these very answers, else null (answers changed since: ask again). */
export function aiSuggestFor(a: SuggestAnswers): AiSuggest | null {
  const s = a.aiSuggest;
  return s && s.key && s.key === suggestKey(a) ? s : null;
}

const strings = (v: unknown, max: number, chars: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = tidy(x).slice(0, chars);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

/** The server's answer as kept: null when the assistant could not answer (`unavailable`) or the answer is not one. */
export function readSuggestResponse(raw: unknown, key: string): AiSuggest | null {
  if (!raw || typeof raw !== "object" || !key) return null;
  const r = raw as { mustHaves?: unknown; questions?: unknown; unavailable?: unknown };
  if (r.unavailable === true || !Array.isArray(r.mustHaves) || !Array.isArray(r.questions)) return null;
  return { key, mustHaves: strings(r.mustHaves, SUGGEST_MUST_HAVES_MAX, 200), questions: strings(r.questions, SUGGEST_QUESTIONS_MAX, 300) };
}

/** Kept suggestions read back from this browser's storage, or null. */
export function readAiSuggest(v: unknown): AiSuggest | null {
  if (!v || typeof v !== "object") return null;
  const key = (v as { key?: unknown }).key;
  if (typeof key !== "string" || !key || key.length > 1000) return null;
  return readSuggestResponse(v, key);
}

/**
 * The answers with an arrived suggestion kept. `seen` is whether the person is still on a step that shows it (up to the
 * questions step). An answer that lands after they moved past the questions (the call can take 25 seconds) is kept,
 * but its questions start unticked: a question they never saw never goes on the form. Must-haves always start unticked.
 */
export function adoptSuggestion<A extends Pick<QuickAnswers, "questionsOff" | "aiSuggest">>(a: A, fresh: AiSuggest, seen: boolean): A {
  if (a.aiSuggest?.key === fresh.key) return a;
  const unseen = seen ? [] : fresh.questions.filter((q) => !a.questionsOff.some((x) => x.toLowerCase() === q.toLowerCase()));
  return { ...a, aiSuggest: fresh, ...(unseen.length ? { questionsOff: [...a.questionsOff, ...unseen] } : {}) };
}

type Post = (path: string, body: unknown, init?: RequestInit) => Promise<unknown>;

/**
 * Asks for the suggestions; null when the call fails or takes longer than `timeoutMs` (the page then shows nothing).
 * `signal` is the query's own: leaving the page stops the call.
 */
export async function fetchSuggestions(post: Post, body: SuggestBody, key: string, signal?: AbortSignal, timeoutMs = SUGGEST_TIMEOUT_MS): Promise<AiSuggest | null> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => { stop(); resolve(null); }, timeoutMs);
  });
  try {
    const answer = post(SUGGEST_PATH, body, { signal: ctrl.signal }).then((raw) => readSuggestResponse(raw, key), () => null);
    return await Promise.race([answer, late]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * What the must-haves and questions steps show: the guide's suggestions (`guide`), the one line while the assistant
 * works (`waiting`), its suggestions (`ai`), or nothing beyond "add your own" (`none`). `fresh` is an answer that has
 * just arrived and is not kept yet; `waiting` is whether the call is running.
 */
export type SuggestView = { kind: "guide" } | { kind: "waiting" } | { kind: "ai"; mustHaves: string[]; questions: string[] } | { kind: "none" };

export function suggestView(vertical: string | null | undefined, a: SuggestAnswers, opts: { fresh?: AiSuggest | null; waiting?: boolean } = {}): SuggestView {
  if (guideRoleFor(vertical, a.title ?? "")) return { kind: "guide" };
  const key = suggestKey(a);
  if (!key) return { kind: "none" };
  const kept = aiSuggestFor(a) ?? (opts.fresh && opts.fresh.key === key ? opts.fresh : null);
  if (kept) return { kind: "ai", mustHaves: kept.mustHaves, questions: kept.questions };
  return opts.waiting ? { kind: "waiting" } : { kind: "none" };
}
