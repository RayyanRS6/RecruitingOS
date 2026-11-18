import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainer, type Container } from "@ros/api/src/container";
import { installShellForTests } from "./container";
import { honoHandler } from "./hono";

/** Decision D20: the Hono API and candidate pages are mounted unchanged under the Next.js route handlers. */
describe("the Next.js shell mounts the Hono application", () => {
  let container: Container;
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    installShellForTests(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("serves the API, the health check and the candidate pages through one handler", async () => {
    const cfg = await honoHandler(new Request("http://localhost:3000/api/v1/auth/config"));
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { providers: unknown[] }).providers.length).toBeGreaterThan(0);
    const health = await honoHandler(new Request("http://localhost:3000/healthz"));
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    const missing = await honoHandler(new Request("http://localhost:3000/careers/nobody/jobs/00000000-0000-0000-0000-000000000000"));
    expect(missing.status).toBe(404);
    const me = await honoHandler(new Request("http://localhost:3000/api/v1/auth/me"));
    expect(me.status).toBe(401);
    // the sitemap and robots are Hono's too
    const sitemap = await honoHandler(new Request("http://localhost:3000/sitemap.xml"));
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("xml");
    const robots = await honoHandler(new Request("http://localhost:3000/robots.txt"));
    expect(robots.status).toBe(200);
    // Hono's robots file; outside the production deployment it keeps every crawler out and names no sitemap (GAP3-3)
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("every mounted path exports the HTTP methods Next.js expects, and the mounts are exactly the ones the API still serves", async () => {
    const mounted = ["api/[[...route]]", "careers/[[...route]]", "c/[[...route]]", "files/[[...route]]", "webhooks/[[...route]]", "dev/[[...route]]", "privacy", "healthz", "sitemap.xml", "robots.txt"];
    for (const p of mounted) {
      const mod = (await import(`../app/${p}/route`)) as Record<string, unknown>;
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) expect(typeof mod[m], `${p} ${m}`).toBe("function");
      expect(mod.runtime).toBe("nodejs");
      expect(mod.dynamic).toBe("force-dynamic");
    }
    // nothing else is handed to Hono: tracked links (/a/) and the job feeds (/feeds/) are gone with their endpoints
    const routes = readdirSync(new URL("../app/", import.meta.url), { recursive: true, encoding: "utf8" }).map((f) => f.replace(/\\/g, "/")).filter((f) => f.endsWith("/route.ts")).map((f) => f.slice(0, -"/route.ts".length));
    expect(routes.sort()).toEqual([...mounted].sort());
  });

  it("the application's content-security middleware leaves every mounted Hono path alone and still covers the pages", async () => {
    const { config } = (await import("../middleware")) as { config: { matcher: string[] } };
    const covered = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/sitemap.xml", "/robots.txt", "/files/put/x", "/careers/brightline", "/c/status/x", "/api/v1/auth/me", "/webhooks/postmark/bounces", "/dev/outbox", "/healthz", "/privacy", "/fonts/ibm-plex-sans-latin-400-normal.woff2"]) expect(covered.test(path), path).toBe(false);
    for (const path of ["/", "/roles/123", "/admin", "/about", "/setup", "/fontsize"]) expect(covered.test(path), path).toBe(true);
    // /admin/privacy is a page of the application, not the mounted /privacy; an address of a removed mount is a page like any other (the not-found page)
    for (const path of ["/admin/privacy", "/admin/system", "/a/abcdefghijkl", "/feeds/jobs.xml"]) expect(covered.test(path), path).toBe(true);
  });

  it("serves the self-hosted font files with a year-long cache", async () => {
    const { default: config } = (await import("../next.config")) as { default: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> } };
    const fonts = (await config.headers()).find((h) => h.source === "/fonts/:file*");
    expect(fonts?.headers).toContainEqual({ key: "Cache-Control", value: "public, max-age=31536000, immutable" });
  });
});
