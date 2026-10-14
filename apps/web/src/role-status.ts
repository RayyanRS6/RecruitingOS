import type { Tone } from "@ros/ui";

/**
 * A role's status as the owner reads it: a word and the colour of its dot (docs/07: the word carries the meaning, the
 * colour only helps a glance). Green is a role taking applicants or filled, amber one waiting on a person or held.
 * An open job reads "Live", the word the job's own pages use.
 */
export const ROLE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "caution" },
  open: { label: "Live", tone: "good" },
  paused: { label: "Paused", tone: "caution" },
  filled: { label: "Filled", tone: "good" },
  closed: { label: "Closed", tone: "neutral" },
};

export function roleStatus(status: string): { label: string; tone: Tone } {
  return ROLE_STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The job's one tab strip (Wave S1: simple, Kanvis-like screens). Where a link to a job lands is rail.ts jobHref.  */
/* ------------------------------------------------------------------------------------------------------------ */

/** The tabs of a job, Candidates first. Candidates lives at /roles/:id/talent; the rest at /roles/:id?tab=… */
export type JobTab = "candidates" | "job" | "scoring" | "plan" | "share" | "report" | "activity";
export type JobPageTab = Exclude<JobTab, "candidates">;

const PAGE_TABS: readonly JobPageTab[] = ["job", "scoring", "plan", "share", "report", "activity"];
/** The tab names older links use (notifications, emails, Home's cards): each opens the tab that now holds it. */
const OLDER_TAB: Record<string, JobPageTab> = { overview: "job", requirements: "scoring", evaluation: "scoring", posting: "share", history: "activity" };

/** The tab `?tab=` asks for, old names included; the Job tab when it names none. */
export function jobTabFrom(value: string | null | undefined): JobPageTab {
  if (!value) return "job";
  if ((PAGE_TABS as readonly string[]).includes(value)) return value as JobPageTab;
  return OLDER_TAB[value] ?? "job";
}

/** The address of one tab of a job. */
export function jobTabHref(roleId: string, tab: JobTab): string {
  if (tab === "candidates") return `/roles/${roleId}/talent`;
  return tab === "job" ? `/roles/${roleId}` : `/roles/${roleId}?tab=${tab}`;
}

/**
 * The job's tabs for this person: Candidates (with how many applied) and the Report only for those who may see
 * candidates. Activity is for everyone: its list of versions is not private; the activity feed inside it is.
 */
export function jobTabs(opts: { seesCandidates: boolean; candidates?: number | null }): Array<{ id: JobTab; label: string; count?: number }> {
  const all: Array<{ id: JobTab; label: string; count?: number }> = [
    { id: "candidates", label: "Candidates", ...(opts.candidates === null || opts.candidates === undefined ? {} : { count: opts.candidates }) },
    { id: "job", label: "Job" },
    { id: "scoring", label: "Scoring" },
    { id: "plan", label: "Interview plan" },
    { id: "share", label: "Share" },
    { id: "report", label: "Report" },
    { id: "activity", label: "Activity" },
  ];
  return all.filter((t) => opts.seesCandidates || (t.id !== "candidates" && t.id !== "report"));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The job's More menu                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

export type JobAction = "edit" | "preview" | "compare" | "pause" | "resume" | "stop-accepting" | "accept-again" | "extend-date" | "hire-again" | "closing-message" | "close";
export type JobActionItem = { id: JobAction; label: string; danger?: boolean };

/** The accepting-applications switch's three ways, in the words the menu and the banner use. */
export const ACCEPTING_LABEL = { stop: "Stop accepting applications", reopen: "Accept applications again", extend: "Extend the closing date" } as const;

/**
 * What the job's More menu offers, in order: the everyday ones first, closing last. `can` is what the person's team role
 * allows (apps/web/src/roles.ts) and what the page has loaded; the job's status decides the rest. `accepting` is unknown
 * (null) until the job itself is read, and then the switch is left out. `comparing` is null where Compare is not offered.
 */
export function jobActions(input: {
  status: string;
  accepting?: boolean | null;
  closedByDate?: boolean;
  can: { manage: boolean; edit: boolean; preview: boolean; close: boolean; tell: boolean; hireAgain: boolean };
  comparing?: boolean | null;
  closingMessageOpen?: boolean;
}): JobActionItem[] {
  const { status, can } = input;
  const live = status === "open" || status === "paused";
  const out: JobActionItem[] = [];
  if (can.edit) out.push({ id: "edit", label: "Edit" });
  if (can.preview) out.push({ id: "preview", label: "Candidate view" });
  if (input.comparing === true || input.comparing === false) out.push({ id: "compare", label: input.comparing ? "Done comparing" : "Compare" });
  if (can.manage && status === "open") out.push({ id: "pause", label: "Pause" });
  if (can.manage && status === "paused") out.push({ id: "resume", label: "Resume" });
  if (can.manage && live && (input.accepting === true || input.accepting === false)) {
    if (input.accepting) out.push({ id: "stop-accepting", label: ACCEPTING_LABEL.stop });
    else if (input.closedByDate) out.push({ id: "extend-date", label: ACCEPTING_LABEL.extend });
    else out.push({ id: "accept-again", label: ACCEPTING_LABEL.reopen });
  }
  if (can.hireAgain && (status === "filled" || status === "closed")) out.push({ id: "hire-again", label: "Hire for this job again" });
  if (can.tell && status === "closed" && !input.closingMessageOpen) out.push({ id: "closing-message", label: "Send the closing message" });
  if (can.close && live) out.push({ id: "close", label: "Close the job", danger: true });
  return out;
}
