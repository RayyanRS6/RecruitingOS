import { z } from "zod";
import { Location } from "../domain/common";
import { isOwnerOrAdmin, type MembershipRole } from "../domain/company";
import { INTAKE_ESSENTIALS, INTAKE_ESSENTIAL_LABEL, INTAKE_FIRST_MESSAGE_MAX, INTAKE_MESSAGE_MAX, type IntakeEssentialKey, type IntakeQuestionField, type IntakeRefusal, type IntakeSessionSummary, type IntakeSessionView, type PlanRoom } from "../domain/intake";
import { POST_TEXT_MAX, type ClosingDateView, type JobUrls, type LegalCheck, type PostChannel, type PostsState, type PublishCheck } from "../domain/publishing";
import { CompensationBasis, EmploymentType, RemotePolicy, type PacketFlag, type RolePacket } from "../domain/role-packet";
import { Importance } from "../domain/score";
import type { CandidateTab, RoleStatus } from "../domain/stages";
import { TRIAL_ENDED_LINE } from "../domain/trial";

/**
 * The job builder, a job's page (its Job and Share tabs), the Jobs list and Home: what the API takes and answers.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The job builder.                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/** POST /api/v1/intake/sessions: a draft starts with its first message, the idea in a sentence or a pasted job ad (up to 20,000 characters). The words never travel in a URL. */
const DESCRIBE_FIRST = "Describe the job first: a sentence or two, or paste a job ad you already have.";
export const StartIntake = z.object({ initialMessage: z.string({ error: DESCRIBE_FIRST }).trim().min(1, DESCRIBE_FIRST).max(INTAKE_FIRST_MESSAGE_MAX) });
export type StartIntake = z.infer<typeof StartIntake>;

/** POST /api/v1/intake/sessions/:id/messages: one more message from the owner. */
export const IntakeMessageRequest = z.object({ message: z.string().trim().min(1).max(INTAKE_MESSAGE_MAX) });
export type IntakeMessageRequest = z.infer<typeof IntakeMessageRequest>;

const Money = z.number().nonnegative().max(10_000_000);

/** One answered question card: ticked offered values, the owner's own words, a skip, or the pay card's figures (a person setting the pay confirms it). */
export const IntakeAnswer = z.object({
  questionId: z.string().min(1).max(60),
  selected: z.array(z.string().max(500)).max(8).default([]),
  own: z.array(z.string().trim().min(1).max(500)).max(6).default([]),
  skipped: z.boolean().default(false),
  pay: z.object({ basis: CompensationBasis, min: Money, max: Money }).optional(),
});
export type IntakeAnswer = z.infer<typeof IntakeAnswer>;

/**
 * POST /api/v1/intake/sessions/:id/answers: the answers to the open cards and any words typed beside them. The server
 * writes one short summary to the conversation and asks the assistant for the next turn.
 */
export const IntakeAnswersRequest = z.object({
  answers: z.array(IntakeAnswer).min(1, "Answer a question first.").max(3),
  note: z.string().trim().max(INTAKE_MESSAGE_MAX).optional(),
});
export type IntakeAnswersRequest = z.infer<typeof IntakeAnswersRequest>;

/** Keep a flagged phrase, with the reason. It is recorded with who kept it and when. */
export const KeepPacketFlag = z.object({ flagId: z.string().min(1).max(300), reason: z.string().trim().min(5, "Say why in a few words (at least five characters).").max(500) });
export type KeepPacketFlag = z.infer<typeof KeepPacketFlag>;

/**
 * How each question card's answer is named in the one-line summary of tapped answers ("Where the job is: Austin, TX"):
 * the words the server writes into the conversation, and the words the page shows at once, before the server's copy of
 * the message arrives. A fact that is one of the job's essentials takes its name from the essentials' own table
 * (`INTAKE_ESSENTIAL_LABEL`), so the checklist and the summary call it the same. That table has no name for the other
 * three (how the pay is counted, the deal-breakers, the benefits), and names the must-haves as a checklist line ("At
 * least one must-have"), not as the list a summary gives, so those four are named here.
 */
