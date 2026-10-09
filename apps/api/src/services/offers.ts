import { and, eq, inArray } from "drizzle-orm";
import type { Actor, ApplicationStage, MembershipRole, OfferMadeResult, RecordOfferMade } from "@ros/contracts";
import { STAGE_LABEL, audit, companyToday, emit, openEscalationsFor, transition } from "@ros/core";
import { applications, companies, offers, roles, users, withPlatform, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";

/**
 * "Offer made" (founder decision Q29; plan H2). A person records that an offer was made to a finalist outside the app:
 * the candidate moves to Offer, where they wait on the candidate's answer, and an offers row keeps who recorded it and
 * when it was made, with no term of the offer in it. The app never writes, approves or sends an offer, and nothing is
 * sent to the candidate. Their answer is recorded later as an outcome: Accepted is a hire (the hire sheet), Declined is
 * `offer_declined_externally`. Who may record it: those who record outcomes (outcome.record).
 */
export const OFFER_STATEMENT = "Recorded by a person. The offer was made outside Recruiting OS: the app did not write, approve or send it, and the candidate was not sent anything.";
const OFFER_NEXT = "When they answer, record it here: Accepted opens the hire sheet; Declined records that they turned it down.";
/** The steps from which an offer can be recorded: a finalist, or someone whose references are being checked. */
export const OFFER_FROM: readonly ApplicationStage[] = ["finalist", "reference_check"];

type App = typeof applications.$inferSelect;

/** Why an offer cannot be recorded for someone at this step, or null when it can. */
export function offerBlockedReason(stage: ApplicationStage): string | null {
  if (OFFER_FROM.includes(stage)) return null;
  if (stage === "offer_sent" || stage === "negotiation") return "An offer is already recorded for them. Record whether they accepted or declined.";
  return `Record an offer once they are a finalist (they are at "${STAGE_LABEL[stage]}").`;
}

export async function recordOfferMade(tx: Tx, input: { app: App; by: MembershipRole; actor: Actor; body: RecordOfferMade; now: Date }): Promise<OfferMadeResult> {
  const { app } = input;
  const blocked = offerBlockedReason(app.stage);
  if (blocked) throw new HttpError(409, "offer_not_allowed", blocked);
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const today = companyToday(input.now, company?.timezone ?? null);
  const madeOn = input.body.madeOn ?? today;
  if (madeOn > today) throw new HttpError(400, "date_in_future", "That date is still to come. Record the offer once it has been made.");
  const note = input.body.note?.trim() || null;
  const moved = await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "offer_sent", by: input.by, actor: input.actor, reason: "offer made outside the app", payload: { recordedOutsidePlatform: true, madeOn } });
  const [offer] = await tx.insert(offers).values({ companyId: app.companyId, applicationId: app.id, status: "made", terms: {}, madeOutside: true, madeOn, createdBy: input.actor }).returning({ id: offers.id });
  await emit(tx, { type: "offer.created", companyId: app.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { offerId: offer.id, madeOutside: true, recordedOutsidePlatform: true, madeOn, note } });
  await emit(tx, { type: "human.override", companyId: app.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { action: "offer_made", madeOn } });
  await audit(tx, { companyId: app.companyId, actor: input.actor, action: "outcome.recorded", target: { type: "application", id: app.id }, reason: "offer made outside the app", details: { offerId: offer.id, madeOn, stageFrom: moved.from, stageTo: moved.to } });
  return { ok: true, stage: "offer_sent", offerId: offer.id, madeOn, candidateNotice: "not_told", statement: OFFER_STATEMENT, next: OFFER_NEXT };
}

/**
 * The candidate's answer to an offer made outside the app, once a person records the outcome: accepted with a hire,
 * declined when they turned it down or withdrew, withdrawn when the team ended it (declined them, or no hire). Nothing
 * when no such offer is open.
 */
export async function settleOutsideOffer(tx: Tx, input: { applicationId: string; companyId: string; outcome: string; actor: Actor; now: Date }): Promise<string | null> {
  const status = input.outcome === "hired_externally" ? "accepted" : ["offer_declined_externally", "candidate_withdrew"].includes(input.outcome) ? "declined" : "withdrawn";
  const [row] = await tx.update(offers).set({ status, respondedAt: input.now.toISOString() }).where(and(eq(offers.applicationId, input.applicationId), eq(offers.madeOutside, true), eq(offers.status, "made"))).returning({ id: offers.id });
  if (!row) return null;
  await emit(tx, { type: status === "accepted" ? "offer.accepted" : status === "declined" ? "offer.declined" : "offer.rescinded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { offerId: row.id, madeOutside: true, recordedOutsidePlatform: true, outcome: input.outcome } });
  return status;
}

/** Tells the ITS recruiter working on this role or candidate about an outcome. Names the role, never the candidate. */
export async function tellRecruiterAboutOutcome(container: Container, companyId: string, roleId: string, applicationId: string | null, what: string, key: string) {
  const escalations = await openEscalationsFor(container.db, companyId, roleId, applicationId);
  if (!escalations.length) return;
  // the assigned recruiter is ITS staff, not a member of the company, so their address is read on the platform side
  const assigned = [...new Set(escalations.map((e) => e.assignedToUserId).filter((id): id is string => !!id))];
  const { company, role, emailOf } = await withPlatform(container.db, async (tx) => {
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const [role] = await tx.select({ title: roles.title }).from(roles).where(and(eq(roles.id, roleId), eq(roles.companyId, companyId))).limit(1);
    const people = assigned.length ? await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, assigned)) : [];
    return { company, role, emailOf: new Map(people.map((p) => [p.id, p.email])) };
  });
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  const told = new Set<string>();
  for (const e of escalations) {
    const to = e.assignedToUserId ? emailOf.get(e.assignedToUserId) : container.env.ITS_QUEUE_EMAIL;
    if (!to || told.has(to)) continue;
    told.add(to);
    await container.integrations.email.send({ to, from, subject: `${company?.name ?? "A customer"} recorded an outcome for ${role?.title ?? "a role"}`, text: `${what}\n\nThe customer recorded this themselves; the decision was made outside Recruiting OS. Your open request: ${container.env.APP_BASE_URL}/recruiter/queue/${e.id}`, idempotencyKey: `${key}:${to}`, tags: { template: "outcome_recorded" } });
  }
}
