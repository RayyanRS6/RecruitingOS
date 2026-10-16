import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companyVerifiedAt, newTrialTerm, onTrialPlan, trialTermOf, type Actor } from "@ros/contracts";
import { BOARD_UP_STATES, audit, closingDateRequired, defaultClosingDate, emit, isBoardChannel, notify, raiseAlert, transitionPosting, type PostingState } from "@ros/core";
import { releaseHeldCommunications } from "@ros/agents";
import { companies, postings, rolePackets, roles, type Queryable } from "@ros/db";
import { armClosingDate, companyVerifiedSignal } from "@ros/workflows";
import type { Container } from "../container";
import { trialDateWords, trialPatch } from "./trial";

/**
 * The one-time ITS check of a company that signed itself up (founder decision B7, plan B1) and the getting-started
 * facts kept beside it (plan B2). Every write is a single jsonb statement on companies.settings, so a customer's own
 * settings change and an ITS confirmation made at the same moment never overwrite each other.
 */

/** Who confirmed a company where no ITS check is needed (COMPANY_CHECK=auto: tests, and local journeys that need public pages). */
export const AUTO_CHECK_ACTOR: Actor = { kind: "system", id: "company_check_auto", name: "No ITS check in this environment" };

/** The confirmation a new company starts with when the environment needs no ITS check. */
export function autoVerification(now: Date): { verifiedAt: string; verifiedBy: Actor } {
  return { verifiedAt: now.toISOString(), verifiedBy: AUTO_CHECK_ACTOR };
}

export type VerificationResult = { companyId: string; name: string; changed: boolean; verifiedAt: string | null; released: number };

/**
 * ITS confirms the company: from now on its careers page, job pages, Google listing and feeds are public, approved roles
 * waiting to be published are woken, and every message to a candidate that waited for the check goes into the queue.
 * The owners and admins are told; the confirmation is audited (the customer sees it in their history) and emitted.
 * Confirming a confirmed company changes nothing, except that any message to a candidate still held goes into the queue
 * (confirming again is the way to repair one that slipped past the first release). Null when there is no such company.
 */
