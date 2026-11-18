import type { Context, MiddlewareHandler } from "hono";
import { loadSession, type SessionContext } from "@ros/core";
import type { MembershipRole } from "@ros/contracts";
import type { Container } from "../container";
import { SESSION_COOKIE } from "../cookie-names";
import { readAppCookie, type CookiePlace } from "../cookies";
import { HttpError } from "./errors";

export type Tenant = { companyId: string; role: MembershipRole; userId: string };

export type Vars = {
  Variables: {
    container: Container;
    session: SessionContext | null;
    tenant: Tenant | null;
    /** Per-request content-security nonce for candidate pages (21 Sep, item 6). */
    nonce: string;
  };
};

export { SESSION_COOKIE };
/** The session cookie lives on Path=/, shared across the hosts COOKIE_DOMAIN names: "__Host-ros_session" over https without it (cookie-names.ts). */
export const SESSION_PLACE: CookiePlace = { path: "/", shared: true };

export function readSessionCookie(c: Context<Vars>): string | undefined {
  return readAppCookie(c, SESSION_COOKIE, SESSION_PLACE);
}

/**
 * Tenancy comes from the authenticated user's verified membership only (founder decision F1). No request header can
 * choose a company.
 */
export function sessionMiddleware(container: Container): MiddlewareHandler<Vars> {
  return async (c, next) => {
    c.set("container", container);
    const token = readSessionCookie(c);
    let session: SessionContext | null = null;
    if (token) session = await loadSession(container.db, token);
    c.set("session", session);
    let tenant: Tenant | null = null;
    if (session?.activeCompanyId) {
      const m = session.memberships.find((x) => x.companyId === session.activeCompanyId && x.status === "active");
      if (m) tenant = { companyId: m.companyId, role: m.role as MembershipRole, userId: session.user.id };
    }
    c.set("tenant", tenant);
    await next();
  };
}

export const requireUser: MiddlewareHandler<Vars> = async (c, next) => {
  if (!c.get("session")) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  await next();
};

export const requireTenant: MiddlewareHandler<Vars> = async (c, next) => {
  if (!c.get("session")) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  if (!c.get("tenant")) throw new HttpError(403, "no_company", "Create or join a company first.");
  await next();
};

export const requirePlatformAdmin: MiddlewareHandler<Vars> = async (c, next) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  if (s.user.platformRole !== "platform_admin") throw new HttpError(403, "forbidden", "Platform administrators only.");
  // Item 2 of the 21 Sep instruction: the role alone is not enough; the session must carry a verified second factor.
  if (s.aal !== "aal2") throw new HttpError(403, "mfa_required", "Administrator actions need a session opened with Microsoft 365 and a second factor.");
  await next();
};

const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether an id in a path is written the one way the database writes it, which is how the product hands every id out. A
 * guard must refuse anything else, never pass it on: Postgres also reads the same bytes with no hyphens, with hyphens
 * elsewhere, in braces or in capitals, so a handler would find the row a guard that looks only at this form had skipped.
 */
export const isCanonicalId = (id: string): boolean => CANONICAL_ID.test(id);

/**
 * An id not written the database's way names no job, for every reader and every method: a plain 404 before any query,
 * never the database refusing the cast as a 500. Nobody signed in to a company is left to `requireTenant`.
 */
export const roleScopeGuard: MiddlewareHandler<Vars> = async (c, next) => {
  const roleId = c.req.param("id");
  if (c.get("tenant") && roleId && !isCanonicalId(roleId)) throw new HttpError(404, "not_found", "Role not found.");
  await next();
};

export function actorOf(c: Context<Vars>) {
  const s = c.get("session")!;
  return { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
}

/**
 * The client address as the trusted proxy reports it: the entry TRUST_PROXY_HOPS from the right of X-Forwarded-For (a
 * client can prepend entries but cannot append after the proxy). Empty or missing headers count as "unknown", still a
 * subject for limits, never a way around them.
 */
export function clientIp(c: Context<Vars>): string | undefined {
  const hops = c.get("container")?.env.TRUST_PROXY_HOPS ?? 1;
  const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length) return parts[Math.max(0, parts.length - Math.max(1, hops))];
  const real = c.req.header("x-real-ip")?.trim();
  return real || undefined;
}
