import { z } from "zod";
import { RecordDecision } from "../domain/interview";

/**
 * Interviews to hire (plan Wave H): the record-only "Offer made", the hire sheet, private team notes and the one-step
 * interview from a suggestion. The app never writes, sends or changes an offer (founder decision Q29); every record
 * names the person who made it.
 */

/** A calendar date (YYYY-MM-DD) that exists. */
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01").refine((d) => { const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; }, "That date does not exist");

/**
 * POST /applications/:id/offer: a person records that an offer was made to a finalist outside the app (Q29). `madeOn`:
 * when it was made (today when left out). No term of the offer is kept and nothing is sent to the candidate.
 */
export const RecordOfferMade = z.object({ confirm: z.literal(true, { message: "Confirm that the offer was made." }), madeOn: CalendarDate.optional(), note: z.string().trim().max(2000).optional() }).strict();
export type RecordOfferMade = z.infer<typeof RecordOfferMade>;

/** What POST /applications/:id/offer answers: the offer is recorded, the candidate was not written to, and what comes next. */
export type OfferMadeResult = { ok: true; stage: "offer_sent"; offerId: string; madeOn: string; candidateNotice: "not_told"; statement: string; next: string };

/**
 * The decision after an interview, with the hire's dates: "hired" records the hire through the outcome service (plan H1)
 * and needs the start date (`hireDate`); `offerAcceptedAt` is optional.
 */
export const RecordInterviewDecision = RecordDecision.extend({ hireDate: CalendarDate.optional(), offerAcceptedAt: CalendarDate.optional() });
export type RecordInterviewDecision = z.infer<typeof RecordInterviewDecision>;

/**
 * What follows a hire (POST /applications/:id/outcome with hired_externally, and the "hired" decision after an
 * interview): the people still in the running for the role, to keep warm until the start date (`backups`), and closing
 * the role in the same sheet (`closeRole`: POST to `path` with `{ outcome: "filled", confirm: true }`), null once closed.
 */
export type HireFollowUp = {
  startDate: string | null;
  backups: { count: number; people: Array<{ applicationId: string; name: string; stageLabel: string }> };
  closeRole: { path: string; outcome: "filled"; stillInProcess: number; words: string } | null;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Private team notes (founder decision Q24; plan H3).                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** The prompt a note was started from, if any. */
export const NoteStarter = z.enum(["before_interview", "after_interview", "for_and_against"]);
export type NoteStarter = z.infer<typeof NoteStarter>;
export const NOTE_STARTER: Record<NoteStarter, { label: string; prompt: string }> = {
  before_interview: { label: "Before the interview", prompt: "What do you want to find out?" },
  after_interview: { label: "After the interview", prompt: "How did it go? What did you see and hear?" },
  for_and_against: { label: "For and against", prompt: "What speaks for them, and what gives you pause?" },
};
export const NOTE_BODY_MAX = 5000;
/** Said under every list of notes. */
export const NOTES_PRIVACY_LINE = "Private to your hiring team. The candidate never sees notes, and they are never given to the AI assistant.";

/** PUT /applications/:id/notes/mine: the person's own note on this candidate (one each), written or changed. */
export const WriteNote = z.object({ starter: NoteStarter.nullable().optional(), body: z.string().trim().min(1, "Write the note first.").max(NOTE_BODY_MAX) }).strict();
export type WriteNote = z.infer<typeof WriteNote>;

/** One earlier version of a note: the words a later sitting replaced, and when they were last saved. */
export type NoteVersion = { body: string; starter: NoteStarter | null; at: string };
/**
 * Changes saved within this many minutes of the last save belong to the same sitting and make one version (autosave
 * saves whenever typing pauses); a change after a longer pause keeps the words it replaces as an earlier version.
 */
export const NOTE_VERSION_SITTING_MINUTES = 15;
/** At most this many earlier versions are kept per note; the oldest go first. */
export const NOTE_VERSIONS_KEPT = 20;

/** A note. `previousVersions`: its earlier versions, oldest first, on the reader's own note only. */
export type NoteView = { id: string; applicationId: string; author: { userId: string; name: string }; mine: boolean; starter: NoteStarter | null; starterLabel: string | null; body: string; createdAt: string; updatedAt: string; edited: boolean; previousVersions?: NoteVersion[] };

/**
 * GET /applications/:id/notes: the notes this person may read (everyone's, or only their own for an interviewer:
 * `canRead`), their own note, whether they may write one (with the reason when not) and the starters on offer.
 */
export type NotesView = { notes: NoteView[]; mine: NoteView | null; canRead: "all" | "own"; canWrite: boolean; writeBlockedReason: string | null; starters: Array<{ id: NoteStarter; label: string; prompt: string }>; privacy: string };

/* ------------------------------------------------------------------------------------------------------------ */
/* One-step interview from a suggestion (plan H4).                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The interview approval card filled in (GET /applications/:id/interview-draft, and `interviewDraft` when "Yes,
 * interview" approves the assistant's suggestion): the round, who interviews (the plan's people who are still active
 * members), the meeting link and the scheduling window. Posting it to `requestPath` is the one approval.
 */
export type InterviewDraft = {
  applicationId: string; roleId: string; roundKey: string; roundTitle: string; durationMinutes: number; format: string;
  interviewerUserIds: string[]; linkSource: "calendar"; window: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean };
  requestPath: string; nextRound: boolean;
};
