import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { ADMIN_COMPANY_STATUS_LABEL, AI_CREDIT_AVAILABLE, ApplicationStage, CustomerAccessChange, PLAN_REQUEST_ALERT_KIND, PUBLIC_PLAN_KEYS, PlanChange, ROLE_STATUS_LABEL, TrialExtensionRequest, accessDecisionsFor, adminCompanyStatus, isPublicPlanKey, newTrialTerm, onTrialPlan, planRequestWords, tabOf, trialStanding, trialTermOf, type AdminAlert, type AdminCompany, type AdminCompanyJobs, type AdminCostRow, type AdminFailures, type AdminJobRow, type AdminPlanOption, type AdminPlanRequest, type AdminQueue, type CspReports, type CustomerAccessAnswer, type EmailSuppression, type PlanChangeAnswer, type PlatformRoleChanged, type PlatformRoleGrants, type RoleStatus, type SessionsRevoked, type TrialExtensionAnswer } from "@ros/contracts";
import { BUSINESS_TIMEZONE, PlatformRoleError, STANDING_STATUSES, acknowledgeAlert, aiCreditLines, audit, countActiveAdmins, emit, entitlements, grantPlatformRole, isCompanyLive, listCspReports, listPlatformRoleGrants, listSuppressions, openAlerts, raiseAlert, releaseSuppression, resolveAlert, resolveAlertsFor, reviewCspReport, revokeAllSessions, revokePlatformRole, settleAiCreditAlerts, suppressAddress, zonedToUtc } from "@ros/core";
import { adminAlerts, aiRuns, applications, companies, events, jobs, memberships, plans, roles, users, workflowRuns, withPlatform } from "@ros/db";
import { mailbox } from "@ros/integrations";
import { unlockApplicants } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { requirePlatformAdmin, type Vars } from "../middleware/session";
import { resetSitemapCache } from "../pages/sitemap";
import { customerAccessRequests, decideAccess, refuseWhileAccessOpen, tellOwnersRemoved, tellPersonDeclined } from "../services/access-requests";
import { jobUrls } from "../services/job-urls";
import { afterPlanChange } from "../services/plan-change";
import { TRIAL_ENDED_ALERT, extendTrial } from "../services/trial";

/**
 * The admin dashboard's API: Companies (the requests to accept or decline, the list, one company with its plan and its
 * jobs) and System. Platform administrators only, with a second factor; every call, reads included, is recorded in the
 * audit history with the reason the administrator gives (`x-admin-reason`). Nothing here about a company's jobs carries a
 * candidate's name, email, file, answers or score: counts only. Privacy requests are routes/privacy-requests.ts.
 */
export const adminRoutes = new Hono<Vars>();

