import { describe, expect, it } from "vitest";
import { extractApplicantFromInbound, extractIntakeToken, intakeAddress, parsePostmarkInbound } from "./email/inbound";
import { FakeEmailAdapter } from "./email/fake";
import { linkedInFeedXml } from "./jobboards/external";

describe("inbound email", () => {
  it("round-trips intake addresses", () => {
    const addr = intakeAddress("abc123", "intake.example.com");
    expect(addr).toBe("apply-abc123@intake.example.com");
    expect(extractIntakeToken("Jobs <APPLY-abc123@intake.example.com>", "intake.example.com")).toBe("abc123");
    expect(extractIntakeToken("apply-abc123@other.com", "intake.example.com")).toBeNull();
  });
  it("parses an Indeed-style forwarded application", () => {
    const mail = parsePostmarkInbound({
      From: "noreply@indeed.com",
      FromName: "Indeed",
      To: "apply-tok@intake.example.com",
      Subject: "New applicant: Maria Reyes - Registered Dental Hygienist",
      TextBody: "Maria Reyes applied.\nEmail: maria.reyes@example.com\nPhone: (949) 555-0100\nResume attached.",
      Attachments: [{ Name: "Maria-Reyes-Resume.pdf", ContentType: "application/pdf", Content: "JVBERi0=", ContentLength: 5 }],
    });
    const a = extractApplicantFromInbound(mail);
    expect(a.firstName).toBe("Maria");
    expect(a.lastName).toBe("Reyes");
    expect(a.email).toBe("maria.reyes@example.com");
    expect(a.phone).toContain("555");
    expect(mail.attachments[0].filename).toBe("Maria-Reyes-Resume.pdf");
  });
});

describe("fake email adapter", () => {
  it("is idempotent and can simulate outages", async () => {
    const e = new FakeEmailAdapter();
    e.failNext(1);
    const first = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    expect(first.status).toBe("failed");
    const second = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    const third = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    expect(second.status).toBe("sent");
    expect(third).toEqual(second);
    expect(e.sent).toHaveLength(1);
  });
});

describe("linkedin feed", () => {
  it("produces a feed with CDATA-escaped content", () => {
    const xml = linkedInFeedXml([{ partnerJobId: "1", company: "Brightline", title: "RDH", description: "a ]]> b", location: "Irvine, CA", applyUrl: "https://x/apply" }]);
    expect(xml).toContain("<partnerJobId><![CDATA[1]]></partnerJobId>");
    expect(xml).not.toContain("a ]]> b");
  });
});

