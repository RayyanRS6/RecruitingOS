import type { AiInterviewView, ApplicationDetail, Screen, ScreeningFunnel, ScreenTranscriptLine, TimelineEvent } from "./api/client";
import { canAddCallNotes } from "./roles";

/**
 * The screening conversation as the team reads it (plan Wave E), kept free of React so it can be tested
 * (tests/web/screen-view.test.ts): whether it came with the application ("Applied, then did the AI interview"), each
 * answer with what the candidate did with it (chose not to answer, changed it before sending, picked it from the
 * choices), a recruiter's call notes kept apart from the candidate's own words, who may add those notes, and the role's
 * figures in plain words.
 */

/** A conversation's state in a word or two. */
export const SCREEN_STATUS_LABEL: Record<string, string> = {
  invited: "Invited",
  reminded: "Reminded",
  in_progress: "Answering",
  completed: "Completed",
  expired: "No response",
  abandoned: "Withdrawn",
  human_requested: "Asked for a person",
  cancelled: "Stopped",
  unfinished: "Didn't finish the conversation",
  declined_by_candidate: "Sent without it",
  paused: "Paused",
};

/** An AI interview that came with the application and is still open (mirrors `isStillApplying` in packages/core/src/apply-flow.ts). */
const STILL_APPLYING = ["invited", "reminded", "in_progress", "paused"];
/** Its words in the AI interview tab's origin line (R20-7: the column "No AI interview yet" holds them). */
export const NOT_SENT_YET = "AI interview not sent yet";

/** The words the panel uses for what a candidate did with a question. */
export const DECLINED_WORDS = "Chose not to answer";
export const EDITED_WORDS = "Changed before sending";
export const TAPPED_WORDS = "Picked from the choices";
/**
 * A finished AI interview that came with the application, in plain words (22 Oct 2026 try-out). It said "Applied and
 * talked in one visit", from the time the chat was offered inside the apply visit; since 20 Oct 2026 every applicant gets
 * the same automatic AI interview, by its own link.
 */
export const APPLIED_IN_ONE_VISIT = "Applied, then did the AI interview";

type EventLike = Pick<TimelineEvent, "type" | "payload"> & { subjectId?: string };

/** A recruiter's notes from a call (plan E3): never the candidate's own words. */
export function isRecruiterNote(t: Pick<ScreenTranscriptLine, "role" | "source">): boolean {
  return t.role === "recruiter" || t.source === "recruiter_call";
}

/** "Notes from a call by Rae. Not the candidate's own words." */
export function recruiterNoteLabel(by: string | null | undefined): string {
  return `Notes from a call${by ? ` by ${by}` : " by a recruiter"}. Not the candidate's own words.`;
}

/** Screens that come with the application: offered in the visit (plan E1), or every applicant's AI interview since 20 Oct 2026. */
const WITH_APPLICATION = ["apply", "with_application"];

/**
 * The conversation came with the application (plan E1; since 20 Oct 2026 every applicant's AI interview). The screen's
 * own `invitedVia` says so when the API sends it; otherwise the invitation's history entry does.
 */
export function offeredWithApplication(s: Pick<Screen, "id" | "invitedVia">, timeline: readonly EventLike[] = []): boolean {
  if (s.invitedVia !== undefined) return WITH_APPLICATION.includes(s.invitedVia ?? "");
  return timeline.some((e) => e.type === "screen.invited" && WITH_APPLICATION.includes(String(e.payload.invitedVia ?? "")) && (e.subjectId === undefined || e.subjectId === s.id));
}

/** The answers came from a second application whose address owner confirmed them by email (repeat submissions, Q14 x Q15). */
function addedAfterConfirming(s: Pick<Screen, "id" | "invitedVia">, timeline: readonly EventLike[]): boolean {
  if (s.invitedVia !== undefined) return s.invitedVia === "confirmed_repeat";
  return timeline.some((e) => e.type === "screen.repeat_confirmed" && e.payload.added === true && e.subjectId === s.id);
}

/**
 * How the conversation reached the candidate, in a few words for the AI interview tab; null for an invitation sent by email
 * (nothing to say). "Applied, then did the AI interview" once a conversation offered with the application is complete.
 */