adminRoutes.use("*", requirePlatformAdmin, async (c, next) => {
  const s = c.get("session")!;
  const reason = c.req.header("x-admin-reason") ?? "admin dashboard";
  await audit(c.get("container").db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "admin.bypass", reason: `${c.req.method} ${c.req.path}: ${reason}` });
  await next();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function adminActor(c: Context<Vars>) {
  const s = c.get("session")!;
  return { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
}

/** The company a path names; an id that is not even a uuid names nothing. */
function companyIdOf(c: Context<Vars>): string {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "not_found", "Company not found.");
  return id;
}

/** A time as the database hands it back, as the ISO string the dashboard's own shapes carry. */
const iso = (at: string | Date) => new Date(at).toISOString();

/* ------------------------------------------------------------------------------------------------------------ */
/* Companies.                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Every company, newest first, as one row each: where it stands with the one gate and what may be decided about it now,
 * its plan with the usage lines its own people read, the same AI help in dollars, its jobs and applicants as counts, and
 * its open request about its plan. The counts come from a fixed handful of grouped queries; the usage lines are counted
 * per company by the function the company's own Settings uses, so the two never disagree.
 */
adminRoutes.get("/customers", async (c) => {
  const container = c.get("container");
  const now = container.engine.clock();
  const list = await withPlatform(container.db, async (tx): Promise<AdminCompany[]> => {
    const rows = await tx.select().from(companies).orderBy(desc(companies.createdAt));
    const byCompany = <T extends { companyId: string | null }>(of: T[]) => new Map(of.map((r) => [r.companyId, r]));
    const jobCounts = byCompany(await tx.select({ companyId: roles.companyId, total: sql<number>`count(*)`, open: sql<number>`count(*) filter (where ${roles.status} = 'open')` }).from(roles).groupBy(roles.companyId));
    const applicantCounts = byCompany(await tx.select({ companyId: applications.companyId, total: sql<number>`count(*)`, locked: sql<number>`count(${applications.lockedAt})` }).from(applications).groupBy(applications.companyId));
    const costs = byCompany(await tx.select({ companyId: aiRuns.companyId, usd: sql<string>`coalesce(sum(${aiRuns.costUsd}), 0)` }).from(aiRuns).groupBy(aiRuns.companyId));
    const lastActivity = byCompany(await tx.select({ companyId: events.companyId, at: sql<string>`max(${events.occurredAt})` }).from(events).groupBy(events.companyId));
    const aiCredit = await aiCreditLines(tx, { now });
    const planNames = new Map((await tx.select({ key: plans.key, name: plans.name }).from(plans)).map((p) => [p.key, p.name]));
    // A company's open request about its plan: one alert while it stands (services/plan-request.ts).
    const planRequests = new Map<string, AdminPlanRequest>();
    for (const a of await tx.select({ companyId: adminAlerts.companyId, createdAt: adminAlerts.createdAt, details: adminAlerts.details }).from(adminAlerts).where(and(eq(adminAlerts.kind, PLAN_REQUEST_ALERT_KIND), inArray(adminAlerts.status, [...STANDING_STATUSES]))).orderBy(desc(adminAlerts.createdAt))) {
      if (a.companyId) planRequests.set(a.companyId, planRequestOf(a));
    }
    // For an active company, an owner to write to: its first.
    const owners = new Map<string, { name: string | null; email: string }>();
    for (const o of await tx.select({ companyId: memberships.companyId, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.role, "owner"), eq(memberships.status, "active"))).orderBy(asc(memberships.createdAt))) {
      if (!owners.has(o.companyId)) owners.set(o.companyId, { name: o.name, email: o.email });
    }
    const accessRequests = await customerAccessRequests(tx);
    const out: AdminCompany[] = [];
    for (const co of rows) {
      const accessRequest = accessRequests.get(co.id) ?? null;
      const status = adminCompanyStatus(accessRequest);
      const credit = aiCredit.get(co.id);
      const lastAt = lastActivity.get(co.id)?.at;
      out.push({
        id: co.id,
        name: co.name,
        slug: co.slug,
        vertical: co.vertical,
        sizeBand: co.sizeBand,
        timezone: co.timezone,
        locations: co.locations,
        website: co.settings.website ?? null,
        createdAt: iso(co.createdAt),
        status,
        statusLabel: ADMIN_COMPANY_STATUS_LABEL[status],
        accessRequest,
        owner: status === "active" ? owners.get(co.id) ?? null : null,
        accessDecisions: accessDecisionsFor(status),
        planKey: co.planKey,
        planName: planNames.get(co.planKey) ?? co.planKey,
        jobs: { open: Number(jobCounts.get(co.id)?.open ?? 0), total: Number(jobCounts.get(co.id)?.total ?? 0) },
        applicants: Number(applicantCounts.get(co.id)?.total ?? 0),
        lockedApplicants: Number(applicantCounts.get(co.id)?.locked ?? 0),
        lastActivityAt: lastAt ? iso(lastAt) : null,
        usage: await entitlements.usageOf(tx, co.id, { now }),
        seats: { used: await entitlements.seatsInUse(tx, co.id, { now }), limit: await entitlements.seatLimit(tx, co.id) },
        aiCredit: credit ? { ...credit, resetsAt: credit.resetsAt ? iso(credit.resetsAt) : null } : null,
        aiCostUsd: Number(costs.get(co.id)?.usd ?? 0),
        trial: trialStanding(co, now),
        trialTerm: trialTermOf(co.settings),
        planRequest: planRequests.get(co.id) ?? null,
        careersUrl: isCompanyLive(co.settings) ? jobUrls(container.env, { slug: co.slug, roleId: "-" }).careers : null,
      });
    }
    return out;
  });
  return c.json(list);
});

/** A plan request as the dashboard reads it, from the alert that carries it. */
function planRequestOf(alert: { createdAt: string; details: Record<string, unknown> }): AdminPlanRequest {
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const planKey = text(alert.details.planKey);
  const planName = text(alert.details.planName);
  return {
    since: iso(alert.createdAt),
    planKey: isPublicPlanKey(planKey) ? planKey : null,
    planName,
    words: planRequestWords(planName, { reason: text(alert.details.reason), note: text(alert.details.note) }),
    requestedBy: text((alert.details.requestedBy as { name?: unknown } | undefined)?.name),
  };
}

/**
 * The one gate: an administrator accepts or declines a company's request, with a second press and no reason typed, or
 * takes an accepted company's access away (services/access-requests.ts). Accept makes the company live; nothing else
 * confirms it. Decline stops there, and accepting later is the undo. Two presses at once make one change, and the second
 * reads `changed: false` with what happened. The first press wins: an Accept from a row that still showed the request,
 * once it was declined, answers 409 `access_decided` with who decided and when, and only the declined company's own Accept
 * (`from: "declined"`) undoes it. `remove` on a request, a declined company or one with nobody active answers 409
 * `no_access` and changes nothing. After a Decline or a removal one email goes to the person (to the owners; `emailed`
 * says whether it really left).
 */
