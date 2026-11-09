import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ACCESS_REQUEST_STATUSES, oneLine, type Actor, type CreateCompany, type CustomerAccessAnswer, type CustomerAccessChange, type CustomerAccessRequest, type SignupConfig, type SignupRequest } from "@ros/contracts";
import { audit, emit, errorForLog, notify, revokeInvitation, revokeSessionsForCompany } from "@ros/core";
import { companies, events, invitations, memberships, users, withPlatform, type Db, type Queryable } from "@ros/db";
import { mailbox } from "@ros/integrations";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { createCompany, signupDoor } from "./companies";
import { sendWithoutAlert, tellItsAboutNewCompany, unverifyCompany, verifyCompany } from "./company-trust";

/**
 * First sign-in asks for approval (the owner's request of 6 November 2026, SIGNUP_MODE=approval). Anyone signed in who is
 * neither a platform administrator nor on the allow-list fills in the usual company form, and their company starts as a
 * request: a company row with its owner's membership `requested`. That membership is the wall: the code reads only
 * `status = 'active'` when it looks for a tenant, so someone waiting has none, and no route, AI run or workflow starts for
 * them. A platform administrator accepts or declines from the console (POST /admin/customers/:id/access). Accept makes the
 * membership active and counts as the one-time ITS check too: one approval, not two. Decline makes it `declined`; accepting
 * later is the undo. Take away access (6 November 2026) makes an accepted company a declined one: everyone on it is
 * `declined`, and Accept brings them all back.
 *
 * The membership's status is the one source of truth for who is waiting. The only thing kept in the company's settings is
 * whether the request's email really left (`accessRequestEmailedAt`), so a screen claims it only when true. Email is not
 * live on production yet, so a send can fail for now, and nothing here depends on one: a failed email never stops a
 * request, an accept or a decline, and never raises an alert (`sendWithoutAlert`; the accepted notice's outbox email is
 * quiet too, NOTIFY_QUIET_ON_FAILURE in @ros/core).
 *
 * The address a request's email goes to is the session's: `users.email`, which nothing changes after the account is made,
 * set from an identity whose address the provider verified (`evaluateSignIn` refuses `email_unverified` before a session
 * opens) or from an emailed link the person opened (`consumeMagicLink`). So nobody can send our mail to an address they
 * have not proved they hold, and one account makes one request.
 */

/** The reasons recorded on the audit rows: nobody types one. */
export const ACCEPTED_REASON = "Accepted from the console";
export const DECLINED_REASON = "Declined from the console";

/**
 * A request's details as they are kept: what a stranger typed is data, so each value is one line and no longer than the
 * same field may be once it is theirs to change (UpdateCompany and the like). The form cannot send a line break, so this
 * only ever changes what a hand-made request sent. Nothing is refused for being long, except by CreateCompany's own limits.
 */
export function companyRequestDetails(input: CreateCompany): CreateCompany {
  const name = oneLine(input.name, 120);
  const vertical = oneLine(input.vertical, 60);
  if (name.length < 2 || vertical.length < 2) throw new HttpError(400, "invalid_request", "Some fields are missing or invalid.");
  const place = (value: string | undefined) => (value === undefined ? undefined : oneLine(value, 120));
  return {
    ...input,
    name,
    vertical,
    ownerName: oneLine(input.ownerName, 120) || undefined,
    website: oneLine(input.website, 200) || undefined,
    locations: input.locations.slice(0, 20).map((l) => ({ ...l, label: place(l.label), address1: place(l.address1), city: place(l.city), region: place(l.region), postalCode: place(l.postalCode), country: oneLine(l.country, 120) || "US", timezone: place(l.timezone) })),
  };
}

/** "Austin, TX": the first place the company named, as the ITS email and the Overview row say it. */
function placeOf(locations: ReadonlyArray<{ city?: string; region?: string }>): string | null {
  const first = locations[0];
  return [first?.city, first?.region].filter(Boolean).join(", ") || null;
}

/**
 * Sends the request (`POST /companies` for someone whose door is `request`): the company and the `requested` membership in
 * one transaction, with no active company, no workflow and no AI, then the emails outside it, to the person and to ITS.
 * `accessRequestEmailedAt` is written only when the person's copy really left, in one statement on the settings.
 */
