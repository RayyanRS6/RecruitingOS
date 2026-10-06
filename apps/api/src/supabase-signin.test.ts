import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHs256, SupabaseIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The real identity service (Supabase Auth) keeps its own state with Google or Microsoft and sends the browser back to
 * redirect_to with only `code` added, keeping the address's own query. Found on staging, 7 October 2026: the
 * application's state went out as a separate parameter the service ignores, so every real sign-in ended in
 * "signin_incomplete". The fake issuer hands state back itself, so only a test shaped like the service catches this.
 */
describe("sign-in through the identity service's return trip", () => {
  const serviceUrl = "https://project.supabase.test";
  const jwtSecret = "supabase-jwt-secret-for-this-test";
  const issued = new Map<string, string>();
  let container: Container;
  let app: ReturnType<typeof createApp>;

  /** The service's token endpoint: a code is good once, and only with the verifier behind its challenge. */
  const serviceFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "pkce") return new Response("not found", { status: 404 });
    const { auth_code, code_verifier } = JSON.parse(String(init?.body)) as { auth_code: string; code_verifier: string };
    const challenge = issued.get(auth_code);
    issued.delete(auth_code);
    if (!challenge || createHash("sha256").update(code_verifier).digest("base64url") !== challenge) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const access_token = signHs256({
      iss: `${serviceUrl}/auth/v1`, sub: "google-subject-1", aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600,
      email: "first.customer@example.com", aal: "aal1", amr: [{ method: "oauth", timestamp: now }], session_id: "service-session-1",
      app_metadata: { provider: "google", providers: ["google"] }, user_metadata: { full_name: "First Customer", email_verified: true },
    }, jwtSecret);
    return new Response(JSON.stringify({ access_token }), { status: 200, headers: { "content-type": "application/json" } });
  };

  /** What the service does once the provider says yes: a code bound to the challenge, added to redirect_to. */
  const serviceReturns = (authorizeLocation: string, code: string) => {
    const authorize = new URL(authorizeLocation);
    issued.set(code, authorize.searchParams.get("code_challenge")!);
    const back = new URL(authorize.searchParams.get("redirect_to")!);
    back.searchParams.set("code", code);
    return back;
  };
  const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    container.integrations.identity = new SupabaseIdentityProvider({ url: serviceUrl, anonKey: "sb_publishable_test", jwtSecret, providers: ["azure", "google"], fetch: serviceFetch });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("comes back to the callback with this browser's state, and a first-time customer is sent to create their company", async () => {
    const start = await app.request("/api/v1/auth/start/google");
    expect(start.status).toBe(302);
    const location = start.headers.get("location")!;
    expect(location.startsWith(`${serviceUrl}/auth/v1/authorize?`)).toBe(true);
    const back = serviceReturns(location, "code-1");
    expect(`${back.origin}${back.pathname}`).toBe(`${container.env.APP_BASE_URL}/api/v1/auth/callback`);
    const done = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: cookieOf(start) } });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect(done.headers.get("set-cookie") ?? "").toContain("ros_session=");
  });

  it("refuses a return carrying another browser's state", async () => {
    const mine = await app.request("/api/v1/auth/start/google");
    const theirs = await app.request("/api/v1/auth/start/google");
    const back = serviceReturns(theirs.headers.get("location")!, "code-2");
    const refused = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: cookieOf(mine) } });
    expect(refused.headers.get("location")).toContain("/login?error=signin_incomplete");
  });
});
