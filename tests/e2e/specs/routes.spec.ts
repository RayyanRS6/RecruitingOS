import { expect, test, type Page } from "@playwright/test";
import { ADMIN, PERSONAS, applyThroughTheForm, createCompanyThroughTheForm, expectAccessible, gotoSettled, noSidewaysScroll, publishedJobThroughTheApi, signIn, skipWithoutFakeSignIn, statusPathFromEmail, type Applicant } from "./helpers";

/**
 * Route inventory: every page of the app is visited signed out (sent to sign in), signed in as the wrong role (sent
 * where that person belongs) and as the right one (it renders, passes axe, and never scrolls sideways on this
 * viewport), and the address of a page that is gone leads to the nearest page that exists. Runs on a desk and on a
 * phone.
 */
const run = Date.now().toString(36);

/** No table scrolls sideways inside its own box on a desk (on a phone a table may; the page may not). */
async function noTableOverflow(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 0) < 1280) return;
  const wide = await page.evaluate(() => [...document.querySelectorAll(".table-wrap")].filter((t) => t.scrollWidth > t.clientWidth + 1).length);
  expect(wide, `${name}: a table scrolls sideways`).toBe(0);
}

/** The frame's links sit in the side rail from 900px, and behind the Menu button under it. */
const sideRail = (page: Page) => (page.viewportSize()?.width ?? 0) > 900;

