import { OWNER_STAGE_LABEL, OwnerStage as OwnerStageEnum } from "@ros/contracts";
import type { Tone } from "@ros/ui";
import type { ApplicationSummary, CancelledReason, OwnerStage, RoleSummary, StageStripCounts, ToldState } from "./api/client";
import { cancelledReasonFrom } from "./cancelled";
import { SAFETY_NET_WORKING_DAYS } from "./telling";

/**
 * The Candidates list (plan A3; founder decisions B2, B3 and B6; Wave S1), kept free of React so it can be tested: the
 * stage strip, the chips on a row, the filters, search and the four orders. The AI review's words only filter; the list
 * can be ordered by the match score, the number worked out by code from the checked findings (B2), as well as newest
 * first, waiting longest and by name. Also the one line on each job in the Jobs list.
 */

/**
 * The day-5 safety net in one short line (founder decision D-03), for the places that say a decision is private but know
 * neither each person's day nor the company's message setting: the "Not told yet" list, the pool board's Review and
 * apply. The candidate's own page says the day (telling.ts safetyNetLine).
 */
export const SAFETY_NET_NOTE = `If nobody tells them within ${SAFETY_NET_WORKING_DAYS} working days, the standard message goes by itself (or an ITS recruiter is brought in, if your settings say so).`;

/** The latest reading in a word: the chip on each row and the reading filter. */
export type Reading = "strong" | "potential" | "weak" | "missing_must_have" | "closer_look" | "insufficient" | "none";
export const READING: Record<Exclude<Reading, "none">, { label: string; tone: Tone }> = {
  strong: { label: "Strong match", tone: "good" },
  potential: { label: "Potential match", tone: "accent" },
  weak: { label: "Weak match", tone: "neutral" },
  // red only for a must-have the evidence shows is missing (plan adjustments §5)
  missing_must_have: { label: "Missing a must-have", tone: "critical" },
  closer_look: { label: "Needs a closer look", tone: "caution" },
  insufficient: { label: "Not enough evidence", tone: "neutral" },
};

/**
 * One reading per row, from the latest reading only: "needs a closer look" first (the assistant could not say enough),
 * then a must-have the evidence shows is missing, then the overall reading.
 */
export function readingOf(a: Pick<ApplicationSummary, "assessment" | "evidence">): Reading {
  if (a.evidence?.needsCloserLook) return "closer_look";
  if (a.evidence?.hasProvenMiss) return "missing_must_have";
  switch (a.assessment?.overall) {
    case "strong":
      return "strong";
    case "potential":
      return "potential";
    case "weak":
      return "weak";
    case "unknown":
      return "insufficient";
    default:
      return "none";
  }
}

export type ReadingFilter = "any" | "strong" | "potential" | "missing_must_have" | "closer_look";
export const READING_FILTERS: ReadonlyArray<{ id: ReadingFilter; label: string }> = [
  { id: "any", label: "All matches" },
  { id: "strong", label: "Strong match" },
  { id: "potential", label: "Potential match" },
  { id: "missing_must_have", label: "Missing a must-have" },
  { id: "closer_look", label: "Needs a closer look" },
];

/** `score`: the match score, highest first; people with no score yet last, newest first among equals. */
export type Order = "score" | "newest" | "waiting" | "name";
export const ORDERS: ReadonlyArray<{ id: Order; label: string }> = [
  { id: "score", label: "Score" },
  { id: "newest", label: "Newest first" },
  { id: "waiting", label: "Waiting longest" },
  { id: "name", label: "Name" },
];

/**
 * What the list shows. `stage` is a column of the strip (or everyone); `waiting` keeps the people waiting on you;
 * `applying` keeps the people still applying (plan E6); `internalStage` and `told` come from links (Today's "held on an
 * eligibility answer", "not told yet") and show as removable chips. `cancelledReason` narrows the Cancelled column to
 * one reason (asked for new times, no longer interested, no-show; founder decision 2A), from its chips or `?cancelled=`.
 */
export type TalentView = { stage: OwnerStage | "all"; waiting: boolean; applying: boolean; reading: ReadingFilter; query: string; order: Order; internalStage: string | null; told: ToldState | null; cancelledReason: CancelledReason | null };

/* ------------------------------------------------------------------------------------------------------------ */
/* Still applying (plan E6)                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export const STILL_APPLYING_LABEL = "Still applying";
/** Said above the list while it shows the people still applying. */
export const STILL_APPLYING_TEXT = "They sent the form and are still on the screening questions. Nothing about them waits on you until they send their answers; you are told then.";

