import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Cross-site requests to the API (security review, 11 October 2026; middleware/same-site.ts): a change under /api that
 * the browser says came from another site, or from an address other than the deployment's own, is refused before
 * anything is read. Reads, callers that are not browsers, and the deployment's own pages pass.
 */
const APP = "https://app.example.test";
const JOBS = "https://jobs.example.test";
const EVIL = "https://evil.example";

describe("cross-site changes to the API", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  /** One signed-in person for the checks that leave the session open. */
  let cookie = "";
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: APP, JOBS_BASE_URL: JOBS };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0]!;
  };
  const send = (jar: string, path: string, headers: Record<string, string> = {}, method = "POST") => app.request(path, { method, headers: { cookie: jar, "content-type": "application/json", ...headers }, body: "{}" });
  /** Harmless for the session: drops a carried invitation, if any, and answers ok. */
  const harmless = (jar: string, headers: Record<string, string> = {}) => send(jar, "/api/v1/auth/invite/forget", headers);
  const me = (jar: string) => app.request("/api/v1/auth/me", { headers: { cookie: jar } });
  const errorOf = async (r: Response) => ((await r.json()) as { error?: { code: string; message: string } }).error;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    cookie = await signIn("person@same-site.test");
  });
  afterAll(async () => {
    await container.close();
  });

  it("a post another site makes with the person's cookie is refused, in plain words, and changes nothing", async () => {
    const r = await send(cookie, "/api/v1/auth/logout", { "sec-fetch-site": "cross-site", origin: EVIL });
    expect(r.status).toBe(403);
    const error = await errorOf(r);
    expect(error?.code).toBe("cross_site");
    expect(error?.message).toMatch(/another website, so nothing was changed/);
    // Sec-Fetch-Site alone is enough
    expect((await send(cookie, "/api/v1/auth/logout", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await me(cookie)).status).toBe(200);
  });

  it("covers every kind of change, before any route is looked up", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await send(cookie, "/api/v1/companies/current", { "sec-fetch-site": "cross-site" }, method);
      expect(r.status, method).toBe(403);
      expect((await errorOf(r))?.code).toBe("cross_site");
    }
  });

  it("a post from the app's own pages passes", async () => {
    const own = await signIn("own@same-site.test");
    expect((await harmless(own, { "sec-fetch-site": "same-origin", origin: APP })).status).toBe(200);
    // a browser that sends no fetch metadata still names the origin
    expect((await harmless(own, { origin: APP })).status).toBe(200);
    const out = await send(own, "/api/v1/auth/logout", { "sec-fetch-site": "same-origin", origin: APP });
    expect(out.status).toBe(200);
    expect((await me(own)).status).toBe(401);
  });

  it("a post with neither Origin nor Sec-Fetch-Site passes: callers that are not browsers, like the browser journeys' request helpers", async () => {
    const plain = await signIn("plain@same-site.test");
    expect((await harmless(plain)).status).toBe(200);
    expect((await send(plain, "/api/v1/auth/logout")).status).toBe(200);
    expect((await me(plain)).status).toBe(401);
  });

  it("a read is never refused", async () => {
    expect((await app.request("/api/v1/auth/me", { headers: { cookie, "sec-fetch-site": "cross-site", origin: EVIL } })).status).toBe(200);
    expect((await app.request("/api/v1/auth/config", { method: "HEAD", headers: { "sec-fetch-site": "cross-site", origin: EVIL } })).status).not.toBe(403);
  });

  it("an Origin other than the deployment's own is refused: another site, a sibling host, a lookalike, another scheme or port", async () => {
    for (const origin of [EVIL, "https://www.example.test", `${APP}.evil.example`, "http://app.example.test", "https://app.example.test:8443"]) {
      const r = await harmless(cookie, { origin });
      expect(r.status, origin).toBe(403);
      expect((await errorOf(r))?.code).toBe("cross_site");
    }
    // a sibling host is "same-site" to the browser and receives the Lax cookie; its Origin still gives it away
    expect((await harmless(cookie, { "sec-fetch-site": "same-site", origin: "https://www.example.test" })).status).toBe(403);
    // a value the check does not know is not trusted
    expect((await harmless(cookie, { "sec-fetch-site": "bogus" })).status).toBe(403);
  });

  it("the job-page host is the deployment's own: its pages' policy reports are accepted", async () => {
    for (const origin of [JOBS, APP]) expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report", "sec-fetch-site": "same-origin", origin }, body: "{}" })).status, origin).toBe(204);
    expect((await app.request("/api/csp-report", { method: "POST", headers: { "content-type": "application/csp-report", "sec-fetch-site": "cross-site", origin: EVIL }, body: "{}" })).status).toBe(403);
  });

  it("an opaque origin (Origin: null) passes only when the browser says the post came from the deployment's own page", async () => {
    expect((await harmless(cookie, { "sec-fetch-site": "same-origin", origin: "null" })).status).toBe(200);
    // a sibling host or another site hiding its origin
    expect((await harmless(cookie, { "sec-fetch-site": "same-site", origin: "null" })).status).toBe(403);
    expect((await harmless(cookie, { "sec-fetch-site": "cross-site", origin: "null" })).status).toBe(403);
    // a browser without fetch metadata (Safari before 16.4) posting from a sandboxed frame or a no-referrer page on a
    // sibling host: it sends the Lax cookie and Origin: null, and nothing says where it came from, so it is refused
    const r = await harmless(cookie, { origin: "null" });
    expect(r.status).toBe(403);
    expect((await errorOf(r))?.code).toBe("cross_site");
    expect((await send(cookie, "/api/v1/auth/logout", { origin: "null" })).status).toBe(403);
    expect((await me(cookie)).status).toBe(200);
  });

  it("the API's own form pages keep their real origin on their posts (Referrer-Policy: same-origin); everything else keeps no-referrer", async () => {
    const policy = async (path: string) => (await app.request(path, { headers: { cookie } })).headers.get("referrer-policy");
    // the sign-in link, the invitation, the second factor (no step open: a redirect, same header), the development consent pages
    for (const path of ["/api/v1/auth/consume?token=t", "/api/v1/auth/invite?token=t", "/api/v1/auth/mfa", "/api/v1/auth/mfa/backup", "/api/v1/auth/fake/authorize?provider=google", "/api/v1/integrations/calendar/fake/authorize"]) {
      expect(await policy(path), path).toBe("same-origin");
    }
    // the page the invitation's own form answers with
    const posted = await app.request("/api/v1/auth/invite/email", { method: "POST", headers: { cookie, "sec-fetch-site": "same-origin", origin: APP, "content-type": "application/x-www-form-urlencoded" }, body: "token=t" });
    expect(posted.headers.get("referrer-policy")).toBe("same-origin");
    for (const path of ["/api/v1/auth/me", "/api/v1/auth/config", "/privacy", "/api/v1/auth/consumed", "/api/v1/auth/mfa-other"]) expect(await policy(path), path).toBe("no-referrer");
  });

  it("webhooks are outside /api and keep their own checks", async () => {
    const r = await app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", origin: EVIL }, body: "{}" });
    expect(await r.text()).not.toContain("cross_site");
  });
});
