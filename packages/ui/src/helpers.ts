/**
 * Pure helpers behind the design-system components (docs/07). No React and no DOM, so server components, client
 * components and the unit tests share one copy of each rule: initials, score bands, keyboard movement, toast messages.
 */

/** The tones every pill, chip, dot and badge draws from. Colour never carries meaning alone: a word always goes with it. */
export type Tone = "neutral" | "good" | "caution" | "critical" | "accent";

/** Joins class names, leaving out the empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** A stable DOM id from React's useId, which may contain characters CSS selectors and ARIA references dislike. */
export function domId(prefix: string, reactId: string): string {
  return `${prefix}${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * Initials for an avatar: the first letter of the first and last words ("Priya Raman" → "PR"), one letter when asked
 * or when there is one word, and "?" when there is nothing to draw from. An email address uses the part before the @.
 * Bracketed asides such as pronouns are left out.
 */
export function initials(name: string | null | undefined, letters: 1 | 2 = 2): string {
  const words = (name ?? "")
    .split("@")[0]
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s._-]+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean);
  if (words.length === 0) return "?";
  const picked = letters === 1 || words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return picked.join("").toLocaleUpperCase();
}

export type ScoreBand = "very_high" | "high" | "medium" | "low";

/**
 * Match-score bands (plan adjustments §1). The badge is green from 70 and amber from 55; below that it stays plain grey,
 * because a low score is not an alarm. Red is kept for a missing must-have, which is shown as its own chip. The words
 * describe the number the code worked out and never reuse the AI reading's words ("Strong match", "Potential match",
 * "Weak match"), so nobody mistakes one for the other when both are on screen.
 */
export const SCORE_BANDS: ReadonlyArray<{ band: ScoreBand; min: number; label: string; tone: Tone }> = [
  { band: "very_high", min: 85, label: "Very high", tone: "good" },
  { band: "high", min: 70, label: "High", tone: "good" },
  { band: "medium", min: 55, label: "Medium", tone: "caution" },
  { band: "low", min: 0, label: "Low", tone: "neutral" },
];

/** The band for a 0-100 score (rounded and kept inside 0-100), or null when there is no score yet. */
export function scoreBand(score: number | null | undefined): { score: number; band: ScoreBand; label: string; tone: Tone } | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const s = Math.min(100, Math.max(0, Math.round(score)));
  const b = SCORE_BANDS.find((x) => s >= x.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
  return { score: s, band: b.band, label: b.label, tone: b.tone };
}

export type OwnerStage = "new" | "longlist" | "shortlist" | "interviewing" | "on_hold" | "offer" | "hired" | "not_moving_forward";

/**
 * The stages an owner sees for a candidate (plan adjustments §2), in the order the stage strip and the stage button list
 * them, each with the colour of its dot: green for good news, amber for on hold, ink for work under way, grey for new
 * and for not moving forward (never red: a decision is not an error). A view over the internal stages, which stay.
 */
export const OWNER_STAGES: ReadonlyArray<{ id: OwnerStage; label: string; tone: Tone }> = [
  { id: "new", label: "New", tone: "neutral" },
  { id: "longlist", label: "Longlist", tone: "accent" },
  { id: "shortlist", label: "Shortlist", tone: "good" },
  { id: "interviewing", label: "Interviewing", tone: "accent" },
  { id: "on_hold", label: "On hold", tone: "caution" },
  { id: "offer", label: "Offer", tone: "good" },
  { id: "hired", label: "Hired", tone: "good" },
  { id: "not_moving_forward", label: "Not moving forward", tone: "neutral" },
];

/** One stage's word and colour; an unknown one reads as New rather than showing a raw name. */
export function ownerStage(id: string): { id: OwnerStage; label: string; tone: Tone } {
  return OWNER_STAGES.find((s) => s.id === id) ?? OWNER_STAGES[0];
}

/** One line of the stage button's menu. */
export type StageChoice = { id: OwnerStage; label: string; tone: Tone; current: boolean; disabled?: boolean; reason?: string };

/**
 * The stage button's choices: every stage, the current one marked, and each move that is not allowed now kept in the
 * list, greyed, with its reason (`blocked`, from the page that knows the candidate), so nobody wonders where it went.
 */
export function stageMenuItems(current: string, blocked: Partial<Record<OwnerStage, string>> = {}): StageChoice[] {
  const now = ownerStage(current).id;
  return OWNER_STAGES.map((s) => {
    const reason = s.id === now ? undefined : blocked[s.id];
    return reason ? { ...s, current: false, disabled: true, reason } : { ...s, current: s.id === now };
  });
}

/** What a screen reader hears for a score badge. */
export function scoreLabel(score: number | null | undefined): string {
  const b = scoreBand(score);
  return b ? `Match score ${b.score} out of 100` : "No match score yet";
}

export type Move = "next" | "prev" | "first" | "last";

/**
 * Where the arrow keys, Home and End move in a row of tabs or a menu: round the ends, past anything `skip` rules out.
 * Stays put when nothing else can take focus.
 */
export function nextIndex(count: number, from: number, move: Move, skip: (i: number) => boolean = () => false): number {
  if (count <= 0) return -1;
  const step = move === "prev" || move === "last" ? -1 : 1;
  const start = move === "first" ? 0 : move === "last" ? count - 1 : from + step;
  for (let n = 0; n < count; n++) {
    const at = (((start + n * step) % count) + count) % count;
    if (!skip(at)) return at;
  }
  return from;
}

/** Typing a letter in an open menu moves to the next item whose label starts with it. */
export function typeaheadIndex(labels: readonly string[], from: number, char: string): number {
  const c = char.toLocaleLowerCase();
  for (let n = 1; n <= labels.length; n++) {
    const at = (((from + n) % labels.length) + labels.length) % labels.length;
    if (labels[at].trim().toLocaleLowerCase().startsWith(c)) return at;
  }
  return from;
}

/** The ids that tie a tab to its panel (aria-controls / aria-labelledby). */
export function tabIds(base: string, id: string): { tab: string; panel: string } {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return { tab: `${base}-tab-${safe}`, panel: `${base}-panel-${safe}` };
}

/** What holds the page still behind an open drawer: the body's inline overflow (a plain object in tests). */
export type ScrollHost = { style: { overflow: string } };

/** One count for every open drawer, however many are open and in whatever order they close. */
const scrollHold = { count: 0, saved: "" };

/**
 * Stops the page behind a drawer from scrolling, and returns the call that lets it go. The first hold saves the page's
 * own setting and the last release puts it back, so drawers that close together in any order (React unmounts a
 * drawer before the sheet opened from inside it) never leave the page stuck. A release only counts once.
 */
export function holdPageScroll(host: ScrollHost): () => void {
  if (scrollHold.count === 0) {
    scrollHold.saved = host.style.overflow;
    host.style.overflow = "hidden";
  }
  scrollHold.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollHold.count -= 1;
    if (scrollHold.count === 0) host.style.overflow = scrollHold.saved;
  };
}

export type StepState = "done" | "active" | "waiting" | "failed";

/** Spoken after each step of a progress list, so the state is not carried by the tick or the spinner alone. */
export const STEP_STATE_TEXT: Record<StepState, string> = { done: "done", active: "working on it", waiting: "not started yet", failed: "did not finish" };

/** The window event the toast() helper sends and the Toaster listens for. */
export const TOAST_EVENT = "ros:toast";

export type ToastTone = "neutral" | "good" | "critical";

/** A toast: what happened, and optionally a second line on what did or did not follow ("The candidate was not told."). */
export type ToastMessage = { title: string; detail?: string; tone?: ToastTone };

/**
 * What toast() puts on the event: a plain string when there is only a title (the shape every Toaster has understood
 * from the start), a ToastMessage when there is a second line or a tone.
 */
export function toastPayload(title: string, more?: string | { detail?: string; tone?: ToastTone }): string | ToastMessage {
  const extra = typeof more === "string" ? { detail: more } : (more ?? {});
  if (!extra.detail && !extra.tone) return title;
  const message: ToastMessage = { title };
  if (extra.detail) message.detail = extra.detail;
  if (extra.tone) message.tone = extra.tone;
  return message;
}

/** Accepts both shapes a toast travels in: a plain string (title only) or a ToastMessage. Anything else is ignored. */
export function normalizeToast(input: unknown): ToastMessage | null {
  if (typeof input === "string") return input.trim() ? { title: input } : null;
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) return null;
  const message: ToastMessage = { title: o.title };
  if (typeof o.detail === "string" && o.detail.trim()) message.detail = o.detail;
  if (o.tone === "neutral" || o.tone === "good" || o.tone === "critical") message.tone = o.tone;
  return message;
}

/** How long a toast stays: never less than the old 2.6 seconds, plus reading time for longer messages, at most 9 seconds. */
export function toastDuration(m: ToastMessage): number {
  const words = `${m.title} ${m.detail ?? ""}`.trim().split(/\s+/).length;
  return Math.min(9000, Math.max(2600, 1200 + words * 260));
}
