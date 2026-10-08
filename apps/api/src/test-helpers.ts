import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MembershipRole } from "@ros/contracts";
import { grantPlatformRole, type PlatformRole } from "@ros/core";
import { applications, candidates, companies, memberships, users, withPlatform } from "@ros/db";
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

/**
 * Where a suite's database lives (docs/readiness/03 section 2). By default the in-memory PGlite every suite has always
 * used. With TEST_DATABASE_URL set, the isolation and privacy suites run against that Postgres database instead: an
 * empty test database, connected as its owner role (the one that applied the migrations there, the same kind of
 * string as MIGRATE_DATABASE_URL), never as `ros_app` or `ros_worker`. The application roles cannot read the
 * migration ledger the container checks at boot, and those suites read and write tables straight on `container.db`
 * between requests, outside withTenant and withPlatform, which relies on the connection seeing every company's rows
 * the way PGlite's superuser does (an owner or bypassing role sees them; so does any role in platform mode, which
 * every Postgres connection enters when it opens). The proof of row-level security is what happens inside withTenant,
 * where the policies judge the current role `app_tenant`, not the session role. The suite's own environment (fake
 * providers, inline worker) is kept; only the database changes.
 */
export function testContainerOptions(env: Record<string, string | undefined>): { memory: boolean; env: Record<string, string | undefined> } {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) return { memory: true, env };
  refuseApplicationRole(url);
  return { memory: false, env: { ...env, DATABASE_URL: url, PGLITE_DIR: undefined } };
}

/** An application-role string fails at boot on the migration ledger and then on every direct read; better one plain sentence first. */
export function refuseApplicationRole(url: string): void {
  let user = "";
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    return; // a malformed string is reported by createDb in its own words
  }
  // Through the Supabase pooler the user is written `<role>.<project ref>`.
  if (/^(ros_app|ros_worker|app_tenant)(\.|$)/.test(user)) throw new Error(`TEST_DATABASE_URL connects as ${user}: use the owner role of an empty test database (the one that applied its migrations), never ros_app or ros_worker; the application roles cannot read the migration ledger and the suites' direct reads rely on seeing every row (docs/readiness/03 section 2)`);
}

/**
 * The status token of the application an address made for a role. Since Wave 0 item 0.1 the apply form answers every
 * submission with the same receipt and the link travels only by email, so suites read it from the database.
 */
export async function statusTokenFor(container: Container, input: { roleId: string; email: string }): Promise<string> {
  const [row] = await container.db.select({ token: applications.statusToken }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, input.roleId), eq(candidates.email, input.email.trim().toLowerCase()))).limit(1);
  if (!row) throw new Error(`no application from ${input.email} for role ${input.roleId}`);
  return row.token;
}

/**
 * Sets how a company's roles meet the screening conversation (plan Wave E), as ITS does from its console. A company
 * with no setting takes "form now, conversation later" (the one-visit flow runs on pilot roles first, founder decision
 * B1); suites about the conversation offered in the same visit as the form start their company with `useOneVisitApplyFlow`.
 * Suites about the emailed invitation say so with `useLaterApplyFlow`, so they keep testing it whatever the default.
 */
async function setApplyFlowDefault(container: Container, companyId: string, flow: "one_visit" | "form_then_screen"): Promise<void> {
  await withPlatform(container.db, async (tx) => {
    const [co] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co) throw new Error(`no company ${companyId}`);
    await tx.update(companies).set({ settings: { ...co.settings, applyFlowDefault: flow } }).where(eq(companies.id, companyId));
  });
}

export const useLaterApplyFlow = (container: Container, companyId: string) => setApplyFlowDefault(container, companyId, "form_then_screen");
export const useOneVisitApplyFlow = (container: Container, companyId: string) => setApplyFlowDefault(container, companyId, "one_visit");

/**
 * A customer with a membership of the given role in the company, signed in through the fake Google issuer (docs/spec/21,
 * area A: per-role coverage). Creates the person and the membership when they do not exist yet, then returns the
 * session cookie with that company active. The email defaults to a fresh address so each call is a distinct person.
 */
export async function signInAs(container: Container, app: ReturnType<typeof createApp>, input: { companyId: string; role: MembershipRole; email?: string; name?: string }): Promise<string> {
  const email = (input.email ?? `${input.role.replace(/_/g, "-")}-${randomBytes(3).toString("hex")}@member.test`).toLowerCase();
  const name = input.name ?? email.split("@")[0];
  await withPlatform(container.db, async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) [user] = await tx.insert(users).values({ email, name }).returning();
    const [existing] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.companyId, input.companyId), eq(memberships.userId, user.id))).limit(1);
    if (existing) await tx.update(memberships).set({ role: input.role, status: "active" }).where(eq(memberships.id, existing.id));
    else await tx.insert(memberships).values({ companyId: input.companyId, userId: user.id, role: input.role, status: "active" });
  });
  const cookie = await signInWithIdentity(app, container, { email, name, provider: "google", aal2: false });
  const sw = await app.request("/api/v1/auth/switch", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ companyId: input.companyId }) });
  if (sw.status !== 200) throw new Error(`could not enter company ${input.companyId} as ${input.role} (${sw.status}): ${await sw.text()}`);
  return cookie;
}
