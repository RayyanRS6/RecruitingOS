import { describe, expect, it, vi, type MockInstance } from "vitest";
import type { DbHandle } from "@ros/db";
import { createContainer } from "./container";

/** The pool createDb opened for the start below, with its close() watched; the start then fails at seeding. */
const boot = vi.hoisted(() => ({ close: undefined as MockInstance<DbHandle["close"]> | undefined }));
vi.mock("@ros/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ros/db")>();
  return {
    ...actual,
    createDb: vi.fn(async (...args: Parameters<typeof actual.createDb>) => {
      const handle = await actual.createDb(...args);
      boot.close = vi.spyOn(handle, "close");
      return handle;
    }),
    seedPlatform: vi.fn(async () => {
      throw new Error("boom");
    }),
  };
});

/**
 * The shell retries a start that failed on the next request (apps/shell/lib/container.ts). A start that fails after
 * the pool exists must close it, or every retry leaves a pool behind that may hold a session-pooler slot no request
 * will ever give back (the 12 Oct 2026 staging incident).
 */
describe("a start that fails after the database pool exists", () => {
  it("closes the pool and reports the failure", async () => {
    await expect(createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } })).rejects.toThrow("boom");
    expect(boot.close).toBeDefined();
    expect(boot.close).toHaveBeenCalledTimes(1);
  });
});
