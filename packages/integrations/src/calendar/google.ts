import { CalendarError, GOOGLE_CALENDAR_SCOPES, type CalendarAccount, type CalendarCredential, type CalendarEventInput, type CalendarEventRef, type CalendarProvider, type TimeRange } from "./types";

/**
 * Google Calendar over the REST API (built against the documented endpoints; verified with a fake fetch until an ITS
 * Google Cloud project exists, see docs/spec/13 §8). Narrow scopes (events on the chosen calendar plus free/busy).
 * Access tokens are minted from the refresh token in memory per call batch and never stored.
 */
type Fetch = typeof fetch;
type TokenCache = { accessToken: string; expiresAt: number };

export class GoogleCalendarProvider implements CalendarProvider {
  readonly provider = "google";
  private tokens = new Map<string, TokenCache>();
  constructor(private cfg: { clientId?: string; clientSecret?: string; fetch?: Fetch; now?: () => Date }) {}
  get status() {
    return this.cfg.clientId && this.cfg.clientSecret ? ("live" as const) : ("not_connected" as const);
  }
  private get f(): Fetch {
    return this.cfg.fetch ?? fetch;
  }
  authorizeUrl(input: { redirectTo: string; state: string; codeChallenge?: string; loginHint?: string | null }): string {
    if (!this.cfg.clientId) throw new CalendarError("not_configured", "Google Calendar is not configured.", false);
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", input.redirectTo);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "false");
    u.searchParams.set("state", input.state);
    if (input.codeChallenge) { u.searchParams.set("code_challenge", input.codeChallenge); u.searchParams.set("code_challenge_method", "S256"); }
    if (input.loginHint) u.searchParams.set("login_hint", input.loginHint);
    return u.toString();
  }
  async exchangeCode(input: { code: string; redirectTo: string; codeVerifier?: string }): Promise<{ refreshToken: string; account: CalendarAccount; scopes: string[] }> {
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new CalendarError("not_configured", "Google Calendar is not configured.", false);
    const body = new URLSearchParams({ code: input.code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: input.redirectTo, grant_type: "authorization_code" });
    if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);
    const res = await this.f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!res.ok) throw new CalendarError("transient", "Google did not accept the authorization code.", false);
    const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    if (!tok.refresh_token) throw new CalendarError("transient", "Google did not return a refresh token; the consent screen must ask for offline access.", false);
    this.tokens.set(tok.refresh_token, { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 });
    const cal = await this.api(tok.access_token, "GET", "https://www.googleapis.com/calendar/v3/calendars/primary");
    const c = (await cal.json()) as { id: string; timeZone?: string; summary?: string };
    const me = await this.api(tok.access_token, "GET", "https://www.googleapis.com/oauth2/v3/userinfo");
    const u = (await me.json()) as { email?: string };
    return { refreshToken: tok.refresh_token, account: { email: u.email ?? c.id ?? null, calendarId: "primary", timeZone: c.timeZone ?? null, displayName: c.summary ?? null }, scopes: (tok.scope ?? "").split(" ").filter(Boolean) };
  }
  private async accessToken(cred: CalendarCredential): Promise<string> {
    const cached = this.tokens.get(cred.refreshToken);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new CalendarError("not_configured", "Google Calendar is not configured.", false);
    const body = new URLSearchParams({ refresh_token: cred.refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "refresh_token" });
    const res = await this.f("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (res.status === 400 || res.status === 401) throw new CalendarError("auth_revoked", "Google no longer honours this connection; reconnect the calendar.", false);
    if (!res.ok) throw new CalendarError("transient", "Google's token service returned an error.");
    const tok = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens.set(cred.refreshToken, { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 });
    return tok.access_token;
  }
  private async api(accessToken: string, method: string, url: string, body?: unknown): Promise<Response> {
    const res = await this.f(url, { method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) throw new CalendarError("auth_revoked", "Google no longer honours this connection; reconnect the calendar.", false);
    if (res.status === 403 || res.status === 429) throw new CalendarError("rate_limited", "Google asked us to slow down.");
    if (res.status === 404) throw new CalendarError("not_found", "The calendar or event was not found.", false);
    if (res.status === 409) throw new CalendarError("conflict", "The event already exists.", false);
    if (res.status >= 500) throw new CalendarError("transient", `Google returned ${res.status}.`);
    if (!res.ok) throw new CalendarError("transient", `Google returned ${res.status}.`, false);
    return res;
  }
  async freeBusy(cred: CalendarCredential, input: { calendarIds: string[]; range: TimeRange }): Promise<Record<string, TimeRange[]>> {
    const token = await this.accessToken(cred);
    const res = await this.api(token, "POST", "https://www.googleapis.com/calendar/v3/freeBusy", { timeMin: input.range.start, timeMax: input.range.end, items: input.calendarIds.map((id) => ({ id })) });
    const body = (await res.json()) as { calendars: Record<string, { busy: Array<{ start: string; end: string }>; errors?: unknown[] }> };
    const out: Record<string, TimeRange[]> = {};
    for (const id of input.calendarIds) out[id] = (body.calendars?.[id]?.busy ?? []).map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() }));
    return out;
  }
  async findEventByKey(cred: CalendarCredential, calendarId: string, idempotencyKey: string): Promise<CalendarEventRef | null> {
    const token = await this.accessToken(cred);
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set("privateExtendedProperty", `rosKey=${idempotencyKey}`);
    u.searchParams.set("showDeleted", "false");
    const res = await this.api(token, "GET", u.toString());
    const body = (await res.json()) as { items?: Array<{ id: string; iCalUID?: string; htmlLink?: string; hangoutLink?: string; status?: string }> };
    const e = body.items?.find((x) => x.status !== "cancelled");
    return e ? { provider: "google", calendarId, eventId: e.id, icalUid: e.iCalUID ?? null, htmlLink: e.htmlLink ?? null, meetingUrl: e.hangoutLink ?? null, idempotencyKey } : null;
  }
  async createEvent(cred: CalendarCredential, calendarId: string, input: CalendarEventInput): Promise<CalendarEventRef> {
    const existing = await this.findEventByKey(cred, calendarId, input.idempotencyKey);
    if (existing) return existing;
    const token = await this.accessToken(cred);
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    if (input.conference === "auto") u.searchParams.set("conferenceDataVersion", "1");
    u.searchParams.set("sendUpdates", "all");
    const body = {
      summary: input.title, description: input.description, location: input.location ?? undefined,
      start: { dateTime: input.start, timeZone: input.timeZone }, end: { dateTime: input.end, timeZone: input.timeZone },
      attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined, optional: a.optional ?? false })),
      extendedProperties: { private: { rosKey: input.idempotencyKey } },
      guestsCanModify: false, guestsCanInviteOthers: false,
      ...(input.conference === "auto" ? { conferenceData: { createRequest: { requestId: input.idempotencyKey, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    };
    const res = await this.api(token, "POST", u.toString(), body);
    const e = (await res.json()) as { id: string; iCalUID?: string; htmlLink?: string; hangoutLink?: string };
    return { provider: "google", calendarId, eventId: e.id, icalUid: e.iCalUID ?? null, htmlLink: e.htmlLink ?? null, meetingUrl: e.hangoutLink ?? null, idempotencyKey: input.idempotencyKey };
  }
  async updateEvent(cred: CalendarCredential, ref: CalendarEventRef, patch: Partial<Pick<CalendarEventInput, "start" | "end" | "timeZone" | "title" | "description" | "attendees">>): Promise<CalendarEventRef> {
    const token = await this.accessToken(cred);
    const body: Record<string, unknown> = {};
    if (patch.title) body.summary = patch.title;
    if (patch.description) body.description = patch.description;
    if (patch.start) body.start = { dateTime: patch.start, timeZone: patch.timeZone };
    if (patch.end) body.end = { dateTime: patch.end, timeZone: patch.timeZone };
    if (patch.attendees) body.attendees = patch.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined }));
    const res = await this.api(token, "PATCH", `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}?sendUpdates=all`, body);
    const e = (await res.json()) as { id: string; iCalUID?: string; htmlLink?: string; hangoutLink?: string };
    return { ...ref, eventId: e.id, icalUid: e.iCalUID ?? ref.icalUid, htmlLink: e.htmlLink ?? ref.htmlLink, meetingUrl: e.hangoutLink ?? ref.meetingUrl };
  }
  async cancelEvent(cred: CalendarCredential, ref: CalendarEventRef): Promise<void> {
    const token = await this.accessToken(cred);
    try {
      await this.api(token, "DELETE", `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}?sendUpdates=all`);
    } catch (err) {
      if (err instanceof CalendarError && err.code === "not_found") return; // already gone: idempotent
      throw err;
    }
  }
  async probe(cred: CalendarCredential, calendarId: string): Promise<{ ok: true; timeZone: string | null } | { ok: false; code: CalendarError["code"]; error: string }> {
    try {
      const token = await this.accessToken(cred);
      const res = await this.api(token, "GET", `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`);
      const c = (await res.json()) as { timeZone?: string };
      return { ok: true, timeZone: c.timeZone ?? null };
    } catch (err) {
      if (err instanceof CalendarError) return { ok: false, code: err.code, error: err.message };
      throw err;
    }
  }
  async revoke(cred: CalendarCredential): Promise<{ ok: boolean; error?: string }> {
    const res = await this.f("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: cred.refreshToken }).toString() });
    this.tokens.delete(cred.refreshToken);
    return res.ok ? { ok: true } : { ok: false, error: `Google returned ${res.status}` };
  }
}
