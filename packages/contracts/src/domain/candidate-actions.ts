import { z } from "zod";
import { TRIAL_ENDED_LINE } from "./trial";
import { inProcess, type AiInterviewStatus, type ApplicationStage, type RoleStatus, type ToldState } from "./stages";

/**
 * Everything a person on the team can do with a candidate, and the one rule that says when. The API works the list out
 * with `candidateActions` for every row and for the panel, and refuses with the same reason when an action that is not
 * allowed is sent anyway. A screen shows what it is given: a button for each action, disabled with its `reason` when it
 * is not allowed. It never works the rule out again.
 *
 * - `shortlist`: moves someone from New to Shortlisted and emails them the AI interview.
 * - `remind_screen`: emails a reminder about an open AI interview link (at most one a day).
 * - `send_new_link`: emails a new AI interview link after the first one closed.
 * - `cancel_screen`: cancels the AI interview before its answers are sent; the person goes back to New.
 * - `hire`: marks the person Hired. Nothing is emailed.
 * - `reject`: marks the person Not selected. Private: nothing is emailed until someone presses "Email the decision".
 * - `undo_decision`: takes back Hired, or Not selected while the candidate has not been told (`stageAfterUndo` says where they go).
 * - `send_decision`: emails the one standard decision message to someone marked Not selected.
 * - `unsend_decision`: takes that email back while it still waits in the outbox.
 */
export const CandidateAction = z.enum(["shortlist", "remind_screen", "send_new_link", "cancel_screen", "hire", "reject", "undo_decision", "send_decision", "unsend_decision"]);
export type CandidateAction = z.infer<typeof CandidateAction>;

export const CANDIDATE_ACTION_LABEL: Record<CandidateAction, string> = {
  shortlist: "Shortlist",
  remind_screen: "Send a reminder",
  send_new_link: "Send a new link",
  cancel_screen: "Cancel the AI interview",
  hire: "Hire",
  reject: "Not selected",
  undo_decision: "Undo",
  send_decision: "Email the decision",
  unsend_decision: "Don't send",
};

/** The actions that can be done for several ticked people at once. `unsend_decision` is the Undo of a `send_decision` for several. */
export const BulkCandidateAction = z.enum(["shortlist", "reject", "send_decision", "unsend_decision"]);
export type BulkCandidateAction = z.infer<typeof BulkCandidateAction>;

/** One action as a row and the panel carry it: its button's words, whether it may be pressed now, and why not. */
export type CandidateActionState = { action: CandidateAction; label: string; allowed: boolean; reason: string | null };

/** Why the plan stops something that costs AI help or an AI interview; null when it does not. */
export const PlanStop = z.enum(["ai_interviews_used_up", "ai_used_up", "trial_ended"]);
export type PlanStop = z.infer<typeof PlanStop>;

/** The plain reason an action is not allowed. One sentence each; the same words on a disabled button and in a refusal. */
export const ACTION_BLOCKED = {
  beingRead: "Their resume is still being read. Try again in a moment.",
  noEmail: "There is no email address that works for them, so nothing can be sent.",
  jobClosed: "This job is closed.",
  interviewsUsedUp: "This month's AI interviews are used up.",
  aiUsedUp: "Your plan's AI help is used up.",
  trialEnded: TRIAL_ENDED_LINE,
  remindedRecently: "A reminder or the link went to them in the last day. Try again tomorrow.",
  toldAlready: "They were already told by email.",
  emailOnItsWay: "The decision email is on its way. Press \"Don't send\" first to change anything.",
  emailLeft: "The email has already left.",
} as const;

/** What the rule reads about one application. Everything here is a stored fact the server looks up; nothing is guessed. */
export type CandidateActionFacts = {
  stage: ApplicationStage;
  /** Where their newest AI interview stands; null without one (never shortlisted, or it was cancelled). */
  aiInterview: AiInterviewStatus | null;
  /** For someone Not selected: whether they were told. Null at every other stage. */
  toldState: ToldState | null;
  /** The decision email still waits in the outbox and can be taken back. */
  decisionEmailWaiting: boolean;
  /** An email address is on file and is not on the do-not-send list. */
  reachable: boolean;
  /** The AI interview's link or a reminder about it went to them in the last 24 hours. */
  remindedRecently: boolean;
  roleStatus: RoleStatus;
  /** The plan stops new AI interviews for this company now. */
  planStop: PlanStop | null;
};

/**
 * The plain reason for each thing the plan stops: the words on the greyed button, and the ones the API answers 402 with
 * when the action is sent anyway (it knows a refusal is the plan's by this table).
 */
export const PLAN_STOP_REASON: Record<PlanStop, string> = { ai_interviews_used_up: ACTION_BLOCKED.interviewsUsedUp, ai_used_up: ACTION_BLOCKED.aiUsedUp, trial_ended: ACTION_BLOCKED.trialEnded };

/**
 * The actions that apply to a person where they are now, in the order the buttons are shown, each allowed or not with
 * the reason. Every member of the team (owner, admin, member) may do every one of them; nobody else may do any.
 */
export function candidateActions(f: CandidateActionFacts): CandidateActionState[] {
  const state = (action: CandidateAction, reason: string | null = null): CandidateActionState => ({ action, label: CANDIDATE_ACTION_LABEL[action], allowed: reason === null, reason });
  /** Why a new AI interview email cannot go now. */
  const sendBlocked = (): string | null => {
    if (f.roleStatus === "closed") return ACTION_BLOCKED.jobClosed;
    if (!f.reachable) return ACTION_BLOCKED.noEmail;
    return f.planStop ? PLAN_STOP_REASON[f.planStop] : null;
  };
  const out: CandidateActionState[] = [];
  if (inProcess(f.stage)) {
    if (f.stage === "applied" || f.stage === "received") out.push(state("shortlist", ACTION_BLOCKED.beingRead));
    else if (f.stage === "triaged") out.push(state("shortlist", sendBlocked()));
    else if (f.stage === "screen_invited" || f.stage === "screening") {
      if (f.aiInterview === "sent" || f.aiInterview === "started") {
        out.push(state("remind_screen", f.roleStatus === "closed" ? ACTION_BLOCKED.jobClosed : !f.reachable ? ACTION_BLOCKED.noEmail : f.remindedRecently ? ACTION_BLOCKED.remindedRecently : null));
      } else if (f.aiInterview === "link_closed") {
        out.push(state("send_new_link", sendBlocked()));
      }
      out.push(state("cancel_screen"));
    }
    out.push(state("hire"), state("reject"));
    return out;
  }
  if (f.stage === "hired") return [state("undo_decision")];
  if (f.stage === "rejected") {
    if (f.toldState === "queued") {
      return [state("unsend_decision", f.decisionEmailWaiting ? null : ACTION_BLOCKED.emailLeft), state("undo_decision", ACTION_BLOCKED.emailOnItsWay)];
    }
    if (f.toldState === "sent") return [state("send_decision", ACTION_BLOCKED.toldAlready), state("undo_decision", ACTION_BLOCKED.toldAlready)];
    return [state("send_decision", f.reachable ? null : ACTION_BLOCKED.noEmail), state("undo_decision")];
  }
  // Withdrew: their own choice, and nothing is left to do.
  return out;
}

/** The state of one action for a person, or null when it does not apply where they are. */
export function candidateActionState(f: CandidateActionFacts, action: CandidateAction): CandidateActionState | null {
  return candidateActions(f).find((a) => a.action === action) ?? null;
}
