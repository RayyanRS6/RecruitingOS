import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ACCESS_REQUEST_STATUSES, oneLine, typedName, visibleLength, type Actor, type CreateCompany, type CustomerAccessAnswer, type CustomerAccessChange, type CustomerAccessRequest, type SignupConfig, type SignupRequest } from "@ros/contracts";
import { activeSuppression, audit, emit, errorForLog, notify } from "@ros/core";
import { companies, events, memberships, users, withPlatform, type Db, type Queryable } from "@ros/db";
import { mailbox } from "@ros/integrations";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { createCompany, freeSlug, signupDoor, slugify } from "./companies";
import { sendWithoutAlert, tellItsAboutNewCompany, verifyCompany } from "./company-trust";

/**
 * First sign-in asks for approval (the owner's request of 6 November 2026, SIGNUP_MODE=approval). Anyone signed in who is
 * neither a platform administrator nor on the allow-list fills in the usual company form, and their company starts as a
 * request: a company row with its owner's membership `requested`. That membership is the wall: the code reads only
 * `status = 'active'` when it looks for a tenant, so someone waiting has none, and no route, AI run or workflow starts for
 * them. A platform administrator accepts or declines from the console (POST /admin/customers/:id/access). Accept makes the
 * membership active and counts as the one-time ITS check too: one approval, not two. Decline makes it `declined`; accepting
 * later is the undo.
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
 * Only the one place the form sends is kept (the review of 6 November 2026): a hand-made body cannot store twenty. A name
 * needs two characters a reader can see, and the person's own name has no angle brackets (`typedName`), so neither can be
 * blank on the console's row or pass for someone else's address in the ITS email.
 */
export function companyRequestDetails(input: CreateCompany): CreateCompany {
  const name = oneLine(input.name, 120);
  const vertical = oneLine(input.vertical, 60);
  if (visibleLength(name) < 2 || vertical.length < 2) throw new HttpError(400, "invalid_request", "Some fields are missing or invalid.");
  const place = (value: string | undefined) => (value === undefined ? undefined : oneLine(value, 120));
  return {
    ...input,
    name,
    vertical,
    ownerName: typedName(input.ownerName) ?? undefined,
    website: oneLine(input.website, 200) || undefined,
    locations: input.locations.slice(0, 1).map((l) => ({ ...l, label: place(l.label), address1: place(l.address1), city: place(l.city), region: place(l.region), postalCode: place(l.postalCode), country: oneLine(l.country, 120) || "US", timezone: place(l.timezone) })),
  };
}

/** "Austin, TX": the first place the company named, as the ITS email and the Overview row say it. */
function placeOf(locations: ReadonlyArray<{ city?: string; region?: string }>): string | null {
  const first = locations[0];
  return [first?.city, first?.region].filter(Boolean).join(", ") || null;
}

/**
 * Past this many requests waiting at once, a new one is still taken, with its row on the Overview, but neither of its emails
 * goes (the review of 6 November 2026): many accounts could otherwise fill the ITS mailbox and send our mail, from our domain,
 * to addresses of their own. The Overview's row is what tells an administrator, and the person's screen claims no email.
 */
export const OPEN_REQUESTS_EMAILED = 25;

/**
 * Sends the request (`POST /companies` for someone whose door is `request`): the company and the `requested` membership in
 * one transaction, with no active company, no workflow and no AI, then the emails outside it, to the person and to ITS.
 * `accessRequestEmailedAt` is written only when the person's copy really left, in one statement on the settings. With more
 * than OPEN_REQUESTS_EMAILED waiting, this one counted, no email goes.
 */
