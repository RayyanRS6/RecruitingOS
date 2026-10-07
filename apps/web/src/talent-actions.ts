import type { ActionResult, CandidateNotice, DeclineMessagePolicy } from "./api/client";

/**
 * What the Talent page says after a decision, word for word from what the API reports (plan 0.5; founder decision B6:
 * decisions are private, so the words say exactly whether the candidate was told). Until the told state arrives in
 * Wave G, a decline reports what became of its message: on its way, waiting for approval, or not sent and why.
 */
export function noticeText(notice: CandidateNotice): string {
  switch (notice) {
    case "queued":
      return "A short, courteous message to the candidate is on its way.";
    case "already_sent":
      return "They already had a decline message from an earlier decision, so nothing new was sent.";
    case "pending_approval":
      return "The message to the candidate is waiting for approval; they have not been told yet.";
    case "not_sent_settings":
      return "No message was sent under your settings; the candidate has not been told.";
    case "not_sent_no_email":
      return "There is no email address on file, so the candidate has not been told.";
    case "not_sent":
      return "The message could not be prepared, so the candidate has not been told.";
    case "not_told":
      return "The candidate was not told.";
  }
}

/** An older answer without `candidateNotice` says only whether the message went. */
function declineNotice(r: Pick<ActionResult, "candidateNotice" | "dispositionSent">): string {
  if (r.candidateNotice) return noticeText(r.candidateNotice);
  return r.dispositionSent ? noticeText("queued") : "No message has gone to the candidate yet.";
}

/** The toast after a button on the candidate page (POST /applications/:id/actions). */
export function actionToast(action: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "next" | "talentPoolOptOut">): string {
  switch (action) {
    case "reject":
      return `Declined. ${declineNotice(r)}`;
    case "hold":
      return "Saved. The candidate was not told.";
    case "advance_to_interview":
      return "Marked for interview. The candidate was not told; choose Interview to offer them times.";
    case "move_to_talent_pool":
      // The person's own "don't keep me for future roles" stands (Wave 0 item 0.11); the page says so instead of "added".
      return r.talentPoolOptOut
        ? "Moved out of this role. They asked not to be kept for future roles, so they are not in your talent pool and nobody will contact them about other openings. The candidate was not told."
        : "Added to your talent pool. The candidate was not told.";
    case "invite_screen":
      return r.next ?? "Invitation on its way.";
    case "ask_in_screen":
      return r.next ?? "Invitation on its way. The screen starts with these questions.";
    case "override_eligibility":
      return "Kept in. Your reason is recorded.";
    case "review_anyway":
      return "Reopened. The application is being looked at again.";
    default:
      return "Done.";
  }
}

/** The toast after "How did the interview go?" (POST /applications/:id/decision). */
export function decisionToast(decision: "next_round" | "finalist" | "not_moving_forward", r: Pick<ActionResult, "candidateNotice" | "dispositionSent"> & { nextRoundKey?: string | null }): string {
  if (decision === "finalist") return "Marked as a finalist.";
  if (decision === "next_round") return r.nextRoundKey ? "Next round. Check the interviewers below and approve; times go out from there." : "Next round recorded.";
  return `Recorded. ${declineNotice(r)}`;
}

/** The toast after "Record what happened" (POST /applications/:id/outcome); only a decline involves a message. */
export function outcomeToast(outcome: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent">): string {
  return outcome === "employer_declined" ? `Outcome recorded with your name. ${declineNotice(r)}` : "Outcome recorded with your name.";
}

/** What the confirm step says before a decline, under the company's settings for the role, so the click holds no surprise. */
export function declineConfirmText(policy: DeclineMessagePolicy, input: { hasEmail: boolean; eligibility?: boolean }): string {
  const base = "Declining is your decision and is recorded with your reason.";
  if (policy === "not_sent") return `${base} Under your settings no message is sent, so the candidate is not told.`;
  if (!input.hasEmail) return `${base} There is no email address on file, so the candidate will not get a message.`;
  const message = input.eligibility ? "a short, courteous email saying the role needs something their answers did not show, and that they can reply if that has changed" : "a short, courteous email";
  if (policy === "needs_approval") return `${base} The candidate's message (${message}) waits for approval before it goes out.`;
  return `${base} The candidate gets ${message}.`;
}
