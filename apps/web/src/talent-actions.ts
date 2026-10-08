import { OWNER_STAGE_LABEL, type MarkKind, type OwnerStage } from "@ros/contracts";
import type { ActionResult, CandidateNotice, DecisionMessagesResponse, DeclineMessagePolicy, StageMove } from "./api/client";

/**
 * What the Talent page and the candidate panel say after a choice, word for word from what the API reports (plan 0.5;
 * founder decision B6: decisions are private, so the words say exactly whether the candidate was told). Each toast has
 * a first line saying what happened and, when there is more, a second line saying what did or did not follow.
 */
export type ToastParts = { title: string; detail?: string };

/** The second line of every private choice: a decision, a mark, a hold. */
export const NOT_TOLD = "Private: the candidate was not told.";
/** The second line after a decision: private, and how the candidate will hear. */
export const PRIVATE_DECISION = "Private: the candidate was not told. Send them the decision message when you are ready.";

/** What became of the candidate's message, in one sentence. */
export function noticeText(notice: CandidateNotice): string {
  switch (notice) {
    case "not_told":
      return NOT_TOLD;
    case "queued":
      return "A short, courteous message to the candidate is on its way.";
    case "waiting_approval":
      return "The message waits for approval; the candidate has not been told yet.";
    case "not_sent_settings":
      return "Under your settings no decision messages are sent; the candidate has not been told.";
    case "not_sent_no_email":
      return "There is no email address on file, so the candidate has not been told.";
    case "not_sent":
      return "The message could not be prepared, so the candidate has not been told.";
  }
}

/**
 * What a private decision did to interviews still to come (founder decision B6): each is cancelled now. A candidate who
 * had a booked time or times to pick from was sent a short note at once saying only that it is off (no reason), so
 * nobody turns up for it; the decision itself stays private until someone sends the decision message. `toldOff` is how
 * many such notes went (the API's `interviewOffNotes`); the rest had no times sent to the candidate yet.
 */
export function interviewsOffText(cancelled: number | undefined, toldOff?: number): string {
  if (!cancelled) return "";
  const told = Math.min(toldOff ?? 0, cancelled);
  const stopped = cancelled - told;
  const parts: string[] = [];
  if (told) parts.push(`${told === 1 ? "Their interview is" : `${told} interviews are`} cancelled, and they were sent a short note now saying only that ${told === 1 ? "it is" : "they are"} off.`);
  if (stopped) {
    parts.push(told
      ? `${stopped === 1 ? "Another interview is" : `${stopped} more interviews are`} stopped; no times had gone to them for ${stopped === 1 ? "it" : "those"}.`
      : `${stopped === 1 ? "Their interview is" : `${stopped} interviews are`} stopped; no times had gone to them, so nothing was sent about ${stopped === 1 ? "it" : "them"}.`);
  }
  return ` ${parts.join(" ")}`;
}

/** A decision's second line: the private sentence while nothing went (always, since B6), else what became of the message. */
function decisionDetail(r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes">): string {
  if (!r.candidateNotice || r.candidateNotice === "not_told") return r.dispositionSent ? noticeText("queued") : `${PRIVATE_DECISION}${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)}`;
  return noticeText(r.candidateNotice);
}

