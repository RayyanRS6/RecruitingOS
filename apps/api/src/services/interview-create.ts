import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NO_WORK_WHILE_LOCKED, type Actor, type CandidateNotice, type InterviewPlace, type MembershipRole, type OfferedSlot, type SetInterviewTime } from "@ros/contracts";
import { CANCEL_STAGES, STAGE_LABEL, audit, defaultSchedulingWindow, emit, endMarkOnMove, followUpParked, notify, openFollowUpOf, personSetSlot, setAutoState, setCurrentInterview, transition } from "@ros/core";
import { clashingInterviewers, companyConfirmed, type InvitationNote } from "@ros/agents";
import { applications, approvalRequests, candidates, communications, companies, interviewParticipants, interviews, memberships, randomToken, rolePackets, roles, type Tx } from "@ros/db";
import { cancelNewTimesRuns, type NewTimesOfferKind, type NewTimesVia } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { suggestionRunOf } from "./messages";

/** The steps from which a person may set up an interview round: set its date and time, or let the candidate pick. */
export const INTERVIEW_FROM: readonly string[] = ["triaged", "screen_complete", "interview_recommended", "interview_complete", "eligible", "screen_invited", "screening"];
/** Interviews with times being worked out, offered or booked: an application has one at a time. */
export const OPEN_INTERVIEW: string[] = ["proposed", "scheduling", "scheduled"];
export const INTERVIEW_ALREADY_OPEN = "This candidate already has an interview set up. Open it to move or cancel it.";
/** Nobody can pick from times nobody has hours for: what stops a send or a re-offer that would only wait for ever. */
export const NO_HOURS = "Not everyone on this interview has hours to offer. Set a date and time instead.";
/** Where the run of a time a person set begins: the route already booked it, so nothing is worked out or offered. */
export const BOOKED_RUN_STARTS_AT = "place_on_calendars";

/**
 * What the place a person chose writes on the interview. A link left empty asks a live calendar to make one
 * (`linkSource: "calendar"`); anything else is the person's own, so no calendar makes a video link for a phone call or a
 * visit. An address keeps a round that is a working session; otherwise it is on site.
 */
export function placeOnInterview(place: InterviewPlace, roundFormat: string): { format: string; linkSource: "calendar" | "pasted"; meetingUrl: string | null; address: string | null } {
  if (place.kind === "link") return { format: "video", linkSource: place.url ? "pasted" : "calendar", meetingUrl: place.url ?? null, address: null };
  if (place.kind === "phone") return { format: "phone", linkSource: "pasted", meetingUrl: null, address: null };
  return { format: roundFormat === "working_session" ? "working_session" : "onsite", linkSource: "pasted", meetingUrl: null, address: place.text };
}

/** The slot a person's date and time make, on the company's clock, or the refusal in plain words. */
export function slotFromPerson(setTime: SetInterviewTime, input: { companyTimezone: string; interviewerUserIds: string[]; address: string | null; now: Date }): OfferedSlot {
  const made = personSetSlot({ date: setTime.date, time: setTime.time, durationMinutes: setTime.durationMinutes, companyTimezone: input.companyTimezone, interviewerUserIds: input.interviewerUserIds, address: input.address, now: input.now });
  if (made.ok) return made.slot;
  if (made.code === "time_passed") throw new HttpError(400, "time_passed", "That time has passed. Choose a later one.");
  throw new HttpError(400, "no_such_time", "That time does not exist on that day: the clocks change. Choose another.");
}

/**
 * An interviewer already booked for another interview at that time is named (409 `interviewer_busy`, with `details.names`),
 * and "Book anyway" (`allowClash`) goes ahead. Booked interviews only, no buffer: no calendar is read here. Answers who
 * clashed, for the record on the event.
 */