export const INTAKE_FIELD_LABEL: Readonly<Record<IntakeQuestionField, string>> = {
  title: INTAKE_ESSENTIAL_LABEL.title,
  location: INTAKE_ESSENTIAL_LABEL.location,
  remote_policy: INTAKE_ESSENTIAL_LABEL.remote_policy,
  employment_type: INTAKE_ESSENTIAL_LABEL.employment_type,
  schedule: INTAKE_ESSENTIAL_LABEL.schedule,
  compensation: INTAKE_ESSENTIAL_LABEL.compensation_range,
  compensation_basis: "Paid",
  must_haves: "Must-haves",
  deal_breakers: "Deal-breakers",
  benefits: "Benefits",
};

/**
 * The assistant's turn as the builder reads it, or what went wrong and what to do next. On a failure `upgrade` is true
 * when the plan's AI help is used up: the way on is the request about the plan, not trying again. `ask`: that request's
 * button and the words it sends; null when nothing is used up, or for someone who may not ask. `unavailable`: true when
 * the AI provider itself is the problem (it refuses our account, or it is not answering): trying again at once would not
 * help, an administrator has been alerted, and `recovery` is the whole sentence to show, exactly as it is.
 */
export type IntakeTurnReply = { assistantMessage: string; takenFromAd: string[]; notARole: boolean } | { error: string; recovery: string; upgrade: boolean; ask: { label: string; reason: string } | null; unavailable?: boolean };

/**
 * A draft in an answer of the job builder's routes: the draft, and beside it the company's time zone. `timeZone` is the
 * one "today" is counted in for the closing date chosen on a draft, as the server checks that date (never the device's
 * own zone). Every answer that carries a draft carries both.
 */
export type IntakeDraftAnswer = { session: IntakeSessionView; timeZone: string };

/** POST /api/v1/intake/sessions: the new draft and its first turn; `session` is null when the message was not about hiring someone. */
export type IntakeStartResponse = (IntakeDraftAnswer | { session: null }) & { notARole: boolean; reply: IntakeTurnReply };
/** POST .../messages and .../answers: the draft as it now stands, the next turn, anything refused by the fairness check, and the summary of what was taken. */
export type IntakeTurnResponse = IntakeDraftAnswer & { reply: IntakeTurnReply; refused: IntakeRefusal[]; summary: string[] };
/** GET /api/v1/intake/sessions/:id, and every builder answer that changes the draft without a turn. */
export type IntakeSessionResponse = IntakeDraftAnswer;
/**
 * One line of the drafts list as the routes answer it (GET /api/v1/intake/sessions, and Home): the summary, and
 * `payConfirmed`, whether a person has set or confirmed the pay the draft states. With `missing` it says what the draft
 * still needs (`draftStillNeeds`), so a draft's line and the builder count the same things.
 */
export type IntakeDraftSummary = IntakeSessionSummary & { payConfirmed: boolean };

/** GET /api/v1/intake/sessions: the drafts this person may continue, and the plan's room for another job. */
export type IntakeSessionList = { sessions: IntakeDraftSummary[]; room: PlanRoom };

/**
 * What a draft still needs before its job can be written: the one meaning of "still needed", for the builder's list and
 * for a draft's line in a list. The essentials that are missing (`missing`, the server's own list), and the pay while it
 * is stated and no person has confirmed it: a range read from a pasted ad counts only once someone confirms it on the
 * pay card. In the essentials' own order.
 */
export function draftStillNeeds(draft: { missing: readonly IntakeEssentialKey[]; payConfirmed: boolean }): IntakeEssentialKey[] {
  const payWaits = !draft.payConfirmed && !draft.missing.includes("compensation_range");
  return INTAKE_ESSENTIALS.filter((key) => draft.missing.includes(key) || (payWaits && key === "compensation_range"));
}

/**
 * A draft's title, the one rule for every place that shows it: the builder's heading, the draft's line on Home and on
 * the Jobs page, and the notice that a draft was taken over. Once the job has been written, the written job's title
 * (a person may have changed it in the editor); before that, the title from the answers. Null while neither names one,
 * which a page shows as "Untitled job".
 */
