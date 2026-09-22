import { createHash } from "node:crypto";
import type { OfferedSlot } from "@ros/contracts";
import { zonedParts, zonedToUtc } from "./business-hours";

/**
 * Slot computation for interviews (docs/06 schedule_interview, propose_slots). Pure: the workflow gathers each
 * participant's constraints (declared windows, calendar busy time, existing bookings) and this turns them into a
 * short list of times that work for everyone, expressed as instants so every time zone and daylight-saving change is
 * handled by the same arithmetic the business calendar uses.
 */
export type TimeRange = { start: string; end: string };
export type AvailabilityWindow = { day: number; start: string; end: string }; // day: 0 Sunday .. 6 Saturday, HH:MM in the participant's zone

export type ParticipantConstraints = {
  userId: string;
  /** calendar: free/busy came from a connected calendar; declared: only the windows; none: nothing known (treated as unconstrained, reported). */
  source: "calendar" | "declared" | "none";
  timezone: string;
  windows: AvailabilityWindow[];
  bufferMinutes: number;
  maxPerDay: number;
  busy: TimeRange[];
  /** Interviews already booked, per day key in the participant's zone. */
  bookedPerDay?: Record<string, number>;
};

export type SlotComputationInput = {
  participants: ParticipantConstraints[];
  durationMinutes: number;
  /** Inclusive day range in the company's zone. */
  fromDate: string;
  toDate: string;
  companyTimezone: string;
  businessDaysOnly: boolean;
  now: Date;
  /** Nothing sooner than this many hours from now. */
  leadHours?: number;
  stepMinutes?: number;
  maxSlots?: number;
  maxSlotsPerDay?: number;
};

const DEFAULT_WINDOWS: AvailabilityWindow[] = [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" }));

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Enumerates the day keys from fromDate to toDate inclusive (YYYY-MM-DD strings compare lexically). */
export function dayKeysBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const [y, m, d] = fromDate.split("-").map(Number);
  for (let i = 0; i < 120; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    const key = t.toISOString().slice(0, 10);
    if (key > toDate) break;
    out.push(key);
  }
  return out;
}

/** A participant's free ranges on one company day: declared windows in their own zone, minus busy time padded by the buffer. */
export function freeRangesForDay(p: ParticipantConstraints, dayKey: string): TimeRange[] {
  const [y, m, d] = dayKey.split("-").map(Number);
  // The participant's windows are defined per weekday in their zone; map the company day to the participant's weekday at noon.
  const noon = zonedToUtc(y, m, d, 12, 0, p.timezone);
  const pp = zonedParts(noon, p.timezone);
  const windows = (p.source === "none" ? DEFAULT_WINDOWS : p.windows).filter((w) => w.day === pp.weekday);
  if (!windows.length) return [];
  if ((p.bookedPerDay?.[pp.dayKey] ?? 0) >= p.maxPerDay) return [];
  const ranges: TimeRange[] = windows.map((w) => ({ start: zonedToUtc(pp.year, pp.month, pp.day, Math.floor(toMin(w.start) / 60), toMin(w.start) % 60, p.timezone).toISOString(), end: zonedToUtc(pp.year, pp.month, pp.day, Math.floor(toMin(w.end) / 60), toMin(w.end) % 60, p.timezone).toISOString() }));
  const pad = p.bufferMinutes * 60_000;
  const busy = p.busy.map((b) => ({ start: new Date(Date.parse(b.start) - pad).toISOString(), end: new Date(Date.parse(b.end) + pad).toISOString() }));
  return subtractRanges(ranges, busy);
}

export function subtractRanges(free: TimeRange[], busy: TimeRange[]): TimeRange[] {
  let out = [...free];
  for (const b of busy) {
    const next: TimeRange[] = [];
    for (const f of out) {
      if (b.end <= f.start || b.start >= f.end) { next.push(f); continue; }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    out = next;
  }
  return out.filter((r) => r.end > r.start);
}

export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const x of a) for (const y of b) {
    const start = x.start > y.start ? x.start : y.start;
    const end = x.end < y.end ? x.end : y.end;
    if (end > start) out.push({ start, end });
  }
  return out.sort((p, q) => (p.start < q.start ? -1 : 1));
}

export function slotId(startsAt: string, interviewerUserIds: string[]): string {
  return `slot_${createHash("sha256").update(`${startsAt}|${[...interviewerUserIds].sort().join(",")}`).digest("hex").slice(0, 12)}`;
}