adminRoutes.post("/customers/:id/access", async (c) => {
  const container = c.get("container");
  const companyId = companyIdOf(c);
  const body = CustomerAccessChange.parse(await c.req.json().catch(() => ({})));
  const result = await withPlatform(container.db, (tx) => decideAccess(tx, { companyId, decision: body.decision, from: body.from, actor: adminActor(c), now: container.engine.clock() }));
  // What is public changed: the sitemap is rebuilt at once.
  resetSitemapCache(container);
  if (result.declined) await tellPersonDeclined(container, result.declined);
  const emailed = result.removed ? await tellOwnersRemoved(container, result.removed) : undefined;
  await container.kick();
  const answer: CustomerAccessAnswer = emailed === undefined ? result.answer : { ...result.answer, emailed };
  return c.json(answer);
});

/**
 * Every job of one company, newest first, as counts: everyone who applied, and the people in the Shortlisted,
 * Interviewed and Hired tabs of the job's Candidates list now (the people its team may read). Never a candidate's name,
 * email, file, answers or score. `jobPageUrl`: the public job page of an open or paused job of a live company.
 */
adminRoutes.get("/customers/:id/jobs", async (c) => {
  const container = c.get("container");
  const companyId = companyIdOf(c);
  const answer = await withPlatform(container.db, async (tx): Promise<AdminCompanyJobs | null> => {
    const [co] = await tx.select({ id: companies.id, name: companies.name, slug: companies.slug, settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co) return null;
    const jobRows = await tx.select({ id: roles.id, title: roles.title, status: roles.status, openedAt: roles.openedAt, version: roles.currentPacketVersion }).from(roles).where(eq(roles.companyId, co.id)).orderBy(desc(roles.createdAt));
    const locked = sql<boolean>`${applications.lockedAt} is not null`;
    const counts = await tx.select({ roleId: applications.roleId, stage: applications.stage, locked, n: sql<number>`count(*)` }).from(applications).where(eq(applications.companyId, co.id)).groupBy(applications.roleId, applications.stage, locked);
    const live = isCompanyLive(co.settings);
    const jobList = jobRows.map((r): AdminJobRow => {
      const mine = counts.filter((x) => x.roleId === r.id);
      const inTab = (tab: "shortlisted" | "interviewed" | "hired") => mine.filter((x) => !x.locked && ApplicationStage.safeParse(x.stage).success && tabOf(x.stage as ApplicationStage) === tab).reduce((n, x) => n + Number(x.n), 0);
      const status = r.status as RoleStatus;
      const hasPage = live && !!r.version && (status === "open" || status === "paused");
      return { id: r.id, title: r.title, status, statusLabel: ROLE_STATUS_LABEL[status] ?? r.status, publishedAt: r.openedAt ? iso(r.openedAt) : null, applicants: mine.reduce((n, x) => n + Number(x.n), 0), shortlisted: inTab("shortlisted"), interviewed: inTab("interviewed"), hired: inTab("hired"), jobPageUrl: hasPage ? jobUrls(container.env, { slug: co.slug, roleId: r.id }).job : null };
    });
    return { company: { id: co.id, name: co.name }, jobs: jobList };
  });
  if (!answer) throw new HttpError(404, "not_found", "Company not found.");
  return c.json(answer);
});

/**
 * The plans a company can be put on: key, name, price and what each includes, in dollars for the administrator. The
 * public plans in their own order first, then the private pilot.
 */
adminRoutes.get("/plans", async (c) => {
  const rows = await withPlatform(c.get("container").db, (tx) => tx.select({ key: plans.key, name: plans.name, prices: plans.prices, limits: plans.limits, active: plans.active }).from(plans).orderBy(plans.createdAt));
  const place = (key: string) => { const at = (PUBLIC_PLAN_KEYS as readonly string[]).indexOf(key); return at < 0 ? PUBLIC_PLAN_KEYS.length : at; };
  const options: AdminPlanOption[] = rows.filter((p) => p.active).sort((a, b) => place(a.key) - place(b.key)).map((p) => ({ key: p.key, name: p.name, prices: p.prices, limits: p.limits }));
  return c.json(options);
});

/**
 * An administrator puts a company on another plan, with a reason. The new limits apply at once; what was used this month
 * stays used and the reset date does not move, except that a monthly AI credit that had no limit starts its first month
 * now (`aiCreditMonthStarted`). People a smaller plan left locked open, oldest first (`unlocked`). The company's open
 * request about its plan is done, and its owners and admins are told. A request or a declined company answers 409
 * `access_request_open`: a plan is chosen once the company is in.
 *
 * The Trial plan: moving a company to Trial starts a new 30 days. Moving it to another plan ends the trial with nothing
 * to write (only the Trial plan reads the dates, which stay as a record): the "trial ended" alert is resolved, and a
 * company that was paused takes applications again (`trialEnded`). The private pilot keeps its term of 90 days,
 * extendable.
 */
adminRoutes.post("/customers/:id/plan", async (c) => {
  const body = PlanChange.parse(await c.req.json());
  const companyId = companyIdOf(c);
  const reason = body.reason?.trim() ?? "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Say why the plan is changing (at least five characters).");
  const container = c.get("container");
  const now = container.engine.clock();
  const actor = adminActor(c);
  const result = await withPlatform(container.db, async (tx) => {
    // Locked: the settings are written back whole, so a change the company makes meanwhile is kept. Not "for update": every
    // insert that names this company takes a key share of its row, and `unlockApplicants` below waits for each job's
    // applicants' lock, whose holder is about to make such an insert. "For update" would leave the two waiting for each other.
    const [co] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1).for("no key update");
    if (!co) throw new HttpError(404, "not_found", "Company not found.");
    await refuseWhileAccessOpen(tx, companyId);
    const [plan] = await tx.select({ key: plans.key, name: plans.name, active: plans.active, limits: plans.limits }).from(plans).where(eq(plans.key, body.planKey)).limit(1);
    if (!plan) throw new HttpError(400, "unknown_plan", `There is no plan called ${body.planKey}.`);
    // a retired plan (left out of GET /admin/plans) is not given here either
    if (plan.active === false) throw new HttpError(400, "inactive_plan", `The ${body.planKey} plan is retired and can no longer be given to a company.`);
    const [fromPlan] = await tx.select({ name: plans.name }).from(plans).where(eq(plans.key, co.planKey)).limit(1);
    // People a smaller plan left locked open now, oldest first, up to the new limit. A move down opens nobody and locks nobody.
    // Before the plan's rows are written, because opening many takes a while and every AI call of this company waits on those
    // rows: until they are written its calls go on under the old plan, and they wait only for the short rest of this transaction.
    const limit = entitlements.CANDIDATES_PER_JOB in plan.limits ? plan.limits[entitlements.CANDIDATES_PER_JOB] : await entitlements.limitOf(tx, companyId, entitlements.CANDIDATES_PER_JOB);
    const opened = await unlockApplicants(tx, container.engine, { companyId, planKey: body.planKey, limit, actor, reason, now, integrations: container.integrations, statusBaseUrl: container.env.JOBS_BASE_URL });
    const { aiCreditMonthStarted } = await entitlements.applyPlan(tx, companyId, body.planKey, "plan");
    await entitlements.settleAllowanceAlerts(tx, { companyId });
    const pilot = body.planKey === "design_partner"
      ? { startedAt: co.settings.pilot?.startedAt ?? now.toISOString(), endsAt: co.settings.pilot?.endsAt ?? new Date(now.getTime() + (body.pilotDays ?? 90) * 86_400_000).toISOString(), ...(body.extendUntil ? { extendedUntil: body.extendUntil } : {}) }
      : co.settings.pilot;
    const toTrial = onTrialPlan(body.planKey) && !onTrialPlan(co.planKey);
    const leavingTrial = onTrialPlan(co.planKey) && !onTrialPlan(body.planKey);
    const wasPaused = leavingTrial && trialStanding(co, now)?.ended === true;
    const term = toTrial ? newTrialTerm(now, "plan_change") : null;
    // What the owner was told about the AI credit goes: a new plan's lines are told again.
    const { trial: oldTerm, aiCreditTold: _told, ...others } = co.settings;
    await tx.update(companies).set({ settings: { ...others, pilot, ...(term ? { trial: term } : oldTerm ? { trial: oldTerm } : {}) } }).where(eq(companies.id, companyId));
    await settleAiCreditAlerts(tx, { companyId, now });
    // AI work waiting for credit looks again now: each run woken passes the same check at the credit's own gate.
    await container.engine.signal(tx, { companyId, key: AI_CREDIT_AVAILABLE });
    if (leavingTrial) await resolveAlertsFor(tx, TRIAL_ENDED_ALERT, companyId, now);
    await emit(tx, { type: "plan.changed", companyId, actor, subject: { type: "company", id: companyId }, payload: { from: co.planKey, to: body.planKey, pilot, ...(leavingTrial ? { trialEnded: true } : {}) } });
    await audit(tx, { companyId, actor, action: "plan.changed", target: { type: "company", id: companyId }, reason, details: { pilot, from: co.planKey, to: body.planKey, fromName: fromPlan?.name ?? null, toName: plan.name, unlocked: opened.unlocked, ...(term ? { trial: { startedAt: term.startedAt, endsAt: term.endsAt } } : {}), ...(leavingTrial ? { trialEnded: true } : {}) } });
    if (term) await emit(tx, { type: "trial.started", companyId, actor, subject: { type: "company", id: companyId }, payload: { startedAt: term.startedAt, endsAt: term.endsAt, startedBy: term.startedBy } });
    await afterPlanChange(tx, { companyId, planName: plan.name, opened: opened.unlocked, now });
    return { wasPaused, answer: { trialEnded: leavingTrial, unlocked: opened.unlocked, aiCreditMonthStarted } satisfies PlanChangeAnswer };
  });
  // Paused no more: the jobs go back on the sitemap.
  if (result.wasPaused) resetSitemapCache(container);
  await container.kick();
  return c.json(result.answer);
});

