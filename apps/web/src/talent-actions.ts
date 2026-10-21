import { OWNER_STAGE_LABEL, titleMidSentence, type MarkKind, type OwnerStage } from "@ros/contracts";
import type { ActionResult, CandidateNotice, DecisionMessagesResponse, DeclineMessagePolicy, SendNewTimesBatchResult, SendNewTimesResult, StageMove } from "./api/client";
import { safetyNetDate, safetyNetShort } from "./telling";

/**
 * What the Candidates page and the candidate panel say after a choice, word for word from what the API reports (plan
 * 0.5; founder decision B6: decisions are private, so the words say exactly whether the candidate was told). Each toast
 * has a first line saying what happened and, when there is more, a second line saying what did or did not follow. A
 * decision's second line also says, in one short sentence, when the standard message goes by itself if nobody tells
 * them first (founder decision D-03 A).
 */
export type ToastParts = { title: string; detail?: string };

/** The second line of every private choice: a decision, a mark, a hold. */
export const NOT_TOLD = "Private: the candidate was not told.";
/** How a private decision's second line starts; the safety net follows it (see `decisionDetail`). */
export const PRIVATE_DECISION = "Private: the candidate was not told.";

/** What a decision's answer says about the decision message: the company's setting and whether there is an address. */
type DecisionMessageHint = { decisionMessage?: { policy: DeclineMessagePolicy; to: string | null } | null };

/**
 * The safety net said after a decision is filed now (founder decision D-03 A): the day the standard message goes by
 * itself, counted from `now` as the daily check counts it, in the way the company's settings run it when the answer says.
 */
export function safetyNetAfterDecision(r: DecisionMessageHint, now: Date = new Date(), what?: string): string {
  const m = r.decisionMessage ?? null;
  return safetyNetShort({ policy: m?.policy ?? null, hasEmail: m ? !!m.to : null, on: safetyNetDate(now.toISOString()), what });
}
/** A message saved in the outbox of a company ITS has not confirmed yet (founder decision B7): it is not on its way yet. */
export const HELD_FOR_CHECK = "The message is saved and goes to the candidate as soon as ITS confirms your company; they have not been told yet.";