/** "October 22": the day a hold ends. */
export function holdDay(remindAt: string): string {
  return new Date(remindAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** The toast after a choice on the candidate panel or a row (POST /applications/:id/actions). */
export function actionToast(action: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "next" | "talentPoolOptOut" | "mark" | "ownerStage" | "interviewsCancelled" | "interviewOffNotes">): ToastParts {
  switch (action) {
    case "reject":
      return { title: "Moved to Not moving forward.", detail: decisionDetail(r) };
    case "hold":
    case "set_mark":
      if (r.mark?.mark === "on_hold") return { title: r.mark.remindAt ? `On hold until ${holdDay(r.mark.remindAt)}.` : "On hold.", detail: `They come back to Today then. ${NOT_TOLD}` };
      return { title: `Moved to ${r.mark?.label ?? "the new stage"}.`, detail: NOT_TOLD };
    case "clear_mark":
      return { title: r.ownerStage ? `Moved to ${OWNER_STAGE_LABEL[r.ownerStage]}.` : "Mark taken off.", detail: NOT_TOLD };
    case "advance_to_interview":
      return { title: "Marked for interview.", detail: "The candidate was not told; choose Interviewing to offer them times." };
    case "move_to_talent_pool":
      // The person's own "don't keep me for future roles" stands (Wave 0 item 0.11); the page says so instead of "added".
      return r.talentPoolOptOut
        ? { title: "Moved out of this role.", detail: `They asked not to be kept for future roles, so they are not in your talent pool and nobody will contact them about other openings. The candidate was not told.${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)}` }
        : { title: "Added to your talent pool.", detail: `The candidate was not told.${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)}` };
    case "invite_screen":
      return { title: r.next ?? "Invitation on its way." };
    case "ask_in_screen":
      return { title: r.next ?? "Invitation on its way. The screen starts with these questions." };
    case "override_eligibility":
      return { title: "Kept in.", detail: "Your reason is recorded." };
    case "review_anyway":
      return { title: "Reopened.", detail: "The application is being looked at again." };
    case "send_decision":
      return sendDecisionToast(r.candidateNotice ?? "not_sent");
    case "told_in_person":
      return { title: "Recorded that you told them yourself.", detail: "Nothing more will be sent." };
    case "cancel_screen":
      return { title: "Screen invitation stopped.", detail: r.next ?? (r.candidateNotice ? noticeText(r.candidateNotice) : "Their link no longer works.") };
    default:
      return { title: "Saved." };
  }
}

/** The toast after "How did the interview go?" (POST /applications/:id/decision). */
export function decisionToast(decision: "next_round" | "finalist" | "not_moving_forward", r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes"> & { nextRoundKey?: string | null }): ToastParts {
  if (decision === "finalist") return { title: "Marked as a finalist.", detail: "The candidate was not told." };
  if (decision === "next_round") return { title: r.nextRoundKey ? "Next round." : "Next round recorded.", detail: r.nextRoundKey ? "Check the interviewers below and approve; times go out from there." : undefined };
  return { title: "Recorded: not moving forward.", detail: decisionDetail(r) };
}

/** The toast after "Record what happened" (POST /applications/:id/outcome); the team's own decisions are private. */
export function outcomeToast(outcome: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes">): ToastParts {
  if (outcome === "hired_externally") return { title: "Hire recorded with your name." };
  if (outcome === "employer_declined" || outcome === "no_hire") return { title: "Outcome recorded with your name.", detail: decisionDetail(r) };
  return { title: "Outcome recorded with your name." };
}

/** The toast after "Send" on a decision message (one person). */
export function sendDecisionToast(notice: CandidateNotice): ToastParts {
  switch (notice) {
    case "queued":
      return { title: "Decision message sent.", detail: "A short, courteous message is on its way to the candidate." };
    case "waiting_approval":
      return { title: "Waiting for approval.", detail: "Someone who may approve it reads it first. The candidate has not been told yet." };
    case "not_sent_settings":
      return { title: "Not sent.", detail: "Under your settings no decision messages are sent. Tell them yourself, then record it here." };
    case "not_sent_no_email":
      return { title: "Not sent.", detail: "There is no email address on file. Tell them another way, then record it here." };
    default:
      return { title: "Not sent.", detail: "The message could not be prepared. Try again, or tell them yourself and record it." };
  }
}

/** How many people one bulk Send carries (the API's limit per request, SendDecisionMessages). */
export const DECISION_BATCH = 100;

/** The people to send to, in requests of at most `size`, in the order chosen. */
export function batches<T>(items: readonly T[], size = DECISION_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The answers of several bulk Sends as one: every person's own result, and the counts added up. */
export function mergeDecisionResults(parts: readonly DecisionMessagesResponse[]): DecisionMessagesResponse {
  return { results: parts.flatMap((p) => p.results), queued: parts.reduce((n, p) => n + p.queued, 0), waitingApproval: parts.reduce((n, p) => n + p.waitingApproval, 0), notSent: parts.reduce((n, p) => n + p.notSent, 0) };
}

/** The toast after sending the decision message to several people at once: every outcome counted, nothing hidden. */
export function bulkSendToast(r: Pick<DecisionMessagesResponse, "queued" | "waitingApproval" | "notSent">): ToastParts {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const title = r.queued ? `${plural(r.queued, "decision message", "decision messages")} on ${r.queued === 1 ? "its" : "their"} way.` : "No decision messages were sent.";
  const rest = [r.waitingApproval ? `${r.waitingApproval} waiting for approval` : "", r.notSent ? `${r.notSent} not sent; the list says why` : ""].filter(Boolean);
  return rest.length ? { title, detail: `${rest.join("; ")}.` } : { title };
}

/** "Not now" on one of the assistant's suggestions (plan A6). */
export const NOT_NOW_TOAST: ToastParts = { title: "Not now.", detail: "The suggestion is set aside. The candidate stays where they are and was not told." };

/**
 * The toast after a button on a Today card that answers an approval (POST /approvals/:id/decide): named for what the
 * button did, never a bare "Done."; a decision message says what became of it.
 */
export function briefDecisionToast(action: { label: string; body?: Record<string, unknown> }, response: unknown): ToastParts {
  const notice = (response as { candidateNotice?: CandidateNotice } | null)?.candidateNotice;
  if (action.body?.decision === "reject") {
    if (action.label === "Not now") return NOT_NOW_TOAST;
    if (action.label === "Do not send") return { title: "Not sent.", detail: "Nobody was told anything new; it can be sent later." };
    return { title: "Turned down.", detail: "Recorded with your name." };
  }
  if (notice) return sendDecisionToast(notice);
  if (/invite to a screen/i.test(action.label)) return { title: "Invitation on its way.", detail: "The screen goes to the candidate by email, or by text when they agreed to texts." };
  if (/^Yes, interview/i.test(action.label)) return { title: "Moved to Interviewing.", detail: "Open the candidate to choose the round and the interviewers; times go out from there." };
  if (action.label === "Yes, send it") return { title: "Sent.", detail: "It is on its way." };
  return { title: "Approved.", detail: "Recorded with your name." };
}

/** An interview a decision would call off: its title, when it is, its state, and the times offered to the candidate. */
export type InterviewRef = { title: string; startsAt: string | null; timezone: string | null; status: string; offeredSlots?: readonly unknown[] };

/** Whether the candidate knows about the interview: a booked time, or times offered to pick from. */
export function candidateKnowsOf(iv: InterviewRef): boolean {
  return (iv.status === "scheduled" && !!iv.startsAt) || (iv.status === "scheduling" && (iv.offeredSlots?.length ?? 0) > 0);
}

/**
 * What the confirm step says before "Not moving forward" (founder decision B6): the decision is private, how the
 * candidate will hear it under the company's settings, and the interviews it calls off, by name and time. One they knew
 * about (a booked time, times to pick from) is cancelled and the candidate is told at once, in a short note with no
 * reason, that it is off, so nobody turns up for it; the decision itself is sent only when someone chooses to send it.
 * One never offered to them is simply stopped.
 */
export function declineConfirmText(policy: DeclineMessagePolicy, input: { hasEmail: boolean; eligibility?: boolean; interviews?: readonly InterviewRef[] }): string {
  const known = (input.interviews ?? []).filter(candidateKnowsOf);
  const unknown = (input.interviews ?? []).filter((iv) => !candidateKnowsOf(iv));
  // With an interview to call off something does go now (the short note), so the private sentence is about the decision.
  const sendable = policy !== "not_sent" && input.hasEmail;
  const privacy = !known.length ? "nothing is sent to the candidate now" : sendable ? "the decision itself is only sent to the candidate when you choose to send it" : "the decision itself is not sent to the candidate";
  const parts = [`Not moving forward is your decision, recorded with your reason. It is private: ${privacy}.`];
  if (known.length) parts.push(`This cancels ${listWords(known.map(interviewWords))}, and the candidate is told now, in a short note that gives no reason, that ${known.length === 1 ? "it is" : "they are"} off.`);
  if (unknown.length) parts.push(`It also stops ${listWords(unknown.map(interviewWords))}; no times had gone to the candidate.`);
  if (policy === "not_sent") parts.push("Under your settings no decision messages are sent, so tell them yourself and record it on their page.");
  else if (!input.hasEmail) parts.push("There is no email address on file, so tell them yourself and record it on their page.");
  else {
    const message = input.eligibility ? "a short, courteous email saying the role needs something their answers did not show, and that they can reply if that has changed" : "a short, courteous email";
    parts.push(policy === "needs_approval" ? `When you send the decision message (${message}), it waits for approval before it goes out.` : `When you are ready, send the decision message from their page: ${message}.`);
  }
  return parts.join(" ");
}

/** "the Phone screen on Tuesday, October 14, 2:00 PM": an interview the decision would call off, named. */
export function interviewWords(iv: InterviewRef): string {
  if (iv.startsAt) {
    const when = new Date(iv.startsAt).toLocaleString("en-US", { timeZone: iv.timezone ?? undefined, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `the ${iv.title} on ${when}`;
  }
  return candidateKnowsOf(iv) ? `the ${iv.title} (times offered, none chosen yet)` : `the ${iv.title} (times not offered yet)`;
}

/** The toast after "Cancel interview" on the Interviews page: exactly who was told (POST /interviews/:id/cancel). */
export function interviewCancelToast(r: { candidateTold?: boolean; interviewersTold?: boolean }): ToastParts {
  return { title: "Interview cancelled.", detail: `${r.candidateTold ? "The candidate was sent a cancellation." : "The candidate had no time booked or offered, so nothing was sent to them."}${r.interviewersTold ? " The interviewers were told." : ""}` };
}

/**
 * The toast after closing a role (POST /roles/:id/outcome): who moved, privately, and the interviews it called off. A
 * candidate who had a booked time or times to pick from was sent a short note at once saying only that the interview is
 * off (`interviewOffNotes`); the decision stays private until someone sends the decision message.
 */
export function closeRoleToast(r: { movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number }, title = "Role closed as filled."): ToastParts {
  const moved = Math.max(0, (r.movedToTalentPool ?? 0) - (r.heldEmailsAddedToTalentPool ?? 0));
  const who = moved ? `${moved === 1 ? "The one person" : `The ${moved} people`} still in the process moved to your talent pool, privately: nobody is told the decision until someone sends them the decision message.` : "Nobody else was still in the process.";
  return { title, detail: `${who}${closedInterviewsText(r.interviewsCancelled ?? 0, r.interviewOffNotes ?? 0)}` };
}

/** The interviews a role close called off, and who was told they are off (a short note, no reason). */
function closedInterviewsText(ivs: number, toldOff: number): string {
  if (!ivs) return "";
  const told = Math.min(toldOff, ivs);
  const head = `${ivs === 1 ? "1 interview was" : `${ivs} interviews were`} cancelled`;
  if (told === ivs) return ` ${head}; ${ivs === 1 ? "the candidate was sent a short note now saying only that it is off" : "each candidate was sent a short note now saying only that their interview is off"}.`;
  if (told) return ` ${head}; ${told === 1 ? "the candidate who had a time booked or offered was" : `the ${told} candidates who had a time booked or offered were`} sent a short note now saying only that their interview is off.`;
  return ` ${head}; no times had gone to ${ivs === 1 ? "the candidate" : "the candidates"}, so nothing was sent about ${ivs === 1 ? "it" : "them"}.`;
}

function listWords(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
}

/** A panel step a stage choice opens; Longlist and Shortlist need none. */
export type PanelStep = "hold" | "interview" | "decline" | "hire" | "outcome";

/** How a choice on the stage button is carried out on the page: at once (a private mark), by opening a step, or not at all. */
export type StageIntent = { kind: "none" } | { kind: "action"; body: { action: "set_mark"; mark: MarkKind } | { action: "clear_mark" } } | { kind: "step"; step: PanelStep };

/**
 * The stage button's choice turned into what the page does (plan adjustments §2): Longlist and Shortlist set the mark in
 * one click; the step under a mark takes it off; On hold asks for the date it ends; Interviewing opens the interview
 * approval; Offer and Hired open the outcome step; Not moving forward opens the private decline.
 */
export function stageIntent(move: StageMove): StageIntent {
  if (!move.allowed || move.current) return { kind: "none" };
  switch (move.via) {
    case "set_mark":
      if (!move.mark) return { kind: "none" };
      return move.mark === "on_hold" ? { kind: "step", step: "hold" } : { kind: "action", body: { action: "set_mark", mark: move.mark } };
    case "clear_mark":
      return { kind: "action", body: { action: "clear_mark" } };
    case "interview":
      return { kind: "step", step: "interview" };
    case "offer":
      return { kind: "step", step: "outcome" };
    case "record_hire":
      return { kind: "step", step: "hire" };
    case "decline":
      return { kind: "step", step: "decline" };
    default:
      return { kind: "none" };
  }
}

/** The stage button's greyed choices with their reasons, from the API's moves. */
export function stageBlocked(moves: StageMove[]): Partial<Record<OwnerStage, string>> {
  const out: Partial<Record<OwnerStage, string>> = {};
  for (const m of moves) if (!m.allowed && !m.current) out[m.to] = m.blockedReason ?? "Not available at this step.";
  return out;
}
