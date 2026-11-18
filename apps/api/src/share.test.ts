import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { POST_TEXT_MAX, RolePacket, SHARE_LINE, type IntakeSessionView, type PublishResult, type ShareView } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { aiRuns, rolePackets, roles, withPlatform } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { jobUrls } from "./services/job-urls";
import { finishPost } from "./services/share";
import { signInAs } from "./test-helpers";

/**
 * A job's Share tab: the Apply link and the LinkedIn and Indeed posts. Publishing queues their writing and never waits
 * for it; each post carries the pay and its own Apply link; a person's own words are never replaced by an automatic
 * rewrite, only by that post's own "Write again"; and the tab says when the posts could not be written.
 */
describe("a job's Share tab", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let made = 0;
  const WORDS = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const share = async (cookie: string, roleId: string) => (await (await json(cookie, "GET", `/api/v1/roles/${roleId}/share`)).json()) as ShareView;
  const postsWritten = () => container.fake!.calls.filter((call) => call.task === "job.posts").length;
  const moveClock = (at: number | null) => { (container.engine as unknown as { now: () => Date }).now = at === null ? () => new Date() : () => new Date(at); };

  /** A company of its own on `plan`, with its owner signed in. */
  const newCompany = async (plan: string) => {
    made += 1;
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `owner-${made}@share.test` }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    const cookie = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const id = ((await (await json(cookie, "POST", "/api/v1/companies", { name: `Share Dental ${made}`, vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    const slug = ((await (await json(cookie, "GET", "/api/v1/companies/current")).json()) as { slug: string }).slug;
    await entitlements.applyPlan(container.db, id, plan);
    return { cookie, id, slug };
  };
  /** A job built from one sentence, written and published. */
  const publishedJob = async (cookie: string): Promise<string> => {
    const session = ((await (await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: WORDS })).json()) as { session: IntakeSessionView }).session.id;
    expect((await json(cookie, "POST", `/api/v1/intake/sessions/${session}/draft`)).status).toBe(200);
    const published = await json(cookie, "POST", `/api/v1/intake/sessions/${session}/publish`);
    expect(published.status, await published.clone().text()).toBe(201);
    return ((await published.json()) as PublishResult).roleId;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("publishing writes the two posts in the background, each with the job's facts, the pay and its own Apply link", async () => {
    const co = await newCompany("ultra");
    const roleId = await publishedJob(co.cookie);
    const view = await share(co.cookie, roleId);
    const jobUrl = jobUrls(container.env, { slug: co.slug, roleId }).job;
    expect(view).toMatchObject({ roleId, jobUrl, public: true, notPublicLine: null, state: "ready", stateLine: null });
    expect(view.posts.map((p) => [p.channel, p.label, p.applyUrl, p.edited])).toEqual([
      ["linkedin", "LinkedIn post", `${jobUrl}?src=linkedin`, false],
      ["indeed", "Indeed post", `${jobUrl}?src=indeed`, false],
    ]);
    const [linkedin, indeed] = view.posts;
    for (const post of view.posts) {
      expect(post.text).toContain(post.applyUrl);
      expect(post.text).toContain("$45–$55 an hour");
      expect(post.text).toMatch(/Registered Dental Hygienist/i);
      expect(post.text).toContain(`Share Dental ${made}`);
      expect(post.writtenAt).toEqual(expect.any(String));
    }
    expect(linkedin.text).not.toContain("src=indeed");
    expect(indeed.text).not.toContain("src=linkedin");
    for (const heading of ["About the job", "What you will do", "What you need", "Pay and schedule", "How to apply"]) expect(indeed.text).toContain(heading);
    // one call of the posts stage, recorded like every other call, and the version it was written from
    const runs = await container.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, co.id), eq(aiRuns.task, "job.posts")));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ promptKey: "job.posts", promptVersion: 1, agent: "share", status: "ok" });
    const [stored] = await container.db.select({ posts: roles.posts }).from(roles).where(eq(roles.id, roleId));
    expect(stored.posts).toMatchObject({ state: "ready", version: 1 });
    // anyone on the team reads the tab
    const member = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", name: "Mia Member" });
    expect((await json(member, "GET", `/api/v1/roles/${roleId}/share`)).status).toBe(200);
  });

  it("keeps a person's own words through an automatic rewrite, and writes the other post again when the job page's facts change", async () => {
    const co = await newCompany("ultra");
    const roleId = await publishedJob(co.cookie);
    const own = "We are growing our hygiene team in Tustin. Come and meet us.";
    const edited = await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/linkedin`, { text: `  ${own}  ` });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as ShareView).posts[0]).toMatchObject({ channel: "linkedin", text: own, edited: true });
    // an edit that changes nothing the job page says writes nothing
    const before = postsWritten();
    expect((await json(co.cookie, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, screening: { maxMinutes: 15 } })).status).toBe(200);
    expect(postsWritten()).toBe(before);
    // the schedule is on the job page: the Indeed post is written again, the person's LinkedIn post stays
    expect((await json(co.cookie, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 2, identity: { schedule: "Tuesday to Saturday" } })).status).toBe(200);
    expect(postsWritten()).toBe(before + 1);
    const view = await share(co.cookie, roleId);
    expect(view.state).toBe("ready");
    expect(view.posts[0]).toMatchObject({ text: own, edited: true });
    expect(view.posts[1].edited).toBe(false);
    expect(view.posts[1].text).toContain("Full time, Tuesday to Saturday, On site");
    // with both posts a person's own words, a change of the job page writes nothing
    expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/indeed`, { text: "Hygienist wanted. See our job page." })).status).toBe(200);
    expect((await json(co.cookie, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 3, identity: { schedule: "Monday to Thursday" } })).status).toBe(200);
    expect(postsWritten()).toBe(before + 1);
    expect((await share(co.cookie, roleId)).posts.map((p) => p.edited)).toEqual([true, true]);
  });

  it("Write again answers at once and replaces that post only, a person's own words included", async () => {
    const co = await newCompany("ultra");
    const roleId = await publishedJob(co.cookie);
    for (const channel of ["linkedin", "indeed"]) expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/${channel}`, { text: `My own ${channel} words.` })).status).toBe(200);
    const asked = await json(co.cookie, "POST", `/api/v1/roles/${roleId}/share/linkedin/rewrite`);
    expect(asked.status).toBe(202);
    expect(((await asked.json()) as ShareView)).toMatchObject({ state: "writing", stateLine: null });
    const view = await share(co.cookie, roleId);
    expect(view.state).toBe("ready");
    expect(view.posts[0].edited).toBe(false);
    expect(view.posts[0].text).toContain(view.posts[0].applyUrl);
    expect(view.posts[1]).toMatchObject({ text: "My own indeed words.", edited: true });
    // a member of the team may edit and ask again; what is not a post or not a job is not found; an empty post is refused
    const member = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", name: "Mia Member" });
    expect((await json(member, "PUT", `/api/v1/roles/${roleId}/share/indeed`, { text: "A member's words." })).status).toBe(200);
    expect((await json(member, "POST", `/api/v1/roles/${roleId}/share/indeed/rewrite`)).status).toBe(202);
    expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/facebook`, { text: "Hello." })).status).toBe(404);
    expect((await json(co.cookie, "POST", `/api/v1/roles/${roleId}/share/facebook/rewrite`)).status).toBe(404);
    expect((await json(co.cookie, "GET", "/api/v1/roles/not-a-job/share")).status).toBe(404);
    expect((await json(co.cookie, "GET", "/api/v1/roles/00000000-0000-4000-8000-000000000000/share")).status).toBe(404);
    expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/indeed`, { text: "   " })).status).toBe(400);
    expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/indeed`, { text: "x".repeat(POST_TEXT_MAX + 1) })).status).toBe(400);
    // another company's job is not found
    const other = await newCompany("ultra");
    expect((await json(other.cookie, "GET", `/api/v1/roles/${roleId}/share`)).status).toBe(404);
    expect((await json(other.cookie, "POST", `/api/v1/roles/${roleId}/share/linkedin/rewrite`)).status).toBe(404);
  });

  it("says why a job that is not public has nothing to share: a closed job, and a job not published yet", async () => {
    const co = await newCompany("ultra");
    const roleId = await publishedJob(co.cookie);
    expect((await json(co.cookie, "POST", `/api/v1/roles/${roleId}/close`, { confirm: true })).status).toBe(200);
    const closed = await share(co.cookie, roleId);
    expect(closed).toMatchObject({ public: false, notPublicLine: SHARE_LINE.closed, state: "ready" });
    expect(closed.posts[0].text).toContain("src=linkedin");
    for (const [method, path, body] of [["PUT", "linkedin", { text: "Words." }], ["POST", "linkedin/rewrite", undefined]] as const) {
      const refused = await json(co.cookie, method, `/api/v1/roles/${roleId}/share/${path}`, body);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "role_closed", message: SHARE_LINE.closed });
    }
    await container.db.update(roles).set({ status: "draft", posts: null }).where(eq(roles.id, roleId));
    expect(await share(co.cookie, roleId)).toMatchObject({ public: false, notPublicLine: SHARE_LINE.draft, state: null, stateLine: null, posts: [{ text: null, edited: false, writtenAt: null }, { text: null, edited: false, writtenAt: null }] });
    const early = await json(co.cookie, "POST", `/api/v1/roles/${roleId}/share/indeed/rewrite`);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "not_published", message: SHARE_LINE.draft });
  });

  it("says when the plan's AI help is used up: at once on Write again, and after an edit of the job, with the posts left as they were", async () => {
    const co = await newCompany("free");
    const roleId = await publishedJob(co.cookie);
    const written = await share(co.cookie, roleId);
    expect(written.state).toBe("ready");
    await withPlatform(container.db, (tx) => tx.insert(aiRuns).values({ companyId: co.id, agent: "test", task: "test.spent", provider: "fake", model: "fake", promptKey: "test.spent", promptVersion: 1, promptHash: "x", costUsd: "10", status: "ok" }));
    const calls = postsWritten();
    const asked = await json(co.cookie, "POST", `/api/v1/roles/${roleId}/share/indeed/rewrite`);
    expect(asked.status).toBe(202);
    const refused = (await asked.json()) as ShareView;
    expect(refused).toMatchObject({ state: "no_ai", stateLine: SHARE_LINE.noAi });
    expect(refused.posts.map((p) => p.text)).toEqual(written.posts.map((p) => p.text));
    // a person still writes their own
    expect((await json(co.cookie, "PUT", `/api/v1/roles/${roleId}/share/linkedin`, { text: "Our own words." })).status).toBe(200);
    // an automatic rewrite finds no credit either, and the model is not asked
    expect((await json(co.cookie, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, identity: { schedule: "Tuesday to Saturday" } })).status).toBe(200);
    const after = await share(co.cookie, roleId);
    expect(after).toMatchObject({ state: "no_ai", stateLine: SHARE_LINE.noAi });
    expect(after.posts.map((p) => p.text)).toEqual(["Our own words.", written.posts[1].text]);
    expect(postsWritten()).toBe(calls);
  });

  it("tries a failed writing again within seconds, then says the posts could not be written; publishing never fails with it", async () => {
    const co = await newCompany("ultra");
    for (let i = 0; i < 4; i++) container.fake!.failNext("job.posts", "unusable");
    try {
      const roleId = await publishedJob(co.cookie);
      // the job is open and its page is public, whatever the writing does
      expect(await share(co.cookie, roleId)).toMatchObject({ public: true, state: "writing", stateLine: null });
      for (const wait of [3_000, 8_000, 17_000]) {
        moveClock(Date.now() + wait);
        await container.drain();
      }
      const failed = await share(co.cookie, roleId);
      expect(failed).toMatchObject({ state: "failed", stateLine: SHARE_LINE.failed });
      expect(failed.posts.map((p) => p.text)).toEqual([null, null]);
      // Write again tries once more and writes both posts, since neither has words yet
      expect((await json(co.cookie, "POST", `/api/v1/roles/${roleId}/share/indeed/rewrite`)).status).toBe(202);
      const view = await share(co.cookie, roleId);
      expect(view.state).toBe("ready");
      expect(view.posts.every((p) => !!p.text && p.text.includes(p.applyUrl))).toBe(true);
    } finally {
      moveClock(null);
      container.fake!.clearScripts();
    }
  });

  it("finishes what the model wrote by rule: flagged lines out, the pay and the Apply link in", async () => {
    const co = await newCompany("ultra");
    const roleId = await publishedJob(co.cookie);
    const [stored] = await container.db.select({ packet: rolePackets.packet }).from(rolePackets).where(eq(rolePackets.roleId, roleId));
    const packet = RolePacket.parse(stored.packet);
    const jobUrl = jobUrls(container.env, { slug: co.slug, roleId }).job;
    const finish = (text: string, channel: "linkedin" | "indeed" = "linkedin") => finishPost(text, { packet, facts: { pay: "$45–$55 an hour", benefits: "Health cover and a $500 uniform allowance" }, jobUrl, channel });
    // nothing to add: the words stay as written
    const whole = `We are hiring a hygienist.\n- Active CA RDH license\nPay: $45–$55 an hour\nApply: ${jobUrl}?src=linkedin`;
    expect(finish(whole)).toBe(whole);
    // the pay and the link are added when the text lacks them
    expect(finish("We are hiring a hygienist.")).toBe(`We are hiring a hygienist.\n\nPay: $45–$55 an hour\nApply: ${jobUrl}?src=linkedin`);
    // the job page's address, bare or with the other post's source, becomes this post's own link
    expect(finish(`Pay $45 to $55. Apply at ${jobUrl}?src=indeed or ${jobUrl}.`)).toBe(`Pay $45 to $55. Apply at ${jobUrl}?src=linkedin or ${jobUrl}?src=linkedin.`);
    // a line the fairness guard would flag in a job description is taken out; so is a pay figure that is not the job's
    const cleaned = finish(`We are hiring.\n- Recent graduates welcome\n- Digital charting every day\n- Earn up to $70 an hour\n- $500 uniform allowance\nPay: $45–$55 an hour\nApply: ${jobUrl}?src=indeed`, "indeed");
    expect(cleaned).toBe(`We are hiring.\n- Digital charting every day\n- $500 uniform allowance\nPay: $45–$55 an hour\nApply: ${jobUrl}?src=indeed`);
    // what is added always fits the stored length
    const long = finish("x".repeat(POST_TEXT_MAX));
    expect(long.length).toBeLessThanOrEqual(POST_TEXT_MAX);
    expect(long.endsWith(`Pay: $45–$55 an hour\nApply: ${jobUrl}?src=linkedin`)).toBe(true);
  });
});
