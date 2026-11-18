import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { RejectReason, type Actor, type ApplicationStage } from "@ros/contracts";
import { applications, approvalRequests, entitlements, events, hiringOutcomes, offers, postings, roles, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { lockApplicants } from "./candidate-lock";
import { ACTIVE_ROLES, roleRoom } from "./entitlements";
import { emit } from "./events";
import { BOARD_UP_STATES, isBoardChannel, transitionPosting, type PostingState } from "./postings";
import { DECISION_STAGES, transition, withdrawQueuedDecision } from "./stages";

const ACTIVE_STAGES = new Set<ApplicationStage>(["applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete", "interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check", "offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding"]);

/**
 * Human-recorded hiring outcomes (founder instruction of 21 September 2026, item 4). A decision-maker records what
 * happened, usually outside the platform: a hire, a withdrawal, a decline, a role cancelled or filled elsewhere. The
 * platform never generates, approves or transmits an offer, and this module holds no payroll, tax, identity, banking or
 * onboarding data. Every record names the person who recorded it and can only be corrected by an audited administrator
 * action that leaves the original row in place, or taken back with its decision before the candidate was told
 * (`takeBackOutcome`, audited too), which keeps the row too.
 */
export type ApplicationOutcome = "hired_externally" | "candidate_withdrew" | "employer_declined" | "offer_declined_externally" | "no_hire";
export type RoleOutcome = "filled" | "filled_outside_platform" | "role_cancelled" | "no_hire";
export type OutcomeRow = typeof hiringOutcomes.$inferSelect;
type Mover = Parameters<typeof transition>[1]["by"];

export const OUTCOME_STAGE: Record<ApplicationOutcome, ApplicationStage> = {
  hired_externally: "hired",
  candidate_withdrew: "withdrawn",
  employer_declined: "rejected",
  offer_declined_externally: "declined",
  no_hire: "talent_pool",
};

/** The sentence shown next to every outcome so nobody reads it as something the platform did. */
export const OUTCOME_STATEMENT = "Recorded by a person. Any offer, acceptance or decline happened outside Recruiting OS; the platform did not generate, approve or send it.";

export class OutcomeError extends Error {
  constructor(public readonly code: "hire_date_required" | "reason_required" | "not_found" | "already_closed" | "already_corrected" | "already_recorded" | "not_active" | "bad_outcome" | "no_room_on_plan", message: string) {
    super(message);
  }
}

/** A stored reason read back as one of the fixed reasons (plan G2); anything older or unknown reads as "other". */
export function rejectReasonOf(value: unknown): RejectReason {
  const parsed = RejectReason.safeParse(value);
  return parsed.success ? parsed.data : "other";
}

/**
 * `reason` is one of the fixed decline reasons (plan G2), the same list as the Decline button's: a decline recorded as an
 * outcome files that reason on the application exactly as a decline does; the person's own words go in `note`.
 */
export async function recordApplicationOutcome(
  q: Queryable,
  input: { companyId: string; applicationId: string; outcome: ApplicationOutcome; by: Mover; actor: Actor; hireDate?: string; offerAcceptedAt?: string; reason?: RejectReason; note?: string; now?: Date },
): Promise<{ row: OutcomeRow; from: ApplicationStage; to: ApplicationStage; roleId: string; roleStillOpen: boolean; app: typeof applications.$inferSelect }> {
  const now = input.now ?? new Date();
  const [app] = await q.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.companyId, input.companyId))).limit(1);
  if (!app) throw new OutcomeError("not_found", "Application not found.");
  // one outcome per candidate: a closed candidate takes no second outcome (an administrator corrects), except a later hire from the talent pool
  const later = input.outcome === "hired_externally" && app.stage === "talent_pool";
  if (!ACTIVE_STAGES.has(app.stage) && !later) throw new OutcomeError("not_active", "This candidate already has an outcome. An administrator can correct it.");
  const duplicate = await q.select({ id: hiringOutcomes.id }).from(hiringOutcomes).where(and(eq(hiringOutcomes.applicationId, app.id), eq(hiringOutcomes.outcome, input.outcome), isNull(hiringOutcomes.correctedAt))).limit(1);
  if (duplicate.length) throw new OutcomeError("already_recorded", "This outcome is already recorded for this candidate.");
  if (input.outcome === "hired_externally" && !input.hireDate) throw new OutcomeError("hire_date_required", "Enter the hire date (the start date agreed outside the platform).");
  if (input.outcome === "employer_declined" && !input.reason) throw new OutcomeError("reason_required", "Choose why you declined them; it is recorded with your name.");
  const to = OUTCOME_STAGE[input.outcome];
  // A decline keeps its reason on the application (the role report counts it, the decision message's wording follows it).
  const reason = input.outcome === "employer_declined" ? input.reason : input.outcome;
  const moved = await transition(q, { applicationId: app.id, companyId: input.companyId, to, by: input.by, actor: input.actor, reason, payload: { outcome: input.outcome, recordedOutsidePlatform: true, ...(input.reason ? { declineReason: input.reason } : {}) } });
  const [row] = await q.insert(hiringOutcomes).values({
    companyId: input.companyId, applicationId: app.id, roleId: app.roleId, milestone: "final", outcome: input.outcome, notes: input.note ?? null,
    hireDate: input.outcome === "hired_externally" ? input.hireDate ?? null : null, offerAcceptedAt: input.outcome === "hired_externally" ? input.offerAcceptedAt ?? null : null,
    details: { reason: input.reason ?? null, stageFrom: moved.from, stageTo: moved.to, recordedOutsidePlatform: true },
    recordedBy: input.actor, recordedAt: now.toISOString(),
  }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "outcome.recorded", target: { type: "application", id: app.id }, reason: input.reason ?? input.outcome, details: { outcomeId: row.id, outcome: input.outcome, hireDate: row.hireDate, offerAcceptedAt: row.offerAcceptedAt, stageFrom: moved.from, stageTo: moved.to } });
  await emit(q, { type: "outcome.recorded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { outcome: input.outcome, level: "application", outcomeId: row.id, roleId: app.roleId, stageFrom: moved.from, stageTo: moved.to } });
  await emit(q, { type: "human.override", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { action: "outcome", outcome: input.outcome } });
  const [role] = await q.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  return { row, from: moved.from, to: moved.to, roleId: app.roleId, roleStillOpen: !!role && role.status !== "closed", app };
}

/** A board that was up when the role closed and still needs taking down by hand (docs/spec/20 item 15). */
export type ClosureRequired = { postingId: string; channel: string; externalUrl: string | null };

/**
 * Closes the role with its outcome. Separate from the candidate outcome on purpose: the founder asked for a second,
 * explicit confirmation. Every posting closes with it; a board that was posted (or paused after being posted) is marked
 * `closureRequired` and emitted as `posting.closure_required`, so the role page can say what is still up until a person
 * confirms it was removed. Someone locked moves as the others do and stays locked (Rule 2): the stage says the job is over
 * for them, but they are not among `movedCandidateIds` or the count, because nobody at the company knows them to keep them.
 */
export async function recordRoleOutcome(
  q: Queryable,
  input: { companyId: string; roleId: string; outcome: RoleOutcome; by: Mover; actor: Actor; reason?: string; now?: Date },
): Promise<{ row: OutcomeRow; role: typeof roles.$inferSelect; movedToTalentPool: number; movedApplicationIds: string[]; movedCandidateIds: string[]; closureRequired: ClosureRequired[] }> {
  const now = input.now ?? new Date();
  const [role] = await q.select().from(roles).where(and(eq(roles.id, input.roleId), eq(roles.companyId, input.companyId))).limit(1);
  if (!role) throw new OutcomeError("not_found", "Role not found.");
  if (role.status === "closed") throw new OutcomeError("already_closed", "This role is already closed. An administrator can correct its outcome.");
  const closed = await q.update(roles).set({ status: "closed", closedAt: now.toISOString(), closeReason: input.outcome }).where(and(eq(roles.id, role.id), sql`${roles.status} <> 'closed'`)).returning();
  if (!closed.length) throw new OutcomeError("already_closed", "This role was closed a moment ago by someone else.");
  const updated = closed[0];
  // active candidates are kept in the talent pool, as the page promises; hired and closed candidates are untouched. The
  // move is a private decision like any other (founder decision B6): nobody is told the decision until a person sends the
  // message (the caller's exit cleanup tells someone with a booked time or offered times only that the interview is off).
  // The caller keeps them in the talent pool unless they asked not to be kept, and offers the one closing message (Q30).
  // Behind the job's own lock: a change of plan opening its applicants goes through the same rows in another order.
  await lockApplicants(q, role.id);
  const open = await q.select({ id: applications.id, stage: applications.stage, candidateId: applications.candidateId, lockedAt: applications.lockedAt }).from(applications).where(eq(applications.roleId, role.id));
  const movedApplicationIds: string[] = [];
  const movedCandidateIds: string[] = [];
  // The locked people this close moved, kept on its record: a void moves back exactly these (`correctOutcome`).
  const lockedMoved: string[] = [];
  for (const a of open) {
    if (!ACTIVE_STAGES.has(a.stage)) continue;
    await transition(q, { applicationId: a.id, companyId: input.companyId, to: "talent_pool", by: input.by, actor: input.actor, reason: `role closed: ${input.outcome}` });
    movedApplicationIds.push(a.id);
    if (!a.lockedAt) movedCandidateIds.push(a.candidateId);
    else lockedMoved.push(a.id);
  }
  const movedToTalentPool = movedCandidateIds.length;
  // every posting closes with the role; a board that is up on the outside is named for manual removal
  const closureRequired: ClosureRequired[] = [];
  const posts = await q.select().from(postings).where(eq(postings.roleId, role.id));
  for (const p of posts) {
    if (p.status === "closed") continue;
    const stillUp = isBoardChannel(p.channel) && BOARD_UP_STATES.includes(p.status as PostingState);
    await transitionPosting(q, { postingId: p.id, to: "closed", actor: input.actor, now, reason: `role closed: ${input.outcome}`, patch: stillUp ? { closureRequired: true } : {} });
    if (stillUp) {
      closureRequired.push({ postingId: p.id, channel: p.channel, externalUrl: p.externalUrl });
      await emit(q, { type: "posting.closure_required", companyId: input.companyId, actor: input.actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: role.id, url: p.externalUrl } });
    }
  }
  const [row] = await q.insert(hiringOutcomes).values({ companyId: input.companyId, applicationId: null, roleId: role.id, milestone: "role", outcome: input.outcome, notes: input.reason ?? null, details: { reason: input.reason ?? null, previousStatus: role.status, recordedOutsidePlatform: true, closureRequired: closureRequired.map((c) => c.channel), lockedMoved }, recordedBy: input.actor, recordedAt: now.toISOString() }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "role.outcome_recorded", target: { type: "role", id: role.id }, reason: input.reason ?? input.outcome, details: { outcomeId: row.id, outcome: input.outcome, previousStatus: role.status, closureRequired: closureRequired.map((c) => c.channel) } });
  await emit(q, { type: "role.closed", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { reason: input.outcome, closureRequired: closureRequired.map((c) => c.channel) } });
  await emit(q, { type: "outcome.recorded", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { outcome: input.outcome, level: "role", outcomeId: row.id, roleId: role.id, movedToTalentPool } });
  return { row, role: updated, movedToTalentPool, movedApplicationIds, movedCandidateIds, closureRequired };
}

