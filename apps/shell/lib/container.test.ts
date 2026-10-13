import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { after } from "next/server";
import { createContainer, type Container } from "@ros/api/src/container";
import { getShellForRequest, installShellForTests } from "./container";
import { honoHandler } from "./hono";
import { getMe } from "./session";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
// getMe reads the session cookie; any cookie makes it ask the API, which answers 401 for this unknown one.
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [{ name: "s", value: "x" }] }) }));

/**
 * The 12 Oct 2026 staging incident: Vercel suspends an instance once its requests end and its timers stop, so the
 * pool's idle connections stayed open on the session pooler. Every request now hands Next.js a task that keeps it
 * alive until the pool has closed them.
 */
describe("each request waits for the database pool to give its connections back", () => {
  let container: Container;
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    installShellForTests(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("registers one after() task per request, and the task waits until the pool is idle", async () => {
    const registered = vi.mocked(after);
    registered.mockClear();
    const shell = await getShellForRequest();
    expect(shell.container).toBe(container);
    expect(registered).toHaveBeenCalledTimes(1);
    const task = registered.mock.calls[0][0];
    expect(typeof task).toBe("function");
    const whenIdle = vi.spyOn(container.handle, "whenIdle");
    try {
      await (task as () => Promise<void>)();
      expect(whenIdle).toHaveBeenCalledTimes(1);
    } finally {
      whenIdle.mockRestore();
    }
  });

  it("route handlers (honoHandler) and getMe take the container through getShellForRequest, never getShell", async () => {
    // hono.test.ts passes either way (the real after() throws outside a request and that is swallowed), so this is the
    // check that a route handler or the page function still waits for the pool before Vercel suspends the instance.
    const registered = vi.mocked(after);
    registered.mockClear();
    const res = await honoHandler(new Request("http://shell.local/api/v1/auth/config"));
    expect(res.status).toBe(200);
    expect(registered).toHaveBeenCalledTimes(1);
    registered.mockClear();
    expect(await getMe()).toBeNull();
    expect(registered).toHaveBeenCalledTimes(1);
  });

  it("outside a Next.js request (after() throws) the container is still handed out", async () => {
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const shell = await getShellForRequest();
    expect(shell.container).toBe(container);
  });
});
