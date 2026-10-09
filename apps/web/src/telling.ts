import { DECISION_WORDING_LABEL, PERSONAL_LINE_MAX, type DecisionWording } from "@ros/contracts";
import type { ApplicationDetail, ClosingMessagePreview, ClosingMessageResult, DeclineMessagePolicy, DecisionMessageResult, DecisionWordingOption, TimelineEvent, ToldState } from "./api/client";
import type { ToastParts } from "./talent-actions";

/**
 * Telling candidates (plan Wave G; founder decisions B6, Q27, Q28, Q30), the pure parts the candidate panel, the Talent
 * page and the role page share, kept free of React so they can be tested (tests/web/telling.test.ts): the approved
 * wordings and the personal line on the Send screen, the Undo window after Send, the safety net on the "not told yet"
 * card, the one closing message of a closed role, and the conversation thread on the Messages tab.
 */

export { PERSONAL_LINE_MAX };

/* ------------------------------------------------------------------------------------------------------------ */
/* The Send screen: approved wordings and a personal line (Q28)                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** One line under each approved wording on the Send screen, in our own words; the exact message shows below the choice. */
export const WORDING_HINT: Record<DecisionWording, string> = {
  v1: "The standard wording.",
  v2: "A warmer version of the standard wording.",
  v3: "A shorter version, a few sentences.",
  after_interview: "For someone who met your team: thanks them for their time.",
  position_filled: "Says the job went to someone else.",
  role_closed: "For a role that has closed.",
  eligibility: "After a decline on an eligibility answer: says how to correct an answer given in error. Always used for these.",
};

/** The wordings as the Send screen lists them: each with its hint, the suggested one first and marked. */
export function wordingChoices(options: readonly DecisionWordingOption[]): Array<DecisionWordingOption & { hint: string; text: string }> {
  return [...options]
    .sort((x, y) => Number(y.suggested) - Number(x.suggested))
    .map((o) => ({ ...o, hint: WORDING_HINT[o.id], text: o.suggested ? `${o.label} (suggested)` : o.label }));
}

/** Said under the personal line box. */
export const PERSONAL_LINE_HINT = `Optional: one or two sentences in your own words, ${PERSONAL_LINE_MAX} characters at most. It is checked before anything is sent: no scores, no reasons for the decision, nothing about age, family, health, religion or background.`;

/** What the Send button says and does under the company's settings. */
export function sendButtonLabel(policy: DeclineMessagePolicy): string {
  return policy === "needs_approval" ? "Send for approval" : "Send";
}

/** The line above the message: who it goes to and what Send does, with the Undo window when it goes. */
export function sendPolicyLine(input: { to: string | null; policy: DeclineMessagePolicy; undoSeconds: number }): string {
  const to = input.to ? `To ${input.to}.` : "There is no email address on file, so it cannot be sent: tell them another way and record it.";
  if (!input.to) return to;
  if (input.policy === "not_sent") return `${to} Under your settings no decision messages are sent. Tell them yourself, then record it here.`;
  if (input.policy === "needs_approval") return `${to} Under your settings it waits for approval before it goes out.`;
  return input.undoSeconds > 0 ? `${to} It goes when you press Send, after ${input.undoSeconds} seconds in which you can still undo it.` : `${to} It goes as soon as you press Send.`;
}

/** The label of a wording the message used, for the toast and the history. */
export function wordingLabel(w: DecisionWording | null | undefined): string | null {
  return w ? DECISION_WORDING_LABEL[w] : null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Undo (plan G9)                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** How long Undo still works, in milliseconds (0 once the window has passed or when there is none). */
export function undoMillisLeft(undoUntil: string | null | undefined, now: Date = new Date()): number {
  if (!undoUntil) return 0;
  const at = Date.parse(undoUntil);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now.getTime());
}

/** The toast after Send while the message waits out its Undo window. */
export function sentWithUndoToast(input: { firstName: string; seconds: number; wording?: DecisionWording | null; kind?: "decision" | "message" }): ToastParts {
  const what = input.kind === "message" ? `Message to ${input.firstName} sent.` : "Decision message sent.";
  const which = input.kind !== "message" && input.wording ? ` (${DECISION_WORDING_LABEL[input.wording]})` : "";
  return { title: `${what.replace(/\.$/, "")}${which}.`, detail: `It leaves in ${input.seconds} seconds. Press Undo to take it back.` };
}

