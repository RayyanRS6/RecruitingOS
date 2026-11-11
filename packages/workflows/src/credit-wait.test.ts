import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_CREDIT_AVAILABLE } from "@ros/contracts";
import type { StepContext } from "./types";

/**
 * A step about to wait for AI credit. What each wait means in money is in apps/api/src/ai-credit.test.ts, which runs it through
 * the worker. PGlite has one connection, so no test can really run a Change plan beside this step: what can be held to is the
 * order, which is the whole of why the two take turns. The hold first, on the step's own transaction, and every read after it.
 */
const credit = vi.hoisted(() => ({ order: [] as string[], heldOn: [] as unknown[], asked: [] as unknown[], roomSoon: false, resetsAt: null as string | null }));
vi.mock("@ros/core", () => ({
  holdAiCreditRows: async (q: unknown, companyId: string) => { credit.order.push("hold"); credit.heldOn.push(q, companyId); },
  aiCreditRoomSoon: async (_q: unknown, input: unknown) => { credit.order.push("read"); credit.asked.push(input); return credit.roomSoon; },
  aiCreditResetsAt: async () => { credit.order.push("read the date"); return credit.resetsAt; },
}));
const { CREDIT_IN_FLIGHT_WAIT_MINUTES, CREDIT_WAIT_DAYS, waitForCredit } = await import("./credit-wait");

describe("a step about to wait for AI credit", () => {
  const now = new Date("2026-11-07T10:00:00.000Z");
  const q = { the: "step's own transaction" };
  const ctx = { q, companyId: "company-1", now } as unknown as StepContext<Record<string, unknown>>;
  /** The three readings' hold of about 6 cents, what was refused a moment ago. */
  const READINGS_USD = 0.06;

  beforeEach(() => {
    credit.order = [];
    credit.heldOn = [];
    credit.asked = [];
    credit.roomSoon = false;
    credit.resetsAt = null;
  });

  it("holds the credit's row first, on the step's own transaction, and only then reads: a Change plan in progress has finished by the read, or waits for this commit and then finds the run waiting", async () => {
    await waitForCredit(ctx, "assess", READINGS_USD);
    expect(credit.order[0]).toBe("hold");
    expect(credit.order.slice(1)).toEqual(["read", "read the date"]);
    expect(credit.heldOn).toEqual([q, "company-1"]);
    expect(credit.asked).toEqual([{ companyId: "company-1", holdUsd: READINGS_USD, now }]);
  });

  it("only money in flight: a look again in 15 minutes, on the same signal, and it says so", async () => {
    credit.roomSoon = true;
    const { roomSoon, wait } = await waitForCredit(ctx, "assess", READINGS_USD, { creditWaitSince: "2026-11-07T09:00:00.000Z" });
    expect(roomSoon).toBe(true);
    expect(CREDIT_IN_FLIGHT_WAIT_MINUTES).toBe(15);
    expect(wait).toEqual({
      kind: "wait",
      wait: { kind: "event", eventTypes: [AI_CREDIT_AVAILABLE], until: "2026-11-07T10:15:00.000Z", reason: "only money held for AI work still running stands in the way: this looks again in a few minutes" },
      state: { creditWaitSince: "2026-11-07T09:00:00.000Z" },
      resumeStep: "assess",
    });
  });

  it("really gone on a monthly plan: to the day the month starts again, in the used-up words", async () => {
    credit.resetsAt = "2026-12-05T10:00:00.000Z";
    const { roomSoon, wait } = await waitForCredit(ctx, "extract", READINGS_USD);
    expect(roomSoon).toBe(false);
    expect(wait).toEqual({
      kind: "wait",
      wait: { kind: "event", eventTypes: [AI_CREDIT_AVAILABLE], until: "2026-12-05T10:00:00.000Z", reason: "the company's AI credit is used up: this goes on after a change of plan, or when a monthly credit starts again" },
      resumeStep: "extract",
    });
  });

  it("really gone on a credit that never starts again: it looks again in 30 days all the same", async () => {
    const { wait } = await waitForCredit(ctx, "assess", READINGS_USD);
    expect(CREDIT_WAIT_DAYS).toBe(30);
    expect(wait).toMatchObject({ wait: { until: "2026-12-07T10:00:00.000Z" } });
  });
});
