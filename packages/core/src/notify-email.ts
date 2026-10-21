import { NOTIFY_GROUPS, type NotifyGroup } from "@ros/contracts";
import { NOTIFY_ALWAYS, NOTIFY_GROUP_INFO, notifyGroupOf } from "./notify-groups";

/**
 * The words of alert emails and summaries (plan B3). An email says what kind of thing happened, at which company, for
 * which role, and links to it; nothing else. It never names a candidate or carries their details, an ITS recruiter's
 * answer, a ranking or a score: the update's own title and body (which do) stay in the app, behind sign-in. Pure
 * functions, so the words can be checked without a database.
 */

/** What happened, per update kind, in words that name nobody. */
const HEADLINES: Record<string, string> = {
  "approval.requested": "A role is waiting for your approval",
  "role.sent_back": "A role was sent back to draft",
  "message.approval_requested": "A message to a candidate is waiting for your approval",
  "candidate.recommended": "A candidate is ready for your decision",
  "application.ready": "A candidate is ready for an AI interview",
  "application.needs_review": "A candidate needs a closer look",
  "application.assessment_unavailable": "An application needs your review",
  "application.ineligible_hold": "Someone is waiting for your eligibility decision",
  "application.ineligible_review_due": "Someone is still waiting for your eligibility decision",
  "application.email_held": "An application sent by email is waiting",
  "screen.completed": "A candidate finished the AI interview",
  "screen.expired": "A candidate did not answer an AI interview invitation",
  "screen.invited": "A candidate was invited to an AI interview",
  "screen.human_requested": "A candidate asked to talk to a person",
  "candidate.withdrawn": "A candidate withdrew",
  "message.received": "A candidate wrote back",
  "interview.assigned": "You have a new interview to do",
  "interview.reminder": "You have an interview coming up",
  "interview.decision": "An interview is over and needs your decision",
  "interview.outcome": "Tell us whether an interview took place",
  "interview.cancelled": "An interview was cancelled",
  "interview.rescheduled": "A candidate asked to move an interview",
  "interview.reschedule_limit": "A candidate wants to move an interview again",
  "interview.accessibility": "A candidate asked for an accommodation for an interview",
  "interview.declare_availability": "Tell us when you can interview",
  "interview.no_availability": "Interview times cannot be offered yet",
  "interview.no_slots": "There are no shared free times for an interview",
  "interview.none_work": "A candidate asked for other interview times",
  "interview.unreachable": "A candidate cannot be reached about interview times",
  "interview.offer_expired": "A candidate did not pick an interview time",
  "interview.stuck": "An interview time could not be booked",
  "interview.no_show": "A candidate did not come to an interview",
  "interview.new_times_sent": "New interview times went to a candidate who asked for them",
  "interview.new_times_not_sent": "New interview times a candidate asked for were not sent",
  // The interviewers' notice when new times are set up; "interview.rescheduled" is the candidate asking to move one.
  "interview.new_times": "New times are going to a candidate for your interview",
  "calendar.needs_attention": "Your calendar connection needs attention",
  "calendar.cancel_failed": "Please remove a cancelled interview from your calendar",
  "member.removed_interviews": "Someone who left your team had interviews coming up",
  "stuck.candidates_waiting": "Candidates have been waiting on you",
  "stuck.screens_unanswered": "AI interview invitations have gone unanswered",
  "stuck.approval_pending": "A decision has been waiting",
  "stuck.no_applicants": "A role has had no applicants",
  "stuck.hold_ended": "A hold you set has ended",
  "stuck.decisions_untold": "Some candidates have not been told your decision",
  "stuck.conversations_stuck": "Some applicants are stuck in the AI interview",
  "stuck.offer_recruiter": "An ITS recruiter can help with a role",
  "stuck.closing_date_passed": "A role's closing date had passed when it opened",
  "stuck.closing_date_added": "A role was given a closing date",
  "stuck.boards_outdated": "A job board still shows an earlier version of a job",
  "stuck.escalated": "An ITS recruiter is looking at a role",
  "volume.high": "A role had more applicants in a day than your limit",
  "applications.closed": "A role stopped taking new applications",
  "applications.reopened": "A role is taking applications again",
  "recruiter.resolved": "Your ITS recruiter answered your request",
  "recruiter.posting_not_done": "ITS could not finish a job board task",
  "recruiter.claimed": "An ITS recruiter now has access to your hiring",
  "recruiter.access_granted": "An ITS recruiter now has access to your hiring",
  "message.sent": "A message to a candidate was sent",
  "message.declined": "A message to a candidate was not sent",
  "candidate.unreachable": "A message to a candidate could not be delivered",
  "company.verified": "ITS confirmed your company",
  "company.unverified": "Your careers page is offline while ITS checks your company again",
  // The Trial plan's 30 days (founder decision L-02 B).
  "company.trial_started": "Your 30-day trial has started",
  "company.trial_ending": "Your trial ends soon",
  "company.trial_extended": "ITS extended your trial",
  "company.trial_ended": "Your trial has ended",
  "entitlement.text_screens": "News about your plan's AI interviews",
};