/** Up to `maxSlots` starts spread over the window: at most `maxSlotsPerDay` per day, preferring times a few hours apart. */
export function computeSlots(input: SlotComputationInput): { slots: OfferedSlot[]; unconstrained: string[] } {
  const step = (input.stepMinutes ?? 30) * 60_000;
  const duration = input.durationMinutes * 60_000;
  const earliest = input.now.getTime() + (input.leadHours ?? 24) * 3600_000;
  const maxSlots = input.maxSlots ?? 8;
  const perDay = input.maxSlotsPerDay ?? 2;
  const ids = input.participants.map((p) => p.userId);
  const source: OfferedSlot["source"] = input.participants.some((p) => p.source === "calendar") ? "calendar" : "declared";
  const slots: OfferedSlot[] = [];
  for (const dayKey of dayKeysBetween(input.fromDate, input.toDate)) {
    if (slots.length >= maxSlots) break;
    const [y, m, d] = dayKey.split("-").map(Number);
    const companyNoon = zonedParts(zonedToUtc(y, m, d, 12, 0, input.companyTimezone), input.companyTimezone);
    if (input.businessDaysOnly && (companyNoon.weekday === 0 || companyNoon.weekday === 6)) continue;
    let common: TimeRange[] | null = null;
    for (const p of input.participants) {
      const free = freeRangesForDay(p, dayKey);
      common = common === null ? free : intersectRanges(common, free);
      if (!common.length) break;
    }
    if (!common?.length) continue;
    const dayStarts: number[] = [];
    for (const r of common) {
      // align to the step grid measured from the top of the hour
      let t = Math.ceil(Date.parse(r.start) / step) * step;
      while (t + duration <= Date.parse(r.end)) {
        if (t >= earliest) dayStarts.push(t);
        t += step;
      }
    }
    if (!dayStarts.length) continue;
    // pick spread-out starts: the first, then the first that is at least three hours later, and so on
    const chosen: number[] = [];
    for (const t of dayStarts) {
      if (chosen.length >= perDay) break;
      if (!chosen.length || t - chosen[chosen.length - 1] >= 3 * 3600_000) chosen.push(t);
    }
    if (chosen.length < perDay && dayStarts.length > chosen.length) {
      // not enough spread: fall back to the latest start of the day for a second option
      const last = dayStarts[dayStarts.length - 1];
      if (!chosen.includes(last)) chosen.push(last);
    }
    for (const t of chosen.slice(0, perDay)) {
      if (slots.length >= maxSlots) break;
      const startsAt = new Date(t).toISOString();
      slots.push({ id: slotId(startsAt, ids), startsAt, endsAt: new Date(t + duration).toISOString(), interviewerUserIds: ids, source });
    }
  }
  return { slots, unconstrained: input.participants.filter((p) => p.source === "none").map((p) => p.userId) };
}

/** True when the slot still fits every participant's current constraints (the re-check at booking time). */
export function slotStillFree(slot: { startsAt: string; endsAt: string }, participants: ParticipantConstraints[]): boolean {
  const pad = (p: ParticipantConstraints) => p.bufferMinutes * 60_000;
  return participants.every((p) => p.busy.every((b) => Date.parse(b.end) + pad(p) <= Date.parse(slot.startsAt) || Date.parse(b.start) - pad(p) >= Date.parse(slot.endsAt)));
}

/** Groups offered slots by the candidate's local day for the pick-a-time page. */
export function groupSlotsByDay(slots: OfferedSlot[], timeZone: string): Array<{ dayKey: string; label: string; slots: Array<OfferedSlot & { label: string }> }> {
  const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
  const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const groups = new Map<string, { dayKey: string; label: string; slots: Array<OfferedSlot & { label: string }> }>();
  for (const s of [...slots].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1))) {
    const d = new Date(s.startsAt);
    const key = zonedParts(d, timeZone).dayKey;
    const g = groups.get(key) ?? { dayKey: key, label: fmtDay.format(d), slots: [] };
    g.slots.push({ ...s, label: `${fmtTime.format(d)}` });
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The default scheduling window: the next ten business days starting tomorrow, in the company's zone. */
export function defaultSchedulingWindow(now: Date, companyTimezone: string): { fromDate: string; toDate: string; businessDaysOnly: true } {
  const p = zonedParts(now, companyTimezone);
  const from = zonedParts(zonedToUtc(p.year, p.month, p.day + 1, 12, 0, companyTimezone), companyTimezone).dayKey;
  let businessDays = 0;
  let i = 1;
  let to = from;
  while (businessDays < 10 && i < 30) {
    const q = zonedParts(zonedToUtc(p.year, p.month, p.day + i, 12, 0, companyTimezone), companyTimezone);
    if (q.weekday !== 0 && q.weekday !== 6) businessDays++;
    to = q.dayKey;
    i++;
  }
  return { fromDate: from, toDate: to, businessDaysOnly: true };
}
