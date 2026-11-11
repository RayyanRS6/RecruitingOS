/**
 * A refusal the identity service brings back, as a code the sign-in page has words for (apps/web/src/pages/Login.tsx,
 * `ERRORS`). Supabase Auth sends the browser to redirect_to with `error` and `error_description` (Microsoft's own, or the
 * service's) and, for the service's own refusals only, `error_code`, in the query and again in the fragment, and no code;
 * one it cannot tie to a sign-in (its record of the flow expired or missing) goes to the Site URL, the address's root,
 * the same way. Microsoft's reason is the AADSTS number its description starts with; Microsoft also sends
 * error_subcode=cancel, which the service does not pass on.
 *
 * No imports: the sign-in callback (routes/auth.ts) and the shell's middleware (apps/shell/middleware.ts, for a refusal
 * at the root) map a refusal by this one rule, and the middleware bundle stays dependency-free.
 */

/**
 * Microsoft's refusals that wait on the person's company IT approving the app once (Entra AADSTS numbers): 65001 (nobody
 * has consented to the app yet), 90093, 90094 and 90095 (an administrator must approve, or the person may only ask for
 * it), 900941 and 900981 (an administrator must approve an app Microsoft counts as risky).
 */
export const NEEDS_APPROVAL = ["AADSTS65001", "AADSTS90093", "AADSTS90094", "AADSTS90095", "AADSTS900941", "AADSTS900981"];

/**
 * The service's refusals of an address the provider has not verified (Microsoft: xms_edov false). With Confirm email on,
 * the service mails that address a confirmation and refuses with provider_email_needs_verification; when the mail cannot
 * go, the mailer's own refusal comes back instead: email_address_not_authorized (Supabase's built-in mailer writes only
 * to its organization's members, and no custom SMTP is set up), over_email_send_rate_limit (a second try within the mail
 * interval) or email_address_invalid. That confirmation is the only mail on the way back from a provider.
 */
export const EMAIL_UNVERIFIED = ["provider_email_needs_verification", "email_address_not_authorized", "over_email_send_rate_limit", "email_address_invalid"];

/** What a refusal carries: the query's own values, and the provider the browser's sign-in started with (the PKCE cookie's). */
export type SignInRefusal = { error?: string | null; errorCode?: string | null; errorSubcode?: string | null; description?: string | null; provider?: string | null };

/**
 * The refusal's code and the bare AADSTS number (for the one log line; never the description). The microsoft_* codes name
 * Microsoft on the sign-in page, so only a flow that started with Microsoft gets them (`provider`: 10 November 2026); any
 * other, and one with no flow behind it, reads as `signin_incomplete`, as does an expired or missing flow state.
 */
export function refusalCode(q: SignInRefusal): { code: string; aadsts: string | null } {
  const numbers: string[] = q.description?.match(/AADSTS\d+/g) ?? [];
  const aadsts = numbers[0] ?? null;
  if (q.errorCode && EMAIL_UNVERIFIED.includes(q.errorCode)) return { code: "email_unverified", aadsts };
  if (q.provider !== "azure") return { code: "signin_incomplete", aadsts };
  // Cancel pressed on Microsoft's permissions screen, or Back to the app after asking IT for approval.
  if (numbers.includes("AADSTS65004") || q.errorSubcode === "cancel") return { code: "microsoft_declined", aadsts };
  if (numbers.some((n) => NEEDS_APPROVAL.includes(n)) || q.error === "consent_required") return { code: "microsoft_needs_approval", aadsts };
  if (/Error getting user email from external provider/i.test(q.description ?? "")) return { code: "microsoft_no_email", aadsts };
  return { code: "signin_incomplete", aadsts };
}

/** The query keys a refusal comes with. */
export const REFUSAL_KEYS: readonly string[] = ["error", "error_code", "error_description"];

/** Whether an address's query is a refusal the service sent: any of its keys, and no code (a code is a sign-in going on). */
export function isRefusalQuery(q: { has(key: string): boolean }): boolean {
  return !q.has("code") && REFUSAL_KEYS.some((k) => q.has(k));
}