/** When a kind has no headline of its own, its group's. */
const GROUP_HEADLINES: Record<NotifyGroup, string> = {
  approvals: "Something is waiting for your approval",
  candidates: "There is news about a candidate",
  interviews: "There is news about an interview",
  stuck: "A role needs your attention",
  recruiter: "There is news from your ITS recruiter",
  messages: "There is news about a message to a candidate",
  account: "There is news about your account",
};

export function alertHeadline(kind: string): string {
  return HEADLINES[kind] ?? GROUP_HEADLINES[notifyGroupOf(kind)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The role an update's link points at (`/roles/<id>...`), if any. */
export function roleIdFromHref(href: string | null | undefined): string | null {
  const m = /^\/roles\/([^/?#]+)/.exec(href ?? "");
  return m && UUID.test(m[1]) ? m[1] : null;
}

/** The interview an update's link points at (`/interviews/<id>`), if any; its role is looked up from the interview. */
export function interviewIdFromHref(href: string | null | undefined): string | null {
  const m = /^\/interviews\/([^/?#]+)/.exec(href ?? "");
  return m && UUID.test(m[1]) ? m[1] : null;
}

/** Where an email's link goes: the update's own page in the app, or the list of updates when it has none. */
export function alertLink(appBaseUrl: string, href: string | null | undefined): string {
  const path = href?.startsWith("/") && !href.startsWith("//") ? href : "/updates";
  return `${appBaseUrl.replace(/\/+$/, "")}${path}`;
}

/** The Settings section where a person changes which emails they get (the old /setup address, which still works). */
export function notificationSettingsLink(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/setup#setup-notifications`;
}

function greeting(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : "Hi,";
}

/** Said in every email alert, and in the stuck-role ladder's own emails (packages/agents orchestrator.ts). */
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
 * The email for one update sent as it happens: what happened, the company, the role if there is one, the link, and why
 * this person gets it (always, or because of their own setting, with the way to change it).
 */
export function renderAlertEmail(input: AlertEmailInput): { subject: string; text: string } {
  const headline = alertHeadline(input.kind);
  const always = NOTIFY_ALWAYS.get(input.kind);
  const group = notifyGroupOf(input.kind);
  const why = always
    ? `This email is always sent: ${always.why}`
    : `You get emails about "${NOTIFY_GROUP_INFO[group].label}" as they happen. Change which emails you get: ${notificationSettingsLink(input.appBaseUrl)}`;
  const lines = [
    greeting(input.recipientName),
    "",
    `${headline}.`,
    "",
    `Company: ${input.companyName}`,
    ...(input.roleTitle ? [`Role: ${input.roleTitle}`] : []),
    `Open it: ${input.link}`,
    "",
    ALERT_PRIVACY_LINE,
    "",
    why,
  ];
  return { subject: input.roleTitle ? `${headline}: ${input.roleTitle}` : headline, text: lines.join("\n") };
}

/** One update as a summary counts it: its group and its role. */
export type DigestItem = { kind: string; roleId: string | null; roleTitle: string | null };

export type DigestEmailInput = {
  recipientName: string | null;
  companyName: string;
  appBaseUrl: string;
  /** Weekly when this summary carries the Monday groups. */
  weekly: boolean;
  items: DigestItem[];
};

/**
 * A summary: how many updates came in per group and, under each, per role, with a link to the role. Counts, group names
 * and role names only; never a title, a body or a name.
 */
export function renderDigestEmail(input: DigestEmailInput): { subject: string; text: string } {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  const n = input.items.length;
  const lines = [
    greeting(input.recipientName),
    "",
    `Here is what came in at ${input.companyName} since your last summary that you have not seen yet.`,
    ALERT_PRIVACY_LINE,
  ];
  for (const group of NOTIFY_GROUPS) {
    const mine = input.items.filter((i) => notifyGroupOf(i.kind) === group);
    if (!mine.length) continue;
    lines.push("", `${NOTIFY_GROUP_INFO[group].label}: ${mine.length}`);
    const byRole = new Map<string, { title: string; roleId: string | null; count: number }>();
    for (const i of mine) {
      const key = i.roleId ?? "";
      const row = byRole.get(key) ?? { title: i.roleTitle ?? "Not about one role", roleId: i.roleId, count: 0 };
      row.count += 1;
      byRole.set(key, row);
    }
    const rows = [...byRole.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    for (const r of rows) {
      const link = r.roleId ? `${base}/roles/${r.roleId}${group === "candidates" ? "/talent" : ""}` : `${base}/updates`;
      lines.push(`- ${r.title}: ${r.count}  ${link}`);
    }
  }
  lines.push("", `See all your updates: ${base}/updates`, `Change which emails you get: ${notificationSettingsLink(base)}`);
  return { subject: `${input.companyName}: your ${input.weekly ? "weekly" : "daily"} summary (${n} new ${n === 1 ? "update" : "updates"})`, text: lines.join("\n") };
}