/**
 * An administrator extends a company's trial: a number of days (1 to 90) and a reason, confirmed. The new end counts
 * from the later of the old end and now; the extension is kept on the dates and audited with the reason, the "trial
 * ended" alert is resolved and the owners are told. 409 `not_on_trial` on another plan; 409 `trial_not_started` when the
 * trial has no dates yet. A company that was paused takes applications again.
 */
adminRoutes.post("/customers/:id/trial", async (c) => {
  const container = c.get("container");
  const companyId = companyIdOf(c);
  const body = TrialExtensionRequest.parse(await c.req.json().catch(() => ({})));
  const now = container.engine.clock();
  const result = await withPlatform(container.db, async (tx) => {
    await refuseWhileAccessOpen(tx, companyId);
    return extendTrial(tx, { companyId, days: body.days, reason: body.reason, actor: adminActor(c), now });
  });
  if (result.wasPaused) resetSitemapCache(container);
  await container.kick();
  const answer: TrialExtensionAnswer = { ok: true, companyId, trial: result.standing };
  return c.json(answer);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* System: health.                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The work that failed, and the alerts that are open or acknowledged. Of a workflow run, a background job and an AI
 * call: what it was, where it stopped and its error; never its state, its payload or its output. Alerts about an
 * allowance or the AI credit that no longer stand are resolved first.
 */
adminRoutes.get("/failures", async (c) => {
  const answer = await withPlatform(c.get("container").db, async (tx): Promise<AdminFailures> => {
    const failedRuns = await tx.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, workflowKey: workflowRuns.workflowKey, status: workflowRuns.status, currentStep: workflowRuns.currentStep, attempts: workflowRuns.attempts, lastError: workflowRuns.lastError, updatedAt: workflowRuns.updatedAt, subject: workflowRuns.subject }).from(workflowRuns).where(eq(workflowRuns.status, "failed")).orderBy(desc(workflowRuns.updatedAt)).limit(100);
    const failedJobs = await tx.select({ id: jobs.id, kind: jobs.kind, attempts: jobs.attempts, lastError: jobs.lastError, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.status, "failed")).orderBy(desc(jobs.createdAt)).limit(100);
    // A call still `running` holds its place in the AI credit and has not failed: it is not on this list.
    const failedAi = await tx.select({ id: aiRuns.id, task: aiRuns.task, model: aiRuns.model, status: aiRuns.status, error: aiRuns.error, createdAt: aiRuns.createdAt }).from(aiRuns).where(sql`${aiRuns.status} not in ('ok', 'running')`).orderBy(desc(aiRuns.createdAt)).limit(100);
    await entitlements.settleAllowanceAlerts(tx);
    await settleAiCreditAlerts(tx);
    const alerts = (await openAlerts(tx)).map((a): AdminAlert => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title, body: a.body, status: a.status, companyId: a.companyId, target: a.target, details: a.details, createdAt: a.createdAt }));
    return { failedRuns, failedJobs, failedAi, alerts };
  });
  return c.json(answer);
});

