import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, inspectConnectionRole, problemsWithConnectionRole, rowsOf, withPlatform, withTenant, type DbHandle } from "./client";
import { migrate } from "./migrate";
import {
  aiRuns, applications, approvalRequests, auditRecords, candidates, communications, companies, documents, entitlements, events,
  interventions, memberships, notifications, policies, recruiterEscalations, roles, screens, usageEvents, users, workflowRuns,
} from "./schema";

/**
 * Tenant isolation is enforced by Postgres, not by application code (founder decision F1). These tests prove it on
 * PGlite, and on a real Postgres test database through TEST_DATABASE_URL: every table with a company_id is protected;
 * a tenant transaction sees and writes only its own rows; the tenant role cannot use platform mode; the application
 * role sees nothing outside platform mode. The proof is what happens inside withTenant, where the policies judge the
 * current role app_tenant; the connection itself is PGlite's superuser or the owner of the test database.
 */

/**
 * The application roles cannot run this file: they may not read the migration ledger, and the rows seeded here are
 * read back outside tenant transactions, which relies on the connection seeing every company (docs/readiness/03
 * section 2). Through the Supabase pooler the user is written `<role>.<project ref>`.
 */
function refuseApplicationRole(url: string): void {
  let user = "";
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    return; // a malformed string is reported by createDb in its own words
  }
  if (/^(ros_app|ros_worker|app_tenant)(\.|$)/.test(user)) throw new Error(`TEST_DATABASE_URL connects as ${user}: use the owner role of an empty test database (the one that applied its migrations), never ros_app or ros_worker (docs/readiness/03 section 2)`);
}

