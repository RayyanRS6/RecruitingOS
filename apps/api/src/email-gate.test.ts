import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAlerts, type Db } from "@ros/db";
import { createIntegrations } from "@ros/integrations";
import { createContainer, type Container } from "./container";
import { checkEmailForProduction } from "./email-gate";

/**
 * Staging ran with EMAIL_PROVIDER=fake and nothing said so: the company check to ITS and every candidate email went
 * nowhere while the pages said they were sent. Production on the fake email adapter now warns at every boot and raises
 * one standing `email.fake` alert, from whichever process boots first; nothing is raised outside production or with
 * Postmark, and a failure to raise never stops the boot.
 */
describe("the fake-email gate at boot", () => {
  let container: Container;
  const alerts = async () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "email.fake"));
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("keys off the adapter in use: anything but postmark is the fake, which reports itself as fake", () => {
    const status = (EMAIL_PROVIDER: string | undefined) => createIntegrations({ EMAIL_PROVIDER, COMP_BLS_ENABLED: "false" }, { memoryStorage: true }).email.status;
    expect(status("fake")).toBe("fake");
    expect(status(undefined)).toBe("fake");
    expect(status("postmrk")).toBe("fake");
    expect(status("postmark")).not.toBe("fake");
    // the test container's own adapter, which the boot passes to the gate
    expect(container.integrations.email.status).toBe("fake");
  });

  it("raises nothing outside production or with a real adapter, and says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await checkEmailForProduction(container.db, { nodeEnv: "test", role: "app", emailStatus: "fake", emailId: "fake-email" })).toEqual({ raised: false });
      expect(await checkEmailForProduction(container.db, { nodeEnv: "development", role: "worker", emailStatus: "fake", emailId: "fake-email" })).toEqual({ raised: false });
      expect(await checkEmailForProduction(container.db, { nodeEnv: "production", role: "app", emailStatus: "live", emailId: "postmark" })).toEqual({ raised: false });
      expect(await checkEmailForProduction(container.db, { nodeEnv: "production", role: "worker", emailStatus: "not_connected", emailId: "postmark" })).toEqual({ raised: false });
      expect(await alerts()).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("production on the fake adapter warns and raises one standing alert in plain words; the other process's boot only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await checkEmailForProduction(container.db, { nodeEnv: "production", role: "app", emailStatus: "fake", emailId: "fake-email" })).toEqual({ raised: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fake email adapter on the app"));
      const raised = await alerts();
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ severity: "high", status: "open", title: "Emails are not being sent" });
      expect(raised[0].body).toContain("no email leaves the system");
      expect(raised[0].body).toContain("company check sent to ITS");
      expect(raised[0].body).toContain("Set up Postmark (to-do item 14");
      expect(raised[0].body).toContain("EMAIL_PROVIDER=postmark");
      expect(raised[0].details).toMatchObject({ provider: "fake-email", process: "app" });
      // the worker boots on the same deployment: it warns too, and the one alert stands
      expect(await checkEmailForProduction(container.db, { nodeEnv: "production", role: "worker", emailStatus: "fake", emailId: "fake-email" })).toEqual({ raised: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fake email adapter on the worker"));
      expect(await alerts()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a database that cannot take the alert is logged and never stops the boot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { select: () => { throw new Error("connection refused"); } } as unknown as Db;
    try {
      await expect(checkEmailForProduction(broken, { nodeEnv: "production", role: "app", emailStatus: "fake", emailId: "fake-email" })).resolves.toEqual({ raised: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not raise the alert: connection refused"));
    } finally {
      warn.mockRestore();
    }
  });
});
