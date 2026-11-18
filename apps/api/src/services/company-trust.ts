import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { companyVerifiedAt, newTrialTerm, onTrialPlan, oneLine, trialTermOf, typedName, type Actor } from "@ros/contracts";
import { audit, closingDateRequired, defaultClosingDate, emit, errorForLog, notify, raiseAlert } from "@ros/core";
import { releaseHeldCommunications } from "@ros/agents";
import { companies, rolePackets, roles, type Queryable } from "@ros/db";
import { mailbox, type OutboundEmail, type SendResult } from "@ros/integrations";
import { armClosingDate } from "@ros/workflows";
import type { Container } from "../container";
import { trialDateWords, trialPatch } from "./trial";

/**
 * The one-time ITS check of a company that signed itself up (founder decision B7, plan B1). Every write is a single
 * jsonb statement on companies.settings, so a customer's own settings change and an ITS confirmation made at the same
 * moment never overwrite each other.
 */

/** Who confirmed a company where no ITS check is needed (COMPANY_CHECK=auto: tests, and local journeys that need public pages). */
export const AUTO_CHECK_ACTOR: Actor = { kind: "system", id: "company_check_auto", name: "No ITS check in this environment" };

/** The confirmation a new company starts with when the environment needs no ITS check. */
export function autoVerification(now: Date): { verifiedAt: string; verifiedBy: Actor } {
  return { verifiedAt: now.toISOString(), verifiedBy: AUTO_CHECK_ACTOR };
}

export type VerificationResult = { companyId: string; name: string; changed: boolean; verifiedAt: string | null; released: number };

/**
 * ITS confirms the company: from now on its careers page, job pages and Google listing are public, and every message to
 * a candidate that waited for the check goes into the queue.
 * The owners and admins are told; the confirmation is audited (the customer sees it in their history) and emitted.
 * Confirming a confirmed company changes nothing, except that any message to a candidate still held goes into the queue
 * (confirming again is the way to repair one that slipped past the first release). Null when there is no such company.
 * `quiet`: the caller tells the owner itself, in one notice (Accept, services/access-requests.ts: one approval, not two).
 */
export async function verifyCompany(tx: Queryable, container: Container, input: { companyId: string; actor: Actor; reason: string; now: Date; quiet?: boolean }): Promise<VerificationResult | null> {
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
  await giveDefaultClosingDates(tx, container, { companyId: co.id, actor: input.actor, now: input.now });
  if (input.quiet) return { companyId: co.id, name: co.name, changed: true, verifiedAt: at, released };
  await notify(tx, {
    companyId: co.id,
    kind: "company.verified",
    title: "ITS confirmed your company",
    body: `Your careers page and job pages are public now.${released ? ` ${released} ${released === 1 ? "message" : "messages"} to candidates that ${released === 1 ? "was" : "were"} waiting for this ${released === 1 ? "is" : "are"} on ${released === 1 ? "its" : "their"} way.` : ""}${term ? ` Your 30-day trial starts today and ends on ${trialDateWords(term.endsAt, co.timezone)}.` : ""}`,
    action: { label: "Open Home", href: "/" },
    roles: ["owner", "admin", "hiring_manager"],
  });
  return { companyId: co.id, name: co.name, changed: true, verifiedAt: at, released };
}

/**
 * Colorado's default closing date counts from when the job goes public (row 58): a role that opened while the company
 * waited for this check got no default date, so every open or paused role whose
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
 * ITS takes its confirmation back (a mistake, or a doubt about the company): the public pages go offline at once and
 * messages to candidates wait again, including any already queued (the outbox checks before it sends). Roles,
 * candidates and decisions are untouched. The owners and admins are told in plain words; audited with the reason.
 */