/**
 * Someone still in the visit that sent their application: offered the screening chat with it and not finished,
 * sent without it, handed to a person or closed. They sit in their stage like anyone else, are counted apart beside the
 * strip, and are never shown as waiting on you.
 */
export function isStillApplying(a: Pick<ApplicationSummary, "stillApplying">): boolean {
  return a.stillApplying === true;
}

/** How many people are still applying: the API's count, or the rows' when an older answer has none. */
export function stillApplyingCount(counts: Pick<StageStripCounts, "stillApplying"> | null | undefined, rows: ReadonlyArray<Pick<ApplicationSummary, "stillApplying">>): number {
  return counts?.stillApplying ?? rows.filter(isStillApplying).length;
}

/** How many people wait on you: never anyone still applying, whatever their group says (a hold that ended mid-visit). */
export function waitingOnYouCount(counts: Pick<StageStripCounts, "byGroup"> | null | undefined, rows: ReadonlyArray<Pick<ApplicationSummary, "stillApplying" | "group">>): number {
  const applying = rows.filter((a) => isStillApplying(a) && a.group === "waiting_on_you").length;
  return Math.max(0, (counts?.byGroup.waiting_on_you ?? 0) - applying);
}

const OWNER_STAGES = OwnerStageEnum.options as readonly OwnerStage[];
const TOLD = ["not_told", "queued", "sent", "told_in_person"] as const;

/**
 * The view the page opens on: what the link asks for (`?ownerStage=`, `?stage=`, `?told=`, `?applying=1`, `?order=`,
 * and `?cancelled=` for one reason under Cancelled), otherwise "Waiting on you", longest wait first, when anyone waits on
 * you (plan A3), and everyone, newest first, when nobody does. `counts` are the ones the page shows (people still
 * applying never wait on you).
 */
export function defaultView(params: { get: (k: string) => string | null }, counts: Pick<StageStripCounts, "byGroup"> | null | undefined): TalentView {
  const stageParam = params.get("ownerStage");
  const asked = stageParam && (OWNER_STAGES as readonly string[]).includes(stageParam) ? (stageParam as OwnerStage) : "all";
  // a reason belongs to the Cancelled column: on its own it opens that column, beside another column it means nothing
  const reason = cancelledReasonFrom(params.get("cancelled"));
  const cancelledReason = reason && (asked === "all" || asked === "cancelled") ? reason : null;
  const stage = cancelledReason ? "cancelled" : asked;
  const toldParam = params.get("told");
  const told = toldParam && (TOLD as readonly string[]).includes(toldParam) ? (toldParam as ToldState) : null;
  const internalStage = params.get("stage") || null;
  const applying = params.get("applying") === "1";
  const linked = stage !== "all" || !!told || !!internalStage || applying;
  const waiting = !linked && (counts?.byGroup.waiting_on_you ?? 0) > 0;
  const orderParam = params.get("order");
  const order: Order = ORDERS.some((o) => o.id === orderParam) ? (orderParam as Order) : waiting ? "waiting" : "newest";
  return { stage, waiting, applying, reading: "any", query: "", order, internalStage, told, cancelledReason };
}

/** Lower case without accents, so "José" is found by "jose". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

/** Search on name, email and where they came from (client-side; the list is one role's applicants). */
export function matchesQuery(a: Pick<ApplicationSummary, "candidate" | "source">, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return [a.candidate?.name ?? "", a.candidate?.email ?? "", a.source.replace(/_/g, " ")].some((field) => fold(field).includes(q));
}

/** The rows the view shows, in its order. */
export function applyView(rows: readonly ApplicationSummary[], view: TalentView): ApplicationSummary[] {
  const shown = rows.filter((a) =>
    (view.stage === "all" || a.ownerStage === view.stage) &&
    (!view.waiting || waitsOnYou(a)) &&
    (!view.applying || isStillApplying(a)) &&
    (view.reading === "any" || readingOf(a) === view.reading) &&
    (!view.internalStage || a.stage === view.internalStage) &&
    (!view.told || a.toldState === view.told) &&
    (!view.cancelledReason || a.cancelled?.reason === view.cancelledReason) &&
    matchesQuery(a, view.query),
  );
  return orderRows(shown, view.order);
}

