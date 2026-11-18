import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { closingMoment, companyToday, defaultClosingDate, entitlements } from "@ros/core";
import { applicationLinks, companies, events, notifications, policies, postings, rolePackets, roles, users, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { createApplication } from "./services/applications";
import { lateApplicationAllowed, sealFormOpened } from "./services/closing-date";
import { backfillPublishing } from "./services/publishing-backfill";
import { jobUrls } from "./services/job-urls";
import { signInAs } from "./test-helpers";

/**
 * Approving and publishing (plan Wave D, server slice): the boards each role uses (Q11, D6), which the team posts from its
 * own accounts, what the screen right after approval reads (D2), changes to a live job (Q10, D4), the
 * legal check before approval (D5), the closing date and its timer in the company's time zone (Q12, D7), one-tap
 * sharing with links that open the job page and preview fetchers left uncounted (D8), and what starts on its own once
 * the job is live (D9).
 */
describe("publishing: boards, live edits, the legal check, the closing date and sharing", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleA = "";
  let roleB = "";
  let roleC = "";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  let clockOffset = 0;
  const setClock = (offsetMs: number) => { clockOffset = offsetMs; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };
  const advance = async (ms: number) => { setClock(clockOffset + ms); await container.drain(); };
  const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (cookie: string, path: string) => json(cookie, "GET", path);
  const post = (cookie: string, path: string, body: unknown = {}) => json(cookie, "POST", path, body);
  const body = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const MESSAGE = "I need a bookkeeper in Irvine, $60,000 to $70,000, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
  /** A drafted role waiting for approval; `mutate` changes version 1 before anyone approves it (a place, the benefits). */
  const newRole = async (cookie: string, mutate?: (p: RolePacket) => void) => {
    const s = await body<{ session: { id: string } }>(await post(cookie, "/api/v1/intake/sessions", { initialMessage: MESSAGE }));
    const roleId = (await body<{ roleId: string }>(await post(cookie, `/api/v1/intake/sessions/${s.session.id}/compile`))).roleId;
    await container.drain();
    if (mutate) {
      const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
      const packet = structuredClone(pv.packet);
      mutate(packet);
      await container.db.update(rolePackets).set({ packet }).where(eq(rolePackets.id, pv.id));
    }
    return roleId;
  };
  const settings = async (patch: Record<string, unknown>, id = companyId) => {
    const [co] = await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, id));
    await container.db.update(companies).set({ settings: { ...co.s, ...patch } }).where(eq(companies.id, id));
  };
  const posting = async (roleId: string, channel: string) => (await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, channel))))[0];
  const roleRow = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  type Card = { kind: string; title: string; body: string; roleId?: string; actions: Array<{ label: string; method: string; path: string; body?: Record<string, unknown> }> };
  const brief = async (cookie: string) => (await body<{ cards: Card[] }>(await get(cookie, "/api/v1/brief"))).cards;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@publish.test");
    const co = await body<{ id: string; slug: string }>(await post(owner, "/api/v1/companies", { name: "Ledger & Co", vertical: "professional_services", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] }));
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
  });
  afterAll(async () => {
    await container.close();
  });

  it("before approval the board ticks follow the role plan; ZipRecruiter needs the company's own plan; approving prepares only the chosen boards, and Today asks the team to post them", async () => {
    roleA = await newRole(owner);
    type Detail = { boards: Array<{ channel: string; chosen: boolean; available: boolean; reason: string | null; inRolePlan: boolean }>; autoActionsOnOpen: { lines: Array<{ actionType: string; level: string; text: string }>; changeHref: string }; closingDate: { closesOn: string | null; requiredByLaw: boolean } };
    const d = await body<Detail>(await get(owner, `/api/v1/roles/${roleA}`));
    // the fake role plan names Indeed (and referrals), so Indeed is ticked; LinkedIn is offered; ZipRecruiter is not, and says why
    expect(d.boards.map((b) => [b.channel, b.chosen, b.available, b.inRolePlan])).toEqual([["linkedin_basic", false, true, false], ["indeed", true, true, true], ["ziprecruiter", false, false, false]]);
    expect(d.boards[2].reason).toMatch(/own paid ZipRecruiter plan/);
    expect(d.autoActionsOnOpen.lines.map((l) => l.actionType)).toEqual(["message.send_templated", "application.invite_screen"]);
    expect(d.autoActionsOnOpen.lines[0].text).toMatch(/one email.*thank you, and the link to their AI interview/);
    expect(d.autoActionsOnOpen.changeHref).toBe("/setup#setup-rules");
    expect(d.closingDate).toMatchObject({ closesOn: null, requiredByLaw: false });
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleA}/channels`, { channels: ["ziprecruiter"] }))).code).toBe("ziprecruiter_needs_plan");
    const ticked = await body<{ boards: Array<{ channel: string; chosen: boolean }> }>(await post(owner, `/api/v1/roles/${roleA}/channels`, { channels: ["indeed", "linkedin_basic"] }));
    expect(ticked.boards.filter((b) => b.chosen).map((b) => b.channel)).toEqual(["linkedin_basic", "indeed"]);
    expect((await roleRow(roleA)).publishChannels).toEqual(["linkedin_basic", "indeed"]);
    expect((await container.db.select().from(events).where(eq(events.type, "role.boards_chosen"))).length).toBe(1);
    const hiring = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@publish.test" });
    expect((await post(hiring, `/api/v1/roles/${roleA}/channels`, { channels: [] })).status).toBe(403);

    expect((await post(owner, `/api/v1/roles/${roleA}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const rows = await container.db.select().from(postings).where(eq(postings.roleId, roleA));
    expect(rows.map((p) => p.channel).sort()).toEqual(["careers_page", "email_in", "google_jobs", "indeed", "linkedin_basic"]);
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "publish_role"));
    expect(run.workflowVersion).toBe(3);
    // each board waits for the team to post it from its own account: Today says so, and offers to share the new job
    expect((await posting(roleA, "indeed")).status).toBe("ready_to_post");
    expect((await posting(roleA, "linkedin_basic")).status).toBe("ready_to_post");
    const cards = await brief(owner);
    expect(cards.find((c) => c.kind === "posting_action" && c.roleId === roleA)?.title).toMatch(/: post it on (LinkedIn, Indeed|Indeed, LinkedIn) from your own account$/);
    expect(cards.find((c) => c.kind === "share" && c.roleId === roleA)?.actions[0]).toMatchObject({ method: "GET", path: `/roles/${roleA}?tab=posting#share` });
  });

  it("the screen right after approval reads where publishing stands, the share block and the interviewers note", async () => {
    type View = { publishing: { state: string; pollAfterSeconds: number | null; checksPending: number }; emailIn: { shown: boolean }; postings: Array<{ channel: string; chosen: boolean; showsOldVersion: boolean }>; share: { jobUrl: string; text: string; places: Array<{ place: string; link: unknown }> }; interviewers: { rounds: number; roundsWithoutInterviewers: number }; closingDate: { closesOn: string | null } };
    const v = await body<View>(await get(owner, `/api/v1/roles/${roleA}/postings`));
    expect(v.publishing).toMatchObject({ state: "ready", pollAfterSeconds: null, checksPending: 0 });
    // applications by email are offered only while they work
    expect(v.emailIn.shown).toBe(false);
    expect(v.postings.find((p) => p.channel === "indeed")).toMatchObject({ chosen: true, showsOldVersion: false });
    const urls = jobUrls(container.env, { slug, roleId: roleA });
    expect(v.share.jobUrl).toBe(urls.job);
    expect(v.share.text).toContain(urls.job);
    expect(v.share.places.map((p) => p.place)).toEqual(["referral", "school", "community", "email", "text", "whatsapp", "linkedin", "facebook", "x"]);
    expect(v.share.places.every((p) => p.link === null)).toBe(true);
    expect(v.interviewers.rounds).toBeGreaterThanOrEqual(1);
    expect(v.interviewers.roundsWithoutInterviewers).toBe(v.interviewers.rounds);
    // nothing is public before the ITS check (founder decision B7), so Today offers no "share it now" until then
    const [co] = await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const unchecked = { ...co.s };
    delete unchecked.verifiedAt;
    await container.db.update(companies).set({ settings: unchecked }).where(eq(companies.id, companyId));
    expect((await brief(owner)).some((c) => c.kind === "share")).toBe(false);
    await container.db.update(companies).set({ settings: co.s }).where(eq(companies.id, companyId));
    expect((await brief(owner)).some((c) => c.kind === "share" && c.roleId === roleA)).toBe(true);
    // a role still waiting for approval has nothing public, and the screen does not poll
    roleB = await newRole(owner);
    expect((await body<View>(await get(owner, `/api/v1/roles/${roleB}/postings`))).publishing).toMatchObject({ state: "not_open", pollAfterSeconds: null });
  });

  it("the team posts a board from its own account: recording its address makes the posting live once it is checked, and Today stops asking for it", async () => {
    const url = "https://www.indeed.com/viewjob?jk=abc123";
    expect((await post(owner, `/api/v1/roles/${roleA}/postings/indeed/url`, { url })).status).toBe(200);
    await container.drain();
    expect(await posting(roleA, "indeed")).toMatchObject({ status: "live_verified", externalUrl: url, boardVersion: 1 });
    expect((await brief(owner)).find((c) => c.kind === "posting_action" && c.roleId === roleA)?.title).toMatch(/: post it on LinkedIn from your own account$/);
  });

  it("sharing: one tap per place makes its own link that opens the job page; a board's link opens the form; preview fetchers are sent to the job page uncounted", async () => {
    const urls = jobUrls(container.env, { slug, roleId: roleA });
    const first = await post(owner, `/api/v1/roles/${roleA}/share-links`, { place: "whatsapp" });
    expect(first.status).toBe(201);
    type Shared = { created: boolean; link: { id: string; url: string; source: string; label: string; landing: string }; text: string; targets: Array<{ key: string; url: string }> };
    const a = await body<Shared>(first);
    expect(a.link).toMatchObject({ source: "whatsapp", label: "Shared on WhatsApp", landing: "job" });
    expect(a.text.endsWith(a.link.url)).toBe(true);
    expect(a.targets.map((t) => t.key)).toEqual(["email", "text", "whatsapp", "linkedin", "facebook", "x"]);
    expect(a.targets.find((t) => t.key === "whatsapp")!.url).toBe(`https://wa.me/?text=${encodeURIComponent(a.text)}`);
    expect(a.targets.find((t) => t.key === "linkedin")!.url).toBe(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(a.link.url)}`);
    expect(a.targets.find((t) => t.key === "email")!.url).toMatch(/^mailto:\?subject=Ledger%20%26%20Co%20is%20hiring/);
    // the same place again reuses its link
    const again = await post(owner, `/api/v1/roles/${roleA}/share-links`, { place: "whatsapp" });
    expect(again.status).toBe(200);
    expect((await body<Shared>(again)).link.id).toBe(a.link.id);
    // whoever approves roles may share; an interviewer may not; an unknown place is refused
    const hiring = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@publish.test" });
    expect((await post(hiring, `/api/v1/roles/${roleA}/share-links`, { place: "school" })).status).toBe(201);
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
    expect((await post(interviewer, `/api/v1/roles/${roleA}/share-links`, { place: "community" })).status).toBe(403);
    expect((await post(owner, `/api/v1/roles/${roleA}/share-links`, { place: "carrier_pigeon" })).status).toBe(400);
    // a person opening the shared link lands on the job page, counted, with the source cookie
    const token = a.link.url.split("/a/")[1];
    const visit = await app.request(`/a/${token}`, { headers: { "user-agent": BROWSER } });
    expect(visit.status).toBe(302);
    expect(visit.headers.get("location")).toBe(urls.job);
    expect(visit.headers.get("set-cookie") ?? "").toMatch(/^ros_src=v1\./);
    // the app it was pasted into fetches it for a preview card first: sent to the job page, not counted, no cookie
    for (const ua of ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "WhatsApp/2.23.20.0 A", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"]) {
      const preview = await app.request(`/a/${token}`, { headers: { "user-agent": ua } });
      expect(preview.headers.get("location"), ua).toBe(urls.job);
      expect(preview.headers.get("set-cookie"), ua).toBeNull();
    }
    expect((await container.db.select().from(applicationLinks).where(eq(applicationLinks.id, a.link.id)))[0].visits).toBe(1);
    // a board's own link goes straight to the form: the board already showed the job
    const [boardLink] = await container.db.select().from(applicationLinks).where(eq(applicationLinks.postingId, (await posting(roleA, "indeed")).id));
    expect(boardLink.landing).toBe("apply");
    expect((await app.request(`/a/${boardLink.token}`, { headers: { "user-agent": BROWSER } })).headers.get("location")).toBe(urls.apply);
    const v = await body<{ share: { places: Array<{ place: string; link: { visits: number } | null }> } }>(await get(owner, `/api/v1/roles/${roleA}/postings`));
    expect(v.share.places.find((p) => p.place === "whatsapp")!.link).toMatchObject({ visits: 1 });
    expect(v.share.places.find((p) => p.place === "school")!.link).not.toBeNull();
  });

  it("a paused role prepares nothing, so the screen does not wait on it: a board ticked meanwhile is prepared on resume", async () => {
    const roleD = await newRole(owner);
    expect((await post(owner, `/api/v1/roles/${roleD}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await posting(roleD, "indeed")).status).toBe("ready_to_post");
    expect((await post(owner, `/api/v1/roles/${roleD}/pause`)).status).toBe(200);
    expect((await post(owner, `/api/v1/roles/${roleD}/channels`, { channels: ["indeed", "linkedin_basic"] })).status).toBe(200);
    const paused = await body<{ publishing: { state: string; pollAfterSeconds: number | null; message: string } }>(await get(owner, `/api/v1/roles/${roleD}/postings`));
    expect(paused.publishing).toMatchObject({ state: "ready", pollAfterSeconds: null });
    expect(paused.publishing.message).toMatch(/The role is paused/);
    expect((await post(owner, `/api/v1/roles/${roleD}/resume`)).status).toBe(200);
    await container.drain();
    expect((await posting(roleD, "linkedin_basic")).status).toBe("ready_to_post");
  });

  it("unticking a board that is not up closes it; 'prepare this board' brings it back", async () => {
    const linkedin = await posting(roleA, "linkedin_basic");
    expect((await post(owner, `/api/v1/roles/${roleA}/channels`, { channels: ["indeed"] })).status).toBe(200);
    expect(await posting(roleA, "linkedin_basic")).toMatchObject({ status: "closed", closureRequired: false });
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleA}/postings/careers_page/prepare`))).code).toBe("not_a_board");
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleA}/postings/ziprecruiter/prepare`))).code).toBe("ziprecruiter_needs_plan");
    const back = await post(owner, `/api/v1/roles/${roleA}/postings/linkedin_basic/prepare`);
    expect(back.status).toBe(200);
    expect(await posting(roleA, "linkedin_basic")).toMatchObject({ id: linkedin.id, status: "ready_to_post" });
    expect((await roleRow(roleA)).publishChannels).toEqual(["linkedin_basic", "indeed"]);
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleA}/postings/linkedin_basic/prepare`))).code).toBe("already_prepared");
  });

  it("closing the role asks the team to take down each board still up, until it is ticked off", async () => {
    expect((await post(owner, `/api/v1/roles/${roleA}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(200);
    expect(await posting(roleA, "indeed")).toMatchObject({ closureRequired: true, closureConfirmedAt: null });
    // LinkedIn was never up, so there is nothing to take down there
    expect(await posting(roleA, "linkedin_basic")).toMatchObject({ closureRequired: false });
    const card = (await brief(owner)).find((c) => c.kind === "posting_action" && c.roleId === roleA)!;
    expect(card.title).toBe("Still posted on Indeed");
    expect(card.body).toContain("Take the posting down from your own account");
    expect((await post(owner, `/api/v1/roles/${roleA}/postings/indeed/closure-confirm`)).status).toBe(200);
    expect((await posting(roleA, "indeed")).closureConfirmedAt).toBeTruthy();
    expect((await brief(owner)).some((c) => c.title.startsWith("Still posted on"))).toBe(false);
  });

  it("a change to the pay of a live job needs the same approval as a new role, which a sole owner confirms; a board still showing the old version is named until the team says it is up to date (Q10)", async () => {
    expect((await post(owner, `/api/v1/roles/${roleB}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    expect((await post(owner, `/api/v1/roles/${roleB}/postings/indeed/url`, { url: "https://www.indeed.com/viewjob?jk=b1" })).status).toBe(200);
    await container.drain();
    expect(await posting(roleB, "indeed")).toMatchObject({ status: "live_verified", boardVersion: 1 });
    const v1 = (await body<Array<{ version: number; packet: RolePacket }>>(await get(owner, `/api/v1/roles/${roleB}/packets`)))[0].packet;
    const pay = structuredClone(v1);
    pay.compensation.max += 1000;
    const r = await post(owner, `/api/v1/roles/${roleB}/packets`, { packet: pay, changeSummary: "Top of the range up" });
    expect(r.status).toBe(201);
    expect(await body(r)).toMatchObject({ version: 2, outcome: "proposed_pending_approval", needsApproval: { changes: ["pay"], youMayConfirm: true }, boardsShowingOldVersion: [] });
    await container.drain();
    expect((await roleRow(roleB)).currentPacketVersion).toBe(1);
    // the sole owner confirms their own change
    expect((await post(owner, `/api/v1/roles/${roleB}/approve`, { version: 2 })).status).toBe(200);
    await container.drain();
    expect((await roleRow(roleB)).currentPacketVersion).toBe(2);
    const d = await body<{ boardsShowingOldVersion: string[] }>(await get(owner, `/api/v1/roles/${roleB}`));
    expect(d.boardsShowingOldVersion).toEqual(["indeed"]);
    expect((await container.db.select().from(events).where(eq(events.type, "posting.update_required"))).length).toBe(1);
    // the team puts the new range on the board and says so
    expect(await body(await post(owner, `/api/v1/roles/${roleB}/postings/indeed/updated`, { note: "New range in place" }))).toMatchObject({ showsOldVersion: false, boardVersion: 2 });
    await container.drain();
    expect((await posting(roleB, "indeed")).boardVersion).toBe(2);
    // a wording change goes live at once (after the preview the page shows first); the board is behind again
    const wording = structuredClone(pay);
    wording.description.publicJobDescription = `${pay.description.publicJobDescription} Free parking on site.`;
    const w = await post(owner, `/api/v1/roles/${roleB}/packets`, { packet: wording, changeSummary: "Parking" });
    expect(await body(w)).toMatchObject({ version: 3, outcome: "approved_current", needsApproval: null, boardsShowingOldVersion: ["indeed"] });
    // the team says the board is up to date, and the address is checked again
    const confirmed = await body<{ showsOldVersion: boolean; boardVersion: number }>(await post(owner, `/api/v1/roles/${roleB}/postings/indeed/updated`, {}));
    expect(confirmed).toMatchObject({ showsOldVersion: false, boardVersion: 3 });
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleB}/postings/indeed/updated`, {}))).code).toBe("up_to_date");
  });

  it("what starts on its own once the job is live is the same for every company (D9; 20 Oct 2026, R20-4): a rule saved before changes nothing", async () => {
    await withTenant(container.db, companyId, async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, "owner@publish.test"));
      await tx.insert(policies).values({ companyId, roleId: null, actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"], createdBy: { kind: "user", id: u.id } });
    });
    const d = await body<{ autoActionsOnOpen: { lines: Array<{ actionType: string; level: string; text: string }> } }>(await get(owner, `/api/v1/roles/${roleB}`));
    expect(d.autoActionsOnOpen.lines[1]).toMatchObject({ actionType: "application.invite_screen", level: "auto" });
    // the line says plainly that the assistant runs an AI interview with every applicant (the AI is never hidden)
    expect(d.autoActionsOnOpen.lines[1].text).toMatch(/^Every applicant has a short AI interview with the assistant/);
    expect(d.autoActionsOnOpen.lines[1].text).not.toMatch(/approval/);
  });

  it("the legal check blocks approving a Colorado role until the benefits are described; the role then opens with a default closing date and its timer", async () => {
    roleC = await newRole(owner, (p) => { p.identity.locations = [{ city: "Denver", region: "CO", country: "US" }]; delete p.compensation.benefitsSummary; });
    type Pending = { packetApproval: { pending: { legalCheck: { missing: Array<{ key: string }>; items: Array<{ key: string; met: boolean; detail: string }> }; viewer: { mayDecide: boolean; reason: string | null } } } };
    const d = await body<Pending>(await get(owner, `/api/v1/roles/${roleC}`));
    expect(d.packetApproval.pending.legalCheck.missing.map((m) => m.key)).toEqual(["benefits"]);
    expect(d.packetApproval.pending.legalCheck.items.find((i) => i.key === "closing_date")).toMatchObject({ met: true });
    expect(d.packetApproval.pending.viewer).toMatchObject({ mayDecide: false });
    expect(d.packetApproval.pending.viewer.reason).toMatch(/short description of the benefits/);
    const card = (await brief(owner)).find((c) => c.kind === "decision" && c.roleId === roleC)!;
    expect(card.actions[0].label).toBe("See what is missing");
    expect(card.body).toMatch(/benefits/);
    const refused = await post(owner, `/api/v1/roles/${roleC}/approve`, { version: 1 });
    expect(refused.status).toBe(409);
    const err = await errorOf(refused);
    expect(err.code).toBe("legal_check");
    expect((err.details?.missing as Array<{ key: string }> | undefined)?.map((m) => m.key)).toEqual(["benefits"]);
    // the company describes its benefits once, in Setup
    await settings({ benefitsSummary: "Health and dental insurance, 401(k) with match, paid time off." });
    expect((await post(owner, `/api/v1/roles/${roleC}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    const clock = container.engine.clock();
    const role = await roleRow(roleC);
    expect(role.status).toBe("open");
    expect(role.applicationsCloseOn).toBe(defaultClosingDate(clock, "America/Los_Angeles"));
    const timers = await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "role_closing_date"));
    expect(timers.filter((t) => t.status === "waiting").map((t) => (t.state as { roleId: string }).roleId)).toEqual([roleC]);
    const [set] = await container.db.select().from(events).where(and(eq(events.type, "role.closing_date_set"), eq(events.subjectId, roleC)));
    expect(set.payload).toMatchObject({ defaulted: true, closesOn: role.applicationsCloseOn });
    const view = await body<{ closingDate: { closesOn: string; requiredByLaw: boolean; applyBy: string } }>(await get(owner, `/api/v1/roles/${roleC}`));
    expect(view.closingDate).toMatchObject({ closesOn: role.applicationsCloseOn, requiredByLaw: true });
    expect(view.closingDate.applyBy).toMatch(/^Apply by /);
  });

  it("the closing date: kept for Colorado, never in the past; at the end of the day in the company's zone applications stop, nobody is rejected, and Extend opens them again", async () => {
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleC}/closing-date`, { closesOn: null }))).code).toBe("closing_date_required");
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleC}/closing-date`, { closesOn: "2020-01-01" }))).code).toBe("bad_closing_date");
    expect((await post(owner, `/api/v1/roles/${roleC}/closing-date`, { closesOn: "2026-02-30" })).status).toBe(400);
    const hiring = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@publish.test" });
    const today = companyToday(container.engine.clock(), "America/Los_Angeles");
    expect((await post(hiring, `/api/v1/roles/${roleC}/closing-date`, { closesOn: today })).status).toBe(403);
    const set = await body<{ reopened: boolean; closingDate: { closesOn: string; closesAt: string } }>(await post(owner, `/api/v1/roles/${roleC}/closing-date`, { closesOn: today }));
    const moment = closingMoment(today, "America/Los_Angeles");
    expect(set).toMatchObject({ reopened: false, closingDate: { closesOn: today, closesAt: moment.toISOString() } });
    await container.drain();
    const waiting = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "role_closing_date"))).filter((t) => t.status === "waiting");
    expect(waiting.map((t) => (t.state as { closesOn: string }).closesOn)).toEqual([today]);
    // a minute before midnight in California the role still takes applications; a minute after, it does not
    await advance(moment.getTime() - container.engine.clock().getTime() - 60_000);
    expect((await roleRow(roleC)).acceptingApplications).toBe(true);
    await advance(120_000);
    const stopped = await roleRow(roleC);
    expect(stopped).toMatchObject({ status: "open", acceptingApplications: false, applicationsClosedReason: "closing date" });
    expect(Date.parse(stopped.applicationsClosedAt!)).toBe(moment.getTime());
    const [closedEvent] = await container.db.select().from(events).where(and(eq(events.type, "role.applications_closed"), eq(events.subjectId, roleC)));
    expect(closedEvent.payload).toMatchObject({ reason: "closing date", automatic: true, closesOn: today });
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "applications.closed")))).some((n) => n.title.includes("stopped taking new applications"))).toBe(true);
    // someone part-way through the form when it closed may still send it; a form opened afterwards may not
    const opened = sealFormOpened(container.env.SESSION_SECRET, roleC, new Date(moment.getTime() - 10 * 60_000));
    const now = container.engine.clock();
    expect(lateApplicationAllowed({ role: stopped, sealed: opened, secret: container.env.SESSION_SECRET, now })).toBe(true);
    expect(lateApplicationAllowed({ role: stopped, sealed: sealFormOpened(container.env.SESSION_SECRET, roleC, now), secret: container.env.SESSION_SECRET, now })).toBe(false);
    expect(lateApplicationAllowed({ role: stopped, sealed: opened, secret: container.env.SESSION_SECRET, now: new Date(moment.getTime() + 25 * 3600_000) })).toBe(false);
    expect(lateApplicationAllowed({ role: { ...stopped, id: roleB }, sealed: opened, secret: container.env.SESSION_SECRET, now })).toBe(false);
    expect(lateApplicationAllowed({ role: { ...stopped, applicationsClosedReason: "Enough for now" }, sealed: opened, secret: container.env.SESSION_SECRET, now })).toBe(false);
    expect(lateApplicationAllowed({ role: stopped, sealed: `${opened}x`, secret: container.env.SESSION_SECRET, now })).toBe(false);
    const late = { companyId, roleId: roleC, source: "careers_page", firstName: "Lena", lastName: "Late", email: "lena.late@example.com", phone: null, smsConsent: false, consentSource: "careers_page_apply", noticeVersionsShown: [], eligibilityAnswers: {}, noResumeAnswers: { summary: "Bookkeeper for six years." } };
    await expect(withTenant(container.db, companyId, (tx) => createApplication(tx, container, late, { kind: "candidate", id: "applicant" }))).rejects.toThrow(/not accepting/);
    const admitted = await withTenant(container.db, companyId, (tx) => createApplication(tx, container, late, { kind: "candidate", id: "applicant" }, { closingGrace: true }));
    expect(admitted.application.roleId).toBe(roleC);
    // Today: extend by two weeks, choose another date, or close the job (a person's decision), its button in job words like every other (10 November 2026)
    const card = (await brief(owner)).find((c) => c.kind === "closing_date" && c.roleId === roleC)!;
    expect(card.title).toContain("stopped taking applications");
    expect(card.actions.map((a) => a.label)).toEqual(["Extend by two weeks", "Choose another date", "Close the job"]);
    expect(card.actions.map((a) => a.label)).not.toContain("Close the role");
    expect(card.actions[2]).toMatchObject({ method: "GET", path: `/roles/${roleC}?close=1` });
    expect(card.actions[0]).toMatchObject({ method: "POST", path: `/api/v1/roles/${roleC}/closing-date` });
    // its sentence in job words too (the lead's D1, 11 November 2026)
    expect(card.body).toContain("close the job when you are ready");
    expect(card.body).not.toMatch(/\brole\b/);
    // the plain switch cannot reopen past the date: the date would stop them again and show a past date
    expect((await errorOf(await post(owner, `/api/v1/roles/${roleC}/applications/accepting`, { accepting: true }))).code).toBe("closing_date_passed");
    // the card's button posts its body as it is (Today adds a question field, which is ignored)
    const extended = await body<{ reopened: boolean; closingDate: { closesOn: string } }>(await post(owner, card.actions[0].path, { ...card.actions[0].body, question: "Please review" }));
    expect(extended.reopened).toBe(true);
    expect(await roleRow(roleC)).toMatchObject({ acceptingApplications: true, applicationsClosedReason: null, applicationsCloseOn: extended.closingDate.closesOn });
    expect((await container.db.select().from(events).where(and(eq(events.type, "role.applications_reopened"), eq(events.subjectId, roleC)))).length).toBe(1);
    // "closing date" marks a stop the date made; a person's own stop cannot carry it, so it never lets late forms in
    const reserved = await post(owner, `/api/v1/roles/${roleC}/applications/accepting`, { accepting: false, reason: "Closing date" });
    expect(reserved.status).toBe(400);
    expect((await errorOf(reserved)).code).toBe("reserved_reason");
    expect((await roleRow(roleC)).acceptingApplications).toBe(true);
  });

  it("a closing date chosen before approval that has passed when the role opens is not kept: the team is told, and the role takes applications", async () => {
    const roleE = await newRole(owner);
    const today = companyToday(container.engine.clock(), "America/Los_Angeles");
    expect((await post(owner, `/api/v1/roles/${roleE}/closing-date`, { closesOn: today })).status).toBe(200);
    // approval comes the next morning
    await advance(closingMoment(today, "America/Los_Angeles").getTime() - container.engine.clock().getTime() + 8 * 3600_000);
    expect((await post(owner, `/api/v1/roles/${roleE}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect(await roleRow(roleE)).toMatchObject({ status: "open", applicationsCloseOn: null, acceptingApplications: true });
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "role_closing_date"))).filter((t) => t.status === "waiting" && (t.state as { roleId: string }).roleId === roleE)).toEqual([]);
    const [told] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "stuck.closing_date_passed")));
    expect(told.title).toBe(`${(await roleRow(roleE)).title}: the closing date had passed when it opened`);
    expect(told.body).toMatch(/takes applications until you stop them/);
    const set = await container.db.select().from(events).where(and(eq(events.type, "role.closing_date_set"), eq(events.subjectId, roleE))).orderBy(events.id);
    expect(set.map((e) => e.payload)).toEqual([expect.objectContaining({ closesOn: today, previous: null }), expect.objectContaining({ closesOn: null, previous: today, defaulted: false })]);
  });

  it("after an approved edit of a live job the team is told which boards still show the earlier version", async () => {
    const own = await signIn("owner@diy.test");
    const co = await body<{ id: string }>(await post(own, "/api/v1/companies", { name: "Do It Yourself Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] }));
    await entitlements.applyPlan(container.db, co.id, "growth");
    const roleId = await newRole(own);
    expect((await post(own, `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await brief(own)).some((c) => c.kind === "posting_action" && c.title.includes("from your own account"))).toBe(true);
    expect((await post(own, `/api/v1/roles/${roleId}/postings/indeed/url`, { url: "https://www.indeed.com/viewjob?jk=diy" })).status).toBe(200);
    await container.drain();
    const v1 = (await body<Array<{ packet: RolePacket }>>(await get(own, `/api/v1/roles/${roleId}/packets`)))[0].packet;
    const wording = structuredClone(v1);
    wording.description.publicJobDescription = `${v1.description.publicJobDescription} We close early on Fridays.`;
    expect(await body(await post(own, `/api/v1/roles/${roleId}/packets`, { packet: wording, changeSummary: "Fridays" }))).toMatchObject({ outcome: "approved_current", boardsShowingOldVersion: ["indeed"] });
    const told = await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "stuck.boards_outdated")));
    expect(told.length).toBeGreaterThan(0);
    expect(told[0].title).toMatch(/Indeed still shows the earlier version/);
  });

  it("the deploy backfill: an open Colorado role with no closing date gets one; a second run changes nothing", async () => {
    // a Colorado role that opened before closing dates existed
    await container.db.update(roles).set({ applicationsCloseOn: null }).where(eq(roles.id, roleC));
    const first = await backfillPublishing(container);
    expect(first.closingDates).toBe(1);
    await container.drain();
    const role = await roleRow(roleC);
    expect(role.applicationsCloseOn).toBe(defaultClosingDate(container.engine.clock(), "America/Los_Angeles"));
    expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "role_closing_date"))).filter((t) => t.status === "waiting" && (t.state as { roleId: string }).roleId === roleC)).toHaveLength(1);
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "stuck.closing_date_added")))).map((n) => n.title)).toEqual([`${role.title} now has a closing date`]);
    expect(await backfillPublishing(container)).toEqual({ closingDates: 0 });
  });
});
