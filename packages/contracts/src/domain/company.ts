import { z } from "zod";
import type { Actor } from "./common";

/**
 * The one-time ITS check of a company that signed itself up (founder decision B7, plan B1). Until ITS confirms the
 * company is real, it can draft and approve roles, but its careers page, job pages, Google listing and feeds stay
 * offline and its messages to candidates wait in the outbox ("held"). Stored on `companies.settings` as `verifiedAt`
 * and `verifiedBy`; set and cleared only from the ITS admin console, never by the customer (CompanySettingsInput is
 * strict and the settings route names these keys as ITS's).
 */
export type CompanyVerification = { verifiedAt?: string; verifiedBy?: Actor };

/** When ITS confirmed the company, or null while it waits for the check. Reads any settings object. */
export function companyVerifiedAt(settings: unknown): string | null {
  const at = settings && typeof settings === "object" ? (settings as { verifiedAt?: unknown }).verifiedAt : undefined;
  return typeof at === "string" && at ? at : null;
}

export function isCompanyVerified(settings: unknown): boolean {
  return companyVerifiedAt(settings) !== null;
}

/**
 * Getting started (plan B2), on `companies.settings.onboarding`. `dismissedBy` holds, per person, when they hid the
 * card; `policiesReviewed*` is the owner's "I've reviewed them" on the AI rules; `jobBoardsConfirmed*` is set by ITS
 * once it can sign in to the company's job-board accounts.
 */
export type CompanyOnboarding = {
  dismissedBy?: Record<string, string>;
  policiesReviewedAt?: string;
  policiesReviewedBy?: Actor;
  jobBoardsConfirmedAt?: string;
  jobBoardsConfirmedBy?: Actor;
};

export function companyOnboarding(settings: unknown): CompanyOnboarding {
  const o = settings && typeof settings === "object" ? (settings as { onboarding?: unknown }).onboarding : undefined;
  return o && typeof o === "object" ? (o as CompanyOnboarding) : {};
}

/** The steps of the getting-started card, in the order the card lists them. */
export const GettingStartedStepKey = z.enum(["company_details", "team", "interview_hours", "first_role", "job_boards", "ai_rules"]);
export type GettingStartedStepKey = z.infer<typeof GettingStartedStepKey>;

/** A button on the card: a page to open, or a request to send (its body exactly as given). */
export type GettingStartedAction = { label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> };

/** One step: what to do, one line on why it matters, whether it is done, and what is still missing. */
export type GettingStartedStep = { key: GettingStartedStepKey; title: string; why: string; done: boolean; detail?: string; actions: GettingStartedAction[] };

/**
 * What the Today card carries (BriefCard kind `getting_started`). `verified` false means ITS has not confirmed the
 * company yet; `heldMessages` counts the messages to candidates waiting for that. `steps` are only the ones the viewer
 * can do, empty when the viewer hid the card or real decisions are waiting; `dismissible` says whether "Hide" is offered.
 */
export type GettingStarted = { verified: boolean; heldMessages: number; steps: GettingStartedStep[]; dismissible: boolean };

/** POST /api/v1/companies/current/getting-started: hide the card for yourself, or record that the AI rules were reviewed. */
export const GettingStartedRequest = z.object({ action: z.enum(["dismiss", "policies_reviewed"]) }).strict();
export type GettingStartedRequest = z.infer<typeof GettingStartedRequest>;

/** POST /api/v1/admin/customers/:id/verification: ITS confirms the company, or takes the confirmation back, with a reason. */
export const CompanyVerificationChange = z.object({
  verified: z.boolean(),
  reason: z.string().trim().min(5, "Say how you checked the company (at least five characters).").max(500),
  confirm: z.literal(true, { message: "Confirm the change." }),
}).strict();
export type CompanyVerificationChange = z.infer<typeof CompanyVerificationChange>;

/** POST /api/v1/admin/customers/:id/job-boards: ITS confirms it can sign in to the company's job-board accounts (or not any more). */
export const JobBoardAccessChange = z.object({ confirmed: z.boolean(), note: z.string().trim().max(500).optional() }).strict();
export type JobBoardAccessChange = z.infer<typeof JobBoardAccessChange>;
