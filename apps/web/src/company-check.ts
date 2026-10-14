import { isCompanyVerified } from "@ros/contracts";

/**
 * The one-time ITS check (founder decision B7) as the team's pages say it, the pure parts. Until ITS confirms the
 * company, nothing of it is public (careers page, job pages and their addresses, the Google listing, apply links) and
 * messages to candidates wait in the outbox; roles can still be drafted and approved. Every page that would otherwise
 * promise "posting now" or "on its way" says so instead. The hook is components/use-company-check.ts.
 */

/** "confirmed", "waiting" for the check, or "unknown" while the company is still loading (say nothing either way). */
export type CompanyCheck = "confirmed" | "waiting" | "unknown";

export function companyCheckOf(company: { settings?: unknown } | null | undefined): CompanyCheck {
  if (!company) return "unknown";
  return isCompanyVerified(company.settings) ? "confirmed" : "waiting";
}

/**
 * The toast after a role is approved. The screen that opens with it says where the job is going; nothing is promised as
 * posted before its address has been checked (plan D2), so the toast never says "posting now".
 */
export function approvedToast(input: { editWhileOpen: boolean; check: CompanyCheck }): string {
  if (input.editWhileOpen) return "Approved. The job now runs on the new version.";
  return input.check === "waiting" ? "Approved. It goes public as soon as ITS confirms your company." : "Approved. Getting it ready on its channels.";
}

/** On the approval card, before anyone approves while the company waits. */
export const APPROVE_WAITS_FOR_CHECK = "ITS has not confirmed your company yet. Approving opens the job now; it goes public on its own as soon as ITS confirms.";

/** At the top of an open job's page while the company waits. */
export const ROLE_WAITS_FOR_CHECK = "Not public yet: ITS is confirming your company. The job is open here, and its job page, careers page listing and Google listing go public on their own as soon as ITS confirms. The Share tab says more.";

/** The Share tab's notice while the company waits: why it is empty, and why the job page's address answers "not found". */
export const POSTING_WAITS_FOR_CHECK = "Nothing of this job is public until ITS confirms your company: the careers page, the job page and its address, the Google listing and the apply links show \"not found\" for now. The moment ITS confirms, the channels are prepared and the job goes public on its own; you do not need to do anything. Home shows how the check is going.";

/** Beside the careers page's address in Settings. */
export const CAREERS_PAGE_WAITS = "Offline until ITS confirms your company.";

/** The chip for a decision message that is in the outbox: on its way, or waiting for the ITS check. */
export function messageOnItsWayChip(check: CompanyCheck): string {
  return check === "waiting" ? "Message waits for the ITS check" : "Message on its way";
}

/** The candidate panel's line while the decision message is in the outbox. */
export function decisionOnItsWayText(firstName: string, check: CompanyCheck): string {
  return check === "waiting"
    ? `The decision message waits for the ITS check of your company; it goes to ${firstName} on its own as soon as ITS confirms.`
    : `The decision message is on its way to ${firstName}.`;
}