describe("secret stores (founder decision F1: managed key management, never application-side cryptography)", () => {
  it("the memory store round-trips, rotates and deletes (development only)", async () => {
    const { MemorySecretStore } = await import("./secrets/memory");
    const s = new MemorySecretStore();
    expect(s.status).toBe("fake");
    const { ref } = await s.put("google:user1", "refresh-token-1");
    expect(ref).toMatch(/[0-9a-f-]{36}/);
    expect(await s.get(ref)).toBe("refresh-token-1");
    await s.rotate(ref, "refresh-token-2");
    expect(await s.get(ref)).toBe("refresh-token-2");
    await s.delete(ref);
    expect(await s.get(ref)).toBeNull();
    expect(s.size).toBe(0);
  });
  it("the vault store issues parameterised statements and never embeds the value in SQL", async () => {
    const { SupabaseVaultSecretStore } = await import("./secrets/vault");
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const exec = async (text: string, params: unknown[]) => { calls.push({ text, params }); return text.startsWith("select vault.create_secret") ? [{ id: "11111111-1111-1111-1111-111111111111" }] : text.includes("decrypted_secrets") ? [{ decrypted_secret: "tok" }] : []; };
    const s = new SupabaseVaultSecretStore(exec);
    const { ref } = await s.put("google:user1", "refresh-token", "Google Calendar refresh token");
    expect(ref).toBe("11111111-1111-1111-1111-111111111111");
    expect(await s.get(ref)).toBe("tok");
    await s.rotate(ref, "new");
    await s.delete(ref);
    for (const call of calls) expect(call.text).not.toContain("refresh-token");
    expect(calls.map((c) => c.text.split(" ")[0])).toEqual(["select", "select", "select", "delete"]);
    expect(calls[0].params).toEqual(["refresh-token", "google:user1", "Google Calendar refresh token"]);
  });
  it("the registry chooses the vault only when told to and given an executor", async () => {
    const { createIntegrations } = await import("./registry");
    expect(createIntegrations({ SECRET_STORE: "memory" }).secrets.id).toBe("memory");
    expect(createIntegrations({ SECRET_STORE: "vault" }).secrets.id).toBe("memory");
    expect(createIntegrations({ SECRET_STORE: "vault" }, { secretsExecutor: async () => [] }).secrets.id).toBe("supabase_vault");
    const statuses = createIntegrations({}).statuses();
    expect(statuses.find((s) => s.provider === "linkedin_basic")?.status).toBe("manual_action_required");
    expect(statuses.find((s) => s.provider === "google_jobs")?.status).toBe("awaiting_verification");
    expect(statuses.find((s) => s.provider === "email_in")?.status).toBe("not_connected");
    expect(statuses.find((s) => s.provider === "email_in" && s.status === "live")).toBeUndefined();
    expect(createIntegrations({ EMAIL_PROVIDER: "postmark", POSTMARK_INBOUND_SECRET: "x", EMAIL_INTAKE_DOMAIN: "apply.example.com" }).statuses().find((s) => s.provider === "email_in")?.status).toBe("live");
  });
});

describe("product analytics (founder decision, correction 14: no candidate PII, server-side only)", () => {
  it("maps funnel events to keyed references and drops everything else", async () => {
    const { toProductEvent, refFor, PRODUCT_EVENT_NAMES } = await import("./analytics/mapping").then(async (m) => ({ ...m, ...(await import("./analytics/types")) }));
    const salt = "test-salt";
    const ev = toProductEvent({ type: "screen.completed", companyId: "co-1", subjectId: "screen-9", occurredAt: "2026-09-18T10:00:00Z", payload: { applicationId: "app-1", channel: "web", candidateName: "Maria Reyes", email: "maria@example.com", transcript: "hello" } }, salt)!;
    expect(ev.name).toBe("screening_completed");
    expect(PRODUCT_EVENT_NAMES).toContain(ev.name);
    expect(ev.subjectRef).toBe(refFor("app-1", salt));
    expect(ev.subjectRef).not.toContain("app-1");
    expect(ev.companyRef).not.toContain("co-1");
    expect(ev.properties).toEqual({ channel: "web" });
    expect(JSON.stringify(ev)).not.toMatch(/Maria|maria@|hello/);
    expect(toProductEvent({ type: "assessment.created", companyId: "co-1", subjectId: "app-1", payload: { summary: "strong" } }, salt)).toBeNull();
    expect(toProductEvent({ type: "screen.completed", companyId: null, subjectId: "x", payload: {} }, salt)).toBeNull();
    expect(refFor("app-1", "other-salt")).not.toBe(refFor("app-1", salt));
  });
  it("the PostHog adapter is not connected without a key and never throws", async () => {
    const { PostHogServerAdapter, FakeAnalyticsAdapter } = await import("./analytics/adapters");
    expect(new PostHogServerAdapter(undefined).status).toBe("not_connected");
    const calls: string[] = [];
    const live = new PostHogServerAdapter("phc_test", "https://example.test", (async (url: string, init: RequestInit) => { calls.push(`${url} ${String(init.body)}`); return new Response("ok"); }) as unknown as typeof fetch);
    await live.capture({ name: "application_completed", subjectRef: "abc", companyRef: "def", at: "2026-09-18T10:00:00Z", properties: {} });
    expect(calls[0]).toContain("$process_person_profile");
    expect(calls[0]).toContain('"distinct_id":"abc"');
    expect(calls[0]).toContain("https://example.test/capture/");
    const fake = new FakeAnalyticsAdapter();
    await fake.capture({ name: "screening_started", subjectRef: "a", companyRef: "b", at: "x", properties: {} });
    expect(fake.captured).toHaveLength(1);
  });
});

