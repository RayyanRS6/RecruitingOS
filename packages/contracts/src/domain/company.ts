import { z } from "zod";
import type { Actor } from "./common";

/**
 * When ITS confirmed the company, or null while it waits for the check. Reads any settings object.
 *
 * The check is the one-time ITS check of a company that signed itself up (founder decision B7, plan B1). Until ITS
 * confirms the company is real, it can draft and approve roles, but its careers page, job pages, Google listing and
 * feeds stay offline and its messages to candidates wait in the outbox ("held"). Stored on `companies.settings` as
 * `verifiedAt` and `verifiedBy`; set and cleared only from the ITS admin console, never by the customer
 * (CompanySettingsInput is strict and the settings route names these keys as ITS's).
 */
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

/**
 * First sign-in asks for approval (the owner's request of 6 November 2026, SIGNUP_MODE=approval). A request is a company
 * whose owner's membership is `requested`, and `declined` once an administrator declined it. Both are memberships that
 * are not `active`, so someone waiting has no tenant, and that is the wall. The membership's status is the one source of
 * truth: it is never copied into `companies.settings`.
 */
export const ACCESS_REQUEST_STATUSES = ["requested", "declined"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** Whether a membership's status means a request for access, waiting or declined, rather than someone on a team. */
export function isAccessRequestStatus(status: string | null | undefined): status is AccessRequestStatus {
  return status === "requested" || status === "declined";
}

/**
 * POST /api/v1/admin/customers/:id/access: an administrator accepts or declines a request. No reason is typed. `remove`
 * (6 November 2026): takes an accepted company's access away; from then on it is a declined company, and Accept is the undo.
 */
export const CustomerAccessChange = z.object({
  decision: z.enum(["accept", "decline", "remove"]),
  confirm: z.literal(true, { message: "Confirm the decision." }),
}).strict();
export type CustomerAccessChange = z.infer<typeof CustomerAccessChange>;

/**
 * What that route answers. `status`: where the person stands now, `active` once they are in. `changed`: false when this
 * press changed nothing (another administrator got there first, or a second press), and `message` says so in plain words.
 * After `remove`: `people`, how many lost access, and `emailed`, whether the email to the owner really left (a screen may
 * say it went only then).
 */
export type CustomerAccessAnswer = { ok: true; companyId: string; decision: CustomerAccessChange["decision"]; status: "active" | "declined"; changed: boolean; message: string; people?: number; emailed?: boolean };

/**
 * `accessRequest` on a row of GET /api/v1/admin/customers, null for any other company: the status, the person who asked,
 * and for a declined one when and by whom, read from its `company.access_declined` event.
 */
export type CustomerAccessRequest = { status: AccessRequestStatus; person: { name: string | null; email: string }; declined: { at: string; by: string | null } | null; /** declined because an administrator took an accepted company's access away (6 November 2026) */ removed?: boolean };

/**
 * A person's own request, as `signup.request` on GET /api/v1/auth/config and `accessRequest` on POST /api/v1/companies say
 * it. `emailedAt`: when the copy really left (`accessRequestEmailedAt` in the company's settings); null means no claim about
 * email may be made on the screen.
 */
export type SignupRequest = { status: AccessRequestStatus; companyName: string; email: string; emailedAt: string | null };

/**
 * The `signup` part of GET /api/v1/auth/config. `mode`: SIGNUP_MODE. `allowed`: whether this person may send the company
 * form now. `contact`: the ITS inbox to ask. `door`, only under `approval`: `direct` for a platform administrator or an
 * address on the allow-list, `request` for anyone else signed in (the form sends a request), `none` signed out. `request`,
 * in any mode: this person's own request, waiting or declined; with one, `allowed` is false.
 */
export type SignupConfig = { mode: "open" | "invite" | "approval"; allowed: boolean; contact: string; door?: "direct" | "request" | "none"; request?: SignupRequest };

/**
 * What a person typed, for one line of an email (a subject, or one "Label: value" of a body) or a request's details: as a
 * display name in `mailbox` (packages/integrations) can never start a header of its own, this can never start a line of
 * its own. Line breaks and other control characters become one space, runs of spaces close up, and a very long value
 * stops at `max` characters.
 */
export function oneLine(value: string | null | undefined, max = 200): string {
  const line = (value ?? "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return line.length > max ? line.slice(0, max).trimEnd() : line;
}
