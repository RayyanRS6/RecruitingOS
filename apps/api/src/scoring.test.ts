import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AI_CREDIT_AVAILABLE, EARLIER_VERSION_LINE, RolePacket, SCORE_FINDING_LABEL, cvScoreOf, cvScoreSummary, type ActionResult, type CandidateList, type CandidatePanel, type RoleDetail } from "@ros/contracts";
import { aiRuns, applications, assessments, candidates, entitlements, rolePackets, roles, screens, withPlatform, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, usePlan } from "./test-helpers";

/**
 * The one scoring system through the API: the resume score of each person from their newest resume reading, the order of
 * a job's Candidates list, and what happens to those scores when the job's must-haves or skills change. The formulas
 * themselves are tested where they live (packages/contracts score.test.ts, packages/core match-score.test.ts); the
 * evidence rules in packages/agents.
 */
describe("the resume score of a job's candidates", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  const ids: Record<string, string> = {};

  const call = (method: string, path: string, body?: unknown, cookie = owner) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const read = async <T>(path: string): Promise<T> => {
    const r = await call("GET", path);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as T;
  };
  const list = (tab: string) => read<CandidateList>(`/api/v1/roles/${roleId}/applications?tab=${tab}`);
  const panel = (who: string) => read<CandidatePanel>(`/api/v1/applications/${ids[who]}`);
  const edit = async (body: Record<string, unknown>) => {
    const job = await read<RoleDetail>(`/api/v1/roles/${roleId}`);
    const r = await call("PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: job.version, ...body });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };
  const readingsOf = async (who: string) => (await container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids[who]), eq(assessments.kind, "triage")))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  /** The intake runs of one person: the first, and one for each time they were read again. */
  const runsOf = async (who: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).filter((r) => r.subject.id === ids[who]);
  const readingCalls = async () => (await container.db.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.companyId, companyId), eq(aiRuns.task, "triage.assess")))).length;

  /** A dental assistant job with two must-haves (one a certificate) and two skills, open, with its one version live. */
  const plantJob = async (): Promise<string> => {
    const actor = { kind: "system" as const, id: "test_seed" };
    const packet = RolePacket.parse({
      identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
      compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
      description: { publicJobDescription: "We are hiring a dental assistant. You will seat patients, take digital x-rays and keep the rooms ready." },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { key: "mh_chairside", text: "Chairside assisting experience" }], niceToHaves: [{ key: "n_spanish", text: "Speaks Spanish" }] },
      competencies: [
        { key: "c_dentrix", name: "Dentrix charting", definition: "Charts every visit in Dentrix.", importance: "essential", indicators: [] },
        { key: "c_sterilization", name: "Sterilization", definition: "Keeps instruments sterile.", importance: "helpful", indicators: [] },
      ],
      screening: { questions: [{ key: "recent", question: "Tell me about your most recent work." }, { key: "nervous", question: "Tell me about a nervous patient and what you did." }, { key: "available", question: "Which days and hours are you available?" }] },
      communication: { tone: "warm", companyBlurb: "A family practice.", signature: "The team", disclosureText: "This message was sent with help from an AI assistant.", humanAlternativeText: "Reply to reach a person." },
      compliance: {},
      provenance: {},
    });
    return withPlatform(container.db, async (tx) => {
      const [role] = await tx.insert(roles).values({ companyId, title: "Dental Assistant", status: "open", currentPacketVersion: 1, acceptingApplications: true, openedAt: container.engine.clock().toISOString(), createdBy: actor }).returning({ id: roles.id });
      await tx.insert(rolePackets).values({ companyId, roleId: role.id, version: 1, packet, status: "approved", source: "human_edit", createdBy: actor });
      return role.id;
    });
  };

  /** Applies on the public form with this file as the resume. */
  const applyWith = async (name: string, file: File) => {
    const email = `${name.toLowerCase()}@people.test`;
    const fd = new FormData();
    fd.set("firstName", name);
    fd.set("lastName", "Tester");
    fd.set("email", email);
    fd.set("acknowledged", "yes");
    fd.set("resume", file);
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [row] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, roleId), eq(candidates.email, email)));
    ids[name] = row.id;
  };
  const apply = (name: string, resume: string) => applyWith(name, new File([`${name} Tester\n${name.toLowerCase()}@people.test\n${resume}\n`], "resume.txt", { type: "text/plain" }));

  const EVERYTHING = "Dental Assistant at Bright Smiles 2019 - present\nRadiography certificate, California, 2021\nChairside assisting for two dentists, four-handed dentistry\nDentrix charting every visit\nSterilization of instruments, keeps trays sterile";
  const SOME = "Dental Assistant at Coast Dental 2021 - present\nRadiography certificate, California, 2022\nDentrix charting";
  const NO_CERTIFICATE = "Dental Assistant at Park Dental 2018 - present\nI do not hold a radiography certificate\nChairside assisting daily with two dentists\nDentrix charting every visit\nSterilization of instruments, keeps trays sterile";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const asked = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@scoring.test" }) });
    const { devLink } = (await asked.json()) as { devLink: string };
    const signedIn = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    owner = signedIn.headers.get("set-cookie")!.split(";")[0];
    admin = await signInAdmin(app, container, "admin@its.test");
    companyId = ((await (await call("POST", "/api/v1/companies", { name: "Scoring Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = (await read<{ slug: string }>("/api/v1/companies/current")).slug;
    await usePlan(container, companyId, "pro");
    roleId = await plantJob();
    // not in the order of their scores, nor of their names
    await apply("Held", NO_CERTIFICATE);
    await apply("Zed", SOME);
    await applyWith("Scan", new File([new Uint8Array(readFileSync(new URL("../../../packages/agents/src/fixtures/scanned.pdf", import.meta.url)))], "scan.pdf", { type: "application/pdf" }));
    await apply("Abe", SOME);
    await apply("Top", EVERYTHING);
    await apply("Rex", SOME);
  });
  afterAll(async () => { await container.close(); });

  it("lists the New tab by resume score, highest first, then who applied first, with anyone who has no score last", async () => {
    const fresh = await list("new");
    expect(fresh.rows.map((r) => [r.name, r.cvScore.score, r.cvScore.bandLabel, r.cvScore.mustHaveLine])).toEqual([
      ["Top Tester", 100, "Very high", "2 of 2 must-haves shown"],
      // the same resume, so the same number: who applied first comes first
      ["Zed Tester", 58, "Medium", "1 of 2 must-haves shown"],
      ["Abe Tester", 58, "Medium", "1 of 2 must-haves shown"],
      ["Rex Tester", 58, "Medium", "1 of 2 must-haves shown"],
      // every other requirement shown, and held at 54 because their own words say the certificate is not held
      ["Held Tester", 54, "Low", "1 of 2 must-haves shown"],
      ["Scan Tester", null, null, null],
    ]);
    expect(fresh.rows.at(-1)?.cvScore).toMatchObject({ noScore: "unreadable", noScoreLabel: "Resume could not be read" });
    expect(fresh.rows.find((r) => r.name === "Held Tester")?.cvScore.missingLine).toBe("Missing a must-have: Radiography certificate");
    expect(fresh.rows.every((r) => !r.cvScore.earlierVersion)).toBe(true);
  });

  it("opens a person with the breakdown the number comes from: every requirement of the job, its finding in the one set of words, and the quote", async () => {
    const held = await panel("Held");
    expect(held.cvScore).toMatchObject({ score: 54, band: "low", held: true, mustHaves: { shown: 1, total: 2 }, missingMustHaves: [{ key: "mh_xray", label: "Radiography certificate", quote: "I do not hold a radiography certificate" }] });
    // the must-haves first, then the skills, each in the job's own order
    expect(held.cvScore.requirements.map((r) => [r.key, r.mustHave, r.importance, r.finding, r.findingLabel, r.weightPct])).toEqual([
      ["mh_xray", true, null, "not_met", SCORE_FINDING_LABEL.not_met, 33],
      ["mh_chairside", true, null, "shown", SCORE_FINDING_LABEL.shown, 33],
      ["c_dentrix", false, "essential", "shown", SCORE_FINDING_LABEL.shown, 25],
      ["c_sterilization", false, "helpful", "shown", SCORE_FINDING_LABEL.shown, 8],
    ]);
    expect(held.cvScore.requirements[1]).toMatchObject({ quote: "Chairside assisting daily with two dentists", source: "resume" });
    // the number, the band, the must-have line and the missing line all come from that one list, by the one function
    const { requirements } = held.cvScore;
    expect(cvScoreOf(requirements.map(({ findingLabel: _label, weightPct: _weight, ...r }) => r))).toEqual(held.cvScore);
    expect((await list("new")).rows.find((r) => r.id === ids.Held)?.cvScore).toEqual(cvScoreSummary(held.cvScore));
    // the reading as stored is findings and words: no verdict, number or recommendation was asked for or kept
    const [reading] = await readingsOf("Held");
    expect(Object.keys(reading.result).sort()).toEqual(["competencyFindings", "concerns", "requirementFindings", "strengths", "summary", "unknowns"]);
    expect(reading.packetVersion).toBe(1);
    // and nothing of a stored verdict is sent to a screen
    expect(JSON.stringify([held, await list("new")])).not.toMatch(/"(?:overall|recommendation|confidence|fit|closerLook|needsCloserLook|secondaryScore)"\s*:/);
    // someone whose file has no text has no number and no breakdown, and says why
    expect((await panel("Scan")).cvScore).toMatchObject({ score: null, noScore: "unreadable", requirements: [], mustHaveLine: null });
  });

  it("reads everyone still in the process again when the job's must-haves change; with no AI help left they keep their score, marked as from an earlier version", async () => {
    // Rex is out of the process, and Late applies past the plan's candidates per job, so nobody reads them yet
    const rejected = await call("POST", `/api/v1/applications/${ids.Rex}/actions`, { action: "reject" });
    expect(((await rejected.json()) as ActionResult).stage).toBe("rejected");
    await container.db.update(entitlements).set({ limit: 6 }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "candidates_per_job")));
    await apply("Late", EVERYTHING);
    const [late] = await container.db.select().from(applications).where(eq(applications.id, ids.Late));
    expect(late.stage).toBe("received");
    expect(late.lockedAt).not.toBeNull();
    const callsBefore = await readingCalls();
    expect(callsBefore).toBe(15);
    // the plan's AI help for the month is used up
    await withPlatform(container.db, (tx) => tx.insert(aiRuns).values({ companyId, agent: "test", task: "test.spent", provider: "fake", model: "fake", promptKey: "test.spent", promptVersion: 1, promptHash: "x", costUsd: "60", status: "ok" }));
    await edit({ requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { text: "Nitrous oxide monitoring" }] } });
    expect((await read<RoleDetail>(`/api/v1/roles/${roleId}`)).version).toBe(2);
    // a reading was started for each person still in the process, and waits for the AI help
    for (const who of ["Top", "Zed", "Abe", "Held", "Scan"]) expect((await runsOf(who)).map((r) => r.idempotencyKey), who).toContain(`application_intake:${ids[who]}:v2`);
    for (const who of ["Top", "Zed", "Abe", "Held"]) expect((await runsOf(who)).find((r) => r.idempotencyKey?.endsWith(":v2")), who).toMatchObject({ status: "waiting", currentStep: "extract", wait: { kind: "event", keys: [AI_CREDIT_AVAILABLE] } });
    // nobody who left the process, and nobody the plan does not let the team read
    for (const who of ["Rex", "Late"]) expect((await runsOf(who)).filter((r) => r.idempotencyKey?.endsWith(":v2")), who).toEqual([]);
    expect(await readingCalls()).toBe(callsBefore);
    // until then: the old reading, the old number, and the line that says so
    const waiting = await list("new");
    expect(waiting.rows.map((r) => [r.name, r.cvScore.score, r.cvScore.earlierVersion])).toEqual([["Top Tester", 100, true], ["Zed Tester", 58, true], ["Abe Tester", 58, true], ["Held Tester", 54, true], ["Scan Tester", null, false]]);
    expect((await panel("Top")).cvScore).toMatchObject({ score: 100, earlierVersion: true, earlierVersionLine: EARLIER_VERSION_LINE });
    expect((await panel("Top")).cvScore.requirements.map((r) => r.key)).toEqual(["mh_xray", "mh_chairside", "c_dentrix", "c_sterilization"]);

    // an administrator moves the company to a bigger plan: the AI help is back, and the plan opens Late
    const changed = await call("POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "ultra", reason: "They asked for more AI help." }, admin);
    expect(changed.status, await changed.clone().text()).toBe(200);
    await container.drain();
    // each is read again, three readings each, against the job as it is now; Late is read for the first time, against it too
    expect(await readingCalls()).toBe(callsBefore + 5 * 3);
    for (const who of ["Top", "Zed", "Abe", "Held"]) {
      expect((await readingsOf(who)).map((r) => r.packetVersion), who).toEqual([1, 2]);
      expect((await runsOf(who)).every((r) => r.status === "completed"), who).toBe(true);
    }
    expect((await readingsOf("Late")).map((r) => r.packetVersion)).toEqual([2]);
    expect(await readingsOf("Rex")).toHaveLength(1);
    expect(await readingsOf("Scan")).toHaveLength(0);
    // one list, one set of requirements: nobody shows the new must-have, so every number is counted against it
    const again = await list("new");
    expect(again.rows.map((r) => [r.name, r.cvScore.score, r.cvScore.mustHaveLine, r.cvScore.earlierVersion])).toEqual([
      ["Top Tester", 67, "1 of 2 must-haves shown", false],
      ["Late Tester", 67, "1 of 2 must-haves shown", false],
      ["Zed Tester", 58, "1 of 2 must-haves shown", false],
      ["Abe Tester", 58, "1 of 2 must-haves shown", false],
      ["Held Tester", 33, "0 of 2 must-haves shown", false],
      ["Scan Tester", null, null, false],
    ]);
    const top = await panel("Top");
    expect(top.cvScore.requirements.map((r) => [r.label, r.finding])).toEqual([["Radiography certificate", "shown"], ["Nitrous oxide monitoring", "not_shown"], ["Dentrix charting", "shown"], ["Sterilization", "shown"]]);
    expect(top.cvScore.earlierVersionLine).toBeNull();
    // under 54 nothing is held, and the must-have their words say is not met is still named
    expect((await panel("Held")).cvScore).toMatchObject({ score: 33, held: false, missingLine: "Missing a must-have: Radiography certificate" });
    // someone out of the process keeps the score they were decided on, and it says which job it was read against
    expect((await list("not_selected")).rows.map((r) => [r.name, r.cvScore.score, r.cvScore.earlierVersion])).toEqual([["Rex Tester", 58, true]]);
  });

  it("reads nobody again when an edit leaves the must-haves and skills as they are", async () => {
    const calls = await readingCalls();
    const runs = (await container.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).length;
    await edit({ description: "We are hiring a dental assistant for our Irvine practice. You will seat patients, take digital x-rays and keep the rooms ready." });
    expect((await read<RoleDetail>(`/api/v1/roles/${roleId}`)).version).toBe(3);
    expect(await readingCalls()).toBe(calls);
    expect((await container.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.workflowKey, "application_intake"))).length).toBe(runs);
    // a reading against version 2 still answers what version 3 asks for
    expect((await list("new")).rows.map((r) => [r.name, r.cvScore.score, r.cvScore.earlierVersion])).toEqual([["Top Tester", 67, false], ["Late Tester", 67, false], ["Zed Tester", 58, false], ["Abe Tester", 58, false], ["Held Tester", 33, false], ["Scan Tester", null, false]]);
  });

  it("reads everyone again when a skill's importance changes, because the number weighs it", async () => {
    const calls = await readingCalls();
    await edit({ competencies: [{ key: "c_dentrix", name: "Dentrix charting", importance: "helpful", definition: "Charts every visit in Dentrix." }, { key: "c_sterilization", name: "Sterilization", importance: "essential", definition: "Keeps instruments sterile." }] });
    expect(await readingCalls()).toBe(calls + 5 * 3);
    for (const who of ["Top", "Zed", "Abe", "Held"]) expect((await readingsOf(who)).map((r) => r.packetVersion), who).toEqual([1, 2, 4]);
    expect((await readingsOf("Late")).map((r) => r.packetVersion)).toEqual([2, 4]);
    // Zed and Abe show Dentrix and not sterilization: 4 + 1 of 12 points now
    expect((await list("new")).rows.map((r) => [r.name, r.cvScore.score, r.cvScore.earlierVersion])).toEqual([["Top Tester", 67, false], ["Late Tester", 67, false], ["Zed Tester", 42, false], ["Abe Tester", 42, false], ["Held Tester", 33, false], ["Scan Tester", null, false]]);
  });

  it("an AI interview asks about the must-haves of the job version the person applied to that their resume reading did not find shown", async () => {
    const planOf = async (who: string) => {
      const sent = await call("POST", `/api/v1/applications/${ids[who]}/actions`, { action: "shortlist" });
      expect(sent.status, await sent.clone().text()).toBe(200);
      await container.drain();
      const [invited] = await container.db.select().from(screens).where(eq(screens.applicationId, ids[who]));
      expect((await app.request(`/c/screen/${invited.token}/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" })).status).toBe(302);
      const [started] = await container.db.select().from(screens).where(eq(screens.id, invited.id));
      return started.progress.chat?.items.map((i) => [i.key, i.kind]);
    };
    // Top's reading against the version they applied to shows both of its must-haves: the chat has only the job's own questions
    expect(await planOf("Top")).toEqual([["recent", "question"], ["nervous", "question"], ["available", "question"]]);
    // Zed's did not show one of them; the must-have the job gained later is not theirs to be asked about
    expect(await planOf("Zed")).toEqual([["recent", "question"], ["nervous", "question"], ["available", "question"], ["mh_chairside", "gap"]]);
    // Late was first read after the job changed: the must-have that reading says nothing about is asked about
    expect(await planOf("Late")).toEqual([["recent", "question"], ["nervous", "question"], ["available", "question"], ["mh_chairside", "gap"]]);
  });
});
