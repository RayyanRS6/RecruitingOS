import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { availabilitySourceFor, emit, markCalendarHealthy, markCalendarNeedsAttention, notify, readConnectionSecret, zonedParts, type ParticipantConstraints, type TimeRange } from "@ros/core";
import { interviewParticipants, interviews, users, type Queryable } from "@ros/db";
import { CalendarError, type CalendarEventRef, type Integrations } from "@ros/integrations";

/**
 * The bridge between scheduling and calendars (slice 5 step 9). Runs in the worker: it is the only role allowed to read
 * a connection's credential, and every read states its purpose. A revoked credential never stops an interview from
 * being scheduled: the person's declared windows take over and they are told to reconnect.
 */
/** `optional`: the participant's role on the interview is "optional", so scheduling can go ahead without their availability. */
export type ParticipantInfo = { userId: string; email: string; name: string | null; firstName: string; optional?: boolean };

export async function participantsOf(q: Queryable, interviewId: string): Promise<ParticipantInfo[]> {
  const rows = await q.select({ userId: interviewParticipants.userId, email: users.email, name: users.name, role: interviewParticipants.role }).from(interviewParticipants).innerJoin(users, eq(users.id, interviewParticipants.userId)).where(eq(interviewParticipants.interviewId, interviewId));
  return rows.map(({ role, ...r }) => ({ ...r, firstName: (r.name ?? r.email).split(/[\s@]/)[0], optional: role === "optional" }));
}

/**
 * Whether a time clashes with an interview already booked for any of these people (their other interviews, not this
 * one). The quick check a pick makes before it is booked straight away (no calendar is read here; the booking step
 * re-checks calendars too). Two candidates can be offered the same free time by the same interviewer, so this is the
 * realistic collision.
 */
export async function clashesWithBookings(q: Queryable, input: { companyId: string; interviewId: string; userIds: string[]; slot: { startsAt: string; endsAt: string } }): Promise<boolean> {
  if (!input.userIds.length) return false;
  const rows = await q.select({ id: interviews.id, startsAt: interviews.startsAt, endsAt: interviews.endsAt }).from(interviews).innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id)).where(and(eq(interviews.companyId, input.companyId), inArray(interviewParticipants.userId, input.userIds), eq(interviews.status, "scheduled")));
  const start = Date.parse(input.slot.startsAt);
  const end = Date.parse(input.slot.endsAt);
  return rows.some((r) => r.id !== input.interviewId && !!r.startsAt && !!r.endsAt && Date.parse(r.startsAt) < end && Date.parse(r.endsAt) > start);
}

/**
 * Interviews already on this person's plate inside the range: busy time and a per-day count for the daily maximum. The
 * count is kept by the person's own local day (`timeZone`), the day the maximum is checked against
 * (core `freeRangesForDay`), so an evening interview never counts toward the next day's maximum.
 */
export async function bookedFor(q: Queryable, companyId: string, userId: string, range: TimeRange, exceptInterviewId: string, timeZone: string): Promise<{ busy: TimeRange[]; perDay: Record<string, number> }> {
  const rows = await q.select({ id: interviews.id, startsAt: interviews.startsAt, endsAt: interviews.endsAt }).from(interviews).innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id)).where(and(eq(interviews.companyId, companyId), eq(interviewParticipants.userId, userId), eq(interviews.status, "scheduled")));
  const busy: TimeRange[] = [];
  const perDay: Record<string, number> = {};
  for (const r of rows) {
    if (r.id === exceptInterviewId || !r.startsAt || !r.endsAt) continue;
    const start = new Date(r.startsAt).toISOString();
    const end = new Date(r.endsAt).toISOString();
    if (end <= range.start || start >= range.end) continue;
    busy.push({ start, end });
    const day = zonedParts(new Date(start), timeZone).dayKey;
    perDay[day] = (perDay[day] ?? 0) + 1;
  }
  return { busy, perDay };
}

