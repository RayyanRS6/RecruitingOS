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
  });

  it("every mounted path exports the HTTP methods Next.js expects", async () => {
    for (const p of ["api/[[...route]]", "careers/[[...route]]", "c/[[...route]]", "webhooks/[[...route]]", "feeds/[[...route]]", "dev/[[...route]]", "privacy", "healthz"]) {
      const mod = (await import(`../app/${p}/route`)) as Record<string, unknown>;
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) expect(typeof mod[m], `${p} ${m}`).toBe("function");
      expect(mod.runtime).toBe("nodejs");
      expect(mod.dynamic).toBe("force-dynamic");
    }
  });
});
