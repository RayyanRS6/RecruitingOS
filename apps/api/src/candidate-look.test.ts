import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCandidateCsp, entitlements } from "@ros/core";
import { applications, interviews, roles, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { SCREEN_CSS, STATUS_CSS } from "./pages/candidate";
import { CANDIDATE_FONTS, FONT_DIR, FONT_LOCK_FILE, type FontLock, fontLicenceFile } from "./pages/fonts";
import { AI_NOTICE_LINE } from "./pages/job-page";
import { CSS } from "./pages/layout";
import { statusTokenFor, useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave DS, candidate pages: the server-rendered pages wear the application's look (docs/07). The token values are the
 * ones in packages/ui/src/tokens.css in both themes, the fonts come from this deployment's own origin so the policy
 * keeps `font-src 'self'`, secondary buttons are styled on every page (not only the screening page), and the job page
 * shows its facts as pills and one Apply button that stays reachable on a phone.
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const uiCss = stripComments(readFileSync(new URL("../../../packages/ui/src/tokens.css", import.meta.url), "utf8"));
const pageCss = stripComments(CSS);

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
    expect(pageLight.size).toBeGreaterThan(20);
    for (const [name, value] of pageLight) expect(value, `${name} (light)`).toBe(uiLight.get(name));
    for (const [name, value] of pageDark) expect(value, `${name} (dark)`).toBe(uiDark.get(name));
    // every token the page copies that turns in the dark theme turns on the page too
    for (const name of pageLight.keys()) if (uiDark.has(name)) expect(pageDark.get(name), `${name} has no dark value on the page`).toBe(uiDark.get(name));
  });

  it("uses only tokens it declares, and no colour outside the token blocks", () => {
    const used = new Set([...`${CSS}${SCREEN_CSS}${STATUS_CSS}`.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(pageLight.has(name), `${name} is used but not declared`).toBe(true);
    const outside = `${pageCss.slice(0, pageCss.indexOf(":root {"))}${pageCss.slice(pageCss.indexOf("* {"))}${stripComments(SCREEN_CSS)}${stripComments(STATUS_CSS)}`;
    expect(outside).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // the near-black primary button and the outlined secondary one, on every page (the screening page used to be the only one with a secondary look)
    expect(pageCss).toMatch(/\.btn \{[^}]*background: var\(--primary\); color: var\(--on-primary\);/);
    expect(pageCss).toMatch(/\.btn\.secondary \{ background: var\(--surface\); border-color: var\(--line-2\); color: var\(--ink\); \}/);
    expect(SCREEN_CSS).not.toContain(".btn");
    expect(STATUS_CSS).not.toContain(".btn");
    // the status page's messages and the screening conversation are one look: the candidate's own on the right in near-black (plan G7)
    for (const css of [SCREEN_CSS, STATUS_CSS]) expect(css).toContain(".msg.candidate { align-self: flex-end; background: var(--ink); color: var(--ground);");
    expect(STATUS_CSS).toContain(".msg.assistant, .msg.team { align-self: flex-start; background: var(--ground);");
    // the progress line (Wave S2, K4): down the page on a phone, across it from 600 pixels; the tick on the ink fill; no motion
    expect(STATUS_CSS).toContain(".track li.done .dot { border-color: var(--ink); background: var(--ink); color: var(--ground); }");
    expect(STATUS_CSS).toMatch(/@media \(min-width: 600px\) \{[^@]*\.track \{ grid-auto-flow: column;/);
    expect(stripComments(STATUS_CSS)).not.toMatch(/transition|animation/);
    expect(pageCss).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }");
  });

  it("declares IBM Plex Sans and Bricolage Grotesque from this deployment's own /fonts/ folder, and the policy still names no outside host", () => {
    for (const [family, weight] of [["IBM Plex Sans", 400], ["IBM Plex Sans", 600], ["Bricolage Grotesque", 700]] as const) {
      const faces = [...CSS.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]).filter((f) => f.includes(`font-family: "${family}"`) && f.includes(`font-weight: ${weight};`));
      expect(faces, `${family} ${weight}`).toHaveLength(2); // the latin file and the latin-ext file
      for (const f of faces) {
        expect(f).toContain("font-display: swap");
        expect(f).toMatch(new RegExp(`url\\("${FONT_DIR}/[a-z-]+-latin(-ext)?-${weight}-normal\\.woff2"\\) format\\("woff2"\\)`));
        expect(f).toContain("unicode-range: U+");
      }
    }
    // nothing on a candidate page loads from another origin, so font-src 'self' covers the fonts
    expect(`${CSS}${SCREEN_CSS}`).not.toMatch(/https?:|url\((?!"\/fonts\/)/);
    const csp = buildCandidateCsp({ nonce: "n", production: true, reportPath: "/api/csp-report" });
    expect(csp).toContain("font-src 'self';");
    expect(csp).not.toMatch(/https?:\/\//);
    // only the weights that have a file: no faux bold
    const weights = [...pageCss.matchAll(/font-weight: (\d+)|font: (\d+) /g)].map((m) => Number(m[1] ?? m[2]));
    for (const w of weights) expect([400, 600, 700], `font weight ${w}`).toContain(w);
    // Fontsource's file names, one file per face and subset, so scripts/fetch-fonts.ts can copy them one for one
    expect(new Set(CANDIDATE_FONTS.map((f) => f.file)).size).toBe(CANDIDATE_FONTS.length);
    for (const f of CANDIDATE_FONTS) expect(f.file).toBe(`${f.slug}-${f.subset}-${f.weight}-normal.woff2`);
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
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SMS_ENABLED: "false" };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return r.text();
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@look.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Look Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    await entitlements.applyPlan(container.db, co.id, "growth");
    // A pilot company: the screening conversation follows the form in the same visit (plan E1).
    await useOneVisitApplyFlow(container, co.id);
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", "Ivy"); fd.set("lastName", "Chen"); fd.set("email", "ivy.chen@example.com"); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File(["Ivy Chen, RDH"], "ivy.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    statusToken = await statusTokenFor(container, { roleId, email: "ivy.chen@example.com" });
    await container.drain();
    const [appRow] = await container.db.select().from(applications).where(eq(applications.statusToken, statusToken));
    await json(owner, "POST", `/api/v1/applications/${appRow.id}/actions`, { action: "invite_screen", channel: "web" });
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
    // the only script is the structured data on the job page and the résumé upload on the form: everything works without it
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

  it("the scheduling pages too: picking a time, the confirmed page with its cancel choice, and the page after cancelling", async () => {
    expect((await json(owner, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; interviews: { plan: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", "Leo"); fd.set("lastName", "Park"); fd.set("email", "leo.park@example.com"); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File(["Leo Park, RDH"], "leo.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const [leo] = await container.db.select().from(applications).where(eq(applications.statusToken, await statusTokenFor(container, { roleId, email: "leo.park@example.com" })));
    const me = (await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } };
    const approved = await json(owner, "POST", `/api/v1/applications/${leo.id}/interviews`, { roundKey: role.currentPacket.packet.interviews.plan[0].key, interviewerUserIds: [me.user.id], linkSource: "calendar" });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const [iv] = await container.db.select().from(interviews).where(eq(interviews.applicationId, leo.id));
    expect(iv.scheduleToken).toBeTruthy();
    const pick = await looksRight(`/c/schedule/${iv.scheduleToken}`);
    const slotId = pick.match(/name="slotId" value="([^"]+)"/)![1];
    // picking a time is the page's one job; asking for other times is one click away (founder brief, 14 October 2026)
    expect(pick).toMatch(/<details class="more"><summary>None of these work\?<\/summary><form method="post" action="\/c\/schedule\/[^"]+\/none-work" class="card">/);
    // the zone shown is named in the line under the heading; another zone is one click away, still a plain GET form
    expect(pick).toMatch(/Times are shown in <strong>[^<]+<\/strong>\.<\/p><details class="more"><summary>Change the time zone<\/summary>/);
    expect(pick).toMatch(/<details class="more"><summary>Change the time zone<\/summary><form method="get" action="\/c\/schedule\/[^"]+" class="card"><label for="tz" class="flush">Show times in<\/label><select id="tz" name="tz">/);
    expect(pick.indexOf("<summary>Change the time zone</summary>")).toBeLessThan(pick.indexOf("<legend>Available times</legend>"));
    const form =(fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    expect((await app.request(`/c/schedule/${iv.scheduleToken}`, form({ slotId, timezone: "America/Los_Angeles" }))).status).toBe(302);
    await container.drain();
    const confirmed = await looksRight(`/c/schedule/${iv.scheduleToken}/confirmed`);
    // the choice is a group of real radio buttons with a legend, in the page's own styles, one click away under "I need to cancel"
    expect(confirmed).toMatch(/<details class="more"><summary>I need to cancel<\/summary><form method="post" action="\/c\/schedule\/[^"]+\/cancel" class="card" id="cancel">/);
    expect(confirmed).toContain('<legend class="question-legend">If you cancel, what would you like next?</legend>');
    expect(confirmed.match(/<label class="check slot" for="next-[a-z-]+"><input type="radio"/g)).toHaveLength(2);
    expect(confirmed).not.toMatch(/ style="/);
    expect((await app.request(`/c/schedule/${iv.scheduleToken}/cancel`, form({ confirm: "yes", next: "new_times" }))).status).toBe(302);
    await container.drain();
    const after = await looksRight(`/c/schedule/${iv.scheduleToken}/cancelled`);
    expect(after).toContain('<p class="notice">Reply to any of our emails with HUMAN to reach a person.</p>');
    expect(after).not.toContain("<script");
  });

  it("the careers page lists each role as a card with an outlined button that names the role for a screen reader", async () => {
    const html = await page(`/careers/${slug}`);
    expect(html).toContain('<ul class="roles"><li class="card role">');
    expect(html).toMatch(/<a class="btn secondary" href="\/careers\/[^"]+\/jobs\/[^"]+">View and apply<span class="sr-only">: [^<]+<\/span><svg class="icon"/);
  });

  it("the job page: the company beside its initials, the facts as pills with icons and spoken names, an Apply button at the top and one in the panel that stays on a phone's screen, the notices before the panel", async () => {
    const html = await page(`/careers/${slug}/jobs/${roleId}`);
    expect(html).toContain('<main class="wide">');
    expect(html).toMatch(/<p class="eyebrow"><a href="\/careers\/[^"]+">Careers at Look Dental<\/a><\/p>/);
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
    expect(html).toMatch(/<a class="btn go head-apply" href="\/careers\/[^"]+\/apply"><span class="go-fill" aria-hidden="true"><\/span><span class="go-icon"><svg class="icon"[^>]*>.*?<\/svg><\/span><span class="go-text">Apply now<\/span><\/a>/);
    expect(CSS).toMatch(/@media \(max-width: 899px\) \{[^@]*\.head-apply \{ display: none; \}/);
    const panel = html.indexOf('<div class="apply-panel">');
    expect(panel).toBeGreaterThan(0);
    // Apply now (founder decision Q2 = A): the circle and arrow, the fill hidden from screen readers, the words its only name; in the panel too
    expect(html.slice(panel)).toMatch(/<a class="btn go" href="\/careers\/[^"]+\/apply"><span class="go-fill" aria-hidden="true"><\/span><span class="go-icon"><svg class="icon"[^>]*>.*?<\/svg><\/span><span class="go-text">Apply now<\/span><\/a>/);
    // each one's accessible name is exactly "Apply now": take away what screen readers skip and only the words are left
    const goLinks = [...html.matchAll(/<a class="btn go[^"]*" href="[^"]+">(.*?)<\/a>/g)].map((m) => m[1]);
    expect(goLinks).toHaveLength(2);
    for (const inner of goLinks) expect(inner.replace(/<(span|svg)\b[^>]*aria-hidden="true"[^>]*>.*?<\/\1>/g, "").replace(/<[^>]+>/g, "")).toBe("Apply now");
    // the fill moves by transform alone, in 200ms, on a mouse's hover or a keyboard's focus; a tap never turns it near-black
    expect(CSS).toMatch(/\.go-fill \{[^}]*transform: translateX\(calc\(-100% - 4px\)\); \}/);
    expect(CSS).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{[^@]*\.btn\.go:hover \.go-fill \{ transform: none; \}/);
    expect(CSS).toContain(".btn.go:focus-visible .go-fill, .btn.go:active .go-fill { transform: none; }");
    expect(CSS).toContain("@media (prefers-reduced-motion: no-preference) { .go-fill, .go-icon .icon { transition: transform 200ms ease-out; } }");
    // its edge is the field-border grey, so the pill shows on the open ground too; a tap on a phone never fills a button
    expect(CSS).toMatch(/\.btn\.go \{[^}]*border-color: var\(--line-strong\);/);
    expect(CSS).toContain("@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); } }");
    expect(CSS).not.toMatch(/backdrop-filter|filter:\s*blur|transition:[^;]*width/);
    expect(html.lastIndexOf(">Apply now<")).toBeGreaterThan(panel);
    // the AI and pay notices come first in reading order, in readable notice boxes
    const notices = [...html.matchAll(/<(p|div) class="notice">/g)].map((m) => m.index ?? 0);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    for (const at of notices) expect(at).toBeLessThan(panel);
    // the AI notice is one plain line on the first view, with its full text, word for word, under "How AI is used" (founder brief, 14 October 2026)
    expect(html).toContain(`<div class="notice"><p>${AI_NOTICE_LINE}</p><details class="more"><summary>How AI is used</summary><p>This employer uses software that includes artificial intelligence`);
    // "What to expect" at a glance: at most four lines, every step in full one click away
    const glance = html.slice(html.indexOf("<h2>What to expect</h2>"), html.indexOf('<details class="more"><summary>More about each step</summary>'));
    expect(glance.match(/<li>/g)?.length).toBeLessThanOrEqual(4);
    expect(html).toMatch(/<details class="more"><summary>More about each step<\/summary><ol class="steps"><li>Apply in about \d+ minutes/);
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

  it("the form keeps the job's facts above it, under a back link and the employer's name", async () => {
    const html = await page(`/careers/${slug}/jobs/${roleId}/apply`);
    const head = html.slice(0, html.indexOf("<form"));
    expect(head).toMatch(/<p class="back"><a href="\/careers\/[^"]+\/jobs\/[^"]+"><svg class="icon"[^>]*>.*?<\/svg>Back to the job<\/a><\/p>/);
    expect(head).toContain('<p class="eyebrow">Look Dental</p>');
    expect(head).toContain('<ul class="facts">');
    expect(html).toContain('<button class="btn" type="submit">Send my application</button>');
  });

  it("the status page: withdrawing and the future-roles choice are outlined secondary buttons; the screening link is the one near-black button", async () => {
    const html = await page(`/c/status/${statusToken}`);
    expect(html).toContain('<p class="eyebrow">Look Dental · Your application</p>');
    expect(html).toContain('<button class="btn secondary" type="submit">Withdraw my application</button>');
    expect(html).toContain('<button class="btn secondary" type="submit">Don&#39;t keep me for future roles</button>');
    expect(html).toContain('<button class="btn secondary" type="submit">Send request</button>');
    // one name for the chat on this page: the button says what the progress line says
    expect(html).toMatch(/<a class="btn" href="\/c\/screen\/[^"]+">(Start|Continue) the screening chat<\/a>/);
    expect(html).toMatch(/<span>Status<\/span><strong>Screening chat<\/strong>/);
    // the page leads with the progress line (Wave S2, K4), then the line and the one thing to do now; withdrawing and the
    // privacy requests are one click away, closed until opened (founder brief, 14 October 2026)
    const main = html.slice(html.indexOf("<main>"));
    expect(main.slice(main.indexOf("</h1>") + "</h1>".length).startsWith('<ol class="track" aria-label="Where your application is">')).toBe(true);
    // a circle per step joined by a line: Applied is behind her, ticked and said to be done; the screening chat is where she is
    expect(main).toMatch(/<ol class="track" aria-label="Where your application is"><li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>Applied<\/span><span class="sr-only"> \(done\)<\/span><\/li><li class="current" aria-current="step"><span class="dot" aria-hidden="true"><\/span><span>Screening chat<\/span><\/li><li><span class="dot" aria-hidden="true"><\/span><span>Review<\/span><\/li>/);
    expect(main.indexOf('<ol class="track"')).toBeLessThan(main.indexOf("<h2>What happens next</h2>"));
    expect(main.indexOf("<h2>What happens next</h2>")).toBeLessThan(main.indexOf('<a class="btn" href="/c/screen/'));
    expect(main.indexOf('<a class="btn" href="/c/screen/')).toBeLessThan(main.indexOf('<div class="card status">'));
    expect(html).toMatch(/<details class="more"><summary>No longer interested\?<\/summary><form method="post" action="\/c\/status\/[^"]+\/withdraw" class="card">/);
    expect(html).toMatch(/<details class="more"><summary>Ask for a copy, a fix, deletion, or a person&#39;s review<\/summary>/);
    expect(html).toContain('<option value="human_review">Have a person review my application</option>');
    expect(html).toContain('<details class="more"><summary>How AI is used</summary><p class="meta">An AI assistant reads applications');
    // a send without the confirmation box comes back with the withdraw choice open
    expect(await page(`/c/status/${statusToken}?confirm=withdraw`)).toContain('<details class="more" open=""><summary>No longer interested?</summary>');
    // the messages read as a conversation in the page's own styles, with no style attribute and no script (plan G7)
    expect(html).toContain('<h2 id="messages">Messages about your application</h2>');
    expect(html).toMatch(/<li class="msg team"><p class="msg-head">Look Dental<span aria-hidden="true"> · <\/span>/);
    expect(html).not.toMatch(/ style="/);
    expect(html).not.toContain("<script");
  });

  it("the screening page carries its own styles in the head with the request's nonce; its introduction says first that it is the company's AI assistant, with Start as the one near-black button and the other two outlined", async () => {
    const r = await app.request(`/c/screen/${screenToken}`);
    const nonce = (r.headers.get("content-security-policy-report-only") ?? "").match(/'nonce-([^']+)'/)![1];
    const html = await r.text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.split(`<style nonce="${nonce}">`).length - 1).toBe(2);
    expect(head).toContain(".msg.candidate { align-self: flex-end; background: var(--ink); color: var(--ground);");
    expect(html.slice(html.indexOf("</head>"))).not.toContain("<style");
    // the AI line is the first thing in the page, before the company's name and the heading
    const main = html.slice(html.indexOf("<main>"));
    expect(main.indexOf('<p class="ai-line"><span class="ai-tag">AI assistant</span>')).toBe("<main>".length);
    expect(main).toContain("This conversation is with Look Dental&#39;s AI assistant, a software program, not a person.");
    expect(html).toContain(`<form method="post" action="/c/screen/${screenToken}/start"><button class="btn" type="submit">Start</button></form>`);
    expect(html).toContain(`<form method="post" action="/c/screen/${screenToken}/later"><button class="btn secondary" type="submit">Do this later</button></form>`);
    expect(html).toContain(`<a class="btn secondary" href="/c/screen/${screenToken}/person">I&#39;d rather talk to a person</a>`);
  });

  it("a question page: the question in large type, a thin native progress bar with its words, the quiet skip and the person always there, and no inline style", async () => {
    expect((await app.request(`/c/screen/${screenToken}/start`, { method: "POST" })).status).toBe(302);
    const html = await page(`/c/screen/${screenToken}`);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 class="question" id="question">[^<]+<\/h1>/);
    expect(html).toMatch(/<div class="progress"><label for="progress">Question 1 of (\d+)<\/label><progress id="progress" max="\1" value="1">Question 1 of \1<\/progress><\/div>/);
    expect(html).toContain('<button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Skip this question</button>');
    expect(html).toContain(`<a class="link-action" href="/c/screen/${screenToken}/person">I&#39;d rather talk to a person</a>`);
    expect(html).not.toMatch(/ style="/);
    // the bar's colours come from the tokens, in both themes, without a style attribute
    expect(SCREEN_CSS).toContain(".progress progress::-webkit-progress-value { border-radius: var(--r-pill); background: var(--ink); }");
    expect(SCREEN_CSS).toContain(".progress progress::-moz-progress-bar { border-radius: var(--r-pill); background: var(--ink); }");
    // the choice page: one heading, two equal outlined buttons
    const choice = await page(`/c/screen/${screenToken}/person`);
    expect(choice.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(choice.match(/<button class="btn secondary" type="submit">/g)).toHaveLength(2);
    expect(choice).not.toMatch(/<button class="btn" type="submit">/);
  });
});
