import { MARK_LABEL, type MarkKind } from "@ros/contracts";
import type { ApplicationDetail, Screen, TimelineEvent } from "../../api/client";
import { notSentReasonText } from "../../cancelled";
import { DECLINED_WORDS, isRecruiterNote, transcriptBubble, type TranscriptBubble } from "../../screen-view";
import { abbreviationBefore } from "../../today";

/**
 * The candidate panel's rules (plan A10), kept free of React so they can be tested (tests/web/candidate-panel.test.ts):
 * its sections and address, next and previous, the unread markers, the hold's dates, and the History tab's words (who
 * did what, why, and what the candidate was told).
 */

/** `notes`: the team's private notes (founder decision Q24; plan H3), never shown to the candidate. */
export type PanelTab = "overview" | "screen" | "resume" | "messages" | "notes" | "history";
export const PANEL_TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "screen", label: "Screening chat" },
  { id: "resume", label: "Résumé" },
  { id: "messages", label: "Messages" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "History" },
];

/**
 * A card's one visible line and the rest (Wave S1): the first sentence of a longer text, and what follows it, which the
 * card keeps one click away under "Why". A title such as "Dr." ("Dr. Lee Dental") does not end it. `rest` is null when
 * the text is one sentence.
 */
export function firstSentence(text: string | null | undefined): { line: string; rest: string | null } {
  const t = (text ?? "").trim();
  const mark = /[.!?]["”)]?(?=\s+[A-Z"“(])/g;
  for (let m = mark.exec(t); m; m = mark.exec(t)) {
    if (m[0][0] === "." && abbreviationBefore(t.slice(0, m.index))) continue;
    const end = m.index + m[0].length;
    const rest = t.slice(end).trim();
    return { line: t.slice(0, end), rest: rest || null };
  }
  return { line: t, rest: null };
}

/** `?tab=` as a section; anything else opens the Overview. */
export function panelTabFrom(value: string | null | undefined): PanelTab {
  return PANEL_TABS.some((t) => t.id === value) ? (value as PanelTab) : "overview";
}

/**
 * The page's query string with the panel's state in it (`?open=<id>&tab=…`), the rest of the address kept. Closing
 * (`open: null`) also drops `tab` and `message`: `?message=1` belongs to the link it came in on, and left in the
 * address every panel opened next would start with the text box open. `step` and `round` (Today's "Yes, interview",
 * plan H4) open a step once, so any change of the panel drops them too.
 */