describe("observability scrubbing (correction 10)", () => {
  it("removes tokens, cookies and authorization headers from an error-tracking event", async () => {
    const { scrubObservabilityEvent } = await import("./observability/sentry");
    const token = "1//0gScrubMeRefreshToken_ABCDEFGHIJKLMNOPQRSTUV";
    const ev = scrubObservabilityEvent({
      message: `failed with ${token}`,
      request: { url: "https://recruiting.identifiedtalent.com/api/v1/integrations/calendar/google/callback?code=4/0Afake&state=s1", headers: { authorization: "Bearer abc", cookie: "ros_session=xyz", "user-agent": "test" }, cookies: { ros_session: "xyz" }, data: { refresh_token: token } },
      exception: { values: [{ type: "Error", value: `upstream: ${token}` }] },
      user: { id: "u1", email: "person@example.com", ip_address: "1.2.3.4" },
      extra: { registered: "plain-registered-value-123" },
    }, ["plain-registered-value-123"]);
    const text = JSON.stringify(ev);
    expect(text).not.toContain(token);
    expect(text).not.toContain("4/0Afake");
    expect(text).not.toContain("xyz");
    expect(text).not.toContain("Bearer abc");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("plain-registered-value-123");
    expect(ev.request!.headers).toEqual({ "user-agent": "test" });
    expect(ev.user).toEqual({ id: "u1" });
  });
});