export async function constraintsFor(
  q: Queryable,
  integrations: Integrations,
  input: { companyId: string; interviewId: string; participant: ParticipantInfo; range: TimeRange; companyTimezone: string; actor: Actor },
): Promise<ParticipantConstraints & { connectionId: string | null }> {
  const { source, connection, availability } = await availabilitySourceFor(q, input.companyId, input.participant.userId);
  const timezone = availability?.timezone ?? (connection?.config as { timeZone?: string } | undefined)?.timeZone ?? input.companyTimezone;
  const booked = await bookedFor(q, input.companyId, input.participant.userId, input.range, input.interviewId, timezone);
  const base = {
    userId: input.participant.userId,
    optional: !!input.participant.optional,
    timezone,
    windows: availability?.windows ?? [],
    bufferMinutes: availability?.bufferMinutes ?? 15,
    maxPerDay: availability?.maxPerDay ?? 3,
    bookedPerDay: booked.perDay,
    connectionId: connection?.id ?? null,
  };
  if (source === "calendar" && connection) {
    const provider = integrations.calendars[connection.provider];
    const cfg = connection.config as { calendarId?: string; timeZone?: string };
    try {
      const refreshToken = await readConnectionSecret(q, integrations.secrets, connection, { purpose: "calendar_sync", actor: input.actor });
      if (!provider || !refreshToken) throw new CalendarError("auth_revoked", "no credential", false);
      const fb = await provider.freeBusy({ refreshToken }, { calendarIds: [cfg.calendarId ?? "primary"], range: input.range });
      const busy = fb[cfg.calendarId ?? "primary"] ?? [];
      await markCalendarHealthy(q, connection, cfg.timeZone ?? null);
      // Declared windows constrain a connected calendar too (working hours); with none declared, weekdays 9 to 5 in the person's zone.
      return { ...base, source: "calendar", windows: base.windows.length ? base.windows : [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), busy: [...busy, ...booked.busy] };
    } catch (err) {
      if (err instanceof CalendarError && err.retryable) throw err; // the step retries with backoff
      const message = err instanceof Error ? err.message : String(err);
      await markCalendarNeedsAttention(q, connection, message, input.actor);
      await notify(q, { companyId: input.companyId, kind: "calendar.needs_attention", title: "Your calendar connection needs attention", body: `${message} Until it is reconnected, interviews use your declared availability.`, action: { label: "Fix it in Settings", href: "/setup" }, userIds: [input.participant.userId] });
      // fall through to declared windows
    }
  }
  if (base.windows.length) return { ...base, source: "declared", busy: booked.busy };
  return { ...base, source: "none", busy: booked.busy };
}

/** The idempotency key of an interviewer's event for one booking (an interview and its attempt). */
export function interviewEventKey(interviewId: string, attempt: number, userId: string): string {
  return `interview:${interviewId}:${attempt}:${userId}`;
}

/**
 * True when a stored event belongs to the interview's live booking: the interview is booked and the event was made for
 * its current attempt. Such an event is never removed by a removal queued for an earlier time (audit 06, bug 101).
 */
export function isLiveBookingEvent(iv: Pick<typeof interviews.$inferSelect, "id" | "status" | "attempt">, userId: string, ref: Pick<CalendarEventRef, "idempotencyKey">): boolean {
  return iv.status === "scheduled" && ref.idempotencyKey === interviewEventKey(iv.id, iv.attempt, userId);
}

