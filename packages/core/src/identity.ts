import { and, eq } from "drizzle-orm";
import { SIGN_IN_REFUSAL, type SignInRefusalCode } from "@ros/contracts";
import { memberships, randomToken, sessions, users, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { SESSION_IDLE_MS, STAFF_SESSION_MS, hashToken, isEmailAddress, normalizeEmail } from "./auth";
import { acceptPendingInvitations } from "./invitations";
import { activeGrantFor, applyBootstrapAdmin } from "./platform-roles";

/**
 * Sign-in policy on top of the managed identity service (founder decisions F11, D19, D25; correction 4 of 18 September
 * 2026). The service proves who the person is; this decides whether that proof is enough for the account they hold.
 */
export type IdentityLike = { subject: string; email: string; emailVerified: boolean; name: string | null; provider: string; /** Every provider linked to the account at the identity service, its first (`provider`) included. */ providers?: string[]; aal: "aal1" | "aal2"; mfaVerifiedAt: string | null };
export type SignInPolicy = { staffDomains: string[]; staffProvider: string; requireStaffMfa: boolean; /** One-time bootstrap list (BOOTSTRAP_ADMIN_EMAILS): honoured only while no administrator exists; never a standing grant. */ bootstrapAdmins?: string[]; /** The providers the deployment offers (AUTH_SIGNIN_PROVIDERS): a session opens through these only. */ allowedProviders?: string[] };
export const DEFAULT_SIGN_IN_POLICY: SignInPolicy = { staffDomains: ["identifiedtalent.com"], staffProvider: "azure", requireStaffMfa: true, bootstrapAdmins: [], allowedProviders: ["azure", "google"] };

export type SignInDecision = { ok: true; staff: boolean } | { ok: false; staff: boolean; code: "email_unverified" | "staff_provider_required" | "staff_provider_linked" | "mfa_required"; message: string };
export type SignInIdentity<T extends IdentityLike> = { ok: true; identity: T } | { ok: false; code: "provider_mismatch" | "provider_not_allowed" | "email_invalid"; message: string };

/** A refusal by its code. Its message is the one sentence the sign-in page shows for that code (`SIGN_IN_REFUSAL` in packages/contracts): no sentence is written here. */
const refuse = <C extends SignInRefusalCode>(code: C) => ({ ok: false as const, code, message: SIGN_IN_REFUSAL[code] });

/**
 * What a verified identity signs in as, before any account is looked at (audit SEC-8, known bug row 41). The identity
 * service names the account's first provider and links accounts across providers by email, so the token alone does not
 * say which one the person used this time. The browser flow does: the provider it started (the PKCE cookie) is this
 * sign-in's provider, for the staff Microsoft rule and the account match alike, when the account holds it; a start the
 * account does not hold is refused. Without a start (the JSON route, which only tests use) the token's provider stands.
 * Then the provider must be one the deployment offers, and the address a usable one.
 */
export function identityForSignIn<T extends IdentityLike>(identity: T, startedProvider: string | null | undefined, policy: SignInPolicy = DEFAULT_SIGN_IN_POLICY): SignInIdentity<T> {
  if (startedProvider && !(identity.providers ?? [identity.provider]).includes(startedProvider)) return refuse("provider_mismatch");
  const used = startedProvider ? { ...identity, provider: startedProvider } : identity;
  if (!(policy.allowedProviders ?? DEFAULT_SIGN_IN_POLICY.allowedProviders ?? []).includes(used.provider)) return refuse("provider_not_allowed");
  if (!isEmailAddress(normalizeEmail(used.email))) return refuse("email_invalid");
  return { ok: true, identity: used };
}

/**
 * The identity service presents one subject for every provider it links to an account, so an account recorded under any
 * provider this identity holds must carry its subject. Another subject with the same address is not the same person as
 * far as we can tell (a re-created account, or a tenant mix-up). Holding every linked provider to it, not only the one
 * used, keeps the check as strong as when the account's first provider stood for every sign-in.
 */
export function linkedToAnotherSubject(account: { authProvider: string | null; authSubject: string | null }, identity: IdentityLike): boolean {
  return !!account.authProvider && !!account.authSubject && account.authSubject !== identity.subject && (identity.providers ?? [identity.provider]).includes(account.authProvider);
}

export function isStaffAccount(email: string, platformRole: string | null | undefined, policy: SignInPolicy): boolean {
  if (platformRole === "platform_admin") return true;
  const domain = normalizeEmail(email).split("@")[1] ?? "";
  return policy.staffDomains.includes(domain);
}

/**
 * Whether the identity service links any provider but the staff one to this account. The provider a browser sign-in
 * started with comes from an unsealed cookie and may name any provider the account holds, and the service links a new
 * provider to an account by its verified address. So someone who controls a staff mailbox could open a Google account
 * for it and present that sign-in as Microsoft; a staff account must therefore hold the staff provider only. ITS
 * removes a stray link at the identity service.
 */
export function holdsOtherThanStaffProvider(identity: IdentityLike, policy: SignInPolicy): boolean {
  return (identity.providers ?? [identity.provider]).some((p) => p !== policy.staffProvider);
}

export function evaluateSignIn(identity: IdentityLike, existing: { platformRole: string } | null, policy: SignInPolicy = DEFAULT_SIGN_IN_POLICY): SignInDecision {
  const bootstrap = (policy.bootstrapAdmins ?? []).includes(normalizeEmail(identity.email));
  const staff = isStaffAccount(identity.email, bootstrap ? "platform_admin" : existing?.platformRole, policy);
  if (!identity.emailVerified) return { ...refuse("email_unverified"), staff };
  if (staff && identity.provider !== policy.staffProvider) return { ...refuse("staff_provider_required"), staff };
  if (staff && holdsOtherThanStaffProvider(identity, policy)) return { ...refuse("staff_provider_linked"), staff };
  if (staff && policy.requireStaffMfa && identity.aal !== "aal2") return { ...refuse("mfa_required"), staff };
  return { ok: true, staff };
}

/**
 * Opens the application's own session from a verified identity. Links the provider subject to the user record on first
 * delegated sign-in (by verified email), creates the user if new, accepts any open team invitation for the verified
 * address (and the one the browser carried, by its token hash), and records how the session was opened. Never stores
 * the provider's token. An invitation the sign-in cannot honour raises InvitationRefused and nothing is opened.
 * `startedProvider` is the provider the browser flow started with (identityForSignIn). `platformAdmin`: the person holds
 * the platform administrator role in the ledger, so they land on the admin dashboard.
 */
export async function openSessionFromIdentity(
  q: Queryable,
  input: { identity: IdentityLike; startedProvider?: string | null; policy?: SignInPolicy; ip?: string; userAgent?: string; now?: Date; invitationTokenHash?: string | null; openedAt?: Date },
): Promise<{ sessionToken: string; userId: string; activeCompanyId: string | null; staff: boolean; platformAdmin: boolean; expiresAt: string; invitationsAccepted: number }> {
  const policy = input.policy ?? DEFAULT_SIGN_IN_POLICY;
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.identity.email);
  const checked = identityForSignIn(input.identity, input.startedProvider, policy);
  if (!checked.ok) {
    const record: Parameters<typeof audit>[1] = { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: checked.code, ip: input.ip, details: { email, provider: input.identity.provider, providers: input.identity.providers ?? [input.identity.provider], startedProvider: input.startedProvider ?? null } };
    await audit(q, record);
    throw new SignInRefused(checked.code, record);
  }
  const identity = checked.identity;
  let [user] = await q.select().from(users).where(and(eq(users.authProvider, identity.provider), eq(users.authSubject, identity.subject))).limit(1);
  if (!user) [user] = await q.select().from(users).where(eq(users.email, email)).limit(1);
  // A provider this identity holds must present the account's subject (linkedToAnotherSubject); otherwise refused and audited.
  if (user && linkedToAnotherSubject(user, identity)) {
    const record: Parameters<typeof audit>[1] = { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: "identity_mismatch", ip: input.ip, details: { email, provider: identity.provider } };
    await audit(q, record);
    throw new SignInRefused("identity_mismatch", record);
  }
  const decision = evaluateSignIn(identity, user ? { platformRole: user.platformRole } : null, policy);
  if (!decision.ok) {
    const record: Parameters<typeof audit>[1] = { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: decision.code, ip: input.ip, details: { email, provider: identity.provider, aal: identity.aal, staff: decision.staff } };
    await audit(q, record);
    throw new SignInRefused(decision.code, record);
  }
  if (!user) {
    [user] = await q.insert(users).values({ email, name: identity.name, authProvider: identity.provider, authSubject: identity.subject }).returning();
  } else if (!user.authSubject) {
    await q.update(users).set({ authProvider: identity.provider, authSubject: identity.subject, name: user.name ?? identity.name }).where(eq(users.id, user.id));
  }
  // The bootstrap list is not authority: it is honoured once, for the very first administrator, and only through the
  // ledger. Any later match is ignored and audited (21 Sep, item 2). A listed address is treated as staff above, so the
  // bootstrap never applies without Microsoft and a second factor.
  const bootstrap = await applyBootstrapAdmin(q, { userId: user.id, email, listed: (policy.bootstrapAdmins ?? []).includes(email), now });
  if (bootstrap === "granted") user = { ...user, platformRole: "platform_admin" };
  // Team invitations (docs/PRODUCT.md, D1): honoured for customers only; a staff account never joins a company this way.
  const invited = await acceptPendingInvitations(q, { user: { id: user.id, email, name: user.name ?? identity.name }, tokenHash: input.invitationTokenHash ?? null, staff: decision.staff, now, ip: input.ip });
  const ms = await q.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"))).limit(1);
  const activeCompanyId = invited.activeCompanyId ?? ms[0]?.companyId ?? null;
  const sessionToken = randomToken(32);
  const expiresAt = new Date(now.getTime() + (decision.staff ? STAFF_SESSION_MS : SESSION_IDLE_MS)).toISOString();
  const [row] = await q.insert(sessions).values({
    userId: user.id, tokenHash: hashToken(sessionToken), activeCompanyId, expiresAt, lastSeenAt: now.toISOString(), ip: input.ip ?? null, userAgent: input.userAgent ?? null,
    identityProvider: identity.provider, aal: identity.aal, mfaVerifiedAt: identity.mfaVerifiedAt,
    // When the session opened, on the caller's clock: the recent-sign-in rule (`isRecentlyAuthenticated`) reads it against the same clock.
    createdAt: (input.openedAt ?? now).toISOString(),
  }).returning({ id: sessions.id });
  await audit(q, { companyId: null, actor: { kind: "user", id: user.id, name: user.name ?? user.email }, action: "session.opened", target: { type: "user", id: user.id }, reason: identity.provider, ip: input.ip, details: { sessionId: row.id, provider: identity.provider, aal: identity.aal, staff: decision.staff, mfaVerifiedAt: identity.mfaVerifiedAt } });
  const platformAdmin = (await activeGrantFor(q, user.id))?.role === "platform_admin";
  return { sessionToken, userId: user.id, activeCompanyId, staff: decision.staff, platformAdmin, expiresAt, invitationsAccepted: invited.accepted.length };
}

/** A refused sign-in, by its code. Its message is the one sentence the sign-in page shows for that code (`SIGN_IN_REFUSAL` in packages/contracts). */
export class SignInRefused extends Error {
  status = 403;
  /** The refusal's audit record: when the sign-in ran inside a transaction that rolled back, the caller writes it again. */
  constructor(public readonly code: SignInRefusalCode, public readonly auditRecord?: Parameters<typeof audit>[1]) {
    super(SIGN_IN_REFUSAL[code]);
  }
}
