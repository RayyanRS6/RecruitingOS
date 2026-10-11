import { z } from "zod";

/**
 * Email alerts and the full history of a person's updates (plan B3). Every update lands in the app; these settings
 * choose, per group of updates, whether the person also hears about it by email: as it happens, in a summary each
 * morning or each Monday morning, or not at all. A few updates are always emailed at once and cannot be turned off
 * (NOTIFY_ALWAYS in packages/core/src/notify-groups.ts). No email ever names a candidate or carries their details:
 * the role's name and a link only.
 */
export const NOTIFY_CADENCES = ["immediate", "daily", "weekly", "off"] as const;
export const NotifyCadence = z.enum(NOTIFY_CADENCES);
export type NotifyCadence = z.infer<typeof NotifyCadence>;

/** The groups the updates are sorted into, in the order Setup lists them. */
export const NOTIFY_GROUPS = ["approvals", "candidates", "interviews", "stuck", "recruiter", "messages", "account"] as const;
export const NotifyGroup = z.enum(NOTIFY_GROUPS);
export type NotifyGroup = z.infer<typeof NotifyGroup>;

/** PUT /notifications/preferences: the groups to change; every other group keeps its setting. */
export const UpdateNotificationPreferences = z
  .object({ preferences: z.array(z.object({ group: NotifyGroup, cadence: NotifyCadence }).strict()).min(1).max(NOTIFY_GROUPS.length) })
  .strict();
export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferences>;

/** One group as Setup shows it: what it covers, how often it is emailed now, and the product's default. */
export type NotificationPreferenceView = { group: NotifyGroup; label: string; description: string; cadence: NotifyCadence; defaultCadence: NotifyCadence };

/** GET and PUT /notifications/preferences. */
export type NotificationPreferencesView = {
  groups: NotificationPreferenceView[];
  /** Updates that are always emailed at once, whatever the groups say, each with the reason. */
  alwaysSent: Array<{ label: string; why: string }>;
  /** When summaries arrive: the local hour in the company's time zone; weekly summaries on `weekday`. */
  digest: { timezone: string; hour: number; weekday: string };
  /** The address the emails go to. */
  email: string;
};

/** POST /notifications/unread: put updates back to unread. */
export const MarkNotificationsUnread = z.object({ ids: z.array(z.string()).min(1).max(200) }).strict();
/**
 * POST /notifications/read-all: every unread update that existed when the list was loaded (`upTo`, the page's `asOf`),
 * never one that arrived after it, so nothing is marked read that nobody has seen.
 */
export const MarkAllNotificationsRead = z.object({ upTo: z.iso.datetime({ offset: true }) }).strict();

/** GET /notifications/history: all or only unread, newest first; `before` is the id of the last update already shown. */
export const NotificationHistoryQuery = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * One update in the history, with the group it belongs to and when it went out by email (null when it never did: the
 * person's settings kept it in the app, or it came before email alerts existed).
 */
export type NotificationView = { id: string; kind: string; group: NotifyGroup; groupLabel: string; title: string; body: string; action: { label: string; href: string } | null; readAt: string | null; emailedAt: string | null; createdAt: string };

/** GET /notifications/history. `nextBefore` is null on the last page; `asOf` is when the page was read (for read-all). */
export type NotificationHistoryPage = { items: NotificationView[]; nextBefore: string | null; unreadCount: number; asOf: string };
