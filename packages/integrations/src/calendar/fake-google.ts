import { randomBytes } from "node:crypto";
import { CalendarError, GOOGLE_CALENDAR_SCOPES, type CalendarAccount, type CalendarErrorCode, type CalendarCredential, type CalendarEventInput, type CalendarEventRef, type CalendarProvider, type TimeRange } from "./types";

/**
 * Google Calendar, mocked (slice 5 step 8; founder decision: synthetic data and mocks until accounts exist). Behaves
 * like the real adapter at the interface: consent, code exchange, free/busy, idempotent events, conference links,
 * probes, revocation, and the failures that matter (revoked credential, rate limit, transient error). Tests script
 * busy time and failures; nothing here leaves the process.
 */
/** The failures a test can script: the ones that matter to scheduling. */
type FakeFailure = "auth_revoked" | "rate_limited" | "transient" | "permission_denied";
type Account = { refreshToken: string; email: string; calendarId: string; timeZone: string; revoked: boolean };
type StoredEvent = CalendarEventRef & { input: CalendarEventInput; status: "confirmed" | "cancelled"; sequence: number };

export class FakeGoogleCalendarProvider implements CalendarProvider {
  readonly provider = "google";
  readonly status = "fake" as const;
  private accounts = new Map<string, Account>(); // by refresh token
  private codes = new Map<string, { email: string; timeZone: string; codeChallenge?: string }>();
  private busyByEmail = new Map<string, TimeRange[]>();
  private events = new Map<string, StoredEvent>(); // by event id
  private nextFailure: { code: FakeFailure; times: number } | null = null;
  constructor(private cfg: { apiBaseUrl: string }) {}