adminRoutes.get("/queue", async (c) => {
  const container = c.get("container");
  const answer = await withPlatform(container.db, async (tx): Promise<AdminQueue> => {
    const [q] = await tx.select({ queued: sql<number>`count(*) filter (where status = 'queued')`, failed: sql<number>`count(*) filter (where status = 'failed')`, oldest: sql<string | null>`min(run_at) filter (where status = 'queued')` }).from(jobs);
    const [waiting] = await tx.select({ n: sql<number>`count(*)` }).from(workflowRuns).where(eq(workflowRuns.status, "waiting"));
    return { queued: Number(q.queued), failed: Number(q.failed), oldestQueuedAt: q.oldest, waitingRuns: Number(waiting.n), definitions: container.engine.definitions() };
  });
  return c.json(answer);
});

/** Runs a failed workflow run again from where it stopped. The alert that it stopped is done with; if it stops again, a new one is raised. */
adminRoutes.post("/runs/:id/retry", async (c) => {
  const container = c.get("container");
  const runId = c.req.param("id") ?? "";
  const found = UUID.test(runId) && (await withPlatform(container.db, async (tx) => {
    const [run] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run) return false;
    await tx.update(workflowRuns).set({ status: "running", attempts: 0, wait: null, lastError: null }).where(eq(workflowRuns.id, run.id));
    await resolveAlertsFor(tx, "workflow.failed", run.id);
    await tx.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "manual" } } });
    return true;
  }));
  if (!found) throw new HttpError(404, "not_found", "Run not found.");
  await container.kick();
  return c.json({ ok: true });
});

