import { z } from "zod";

/**
 * Updates: what happened that a person on a team should know. Every update lands in the app's Updates page. One switch
 * per person, "Email me updates" (on by default), says whether they are also emailed as they happen; an email's
 * unsubscribe link turns the switch off. Account notices (the company's access, its plan and trial, the plan's AI help,
 * someone leaving the team) are always emailed, whatever the switch says. No email names a candidate or carries their
 * details: the job's name and a link only.
 */
export const NotificationKind = z.enum([
  // Candidates: someone sent their AI interview answers, chose not to do the AI interview, withdrew, or an email to them could not be delivered.
  "screen.completed",
  "screen.declined_by_candidate",
  "candidate.withdrawn",
  "candidate.unreachable",
  // Jobs: the closing date stopped applications, or a later date took them again; a teammate changed a live job or took over a draft.
  "applications.closed",
  "applications.reopened",
  "role.edited_live",
  "intake.taken_over",
  // More people applied than the plan lets the team read.
  "entitlement.more_applied",
  // The account, always emailed.
  "company.access_accepted",
  "company.access_restored",
  "company.plan_changed",
  "company.trial_started",
  "company.trial_extended",
  "company.trial_ending",
  "company.trial_ended",
  "entitlement.ai_credit",
  "entitlement.text_screens",
  "member.left",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds emailed whatever the person's switch says. */
export const ALWAYS_EMAILED: ReadonlySet<NotificationKind> = new Set([
  "company.access_accepted",
  "company.access_restored",
  "company.plan_changed",
  "company.trial_started",
  "company.trial_extended",
  "company.trial_ending",
  "company.trial_ended",
  "entitlement.ai_credit",
  "entitlement.text_screens",
  "member.left",
]);

/** Whether an update of this kind is emailed to a person: always for an account notice, otherwise as their switch says. */
export function emailsUpdate(kind: string, emailUpdates: boolean): boolean {
  return ALWAYS_EMAILED.has(kind as NotificationKind) || emailUpdates;
}

/** The one line Settings shows under the switch. */
export const ALWAYS_EMAILED_LINE = "Notices about your account, your plan and your team are always emailed.";

/**
 * GET and PUT /api/v1/notifications/preferences: the person's one choice, and the address the emails go to.
 */
export type NotificationPreferences = { emailUpdates: boolean; email: string; alwaysEmailedLine: string };
export const UpdateNotificationPreferences = z.object({ emailUpdates: z.boolean() }).strict();
export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferences>;

/** POST /api/v1/notifications/read and /unread: mark these updates read, or put them back to unread. */
export const MarkNotificationsRead = z.object({ ids: z.array(z.string()).min(1).max(200) });
export const MarkNotificationsUnread = z.object({ ids: z.array(z.string()).min(1).max(200) }).strict();
/**
 * POST /api/v1/notifications/read-all: every unread update that existed when the list was loaded (`upTo`, the page's
 * `asOf`), never one that arrived after it, so nothing is marked read that nobody has seen.
 */
export const MarkAllNotificationsRead = z.object({ upTo: z.iso.datetime({ offset: true }) }).strict();
/** What the three answer. */
export type NotificationsMarked = { ok: true; marked: number };

/** GET /api/v1/notifications/history: all or only unread, newest first; `before` is the id of the last update already shown. */
export const NotificationHistoryQuery = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * One update. `kind` is a `NotificationKind` for every update made now; one stored earlier may carry a kind that is
 * gone, and is still listed with its words. `action`: the page it opens; null when there is none, or when the page it
 * pointed at no longer exists. `emailedAt`: when it went out by email, null when it never did.
 */
export type NotificationView = { id: string; kind: string; title: string; body: string; action: { label: string; href: string } | null; readAt: string | null; emailedAt: string | null; createdAt: string };

/** GET /api/v1/notifications/history. `nextBefore` is null on the last page; `asOf` is when the page was read (for read-all). */
export type NotificationHistoryPage = { items: NotificationView[]; nextBefore: string | null; unreadCount: number; asOf: string };
