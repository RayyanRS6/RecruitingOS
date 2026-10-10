import type { RoleEvent } from "./api/client";

/**
 * The words the role page uses for channels, team roles and what happened on a role (Owner Mode never shows raw stage,
 * state or event names, docs/07). No React and no API calls here, so the words can be tested on their own
 * (tests/web/role-page.test.ts).
 */

/** Each posting channel as the owner knows it. */
export const CHANNEL_LABEL: Record<string, string> = { careers_page: "Careers page", google_jobs: "Google for Jobs", email_in: "Applications by email", linkedin_basic: "LinkedIn", indeed: "Indeed", ziprecruiter: "ZipRecruiter" };

export function channelName(channel: unknown): string {
  return typeof channel === "string" && channel ? CHANNEL_LABEL[channel] ?? channel.replace(/_/g, " ") : "A posting";
}

export function boardNames(channels: string[]): string {
  return channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ");
}

/**
 * "Shown to candidates" on the Pay card, by the public pages' rule (`payShown` in packages/core, sent by the API with
 * each packet): the owner's choice, or a pay transparency law where the job is, which shows it whatever the choice.
 */
export function payShownLabel(packet: { payShown?: boolean; payRequiredByLaw?: boolean }, discloseRange: boolean): string {
  const shown = packet.payShown ?? discloseRange;
  if (!shown) return "No";
  return !discloseRange && packet.payRequiredByLaw ? "Yes: the law where this job is requires it" : "Yes";
}

/** A team role as a person ("a hiring manager"), for sentences such as "planned: an owner, a hiring manager". */
const ROLE_WORDS: Record<string, string> = { owner: "an owner", admin: "an admin", hiring_manager: "a hiring manager", hr: "someone from HR", interviewer: "an interviewer", recruiter: "a recruiter" };
export function roleWords(roles: string[]): string {
  return roles.map((r) => ROLE_WORDS[r] ?? r.replace(/_/g, " ")).join(", ");
}

/** Who did something, in words: a person's name, "the assistant" for an AI step (never its internal id), "the system" for a workflow. */
export function actorWords(actor: RoleEvent["actor"]): string {
  if (actor.name) return actor.name;
  switch (actor.kind) {
    case "agent": return "the assistant";
    case "system": return "the system";
    case "candidate": return "a candidate";
    case "user": return "a team member";
    default: return "someone";
  }
}

/** Mirrors STAGE_LABEL in packages/core. */
const STAGE_WORDS: Record<string, string> = {
  applied: "Just applied", received: "Received", ineligible: "Doesn't meet eligibility", eligible: "Eligible", triaged: "Ready for your review", screen_invited: "Invited to a screen",
  screening: "Being screened", screen_complete: "Screen complete", interview_recommended: "Recommended for interview", interview_scheduled: "Interviewing", interview_complete: "Interview done",
  debrief: "Deciding", finalist: "Finalist", reference_check: "Checking references", offer_draft: "Offer being prepared", offer_approval: "Offer needs your approval", offer_sent: "Offer out",
  negotiation: "Negotiating", accepted: "Accepted", declined: "Declined the offer", hired: "Hired", onboarding: "Starting soon", withdrawn: "Withdrew", rejected: "Not moving forward", talent_pool: "In your talent pool",
};

/**
 * What a posting event means, after the board's name. The nine posting states (packages/core/src/postings.ts emits
 * `posting.<state>`), the worker's failed check and the two removal events; anything older or unknown still names the
 * board and never shows a raw state name.
 */
function postingWords(type: string, p: Record<string, unknown>): string {
  const what = type.slice("posting.".length);
  switch (what) {
    case "draft": return "waiting for the role to be approved";
    case "approved": return "approved, being prepared";
    case "ready_to_post": return p.channel === "careers_page" || p.channel === "google_jobs" ? "prepared" : "ready to post";
    case "posted_manually": return p.corrected ? "a different address recorded, being checked" : "address recorded, being checked";
    case "submitted_integration": return "submitted, waiting to be listed";
    case "live_verified": return "checked and live";
    case "paused": return "paused";
    case "failed": return "could not be verified";
    case "closed": return "closed";
    case "verification_failed": return p.final ? "the last check did not pass" : "the check did not pass; it is checked again shortly";
    case "closure_required": return "still to be taken down";
    case "closure_confirmed": return "confirmed taken down";
    case "update_required": return "still shows the earlier version, to be updated";
    case "updated": return "brought up to date with the new version";
    default: return "posting updated";
  }
}