export async function unverifyCompany(tx: Queryable, input: { companyId: string; actor: Actor; reason: string; now?: Date }): Promise<VerificationResult | null> {
  const [co] = await tx.select({ id: companies.id, name: companies.name, settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1).for("update");
  if (!co) return null;
  if (!companyVerifiedAt(co.settings)) return { companyId: co.id, name: co.name, changed: false, verifiedAt: null, released: 0 };
  await tx.update(companies).set({ settings: sql`${companies.settings} - 'verifiedAt' - 'verifiedBy'` }).where(eq(companies.id, co.id));
  await emit(tx, { type: "company.unverified", companyId: co.id, actor: input.actor, subject: { type: "company", id: co.id }, payload: {} });
  await audit(tx, { companyId: co.id, actor: input.actor, action: "company.unverified", target: { type: "company", id: co.id }, reason: input.reason });
  await notify(tx, {
    companyId: co.id,
    kind: "company.unverified",
    title: "Your careers page is offline while ITS checks your company again",
    body: `Your careers page and job pages are offline for now, and messages to candidates wait until ITS confirms your company again. Your roles, candidates and decisions are unchanged. Your ITS contact will be in touch.`,
    action: { label: "Open Home", href: "/" },
    roles: ["owner", "admin", "hiring_manager"],
  });
  return { companyId: co.id, name: co.name, changed: true, verifiedAt: null, released: 0 };
}

/**
 * Whether an email really left: the provider took it. The fake adapter on a hosted deployment reports every email sent
 * and keeps it in memory (email-gate.ts), and a provider that is not set up, or a reply that was cut off, says nothing
 * about delivery, so none of them may be told to a person as sent.
 */
export function emailReallyLeft(sent: SendResult, adapter: { status: string }, nodeEnv: string): boolean {
  return sent.status === "sent" && !(adapter.status === "fake" && nodeEnv === "production");
}

/**
 * One email outside any transaction, where a failure stops nothing and raises no alert (first sign-in asks for approval:
 * email is not live on production yet, and the Overview row is what tells Nadine). True only when it really left.
 */
export async function sendWithoutAlert(container: Container, message: OutboundEmail): Promise<boolean> {
  try {
    return emailReallyLeft(await container.integrations.email.send(message), container.integrations.email, container.env.NODE_ENV);
  } catch (err) {
    console.warn(`[email] ${message.tags?.template ?? "a message"} could not be sent: ${errorForLog(err)}`);
    return false;
  }
}

/**
 * Tells the ITS queue mailbox that a company signed itself up and waits for the check, with the company's own details
 * and the owner's address, then the name they typed (no candidate data exists yet). Sent outside any transaction; a failed
 * send is raised as an operator alert so the company never waits unseen. What the person typed goes in one line each
 * (`oneLine`), and the email says only the address is proved.
 *
 * `request` (SIGNUP_MODE=approval): the words of a request for access, and a failed send raises no alert, because the
 * Overview row is what tells Nadine and a second row that outlives the decision would only be noise.
 */
export async function tellItsAboutNewCompany(container: Container, input: { company: { id: string; name: string; vertical: string; sizeBand: string; website: string | null; place?: string | null }; owner: { name: string | null; email: string }; request?: boolean }): Promise<void> {
  const from = mailbox(container.env.PRODUCT_NAME, container.integrations.env.fromAddress);
  const name = oneLine(input.company.name, 120);
  const vertical = oneLine(input.company.vertical, 60);
  const website = oneLine(input.company.website, 200) || "not given";
  // The address their sign-in proved comes first, and the name they typed after it with no angle brackets, so a name such
  // as "Pat Example <pat@its.example>" cannot pass for an address of ours (the review of 6 November 2026). In
  // every mode: under SIGNUP_MODE=open anyone signed in has the direct door (the review of 9 November 2026).
  const typed = typedName(input.owner.name);
  const owner = typed ? `${input.owner.email} (${typed})` : input.owner.email;
  if (input.request) {
    const text = [
      "Someone is asking for access. Nothing works for them until an administrator accepts: no AI runs, and nothing of theirs is public. Only the email address is proved; the rest is what they typed.",
      `Company: ${name}\nPerson: ${owner}\nKind of business: ${vertical}\nSize: ${input.company.sizeBand} employees\nCity and state: ${oneLine(input.company.place, 120) || "not given"}\nWebsite: ${website}`,
      `Accept or decline it in the admin console, on the Overview: ${container.env.APP_BASE_URL}/admin`,
    ].join("\n\n");
    await sendWithoutAlert(container, { to: container.env.ITS_QUEUE_EMAIL, from, subject: `[access request] ${name} is asking for access`, text, idempotencyKey: `access_request_its:${input.company.id}`, tags: { template: "access_request_its" } });
    return;
  }
  const text = [
    "A company signed itself up. Its careers page, job pages, Google listing and first emails to candidates wait for the one-time ITS check; it can draft and approve roles meanwhile. Only the email address is proved; the rest is what they typed.",
    `Company: ${name}\nKind of business: ${vertical}\nSize: ${input.company.sizeBand} employees\nWebsite: ${website}\nOwner: ${owner}`,
    `Confirm it, or ask the owner first, in the admin console under Customers: ${container.env.APP_BASE_URL}/admin`,
  ].join("\n\n");
  const sent = await container.integrations.email.send({ to: container.env.ITS_QUEUE_EMAIL, from, subject: `[company check] ${name} is waiting for the ITS check`, text, idempotencyKey: `company_check:${input.company.id}`, tags: { template: "company_check" } });
  if (sent.status === "failed") {
    await raiseAlert(container.db, { kind: "company.check_notice_failed", severity: "high", title: "A new company is waiting for the ITS check", body: `${name} signed itself up, but the email to the ITS queue failed (${sent.error}). Confirm the company in the admin console under Customers.`, companyId: input.company.id, target: { type: "company", id: input.company.id } });
  }
}
