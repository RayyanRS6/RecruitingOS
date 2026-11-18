import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ActionResult, DecisionMessagePreview, ResumeExtraction } from "@ros/contracts";
import { ADVERSE_DECISION_LINE } from "@ros/core";
import { applications, candidates } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * The decision email's Colorado line (how to ask for the reasons and for a person's review): it is in the email when
 * the job is in Colorado, and when the candidate is. The form does not ask where a candidate is based, so that is read
 * from their own resume. The same answer in the preview a person reads before sending and in the email that leaves.
 */
describe("the decision email's Colorado line", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let inCalifornia = "";
  let inColorado = "";

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);
  /** What the resume reading makes of where someone is, for the stand-in AI, which reads no place by itself. */
  const readsPlace = (name: string, locationText: string): ResumeExtraction => ({ fullName: name, locationText, positions: [{ title: "Dental Hygienist", employer: "Mile High Dental", current: true }], education: [], licenses: [], certifications: [], skills: ["Dentrix"], languages: [], anomalies: [], confidence: "medium" });

  /** Someone applies, is marked Not selected, and the email "Email the decision" would send them is read; then it is sent. */
  async function declined(roleId: string, first: string, place?: string) {
    const email = `${first.toLowerCase()}@people.test`;
    if (place) container.fake!.scriptNext("resume.extract", readsPlace(`${first} Tester`, place));
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: first, lastName: "Tester", email }) })).status).toBe(302);
    await container.drain();
    const [row] = await container.db.select({ id: applications.id, extraction: applications.extraction }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, roleId), eq(candidates.email, email)));
    expect((await json("POST", `/api/v1/applications/${row.id}/actions`, { action: "reject" })).status).toBe(200);
    const preview = (await (await json("GET", `/api/v1/applications/${row.id}/decision-message`)).json()) as DecisionMessagePreview;
    const sent = await json("POST", `/api/v1/applications/${row.id}/actions`, { action: "send_decision" });
    expect(((await sent.json()) as ActionResult).toldState).toBe("queued");
    await container.drain();
    const mail = mailTo(email).find((m) => m.subject === "Your application to Summit Dental")!;
    return { preview, mail, readPlace: row.extraction?.locationText ?? null };
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", MESSAGE_UNDO_SECONDS: "0" } });
    app = createApp(container);
    const company = await seedCompany(app, { email: "owner@summit.test", name: "Summit Dental" });
    ({ owner, companyId, slug } = company);
    await usePlan(container, companyId);
    inCalifornia = await plantJob(container, { companyId, title: "Dental Hygienist" });
    inColorado = await plantJob(container, { companyId, title: "Dental Assistant", packet: (p) => { p.identity.locations = [{ city: "Denver", region: "CO", country: "US" }]; } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("is left out for a California job when nothing places the candidate in Colorado", async () => {
    const { preview, mail, readPlace } = await declined(inCalifornia, "Cal");
    expect(readPlace).toBeNull();
    expect(preview.adverseDecisionLine).toBe(false);
    expect(preview.text).not.toContain("Colorado");
    expect(mail.text).toBe(preview.text);
  });

  it("is in the email when the candidate's own resume places them in Colorado, though the job is elsewhere", async () => {
    const { preview, mail, readPlace } = await declined(inCalifornia, "Dana", "Denver, CO");
    expect(readPlace).toBe("Denver, CO");
    expect(preview.adverseDecisionLine).toBe(true);
    expect(preview.text).toContain(ADVERSE_DECISION_LINE.text);
    expect(ADVERSE_DECISION_LINE.text).toBe("Colorado: you may ask us to explain the main reasons for this decision and to have a person review it. Reply to this email within 30 days, and someone who was not part of the decision will answer you.");
    // what leaves is what the person read before sending, and it asks for no keyword
    expect(mail.text).toBe(preview.text);
    expect(mail.text).not.toMatch(/EXPLAIN|HUMAN/);
  });

  it("is in the email for a job in Colorado, wherever the candidate is", async () => {
    const { preview, mail } = await declined(inColorado, "Eve", "Tustin, CA");
    expect(preview.adverseDecisionLine).toBe(true);
    expect(mail.text).toContain(ADVERSE_DECISION_LINE.text);
  });
});