/** The toast after Undo: what became of the message, and of the candidate's told state. */
export function undoneToast(input: { firstName: string; kind: "decision" | "message"; toldState?: ToldState | null }): ToastParts {
  if (input.kind === "message") return { title: "Taken back.", detail: `Your message to ${input.firstName} was not sent.` };
  return { title: "Taken back.", detail: input.toldState === "not_told" || !input.toldState ? `The decision message was not sent; ${input.firstName} has not been told.` : "The decision message was not sent." };
}

/** The toast when Undo came too late or did not work. */
export function undoFailedToast(code: string | null | undefined, message?: string): ToastParts {
  if (code === "already_sent") return { title: "Too late to undo.", detail: "The message has already gone." };
  return { title: "Could not undo.", detail: message ?? "Try again, or write to the candidate to correct it." };
}

/** One person's result from a bulk Send or the closing message, as far as Undo needs it. */
type UndoableResult = Pick<DecisionMessageResult, "applicationId" | "ok" | "communicationId" | "undoUntil">;

/** The messages of a bulk Send, or of the closing message, that can still be taken back (plan G9). */
export function undoable(results: readonly UndoableResult[], now: Date = new Date()): Array<{ applicationId: string; communicationId: string }> {
  return results.filter((r) => r.ok && r.communicationId && undoMillisLeft(r.undoUntil, now) > 0).map((r) => ({ applicationId: r.applicationId, communicationId: r.communicationId! }));
}

/** How long the bulk toast's "Undo all" lasts: until the first of the messages leaves. */
export function bulkUndoMillis(results: readonly UndoableResult[], now: Date = new Date()): number {
  const left = results.filter((r) => r.ok && r.communicationId).map((r) => undoMillisLeft(r.undoUntil, now)).filter((ms) => ms > 0);
  return left.length ? Math.min(...left) : 0;
}

/** The toast after "Undo all". */
export function bulkUndoneToast(taken: number, late: number): ToastParts {
  const title = taken ? `${taken === 1 ? "1 message" : `${taken} messages`} taken back.` : "Nothing was taken back.";
  const rest = [taken ? "Those people have not been told." : "", late ? `${late === 1 ? "1 message had" : `${late} messages had`} already gone.` : ""].filter(Boolean).join(" ");
  return rest ? { title, detail: rest } : { title };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The safety net on the "not told yet" card (Q27)                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** Working days after a decision before the safety net acts (packages/agents UNTOLD_SEND_WORKING_DAYS). */
export const SAFETY_NET_WORKING_DAYS = 5;
const DAY = 86_400_000;

/**
 * The day the safety net acts: five working days (Monday to Friday) after the moment of the decision, counted the way the
 * daily check counts them. The check runs in the company's time zone and skips the holidays on the ITS calendar, which
 * can move it by a day; a day the API names (`fallbackOn`) wins.
 */
export function safetyNetDate(decidedAt: string, days = SAFETY_NET_WORKING_DAYS): Date | null {
  const from = Date.parse(decidedAt);
  if (Number.isNaN(from)) return null;
  let t = from;
  let n = 0;
  for (let i = 0; i < 60 && n < days; i++) {
    t += DAY;
    const weekday = new Date(t).getDay();
    if (weekday >= 1 && weekday <= 5) n += 1;
  }
  return new Date(t);
}

/** "Tuesday, October 14". */
export function dayWords(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** What the safety net already did about this decision, from the history (`application.untold_fallback`). */
export function safetyNetActed(timeline: readonly TimelineEvent[]): { action: "sent" | "recruiter"; at: string } | null {
  const e = [...timeline].filter((x) => x.type === "application.untold_fallback").sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))[0];
  if (!e) return null;
  return { action: e.payload.action === "sent" ? "sent" : "recruiter", at: e.occurredAt };
}

/**
 * The safety net, in one sentence on the "not told yet" card (Q27): on which day the standard message goes by itself
 * unless someone sends it or records telling them; or, when the settings ask for approval, keep messages with a person,
 * or there is no address, that a recruiter is brought in that day and nothing is sent. Null when nothing waits on it (told
 * already, or a message waits for an approver).
 */
