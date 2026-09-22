/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { audit, MFA_MAX_ATTEMPTS, MFA_TRANSACTION_TTL_MS, openMfaTransaction, sealMfaTransaction, SignInRefused, type MfaTransaction } from "@ros/core";
import { users } from "@ros/db";
import { IdentityError, type MfaFactor } from "@ros/integrations";
import type { Container } from "../container";
import { clientIp, SESSION_COOKIE, type Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { BackupOfferPage, EnrolPage, VerifyPage } from "../pages/mfa";
import { MFA_COOKIE, MFA_COOKIE_PATH, mfaCookieOptions, openSession, sessionCookieOptions } from "./auth-shared";

/**
 * The staff second factor (founder approval of 22 September 2026). After Microsoft has vouched for an ITS staff member,
 * the sign-in continues here: an authenticator app is enrolled the first time and challenged every time, through the
 * identity service, with the person's own token. Only a token the service re-issued at assurance level 2 opens a
 * session. Nothing here weakens the rule: a staff session without that level is still refused everywhere.
 *
 * Recovery: the service issues no recovery codes, so a backup authenticator is offered right after enrolment and at any
 * later sign-in with a single factor; a person who loses every authenticator asks the platform owner to remove the
 * factors in the service's dashboard (docs/runbooks/staff-second-factor.md), and enrols again at the next sign-in. The
 * application holds no service key and cannot remove a factor itself.
 */
export const mfaRoutes = new Hono<Vars>();

const PRIMARY_NAME = "Primary authenticator";
const BACKUP_NAME = "Backup authenticator";
const WRONG_CODE = "That code is not right. Check the app and try again.";

function paths(container: Container) {
  const base = `${container.env.APP_BASE_URL}/api/v1/auth/mfa`;
  return { base, backup: `${base}/backup`, skip: `${base}/skip`, cancel: `${base}/cancel`, home: `${container.env.WEB_BASE_URL}/` };
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
  return c.redirect(`${container.env.WEB_BASE_URL}/login${code ? `?error=${encodeURIComponent(code)}` : ""}`, 302);
}
function providerFailure(c: Context<Vars>, container: Container, err: unknown) {
  if (err instanceof IdentityError) return toLogin(c, container, err.code === "mfa_session_invalid" ? "mfa_expired" : "mfa_unavailable");
  throw err;
}
const verifiedTotp = (factors: MfaFactor[]) => factors.filter((f) => f.type === "totp" && f.status === "verified");

/** Starts an enrolment for the person in the transaction and returns the page to show. */
async function beginEnrolment(c: Context<Vars>, container: Container, tx: MfaTransaction, backup: boolean) {
  const idp = container.integrations.identity;
  const factors = await idp.listFactors(tx.accessToken);
  // A half-finished enrolment from an abandoned attempt would otherwise pile up at the service.
  for (const f of factors.filter((x) => x.status === "unverified")) await idp.unenrolFactor(tx.accessToken, f.id).catch(() => undefined);
  if (!backup) {
    // Nothing enrolled although this person verified an authenticator before: the factors were removed at the service
    // (the owner's reset). Recorded, so a reset is never invisible; the person simply enrols again.
    const [known] = await container.db.select({ id: users.id, mfaEnrolledAt: users.mfaEnrolledAt }).from(users).where(eq(users.email, tx.email)).limit(1);
    if (known?.mfaEnrolledAt) await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.reset_detected", target: { type: "user", id: known.id }, reason: "no_factor_at_identity_service", ip: clientIp(c), details: { email: tx.email, previouslyEnrolledAt: known.mfaEnrolledAt } });
  }
  const enrolment = await idp.enrolTotp(tx.accessToken, { friendlyName: backup ? BACKUP_NAME : PRIMARY_NAME, issuer: container.env.PRODUCT_NAME });
  saveTx(c, container, { ...tx, stage: backup ? "backup_enrol" : "enrol", factorIds: [enrolment.factorId], secret: enrolment.secret, uri: enrolment.uri, attempts: 0 });
  const p = paths(container);
  return c.html(<EnrolPage productName={container.env.PRODUCT_NAME} secret={enrolment.secret} uri={enrolment.uri} qrSvg={enrolment.qrCodeSvg} backup={backup} action={p.base} cancelAction={backup ? p.home : p.cancel} />);
}

function renderStage(c: Context<Vars>, container: Container, tx: MfaTransaction, error: string | null) {
  const p = paths(container);
  if (tx.stage === "enrol" || tx.stage === "backup_enrol") {
    const backup = tx.stage === "backup_enrol";
    return c.html(<EnrolPage productName={container.env.PRODUCT_NAME} secret={tx.secret ?? ""} uri={tx.uri ?? ""} qrSvg={null} backup={backup} error={error} action={p.base} cancelAction={backup ? p.home : p.cancel} />);
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
    if (tx.stage === "backup_offer") return c.html(<BackupOfferPage backupHref={p.backup} skipAction={p.skip} continueHref={p.home} />);
    // A refresh shows the same secret the person may already have scanned.
    if ((tx.stage === "enrol" || tx.stage === "backup_enrol") && tx.secret && tx.factorIds.length) return renderStage(c, container, tx, null);
    const verified = verifiedTotp(await container.integrations.identity.listFactors(tx.accessToken));
    if (verified.length) {
      const next: MfaTransaction = { ...tx, stage: "verify", factorIds: verified.map((f) => f.id), secret: null, uri: null };
      saveTx(c, container, next);
      return renderStage(c, container, next, null);
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
  if (tx.stage !== "enrol" && tx.stage !== "verify" && tx.stage !== "backup_enrol") return c.redirect(p.base, 302);
  const form = await c.req.parseBody();
  const code = String(typeof form.code === "string" ? form.code : "").replace(/\s+/g, "");
  const attempts = tx.attempts + 1;
  const ip = clientIp(c);
  if (attempts > MFA_MAX_ATTEMPTS) {
    await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: "too_many_attempts", ip, details: { email: tx.email, stage: tx.stage, attempts } });
    return toLogin(c, container, "mfa_failed");
  }
  let newToken: string | null = null;
  if (/^\d{6}$/.test(code)) {
    // Challenge and verify in the same request: the identity service requires both to come from one address, and a
    // hosted function's outbound address can change between requests.
    for (let i = 0; i < tx.factorIds.length && !newToken; i++) {
      const factorId = tx.factorIds[i]!;
      try {
        const { challengeId } = await idp.challengeFactor(tx.accessToken, factorId);
        newToken = (await idp.verifyFactor(tx.accessToken, { factorId, challengeId, code })).accessToken;
      } catch (err) {
        if (!(err instanceof IdentityError)) throw err;
        if (err.code === "mfa_code_invalid" || err.code === "mfa_challenge_expired" || err.code === "mfa_challenge_invalid") continue;
        return providerFailure(c, container, err);
      }
    }
  }
  if (!newToken) {
    await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "mfa.failed", reason: /^\d{6}$/.test(code) ? "code_invalid" : "code_format", ip, details: { email: tx.email, stage: tx.stage, attempt: attempts, remaining: MFA_MAX_ATTEMPTS - attempts } });
    saveTx(c, container, { ...tx, attempts });
    return renderStage(c, container, tx, attempts >= MFA_MAX_ATTEMPTS ? `${WRONG_CODE} This is your last try.` : WRONG_CODE);
  }
  try {
    if (tx.stage === "backup_enrol") {
      const s = c.get("session");
      await audit(container.db, { companyId: null, actor: s ? { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email } : { kind: "system", id: "sign_in" }, action: "mfa.backup_enrolled", target: s ? { type: "user", id: s.user.id } : undefined, ip, details: { email: tx.email } });
      clearTx(c, container);
      return c.redirect(p.home, 302);
    }
    // Only the service's re-issued token, verified like any other, opens the session.
    const identity = await idp.verify(newToken);
    if (identity.aal !== "aal2") return toLogin(c, container, "mfa_unavailable");
    let result: Awaited<ReturnType<typeof openSession>>;
    try {
      result = await openSession(container, c, identity);
    } catch (err) {
      if (err instanceof SignInRefused) return toLogin(c, container, err.code);
      throw err;
    }
    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
    const actor = { kind: "user" as const, id: result.userId, name: identity.name ?? identity.email };
    if (tx.stage === "enrol") {
      await container.db.update(users).set({ mfaEnrolledAt: container.engine.clock().toISOString() }).where(eq(users.id, result.userId));
      await audit(container.db, { companyId: null, actor, action: "mfa.enrolled", target: { type: "user", id: result.userId }, reason: "authenticator_app", ip, details: { email: tx.email, friendlyName: PRIMARY_NAME } });
    } else {
      await audit(container.db, { companyId: null, actor, action: "mfa.verified", target: { type: "user", id: result.userId }, reason: "authenticator_app", ip, details: { email: tx.email } });
    }
    const verifiedCount = verifiedTotp(await idp.listFactors(newToken)).length;
    if (verifiedCount < 2) {
      saveTx(c, container, { ...tx, accessToken: newToken, stage: "backup_offer", factorIds: [], secret: null, uri: null, attempts: 0, expiresAt: container.engine.clock().getTime() + MFA_TRANSACTION_TTL_MS });
      return c.html(<BackupOfferPage backupHref={p.backup} skipAction={p.skip} continueHref={p.home} />);
    }
    clearTx(c, container);
    return c.redirect(p.home, 302);
  } catch (err) {
    return providerFailure(c, container, err);
  }
});

/** Enrol a second authenticator while the level-2 token from this sign-in is still at hand. */
mfaRoutes.get("/backup", async (c) => {
  const container = c.get("container");
  const tx = readTx(c, container);
  if (!tx || (tx.stage !== "backup_offer" && tx.stage !== "backup_enrol") || !c.get("session")) return c.redirect(paths(container).home, 302);
  try {
    return await beginEnrolment(c, container, tx, true);
  } catch (err) {
    return providerFailure(c, container, err);
  }
});

mfaRoutes.post("/skip", async (c) => {
  const container = c.get("container");
  clearTx(c, container);
  return c.redirect(paths(container).home, 302);
});

mfaRoutes.get("/cancel", async (c) => {
  const container = c.get("container");
  return toLogin(c, container, null);
});
