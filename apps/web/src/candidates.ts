import {
  appPaths, BULK_ACTION_MAX, BulkCandidateAction, CANDIDATE_ACTION_LABEL, CANDIDATE_TAB_LABEL, CandidateTab, EARLIER_VERSION_LINE, IMPORTANCE_LABEL, quoteWithSource,
  type AiInterviewView, type BulkActionResult, type CandidateAction, type CandidateActionState, type CandidateCounts, type CandidateDocument, type CandidateList,
  type CandidatePanel, type CandidateRow, type CvScore, type InterviewAnswer, type InterviewScore, type MatchBand, type RoleStatus, type ScoreFinding,
} from "@ros/contracts";
import type { Tone } from "@ros/ui";
import { appliedWhen, shortDay } from "./dates";

/**
 * A job's Candidates list, its bar for several ticked people, and the candidate panel: the parts that need no browser,
 * kept out of the pages so tests/web/candidates.test.ts can check them. The server works out every tab, label, score,
 * order and allowed action; these lay out what it sends and never decide a rule again.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Where the list is, and its tabs                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** The five tabs, in the order they are shown. */
export const CANDIDATE_TABS: readonly CandidateTab[] = CandidateTab.options;

/** The tab an address names (`?tab=`); New for anything else. */
export function tabFrom(value: string | null | undefined): CandidateTab {
  return CANDIDATE_TABS.find((t) => t === value) ?? "new";
}

/** The tabs with how many people each holds, once the counts are known. */
export function tabItems(counts: Pick<CandidateCounts, "byTab"> | null | undefined): Array<{ id: CandidateTab; label: string; count?: number }> {
  return CANDIDATE_TABS.map((id) => ({ id, label: CANDIDATE_TAB_LABEL[id], ...(counts ? { count: counts.byTab[id] } : {}) }));
}

/** Where the list is shown: under a job's Candidates tab, or under Candidates in the rail, where a job is picked. */
export type ListPlace = { kind: "job"; roleId: string } | { kind: "all"; roleId: string };

/**
 * The list's address for a tab and an open panel. A job's own page keeps the addresses the server links to
 * (/roles/<id>/talent?tab=…, ?open=…); Candidates in the rail names the picked job as `?job=`.
 */