/** Two-person visibility: the administrator who changed a platform role cannot be the one who closes the alert about it. */
async function refuseOwnPlatformRoleAlert(c: Context<Vars>, alertId: string, verb: "acknowledge" | "resolve"): Promise<void> {
  if (!UUID.test(alertId)) throw new HttpError(404, "not_found", "Alert not found.");
  const userId = c.get("session")!.user.id;
  const [alert] = await withPlatform(c.get("container").db, (tx) => tx.select({ kind: adminAlerts.kind, details: adminAlerts.details, target: adminAlerts.target }).from(adminAlerts).where(eq(adminAlerts.id, alertId)).limit(1));
  if (alert?.kind.startsWith("platform_role.") && (alert.details?.actorId === userId || alert.target?.id === userId)) throw new HttpError(403, "second_person_required", `Another administrator must ${verb} a change to platform roles that you made or that concerns you.`);
}

adminRoutes.post("/alerts/:id/acknowledge", async (c) => {
  const id = c.req.param("id") ?? "";
  await refuseOwnPlatformRoleAlert(c, id, "acknowledge");
  const ok = await withPlatform(c.get("container").db, (tx) => acknowledgeAlert(tx, { id, actor: adminActor(c) }));
  if (!ok) throw new HttpError(404, "not_found", "Alert not found or already acknowledged.");
  return c.json({ ok: true });
});

/**
 * Resolve: the problem is dealt with. The alert leaves the dashboard's list and stays on record, audited with the
 * administrator's note; the next time the problem shows up a new alert is raised.
 */
adminRoutes.post("/alerts/:id/resolve", async (c) => {
  const id = c.req.param("id") ?? "";
  await refuseOwnPlatformRoleAlert(c, id, "resolve");
  const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;
  const result = await withPlatform(c.get("container").db, (tx) => resolveAlert(tx, { id, actor: adminActor(c), note }));
  if (result === "not_found") throw new HttpError(404, "not_found", "Alert not found.");
  if (result === "already_resolved") throw new HttpError(409, "already_resolved", "This alert was already resolved.");
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------------------------------------------------ */
/* System: costs, email, security reports.                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * AI spend at list prices by company, task and model. `?since=YYYY-MM-DD` counts only the runs from that day on, the
 * day starting at midnight in the ITS business time zone; without it, every run.
 */
adminRoutes.get("/costs", async (c) => {
  const since = c.req.query("since");
  let from: string | null = null;
  if (since !== undefined) {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
    const [y, m, d] = day ? [Number(day[1]), Number(day[2]), Number(day[3])] : [0, 0, 0];
    const real = new Date(Date.UTC(y, m - 1, d));
    if (!day || real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) throw new HttpError(400, "invalid_date", "since must be a date written like 2026-10-01.");
    from = zonedToUtc(y, m, d, 0, 0, BUSINESS_TIMEZONE).toISOString();
  }
  const rows = await withPlatform(c.get("container").db, (tx) =>
    tx
      .select({ companyId: aiRuns.companyId, task: aiRuns.task, model: aiRuns.model, runs: sql<number>`count(*)`, inputTokens: sql<number>`sum(input_tokens)`, outputTokens: sql<number>`sum(output_tokens)`, costUsd: sql<string>`sum(cost_usd)` })
      .from(aiRuns)
      .where(from ? gte(aiRuns.createdAt, from) : undefined)
      .groupBy(aiRuns.companyId, aiRuns.task, aiRuns.model),
  );
  const costs: AdminCostRow[] = rows.map((r) => ({ ...r, runs: Number(r.runs), inputTokens: Number(r.inputTokens), outputTokens: Number(r.outputTokens), costUsd: Number(r.costUsd) }));
  return c.json(costs);
});

/** The email do-not-send list: what is stopped and why. `?all=1` lists released addresses too. */
adminRoutes.get("/email-suppressions", async (c) => {
  const rows = await withPlatform(c.get("container").db, (tx) => listSuppressions(tx, c.req.query("all") !== "1"));
  const list: EmailSuppression[] = rows.map((s) => ({ id: s.id, address: s.address, reason: s.reason, source: s.source, active: s.active, count: s.count, firstAt: s.firstAt, lastAt: s.lastAt, details: s.details, releasedAt: s.releasedAt, releaseReason: s.releaseReason }));
  return c.json(list);
});

/**
 * An administrator stops emails to an address by hand: someone asked by phone not to be emailed, or an address bounces
 * somewhere the provider does not report. Why is required and kept on the row; the addition is audited.
 */
adminRoutes.post("/email-suppressions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { address?: string; reason?: string };
  const address = String(body.address ?? "").trim();
  const note = String(body.reason ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, "invalid_request", "Enter one email address, like name@example.com.");
  if (note.length < 5) throw new HttpError(400, "reason_required", "Say why this address must not be emailed (at least five characters).");
  const row = await withPlatform(c.get("container").db, (tx) => suppressAddress(tx, { address, reason: "manual", source: "admin", details: { note }, actor: adminActor(c) }));
  return c.json({ id: row.id, address: row.address, reason: row.reason, active: row.active }, 201);
});

/** Lets an address be emailed again, once a person has confirmed it is deliverable. Never for a spam complaint. */
adminRoutes.post("/email-suppressions/:id/release", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  if (!body.reason || body.reason.length < 5) throw new HttpError(400, "reason_required", "Say how you confirmed the address is deliverable again.");
  const reason = body.reason;
  const id = c.req.param("id") ?? "";
  const row = UUID.test(id) ? await withPlatform(c.get("container").db, (tx) => releaseSuppression(tx, { id, reason, actor: adminActor(c) })) : null;
  if (!row) throw new HttpError(404, "not_found", "No active suppression with that id.");
  return c.json({ ok: true, address: row.address });
});

