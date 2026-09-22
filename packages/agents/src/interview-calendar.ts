import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { availabilitySourceFor, emit, markCalendarHealthy, markCalendarNeedsAttention, notify, readConnectionSecret, type ParticipantConstraints, type TimeRange } from "@ros/core";
import { interviewParticipants, interviews, users, type Queryable, type integrations as integrationsTable } from "@ros/db";
import { CalendarError, type CalendarEventRef, type Integrations } from "@ros/integrations";

type ConnectionRow = typeof integrationsTable.$inferSelect;

/**
 * The bridge between scheduling and calendars (slice 5 step 9). Runs in the worker: it is the only role allowed to read
 * a connection's credential, and every read states its purpose. A revoked credential never stops an interview from
 * being scheduled: the person's declared windows take over and they are told to reconnect.
 */
export type ParticipantInfo = { userId: string; email: string; name: string | null; firstName: string };

export async function participantsOf(q: Queryable, interviewId: string): Promise<ParticipantInfo[]> {
  const rows = await q.select({ userId: interviewParticipants.userId, email: users.email, name: users.name }).from(interviewParticipants).innerJoin(users, eq(users.id, interviewParticipants.userId)).where(eq(interviewParticipants.interviewId, interviewId));
  return rows.map((r) => ({ ...r, firstName: (r.name ?? r.email).split(/[\s@]/)[0] }));
}

/** Interviews already on this person's plate inside the range: busy time and a per-day count for the daily maximum. */
async function bookedFor(q: Queryable, companyId: string, userId: string, range: TimeRange, exceptInterviewId: string): Promise<{ busy: TimeRange[]; perDay: Record<string, number> }> {
  const rows = await q.select({ id: interviews.id, startsAt: interviews.startsAt, endsAt: interviews.endsAt, timezone: interviews.timezone }).from(interviews).innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id)).where(and(eq(interviews.companyId, companyId), eq(interviewParticipants.userId, userId), eq(interviews.status, "scheduled")));
  const busy: TimeRange[] = [];
  const perDay: Record<string, number> = {};
  for (const r of rows) {
    if (r.id === exceptInterviewId || !r.startsAt || !r.endsAt) continue;
    const start = new Date(r.startsAt).toISOString();
    const end = new Date(r.endsAt).toISOString();
    if (end <= range.start || start >= range.end) continue;
    busy.push({ start, end });
    const day = start.slice(0, 10);
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
  const booked = await bookedFor(q, input.companyId, input.participant.userId, input.range, input.interviewId);
  const base = {
    userId: input.participant.userId,
    timezone: availability?.timezone ?? (connection?.config as { timeZone?: string } | undefined)?.timeZone ?? input.companyTimezone,
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
      await notify(q, { companyId: input.companyId, kind: "calendar.needs_attention", title: "Your calendar connection needs attention", body: `${message} Until it is reconnected, interviews use your declared availability.`, action: { label: "Fix it in Setup", href: "/setup" }, userIds: [input.participant.userId] });
      // fall through to declared windows
    }
  }
  if (base.windows.length) return { ...base, source: "declared", busy: booked.busy };
  return { ...base, source: "none", busy: booked.busy };
}

