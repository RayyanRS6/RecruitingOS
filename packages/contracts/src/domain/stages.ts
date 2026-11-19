import { z } from "zod";

/**
 * Where an application is. The stage is the only place a person's position is stored: every tab, count and label on
 * screen is worked out from it by the functions in this file.
 *
 * The system moves applied > received > triaged (the CV is read) and screen_invited > screening > screen_complete (the
 * AI interview is sent, started, and its answers sent by the candidate). A person on the team shortlists (triaged >
 * screen_invited), cancels the AI interview (back to triaged), hires or marks Not selected from any stage still in the
 * process, and undoes either (`stageAfterUndo`). The candidate may withdraw. The system never declines and never hires.
 */
export const ApplicationStage = z.enum(["applied", "received", "triaged", "screen_invited", "screening", "screen_complete", "hired", "rejected", "withdrawn"]);
export type ApplicationStage = z.infer<typeof ApplicationStage>;

/** The stages a person is still in the process at, in order. */
export const IN_PROCESS_STAGES: readonly ApplicationStage[] = ["applied", "received", "triaged", "screen_invited", "screening", "screen_complete"];
/** Out of the process: hired, not selected, or withdrew. */
export const TERMINAL_STAGES: ReadonlySet<ApplicationStage> = new Set(["hired", "rejected", "withdrawn"]);

export function inProcess(stage: ApplicationStage): boolean {
  return !TERMINAL_STAGES.has(stage);
}

/**
 * Where an undo of Hired or Not selected puts a person, from the stage the decision was made at. Someone who had sent
 * their AI interview answers goes back to Interviewed. Anyone else goes back to New: a decision closes an AI interview
 * that was still open, so someone who was Shortlisted can be shortlisted again, and gets a new link.
 */
export function stageAfterUndo(before: ApplicationStage | null | undefined): ApplicationStage {
  return before === "screen_complete" ? "screen_complete" : "triaged";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The company's view: five tabs.                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** The tabs of a job's Candidates list, in the order they are shown. */
export const CandidateTab = z.enum(["new", "shortlisted", "interviewed", "hired", "not_selected"]);
export type CandidateTab = z.infer<typeof CandidateTab>;
export const CANDIDATE_TAB_LABEL: Record<CandidateTab, string> = { new: "New", shortlisted: "Shortlisted", interviewed: "Interviewed", hired: "Hired", not_selected: "Not selected" };

/** The tab each stage is listed under. Someone who withdrew is listed under Not selected, labelled "Withdrew". */
export const STAGE_TAB: Record<ApplicationStage, CandidateTab> = {
  applied: "new",
  received: "new",
  triaged: "new",
  screen_invited: "shortlisted",
  screening: "shortlisted",
  screen_complete: "interviewed",
  hired: "hired",
  rejected: "not_selected",
  withdrawn: "not_selected",
};

export function tabOf(stage: ApplicationStage): CandidateTab {
  return STAGE_TAB[stage];
}

/**
 * Where a shortlisted person's AI interview stands, as the team reads it. `sent`: the link is out and not started;
 * `started`: begun, answers not sent; `link_closed`: the link closed after five days without their answers; `opted_out`:
 * they chose "I'd rather not do the AI interview"; `done`: they pressed "Send my answers". Never how far anyone got:
 * nothing of an interview reaches the team before the candidate sends it.
 */
export const AiInterviewStatus = z.enum(["sent", "started", "link_closed", "opted_out", "done"]);
export type AiInterviewStatus = z.infer<typeof AiInterviewStatus>;
export const AI_INTERVIEW_STATUS_LABEL: Record<AiInterviewStatus, string> = {
  sent: "AI interview sent",
  started: "AI interview started",
  link_closed: "AI interview link closed",
  opted_out: "Chose not to do the AI interview",
  done: "AI interview done",
};

/**
 * The one label table for a stage. Under Shortlisted the AI interview's own label is shown instead (`stageLabel`). A
 * person whose CV is still being read is "New" like everyone else in that tab: their CV score says "Reading the CV".
 */
export const STAGE_LABEL: Record<ApplicationStage, string> = {
  applied: "New",
  received: "New",
  triaged: "New",
  screen_invited: AI_INTERVIEW_STATUS_LABEL.sent,
  screening: AI_INTERVIEW_STATUS_LABEL.started,
  screen_complete: "Interviewed",
  hired: "Hired",
  rejected: "Not selected",
  withdrawn: "Withdrew",
};

/**
 * The words a row and the candidate panel show for where a person is: the stage's label, and for someone shortlisted
 * where their AI interview stands when that is known ("AI interview link closed", "Chose not to do the AI interview").
 */
export function stageLabel(stage: ApplicationStage, aiInterview?: AiInterviewStatus | null): string {
  if ((stage === "screen_invited" || stage === "screening") && aiInterview && aiInterview !== "done") return AI_INTERVIEW_STATUS_LABEL[aiInterview];
  return STAGE_LABEL[stage];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Telling a candidate, and the candidate's own view.                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Whether someone marked Not selected has been told. The decision is private until a person presses "Email the
 * decision": `not_told`, then `queued` while the email waits in the outbox (it can still be taken back), then `sent`.
 * Null for every other stage.
 */
export const ToldState = z.enum(["not_told", "queued", "sent"]);
export type ToldState = z.infer<typeof ToldState>;
export const TOLD_STATE_LABEL: Record<ToldState, string> = { not_told: "Not told yet", queued: "Decision email on its way", sent: "Told by email" };

/**
 * The steps a candidate sees on their status page, in order. "AI interview" is shown only to someone who was
 * shortlisted, and "Decision" only once they were told (or hired, or withdrew themselves): a decision nobody has told
 * them reads as the step they were at before it. Nothing about a score is ever shown to a candidate.
 */
export const CandidateStep = z.enum(["received", "under_review", "interview", "decision"]);
export type CandidateStep = z.infer<typeof CandidateStep>;
export const CANDIDATE_STEP_LABEL: Record<CandidateStep, string> = { received: "Received", under_review: "Under review", interview: "AI interview", decision: "Decision" };

/* ------------------------------------------------------------------------------------------------------------ */
/* Jobs.                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * A job's status. `draft`: saved and not published yet; `open`: its job page is public and takes applications;
 * `paused`: taking no new applications, while everyone already in the process carries on; `closed`: finished, for good.
 * The company publishes with one button; nobody approves a job.
 */
export const RoleStatus = z.enum(["draft", "open", "paused", "closed"]);
export type RoleStatus = z.infer<typeof RoleStatus>;
export const ROLE_STATUS_LABEL: Record<RoleStatus, string> = { draft: "Draft", open: "Open", paused: "Paused", closed: "Closed" };
