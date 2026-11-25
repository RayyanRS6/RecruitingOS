import { z } from "zod";
import { FormAnswers } from "../domain/apply-questions";
import { MembershipRole, PlatformRole, type SignupConfig } from "../domain/company";
import type { PlanRoom } from "../domain/intake";
import { PUBLIC_PLAN_KEYS } from "../domain/plans";

/**
 * What every API answer shares, sign-in, the application form's post and the plan request. The other areas are in
 * jobs.ts, candidates.ts, settings.ts, notifications.ts and admin.ts.
 */

/** Every refusal: a stable `code`, a plain `message` a screen may show as it is, and sometimes `details`. */
export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * `details` of a 402: the plan stops this. `upgrade`: asking for a bigger plan is the way on. `ask`: the button's
 * words ("Upgrade", or "Talk to ITS" on the last plan) and the reason to send with POST /api/v1/plans/request; null when
 * this person may not ask. `room`: the plan's room for jobs, when that is what ran out.
 */
export type PlanLimitDetails = { upgrade: boolean; ask: { label: string; reason: string } | null; room?: PlanRoom };

/* ------------------------------------------------------------------------------------------------------------ */
/* Sign-in and session.                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

export const MagicLinkRequest = z.object({ email: z.email() });
export const MagicLinkConsume = z.object({ token: z.string().min(10) });

/** GET /api/v1/auth/config: how people sign in here, and where this person stands with sign-up. */
export type AuthConfig = { mode: string; providers: Array<{ key: string; label: string }>; magicLink: boolean; staffDomains: string[]; signup: SignupConfig };

/** The product's name as the sign-in page's heading writes it, for the sentences below that name it. A rename changes this line and that heading. */
const PRODUCT = "Recruiting OS";

/**
 * Why a sign-in was refused, in the words the person reads: one sentence for each code, and each says what to do next.
 * The sign-in routes send a refused sign-in back to the sign-in page as `?error=<code>`, and the page shows the
 * sentence here (`signInRefusalLine`). The sign-in rules in packages/core give a refusal the same sentence as its
 * message, so the page and the server cannot say two things for one code.
 */
export const SIGN_IN_REFUSAL = {
  // The checks on the identity and on the account it signs in to (packages/core/src/identity.ts).
  provider_not_allowed: "Sign in with Microsoft or Google.",
  provider_mismatch: "That sign-in did not match the provider you chose. Start again.",
  email_invalid: "Your sign-in account has no usable email address. Sign in with Microsoft or Google.",
  email_unverified: "Your email address is not verified with the sign-in provider. Ask your IT to check the email address on your account, or use the other sign-in button.",
  staff_provider_required: "ITS staff sign in with their Microsoft 365 account.",
  staff_provider_linked: "This ITS account is also linked to another sign-in method. Ask an ITS administrator to remove that link, then sign in with Microsoft 365.",
  mfa_required: "ITS staff need a second factor. Finish multi-factor sign-in with Microsoft and try again.",
  identity_mismatch: "This email address is already linked to a different Google or Microsoft account. Sign in with the account you used before, or contact ITS support to change it.",
  // A team invitation the sign-in carried (packages/core/src/invitations.ts). The last: the company's plan has all its people.
  invite_email_mismatch: "That invitation was sent to a different email address. Sign in with the address the invitation was sent to, or continue without it.",
  invite_expired: "That invitation has expired or was withdrawn. Ask the person who invited you for a new one, then sign in as usual.",
  invite_seats_full: "This company's plan is full. Ask the person who invited you to upgrade, then open the invitation link again.",
  // The steps of a sign-in, as the sign-in routes name them (apps/api/src/routes/auth.ts, auth-mfa.tsx).
  expired: "That sign-in link is invalid or has expired. Request a new one.",
  signin_incomplete: "The sign-in did not complete. Start again.",
  exchange_failed: "The sign-in could not be completed. Try again.",
  mfa_expired: "The second-factor step timed out. Sign in again.",
  mfa_failed: "The code was wrong too many times. Sign in again.",
  mfa_unavailable: "The second-factor service is not available right now. Try again in a few minutes.",
  // Microsoft's refusals, as the sign-in callback names them (apps/api/src/signin-refusal.ts).
  microsoft_needs_approval: `Your company's IT has to approve ${PRODUCT} once before you can sign in with Microsoft. Ask them, or continue with Google.`,
  microsoft_declined: `The Microsoft sign-in did not finish. Start again and press Accept. If your IT has to approve ${PRODUCT} first, try again once they have.`,
  microsoft_no_email: "Microsoft did not share an email address for this account. Ask your IT to check it, or continue with Google.",
} as const;
export type SignInRefusalCode = keyof typeof SIGN_IN_REFUSAL;

/** What the sign-in page says for the code in its address: that code's sentence, or the general line for a code the table does not hold. */
export function signInRefusalLine(code: string): string {
  return Object.hasOwn(SIGN_IN_REFUSAL, code) ? SIGN_IN_REFUSAL[code as SignInRefusalCode] : "Sign-in failed. Try again.";
}

/** The signed-in person as GET /api/v1/auth/me answers it; the API builds this shape and the web client reads it, so neither can drift. */
export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable(), platformRole: PlatformRole }),
  auth: z.object({ provider: z.string(), aal: z.enum(["aal1", "aal2"]), mfaVerifiedAt: z.string().nullable() }),
  /** The companies this person is an active member of. Someone whose request waits or was declined has none. */
  memberships: z.array(z.object({ companyId: z.string(), companyName: z.string(), companySlug: z.string(), role: MembershipRole })),
  activeCompanyId: z.string().nullable(),
  ai: z.object({ provider: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Applying (the candidate's form).                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What "Send" on the application form carries, beside the CV file: who they are, their answers to the job's screening
 * questions, and the acknowledgment. No AI is asked anything before Send. A CV is required: the server refuses a Send
 * without one.
 */
export const ApplyRequest = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.email(),
  phone: z.string().min(7).max(30).optional(),
  /** By question key: "yes" or "no", the chosen option's words, or the number as typed. */
  answers: FormAnswers.default({}),
  /** Honeypot: must be empty. */
  website: z.string().max(0).optional(),
  noticeVersionsShown: z.array(z.string()).default([]),
  /** The affirmative acknowledgment: an unchecked box the candidate must tick; never pre-checked, never optional. */
  acknowledged: z.literal(true, { message: "Please confirm you have read the notice." }),
});
export type ApplyRequest = z.infer<typeof ApplyRequest>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Plans.                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * POST /api/v1/plans/request: a company asks for a bigger plan. `planKey` is the plan asked for (none when nothing is
 * above theirs), `reason` why the person got here (a line of ours), `note` their own words.
 */
export const PlanRequest = z.object({ planKey: z.enum(PUBLIC_PLAN_KEYS).optional(), reason: z.string().trim().max(300).optional(), note: z.string().trim().max(1000).optional() }).strict();
export type PlanRequest = z.infer<typeof PlanRequest>;
/** Its answer: when the company's open request was sent, and whether one was already open (nothing new was raised). */
export type PlanRequestSent = { requestedAt: string; alreadyAsked: boolean };
