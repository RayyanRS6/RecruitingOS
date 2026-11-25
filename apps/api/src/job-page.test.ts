import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CLOSING_DATE_REASON, ON_FILE_LAST_STEP, applyByLabel, closingDayWords } from "@ros/core";
import { applications, companies, roles } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { descriptionBlocks, descriptionExcerpt } from "./pages/description";
import { initials } from "./pages/job-page";
import { resetSitemapCache } from "./pages/sitemap";
import { APPLY_TIME_LINE, applySteps } from "./services/job-preview";
import { jobUrls } from "./services/job-urls";
import { applicationForm, plantJob, seedCompany, usePlan } from "./test-helpers";

/** The first bytes of a PNG: enough for the server's header check, which never decodes pixels. */
function png(width = 200, height = 80): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe("what the job page is drawn from", () => {
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
    // a plain description is one paragraph; a sentence ending in a colon after other words stays text
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

  it("shows a company without a logo by its initials", () => {
    expect(initials("Harbor Dental")).toBe("HD");
    expect(initials("Smile & Co.")).toBe("SC");
    expect(initials("acme")).toBe("AC");
  });

  it("'What to expect': a short form, the team's review, an AI interview by email only for someone shortlisted, and people deciding; a job past its limit promises an email by a date and no review", () => {
    expect(applySteps({ companyName: "Dr. Lee Dental", onFile: false })).toEqual([
      "Send a short form, about 3 minutes. We confirm by email.",
      "The hiring team at Dr. Lee Dental reviews your application.",
      "If you are shortlisted, we email you a link to a short AI interview: a written chat you do at a time that suits you.",
      "The team decides. People on the hiring team make every decision.",
    ]);
    expect(applySteps({ companyName: "Dr. Lee Dental", onFile: true })).toEqual(["Send a short form, about 3 minutes. We confirm by email.", ON_FILE_LAST_STEP]);
    expect(APPLY_TIME_LINE).toBe("A short form, about 3 minutes.");
  });
});

