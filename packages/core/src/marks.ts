import { and, eq, inArray, isNull } from "drizzle-orm";
import { MARK_LABEL, type ActiveMark, type Actor, type ApplicationStage, type MarkKind, type MarkSource } from "@ros/contracts";
import { applicationMarks, type Queryable } from "@ros/db";
import { emit } from "./events";
import { markBlockedReason } from "./stages";

/**
 * Private marks on an application (founder decision B3, plan A4): Longlist, Shortlist, On hold, Not a fit for now. A
 * person's sorting, never a stage change and never told to the candidate. One mark is active at a time: a new one
 * replaces the old, and the old row stays, cleared, so the history says who sorted whom and when. Leaving the process
 * clears every mark (`transition` in stages.ts). A hold always ends on a date, when the person comes back to Today.
 */
export const HOLD_DEFAULT_DAYS = 14;
export const HOLD_MAX_DAYS = 56;
const DAY_MS = 86_400_000;

export class MarkError extends Error {
  constructor(public readonly code: "not_allowed" | "no_mark" | "bad_date" | "conflict", message: string) {
    super(message);
  }
}

/** A Postgres unique violation (23505), whether the driver hands it back as it is or wrapped by the query builder. */
function uniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === "object" && "code" in x ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

type MarkRow = typeof applicationMarks.$inferSelect;

/** Times in ISO form whatever the driver hands back, so every page reads them the same way. */
const iso = (value: string) => new Date(value).toISOString();

export function toActiveMark(row: MarkRow): ActiveMark {
  return { id: row.id, mark: row.mark, label: MARK_LABEL[row.mark], remindAt: row.remindAt ? iso(row.remindAt) : null, note: row.note, source: row.source, setAt: iso(row.createdAt), setBy: { kind: row.setBy.kind, id: row.setBy.id, ...(row.setBy.name ? { name: row.setBy.name } : {}) } };
}

/**
 * When a hold ends: the date the person chose, or 14 days from now. A bare date ("2026-10-22") means that day, in the
 * morning across the United States (15:00 UTC). It must be after now and at most 56 days away.
 */
export function holdUntil(input: string | null | undefined, now: Date): string {
  if (!input) return new Date(now.getTime() + HOLD_DEFAULT_DAYS * DAY_MS).toISOString();
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T15:00:00Z` : input);
  if (Number.isNaN(at)) throw new MarkError("bad_date", "Use a date like 2026-10-22.");
  if (at <= now.getTime()) throw new MarkError("bad_date", "Choose a date after today for the hold to end.");
  if (at > now.getTime() + HOLD_MAX_DAYS * DAY_MS) throw new MarkError("bad_date", `A hold lasts ${HOLD_MAX_DAYS / 7} weeks at most; choose an earlier date.`);
  return new Date(at).toISOString();
}

/** The active mark of each application, in one query. */
export async function activeMarksFor(q: Queryable, applicationIds: string[]): Promise<Map<string, ActiveMark>> {
  const out = new Map<string, ActiveMark>();
  if (!applicationIds.length) return out;
  const rows = await q.select().from(applicationMarks).where(and(inArray(applicationMarks.applicationId, applicationIds), isNull(applicationMarks.clearedAt)));
  for (const r of rows) out.set(r.applicationId, toActiveMark(r));
  return out;
}

async function clearActive(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; reason: string; note?: string | null; now: Date }): Promise<MarkRow | null> {
  const [row] = await q.update(applicationMarks).set({ clearedAt: input.now.toISOString(), clearedBy: input.actor, clearReason: input.reason }).where(and(eq(applicationMarks.applicationId, input.applicationId), isNull(applicationMarks.clearedAt))).returning();
  if (!row) return null;
  await emit(q, { type: "application.mark_cleared", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { markId: row.id, mark: row.mark, reason: input.reason, note: input.note ?? null } });
  return row;
}

/**
 * Sets a mark, replacing the active one. Refused when the step does not allow it (MarkError "not_allowed", with the
 * reason in plain words). A hold gets its end date here (`holdUntil`); other marks carry none.
 */
export async function setMark(
  q: Queryable,
  input: { companyId: string; app: { id: string; stage: ApplicationStage }; mark: MarkKind; note?: string | null; remindAt?: string | null; actor: Actor; source?: MarkSource; now?: Date },
): Promise<{ mark: ActiveMark; replaced: MarkKind | null }> {
  const now = input.now ?? new Date();
  const blocked = markBlockedReason(input.app.stage, input.mark);
  if (blocked) throw new MarkError("not_allowed", blocked);
  const remindAt = input.mark === "on_hold" ? holdUntil(input.remindAt, now) : null;
  const previous = await clearActive(q, { companyId: input.companyId, applicationId: input.app.id, actor: input.actor, reason: `replaced by ${MARK_LABEL[input.mark].toLowerCase()}`, now });
  // One active mark per application (a unique index): someone else setting one at the same moment is a clear refusal, not a crash.
  const [row] = await q.insert(applicationMarks).values({ companyId: input.companyId, applicationId: input.app.id, mark: input.mark, remindAt, note: input.note?.trim() || null, setBy: input.actor, source: input.source ?? "manual", createdAt: now.toISOString() }).returning().catch((e: unknown) => {
    if (uniqueViolation(e)) throw new MarkError("conflict", "Someone else changed this candidate's stage a moment ago. Refresh to see where they are now.");
    throw e;
  });
  await emit(q, { type: "application.marked", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.app.id }, payload: { markId: row.id, mark: row.mark, remindAt, note: row.note, source: row.source, replaced: previous?.mark ?? null } });
  return { mark: toActiveMark(row), replaced: previous?.mark ?? null };
}

/** Takes the active mark off (back to the step underneath). MarkError "no_mark" when there is none. */
export async function clearMark(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; note?: string | null; reason?: string; now?: Date }): Promise<MarkKind> {
  const row = await clearActive(q, { companyId: input.companyId, applicationId: input.applicationId, actor: input.actor, reason: input.reason ?? "cleared by a person", note: input.note ?? null, now: input.now ?? new Date() });
  if (!row) throw new MarkError("no_mark", "There is no mark to take off.");
  return row.mark;
}
