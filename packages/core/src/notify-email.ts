import { ALWAYS_EMAILED, ALWAYS_EMAILED_LINE, appPaths, oneLine, type NotificationKind } from "@ros/contracts";

/**
 * The words of the email that tells a person about an update. It says what kind of thing happened, at which company,
 * for which job, and links to it; nothing else. It never names a candidate or carries their details or a score: the
 * update's own title and body (which do) stay in the app, behind sign-in. Pure functions, so the words can be checked
 * without a database.
 */

/** What happened, per update kind, in words that name nobody. */
const HEADLINES: Record<NotificationKind, string> = {
  "screen.completed": "A candidate finished the AI interview",
  "screen.declined_by_candidate": "A candidate chose not to do the AI interview",
  "candidate.withdrawn": "A candidate withdrew",
  "candidate.unreachable": "An email to a candidate could not be delivered",
  "applications.closed": "A job stopped taking new applications",
  "applications.reopened": "A job is taking applications again",
  "role.edited_live": "A teammate changed a live job",
  "intake.taken_over": "A teammate took over a draft",
  "entitlement.more_applied": "More people applied to a job",
  "company.access_accepted": "Your request was approved",
  // Accept after "Take away access": nobody made a request, so the email says what the update says.
  "company.access_restored": "Your access is back",
  "company.plan_changed": "ITS changed your plan",
  "company.trial_started": "Your 30-day trial has started",
  "company.trial_extended": "ITS extended your trial",
  "company.trial_ending": "Your trial ends soon",
  "company.trial_ended": "Your trial has ended",
  "entitlement.ai_credit": "News about your plan's AI help",
  "entitlement.text_screens": "News about your plan's AI interviews",
  "member.left": "Someone left your team",
};

export function alertHeadline(kind: string): string {
  return HEADLINES[kind as NotificationKind] ?? "There is an update for you";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job an update's link points at (`/roles/<id>...`), if any. */
export function roleIdFromHref(href: string | null | undefined): string | null {
  const m = /^\/roles\/([^/?#]+)/.exec(href ?? "");
  return m && UUID.test(m[1]) ? m[1] : null;
}

/** Where an email's link goes: the update's own page in the app, or the list of updates when it has none. */
export function alertLink(appBaseUrl: string, href: string | null | undefined): string {
  const path = href?.startsWith("/") && !href.startsWith("//") ? href : appPaths.updates;
  return `${appBaseUrl.replace(/\/+$/, "")}${path}`;
}

/** Settings, where a person turns "Email me updates" on or off. */
export function notificationSettingsLink(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}${appPaths.settings}`;
}

function greeting(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : "Hi,";
}

/** Said in every email about an update. */
export const ALERT_PRIVACY_LINE = "Candidate names and details are never put in emails; you will see them once you sign in.";

export type AlertEmailInput = {
  kind: string;
  recipientName: string | null;
  companyName: string;
  roleTitle: string | null;
  /** The update's own page, absolute. */
  link: string;
  appBaseUrl: string;
};

/**
 * The email for one update: what happened, the company, the job if there is one, the link, and why this person gets
 * it (an account notice is always emailed; anything else because their "Email me updates" is on, with where to turn it
 * off).
 */
export function renderAlertEmail(input: AlertEmailInput): { subject: string; text: string } {
  const headline = alertHeadline(input.kind);
  const why = ALWAYS_EMAILED.has(input.kind as NotificationKind)
    ? ALWAYS_EMAILED_LINE
    : `You get this email because "Email me updates" is on. Turn it off in Settings: ${notificationSettingsLink(input.appBaseUrl)}`;
  const lines = [
    greeting(input.recipientName),
    "",
    `${headline}.`,
    "",
    `Company: ${oneLine(input.companyName, 120)}`,
    ...(input.roleTitle ? [`Job: ${input.roleTitle}`] : []),
    `Open it: ${input.link}`,
    "",
    ALERT_PRIVACY_LINE,
    "",
    why,
  ];
  return { subject: input.roleTitle ? `${headline}: ${input.roleTitle}` : headline, text: lines.join("\n") };
}
