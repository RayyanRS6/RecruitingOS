import { cache } from "react";
import { cookies } from "next/headers";
import { getShell } from "./container";

export type Me = {
  user: { id: string; email: string; name: string | null; platformRole: string };
  auth: { provider: string; aal: string; mfaVerifiedAt: string | null };
  memberships: Array<{ companyId: string; companyName: string; companySlug: string; role: string }>;
  activeCompanyId: string | null;
  staffAccess?: { grantId: string; kind: string; purpose: string; expiresAt: string; companyName: string | null; scope: { escalationId: string | null; roleId: string | null; applicationId: string | null } } | null;
  ai: { provider: string };
};

/**
 * The signed-in person, resolved on the server from the session cookie by asking the mounted API in-process (no network
 * hop, same rules as every other request). Cached per request so nested layouts share one lookup.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  if (!cookie) return null;
  const { handler } = await getShell();
  const res = await handler(new Request("http://shell.local/api/v1/auth/me", { headers: { cookie } }));
  if (res.status !== 200) return null;
  return (await res.json()) as Me;
});

export const isStaff = (me: Me | null) => !!me && ["platform_admin", "its_recruiter"].includes(me.user.platformRole);
export const isAdmin = (me: Me | null) => !!me && me.user.platformRole === "platform_admin";
