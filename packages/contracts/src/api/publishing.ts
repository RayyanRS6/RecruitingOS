import { z } from "zod";
import type { PolicyLevel } from "../domain/policy";

/**
 * Approving and publishing a role (plan Wave D): the boards a role uses (Q11), its closing date (Q12), sharing (D8),
 * the legal check before approval (D5), what starts on its own once the role is live (D9) and the ITS posting tasks
 * (D3). The API builds these shapes and the web client reads them.
 */

/** The job boards a person may tick for a role (Q11). The careers page, Google and email are part of every open role. */
export const BoardChoice = z.enum(["linkedin_basic", "indeed", "ziprecruiter"]);
export type BoardChoice = z.infer<typeof BoardChoice>;

/** POST /roles/:id/channels: the ticked boards. Editable before and after approval. */
export const SetPublishChannels = z.object({ channels: z.array(BoardChoice).max(3) });
export type SetPublishChannels = z.infer<typeof SetPublishChannels>;

const CalendarDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.")
  .refine((d) => { const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; }, "That date does not exist.");

/**
 * POST /roles/:id/closing-date: the last day new applications are taken, in the company's time zone, or null to take
 * the date off. A later date also reopens applications that the earlier date stopped ("Extend the date").
 */
export const SetClosingDate = z.object({ closesOn: CalendarDate.nullable() });
export type SetClosingDate = z.infer<typeof SetClosingDate>;

/**
 * The ready-made places a job is shared to (D8), one tap each with its own tracked link: a referral from the team, a
 * school or training program, a community group, and the share buttons (email, text, WhatsApp, LinkedIn, Facebook, X).
 */
export const SharePlace = z.enum(["referral", "school", "community", "email", "text", "whatsapp", "linkedin", "facebook", "x"]);
export type SharePlace = z.infer<typeof SharePlace>;
export const CreateShareLink = z.object({ place: SharePlace });
export type CreateShareLink = z.infer<typeof CreateShareLink>;

/** The ITS posting tasks (D3): post the job on a board, bring a board up to date after an approved edit, take it down. */
export const PostingTaskKind = z.enum(["post_job", "update_job", "take_down_job"]);
export type PostingTaskKind = z.infer<typeof PostingTaskKind>;

/** "The board shows the new version now": recorded by the team or the ITS recruiter, with an optional note. */
export const ConfirmBoardUpdated = z.object({ note: z.string().trim().max(500).optional() });
export type ConfirmBoardUpdated = z.infer<typeof ConfirmBoardUpdated>;

/**
 * One thing the law asks of the job ad in the job's places (D5). `blocking` items stop approval until they are met;
 * `pendingCounsel` names places our lawyer has not confirmed yet (Washington DC, Rhode Island), which never block.
 */
export type LegalCheckItem = {
  key: "pay_range" | "benefits" | "closing_date";
  label: string;
  met: boolean;
  blocking: boolean;
  /** The places whose law asks for it (US-CO, ...); for a remote role, every place with such a law. */
  jurisdictions: string[];
  pendingCounsel: string[];
  /** What is wrong or what will happen, in plain words. */
  detail: string;
  /** How to fix it, in plain words; null when nothing is needed. */
  fix: string | null;
};
/** The legal check of a version (D5): `missing` are the blocking items not met, which POST /roles/:id/approve refuses with 409 `legal_check`. */
export type LegalCheck = { jurisdictions: string[]; remote: boolean; items: LegalCheckItem[]; missing: LegalCheckItem[] };

/** One line of "what starts on its own once the job is live" (D9), from the company's rules. */
export type AutoActionLine = { actionType: "message.send_templated" | "application.invite_screen"; level: PolicyLevel; text: string };
export type AutoActionsOnOpen = { lines: AutoActionLine[]; changeHref: string };

/**
 * The role's closing date (Q12). `closesAt` is the moment applications stop (the end of `closesOn` in `timeZone`);
 * `applyBy` is the line the job and careers pages show; `defaultIfMissing` is the date a Colorado (or remote) role gets
 * when it opens without one; `applicationsClosedByDate` says the date has passed and stopped applications.
 */
export type ClosingDateView = {
  closesOn: string | null;
  closesAt: string | null;
  applyBy: string | null;
  timeZone: string;
  requiredByLaw: boolean;
  defaultIfMissing: string | null;
  passed: boolean;
  applicationsClosedByDate: boolean;
};

/**
 * An ITS posting task as the role's Posting tab shows it: what it is, where it stands, who has it (a name only).
 * `notDone`: the recruiter closed it as not possible, and `note` says why in their words; the team can ask again
 * (POST /roles/:id/postings/:channel/ask-its) or do it from its own account.
 */
export type PostingTaskView = { id: string; kind: PostingTaskKind; status: string; label: string; recruiterName: string | null; createdAt: string; resolvedAt: string | null; notDone: boolean; note: string | null };

/**
 * Where publishing stands, for the screen right after approval (D2). Poll while `pollAfterSeconds` is a number:
 * `preparing` while the boards are being prepared, `ready` with `checksPending` while public addresses are being
 * checked; `waiting_for_company_check` until ITS confirms the company (founder decision B7).
 */
export type PublishingState = { state: "not_open" | "waiting_for_company_check" | "preparing" | "ready"; pollAfterSeconds: number | null; message: string; checksPending: number };

/** A board as the ticks show it: chosen, offered, and why not when it is not (ZipRecruiter needs the company's own plan). */
export type BoardChoiceView = { channel: BoardChoice; name: string; chosen: boolean; available: boolean; reason: string | null; inRolePlan: boolean };

/** A share button's address (D8): opened in a new tab or the phone's own app; no third-party script ever runs on our pages. */
export type ShareTarget = { key: "email" | "text" | "whatsapp" | "linkedin" | "facebook" | "x"; label: string; url: string };
export type SharePlaceView = { place: SharePlace; label: string; link: { id: string; url: string; visits: number } | null };
export type ShareView = { jobUrl: string; text: string; places: SharePlaceView[] };