/** What became of the candidate's message, in one sentence. */
export function noticeText(notice: CandidateNotice): string {
  switch (notice) {
    case "not_told":
      return NOT_TOLD;
    case "queued":
      return "A short, courteous message to the candidate is on its way.";
    case "held":
      return HELD_FOR_CHECK;
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

/**
 * A decision's second line: the private sentence while nothing went (always, since B6), the interviews it called off,
 * and the day the standard message goes by itself if nobody tells them first; else what became of the message.
 */
function decisionDetail(r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes"> & DecisionMessageHint, now: Date): string {
  if (!r.candidateNotice || r.candidateNotice === "not_told") return r.dispositionSent ? noticeText("queued") : `${PRIVATE_DECISION}${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)} ${safetyNetAfterDecision(r, now)}`;
  return noticeText(r.candidateNotice);
}

/** "October 22": the day a hold ends. */
export function holdDay(remindAt: string): string {
  return new Date(remindAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** The toast after a choice on the candidate panel or a row (POST /applications/:id/actions). */
export function actionToast(action: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "next" | "talentPoolOptOut" | "mark" | "ownerStage" | "interviewsCancelled" | "interviewOffNotes"> & DecisionMessageHint, now: Date = new Date()): ToastParts {
  switch (action) {
    case "reject":
      return { title: "Moved to Not moving forward.", detail: decisionDetail(r, now) };
    case "hold":
    case "set_mark":
      if (r.mark?.mark === "on_hold") return { title: r.mark.remindAt ? `On hold until ${holdDay(r.mark.remindAt)}.` : "On hold.", detail: `They come back to your Home page then. ${NOT_TOLD}` };
      return { title: `Moved to ${r.mark?.label ?? "the new stage"}.`, detail: NOT_TOLD };
    case "clear_mark":
      return { title: r.ownerStage ? `Moved to ${OWNER_STAGE_LABEL[r.ownerStage]}.` : "Mark taken off.", detail: NOT_TOLD };
    case "advance_to_interview":
      return { title: "Marked for interview.", detail: "The candidate was not told; choose Interviewing to offer them times." };
    case "move_to_talent_pool":
      // The person's own "don't keep me for future roles" stands (Wave 0 item 0.11); the page says so instead of "added".
      return r.talentPoolOptOut
        ? { title: "Moved out of this role.", detail: `They asked not to be kept for future roles, so they are not in your talent pool and nobody will contact them about other openings. The candidate was not told.${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)} ${safetyNetAfterDecision(r, now)}` }
        : { title: "Added to your talent pool.", detail: `The candidate was not told.${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)} ${safetyNetAfterDecision(r, now)}` };
    case "invite_screen":
      return { title: r.next ?? "A new AI interview link is on its way." };
    case "ask_in_screen":
      return { title: r.next ?? "Invitation on its way. The AI interview starts with these questions." };
    case "remind_screen":
      // "Send a reminder" (R20-7): the API's sentence says until when the link stays open, and whether it waits for the ITS check.
      return r.candidateNotice === "held" ? { title: "Reminder saved.", detail: r.next?.replace(/^Reminder saved:\s*/, "") ?? noticeText("held") } : { title: "Reminder on its way.", detail: r.next?.replace(/^Reminder on its way\.\s*/, "") || undefined };
    case "override_eligibility":
      return { title: "Kept in.", detail: "Your reason is recorded." };
    case "review_anyway":
      return { title: "Reopened.", detail: "The application is being looked at again." };
    case "send_decision":
      return sendDecisionToast(r.candidateNotice ?? "not_sent");
    case "told_in_person":
      return { title: "Recorded that you told them yourself.", detail: "Nothing more will be sent." };
    case "cancel_screen":
      return { title: "AI interview invitation stopped.", detail: r.next ?? (r.candidateNotice ? noticeText(r.candidateNotice) : "Their link no longer works.") };
    case "undo_decision":
      // Back under Cancelled (founder decisions 1A-4A): the API's sentence says whether their new times still go on the
      // day they were promised, so "nothing will be sent" is never said about a set that will.
      if (r.ownerStage === "cancelled") return { title: "Decision taken back: back in Cancelled.", detail: r.next?.replace(/^Decision taken back: they are back under Cancelled\.\s*/, "") || "They were never told." };
      return { title: r.ownerStage ? `Decision taken back: back in ${OWNER_STAGE_LABEL[r.ownerStage]}.` : "Decision taken back.", detail: "They were never told, and nothing will be sent." };
    default:
      return { title: "Saved." };
  }
}

/** The toast after "How did the interview go?" (POST /applications/:id/decision). */
export function decisionToast(decision: "next_round" | "finalist" | "not_moving_forward", r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes"> & DecisionMessageHint & { nextRoundKey?: string | null }, now: Date = new Date()): ToastParts {
  if (decision === "finalist") return { title: "Marked as a finalist.", detail: "The candidate was not told." };
  if (decision === "next_round") return { title: r.nextRoundKey ? "Next round." : "Next round recorded.", detail: r.nextRoundKey ? "Check the interviewers below and approve; times go out from there." : undefined };
  return { title: "Recorded: not moving forward.", detail: decisionDetail(r, now) };
}

/** The toast after "Record what happened" (POST /applications/:id/outcome); the team's own decisions are private. */
export function outcomeToast(outcome: string, r: Pick<ActionResult, "candidateNotice" | "dispositionSent" | "interviewsCancelled" | "interviewOffNotes"> & DecisionMessageHint, now: Date = new Date()): ToastParts {
  if (outcome === "hired_externally") return { title: "Hire recorded with your name." };
  if (outcome === "employer_declined" || outcome === "no_hire") return { title: "Outcome recorded with your name.", detail: decisionDetail(r, now) };
  return { title: "Outcome recorded with your name." };
}

/** The toast after "Send" on a decision message (one person). */
export function sendDecisionToast(notice: CandidateNotice): ToastParts {
  switch (notice) {
    case "queued":
      return { title: "Decision message sent.", detail: "A short, courteous message is on its way to the candidate." };
    case "held":
      return { title: "Saved.", detail: HELD_FOR_CHECK };
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
  return { results: parts.flatMap((p) => p.results), queued: parts.reduce((n, p) => n + p.queued, 0), held: parts.reduce((n, p) => n + (p.held ?? 0), 0), waitingApproval: parts.reduce((n, p) => n + p.waitingApproval, 0), notSent: parts.reduce((n, p) => n + p.notSent, 0) };
}

/** The toast after sending the decision message to several people at once: every outcome counted, nothing hidden. */
export function bulkSendToast(r: Pick<DecisionMessagesResponse, "queued" | "held" | "waitingApproval" | "notSent">): ToastParts {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const held = r.held ?? 0;
  const title = r.queued ? `${plural(r.queued, "decision message", "decision messages")} on ${r.queued === 1 ? "its" : "their"} way.`
    : held ? `${plural(held, "decision message", "decision messages")} saved.` : "No decision messages were sent.";
  const rest = [r.queued && held ? `${held} saved` : "", held ? "saved messages go out as soon as ITS confirms your company" : "", r.waitingApproval ? `${r.waitingApproval} waiting for approval` : "", r.notSent ? `${r.notSent} not sent; the list says why` : ""].filter(Boolean);
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
  if (/invite to (a screen|an AI interview)/i.test(action.label)) return { title: "Invitation on its way.", detail: "The AI interview link goes to the candidate by email, or by text when they agreed to texts." };
  if (/^Yes, interview/i.test(action.label)) {
    // The answer carries the interview approval filled in (plan H4): the page opens it on the candidate's panel.
    const filled = !!(response as { interviewDraft?: unknown } | null)?.interviewDraft;
    return { title: "Moved to Interviewing.", detail: filled ? "Check the interview filled in from your plan and approve it; times go out to the candidate from there." : "Open the candidate to choose the round and the interviewers; times go out from there." };
  }
  if (action.label === "Yes, send it") {
    // a message a team member wrote, approved: on its way, or saved until ITS confirms the company (founder decision B7)
    if ((response as { messageStatus?: string } | null)?.messageStatus === "held") return { title: "Approved and saved.", detail: "It goes out under the writer's name as soon as ITS confirms your company." };
    return { title: "Sent.", detail: "It is on its way." };
  }
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

/**
 * The short lines a decline step shows before the click (founder decisions B6 and D-03 A): private now, any interview it
 * calls off, and the day the standard message goes by itself if nobody tells them first (or the day an ITS recruiter is
 * brought in, under the company's settings). The whole of `declineConfirmText` sits one click away under it.
 */
export function declineSummary(policy: DeclineMessagePolicy, input: { hasEmail: boolean; interviews?: readonly InterviewRef[]; now?: Date }): string[] {
  const known = (input.interviews ?? []).filter(candidateKnowsOf);
  const lead = !known.length ? "Private: nothing is sent to them now."
    : `Private: the decision is not sent now. ${known.length === 1 ? "Their interview is" : `Their ${known.length} interviews are`} called off, and they get a short note saying so.`;
  const on = safetyNetDate((input.now ?? new Date()).toISOString());
  return [lead, safetyNetShort({ policy, hasEmail: input.hasEmail, on })];
}

/**
 * What "Record what happened" says the candidate gets: nothing about the outcome, but an interview they know of (a booked
 * time, or times to pick from) is called off by any outcome but a hire, and they are told now, in a short note with no
 * reason, that it is off.
 */
export function outcomeNoticeText(interviews: readonly InterviewRef[]): string {
  const known = interviews.filter(candidateKnowsOf);
  if (!known.length) return "Nothing is sent to the candidate.";
  return `Nothing about the outcome is sent to the candidate. Unless it is a hire, ${listWords(known.map(interviewWords))} ${known.length === 1 ? "is" : "are"} called off, and they are told now, in a short note that gives no reason, that ${known.length === 1 ? "it is" : "they are"} off.`;
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
 * The toast after "Send new times" for someone under Cancelled (founder decision 2A): for one person (POST
 * /applications/:id/new-times; `round` is the interview's title, said in lower case mid-sentence), stopping their automatic set (…/new-times/stop), or
 * several people at once (POST /roles/:id/new-times). Times count as sent only once their email is on its way, so the
 * words say they are being got ready, and that the person stays under Cancelled until they book.
 */
export type NewTimesOutcome =
  | ({ kind: "sent"; firstName: string; round: string } & Pick<SendNewTimesResult, "via">)
  | { kind: "stopped" }
  | ({ kind: "batch" } & Pick<SendNewTimesBatchResult, "results" | "sent" | "notSent">);
export function newTimesToast(r: NewTimesOutcome): ToastParts {
  if (r.kind === "stopped") return { title: "Stopped.", detail: "Nothing goes to them automatically; they stay under Cancelled." };
  if (r.kind === "sent") {
    return r.via === "new_interview"
      ? { title: `A new ${titleMidSentence(r.round)} was set up.`, detail: `Same round; ${r.firstName} gets an email as soon as there are times to offer.` }
      : { title: "Getting new times ready.", detail: `${r.firstName} gets an email as soon as there are times to offer from the interviewers' calendars. They stay under Cancelled until they book.` };
  }
  const title = r.sent ? `Getting new times ready for ${r.sent} ${r.sent === 1 ? "person" : "people"}.` : "No new times were sent.";
  const refused = r.results.filter((x) => !x.ok).map((x) => `${x.name} (${(x.message ?? "not sent").replace(/\.$/, "")})`);
  return r.notSent > 0 && refused.length ? { title, detail: `Not sent: ${refused.join("; ")}.` } : { title };
}

/** Who may tell candidates a decision (application.reject), for someone who may not: HR closes roles but does not tell. */
export const CLOSING_SENDERS = "An owner, admin, hiring manager or recruiter";

/**
 * The toast after closing a role (POST /roles/:id/outcome): who moved, privately, and the interviews it called off. A
 * candidate who had a booked time or times to pick from was sent a short note at once saying only that the interview is
 * off (`interviewOffNotes`); the decision stays private until someone sends the one closing message (Q30), or the
 * safety net acts after five working days (Q27), on the day named (D-03 A). `closingMessage.policy`, when the answer
 * carries it, says which way the safety net goes. `mayTell` is false for someone who may close a role but not tell
 * candidates a decision (HR): they are told who sends the message instead of being asked to send it.
 */
export function closeRoleToast(r: { movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number; closingMessage?: { policy: DeclineMessagePolicy } | null }, title = "Role closed as filled.", mayTell = true, now: Date = new Date()): ToastParts {
  const moved = Math.max(0, (r.movedToTalentPool ?? 0) - (r.heldEmailsAddedToTalentPool ?? 0));
  const policy = r.closingMessage?.policy ?? null;
  const net = safetyNetShort({ policy, on: safetyNetDate(now.toISOString()), what: "the closing message" });
  const tell = !mayTell ? `${CLOSING_SENDERS} sends them the closing message; it waits on their Home page. ${net}`
    : policy === "not_sent" ? `Under your settings no message is sent: tell each of them yourself, then record it on their page. ${net}`
    : `Send the closing message when you are ready. ${net}`;
  const who = moved ? `${moved === 1 ? "The one person" : `The ${moved} people`} still in the process moved to your talent pool, privately: nobody is told yet. ${tell}` : "Nobody else was still in the process.";
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

/** A panel step a stage choice opens; Longlist and Shortlist need none. `offer` is the record-only "Offer made" (plan H2). */
export type PanelStep = "hold" | "interview" | "decline" | "hire" | "outcome" | "offer";
const PANEL_STEPS: readonly PanelStep[] = ["hold", "interview", "decline", "hire", "outcome", "offer"];

/** `?step=` on a link to the panel (Today's "Yes, interview" opens the interview approval, plan H4); anything else opens none. */
export function panelStepFrom(value: string | null | undefined): PanelStep | null {
  return value && (PANEL_STEPS as readonly string[]).includes(value) ? (value as PanelStep) : null;
}

/** How a choice on the stage button is carried out on the page: at once (a private mark), by opening a step, or not at all. */
export type StageIntent = { kind: "none" } | { kind: "action"; body: { action: "set_mark"; mark: MarkKind } | { action: "clear_mark" } | { action: "undo_decision" } } | { kind: "step"; step: PanelStep };

/**
 * The stage button's choice turned into what the page does (plan adjustments §2): Longlist and Shortlist set the mark in
 * one click; the step under a mark takes it off; On hold asks for the date it ends; Interviewing opens the interview
 * approval; Offer opens the record-only "Offer made" (plan H2); Hired opens the hire sheet (H1); Not moving forward opens
 * the private decline. For a decision nobody told, the step it was made from takes it back (plan G1).
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
      return { kind: "step", step: "offer" };
    case "record_hire":
      return { kind: "step", step: "hire" };
    case "decline":
      return { kind: "step", step: "decline" };
    case "undo_decision":
      return { kind: "action", body: { action: "undo_decision" } };
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
