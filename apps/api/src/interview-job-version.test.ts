import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { ActionResult, CandidateList, CandidatePanel, RoleDetail } from "@ros/contracts";
import { FAKE_SAMPLE_RESUMES } from "@ros/agents";
import { applications, assessments, candidates, screens, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation, type ConversationRef } from "./services/screens";
import { plantJob, statusTokenFor, usePlan } from "./test-helpers";

/**
 * An AI interview follows the job as it is when the interview is made (a shortlist, or a new link) and keeps that
 * version to its end, whatever is edited later; and closing a job closes every interview of it that is still open.
 */
describe("an AI interview and the job it is made for", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  const ids: Record<string, string> = {};
  const emails: Record<string, string> = {};

  const BASE = Date.now();
  let offset = 0;
  const advance = async (ms: number) => { offset += ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); await container.drain(); };
  const DAY = 24 * 3600_000;
  const ANSWER = "At Coastal Smiles I assisted chairside for four years and took x-rays every day.";
  const NERVOUS = "Tell me about a nervous patient and what you did.";
  const CROWN = "How do you set up for a crown prep?";
  const NOTICE = "How much notice do you need to give?";

  const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(path: string): Promise<T> => {
    const r = await call("GET", path);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  const acted = async (who: string, action: string): Promise<ActionResult> => {
    const r = await call("POST", `/api/v1/applications/${ids[who]}/actions`, { action });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return (await r.json()) as ActionResult;
  };
  const panel = (who: string) => read<CandidatePanel>(`/api/v1/applications/${ids[who]}`);
  const page = async (path: string) => (await (await app.request(path)).text()).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/&#39;/g, "'");
  const stageOf = async (who: string) => (await container.db.select({ stage: applications.stage }).from(applications).where(eq(applications.id, ids[who])))[0].stage;
  const screensOf = async (who: string) => container.db.select().from(screens).where(eq(screens.applicationId, ids[who])).orderBy(asc(screens.createdAt), asc(screens.id));
  const runsOf = async (who: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).filter((r) => r.subject.id === ids[who]);
  const scorecardsOf = (who: string) => container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids[who]), eq(assessments.kind, "screen")));
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;

  const apply = async (name: string, job: string) => {
    const email = `${name.toLowerCase()}@people.test`;
    const fd = new FormData();
    fd.set("firstName", name);
    fd.set("lastName", "Tester");
    fd.set("email", email);
    fd.set("acknowledged", "yes");
    fd.set("resume", new File([`${name} Tester\n${email}\n${FAKE_SAMPLE_RESUMES.possible}\n`], "resume.txt", { type: "text/plain" }));
    const res = await app.request(`/careers/${slug}/jobs/${job}/apply`, { method: "POST", body: fd });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [row] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, job), eq(candidates.email, email)));
    ids[name] = row.id;
    emails[name] = email;
  };
  /** The newest AI interview of a person, as the candidate's pages find it. */
  const interviewOf = async (who: string): Promise<ConversationRef> => (await findConversation(container.db, (await screensOf(who)).at(-1)!.token))!;
  /** Presses Start, answers every question the chat asks, and says which questions it asked. */
  const walk = async (who: string): Promise<string[]> => {
    const ref = await interviewOf(who);
    if (!(await conversationView(container.db, ref))!.current) expect(await conversationStart(container, ref)).toBe(true);
    const asked: string[] = [];
    for (let turn = 0; turn < 40; turn++) {
      const view = (await conversationView(container.db, ref))!;
      if (view.phase !== "conversation") return asked;
      if (view.current && !asked.includes(view.current.question)) asked.push(view.current.question);
      const r = await conversationTurn(container, ref, { message: `${ANSWER} (${turn + 1})` });
      expect(r.kind, JSON.stringify(r)).toBe("reply");
    }
    throw new Error("the chat never ended");
  };
  const send = async (who: string) => {
    expect(await conversationSubmit(container, await interviewOf(who))).toBe(true);
    await container.drain();
  };
  /** Saves an edit of the open job, as the job editor does: a new version, live at once. */
  const edit = async (job: string, body: Record<string, unknown>): Promise<number> => {
    const before = await read<RoleDetail>(`/api/v1/roles/${job}`);
    const r = await call("PATCH", `/api/v1/roles/${job}/packet`, { baseVersion: before.version, ...body });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return (await read<RoleDetail>(`/api/v1/roles/${job}`)).version!;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", MESSAGE_UNDO_SECONDS: "30", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@versions.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    owner = r2.headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await call("POST", "/api/v1/companies", { name: "Version Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = (await read<{ slug: string }>("/api/v1/companies/current")).slug;
    await usePlan(container, companyId, "ultra");
  });
  afterAll(async () => { await container.close(); });

  describe("the job changes after people applied", () => {
    let job = "";

    beforeAll(async () => {
      job = await plantJob(container, { companyId, title: "Dental Assistant" });
      for (const name of ["Ada", "Ben", "Cy"]) await apply(name, job);
      // Ben is shortlisted and starts while the job is as it was when everyone applied
      await acted("Ben", "shortlist");
      expect(await conversationStart(container, await interviewOf("Ben"))).toBe(true);
      // then the company changes what the AI interview asks and adds a must-have
      const version = await edit(job, {
        requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { text: "Forklift licence" }] },
        screening: { questions: [{ key: "recent", question: "Tell me about your most recent work." }, { question: CROWN }, { key: "available", question: "Which days and hours are you available?" }] },
      });
      expect(version).toBe(2);
    });

    it("someone shortlisted after the change is asked the new questions and about the new must-have; their scorecard has a finding for each and the panel shows them", async () => {
      await acted("Ada", "shortlist");
      const [interview] = await screensOf("Ada");
      expect(interview).toMatchObject({ status: "invited", packetVersion: 2 });
      // she applied to the first version: the form's answers still belong to it
      expect((await container.db.select({ v: applications.packetVersion }).from(applications).where(eq(applications.id, ids.Ada)))[0].v).toBe(1);
      const asked = await walk("Ada");
      expect(asked).toContain(CROWN);
      expect(asked.some((q) => q.includes("Forklift licence"))).toBe(true);
      expect(asked).not.toContain(NERVOUS);
      await send("Ada");
      expect(await stageOf("Ada")).toBe("screen_complete");
      const [card] = await scorecardsOf("Ada");
      // the scorecard is stored with the version the interview asked about
      expect(card.packetVersion).toBe(2);
      const ada = await panel("Ada");
      const scored = ada.aiInterview!.score!;
      expect(typeof scored.score).toBe("number");
      // one finding for every question the interview asked: the new question and the new must-have among them
      expect(scored.questions.map((q) => q.question).sort()).toEqual(asked.filter((q) => !/anything else/i.test(q)).sort());
      expect(scored.questions.some((q) => q.question === CROWN)).toBe(true);
      expect(scored.questions.some((q) => q.question.includes("Forklift licence"))).toBe(true);
      expect(ada.aiInterview!.answers.map((a) => a.question)).toEqual(expect.arrayContaining([CROWN, asked.find((q) => q.includes("Forklift licence"))!]));
      expect(ada.aiInterview!.answers.map((a) => a.question)).not.toContain(NERVOUS);
      // and her own page reads her answers back under the questions she was asked
      const status = await page(`/c/status/${await statusTokenFor(container, { roleId: job, email: emails.Ada })}`);
      const readBack = [...status.matchAll(/<p class="said-q">\d+\. ([^<]*)<\/p>/g)].map((m) => m[1]);
      expect(readBack).toEqual(expect.arrayContaining([CROWN, asked.find((q) => q.includes("Forklift licence"))!]));
      expect(readBack).not.toContain(NERVOUS);
      // the list ranks her by that score
      const interviewed = await read<CandidateList>(`/api/v1/roles/${job}/applications?tab=interviewed`);
      expect(interviewed.rows.map((r) => [r.name, typeof r.interviewScore?.score])).toEqual([["Ada Tester", "number"]]);
    });

    it("an interview already open when the job changed keeps its questions to the end", async () => {
      const [interview] = await screensOf("Ben");
      expect(interview).toMatchObject({ status: "in_progress", packetVersion: 1 });
      const asked = await walk("Ben");
      expect(asked).toContain(NERVOUS);
      expect(asked).not.toContain(CROWN);
      expect(asked.some((q) => q.includes("Forklift licence"))).toBe(false);
      await send("Ben");
      const [card] = await scorecardsOf("Ben");
      expect(card.packetVersion).toBe(1);
      const ben = await panel("Ben");
      expect(ben.aiInterview!.score!.questions.map((q) => q.question)).toContain(NERVOUS);
      expect(ben.aiInterview!.score!.questions.map((q) => q.question)).not.toContain(CROWN);
      expect(ben.aiInterview!.answers.map((a) => a.question)).toContain(NERVOUS);
    });

    it("a new link is a new interview, made with the job as it is then; the one that closed keeps the version it had", async () => {
      await acted("Cy", "shortlist");
      await advance(5 * DAY + 60_000);
      expect((await screensOf("Cy")).map((s) => [s.status, s.packetVersion])).toEqual([["expired", 2]]);
      expect(await edit(job, { screening: { questions: [{ key: "recent", question: "Tell me about your most recent work." }, { question: NOTICE }, { key: "available", question: "Which days and hours are you available?" }] } })).toBe(3);
      await acted("Cy", "send_new_link");
      expect((await screensOf("Cy")).map((s) => [s.status, s.packetVersion])).toEqual([["expired", 2], ["invited", 3]]);
      const asked = await walk("Cy");
      expect(asked).toContain(NOTICE);
      expect(asked).not.toContain(CROWN);
    });
  });

  describe("the job closes", () => {
    let job = "";

    beforeAll(async () => {
      job = await plantJob(container, { companyId, title: "Front Desk Coordinator" });
      for (const name of ["Eve", "Fay", "Gus", "Hal", "Ivy"]) await apply(name, job);
      // Hal's link closes by itself, five days after it went
      await acted("Hal", "shortlist");
      await advance(5 * DAY + 60_000);
      // Eve is invited, Fay has started, Gus has sent his answers; Ivy was never shortlisted
      for (const name of ["Eve", "Fay", "Gus"]) await acted(name, "shortlist");
      expect(await conversationStart(container, await interviewOf("Fay"))).toBe(true);
      await walk("Gus");
      await send("Gus");
    });

    it("pausing the job closes nothing: every open link still works", async () => {
      expect((await call("POST", `/api/v1/roles/${job}/pause`, { reason: "A week off" })).status).toBe(200);
      await container.drain();
      expect((await screensOf("Eve"))[0].status).toBe("invited");
      expect((await screensOf("Fay"))[0].status).toBe("in_progress");
      expect(await page(`/c/screen/${(await screensOf("Eve"))[0].token}`)).toContain(">Start</button>");
      expect((await call("POST", `/api/v1/roles/${job}/resume`)).status).toBe(200);
    });

    it("closing the job closes every AI interview still open, emails nobody, and leaves a sent interview with its answers and its score", async () => {
      const before = mail().length;
      const gusBefore = await panel("Gus");
      expect(typeof gusBefore.aiInterview!.score!.score).toBe("number");
      expect((await call("POST", `/api/v1/roles/${job}/close`, { confirm: true })).status).toBe(200);
      await container.drain();
      // the two open interviews are closed, their runs are over, and the link reads as closed
      for (const name of ["Eve", "Fay"]) {
        const [interview] = await screensOf(name);
        expect(interview.status, name).toBe("cancelled");
        expect(interview.completedAt).toBeTruthy();
        expect((await runsOf(name)).map((r) => r.status)).toEqual(["cancelled"]);
        const closed = await page(`/c/screen/${interview.token}`);
        expect(closed).toContain("This AI interview is closed");
        expect(closed).not.toContain(">Start</button>");
        // nothing typed into a closed link is taken
        const ref = (await findConversation(container.db, interview.token))!;
        expect(await conversationStart(container, ref)).toBe(false);
        expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("closed");
      }
      // a close moves nobody: they are where they were
      expect([await stageOf("Eve"), await stageOf("Fay")]).toEqual(["screen_invited", "screening"]);
      // nobody was emailed by the close
      await advance(DAY);
      expect(mail().length).toBe(before);
      // the interview that was sent keeps its answers and its score, and its person stays Interviewed
      const gus = await panel("Gus");
      expect(gus).toMatchObject({ stage: "screen_complete", tab: "interviewed" });
      expect(gus.aiInterview!.score).toEqual(gusBefore.aiInterview!.score);
      expect(gus.aiInterview!.answers).toEqual(gusBefore.aiInterview!.answers);
      expect((await screensOf("Gus"))[0]).toMatchObject({ status: "completed" });
      // a link that had already closed by itself stays as it was, and so does someone never shortlisted
      expect((await screensOf("Hal"))[0].status).toBe("expired");
      expect(await stageOf("Hal")).toBe("screen_invited");
      expect(await stageOf("Ivy")).toBe("triaged");
      // and nobody can be shortlisted on a closed job
      const again = await call("POST", `/api/v1/applications/${ids.Ivy}/actions`, { action: "shortlist" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { message: string } }).error.message).toBe("This job is closed.");
    });
  });
});