export function orderRows(rows: readonly ApplicationSummary[], order: Order): ApplicationSummary[] {
  const name = (a: ApplicationSummary) => a.candidate?.name ?? "";
  const when = (iso: string) => Date.parse(iso) || 0;
  const newest = (x: ApplicationSummary, y: ApplicationSummary) => when(y.appliedAt ?? y.createdAt) - when(x.appliedAt ?? x.createdAt);
  const out = [...rows];
  if (order === "waiting") out.sort((x, y) => when(x.stageChangedAt) - when(y.stageChangedAt));
  else if (order === "name") out.sort((x, y) => name(x).localeCompare(name(y), undefined, { sensitivity: "base" }));
  else if (order === "score") out.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || newest(x, y));
  else out.sort(newest);
  return out;
}

/** The strip: everyone, then every owner stage in order, each with its count. */
export function stripItems(counts: Pick<StageStripCounts, "total" | "byOwnerStage"> | null | undefined): Array<{ id: OwnerStage | "all"; label: string; count: number }> {
  return [{ id: "all" as const, label: "All", count: counts?.total ?? 0 }, ...OWNER_STAGES.map((s) => ({ id: s, label: OWNER_STAGE_LABEL[s], count: counts?.byOwnerStage[s] ?? 0 }))];
}

/** The columns the strip always shows, whatever their counts (Wave S1). */
const ALWAYS_ON_STRIP: ReadonlyArray<OwnerStage | "all"> = ["all", "new", "shortlist", "interviewing", "hired", "not_moving_forward"];

/**
 * The strip split in two (Wave S1): `shown` are All, New, Shortlist, Interviewing, Hired, Not moving forward, every other
 * stage someone is at, and the column being shown; `more` are the other stages nobody is at, in strip order, kept one
 * click away under "More stages" with their counts.
 */
export function stripParts(counts: Pick<StageStripCounts, "total" | "byOwnerStage"> | null | undefined, current: OwnerStage | "all"): { shown: ReturnType<typeof stripItems>; more: ReturnType<typeof stripItems> } {
  const all = stripItems(counts);
  const keep = (i: (typeof all)[number]) => ALWAYS_ON_STRIP.includes(i.id) || i.count > 0 || i.id === current;
  return { shown: all.filter(keep), more: all.filter((i) => !keep(i)) };
}

/** A chip on a candidate's row: a word, its colour, and (for a short one) the full words it stands for. */
export type RowChip = { key: string; label: string; tone: Tone; title?: string; kind: "pill" | "chip" };
/** At most this many chips on a row, besides the score and the stage button (Wave S1); the rest are counted in "+N". */
export const ROW_CHIP_LIMIT = 2;

/**
 * Everything a row could say in a chip, most pressing first: still applying, where new times stand under Cancelled, a
 * tag ("Check eligibility", "Hold ended"), whether the decision was told, the AI review's word for the match, and a
 * low-confidence review ("Check", its full words as the title). The page shows the first ROW_CHIP_LIMIT. "Not told yet"
 * carries the day-5 safety net as its title (founder decision D-03).
 */
export function rowChips(a: Pick<ApplicationSummary, "stillApplying" | "ownerStage" | "cancelled" | "tags" | "toldState" | "decisionMessageWaiting" | "assessment" | "evidence">, words: { stillApplying: string; onItsWay: string; lowConfidence: string; notToldTitle?: string }): RowChip[] {
  const out: RowChip[] = [];
  const reading = readingOf(a);
  if (isStillApplying(a)) out.push({ key: "applying", label: STILL_APPLYING_LABEL, tone: "neutral", title: words.stillApplying, kind: "pill" });
  if (a.ownerStage === "cancelled" && a.cancelled) out.push({ key: "cancelled", label: a.cancelled.status, tone: "neutral", kind: "chip" });
  for (const t of a.tags) out.push({ key: `tag-${t}`, label: t, tone: "caution", kind: "chip" });
  if (a.toldState === "not_told") out.push({ key: "told", label: a.decisionMessageWaiting ? "Message waiting for approval" : "Not told yet", tone: "neutral", title: a.decisionMessageWaiting ? undefined : words.notToldTitle ?? SAFETY_NET_NOTE, kind: "chip" });
  if (a.toldState === "queued") out.push({ key: "told", label: words.onItsWay, tone: "neutral", kind: "chip" });
  if (reading !== "none") out.push({ key: "reading", label: READING[reading].label, tone: READING[reading].tone, kind: "pill" });
  if (a.evidence?.lowConfidence && reading !== "closer_look") out.push({ key: "low", label: "Check", tone: "caution", title: words.lowConfidence, kind: "chip" });
  return out;
}

