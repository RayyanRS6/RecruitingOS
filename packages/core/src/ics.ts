/**
 * iCalendar (RFC 5545) for interview confirmations and cancellations: the candidate's "add to calendar" download and the
 * attachment on confirmation email. Text is folded and escaped per the standard; times are UTC so every client agrees.
 */
export type IcsEvent = {
  uid: string;
  sequence: number;
  method: "REQUEST" | "CANCEL" | "PUBLISH";
  start: string; // ISO
  end: string; // ISO
  summary: string;
  description?: string;
  location?: string | null;
  url?: string | null;
  organizer?: { name: string; email: string } | null;
  attendees?: Array<{ name?: string | null; email: string }>;
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
  stamp?: Date;
};

function icsDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
/** TEXT values (RFC 5545 3.3.11): backslash, semicolon and comma are backslash-escaped, line breaks become "\n". */
export function escapeIcsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
/**
 * A parameter value such as CN (RFC 5545 3.2): always DQUOTE-quoted, so a comma, colon or semicolon in a name stays
 * inside it. A quoted value cannot hold a DQUOTE or a control character, so those become an apostrophe and a space.
 */
export function quoteIcsParam(s: string): string {
  const clean = Array.from(s, (ch) => {
    const code = ch.charCodeAt(0);
    return ch === '"' ? "'" : code < 32 || code === 127 ? " " : ch;
  }).join("");
  return `"${clean.trim()}"`;
}
/** Lines longer than 75 octets are folded with CRLF plus a single space. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    // never split a surrogate pair
    if (cut > 0 && /[\uD800-\uDBFF]$/.test(rest.slice(0, cut))) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(ev: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Identified Talent Solutions//Recruiting OS//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${ev.method}`,
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `SEQUENCE:${ev.sequence}`,
    `DTSTAMP:${icsDate(ev.stamp ?? new Date())}`,
    `DTSTART:${icsDate(ev.start)}`,
    `DTEND:${icsDate(ev.end)}`,
    `SUMMARY:${escapeIcsText(ev.summary)}`,
    `STATUS:${ev.status ?? (ev.method === "CANCEL" ? "CANCELLED" : "CONFIRMED")}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.organizer) lines.push(`ORGANIZER;CN=${quoteIcsParam(ev.organizer.name)}:mailto:${ev.organizer.email}`);
  for (const a of ev.attendees ?? []) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE${a.name ? `;CN=${quoteIcsParam(a.name)}` : ""}:mailto:${a.email}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** Wall-clock text for a person in their zone, e.g. "Tuesday, September 22, 2026 at 10:00 AM PDT". */
export function formatInZone(iso: string, timeZone: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