export function draftTitleOf(draft: { facts: { title?: string | null }; draft?: { identity: { title?: string | null } } | null }): string | null {
  return draft.draft?.identity.title?.trim() || draft.facts.title?.trim() || null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The one editor.                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

const ItemKey = z.string().trim().min(1).max(100);
const EditedRequirement = z.object({ key: ItemKey.optional(), text: z.string().trim().min(1, "Write the requirement first.").max(300) }).strict();
const EditedSkill = z.object({ key: ItemKey.optional(), name: z.string().trim().min(1, "Name the skill first.").max(120), importance: Importance, definition: z.string().trim().max(400).optional() }).strict();
const EditedScreeningQuestion = z.object({ key: ItemKey.optional(), question: z.string().trim().min(1, "Write the question first.").max(500), modelAnswer: z.string().trim().max(600).optional() }).strict();
const EditedQuestionWords = { key: ItemKey.optional(), question: z.string().trim().min(3, "Write the question (at least three letters).").max(300), help: z.string().trim().max(200).optional(), required: z.boolean().optional() };
const EditedFormQuestion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yes_no"), ...EditedQuestionWords }).strict(),
  z.object({ kind: z.literal("choice"), ...EditedQuestionWords, options: z.array(z.string().trim().min(1).max(80)).max(20) }).strict(),
  z.object({ kind: z.literal("number"), ...EditedQuestionWords, unit: z.string().trim().max(30).optional(), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
]);

/**
 * PATCH /api/v1/roles/:id/packet: the one editor of a job. It mirrors the job record's sections; only what is sent
 * changes, and everything else is copied from `baseVersion`, which must still be the newest version (someone else may
 * have saved since). A list is sent whole, in order: adding, removing and reordering are one list. An item keeps its
 * `key` when it is the same item. What the editor does not carry (a must-have's `rationale`, a skill's `indicators`, a
 * question's `kind`) was written for the item's words: it is kept while those words are untouched, and when they change
 * the rationale and the indicators go and the kind is worked out again from the new words (`applyFieldEdit`). A new item
 * has no key. Counts (one to six must-haves, three to twelve AI interview
 * questions, at most ten form questions, two to eight choices) are checked on the server and refused in plain words.
 *
 * Saving an open or paused job makes a new version that is live at once. Pay set here counts as a person confirming it.
 * Wording the fairness guard flags refuses the save (422 `packet_flags`) until it is changed or kept with a reason in
 * `keepFlags`; a form question that asks about a protected characteristic is always refused (422 `question_not_allowed`).
 * `screening` is the AI interview; `formQuestions` are the application form's questions ("Screening questions" on screen).
 */
export const PacketFieldEdit = z.object({
  baseVersion: z.number().int().min(1),
  identity: z.object({
    title: z.string().trim().min(2).max(160),
    department: z.string().trim().max(120).nullable(),
    locations: z.array(Location).min(1).max(20),
    employmentType: EmploymentType,
    schedule: z.string().trim().max(300).nullable(),
    remotePolicy: RemotePolicy,
  }).partial().strict().optional(),
  compensation: z.object({ basis: CompensationBasis, min: Money, max: Money, discloseRange: z.boolean(), benefitsSummary: z.string().trim().max(2000).nullable() }).partial().strict().optional(),
  /** The job description candidates read. */
  description: z.string().trim().min(50, "The job description needs at least 50 characters.").max(20_000).optional(),
  requirements: z.object({ mustHaves: z.array(EditedRequirement).max(20), niceToHaves: z.array(EditedRequirement).max(20) }).partial().strict().optional(),
  /** The skills the CV score counts beside the must-haves. */
  competencies: z.array(EditedSkill).max(20).optional(),
  screening: z.object({ questions: z.array(EditedScreeningQuestion).max(30), maxMinutes: z.number().int().min(5).max(30) }).partial().strict().optional(),
  formQuestions: z.array(EditedFormQuestion).max(30).optional(),
  keepFlags: z.array(KeepPacketFlag).max(20).optional(),
  changeSummary: z.string().trim().min(1).max(500).optional(),
}).strict();
export type PacketFieldEdit = z.infer<typeof PacketFieldEdit>;

/**
 * PATCH /api/v1/intake/sessions/:id/draft: the same editor on a job that is written and not published yet. A draft has
 * no versions, so there is no `baseVersion`. The edit is always saved; wording the fairness guard flags is listed on the
 * draft (`IntakeSessionView.flags`) and holds publishing until it is changed, or kept with
 * POST /api/v1/intake/sessions/:id/flags/keep, so there is no `keepFlags` either.
 */
export const DraftFieldEdit = PacketFieldEdit.omit({ baseVersion: true, keepFlags: true });
export type DraftFieldEdit = z.infer<typeof DraftFieldEdit>;

/** One refused part of a form question, as the 422 `question_not_allowed` answer lists them (`details.problems`). */
export type FormQuestionRefusal = { index: number; key: string | null; part: "question" | "help" | "option"; rule: string; text: string; reason: string; alternative: string; words: string };

/** What saving the draft answers. `guardChanges`: what the fairness guard fixed by rule on saving, in plain words. */
export type DraftSaved = IntakeDraftAnswer & { guardChanges: string[] };

/* ------------------------------------------------------------------------------------------------------------ */
/* Jobs.                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * How many people a job has in each tab of its Candidates list. `total` counts everyone who applied, the people past
 * the plan's candidates per job among them; `locked` is how many those are; no tab counts them.
 */
export type CandidateCounts = { total: number; byTab: Record<CandidateTab, number>; locked: number };

/** What can be done with a job. `publish` appears only on a draft; `pause` on an open job; `resume` on a paused one. */
export const RoleActionKey = z.enum(["edit", "publish", "pause", "resume", "set_closing_date", "close"]);
export type RoleActionKey = z.infer<typeof RoleActionKey>;
export const ROLE_ACTION_LABEL: Record<RoleActionKey, string> = { edit: "Edit", publish: "Publish job", pause: "Pause", resume: "Resume", set_closing_date: "Closing date", close: "Close job" };
/** One action as a job's page carries it: its button's words, whether it may be pressed now, and why not. */
export type RoleActionState = { action: RoleActionKey; label: string; allowed: boolean; reason: string | null };

export const ROLE_ACTION_BLOCKED = {
  closed: "This job is closed, so it is not changed any more. Start a new job to hire again.",
  ownerOrAdmin: "Only an owner or an admin can do this.",
  trialEnded: TRIAL_ENDED_LINE,
} as const;

/**
 * The actions of a job for the person looking at it, in the order the buttons are shown, each allowed or not with the
 * reason. Everyone on the team edits and publishes; an owner or an admin also pauses, resumes, sets the closing date and
 * closes. Whether a draft may be published now is `RoleDetail.publish`, which lists every check.
 */
export function roleActions(f: { status: RoleStatus; role: MembershipRole; trialEnded: boolean }): RoleActionState[] {
  const state = (action: RoleActionKey, reason: string | null = null): RoleActionState => ({ action, label: ROLE_ACTION_LABEL[action], allowed: reason === null, reason });
  if (f.status === "closed") return [state("edit", ROLE_ACTION_BLOCKED.closed)];
  const manages = isOwnerOrAdmin(f.role) ? null : ROLE_ACTION_BLOCKED.ownerOrAdmin;
  const out: RoleActionState[] = [state("edit")];
  if (f.status === "draft") out.push(state("publish", f.trialEnded ? ROLE_ACTION_BLOCKED.trialEnded : null));
  if (f.status === "open") out.push(state("pause", manages));
  if (f.status === "paused") out.push(state("resume", manages ?? (f.trialEnded ? ROLE_ACTION_BLOCKED.trialEnded : null)));
  out.push(state("set_closing_date", manages), state("close", manages));
  return out;
}

/** One job on the Jobs list (GET /api/v1/roles). Every time is ISO. */
export type RoleSummary = {
  id: string;
  title: string;
  /** Where the job is, in words: its first place ("Tustin, CA"); null when it names none. */
  place: string | null;
  status: RoleStatus;
  statusLabel: string;
  createdAt: string;
  /** When it was published; null for a draft. */
  openedAt: string | null;
  closedAt: string | null;
  /** Whole days since it was published; null for a draft. */
  daysOpen: number | null;
  /** The latest of its own changes and its newest application. */
  lastActivityAt: string;
  /** The last day applications are taken (YYYY-MM-DD), or null. */
  closesOn: string | null;
  /** False when its closing date has passed, or while it is not open. */
  acceptingApplications: boolean;
  counts: CandidateCounts;
};

/**
 * A job's page (GET /api/v1/roles/:id): the Job tab reads `packet`, the Candidates tab reads `counts` and then
 * GET /api/v1/roles/:id/applications, the Share tab reads GET /api/v1/roles/:id/share.
 */
export type RoleDetail = RoleSummary & {
  /** The live version's number. */
  version: number | null;
  /** The job record of that version: the description, the facts, the requirements, the skills, the form's questions and the AI interview's questions. */
  packet: RolePacket | null;
  /** Whether candidates see the pay range, and whether a pay transparency law is why. */
  payShown: boolean;
  payRequiredByLaw: boolean;
  closingDate: ClosingDateView;
  /** What the law of the job's places asks of the ad, for the version shown. */
  legalCheck: LegalCheck | null;
  /** The wording flags on that version: on a published job each one was kept, with who kept it and why. */
  flags: PacketFlag[];
  urls: JobUrls;
  /** The job page is public now: the job is open or paused. */
  public: boolean;
  /** For a draft: whether it may be published now, and each reason when not. Null once published. */
  publish: PublishCheck | null;
  actions: RoleActionState[];
};

/** POST /api/v1/roles/:id/pause and /resume: an optional reason, kept in the job's history. */
export const RoleStatusChange = z.object({ reason: z.string().trim().max(500).optional() });
export type RoleStatusChange = z.infer<typeof RoleStatusChange>;

/** POST /api/v1/roles/:id/close: closing is for good, so it is confirmed. Nobody is told anything by a close. */
export const CloseRole = z.object({ confirm: z.literal(true, { message: "Confirm closing the job." }) }).strict();
export type CloseRole = z.infer<typeof CloseRole>;

/** What saving an edit to a job answers: the job as it now stands, and what the fairness guard fixed by rule. */
export type PacketSaved = { role: RoleDetail; guardChanges: string[] };

/**
 * What publishing answers (POST /api/v1/intake/sessions/:id/publish, POST /api/v1/roles/:id/publish): the job, open.
 * Its LinkedIn and Indeed posts are written in the background; the Share tab shows them when they are ready.
 */
export type PublishResult = { ok: true; roleId: string; version: number; urls: JobUrls };

/** POST /api/v1/roles/:id/closing-date. `reopened`: a later date took applications again. */
export type ClosingDateAnswer = { ok: true; reopened: boolean; closingDate: ClosingDateView };

/* ------------------------------------------------------------------------------------------------------------ */
/* A job's Share tab.                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/** One post on the Share tab: the words (null until written), and the Apply link that post should carry. */
export type SharePost = { channel: PostChannel; label: string; text: string | null; edited: boolean; writtenAt: string | null; applyUrl: string };

/**
 * GET /api/v1/roles/:id/share. `jobUrl`: the Apply link, the job page's address. `state` says where the writing of the
 * posts stands, null on a job never published; ask again every few seconds while it is `writing`. `stateLine`: the plain
 * line to show for `no_ai` and `failed`, null otherwise. `public`: false while the job page cannot be opened by
 * candidates, with `notPublicLine` saying why (a draft, or a closed job).
 */
export type ShareView = { roleId: string; jobUrl: string; public: boolean; notPublicLine: string | null; state: PostsState | null; stateLine: string | null; posts: SharePost[] };

/** PUT /api/v1/roles/:id/share/:channel: a person's own words for one post. An automatic rewrite never replaces them. */
export const EditPost = z.object({ text: z.string().trim().min(1, "Write the post first.").max(POST_TEXT_MAX) }).strict();
export type EditPost = z.infer<typeof EditPost>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Home.                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** One open or paused job on Home: how many are new to review and how many finished the AI interview. */
export type HomeJob = { id: string; title: string; status: RoleStatus; statusLabel: string; toReview: number; interviewed: number; applicants: number };

/**
 * A line above everything on Home: the trial ending or ended, the plan's AI help at 80% or used up. `upgrade`: offer the
 * Upgrade request with it. `ask`: that request's button words and the reason to send with POST /api/v1/plans/request;
 * null when the notice offers none, or this person may not ask.
 */
export type HomeNotice = { kind: "trial_ending" | "trial_ended" | "ai_help_warning" | "ai_help_used_up"; title: string; body: string; upgrade: boolean; ask: { label: string; reason: string } | null };

/**
 * GET /api/v1/home: the open and paused jobs, the one with the most to review first; this person's unfinished drafts;
 * the plan's room for another job, for the start-a-hire box; and the notices.
 */
export type HomeView = { jobs: HomeJob[]; drafts: IntakeDraftSummary[]; room: PlanRoom; notices: HomeNotice[] };
