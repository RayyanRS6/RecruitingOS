import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { roles } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { ONE_VISIT_LINE } from "./services/publishing";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * The approval card's "Once it is live" line (signed-in polish): a role on the one-visit flow (founder decision B1) has
 * its applicants talk to the assistant as part of applying, so the line says that instead of describing a later
 * invitation. It follows the same rule as the apply page: the role's or the company's flow, and the owner's rule for
 * screen invitations ("Ask me first" keeps the later path, and the line says so again).
 */
describe("the approval card's line about the screening conversation", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let roleId = "";
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  type Detail = { autoActionsOnOpen: { lines: Array<{ actionType: string; level: string; text: string }> } };
  const inviteLine = async () => ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as Detail).autoActionsOnOpen.lines.find((l) => l.actionType === "application.invite_screen")!;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "owner@line.test" });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token");
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json("POST", "/api/v1/companies", { name: "Line Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("describes the later invitation on the usual flow", async () => {
    const line = await inviteLine();
    expect(line.text).toMatch(/^When the assistant's reading of an application suggests a good fit/);
    expect(line.text).not.toBe(ONE_VISIT_LINE);
  });

  it("describes the conversation as part of applying once the role is on the one-visit flow", async () => {
    await useOneVisitApplyFlow(container, companyId);
    const line = await inviteLine();
    expect(line.text).toBe(ONE_VISIT_LINE);
    expect(line.text).toMatch(/as part of applying/);
    expect(line.text).toMatch(/ask for a person/);
  });

  it("follows the role's own setting over the company's, and the owner's 'Ask me first', like the apply page", async () => {
    await container.db.update(roles).set({ applyMode: "form_then_screen" }).where(eq(roles.id, roleId));
    expect((await inviteLine()).text).not.toBe(ONE_VISIT_LINE);
    await container.db.update(roles).set({ applyMode: null }).where(eq(roles.id, roleId));
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"] })).status).toBe(200);
    const line = await inviteLine();
    expect(line.level).toBe("approval");
    expect(line.text).toMatch(/waits for your approval/);
  });
});
