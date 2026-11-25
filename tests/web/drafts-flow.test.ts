import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IntakeDraftAnswer, IntakeSessionResponse, IntakeStartResponse } from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
import { createContainer, type Container } from "../../apps/api/src/container";
import { seedCompany, usePlan } from "../../apps/api/src/test-helpers";
import { todayIn } from "../../apps/web/src/dates";
import { closingDateProblem } from "../../apps/web/src/jobs";

/**
 * A draft of the job builder as its pages read it, the pages and the API together on the stand-in AI: what the API
 * answers about a draft is handed to the pages' own helpers (apps/web/src), so a rule kept on both sides is held to one
 * answer. For the small rules that were once decided twice: what "today" is for a draft's closing date.
 */
describe("a draft, as its pages and the API read it together", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  /** The engine's clock, which the API reads "now" from; each test sets it. */
  let clock = new Date("2026-11-18T18:00:00.000Z");
  const sessions = "/api/v1/intake/sessions";
  const send = async <T>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  /** An owner's first sentence with every essential in it, the pay typed by them. */
  const HYGIENIST = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  /** A draft started with these words, as the builder's first box sends them: the draft, and the company's time zone beside it. */
  const start = async (cookie: string, words: string): Promise<IntakeDraftAnswer> => {
    const started = await send<IntakeStartResponse>(cookie, "POST", sessions, { initialMessage: words });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    if (!started.body.session) throw new Error("no draft was started");
    return { session: started.body.session, timeZone: started.body.timeZone };
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, now: () => clock, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    // a company on the East Coast: its day ends hours before a device set to UTC, and hours after one in Los Angeles
    const made = await seedCompany(app, { email: "owner@drafts.test", name: "Harbor Dental", timezone: "America/New_York" });
    owner = made.owner;
    await usePlan(container, made.companyId, "ultra");
  });
  afterAll(async () => {
    await container.close();
  });

  it("counts today for a draft's closing date in the company's time zone on both sides: the earliest day the page offers is one the server takes", async () => {
    // half past eleven at night on 18 November in New York; already the 19th on a device set to UTC
    clock = new Date("2026-11-19T04:30:00.000Z");
    const { session: draft, timeZone } = await start(owner, HYGIENIST);
    expect(timeZone).toBe("America/New_York");
    const today = todayIn(timeZone, clock);
    expect(today).toBe("2026-11-18");
    // the page lets that day through, and the server takes it; its answer carries the time zone again
    expect(closingDateProblem(today, timeZone, clock)).toBeNull();
    const set = await send<IntakeSessionResponse>(owner, "PUT", `${sessions}/${draft.id}/closing-date`, { closesOn: today });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ session: { closesOn: today }, timeZone: "America/New_York" });
    expect((await send<IntakeSessionResponse>(owner, "GET", `${sessions}/${draft.id}`)).body.timeZone).toBe("America/New_York");
    // the day before is refused on both sides
    expect(closingDateProblem("2026-11-17", timeZone, clock)).toBe("Choose today or a later date.");
    expect((await send(owner, "PUT", `${sessions}/${draft.id}/closing-date`, { closesOn: "2026-11-17" })).status).toBe(400);
    // counted on a device's own calendar instead (UTC here), the page would have refused the 18th, a day the server takes
    expect(closingDateProblem(today, "UTC", clock)).toBe("Choose today or a later date.");
  });
});
