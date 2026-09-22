/**
 * TCPA-style quiet hours (docs/08): no automated texts before 8:00 or after 21:00 in the recipient's local time.
 * The company's timezone stands in for the candidate's until a candidate timezone is known.
 */
export const CONTACT_HOURS = { start: 8, end: 21 };

export function localHour(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
    return h === 24 ? 0 : h;
  } catch {
    return now.getUTCHours();
  }
}

export function withinContactHours(now: Date, timezone: string): boolean {
  const h = localHour(now, timezone);
  return h >= CONTACT_HOURS.start && h < CONTACT_HOURS.end;
}

/** The next moment texting is allowed: now if inside the window, else the next local 8:00 (to the quarter hour). */
export function nextContactWindow(now: Date, timezone: string): Date {
  if (withinContactHours(now, timezone)) return now;
  let t = new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 24 * 4; i++) {
    if (withinContactHours(t, timezone)) return t;
    t = new Date(t.getTime() + 900_000);
  }
  return t;
}