export function screenOrigin(s: Pick<Screen, "id" | "invitedVia" | "status" | "transcript"> & { progress?: Pick<Screen["progress"], "completedBy"> }, timeline: readonly EventLike[] = []): string | null {
  if (addedAfterConfirming(s, timeline)) return "Added after they confirmed a second application";
  if (!offeredWithApplication(s, timeline)) return null;
  if (s.status === "completed") return s.progress?.completedBy === "recruiter_call" || s.transcript.some(isRecruiterNote) ? "Finished on a call with a recruiter" : APPLIED_IN_ONE_VISIT;
  if (STILL_APPLYING.includes(s.status)) return NOT_SENT_YET;
  if (s.status === "declined_by_candidate") return "Sent the application without the AI interview";
  if (s.status === "human_requested") return "Asked for a person while applying";
  if (s.status === "unfinished") return "Didn't finish while applying";
  return "Offered with the application";
}

/** One sentence for the Overview about the latest conversation, when there is something to say. */
export function overviewScreenLine(a: Pick<ApplicationDetail, "screens" | "timeline"> & { candidate: { firstName: string } }): string | null {
  const s = a.screens[0];
  if (!s) return null;
  const origin = screenOrigin(s, a.timeline);
  if (origin === APPLIED_IN_ONE_VISIT) return `${APPLIED_IN_ONE_VISIT}.`;
  if (origin === NOT_SENT_YET) return `${STILL_APPLYING_LINE}${s.status === "paused" ? " The AI interview is paused while the assistant is not working." : ""} Nothing about ${a.candidate.firstName} waits on you until then.`;
  if (s.status === "declined_by_candidate") return "Sent the application without the AI interview, by their own choice. It is never held against them.";
  if (s.status === "human_requested") return "Asked to talk to a person instead of the assistant. A recruiter contacts them and adds notes from the call. Anything they typed before asking was not sent, so you won't see it.";
  if (s.status === "unfinished") return `${DIDNT_FINISH_LINE} The AI review and match score use their application only.`;
  if (s.status === "cancelled" && s.startedAt && s.answersShared === false) return "The AI interview closed before they sent their answers, so you won't see them. The AI review and match score use their application only.";
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* "No AI interview yet" (20 October 2026, R20-7): the Overview's card                                           */
/* ------------------------------------------------------------------------------------------------------------ */

const longDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });

/** Where they stand with the AI interview, in one neutral sentence: never how far they got. */
export function aiInterviewLine(v: AiInterviewView): string {
  switch (v.state) {
    case "being_read":
      // Q17: the month's AI interviews are used up, however long ago their application was read.
      return v.waitingForMore ? "Waiting for more AI interviews this month: the link goes to them by email once more are added." : "Getting the AI interview ready: their application is being read, and the link goes to them by email by itself.";
    case "invited":
      return `Invited${v.since ? ` on ${longDay(v.since)}` : ""}, not started yet.${v.linkOpenUntil ? ` The link is open until ${longDay(v.linkOpenUntil)}.` : ""}`;
    case "started":
      return "Started, not finished: their answers appear here once they send them.";
    case "asked_person":
      return "Asked for a person instead of the assistant. A recruiter contacts them and adds notes from the call.";
    case "link_expired":
      return `The link expired${v.since ? ` on ${longDay(v.since)}` : ""} without being started.`;
    default:
      return "Didn't finish: they did not send their answers, even after a reminder, so you won't see them.";
  }
}

/**
 * The AI interview tab with no interview yet. Under "No AI interview yet" the link goes to them by itself (R20-4): the
 * line says where it stands (`aiInterviewLine`), never that it waits on the team. Anyone else (held on a must-have answer,
 * sent without it, an invitation the team stopped) has not been invited, and "Invite them from More" is said only when
 * "Send a new AI interview link" is actually offered.
 */
export function noScreenWords(a: Pick<ApplicationDetail, "ownerStage" | "allowedActions"> & { candidate: { firstName: string }; aiInterview?: AiInterviewView | null }): { line: string; why: string } {
  const what = "A short chat with the questions you approved for this job.";
  if (a.ownerStage === "no_ai_interview" && a.aiInterview) return { line: aiInterviewLine(a.aiInterview), why: `${what} Every applicant gets one by email, by itself; nothing waits on you.` };
  return { line: `${a.candidate.firstName} has not been invited to an AI interview yet.`, why: a.allowedActions.includes("invite_screen") ? `${what} Invite them from More at the top.` : what };
}

