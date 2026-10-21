import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { policies, roles } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { ONE_VISIT_LINE } from "./services/publishing";
import { useLaterApplyFlow, useOneVisitApplyFlow } from "./test-helpers";

/**
 * The approval card's "Once it is live" line (signed-in polish). Since 20 October 2026 (R20-4, R20-12) every applicant
 * has the AI interview as part of applying, with no approval and whatever ITS's old switch says, so the line is the same
 * for every company and role: what the candidate does, that the team hears once it is scored, and that a person decides.
 */
describe("the approval card's line about the AI interview", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let roleId = "";
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  type Detail = { autoActionsOnOpen: { lines: Array<{ actionType: string; level: string; text: string }> } };
  const lines = async () => ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as Detail).autoActionsOnOpen.lines;
  const inviteLine = async () => (await lines()).find((l) => l.actionType === "application.invite_screen")!;

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

  it("describes the AI interview every applicant has as part of applying, and the one email", async () => {
    const all = await lines();
    expect(all.map((l) => l.actionType)).toEqual(["message.send_templated", "application.invite_screen"]);
    expect(all[0].text).toMatch(/one email.*AI interview/);
    const line = await inviteLine();
    expect(line).toMatchObject({ level: "auto", text: ONE_VISIT_LINE });
    expect(line.text).toMatch(/as soon as their résumé is read/);
    expect(line.text).toMatch(/ask for a person/);
    expect(line.text).toMatch(/once, when their interview is scored/);
  });

  it("is the same whatever ITS's old switch or a rule saved before says (R20-12, R20-4)", async () => {
    await useLaterApplyFlow(container, companyId);
    expect((await inviteLine()).text).toBe(ONE_VISIT_LINE);
    await useOneVisitApplyFlow(container, companyId);
    await container.db.update(roles).set({ applyMode: "form_then_screen" }).where(eq(roles.id, roleId));
    expect((await inviteLine()).text).toBe(ONE_VISIT_LINE);
    await container.db.update(roles).set({ applyMode: null }).where(eq(roles.id, roleId));
    // a company that chose "Ask me first" before 20 October: nothing waits for approval now
    await container.db.insert(policies).values({ companyId, roleId: null, actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"], createdBy: { kind: "system", id: "test" } });
    expect((await json("PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"] })).status).toBe(400);
    expect(await inviteLine()).toMatchObject({ level: "auto", text: ONE_VISIT_LINE });
  });
});
