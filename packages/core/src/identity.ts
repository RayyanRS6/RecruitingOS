import { and, eq } from "drizzle-orm";
import { memberships, randomToken, sessions, users, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { STAFF_SESSION_MS, hashToken, normalizeEmail } from "./auth";
import { acceptPendingInvitations } from "./invitations";
import { applyBootstrapAdmin } from "./platform-roles";

/**
 * Sign-in policy on top of the managed identity service (founder decisions F11, D19, D25; correction 4 of 18 September
 * 2026). The service proves who the person is; this decides whether that proof is enough for the account they hold.
 */
export type IdentityLike = { subject: string; email: string; emailVerified: boolean; name: string | null; provider: string; aal: "aal1" | "aal2"; mfaVerifiedAt: string | null };
export type SignInPolicy = { staffDomains: string[]; staffProvider: string; requireStaffMfa: boolean; /** One-time bootstrap list (BOOTSTRAP_ADMIN_EMAILS): honoured only while no administrator exists; never a standing grant. */ bootstrapAdmins?: string[] };
export const DEFAULT_SIGN_IN_POLICY: SignInPolicy = { staffDomains: ["identifiedtalent.com"], staffProvider: "azure", requireStaffMfa: true, bootstrapAdmins: [] };
export const STAFF_ROLES = ["its_recruiter", "platform_admin"] as const;
const SESSION_IDLE_MS = 30 * 24 * 3600_000;

export type SignInDecision = { ok: true; staff: boolean } | { ok: false; staff: boolean; code: "email_unverified" | "staff_provider_required" | "mfa_required"; message: string };

export function isStaffAccount(email: string, platformRole: string | null | undefined, policy: SignInPolicy): boolean {
  if (platformRole && (STAFF_ROLES as readonly string[]).includes(platformRole)) return true;
  const domain = normalizeEmail(email).split("@")[1] ?? "";
  return policy.staffDomains.includes(domain);
}

export function evaluateSignIn(identity: IdentityLike, existing: { platformRole: string } | null, policy: SignInPolicy = DEFAULT_SIGN_IN_POLICY): SignInDecision {
  const bootstrap = (policy.bootstrapAdmins ?? []).includes(normalizeEmail(identity.email));
  const staff = isStaffAccount(identity.email, bootstrap ? "platform_admin" : existing?.platformRole, policy);
  if (!identity.emailVerified) return { ok: false, staff, code: "email_unverified", message: "Your email address is not verified with the sign-in provider. Verify it and try again." };
  if (staff && identity.provider !== policy.staffProvider) return { ok: false, staff, code: "staff_provider_required", message: "ITS staff sign in with their Microsoft 365 account." };
  if (staff && policy.requireStaffMfa && identity.aal !== "aal2") return { ok: false, staff, code: "mfa_required", message: "ITS staff need a second factor. Finish multi-factor sign-in and try again." };
  return { ok: true, staff };
}

/**
 * Opens the application's own session from a verified identity. Links the provider subject to the user record on first
 * delegated sign-in (by verified email), creates the user if new, accepts any open team invitation for the verified
 * address (and the one the browser carried, by its token hash), and records how the session was opened. Never stores
 * the provider's token. An invitation the sign-in cannot honour raises InvitationRefused and nothing is opened.
 */
export async function openSessionFromIdentity(
  q: Queryable,
  input: { identity: IdentityLike; policy?: SignInPolicy; ip?: string; userAgent?: string; now?: Date; invitationTokenHash?: string | null; openedAt?: Date },
): Promise<{ sessionToken: string; userId: string; activeCompanyId: string | null; staff: boolean; expiresAt: string; invitationsAccepted: number }> {
  const policy = input.policy ?? DEFAULT_SIGN_IN_POLICY;
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.identity.email);
  let [user] = await q.select().from(users).where(and(eq(users.authProvider, input.identity.provider), eq(users.authSubject, input.identity.subject))).limit(1);
  if (!user) [user] = await q.select().from(users).where(eq(users.email, email)).limit(1);
  // The same provider must present the same subject for this account. A different subject with the same address is not
  // the same person as far as we can tell (a re-created account, or a tenant mix-up), so it is refused and audited.
  if (user && user.authProvider === input.identity.provider && user.authSubject && user.authSubject !== input.identity.subject) {
    const record: Parameters<typeof audit>[1] = { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: "identity_mismatch", ip: input.ip, details: { email, provider: input.identity.provider } };
    await audit(q, record);
    throw new SignInRefused("identity_mismatch", "This account is linked to a different sign-in identity. Contact ITS support.", record);
  }
  const decision = evaluateSignIn(input.identity, user ? { platformRole: user.platformRole } : null, policy);
  if (!decision.ok) {
    const record: Parameters<typeof audit>[1] = { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: decision.code, ip: input.ip, details: { email, provider: input.identity.provider, aal: input.identity.aal, staff: decision.staff } };
    await audit(q, record);
    throw new SignInRefused(decision.code, decision.message, record);
  }
  if (!user) {
    [user] = await q.insert(users).values({ email, name: input.identity.name, authProvider: input.identity.provider, authSubject: input.identity.subject }).returning();
  } else if (!user.authSubject) {
    await q.update(users).set({ authProvider: input.identity.provider, authSubject: input.identity.subject, name: user.name ?? input.identity.name }).where(eq(users.id, user.id));
  }
  // The bootstrap list is not authority: it is honoured once, for the very first administrator, and only through the
  // ledger. Any later match is ignored and audited (21 Sep, item 2). A listed address is treated as staff above, so the
  // bootstrap never applies without Microsoft and a second factor.
  const bootstrap = await applyBootstrapAdmin(q, { userId: user.id, email, listed: (policy.bootstrapAdmins ?? []).includes(email), now });
  if (bootstrap === "granted") user = { ...user, platformRole: "platform_admin" };
  // Team invitations (docs/spec/21, area A): honoured for customers only; a staff account never joins a company this way.
  const invited = await acceptPendingInvitations(q, { user: { id: user.id, email, name: user.name ?? input.identity.name }, tokenHash: input.invitationTokenHash ?? null, staff: decision.staff, now, ip: input.ip });
  const ms = await q.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"))).limit(1);
  const activeCompanyId = invited.activeCompanyId ?? ms[0]?.companyId ?? null;
  const sessionToken = randomToken(32);
  const expiresAt = new Date(now.getTime() + (decision.staff ? STAFF_SESSION_MS : SESSION_IDLE_MS)).toISOString();
  const [row] = await q.insert(sessions).values({
    userId: user.id, tokenHash: hashToken(sessionToken), activeCompanyId, expiresAt, lastSeenAt: now.toISOString(), ip: input.ip ?? null, userAgent: input.userAgent ?? null,
    identityProvider: input.identity.provider, aal: input.identity.aal, mfaVerifiedAt: input.identity.mfaVerifiedAt,
    // When the session opened, on the caller's clock: the freshness rule for policy and notice changes (A12) reads it against the same clock.
    createdAt: (input.openedAt ?? now).toISOString(),
  }).returning({ id: sessions.id });
  await audit(q, { companyId: null, actor: { kind: "user", id: user.id, name: user.name ?? user.email }, action: "session.opened", target: { type: "user", id: user.id }, reason: input.identity.provider, ip: input.ip, details: { sessionId: row.id, provider: input.identity.provider, aal: input.identity.aal, staff: decision.staff, mfaVerifiedAt: input.identity.mfaVerifiedAt } });
  return { sessionToken, userId: user.id, activeCompanyId, staff: decision.staff, expiresAt, invitationsAccepted: invited.accepted.length };
}

export class SignInRefused extends Error {
  status = 403;
  /** The refusal's audit record: when the sign-in ran inside a transaction that rolled back, the caller writes it again. */
  constructor(public readonly code: string, message: string, public readonly auditRecord?: Parameters<typeof audit>[1]) {
    super(message);
  }
}