/** Content-security-policy violation reports: reviewed before any enforcement. */
adminRoutes.get("/csp-reports", async (c) => {
  const container = c.get("container");
  const answer: CspReports = { mode: container.env.CSP_MODE, reports: await withPlatform(container.db, (tx) => listCspReports(tx)) };
  return c.json(answer);
});

adminRoutes.post("/csp-reports/:id/review", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { disposition?: string };
  const disposition = body.disposition?.trim() ?? "";
  if (disposition.length < 3) throw new HttpError(400, "disposition_required", "Say what this report means (expected, fix needed, policy change).");
  const id = c.req.param("id") ?? "";
  const actor = adminActor(c);
  const ok = UUID.test(id) && (await withPlatform(c.get("container").db, async (tx) => {
    if (!(await reviewCspReport(tx, { id, reviewedBy: actor.id, disposition }))) return false;
    await audit(tx, { companyId: null, actor, action: "admin.bypass", reason: `csp report reviewed: ${disposition}`, details: { reportId: id } });
    return true;
  }));
  if (!ok) throw new HttpError(404, "not_found", "Report not found.");
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------------------------------------------------ */
/* System: administrators.                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Platform administrators: a ledger of named people, granted and revoked by administrators with a second factor and a
 * reason; never by configuration. The bootstrap list is reported so a forgotten variable is visible.
 */
adminRoutes.get("/platform-roles", async (c) => {
  const container = c.get("container");
  const answer = await withPlatform(container.db, async (tx): Promise<PlatformRoleGrants> => {
    const activeAdmins = await countActiveAdmins(tx);
    return { grants: await listPlatformRoleGrants(tx), activeAdmins, bootstrap: { configured: container.env.BOOTSTRAP_ADMIN_EMAILS.length, ignored: container.env.BOOTSTRAP_ADMIN_EMAILS.length > 0 && activeAdmins > 0 } };
  });
  return c.json(answer);
});

adminRoutes.post("/platform-roles", async (c) => {
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string; reason?: string; confirm?: boolean };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm the grant.");
  if (body.role !== "platform_admin") throw new HttpError(400, "bad_role", "Role must be platform_admin.");
  const role = body.role;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Give the reason for the grant; every administrator will see it.");
  const email = (body.email ?? "").trim().toLowerCase();
  if (!container.env.ITS_STAFF_EMAIL_DOMAINS.includes(email.split("@")[1] ?? "")) throw new HttpError(400, "not_staff_domain", "Platform roles are only for ITS staff accounts on a staff email domain.");
  const actor = adminActor(c);
  try {
    const grant = await withPlatform(container.db, async (tx) => {
      const [grantee] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (!grantee) throw new PlatformRoleError("unknown_user", "That person has not signed in yet. They must sign in with Microsoft 365 and a second factor first.");
      return grantPlatformRole(tx, { userId: grantee.id, role, actor, reason, source: "console", requireStaffProvider: "azure" });
    });
    const delivery = await notifyOtherAdmins(container, actor.id, `Platform role granted: ${email} is now ${role.replace("_", " ")}`, `${actor.name} granted ${role.replace("_", " ")} to ${email}.\nReason: ${reason}\n\nIf you did not expect this, revoke it in the admin dashboard and tell the founder.`, `role_granted:${grant.id}`);
    const answer: PlatformRoleChanged = { ok: true, grantId: grant.id, ...delivery };
    return c.json(answer, 201);
  } catch (e) {
    if (e instanceof PlatformRoleError) throw new HttpError(e.code === "unknown_user" ? 404 : e.code === "self_grant" ? 403 : 409, e.code, e.message);
    throw e;
  }
});

