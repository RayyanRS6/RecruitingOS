import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FakeHandler, StructuredRequest } from "@ros/ai";
import type { ActionResult } from "@ros/contracts";
import { applications, candidates } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantJob, usePlan } from "./test-helpers";

/**
 * When someone applies to a second job of a company, the resume reading the app runs (the `read` step of
 * application_intake, `assessApplication`) is never told about their earlier application or how it ended, and never sees
 * their name, email or phone. The evals check the input builder; this checks the path the app takes, by reading what the
 * model was sent.
 */
describe("the resume reading of someone who applied before", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let frontDesk = "";
  let assistant = "";
  const sent: Array<{ system: string; messages: string }> = [];

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const RESUME = "Lena Ortiz, RDA\nlena.ortiz@example.com | (512) 555-0142\n\nDental Assistant at Bright Smiles Dental 2018 - present\nRadiography certificate, California, 2019\nSkills: chairside assisting, Dentrix";

  async function apply(roleId: string) {
    const fd = new FormData();
    fd.set("firstName", "Lena");
    fd.set("lastName", "Ortiz");
    fd.set("email", "lena.ortiz@example.com");
    fd.set("phone", "(512) 555-0142");
    fd.set("resume", new File([RESUME], "lena.txt", { type: "text/plain" }));
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [person] = await container.db.select().from(candidates).where(eq(candidates.email, "lena.ortiz@example.com"));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, person.id))))[0];
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@earlier.test" })).json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const company = (await (await json("POST", "/api/v1/companies", { name: "Earlier Smiles Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    slug = ((await (await json("GET", "/api/v1/companies/current")).json()) as { slug: string }).slug;
    await usePlan(container, company.id, "ultra");
    frontDesk = await plantJob(container, { companyId: company.id, title: "Front desk coordinator" });
    assistant = await plantJob(container, { companyId: company.id, title: "Dental Assistant" });
    // every resume reading's full request (system text and messages), as the model would receive it
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

  it("sends no earlier application or how it ended, and no name, email or phone; the team still has the earlier application", async () => {
    // her first application, to the front desk job, marked Not selected, with a note an older decision left on it
    const first = await apply(frontDesk);
    expect(first.stage).toBe("triaged");
    const decided = await json("POST", `/api/v1/applications/${first.id}/actions`, { action: "reject" });
    expect(((await decided.json()) as ActionResult).stage).toBe("rejected");
    await container.db.update(applications).set({ rejectNote: "Turned down in March 2025: patchy attendance record" }).where(eq(applications.id, first.id));
    sent.length = 0;

    // she applies again, to the dental assistant job
    const again = await apply(assistant);
    expect(again.id).not.toBe(first.id);
    expect(again.candidateId).toBe(first.candidateId);
    expect(again.stage).toBe("triaged");
    // read three times, like everyone
    expect(sent).toHaveLength(3);
    for (const { system, messages } of sent) {
      const request = `${system}\n${messages}`;
      expect(request).not.toMatch(/Front desk coordinator|March 2025|patchy attendance/i);
      // the fixed instructions may name the rule ("never their earlier applications"); the data never carries one
      expect(messages).not.toMatch(/rejected|not selected|not moving forward|earlier application|prior_applications/i);
      expect(request).not.toMatch(/Lena|Ortiz|lena\.ortiz@example\.com|555-0142/);
      // the job-relevant words are all there
      expect(messages).toMatch(/Bright Smiles Dental/);
      expect(messages).toMatch(/Radiography certificate, California, 2019/);
      expect(system).toMatch(/Role: Dental Assistant/);
    }
    // nothing was lost for the team: the earlier application is on her record as it was
    const [kept] = await container.db.select().from(applications).where(eq(applications.id, first.id));
    expect(kept).toMatchObject({ roleId: frontDesk, stage: "rejected", rejectNote: "Turned down in March 2025: patchy attendance record" });
  });
});
