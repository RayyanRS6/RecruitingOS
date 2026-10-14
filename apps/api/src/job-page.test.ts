import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { applyByLabel, closingDayWords, CLOSING_DATE_REASON } from "@ros/core";
import { applications, companies, rolePackets, roles } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { descriptionBlocks, descriptionExcerpt } from "./pages/description";
import { NO_RESUME_QUESTIONS, expectAtAGlance, initials, noResumeAnswersFrom } from "./pages/job-page";
import { resetPublicFeedCache } from "./pages/public-feeds";
import { oneVisitMinutes } from "./services/job-preview";
import { jobUrls } from "./services/job-urls";
import { useOneVisitApplyFlow } from "./test-helpers";

/** The first bytes of a PNG: enough for the server's header check, which never decodes pixels. */
function png(width = 200, height = 80): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe("the description renderer (plan D10)", () => {
  it("reads headings and bullets in the shapes people type, and keeps everything else as plain text", () => {
    const text = "## What you will do\n- Clean teeth <b>gently</b>\n* Teach patients\n  and their families\n\nWe are a **friendly** practice.\nLine two of the same paragraph.\n\nSchedule:\n1. Tuesday\n2) Friday\n\n**Benefits**\n• Dental care";
    expect(descriptionBlocks(text)).toEqual([
      { kind: "heading", text: "What you will do" },
      { kind: "list", ordered: false, items: ["Clean teeth <b>gently</b>", "Teach patients and their families"] },
      { kind: "paragraph", text: "We are a friendly practice.\nLine two of the same paragraph." },
      { kind: "heading", text: "Schedule" },
      { kind: "list", ordered: true, items: ["Tuesday", "Friday"] },
      { kind: "heading", text: "Benefits" },
      { kind: "list", ordered: false, items: ["Dental care"] },
    ]);
    // a plain description is one paragraph, as the assistant writes them today; a sentence ending in a colon after other words stays text
    expect(descriptionBlocks("Harbor Dental is hiring. You will care for patients.")).toEqual([{ kind: "paragraph", text: "Harbor Dental is hiring. You will care for patients." }]);
    expect(descriptionBlocks("Schedule: Monday to Friday")).toEqual([{ kind: "paragraph", text: "Schedule: Monday to Friday" }]);
    expect(descriptionBlocks("This is a long sentence that happens to end with a colon because a list follows it here:")[0].kind).toBe("paragraph");
  });

  it("an excerpt has no headings or list marks, and stops at a word", () => {
    expect(descriptionExcerpt("## About\n- One thing\n- Two things\n\nA short close.")).toBe("One thing Two things A short close.");
    const long = descriptionExcerpt("word ".repeat(100), 50);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long).not.toMatch(/ …$/);
  });

  it("the four short questions keep each answer and write the one summary every reader uses; an older one-box form still works", () => {
    expect(NO_RESUME_QUESTIONS.map((q) => q.key)).toEqual(["recentWork", "dayToDay", "skills", "lookingFor"]);
    expect(noResumeAnswersFrom({ recentWork: " Hygienist at Coastal Dental, 2019 to now ", skills: "CA RDH license; Dentrix" })).toEqual({
      recentWork: "Hygienist at Coastal Dental, 2019 to now",
      skills: "CA RDH license; Dentrix",
      summary: "Most recent work: Hygienist at Coastal Dental, 2019 to now\nSkills, licenses or tools: CA RDH license; Dentrix",
    });
    expect(noResumeAnswersFrom({ noResume: "Hygienist for six years." })).toEqual({ summary: "Hygienist for six years." });
    expect(noResumeAnswersFrom({ recentWork: "", noResume: "  " })).toBeUndefined();
    expect(noResumeAnswersFrom({ recentWork: "x".repeat(5000) })!.recentWork).toHaveLength(1000);
    expect(initials("Harbor Dental")).toBe("HD");
    expect(initials("Smile & Co.")).toBe("SC");
    expect(initials("acme")).toBe("AC");
  });

  it("'What to expect' at a glance: four lines at most, the first sentence of applying and of the conversation (never cut inside the company's name), the interviews on one line, the decision", () => {
    const steps = [
      "Apply in about 12 minutes, including a short written conversation with Dr. Lee Dental's AI assistant. We confirm by email.",
      "The conversation: 5 questions, about 10 minutes. It is not a test. You can skip a question, stop and come back later, or ask for a person instead.",
      "Phone call (20 minutes)",
      "Meet the team (45 minutes)",
      "A decision, and a real answer either way.",
    ];
    expect(expectAtAGlance(steps, "Dr. Lee Dental")).toEqual([
      "Apply in about 12 minutes, including a short written conversation with Dr. Lee Dental's AI assistant.",
      "The conversation: 5 questions, about 10 minutes.",
      "Interviews: Phone call (20 minutes), Meet the team (45 minutes)",
      "A decision, and a real answer either way.",
    ]);
    // one interview keeps its own words; none leaves three lines; the later path keeps its first sentence
    expect(expectAtAGlance([steps[0], steps[1], steps[2], steps[4]], "Dr. Lee Dental")[2]).toBe("Phone call (20 minutes)");
    expect(expectAtAGlance(["Send a short form, about 3 minutes. We confirm by email.", "Possibly a short written conversation with Acme's AI assistant (online, about 10 minutes). If so, we email you the link.", steps[4]], "Acme")).toEqual([
      "Send a short form, about 3 minutes.",
      "Possibly a short written conversation with Acme's AI assistant (online, about 10 minutes).",
      "A decision, and a real answer either way.",
    ]);
  });
});