export async function sendAccessRequest(container: Container, input: { body: CreateCompany; user: { id: string; email: string; name: string | null }; actor: Actor }) {
  const details = companyRequestDetails(input.body);
  const company = await createCompany(container.db, details, input.user.id, input.actor, { request: true, now: container.engine.clock() });
  const person = { name: details.ownerName ?? input.user.name ?? null, email: input.user.email };
  const left = await sendWithoutAlert(container, {
    to: person.email,
    from: mailbox(container.env.PRODUCT_NAME, container.integrations.env.fromAddress),
    replyTo: container.env.EMAIL_REPLY_TO,
    subject: "Your request has been sent",
    text: [
      `Thanks for asking about ${container.env.PRODUCT_NAME}. Your request for ${oneLine(company.name, 120)} has been sent.`,
      "Please wait for approval. ITS reviews each company, usually within one business day, and we will email you when it is decided.",
    ].join("\n\n"),
    idempotencyKey: `access_request:${company.id}`,
    tags: { template: "access_request" },
  });
  const emailedAt = left ? await recordRequestEmailed(container, company.id) : null;
  await tellItsAboutNewCompany(container, { company: { id: company.id, name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, website: details.website ?? null, place: placeOf(details.locations) }, owner: person, request: true });
  const accessRequest: SignupRequest = { status: "requested", companyName: company.name, email: person.email, emailedAt };
  return { ...company, settings: emailedAt ? { ...company.settings, accessRequestEmailedAt: emailedAt } : company.settings, accessRequest };
}

/** The one thing kept in settings. A failure to write it costs only the line on the screen, so it stops nothing. */
async function recordRequestEmailed(container: Container, companyId: string): Promise<string | null> {
  const at = container.engine.clock().toISOString();
  try {
    await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('accessRequestEmailedAt', ${at}::text)` }).where(eq(companies.id, companyId)));
    return at;
  } catch (err) {
    console.warn(`[access] could not record that the request's email left: ${errorForLog(err)}`);
    return null;
  }
}

/**
 * The `signup` part of GET /auth/config: the mode, whether this person may send the company form now, the ITS inbox to ask,
 * under `approval` which door they have, and in any mode their own request if they sent one (`invite` shuts the door
 * again, and whoever is waiting still reads where they stand).
 */
export async function signupConfigFor(container: Container, user: { id: string; email: string; platformRole: string } | null | undefined): Promise<SignupConfig> {
  const { env } = container;
  const door = user ? signupDoor(env, user) : "none";
  const base: SignupConfig = { mode: env.SIGNUP_MODE, allowed: user ? door !== "none" : env.SIGNUP_MODE === "open", contact: env.EMAIL_REPLY_TO, ...(env.SIGNUP_MODE === "approval" ? { door } : {}) };
  if (!user) return base;
  const [row] = await withPlatform(container.db, (tx) =>
    tx
      .select({ status: memberships.status, companyName: companies.name, settings: companies.settings })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(and(eq(memberships.userId, user.id), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES])))
      .orderBy(desc(memberships.createdAt))
      .limit(1),
  );
  if (!row) return base;
  return { ...base, allowed: false, request: { status: row.status as SignupRequest["status"], companyName: row.companyName, email: user.email, emailedAt: row.settings.accessRequestEmailedAt ?? null } };
}

/** What is left to do once a Decline has committed: the direct email, because a declined person is not an active member. */
type DeclinedNotice = { companyId: string; companyName: string; email: string; key?: string };

/** The reason recorded when an administrator takes an accepted company's access away (6 November 2026). */
export const REMOVED_REASON = "Access taken away from the console";

/** What is left to do once a removal has committed: the sessions of the people who lost access, and the owners' email. */
type RemovedPeople = { companyId: string; companyName: string; userIds: string[]; owners: string[]; at: string };

