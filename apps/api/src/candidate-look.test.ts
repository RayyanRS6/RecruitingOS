import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCandidateCsp } from "@ros/core";
import { applications, roles, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { SCREEN_CSS, STATUS_CSS } from "./pages/candidate";
import { CANDIDATE_FONTS, DISPLAY_WEIGHTS, DISPLAY_WIDTHS, FONT_DIR, FONT_LOCK_FILE, type FontLock, fontLicenceFile } from "./pages/fonts";
import { AI_NOTICE_LINE } from "./pages/job-page";
import { CSS } from "./pages/layout";
import { applicationForm, plantJob, seedCompany, statusTokenFor, usePlan } from "./test-helpers";

/**
 * The candidate pages' look: the server-rendered pages wear the application's look (docs/07). Every colour and shadow
 * token they declare carries the value packages/ui/src/styles.css gives it, in both themes (the pages copy the subset
 * they use; only their corner radii and font stacks are their own), the fonts come from this deployment's own origin so
 * the policy keeps `font-src 'self'`, secondary buttons are styled on every page, and the job page shows its facts with
 * their icons and one Apply button that stays reachable on a phone.
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const uiCss = stripComments(readFileSync(new URL("../../../packages/ui/src/styles.css", import.meta.url), "utf8"));
const pageCss = stripComments(CSS);
/** The candidate pages' own tokens, which the application has no copy of: corner radii and font stacks, no colours. */
const PAGE_ONLY = new Set(["--r-control", "--r-card", "--r-panel", "--r-pill", "--display", "--ui", "--mono"]);

/** The custom properties declared in the first `{ … }` block that follows `start` in `css`. */
function block(css: string, start: string, from = 0): Map<string, string> {
  const at = css.indexOf(start, from);
  if (at < 0) throw new Error(`no ${start} block`);
  const open = css.indexOf("{", at + start.length - 1);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const uiLight = block(uiCss, ":root {");
const uiDark = block(uiCss, ':root:not([data-theme="light"]) {');
const pageLight = block(pageCss, ":root {");
const pageDark = block(pageCss, ":root {", pageCss.indexOf("@media (prefers-color-scheme: dark)"));

describe("candidate pages: design tokens and fonts", () => {
  it("copies the application's token values exactly, in the light and the dark theme", () => {
    const shared = [...pageLight.keys()].filter((name) => !PAGE_ONLY.has(name));
    expect(shared.length).toBeGreaterThan(20);
    for (const name of shared) expect(pageLight.get(name), `${name} (light)`).toBe(uiLight.get(name));
    for (const [name, value] of pageDark) expect(value, `${name} (dark)`).toBe(uiDark.get(name));
    // every token the page copies that turns in the dark theme turns on the page too
    for (const name of shared) if (uiDark.has(name)) expect(pageDark.get(name), `${name} has no dark value on the page`).toBe(uiDark.get(name));
    // the page's own tokens are shapes and type, never a colour of its own
    for (const name of PAGE_ONLY) if (pageLight.has(name)) expect(pageLight.get(name), name).not.toMatch(/#|rgb|hsl/);
  });

  it("uses only tokens it declares, and no colour outside the token blocks", () => {
    const used = new Set([...`${CSS}${SCREEN_CSS}${STATUS_CSS}`.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(pageLight.has(name), `${name} is used but not declared`).toBe(true);
    const outside = `${pageCss.slice(0, pageCss.indexOf(":root {"))}${pageCss.slice(pageCss.indexOf("* {"))}${stripComments(SCREEN_CSS)}${stripComments(STATUS_CSS)}`;
    expect(outside).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // the plum primary button and the outlined secondary one, on every page
    expect(pageCss).toMatch(/\.btn \{[^}]*background: var\(--primary\); color: var\(--on-primary\);/);
    expect(pageCss).toMatch(/\.btn\.secondary \{ background: var\(--surface\); border-color: var\(--line-2\); color: var\(--ink\); \}/);
    expect(SCREEN_CSS).not.toContain(".btn");
    expect(STATUS_CSS).not.toContain(".btn");
    // the chat read back on the status page and the AI interview's chat are one look: the candidate's own on the right
    // in peach, the assistant's on the left in white
    for (const css of [SCREEN_CSS, STATUS_CSS]) {
      expect(css).toContain(".msg.candidate { align-self: flex-end; background: var(--peach); color: var(--ink);");
      expect(css).toMatch(/\.msg\.assistant \{ align-self: flex-start;[^}]*background: var\(--surface\);/);
    }
    // the status page styles nothing it no longer draws: no score, no bars, no list of other applications, no thread of the team's
    expect(STATUS_CSS).not.toMatch(/\.score|\.bars|\.apps|\.msg\.team/);
    // the status page's steps: down the page on a phone, across it from 600 pixels; the tick on the plum fill; no motion
    expect(STATUS_CSS).toContain(".track li.done .dot { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }");
    expect(STATUS_CSS).toMatch(/@media \(min-width: 600px\) \{[^@]*\.track \{ grid-auto-flow: column;/);
    expect(stripComments(STATUS_CSS)).not.toMatch(/transition|animation/);
    expect(pageCss).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }");
  });

  // Wave S6 (15 October 2026): in dark mode on Windows a dropdown's open list showed near-white words on a light list.
  it("colours every dropdown's open list with the same rule as the application, and leaves the native arrow alone", () => {
    const rule = "select, option, optgroup { background-color: var(--surface); color: var(--ink); }";
    expect(uiCss).toContain(rule);
    expect(pageCss).toContain(rule);
    // the page's own select rule (the closed control) still sets the same two colours
    expect(pageCss).toMatch(/textarea, select \{[^}]*background: var\(--surface\); color: var\(--ink\);/);
    expect(pageCss).not.toMatch(/appearance\s*:\s*none/);
    // the dark list reads: the page turns color-scheme with its tokens
    expect(pageCss).toMatch(/:root \{[^}]*color-scheme: light;/);
    expect(pageCss.slice(pageCss.indexOf("@media (prefers-color-scheme: dark)"))).toMatch(/:root \{[^}]*color-scheme: dark;/);
  });

  it("declares IBM Plex Sans and Bricolage Grotesque from this deployment's own /fonts/ folder, and the policy still names no outside host", () => {
    // Bricolage Grotesque is one variable file (weights 200 to 800, widths 75% to 100%), named by its width axis
    for (const [family, weight, file] of [["IBM Plex Sans", "400", "400"], ["IBM Plex Sans", "600", "600"], ["Bricolage Grotesque", DISPLAY_WEIGHTS, "wdth"]] as const) {
      const faces = [...CSS.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]).filter((f) => f.includes(`font-family: "${family}"`) && f.includes(`font-weight: ${weight};`));
      expect(faces, `${family} ${weight}`).toHaveLength(2); // the latin file and the latin-ext file
      for (const f of faces) {
        expect(f).toContain("font-display: swap");
        expect(f).toMatch(new RegExp(`url\\("${FONT_DIR}/[a-z-]+-latin(-ext)?-${file}-normal\\.woff2"\\) format\\("woff2"\\)`));
        expect(f).toContain("unicode-range: U+");
        // the variable face says its widths and is never taken from the device (an installed copy may be one fixed cut)
        expect(f.includes(`font-stretch: ${DISPLAY_WIDTHS};`)).toBe(file === "wdth");
        if (file === "wdth") expect(f).not.toContain("local(");
      }
    }
    // the big headings are set narrow, inside the widths the file has
    expect(pageCss).toMatch(/\nh1 \{[^}]*font-stretch: 80%;/);
    // nothing on a candidate page loads from another origin, so font-src 'self' covers the fonts
    expect(`${CSS}${SCREEN_CSS}`).not.toMatch(/https?:|url\((?!"\/fonts\/)/);
    const csp = buildCandidateCsp({ nonce: "n", production: true, reportPath: "/api/csp-report" });
    expect(csp).toContain("font-src 'self';");
    expect(csp).not.toMatch(/https?:\/\//);
    // only the weights that have a file: no faux bold (the rules that use a weight, not the faces that declare theirs)
    const weights = [...pageCss.replace(/@font-face \{[^}]*\}/g, "").matchAll(/font-weight: (\d+)|font: (\d+) /g)].map((m) => Number(m[1] ?? m[2]));
    for (const w of weights) expect([400, 600, 700], `font weight ${w}`).toContain(w);
    // Fontsource's file names, one file per face and subset, so scripts/fetch-fonts.ts can copy them one for one
    expect(new Set(CANDIDATE_FONTS.map((f) => f.file)).size).toBe(CANDIDATE_FONTS.length);
    for (const f of CANDIDATE_FONTS) expect(f.file).toBe(`${f.slug}-${f.subset}-${f.stretch ? "wdth" : f.weight}-normal.woff2`);
    for (const f of CANDIDATE_FONTS) expect(f.pkg).toBe(`${f.stretch ? "@fontsource-variable" : "@fontsource"}/${f.slug}`);
  });

  const fontsDir = new URL("../../shell/public/fonts/", import.meta.url);
  it.skipIf(!existsSync(fontsDir))("once the font files are in apps/shell/public/fonts, every declared file is there, is a woff2 file, and matches the pinned lock", () => {
    const lockFile = new URL(`../../../${FONT_LOCK_FILE}`, import.meta.url);
    expect(existsSync(lockFile), `${FONT_LOCK_FILE} must be committed with the font files`).toBe(true);
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as FontLock;
    // exact versions only: nothing floats to whatever release is newest
    for (const slug of new Set(CANDIDATE_FONTS.map((f) => f.slug))) {
      expect(lock.packages[slug], `${slug} version`).toMatch(/^\d+\.\d+\.\d+$/);
      const licence = new URL(fontLicenceFile(slug), fontsDir);
      expect(existsSync(licence), `${fontLicenceFile(slug)} is missing`).toBe(true);
      expect(createHash("sha256").update(readFileSync(licence)).digest("hex"), fontLicenceFile(slug)).toBe(lock.files[fontLicenceFile(slug)]);
    }
    for (const f of CANDIDATE_FONTS) {
      const file = new URL(f.file, fontsDir);
      expect(existsSync(file), `${f.file} is missing`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString("latin1"), f.file).toBe("wOF2");
      expect(lock.files[f.file], `${f.file} has no hash in the lock`).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(bytes).digest("hex"), `${f.file} does not match the lock`).toBe(lock.files[f.file]);
    }
  });
});

describe("candidate pages: the look, page by page", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let slug = "";
  let roleId = "";
  let statusToken = "";
  let screenToken = "";
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return r.text();
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    const company = await seedCompany(app, { email: "owner@look.test", name: "Look Dental" });
    ({ owner, slug } = company);
    await usePlan(container, company.companyId);
    roleId = await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist", packet: (p) => { p.compensation = { ...p.compensation, min: 45, max: 55 }; } });
    // Someone applies, and the team shortlists them: their status page then has the AI interview's step and its button.
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: applicationForm({ firstName: "Ivy", lastName: "Chen", email: "ivy.chen@example.com" }) })).status).toBe(302);
    statusToken = await statusTokenFor(container, { roleId, email: "ivy.chen@example.com" });
    await container.drain();
    const [appRow] = await container.db.select().from(applications).where(eq(applications.statusToken, statusToken));
    expect((await json(owner, "POST", `/api/v1/applications/${appRow.id}/actions`, { action: "shortlist" })).status).toBe(200);
    await container.drain();
    screenToken = (await container.db.select().from(screens).where(eq(screens.applicationId, appRow.id)))[0]?.token ?? "";
  });
  afterAll(async () => {
    await container.close();
  });

  /** One main heading, the shared stylesheet, the colour-scheme hint, no leftover quiet buttons, and no script it needs. */
  const looksRight = async (path: string) => {
    const html = await page(path);
    expect(html.match(/<h1[\s>]/g), path).toHaveLength(1);
    expect(html, path).toMatch(/<meta name="color-scheme" content="light dark"\s*\/?>/);
    expect(html, path).toContain(".btn.secondary { background: var(--surface)");
    expect(html, path).toContain('@font-face { font-family: "IBM Plex Sans"');
    expect(html, path).not.toContain("btn-quiet");
    expect(html, path).not.toMatch(/style="[^"]*width:auto/);
    // the only script is the structured data on the job page, the resume upload on the form and the AI interview's one-press guard: everything works without it
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) expect(m[1], path).toMatch(/type="application\/ld\+json"|nonce=/);
    return html;
  };

  it("every page has one main heading, the shared stylesheet, the colour-scheme hint and no leftover quiet buttons", async () => {
    expect(screenToken).toBeTruthy();
    for (const path of [`/careers/${slug}`, `/careers/${slug}/jobs/${roleId}`, `/careers/${slug}/jobs/${roleId}/apply`, `/careers/${slug}/jobs/${roleId}/applied`, `/c/status/${statusToken}`, `/c/screen/${screenToken}`, "/c/link-request", "/c/link-request?sent=1", "/privacy", "/c/privacy-request"]) await looksRight(path);
  });

  it("the privacy request form: the fields and the one button on the first view, the notice word for word one click away above the button", async () => {
    const html = await page("/c/privacy-request");
    const form = html.slice(html.indexOf('<form method="post" action="/c/privacy-request"'), html.indexOf("</form>"));
    const notice = form.slice(form.indexOf('<details class="more"><summary>Read the full notice</summary>'));
    expect(notice).toMatch(/^<details class="more"><summary>Read the full notice<\/summary><p class="notice"><strong>What we collect and why:<\/strong>/);
    expect(notice).toContain("a person handles every request; nothing is decided by software.");
    expect(notice.indexOf("</details>")).toBeLessThan(notice.indexOf("Send me the confirmation link"));
    expect(form.indexOf('<label for="email" class="flush">Your email address</label>')).toBeLessThan(form.indexOf("<details"));
    expect(form).toContain('<p class="meta">We email that address a link to confirm it is you; nothing happens until you open it and press the button.</p>');
  });

  it("the careers page lists each role as a card with an outlined button that names the role for a screen reader", async () => {
    const html = await page(`/careers/${slug}`);
    expect(html).toContain('<ul class="roles"><li class="card role">');
    expect(html).toMatch(/<a class="btn secondary" href="\/careers\/[^"]+\/jobs\/[^"]+">View and apply<span class="sr-only">: [^<]+<\/span><svg class="icon"/);
    // the logo alone above the heading, no "Careers" eyebrow, and no slogan anywhere when the company wrote no
    // introduction of its own, the link preview's text included
    const main = html.slice(html.indexOf("<main"));
    expect(main).toContain('<div class="careers-head"><div class="company"><span class="logo" aria-hidden="true">LD</span></div><h1>Work with <span>Look Dental</span></h1></div>');
    expect(main).not.toContain('<p class="eyebrow">');
    expect(html).not.toContain("We respond to every applicant");
    expect(html).toContain('<meta name="description" content="1 open job at Look Dental."/>');
    // the privacy page leads with its title, no eyebrow above it
    const privacy = await page("/privacy");
    expect(privacy.slice(privacy.indexOf("<main")).startsWith("<main><h1>How we handle your information</h1>")).toBe(true);
  });

  it("the job page: the company beside its initials, the facts as pills with icons and spoken names, an Apply button at the top and one in the panel that stays on a phone's screen, the notices before the panel", async () => {
    const html = await page(`/careers/${slug}/jobs/${roleId}`);
    expect(html).toContain('<main class="wide">');
    // the company in plain semibold words beside its logo (24 November 2026: no small capitals, no underline at rest)
    expect(html).toMatch(/<p class="company-name"><a href="\/careers\/[^"]+">Careers at Look Dental<\/a><\/p>/);
    expect(CSS).toMatch(/\.company-name \{[^}]*font-size: 15\.5px; font-weight: 600;/);
    expect(CSS).toMatch(/\.company-name a \{[^}]*min-height: 40px;[^}]*text-decoration: none; \}/);
    // no logo uploaded: the square shows the initials, hidden from screen readers since the name is written beside it
    expect(html).toContain('<span class="logo" aria-hidden="true">LD</span>');
    const facts = html.slice(html.indexOf('<ul class="facts">'), html.indexOf("</ul>", html.indexOf('<ul class="facts">')));
    expect(facts).toContain('<li class="fact"><svg class="icon"');
    expect(facts).toContain('aria-hidden="true" focusable="false"');
    expect(facts).toMatch(/<span class="sr-only">Location: <\/span><span class="fact-text">Irvine(, CA)?<\/span>/);
    expect(facts).toContain('<span class="sr-only">Workplace: </span><span class="fact-text">On site</span>');
    expect(facts).toContain('<span class="sr-only">Job type: </span><span class="fact-text">Full time</span>');
    expect(facts).toMatch(/<span class="sr-only">Pay: <\/span><span class="fact-text">\$45–\$55 an hour<\/span>/);
    // the posted date names itself, so it has no spoken prefix
    expect(facts).toMatch(/<li class="fact"><svg class="icon"[^>]*>.*?<\/svg><span class="fact-text">Posted [A-Z][a-z]+ \d{1,2}, \d{4}<\/span><\/li>/);
    // two Apply buttons: one by the title (hidden on a phone, where the bar is always there) and one in the panel
    expect(html.match(/>Apply now</g)).toHaveLength(2);
    expect(html).toMatch(/<a class="btn go head-apply" href="\/careers\/[^"]+\/apply"><span class="go-text">Apply now<\/span><span class="go-icon"><svg class="icon"[^>]*>.*?<\/svg><\/span><\/a>/);
    expect(CSS).toMatch(/@media \(max-width: 899px\) \{[^@]*\.head-apply \{ display: none; \}/);
    const panel = html.indexOf('<div class="apply-panel">');
    expect(panel).toBeGreaterThan(0);
    // Apply now (24 November 2026): the application's own plum pill, the words then an arrow in a light circle, the
    // words its only name; in the panel too
    expect(html.slice(panel)).toMatch(/<a class="btn go" href="\/careers\/[^"]+\/apply"><span class="go-text">Apply now<\/span><span class="go-icon"><svg class="icon"[^>]*>.*?<\/svg><\/span><\/a>/);
    // each one's accessible name is exactly "Apply now": take away what screen readers skip and only the words are left
    const goLinks = [...html.matchAll(/<a class="btn go[^"]*" href="[^"]+">(.*?)<\/a>/g)].map((m) => m[1]);
    expect(goLinks).toHaveLength(2);
    for (const inner of goLinks) expect(inner.replace(/<(span|svg)\b[^>]*aria-hidden="true"[^>]*>.*?<\/\1>/g, "").replace(/<[^>]+>/g, "")).toBe("Apply now");
    // it is the main button as it stands (plum fill, light words, the plum shadow): nothing slides across it and it
    // never looks switched off; the arrow steps right by transform alone, in 200ms, on a mouse's hover only
    expect(CSS).not.toContain("go-fill");
    const go = CSS.match(/\.btn\.go \{([^}]*)\}/)?.[1] ?? "";
    expect(go).toContain("justify-content: space-between;");
    expect(go).not.toMatch(/background|border-color|(?<!-)color:/);
    expect(CSS).toContain(".btn.secondary, .btn:disabled { box-shadow: none; }");
    expect(CSS).toMatch(/\.go-icon \{[^}]*border-radius: 50%; background: var\(--on-primary\); color: var\(--primary\); \}/);
    expect(CSS).toContain("@media (hover: hover) and (pointer: fine) { .btn.go:hover .go-icon .icon { transform: translateX(3px); } }");
    expect(CSS).toContain("@media (prefers-reduced-motion: no-preference) { .go-icon .icon { transition: transform 200ms ease-out; } }");
    expect(CSS).toContain("@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); } }");
    expect(CSS).not.toMatch(/backdrop-filter|filter:\s*blur|transition:[^;]*width/);
    expect(html.lastIndexOf(">Apply now<")).toBeGreaterThan(panel);
    // the panel opens on its button: no second job title, and no "We confirm by email." (the steps say it); a closing
    // date, when there is one, comes first
    expect(html.slice(panel)).toMatch(/^<div class="apply-panel"><div class="card apply-card"><a class="btn go" /);
    expect(html).not.toContain('class="apply-title"');
    expect(CSS).not.toContain(".apply-title");
    expect(html.slice(panel, html.indexOf('<ul class="points">', panel))).not.toContain("We confirm by email.");
    const closesOn = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await container.db.update(roles).set({ applicationsCloseOn: closesOn }).where(eq(roles.id, roleId));
    try {
      const closing = await page(`/careers/${slug}/jobs/${roleId}`);
      expect(closing.slice(closing.indexOf('<div class="apply-panel">'))).toMatch(/^<div class="apply-panel"><div class="card apply-card"><p class="apply-by"><svg class="icon"[^>]*>.*?<\/svg>Apply by [^<]+<\/p><a class="btn go" /);
    } finally {
      await container.db.update(roles).set({ applicationsCloseOn: null }).where(eq(roles.id, roleId));
    }
    expect(CSS).toContain(".apply-card .apply-by { margin-bottom: 14px;");
    // the AI and pay notices come first in reading order, in readable notice boxes
    const notices = [...html.matchAll(/<(p|div) class="notice">/g)].map((m) => m.index ?? 0);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    for (const at of notices) expect(at).toBeLessThan(panel);
    // the AI notice is one plain line on the first view, with its full text, word for word, under "How AI is used"
    expect(html).toContain(`<div class="notice"><p>${AI_NOTICE_LINE}</p><details class="more"><summary>How AI is used</summary><p>This employer uses software that includes artificial intelligence`);
    // "What to expect": four short steps, shown once, with nothing folded away
    expect(html).toMatch(/<h2>What to expect<\/h2><ol class="steps"><li>Send a short form, about \d+ minutes\. We confirm by email\.<\/li>(?:<li>[^<]+<\/li>){3}<\/ol><div class="notice">/);
    expect(html).not.toContain("More about each step");
    // the stylesheet holds the panel beside the description on a wide screen and at the bottom of a phone's screen
    expect(CSS).toMatch(/\.apply-panel \{ position: sticky; top: 24px;/);
    expect(CSS).toMatch(/@media \(max-width: 899px\) \{[^@]*\.apply-panel \{ top: auto; bottom: 12px; \}/);
    expect(CSS).toMatch(/html:has\(\.apply-panel\) \{ scroll-padding-bottom: \d+px; \}/); // a focused link is never hidden under the panel
    // the four points ride in the panel on a wide screen and move into the page on a phone, where the bar shows only the button
    expect(html.slice(panel)).toContain('<ul class="points">');
    expect(html.slice(0, panel)).toContain('<div class="card points-card"><ul class="points">');
    expect(CSS).toMatch(/\.points-card \{ display: none; \}/);
    expect(CSS).toMatch(/@media \(max-width: 899px\) \{[^@]*\.points-card \{ display: block;/);
    expect(CSS).toMatch(/@media \(max-width: 899px\) \{[^@]*\.apply-card > p, \.apply-card > \.points \{ display: none; \}/);
  });

  it("a job not taking applications says so in a caution note and has no apply panel", async () => {
    await container.db.update(roles).set({ acceptingApplications: false, applicationsClosedAt: new Date().toISOString() }).where(eq(roles.id, roleId));
    try {
      const html = await page(`/careers/${slug}/jobs/${roleId}`);
      expect(html).toContain('<div class="alert caution" role="status">This position is not taking new applications right now.</div>');
      expect(html).toContain('<div class="job-layout solo">');
      expect(html).not.toContain('<div class="apply-panel">');
      expect(html).not.toContain(">Apply now<");
    } finally {
      await container.db.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null }).where(eq(roles.id, roleId));
    }
  });

  it("the form keeps the job's facts above it, under a back link, and the lead names the employer", async () => {
    const html = await page(`/careers/${slug}/jobs/${roleId}/apply`);
    const head = html.slice(0, html.indexOf("<form"));
    expect(head).toMatch(/<p class="back"><a href="\/careers\/[^"]+\/jobs\/[^"]+"><svg class="icon"[^>]*>.*?<\/svg>Back to the job<\/a><\/p>/);
    // no eyebrow above the title: the title follows the back link, and the lead names the employer
    expect(head).not.toContain('<p class="eyebrow">');
    expect(head).toMatch(/Back to the job<\/a><\/p><h1>Apply: /);
    expect(head).toContain('<p class="lead">A short form for Look Dental, about 3 minutes. No cover letter needed.</p>');
    expect(head).toContain('<ul class="facts">');
    expect(html).toContain('<button class="btn" type="submit">Send my application</button>');
    // no steps header over the form, and nothing styled for one
    expect(html).not.toMatch(/class="journey|\.journey/);
  });

  it("the receipt keeps the link back to the job above its title, without the company's name after it", async () => {
    const html = await page(`/careers/${slug}/jobs/${roleId}/applied`);
    // a trail with a parent link stays; the company is named in the page's own lines
    expect(html).toMatch(/<p class="eyebrow"><a href="\/careers\/[^"]+\/jobs\/[^"]+">[^<]+<\/a><\/p><h1>Thanks, we have your application<\/h1>/);
    expect(html).not.toContain("</a> · Look Dental");
    expect(html).toContain("<li>The hiring team at Look Dental reviews your application.</li>");
  });

  it("the status page: withdrawing is an outlined secondary button; the AI interview's link is the one plum button", async () => {
    const html = await page(`/c/status/${statusToken}`);
    // the employer's name sits above the job's title: on a phone the next mention of the employer is far below the first
    // screen (an eyebrow only where nothing else near the top names them), with no "Your application"
    expect(html.slice(html.indexOf("<main>")).startsWith('<main><p class="eyebrow">Look Dental</p><h1>')).toBe(true);
    expect(html).toContain('<p class="meta">People on the hiring team at Look Dental make every decision about your application.</p>');
    expect(html).not.toContain("· Your application");
    expect(html).toContain('<button class="btn secondary" type="submit">Withdraw my application</button>');
    expect(html).toContain('<button class="btn secondary" type="submit">Send request</button>');
    // one name for the chat on this page: the button says what the steps say
    expect(html).toMatch(/<a class="btn" href="\/c\/screen\/[^"]+">(Start|Continue) your AI interview<\/a>/);
    expect(html).toMatch(/<span>Status<\/span><strong>AI interview<\/strong>/);
    // the page leads with the steps, then the line and the one thing to do now; withdrawing and the privacy requests are
    // one click away, closed until opened
    const main = html.slice(html.indexOf("<main>"));
    expect(main.slice(main.indexOf("</h1>") + "</h1>".length).startsWith('<ol class="track" aria-label="Where your application is">')).toBe(true);
    // a circle per step joined by a line: Received and Under review are behind her, ticked and said to be done; the AI
    // interview is where she is, and it is the last step: no decision is hinted at before she is told one
    expect(main).toMatch(/<ol class="track" aria-label="Where your application is"><li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>Received<\/span><span class="sr-only"> \(done\)<\/span><\/li><li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>Under review<\/span><span class="sr-only"> \(done\)<\/span><\/li><li class="current" aria-current="step"><span class="dot" aria-hidden="true"><\/span><span>AI interview<\/span><\/li><\/ol>/);
    expect(main.indexOf('<ol class="track"')).toBeLessThan(main.indexOf("<h2>What happens next</h2>"));
    expect(main.indexOf("<h2>What happens next</h2>")).toBeLessThan(main.indexOf('<a class="btn" href="/c/screen/'));
    expect(main.indexOf('<a class="btn" href="/c/screen/')).toBeLessThan(main.indexOf('<div class="card status">'));
    expect(html).toMatch(/<details class="more"><summary>No longer interested\?<\/summary><form method="post" action="\/c\/status\/[^"]+\/withdraw" class="card">/);
    expect(html).toMatch(/<details class="more"><summary>Ask for a copy, a fix, deletion, or a person&#39;s review<\/summary>/);
    expect(html).toContain('<option value="human_review">Have a person review my application</option>');
    expect(html).toContain('<details class="more"><summary>How AI is used</summary><p class="meta">An AI assistant reads applications');
    // a person is reached by the address the job page prints, never by a reply keyword; and no score is ever on this page
    expect(html).toMatch(/<p>To reach a person, email <a href="mailto:([^"]+)">\1<\/a>, or make a request below\.<\/p>/);
    expect(html).not.toMatch(/HUMAN|\d{1,3}\s?\/\s?100|match score|<progress/);
    // a send without the confirmation box comes back with the withdraw choice open
    expect(await page(`/c/status/${statusToken}?confirm=withdraw`)).toContain('<details class="more" open=""><summary>No longer interested?</summary>');
    // the page's own styles, with no style attribute and no script
    expect(html).not.toMatch(/ style="/);
    expect(html).not.toContain("<script");
  });

  it("the AI interview's page carries its own styles in the head with the request's nonce; its introduction says first that it is the company's AI assistant, with Start as the one plum button and a person as the outlined one", async () => {
    const r = await app.request(`/c/screen/${screenToken}`);
    const nonce = (r.headers.get("content-security-policy-report-only") ?? "").match(/'nonce-([^']+)'/)![1];
    const html = await r.text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.split(`<style nonce="${nonce}">`).length - 1).toBe(2);
    expect(head).toContain(".msg.candidate { align-self: flex-end; background: var(--peach); color: var(--ink);");
    expect(html.slice(html.indexOf("</head>"))).not.toContain("<style");
    // the AI line is the first thing in the page, before the company's name and the heading
    const main = html.slice(html.indexOf("<main>"));
    expect(main.indexOf('<p class="ai-line"><span class="ai-tag">AI assistant</span>')).toBe("<main>".length);
    expect(main).toContain("This conversation is with Look Dental&#39;s AI assistant, a software program, not a person.");
    expect(html).toContain(`<form method="post" action="/c/screen/${screenToken}/start"><button class="btn" type="submit">Start</button></form>`);
    expect(html).toContain(`<a class="btn secondary" href="/c/screen/${screenToken}/person">I&#39;d rather talk to a person</a>`);
    // two ways on from this page, and no third
    expect(main.slice(main.indexOf('<div class="actions">'), main.indexOf("</div>", main.indexOf('<div class="actions">'))).match(/class="btn/g)).toHaveLength(2);
    expect(html).not.toMatch(/Do this later|\/later"/);
  });

  it("a question page: the chat in one thread with the question to answer as its latest message, how far along it is in one line, the quiet skip and the person always there, and no inline style", async () => {
    expect((await app.request(`/c/screen/${screenToken}/start`, { method: "POST" })).status).toBe(302);
    const html = await page(`/c/screen/${screenToken}`);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    // the chat's title, how far along it is, the thread, the latest message the one to answer
    expect(html).toMatch(/<h1 class="chat-title">Your chat about the [^<]+ role<\/h1><p class="meta">Question 1 of \d+<\/p>/);
    expect(html).not.toMatch(/\brequired ·|Required questions|Wrapping up/);
    expect(html).toMatch(/<li class="msg assistant now" id="question">[\s\S]+?<\/li>/);
    expect(html).toContain('<button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Skip this question</button>');
    expect(html).toContain(`<a class="link-action" href="/c/screen/${screenToken}/person">I&#39;d rather talk to a person</a>`);
    expect(html).not.toMatch(/ style="/);
    // no steps header and no progress bar: neither is drawn, and neither is styled
    expect(html).not.toMatch(/class="journey|\.journey|<progress/);
    expect(SCREEN_CSS).not.toMatch(/\.progress|\.journey/);
    // the choice page: one heading, and one outlined button that tells the hiring team
    const choice = await page(`/c/screen/${screenToken}/person`);
    expect(choice.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(choice.match(/<button class="btn secondary" type="submit">/g)).toHaveLength(1);
    expect(choice).toContain('<button class="btn secondary" type="submit">Tell the hiring team</button>');
    expect(choice).not.toMatch(/<button class="btn" type="submit">/);
  });
});
