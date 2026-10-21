import { BATCH_MAX, BOARD_COLUMN_LABEL, BoardColumn, DECLINE_REASON_LABEL, RESUME_ONLY_CHIP, RejectReason } from "@ros/contracts";
import { scoreBand, type Tone } from "@ros/ui";
import type { BatchPreview, BatchResult, BoardCard, BoardView, PoolAnswer, PoolQuestion, PoolSummary, RoleBatchItem } from "../../api/client";
import { SAFETY_NET_NOTE, appliedWhen, scoreBasis } from "../../talent-list";

/**
 * The pool board on the Candidates page (plan F6-F10; founder decisions B2, B4, B5, B6), kept free of React so it can be
 * tested: the words on the board, its cards and chips, Review and apply's groups, ticks and counter, the one-click
 * questions' addresses and the "Looked at" line, and Home's pool card. The board only suggests: nothing moves until a
 * person applies it, every move is private, and nobody is emailed now (a decision nobody tells meets the day-5 safety
 * net, founder decision D-03).
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------------------------------------------------ */
/* The view and the address                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export type TalentMode = "board" | "list";

/** The Talent page's view from its address: `?view=board` is the pool board; anything else is the list. */
export function modeFrom(params: { get: (k: string) => string | null }): TalentMode {
  return params.get("view") === "board" ? "board" : "list";
}

/**
 * The address with the board's state in it, the rest kept: `view=board` for the board, `review=1` while Review and
 * apply is open (Today's "Review and apply" links straight to it). Going back to the list drops both.
 */