export function panelSearch(current: URLSearchParams | string, change: { open: string | null; tab?: PanelTab }): string {
  const next = new URLSearchParams(current);
  next.delete("step");
  next.delete("round");
  if (change.open) {
    next.set("open", change.open);
    if (change.tab && change.tab !== "overview") next.set("tab", change.tab);
    else next.delete("tab");
  } else {
    next.delete("open");
    next.delete("tab");
    next.delete("message");
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Where next and previous go, from the list as it was when the panel opened. Null when the person is not in that list
 * (a panel opened from a notification about someone the filters hide): then there is no next or previous.
 */
export function neighbours(ids: readonly string[] | null | undefined, id: string): { index: number; total: number; prev: string | null; next: string | null } | null {
  if (!ids) return null;
  const index = ids.indexOf(id);
  if (index < 0) return null;
  return { index, total: ids.length, prev: index > 0 ? ids[index - 1] : null, next: index < ids.length - 1 ? ids[index + 1] : null };
}

/** The newest thing in each section, as a time: what an unread marker compares with. */
export type LatestByTab = Partial<Record<PanelTab, string | null>>;
export function latestByTab(a: Pick<ApplicationDetail, "screens" | "communications" | "timeline" | "documents">): LatestByTab {
  const newest = (times: Array<string | null | undefined>) => times.filter((t): t is string => !!t && !Number.isNaN(Date.parse(t))).sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null;
  const screen = a.screens[0];
  return {
    screen: screen ? newest([screen.completedAt, screen.startedAt, ...screen.transcript.filter((t) => t.role === "candidate").map((t) => t.at)]) : null,
    // only what the candidate wrote counts as new; the team's own messages are not news to the team
    messages: newest(a.communications.filter((m) => m.direction === "inbound").map((m) => m.createdAt)),
    history: newest(a.timeline.map((e) => e.occurredAt)),
    resume: newest(a.documents.map((d) => d.validatedAt)),
  };
}

/** When the reader last opened each section of this candidate's panel; `first` is their first look at the panel. */
export type SeenTabs = { first: string } & Partial<Record<PanelTab, string>>;

/**
 * The sections with something newer than the reader's last look. On a first look nothing is marked (everything would
 * be); afterwards a section counts from when it was last opened, or from the first look if it never was.
 */
export function unreadTabs(latest: LatestByTab, seen: SeenTabs | null | undefined, current?: PanelTab): Set<PanelTab> {
  const out = new Set<PanelTab>();
  if (!seen) return out;
  for (const t of PANEL_TABS) {
    if (t.id === current) continue;
    const at = latest[t.id];
    const since = seen[t.id] ?? seen.first;
    if (at && Date.parse(at) > Date.parse(since)) out.add(t.id);
  }
  return out;
}

/** The record after the reader opened a section now. */
export function markSeen(seen: SeenTabs | null | undefined, tab: PanelTab, now: Date): SeenTabs {
  const at = now.toISOString();
  return { ...(seen ?? { first: at }), [tab]: at };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A date in the reader's own calendar as YYYY-MM-DD, the form a date field reads and writes. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The hold's date field: tomorrow at the earliest, two weeks unless changed (plan A4), and a day inside the API's eight
 * weeks at the latest, so the reader's own calendar day never lands past the limit wherever they are.
 */
export function holdDateBounds(now: Date = new Date()): { min: string; max: string; initial: string } {
  const plus = (days: number) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  return { min: plus(1), max: plus(55), initial: plus(14) };
}

/**
 * How a file shows inside the panel (plan H5): a PDF as itself, a Word or text file as its words (the API serves the text
 * it read), anything else only in a new tab. Both ways go through the API, which records each opening. `frame` is null
 * when nothing can be shown inside the panel.
 */
export function resumeView(applicationId: string, doc: Pick<ApplicationDetail["documents"][number], "id" | "filename" | "status" | "hasText"> & { mime?: string }): { frame: string | null; asText: boolean; open: string } {
  const base = `/api/v1/applications/${applicationId}/documents/${doc.id}`;
  const open = `${base}/file`;
  if (doc.status !== "clean") return { frame: null, asText: false, open };
  const pdf = doc.mime ? doc.mime === "application/pdf" : /\.pdf$/i.test(doc.filename);
  if (pdf) return { frame: `${base}/inline`, asText: false, open };
  if (doc.hasText) return { frame: `${base}/inline`, asText: true, open };
  return { frame: null, asText: false, open };
}

/** The file the Résumé tab shows first: the application's résumé when it is clean, else the first clean file. */
export function resumeToShow<T extends { id: string; status: string; kind: string }>(documents: readonly T[], resumeDocumentId?: string | null): T | null {
  const clean = documents.filter((d) => d.status === "clean");
  return clean.find((d) => d.id === resumeDocumentId) ?? clean.find((d) => d.kind === "resume") ?? clean[0] ?? null;
}

const ACTIVE_INTERVIEWS = ["proposed", "scheduling", "scheduled"];
/** Interviews a decision would call off: requested, being scheduled or booked. */
export function activeInterviews<T extends { status: string }>(interviews: readonly T[]): T[] {
  return interviews.filter((i) => ACTIVE_INTERVIEWS.includes(i.status));
}

/**
 * What was answered on a failed eligibility question, to show after the question itself: "answered no", never the
 * question a second time (the stored reason for a yes/no rule repeats it, for the team's notification).
 */
export function eligibilityAnswerWords(f: { question: string; reason: string }): string {
  const prefix = "answered no to: ";
  return f.reason.startsWith(prefix) && f.reason.slice(prefix.length).trim() === f.question.trim() ? "answered no" : f.reason;
}

/**
 * Why there is no reading yet. Someone held on an eligibility answer is read only once a person keeps them in, so
 * "a minute or two" would never come true for them.
 */
export function notReadYetWords(stage: string): string {
  return stage === "ineligible" ? "The assistant reads this application once someone keeps them in." : "The assistant has not read this application yet. It usually takes a minute or two after they apply.";
}

const ROLE_WORDS: Record<string, string> = { owner: "an owner", admin: "an admin", hiring_manager: "a hiring manager", recruiter: "a recruiter", hr: "HR", interviewer: "an interviewer" };
/** "an owner or an admin": who a waiting message is waiting for, in the reader's words. */
export function whoDecides(roles: readonly string[]): string {
  return roles.length ? roles.map((r) => ROLE_WORDS[r] ?? r.replace(/_/g, " ")).join(" or ") : "an owner or an admin";
}

/** Text typed into the panel and not sent yet, by where it was typed. */
export function hasUnsent(drafts: Record<string, string>): boolean {
  return Object.values(drafts).some((t) => t.trim().length > 0);
}

/** The message being written to the candidate: kept by the panel, so switching sections never loses it. */
export type Compose = { open: boolean; subject: string; text: string };
export const NO_COMPOSE: Compose = { open: false, subject: "", text: "" };

/**
 * The message box for the person on screen (plan A10): what was being written belongs to the person it was written
 * to, so moving to the next or previous person opens an empty, closed box instead of carrying the text over. (Every
 * other form under the header is keyed by the person and starts again the same way.)
 */
export function composeFor(state: Compose & { id: string }, id: string): Compose {
  return state.id === id ? { open: state.open, subject: state.subject, text: state.text } : NO_COMPOSE;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The answers to the company's questions, written up from the chat (Wave S7).                                  */
/* ------------------------------------------------------------------------------------------------------------ */

type PacketLabels = ApplicationDetail["packetLabels"];
/** A question the panel names a screen's answers by; `required` only for the company's written questions. */
export type PanelQuestion = { key: string; question: string; required?: boolean };

/**
 * The questions a screen's answers are named by: the written questions the chat asks (Wave S7; the company's own, or
 * the screening questions under their own keys for a job saved before), then any screening question not among them. An
 * older answer without `written` gives the screening questions alone, as before.
 */
export function panelQuestions(labels: Pick<PacketLabels, "questions" | "written">): PanelQuestion[] {
  const written: PanelQuestion[] = (labels.written ?? []).map((w) => ({ key: w.key, question: w.question, required: w.required }));
  const keys = new Set(written.map((w) => w.key));
  return [...written, ...labels.questions.filter((q) => !keys.has(q.key)).map((q) => ({ key: q.key, question: q.question }))];
}

type WriteupAnswerView = NonNullable<Screen["progress"]["writeup"]>["answers"][number];
type Tone = "good" | "accent" | "neutral" | "caution";

/** What became of a written question, in the panel's words. Not answering is never held against anyone. */
export const WRITEUP_STATUS: Readonly<Record<WriteupAnswerView["status"], { words: string; tone: Tone }>> = {
  answered: { words: "Answered", tone: "good" },
  partly: { words: "Partly answered", tone: "accent" },
  not_given: { words: "No answer given", tone: "neutral" },
  skipped: { words: DECLINED_WORDS, tone: "neutral" },
};
/** The label over the assistant's own note on an answer: kept apart from the answer, and never the candidate's words. */
export const ASSISTANT_NOTE_LABEL = "Note from the assistant. Not the candidate's own words.";
/** Where a written-up answer's words come from. */
export const DRAFTED_WORDS = "Drafted by the assistant from their replies; they could change it before sending.";
export const OWN_WORDS = "Their own words: they changed this before sending.";

/**
 * One company question as the panel shows it once the chat was sent: the answer written up from the candidate's replies
 * (or exactly what they typed, when they changed it on Review & send), what became of the question, the pieces of their
 * own messages it rests on, the assistant's note when something was missing (labelled as the assistant's, never mixed
 * into the answer), a recruiter's call notes about it, and the chat's own messages about it, one click away.
 */
export type WriteupLine = {
  key: string;
  question: string;
  required: boolean;
  answer: string | null;
  status: WriteupAnswerView["status"];
  statusWords: string;
  tone: Tone;
  byCandidate: boolean;
  byWords: string;
  quotes: string[];
  note: string | null;
  notes: Array<{ text: string; by: string | null }>;
  chat: TranscriptBubble[];
};

/** "wq_why_this_job" → "Why this job": a question the labels no longer name (an older version of the job). */
function keyWords(key: string): string {
  const words = key.replace(/^(wq|q|sq)_/, "").replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/**
 * The write-up of a sent chat, one line per company question in the write-up's order. Empty while the answers are
 * hidden ("hide them until they send": the API sends no write-up then either) and for a chat without one.
 */
export function writeupLines(s: Pick<Screen, "progress" | "transcript" | "answersShared">, questions: readonly PanelQuestion[]): WriteupLine[] {
  if (s.answersShared === false) return [];
  const answers = s.progress.writeup?.answers ?? [];
  return answers.map((a) => {
    const q = questions.find((x) => x.key === a.questionKey);
    const answer = a.answer.trim() || null;
    const status = WRITEUP_STATUS[a.status] ?? WRITEUP_STATUS.not_given;
    const quotes = [...new Set((a.quotes ?? []).map((x) => x.trim()).filter((x) => x && x !== answer))];
    const about = s.transcript.filter((t) => t.questionKey === a.questionKey);
    const byCandidate = a.by === "candidate";
    return {
      key: a.questionKey,
      question: q?.question ?? keyWords(a.questionKey),
      required: q?.required ?? true,
      answer,
      status: a.status,
      statusWords: status.words,
      tone: status.tone,
      byCandidate,
      byWords: byCandidate ? OWN_WORDS : DRAFTED_WORDS,
      quotes,
      note: a.note?.trim() || null,
      notes: about.filter(isRecruiterNote).map((t) => ({ text: t.content, by: t.by ?? null })),
      chat: about.filter((t) => !isRecruiterNote(t)).map(transcriptBubble),
    };
  });
}

/** "3 of 4 answered (1 partly)": a partial answer counts as answered, and the line says how many were partial. */
export function writeupSummary(lines: readonly Pick<WriteupLine, "status">[]): string {
  const partly = lines.filter((l) => l.status === "partly").length;
  const given = lines.filter((l) => l.status === "answered").length + partly;
  return `${given} of ${lines.length} answered${partly ? ` (${partly} partly)` : ""}`;
}

/** The Overview's one line about the write-up: how many were answered, how many carry the assistant's note, and where to read them. */
export function writeupOverviewLine(lines: readonly Pick<WriteupLine, "status" | "note">[]): string {
  const noted = lines.filter((l) => l.note).length;
  return `Answers to your questions: ${writeupSummary(lines)}${noted ? `, ${noted} with a note from the assistant` : ""}. Read them on the Screening chat tab.`;
}

type ChatItemView = NonNullable<Screen["progress"]["chat"]>["items"][number];
/** Where a must-have the résumé did not show was left by the chat. "Not known" is never a no. */
export const GAP_STATE_WORDS: Readonly<Record<ChatItemView["state"], string>> = {
  covered: "They gave an answer or an example",
  unknown: "Not known yet: never counted as a no",
  skipped: DECLINED_WORDS,
  open: "Not reached in the chat",
  asking: "Not reached in the chat",
};

/**
 * The must-haves the résumé did not show that the chat asked about ("About your experience"), each with where it was
 * left, in the plan's order. Empty while the answers are hidden and for a chat without a plan or without such gaps.
 */
export function chatGapLines(s: Pick<Screen, "progress" | "answersShared">, mustHaves: ReadonlyArray<{ key: string; text: string }>): Array<{ key: string; text: string; state: ChatItemView["state"]; words: string }> {
  if (s.answersShared === false) return [];
  return (s.progress.chat?.items ?? [])
    .filter((i) => i.kind === "gap")
    .map((i) => ({ key: i.key, text: mustHaves.find((m) => m.key === i.key)?.text ?? i.key.replace(/^mh_\d+_/, "").replace(/_/g, " "), state: i.state, words: GAP_STATE_WORDS[i.state] ?? GAP_STATE_WORDS.open }));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* History: who did what, why, and what the candidate was told.                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

export const REJECT_REASON_LABEL: Record<string, string> = {
  not_a_match_experience: "Experience isn't the right fit",
  not_a_match_skills: "Missing skills we need",
  compensation_mismatch: "Pay expectations don't match",
  location_or_schedule: "Location or schedule",
  position_filled: "Position filled",
  candidate_unresponsive: "They stopped responding",
  eligibility: "An eligibility answer",
  role_closed: "The role closed",
  employer_declined: "We declined",
  other: "Other",
};

/** The reasons a person picks when moving someone to Not moving forward (the fixed list; eligibility has its own card). */
export const DECLINE_REASONS: ReadonlyArray<[string, string]> = ["not_a_match_experience", "not_a_match_skills", "compensation_mismatch", "location_or_schedule", "position_filled", "candidate_unresponsive", "other"].map((k) => [k, REJECT_REASON_LABEL[k]]);

/** The assistant's suggestion after reading the résumé or the screen. Its "hold" means thin evidence, never the On hold mark. */
export const REC_LABEL: Record<string, string> = { screen: "Worth a screening chat", hold: "Thin evidence: your call", review_manually: "Needs a closer look", strong_interview: "Strong: interview", interview: "Interview", decline_recommended: "Concern raised" };

/** Owner Mode never shows raw stage names (docs/07); mirrors STAGE_LABEL in packages/core, in the staff glossary's words (screening chat). */
export const STAGE_LABEL: Record<string, string> = { applied: "Just applied", received: "Received", ineligible: "Doesn't meet eligibility", eligible: "Eligible", triaged: "Ready for your review", screen_invited: "Invited to a screening chat", screening: "In the screening chat", screen_complete: "Screening chat done", interview_recommended: "Recommended for interview", interview_scheduled: "Interviewing", interview_complete: "Interview done: decision needed", debrief: "Deciding", finalist: "Finalist", reference_check: "Checking references", offer_draft: "Offer being prepared", offer_approval: "Offer needs your approval", offer_sent: "Offer out", negotiation: "Negotiating", accepted: "Accepted", declined: "Declined the offer", hired: "Hired", onboarding: "Starting soon", withdrawn: "Withdrew", rejected: "Not moving forward", talent_pool: "In your talent pool" };

const MARK_DONE: Record<MarkKind, string> = { longlist: "Put on the longlist", shortlist: "Put on the shortlist", on_hold: "Put on hold", not_a_fit_for_now: "Set aside: not a fit for now" };

/** Who did it, in words: a person by name, "The assistant" for an AI step (never its internal id), "The system" for a workflow. */
export function whoDid(actor: TimelineEvent["actor"]): string {
  switch (actor.kind) {
    case "agent":
      return "The assistant";
    case "system":
      return "The system";
    case "candidate":
      return "The candidate";
    case "recruiter":
      return actor.name ? `${actor.name} (ITS recruiter)` : "An ITS recruiter";
    default:
      return actor.name ?? "A team member";
  }
}

const shortDay = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const longDay = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "");
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The Cancelled column (founder decisions 1A to 4A) in the History tab: someone went under Cancelled (their choice, a
 * no-show, or back after a decision was taken back) or left it. Leaving the process, or a new entry replacing an old one,
 * says nothing more: the stage line or the new entry already says it.
 */
const LEFT_CANCELLED: Record<string, string> = { rebooked: "Booked a new interview time", moved_by_team: "Moved on from Cancelled", team_cancelled: "The team cancelled the interview with new times" };
function movedToCancelled(p: Record<string, unknown>): { what: string; why?: string; told?: string } {
  if (p.restored) return { what: "Back under Cancelled: the decision was taken back" };
  if (p.reason === "no_show") return { what: "Did not come to the interview", ...(p.backfill ? { why: "Recorded when the Cancelled column was added." } : {}) };
  if (p.reason === "not_interested") return { what: "Cancelled the interview: no longer interested" };
  // The day the candidate was told, in the company's calendar (`dueDay`, YYYY-MM-DD), whatever the reader's time zone.
  const auto = (p.auto ?? {}) as { state?: unknown; dueAt?: unknown; dueDay?: unknown };
  const companyDay = typeof auto.dueDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(auto.dueDay) ? `${auto.dueDay}T12:00:00` : null;
  const day = auto.state === "waiting" ? longDay(companyDay ?? auto.dueAt) : "";
  return { what: "Cancelled the interview and asked for new times", ...(day ? { told: `New times go to them automatically on ${day}.` } : {}) };
}

/** A person's decision already said by its own event: the matching "human decision" record would only repeat it. */
const SAID_ELSEWHERE = new Set(["reject", "set_mark", "clear_mark", "hold", "advance_to_interview", "told_in_person", "send_decision", "interview.decision", "offer_made"]);

export type HistoryItem = { key: string; when: string; what: string; who: string; why?: string; told?: string };

/** The assistant's suggestions a person answers with Yes or Not now (plan A6). */
const SUGGESTIONS = new Set(["application.invite_screen", "application.recommend_interview"]);
const SUGGESTED: Record<string, string> = { "application.invite_screen": "a screening chat", "application.recommend_interview": "an interview", "disposition.send": "sending the decision message", "message.send_freeform": "a team member's message" };
const SCREEN_CANCELLED: Record<string, string> = { stopped_by_team: "Screening chat invitation stopped by the team", left_process: "Screening chat closed: no longer in the process", deletion_request: "Screening chat closed: their information was deleted" };
/** Why a suggestion or approval was closed without an answer. */
const CLOSED_BY: Record<string, string> = { left_process: "they left the process", deletion_request: "their information was deleted", told_in_person: "they were told in person", reject: "a person declined them", move_to_talent_pool: "a person moved them to the talent pool", hold: "a person put them on hold", set_mark: "a person set them aside", invite_screen: "a person invited them to a screening chat", ask_in_screen: "a person invited them to a screening chat", advance_to_interview: "a person moved them to interview" };

/**
 * An approval about this candidate in words: the assistant's suggestion (a screen, an interview) asked, approved by a
 * person, set aside with "Not now", closed, or run out of time; and the team's own approvals (the decision message, a
 * team member's message). Null for one that only repeats another line.
 */
function approvalWords(kind: "asked" | "granted" | "denied" | "cancelled" | "expired", p: Record<string, unknown>, base: { key: string; when: string; who: string }): HistoryItem | null {
  const type = String(p.actionType ?? "");
  const what = SUGGESTED[type];
  if (!what) return null;
  const suggestion = SUGGESTIONS.has(type);
  const note = str(p.note);
  switch (kind) {
    case "asked":
      return suggestion ? { ...base, what: `The assistant suggested ${what}`, who: "The assistant" } : { ...base, what: `Asked for approval: ${what}` };
    case "granted":
      return { ...base, what: suggestion ? `Approved the suggestion of ${what}` : `Approved ${what}` };
    case "denied":
      return suggestion ? { ...base, what: `Not now: set aside the suggestion of ${what}`, ...(note && note !== "Not now" ? { why: note } : {}), told: "The candidate was not told." } : { ...base, what: `Turned down ${what}`, ...(note ? { why: note } : {}) };
    case "cancelled": {
      const by = CLOSED_BY[String(p.by ?? "")];
      return { ...base, what: suggestion ? `The suggestion of ${what} was closed` : `The approval of ${what} was withdrawn`, ...(by ? { why: `Because ${by}.` } : {}) };
    }
    default:
      return { ...base, what: `The suggestion of ${what} ran out of time${typeof p.windowDays === "number" ? ` (${p.windowDays} days)` : ""}`, who: "The system" };
  }
}

/** One event in plain words, or null for a record that only repeats another. */
export function historyItem(e: TimelineEvent, i = 0): HistoryItem | null {
  const p = e.payload as Record<string, unknown>;
  const note = str(p.note);
  const base = { key: `${e.occurredAt}:${e.type}:${i}`, when: e.occurredAt, who: whoDid(e.actor) };
  switch (e.type) {
    case "application.received":
      return { ...base, what: "Applied" };
    case "application.acknowledged":
      return { ...base, what: "Confirmation sent to the candidate" };
    case "application.duplicate_detected":
      return { ...base, what: "Applied again (the original was kept)" };
    case "resume.ingested":
      return { ...base, what: "Résumé read" };
    case "resume.extraction_failed":
      return { ...base, what: "The résumé could not be read" };
    case "eligibility.evaluated":
      return { ...base, what: `Eligibility checked (${p.passed ? "met" : "not met"})` };
    case "application.ineligible":
      return { ...base, what: "Held on an eligibility answer", told: "Nothing was sent to the candidate." };
    case "application.triaged":
      return { ...base, what: `AI review of the résumé: ${REC_LABEL[String(p.recommendation ?? "")] ?? "done"}` };
    case "assessment.created":
      return { ...base, what: p.kind === "screen" ? "AI review of the screening chat written" : "AI review of the résumé written" };
    case "application.stage_changed":
      return { ...base, what: `Now "${STAGE_LABEL[String(p.to ?? "")] ?? String(p.to ?? "").replace(/_/g, " ")}"`, ...(str(p.reason) && !REJECT_REASON_LABEL[String(p.reason)] ? { why: String(p.reason) } : {}) };
    case "application.rejected":
      return {
        ...base,
        what: `Moved to Not moving forward${p.afterInterview ? " after the interview" : ""}`,
        why: [REJECT_REASON_LABEL[String(p.reason ?? "")] ?? str(p.reason), note].filter(Boolean).join(": ") || undefined,
        told: p.candidateTold === false ? "Private: the candidate was not told." : undefined,
      };
    case "application.marked": {
      const mark = p.mark as MarkKind;
      const until = mark === "on_hold" && p.remindAt ? ` until ${shortDay(p.remindAt)}` : "";
      return { ...base, what: `${MARK_DONE[mark] ?? "Marked"}${until}`, ...(note ? { why: note } : {}), told: "Private: the candidate was not told." };
    }
    case "application.mark_cleared": {
      const label = MARK_LABEL[p.mark as MarkKind] ?? "mark";
      const reason = String(p.reason ?? "");
      if (reason.startsWith("replaced by")) return null; // the new mark's own line says it
      const movedOn = p.to === "cancelled" ? "they went under Cancelled" : "they moved on";
      const what = reason === "left_process" ? `${label} mark ended: they left the process` : reason === "moved_on" ? `${label} mark ended: ${movedOn}` : `Taken off ${label === "On hold" ? "hold" : `the ${label.toLowerCase()}`}`;
      return { ...base, what, ...(note ? { why: note } : {}) };
    }
    case "application.told":
      if (p.how === "before_tracking") return { ...base, what: "Counted as told: decided before decisions became private", told: "Their status page already showed the decision." };
      return { ...base, what: p.how === "in_person" ? "Recorded telling the candidate in person" : "The decision message reached the candidate", told: p.how === "in_person" ? "Told in person." : "Told by the decision message." };
    case "application.untold_fallback":
      // The safety net (Q27): five working days after the decision, the standard message went by itself, or a recruiter was brought in.
      if (p.action === "sent") return { ...base, what: "Nobody had told them for five working days, so the standard decision message went by itself", who: "The system", told: "Told by the decision message." };
      return { ...base, what: "Nobody had told them for five working days, so an ITS recruiter was brought in", who: "The system", ...(str(p.why) ? { why: `Nothing was sent, because ${String(p.why)}.` } : {}) };
    case "application.hold_reminded":
      return { ...base, what: "Reminded the team about the hold" };
    // Offers made outside the app (founder decision Q29): recorded by a person, never written or sent by the app.
    case "offer.created":
      return { ...base, what: `Recorded an offer made outside the app${str(p.madeOn) ? ` on ${shortDay(`${String(p.madeOn)}T12:00:00`)}` : ""}`, ...(note ? { why: note } : {}), told: "Nothing was sent to the candidate." };
    case "offer.accepted":
      return { ...base, what: "Recorded that they accepted the offer" };
    case "offer.declined":
      return { ...base, what: p.outcome === "candidate_withdrew" ? "Recorded that they withdrew while the offer was open" : "Recorded that they declined the offer" };
    case "offer.rescinded":
      return { ...base, what: "The recorded offer was closed" };
    // Private team notes (Q24): the fact only, never the words.
    case "note.added":
      return { ...base, what: "Added a private team note" };
    case "note.updated":
      return { ...base, what: p.removed ? "Removed their private team note" : "Changed their private team note" };
    case "application.withdrawn":
      return { ...base, what: "Withdrew", ...(str(p.reason) ? { why: String(p.reason) } : {}) };
    case "application.moved_to_talent_pool":
      return { ...base, what: p.talentPoolOptOut ? "Moved out of this role (they asked not to be kept for future roles)" : "Added to the talent pool", told: "Private: the candidate was not told." };
    case "candidate.recommended":
      if (p.by === "approval") return { ...base, what: "Moved to Interviewing", who: `Suggested by the assistant, approved by ${e.actor.name ?? "a team member"}` };
      if (p.by === "human") return { ...base, what: "Marked for interview" };
      return { ...base, what: "Recommended for interview" };
    case "interview.decision_recorded":
      return { ...base, what: `Decision after the interview: ${String(p.decision ?? "").replace(/_/g, " ")}`, ...(note ? { why: note } : {}) };
    // The Cancelled column (founder decisions 1A to 4A): in, out, and what became of the new times.
    case "application.moved_to_cancelled":
      return { ...base, ...movedToCancelled(p) };
    case "application.left_cancelled": {
      const what = LEFT_CANCELLED[String(p.how ?? "")];
      return what ? { ...base, what } : null;
    }
    case "interview.new_times_sent":
      return p.via === "auto" ? { ...base, what: "New times sent automatically, as they asked", who: "The system" } : { ...base, what: "New times sent" };
    case "interview.new_times_not_sent": {
      if (p.reason === "left_process" || p.reason === "details_deleted") return null;
      const why = notSentReasonText(p.reason);
      return { ...base, what: "The automatic new times did not go", ...(why ? { why } : {}) };
    }
    case "human.override": {
      const action = String(p.action ?? "");
      if (SAID_ELSEWHERE.has(action)) return null;
      const words: Record<string, string> = {
        override_eligibility: "Kept them in after the eligibility answer",
        review_anyway: "Reopened after an eligibility decline",
        invite_screen: "Invited to a screening chat",
        ask_in_screen: "Invited to a screening chat that starts with the open questions",
        "interview.request": "Approved an interview; times go out to the candidate",
        flag_assessment: "Flagged the AI review as wrong",
        outcome: `Recorded an outcome${str(p.outcome) ? `: ${String(p.outcome).replace(/_/g, " ")}` : ""}`,
        outcome_corrected: "An ITS administrator corrected the recorded outcome",
        move_to_talent_pool: "Moved to the talent pool",
        cancel_screen: "Stopped the screening chat invitation",
        undo_decision: "Took back the decision before they were told; nothing was sent",
        "interview.new_times": "Sent new times",
        "interview.new_times_stop": "Stopped the automatic new times",
      };
      return { ...base, what: words[action] ?? `Decision: ${action.replace(/[._]/g, " ")}`, ...(note ? { why: note } : {}) };
    }
    // The assistant's suggestions and other approvals about this candidate (recorded on the request).
    case "approval.requested":
      return approvalWords("asked", p, base);
    case "approval.granted":
      // a person who did what was suggested themselves has their own line (the invitation, the interview), and so does
      // an approved interview ("Moved to Interviewing", suggested by the assistant, approved by …)
      if (p.by || p.actionType === "application.recommend_interview") return null;
      return approvalWords("granted", p, { ...base, who: SUGGESTIONS.has(String(p.actionType)) ? `Suggested by the assistant, approved by ${e.actor.name ?? "a team member"}` : base.who });
    case "approval.denied":
      return approvalWords("denied", p, base);
    case "approval.cancelled":
      return approvalWords("cancelled", p, base);
    case "approval.expired":
      return approvalWords("expired", p, base);
    // Their screens (recorded on the screen).
    case "screen.invited":
      if (p.invitedVia === "apply") return { ...base, what: "Offered the screening chat right after the application form" };
      return { ...base, what: p.focus === "unknowns" ? "Screening chat invitation sent, starting with the open questions" : "Screening chat invitation sent" };
    case "screen.started":
      return { ...base, what: "Started the screening chat" };
    case "screen.completed":
      // Before 9 October 2026 only: answers nobody pressed Send on are no longer sent for the candidate ("hide them until they send").
      if (p.via === "review_timeout") return { ...base, what: "Their screening answers were sent as they were", who: "The system", why: "They answered every question but did not press Send; a reminder said the answers would go two days later." };
      return { ...base, what: p.via === "recruiter_call" ? "Screening finished with a recruiter's notes from a call" : "Finished the screening chat" };
    // Wave E: the conversation in the same visit as applying.
    case "screen.declined_by_candidate":
      return { ...base, what: "Sent the application without the screening chat", why: "Their own choice; it is never held against them." };
    case "screen.idle_reminded":
      return { ...base, what: "Reminded once to finish the screening chat", who: "The system" };
    case "screen.unfinished":
      // They never sent their answers, so the history says nothing about how far they got (9 October 2026).
      return { ...base, what: "Didn't finish the screening chat; it closed after one reminder", who: "The system", why: "They never sent their answers, so they are not shown." };
    case "screen.paused":
      return { ...base, what: "The screening chat paused: the assistant was not working", who: "The system", told: "They are emailed a link to finish once it is back." };
    case "screen.resumed":
      return { ...base, what: "The screening chat is back on", who: "The system" };
    case "screen.question_skipped":
      return { ...base, what: p.answerKept ? "Moved on from a follow-up question, keeping the answer already given" : "Chose not to answer a screening question" };
    case "screen.answer_edited":
      return { ...base, what: "Changed an answer before sending" };
    case "screen.answer_tapped":
      return null; // the answer itself is on the Screen tab
    case "screen.recruiter_notes_added":
      return { ...base, what: "Added notes from a call with the candidate", why: "Kept as the recruiter's notes, never as the candidate's own words." };
    case "screen.turn_cap_reached":
      return { ...base, what: "The screening chat reached its length limit", who: "The system", why: p.ending === "review" ? "They were taken to check their answers, where they can answer any question still open, and send them." : "It closed with what they had said so far, and the AI review reads only that." };
    case "screen.repeat_confirmed":
      return { ...base, what: p.intent === "person" ? "Confirmed by email: asked for a person after applying again" : p.intent === "outage" ? "Confirmed by email: a person to finish the chat the assistant could not, after applying again" : p.added ? "Confirmed by email: answers given when applying again were added" : "Confirmed by email after applying again; nothing was added" };
    case "screen.human_requested":
      return { ...base, what: "Asked to talk to a person instead of the assistant" };
    case "screen.allowance_lapsed":
      return { ...base, what: "Never got the screening chat: the plan's screening chats stayed used up", who: "The system", ...(p.promised ? { told: "They were told it is not going ahead and that nothing else is needed." } : {}) };
    case "screen.expired":
      if (p.oneVisit) return { ...base, what: "Did not start the screening chat that goes with the application", who: "The system", why: "Reminded once; the application came to the team without it, and they were told nothing else is needed." };
      return { ...base, what: "The screening chat invitation lapsed without an answer" };
    case "screen.abandoned":
      return p.reason === "withdrawn" ? null : { ...base, what: "Left the screening chat" };
    case "screen.cancelled":
      return { ...base, what: SCREEN_CANCELLED[String(p.reason ?? "")] ?? "Screening chat closed", ...(note ? { why: note } : {}) };
    // recruiter help, from the second query (events about the escalation, not the application)
    case "recruiter.requested":
      return { ...base, what: "Asked an ITS recruiter for help" };
    case "recruiter.claimed":
      return { ...base, what: "An ITS recruiter picked up the request" };
    case "recruiter.resolved":
      return { ...base, what: "The ITS recruiter answered", ...(str(p.resolution) ? { why: String(p.resolution) } : {}) };
    case "recruiter.replied":
      return { ...base, what: "The ITS recruiter wrote about the request" };
    case "customer.replied":
      return { ...base, what: "A note was added to the request for the recruiter" };
    case "recruiter.reopened":
      return { ...base, what: "The request was reopened: it was not solved yet" };
    case "recruiter.access_granted":
      return { ...base, what: `An ITS recruiter was given access until ${shortDay(p.expiresAt)}` };
    case "recruiter.access_ended":
      return { ...base, what: "The ITS recruiter's access ended" };
    default:
      return { ...base, what: e.type.replace(/[._]/g, " ") };
  }
}

/** The whole history, newest first, with the repeated records left out. */
export function historyItems(timeline: readonly TimelineEvent[], extra: readonly TimelineEvent[] = []): HistoryItem[] {
  return [...timeline, ...extra]
    .map((e, i) => historyItem(e, i))
    .filter((x): x is HistoryItem => !!x)
    .sort((x, y) => Date.parse(y.when) - Date.parse(x.when));
}

/**
 * The escalation events about this candidate (recruiter help): requests and grants name the application, and every
 * other event of those escalations belongs with them.
 */
export function recruiterEventsFor(applicationId: string, events: ReadonlyArray<TimelineEvent & { subjectType?: string; subjectId?: string }>): TimelineEvent[] {
  const ids = new Set(events.filter((e) => (e.type === "recruiter.requested" || e.type === "recruiter.access_granted") && (e.payload as { applicationId?: unknown }).applicationId === applicationId && e.subjectId).map((e) => e.subjectId as string));
  return events.filter((e) => e.subjectType === "escalation" && e.subjectId && ids.has(e.subjectId));
}

/**
 * "The assistant suggested Y; you decided X" (plan A10): the latest suggestion and the first thing a person decided
 * after it, so a reader sees at once where the two differ. Null parts when there is none yet.
 */
export function suggestionAndDecision(timeline: readonly TimelineEvent[]): { suggested: string | null; decided: string | null; decidedBy: string | null } {
  const ordered = [...timeline].sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
  let at = -1;
  for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].type === "application.triaged" && ordered[i].payload.recommendation) { at = i; break; }
  if (at < 0) return { suggested: null, decided: null, decidedBy: null };
  const suggested = REC_LABEL[String(ordered[at].payload.recommendation)] ?? String(ordered[at].payload.recommendation).replace(/_/g, " ");
  for (const e of ordered.slice(at + 1)) {
    if (e.actor.kind !== "user" && e.actor.kind !== "recruiter") continue;
    const p = e.payload as Record<string, unknown>;
    let decided: string | null = null;
    if (e.type === "application.marked") decided = MARK_LABEL[p.mark as MarkKind] ?? null;
    else if (e.type === "application.rejected") decided = "Not moving forward";
    else if (e.type === "candidate.recommended") decided = "Interview";
    else if (e.type === "application.moved_to_talent_pool") decided = "Talent pool";
    else if (e.type === "human.override" && (p.action === "invite_screen" || p.action === "ask_in_screen")) decided = "Invite to a screening chat";
    else if (e.type === "human.override" && p.action === "override_eligibility") decided = "Keep them in";
    if (decided) return { suggested, decided, decidedBy: whoDid(e.actor) };
  }
  return { suggested, decided: null, decidedBy: null };
}