/** Plain words for what happened on a role; anything unknown falls back to the event's own name in words. */
export function describeRoleEvent(e: RoleEvent): string {
  const p = e.payload as Record<string, string | number | boolean | null | undefined>;
  if (e.type.startsWith("posting.")) return `${channelName(p.channel)}: ${postingWords(e.type, p)}`;
  const v = p.version !== undefined && p.version !== null ? `v${p.version}` : "";
  const note = typeof p.note === "string" && p.note ? `: ${p.note}` : "";
  const known: Record<string, string> = {
    "role.created": "Role drafted from the intake conversation",
    "role_packet.proposed": `Packet ${v} ${p.again ? "sent for approval again" : "proposed for approval"}`.trim(),
    "role_packet.edited": `Packet ${v} edited${typeof p.changeSummary === "string" && p.changeSummary ? `: ${p.changeSummary}` : ""}`,
    "role_packet.approved": `Packet ${v} approved${p.via === "edit_while_open" ? " and made current" : ""}`,
    "packet.revision_proposed": "The assistant suggested a change to the packet; nothing was saved",
    "packet.revision_applied": `A change asked for in the chat was saved as packet ${v}`.trim(),
    "packet.revision_discarded": "A suggested change was set aside",
    "packet.check_applied": `Fixes from the requirements check were saved as packet ${v}`.trim(),
    "approval.requested": "Approval requested",
    "approval.granted": `Approved${note}`,
    "approval.denied": `Sent back${note}`,
    "approval.expired": `The approval ran out of time (${typeof p.windowDays === "number" ? p.windowDays : 14} days)`,
    "approval.cancelled": `Approval withdrawn${typeof p.reason === "string" && p.reason ? ` (${p.reason})` : ""}`,
    "role.sent_back": p.wasOpen ? `Proposed ${v} retired${note}` : `Back to a draft${note}`,
    "role.approved": "Role approved",
    "role.opened": "Role opened",
    "role.paused": "Role paused",
    "role.resumed": "Role resumed",
    "role.closed": "Role closed",
    "role.filled": "Role filled",
    "role.applications_closed": "Stopped accepting applications",
    "role.applications_reopened": "Accepting applications again",
    "role.volume_high": "Unusually many applications in a day",
    "role.boards_chosen": Array.isArray(e.payload.channels) && e.payload.channels.length ? `Job boards chosen: ${boardNames(e.payload.channels as string[])}` : "No job boards chosen",
    "role.closing_date_set": typeof p.closesOn === "string" ? `Closing date set: last day to apply ${new Date(`${p.closesOn}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })}` : "Closing date taken off",
    "role.outcome_recorded": "Outcome recorded",
    "application.received": "An application arrived",
    "application.acknowledged": "An applicant was acknowledged",
    "application.duplicate_detected": "Someone applied again (the original was kept)",
    "application.ineligible": "An application was held on an eligibility answer",
    "application.triaged": "An application was assessed",
    "application.stage_changed": `A candidate is now "${STAGE_WORDS[String(p.to ?? "")] ?? String(p.to ?? "").replace(/_/g, " ")}"`,
    "application.rejected": "A candidate was declined by a person",
    "application.withdrawn": "A candidate withdrew",
    "application.moved_to_talent_pool": "A candidate was added to the talent pool",
    "candidate.recommended": "A candidate was recommended for interview",
    "screen.invited": "A candidate was invited to a screen",
    "screen.completed": "A candidate completed the screen",
    "screen.cancelled": p.reason === "stopped_by_team" ? "A screening invitation was stopped by the team" : p.reason === "deletion_request" ? "A screen was closed: the candidate's information was deleted" : "A screen was closed: the candidate is no longer in the process",
    "interview.requested": "An interview was requested",
    "interview.scheduled": "An interview was booked",
    "interview.completed": "An interview took place",
    // the team's "Send new times" for several people under Cancelled at once (founder decision 2A)
    "interview.new_times_batch": `New times asked for ${Number(p.requested ?? 0) === 1 ? "1 person" : `${Number(p.requested ?? 0)} people`} under Cancelled: ${Number(p.sent ?? 0)} going ahead${Number(p.notSent ?? 0) ? `, ${Number(p.notSent)} not sent` : ""}`,
    "outcome.recorded": "An outcome was recorded",
    "recruiter.requested": "A recruiter was asked for help",
    "recruiter.claimed": "An ITS recruiter picked it up",
    "recruiter.resolved": "The ITS recruiter responded",
    "recruiter.replied": "The ITS recruiter wrote about a request",
    "customer.replied": "Someone on the team added a note to a recruiter request",
    "recruiter.reopened": "A recruiter request was reopened",
  };
  return known[e.type] ?? e.type.replace(/[._]/g, " ");
}
