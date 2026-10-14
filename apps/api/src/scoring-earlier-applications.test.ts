import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FakeHandler, StructuredRequest } from "@ros/ai";
import { applications, candidates, roles, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useLaterApplyFlow } from "./test-helpers";

/**
 * Founder decision D-04 = C, end to end (Wave S3): when someone applies again, the résumé reading the app runs
 * (application_intake's `ready` step, assessApplication) is never told about their earlier application to the company or
 * how it ended, and never sees their name, email or phone. The fairness evals check the input builder; this checks the
 * path the app actually takes, by reading what the model was sent.
 */
describe("the résumé reading of someone who applied before", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let companyId = "";
  let elig: Array<{ key: string }> = [];
  const sent: Array<{ system: string; messages: string }> = [];

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const RESUME = "Lena Ortiz, RDH\nlena.ortiz@example.com | (512) 555-0142\n\nRegistered Dental Hygienist at Bright Smiles Dental 2018 - present\nLicenses: RDH license CA #RDH55555, active\nSkills: periodontal charting, Dentrix";

  async function apply() {
    const fd = new FormData();
    fd.set("firstName", "Lena"); fd.set("lastName", "Ortiz"); fd.set("email", "lena.ortiz@example.com"); fd.set("phone", "(512) 555-0142");
    fd.set("resume", new File([RESUME], "lena.txt", { type: "text/plain" }));
    for (const r of elig) fd.set(`elig_${r.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "lena.ortiz@example.com"));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id))))[0];
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@earlier.test" })).json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Earlier Smiles Dental", vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    companyId = co.id;
    await useLaterApplyFlow(container, co.id);
    const c1 = (await (await json("POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days." })).json()) as { intakeSessionId: string };
    await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/messages`, { message: "It's a replacement, our hygienist moved. Ceiling is $58. Interviewers: Dr. Chen and me. I decide. Deal-breakers: can't work Saturdays. Must-haves: active CA RDH license, perio experience." });
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${c1.intakeSessionId}/compile`)).json()) as { roleId: string }).roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1 });
    await container.drain();
    elig = ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } }).currentPacket.packet.requirements.eligibility;
    // every résumé reading's full request (system text and messages), as the model would receive it
    const fake = container.fake!;
    const reading = (fake as unknown as { handlers: Map<string, FakeHandler> }).handlers.get("triage.assess")!;
    fake.register("triage.assess", (req: StructuredRequest<unknown>) => {
      sent.push({ system: req.system.map((b) => b.text).join("\n"), messages: req.messages.map((m) => m.content).join("\n") });
      return reading(req);
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("sends no earlier application, outcome or note, and no name, email or phone; the team still has the earlier application", async () => {
    // her first application, turned down for another job at the same company
    const first = await apply();
    expect(first).toBeTruthy();
    const old = await withTenant(container.db, companyId, async (tx) => {
      const [r] = await tx.insert(roles).values({ companyId, title: "Front desk coordinator", status: "closed", createdBy: { kind: "user", id: "dana" } }).returning({ id: roles.id });
      await tx.update(applications).set({ roleId: r.id, stage: "rejected", rejectNote: "Turned down in March 2025: patchy attendance record" }).where(eq(applications.id, first.id));
      return r.id;
    });
    sent.length = 0;

    // she applies again, to the hygienist job
    const again = await apply();
    expect(again.id).not.toBe(first.id);
    expect(again.candidateId).toBe(first.candidateId);
    expect(sent.length).toBeGreaterThan(0);
    for (const { system, messages } of sent) {
      const request = `${system}\n${messages}`;
      expect(request).not.toMatch(/Front desk coordinator|March 2025|patchy attendance/i);
      // the fixed instructions may name the rule ("never their earlier applications"); the data never carries one
      expect(messages).not.toMatch(/rejected|not moving forward|earlier application|prior_applications/i);
      expect(request).not.toMatch(/Lena|Ortiz|lena\.ortiz@example\.com|555-0142/);
      // the job-relevant words are all there
      expect(messages).toMatch(/Bright Smiles Dental/);
      expect(messages).toMatch(/periodontal charting/);
    }
    // nothing was lost for the team: the earlier application is on her record as it was
    const [kept] = await container.db.select().from(applications).where(eq(applications.id, first.id));
    expect(kept).toMatchObject({ roleId: old, stage: "rejected", rejectNote: "Turned down in March 2025: patchy attendance record" });
  });
});
