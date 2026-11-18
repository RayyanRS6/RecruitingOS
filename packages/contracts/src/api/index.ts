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