export async function sendAccessRequest(container: Container, input: { body: CreateCompany; user: { id: string; email: string; name: string | null }; actor: Actor }) {
  const details = companyRequestDetails(input.body);
  const company = await createCompany(container.db, details, input.user.id, input.actor, { request: true, now: container.engine.clock() });
  const person = { name: details.ownerName ?? input.user.name ?? null, email: input.user.email };
  if ((await openRequests(container)) > OPEN_REQUESTS_EMAILED) {
    const quiet: SignupRequest = { status: "requested", companyName: company.name, email: person.email, emailedAt: null };
    return { ...company, accessRequest: quiet };
  }
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

/** How many requests are waiting for a decision now, across every company. */
async function openRequests(container: Container): Promise<number> {
  const [row] = await withPlatform(container.db, (tx) => tx.select({ n: sql<number>`count(*)` }).from(memberships).where(eq(memberships.status, "requested")));
  return Number(row?.n ?? 0);
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
  // "We will email you when it is decided" holds only while we still may: once the address is stopped (a hard bounce, a
  // complaint), no email goes to it, so the screen claims none and says to keep the page open (the review of 6 November 2026)
  const emailed = row.settings.accessRequestEmailedAt ?? null;
  const emailedAt = emailed && !(await withPlatform(container.db, (tx) => activeSuppression(tx, user.email))) ? emailed : null;
  return { ...base, allowed: false, request: { status: row.status as SignupRequest["status"], companyName: row.companyName, email: user.email, emailedAt } };
}

/** What is left to do once a Decline has committed: the direct email, because a declined person is not an active member. */
type DeclinedNotice = { companyId: string; companyName: string; email: string };

/**
 * Accept or Decline, in the caller's platform transaction, under the company's row lock, so two presses at once make one
 * change and the second is told so. What it finds under the lock decides:
 *
 * - Accept of a request or a declined company (the undo): the membership becomes active, the company gets the careers
 *   address of its name in place of its neutral one (`requestSlug`), `verifyCompany` runs (quiet, and
 *   already a no-op if the company was confirmed), `company.access_accepted` is emitted and audited, `stuck_role_detector`
 *   starts (idempotent), and the owner gets one notice, written after the membership is active or it would reach nobody.
 * - Decline of a request: the membership becomes `declined`, `company.access_declined` is emitted and audited; the email
 *   goes once this has committed (`tellPersonDeclined`).
 * - Accept of a company with nobody waiting changes nothing and says so; Decline of one answers 409. A second Decline
 *   changes nothing and says so.
 * - The first press wins (the review of 6 November 2026): `from` is where the request stood on the row that was pressed. An
 *   Accept from a row that still showed the request, once someone declined it, answers 409 `access_decided` with who and
 *   when, and changes nothing; only the declined company's own Accept (`from: "declined"`) is the undo. A press from a
 *   declined row on a request still waiting is refused the same way. Two presses for the same outcome stay as above.
 */
export async function decideAccess(tx: Queryable, container: Container, input: { companyId: string; decision: CustomerAccessChange["decision"]; from: CustomerAccessChange["from"]; actor: Actor; now: Date }): Promise<{ answer: CustomerAccessAnswer; declined: DeclinedNotice | null }> {
  const { companyId, decision, actor, now } = input;
  const [co] = await tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1).for("update");
  if (!co) throw new HttpError(404, "not_found", "Company not found.");
  const [owner] = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, status: memberships.status, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, co.id), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES])))
    .limit(1);
  const answer = (status: CustomerAccessAnswer["status"], changed: boolean, message: string): CustomerAccessAnswer => ({ ok: true, companyId: co.id, decision, status, changed, message });
  const company = { type: "company" as const, id: co.id };
  if (!owner) {
    if (decision === "decline") throw new HttpError(409, "already_accepted", `${co.name} already has access, so it cannot be declined now.`);
    return { answer: answer("active", false, `${co.name} already has access. Nothing changed.`), declined: null };
  }
  if (input.from !== owner.status && !(decision === "decline" && owner.status === "declined")) throw await decidedFirst(tx, co, owner.status, now);
  const person = { type: "user" as const, id: owner.userId };
  if (decision === "decline") {
    if (owner.status === "declined") return { answer: answer("declined", false, `${co.name} was already declined. Nothing changed.`), declined: null };
    await tx.update(memberships).set({ status: "declined" }).where(eq(memberships.id, owner.id));
    await emit(tx, { type: "company.access_declined", companyId: co.id, actor, subject: company, payload: { from: owner.status } });
    await emit(tx, { type: "membership.changed", companyId: co.id, actor, subject: person, payload: { role: owner.role, status: "declined" } });
    await audit(tx, { companyId: co.id, actor, action: "company.access_declined", target: company, reason: DECLINED_REASON, details: { from: owner.status } });
    return { answer: answer("declined", true, `${co.name} was declined.`), declined: { companyId: co.id, companyName: co.name, email: owner.email } };
  }
  await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, owner.id));
  // The careers address of its name, given now, under the row lock, before anything of it can go public: a request held a
  // neutral one, so nobody took a real company's address by asking (the review of 6 November 2026). Taken meanwhile, it
  // gets four characters more, as any new company does.
  await tx.update(companies).set({ slug: await freeSlug(tx, slugify(co.name), co.id) }).where(eq(companies.id, co.id));
  await verifyCompany(tx, container, { companyId: co.id, actor, reason: ACCEPTED_REASON, now, quiet: true });
  await emit(tx, { type: "company.access_accepted", companyId: co.id, actor, subject: company, payload: { from: owner.status } });
  await emit(tx, { type: "membership.changed", companyId: co.id, actor, subject: person, payload: { role: owner.role, status: "active" } });
  await audit(tx, { companyId: co.id, actor, action: "company.access_accepted", target: company, reason: ACCEPTED_REASON, details: { from: owner.status } });
  await container.engine.start(tx, { workflowKey: "stuck_role_detector", companyId: co.id, subject: company, state: { companyId: co.id }, idempotencyKey: `stuck_role_detector:${co.id}`, actor });
  await notify(tx, { companyId: co.id, kind: "company.access_accepted", title: "Your request was approved", body: "You can start now.", action: { label: "Open Home", href: "/" }, userIds: [owner.userId] });
  return { answer: answer("active", true, `${co.name} was accepted.`), declined: null };
}

