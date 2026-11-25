import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ROLE_ACTION_BLOCKED, RolePacket, type Actor, type ApplicationStage, type CandidateList, type ClosingDateAnswer, type HomeView, type PacketFlag, type PacketSaved, type RoleDetail, type RoleSummary } from "@ros/contracts";
import { addCalendarDays, companyToday, entitlements } from "@ros/core";
import { applications, candidates, companies, events, randomToken, rolePackets, roles, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { placeOf } from "./services/jobs";
import { signInAs } from "./test-helpers";

/**
 * Jobs through their API: the Jobs list, a job's page, its one editor, and pause, resume, close and the closing date.
 * Everyone on the team reads, edits and publishes; an owner or an admin also pauses, resumes, closes and sets the date.
 */
describe("jobs", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let member = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  type Refusal = { error: { code: string; message: string; details?: { flags?: PacketFlag[]; problems?: Array<{ rule: string }> } } };

  /** A job record that passes every check in California: an on-site job in Irvine with its pay on the ad. */
  const packet = (change: (p: RolePacket) => void = () => {}): RolePacket => {
    const p = RolePacket.parse({
      identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
      compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
      description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready." },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate", rationale: "State law asks for it." }], niceToHaves: [] },
      competencies: [{ key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "essential", indicators: ["Four-handed dentistry"] }],
      screening: { questions: [{ key: "recent", question: "Tell me about your most recent dental assisting work.", kind: "skills", modelAnswer: "Names chairside work." }, { key: "nervous", question: "Tell me about a nervous patient and what you did.", kind: "behavioral" }, { key: "available", question: "Which days and hours are you available?", kind: "availability" }] },
      formQuestions: [{ kind: "yes_no", key: "fq_xray", question: "Do you hold a radiography certificate?" }],
      communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The team at Harbor Dental", disclosureText: "This message was sent with help from an AI assistant.", humanAlternativeText: "Reply to reach a person." },
      compliance: {},
      provenance: {},
    });
    change(p);
    return p;
  };
  /** A job with one version, in the given status, written straight into the tables. */
  const job = (status: "draft" | "open" | "paused" | "closed", input: { title?: string; packet?: unknown } = {}) =>
    withTenant(container.db, companyId, async (tx) => {
      const actor: Actor = { kind: "user", id: ownerId, name: "Dana Owner" };
      const live = status !== "draft";
      const [role] = await tx.insert(roles).values({ companyId, title: input.title ?? "Dental Assistant", status, createdBy: actor, ...(live ? { openedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), currentPacketVersion: 1 } : {}) }).returning();
      await tx.insert(rolePackets).values({ companyId, roleId: role.id, version: 1, packet: (input.packet ?? packet()) as RolePacket, status: live ? "approved" : "proposed", source: "human_edit", createdBy: actor });
      return role.id;
    });
  const applicant = (roleId: string, stage: ApplicationStage, n: number, locked = false) =>
    withTenant(container.db, companyId, async (tx) => {
      const [c] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: `Lee ${n}`, email: `pat${n}.${roleId.slice(0, 8)}@candidate.test` }).returning();
      await tx.insert(applications).values({ companyId, roleId, candidateId: c.id, packetVersion: 1, source: "direct", stage, statusToken: randomToken(16), ...(locked ? { lockedAt: new Date().toISOString() } : {}) });
    });
  const detailOf = async (cookie: string, roleId: string) => (await (await json(cookie, "GET", `/api/v1/roles/${roleId}`)).json()) as RoleDetail;
  const roleRow = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const versionsOf = (roleId: string) => container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId)).orderBy(rolePackets.version);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@jobs.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    await entitlements.applyPlan(container.db, companyId, "ultra");
    member = await signInAs(container, app, { companyId, role: "hiring_manager", email: "mo@jobs.test", name: "Mo Member" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("lists every job, newest first, with its place, its status in words and its people by tab, the locked ones only as a number", async () => {
    const first = await job("open", { title: "Dental Assistant" });
    const second = await job("paused", { title: "Front Desk Lead", packet: packet((p) => { p.identity.title = "Front Desk Lead"; p.identity.locations = [{ city: "Tustin", region: "CA", country: "US" }]; }) });
    for (const [stage, n] of [["applied", 1], ["triaged", 2], ["screen_invited", 3], ["screen_complete", 4], ["hired", 5], ["rejected", 6], ["withdrawn", 7]] as const) await applicant(first, stage, n);
    await applicant(first, "received", 8, true);
    const r = await json(member, "GET", "/api/v1/roles");
    expect(r.status).toBe(200);
    const list = (await r.json()) as RoleSummary[];
    const mine = list.filter((j) => [first, second].includes(j.id));
    expect(mine.map((j) => [j.id, j.title, j.place, j.status, j.statusLabel])).toEqual([[second, "Front Desk Lead", "Tustin, CA", "paused", "Paused"], [first, "Dental Assistant", "Irvine, CA", "open", "Open"]]);
    const counted = mine[1];
    expect(counted.counts).toEqual({ total: 8, byTab: { new: 2, shortlisted: 1, interviewed: 1, hired: 1, not_selected: 2 }, locked: 1 });
    expect(counted).toMatchObject({ daysOpen: 3, closedAt: null, closesOn: null, acceptingApplications: true });
    for (const at of [counted.createdAt, counted.openedAt, counted.lastActivityAt]) expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(counted.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(counted.createdAt));
    expect(mine[0]).toMatchObject({ acceptingApplications: false, counts: { total: 0, locked: 0 } });
    // the same figures on the job's own page, on its Candidates list and on Home: one count is behind all four
    expect((await detailOf(member, first)).counts).toEqual(counted.counts);
    expect(((await (await json(member, "GET", `/api/v1/roles/${first}/applications?tab=new`)).json()) as CandidateList).counts).toEqual(counted.counts);
    const onHome = ((await (await json(member, "GET", "/api/v1/home")).json()) as HomeView).jobs.find((j) => j.id === first);
    expect(onHome).toMatchObject({ toReview: counted.counts.byTab.new, interviewed: counted.counts.byTab.interviewed, applicants: counted.counts.total });
    // one status at a time, and nothing for a word that is no status
    expect(((await (await json(owner, "GET", "/api/v1/roles?status=paused")).json()) as RoleSummary[]).every((j) => j.status === "paused")).toBe(true);
    expect((await json(owner, "GET", "/api/v1/roles?status=pending_approval")).status).toBe(400);
    expect(placeOf([])).toBeNull();
    expect(placeOf([{ label: "Main office" }])).toBe("Main office");
  });

  it("shows a job's page: the live version, its checks, its addresses and what this person may do with it", async () => {
    const roleId = await job("open");
    const [company] = await container.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId));
    const asOwner = await detailOf(owner, roleId);
    expect(asOwner).toMatchObject({ id: roleId, title: "Dental Assistant", place: "Irvine, CA", status: "open", version: 1, public: true, publish: null, payShown: true, payRequiredByLaw: true });
    expect(asOwner.packet?.requirements.mustHaves).toEqual([{ key: "mh_xray", text: "Radiography certificate", rationale: "State law asks for it." }]);
    expect(asOwner.urls).toEqual({ careers: `https://jobs.example.test/careers/${company.slug}`, job: `https://jobs.example.test/careers/${company.slug}/jobs/${roleId}`, apply: `https://jobs.example.test/careers/${company.slug}/jobs/${roleId}/apply` });
    expect(asOwner.legalCheck).toMatchObject({ jurisdictions: ["US-CA"], missing: [] });
    expect(asOwner.closingDate).toMatchObject({ closesOn: null, requiredByLaw: false });
    expect(asOwner.flags).toEqual([]);
    expect(asOwner.actions).toEqual([
      { action: "edit", label: "Edit", allowed: true, reason: null },
      { action: "pause", label: "Pause", allowed: true, reason: null },
      { action: "set_closing_date", label: "Closing date", allowed: true, reason: null },
      { action: "close", label: "Close job", allowed: true, reason: null },
    ]);
    // a member edits, and reads why the rest is not theirs
    expect((await detailOf(member, roleId)).actions.map((a) => [a.action, a.allowed, a.reason])).toEqual([["edit", true, null], ["pause", false, ROLE_ACTION_BLOCKED.ownerOrAdmin], ["set_closing_date", false, ROLE_ACTION_BLOCKED.ownerOrAdmin], ["close", false, ROLE_ACTION_BLOCKED.ownerOrAdmin]]);
    // a draft says whether it may be published, and a closed job is only read
    const draft = await detailOf(owner, await job("draft"));
    expect(draft).toMatchObject({ status: "draft", statusLabel: "Draft", public: false, publish: { allowed: true, blockers: [] }, openedAt: null, daysOpen: null });
    expect(draft.actions.map((a) => a.action)).toEqual(["edit", "publish", "set_closing_date", "close"]);
    const closed = await detailOf(owner, await job("closed"));
    expect(closed).toMatchObject({ status: "closed", public: false, acceptingApplications: false });
    expect(closed.actions).toEqual([{ action: "edit", label: "Edit", allowed: false, reason: ROLE_ACTION_BLOCKED.closed }]);
    expect((await json(owner, "GET", "/api/v1/roles/not-an-id")).status).toBe(404);
    expect((await json(owner, "GET", "/api/v1/roles/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("reads a version stored before the record was made smaller as today's record", async () => {
    const old = {
      ...packet(),
      business: { reason: "growth", timeline: {} },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate", evidencedBy: ["resume"] }], niceToHaves: [], eligibility: [{ key: "license", type: "license", question: "Do you hold an RDA license?", rationale: "Some duties need it.", knockout: true, expectation: {} }] },
      competencies: [{ key: "chairside", name: "Chairside skill", definition: "Anticipates the next step.", weight: 5, evaluatedIn: "both", indicators: [] }],
      formQuestions: undefined,
      interviews: { plan: [{ key: "owner", title: "Conversation", durationMinutes: 30 }] },
      preferences: { decisionMakerName: "Dana", dealBreakersInTheirWords: ["No RDA"] },
    };
    const detail = await detailOf(owner, await job("open", { packet: old }));
    expect(Object.keys(detail.packet!).sort()).toEqual(["communication", "compensation", "competencies", "compliance", "description", "formQuestions", "identity", "provenance", "requirements", "schemaVersion", "screening"]);
    expect(detail.packet?.competencies[0].importance).toBe("essential");
    expect(detail.packet?.formQuestions).toEqual([{ kind: "yes_no", key: "license", question: "Do you hold an RDA license?", help: "Some duties need it.", required: true }]);
  });

  it("saves an edit of an open job as a new version that is live at once, keeping what the editor does not carry for an item whose words did not change", async () => {
    const roleId = await job("open");
    const r = await json(member, "PATCH", `/api/v1/roles/${roleId}/packet`, {
      baseVersion: 1,
      identity: { title: "Lead Dental Assistant", schedule: "Monday to Thursday, 7 to 5", department: null },
      compensation: { min: 26, max: 30 },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Current radiography certificate" }, { text: "Two years chairside" }] },
      competencies: [{ key: "chairside", name: "Chairside skill", importance: "important" }, { name: "Sterilization", importance: "helpful", definition: "Keeps instruments ready." }],
      screening: { questions: [{ key: "available", question: "Which days and hours are you available?" }, { key: "recent", question: "Tell me about your most recent dental assisting work." }, { question: "How do you set up for a crown prep?", modelAnswer: "Names the tray and the steps." }], maxMinutes: 15 },
      formQuestions: [{ kind: "yes_no", key: "fq_xray", question: "Do you hold a current radiography certificate?" }, { kind: "number", question: "How many years have you assisted chairside?", unit: "years", min: 0, max: 50 }],
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const saved = (await r.json()) as PacketSaved;
    expect(saved.guardChanges).toEqual([]);
    expect(saved.role).toMatchObject({ id: roleId, title: "Lead Dental Assistant", status: "open", version: 2 });
    const p = saved.role.packet!;
    expect(p.identity).toMatchObject({ title: "Lead Dental Assistant", schedule: "Monday to Thursday, 7 to 5", remotePolicy: "onsite" });
    expect(p.compensation).toMatchObject({ basis: "hourly", min: 26, max: 30 });
    // the same item keeps its key, and what the editor does not carry for as long as its words are the same (the skill
    // and the two questions sent back as they were); a new one gets a key. The must-have's words were rewritten, so the
    // "why it matters" written for the old ones is not kept beside them (apps/api/src/packet-fields.test.ts has the rest)
    expect(p.requirements.mustHaves).toEqual([{ key: "mh_xray", text: "Current radiography certificate" }, { key: "mh_two_years_chairside", text: "Two years chairside" }]);
    expect(p.requirements.mustHaves[0]).not.toHaveProperty("rationale");
    expect(p.competencies).toEqual([{ key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "important", indicators: ["Four-handed dentistry"] }, { key: "skill_sterilization", name: "Sterilization", definition: "Keeps instruments ready.", importance: "helpful", indicators: [] }]);
    expect(p.screening.questions.map((q) => [q.key, q.kind, q.modelAnswer ?? null])).toEqual([["available", "availability", null], ["recent", "skills", "Names chairside work."], ["q_how_do_you_set_up_for_a_crown", "skills", "Names the tray and the steps."]]);
    expect(p.screening.maxMinutes).toBe(15);
    expect(p.formQuestions).toEqual([{ kind: "yes_no", key: "fq_xray", question: "Do you hold a current radiography certificate?", required: true }, { kind: "number", key: "fq_how_many_years_have_you_assist", question: "How many years have you assisted chairside?", required: true, unit: "years", min: 0, max: 50 }]);
    // pay set in the editor counts as a person confirming it
    expect(p.provenance.payConfirmedBy).toMatchObject({ via: "edited", by: { kind: "user", name: "Mo Member" } });
    expect((await versionsOf(roleId)).map((v) => [v.version, v.status, v.changeSummary])).toEqual([[1, "superseded", null], [2, "approved", "Edited: the job's facts, pay, requirements, skills, the AI interview's questions, screening questions"]]);
    expect(await roleRow(roleId)).toMatchObject({ currentPacketVersion: 2, title: "Lead Dental Assistant" });
    // someone who opened the page before that save is asked to reload
    const stale = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, identity: { title: "Dental Assistant II" } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Refusal).error.code).toBe("stale_version");
    const same = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 2, identity: { title: "Lead Dental Assistant" } });
    expect(same.status).toBe(400);
    expect(((await same.json()) as Refusal).error.code).toBe("nothing_changed");
  });

  it("refuses an edit of an open job that carries flagged wording until it is changed or kept with a reason", async () => {
    const roleId = await job("open");
    const description = "Harbor Dental is hiring a dental assistant in Irvine to join our team of digital natives. You will seat patients and take digital x-rays.";
    const r = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, description });
    expect(r.status).toBe(422);
    const refusal = (await r.json()) as Refusal;
    expect(refusal.error).toMatchObject({ code: "packet_flags", message: "One phrase in this job needs a decision first: edit it out, or keep it and say why." });
    const [flag] = refusal.error.details!.flags!;
    expect(flag).toMatchObject({ path: "description.publicJobDescription", rule: "age", text: "digital natives" });
    expect((await versionsOf(roleId)).map((v) => v.version)).toEqual([1]);
    // kept, with the reason and who kept it
    const kept = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, description, keepFlags: [{ flagId: flag.id, reason: "It is the name of our training programme." }] });
    expect(kept.status, await kept.clone().text()).toBe(200);
    const saved = (await kept.json()) as PacketSaved;
    expect(saved.role.version).toBe(2);
    expect(saved.role.flags).toMatchObject([{ id: flag.id, kept: { reason: "It is the name of our training programme.", by: { kind: "user", id: ownerId } } }]);
    const types = (await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.subjectId, `${roleId}:2`)))).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["role_packet.edited", "role_packet.approved", "packet.flag_kept"]));
    // a screening question about a protected characteristic is never kept with a reason
    const asked = await json(owner, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 2, formQuestions: [{ kind: "yes_no", question: "Are you married?" }], keepFlags: [{ flagId: "any", reason: "We want to know." }] });
    expect(asked.status).toBe(422);
    expect(((await asked.json()) as Refusal).error).toMatchObject({ code: "question_not_allowed", details: { problems: [{ rule: "asks_family" }] } });
    // on a draft the edit is saved with its flag, which holds publishing
    const draft = await job("draft");
    const onDraft = await json(owner, "PATCH", `/api/v1/roles/${draft}/packet`, { baseVersion: 1, description });
    expect(onDraft.status).toBe(200);
    const d = ((await onDraft.json()) as PacketSaved).role;
    expect(d).toMatchObject({ status: "draft", version: 2 });
    expect(d.publish?.blockers.map((b) => b.code)).toEqual(["open_flags"]);
    expect((await json(owner, "POST", `/api/v1/roles/${draft}/publish`)).status).toBe(409);
    const fixed = await json(owner, "PATCH", `/api/v1/roles/${draft}/packet`, { baseVersion: 2, keepFlags: [{ flagId: d.flags[0].id, reason: "It is the name of our training programme." }] });
    expect(fixed.status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/roles/${draft}/publish`)).status).toBe(200);
  });

  it("pauses and resumes: only an owner or an admin, only from the right status, answering the job as it stands", async () => {
    const roleId = await job("open");
    expect((await json(member, "POST", `/api/v1/roles/${roleId}/pause`, {})).status).toBe(403);
    const paused = await json(owner, "POST", `/api/v1/roles/${roleId}/pause`, { reason: "On holiday" });
    expect(paused.status).toBe(200);
    const p = (await paused.json()) as RoleDetail;
    expect(p).toMatchObject({ id: roleId, status: "paused", statusLabel: "Paused", public: true, acceptingApplications: false });
    expect(p.actions.map((a) => a.action)).toEqual(["edit", "resume", "set_closing_date", "close"]);
    const twice = await json(owner, "POST", `/api/v1/roles/${roleId}/pause`, {});
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as Refusal).error).toMatchObject({ code: "not_open", message: "This job is already paused." });
    const resumed = await json(owner, "POST", `/api/v1/roles/${roleId}/resume`);
    expect(resumed.status).toBe(200);
    expect((await resumed.json()) as RoleDetail).toMatchObject({ status: "open", acceptingApplications: true });
    expect(((await (await json(owner, "POST", `/api/v1/roles/${roleId}/resume`)).json()) as Refusal).error.code).toBe("not_paused");
    const draft = await job("draft");
    expect(((await (await json(owner, "POST", `/api/v1/roles/${draft}/pause`, {})).json()) as Refusal).error.code).toBe("not_open");
    const history = (await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.subjectId, roleId)))).filter((e) => e.type === "role.paused" || e.type === "role.resumed");
    expect(history.map((e) => [e.type, (e.payload as { reason: string | null }).reason])).toEqual([["role.paused", "On holiday"], ["role.resumed", null]]);
  });

  it("closes a job for good with a confirmation: nobody is told, nobody is moved, and its place on the plan comes back", async () => {
    const roleId = await job("open");
    await applicant(roleId, "triaged", 20);
    await applicant(roleId, "screen_invited", 21);
    expect((await json(member, "POST", `/api/v1/roles/${roleId}/close`, { confirm: true })).status).toBe(403);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/close`, {})).status).toBe(400);
    expect((await roleRow(roleId)).status).toBe("open");
    const before = await withTenant(container.db, companyId, (tx) => entitlements.roleRoom(tx, companyId));
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/close`, { confirm: true });
    expect(r.status).toBe(200);
    const closed = (await r.json()) as RoleDetail;
    expect(closed).toMatchObject({ id: roleId, status: "closed", statusLabel: "Closed", public: false, acceptingApplications: false });
    expect(closed.closedAt).toBeTruthy();
    expect(closed.actions).toEqual([{ action: "edit", label: "Edit", allowed: false, reason: ROLE_ACTION_BLOCKED.closed }]);
    // everyone is where they were
    expect(closed.counts.byTab).toMatchObject({ new: 1, shortlisted: 1 });
    expect((await container.db.select({ stage: applications.stage }).from(applications).where(eq(applications.roleId, roleId))).map((a) => a.stage).sort()).toEqual(["screen_invited", "triaged"]);
    expect((await withTenant(container.db, companyId, (tx) => entitlements.roleRoom(tx, companyId))).used).toBe(before.used - 1);
    // final: a second press answers the closed job, and nothing changes it any more
    expect(((await (await json(owner, "POST", `/api/v1/roles/${roleId}/close`, { confirm: true })).json()) as RoleDetail).status).toBe("closed");
    for (const [method, path, body] of [["POST", "resume", undefined], ["POST", "pause", {}], ["POST", "publish", undefined], ["PATCH", "packet", { baseVersion: 1, identity: { title: "Reopened" } }], ["POST", "closing-date", { closesOn: null }]] as const) {
      const refused = await json(owner, method, `/api/v1/roles/${roleId}/${path}`, body);
      expect(refused.status, path).toBe(409);
      expect(((await refused.json()) as Refusal).error, path).toMatchObject({ code: "role_closed", message: ROLE_ACTION_BLOCKED.closed });
    }
    expect((await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.subjectId, roleId), eq(events.type, "role.closed")))).length).toBe(1);
  });

  it("sets a job's closing date, arms its timer, and keeps a date where the law asks for one", async () => {
    const roleId = await job("open");
    const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const closesOn = addCalendarDays(companyToday(container.engine.clock(), company.timezone), 14);
    expect((await json(member, "POST", `/api/v1/roles/${roleId}/closing-date`, { closesOn })).status).toBe(403);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/closing-date`, { closesOn: "2020-01-01" })).status).toBe(400);
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/closing-date`, { closesOn });
    expect(r.status).toBe(200);
    const answer = (await r.json()) as ClosingDateAnswer;
    expect(answer).toMatchObject({ ok: true, reopened: false, closingDate: { closesOn, passed: false, requiredByLaw: false } });
    expect(Object.keys(answer).sort()).toEqual(["closingDate", "ok", "reopened"]);
    const timers = await container.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.workflowKey, "role_closing_date")));
    expect(timers.filter((t) => (t.subject as { id?: string }).id === roleId && (t.state as { closesOn?: string }).closesOn === closesOn)).toHaveLength(1);
    expect(((await (await json(owner, "POST", `/api/v1/roles/${roleId}/closing-date`, { closesOn: null })).json()) as ClosingDateAnswer).closingDate.closesOn).toBeNull();
    // Colorado asks the ad to say when applications close: the date can move, never go
    const colorado = await job("open", { packet: packet((p) => { p.identity.locations = [{ city: "Denver", region: "CO", country: "US" }]; p.compensation.benefitsSummary = "Health and dental."; }) });
    const kept = await json(owner, "POST", `/api/v1/roles/${colorado}/closing-date`, { closesOn: null });
    expect(kept.status).toBe(409);
    expect(((await kept.json()) as Refusal).error.code).toBe("closing_date_required");
  });
});