adminRoutes.post("/platform-roles/:grantId/revoke", async (c) => {
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; confirm?: boolean };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm the revocation.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Give the reason for the revocation; every administrator will see it.");
  const grantId = c.req.param("grantId") ?? "";
  if (!UUID.test(grantId)) throw new HttpError(404, "not_found", "No active grant with that id.");
  const actor = adminActor(c);
  try {
    const { grant, who } = await withPlatform(container.db, async (tx) => {
      const revoked = await revokePlatformRole(tx, { grantId, actor, reason });
      const [person] = await tx.select({ email: users.email }).from(users).where(eq(users.id, revoked.userId)).limit(1);
      return { grant: revoked, who: person?.email ?? revoked.userId };
    });
    const delivery = await notifyOtherAdmins(container, actor.id, `Platform role revoked: ${who} is no longer ${grant.role.replace("_", " ")}`, `${actor.name} revoked ${grant.role.replace("_", " ")} from ${who}.\nReason: ${reason}`, `role_revoked:${grant.id}`);
    const answer: PlatformRoleChanged = { ok: true, grantId: grant.id, ...delivery };
    return c.json(answer);
  } catch (e) {
    if (e instanceof PlatformRoleError) throw new HttpError(e.code === "not_found" ? 404 : 409, e.code, e.message);
    throw e;
  }
});

/**
 * Every other administrator, and the ITS mailbox, hear about a platform-role change (two-person visibility). A message
 * that cannot be delivered is never silent: it is audited and raised as an alert, and the caller learns how many
 * recipients were not reached.
 */
async function notifyOtherAdmins(container: Container, actorUserId: string, subject: string, text: string, key: string): Promise<{ notified: number; failed: number }> {
  const others = await withPlatform(container.db, (tx) => tx.select({ email: users.email }).from(users).where(and(eq(users.platformRole, "platform_admin"), sql`${users.id} <> ${actorUserId}`)));
  const recipients = new Set<string>([...others.map((o) => o.email), container.env.ITS_QUEUE_EMAIL]);
  const from = mailbox(container.env.PRODUCT_NAME, container.integrations.env.fromAddress);
  let notified = 0;
  let failed = 0;
  for (const to of recipients) {
    const sent = await container.integrations.email.send({ to, from, subject, text, idempotencyKey: `${key}:${to}`, tags: { template: "platform_role_changed" } });
    if (sent.status !== "failed") { notified += 1; continue; }
    failed += 1;
    const details = { key, recipientHash: createHash("sha256").update(to).digest("hex").slice(0, 16) };
    await withPlatform(container.db, async (tx) => {
      await audit(tx, { companyId: null, actor: { kind: "system", id: "email" }, action: "platform_role.changed", reason: `notification failed: ${sent.error}`, details });
      await raiseAlert(tx, { kind: "platform_role.notify_failed", severity: "high", title: "An administrator was not told about a platform-role change", body: `${subject}. The email to one administrator failed (${sent.error}); tell them another way and check the suppression list.`, details });
    });
  }
  return { notified, failed };
}

/**
 * Signs a person out everywhere, by the address they sign in with: after a lost device and a reset at the identity
 * service, an application session on that device must not outlive the reset. With a confirmation and a reason; audited
 * with both.
 */
adminRoutes.post("/sessions/revoke", async (c) => {
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; reason?: string; confirm?: boolean };
  const email = String(body.email ?? "").trim().toLowerCase();
  const reason = String(body.reason ?? "").trim();
  if (!email.includes("@")) throw new HttpError(400, "invalid_request", "Enter the email address the person signs in with.");
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm that every session of this person should end.");
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Give a reason of at least five characters.");
  const ended = await withPlatform(container.db, async (tx) => {
    const [who] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
    if (!who) return null;
    const sessionsEnded = await revokeAllSessions(tx, who.id, { now: container.engine.clock() });
    await audit(tx, { companyId: null, actor: adminActor(c), action: "session.revoked", target: { type: "user", id: who.id }, reason, details: { email: who.email, sessionsEnded, by: "administrator" } });
    return sessionsEnded;
  });
  if (ended === null) throw new HttpError(404, "not_found", "Nobody signs in with that address.");
  const answer: SessionsRevoked = { ok: true, sessionsEnded: ended };
  return c.json(answer);
});