/**
 * Accept, Decline or Take away access, in the caller's platform transaction, under the company's row lock, so two presses
 * at once make one change and the second is told so. What it finds under the lock decides:
 *
 * - Accept of a request or a declined company (the undo): every membership waiting or declined becomes active (one for a
 *   request; everyone a removal took away), `verifyCompany` runs (quiet, and already a no-op if the company was
 *   confirmed), `company.access_accepted` is emitted and audited, `stuck_role_detector` starts (idempotent), and each of
 *   them gets one notice, written after the membership is active or it would reach nobody.
 * - Decline of a request: the membership becomes `declined`, `company.access_declined` is emitted and audited; the email
 *   goes once this has committed (`tellPersonDeclined`).
 * - Take away access (`remove`, 6 November 2026) of a company with access: every active membership becomes `declined`,
 *   open invitations are withdrawn (one accepted later would let someone in), the confirmation is taken back as "Take
 *   back the confirmation" does it (`unverifyCompany`: public pages offline, candidate emails held), and each person's
 *   sessions in it end (`revokeSessionsForCompany`), all in this transaction. `company.access_removed` is emitted and
 *   audited. From then on it is a declined company, and Accept brings everyone back. The owners' email goes once this
 *   has committed (`tellOwnersRemoved`). Someone also on another company keeps that one.
 * - Accept of a company with nobody waiting changes nothing and says so; Decline of one answers 409. A second Decline
 *   changes nothing and says so. Take away access of a company with none (a request, a declined company, nobody active)
 *   answers a calm 409.
 */
export async function decideAccess(tx: Queryable, container: Container, input: { companyId: string; decision: CustomerAccessChange["decision"]; actor: Actor; now: Date }): Promise<{ answer: CustomerAccessAnswer; declined: DeclinedNotice | null; removed?: RemovedPeople | null }> {
  const { companyId, decision, actor, now } = input;
  const [co] = await tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1).for("update");
  if (!co) throw new HttpError(404, "not_found", "Company not found.");
  const waiting = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, status: memberships.status, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, co.id), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES])));
  // The person a request is about: the one who asked, or after a removal the owner first.
  const owner = waiting.find((m) => m.role === "owner") ?? waiting[0];
  const answer = (status: CustomerAccessAnswer["status"], changed: boolean, message: string, extra: Partial<CustomerAccessAnswer> = {}): CustomerAccessAnswer => ({ ok: true, companyId: co.id, decision, status, changed, message, ...extra });
  const company = { type: "company" as const, id: co.id };
  if (decision === "remove") {
    if (owner) throw new HttpError(409, "no_access", owner.status === "requested" ? `${co.name} is asking for access and has none to take away. Decline it instead.` : `${co.name} has no access to take away. Nothing changed.`);
    const removed = await takeAccessAway(tx, { company: co, actor, now });
    return { answer: answer("declined", true, `${co.name} no longer has access.`, { people: removed.userIds.length }), declined: null, removed };
  }
  if (!owner) {
    if (decision === "decline") throw new HttpError(409, "already_accepted", `${co.name} already has access, so it cannot be declined now.`);
    return { answer: answer("active", false, `${co.name} already has access. Nothing changed.`), declined: null };
  }
  const person = { type: "user" as const, id: owner.userId };
  if (decision === "decline") {
    if (owner.status === "declined") return { answer: answer("declined", false, `${co.name} was already declined. Nothing changed.`), declined: null };
    await tx.update(memberships).set({ status: "declined" }).where(eq(memberships.id, owner.id));
    await emit(tx, { type: "company.access_declined", companyId: co.id, actor, subject: company, payload: { from: owner.status } });
    await emit(tx, { type: "membership.changed", companyId: co.id, actor, subject: person, payload: { role: owner.role, status: "declined" } });
    await audit(tx, { companyId: co.id, actor, action: "company.access_declined", target: company, reason: DECLINED_REASON, details: { from: owner.status } });
    return { answer: answer("declined", true, `${co.name} was declined.`), declined: { companyId: co.id, companyName: co.name, email: owner.email } };
  }
  // Was this the undo of a removal? Then everyone it took away comes back, and the notice says their access is back.
  const restoring = await accessWasTakenAway(tx, co.id);
  await tx.update(memberships).set({ status: "active" }).where(inArray(memberships.id, waiting.map((m) => m.id)));
  await verifyCompany(tx, container, { companyId: co.id, actor, reason: ACCEPTED_REASON, now, quiet: true });
  await emit(tx, { type: "company.access_accepted", companyId: co.id, actor, subject: company, payload: { from: owner.status, ...(restoring ? { restored: waiting.length } : {}) } });
  for (const m of waiting) await emit(tx, { type: "membership.changed", companyId: co.id, actor, subject: { type: "user", id: m.userId }, payload: { role: m.role, status: "active" } });
  await audit(tx, { companyId: co.id, actor, action: "company.access_accepted", target: company, reason: ACCEPTED_REASON, details: { from: owner.status, ...(restoring ? { restored: waiting.length } : {}) } });
  await container.engine.start(tx, { workflowKey: "stuck_role_detector", companyId: co.id, subject: company, state: { companyId: co.id }, idempotencyKey: `stuck_role_detector:${co.id}`, actor });
  await notify(tx, { companyId: co.id, kind: "company.access_accepted", ...(restoring ? { title: "Your access is back", body: "You can sign in and pick up where you left off." } : { title: "Your request was approved", body: "You can start now." }), action: { label: "Open Home", href: "/" }, userIds: waiting.map((m) => m.userId) });
  return { answer: answer("active", true, restoring ? `${co.name} has access again.` : `${co.name} was accepted.`), declined: null };
}

