import {
  appPaths, draftStillNeeds, EMPLOYMENT_TYPE_LABEL, FORM_QUESTION_KIND_LABEL, formatPayRange, REMOTE_POLICY_LABEL,
  type CandidateCounts, type ClosingDateView, type DraftRolePacket, type FormQuestion, type IntakeDraftSummary, type Location, type PostsState,
  type RoleActionState, type RolePacket, type RoleStatus, type RoleSummary, type SharePost, type ShareView,
} from "@ros/contracts";
import type { Tone } from "@ros/ui";
import { calendarDay, shortDay, todayIn } from "./dates";

/**
 * The Jobs page and a job's own page (its header, its Job tab and its Share tab), the parts that need no browser, kept
 * out of the pages so tests/web/jobs.test.ts can check them. Every status word, count and allowed action comes from the
 * API; these only lay them out.
 */

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The colour of a job's status dot. The word beside it is the API's `statusLabel`; the colour only helps a glance. */
export function statusTone(status: RoleStatus): Tone {
  return status === "open" ? "good" : status === "paused" ? "caution" : "neutral";
}

/** Where a job opens: its candidates once it has been published, the job itself while it is a draft. */
export function jobHref(job: Pick<RoleSummary, "id" | "status" | "openedAt">): string {
  return job.status !== "draft" && job.openedAt ? appPaths.candidates(job.id) : appPaths.job(job.id);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The Jobs page                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * One job on the Jobs page: where it opens, its status, where the job is (the API's `place`, when it names one), when
 * it was published and how many people it has, tab by tab.
 */
export type JobRow = { id: string; title: string; href: string; statusLabel: string; tone: Tone; facts: string[]; counts: string[] };

export function jobRow(job: RoleSummary, now: Date = new Date()): JobRow {
  const facts: string[] = job.place ? [job.place] : [];
  if (job.openedAt) facts.push(`Published ${shortDay(job.openedAt, now)}`);
  else facts.push(`Created ${shortDay(job.createdAt, now)}`);
  if (job.status === "closed" && job.closedAt) facts.push(`Closed ${shortDay(job.closedAt, now)}`);
  else if (job.status !== "closed" && job.daysOpen !== null) facts.push(job.daysOpen === 0 ? "Opened today" : `${counted(job.daysOpen, "day", "days")} open`);
  if (job.closesOn && job.status !== "closed") facts.push(`Apply by ${calendarDay(job.closesOn)}`);
  return { id: job.id, title: job.title, href: jobHref(job), statusLabel: job.statusLabel, tone: statusTone(job.status), facts, counts: job.status === "draft" ? [] : countWords(job.counts) };
}

/** A job's people in words: everyone who applied, then each tab that has someone, then the people the plan keeps locked. */
export function countWords(counts: CandidateCounts): string[] {
  if (!counts.total) return ["No applicants yet"];
  const out = [counted(counts.total, "applicant", "applicants")];
  if (counts.byTab.new) out.push(`${counts.byTab.new} new`);
  if (counts.byTab.shortlisted) out.push(`${counts.byTab.shortlisted} shortlisted`);
  if (counts.byTab.interviewed) out.push(`${counts.byTab.interviewed} interviewed`);
  if (counts.byTab.hired) out.push(`${counts.byTab.hired} hired`);
  if (counts.locked > 0) out.push(`${counts.locked} locked`);
  return out;
}

/**
 * One unfinished draft, on Home, on the Jobs page and under the job builder's first box: its title (or "Untitled job"),
 * where it continues, who started it when that is someone else, when it last changed, and how much is still needed.
 * "Still needed" counts what the builder lists under that heading when the draft is opened (`draftStillNeeds`): the
 * essentials that are missing, and the pay while nobody has confirmed it.
 */
export type DraftRow = { id: string; title: string; href: string; facts: string[] };

export function draftRow(draft: Pick<IntakeDraftSummary, "id" | "title" | "updatedAt" | "mine" | "startedBy" | "missing" | "payConfirmed" | "hasDraft">, now: Date = new Date()): DraftRow {
  const facts: string[] = [];
  if (!draft.mine) facts.push(`Started by ${draft.startedBy.name ?? "someone on your team"}`);
  const day = shortDay(draft.updatedAt, now);
  if (day) facts.push(`Last changed ${day}`);
  const needed = draftStillNeeds(draft).length;
  if (needed) facts.push(`${counted(needed, "thing", "things")} still needed`);
  else if (draft.hasDraft) facts.push("Written");
  return { id: draft.id, title: draft.title?.trim() || "Untitled job", href: appPaths.draft(draft.id), facts };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A job's page: the header and the tabs                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

export type JobTabId = "candidates" | "job" | "share";

/** The three tabs of a job, Candidates first, each its own address. Candidates carries how many people applied, once known. */
export function jobTabs(roleId: string, counts: Pick<CandidateCounts, "total"> | null | undefined): Array<{ id: JobTabId; label: string; href: string; count?: number }> {
  return [
    { id: "candidates", label: "Candidates", href: appPaths.candidates(roleId), ...(counts ? { count: counts.total } : {}) },
    { id: "job", label: "Job", href: appPaths.job(roleId) },
    { id: "share", label: "Share", href: appPaths.jobShare(roleId) },
  ];
}

/** The tab `?tab=` names on a job's page: Share, or the Job tab for anything else. */
export function jobTabFrom(value: string | null | undefined): "job" | "share" {
  return value === "share" ? "share" : "job";
}

/** A place in words: "Irvine, CA", or its label when it has no city. */
export function placeWords(location: Location | undefined): string {
  if (!location) return "";
  return [location.city, location.region].filter(Boolean).join(", ") || location.label || "";
}

type Packet = RolePacket | DraftRolePacket;

/** The header's one line of facts: where, the work arrangement, the type, the pay, and "Apply by …" while a date is set. */
export function jobFacts(packet: Packet | null | undefined, applyBy?: string | null): string[] {
  if (!packet) return [];
  const { identity: i, compensation: c } = packet;
  return [i.locations.map(placeWords).filter(Boolean).join("; "), REMOTE_POLICY_LABEL[i.remotePolicy], EMPLOYMENT_TYPE_LABEL[i.employmentType], c ? formatPayRange(c) : "", applyBy ?? ""].filter(Boolean);
}

/** The "Apply by …" a job's header carries: the API's line while a date is set and the job is not closed. */
export function applyByOf(closing: Pick<ClosingDateView, "closesOn" | "applyBy"> | null | undefined, status: RoleStatus): string | null {
  return closing?.closesOn && status !== "closed" ? closing.applyBy ?? `Apply by ${calendarDay(closing.closesOn)}` : null;
}

/**
 * A job's actions as its header lays them out: "Publish job" for a draft and "Edit" for the Job tab are buttons of
 * their own; pause, resume, the closing date and close share one menu. An action the API does not list is not drawn.
 */
export function headerActions(actions: readonly RoleActionState[]): { publish: RoleActionState | null; edit: RoleActionState | null; menu: RoleActionState[] } {
  return {
    publish: actions.find((a) => a.action === "publish") ?? null,
    edit: actions.find((a) => a.action === "edit") ?? null,
    menu: actions.filter((a) => a.action !== "publish" && a.action !== "edit"),
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The job record, as the Job tab and the job builder show it                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The record's facts as label and value rows. `pay`: whether candidates see the range by the job page's own rule and
 * whether a pay transparency law is why (a job's page knows; a draft says what was chosen).
 */
export function recordFacts(packet: Packet, pay?: { shown: boolean; requiredByLaw: boolean }): Array<{ label: string; value: string }> {
  const { identity: i, compensation: c } = packet;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Where", value: i.locations.map(placeWords).filter(Boolean).join("; ") },
    { label: "Work arrangement", value: REMOTE_POLICY_LABEL[i.remotePolicy] },
    { label: "Type", value: EMPLOYMENT_TYPE_LABEL[i.employmentType] },
    { label: "Schedule", value: i.schedule ?? "" },
    { label: "Department", value: i.department ?? "" },
    { label: "Pay", value: c ? formatPayRange(c) : "Not set yet" },
  ];
  if (c) {
    const shown = pay ? pay.shown : c.discloseRange;
    rows.push({ label: "Pay on the job page", value: pay?.requiredByLaw && !c.discloseRange ? "Shown: the law where this job is requires it" : shown ? "Shown" : "Not shown" });
    rows.push({ label: "Benefits", value: c.benefitsSummary ?? "" });
  }
  return rows.filter((r) => r.value);
}

/** How one screening question is answered, in a few words: "Yes or no", "Choice: Days · Nights", "Number (years)", and "optional" when it may be left. */
export function formQuestionFacts(q: FormQuestion): string {
  const kind = q.kind === "choice" ? `${FORM_QUESTION_KIND_LABEL.choice}: ${q.options.join(" · ")}` : q.kind === "number" && q.unit ? `${FORM_QUESTION_KIND_LABEL.number} (${q.unit})` : FORM_QUESTION_KIND_LABEL[q.kind];
  return q.required ? kind : `${kind} · optional`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The closing date                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/** The closing date in one line. */
export function closingDateLine(c: Pick<ClosingDateView, "closesOn" | "applyBy" | "applicationsClosedByDate">): string {
  if (c.applicationsClosedByDate) return `The closing date${c.closesOn ? `, ${calendarDay(c.closesOn)},` : ""} has passed. New applications have stopped.`;
  if (c.closesOn) return c.applyBy ?? `Apply by ${calendarDay(c.closesOn)}`;
  return "No closing date";
}

/**
 * Why a closing date cannot be saved, or null. "Today" is today in the company's time zone (`todayIn`, the one place
 * the pages work it out), as the server checks the date: `timeZone` is the one the API sends with the job or the draft.
 */
export function closingDateProblem(value: string, timeZone: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Choose a date.";
  if (value < todayIn(timeZone, now)) return "Choose today or a later date.";
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The Share tab                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** How often the Share tab asks again while the posts are being written; false once there is nothing to wait for. */
export function shareRefresh(view: Pick<ShareView, "state"> | null | undefined): number | false {
  return view?.state === "writing" ? 4000 : false;
}

/**
 * One post's box: the words in it (what the person typed, else the post as written), whether they differ from the saved
 * post (Save shows only then), and whether there is anything to copy.
 */
export function postBox(post: Pick<SharePost, "text">, typed: string | undefined): { text: string; dirty: boolean; empty: boolean } {
  const saved = post.text ?? "";
  const text = typed ?? saved;
  return { text, dirty: typed !== undefined && typed.trim() !== saved.trim(), empty: !text.trim() };
}

/** What an empty post's box says: that the post is on its way, or that it is the person's to write. */
export function postPlaceholder(state: PostsState | null): string {
  return state === "writing" ? "Being written…" : "Write your post here";
}