/** One of the card's buttons: shown, and whether it can be pressed now (with why not). */
export type CardChoice = { allowed: boolean; reason?: string };

/**
 * The Overview's "AI interview" card for someone under "No AI interview yet" (R20-7), or null for anyone else: where they
 * stand, and the team's choices, nothing waiting on them. "Send a reminder" while the link is open (once a day, not
 * before the email carrying it left, not while paused; the API decides and says why), "Send a new link" once it closed,
 * and "Not moving forward", which opens the private decline with "Candidate did not respond" chosen first
 * (`declineReasonFor`).
 */
export function aiInterviewCard(a: Pick<ApplicationDetail, "ownerStage" | "allowedActions" | "blockedReasons"> & { aiInterview?: AiInterviewView | null }): { line: string; remind: CardChoice | null; resend: CardChoice | null; decline: boolean } | null {
  const v = a.aiInterview;
  if (a.ownerStage !== "no_ai_interview" || !v) return null;
  const open = v.state === "invited" || v.state === "started";
  return {
    line: `${aiInterviewLine(v)} Nothing here waits on you.`,
    remind: open ? { allowed: a.allowedActions.includes("remind_screen"), reason: a.blockedReasons.remind_screen } : null,
    resend: v.canResend ? { allowed: a.allowedActions.includes("invite_screen"), reason: a.blockedReasons.invite_screen } : null,
    decline: a.allowedActions.includes("reject"),
  };
}

/**
 * The reason the private decline starts on: "Candidate did not respond" for everyone under "No AI interview yet" (plan
 * Step 3 item 5), never a judgement about their experience for someone nobody has interviewed; elsewhere none. The person
 * declining can still change it.
 */