describe("calendar providers (slice 5 steps 6 and 8)", () => {
  it("the fake Google provider round-trips consent, free/busy, idempotent events and revocation", async () => {
    const { FakeGoogleCalendarProvider } = await import("./calendar/fake-google");
    const { CalendarError } = await import("./calendar/types");
    const cal = new FakeGoogleCalendarProvider({ apiBaseUrl: "http://localhost:3001" });
    const url = new URL(cal.authorizeUrl({ redirectTo: "http://localhost:3001/cb", state: "s", codeChallenge: "c" }));
    expect(url.pathname).toBe("/api/v1/integrations/calendar/fake/authorize");
    const code = cal.issueCode({ email: "Dana@Brightline.test", timeZone: "America/Los_Angeles" });
    const { refreshToken, account, scopes } = await cal.exchangeCode({ code, redirectTo: "http://localhost:3001/cb" });
    expect(account).toEqual({ email: "dana@brightline.test", calendarId: "dana@brightline.test", timeZone: "America/Los_Angeles" });
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    await expect(cal.exchangeCode({ code, redirectTo: "x" })).rejects.toBeInstanceOf(CalendarError); // single use
    cal.setBusy("dana@brightline.test", [{ start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T17:00:00.000Z" }]);
    const fb = await cal.freeBusy({ refreshToken }, { calendarIds: ["dana@brightline.test"], range: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" } });
    expect(fb["dana@brightline.test"]).toHaveLength(1);
    const input = { idempotencyKey: "interview:1:1:u", title: "Interview", description: "d", start: "2026-09-21T18:00:00.000Z", end: "2026-09-21T18:45:00.000Z", timeZone: "America/Los_Angeles", attendees: [{ email: "dana@brightline.test" }], conference: "auto" as const };
    const a = await cal.createEvent({ refreshToken }, "dana@brightline.test", input);
    const b = await cal.createEvent({ refreshToken }, "dana@brightline.test", input);
    expect(b.eventId).toBe(a.eventId); // duplicate protection
    expect(a.meetingUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect((await cal.freeBusy({ refreshToken }, { calendarIds: ["dana@brightline.test"], range: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-22T00:00:00.000Z" } }))["dana@brightline.test"]).toHaveLength(2);
    await cal.cancelEvent({ refreshToken }, a);
    await cal.cancelEvent({ refreshToken }, a); // idempotent
    expect(cal.eventsFor("dana@brightline.test")[0].status).toBe("cancelled");
    cal.failNext("rate_limited");
    await expect(cal.probe({ refreshToken }, "dana@brightline.test")).resolves.toMatchObject({ ok: false, code: "rate_limited" });
    expect(await cal.probe({ refreshToken }, "dana@brightline.test")).toMatchObject({ ok: true });
    await cal.revoke({ refreshToken });
    await expect(cal.freeBusy({ refreshToken }, { calendarIds: ["x"], range: { start: "a", end: "b" } })).rejects.toMatchObject({ code: "auth_revoked" });
  });

  it("the real Google provider speaks the documented endpoints with narrow scopes and never persists tokens", async () => {
    const { GoogleCalendarProvider } = await import("./calendar/google");
    const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null, auth: headers.authorization ?? null });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.fakeaccess", refresh_token: "1//0fakerefresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy" }));
      const method = init?.method ?? "GET";
      if (url.endsWith("/calendars/primary") && method === "GET") return new Response(JSON.stringify({ id: "dana@example.com", timeZone: "America/New_York", summary: "Dana" }));
      if (url.includes("/userinfo")) return new Response(JSON.stringify({ email: "dana@example.com" }));
      if (url.includes("/freeBusy")) return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: "2026-09-21T13:00:00Z", end: "2026-09-21T14:00:00Z" }] } } }));
      if (url.includes("/events?") && method === "GET") return new Response(JSON.stringify({ items: [] }));
      if (url.includes("/events") && method === "POST") return new Response(JSON.stringify({ id: "evt1", iCalUID: "evt1@google.com", htmlLink: "https://calendar.google.com/e/1", hangoutLink: "https://meet.google.com/xyz" }));
      if (url.includes("/events/evt1") && method === "DELETE") return new Response(null, { status: 204 });
      if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("{}");
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const g = new GoogleCalendarProvider({ clientId: "cid", clientSecret: "csecret", fetch: fakeFetch });
    expect(g.status).toBe("live");
    const auth = new URL(g.authorizeUrl({ redirectTo: "https://recruiting.identifiedtalent.com/api/v1/integrations/calendar/google/callback", state: "st", codeChallenge: "cc" }));
    expect(auth.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    const ex = await g.exchangeCode({ code: "4/0code", redirectTo: "https://recruiting.identifiedtalent.com/cb", codeVerifier: "v" });
    expect(ex.refreshToken).toBe("1//0fakerefresh");
    expect(ex.account).toMatchObject({ email: "dana@example.com", calendarId: "primary", timeZone: "America/New_York" });
    const fb = await g.freeBusy({ refreshToken: "1//0fakerefresh" }, { calendarIds: ["primary"], range: { start: "2026-09-21T00:00:00Z", end: "2026-09-22T00:00:00Z" } });
    expect(fb.primary).toEqual([{ start: "2026-09-21T13:00:00.000Z", end: "2026-09-21T14:00:00.000Z" }]);
    const ref = await g.createEvent({ refreshToken: "1//0fakerefresh" }, "primary", { idempotencyKey: "interview:1:1:u", title: "t", description: "d", start: "2026-09-21T15:00:00Z", end: "2026-09-21T15:45:00Z", timeZone: "America/New_York", attendees: [{ email: "c@example.com" }], conference: "auto" });
    expect(ref.meetingUrl).toBe("https://meet.google.com/xyz");
    const create = calls.find((c) => c.method === "POST" && c.url.includes("/events"))!;
    expect(create.url).toContain("conferenceDataVersion=1");
    expect(JSON.parse(create.body!)).toMatchObject({ extendedProperties: { private: { rosKey: "interview:1:1:u" } }, guestsCanInviteOthers: false });
    await g.cancelEvent({ refreshToken: "1//0fakerefresh" }, ref);
    expect(await g.revoke({ refreshToken: "1//0fakerefresh" })).toEqual({ ok: true });
    // the token exchange happened once for exchange and was reused from memory for the API calls
    expect(calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token")).length).toBe(1);
    for (const c of calls) if (c.auth) expect(c.auth).toBe("Bearer ya29.fakeaccess");
  });
});