/** Removes one stored event; a failure asks the person to remove it by hand and never blocks what called it. */
async function removeEvent(q: Queryable, integrations: Integrations, input: { companyId: string; interviewId: string; userId: string; ref: CalendarEventRef; actor: Actor }): Promise<string | null> {
  const { connection } = await availabilitySourceFor(q, input.companyId, input.userId);
  const provider = connection ? integrations.calendars[connection.provider] : null;
  try {
    if (!connection || !provider) throw new Error("calendar no longer connected");
    const refreshToken = await readConnectionSecret(q, integrations.secrets, connection, { purpose: "calendar_booking", actor: input.actor });
    if (!refreshToken) throw new Error("credential gone");
    await provider.cancelEvent({ refreshToken }, input.ref);
    await emit(q, { type: "calendar.event_cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "interview", id: input.interviewId }, payload: { userId: input.userId, provider: input.ref.provider, eventId: input.ref.eventId } });
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await notify(q, { companyId: input.companyId, kind: "calendar.cancel_failed", title: "Please remove a cancelled interview from your calendar", body: `We could not remove the event ourselves (${message}).`, action: { label: "Open interviews", href: "/interviews" }, userIds: [input.userId] });
    return message;
  }
}

/**
 * One calendar event per connected interviewer, keyed so a retry finds the event instead of creating a second one.
 * The candidate is never an attendee on these events: they get one invitation, our own calendar file with the
 * confirmation email (one UID per interview, with the meeting link), never one more Google invitation per interviewer
 * (audit 06, bug 92). The link the first event creates goes on the others as their location. Events left from an
 * earlier time of this interview (a reschedule whose removal has not run yet) are removed first, so the stored events
 * are only this booking's.
 */
export async function createInterviewEvents(
  q: Queryable,
  integrations: Integrations,
  input: { interview: typeof interviews.$inferSelect; participants: ParticipantInfo[]; candidate: { firstName: string; lastName: string; email: string | null }; roleTitle: string; companyName: string; companyTimezone: string; actor: Actor; appBaseUrl: string },
): Promise<{ refs: Record<string, CalendarEventRef>; meetingUrl: string | null; failures: Array<{ userId: string; error: string }> }> {
  const refs: Record<string, CalendarEventRef> = {};
  for (const [userId, ref] of Object.entries((input.interview.calendarRefs ?? {}) as Record<string, CalendarEventRef>)) {
    if (ref.idempotencyKey === interviewEventKey(input.interview.id, input.interview.attempt, userId)) refs[userId] = ref; // this booking's own, from a retry
    else await removeEvent(q, integrations, { companyId: input.interview.companyId, interviewId: input.interview.id, userId, ref, actor: input.actor });
  }
  const failures: Array<{ userId: string; error: string }> = [];
  let meetingUrl: string | null = input.interview.linkSource === "pasted" ? input.interview.meetingUrl : null;
  for (const ref of Object.values(refs)) if (!meetingUrl && ref.meetingUrl) meetingUrl = ref.meetingUrl;
  for (const p of input.participants) {
    const { source, connection } = await availabilitySourceFor(q, input.interview.companyId, p.userId);
    if (source !== "calendar" || !connection) continue;
    const provider = integrations.calendars[connection.provider];
    const cfg = connection.config as { calendarId?: string };
    try {
      const refreshToken = await readConnectionSecret(q, integrations.secrets, connection, { purpose: "calendar_booking", actor: input.actor });
      if (!provider || !refreshToken) throw new CalendarError("auth_revoked", "no credential", false);
      const ref = await provider.createEvent({ refreshToken }, cfg.calendarId ?? "primary", {
        idempotencyKey: interviewEventKey(input.interview.id, input.interview.attempt, p.userId),
        title: `Interview: ${input.candidate.firstName} ${input.candidate.lastName} for ${input.roleTitle}`,
        description: `${input.interview.title} (${input.interview.durationMinutes} min). Prepared by Recruiting OS for ${input.companyName}. ${input.appBaseUrl}/interviews/${input.interview.id}`,
        start: new Date(input.interview.startsAt!).toISOString(), end: new Date(input.interview.endsAt!).toISOString(), timeZone: input.companyTimezone,
        attendees: [{ email: p.email, name: p.name }],
        conference: input.interview.linkSource === "calendar" && !meetingUrl ? "auto" : null,
        location: meetingUrl,
      });
      refs[p.userId] = ref;
      if (!meetingUrl && ref.meetingUrl) meetingUrl = ref.meetingUrl;
      await emit(q, { type: "calendar.event_created", companyId: input.interview.companyId, actor: input.actor, subject: { type: "interview", id: input.interview.id }, payload: { userId: p.userId, provider: ref.provider, eventId: ref.eventId } });
    } catch (err) {
      if (err instanceof CalendarError && err.retryable) throw err;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ userId: p.userId, error: message });
      await markCalendarNeedsAttention(q, connection, message, input.actor);
      await notify(q, { companyId: input.interview.companyId, kind: "calendar.needs_attention", title: "We could not add the interview to your calendar", body: `${message} The interview is confirmed; add it by hand and reconnect your calendar in Settings.`, action: { label: "Open Settings", href: "/setup" }, userIds: [p.userId] });
    }
  }
  return { refs, meetingUrl, failures };
}

/**
 * Cancels the calendar events of an interview's earlier time (a cancellation or a reschedule queued this job);
 * idempotent; a failure never blocks the cancellation itself. Read under the interview's row lock when the job runs:
 * if the interview was booked again meanwhile (a backed-up worker, a candidate who rebooked first), the new booking's
 * events are kept, never removed (audit 06, bug 101).
 */
export async function cancelInterviewEvents(q: Queryable, integrations: Integrations, input: { interviewId: string; actor: Actor }): Promise<{ cancelled: number; failures: Array<{ userId: string; error: string }> }> {
  const [iv] = await q.select().from(interviews).where(eq(interviews.id, input.interviewId)).limit(1).for("update");
  if (!iv) return { cancelled: 0, failures: [] };
  const refs = (iv.calendarRefs ?? {}) as Record<string, CalendarEventRef>;
  const userIds = Object.keys(refs);
  if (!userIds.length) return { cancelled: 0, failures: [] };
  const conns = await q.select().from(interviewParticipants).where(and(eq(interviewParticipants.interviewId, iv.id), inArray(interviewParticipants.userId, userIds)));
  let cancelled = 0;
  const failures: Array<{ userId: string; error: string }> = [];
  const remaining: Record<string, CalendarEventRef> = {};
  for (const p of conns) {
    const ref = refs[p.userId];
    if (isLiveBookingEvent(iv, p.userId, ref)) { remaining[p.userId] = ref; continue; }
    const error = await removeEvent(q, integrations, { companyId: iv.companyId, interviewId: iv.id, userId: p.userId, ref, actor: input.actor });
    if (error === null) cancelled++;
    else { failures.push({ userId: p.userId, error }); remaining[p.userId] = ref; }
  }
  await q.update(interviews).set({ calendarRefs: remaining }).where(eq(interviews.id, iv.id));
  return { cancelled, failures };
}