/** Whether the newest decision about this company's access took an accepted company's access away, rather than declining a request. */
async function accessWasTakenAway(q: Queryable, companyId: string): Promise<boolean> {
  const [last] = await q.select({ type: events.type }).from(events).where(and(eq(events.companyId, companyId), inArray(events.type, ["company.access_removed", "company.access_declined", "company.access_accepted"]))).orderBy(desc(events.occurredAt), desc(events.id)).limit(1);
  return last?.type === "company.access_removed";
}

/**
 * Takes an accepted company's access away, under the company's row lock held by `decideAccess`: everyone active becomes
 * declined, open invitations are withdrawn, the confirmation is taken back, and their sessions in it end. Refused with a
 * calm 409 when nobody is active.
 */
async function takeAccessAway(tx: Queryable, input: { company: { id: string; name: string }; actor: Actor; now: Date }): Promise<RemovedPeople> {
  const { company: co, actor, now } = input;
  const active = await tx.select({ id: memberships.id, userId: memberships.userId, role: memberships.role, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, co.id), eq(memberships.status, "active")));
  if (!active.length) throw new HttpError(409, "no_access", `${co.name} has nobody with access to take away. Nothing changed.`);
  const company = { type: "company" as const, id: co.id };
  await tx.update(memberships).set({ status: "declined" }).where(inArray(memberships.id, active.map((m) => m.id)));
  for (const m of active) await emit(tx, { type: "membership.changed", companyId: co.id, actor, subject: { type: "user", id: m.userId }, payload: { role: m.role, status: "declined", reason: "access_removed" } });
  // An invitation accepted later would make an active membership again: none is left open.
  const open = await tx.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.companyId, co.id), eq(invitations.status, "pending")));
  for (const inv of open) await revokeInvitation(tx, { invitationId: inv.id, companyId: co.id, actor, now });
  await emit(tx, { type: "company.access_removed", companyId: co.id, actor, subject: company, payload: { people: active.length, invitationsWithdrawn: open.length } });
  await audit(tx, { companyId: co.id, actor, action: "company.access_removed", target: company, reason: REMOVED_REASON, details: { people: active.length, invitationsWithdrawn: open.length } });
  // The public side goes offline and candidate emails wait, exactly as "Take back the confirmation" does it. Its notice to
  // the team reaches nobody now, which is right: nobody there can read it.
  await unverifyCompany(tx, { companyId: co.id, actor, reason: REMOVED_REASON, now });
  for (const m of active) await revokeSessionsForCompany(tx, m.userId, co.id, { now });
  return { companyId: co.id, companyName: co.name, userIds: active.map((m) => m.userId), owners: [...new Set(active.filter((m) => m.role === "owner").map((m) => m.email))], at: now.toISOString() };
}