test.describe("route inventory", () => {
  test("every application page and every candidate page answers with one content-security policy and a nonce", async ({ page, baseURL }) => {
    // Report-only by default, blocking with CSP_MODE=enforce (a deployed address may run either): one of the two headers, never both.
    const policyOf = (headers: Record<string, string>, path: string) => {
      expect([headers["content-security-policy"], headers["content-security-policy-report-only"]].filter(Boolean), `${path} sends exactly one policy header`).toHaveLength(1);
      return headers["content-security-policy"] ?? headers["content-security-policy-report-only"];
    };
    // "/" signed out is the middleware's redirect to /welcome, which must carry the policy too; /welcome is the public page itself
    for (const path of ["/login", "/", "/welcome"]) {
      const r = await page.request.get(`${baseURL}${path}`, { maxRedirects: 0 });
      const csp = policyOf(r.headers(), path);
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      expect(csp).toContain("frame-ancestors 'none'");
      // no other site may frame a page, whatever the policy's mode (apps/shell/next.config.ts)
      expect(r.headers()["x-frame-options"], path).toBe("DENY");
    }
    const privacy = await page.request.get(`${baseURL}/privacy`);
    expect(policyOf(privacy.headers(), "/privacy")).toContain("default-src 'none'");
    // a path mounted on the API keeps the API's own headers: the shell's configuration replaces none of them
    expect(privacy.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(privacy.headers()["referrer-policy"]).toBe("no-referrer");
    // the shell's own scripts carry the nonce the header names
    const login = await page.request.get(`${baseURL}/login`, { maxRedirects: 0 });
    expect(login.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const nonce = policyOf(login.headers(), "/login").match(/'nonce-([^']+)'/)![1];
    const html = await login.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) if (!/type="application\/(ld\+)?json"/.test(attrs)) expect(attrs, `<script${attrs}>`).toContain(`nonce="${nonce}"`);
    // the addresses of removed endpoints are served by nobody
    for (const gone of ["/a/abcdefghijkl", "/feeds/jobs.xml"]) expect((await page.request.get(`${baseURL}${gone}`, { maxRedirects: 0 })).status(), gone).toBe(404);
  });

  test("signed out, every private page sends the person to sign in, and the welcome page has one way in", async ({ page }) => {
    for (const path of ["/roles", "/roles/new", "/talent", "/setup", "/updates", "/setup/company", "/admin", "/admin/privacy", "/admin/system", "/people", "/interviews", "/admin/customers", "/admin/problems"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
    }
    // Home's address shows the public welcome page instead, and so does an old address that led Home
    await page.goto("/recruiter/queue");
    await expect(page).toHaveURL(/\/welcome$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hiring, made more manageable.");
    await expectAccessible(page, "welcome");
    await noSidewaysScroll(page, "welcome");
    // every way in says the same, and nobody is told to wait for an invitation
    const waysIn = page.getByRole("link", { name: "Get started" });
    expect(await waysIn.count()).toBeGreaterThan(1);
    for (const link of await waysIn.all()) await expect(link).toHaveAttribute("href", "/login");
    await expect(page.getByText(/invitation/i)).toHaveCount(0);
    await page.getByRole("link", { name: "Sign in", exact: true }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("link", { name: /^Continue with / }).first()).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "sign-in");
    await noSidewaysScroll(page, "sign-in");
  });

  test("an owner sees every company page and every candidate page; the admin dashboard sends them home; old addresses lead to the nearest page", async ({ page, browser, baseURL }, info) => {
    skipWithoutFakeSignIn();
    test.setTimeout(480_000);
    const base = baseURL!;
    const tag = `${run}${info.project.name}`;
    await signIn(page, { email: `owner+${tag}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline ${tag}`);
    const job = await publishedJobThroughTheApi(page.request, base);
    const luis: Applicant = { first: "Luis", last: "Ortega", email: `luis.ortega+${tag}@example.com`, resume: PERSONAS.strong.resume };
    const applied = await applyThroughTheForm(browser, base, job.jobUrl, luis);
    await applied.context.close();
    const statusPath = await statusPathFromEmail(page.request, base, luis.email);
    const { rows } = (await (await page.request.get(`${base}/api/v1/roles/${job.roleId}/applications?tab=new`)).json()) as { rows: Array<{ id: string }> };
    expect(rows).toHaveLength(1);

    // every company page, as the right role: its heading, the frame, axe, and no sideways scrolling
    const rail = page.getByRole("navigation", { name: "Main" });
    const pages: Array<[string, RegExp | string]> = [
      ["/", /Good (morning|afternoon|evening)/],
      ["/roles", "Jobs"],
      ["/roles/new", "Who are you hiring?"],
      [`/roles/${job.roleId}`, job.title],
      [`/roles/${job.roleId}?tab=share`, job.title],
      [`/roles/${job.roleId}/talent`, job.title],
      [`/roles/${job.roleId}/talent?tab=not_selected`, job.title],
      ["/talent", "Candidates"],
      ["/setup", "Settings"],
      ["/updates", "Updates"],
    ];
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(heading, { timeout: 30_000 });
      // Start a hire and Sign out stay reachable in the phone's top bar too
      await expect(rail.getByRole("link", { name: "Start a hire" })).toBeVisible();
      await expect(rail.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expectAccessible(page, path);
      await noSidewaysScroll(page, path);
    }
    // the candidate panel has an address of its own
    await page.goto(`/roles/${job.roleId}/talent?open=${rows[0].id}`);
    await expect(page.getByRole("dialog", { name: "Luis Ortega" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the candidate panel");
    await noSidewaysScroll(page, "the candidate panel");

    // the rail: a company's four places and nothing else; on a phone they open from the Menu button
    await page.goto("/roles");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jobs", { timeout: 30_000 });
    if (!sideRail(page)) {
      await rail.getByRole("button", { name: "Menu" }).click();
      await expectAccessible(page, "the phone menu, open");
    }
    for (const place of ["Home", "Jobs", "Candidates", "Settings"]) await expect(rail.getByRole("link", { name: place, exact: true })).toBeVisible();
    for (const gone of ["Interviews", "People", "Companies", "System"]) await expect(rail.getByRole("link", { name: gone, exact: true })).toHaveCount(0);
    await expect(rail.getByRole("link", { name: /^Updates/ })).toBeVisible();

    // as the wrong role: the admin dashboard sends an owner home
    for (const path of ["/admin", "/admin/privacy", "/admin/system"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/$/, { timeout: 30_000 });
    }
    // the addresses of pages that are gone lead to the nearest page that exists
    const moved: Array<[string, RegExp]> = [
      ["/people", /\/talent$/],
      ["/interviews", /\/talent$/],
      ["/interviews/00000000-0000-4000-8000-000000000000", /\/talent$/],
      [`/roles/${job.roleId}/people`, new RegExp(`/roles/${job.roleId}/talent$`)],
      ["/recruiter/queue", /\/$/],
      ["/admin/customers", /\/$/],
      ["/admin/problems", /\/$/],
    ];
    for (const [from, to] of moved) {
      await page.goto(from);
      await expect(page, from).toHaveURL(to, { timeout: 30_000 });
    }
    // signed in with a company: no second sign-in form, and no second company form
    for (const path of ["/login", "/setup/company"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/$/, { timeout: 30_000 });
    }
    await page.goto("/nothing-here");
    await expect(page.getByRole("heading", { name: "That page does not exist" })).toBeVisible();
    await expectAccessible(page, "not found");

    // the candidate's pages on this viewport too
    const candidatePages: Array<[string, string]> = [
      [`/careers/${job.slug}`, "the careers page"],
      [`/careers/${job.slug}/jobs/${job.roleId}`, "the job page"],
      [`/careers/${job.slug}/jobs/${job.roleId}/apply`, "the application form"],
      [statusPath, "the status page"],
      ["/c/link-request", "Lost your link?"],
      ["/c/privacy-request", "the privacy request form"],
      ["/privacy", "the privacy notice"],
    ];
    for (const [path, name] of candidatePages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await expectAccessible(page, name);
      await noSidewaysScroll(page, name);
    }
  });

  test("a platform administrator lands on the admin dashboard, every section passes accessibility, and the company pages send them back", async ({ page }) => {
    skipWithoutFakeSignIn();
    test.setTimeout(300_000);
    await signIn(page, ADMIN);
    // sign-in lands on Companies, with the requests first
    await expect(page).toHaveURL(/\/admin$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Companies" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Main" });
    // no company to hire for: the rail holds the dashboard's three places only
    await expect(rail.getByRole("link", { name: "Start a hire" })).toHaveCount(0);
    const sections: Array<[string, string, string[]]> = [
      ["Companies", "/admin", []],
      ["Privacy requests", "/admin/privacy", ["Open", "Closed"]],
      ["System", "/admin/system", ["Health", "Costs", "Email", "Security reports", "Administrators"]],
    ];
    for (const [label, path, parts] of sections) {
      // on a phone the sections sit behind the Menu button, which closes once a link is followed
      if (!sideRail(page)) {
        const menu = rail.getByRole("button", { name: "Menu" });
        if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
      }
      await rail.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`), { timeout: 30_000 });
      await expect(rail.getByRole("link", { name: label, exact: true, includeHidden: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible({ timeout: 30_000 });
      await expectAccessible(page, `admin: ${label}`);
      await noSidewaysScroll(page, `admin: ${label}`);
      await noTableOverflow(page, `admin: ${label}`);
      for (const part of parts) {
        const tab = page.getByRole("tab", { name: new RegExp(`^${part}\\b`) });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expectAccessible(page, `admin: ${label}, ${part}`);
        await noSidewaysScroll(page, `admin: ${label}, ${part}`);
        await noTableOverflow(page, `admin: ${label}, ${part}`);
      }
    }
    // a part is in the address: a reload lands on it
    await expect(page).toHaveURL(/\/admin\/system\?view=admins$/);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Administrators\b/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    // the addresses of the old console lead to the dashboard, a company's own link included
    await gotoSettled(page, "/admin/customers?open=00000000-0000-4000-8000-000000000000");
    await expect(page).toHaveURL(/\/admin\?open=00000000-0000-4000-8000-000000000000$/, { timeout: 30_000 });
    await gotoSettled(page, "/admin/problems");
    await expect(page).toHaveURL(/\/admin\/system$/, { timeout: 30_000 });
    // as the wrong role: an administrator has no company, so a company's pages send them back to the dashboard
    for (const path of ["/", "/roles", "/roles/new", "/talent", "/setup", "/updates"]) {
      await gotoSettled(page, path);
      await expect(page, path).toHaveURL(/\/admin$/, { timeout: 30_000 });
    }
  });
});