describe("row-level security", () => {
  let handle: DbHandle;
  let a: string;
  let b: string;
  let userA: string;
  let userB: string;
  let roleA: string;
  let roleB: string;

  const actor = { kind: "system" as const, id: "test" };
  /** Whether the connection may switch to each application role: a superuser (PGlite) always may; a Postgres owner only after the grant docs/readiness/03 section 2 names. */
  const canBecome = { app: true, worker: true };

  beforeAll(async () => {
    // In-memory PGlite by default; with TEST_DATABASE_URL the same proof runs on a real Postgres test database, connected as that database's owner role (docs/readiness/03 section 2).
    const testUrl = process.env.TEST_DATABASE_URL?.trim();
    if (testUrl) refuseApplicationRole(testUrl);
    handle = await createDb(testUrl ? { databaseUrl: testUrl } : { pgliteDir: "memory://" });
    await migrate(handle);
    const membership = rowsOf<{ app: boolean; worker: boolean }>(await handle.db.execute(sql`SELECT pg_has_role(current_user, 'ros_app', 'MEMBER') AS app, pg_has_role(current_user, 'ros_worker', 'MEMBER') AS worker`));
    canBecome.app = !!membership[0]?.app;
    canBecome.worker = !!membership[0]?.worker;
    // Seed one row per tenant in a broad set of tables, in platform context (explicit, so a connection that does not bypass row-level security seeds the same way a superuser does).
    await withPlatform(handle.db, async (tx) => {
      const [ca] = await tx.insert(companies).values({ name: "A", slug: "a", vertical: "dental", sizeBand: "20-49" }).returning();
      const [cb] = await tx.insert(companies).values({ name: "B", slug: "b", vertical: "dental", sizeBand: "20-49" }).returning();
      a = ca.id;
      b = cb.id;
      const [ua] = await tx.insert(users).values({ email: "a@example.test" }).returning();
      const [ub] = await tx.insert(users).values({ email: "b@example.test" }).returning();
      userA = ua.id;
      userB = ub.id;
      for (const [companyId, userId, label] of [[a, userA, "A"], [b, userB, "B"]] as const) {
        const [role] = await tx.insert(roles).values({ companyId, title: `Hygienist ${label}`, createdBy: actor }).returning();
        if (label === "A") roleA = role.id; else roleB = role.id;
        await tx.insert(memberships).values({ companyId, userId, role: "owner", status: "active" });
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: label, lastName: "Candidate", email: `${label.toLowerCase()}c@example.test`, firstSource: "careers_page", dedupeKey: `email:${label.toLowerCase()}c@example.test` }).returning();
        const [app] = await tx.insert(applications).values({ companyId, roleId: role.id, candidateId: cand.id, packetVersion: 1, source: "careers_page", statusToken: `tok-${label}` }).returning();
        await tx.insert(documents).values({ companyId, candidateId: cand.id, applicationId: app.id, kind: "resume", filename: "r.txt", mime: "text/plain", sizeBytes: 1, storageKey: `${label}/r`, sha256: label });
        await tx.insert(communications).values({ companyId, candidateId: cand.id, applicationId: app.id, direction: "outbound", channel: "email", bodyText: `hello ${label}`, sentBy: actor });
        await tx.insert(screens).values({ companyId, applicationId: app.id, channel: "web", token: `screen-${label}` });
        await tx.insert(notifications).values({ companyId, userId, kind: "test", title: label, body: label });
        await tx.insert(events).values({ companyId, type: "role.created", actor, subjectType: "role", subjectId: role.id });
        await tx.insert(auditRecords).values({ companyId, actor, action: "candidate.viewed" });
        await tx.insert(workflowRuns).values({ companyId, workflowKey: "test", subject: { type: "role", id: role.id }, currentStep: "x" });
        await tx.insert(aiRuns).values({ companyId, agent: "t", task: "triage.assess", provider: "fake", model: "fake", promptKey: "k", promptVersion: 1, promptHash: "h" });
        await tx.insert(recruiterEscalations).values({ companyId, kind: "ask", question: label, requestedBy: actor });
        await tx.insert(policies).values({ companyId, actionType: "application.invite_screen", level: "approval", createdBy: actor });
        await tx.insert(approvalRequests).values({ companyId, actionType: "application.invite_screen", subject: { type: "application", id: app.id }, requestedBy: actor });
        await tx.insert(interventions).values({ companyId, roleId: role.id, detector: "candidates_waiting", ladderLevel: "brief" });
        await tx.insert(entitlements).values({ companyId, key: "text_screens", limit: 10 });
        await tx.insert(usageEvents).values({ companyId, key: "text_screens", quantity: 1, unit: "screen" });
      }
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("every table with a company_id has row-level security enabled and a tenant policy", async () => {
    const tables = rowsOf<{ table_name: string; relrowsecurity: boolean; policies: number | string }>(
      await handle.db.execute(sql`
        SELECT c.table_name, pc.relrowsecurity,
               (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.table_name AND p.policyname = 'tenant_isolation') AS policies
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        JOIN pg_class pc ON pc.relname = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE'
      `),
    );
    expect(tables.length).toBeGreaterThan(25);
    const unprotected = tables.filter((t) => !t.relrowsecurity || Number(t.policies) !== 1).map((t) => t.table_name);
    expect(unprotected).toEqual([]);
  });

  it("a tenant sees only its own rows in every seeded table", async () => {
    const tablesToCheck = [
      roles, memberships, candidates, applications, documents, communications, screens, notifications, events, auditRecords,
      workflowRuns, aiRuns, recruiterEscalations, policies, approvalRequests, interventions, entitlements, usageEvents,
    ];
    for (const table of tablesToCheck) {
      const seenByA = await withTenant(handle.db, a, (tx) => tx.select().from(table));
      const seenByB = await withTenant(handle.db, b, (tx) => tx.select().from(table));
      expect(seenByA.length, `A on ${String((table as unknown as { _: { name: string } })._?.name ?? table)}`).toBe(1);
      expect(seenByB.length).toBe(1);
      expect((seenByA[0] as { companyId: string }).companyId).toBe(a);
      expect((seenByB[0] as { companyId: string }).companyId).toBe(b);
    }
    const seenByA = await withTenant(handle.db, a, (tx) => tx.select().from(roles));
    expect(seenByA.map((r) => r.title)).toEqual(["Hygienist A"]);
  });

  it("a tenant cannot read another company's row even by id, nor the other company or its users", async () => {
    const rows = await withTenant(handle.db, a, (tx) => tx.select().from(roles).where(eq(roles.companyId, b)));
    expect(rows).toHaveLength(0);
    const byId = await withTenant(handle.db, a, (tx) => tx.select().from(roles).where(eq(roles.id, roleB)));
    expect(byId).toHaveLength(0);
    const cos = await withTenant(handle.db, a, (tx) => tx.select().from(companies));
    expect(cos.map((c) => c.id)).toEqual([a]);
    const us = await withTenant(handle.db, a, (tx) => tx.select().from(users));
    expect(us.map((u) => u.id)).toEqual([userA]);
  });

  it("a tenant cannot write another company's row, and updates or deletes across tenants affect nothing", async () => {
    await expect(
      withTenant(handle.db, a, (tx) => tx.insert(roles).values({ companyId: b, title: "Smuggled", createdBy: actor })),
    ).rejects.toSatisfy((e: unknown) => {
      const err = e as Error & { cause?: { message?: string } };
      return /row-level security/.test(err.message) || /row-level security/.test(err.cause?.message ?? "");
    });
    const updated = await withTenant(handle.db, a, (tx) => tx.update(roles).set({ title: "Renamed" }).where(eq(roles.id, roleB)).returning());
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(handle.db, a, (tx) => tx.delete(roles).where(eq(roles.id, roleB)).returning());
    expect(deleted).toHaveLength(0);
    const stillThere = await withPlatform(handle.db, (tx) => tx.select().from(roles).where(eq(roles.id, roleB)));
    expect(stillThere[0].title).toBe("Hygienist B");
    // moving a row to another tenant is a cross-tenant write too
    const moved = await withTenant(handle.db, a, (tx) => tx.update(roles).set({ companyId: b }).where(eq(roles.id, roleA)).returning()).catch((e: Error) => e);
    expect(moved).toBeInstanceOf(Error);
  });

  it("the tenant role cannot use platform mode to see other tenants", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
      await tx.execute(sql`SELECT set_config('app.company_id', ${a}, true)`);
      return tx.select().from(roles);
    });
    expect(rows.map((r) => r.title)).toEqual(["Hygienist A"]);
    const none = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
      return tx.select().from(roles);
    });
    expect(none).toHaveLength(0);
  });

  it("the application role sees nothing outside platform mode and everything inside it", async ({ skip }) => {
    skip(!canBecome.app, "this connection cannot become ros_app; grant it to the owner role of the test database (docs/readiness/03 section 2)");
    const outside = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ros_app`);
      return tx.select().from(roles);
    });
    expect(outside).toHaveLength(0);
    const inside = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ros_app`);
      await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
      return tx.select().from(roles);
    });
    expect(inside).toHaveLength(2);
    // and the application role can still enter a tenant transaction
    const asTenant = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ros_app`);
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      await tx.execute(sql`SELECT set_config('app.company_id', ${b}, true)`);
      return tx.select().from(roles);
    });
    expect(asTenant.map((r) => r.title)).toEqual(["Hygienist B"]);
  });

  it("the API role cannot claim jobs; the worker role can", async ({ skip }) => {
    skip(!canBecome.app || !canBecome.worker, "this connection cannot become ros_app and ros_worker; grant them to the owner role of the test database (docs/readiness/03 section 2)");
    await withPlatform(handle.db, (tx) => tx.execute(sql`INSERT INTO jobs (kind, payload) VALUES ('workflow.tick', '{}'::jsonb)`));
    const denied = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ros_app`);
      await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
      return tx.execute(sql`UPDATE jobs SET status = 'done'`).then(() => "allowed").catch((e: Error & { cause?: { message?: string } }) => `${e.message} ${e.cause?.message ?? ""}`);
    }).catch((e: Error & { cause?: { message?: string } }) => `${e.message} ${e.cause?.message ?? ""}`);
    expect(String(denied)).toMatch(/permission denied/);
    const allowed = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE ros_worker`);
      await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
      await tx.execute(sql`UPDATE jobs SET status = 'done'`);
      return "allowed";
    });
    expect(allowed).toBe("allowed");
  });

  it("the platform context sees everything, and the boot check knows the connection's role", async () => {
    const all = await withPlatform(handle.db, (tx) => tx.select().from(roles));
    expect(all).toHaveLength(2);
    const info = await inspectConnectionRole(handle);
    if (handle.kind === "pglite") {
      expect(info.superuser).toBe(true); // PGlite runs as a superuser; production refuses this
      expect(problemsWithConnectionRole(info, "postgres").some((p) => /superuser/.test(p))).toBe(true);
    } else {
      // A real Postgres run connects as the owner of the test database (docs/readiness/03 section 2): never an application role, able to enter tenant transactions (the cases above just did), and in platform mode from the start. The role is printed so the run's record carries it.
      console.log(`[rls] connected as ${info.role} on postgres`);
      expect(info.role).not.toMatch(/^(ros_app|ros_worker|app_tenant)$/);
      expect(info.canBecomeTenant).toBe(true);
      expect(info.platformMode).toBe(true);
    }
    expect(problemsWithConnectionRole({ role: "ros_app", superuser: false, bypassRls: false, canBecomeTenant: true, platformMode: true }, "postgres")).toEqual([]);
  });
});
