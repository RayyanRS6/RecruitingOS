import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  /**
   * What the service does when Microsoft, or the service itself, says no (Supabase Auth's redirectErrors and
   * getErrorQueryString, internal/api/external.go): `error` and `error_description`, and `error_code` for the service's
   * own refusals only (Microsoft's pass through without one, and without its error_subcode), are set on redirect_to's
   * query, which keeps its own parameters (this browser's state), and copied into the fragment with an empty `sb`.
   * There is no code. A browser sends the query and keeps the fragment.
   */
  const serviceRefuses = (authorizeLocation: string, refusal: { error: string; error_description: string; error_code?: string }) => {
    const back = new URL(new URL(authorizeLocation).searchParams.get("redirect_to")!);
    const fragment = new URLSearchParams();
    for (const [key, value] of Object.entries(refusal)) {
      if (value === undefined) continue;
      back.searchParams.set(key, value);
      fragment.set(key, value);
    }
    back.searchParams.sort();
    fragment.set("sb", "");
    fragment.sort();
    back.hash = fragment.toString();
    return back;
  };
  /** Microsoft's description as it comes: the AADSTS number, the reason, then lines that identify the request. */
  const microsoftSays = (aadsts: string, reason: string) => `${aadsts}: ${reason}\r\nTrace ID: 00000000-0000-0000-0000-000000000000\r\nCorrelation ID: 00000000-0000-0000-0000-000000000000\r\nTimestamp: 2026-11-10 09:00:00Z`;
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

  it("refuses a return from an account that does not hold the provider this browser started with (audit SEC-8)", async () => {
    // Started with Microsoft; the authorize address was changed on the way and the service answers for a Google-only account.
    const start = await app.request("/api/v1/auth/start/azure");
    const back = serviceReturns(start.headers.get("location")!, "code-3");
    const refused = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: cookieOf(start) } });
    expect(refused.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/login?error=provider_mismatch`);
    expect(refused.headers.get("set-cookie") ?? "").not.toContain("ros_session=");
  });

  /**
   * Microsoft sign-in for people from other companies (10 November 2026): a refusal the service brings back reaches the
   * sign-in page as a code it has words for. The address ends with `#`, so the browser drops the service's copy of the
   * refusal (the fragment) instead of carrying it onto the page, and Microsoft's description is never shown, kept or
   * put in an address: the one log line has the code and the bare AADSTS number.
   */
  it.each([
    { said: "an administrator must approve the app first (AADSTS90094)", refusal: { error: "access_denied", error_description: microsoftSays("AADSTS90094", "Admin consent is required for the permissions requested by this application.") }, code: "microsoft_needs_approval", aadsts: "AADSTS90094" },
    { said: "Cancel was pressed on Microsoft's permissions screen (AADSTS65004)", refusal: { error: "access_denied", error_description: microsoftSays("AADSTS65004", "User declined to consent to access the app.") }, code: "microsoft_declined", aadsts: "AADSTS65004" },
    { said: "the service does not trust the address Microsoft sent (provider_email_needs_verification)", refusal: { error: "access_denied", error_code: "provider_email_needs_verification", error_description: "Unverified email with azure. A confirmation email has been sent to your azure email" }, code: "email_unverified", aadsts: null },
    { said: "Microsoft sent no email address", refusal: { error: "server_error", error_code: "unexpected_failure", error_description: "Error getting user email from external provider" }, code: "microsoft_no_email", aadsts: null },
    { said: "a refusal with no words of its own (sign-ups switched off at the service)", refusal: { error: "access_denied", error_code: "signup_disabled", error_description: "Signups not allowed for this instance" }, code: "signin_incomplete", aadsts: null },
  ])("a refusal opens no session and reaches the sign-in page as its code, never as Microsoft's words: $said", async ({ refusal, code, aadsts }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const start = await app.request("/api/v1/auth/start/azure");
      const back = serviceRefuses(start.headers.get("location")!, refusal);
      expect(back.searchParams.get("state")).toBeTruthy();
      const refused = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: cookieOf(start) } });
      expect(refused.status).toBe(302);
      const location = refused.headers.get("location")!;
      expect(location).toBe(`${container.env.APP_BASE_URL}/login?error=${code}#`);
      expect(location.endsWith("#")).toBe(true);
      const reason = refusal.error_description.split("\r\n")[0]!;
      expect(decodeURIComponent(location.replace(/\+/g, " "))).not.toContain(reason);
      expect(refused.headers.get("set-cookie") ?? "").not.toContain("ros_session=");
      expect(refused.headers.getSetCookie()).toContainEqual(expect.stringMatching(/^ros_pkce=; Max-Age=0/));
      const logged = warn.mock.calls.map((args) => args.join(" ")).filter((line) => line.startsWith("[sign-in]"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(code);
      if (aadsts) expect(logged[0]).toContain(aadsts);
      expect(logged[0]).not.toContain(reason);
    } finally {
      warn.mockRestore();
    }
  });

  it("a refusal during \"Confirm it's you\" goes back where it started with reauth=failed, as its other failures do, both of its cookies cleared", async () => {
    const start = await app.request("/api/v1/auth/start/google");
    const returned = serviceReturns(start.headers.get("location")!, "code-4");
    const signedIn = await app.request(`${returned.pathname}${returned.search}`, { headers: { cookie: cookieOf(start) } });
    const session = signedIn.headers.getSetCookie().find((c) => c.startsWith("ros_session="))!.split(";")[0]!;
    const begin = await app.request("/api/v1/auth/reauth/start", { method: "POST", headers: { cookie: session, "content-type": "application/json" }, body: JSON.stringify({ returnTo: "/setup" }) });
    const { url } = (await begin.json()) as { url: string };
    const flow = begin.headers.getSetCookie().map((c) => c.split(";")[0]!);
    expect(flow).toEqual(expect.arrayContaining([expect.stringMatching(/^ros_pkce=./), expect.stringMatching(/^ros_reauth=./)]));
    const back = serviceRefuses(url, { error: "access_denied", error_description: microsoftSays("AADSTS65004", "User declined to consent to access the app.") });
    const refused = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: [session, ...flow].join("; ") } });
    expect(refused.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=failed#`);
    expect(refused.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringMatching(/^ros_reauth=; Max-Age=0/), expect.stringMatching(/^ros_pkce=; Max-Age=0/)]));
    expect(refused.headers.get("set-cookie") ?? "").not.toContain("ros_session=");
  });
});