export function safetyNetLine(input: {
  a: Pick<ApplicationDetail, "stage" | "toldState" | "stageChangedAt" | "timeline" | "candidate" | "declineMessage"> & { rejectedAt?: string | null; untoldFallbackOn?: string | null };
  waitingApproval: boolean;
  now?: Date;
}): string | null {
  const { a } = input;
  if (!["rejected", "talent_pool"].includes(a.stage) || a.toldState !== "not_told" || input.waitingApproval) return null;
  const first = a.candidate.firstName || "They";
  const acted = safetyNetActed(a.timeline);
  if (acted?.action === "recruiter") return `Safety net: an ITS recruiter was brought in on ${dayWords(new Date(acted.at))} to make sure ${first} is told. You can still send the message or record telling them.`;
  const decided = a.rejectedAt ?? a.stageChangedAt;
  const on = a.untoldFallbackOn ? new Date(`${a.untoldFallbackOn.slice(0, 10)}T12:00:00`) : safetyNetDate(decided);
  if (!on || Number.isNaN(on.getTime())) return null;
  const sends = a.declineMessage === "sends" && !!a.candidate.email;
  const now = input.now ?? new Date();
  if (on.getTime() <= now.getTime()) {
    return sends
      ? `Safety net: ${SAFETY_NET_WORKING_DAYS} working days have passed, so the standard message goes to ${first} with the next daily check, unless you send a message or mark it told now.`
      : `Safety net: ${SAFETY_NET_WORKING_DAYS} working days have passed, so an ITS recruiter is brought in with the next daily check to make sure ${first} is told. Nothing is sent by itself.`;
  }
  return sends
    ? `Safety net: the standard message goes to ${first} by itself on ${dayWords(on)}, unless you send a message or mark it told before then.`
    : `Safety net: if ${first} has not been told by ${dayWords(on)}, an ITS recruiter is brought in to make sure they are. Nothing is sent by itself.`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The closing message of a closed role (Q30)                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the closing message's sheet says above the message: who gets it, who is left out and why, and what Send does. */
export function closingSheetLines(p: Pick<ClosingMessagePreview, "count" | "alreadyTold" | "waitingApproval" | "noEmail" | "optedOut" | "policy" | "waitingApprovalId">): { lead: string; notes: string[] } {
  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);
  const lead = p.waitingApprovalId
    ? "The closing message is waiting for approval. Nobody is told until it is approved."
    : p.count
      ? `${people(p.count)} ${p.count === 1 ? "was" : "were"} still in process when the role closed. One courteous message tells all of them; each gets it on their own, with their own name. They stay in your talent pool unless they asked not to be kept.`
      : "Everyone the role left in your talent pool has been told already.";
  const notes = [
    p.alreadyTold ? `${people(p.alreadyTold)} already told ${p.alreadyTold === 1 ? "is" : "are"} left out.` : "",
    p.waitingApproval ? `${people(p.waitingApproval)} whose own message waits for approval ${p.waitingApproval === 1 ? "is" : "are"} left out.` : "",
    p.noEmail ? `${people(p.noEmail)} ${p.noEmail === 1 ? "has" : "have"} no email address on file, so tell ${p.noEmail === 1 ? "them" : "those people"} another way and record it on their page.` : "",
    p.optedOut ? `${people(p.optedOut)} asked not to be kept for future roles; the message does not invite them back.` : "",
    p.policy === "needs_approval" && !p.waitingApprovalId ? "Under your settings it waits for one approval for everyone before it goes." : "",
    p.policy === "not_sent" ? "Under your settings no decision messages are sent. Tell each person yourself, then record it on their page." : "",
  ].filter(Boolean);
  return { lead, notes };
}

/** The closing sheet's one button. */
export function closingSendLabel(p: Pick<ClosingMessagePreview, "count" | "policy">): string {
  const people = p.count === 1 ? "1 person" : `${p.count} people`;
  return p.policy === "needs_approval" ? `Send to ${people} for approval` : `Send to ${people}`;
}

