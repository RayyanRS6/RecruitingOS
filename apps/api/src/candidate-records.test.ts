import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { redactText } from "@ros/contracts";
import { createDataRequest, fulfilCorrectionRequest } from "@ros/core";
import { applications, candidates, communications, companies, dataRequests, screens, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applyFormProblem, statusDay } from "./pages/candidate";
import { consentOf, emailStatusLinks, insertCandidateOnce } from "./services/applications";
import { applicationForm, plantJob, seedCompany, statusTokenFor, usePlan } from "./test-helpers";

/**
 * A candidate's own record of their application: what a stranger typing someone's address can see and change, a new
 * private link, a withdrawal inside the AI interview, a corrected address, one address-matching rule, the form's error
 * line, and the status page: its steps, its one line on what happens next, their own answers read back, and never a
 * score, the team's words for where they stand, or a decision they were not told.
 */
describe("candidates and their applications", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let zone = "";
  let roleA = "";
  let roleB = "";
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", MESSAGE_UNDO_SECONDS: "30", JOBS_BASE_URL: "https://jobs.example.test" };
  const BASE = Date.now();
  let offset = 0;
  const advance = async (ms: number) => { offset += ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); await container.drain(); };
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  /** Applies on the public form, and answers the application once its resume has been read. */
  const apply = async (roleId: string, first: string, email: string, more: Record<string, string> = {}) => {
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: first, lastName: "Lind", email, ...more }) });
    await container.drain();
    return res;
  };
  const appByToken = async (token: string) => (await container.db.select().from(applications).where(eq(applications.statusToken, token)))[0];
  const applicationOf = async (roleId: string, email: string) => appByToken(await statusTokenFor(container, { roleId, email }));
  /** One of the team's actions on a person, as the candidates list presses it. */
  const act = async (applicationId: string, action: string) => {
    const r = await json("POST", `/api/v1/applications/${applicationId}/actions`, { action });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const statusPage = async (roleId: string, email: string) => {
    const r = await app.request(`/c/status/${await statusTokenFor(container, { roleId, email })}`);
    expect(r.status).toBe(200);
    return decode(await r.text());
  };
  /** The steps the page draws, in order, with the one it marks as current. */
  const stepsOf = (html: string) => {
    const track = html.slice(html.indexOf('<ol class="track"'), html.indexOf("</ol>", html.indexOf('<ol class="track"')));
    return { steps: [...track.matchAll(/<span>([^<]+)<\/span>(?:<span class="sr-only">|<\/li>)/g)].map((m) => m[1]), current: /<li class="current" aria-current="step"><span class="dot" aria-hidden="true"><\/span><span>([^<]+)<\/span>/.exec(track)?.[1] ?? null };
  };
  const nextLine = (html: string) => /<h2>What happens next<\/h2><p>([^<]*)<\/p>/.exec(html)?.[1] ?? "";
  /** What no status page ever shows: a score, the team's words for a stage, or the plan. */
  const NEVER = /\d{1,3}\s?\/\s?100|Resume match|match score|Shortlisted|Not selected|triaged|screen_invited|upgrade|\bplan\b/i;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    ({ owner, companyId, slug } = await seedCompany(app, { email: "owner@records.test", name: "Lind Dental" }));
    await usePlan(container, companyId);
    zone = (await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)))[0].timezone;
    roleA = await plantJob(container, { companyId, title: "Dental Hygienist", packet: (p) => { p.formQuestions = [{ kind: "yes_no", key: "license", question: "Do you hold an active CA RDH license?", required: true }]; } });
    roleB = await plantJob(container, { companyId, title: "Dental Assistant" });
  });
  afterAll(async () => { await container.close(); });

  it("an application to another job from a known address (Gmail dots and a +suffix) is the known person's: they keep their own name, the page is the receipt anyone gets, and the one email goes to the address on file and says it was sent using their address", async () => {
    expect((await apply(roleA, "Rosa", "rosa.lind@gmail.com", { q_license: "yes" })).status).toBe(302);
    const rosa = (await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, "rosa.lind@gmail.com"))))[0];
    const stranger = await apply(roleB, "Mallory", "RosaLind+x@gmail.com");
    expect(stranger.status).toBe(302);
    // the receipt a new address gets: no link and nobody's name
    const cookie = stranger.headers.get("set-cookie")?.match(/ros_applied=[^;,]+/)?.[0] ?? "";
    const receipt = await (await app.request(stranger.headers.get("location")!, { headers: { cookie } })).text();
    expect(receipt).toContain("<h1>Thanks, we have your application</h1>");
    expect(receipt).not.toMatch(/\/c\/status\/|\/c\/screen\/|Rosa|Mallory/);
    // the new application is Rosa's, and the person on file keeps their own name and details
    const [newApp] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleB), eq(applications.candidateId, rosa.id)));
    expect(newApp).toBeTruthy();
    expect((await container.db.select().from(candidates).where(eq(candidates.id, rosa.id)))[0]).toMatchObject({ firstName: "Rosa", email: "rosa.lind@gmail.com" });
    expect(await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.firstName, "Mallory")))).toEqual([]);
    // each application has its one email, to the address on file; only the second says it was sent using their address
    const acks = mail().filter((m) => m.to === "rosa.lind@gmail.com" && m.subject.startsWith("Thank you for applying:"));
    expect(acks.map((m) => m.subject)).toEqual(["Thank you for applying: Dental Hygienist at Lind Dental", "Thank you for applying: Dental Assistant at Lind Dental"]);
    expect(acks[0].text).not.toContain("sent using your email address");
    expect(acks[1].text).toContain("This application was sent using your email address. If you did not send it, reply to this email and a person will look into it.");
    expect(acks[1].text).toContain(`https://jobs.example.test/c/status/${newApp.statusToken}`);
    expect(mail().some((m) => m.to.toLowerCase().includes("rosalind+x"))).toBe(false);
  });

  it("a person added at the same moment by another submission is read again instead of failing on the unique key", async () => {
    const out = await withTenant(container.db, companyId, async (tx) => {
      const values = { companyId, firstName: "Twin", lastName: "One", email: "twin@example.com", phone: null, dedupeKey: "email:twin@example.com", consent: {} };
      const a = await insertCandidateOnce(tx, values);
      const b = await insertCandidateOnce(tx, { ...values, firstName: "Twin", lastName: "Two" });
      return { a, b };
    });
    expect(out.a.inserted).toBe(true);
    expect(out.b.inserted).toBe(false);
    expect(out.b.candidate.id).toBe(out.a.candidate.id);
    expect(out.b.candidate.lastName).toBe("One");
  });

  it("the form's consent is recorded with the notice versions the page showed and that the box was ticked", () => {
    const now = "2026-10-15T10:00:00.000Z";
    const formed = consentOf({ consentSource: "careers_page_apply", noticeVersionsShown: ["ai_use@1", "privacy@1"], ip: "203.0.113.9" }, now);
    expect(formed.application_terms).toMatchObject({ granted: true, acknowledged: true, at: now, source: "careers_page_apply", ip: "203.0.113.9" });
    expect(formed.ai_notice).toMatchObject({ granted: true, noticeVersion: "ai_use@1,privacy@1" });
    expect(Object.keys(formed).sort()).toEqual(["ai_notice", "application_terms"]);
  });

  it("Get a new link replaces the private link, the old one stops working, the new one goes only by email, and an open AI interview's link changes with it", async () => {
    await apply(roleA, "Nina", "nina.lind@example.com", { q_license: "yes" });
    const old = await statusTokenFor(container, { roleId: roleA, email: "nina.lind@example.com" });
    const ninaApp = await appByToken(old);
    await act(ninaApp.id, "shortlist");
    const chat = await screenOf(ninaApp.id);
    expect(chat.status).toBe("invited");
    const page = await (await app.request(`/c/status/${old}`)).text();
    expect(page).toContain(`action="/c/status/${old}/new-link"`);
    expect(page).toContain("Get a new link");
    expect(page).toContain(`href="/c/screen/${chat.token}"`);
    const res = await form(`/c/status/${old}/new-link`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your new link is on its way");
    expect(html).toContain("n***@example.com");
    const fresh = await statusTokenFor(container, { roleId: roleA, email: "nina.lind@example.com" });
    expect(fresh).not.toBe(old);
    expect(html).not.toContain(fresh);
    expect((await app.request(`/c/status/${old}`)).status).toBe(404);
    expect((await app.request(`/c/status/${fresh}`)).status).toBe(200);
    await container.drain();
    const sent = mail().filter((m) => m.to === "nina.lind@example.com" && /new application link/.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`/c/status/${fresh}`);
    expect(sent[0].text).not.toContain(old);
    // the AI interview the old page linked to: its old link opens nothing, and the new status page carries the new one
    const now = await screenOf(ninaApp.id);
    expect(now.token).not.toBe(chat.token);
    expect((await app.request(`/c/screen/${chat.token}`)).status).toBe(404);
    expect(await (await app.request(`/c/status/${fresh}`)).text()).toContain(`href="/c/screen/${now.token}"`);
  });

  it("withdrawing inside the AI interview is recorded as a request and confirmed by email, like the status page", async () => {
    await apply(roleA, "Wren", "wren.lind@example.com", { q_license: "yes" });
    const wrenApp = await applicationOf(roleA, "wren.lind@example.com");
    await act(wrenApp.id, "shortlist");
    const to = `/c/screen/${(await screenOf(wrenApp.id)).token}`;
    expect((await form(`${to}/start`)).status).toBe(302);
    expect((await form(to, { message: "WITHDRAW" })).status).toBe(302);
    // asked first: nothing is withdrawn until they confirm
    expect((await appByToken(wrenApp.statusToken)).stage).toBe("screening");
    expect(await (await app.request(to)).text()).toContain("Do you want to withdraw your application?");
    expect((await form(`${to}/withdraw`, { confirm: "yes" })).status).toBe(302);
    await container.drain();
    const wren = await appByToken(wrenApp.statusToken);
    expect(wren.stage).toBe("withdrawn");
    const reqs = await withPlatform(container.db, (tx) => tx.select().from(dataRequests).where(eq(dataRequests.applicationId, wren.id)));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ kind: "withdrawal", status: "fulfilled", details: "Withdrawn in the AI interview." });
    expect(reqs[0].confirmationSentAt).toBeTruthy();
    expect(await container.db.select().from(communications).where(eq(communications.idempotencyKey, `privacy_done:${reqs[0].id}`))).toHaveLength(1);
    // their own page says so, as a decision that is theirs
    const page = await statusPage(roleA, "wren.lind@example.com");
    expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review", "AI interview", "Decision"], current: "Decision" });
    expect(page).toContain('<h2 id="decision">You withdrew</h2>');
    expect(nextLine(page)).toBe("You withdrew this application. Thank you for your time.");
    expect(page).not.toContain("Withdraw my application");
  });

  it("a corrected address re-keys the record, and Lost your link? and the privacy form find people by the same rule", async () => {
    await apply(roleA, "Cora", "cora.old@example.com", { q_license: "yes" });
    const [cora] = await container.db.select().from(candidates).where(eq(candidates.email, "cora.old@example.com"));
    const fixed = await withPlatform(container.db, async (tx) => {
      const row = await createDataRequest(tx, { companyId, kind: "correct", requesterEmail: "cora.old@example.com", candidateId: cora.id, channel: "admin", verified: true, actor: { kind: "system", id: "test" } });
      return fulfilCorrectionRequest(tx, row, { field: "email", value: "Cora.New@Example.com", resolution: "fixed", actor: { kind: "system", id: "test" } });
    });
    expect(fixed.status).toBe("fulfilled");
    const after = (await container.db.select().from(candidates).where(eq(candidates.id, cora.id)))[0];
    expect(after.email).toBe("cora.new@example.com");
    expect(after.dedupeKey).toBe("email:cora.new@example.com");
    const deps = { db: container.db, integrations: container.integrations, jobsBaseUrl: "https://jobs.example.test" };
    expect(await emailStatusLinks(deps, "cora.new@example.com", new Date())).toBe(1);
    // a correction to an address another record already holds keeps the key, says so, and merges nothing
    const [rosa] = await container.db.select().from(candidates).where(eq(candidates.email, "rosa.lind@gmail.com"));
    const clash = await withPlatform(container.db, async (tx) => {
      const row = await createDataRequest(tx, { companyId, kind: "correct", requesterEmail: "cora.new@example.com", candidateId: cora.id, channel: "admin", verified: true, actor: { kind: "system", id: "test" } });
      return fulfilCorrectionRequest(tx, row, { field: "email", value: "rosa.lind@gmail.com", resolution: "fixed", actor: { kind: "system", id: "test" } });
    });
    expect(clash.notes.map((n) => n.text).join(" ")).toContain("were not merged");
    expect((await container.db.select().from(candidates).where(eq(candidates.id, cora.id)))[0].dedupeKey).toBe("email:cora.new@example.com");
    expect(rosa.dedupeKey).toBe("email:rosalind@gmail.com");
    // the privacy form folds a Gmail address the same way and writes to the address on file
    const before = mail().length;
    const sentPage = await form("/c/privacy-request", { email: "RosaLind@gmail.com", kind: "access" });
    expect(sentPage.status).toBe(200);
    const confirm = mail().slice(before).filter((m) => /^Confirm your request/.test(m.subject));
    expect(confirm.map((m) => m.to)).toEqual(["rosa.lind@gmail.com"]);
  });

  it("the form's error line names the fields that are highlighted", async () => {
    expect(applyFormProblem(["phone"])).toBe("Please check the highlighted field: a phone number of at least 7 digits, or leave it empty.");
    expect(applyFormProblem(["firstName", "email"])).toBe("Please check the highlighted fields: your first name and a valid email address.");
    const res = await apply(roleA, "Pia", "pia.lind@example.com", { phone: "123", q_license: "yes" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("a phone number of at least 7 digits");
    expect(html).not.toContain("your first name");
  });

  it("status-page dates are the company's days", () => {
    expect(statusDay("2026-10-15T03:00:00.000Z", "America/Los_Angeles")).toBe("Oct 14, 2026");
    expect(statusDay("2026-10-15T03:00:00.000Z", "America/New_York")).toBe("Oct 14, 2026");
    expect(statusDay("2026-10-15T05:00:00.000Z", "America/New_York")).toBe("Oct 15, 2026");
  });

  it("a candidate's link never reaches a request log with its token", () => {
    for (const path of ["/c/status/", "/c/screen/"]) {
      const out = redactText(`<-- POST ${path}AbCdEfGhIjKlMnOpQrStUvWxYz012345 302`);
      expect(out).toContain(`${path}[redacted]`);
      expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    }
  });

  describe("the status page", () => {
    const stan = "stan.lind@example.com";

    it("after applying: Received and Under review, one line that promises nothing, how to reach a person, their own answers, and nothing of the team's", async () => {
      await apply(roleA, "Stan", stan, { q_license: "no", src: "indeed" });
      const page = await statusPage(roleA, stan);
      expect(page).toContain('<p class="eyebrow">Lind Dental</p><h1>Dental Hygienist</h1>');
      expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review"], current: "Under review" });
      expect(nextLine(page)).toBe("The hiring team is reviewing your application.");
      expect(page).not.toMatch(/either way|HUMAN|\/c\/screen\//);
      expect(page).toContain("People on the hiring team at Lind Dental make every decision about your application.");
      expect(page).toContain(`<p>To reach a person, email <a href="mailto:${container.env.EMAIL_REPLY_TO}">${container.env.EMAIL_REPLY_TO}</a>, or make a request below.</p>`);
      // their own answers, read back in plain words, the "No" as they gave it and with no flag; their address masked
      const answers = page.slice(page.indexOf('<section id="answers"'), page.indexOf('<section class="card" id="job"'));
      expect(answers).toContain("<dt>Email</dt><dd>s***@example.com</dd>");
      expect(answers).toContain("<dt>Sent with it</dt><dd>Your resume</dd>");
      expect(answers).toContain("<h3>Questions from Lind Dental</h3>");
      expect(answers).toContain("Do you hold an active CA RDH license?");
      expect(answers).not.toMatch(/Answered No|flag/i);
      expect(answers).not.toContain("From your AI interview");
      // to correct something they are pointed at the request further down this page, by its own name, never sent to "your status page"
      expect(answers).toContain('<h2 id="answers-h">Your answers</h2><p class="meta">To correct something, use <a href="#help">"Ask for a copy, a fix, deletion, or a person\'s review"</a> below.</p>');
      expect(page).toContain('<h2 id="help">Need something?</h2>');
      expect(page).not.toContain("on your status page");
      // the job as it was when they applied, and its page while it is public
      expect(page).toContain(`<a href="/careers/${slug}/jobs/${roleA}">See the job page</a>`);
      expect(page).not.toMatch(NEVER);
      expect(page).not.toMatch(/Indeed|indeed/);
      // the three folds, each closed until opened
      for (const fold of ["No longer interested?", "Ask for a copy, a fix, deletion, or a person's review", "Shared this link by mistake?"]) expect(page).toContain(`<details class="more"><summary>${fold}</summary>`);
    });

    it("once shortlisted: the AI interview is a step, with the one button into it and the day its link closes; started, the page says it is saved", async () => {
      const a = await applicationOf(roleA, stan);
      await act(a.id, "shortlist");
      const chat = await screenOf(a.id);
      const until = statusDay(chat.expiresAt!, zone);
      let page = await statusPage(roleA, stan);
      expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review", "AI interview"], current: "AI interview" });
      expect(nextLine(page)).toBe(`Your next step is a short AI interview with the hiring team's AI assistant. Its link stays open until ${until}.`);
      expect(page).toContain(`<a class="btn" href="/c/screen/${chat.token}">Start your AI interview</a>`);
      expect((await form(`/c/screen/${chat.token}/start`)).status).toBe(302);
      page = await statusPage(roleA, stan);
      expect(nextLine(page)).toBe(`Your AI interview is saved where you left it. Its link stays open until ${until}.`);
      expect(page).toContain(`<a class="btn" href="/c/screen/${chat.token}">Continue your AI interview</a>`);
      expect(page).not.toMatch(NEVER);
    });

    it("once they sent their answers: no button, their answers read back word for word, and still no score", async () => {
      const a = await applicationOf(roleA, stan);
      const base = `/c/screen/${(await screenOf(a.id)).token}`;
      let html = await (await app.request(base)).text();
      for (let turn = 0; turn < 40 && !html.includes("<h1>Check your answers</h1>"); turn++) {
        expect((await form(base, { message: `At Harbor Dental I see about nine patients a day, with periodontal charting in Dentrix (${turn + 1}).` })).status).toBe(302);
        html = await (await app.request(base)).text();
      }
      // "Check your answers" is not the status page: there the same request is named with where to find it
      expect(decode(html)).toContain('this chat does not change them. To correct something, use "Ask for a copy, a fix, deletion, or a person\'s review" on your status page; its link is in the email we sent you when you applied.');
      expect((await form(`${base}/submit`)).status).toBe(302);
      await container.drain();
      const page = await statusPage(roleA, stan);
      expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review", "AI interview"], current: "AI interview" });
      expect(nextLine(page)).toBe("Thanks for completing the AI interview. The team is reviewing your answers.");
      expect(page).not.toContain("/c/screen/");
      const answers = page.slice(page.indexOf('<section id="answers"'), page.indexOf('<section class="card" id="job"'));
      expect(answers).toContain("<h3>From your AI interview</h3>");
      expect(answers).toContain("At Harbor Dental I see about nine patients a day, with periodontal charting in Dentrix (1).");
      expect(answers).toContain("<summary>Your chat, word for word</summary>");
      // the scorecard is the team's: nothing of it, and no number, is on this page
      expect(page).not.toMatch(NEVER);
      expect(page).not.toMatch(/scorecard|findings?/i);
    });

    it("a decision is theirs to read only once they were told: marked Not selected in private the page stands where it was and they may still withdraw; told, it says so", async () => {
      const a = await applicationOf(roleA, stan);
      await act(a.id, "reject");
      let page = await statusPage(roleA, stan);
      expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review", "AI interview"], current: "AI interview" });
      expect(nextLine(page)).toBe("Thanks for completing the AI interview. The team is reviewing your answers.");
      expect(page).not.toMatch(/Decision|Not moving forward|did not work out/);
      expect(page).toContain("Withdraw my application");
      expect(page).not.toMatch(NEVER);
      // the email waits a short while, during which nothing shows; once it has left, the page says the decision
      await act(a.id, "send_decision");
      expect(await statusPage(roleA, stan)).not.toMatch(/Decision|Not moving forward/);
      await advance(60_000);
      expect(mail().filter((m) => m.to === stan && m.subject === "Your application to Lind Dental")).toHaveLength(1);
      page = await statusPage(roleA, stan);
      expect(stepsOf(page)).toEqual({ steps: ["Received", "Under review", "AI interview", "Decision"], current: "Decision" });
      expect(page).toContain('<p class="eyebrow">Decision</p><h2 id="decision">Not moving forward</h2>');
      expect(nextLine(page)).toBe("Thank you for applying. This role did not work out.");
      expect(page).not.toContain("Withdraw my application");
      expect(page).not.toMatch(NEVER);
    });

    it("hired reads as a decision at once; and once a job has closed, someone not hired and not told reads only that it takes no more applications, with nothing offered or promised", async () => {
      await apply(roleB, "Hira", "hira.lind@example.com");
      await apply(roleB, "Clo", "clo.lind@example.com");
      await apply(roleB, "Cid", "cid.lind@example.com");
      await apply(roleB, "Una", "una.lind@example.com");
      const [hira, cid, una] = [await applicationOf(roleB, "hira.lind@example.com"), await applicationOf(roleB, "cid.lind@example.com"), await applicationOf(roleB, "una.lind@example.com")];
      await act(hira.id, "hire");
      await act(cid.id, "shortlist");
      await act(una.id, "reject");
      const hired = await statusPage(roleB, "hira.lind@example.com");
      expect(stepsOf(hired)).toEqual({ steps: ["Received", "Under review", "Decision"], current: "Decision" });
      expect(hired).toContain('<h2 id="decision">Hired</h2>');
      expect(nextLine(hired)).toBe("You are on the team.");
      expect((await json("POST", `/api/v1/roles/${roleB}/close`, { confirm: true })).status).toBe(200);
      // closing told nobody anything
      expect(mail().filter((m) => ["clo.lind@example.com", "cid.lind@example.com", "una.lind@example.com"].includes(m.to) && /Your application to/.test(m.subject))).toEqual([]);
      for (const email of ["clo.lind@example.com", "cid.lind@example.com", "una.lind@example.com"]) {
        const page = await statusPage(roleB, email);
        expect(nextLine(page), email).toBe("This job is no longer taking applications.");
        expect(page, email).not.toMatch(/either way|will hear|Decision|Not moving forward|\/c\/screen\//);
        expect(page, email).not.toMatch(NEVER);
      }
      // the person shortlisted keeps their step, with no button into an interview for a job that has closed
      expect(stepsOf(await statusPage(roleB, "cid.lind@example.com"))).toEqual({ steps: ["Received", "Under review", "AI interview"], current: "AI interview" });
      expect(nextLine(await statusPage(roleB, "hira.lind@example.com"))).toBe("You are on the team.");
    });
  });
});