/** The email a Decline sends, once it has committed. A failure changes nothing and raises nothing. True only when it really left. */
export async function tellPersonDeclined(container: Container, input: DeclinedNotice): Promise<boolean> {
  return sendWithoutAlert(container, {
    to: input.email,
    from: mailbox(container.env.PRODUCT_NAME, container.integrations.env.fromAddress),
    replyTo: container.env.EMAIL_REPLY_TO,
    subject: "We can't offer access right now",
    text: [
      `Thanks for asking about ${container.env.PRODUCT_NAME} for ${oneLine(input.companyName, 120)}. We can't offer access right now.`,
      `Questions? ${container.env.EMAIL_REPLY_TO}`,
    ].join("\n\n"),
    idempotencyKey: input.key ?? `access_declined:${input.companyId}`,
    tags: { template: "access_declined" },
  });
}

/**
 * After Take away access has committed (6 November 2026): one direct email to each owner, with the declined email's words,
 * never blocking and never an alert. True only when every one of them really left, so a screen claims it only then.
 */
export async function tellOwnersRemoved(container: Container, removed: RemovedPeople): Promise<boolean> {
  let all = removed.owners.length > 0;
  for (const email of removed.owners) {
    const left = await tellPersonDeclined(container, { companyId: removed.companyId, companyName: removed.companyName, email, key: `access_removed:${removed.companyId}:${removed.at}:${email}` });
    all = all && left;
  }
  return all;
}

/**
 * Every console action on a customer other than Accept and Decline refuses a request or a declined company: nobody is in
 * yet, so there is nothing to change, and each of them either lets a person's company go public, or tells an owner who
 * cannot read it, or changes what Accept is about to give them. 409 `access_request_open`, pointing at the one door. A
 * company whose access was taken away (6 November 2026) is a declined company, and is refused the same way.
 */
export async function refuseWhileAccessOpen(q: Queryable, companyId: string): Promise<void> {
  const [row] = await q.select({ status: memberships.status }).from(memberships).where(and(eq(memberships.companyId, companyId), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]))).limit(1);
  if (row) throw new HttpError(409, "access_request_open", row.status === "requested" ? "This company is asking for access. Accept or decline it first." : (await accessWasTakenAway(q, companyId)) ? "This company's access was taken away. Accept it first if you want to let it in again." : "This company's request for access was declined. Accept it first if you want to let it in.", { accessRequest: row.status, path: `/api/v1/admin/customers/${companyId}/access` });
}

/** Whether a company is a request for access, waiting or declined: such a company answers nowhere in public. */
export async function isAccessRequestCompany(q: Queryable, companyId: string): Promise<boolean> {
  const [row] = await q.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.companyId, companyId), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]))).limit(1);
  return !!row;
}

/**
 * `accessRequest` for GET /admin/customers: every request and declined company with the person who asked, and who declined
 * it and when (its newest `company.access_declined` event). Two queries, however many customers there are.
 */
export async function customerAccessRequests(db: Db): Promise<Map<string, CustomerAccessRequest>> {
  const rows = await db
    .select({ companyId: memberships.companyId, status: memberships.status, role: memberships.role, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]));
  const declinedIds = [...new Set(rows.filter((r) => r.status === "declined").map((r) => r.companyId))];
  // Declined, or its access taken away (6 November 2026): when and by whom, from the newest of either.
  const decided = declinedIds.length
    ? await db
        .selectDistinctOn([events.companyId], { companyId: events.companyId, at: events.occurredAt, actor: events.actor, type: events.type })
        .from(events)
        .where(and(inArray(events.type, ["company.access_declined", "company.access_removed"]), inArray(events.companyId, declinedIds)))
        .orderBy(events.companyId, desc(events.occurredAt))
    : [];
  const decidedBy = new Map(decided.map((d) => [d.companyId, d]));
  // One person per company: who asked, or after a removal an owner first (the rows of everyone it took away).
  const byCompany = new Map<string, (typeof rows)[number]>();
  for (const r of rows) { const known = byCompany.get(r.companyId); if (!known || (known.role !== "owner" && r.role === "owner")) byCompany.set(r.companyId, r); }
  return new Map([...byCompany.values()].map((r): [string, CustomerAccessRequest] => {
    const by = decidedBy.get(r.companyId);
    return [r.companyId, { status: r.status as CustomerAccessRequest["status"], person: { name: r.name, email: r.email }, declined: r.status === "declined" && by ? { at: by.at, by: by.actor.name ?? null } : null, ...(r.status === "declined" && by?.type === "company.access_removed" ? { removed: true } : {}) }];
  }));
}