  authorizeUrl(input: { redirectTo: string; state: string; codeChallenge?: string; loginHint?: string | null }): string {
    const u = new URL(`${this.cfg.apiBaseUrl}/api/v1/integrations/calendar/fake/authorize`);
    u.searchParams.set("provider", "google");
    u.searchParams.set("redirect_to", input.redirectTo);
    u.searchParams.set("state", input.state);
    if (input.codeChallenge) u.searchParams.set("code_challenge", input.codeChallenge);
    if (input.loginHint) u.searchParams.set("login_hint", input.loginHint);
    return u.toString();
  }
  /** The fake consent page calls this after the person "allows" access. */
  issueCode(input: { email: string; timeZone?: string; codeChallenge?: string }): string {
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, { email: input.email.toLowerCase(), timeZone: input.timeZone ?? "America/Los_Angeles", codeChallenge: input.codeChallenge });
    return code;
  }
  async exchangeCode(input: { code: string; redirectTo: string; codeVerifier?: string }): Promise<{ refreshToken: string; account: CalendarAccount; scopes: string[] }> {
    const entry = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!entry) throw new CalendarError("transient", "The calendar connection could not be completed. Try again.", false);
    const refreshToken = `1//0fake-google-${randomBytes(18).toString("base64url")}`;
    this.accounts.set(refreshToken, { refreshToken, email: entry.email, calendarId: entry.email, timeZone: entry.timeZone, revoked: false });
    return { refreshToken, account: { email: entry.email, calendarId: entry.email, timeZone: entry.timeZone }, scopes: [...GOOGLE_CALENDAR_SCOPES] };
  }
  private account(cred: CalendarCredential): Account {
    if (this.nextFailure && this.nextFailure.times > 0) {
      this.nextFailure.times -= 1;
      const code = this.nextFailure.code;
      if (this.nextFailure.times === 0) this.nextFailure = null;
      throw new CalendarError(code, code === "auth_revoked" ? "Google no longer honours this connection; reconnect the calendar." : code === "rate_limited" ? "Google asked us to slow down." : code === "permission_denied" ? "Google refused access to this calendar; reconnect it and allow access to its events." : "Google returned a temporary error.");
    }
    const a = this.accounts.get(cred.refreshToken);
    if (!a || a.revoked) throw new CalendarError("auth_revoked", "Google no longer honours this connection; reconnect the calendar.", false);
    return a;
  }
  async freeBusy(cred: CalendarCredential, input: { calendarIds: string[]; range: TimeRange }): Promise<Record<string, TimeRange[]>> {
    this.account(cred);
    const out: Record<string, TimeRange[]> = {};
    for (const id of input.calendarIds) {
      const busy = [...(this.busyByEmail.get(id.toLowerCase()) ?? []), ...[...this.events.values()].filter((e) => e.calendarId === id.toLowerCase() && e.status === "confirmed").map((e) => ({ start: e.input.start, end: e.input.end }))];
      out[id] = busy.filter((b) => b.end > input.range.start && b.start < input.range.end).sort((a, b) => (a.start < b.start ? -1 : 1));
    }
    return out;
  }
  async findEventByKey(cred: CalendarCredential, calendarId: string, idempotencyKey: string): Promise<CalendarEventRef | null> {
    this.account(cred);
    const e = [...this.events.values()].find((x) => x.calendarId === calendarId.toLowerCase() && x.idempotencyKey === idempotencyKey && x.status === "confirmed");
    return e ? refOf(e) : null;
  }
  async createEvent(cred: CalendarCredential, calendarId: string, input: CalendarEventInput): Promise<CalendarEventRef> {
    this.account(cred);
    const existing = await this.findEventByKey(cred, calendarId, input.idempotencyKey);
    if (existing) return existing;
    const eventId = `fakeevt_${randomBytes(8).toString("hex")}`;
    const normalized = { ...input, start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() };
    const e: StoredEvent = { provider: "google", calendarId: calendarId.toLowerCase(), eventId, icalUid: `${eventId}@google.com`, htmlLink: `https://calendar.google.com/event?eid=${eventId}`, meetingUrl: input.conference === "auto" ? `https://meet.google.com/fake-${eventId.slice(-8)}` : null, idempotencyKey: input.idempotencyKey, input: normalized, status: "confirmed", sequence: 0 };
    this.events.set(eventId, e);
    return refOf(e);
  }
  async updateEvent(cred: CalendarCredential, ref: CalendarEventRef, patch: Partial<Pick<CalendarEventInput, "start" | "end" | "timeZone" | "title" | "description" | "attendees">>): Promise<CalendarEventRef> {
    this.account(cred);
    const e = this.events.get(ref.eventId);
    if (e?.status !== "confirmed") throw new CalendarError("not_found", "The calendar event no longer exists.", false);
    e.input = { ...e.input, ...patch };
    e.sequence += 1;
    return refOf(e);
  }
  async cancelEvent(cred: CalendarCredential, ref: CalendarEventRef): Promise<void> {
    this.account(cred);
    const e = this.events.get(ref.eventId);
    if (!e) return; // already gone: cancellation is idempotent
    e.status = "cancelled";
  }
  async probe(cred: CalendarCredential, _calendarId: string): Promise<{ ok: true; timeZone: string | null } | { ok: false; code: CalendarErrorCode; error: string }> {
    try {
      const a = this.account(cred);
      return { ok: true, timeZone: a.timeZone };
    } catch (err) {
      if (err instanceof CalendarError) return { ok: false, code: err.code, error: err.message };
      throw err;
    }
  }
  async revoke(cred: CalendarCredential): Promise<{ ok: boolean; error?: string }> {
    const a = this.accounts.get(cred.refreshToken);
    if (!a) return { ok: false, error: "unknown credential" };
    a.revoked = true;
    return { ok: true };
  }

  // Test controls
  setBusy(email: string, ranges: TimeRange[]): void {
    this.busyByEmail.set(email.toLowerCase(), ranges);
  }
  failNext(code: FakeFailure, times = 1): void {
    this.nextFailure = { code, times };
  }
  /** The person revokes access at Google: every later call fails with auth_revoked. */
  revokeAccount(email: string): void {
    for (const a of this.accounts.values()) if (a.email === email.toLowerCase()) a.revoked = true;
  }
  eventsFor(email: string): Array<{ eventId: string; status: string; start: string; end: string; title: string; attendees: string[]; idempotencyKey: string; meetingUrl: string | null }> {
    return [...this.events.values()].filter((e) => e.calendarId === email.toLowerCase()).map((e) => ({ eventId: e.eventId, status: e.status, start: e.input.start, end: e.input.end, title: e.input.title, attendees: e.input.attendees.map((a) => a.email), idempotencyKey: e.idempotencyKey, meetingUrl: e.meetingUrl }));
  }
  accountCount(): number {
    return [...this.accounts.values()].filter((a) => !a.revoked).length;
  }
}

function refOf(e: StoredEvent): CalendarEventRef {
  return { provider: e.provider, calendarId: e.calendarId, eventId: e.eventId, icalUid: e.icalUid, htmlLink: e.htmlLink, meetingUrl: e.meetingUrl, idempotencyKey: e.idempotencyKey };
}