export function declineReasonFor(a: { ownerStage?: string; aiInterview?: AiInterviewView | null }): "candidate_unresponsive" | null {
  return a.ownerStage === "no_ai_interview" ? "candidate_unresponsive" : null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* "Hide them until they send" (founder decision, 9 October 2026)                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/** The calm line the panel shows while the candidate is still in the AI interview that came with the application. */
export const STILL_APPLYING_LINE = "AI interview not sent yet: their answers appear here once they send them.";
/**
 * ...and once it closed unfinished: the team sees that it happened, never what they said, nor how far they got (the
 * same words for someone who stopped at the first question and someone who answered everything but never pressed Send).
 */
export const DIDNT_FINISH_LINE = "Didn't finish the AI interview: they did not send their answers, even after one reminder, so you won't see them.";

/**
 * Why a conversation has nothing to read yet, or never will (the API sends `answersShared: false` and leaves the
 * candidate's words out): null when the answers are there to read, or when there was never anything to hide (a link
 * that lapsed unopened, an invitation the team stopped before it was started).
 */
export function hiddenAnswersLine(s: Pick<Screen, "id" | "invitedVia" | "status" | "transcript" | "answersShared" | "startedAt"> & { progress?: Pick<Screen["progress"], "completedBy"> }, timeline: readonly EventLike[] = []): string | null {
  if (s.answersShared !== false) return null;
  if (STILL_APPLYING.includes(s.status)) {
    if (offeredWithApplication(s, timeline)) return STILL_APPLYING_LINE;
    // a conversation from an emailed invitation: shown once it ends normally
    return s.status === "invited" || s.status === "reminded" ? "Not started yet: their answers appear here once they finish the conversation." : "Still answering: their answers appear here once they finish the conversation.";
  }
  switch (s.status) {
    case "unfinished":
      return DIDNT_FINISH_LINE;
    case "declined_by_candidate":
      return "They sent their application without the conversation, so there are no answers to show.";
    case "human_requested":
      return "They asked for a person. Anything they typed before asking was not sent, so you won't see it; a recruiter adds notes from the call.";
    case "completed":
      return "Finished on a call with a recruiter: only the recruiter's notes are shown, never anything the candidate typed without sending it.";
    case "abandoned":
      return "They withdrew during the conversation. Their answers were not sent, so you won't see them.";
    case "cancelled":
      // Closed part-way when they withdrew or were declined while still applying; never started, there was nothing to hide.
      return s.startedAt ? "The conversation closed before they sent their answers, so you won't see them." : null;
    default:
      return null;
  }
}

/** One question of the conversation with what the candidate did with it, and any notes a recruiter added from a call. */
export type AnswerLine = { key: string; question: string; answer: string | null; declined: boolean; edited: boolean; tapped: boolean; notes: Array<{ text: string; by: string | null }> };

/**
 * The packet's questions that came up, in the packet's order: the answer (or that they chose not to answer), whether it
 * was changed on the "check your answers" page, whether it was picked from the choices, and a recruiter's notes for it.
 */
export function answerLines(s: Pick<Screen, "answers" | "progress" | "transcript">, questions: ReadonlyArray<{ key: string; question: string }>): AnswerLine[] {
  const declined = new Set(s.progress.declined ?? []);
  const notes = s.transcript.filter(isRecruiterNote);
  const came = new Set<string>([...s.progress.askedKeys, ...Object.keys(s.answers), ...declined, ...notes.map((t) => t.questionKey ?? "")]);
  return questions
    .filter((q) => came.has(q.key))
    .map((q) => {
      const answer = s.answers[q.key]?.trim() || null;
      const last = [...s.transcript].reverse().find((t) => t.role === "candidate" && t.questionKey === q.key);
      return {
        key: q.key,
        question: q.question,
        answer,
        declined: !answer && declined.has(q.key),
        edited: !!answer && (s.progress.edits?.[q.key] ?? 0) > 0,
        tapped: !!answer && last?.source === "tap",
        notes: notes.filter((t) => t.questionKey === q.key).map((t) => ({ text: t.content, by: t.by ?? null })),
      };
    });
}

/** A question that came up with no answer and no choice not to answer: still to come while the conversation is open. */
export function unansweredWords(status: string): string {
  return STILL_APPLYING.includes(status) ? "Not answered yet" : "Not answered";
}

/** A recruiter's notes that are not about one question. */
export function generalNotes(s: Pick<Screen, "transcript">, questions: ReadonlyArray<{ key: string }>): Array<{ text: string; by: string | null }> {
  const keys = new Set(questions.map((q) => q.key));
  return s.transcript.filter((t) => isRecruiterNote(t) && (!t.questionKey || !keys.has(t.questionKey))).map((t) => ({ text: t.content, by: t.by ?? null }));
}

/** One line of the transcript as a bubble: who it is from, a label when it needs one, and the words. */
export type TranscriptBubble = { kind: "user" | "assistant" | "system" | "recruiter"; label: string | null; text: string };

export function transcriptBubble(t: ScreenTranscriptLine): TranscriptBubble {
  if (isRecruiterNote(t)) return { kind: "recruiter", label: recruiterNoteLabel(t.by), text: t.content };
  if (t.source === "skip") return { kind: "system", label: null, text: `${DECLINED_WORDS} this question.` };
  if (t.role === "candidate") return { kind: "user", label: t.source === "edit" ? "Changed on the check-your-answers page" : t.source === "tap" ? TAPPED_WORDS : null, text: t.content };
  return { kind: t.role === "assistant" ? "assistant" : "system", label: null, text: t.content };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A recruiter's notes from a call (plan E3)                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** The conversation states notes can be added to (mirrors NOTES_ALLOWED in apps/api/src/services/screens.ts). */
const CALL_NOTES_STATUSES = ["invited", "reminded", "in_progress", "paused", "human_requested", "unfinished", "expired", "declined_by_candidate"];
const CALL_NOTES_STAGES = ["received", "eligible", "triaged", "screen_invited", "screening", "screen_complete"];

/**
 * Whether the signed-in person can add notes from a call (escalation.work: a recruiter, the company's own or ITS under a
 * grant), and whether it is the thing waiting on them: the candidate asked for a person.
 */
export function callNotesState(a: Pick<ApplicationDetail, "stage" | "screens">, role: string | null | undefined): { show: boolean; prominent: boolean } {
  const latest = a.screens[0];
  if (!canAddCallNotes(role) || !CALL_NOTES_STAGES.includes(a.stage) || (latest && !CALL_NOTES_STATUSES.includes(latest.status))) return { show: false, prominent: false };
  return { show: true, prominent: latest?.status === "human_requested" };
}

/**
 * Whether the notes may leave the conversation open: only when there is one. With no conversation yet the notes are the
 * screening and finish it (the API refuses anything else).
 */
export function callNotesMayStayOpen(a: Pick<ApplicationDetail, "screens">): boolean {
  return a.screens.length > 0;
}

/**
 * The questions the notes can be filed under: the ones the conversation asks, as the API keeps a note's question only
 * when the conversation has it (apps/api/src/services/screens.ts). Its open questions first; then, for one created since
 * Wave S8 (`progress.asks`), a Kanvis-style chat, and the one the notes start when there is none, the written questions
 * (`packetLabels.written`: the company's own, or the job's screening questions when it set none); for one from before,
 * the job's screening questions. An older answer without `written` gives the screening questions, as before.
 */
export function callNotesQuestions(a: Pick<ApplicationDetail, "screens" | "packetLabels">): Array<{ key: string; question: string }> {
  const latest = a.screens[0];
  const focus = (latest?.progress.focusQuestions ?? []).map((f) => ({ key: f.key, question: f.question }));
  const writtenList = !latest || latest.progress.asks === "written" || !!latest.progress.chat;
  const asked = writtenList && a.packetLabels.written ? a.packetLabels.written.map((w) => ({ key: w.key, question: w.question })) : a.packetLabels.questions;
  const keys = new Set(focus.map((f) => f.key));
  return [...focus, ...asked.filter((q) => !keys.has(q.key))];
}

/** What POST /applications/:id/screen/recruiter-notes takes, from the form; null when nothing was written. */
export function callNotesBody(byQuestion: Record<string, string>, other: string, complete: boolean): { notes: Array<{ questionKey?: string; text: string }>; complete: boolean } | null {
  const notes: Array<{ questionKey?: string; text: string }> = Object.entries(byQuestion).filter(([, text]) => text.trim()).map(([questionKey, text]) => ({ questionKey, text: text.trim() }));
  if (other.trim()) notes.push({ text: other.trim() });
  return notes.length ? { notes, complete } : null;
}

/** What adding the notes did, in two short lines. */
export function callNotesToast(r: { completed: boolean }, firstName: string): { title: string; detail: string } {
  return r.completed
    ? { title: "Notes added. The conversation is complete.", detail: `${firstName}'s scorecard is written from them, marked as your notes and never as their own words.` }
    : { title: "Notes added.", detail: `The conversation stays open for ${firstName}.` };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* How the conversation goes for a role (plan E13)                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/** "under a minute", "about 1 minute", "about 7 minutes"; null with nothing finished yet. */
export function minutesWords(m: number | null | undefined): string | null {
  if (m === null || m === undefined || !Number.isFinite(m)) return null;
  if (m < 1) return "under a minute";
  const n = Math.round(m);
  return `about ${n} ${n === 1 ? "minute" : "minutes"}`;
}

/** "8 of 10 (80%)"; just "0" with nobody to count from. */
export function shareWords(part: number, whole: number): string {
  return whole > 0 ? `${part} of ${whole} (${Math.round((part / whole) * 100)}%)` : String(part);
}

/** The figures as label and value, in reading order; empty while nobody has been offered the conversation. */
export function funnelLines(f: ScreeningFunnel): Array<{ label: string; value: string }> {
  if (!f.offered) return [];
  const lines = [
    { label: "Offered the conversation", value: String(f.offered) },
    { label: "Started it", value: shareWords(f.started, f.offered) },
    { label: "Finished it", value: shareWords(f.finished, f.started) },
    { label: "Typical time to finish", value: minutesWords(f.medianMinutes) ?? "nobody has finished yet" },
  ];
  if (f.stillApplying) lines.push({ label: "AI interview open now", value: String(f.stillApplying) });
  if (f.unfinished) lines.push({ label: "Didn't finish the conversation", value: String(f.unfinished) });
  const person = f.personChosen.contactMe + f.personChosen.sendWithout;
  lines.push({ label: "Chose a person instead", value: person ? `${person}: ${f.personChosen.contactMe} asked to be contacted, ${f.personChosen.sendWithout} sent their application without it` : "nobody" });
  return lines;
}