export async function verifyCompany(tx: Queryable, container: Container, input: { companyId: string; actor: Actor; reason: string; now: Date }): Promise<VerificationResult | null> {
  const [co] = await tx.select({ id: companies.id, name: companies.name, settings: companies.settings, planKey: companies.planKey, timezone: companies.timezone }).from(companies).where(eq(companies.id, input.companyId)).limit(1).for("update");
  if (!co) return null;
  const already = companyVerifiedAt(co.settings);
  if (already) return { companyId: co.id, name: co.name, changed: false, verifiedAt: already, released: await releaseHeldCommunications(tx, { companyId: co.id, actor: input.actor, now: input.now }) };
  const at = input.now.toISOString();
  // The Trial plan's 30 days start at this check, the first day the company can go live (founder decision L-02 B), in
  // the same statement as the confirmation. Dates already there are kept, so confirming again (or after a confirmation
  // was taken back) never restarts a trial.
  const startsTrial = onTrialPlan(co.planKey) && !trialTermOf(co.settings);
  const term = startsTrial ? newTrialTerm(input.now, "its_check") : null;
  const trial = term ? sql` || ${trialPatch(term, { keep: true })}` : sql``;
  await tx.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('verifiedAt', ${at}::text, 'verifiedBy', ${JSON.stringify(input.actor)}::jsonb)${trial}` }).where(eq(companies.id, co.id));
  if (term) {
    await audit(tx, { companyId: co.id, actor: input.actor, action: "trial.started", target: { type: "company", id: co.id }, reason: "the 30-day trial starts when ITS confirms the company", details: { startedAt: term.startedAt, endsAt: term.endsAt, startedBy: term.startedBy } });
    await emit(tx, { type: "trial.started", companyId: co.id, actor: input.actor, subject: { type: "company", id: co.id }, payload: { startedAt: term.startedAt, endsAt: term.endsAt, startedBy: term.startedBy } });
  }
  const released = await releaseHeldCommunications(tx, { companyId: co.id, actor: input.actor, now: input.now });
  await emit(tx, { type: "company.verified", companyId: co.id, actor: input.actor, subject: { type: "company", id: co.id }, payload: { released } });
  await audit(tx, { companyId: co.id, actor: input.actor, action: "company.verified", target: { type: "company", id: co.id }, reason: input.reason, details: { released } });
  // Publish runs of roles approved while the company waited resume now (packages/workflows publish-role.ts).
  await container.engine.signal(tx, { companyId: co.id, key: companyVerifiedSignal(co.id) });
  await giveDefaultClosingDates(tx, container, { companyId: co.id, actor: input.actor, now: input.now });
  await notify(tx, {
    companyId: co.id,
    kind: "company.verified",
    title: "ITS confirmed your company",
    body: `Your careers page and job pages are public now, and any approved role is being published.${released ? ` ${released} ${released === 1 ? "message" : "messages"} to candidates that ${released === 1 ? "was" : "were"} waiting for this ${released === 1 ? "is" : "are"} on ${released === 1 ? "its" : "their"} way.` : ""}${term ? ` Your 30-day trial starts today and ends on ${trialDateWords(term.endsAt, co.timezone)}.` : ""}`,
    action: { label: "Open Home", href: "/" },
    roles: ["owner", "admin", "hiring_manager"],
  });
  return { companyId: co.id, name: co.name, changed: true, verifiedAt: at, released };
}

/**
 * Colorado's default closing date counts from when the job goes public (row 58): a role that opened while the company
 * waited for this check got no default date (packages/workflows role-approval.ts), so every open or paused role whose
 * place asks for one, and has none, gets thirty days from now, with its timer, recorded like the default given at opening.
 */
async function giveDefaultClosingDates(tx: Queryable, container: Container, input: { companyId: string; actor: Actor; now: Date }): Promise<number> {
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const waiting = await tx.select().from(roles).where(and(eq(roles.companyId, input.companyId), inArray(roles.status, ["open", "paused"]), isNull(roles.applicationsCloseOn)));
  let given = 0;
  for (const role of waiting) {
    if (!role.currentPacketVersion) continue;
    const [pv] = await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
    if (!pv || !closingDateRequired({ jobLocations: pv.packet.identity.locations, remotePolicy: pv.packet.identity.remotePolicy })) continue;
    const closesOn = defaultClosingDate(input.now, company?.timezone);
    await tx.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role.closing_date_set", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { closesOn, previous: null, defaulted: true, reason: "Colorado expects the job ad to say when applications close; the thirty days start when the job goes public." } });
    await armClosingDate(tx, container.engine, { companyId: input.companyId, roleId: role.id, closesOn, actor: input.actor });
    given++;
  }
  return given;
}

/**
 * ITS takes its confirmation back (a mistake, or a doubt about the company): the public pages and feeds go offline at
 * once and messages to candidates wait again, including any already queued (the outbox checks before it sends). Every
 * job-board listing that is up (or paused after being up) is closed and named for taking down, as when a role closes
 * (row 63): its apply link stops working with the careers page, so no candidate should meet the listing. When ITS posts
 * for the company, a "take it down" task opens per listing; otherwise the Share tab lists them for the team. Roles,
 * candidates and decisions are untouched. The owners and admins are told in plain words; audited with the reason.
 */
export async function unverifyCompany(tx: Queryable, input: { companyId: string; actor: Actor; reason: string; now?: Date }): Promise<VerificationResult | null> {
  const [co] = await tx.select({ id: companies.id, name: companies.name, settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1).for("update");
  if (!co) return null;
  if (!companyVerifiedAt(co.settings)) return { companyId: co.id, name: co.name, changed: false, verifiedAt: null, released: 0 };
  await tx.update(companies).set({ settings: sql`${companies.settings} - 'verifiedAt' - 'verifiedBy'` }).where(eq(companies.id, co.id));
  const now = input.now ?? new Date();
  const up = (await tx.select().from(postings).where(eq(postings.companyId, co.id))).filter((p) => isBoardChannel(p.channel) && BOARD_UP_STATES.includes(p.status as PostingState));
  for (const p of up) {
    await transitionPosting(tx, { postingId: p.id, to: "closed", actor: input.actor, now, reason: "company check taken back", patch: { closureRequired: true } });
    await emit(tx, { type: "posting.closure_required", companyId: co.id, actor: input.actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: p.roleId, url: p.externalUrl, reason: "company check taken back" } });
  }
  await emit(tx, { type: "company.unverified", companyId: co.id, actor: input.actor, subject: { type: "company", id: co.id }, payload: { boardsClosed: up.length } });
  await audit(tx, { companyId: co.id, actor: input.actor, action: "company.unverified", target: { type: "company", id: co.id }, reason: input.reason, details: { boardsClosed: up.length } });
  const boards = up.length ? ` ${up.length === 1 ? "The job-board listing that was up is closed and must be taken down" : `The ${up.length} job-board listings that were up are closed and must be taken down`}; the Share tab of each job says which. Post them again once ITS confirms your company.` : "";
  await notify(tx, {
    companyId: co.id,
    kind: "company.unverified",
    title: "Your careers page is offline while ITS checks your company again",
    body: `Your careers page and job pages are offline for now, and messages to candidates wait until ITS confirms your company again.${boards} Your roles, candidates and decisions are unchanged. Your ITS contact will be in touch.`,
    action: { label: "Open Home", href: "/" },
    roles: ["owner", "admin", "hiring_manager"],
  });
  return { companyId: co.id, name: co.name, changed: true, verifiedAt: null, released: 0 };
}

/** Merges keys into companies.settings.onboarding (null removes a key), in one statement. */
async function mergeOnboarding(tx: Queryable, companyId: string, patch: Record<string, unknown>): Promise<void> {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const drop = Object.keys(patch).filter((k) => patch[k] === null);
  let onboarding = sql`(coalesce(${companies.settings}->'onboarding', '{}'::jsonb) || ${JSON.stringify(set)}::jsonb)`;
  for (const k of drop) onboarding = sql`(${onboarding} - ${k}::text)`;
  await tx.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('onboarding', ${onboarding})` }).where(eq(companies.id, companyId));
}

