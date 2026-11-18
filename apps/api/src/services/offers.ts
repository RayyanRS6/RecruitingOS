import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, ApplicationStage, MembershipRole, OfferMadeResult, RecordOfferMade } from "@ros/contracts";
import { audit, companyToday, emit, transition } from "@ros/core";
import { type applications, companies, offers, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";

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
  // The stage menu's line, so it never names an internal step, and it says the way on (6 November 2026): an offer comes
  // after the interview's decision (Finalist), and someone already agreed outside the app is simply marked Hired.
  if (stage === "interview_complete" || stage === "debrief") return "Record Finalist as the interview's decision first, or mark them Hired.";
  if (stage === "interview_recommended" || stage === "interview_scheduled") return "Finish the interview first, or mark them Hired.";
  return "Interview them first, or mark them Hired.";
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
 * The day the offer each person at Offer waits on was made (`made_on`), by application, for the Talent list's row: it says
 * the same day as the candidate panel's card, which reads the newest `offer.created` fact, written with the newest offer
 * (review of the live-test fixes, 12 November 2026: the row counted 24 hours since the stage changed, and said "today" the
 * next morning). The newest offer whatever its state: an answer recorded at Offer and then taken back before they were
 * told, or voided by an administrator, puts them back at Offer, waiting on that offer again ("made" since 17 November
 * 2026; one taken back or voided before then left it settled: withdrawn, declined, accepted), and no newer one can be
 * recorded while they are there (the second look at that fix). None when the newest has no day, as the card then says
 * the day they moved to Offer. Only people at Offer are passed in; one query for the whole list.
 */
export async function openOfferDays(tx: Tx, applicationIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!applicationIds.length) return out;
  const rows = await tx.select({ applicationId: offers.applicationId, madeOn: offers.madeOn }).from(offers).where(inArray(offers.applicationId, [...applicationIds])).orderBy(desc(offers.createdAt));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.applicationId)) continue;
    seen.add(r.applicationId);
    if (r.madeOn) out.set(r.applicationId, r.madeOn);
  }
  return out;
}

/**
 * The candidate's answer to an offer made outside the app, once a person records the outcome: accepted with a hire,
 * declined when they turned it down or withdrew, withdrawn when the team ended it (declined them, or no hire), with the
 * day the offer was made, which the outcome's answer names (`offerMadeOn`). Nothing when no such offer is open. An answer
 * that no longer stands, taken back before they were told or voided by an administrator, puts the offer it settled back
 * to "made" (`reopenOfferSettledBy` in @ros/core, from the offer fact written here), so the next answer settles it again.
 */
export async function settleOutsideOffer(tx: Tx, input: { applicationId: string; companyId: string; outcome: string; actor: Actor; now: Date }): Promise<{ status: string; madeOn: string | null } | null> {
  const status = input.outcome === "hired_externally" ? "accepted" : ["offer_declined_externally", "candidate_withdrew"].includes(input.outcome) ? "declined" : "withdrawn";
  const [row] = await tx.update(offers).set({ status, respondedAt: input.now.toISOString() }).where(and(eq(offers.applicationId, input.applicationId), eq(offers.madeOutside, true), eq(offers.status, "made"))).returning({ id: offers.id, madeOn: offers.madeOn });
  if (!row) return null;
  await emit(tx, { type: status === "accepted" ? "offer.accepted" : status === "declined" ? "offer.declined" : "offer.rescinded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { offerId: row.id, madeOutside: true, recordedOutsidePlatform: true, outcome: input.outcome } });
  return { status, madeOn: row.madeOn };
}
