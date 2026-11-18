import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { PERSON_REPLY, WITHDRAW_CONFIRM_KEY } from "@ros/agents";
import { applications, candidates, events, notifications, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/**
 * The AI interview's keyword commands, over HTTP. Only a message that is the command itself counts: an answer that
 * starts with "Representative" or "Withdraw" is recorded as an answer. HUMAN closes nothing: the chat says how to choose
 * a person on the page, and the choice is made there. WITHDRAW withdraws nothing by itself: the candidate is asked, and
 * confirms with the button on the page (`POST /c/screen/:token/withdraw`); NO keeps the application.
 */
describe("AI interview keywords: whole-message commands, a person chosen on the page, and a confirmed withdrawal", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let slug = "";
  let roleId = "";
  const QUESTIONS = ["Tell me about your most recent work.", "Tell me about a nervous patient and what you did.", "Which days and hours are you available?"];
  let n = 0;

  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)))[0];
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  /** The team's updates that this applicant chose a person instead of the AI interview. */
  const toldTheyChose = async (applicationId: string) => (await container.db.select().from(notifications).where(eq(notifications.kind, "screen.declined_by_candidate"))).filter((x) => (x.action?.href ?? "").includes(applicationId));
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  /** Someone applies, the team shortlists them, and they press Start: the first question of the job is on the page. */
  async function interview(first: string) {
    n += 1;
    const email = `${first.toLowerCase()}.${n}@keywords.test`;
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: first, lastName: "Tester", email }) })).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("triaged");
    expect((await app.request(`/api/v1/applications/${a.id}/actions`, { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ action: "shortlist" }) })).status).toBe(200);
    await container.drain();
    const scr = await screenOf(a.id);
    expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    return { application: a, candidate: cand, token: scr.token };
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const company = await seedCompany(app, { email: "dana@keywords.test", name: "Keyword Dental" });
    ({ owner, slug } = company);
    await usePlan(container, company.companyId);
    roleId = await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist", packet: (p) => { p.screening.questions = QUESTIONS.map((question, i) => ({ key: `q${i + 1}`, question, kind: "skills" as const })); } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("an answer that starts with a keyword is recorded as an answer, not taken as a command", async () => {
    const { application, token } = await interview("Rita");
    expect((await form(`/c/screen/${token}`, { message: "Representative at a phone store for two years, then a dental front desk." })).status).toBe(302);
    let scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(scr.answers.q1).toBe("Representative at a phone store for two years, then a dental front desk.");
    expect((await form(`/c/screen/${token}`, { message: "Withdraw cash from the till at closing and balance the drawer every night." })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(Object.values(scr.answers)).toContain("Withdraw cash from the till at closing and balance the drawer every night.");
    expect((await applicationOf(application.id)).stage).toBe("screening");
    expect(await toldTheyChose(application.id)).toHaveLength(0);
  });

  it("HUMAN on its own closes nothing and is no answer: the chat says how to choose a person on the page, and the choice made there is recorded and tells the team", async () => {
    const { application, token } = await interview("Hugo");
    expect((await form(`/c/screen/${token}`, { message: "HUMAN" })).status).toBe(302);
    let scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(scr.answers).toEqual({});
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: PERSON_REPLY });
    expect(await toldTheyChose(application.id)).toHaveLength(0);
    // the same question is still the one to answer, and the way to a person is on the page
    const page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(page).toContain(`href="/c/screen/${token}/person"`);
    expect(page).toContain("choose \"I'd rather talk to a person\" on this page");
    // choosing it there: the AI interview closes as their choice, nothing they typed is sent, and the team gets one update
    expect((await form(`/c/screen/${token}/person`)).status).toBe(302);
    await container.drain();
    scr = await screenOf(application.id);
    expect(scr.status).toBe("declined_by_candidate");
    expect((await toldTheyChose(application.id)).map((x) => x.title)).toEqual(["Hugo Tester chose not to do the AI interview"]);
    expect(decodeEntities(await (await app.request(`/c/screen/${token}`)).text())).toContain("<h1>The hiring team has been told</h1>");
    // a second press changes nothing
    expect((await form(`/c/screen/${token}/person`)).status).toBe(302);
    expect(await toldTheyChose(application.id)).toHaveLength(1);
  });

  it("WITHDRAW asks first; 'No, keep my application' carries on; the confirm button withdraws", async () => {
    const { application, token } = await interview("Wendy");
    expect((await form(`/c/screen/${token}`, { message: "WITHDRAW" })).status).toBe(302);
    let scr = await screenOf(application.id);
    // nothing is withdrawn yet: the chat asks, with the marker that makes the next answer decide
    expect(scr.status).toBe("in_progress");
    expect((await applicationOf(application.id)).stage).toBe("screening");
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", questionKey: WITHDRAW_CONFIRM_KEY });
    expect(scr.transcript.at(-1)!.content).toMatch(/^Do you want to withdraw your application for .+\? Press "Yes, withdraw my application" below to confirm\./);
    let page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(page).toContain("Do you want to withdraw your application?");
    expect(page).toContain(`action="/c/screen/${token}/withdraw"`);
    expect(page).toContain("Yes, withdraw my application");
    expect(page).toContain("No, keep my application");
    // keep it: the chat picks up where it was
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "no" })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(scr.transcript.at(-1)!.content).toBe(`No problem, your application stays active. Here is where we were: ${QUESTIONS[0]}`);
    page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(page).not.toContain("Do you want to withdraw your application?");
    // ask again, then confirm with the button
    await form(`/c/screen/${token}`, { message: "withdraw" });
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    await container.drain();
    scr = await screenOf(application.id);
    expect(scr.status).toBe("cancelled");
    expect((await applicationOf(application.id)).stage).toBe("withdrawn");
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.withdrawn"), eq(events.subjectId, application.id))))[0].payload).toMatchObject({ via: "ai_interview", fromStage: "screening" });
    expect((await container.db.select().from(notifications).where(eq(notifications.kind, "candidate.withdrawn"))).some((x) => x.title === "Wendy Tester withdrew")).toBe(true);
    expect(decodeEntities(await (await app.request(`/c/screen/${token}`)).text())).toContain("<h1>This AI interview is closed</h1>");
    // a second press on an ended AI interview changes nothing; a forged link is a 404
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.withdrawn"), eq(events.subjectId, application.id))))).toHaveLength(1);
    expect((await form(`/c/screen/${"x".repeat(32)}/withdraw`, { confirm: "yes" })).status).toBe(404);
  });
});