/** One person hides the getting-started card for themselves (the rest of the team keeps theirs). */
export async function dismissGettingStarted(tx: Queryable, input: { companyId: string; userId: string; now: Date }): Promise<void> {
  const by = sql`coalesce(${companies.settings}->'onboarding'->'dismissedBy', '{}'::jsonb) || jsonb_build_object(${input.userId}::text, ${input.now.toISOString()}::text)`;
  await tx.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('onboarding', coalesce(${companies.settings}->'onboarding', '{}'::jsonb) || jsonb_build_object('dismissedBy', ${by}))` }).where(eq(companies.id, input.companyId));
}

/** An owner or admin says the AI rules were reviewed (getting started, step 7 of the onboarding checklist). */
export async function markPoliciesReviewed(tx: Queryable, input: { companyId: string; actor: Actor; now: Date; ip?: string }): Promise<void> {
  await mergeOnboarding(tx, input.companyId, { policiesReviewedAt: input.now.toISOString(), policiesReviewedBy: input.actor });
  await audit(tx, { companyId: input.companyId, actor: input.actor, action: "company.updated", target: { type: "company", id: input.companyId }, reason: "the AI rules were reviewed", ...(input.ip ? { ip: input.ip } : {}), details: { fields: ["aiRulesReviewed"] } });
  await emit(tx, { type: "company.updated", companyId: input.companyId, actor: input.actor, subject: { type: "company", id: input.companyId }, payload: { fields: ["aiRulesReviewed"] } });
}

/** ITS confirms it can sign in to the company's job-board accounts (or no longer can); the getting-started step follows. */
export async function setJobBoardAccess(tx: Queryable, input: { companyId: string; confirmed: boolean; actor: Actor; now: Date; note?: string }): Promise<boolean> {
  const [co] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!co) return false;
  await mergeOnboarding(tx, co.id, input.confirmed ? { jobBoardsConfirmedAt: input.now.toISOString(), jobBoardsConfirmedBy: input.actor } : { jobBoardsConfirmedAt: null, jobBoardsConfirmedBy: null });
  const field = input.confirmed ? "jobBoardAccess" : "jobBoardAccessRemoved";
  await audit(tx, { companyId: co.id, actor: input.actor, action: "company.updated", target: { type: "company", id: co.id }, reason: input.note || (input.confirmed ? "ITS confirmed it can sign in to the job boards" : "ITS can no longer sign in to the job boards"), details: { fields: [field] } });
  await emit(tx, { type: "company.updated", companyId: co.id, actor: input.actor, subject: { type: "company", id: co.id }, payload: { fields: [field] } });
  return true;
}

/**
 * Tells the ITS queue mailbox that a company signed itself up and waits for the check, with the company's own details
 * and the owner's address (no candidate data exists yet). Sent outside any transaction; a failed send is raised as an
 * operator alert so the company never waits unseen.
 */
export async function tellItsAboutNewCompany(container: Container, input: { company: { id: string; name: string; vertical: string; sizeBand: string; website: string | null }; owner: { name: string | null; email: string } }): Promise<void> {
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  const text = [
    "A company signed itself up. Its careers page, job pages, Google listing and first emails to candidates wait for the one-time ITS check; it can draft and approve roles meanwhile.",
    `Company: ${input.company.name}\nKind of business: ${input.company.vertical}\nSize: ${input.company.sizeBand} employees\nWebsite: ${input.company.website || "not given"}\nOwner: ${input.owner.name ? `${input.owner.name} <${input.owner.email}>` : input.owner.email}`,
    `Confirm it, or ask the owner first, in the admin console under Customers: ${container.env.APP_BASE_URL}/admin`,
  ].join("\n\n");
  const sent = await container.integrations.email.send({ to: container.env.ITS_QUEUE_EMAIL, from, subject: `[company check] ${input.company.name} is waiting for the ITS check`, text, idempotencyKey: `company_check:${input.company.id}`, tags: { template: "company_check" } });
  if (sent.status === "failed") {
    await raiseAlert(container.db, { kind: "company.check_notice_failed", severity: "high", title: "A new company is waiting for the ITS check", body: `${input.company.name} signed itself up, but the email to the ITS queue failed (${sent.error}). Confirm the company in the admin console under Customers.`, companyId: input.company.id, target: { type: "company", id: input.company.id } });
  }
}