export function boardSearch(current: URLSearchParams | string, change: { mode?: TalentMode; review?: boolean }): string {
  const next = new URLSearchParams(current);
  if (change.mode === "board") next.set("view", "board");
  else if (change.mode === "list") next.delete("view");
  if (change.review === true) next.set("review", "1");
  else if (change.review === false || change.mode === "list") next.delete("review");
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/** The strip above the list and the board, in one line: what sorting does, and that nothing moves or is sent. */
export const SORT_TITLE = "Sort the pool";
export const SORT_TEXT = "Groups everyone who finished applying, with a reason for each. Nothing moves until you apply it, and nothing is sent to anyone.";

/** The strip once the board is showing: when it was sorted, and the same promise. */
export function sortedText(generatedAt: string | null | undefined): string {
  const at = generatedAt ? new Date(generatedAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? ` at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";
  return `Sorted${when} by fixed rules from the checked evidence. Nothing moves until you apply it, and nothing is sent to anyone.`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The board                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The three columns, in our words, with the line under each title. The lines say what puts someone there, no more: a
 * low score from too little evidence, or anything the board is unsure of, waits on the Longlist for a person's eye.
 */
export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumn; title: string; sub: string }> = [
  { id: "shortlist", title: BOARD_COLUMN_LABEL.shortlist, sub: "Good evidence on the must-haves" },
  { id: "longlist", title: BOARD_COLUMN_LABEL.longlist, sub: "Some evidence, or more to find out" },
  { id: "not_moving_forward", title: BOARD_COLUMN_LABEL.not_moving_forward, sub: "A must-have shown missing, or a low score on what is known" },
];

/** "3 shortlist · 1 longlist · 2 not moving forward". */
export function countsLine(counts: Partial<Record<BoardColumn, number>>): string {
  return BoardColumn.options.map((c) => `${counts[c] ?? 0} ${BOARD_COLUMN_LABEL[c].toLowerCase()}`).join(" · ");
}

/**
 * The board's header line: the people still to sort by the column the board suggests, then everyone already sorted,
 * decided or past this step (they are never counted as "on the shortlist"), and the lane's people (R20-7, R20-9) in one
 * neutral count: some are being scored and some have a closed link, so it never says what they lack. "To sort: 2
 * shortlist · 1 longlist · 0 not moving forward · 3 already sorted or decided · 2 not on the board yet".
 */
export function headerCounts(summary: { counts: Partial<Record<BoardColumn, number>>; done?: number; noAiInterview?: number }): string {
  return `To sort: ${countsLine(summary.counts)}${summary.done ? ` · ${summary.done} already sorted or decided` : ""}${summary.noAiInterview ? ` · ${summary.noAiInterview} not on the board yet` : ""}`;
}

/**
 * The read-only lane under the columns (20 Oct 2026, R20-7): who has no AI interview yet, never placed or suggested; and
 * (R20-9) anyone else whose score has no AI interview in it yet, so résumé-only scores are never ranked beside it.
 */
export const NO_AI_INTERVIEW_LANE = { title: "No AI interview yet", sub: "Scored after the AI interview: they join the board when they send it, and Review and apply never includes them." } as const;

/**
 * One person in that lane: the name, where they stand with the AI interview (its neutral words; out of the column, the
 * board's own: "AI interview being scored", "No AI interview"), and when they applied.
 */
export function laneRow(card: Pick<BoardCard, "applicationId" | "name" | "appliedAt" | "aiInterview" | "ownerStageLabel"> & { placement?: Pick<BoardCard["placement"], "doneLabel"> }, now: Date = new Date()): { id: string; name: string; state: string; applied: string } {
  return { id: card.applicationId, name: card.name, state: card.aiInterview?.label ?? card.placement?.doneLabel ?? card.ownerStageLabel, applied: appliedWhen(card.appliedAt, now) };
}

/**
 * The score on a card or a row in words: "High · 78" with the badge's colour (packages/ui SCORE_BANDS), what a screen
 * reader hears, and "No score yet" when nothing could be judged.
 */
export function scoreText(score: number | null | undefined): { text: string; tone: Tone; label: string } {
  const b = scoreBand(score);
  if (!b) return { text: "No score yet", tone: "neutral", label: "No match score yet" };
  return { text: `${b.label} · ${b.score}`, tone: b.tone, label: `Match score ${b.score} out of 100 (${b.label.toLowerCase()})` };
}

export type CardChip = { label: string; tone: "good" | "caution" | "critical" | "neutral"; title?: string; done?: boolean };

/**
 * The card's state chip: "Done" once a person has sorted or decided, the lane's words while they wait to join the board, then
 * red "Missing must-have: <name>" (a must-have their own words show is not met; red is used for nothing else), "Needs
 * your eye" when the board is not sure, and "Ready to apply" when Review and apply starts with them ticked. It says
 * what the board will do, not how good they are, so it is never green; the reading's own confidence is a chip of its own.
 */
export function cardChip(card: Pick<BoardCard, "placement" | "score">): CardChip {
  const p = card.placement;
  if (p.state === "done") return { label: "Done", tone: "neutral", title: p.doneLabel ?? undefined, done: true };
  if (p.state === "waiting") return { label: p.doneLabel ?? "Being read", tone: "neutral" };
  const missing = card.score?.missingMustHave ?? [];
  if (missing.length) return { label: `Missing must-have: ${missing[0].label}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}`, tone: "critical" };
  if (p.needsYourEye || !p.confident) return { label: "Needs your eye", tone: "caution", title: p.needsYourEye ?? undefined };
  return { label: "Ready to apply", tone: "neutral", title: "Review and apply starts with them ticked." };
}

const CONFIDENCE_WORDS: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

/** The reading's own confidence, kept apart from the score: amber when low (read it yourself), plain otherwise. */
export function confidenceChip(card: Pick<BoardCard, "confidence">): CardChip | null {
  const c = card.confidence;
  if (!c || !CONFIDENCE_WORDS[c]) return null;
  return { label: CONFIDENCE_WORDS[c], tone: c === "low" ? "caution" : "neutral", title: "How sure the AI was about its review. It is not part of the score." };
}

/**
 * The small facts under a card (plan F1, F4, F6): the must-have line, what the score rests on (its label, R20-9: "From
 * the résumé and the AI interview", or "Résumé only: …" until the AI interview is in it), a reading made against an
 * earlier version of the role, and what already happened or is waiting.
 */
export function cardFacts(card: Pick<BoardCard, "mustHaves" | "score" | "readingVersion" | "facts">): string[] {
  const out: string[] = [];
  if (card.mustHaves?.total) out.push(card.mustHaves.words);
  const basis = scoreBasis(card.score);
  if (basis) out.push(basis);
  if (card.readingVersion) out.push(card.readingVersion.label);
  if (card.facts.invitedAutomatically) out.push("Invited to the AI interview automatically");
  else if (card.facts.openScreen) out.push("AI interview open");
  if (card.facts.suggestionWaiting) out.push("A suggestion is waiting for you");
  return out;
}

/** The card's one line on why it sits where it does: what needs a person's eye first, otherwise the board's reason. */
export function reasonLine(card: Pick<BoardCard, "placement">): string {
  const p = card.placement;
  return p.state === "suggested" && p.needsYourEye ? p.needsYourEye : p.reason;
}

const SOURCE_WORDS: Record<string, string> = { resume: "résumé", application: "application", screen: "AI interview", interview: "interview", recruiter_note: "recruiter's call notes", eligibility: "eligibility answers" };

/** Where a finding came from, in plain words. */
export function sourceWords(source: string): string {
  return SOURCE_WORDS[source] ?? source.replace(/_/g, " ");
}

export type EvidenceLine = { kind: "strength" | "gap"; text: string; source: string; quoted: boolean };

/** Two strengths (a tick each) and the gap that cost the most (a dash), each with where it came from. */
export function evidenceLines(card: Pick<BoardCard, "strengths" | "gap">): EvidenceLine[] {
  const line = (kind: EvidenceLine["kind"], q: BoardCard["strengths"][number]): EvidenceLine => ({ kind, text: q.claim, source: sourceWords(q.source), quoted: !q.unquoted && !!q.quote });
  return [...card.strengths.slice(0, 2).map((s) => line("strength", s)), ...(card.gap ? [line("gap", card.gap)] : [])];
}

/**
 * "Have a recruiter check this" (plan F9): the request it opens, filled in. The recruiter sees the board as it stood
 * when it was sent, beside the role (apps/api/src/services/escalation-queue.ts).
 */
export const RECRUITER_CHECK = "Please check how the board sorted this role's applicants before we apply it.";

/** Everyone on the board in its order (the columns left to right, top to bottom): the panel steps through them. */
export function boardOrder(view: Pick<BoardView, "columns">, only?: ReadonlySet<string> | null): string[] {
  return BoardColumn.options.flatMap((c) => view.columns[c].map((x) => x.applicationId)).filter((id) => !only || only.has(id));
}

/**
 * The two plain sentences under "What the pool looks like": the summary's own sentences after the counts (which the
 * header already shows), leaving out the "stricter than needed?" note, which has its own line.
 */
export function summarySentences(summary: Pick<PoolSummary, "sentences" | "stricter">): string[] {
  const rest = summary.sentences.slice(1).filter((s) => s !== summary.stricter?.words);
  return (rest.length ? rest : summary.sentences).slice(0, 2);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Review and apply (plan F8; plan-adjustments section 3; founder decision B4)                                    */
/* ------------------------------------------------------------------------------------------------------------ */

export type ReviewAction = BoardColumn;

/** One person in Review and apply: what the board suggests for them, why, what to know first, and their reason. */
export type ReviewRow = {
  applicationId: string;
  name: string;
  column: BoardColumn;
  /** What applying does for them; null when nothing can be applied here (held on an eligibility answer). */
  action: ReviewAction | null;
  score: number | null;
  scoreText: string;
  reason: string;
  needsYourEye: string | null;
  missing: string[];
  /** For a not-moving-forward: the reason from the fixed list and the note, pre-filled from their own evidence. */
  declineReason: { reason: RejectReason; note: string } | null;
  /** Ticked when the window opens: placed with confidence. */
  ticked: boolean;
  /** Why they cannot be ticked here, when they cannot. */
  locked: string | null;
};

/** Said on a not-moving-forward row for a role that cannot decline (HR): the same rule as the candidate's own page. */
export const NO_DECLINE_HERE = "Your role can't file people as not moving forward; an owner, admin or hiring manager can.";

/**
 * Review and apply's rows: everyone the board placed and nobody has sorted yet, column by column in the board's order.
 * People the board placed with confidence start ticked; anyone who needs your eye (a closer look, low confidence, no
 * reading, nothing to score) starts unticked with the reason shown, and someone held on an eligibility answer cannot
 * be ticked here at all. At most 50 at a time (`left` says how many wait for the next round).
 */
export function reviewRows(view: Pick<BoardView, "columns">, opts: { mayDecline: boolean }): { rows: ReviewRow[]; left: number } {
  const all: ReviewRow[] = [];
  for (const column of BoardColumn.options) {
    for (const card of view.columns[column]) {
      const p = card.placement;
      if (p.state !== "suggested") continue;
      const action = p.suggestedAction;
      const locked = !action ? (p.needsYourEye ?? "Nothing to apply for them here; decide from their page.") : action === "not_moving_forward" && !opts.mayDecline ? NO_DECLINE_HERE : null;
      all.push({
        applicationId: card.applicationId,
        name: card.name,
        column,
        action,
        score: card.score?.score ?? null,
        scoreText: scoreText(card.score?.score).text,
        reason: p.reason,
        needsYourEye: p.needsYourEye,
        missing: (card.score?.missingMustHave ?? []).map((m) => m.label),
        declineReason: p.declineReason,
        ticked: !locked && p.confident && !p.needsYourEye,
        locked,
      });
    }
  }
  return { rows: all.slice(0, BATCH_MAX), left: Math.max(0, all.length - BATCH_MAX) };
}

/** Each row's tick, the reasons changed from the pre-filled ones, and what the preview refused. */
export type ReviewState = { ticks: Record<string, boolean>; reasons: Record<string, RejectReason>; refused: Record<string, string> };

export function initialReview(rows: readonly ReviewRow[]): ReviewState {
  return { ticks: Object.fromEntries(rows.map((r) => [r.applicationId, r.ticked])), reasons: {}, refused: {} };
}

/** Whether a row can be ticked at all: something to apply, allowed for this role, and not refused by the preview. */
export function tickable(row: ReviewRow, state: Pick<ReviewState, "refused">): boolean {
  return !!row.action && !row.locked && !state.refused[row.applicationId];
}

/** The reason a not-moving-forward row is filed with: the one chosen here, otherwise the pre-filled one. */
export function reasonOf(row: ReviewRow, state: Pick<ReviewState, "reasons">): RejectReason | null {
  return state.reasons[row.applicationId] ?? row.declineReason?.reason ?? null;
}

/** A not-moving-forward row with no reason yet: it waits for one before it can be applied. */
export function needsReason(row: ReviewRow, state: Pick<ReviewState, "reasons">): boolean {
  return row.action === "not_moving_forward" && !reasonOf(row, state);
}

/** Whether a row will be applied: tickable, ticked, and (for a not-moving-forward) with a reason. */
export function isTicked(row: ReviewRow, state: ReviewState): boolean {
  return tickable(row, state) && !!state.ticks[row.applicationId] && !needsReason(row, state);
}

/** What the preview (`dryRun`) is asked about: every row that has something to apply. */
export function previewItems(rows: readonly ReviewRow[]): RoleBatchItem[] {
  return rows.filter((r) => r.action && !r.locked).map((r) => ({ applicationId: r.applicationId, action: r.action!, ...(r.action === "not_moving_forward" && r.declineReason ? { reason: r.declineReason.reason } : {}) }));
}

/** What Apply sends: the ticked rows, each not-moving-forward with its reason (the note pre-filled from their evidence stays). */
export function batchItems(rows: readonly ReviewRow[], state: ReviewState): RoleBatchItem[] {
  return rows.filter((r) => isTicked(r, state)).map((r) => {
    const reason = r.action === "not_moving_forward" ? reasonOf(r, state) : null;
    return { applicationId: r.applicationId, action: r.action!, ...(reason ? { reason } : {}) };
  });
}

/** The preview's refusals and extra warnings by person. */
export function previewByPerson(preview: Pick<BatchPreview, "items"> | null | undefined): { refused: Record<string, string>; warnings: Record<string, string[]> } {
  const refused: Record<string, string> = {};
  const warnings: Record<string, string[]> = {};
  for (const i of preview?.items ?? []) {
    if (!i.allowed && i.refusedReason) refused[i.applicationId] = i.refusedReason;
    warnings[i.applicationId] = i.warnings;
  }
  return { refused, warnings };
}

export type ReadyCounts = Record<ReviewAction, number> & { total: number };

export function readyCounts(rows: readonly ReviewRow[], state: ReviewState): ReadyCounts {
  const out: ReadyCounts = { shortlist: 0, longlist: 0, not_moving_forward: 0, total: 0 };
  for (const r of rows) {
    if (!isTicked(r, state)) continue;
    out[r.action!] += 1;
    out.total += 1;
  }
  return out;
}

/** The live counter: "4 decisions ready (2 shortlist · 1 longlist · 1 not moving forward)". */
export function readyLine(c: ReadyCounts): string {
  return `${plural(c.total, "decision", "decisions")} ready (${c.shortlist} shortlist · ${c.longlist} longlist · ${c.not_moving_forward} not moving forward)`;
}

/** "Apply 4 decisions". */
export function applyLabel(total: number): string {
  return `Apply ${plural(total, "decision", "decisions")}`;
}

/** A group's "n/m": how many are ticked of how many are in it. */
export function groupCount(rows: readonly ReviewRow[], column: BoardColumn, state: ReviewState): { ticked: number; total: number } {
  const own = rows.filter((r) => r.column === column);
  return { ticked: own.filter((r) => isTicked(r, state)).length, total: own.length };
}

/**
 * Where each group goes, and that it is private. A decision nobody tells is not left forever: the safety net (Q27) acts
 * after five working days, and the board does not know the company's setting, so the line says both what it may do
 * (founder decision D-03: every screen that says a decision is private says so too).
 */
export const GROUP_WORDS: Record<BoardColumn, string> = {
  shortlist: "Added to your Shortlist. Private, the candidate is not told.",
  longlist: "Kept warm on your Longlist. Private, no email.",
  not_moving_forward: `Filed privately; nobody is emailed now. ${SAFETY_NET_NOTE}`,
};

/** The line under Review and apply's title: what can change here, and what happens to the rest. */
export const REVIEW_SUB = "Untick anyone you want to decide yourself. Unticked people stay where they are.";

/** The footer of Review and apply. */
export const REVIEW_FOOT = "Private: nobody is emailed now.";
export const NEEDS_EYE_WARNING = "Needs your eye: read before applying";

/**
 * The footer's second line while anyone ticked is filed as not moving forward: the day-5 safety net (Q27; founder
 * decision D-03), so "nobody is emailed" is never read as "nobody is ever told".
 */
export function reviewFootNote(c: Pick<ReadyCounts, "not_moving_forward">): string | null {
  return c.not_moving_forward ? `Not moving forward: ${SAFETY_NET_NOTE.charAt(0).toLowerCase()}${SAFETY_NET_NOTE.slice(1)}` : null;
}

/** A row's warnings: a missing must-have in red, "Needs your eye" in amber. */
export function rowWarnings(row: ReviewRow): Array<{ text: string; tone: "caution" | "critical" }> {
  const out: Array<{ text: string; tone: "caution" | "critical" }> = [];
  if (row.missing.length) out.push({ text: `Missing must-have: ${row.missing.join(", ")}`, tone: "critical" });
  if (!row.locked && row.needsYourEye) out.push({ text: NEEDS_EYE_WARNING, tone: "caution" });
  return out;
}

/** What the preview adds that the row does not already say (an open screening conversation that a decline closes...). */
export function extraWarnings(row: ReviewRow, server: readonly string[] | undefined): string[] {
  return (server ?? []).filter((w) => w !== row.needsYourEye && !w.startsWith("Missing must-have") && !w.startsWith("The board suggested"));
}

/** The fixed reasons a not-moving-forward can be filed with here, in the team's words (closing the role has its own step). */
export const DECLINE_CHOICES: ReadonlyArray<{ id: RejectReason; label: string }> = RejectReason.options.filter((r) => r !== "role_closed").map((r) => ({ id: r, label: DECLINE_REASON_LABEL[r] }));

/**
 * The toast after Apply: how many were applied, and that it was private; when anyone was filed as not moving forward,
 * the day-5 safety net too (founder decision D-03).
 */
export function appliedToast(r: Pick<BatchResult, "applied" | "refused"> & { results?: ReadonlyArray<Pick<BatchResult["results"][number], "ok" | "action">> }): { title: string; detail: string } {
  if (!r.applied) return { title: "Nothing was applied", detail: "Each person says why. Nobody was emailed." };
  return { title: `Applied ${plural(r.applied, "decision", "decisions")}`, detail: `Filed privately. ${appliedNote(r)}${r.refused ? ` ${plural(r.refused, "person", "people")} could not be applied; each says why.` : ""}` };
}

/** "Nobody was emailed.", and the day-5 safety net when anyone was filed as not moving forward (founder decision D-03). */
export function appliedNote(r: { results?: ReadonlyArray<Pick<BatchResult["results"][number], "ok" | "action">> }): string {
  const declined = (r.results ?? []).some((x) => x.ok && x.action === "not_moving_forward");
  return `Nobody was emailed.${declined ? ` ${SAFETY_NET_NOTE}` : ""}`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* One-click questions (plan F10; founder decision B5)                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

export const ASK_TITLE = "Ask about this pool";
export const ASK_INTRO = "Pick a question. Each answer says what it looked at.";
export const ASK_SOON = "Typing your own question is not available yet. Pick one above, or bring in a recruiter.";
/** "Compare these" takes up to this many people (COMPARE_MAX in apps/api/src/routes/compare.ts). */
export const COMPARE_MAX = 5;

/** Where a question is answered: the must-have it is about, or the people to compare. */
export function answerPath(roleId: string, q: Pick<PoolQuestion, "kind" | "mustHaveKey">, ids: readonly string[] = []): string {
  const qs = new URLSearchParams();
  if (q.kind === "strongest_evidence" && q.mustHaveKey) qs.set("mustHave", q.mustHaveKey);
  if (q.kind === "compare" && ids.length) qs.set("ids", ids.join(","));
  const s = qs.toString();
  return `/api/v1/roles/${roleId}/questions/${q.kind}${s ? `?${s}` : ""}`;
}

/** "Looked at: 6 people (6 résumé reviews and 2 screening chats), against 2 must-haves. Nothing new was asked of the AI." */
export function lookedAtLine(l: PoolAnswer["lookedAt"]): string {
  const reads = [l.resumeReadings ? plural(l.resumeReadings, "résumé review", "résumé reviews") : "", l.screenReadings ? plural(l.screenReadings, "AI interview", "AI interviews") : ""].filter(Boolean);
  const against = l.requirements.length ? `, against ${l.requirements.length === 1 ? `"${l.requirements[0]}"` : `${l.requirements.length} must-haves`}` : "";
  return `Looked at: ${plural(l.people, "person", "people")}${reads.length ? ` (${reads.join(" and ")})` : ""}${against}. Nothing new was asked of the AI.`;
}

/** Ticks one person for "Compare these" on or off, never past the limit. */
export function togglePick(picked: readonly string[], id: string, on: boolean, max = COMPARE_MAX): string[] {
  if (!on) return picked.filter((x) => x !== id);
  return picked.includes(id) || picked.length >= max ? [...picked] : [...picked, id];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Today's pool card, and the board a recruiter was asked to check                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Said on Today's pool card under its buttons. */
export const POOL_CARD_NOTE = "Nothing moves until you apply it, and nobody is emailed.";

/** Today's pool card: two sentences and up to three next steps naming people. */
export function poolCardView(pool: PoolSummary): { sentences: string[]; steps: PoolSummary["nextSteps"] } {
  return { sentences: summarySentences(pool), steps: pool.nextSteps.slice(0, 3) };
}

/** Where a person's name on Today's pool card opens: their panel over the role's board. */
export function boardPersonPath(roleId: string, applicationId: string): string {
  return `/roles/${roleId}/talent?view=board&open=${applicationId}`;
}

/** The pool board as it stood when a team asked a recruiter to check it (plan F9; `contextSnapshot.board`). */
export type BoardSnapshot = {
  capturedAt: string;
  summary: Pick<PoolSummary, "sentences" | "counts"> & Partial<Pick<PoolSummary, "done">>;
  /** `interview` and `basis` (R20-9): whether their AI interview is in the score, and its label; older snapshots have neither. */
  people: Array<{ applicationId: string; name: string; column: BoardColumn | null; state: string; score: number | null; interview?: string | null; basis?: string | null; reason: string; needsYourEye: string | null; nextStep: string | null }>;
};

/**
 * A snapshot row's score: "88/100", with "Résumé only" beside a score whose AI interview is not in it (R20-9) and the
 * full label on hover, as on the list; "No score yet" without one.
 */
export function snapshotScore(p: Pick<BoardSnapshot["people"][number], "score" | "interview" | "basis">): { text: string; title?: string } {
  if (p.score === null) return { text: "No score yet" };
  const resumeOnly = !!p.interview && p.interview !== "done";
  return resumeOnly ? { text: `${p.score}/100 · ${RESUME_ONLY_CHIP}`, title: p.basis ?? RESUME_ONLY_CHIP } : { text: `${p.score}/100`, ...(p.basis ? { title: p.basis } : {}) };
}

/** The snapshot from a request's context, or null when it has none (or not in the shape the board wrote). */
export function snapshotOf(context: unknown): BoardSnapshot | null {
  const board = (context as { board?: unknown } | null | undefined)?.board as Partial<BoardSnapshot> | undefined;
  if (!board || typeof board.capturedAt !== "string" || !Array.isArray(board.people) || !board.summary || !Array.isArray(board.summary.sentences)) return null;
  return board as BoardSnapshot;
}

/** A snapshot row's place in words: its column, or "No AI interview yet" for someone not placed (R20-7). */
export function snapshotPlace(p: BoardSnapshot["people"][number]): string {
  if (!p.column) return NO_AI_INTERVIEW_LANE.title;
  return `${BOARD_COLUMN_LABEL[p.column]}${p.state === "done" ? " (already sorted)" : ""}`;
}
