import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { activeStaffGrant, loadSession, recordStaffAccess, scopeAllows, type SessionContext, type StaffGrant } from "@ros/core";
import type { MembershipRole } from "@ros/contracts";
import { applications, interviewParticipants, interviews, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "./errors";

export type StaffAccess = { grantId: string; kind: string; purpose: string; expiresAt: string; scope: { escalationId: string | null; roleId: string | null; applicationId: string | null } };
export type Tenant = { companyId: string; role: MembershipRole; userId: string; /** Present only for ITS staff acting under a scoped, time-limited grant. */ staff?: StaffAccess };

export type Vars = {
  Variables: {
    container: Container;
    session: SessionContext | null;
    tenant: Tenant | null;
    /** Per-request content-security nonce for candidate pages (21 Sep, item 6). */
    nonce: string;
  };
};

export const SESSION_COOKIE = "ros_session";

export function isPlatformStaff(s: SessionContext | null): boolean {
  return !!s && ["platform_admin", "its_recruiter"].includes(s.user.platformRole);
}

function staffAccessOf(g: StaffGrant): StaffAccess {
  return { grantId: g.id, kind: g.kind, purpose: g.purpose, expiresAt: g.expiresAt, scope: { escalationId: g.escalationId, roleId: g.roleId, applicationId: g.applicationId } };
}

/**
 * Tenancy comes from the authenticated user's verified membership only (founder decision F1). No request header can
 * choose a company. ITS staff get tenant context only through an explicit, scoped, time-limited grant (F10), and every
 * request they make under it is recorded with the route, the grant, and its expiry.
 */
export function sessionMiddleware(container: Container): MiddlewareHandler<Vars> {
  return async (c, next) => {
    c.set("container", container);
    const token = getCookie(c, SESSION_COOKIE);
    let session: SessionContext | null = null;
    if (token) session = await loadSession(container.db, token);
    c.set("session", session);
    let tenant: Tenant | null = null;
    if (session?.activeCompanyId) {
      const m = session.memberships.find((x) => x.companyId === session.activeCompanyId && x.status === "active");
      if (m) tenant = { companyId: m.companyId, role: m.role as MembershipRole, userId: session.user.id };
      else if (isPlatformStaff(session)) {
        const grant = await activeStaffGrant(container.db, session.user.id, session.activeCompanyId);
        if (grant) {
          tenant = { companyId: grant.companyId, role: "recruiter", userId: session.user.id, staff: staffAccessOf(grant) };
          if (c.req.path.startsWith("/api/") && !c.req.path.startsWith("/api/v1/auth/")) {
            await recordStaffAccess(container.db, { grant, userName: session.user.name ?? session.user.email, method: c.req.method, path: c.req.path, ip: clientIp(c) });
          }
        }
      }
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

export const requireRecruiterOrAdmin: MiddlewareHandler<Vars> = async (c, next) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  if (!isPlatformStaff(s)) throw new HttpError(403, "forbidden", "Recruiters only.");
  if (s.aal !== "aal2") throw new HttpError(403, "mfa_required", "Staff actions need a session opened with Microsoft 365 and a second factor.");
  await next();
};

function scopeError(): HttpError {
  return new HttpError(403, "staff_scope", "Your access is limited to the role and candidate of the escalation you accepted.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The roles an interviewer interviews for: those with an interview they are on (F9: an interviewer sees their own
 * interviews). The roles list, the role page, its tabs and its interviews all go by this one rule. With `roleId`, only
 * that role is looked for.
 */
export async function rolesInterviewedBy(tx: Tx, userId: string, roleId?: string): Promise<Set<string>> {
  const rows = await tx
    .select({ roleId: applications.roleId })
    .from(interviewParticipants)
    .innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId))
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(roleId ? and(eq(interviewParticipants.userId, userId), eq(applications.roleId, roleId)) : eq(interviewParticipants.userId, userId));
  return new Set(rows.map((r) => r.roleId));
}

/** One look per request: the role routes are mounted from several groups, and each runs this guard. */
const interviewerOnRole = new WeakMap<Request, Promise<boolean>>();

/**
 * Staff acting under a grant may touch only the role the grant names. An interviewer reads only the roles they
 * interview for (the roles list's rule): any other role's page, tabs and interviews answer "Role not found.", as for a
 * role that does not exist. Their changes are refused by the permission matrix as before. Other members are unaffected.
 */
export const roleScopeGuard: MiddlewareHandler<Vars> = async (c, next) => {
  const t = c.get("tenant");
  const roleId = c.req.param("id");
  if (t?.staff) {
    if (roleId && !scopeAllows({ roleId: t.staff.scope.roleId, applicationId: t.staff.scope.applicationId }, { roleId })) throw scopeError();
  } else if (t?.role === "interviewer" && roleId && UUID.test(roleId) && (c.req.method === "GET" || c.req.method === "HEAD")) {
    let on = interviewerOnRole.get(c.req.raw);
    if (!on) {
      on = withTenant(c.get("container").db, t.companyId, async (tx) => (await rolesInterviewedBy(tx, t.userId, roleId)).has(roleId));
      interviewerOnRole.set(c.req.raw, on);
    }
    if (!(await on)) throw new HttpError(404, "not_found", "Role not found.");
  }
  await next();
};

/** Staff acting under a grant may touch only the application (or the role's applications) the grant names. */
export const applicationScopeGuard: MiddlewareHandler<Vars> = async (c, next) => {
  const t = c.get("tenant");
  if (t?.staff) {
    const id = c.req.param("id");
    if (id) {
      const [app] = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select({ id: applications.id, roleId: applications.roleId }).from(applications).where(eq(applications.id, id)).limit(1));
      if (app && !scopeAllows({ roleId: t.staff.scope.roleId, applicationId: t.staff.scope.applicationId }, { roleId: app.roleId, applicationId: app.id })) throw scopeError();
    }
  }
  await next();
};

export function actorOf(c: Context<Vars>) {
  const s = c.get("session")!;
  const t = c.get("tenant");
  if (t?.staff) return { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
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
