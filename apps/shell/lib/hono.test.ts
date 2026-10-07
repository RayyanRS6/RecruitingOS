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
    // the tracked links, the sitemap and robots are Hono's too: an unknown token is the "not active" page, never Next.js's not-found
    const link = await honoHandler(new Request("http://localhost:3000/a/abcdefghijkl"));
    expect(link.status).toBe(404);
    expect(await link.text()).toContain("This link is not active");
    const sitemap = await honoHandler(new Request("http://localhost:3000/sitemap.xml"));
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("xml");
    const robots = await honoHandler(new Request("http://localhost:3000/robots.txt"));
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("Sitemap:");
  });

  it("every mounted path exports the HTTP methods Next.js expects", async () => {
    for (const p of ["api/[[...route]]", "careers/[[...route]]", "c/[[...route]]", "a/[[...route]]", "files/[[...route]]", "webhooks/[[...route]]", "feeds/[[...route]]", "dev/[[...route]]", "privacy", "healthz", "sitemap.xml", "robots.txt"]) {
      const mod = (await import(`../app/${p}/route`)) as Record<string, unknown>;
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) expect(typeof mod[m], `${p} ${m}`).toBe("function");
      expect(mod.runtime).toBe("nodejs");
      expect(mod.dynamic).toBe("force-dynamic");
    }
  });

  it("the application's content-security middleware leaves every mounted Hono path alone and still covers the pages", async () => {
    const { config } = (await import("../middleware")) as { config: { matcher: string[] } };
    const covered = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/a/abcdefghijkl", "/sitemap.xml", "/robots.txt", "/files/put/x", "/careers/brightline", "/c/status/x", "/api/v1/auth/me", "/feeds/jobs.xml", "/webhooks/postmark/inbound", "/healthz", "/privacy", "/fonts/ibm-plex-sans-latin-400-normal.woff2"]) expect(covered.test(path), path).toBe(false);
    for (const path of ["/", "/roles/123", "/admin", "/about", "/setup", "/fontsize"]) expect(covered.test(path), path).toBe(true);
  });

  it("serves the self-hosted font files with a year-long cache", async () => {
    const { default: config } = (await import("../next.config")) as { default: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> } };
    const fonts = (await config.headers()).find((h) => h.source === "/fonts/:file*");
    expect(fonts?.headers).toContainEqual({ key: "Cache-Control", value: "public, max-age=31536000, immutable" });
  });
});
