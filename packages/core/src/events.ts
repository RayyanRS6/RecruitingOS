import type { Actor, DomainEvent, EventType, Subject } from "@ros/contracts";
import { DomainEvent as DomainEventSchema } from "@ros/contracts";
import { events, type Queryable } from "@ros/db";
import { guardOutbound } from "./secrets";

export const SYSTEM_ACTOR: Actor = { kind: "system", id: "system" };

type EventSink = (event: DomainEvent & { id: number }) => void;
let sink: EventSink | null = null;
/** Registers a fire-and-forget observer for every emitted event (the container forwards funnel events to analytics). */
export function setEventSink(fn: EventSink | null): void {
  sink = fn;
}

export type EmitInput = {
  type: EventType;
  companyId: string | null;
  actor: Actor;
  subject: Subject;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
};

/** Appends a fact to the event log. Events are never updated or deleted. */
export async function emit(q: Queryable, input: EmitInput): Promise<{ id: number; event: DomainEvent }> {
  const event = DomainEventSchema.parse({
    type: input.type,
    companyId: input.companyId,
    actor: input.actor,
    subject: input.subject,
    // Correction 10: an event payload never carries a credential.
    payload: guardOutbound(input.payload ?? {}, `event ${input.type}`),
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
  });
  const [row] = await q
    .insert(events)
    .values({
      companyId: event.companyId,
      type: event.type,
      actor: event.actor,
      subjectType: event.subject.type,
      subjectId: event.subject.id,
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      payload: event.payload,
    })
    .returning({ id: events.id });
  if (sink) {
    try {
      sink({ ...event, id: row.id });
    } catch {
      /* an observer never affects the write */
    }
  }
  return { id: row.id, event };
}
