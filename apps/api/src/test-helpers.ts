import { eq } from "drizzle-orm";
import { grantPlatformRole, type PlatformRole } from "@ros/core";
import { users } from "@ros/db";
import type { FakeIdentityProvider } from "@ros/integrations";
import type { createApp } from "./app";
import type { Container } from "./container";

/**
 * Test-only helpers for staff accounts. Since 21 September 2026 (item 2) platform roles come from the
 * platform_role_grants ledger and administrator routes need a session with a second factor, so suites open staff
 * sessions through the fake identity issuer (Microsoft + TOTP) instead of the email link.
 */
export async function signInWithIdentity(app: ReturnType<typeof createApp>, container: Container, input: { email: string; name?: string; provider?: "azure" | "google"; aal2?: boolean; subject?: string }): Promise<string> {
  const idp = container.integrations.identity as FakeIdentityProvider;
  const token = idp.mint({ email: input.email, name: input.name ?? input.email.split("@")[0], provider: input.provider ?? "azure", aal: input.aal2 === false ? "aal1" : "aal2", ...(input.subject ? { subject: input.subject } : {}) });
  const r = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: token }) });
  if (r.status !== 200) throw new Error(`sign-in failed (${r.status}): ${await r.text()}`);
  return r.headers.get("set-cookie")!.split(";")[0];
}

/** Seeds a platform role through the ledger (as the console would), then opens a Microsoft + second-factor session. */
export async function signInStaff(app: ReturnType<typeof createApp>, container: Container, email: string, role: PlatformRole = "platform_admin", name?: string): Promise<string> {
  let [user] = await container.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) [user] = await container.db.insert(users).values({ email: email.toLowerCase(), name: name ?? email.split("@")[0], authProvider: "azure", authSubject: `seed-${email}` }).returning();
  if (user.platformRole !== role) await grantPlatformRole(container.db, { userId: user.id, role, actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
  return signInWithIdentity(app, container, { email, name: name ?? user.name ?? undefined, provider: "azure", aal2: true, subject: user.authProvider === "azure" && user.authSubject ? user.authSubject : undefined });
}

/** Seeds a platform role through the ledger without opening a session (for accounts that sign in later in a test). */
export async function seedPlatformRole(container: Container, email: string, role: PlatformRole, name?: string): Promise<string> {
  let [user] = await container.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) [user] = await container.db.insert(users).values({ email: email.toLowerCase(), name: name ?? email.split("@")[0], authProvider: "azure", authSubject: `seed-${email}` }).returning();
  if (user.platformRole !== role) await grantPlatformRole(container.db, { userId: user.id, role, actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
  return user.id;
}

export const signInAdmin = (app: ReturnType<typeof createApp>, container: Container, email: string, name?: string) => signInStaff(app, container, email, "platform_admin", name);