/** The toast after the closing message's Send: per-person results counted, nothing hidden. */
export function closingResultToast(r: Pick<ClosingMessageResult, "status" | "queued" | "held" | "notSent">): ToastParts {
  if (r.status === "waiting_approval") return { title: "Waiting for approval.", detail: "One approval covers everyone. Nobody is told until it is approved." };
  if (r.status === "not_sent_settings") return { title: "Not sent.", detail: "Under your settings no decision messages are sent; tell each person yourself and record it." };
  if (r.status === "role_reopened") return { title: "Not sent.", detail: "The role was reopened, so the closing message was not sent. Nobody was told anything." };
  const plural = (n: number) => (n === 1 ? "1 closing message" : `${n} closing messages`);
  const title = r.queued ? `${plural(r.queued)} on ${r.queued === 1 ? "its" : "their"} way.` : r.held ? `${plural(r.held)} saved.` : "No closing messages were sent.";
  const rest = [r.queued && r.held ? `${r.held} saved` : "", r.held ? "saved messages go out as soon as ITS confirms your company" : "", r.notSent ? `${r.notSent} not sent` : ""].filter(Boolean);
  return rest.length ? { title, detail: `${rest.join("; ")}.` } : { title };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The conversation thread on the Messages tab (plan G7)                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

type Comm = ApplicationDetail["communications"][number];

/** Who wrote a message, from the team's side or the candidate's. */
export type ThreadFrom = "team" | "assistant" | "system" | "recruiter" | "candidate";

export type ThreadItem = { id: string; from: ThreadFrom; who: string; at: string; channel: "email" | "sms"; subject: string | null; label: string; text: string; long: boolean; status: string | null; statusTone: "neutral" | "caution" | "critical" };

/** A message's kind when it has no subject of its own, in the team's words. */
const TEMPLATE_LABEL: Record<string, string> = {
  still_reviewing: "Still reviewing note",
  human_requested_reply: "When a person will follow up",
  interview_off: "The interview is off",
  application_received: "Application received",
  talent_pool_opt_out: "Not kept for future roles",
};

function templateLabel(key: string | null): string {
  if (!key) return "A message";
  if (key.startsWith("disposition:")) return "Decision message";
  if (key.startsWith("freeform")) return "A message from your team";
  return TEMPLATE_LABEL[key] ?? key.replace(/[:_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The candidate's own words in a reply, without the earlier messages their email program quoted under it ("On … wrote:",
 * lines starting with ">", "-----Original Message-----", an Outlook "From: … Sent: …" block). The whole reply when nothing
 * would be left. The same rule as the candidate's status page.
 */
export function replyOwnWords(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const outlook = (i: number) => /^From:\s/.test(lines[i].trim()) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s/.test(l.trim()));
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const l = lines[i].trim();
    if (/^>/.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || outlook(i)) cut = i;
    else if (/\bwrote:$/.test(l)) cut = /^On\b/.test(l) ? i : i > 0 && /^On\b/.test(lines[i - 1].trim()) ? i - 1 : i;
  }
  const mine = (cut < 0 ? lines : lines.slice(0, cut)).join("\n").trim();
  return mine || text.trim();
}

/** Where a message stands, when it is not simply delivered. */
function statusOf(m: Comm): { status: string | null; tone: ThreadItem["statusTone"] } {
  if (m.direction === "inbound") return { status: null, tone: "neutral" };
  switch (m.status) {
    case "queued":
    case "sending":
      return { status: "Waiting to go out", tone: "neutral" };
    case "held":
      return { status: "Saved until ITS confirms your company", tone: "caution" };
    case "cancelled":
      return { status: "Taken back before it was sent", tone: "neutral" };
    case "failed":
    case "bounced":
    case "unknown":
      return { status: "Could not be delivered", tone: "critical" };
    default:
      return { status: null, tone: "neutral" };
  }
}

/** Who wrote it, in words: a person by name, an ITS recruiter, the assistant, the product by itself, or the candidate. */
function whoWrote(m: Comm, candidateFirstName: string): { from: ThreadFrom; who: string } {
  if (m.direction === "inbound") return { from: "candidate", who: candidateFirstName || "The candidate" };
  const by = m.sentBy;
  switch (by?.kind) {
    case "user":
      return { from: "team", who: by.name?.trim() || "Someone on your team" };
    case "recruiter":
      return { from: "recruiter", who: by.name?.trim() ? `${by.name.trim()} (ITS recruiter)` : "An ITS recruiter" };
    case "agent":
      return { from: "assistant", who: "The assistant" };
    default:
      return { from: "system", who: "Sent automatically" };
  }
}

/** Longer than this, a message from the team opens with its first lines and the rest one click away. */
export const THREAD_LONG = 420;

/**
 * The conversation with the candidate, oldest first (plan G7): what the team sent (by whom), what the assistant and the
 * product sent by themselves, an ITS recruiter's answers, and the candidate's replies by email or text in their own
 * words. A message taken back or not delivered stays in the list, saying so.
 */
export function threadItems(communications: readonly Comm[], candidateFirstName: string): ThreadItem[] {
  return [...communications]
    .filter((m) => m.channel === "email" || m.channel === "sms")
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || x.id.localeCompare(y.id))
    .map((m) => {
      const { from, who } = whoWrote(m, candidateFirstName);
      const text = m.direction === "inbound" ? replyOwnWords(m.bodyText) : m.bodyText.trim();
      const { status, tone } = statusOf(m);
      return { id: m.id, from, who, at: m.createdAt, channel: m.channel === "sms" ? "sms" : "email", subject: m.direction === "inbound" ? null : m.subject, label: m.direction === "inbound" ? "Reply" : templateLabel(m.templateKey), text, long: m.direction === "outbound" && text.length > THREAD_LONG, status, statusTone: tone };
    });
}

/** "Oct 9, 3:04 PM": when a message was written, in the reader's own time. */
export function threadWhen(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
