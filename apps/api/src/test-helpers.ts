import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { MembershipRole } from "@ros/contracts";
import { entitlements, grantPlatformRole, type PlatformRole } from "@ros/core";
import { applications, candidates, companies, interviewParticipants, interviews, memberships, users, withPlatform, withTenant } from "@ros/db";
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
 * Runs `fn` with the engine's clock moved past the 40 to 90 seconds every waiting room says "preparing" first (Q14,
 * founder 21 Oct: the same timing for a new address and a known one), then puts the clock back.
 */
export async function pastTheWaitingRoom<T>(container: Container, fn: () => Promise<T>): Promise<T> {
  const engine = container.engine as unknown as { now: () => Date };
  const real = engine.now;
  const past = real().getTime() + 91_000;
  engine.now = () => new Date(past);
  try {
    return await fn();
  } finally {
    engine.now = real;
  }
}

/**
 * Follows the apply POST as a browser does (20 Oct 2026, R20-12): its 302 to the waiting room `…/applied`, which opens
 * the application's own AI interview once it exists (with the inline worker, by the time the POST answered) and the 40
 * to 90 seconds every waiting room says "preparing" first have passed (Q14, 21 Oct): `container`'s clock is moved past
 * them for that one look. `token`: the interview the waiting room opened, else null; `html`: the page shown instead (the
 * receipt, or the waiting room).
 */
export async function followApply(app: ReturnType<typeof createApp>, res: Response, container: Container): Promise<{ token: string | null; html: string; status: number; cookie: string }> {
  const location = res.headers.get("location") ?? "";
  const cookie = res.headers.get("set-cookie")?.match(/ros_applied=[^;,]+/)?.[0] ?? "";
  if (!location.endsWith("/applied")) return { token: null, html: await res.text(), status: res.status, cookie };
  const room = await pastTheWaitingRoom(container, async () => app.request(location, { headers: { cookie } }));
  const to = room.headers.get("location") ?? "";
  const token = /^\/c\/screen\/([A-Za-z0-9_-]+)$/.exec(to)?.[1] ?? null;
  return { token, html: token ? "" : await room.text(), status: room.status, cookie };
}

/**
 * Sets ITS's old "apply and talk in one visit" switch for a company (plan Wave E), as the console did. Since 20 October
 * 2026 (R20-12) nothing reads it: every applicant takes the same path, so these only write the saved setting.
 */
async function setApplyFlowDefault(container: Container, companyId: string, flow: "one_visit" | "form_then_screen"): Promise<void> {
  await withPlatform(container.db, async (tx) => {
    // One JSON merge, as the console's own write is, so the trial dates and the ITS check written beside it are kept.
    const [co] = await tx.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('applyFlowDefault', ${flow}::text)` }).where(eq(companies.id, companyId)).returning({ id: companies.id });
    if (!co) throw new Error(`no company ${companyId}`);
  });
}

export const useLaterApplyFlow = (container: Container, companyId: string) => setApplyFlowDefault(container, companyId, "form_then_screen");
export const useOneVisitApplyFlow = (container: Container, companyId: string) => setApplyFlowDefault(container, companyId, "one_visit");

/**
 * Puts a company on a plan as the console's Change plan does (entitlements.applyPlan): for suites whose subject is not
 * the Trial plan's 30 days and 3 people (founder decision L-02 B), which move the clock past a month or invite more
 * than three people. Every plan but Trial has no limit of people and no end date.
 */
export async function usePlan(container: Container, companyId: string, planKey = "growth"): Promise<void> {
  await withPlatform(container.db, (tx) => entitlements.applyPlan(tx, companyId, planKey, "plan"));
}

/**
 * Puts the signed-in member (by their cookie) on an interview for a role, straight into the tables: an interviewer
 * opens only the roles they interview for (roleScopeGuard). The interview is a cancelled one on the role's oldest
 * application, or on a new application when the role has none, so no scheduling starts and nobody is told. `remove`
 * takes away everything it added, for suites that count the role's applications or interviews afterwards.
 */
export async function putOnInterview(container: Container, app: ReturnType<typeof createApp>, input: { cookie: string; roleId: string }): Promise<{ interviewId: string; applicationId: string; remove: () => Promise<void> }> {
  const me = (await (await app.request("/api/v1/auth/me", { headers: { cookie: input.cookie } })).json()) as { user: { id: string }; activeCompanyId: string | null };
  const companyId = me.activeCompanyId;
  if (!companyId) throw new Error("the member has no active company");
  const made = await withTenant(container.db, companyId, async (tx) => {
    let [a] = await tx.select({ id: applications.id, candidateId: applications.candidateId }).from(applications).where(eq(applications.roleId, input.roleId)).orderBy(asc(applications.createdAt)).limit(1);
    let created = false;
    if (!a) {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Ines", lastName: "Interviewed", email: `ines-${randomBytes(3).toString("hex")}@example.com`, firstSource: "direct" }).returning();
      [a] = await tx.insert(applications).values({ companyId, roleId: input.roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomBytes(16).toString("hex") }).returning({ id: applications.id, candidateId: applications.candidateId });
      created = true;
    }
    const [iv] = await tx.insert(interviews).values({ companyId, applicationId: a.id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "cancelled", timezone: "America/Los_Angeles" }).returning();
    await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: me.user.id, role: "interviewer", status: "invited" });
    return { interviewId: iv.id, applicationId: a.id, candidateId: a.candidateId, created };
  });
  // straight on the suite's connection, as the suites' own direct reads and writes are (testContainerOptions)
  const remove = async () => {
    const db = container.db;
    await db.delete(interviewParticipants).where(eq(interviewParticipants.interviewId, made.interviewId));
    await db.delete(interviews).where(eq(interviews.id, made.interviewId));
    if (made.created) {
      await db.delete(applications).where(eq(applications.id, made.applicationId));
      await db.delete(candidates).where(eq(candidates.id, made.candidateId));
    }
  };
  return { interviewId: made.interviewId, applicationId: made.applicationId, remove };
}

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