/** One calendar event per connected participant, keyed so a retry finds the event instead of creating a second one. */
export async function createInterviewEvents(
  q: Queryable,
  integrations: Integrations,
  input: { interview: typeof interviews.$inferSelect; participants: ParticipantInfo[]; candidate: { firstName: string; lastName: string; email: string | null }; roleTitle: string; companyName: string; companyTimezone: string; actor: Actor; appBaseUrl: string },
): Promise<{ refs: Record<string, CalendarEventRef>; meetingUrl: string | null; failures: Array<{ userId: string; error: string }> }> {
  const refs: Record<string, CalendarEventRef> = { ...((input.interview.calendarRefs ?? {}) as Record<string, CalendarEventRef>) };
  const failures: Array<{ userId: string; error: string }> = [];
  let meetingUrl: string | null = input.interview.linkSource === "pasted" ? input.interview.meetingUrl : null;
  for (const p of input.participants) {
    const { source, connection } = await availabilitySourceFor(q, input.interview.companyId, p.userId);
    if (source !== "calendar" || !connection) continue;
    const provider = integrations.calendars[connection.provider];
    const cfg = connection.config as { calendarId?: string };
    try {
      const refreshToken = await readConnectionSecret(q, integrations.secrets, connection, { purpose: "calendar_booking", actor: input.actor });
      if (!provider || !refreshToken) throw new CalendarError("auth_revoked", "no credential", false);
      const ref = await provider.createEvent({ refreshToken }, cfg.calendarId ?? "primary", {
        idempotencyKey: `interview:${input.interview.id}:${input.interview.attempt}:${p.userId}`,
        title: `Interview: ${input.candidate.firstName} ${input.candidate.lastName} for ${input.roleTitle}`,
        description: `${input.interview.title} (${input.interview.durationMinutes} min). Prepared by Recruiting OS for ${input.companyName}. ${input.appBaseUrl}/interviews/${input.interview.id}`,
        start: new Date(input.interview.startsAt!).toISOString(), end: new Date(input.interview.endsAt!).toISOString(), timeZone: input.companyTimezone,
        attendees: [{ email: p.email, name: p.name }, ...(input.candidate.email ? [{ email: input.candidate.email, name: `${input.candidate.firstName} ${input.candidate.lastName}` }] : [])],
        conference: input.interview.linkSource === "calendar" && !meetingUrl ? "auto" : null,
      });
      refs[p.userId] = ref;
      if (!meetingUrl && ref.meetingUrl) meetingUrl = ref.meetingUrl;
      await emit(q, { type: "calendar.event_created", companyId: input.interview.companyId, actor: input.actor, subject: { type: "interview", id: input.interview.id }, payload: { userId: p.userId, provider: ref.provider, eventId: ref.eventId } });
    } catch (err) {
      if (err instanceof CalendarError && err.retryable) throw err;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ userId: p.userId, error: message });
      await markCalendarNeedsAttention(q, connection, message, input.actor);
      await notify(q, { companyId: input.interview.companyId, kind: "calendar.needs_attention", title: "We could not add the interview to your calendar", body: `${message} The interview is confirmed; add it by hand and reconnect your calendar in Setup.`, action: { label: "Open Setup", href: "/setup" }, userIds: [p.userId] });
    }
  }
  return { refs, meetingUrl, failures };
}

/** Cancels every calendar event of an interview; idempotent; a failure never blocks the cancellation itself. */
export async function cancelInterviewEvents(q: Queryable, integrations: Integrations, input: { interviewId: string; actor: Actor }): Promise<{ cancelled: number; failures: Array<{ userId: string; error: string }> }> {
  const [iv] = await q.select().from(interviews).where(eq(interviews.id, input.interviewId)).limit(1);
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
    const { connection } = await availabilitySourceFor(q, iv.companyId, p.userId);
    const provider = connection ? integrations.calendars[connection.provider] : null;
    try {
      if (!connection || !provider) throw new Error("calendar no longer connected");
      const refreshToken = await readConnectionSecret(q, integrations.secrets, connection, { purpose: "calendar_booking", actor: input.actor });
      if (!refreshToken) throw new Error("credential gone");
      await provider.cancelEvent({ refreshToken }, ref);
      cancelled++;
      await emit(q, { type: "calendar.event_cancelled", companyId: iv.companyId, actor: input.actor, subject: { type: "interview", id: iv.id }, payload: { userId: p.userId, provider: ref.provider, eventId: ref.eventId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ userId: p.userId, error: message });
      remaining[p.userId] = ref;
      await notify(q, { companyId: iv.companyId, kind: "calendar.cancel_failed", title: "Please remove a cancelled interview from your calendar", body: `We could not remove the event ourselves (${message}).`, action: { label: "Open interviews", href: "/interviews" }, userIds: [p.userId] });
    }
  }
  await q.update(interviews).set({ calendarRefs: remaining }).where(eq(interviews.id, iv.id));
  return { cancelled, failures };
}

export async function connectionsForUsers(q: Queryable, companyId: string, userIds: string[]): Promise<Record<string, ConnectionRow | null>> {
  const out: Record<string, ConnectionRow | null> = {};
  for (const id of userIds) out[id] = (await availabilitySourceFor(q, companyId, id)).connection;
  return out;
}
