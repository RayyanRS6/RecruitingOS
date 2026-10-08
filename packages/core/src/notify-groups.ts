import { NOTIFY_GROUPS, type NotifyCadence, type NotifyGroup } from "@ros/contracts";

/**
 * The groups every update kind is sorted into for email alerts (plan B3), with the plain words Setup shows and the
 * product's default for each. The in-app update is never affected: these decide only whether, and how often, the person
 * it is for also hears about it by email.
 *
 * Defaults: what waits on a person (a role or a message to approve, an interview, an answer from a recruiter, the
 * account) is emailed as it happens; news that can wait (candidates moving through, quiet roles, messages sent) comes
 * in the morning summary.
 */
export const NOTIFY_GROUP_INFO: Record<NotifyGroup, { label: string; description: string; defaultCadence: NotifyCadence }> = {
  approvals: { label: "Waiting for your approval", description: "A role to approve, a message to a candidate that needs your OK, or a role sent back to draft.", defaultCadence: "immediate" },
  candidates: { label: "Candidates", description: "Someone is ready for review or a screen, finished a screen, wrote back or withdrew.", defaultCadence: "daily" },
  interviews: { label: "Interviews", description: "Interviews you were given, reminders, changes, the decision after an interview, and your calendar connection.", defaultCadence: "immediate" },
  stuck: { label: "Roles that need attention", description: "People waiting on you, invitations nobody answered, no applicants, a hold that ended, decisions nobody has told candidates about, or a role that stopped or started taking applications.", defaultCadence: "daily" },
  recruiter: { label: "Your ITS recruiter", description: "A recruiter answered your request, wrote to you about it, or picked it up.", defaultCadence: "immediate" },
  messages: { label: "Messages to candidates", description: "Messages your team sent, ones that were not approved, and ones that could not be delivered.", defaultCadence: "daily" },
  account: { label: "Your account", description: "Your plan's limits and changes to your team.", defaultCadence: "immediate" },
};

/**
 * Updates that are always emailed at once and cannot be turned off: a recruiter from outside the company can now see its
 * hiring, ITS confirmed the company or took its confirmation back (the careers page goes public or offline), a candidate
 * asked for a person, or someone's application waits on an eligibility decision. Each one concerns who can see the
 * company's data or what the public sees of it, or leaves a person waiting on the team.
 */
export const NOTIFY_ALWAYS: ReadonlyMap<string, { label: string; why: string }> = new Map([
  ["recruiter.claimed", { label: "An ITS recruiter is given access to your hiring", why: "Someone outside your company can now see your hiring, so you always hear about it." }],
  ["recruiter.access_granted", { label: "An ITS recruiter is given access to your hiring", why: "Someone outside your company can now see your hiring, so you always hear about it." }],
  ["company.verified", { label: "ITS confirms your company, or takes the confirmation back", why: "It decides whether your careers page and job pages are public, so you always hear about it." }],
  ["company.unverified", { label: "ITS confirms your company, or takes the confirmation back", why: "It decides whether your careers page and job pages are public, so you always hear about it." }],
  ["screen.human_requested", { label: "A candidate asks to talk to a person", why: "A person is waiting for one of you to reply." }],
  ["application.ineligible_hold", { label: "Someone waits for your eligibility decision", why: "Their application is on hold until a person decides." }],
  ["application.ineligible_review_due", { label: "Someone waits for your eligibility decision", why: "Their application is on hold until a person decides." }],
]);

/**
 * Updates that never go out on their own email, only in summaries: the people involved already get an email of their
 * own (an interviewer's booking confirmation carries the interviewer's brief), or the update is a test.
 */
const SUMMARY_ONLY = new Set(["interview.confirmed"]);

const BY_KIND: Record<string, NotifyGroup> = {
  "approval.requested": "approvals",
  "role.sent_back": "approvals",
  "message.approval_requested": "approvals",
  "candidate.recommended": "candidates",
  "candidate.withdrawn": "candidates",
  "application.ready": "candidates",
  "application.needs_review": "candidates",
  "application.assessment_unavailable": "candidates",
  "application.ineligible_hold": "candidates",
  "application.ineligible_review_due": "candidates",
  "application.email_held": "candidates",
  "message.received": "candidates",
  "volume.high": "stuck",
  "applications.closed": "stuck",
  "applications.reopened": "stuck",
  "message.sent": "messages",
  "message.declined": "messages",
  "candidate.unreachable": "messages",
  "member.removed_interviews": "interviews",
};

/** Kinds sorted by their first word when they have no entry above (new kinds land somewhere sensible). */
const BY_PREFIX: Array<[string, NotifyGroup]> = [
  ["screen.", "candidates"],
  ["application.", "candidates"],
  ["candidate.", "candidates"],
  ["interview.", "interviews"],
  ["calendar.", "interviews"],
  ["stuck.", "stuck"],
  ["recruiter.", "recruiter"],
  ["escalation.", "recruiter"],
  ["message.", "messages"],
  ["approval.", "approvals"],
  ["role.", "approvals"],
  ["company.", "account"],
  ["entitlement.", "account"],
  ["member.", "account"],
];

/** The group an update kind belongs to. Anything unknown counts as an account update. */
export function notifyGroupOf(kind: string): NotifyGroup {
  const exact = BY_KIND[kind];
  if (exact) return exact;
  for (const [prefix, group] of BY_PREFIX) if (kind.startsWith(prefix)) return group;
  return "account";
}

export function isAlwaysEmailed(kind: string): boolean {
  return NOTIFY_ALWAYS.has(kind);
}

/** A person's saved settings by group; a group with no entry uses its default. */
export type StoredPreferences = Partial<Record<NotifyGroup, NotifyCadence>>;

/** How often each group is emailed for one person, defaults filled in. */
export function cadencesFor(stored: StoredPreferences): Record<NotifyGroup, NotifyCadence> {
  return Object.fromEntries(NOTIFY_GROUPS.map((g) => [g, stored[g] ?? NOTIFY_GROUP_INFO[g].defaultCadence])) as Record<NotifyGroup, NotifyCadence>;
}

/**
 * How one update reaches one person by email: its group, the cadence that applies (an always-emailed kind is
 * immediate whatever the group says), and whether that means an email of its own now.
 */
export function resolveNotifyCadence(kind: string, stored: StoredPreferences): { group: NotifyGroup; cadence: NotifyCadence; always: boolean; emailNow: boolean } {
  const group = notifyGroupOf(kind);
  if (isAlwaysEmailed(kind)) return { group, cadence: "immediate", always: true, emailNow: true };
  const cadence = stored[group] ?? NOTIFY_GROUP_INFO[group].defaultCadence;
  return { group, cadence, always: false, emailNow: cadence === "immediate" && !SUMMARY_ONLY.has(kind) && !kind.startsWith("test.") };
}

/** Whether an update belongs in a summary of these cadences for this person (always-emailed kinds went out already). */
export function belongsInDigest(kind: string, stored: StoredPreferences, due: readonly NotifyCadence[]): boolean {
  if (isAlwaysEmailed(kind)) return false;
  return due.includes(stored[notifyGroupOf(kind)] ?? NOTIFY_GROUP_INFO[notifyGroupOf(kind)].defaultCadence);
}