/**
 * An administrator corrects a recorded outcome. The original row stays, marked corrected; a new row points back to it;
 * the application returns to the stage the corrected outcome implies (or the stage it had before, when the outcome is voided).
 * A correction to "we declined the candidate" is filed under one of the fixed reasons (`declineReason`, plan G2; the
 * original's when left out). A role outcome voided reopens the role, and its closing message waiting for approval (Q30)
 * is withdrawn: the closing message is only for a closed role. Someone the team can read stays where the close left them, for
 * the team to move. Someone locked it moved and nobody has told has nobody who could (Rule 2): they go back to waiting, so the
 * date they were promised, the close-out note and an upgrade all work as if the job had not closed. A voided role takes a
 * place on the plan again, so it needs one free, read as a new role's is, behind the same row: the plan's limit holds for ITS too.
 * A voided answer that settled an offer made outside the app puts that offer back to waiting on them (`reopenOfferSettledBy`),
 * so the answer recorded next settles it (17 November 2026).
 */
export async function correctOutcome(
  q: Queryable,
  input: { outcomeId: string; actor: Actor; reason: string; outcome?: string; hireDate?: string; offerAcceptedAt?: string; declineReason?: RejectReason; now?: Date },
): Promise<{ original: OutcomeRow; correction: OutcomeRow }> {
  const now = input.now ?? new Date();
  const [original] = await q.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, input.outcomeId)).limit(1);
  if (!original) throw new OutcomeError("not_found", "Outcome not found.");
  if (original.correctedAt) throw new OutcomeError("already_corrected", "This outcome was already corrected; correct the newest record instead.");
  const newOutcome = input.outcome ?? "voided";
  const applicationLevel = !!original.applicationId;
  const allowed = applicationLevel ? [...Object.keys(OUTCOME_STAGE), "voided"] : ["filled", "filled_outside_platform", "role_cancelled", "no_hire", "voided"];
  if (!allowed.includes(newOutcome)) throw new OutcomeError("bad_outcome", `"${newOutcome}" is not a ${applicationLevel ? "candidate" : "role"} outcome.`);
  if (newOutcome === "hired_externally" && !input.hireDate && !original.hireDate) throw new OutcomeError("hire_date_required", "A corrected hire needs the hire date.");
  if (!applicationLevel && original.roleId && newOutcome === "voided") {
    // The job's lock first, then the plan's row, in the order a change of plan takes them, so the two never wait for each other.
    await lockApplicants(q, original.roleId);
    await q.select({ id: entitlements.id }).from(entitlements).where(and(eq(entitlements.companyId, original.companyId), eq(entitlements.key, ACTIVE_ROLES))).for("update");
    const room = await roleRoom(q, original.companyId, { except: original.roleId });
    if (!room.ok) throw new OutcomeError("no_room_on_plan", "Reopening this job needs a place on the company's plan, and none is free. Change the plan first, then void this outcome.");
  }
  await q.update(hiringOutcomes).set({ correctedAt: now.toISOString(), correctedBy: input.actor, correctionReason: input.reason }).where(eq(hiringOutcomes.id, original.id));
  const [correction] = await q.insert(hiringOutcomes).values({
    companyId: original.companyId, applicationId: original.applicationId, roleId: original.roleId, milestone: original.milestone, outcome: newOutcome,
    hireDate: input.hireDate ?? (newOutcome === "hired_externally" ? original.hireDate : null), offerAcceptedAt: input.offerAcceptedAt ?? (newOutcome === "hired_externally" ? original.offerAcceptedAt : null),
    details: { ...original.details, ...(input.declineReason ? { reason: input.declineReason } : {}), correctionReason: input.reason }, correctionOf: original.id, recordedBy: input.actor, recordedAt: now.toISOString(),
  }).returning();
  let stageTo: ApplicationStage | null = null;
  let reopenedOfferId: string | null = null;
  if (original.applicationId) {
    const from = (original.details as { stageFrom?: ApplicationStage }).stageFrom;
    stageTo = Object.hasOwn(OUTCOME_STAGE, newOutcome) ? OUTCOME_STAGE[newOutcome as ApplicationOutcome] : from ?? "talent_pool";
    const stamp = now.toISOString();
    const [current] = await q.select({ stage: applications.stage }).from(applications).where(eq(applications.id, original.applicationId)).limit(1);
    // A corrected record that now says "declined" or "talent pool" is a decision the candidate has not been told. One that
    // only moves between those two keeps the told state, as `transition` does: they were told a decision either way, and
    // a second Send would write to them twice. One that leaves a decision withdraws its message still in the outbox.
    const wasDecision = !!current && DECISION_STAGES.includes(current.stage);
    const newDecision = DECISION_STAGES.includes(stageTo) && !wasDecision;
    if (wasDecision && !DECISION_STAGES.includes(stageTo)) await withdrawQueuedDecision(q, { applicationId: original.applicationId, companyId: original.companyId, actor: input.actor, reason: "the recorded outcome was corrected" });
    await q.update(applications).set({
      stage: stageTo, stageChangedAt: stamp,
      rejectedAt: stageTo === "rejected" ? stamp : null, rejectReason: stageTo === "rejected" ? (input.declineReason ?? rejectReasonOf((original.details as { reason?: unknown }).reason)) : null,
      withdrawnAt: stageTo === "withdrawn" ? stamp : null, withdrawReason: stageTo === "withdrawn" ? "candidate_withdrew" : null,
      ...(newDecision ? { toldState: "not_told" as const, candidateToldAt: null } : {}),
    }).where(eq(applications.id, original.applicationId));
    // Voided, an answer recorded at Offer leaves them waiting on the offer it settled again.
    if (newOutcome === "voided") reopenedOfferId = await reopenOfferSettledBy(q, original);
    await emit(q, { type: "human.override", companyId: original.companyId, actor: input.actor, subject: { type: "application", id: original.applicationId }, payload: { action: "outcome_corrected", outcome: newOutcome, stageTo, ...(reopenedOfferId ? { reopenedOfferId } : {}) } });
  } else if (original.roleId) {
    if (newOutcome === "voided") {
      // Closing a role withdrew the approval it was waiting for, so one reopened from there goes back to a draft: its team
      // asks for approval again. Waiting for approval, with nothing to approve, it would be stuck.
      const before = (original.details as { previousStatus?: string }).previousStatus ?? "open";
      const previous = before === "pending_approval" ? "draft" : before;
      await q.update(roles).set({ status: previous, closedAt: null, closeReason: null }).where(eq(roles.id, original.roleId));
      await lockApplicants(q, original.roleId);
      // Exactly the people locked the close moved: someone locked whose move to the talent pool was stored before the close
      // keeps it, as a decision of its own, which a void does not undo. A close recorded before that list was kept moves back,
      // as it did, everyone locked and untold in the talent pool.
      const kept = (original.details as { lockedMoved?: unknown }).lockedMoved;
      const only = Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : null;
      const waitingAgain = only?.length === 0 ? [] : await q.update(applications).set({ stage: "received", stageChangedAt: now.toISOString() }).where(and(eq(applications.roleId, original.roleId), eq(applications.stage, "talent_pool"), isNotNull(applications.lockedAt), eq(applications.toldState, "not_told"), ...(only ? [inArray(applications.id, only)] : []))).returning({ id: applications.id });
      for (const a of waitingAgain) await emit(q, { type: "application.stage_changed", companyId: original.companyId, actor: input.actor, subject: { type: "application", id: a.id }, payload: { from: "talent_pool", to: "received", reason: "the role was reopened" } });
      const closing =(await q.select({ id: approvalRequests.id, proposal: approvalRequests.proposal }).from(approvalRequests).where(and(eq(approvalRequests.roleId, original.roleId), isNull(approvalRequests.applicationId), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")))).filter((r) => (r.proposal as { kind?: unknown }).kind === "role_closed");
      for (const r of closing) {
        await q.update(approvalRequests).set({ status: "cancelled", decidedAt: now.toISOString(), decisionNote: "the role was reopened" }).where(eq(approvalRequests.id, r.id));
        await emit(q, { type: "approval.cancelled", companyId: original.companyId, actor: input.actor, subject: { type: "approval_request", id: r.id }, payload: { actionType: "disposition.send", applicationId: null, by: "outcome_corrected" } });
      }
    } else {
      await q.update(roles).set({ closeReason: newOutcome }).where(eq(roles.id, original.roleId));
    }
  }
  await emit(q, { type: "outcome.corrected", companyId: original.companyId, actor: input.actor, subject: original.applicationId ? { type: "application", id: original.applicationId } : { type: "role", id: original.roleId ?? original.id }, payload: { outcome: newOutcome, previous: original.outcome, level: original.applicationId ? "application" : "role", outcomeId: correction.id, originalId: original.id } });
  await audit(q, { companyId: original.companyId, actor: input.actor, action: "outcome.corrected", target: original.applicationId ? { type: "application", id: original.applicationId } : { type: "role", id: original.roleId ?? original.id }, reason: input.reason, details: { originalId: original.id, correctionId: correction.id, from: original.outcome, to: newOutcome, stageTo, ...(reopenedOfferId ? { reopenedOfferId } : {}) } });
  return { original, correction };
}

/** The facts an answer recorded at Offer writes about the offer it settled (`settleOutsideOffer` in apps/api). */
const OFFER_SETTLED = ["offer.accepted", "offer.declined", "offer.rescinded"];

/** Beside a record the team took back with its decision before the candidate was told, where ITS reads why it no longer counts. */
export const TAKEN_BACK_REASON = "Taken back by the team before they were told";

/**
 * The offer an answer settled (`settleOutsideOffer` in apps/api, in the answer's own transaction), back to waiting on the
 * candidate ("made", with no response time) once that answer no longer stands: taken back before they were told
 * (`takeBackOutcome`), or voided by an administrator (`correctOutcome`). They are back at Offer, so the answer recorded
 * next settles it again and carries its day (17 November 2026). The offer is the one named by the offer fact the answer
 * wrote (offer.accepted, offer.declined or offer.rescinded, after its outcome.recorded fact and before the person's next
 * move), and only while no later answer settled it again: an answer that settled none, and an offer an earlier answer
 * settled, are left as they are. A correction stands for the answer it corrected, which wrote the facts. Returns the offer
 * put back, or null.
 */
export async function reopenOfferSettledBy(q: Queryable, answer: Pick<OutcomeRow, "id" | "applicationId" | "correctionOf">): Promise<string | null> {
  let root = answer;
  const seen = new Set([root.id]);
  while (root.correctionOf && !seen.has(root.correctionOf)) {
    seen.add(root.correctionOf);
    const [earlier] = await q.select({ id: hiringOutcomes.id, applicationId: hiringOutcomes.applicationId, correctionOf: hiringOutcomes.correctionOf }).from(hiringOutcomes).where(eq(hiringOutcomes.id, root.correctionOf)).limit(1);
    if (!earlier) break;
    root = earlier;
  }
  const applicationId = root.applicationId;
  if (!applicationId) return null;
  const about = and(eq(events.subjectType, "application"), eq(events.subjectId, applicationId));
  const [recorded] = await q.select({ id: events.id }).from(events).where(and(about, eq(events.type, "outcome.recorded"), sql`${events.payload}->>'outcomeId' = ${root.id}`)).orderBy(asc(events.id)).limit(1);
  if (!recorded) return null;
  const later = await q.select({ id: events.id, type: events.type, payload: events.payload }).from(events).where(and(about, gt(events.id, recorded.id), inArray(events.type, ["application.stage_changed", ...OFFER_SETTLED]))).orderBy(asc(events.id));
  const nextMove = later.find((e) => e.type === "application.stage_changed")?.id ?? Number.POSITIVE_INFINITY;
  const own = later.find((e) => e.type !== "application.stage_changed" && e.id < nextMove && typeof e.payload.offerId === "string");
  if (!own) return null;
  const offerId = String(own.payload.offerId);
  if (later.some((e) => e.id > own.id && e.type !== "application.stage_changed" && e.payload.offerId === offerId)) return null;
  const [row] = await q.update(offers).set({ status: "made", respondedAt: null }).where(and(eq(offers.id, offerId), eq(offers.applicationId, applicationId), eq(offers.madeOutside, true), ne(offers.status, "made"))).returning({ id: offers.id });
  return row?.id ?? null;
}

/**
 * A decision recorded as an outcome ("No hire", "We declined") and taken back before the candidate was told (plan G1,
 * `undo_decision` in apps/api), called before the take back moves them. Its record is kept, marked taken back by the person
 * (`correctedAt`, `correctedBy`, `TAKEN_BACK_REASON`) with no correction after it, so the role report and its applicant list
 * no longer count it, the same answer can be recorded again, and ITS has nothing left to correct; and the offer it settled
 * at Offer waits on them again (`reopenOfferSettledBy`), so the next answer settles it (17 November 2026). The marking is
 * audited `outcome.taken_back` in the same transaction, with the person, `TAKEN_BACK_REASON` and the offer put back, as
 * every other change to an outcome record is, so the team's audit history and ITS read it (the review of that fix). The
 * answer is the one recorded with their last move, as an administrator's correction may have changed it since; a decision
 * made with the decline button records none, and then nothing changes and nothing is audited.
 */
export async function takeBackOutcome(q: Queryable, input: { applicationId: string; actor: Actor; now: Date }): Promise<{ outcomeId: string | null; offerId: string | null }> {
  const none = { outcomeId: null, offerId: null };
  const about = and(eq(events.subjectType, "application"), eq(events.subjectId, input.applicationId));
  const [lastMove] = await q.select({ id: events.id }).from(events).where(and(about, eq(events.type, "application.stage_changed"))).orderBy(desc(events.id)).limit(1);
  if (!lastMove) return none;
  const [recorded] = await q.select({ payload: events.payload }).from(events).where(and(about, eq(events.type, "outcome.recorded"), gt(events.id, lastMove.id))).orderBy(asc(events.id)).limit(1);
  const outcomeId = recorded?.payload.outcomeId;
  if (typeof outcomeId !== "string") return none;
  // The record as it stands now: each correction an administrator made marks the one before it.
  let [answer] = await q.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, outcomeId)).limit(1);
  const seen = new Set<string>();
  while (answer?.correctedAt && !seen.has(answer.id)) {
    seen.add(answer.id);
    [answer] = await q.select().from(hiringOutcomes).where(eq(hiringOutcomes.correctionOf, answer.id)).limit(1);
  }
  if (!answer || answer.correctedAt || answer.applicationId !== input.applicationId || !DECISION_STAGES.includes(OUTCOME_STAGE[answer.outcome as ApplicationOutcome])) return none;
  const [marked] = await q.update(hiringOutcomes).set({ correctedAt: input.now.toISOString(), correctedBy: input.actor, correctionReason: TAKEN_BACK_REASON }).where(and(eq(hiringOutcomes.id, answer.id), isNull(hiringOutcomes.correctedAt))).returning({ id: hiringOutcomes.id });
  if (!marked) return none;
  const offerId = await reopenOfferSettledBy(q, answer);
  await audit(q, { companyId: answer.companyId, actor: input.actor, action: "outcome.taken_back", target: { type: "application", id: input.applicationId }, reason: TAKEN_BACK_REASON, details: { outcomeId: answer.id, outcome: answer.outcome, ...(offerId ? { reopenedOfferId: offerId } : {}) } });
  return { outcomeId: answer.id, offerId };
}

export async function listOutcomes(q: Queryable, where: { companyId: string; applicationId?: string; roleId?: string }, limit = 50): Promise<OutcomeRow[]> {
  const conds = [eq(hiringOutcomes.companyId, where.companyId)];
  if (where.applicationId) conds.push(eq(hiringOutcomes.applicationId, where.applicationId));
  if (where.roleId) conds.push(eq(hiringOutcomes.roleId, where.roleId));
  return q.select().from(hiringOutcomes).where(and(...conds)).orderBy(desc(hiringOutcomes.recordedAt)).limit(limit);
}