/**
 * The calm refusal of a press that came second and would undo what was decided first: who declined it and how long ago (the
 * console shows the API's words as they are, in any time zone), and the way to accept it still.
 */
async function decidedFirst(tx: Queryable, co: { id: string; name: string }, status: string, now: Date): Promise<HttpError> {
  if (status !== "declined") return new HttpError(409, "access_decided", `${co.name} is still waiting for a decision. Nothing changed.`, { status });
  const [last] = await tx.select({ at: events.occurredAt, actor: events.actor }).from(events).where(and(eq(events.companyId, co.id), eq(events.type, "company.access_declined"))).orderBy(desc(events.occurredAt)).limit(1);
  const by = last?.actor.name ?? null;
  return new HttpError(409, "access_decided", `${co.name} was declined${last ? ` ${agoWords(last.at, now)}` : ""}${by ? ` by ${by}` : ""}. Nothing changed. To let them in, accept it under Declined.`, { status, decidedAt: last?.at ?? null, decidedBy: by });
}

/** "a moment ago", "5 minutes ago", "3 hours ago", "2 days ago". */
function agoWords(at: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (!(minutes >= 1)) return "a moment ago";
  const [n, unit]: [number, string] = minutes < 60 ? [minutes, "minute"] : minutes < 1_440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1_440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** The email a Decline sends, once it has committed. A failure changes nothing and raises nothing. */
export async function tellPersonDeclined(container: Container, input: DeclinedNotice): Promise<void> {
  await sendWithoutAlert(container, {
    to: input.email,
    from: mailbox(container.env.PRODUCT_NAME, container.integrations.env.fromAddress),
    replyTo: container.env.EMAIL_REPLY_TO,
    subject: "We can't offer access right now",
    text: [
      `Thanks for asking about ${container.env.PRODUCT_NAME} for ${oneLine(input.companyName, 120)}. We can't offer access right now.`,
      `Questions? ${container.env.EMAIL_REPLY_TO}`,
    ].join("\n\n"),
    idempotencyKey: `access_declined:${input.companyId}`,
    tags: { template: "access_declined" },
  });
}

/**
 * Every console action on a customer other than Accept and Decline refuses a request or a declined company: nobody is in
 * yet, so there is nothing to change, and each of them either lets a person's company go public, or tells an owner who
 * cannot read it, or changes what Accept is about to give them. 409 `access_request_open`, pointing at the one door.
 */
export async function refuseWhileAccessOpen(q: Queryable, companyId: string): Promise<void> {
  const [row] = await q.select({ status: memberships.status }).from(memberships).where(and(eq(memberships.companyId, companyId), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]))).limit(1);
  if (row) throw new HttpError(409, "access_request_open", row.status === "requested" ? "This company is asking for access. Accept or decline it first." : "This company's request for access was declined. Accept it first if you want to let it in.", { accessRequest: row.status, path: `/api/v1/admin/customers/${companyId}/access` });
}

/** Whether a company is a request for access, waiting or declined: such a company answers nowhere in public. */
export async function isAccessRequestCompany(q: Queryable, companyId: string): Promise<boolean> {
  const [row] = await q.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.companyId, companyId), inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]))).limit(1);
  return !!row;
}

/**
 * `accessRequest` for GET /admin/customers: every request and declined company with the person who asked, and who declined
 * it and when (its newest `company.access_declined` event). Two queries, however many customers there are. The person's name
 * is what they typed, or what their sign-in provider holds, so it reads as `typedName` does: one line, no angle brackets.
 */
export async function customerAccessRequests(db: Db): Promise<Map<string, CustomerAccessRequest>> {
  const rows = await db
    .select({ companyId: memberships.companyId, status: memberships.status, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(inArray(memberships.status, [...ACCESS_REQUEST_STATUSES]));
  const declinedIds = rows.filter((r) => r.status === "declined").map((r) => r.companyId);
  const decided = declinedIds.length
    ? await db
        .selectDistinctOn([events.companyId], { companyId: events.companyId, at: events.occurredAt, actor: events.actor })
        .from(events)
        .where(and(eq(events.type, "company.access_declined"), inArray(events.companyId, declinedIds)))
        .orderBy(events.companyId, desc(events.occurredAt))
    : [];
  const decidedBy = new Map(decided.map((d) => [d.companyId, d]));
  return new Map(rows.map((r): [string, CustomerAccessRequest] => {
    const by = decidedBy.get(r.companyId);
    return [r.companyId, { status: r.status as CustomerAccessRequest["status"], person: { name: typedName(r.name), email: r.email }, declined: r.status === "declined" && by ? { at: by.at, by: by.actor.name ?? null } : null }];
  }));
}
