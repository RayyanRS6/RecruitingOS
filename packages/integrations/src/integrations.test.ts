import { describe, expect, it } from "vitest";
import { FakeEmailAdapter } from "./email/fake";

describe("fake email adapter", () => {
  it("sends every message it is asked to, like the real provider, and can simulate outages", async () => {
    const e = new FakeEmailAdapter();
    e.failNext(1);
    const first = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    expect(first.status).toBe("failed");
    const second = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    const third = await e.send({ to: "a@b.c", from: "x@y.z", subject: "s", text: "t", idempotencyKey: "k1" });
    expect(second.status).toBe("sent");
    expect(third.status).toBe("sent");
    // the adapter does not hide a repeated send behind the key; the outbox is what prevents duplicates
    expect(e.sent).toHaveLength(2);
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
      request: { url: "https://recruiting.identifiedtalent.com/api/v1/auth/callback?code=4/0Afake&state=s1", headers: { authorization: "Bearer abc", cookie: "ros_session=xyz", "user-agent": "test" }, cookies: { ros_session: "xyz" }, data: { refresh_token: token } },
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

  it("removes addresses and phone numbers written in the words and in breadcrumbs, and leaves ids alone (audit OPS-2)", async () => {
    const { scrubObservabilityEvent } = await import("./observability/sentry");
    const jobId = "0192f0a1-7b3c-7def-8123-456789012345";
    const ev = scrubObservabilityEvent({
      message: "could not deliver to jane.doe@example.com",
      exception: { values: [{ type: "Error", value: "the provider refused +1 415 555 0134 for jane.doe@example.com" }] },
      breadcrumbs: [{ message: "[outbox] could not deliver to (415) 555-0134", data: { arguments: ["to", { to: "jane.doe@example.com" }] } }],
      extra: { jobId },
    });
    const text = JSON.stringify(ev);
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).not.toContain("555");
    expect(ev.message).toBe("could not deliver to [redacted]");
    expect(ev.exception!.values![0].value).toBe("the provider refused [redacted] for [redacted]");
    expect(ev.breadcrumbs).toEqual([{ message: "[outbox] could not deliver to [redacted]", data: { arguments: ["to", { to: "[redacted]" }] } }]);
    expect(ev.extra).toEqual({ jobId });
  });
});