/**
 * The one line under each job on the Jobs page: how many are new, how many applied, how many wait on you, how long it has
 * been open. A count of nothing is left out (no "0 new"), as on Home's rows (today.ts homeJobFacts), in the same words.
 */
export function jobCardFacts(r: Pick<RoleSummary, "counts" | "stageCounts" | "countsHidden" | "daysOpen">): string {
  const open = r.daysOpen === null ? "Not posted yet" : `${r.daysOpen} day${r.daysOpen === 1 ? "" : "s"} open`;
  if (r.countsHidden) return open;
  const total = r.counts.total ?? 0;
  if (!total && r.daysOpen === null) return open;
  const fresh = r.stageCounts?.new ?? 0;
  const waiting = r.counts.waiting_on_you ?? 0;
  return [fresh ? `${fresh} new` : "", `${total} applicant${total === 1 ? "" : "s"}`, waiting ? `${waiting} to review` : "", open].filter(Boolean).join(" · ");
}

/** The stages anyone is at, in strip order, for a one-line summary ("3 New · 1 Shortlist"); empty stages are left out. */
export function stageSummary(counts: Partial<Record<OwnerStage, number>> | null | undefined): Array<{ id: OwnerStage; label: string; count: number }> {
  return OWNER_STAGES.map((s) => ({ id: s, label: OWNER_STAGE_LABEL[s], count: counts?.[s] ?? 0 })).filter((s) => s.count > 0);
}

/** Waits on you: in the "waiting on you" group and not still applying. */
function waitsOnYou(a: Pick<ApplicationSummary, "group" | "stillApplying">): boolean {
  return a.group === "waiting_on_you" && !isStillApplying(a);
}

/** How many people each reading filter would show, within the strip column, a Cancelled reason and the waiting and still-applying toggles. */
export function readingCounts(rows: readonly ApplicationSummary[], view: Pick<TalentView, "stage" | "waiting"> & { applying?: boolean; cancelledReason?: CancelledReason | null }): Record<ReadingFilter, number> {
  const out: Record<ReadingFilter, number> = { any: 0, strong: 0, potential: 0, missing_must_have: 0, closer_look: 0 };
  for (const a of rows) {
    if ((view.stage !== "all" && a.ownerStage !== view.stage) || (view.waiting && !waitsOnYou(a)) || (view.applying && !isStillApplying(a)) || (view.cancelledReason && a.cancelled?.reason !== view.cancelledReason)) continue;
    out.any += 1;
    const r = readingOf(a);
    if (r in out) out[r as ReadingFilter] += 1;
  }
  return out;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Applied today", "Applied yesterday", "Applied 3 days ago", then the date. Calendar days in the reader's time zone. */
export function appliedWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Applied";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return "Applied today";
  if (days === 1) return "Applied yesterday";
  if (days < 7) return `Applied ${days} days ago`;
  const sameYear = at.getFullYear() === now.getFullYear();
  return `Applied ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}`;
}

/** How long someone has waited on you, for the people who do; null for everyone else, and for anyone still applying. */
export function waitingText(a: Pick<ApplicationSummary, "group" | "daysInStage"> & { stillApplying?: boolean }): string | null {
  if (!waitsOnYou(a)) return null;
  if (a.daysInStage <= 0) return "Waiting on you since today";
  return `Waiting on you ${a.daysInStage} ${a.daysInStage === 1 ? "day" : "days"}`;
}

/** The empty list's sentence for the view the person chose. */
export function emptyText(view: TalentView, total: number): { title: string; body: string } {
  if (total === 0) return { title: "Nobody has applied yet", body: "Applicants appear here as soon as they apply. The Share tab has the job's links once it is live." };
  if (view.query.trim()) return { title: "Nobody matches", body: `Nobody here matches "${view.query.trim()}". Search looks at names, email addresses and where people came from.` };
  if (view.applying) return { title: "Nobody is still applying", body: "Everyone has sent their answers, asked for a person or stopped. Turn off \"Still applying\" to see everyone." };
  if (view.stage === "cancelled" && !view.cancelledReason && !view.waiting && view.reading === "any") return { title: "Nobody is under Cancelled", body: "Candidates who cancel an interview, or do not come to one, show here with what they chose." };
  if (view.waiting && view.stage === "all" && view.reading === "any") return { title: "Nobody is waiting on you", body: "Everyone has a next step under way. Choose All to see them." };
  return { title: "Nobody here", body: "Nobody fits these filters right now. Clear one to see more people." };
}
