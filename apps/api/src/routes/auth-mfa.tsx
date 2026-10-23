/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { audit, MFA_MAX_ATTEMPTS, MFA_PERSON_ATTEMPTS, MFA_PERSON_WINDOW_MS, MFA_TRANSACTION_TTL_MS, normalizeEmail, openMfaTransaction, rateLimitKey, revokeAllSessions, sealMfaTransaction, SignInRefused, type MfaTransaction } from "@ros/core";
import { sessions, users } from "@ros/db";
import { hashToken } from "@ros/core";
import { IdentityError, type MfaFactor } from "@ros/integrations";
import type { Container } from "../container";
import { clientIp, SESSION_COOKIE, type Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { fromThisSite } from "../middleware/same-site";
import { BackupOfferPage, EnrolPage, VerifyPage } from "../pages/mfa";
import { MFA_COOKIE, MFA_COOKIE_PATH, mfaCookieOptions, openSession, sessionCookieOptions } from "./auth-shared";

/**
 * The staff second factor (founder approval of 22 September 2026). After Microsoft has vouched for an ITS staff member,
 * the sign-in continues here: an authenticator app is enrolled the first time and challenged every time, through the
 * identity service, with the person's own token. Only a token the service re-issued at assurance level 2 opens a
 * session. Nothing here weakens the rule: a staff session without that level is still refused everywhere.
 *
 * Attempts are counted server-side, against the transaction's random id and against the person, so an older copy of the
 * cookie or a fresh Microsoft sign-in does not buy more guesses. Challenge and verification happen in one request because
 * the identity service requires both to come from one address.
 *
 * Recovery: the service issues no recovery codes, so a backup authenticator is offered right after enrolment and at any
 * later sign-in with a single factor; a person who loses every authenticator asks the platform owner to remove the
 * factors in the service's dashboard (docs/runbooks/staff-second-factor.md), and enrols again at the next sign-in. The
 * application holds no service key and cannot remove a factor itself.
 */
export const mfaRoutes = new Hono<Vars>();

const WRONG_CODE = "That code is not right. Check the app and try again.";

function paths(container: Container) {
  const base = `${container.env.APP_BASE_URL}/api/v1/auth/mfa`;
  return { base, backup: `${base}/backup`, skip: `${base}/skip`, cancel: `${base}/cancel`, home: `${container.env.APP_BASE_URL}/` };
}

function readTx(c: Context<Vars>, container: Container): MfaTransaction | null {
  return openMfaTransaction(getCookie(c, MFA_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
}
function saveTx(c: Context<Vars>, container: Container, tx: MfaTransaction) {
  setCookie(c, MFA_COOKIE, sealMfaTransaction(tx, container.env.SESSION_SECRET), mfaCookieOptions(container));
}
function clearTx(c: Context<Vars>, container: Container) {
  deleteCookie(c, MFA_COOKIE, { path: MFA_COOKIE_PATH, ...(container.env.raw.COOKIE_DOMAIN ? { domain: container.env.raw.COOKIE_DOMAIN } : {}) });
}
function toLogin(c: Context<Vars>, container: Container, code: string | null) {
  clearTx(c, container);
  return c.redirect(`${container.env.APP_BASE_URL}/login${code ? `?error=${encodeURIComponent(code)}` : ""}`, 302);
}
function providerFailure(c: Context<Vars>, container: Container, err: unknown) {
  if (err instanceof IdentityError) return toLogin(c, container, err.code === "mfa_session_invalid" ? "mfa_expired" : "mfa_unavailable");
  throw err;
}
const verifiedTotp = (factors: MfaFactor[]) => factors.filter((f) => f.type === "totp" && f.status === "verified");

/** "Authenticator 1", "Authenticator 2", ...: the next name the service does not already hold for this person. */
function nextFactorName(factors: MfaFactor[]): string {
  const taken = new Set(factors.map((f) => f.friendlyName ?? ""));
  for (let n = 1; n < 100; n++) if (!taken.has(`Authenticator ${n}`)) return `Authenticator ${n}`;
  return `Authenticator ${Date.now()}`;
}

/** The session that belongs to the transaction's person, or null. The backup step never acts on someone else's token. */
function sessionOf(c: Context<Vars>, tx: MfaTransaction) {
  const s = c.get("session");
  return s && normalizeEmail(s.user.email) === tx.email ? s : null;
}

/** Starts an enrolment for the person in the transaction and returns the page to show. */
async function beginEnrolment(c: Context<Vars>, container: Container, tx: MfaTransaction, backup: boolean) {
  const idp = container.integrations.identity;
  const factors = await idp.listFactors(tx.accessToken);
  // A half-finished enrolment from an abandoned attempt would otherwise pile up at the service and take a name.
  for (const f of factors.filter((x) => x.status === "unverified")) await idp.unenrolFactor(tx.accessToken, f.id).catch(() => undefined);
  const remaining = factors.filter((x) => x.status !== "unverified");
  if (!backup) {
    // Nothing enrolled although this person verified an authenticator before: the factors were removed at the service
    // (the owner's reset). Recorded, so a reset is never invisible; the person simply enrols again.
    const [known] = await container.db.select({ id: users.id, mfaEnrolledAt: users.mfaEnrolledAt }).from(users).where(eq(users.email, tx.email)).limit(1);
    if (known?.mfaEnrolledAt) await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.reset_detected", target: { type: "user", id: known.id }, reason: "no_factor_at_identity_service", ip: clientIp(c), details: { email: tx.email, previouslyEnrolledAt: known.mfaEnrolledAt } });
  }
  const enrolment = await idp.enrolTotp(tx.accessToken, { friendlyName: nextFactorName(remaining), issuer: container.env.PRODUCT_NAME });
  saveTx(c, container, { ...tx, stage: backup ? "backup_enrol" : "enrol", factorIds: [enrolment.factorId], secret: enrolment.secret, uri: enrolment.uri, notice: null });
  const p = paths(container);
  return c.html(<EnrolPage secret={enrolment.secret} uri={enrolment.uri} qrSvg={enrolment.qrCodeSvg} backup={backup} action={p.base} cancelAction={backup ? p.skip : p.cancel} />);
}

function renderStage(c: Context<Vars>, container: Container, tx: MfaTransaction) {
  const p = paths(container);
  const error = tx.notice === "last" ? `${WRONG_CODE} This is your last try.` : tx.notice === "wrong" ? WRONG_CODE : null;
  if (tx.notice) saveTx(c, container, { ...tx, notice: null });
  if (tx.stage === "enrol" || tx.stage === "backup_enrol") {
    const backup = tx.stage === "backup_enrol";
    return c.html(<EnrolPage secret={tx.secret ?? ""} uri={tx.uri ?? ""} qrSvg={null} backup={backup} error={error} action={p.base} cancelAction={backup ? p.skip : p.cancel} />);
  }
  return c.html(<VerifyPage productName={container.env.PRODUCT_NAME} error={error} action={p.base} cancelAction={p.cancel} />);
}

/** The step's page: a challenge for an enrolled authenticator, or an enrolment when the person has none yet. */
mfaRoutes.get("/", async (c) => {
  const container = c.get("container");
  const tx = readTx(c, container);
  if (!tx) return toLogin(c, container, "mfa_expired");
  const p = paths(container);
  try {
    if (tx.stage === "backup_offer") {
      if (!sessionOf(c, tx)) { clearTx(c, container); return c.redirect(p.home, 302); }
      return c.html(<BackupOfferPage backupHref={p.backup} skipAction={p.skip} />);
    }
    // A refresh shows the same setup key the person may already have scanned, and the message from a wrong code once.
    if ((tx.stage === "enrol" || tx.stage === "backup_enrol") && tx.secret && tx.factorIds.length) return renderStage(c, container, tx);
    if (tx.stage === "verify" && tx.factorIds.length) return renderStage(c, container, tx);
    const verified = verifiedTotp(await container.integrations.identity.listFactors(tx.accessToken));
    if (verified.length) {
      const next: MfaTransaction = { ...tx, stage: "verify", factorIds: verified.map((f) => f.id), secret: null, uri: null, notice: null };
      saveTx(c, container, next);
      return renderStage(c, container, next);
    }
    return await beginEnrolment(c, container, tx, false);
  } catch (err) {
    return providerFailure(c, container, err);
  }
});

/** Code entry for enrolment, sign-in verification and backup enrolment alike. */
mfaRoutes.post("/", rateLimit(POLICIES.authMfa), async (c) => {
  const container = c.get("container");
  const idp = container.integrations.identity;
  const tx = readTx(c, container);
  if (!tx) return toLogin(c, container, "mfa_expired");
  const p = paths(container);
  // A request that says it came from another site never answers a transaction (also refused app-wide, middleware/same-site.ts).
  if (!fromThisSite(c, container.env)) return c.redirect(p.base, 302);
  if (tx.stage !== "enrol" && tx.stage !== "verify" && tx.stage !== "backup_enrol") return c.redirect(p.base, 302);
  if (tx.stage === "backup_enrol" && !sessionOf(c, tx)) { clearTx(c, container); return c.redirect(p.home, 302); }
  const form = await c.req.parseBody();
  const code = String(typeof form.code === "string" ? form.code : "").replace(/\s+/g, "");
  const ip = clientIp(c);
  const now = container.engine.clock().getTime();
  // Counted before the service is asked, keyed by the transaction's random id and by the person: replaying an older
  // cookie or starting a new Microsoft sign-in does not reset either count.
  const perTransaction = await container.rateLimits.hit(rateLimitKey(container.env.SESSION_SECRET, "auth.mfa.transaction", "transaction", tx.id), MFA_TRANSACTION_TTL_MS, MFA_MAX_ATTEMPTS, now);
  const perPerson = await container.rateLimits.hit(rateLimitKey(container.env.SESSION_SECRET, "auth.mfa.person", "person", tx.subject), MFA_PERSON_WINDOW_MS, MFA_PERSON_ATTEMPTS, now);
  if (!perTransaction.allowed || !perPerson.allowed) {
    await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: "too_many_attempts", ip, details: { email: tx.email, stage: tx.stage, scope: perTransaction.allowed ? "person" : "transaction", attempts: perTransaction.count } });
    return toLogin(c, container, "mfa_failed");
  }
  let newToken: string | null = null;
  let serviceCode: string | null = null;
  if (/^\d{6}$/.test(code)) {
    // Challenge and verify in the same request: the identity service requires both to come from one address, and a
    // hosted function's outbound address can change between requests.
    for (let i = 0; i < tx.factorIds.length && !newToken; i++) {
      const factorId = tx.factorIds[i]!;
      try {
        const { challengeId } = await idp.challengeFactor(tx.accessToken, factorId, { ip });
        newToken = (await idp.verifyFactor(tx.accessToken, { factorId, challengeId, code }, { ip })).accessToken;
      } catch (err) {
        if (!(err instanceof IdentityError)) throw err;
        if (err.code === "mfa_code_invalid") { serviceCode = err.code; continue; }
        // Anything else (service disabled, address mismatch, rate limit, session gone) is not the person's mistake.
        return providerFailure(c, container, err);
      }
    }
  }
  if (!newToken) {
    const last = perTransaction.count >= MFA_MAX_ATTEMPTS;
    await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: /^\d{6}$/.test(code) ? "code_invalid" : "code_format", ip, details: { email: tx.email, stage: tx.stage, attempt: perTransaction.count, remaining: Math.max(0, MFA_MAX_ATTEMPTS - perTransaction.count), serviceCode } });
    if (last) {
      // The fifth wrong code ends the attempt: the person starts again at sign-in, with Microsoft.
      await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: "too_many_attempts", ip, details: { email: tx.email, stage: tx.stage, scope: "transaction", attempts: perTransaction.count } });
      return toLogin(c, container, "mfa_failed");
    }
    // Post, redirect, get: a refresh of the page never re-submits the code.
    saveTx(c, container, { ...tx, notice: perTransaction.count === MFA_MAX_ATTEMPTS - 1 ? "last" : "wrong" });
    return c.redirect(p.base, 303);
  }
  if (tx.stage === "backup_enrol") {
    const s = sessionOf(c, tx)!;
    await audit(container.db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "mfa.backup_enrolled", target: { type: "user", id: s.user.id }, ip, details: { email: tx.email } });
    clearTx(c, container);
    return c.redirect(p.home, 302);
  }
  // Only the service's re-issued token, verified like any other, opens the session.
  let result: Awaited<ReturnType<typeof openSession>>;
  let identity: Awaited<ReturnType<typeof idp.verify>>;
  try {
    identity = await idp.verify(newToken);
  } catch (err) {
    return providerFailure(c, container, err);
  }
  if (identity.aal !== "aal2") {
    await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: "level_not_raised", ip, details: { email: tx.email, stage: tx.stage } });
    return toLogin(c, container, "mfa_unavailable");
  }
  try {
    result = await openSession(container, c, identity);
  } catch (err) {
    if (err instanceof SignInRefused) return toLogin(c, container, err.code);
    throw err;
  }
  setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
  // From here the person is signed in; whatever fails below must not read as a failed sign-in.
  try {
    const actor = { kind: "user" as const, id: result.userId, name: identity.name ?? identity.email };
    if (tx.stage === "enrol") {
      await container.db.update(users).set({ mfaEnrolledAt: container.engine.clock().toISOString() }).where(eq(users.id, result.userId));
      await audit(container.db, { companyId: null, actor, action: "mfa.enrolled", target: { type: "user", id: result.userId }, reason: "authenticator_app", ip, details: { email: tx.email } });
      // A fresh enrolment is either the first sign-in or a re-enrolment after a reset (a lost device): every other
      // session of the person ends now, so a session on the lost device does not outlive the reset.
      const [mine] = await container.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.tokenHash, hashToken(result.sessionToken))).limit(1);
      const ended = await revokeAllSessions(container.db, result.userId, { exceptSessionId: mine?.id, now: container.engine.clock() });
      if (ended > 0) await audit(container.db, { companyId: null, actor, action: "session.revoked", target: { type: "user", id: result.userId }, reason: "authenticator_enrolled", ip, details: { email: tx.email, sessionsEnded: ended } });
    } else {
      await audit(container.db, { companyId: null, actor, action: "mfa.verified", target: { type: "user", id: result.userId }, reason: "authenticator_app", ip, details: { email: tx.email } });
    }
    const verifiedCount = verifiedTotp(await idp.listFactors(newToken)).length;
    if (verifiedCount < 2) {
      saveTx(c, container, { ...tx, accessToken: newToken, stage: "backup_offer", factorIds: [], secret: null, uri: null, notice: null, expiresAt: container.engine.clock().getTime() + MFA_TRANSACTION_TTL_MS });
      return c.html(<BackupOfferPage backupHref={p.backup} skipAction={p.skip} />);
    }
  } catch {
    // The backup offer is a convenience; the session stands.
  }
  clearTx(c, container);
  return c.redirect(p.home, 302);
});

