import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

const sentry = vi.hoisted(() => ({ requestErrors: [] as unknown[][] }));
vi.mock("@sentry/nextjs", () => ({
  init: () => undefined,
  captureException: () => undefined,
  captureRequestError: (...args: unknown[]) => { sentry.requestErrors.push(args); },
}));

import { onRequestError } from "./instrumentation";

/** Audit OPS-2: a server error Next.js hands to onRequestError leaves without the values a failed query carried. */
describe("errors Next.js reports from the server", () => {
  const runtime = process.env.NEXT_RUNTIME;
  const request = { path: "/roles/r1", method: "GET", headers: {} };
  const context = { routerKind: "App Router", routePath: "/roles/[id]", routeType: "render" };
  afterEach(() => {
    if (runtime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = runtime;
    sentry.requestErrors.length = 0;
  });

  it("on the Node runtime a failed query is reported without its values, with the request as it came", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const reason = 'null value in column "role_id" of relation "applications" violates not-null constraint';
    const cause = Object.assign(new Error(reason), { detail: "Failing row contains (0192a6b2-0000-7aaa-8bbb-000000000001, Nia Brooks, nia.brooks@example.com, null)." });
    const sql = 'insert into "applications" ("name", "email") values ($1, $2)';
    await onRequestError(new DrizzleQueryError(sql, ["Nia Brooks", "nia.brooks@example.com"], cause), request, context);
    expect(sentry.requestErrors).toHaveLength(1);
    const [reported, req, ctx] = sentry.requestErrors[0] as [Error, unknown, unknown];
    expect(reported.message).toBe(`Failed query: ${sql}\nparams: [redacted]`);
    expect((reported.cause as Error).message).toBe(reason);
    expect("params" in reported).toBe(false);
    expect(`${reported.message}${reported.stack}${(reported.cause as Error).stack}`).not.toMatch(/Nia Brooks|nia\.brooks@example\.com/);
    expect(req).toBe(request);
    expect(ctx).toBe(context);
  });

  it("on the Edge runtime (the middleware, which reads no database) the error goes as it is", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const err = new Error("the middleware failed");
    await onRequestError(err, request, context);
    expect(sentry.requestErrors[0]?.[0]).toBe(err);
  });
});
