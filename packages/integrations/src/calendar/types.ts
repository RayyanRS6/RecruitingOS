import type { AdapterStatus } from "../types";

/**
 * Calendar providers (founder decisions D2, F3; correction 3: Google first, Microsoft when a partner needs it). The
 * scheduling domain talks only to this interface. Credentials arrive as a refresh token read from the managed secret
 * store for a stated purpose; the provider exchanges it for short-lived access in memory and never persists anything.
 */
export type TimeRange = { start: string; end: string }; // ISO instants, end exclusive

export type CalendarAccount = { email: string | null; calendarId: string; timeZone: string | null; displayName?: string | null };

export type CalendarCredential = { refreshToken: string };

export type CalendarEventInput = {
  /** Deterministic per interview, attempt and participant, so a retry finds the event instead of creating a second one. */
  idempotencyKey: string;
  title: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: Array<{ email: string; name?: string | null; optional?: boolean }>;
  /** Ask the provider to create a conference link (Google Meet, Teams); null keeps the event without one. */
  conference: "auto" | null;
  location?: string | null;
};

export type CalendarEventRef = { provider: string; calendarId: string; eventId: string; icalUid: string | null; htmlLink: string | null; meetingUrl: string | null; idempotencyKey: string };

export type CalendarErrorCode = "auth_revoked" | "rate_limited" | "not_found" | "conflict" | "transient" | "not_configured";

export class CalendarError extends Error {
  constructor(public readonly code: CalendarErrorCode, message: string, public readonly retryable = code === "rate_limited" || code === "transient") {
    super(message);
  }
}

export interface CalendarProvider {
  readonly provider: string; // google | microsoft | fake
  readonly status: AdapterStatus;
  /** The consent screen for a connection scoped to the calendar the product needs (events plus free/busy, nothing wider). */
  authorizeUrl(input: { redirectTo: string; state: string; codeChallenge?: string; loginHint?: string | null }): string;
  exchangeCode(input: { code: string; redirectTo: string; codeVerifier?: string }): Promise<{ refreshToken: string; account: CalendarAccount; scopes: string[] }>;
  /** Busy ranges per calendar id inside the range. */
  freeBusy(cred: CalendarCredential, input: { calendarIds: string[]; range: TimeRange }): Promise<Record<string, TimeRange[]>>;
  findEventByKey(cred: CalendarCredential, calendarId: string, idempotencyKey: string): Promise<CalendarEventRef | null>;
  createEvent(cred: CalendarCredential, calendarId: string, input: CalendarEventInput): Promise<CalendarEventRef>;
  updateEvent(cred: CalendarCredential, ref: CalendarEventRef, patch: Partial<Pick<CalendarEventInput, "start" | "end" | "timeZone" | "title" | "description" | "attendees">>): Promise<CalendarEventRef>;
  cancelEvent(cred: CalendarCredential, ref: CalendarEventRef): Promise<void>;
  /** A cheap authenticated call that proves the credential still works. */
  probe(cred: CalendarCredential, calendarId: string): Promise<{ ok: true; timeZone: string | null } | { ok: false; code: CalendarErrorCode; error: string }>;
  /** Tells the provider the credential is no longer to be honoured. */
  revoke(cred: CalendarCredential): Promise<{ ok: boolean; error?: string }>;
}

/** The narrow scopes the product requests (S13): events on the chosen calendar and free/busy, nothing wider. */
export const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy", "openid", "email"] as const;