describe("the job page and the careers page (plan D10)", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let eligibility: Array<{ key: string }> = [];
  let maxMinutes = 0;
  let questionCount = 0;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return r.text();
  };
  const jsonLdOf = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)![1]) as Record<string, unknown>;
  const setSettings = async (change: (s: Record<string, unknown>) => void) => {
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    const next = { ...co.settings } as Record<string, unknown>;
    change(next);
    await container.db.update(companies).set({ settings: next as typeof co.settings }).where(eq(companies.id, companyId));
  };
  const applyForm = (fields: Record<string, string | null>) => {
    const fd = new FormData();
    const base: Record<string, string> = { firstName: "Rosa", lastName: "Diaz", email: "rosa.diaz@example.com", locationText: "Irvine, CA", acknowledged: "yes" };
    for (const r of eligibility) base[`elig_${r.key}`] = "yes";
    for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
    return fd;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@jobpage.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Ledger Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    // A pilot company: the conversation follows the form in the same visit, and the pages say how long both take (plan E8).
    await useOneVisitApplyFlow(container, companyId);
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    // The version the role runs on, with the shapes this page has to handle: two places, a nice-to-have, a description
    // with headings, bullets and markup typed into it, and the role plan's own company line (which no person approved).
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const p = structuredClone(pv.packet);
    p.identity.locations = [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }];
    p.requirements.mustHaves = [{ key: "mh_license", text: "An active California RDH license", rationale: "PRIVATE-RATIONALE-1", evidencedBy: ["resume"] }];
    p.requirements.niceToHaves = [{ key: "nh_dentrix", text: "Experience with Dentrix", rationale: "PRIVATE-RATIONALE-2", evidencedBy: ["resume"] }];
    p.description.publicJobDescription = "## What you will do\n- Cleanings and periodontal care <script>alert(1)</script>\n- Teach patients how to care for their teeth\n\nLedger Dental is a **friendly** practice in Irvine, and the team works four days a week.";
    p.communication.companyBlurb = "UNAPPROVED-BLURB: the role plan's own company line.";
    p.compensation.benefitsSummary = "Health and dental cover, paid holidays.";
    await container.db.update(rolePackets).set({ packet: p }).where(eq(rolePackets.id, pv.id));
    eligibility = p.requirements.eligibility;
    maxMinutes = p.screening.maxMinutes;
    questionCount = p.screening.questions.length;
  });
  afterAll(async () => {
    await container.close();
  });

  it("names what the team looks for and what would be nice by their words only, every place, the posted date and the benefits, and draws the description's headings and bullets with everything else escaped", async () => {
    const raw = await page(`/careers/${slug}/jobs/${roleId}`);
    const html = decode(raw);
    expect(html).toContain("<h2>What we're looking for</h2>");
    expect(html).toMatch(/<ul class="checks"><li><svg class="icon"[^>]*>.*?<\/svg><span>An active California RDH license<\/span><\/li><\/ul>/);
    expect(html).toContain("<h2>Nice to have</h2>");
    expect(html).toContain("<span>Experience with Dentrix</span>");
    expect(html).not.toMatch(/PRIVATE-RATIONALE/);
    expect(html).toContain("<h2>Benefits</h2>");
    expect(html).toContain("Health and dental cover, paid holidays.");
    // every place, the workplace and the posted date as pills
    expect(html).toContain('<span class="sr-only">Location: </span><span class="fact-text">Irvine, CA</span>');
    expect(html).toContain('<span class="sr-only">Location: </span><span class="fact-text">Tustin, CA</span>');
    expect(html).toContain('<span class="fact-text">On site</span>');
    expect(html).toMatch(/<span class="fact-text">Posted [A-Z][a-z]+ \d{1,2}, 20\d\d<\/span>/);
    // headings one level under "About the job", bullets as a list, markdown marks gone, typed markup shown as words
    expect(html).toContain('<div class="desc"><h3>What you will do</h3><ul><li>Cleanings and periodontal care <script>alert(1)</script></li><li>Teach patients how to care for their teeth</li></ul><p>Ledger Dental is a friendly practice in Irvine');
    expect(raw).toContain("Cleanings and periodontal care &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(raw).not.toContain("<script>alert(1)");
    // the role plan's own company line is never shown, approved or not
    expect(html).not.toContain("UNAPPROVED-BLURB");
  });

  it("the four points and the pre-apply line name the company's own hiring contact when it set one, the ITS inbox otherwise", async () => {
    let html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    const its = container.env.EMAIL_REPLY_TO;
    expect(html).toContain("<li><svg class=\"icon\"");
    for (const point of [`About ${oneVisitMinutes({ screening: { maxMinutes } })} minutes, including a short written conversation with Ledger Dental's AI assistant.`, "A resume, or a few lines about your work. No cover letter.", "People at Ledger Dental make every hiring decision."]) expect(html).toContain(point);
    expect(html).toContain(`Questions? Email <a href="mailto:${its}">${its}</a> to reach a person.`);
    expect(html).toContain(`Need help applying, or a change to how you apply because of a disability? Email <a href="mailto:${its}">${its}</a> and a person will help.`);
    await setSettings((s) => { s.hiringContact = { email: "jobs@ledger.test", name: "Maya", setAt: new Date().toISOString(), setBy: { kind: "user", id: "u1" } }; });
    html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).toContain('Questions? Email Maya at <a href="mailto:jobs@ledger.test">jobs@ledger.test</a> to reach a person.');
    expect(html).not.toContain(`mailto:${its}`);
    const form = decode(await page(`/careers/${slug}/jobs/${roleId}/apply`));
    expect(form.slice(0, form.indexOf("<form"))).toContain('Need help applying, or a change to how you apply because of a disability? Email Maya at <a href="mailto:jobs@ledger.test">');
    await setSettings((s) => { delete s.hiringContact; });
  });

  it("says how long applying really takes (plan E8): the conversation included when it follows the form, the form alone when the role or the owner's rule keeps it for later", async () => {
    const total = oneVisitMinutes({ screening: { maxMinutes } });
    let html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    // one visit: the time on the panel and the steps count the conversation, and say who it is with
    expect(html).toContain(`<span>About ${total} minutes, including a short written conversation with Ledger Dental's AI assistant.</span>`);
    expect(html).toContain(`<li>Apply in about ${total} minutes, including a short written conversation with Ledger Dental's AI assistant. We confirm by email.</li>`);
    expect(html).toContain(`<li>The conversation: ${questionCount} questions, about ${maxMinutes} minutes. It is not a test. You can skip a question, stop and come back later, or ask for a person instead.</li>`);
    // at a glance, the first sentence of each; every step in full one click away (founder brief, 14 October 2026)
    const glance = html.slice(html.indexOf("<h2>What to expect</h2>"), html.indexOf('<details class="more"><summary>More about each step</summary>'));
    expect(glance).toContain(`<li>Apply in about ${total} minutes, including a short written conversation with Ledger Dental's AI assistant.</li>`);
    expect(glance).toContain(`<li>The conversation: ${questionCount} questions, about ${maxMinutes} minutes.</li>`);
    expect(glance).toContain("<li>A decision, and a real answer either way.</li>");
    expect(glance.match(/<li>/g)!.length).toBeLessThanOrEqual(4);
    expect(html).not.toMatch(/three minutes|looks like a fit/);
    let form = decode(await page(`/careers/${slug}/jobs/${roleId}/apply`));
    expect(form).toContain(`<p class="lead">About ${total} minutes, including a short written conversation with Ledger Dental's AI assistant. First, this form; no cover letter needed.</p>`);
    expect(form).toContain("Next comes the short written conversation with Ledger Dental's AI assistant. You can start it straight away, do it later, or ask for a person instead.");
    expect(form).not.toContain("three minutes");
    // ITS switched the role back to "form now, conversation later": the form alone, and a conversation that may follow by email
    await container.db.update(roles).set({ applyMode: "form_then_screen" }).where(eq(roles.id, roleId));
    html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).toContain("<span>A short form, about 3 minutes.</span>");
    expect(html).toContain(`<li>Possibly a short written conversation with Ledger Dental's AI assistant (online, about ${maxMinutes} minutes). If so, we email you the link.</li>`);
    expect(html).not.toContain("including a short written conversation");
    form = decode(await page(`/careers/${slug}/jobs/${roleId}/apply`));
    expect(form).toContain('<p class="lead">A short form, about 3 minutes. No cover letter needed.</p>');
    expect(form).not.toContain("Next comes the short written conversation");
    await container.db.update(roles).set({ applyMode: null }).where(eq(roles.id, roleId));
    // the owner's rule for screen invitations is "Ask me first": the same later path, so the same words
    expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: ["owner"] })).status).toBe(200);
    expect(decode(await page(`/careers/${slug}/jobs/${roleId}`))).toContain("<span>A short form, about 3 minutes.</span>");
    expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] })).status).toBe(200);
    expect(decode(await page(`/careers/${slug}/jobs/${roleId}`))).toContain(`<span>About ${total} minutes, including`);
  });

  it("shows the text about the company only once a person approved it, with the website; a draft waiting in Setup never shows", async () => {
    await setSettings((s) => { s.aboutDraft = { text: "DRAFT-ONLY text about Ledger Dental that nobody approved yet.", draftedAt: new Date().toISOString(), draftedBy: { kind: "user", id: "u1" }, aiRunId: null, basedOn: [] }; s.website = "ledgerdental.example"; });
    let html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).not.toContain("DRAFT-ONLY");
    expect(html).not.toContain('id="about-company"');
    await setSettings((s) => { s.about = { text: "Ledger Dental is a family-owned dental practice in Irvine, CA.\nIt has cared for local patients since 2004.", approvedAt: new Date().toISOString(), approvedBy: { kind: "user", id: "u1", name: "Olive Owner" }, aiAssisted: true }; });
    html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).toContain('<section class="card about" aria-labelledby="about-company"><h2 id="about-company">About Ledger Dental</h2><p class="pre">Ledger Dental is a family-owned dental practice in Irvine, CA.\nIt has cared for local patients since 2004.</p>');
    expect(html).toMatch(/<a class="site" href="https:\/\/ledgerdental\.example" rel="noopener">ledgerdental\.example<svg/);
    expect(html).not.toContain("DRAFT-ONLY");
    const careers = decode(await page(`/careers/${slug}`));
    expect(careers).toContain("It has cared for local patients since 2004.");
    expect(careers).not.toContain("UNAPPROVED-BLURB");
  });

  it("carries a description, link-preview tags and a canonical address; the logo is our stored copy, served from our own address and named in the structured data", async () => {
    const urls = jobUrls(container.env, { slug, roleId });
    let html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).toMatch(/<meta name="description" content="What you will do|<meta name="description" content="Cleanings and periodontal care/);
    expect(html).toContain(`<link rel="canonical" href="${urls.job}"/>`);
    expect(html).toMatch(/<meta property="og:title" content="[^"]+ at Ledger Dental"\/>/);
    expect(html).toContain(`<meta property="og:url" content="${urls.job}"/>`);
    expect(html).toContain('<meta property="og:site_name" content="Ledger Dental"/>');
    expect(html).toContain('<meta name="twitter:card" content="summary"/>');
    expect(html).not.toContain("og:image");
    expect(html).not.toContain('name="robots"');
    // a stored logo: the page shows it from our own address, the link preview and the structured data name its full address
    const file = "0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3.png";
    const key = `logos/${companyId}/${file}`;
    await container.integrations.storage.put(key, png(), "image/png");
    await setSettings((s) => { s.logo = { file, key, contentType: "image/png", sizeBytes: 64, width: 200, height: 80, uploadedAt: new Date().toISOString(), uploadedBy: { kind: "user", id: "u1" } }; s.logoUrl = `https://jobs.example.test/careers/${slug}/logo/${file}`; });
    html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(html).toContain(`<span class="logo" aria-hidden="true"><img src="/careers/${slug}/logo/${file}" alt="" width="56" height="56"/></span>`);
    expect(html).toContain(`<meta property="og:image" content="https://jobs.example.test/careers/${slug}/logo/${file}"/>`);
    expect((jsonLdOf(html).hiringOrganization as { logo: string }).logo).toBe(`https://jobs.example.test/careers/${slug}/logo/${file}`);
    const img = await app.request(`/careers/${slug}/logo/${file}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(img.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png());
    // only the company's current file, by its exact name
    for (const bad of [`/careers/${slug}/logo/0192f0c4-1c2d-7a3b-8c4d-5e6f708192a4.png`, `/careers/${slug}/logo/..%2F..%2Fsecret.png`, `/careers/other-company/logo/${file}`]) expect((await app.request(bad)).status, bad).toBe(404);
    // the careers page shows it too
    expect(await page(`/careers/${slug}`)).toContain(`<img src="/careers/${slug}/logo/${file}" alt=""`);
    // a company ITS has not confirmed has no public logo either (founder decision B7)
    await setSettings((s) => { s.verifiedAtSaved = s.verifiedAt; delete s.verifiedAt; });
    expect((await app.request(`/careers/${slug}/logo/${file}`)).status).toBe(404);
    await setSettings((s) => { s.verifiedAt = s.verifiedAtSaved; delete s.verifiedAtSaved; });
  });

  it("the careers page lists each open job with its places, work model, kind, pay, first lines and closing date, from one query", async () => {
    const closesOn = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await container.db.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, roleId));
    const html = decode(await page(`/careers/${slug}`));
    const card = html.slice(html.indexOf('<li class="card role">'), html.indexOf("</li>", html.lastIndexOf('<span class="sr-only">: ')) + 5);
    expect(card).toContain("<h3>");
    expect(card).toContain('<ul class="facts small">');
    for (const fact of ["Irvine, CA", "Tustin, CA", "On site", "Full time", "$45–$55 an hour"]) expect(card).toContain(`<span class="fact-text">${fact}</span>`);
    expect(card).toContain('<p class="excerpt">Cleanings and periodontal care <script>alert(1)</script> Teach patients how to care for their teeth');
    expect(card).toContain(`<p class="meta">${applyByLabel(closesOn)}</p>`);
    expect(card).toMatch(/View and apply<span class="sr-only">: [^<]+<\/span>/);
    expect(html).toContain('<meta property="og:title" content="Careers at Ledger Dental"/>');
    // the job page says the same, by the title and in the panel
    const job = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(job.match(new RegExp(applyByLabel(closesOn), "g"))).toHaveLength(2);
    await container.db.update(roles).set({ applicationsCloseOn: null }).where(eq(roles.id, roleId));
  });

  it("a closing date: the structured data and the feeds end on it; once it passes a newcomer finds the form closed, while someone part-way through may still send theirs for a while", async () => {
    const closesOn = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await container.db.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, roleId));
    resetPublicFeedCache(container);
    expect(jsonLdOf(await page(`/careers/${slug}/jobs/${roleId}`)).validThrough).toBe(closesOn);
    const feed = (await (await app.request("/feeds/jobs.json")).json()) as { jobs: Array<{ referenceNumber: string; validThrough?: string }> };
    expect(feed.jobs.find((j) => j.referenceNumber === roleId)?.validThrough).toBe(closesOn);
    expect(await (await app.request("/feeds/jobs.xml")).text()).toContain(`<expirationdate><![CDATA[${closesOn}]]></expirationdate>`);
    // someone opens the form; then the date passes and applications stop (the closing-date timer's own change)
    const form = await page(`/careers/${slug}/jobs/${roleId}/apply`);
    const opened = form.match(/name="formOpened" value="([^"]+)"/)![1];
    const stoppedAt = new Date(container.engine.clock().getTime() + 1000).toISOString();
    await container.db.update(roles).set({ acceptingApplications: false, applicationsClosedAt: stoppedAt, applicationsClosedReason: CLOSING_DATE_REASON }).where(eq(roles.id, roleId));
    try {
      const job = decode(await page(`/careers/${slug}/jobs/${roleId}`));
      expect(job).toContain(`Applications for this position closed at the end of ${closingDayWords(closesOn)}.`);
      expect(job).not.toContain(">Apply now<");
      expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`)).status).toBe(404);
      const careers = decode(await page(`/careers/${slug}`));
      expect(careers).toContain(`Applications closed at the end of ${closingDayWords(closesOn)}.`);
      expect(careers).toContain("View details");
      // a newcomer's submission (no sealed opening time, or a forged one) is refused; the person part-way through gets in
      expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applyForm({ email: "late.newcomer@example.com", nr_recentWork: "Hygienist." }) })).status).toBe(404);
      expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applyForm({ email: "late.forged@example.com", nr_recentWork: "Hygienist.", formOpened: `${opened}x` }) })).status).toBe(404);
      const intent = (formOpened?: string) => app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "r.txt", size: 10, type: "text/plain", ...(formOpened ? { formOpened } : {}) }) });
      expect((await intent()).status).toBe(404);
      expect((await intent(opened)).status).toBe(200);
      const late = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applyForm({ email: "late.finisher@example.com", nr_recentWork: "Hygienist at Coastal Dental since 2019.", formOpened: opened }) });
      expect(late.status).toBe(302);
      // they finish applying like anyone else: the conversation follows in the same visit (plan E1)
      expect(late.headers.get("location")).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
      await container.drain();
      expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).length).toBeGreaterThan(0);
    } finally {
      await container.db.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, applicationsCloseOn: null }).where(eq(roles.id, roleId));
      resetPublicFeedCache(container);
    }
  });

  it("applying without a resume: four short questions, each answer kept and summed up for the team; one answer is enough, none is asked for again with the questions open", async () => {
    const none = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applyForm({ email: "no.answers@example.com" }) });
    expect(none.status).toBe(400);
    const again = decode(await none.text());
    expect(again).toContain("Upload a resume, or answer at least one of the four short questions about your work.");
    expect(again).toMatch(/<details class="no-resume" open[^>]*>/);
    expect(again).toMatch(/<textarea id="nr_recentWork"[^>]*aria-invalid="true"/);
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applyForm({ email: "guided.answers@example.com", nr_recentWork: "Dental assistant at Smile Bright, three years", nr_skills: "X-ray certificate; Dentrix", nr_lookingFor: "Full time, near Irvine" }) });
    expect(r.status).toBe(302);
    await container.drain();
    const rows = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    const mine = rows.find((a) => a.answers.noResume?.recentWork === "Dental assistant at Smile Bright, three years")!;
    expect(mine.answers.noResume).toEqual({
      recentWork: "Dental assistant at Smile Bright, three years",
      skills: "X-ray certificate; Dentrix",
      lookingFor: "Full time, near Irvine",
      summary: "Most recent work: Dental assistant at Smile Bright, three years\nSkills, licenses or tools: X-ray certificate; Dentrix\nLooking for: Full time, near Irvine",
    });
  });
});