export function listHref(place: ListPlace, state: { tab?: CandidateTab; open?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (place.kind === "all") q.set("job", place.roleId);
  if (state.tab && state.tab !== "new") q.set("tab", state.tab);
  if (state.open) q.set("open", state.open);
  const base = place.kind === "job" ? appPaths.candidates(place.roleId) : appPaths.allCandidates;
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** The job Candidates in the rail opens on: the one the address names when it is there, else the first open job, else the newest. */
export function pickedJob<T extends { id: string; status: RoleStatus }>(jobs: readonly T[], wanted: string | null | undefined): T | null {
  return jobs.find((j) => j.id === wanted) ?? jobs.find((j) => j.status === "open") ?? jobs[0] ?? null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Scores: a number with its one band word, or why there is none                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** The colours a score badge comes in: never red, which belongs to a missing must-have. */
export type ScoreTone = "good" | "caution" | "neutral";

/** The colour that goes with a band. The band and its word come from the API; the colour only helps a glance. */
export function bandTone(band: MatchBand | null | undefined): ScoreTone {
  return band === "very_high" || band === "high" ? "good" : band === "medium" ? "caution" : "neutral";
}

/** A score as it is drawn: the number and its band word, or the words for why there is none. */
export type ScoreView = { score: number | null; band: string | null; tone: ScoreTone; none: string | null };

export function scoreView(s: { score: number | null; band: MatchBand | null; bandLabel: string | null; noScoreLabel: string | null }): ScoreView {
  if (s.score === null) return { score: null, band: null, tone: "neutral", none: s.noScoreLabel ?? "No score yet" };
  return { score: s.score, band: s.bandLabel, tone: bandTone(s.band), none: null };
}

/** The colour of a finding's word: green shown, amber partly shown, red only for one their own words show is not met. */
export function findingTone(finding: ScoreFinding): Tone {
  return finding === "shown" ? "good" : finding === "partly" ? "caution" : finding === "not_met" ? "critical" : "neutral";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A row of the list                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * One person as a row: the line of facts under the name, the resume score with its lines, the interview score once
 * there is one, the "Answered No" flags, and the actions (the first as the row's button, the rest under More).
 */
export type RowView = {
  id: string;
  name: string;
  facts: string[];
  resume: ScoreView;
  mustHaveLine: string | null;
  missingLine: string | null;
  earlierVersion: string | null;
  interview: ScoreView | null;
  flags: string[];
  primary: CandidateActionState | null;
  more: CandidateActionState[];
};

export function rowView(row: CandidateRow, now: Date = new Date()): RowView {
  const facts = [appliedWhen(row.appliedAt, now)];
  // the stage's own words only when they say more than the tab the row is under ("AI interview sent", "Withdrew")
  if (row.label !== CANDIDATE_TAB_LABEL[row.tab]) facts.push(row.label);
  if (row.toldLabel) facts.push(row.toldLabel);
  if (row.aiInterview?.linkOpenUntil) facts.push(`Link open until ${shortDay(row.aiInterview.linkOpenUntil, now)}`);
  const { primary, more } = rowActions(row.actions);
  return {
    id: row.id,
    name: row.name,
    facts,
    resume: scoreView(row.cvScore),
    mustHaveLine: row.cvScore.mustHaveLine,
    missingLine: row.cvScore.missingLine,
    earlierVersion: row.cvScore.earlierVersion ? EARLIER_VERSION_LINE : null,
    interview: row.interviewScore ? scoreView(row.interviewScore) : null,
    flags: row.flags,
    primary,
    more,
  };
}

/** A person's actions as a row lays them out: the first the API lists is the row's button, the others sit under More. */
export function rowActions(actions: readonly CandidateActionState[]): { primary: CandidateActionState | null; more: CandidateActionState[] } {
  return { primary: actions[0] ?? null, more: actions.slice(1) };
}

/**
 * "Email the decision" is never sent from a row with one press: the person's panel opens on the email first, so the
 * words are read before they go. Every other action is done where its button is.
 */
export function opensPanelFirst(action: CandidateAction): boolean {
  return action === "send_decision";
}

/** How often the list asks again while a resume is being read or an AI interview scored; false once nothing is on its way. */
export function listRefresh(list: Pick<CandidateList, "rows"> | null | undefined): number | false {
  return list?.rows.some((r) => r.cvScore.noScore === "being_read" || r.interviewScore?.noScore === "being_scored") ? 4000 : false;
}

/** The same for one person's panel. */
export function panelRefresh(panel: Pick<CandidatePanel, "cvScore" | "aiInterview"> | null | undefined): number | false {
  return panel && (panel.cvScore.noScore === "being_read" || panel.aiInterview?.score?.noScore === "being_scored") ? 4000 : false;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Ticks, and the bar for several people                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** The ticks that still point at someone on screen: a tick never outlives its row (a refetch may have moved the person). */
export function ticksOnScreen(ticked: ReadonlySet<string>, rows: readonly { id: string }[]): Set<string> {
  return new Set(rows.filter((r) => ticked.has(r.id)).map((r) => r.id));
}

export function toggleTick(ticked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ticked);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** "Select all" on the list: ticks everyone on screen, or unticks everyone when all are ticked already. */
export function toggleAll(ticked: ReadonlySet<string>, rows: readonly { id: string }[]): Set<string> {
  return rows.length > 0 && rows.every((r) => ticked.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id));
}

/** One button of the bar: the action, its words from the API, and exactly the ticked people who allow it. */
export type BulkButton = { action: BulkCandidateAction; label: string; ids: string[] };

/**
 * The bar's buttons for the ticked people: each action for several that some ticked person lists as allowed, in the
 * API's own order, carrying only the ticked people who allow it. An action nobody ticked allows is not drawn at all.
 */
export function bulkButtons(rows: readonly Pick<CandidateRow, "id" | "actions">[], ticked: ReadonlySet<string>): BulkButton[] {
  const chosen = rows.filter((r) => ticked.has(r.id));
  return BulkCandidateAction.options.flatMap((action) => {
    const ids = chosen.filter((r) => r.actions.some((a) => a.action === action && a.allowed)).map((r) => r.id);
    return ids.length ? [{ action, label: CANDIDATE_ACTION_LABEL[action], ids }] : [];
  });
}

/** A bar button's words: the action, with how many of the ticked people it reaches when that is not all of them. */
export function bulkLabel(button: BulkButton, ticked: number): string {
  return button.ids.length === ticked ? button.label : `${button.label} (${button.ids.length} of ${ticked})`;
}

/** The people of one action in requests the API takes: at most a hundred each. */
export function batches<T>(ids: readonly T[], size: number = BULK_ACTION_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Several answers to one action (a long list goes in several requests) as one: every person's result, and the server's sentences in order. */
export function mergeBulk(parts: readonly BulkActionResult[]): BulkActionResult | null {
  if (!parts.length) return null;
  const undo = parts.map((p) => p.undoUntil).filter((u): u is string => !!u).sort();
  return {
    action: parts[0].action,
    results: parts.flatMap((p) => p.results),
    done: parts.reduce((n, p) => n + p.done, 0),
    refused: parts.reduce((n, p) => n + p.refused, 0),
    message: parts.map((p) => p.message).filter(Boolean).join(" "),
    undoUntil: undo[0] ?? null,
  };
}

/** The people an action for several was refused for, each with the server's reason. */
export function refusedLines(result: Pick<BulkActionResult, "results">): string[] {
  return result.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message}`);
}

/** How long "Don't send" still works after a decision email was queued, in milliseconds; 0 once it has left or without a window. */
export function undoMillis(undoUntil: string | null | undefined, now: number = Date.now()): number {
  const until = undoUntil ? Date.parse(undoUntil) : Number.NaN;
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Nobody in a tab                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** What an empty tab says, with at most one way on: another tab of the list, or a page of the job. */
export type EmptyView = { title: string; action: { label: string; tab: CandidateTab } | { label: string; href: string } | null };

export function emptyView(tab: CandidateTab, list: { role: { id: string; status: RoleStatus }; counts: CandidateCounts }): EmptyView {
  const { role, counts } = list;
  if (tab === "new") {
    if (counts.total > 0) return { title: "Nobody new to review", action: null };
    if (role.status === "open" || role.status === "paused") return { title: "Nobody has applied yet", action: { label: "Share the job", href: appPaths.jobShare(role.id) } };
    return { title: "Nobody has applied yet", action: role.status === "draft" ? { label: "Open the job", href: appPaths.job(role.id) } : null };
  }
  if (tab === "shortlisted") return { title: "Nobody is shortlisted", action: counts.byTab.new > 0 ? { label: "Review new candidates", tab: "new" } : null };
  if (tab === "interviewed") return { title: "Nobody has finished the AI interview yet", action: counts.byTab.shortlisted > 0 ? { label: "See who is shortlisted", tab: "shortlisted" } : null };
  if (tab === "hired") return { title: "Nobody hired yet", action: counts.byTab.interviewed > 0 ? { label: "See who was interviewed", tab: "interviewed" } : null };
  return { title: "Nobody here", action: null };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The candidate panel                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** The one line that goes with Shortlist: what pressing it sends. */
export const SHORTLIST_NOTE = "Shortlist sends the AI interview.";

/** One of a person's actions as the panel draws it: the API's state, how strong the button is, and a line under it. */
export type PanelButton = CandidateActionState & { variant: "primary" | "secondary" | "ghost"; note: string | null };

/**
 * The panel's buttons: one for each action the API lists for where the person is, in its order, and none it does not
 * list. The first that may be pressed is the main one; taking something back is the quietest. One that is not allowed
 * stays, greyed, with the API's reason beside it.
 */
export function panelButtons(actions: readonly CandidateActionState[]): PanelButton[] {
  const main = actions.find((a) => a.allowed && a.action !== "undo_decision" && a.action !== "cancel_screen")?.action ?? null;
  return actions.map((a) => ({
    ...a,
    variant: a.action === main ? "primary" : a.action === "undo_decision" || a.action === "cancel_screen" ? "ghost" : "secondary",
    note: a.action === "shortlist" && a.allowed ? SHORTLIST_NOTE : null,
  }));
}

/** Said on the panel of someone marked Not selected whom nobody has told: the decision is private until it is emailed. */
export function privateLine(panel: Pick<CandidatePanel, "stage" | "toldState"> & { candidate: Pick<CandidatePanel["candidate"], "firstName"> }): string | null {
  if (panel.stage !== "rejected" || panel.toldState !== "not_told") return null;
  return `Private: ${panel.candidate.firstName.trim() || "this person"} has not been told.`;
}

/**
 * How the resume file is shown. Checked and a PDF: in a frame as it is. Checked, another kind of file, with text of
 * its own: its text in a frame. Checked with neither: the download alone. Not checked, refused or removed: the
 * server's line in its place, and nothing to open.
 */
export function resumeView(applicationId: string, cv: CandidateDocument | null): { frame: string | null; download: string | null; words: string | null } {
  if (!cv) return { frame: null, download: null, words: "No resume on file." };
  if (cv.status !== "clean") return { frame: null, download: null, words: cv.statusLabel };
  const base = `/api/v1/applications/${applicationId}/documents/${cv.id}`;
  const download = `${base}/file`;
  if (cv.mime === "application/pdf") return { frame: `${base}/inline`, download, words: null };
  if (cv.hasText) return { frame: `${base}/inline?as=text`, download, words: null };
  return { frame: null, download, words: null };
}

/** One requirement of the job in the resume match's breakdown. */
export type RequirementRow = { key: string; label: string; tag: string; points: string; finding: string; tone: Tone; quote: string | null };

/** The breakdown, in the server's order (must-haves first): what each requirement is, its share of the 100 points, the finding's word and the quote it rests on. */
export function requirementRows(score: Pick<CvScore, "requirements">): RequirementRow[] {
  return score.requirements.map((r) => ({
    key: r.key,
    label: r.label,
    tag: r.mustHave ? "Must-have" : IMPORTANCE_LABEL[r.importance ?? "helpful"],
    points: `${r.weightPct} ${r.weightPct === 1 ? "point" : "points"}`,
    finding: r.findingLabel,
    tone: findingTone(r.finding),
    quote: r.quote ? quoteWithSource(r.quote, r.source) : null,
  }));
}

/** When the AI interview's link went, how long it stays open, and when they started and sent their answers. Never how far anyone got. */
export function interviewFacts(ai: Pick<AiInterviewView, "sentAt" | "linkOpenUntil" | "startedAt" | "completedAt"> | null, now: Date = new Date()): string[] {
  if (!ai) return [];
  const out: string[] = [];
  if (ai.sentAt) out.push(`Sent ${shortDay(ai.sentAt, now)}`);
  if (ai.linkOpenUntil) out.push(`Link open until ${shortDay(ai.linkOpenUntil, now)}`);
  if (ai.startedAt && !ai.completedAt) out.push(`Started ${shortDay(ai.startedAt, now)}`);
  if (ai.completedAt) out.push(`Answers sent ${shortDay(ai.completedAt, now)}`);
  return out;
}

/** One question of the AI interview in its per-question table. */
export type QuestionRow = { key: string; question: string; finding: string; tone: Tone; quote: string | null; note: string | null };

export function questionRows(score: Pick<InterviewScore, "questions">): QuestionRow[] {
  return score.questions.map((q) => ({ key: q.key, question: q.question, finding: q.findingLabel, tone: findingTone(q.finding), quote: q.quote ? `"${q.quote}"` : null, note: q.note }));
}

/** An answer as the candidate sent it, or that they skipped the question. */
export function answerWords(a: Pick<InterviewAnswer, "answer" | "skipped">): string {
  return a.skipped ? "Skipped" : a.answer?.trim() || "No answer";
}