describe("the job page and the careers page", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let companyId = "";
  let slug = "";
  let roleId = "";
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
  const apply = (fd: FormData) => app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    ({ companyId, slug } = await seedCompany(app, { email: "owner@jobpage.test", name: "Ledger Dental" }));
    await usePlan(container, companyId);
    // A job with the shapes this page has to handle: two places, a nice-to-have, a description with headings, bullets and
    // markup typed into it, a reason beside each requirement (the team's), and the job record's own company line (which
    // no person approved).
    roleId = await plantJob(container, {
      companyId,
      title: "Registered Dental Hygienist",
      packet: (p) => {
        p.identity.locations = [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }];
        p.compensation = { ...p.compensation, min: 45, max: 55, benefitsSummary: "Health and dental cover, paid holidays." };
        p.requirements.mustHaves = [{ key: "mh_license", text: "An active California RDH license", rationale: "PRIVATE-RATIONALE-1" }];
        p.requirements.niceToHaves = [{ key: "nh_dentrix", text: "Experience with Dentrix", rationale: "PRIVATE-RATIONALE-2" }];
        p.description.publicJobDescription = "## What you will do\n- Cleanings and periodontal care <script>alert(1)</script>\n- Teach patients how to care for their teeth\n\nLedger Dental is a **friendly** practice in Irvine, and the team works four days a week.";
        p.communication.companyBlurb = "UNAPPROVED-BLURB: the job record's own company line.";
      },
    });
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
    // the job record's own company line is never shown, approved or not
    expect(html).not.toContain("UNAPPROVED-BLURB");
  });

  it("the four points and the pre-apply line name the company's own hiring contact when it set one, the ITS inbox otherwise", async () => {
    let html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    const its = container.env.EMAIL_REPLY_TO;
    for (const point of [APPLY_TIME_LINE, "Your resume. No cover letter.", "People at Ledger Dental make every hiring decision."]) expect(html).toContain(`<span>${point}</span>`);
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

  it("says what to expect in four steps, and nothing on the job page or the form presents an AI interview as part of applying", async () => {
    const html = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    const steps = applySteps({ companyName: "Ledger Dental", onFile: false });
    expect(html).toContain(`<h2>What to expect</h2><ol class="steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`);
    // the AI interview is named once, as something that may come later by email
    expect(html.match(/AI interview/g)).toHaveLength(1);
    expect(html).not.toMatch(/right after the form|including a short AI interview|AI assistant|More about each step|either way/);
    // the time on the apply card is the form's alone
    expect(html.match(new RegExp(`<span>${APPLY_TIME_LINE}</span>`, "g"))).toHaveLength(2);
    const form = decode(await page(`/careers/${slug}/jobs/${roleId}/apply`));
    expect(form).toContain('<p class="lead">A short form for Ledger Dental, about 3 minutes. No cover letter needed.</p>');
    expect(form).not.toMatch(/AI interview|AI assistant|Read my resume|No resume\?|saved details/);
  });

  it("carries where a candidate came from (?src=) from the job page on to the form and back again, and drops anything that is not a plain word", async () => {
    const job = `/careers/${slug}/jobs/${roleId}`;
    const fromPost = await page(`${job}?src=linkedin`);
    expect(fromPost.match(new RegExp(`href="${job}/apply\\?src=linkedin"`, "g"))).toHaveLength(2);
    const form = await page(`${job}/apply?src=linkedin`);
    expect(form).toContain('<input type="hidden" name="src" value="linkedin"');
    // "Back to the job" keeps it, so pressing Apply there again is still counted to LinkedIn
    expect(form).toContain(`<p class="back"><a href="${job}?src=linkedin">`);
    // and so does a form that comes back with something to fix
    const sentBack = await apply(applicationForm({ firstName: "", src: "indeed" }));
    expect(sentBack.status).toBe(400);
    const again = await sentBack.text();
    expect(again).toContain(`<p class="back"><a href="${job}?src=indeed">`);
    expect(again).toContain('<input type="hidden" name="src" value="indeed"');
    const odd = await page(`${job}?src=${encodeURIComponent("<x y>")}`);
    expect(odd).not.toContain("src=");
    const oddForm = await page(`${job}/apply?src=${encodeURIComponent("<x y>")}`);
    expect(oddForm).not.toContain('name="src"');
    expect(oddForm).toContain(`<p class="back"><a href="${job}">`);
    // with no source the links are the plain ones, both ways
    expect((await page(job)).match(new RegExp(`href="${job}/apply"`, "g"))).toHaveLength(2);
    expect(await page(`${job}/apply`)).toContain(`<p class="back"><a href="${job}">`);
  });

  it("shows the text about the company only once a person approved it, with the website; a draft waiting in Settings never shows", async () => {
    await setSettings((s) => { s.aboutDraft = { text: "DRAFT-ONLY text about Ledger Dental that nobody approved yet.", draftedAt: new Date().toISOString(), draftedBy: { kind: "user", id: "u1" }, aiRunId: null }; s.website = "ledgerdental.example"; });
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
    // a company that is not live has no public logo, and no public page, either
    await setSettings((s) => { s.verifiedAtSaved = s.verifiedAt; delete s.verifiedAt; });
    expect((await app.request(`/careers/${slug}/logo/${file}`)).status).toBe(404);
    expect((await app.request(`/careers/${slug}/jobs/${roleId}`)).status).toBe(404);
    await setSettings((s) => { s.verifiedAt = s.verifiedAtSaved; delete s.verifiedAtSaved; });
  });

  it("the careers page lists each open job with its places, work model, kind, pay, first lines and closing date, from one query, and its link preview promises nothing", async () => {
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
    expect(html).not.toContain("We respond to every applicant");
    // the job page says the same, by the title and in the panel
    const job = decode(await page(`/careers/${slug}/jobs/${roleId}`));
    expect(job.match(new RegExp(applyByLabel(closesOn), "g"))).toHaveLength(2);
    await container.db.update(roles).set({ applicationsCloseOn: null }).where(eq(roles.id, roleId));
  });

  it("a closing date: the structured data ends on it; once it passes a newcomer finds the form closed, while someone part-way through may still send theirs for a while", async () => {
    const closesOn = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await container.db.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, roleId));
    resetSitemapCache(container);
    expect(jsonLdOf(await page(`/careers/${slug}/jobs/${roleId}`)).validThrough).toBe(closesOn);
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
      expect((await apply(applicationForm({ email: "late.newcomer@example.com" }))).status).toBe(404);
      expect((await apply(applicationForm({ email: "late.forged@example.com", formOpened: `${opened}x` }))).status).toBe(404);
      const intent = (formOpened?: string) => app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "r.txt", size: 10, type: "text/plain", ...(formOpened ? { formOpened } : {}) }) });
      expect((await intent()).status).toBe(404);
      expect((await intent(opened)).status).toBe(200);
      const late = await apply(applicationForm({ email: "late.finisher@example.com", formOpened: opened }));
      expect(late.status).toBe(302);
      // they get the receipt anyone gets, and their application is in
      expect(late.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
      await container.drain();
      expect(await container.db.select().from(applications).where(eq(applications.roleId, roleId))).toHaveLength(1);
    } finally {
      await container.db.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, applicationsCloseOn: null }).where(eq(roles.id, roleId));
      resetSitemapCache(container);
    }
  });
});