/** Enrol a second authenticator while the level-2 token from this sign-in is still at hand. */
mfaRoutes.get("/backup", async (c) => {
  const container = c.get("container");
  const tx = readTx(c, container);
  const p = paths(container);
  if (!tx || (tx.stage !== "backup_offer" && tx.stage !== "backup_enrol") || !sessionOf(c, tx)) { clearTx(c, container); return c.redirect(p.home, 302); }
  try {
    // A refresh keeps the setup key the person may already have scanned.
    if (tx.stage === "backup_enrol" && tx.secret && tx.factorIds.length) return renderStage(c, container, tx);
    return await beginEnrolment(c, container, tx, true);
  } catch (err) {
    if (err instanceof IdentityError && (err.code === "mfa_factor_conflict" || err.code === "mfa_aal2_required")) { clearTx(c, container); return c.redirect(p.home, 302); }
    return providerFailure(c, container, err);
  }
});

mfaRoutes.post("/skip", async (c) => {
  const container = c.get("container");
  const p = paths(container);
  if (!fromThisSite(c, container.env)) return c.redirect(p.base, 302);
  clearTx(c, container);
  return c.redirect(p.home, 302);
});

mfaRoutes.post("/cancel", async (c) => {
  const container = c.get("container");
  if (!fromThisSite(c, container.env)) return c.redirect(paths(container).base, 302);
  return toLogin(c, container, null);
});