export async function refuseClash(tx: Tx, input: { companyId: string; interviewId?: string | null; userIds: string[]; slot: OfferedSlot; allowClash?: boolean }): Promise<string[]> {
  const names = (await clashingInterviewers(tx, { companyId: input.companyId, interviewId: input.interviewId, userIds: input.userIds, slot: input.slot })).map((p) => p.firstName);
  if (names.length && !input.allowClash) throw new HttpError(409, "interviewer_busy", names.length === 1 ? `${names[0]} already has an interview at that time.` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} already have an interview at that time.`, { names });
  return names;
}

/** No interview can be booked for a closed or filled job: its run would end silently, with no email and nothing to press. */
export function refuseClosedRole(status: string | null | undefined): void {
  if (status === "closed" || status === "filled") throw new HttpError(409, "role_closed", "This job is closed, so no interview can be booked for it.");
}

/**
 * The link's life for a time a person set: it opens their confirmed page and their status page, and lasts until a day
 * after the interview ends. Old links keep working when the time moves.
 */
const tokenExpiry = (endsAt: string) => new Date(Date.parse(endsAt) + 86_400_000).toISOString();

/** The fields a booking a person made writes on the interview, new or in motion. */
export function bookingFields(slot: OfferedSlot, place: ReturnType<typeof placeOnInterview>, input: { durationMinutes: number; companyTimezone: string; token?: string | null }) {
  return { status: "scheduled", startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: input.companyTimezone, durationMinutes: input.durationMinutes, format: place.format, linkSource: place.linkSource, meetingUrl: place.meetingUrl, selectedSlot: slot, offeredSlots: [], scheduleToken: input.token ?? randomToken(24), scheduleTokenExpiresAt: tokenExpiry(slot.endsAt) };
}

/**
 * What the screen says the moment a person booked: the email is on its way, it waits for ITS to confirm the company, or
 * there is no address to send it to. Never that it left: the worker sends it after this commits.
 */
export async function candidateNoticeOfBooking(tx: Tx, input: { companyId: string; hasEmail: boolean }): Promise<CandidateNotice> {
  if (!input.hasEmail) return "not_sent_no_email";
  return (await companyConfirmed(tx, input.companyId)) ? "queued" : "held";
}

/**
 * What became of the candidate's email about an interview, for the Interviews page, its sheet and the panel: `held` until
 * ITS confirms the company, `failed` when it could not be delivered, `no_email` when there is no address to send it to,
 * null when nothing needs saying. Read off the current attempt's own email: a booked time's confirmation, or the times
 * offered to pick from (still offered, or lapsed), so a screen never says "Waiting on the candidate" when nothing reached
 * them. `hasEmail` on an interview (a list of several people) wins over the one given for all of them.
 */
export type CandidateEmailState = "held" | "failed" | "no_email" | null;
const NOT_DELIVERED = new Set(["failed", "bounced", "unknown"]);
type EmailFacts = { id: string; attempt: number; status: string; offeredSlots?: readonly unknown[] | null; hasEmail?: boolean };
/** The key of the email that tells them of this interview as it stands, or null when none is due. */
function tellingKey(i: EmailFacts): string | null {
  if (i.status === "scheduled") return `confirm:${i.id}:${i.attempt}`;
  if ((i.status === "scheduling" && (i.offeredSlots?.length ?? 0) > 0) || i.status === "offer_expired") return `slots:${i.id}:${i.attempt}`;
  return null;
}
export async function candidateEmailStates(tx: Tx, input: { interviews: ReadonlyArray<EmailFacts>; hasEmail?: boolean }): Promise<Map<string, CandidateEmailState>> {
  const out = new Map<string, CandidateEmailState>(input.interviews.map((i) => [i.id, null]));
  const due = input.interviews.flatMap((i) => { const key = tellingKey(i); return key ? [{ i, key }] : []; });
  const reachable = due.filter(({ i }) => i.hasEmail ?? input.hasEmail ?? true);
  for (const { i } of due) if (!(i.hasEmail ?? input.hasEmail ?? true)) out.set(i.id, "no_email");
  if (!reachable.length) return out;
  const rows = await tx.select({ key: communications.idempotencyKey, status: communications.status }).from(communications).where(inArray(communications.idempotencyKey, reachable.map((x) => x.key)));
  const statusOf = new Map(rows.map((r) => [r.key, r.status]));
  for (const { i, key } of reachable) {
    const status = statusOf.get(key);
    out.set(i.id, status === "held" ? "held" : status && NOT_DELIVERED.has(status) ? "failed" : null);
  }
  return out;
}

export type ApproveInterviewInput = {
  companyId: string;
  applicationId: string;
  roundKey: string;
  interviewerUserIds: string[];
  linkSource: "calendar" | "pasted";
  meetingUrl?: string | null;
  window?: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean } | null;
  note?: string | null;
  /** A personal line for the invitation (Q28), already checked; `suggestionRunId` says whether the assistant suggested it. */
  invitationNote?: InvitationNote | null;
  suggestionRunId?: string | null;
  actor: Actor;
  /** The approver's role on the team and their user id (the approval is theirs). */
  by: MembershipRole;
  approvedBy: string;
  now: Date;
  /** The caller already holds the application's lock, then the follow-up's (`sendNewTimes`). */
  locked?: boolean;
  /** For someone under Cancelled: a person's approval or send ("person"), or the team's send to several people ("batch"). */
  via?: Exclude<NewTimesVia, "auto">;
  /** The person set the date and time: it is booked in this transaction, with no calendar or declared hours behind it. */
  setTime?: SetInterviewTime | null;
};

/**
 * A person sets up an interview round (policy `interview.request`, approval level, AC10.1: the click is the approval).
 * The interview is written with its interviewers; a pending recommendation is resolved by it; the candidate moves to
 * "Interview to set up" (or, already at the interview step, their private mark ends, founder decision B3); and
 * `schedule_interview` starts. The same for "Set a date and time" (`setTime`, below), for "Or let them pick from your free
 * times" (no `setTime`: the interviewers are told at once, and times are worked out for the candidate to pick), and for the
 * team's "Send new times" to someone who did not come (the Cancelled column, founder decision 4A).
 *
 * The application is locked first, then its open follow-up, the order the automatic set of new times and a person's
 * "Send new times" take them, so an automatic send and an approval at the same moment never both open an interview. For
 * someone under Cancelled the new interview carries their new times: the no-show it replaces is marked decided ("new
 * times"), the times email opens with the new-times wording instead of "Good news", the follow-up points at it, and an
 * automatic set still waiting for its day does not go (`team_acted`). They stay under Cancelled until they book.
 *
 * `setTime` (the owner's words, 6 November 2026: "nadine sets date and time"): the press is the approval and the booking.
 * This transaction writes it as scheduled, because the worker may not run for a while and the sheet must be right at once;
 * the run then puts it on calendars, emails the candidate, reminds and closes. Someone under Cancelled is taken out here
 * as rebooked. **The order matters:** the Cancelled block first, then the move to `interview_scheduled`, because that move
 * resolves the open follow-up and ends a pending set itself, and the block's `setAutoState` would then throw `illegal_move`.
 */
export async function createApprovedInterview(tx: Tx, container: Container, input: ApproveInterviewInput): Promise<{ interviewId: string; followUpId: string | null; candidateNotice?: CandidateNotice }> {
  const { companyId, actor, now } = input;
  const read = tx.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.companyId, companyId))).limit(1);
  const [app] = input.locked ? await read : await read.for("update");
  if (!app) throw new HttpError(404, "not_found", "Application not found.");
  // Under a grant naming someone locked too: the interviewers would get their name by email and calendar, and could not open them.
  if (app.lockedAt) throw new HttpError(409, "not_while_locked", NO_WORK_WHILE_LOCKED);
  // Two people pressing at once take turns on the lock above: the second finds the first one's booking, and is told that.
  if (app.stage === "interview_scheduled") throw new HttpError(409, "interview_open", INTERVIEW_ALREADY_OPEN);
  if (!INTERVIEW_FROM.includes(app.stage)) throw new HttpError(409, "interview_not_schedulable", `A candidate at "${STAGE_LABEL[app.stage]}" cannot be moved to an interview from here.`);
  // A line that came from the assistant's suggestion says so even if it was changed or the page left the flag out (Q28).
  let invitationNote = input.invitationNote ?? null;
  if (invitationNote && !invitationNote.aiHelped && (await suggestionRunOf(tx, input.suggestionRunId))) invitationNote = { ...invitationNote, aiHelped: true };
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  const round = pv?.packet.interviews.plan.find((r) => r.key === input.roundKey);
  if (!round) throw new HttpError(400, "round_unknown", "That round is not in the approved interview plan.");
  const members = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active"), inArray(memberships.userId, input.interviewerUserIds)));
  if (members.length !== input.interviewerUserIds.length) throw new HttpError(400, "interviewer_unknown", "Every interviewer must be an active member of the company.");
  const followUp = await openFollowUpOf(tx, app.id, { lock: true });
  const open = await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, OPEN_INTERVIEW)));
  if (open.length) throw new HttpError(409, "interview_open", INTERVIEW_ALREADY_OPEN);
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [role] = await tx.select({ title: roles.title, status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  refuseClosedRole(role?.status);
  const window = { ...defaultSchedulingWindow(now, company.timezone), ...(input.window ?? {}) };
  if (!input.setTime && input.linkSource === "pasted" && !input.meetingUrl) throw new HttpError(400, "meeting_url_required", "Paste the meeting link, or let the calendar create one.");
  // A date and time a person set: refused here if it has passed or does not exist, or if an interviewer is booked then.
  const place = input.setTime ? placeOnInterview(input.setTime.place, round.format) : null;
  const slot = input.setTime && place ? slotFromPerson(input.setTime, { companyTimezone: company.timezone, interviewerUserIds: input.interviewerUserIds, address: place.address, now }) : null;
  const clashes = input.setTime && slot ? await refuseClash(tx, { companyId, userIds: input.interviewerUserIds, slot, allowClash: input.setTime.allowClash }) : [];
  const booking = input.setTime && slot && place ? bookingFields(slot, place, { durationMinutes: input.setTime.durationMinutes, companyTimezone: company.timezone }) : null;
  const [iv] = await tx.insert(interviews).values({ companyId, applicationId: app.id, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status: "proposed", linkSource: input.linkSource, meetingUrl: input.linkSource === "pasted" ? input.meetingUrl ?? null : null, schedulingWindow: window, createdBy: actor, timezone: company.timezone, ...(booking ?? {}) }).returning();
  for (const uid of input.interviewerUserIds) await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: uid, role: "interviewer", status: booking ? "confirmed" : "invited" });
  const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName, email: candidates.email }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  // Each interviewer is told the moment they are put on the interview ("invited"); the booking confirms them later. A time
  // a person set is already booked: its confirmation tells them, with the brief.
  if (!booking) await notify(tx, { companyId, about: app.id, kind: "interview.assigned", title: `You are interviewing ${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim(), body: `${round.title} for ${role?.title ?? "a role"}, ${round.durationMinutes} minutes. Times are offered to the candidate from your calendar or declared hours; you will be told as soon as one is booked.`, action: { label: "Open the interview", href: `/interviews/${iv.id}` }, userIds: input.interviewerUserIds });
  // The human's click is the approval (policy interview.request, approval level, AC10.1). Any pending recommendation is resolved by it.
  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.recommend_interview"), eq(approvalRequests.status, "pending")));
  for (const p of pending) await tx.update(approvalRequests).set({ status: "approved", decidedBy: input.approvedBy, decidedAt: now.toISOString(), decisionNote: input.note ?? "interview requested" }).where(eq(approvalRequests.id, p.id));
  // The reason is what History shows beside the move: a time a person set says so, in the words its next move uses too.
  if (app.stage !== "interview_recommended" && app.stage !== "interview_complete") await transition(tx, { applicationId: app.id, companyId, to: "interview_recommended", by: input.by, actor, reason: input.note ?? (input.setTime ? "a person set the date and time" : "interview approved") });
  // Already at the interview step there is no move, but a person approving an interview still moves them on: a hold
  // (or any other private mark) ends here, as it would with the move (founder decision B3).
  else await endMarkOnMove(tx, { applicationId: app.id, companyId, actor, to: app.stage });
  // The fact says whether the invitation carries a personal line and whether the assistant helped; the words are in the invitation itself.
  await emit(tx, { type: "interview.requested", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { applicationId: app.id, roundKey: round.key, interviewers: input.interviewerUserIds, linkSource: iv.linkSource, window, approvedBy: input.approvedBy, invitationLine: invitationNote ? { aiHelped: invitationNote.aiHelped, suggestionRunId: input.suggestionRunId ?? null } : null } });
  await emit(tx, { type: "human.override", companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.request", roundKey: round.key, note: input.note ?? null } });

  // Someone under Cancelled (founder decisions 1A to 4A): this interview carries their new times.
  const carries = followUp && CANCEL_STAGES.includes(app.stage) ? followUp : null;
  let newTimes: { offerKind: NewTimesOfferKind; followUpId: string; via: NewTimesVia } | null = null;
  if (carries) {
    // The interview they did not come to is decided: new times went. The decision card and the report stop asking about
    // it; it stays a no-show on record.
    const [missed] = await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), eq(interviews.status, "no_show"), eq(interviews.outcome, "no_show_candidate"), isNull(interviews.decision))).orderBy(desc(interviews.createdAt)).limit(1);
    if (missed) await tx.update(interviews).set({ decision: "new_times", decisionNote: "New times sent after the candidate did not attend" }).where(eq(interviews.id, missed.id));
    newTimes = { offerKind: carries.choice === "new_times" ? "new_times_asked" : "new_times_team", followUpId: carries.id, via: input.via ?? "person" };
    await setCurrentInterview(tx, { followUpId: carries.id, interviewId: iv.id });
    // A person took it from here: the automatic set waiting for its day does not go.
    if (followUpParked(carries)) {
      await setAutoState(tx, { followUpId: carries.id, to: "not_sent", reason: "team_acted", actor, now });
      await cancelNewTimesRuns(tx, container.engine, { companyId, applicationId: app.id, actor, reason: "a person approved an interview" });
    }
  }
  const firstRun = { interviewId: iv.id, applicationId: app.id, roleId: app.roleId, roundKey: round.key, attempt: 1, ...(invitationNote ? { invitationNote } : {}) };
  if (!booking || !slot) {
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId, subject: { type: "interview", id: iv.id }, state: { ...firstRun, ...(newTimes ?? {}) }, idempotencyKey: `schedule:${iv.id}:1`, actor });
    return { interviewId: iv.id, followUpId: carries?.id ?? null };
  }
  await transition(tx, { applicationId: app.id, companyId, to: "interview_scheduled", by: input.by, actor, reason: "a person set the date and time", now });
  await emit(tx, { type: "interview.booked", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { setByPerson: true, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, attempt: 1, clashAllowed: clashes.length > 0 } });
  await audit(tx, { companyId, actor, action: "interview.booked_on_behalf", target: { type: "interview", id: iv.id }, reason: "a person set the date and time", details: { applicationId: app.id, slotId: slot.id, startsAt: slot.startsAt } });
  await container.engine.start(tx, { workflowKey: "schedule_interview", companyId, subject: { type: "interview", id: iv.id }, state: { ...firstRun, setByPerson: true, bookedAt: now.toISOString(), ...(newTimes ? { offerKind: newTimes.offerKind } : {}) }, idempotencyKey: `schedule:${iv.id}:1`, actor, startStep: BOOKED_RUN_STARTS_AT });
  return { interviewId: iv.id, followUpId: carries?.id ?? null, candidateNotice: await candidateNoticeOfBooking(tx, { companyId, hasEmail: !!cand?.email }) };
}
