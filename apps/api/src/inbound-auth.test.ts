import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/** The inbound webhook accepts Postmark's own credential form (basic auth in the URL) as well as a header or query string. */
describe("inbound email webhook authentication", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const SECRET = "inbound-secret-for-tests-0123456789";
  const body = JSON.stringify({ From: "nobody@example.com", To: "apply-unknown@intake.localhost", Subject: "hello", TextBody: "hi" });
  const post = (headers: Record<string, string>, path = "/webhooks/postmark/inbound") => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", POSTMARK_INBOUND_SECRET: SECRET } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("basic auth with the secret as the password is accepted; a header and a query string still work; anything else is refused", async () => {
    const basic = `Basic ${Buffer.from(`inbound:${SECRET}`).toString("base64")}`;
    expect((await post({ authorization: basic })).status).not.toBe(401);
    expect((await post({ "x-inbound-secret": SECRET })).status).not.toBe(401);
    expect((await post({}, `/webhooks/postmark/inbound?secret=${SECRET}`)).status).not.toBe(401);
    expect((await post({ authorization: `Basic ${Buffer.from("inbound:wrong").toString("base64")}` })).status).toBe(401);
    expect((await post({ "x-inbound-secret": "wrong" })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect((await post({}, "/webhooks/postmark/inbound?secret=")).status).toBe(401);
  });
});
