import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Route inventory coverage (docs/spec/16): every final Next.js route is visited signed out (redirect), signed in with the
 * wrong permission (redirect), and signed in correctly (renders, passes axe, no horizontal overflow on a phone).
 */
const run = Date.now().toString(36);

async function noHorizontalOverflow(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on this viewport`).toBeLessThanOrEqual(innerWidth + 1);
}

test.describe("route inventory", () => {
  test("every application page and every candidate page answers with the report-only content-security policy and a nonce", async ({ page, baseURL }) => {
    for (const path of ["/login", "/"]) {
      const r = await page.request.get(`${baseURL}${path}`, { maxRedirects: 0 });
      const csp = r.headers()["content-security-policy-report-only"];
      expect(csp, path).toBeTruthy();
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(r.headers()["content-security-policy"], path).toBeUndefined();
    }
    const privacy = await page.request.get(`${baseURL}/privacy`);
    expect(privacy.headers()["content-security-policy-report-only"]).toContain("default-src 'none'");
    // the shell's own scripts carry the nonce the header names
    const login = await page.request.get(`${baseURL}/login`, { maxRedirects: 0 });
    const nonce = login.headers()["content-security-policy-report-only"].match(/'nonce-([^']+)'/)![1];
    const html = await login.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) if (!/type="application\/(ld\+)?json"/.test(attrs)) expect(attrs, `<script${attrs}>`).toContain(`nonce="${nonce}"`);
  });

  test("signed out, every private route sends the person to sign in", async ({ page }) => {
    for (const path of ["/", "/roles", "/talent", "/interviews", "/setup", "/updates", "/recruiter/queue", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("an owner sees every company route; recruiter and admin routes send them home", async ({ page, baseURL }) => {
    skipWithoutFakeSignIn();
    test.setTimeout(300_000); // eight routes with accessibility scans, then the candidate pages: long on a loaded runner
    await signIn(page, { email: `owner+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Luis", "Ortega");
    const routes: Array<[string, RegExp | string]> = [
      ["/", /Good (morning|afternoon|evening)/],
      ["/roles", "Roles"],
      [`/roles/${seeded.roleId}`, /Hygienist/i],
      // the Talent page is headed by the role it shows (Wave A: "JOB · <company>" above the role's title)
      [`/roles/${seeded.roleId}/talent`, /Hygienist/i],
      ["/talent", /Hygienist/i],
      ["/interviews", "Interviews"],
      ["/setup", "Setup"],
      // every earlier update, read and unread (plan B3), reached from Today
      ["/updates", "Updates"],
    ];
    for (const [path, heading] of routes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(heading, { timeout: 30_000 });
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      // Sign out stays reachable in the phone's top bar too, and the menu does not name the AI company
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Main" })).not.toContainText("AI:");
      await expectAccessible(page, path);
      await noHorizontalOverflow(page, path);
    }
    // The rail (Wave DS): "Start a hire" is in it for an owner; the open role is listed under Roles on a wide screen,
    // and on a phone the links open from the Menu button while Start a hire and Sign out stay in the bar.
    await page.goto("/roles");
    const rail = page.getByRole("navigation", { name: "Main" });
    await expect(rail.getByRole("link", { name: "Start a hire" })).toBeVisible({ timeout: 30_000 });
    if ((page.viewportSize()?.width ?? 0) > 900) {
      await expect(rail.getByRole("link", { name: /Hygienist/i })).toBeVisible({ timeout: 30_000 });
    } else {
      await rail.getByRole("button", { name: "Menu" }).click();
      await expect(rail.getByRole("link", { name: "Interviews" })).toBeVisible();
      await expectAccessible(page, "phone menu open");
    }
    // N outside a text field opens the new-role conversation on Today; opening it saves nothing (the draft starts with
    // the first message), so a stray key leaves no draft behind
    await page.keyboard.press("n");
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Your recruiting chief of staff" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main")).toContainText("Tell me who you need to hire.");
    const draft = await page.request.get(`${baseURL}/api/v1/intake/sessions/current`);
    expect(((await draft.json()) as { session: unknown }).session).toBeNull();
    // and on a page where something was typed but not saved, N is left alone so the typing is not thrown away
    await page.goto("/setup");
    await page.getByLabel("Buffer between interviews (minutes)").fill("25");
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("n");
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByLabel("Buffer between interviews (minutes)")).toHaveValue("25");
    await page.goto(`/roles/${seeded.roleId}/people`);
    await expect(page).toHaveURL(new RegExp(`/roles/${seeded.roleId}/talent`));
    await page.goto("/people");
    await expect(page).toHaveURL(/\/talent$/, { timeout: 30_000 });
    await page.goto("/recruiter/queue");
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await page.goto("/login");
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 }); // signed in: no second sign-in form
    await page.goto("/nothing-here");
    await expect(page.getByRole("heading", { name: /does not exist/ })).toBeVisible();
    await expectAccessible(page, "not found");
    // the candidate pages on this viewport too
    await page.goto(`/careers/${seeded.slug}/jobs/${seeded.roleId}`);
    await noHorizontalOverflow(page, "job page");
    await page.goto(seeded.statusPath);
    await expectAccessible(page, "status page");
    await noHorizontalOverflow(page, "status page");
  });

  test("a seeded platform administrator reaches the queue and the console; both pass accessibility", async ({ page }) => {
    skipWithoutFakeSignIn();
    await signIn(page, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
    await page.goto("/recruiter/queue");
    await expect(page.getByRole("heading", { name: "Recruiter queue" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "recruiter queue");
    await noHorizontalOverflow(page, "recruiter queue");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin console" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "admin console");
    await noHorizontalOverflow(page, "admin console");
    for (const tab of ["Failures", "Business calendar", "Administrators", "Outcomes", "Queue"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expectAccessible(page, `admin ${tab}`);
      await noHorizontalOverflow(page, `admin ${tab}`);
    }
    await page.goto("/setup");
    await expect(page).toHaveURL(/recruiter\/queue/); // no company: owner routes are not for staff
  });
});
