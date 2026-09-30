import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAlerts } from "@ros/db";
import { createContainer, type Container } from "./container";
import { checkScannerForProduction } from "./scanner-gate";

/**
 * OPS brief item 4, the real-data gate for résumé scanning: a production worker running the fake malware scanner warns
 * and raises one `scanner.fake` alert; nothing is raised for the app process, outside production, or with a real engine.
 */
describe("the fake-scanner gate at boot", () => {
  let container: Container;
  const alerts = async () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "scanner.fake"));
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("raises nothing for the app, outside production, or with a real engine", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await checkScannerForProduction(container.db, { nodeEnv: "production", role: "app", scannerStatus: "fake", scannerId: "fake" })).toEqual({ raised: false });
      expect(await checkScannerForProduction(container.db, { nodeEnv: "test", role: "worker", scannerStatus: "fake", scannerId: "fake" })).toEqual({ raised: false });
      expect(await checkScannerForProduction(container.db, { nodeEnv: "development", role: "worker", scannerStatus: "fake", scannerId: "fake" })).toEqual({ raised: false });
      expect(await checkScannerForProduction(container.db, { nodeEnv: "production", role: "worker", scannerStatus: "live", scannerId: "clamav" })).toEqual({ raised: false });
      expect(await alerts()).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a production worker on the fake scanner warns and raises one standing alert; a second boot raises nothing more", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await checkScannerForProduction(container.db, { nodeEnv: "production", role: "worker", scannerStatus: "fake", scannerId: "fake" })).toEqual({ raised: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fake malware scanner"));
      const raised = await alerts();
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ severity: "high", status: "open", title: "Résumé scanning is the fake engine" });
      expect(raised[0].body).toContain("SCAN_PROVIDER=clamav");
      expect(raised[0].details).toMatchObject({ provider: "fake" });
      expect(await checkScannerForProduction(container.db, { nodeEnv: "production", role: "worker", scannerStatus: "fake", scannerId: "fake" })).toEqual({ raised: false });
      expect(await alerts()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
