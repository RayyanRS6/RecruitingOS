import { expect, test, type Page } from "@playwright/test";
import { exactlyOneEmail, expectAccessible, fillTheCompanyForm, gotoSettled, liveJobThroughTheApi, signIn, signInAsNadine, skipWithoutFakeSignIn, waitForEmail } from "./helpers";

/**
 * Asking for access, being accepted, and having it taken away and given back, end to end in a real browser (the owner's
 * request of 6 November 2026: anyone fills in their details and Nadine approves; and Nadine must be able to undo an
 * accept, because she is about to accept strangers). The request, the acceptance and the removal each send one email,
 * read by its words. After "Take away access" the owner reaches nothing: the declined screen from every address, after
 * signing in again too, and the company's job pages are offline. Accept is the undo: everyone is back, with their job,
 * and the notice says "Your access is back". access-approval.spec.ts walks the request and the decline themselves.
 *
 * The sign-up mode is the server's: this needs a server in SIGNUP_MODE=approval (the "sign-up by approval" run of the flows
 * job in .github/workflows/ci.yml); in any other run it is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);
const A_LOOK = 45_000;
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

test.describe("access asked for, given, taken away and given back", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.SIGNUP_MODE !== "approval", "needs a server of its own in SIGNUP_MODE=approval");

  test("accepted, then access taken away from the console: the owner reaches nothing and is told once; Accept brings them back with their job", async ({ page, browser, baseURL }) => {
    test.setTimeout(600_000);
    const base = baseURL!;
    const company = `Lakeside Dental ${run}`;
    const owner = { email: `rosa+${run}@lakeside.test`, name: "Rosa Diaz", provider: "google" } as const;

    // ---- asks, and is accepted ----------------------------------------------------------------------------------------
    await signIn(page, owner);
    await page.waitForURL("**/setup/company");
    await fillTheCompanyForm(page, company, owner.name);
    await page.getByRole("button", { name: "Send my request" }).click();
    await expect(page.getByRole("heading", { name: "Your request has been sent" })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: owner.email, subject: "Your request has been sent", says: [`Your request for ${company} has been sent.`] });

    const nadine = await signInAsNadine(browser);
    await gotoSettled(nadine.page, "/admin");
    const request = nadine.page.locator(".card", { has: nadine.page.getByRole("heading", { name: "Needs attention" }) }).getByRole("listitem").filter({ hasText: `${company} is asking for access` });
    await request.getByRole("button", { name: `Accept ${company}` }).click();
    await request.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(toast(nadine.page, `${company} was accepted.`)).toBeVisible({ timeout: 30_000 });
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await waitForEmail(page.request, base, { to: owner.email, subject: "Your request was approved", says: ["Your request was approved.", `Company: ${company}`] });

    // the owner gets to work: a live job, public
    const job = await liveJobThroughTheApi(page.request, base);
    expect((await page.request.get(`${base}/careers/${job.slug}`)).status()).toBe(200);

    // ---- Nadine takes the access away: a quiet button at the foot of the ITS check, then the second press -----------------
    await gotoSettled(nadine.page, "/admin/customers");
    const row = nadine.page.getByRole("row", { name: new RegExp(company) });
    await row.getByRole("button", { name: `Open ${company}` }).click();
    const drawer = nadine.page.getByRole("dialog", { name: company });
    await drawer.getByRole("tab", { name: "ITS check" }).click();
    await drawer.getByRole("button", { name: "Take away access" }).click();
    await expect(drawer.getByText(`Take away access from ${company}?`)).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Yes, take away access from ${company}` })).toBeVisible();
    await expectAccessible(nadine.page, "taking access away, the second press");
    await drawer.getByRole("button", { name: `Yes, take away access from ${company}` }).click();
    await expect(toast(nadine.page, `${company} no longer has access.`)).toBeVisible({ timeout: 30_000 });
    await expect(toast(nadine.page, /1 person can no longer sign in to it\. We emailed the owner\./)).toBeVisible();

    // the owner is told once, with the declined words; their pages are offline
    await waitForEmail(page.request, base, { to: owner.email, subject: "We can't offer access right now", says: [`for ${company}. We can't offer access right now.`, "Questions? "] });
    await exactlyOneEmail(page.request, base, { to: owner.email, subject: "We can't offer access right now" });
    expect((await page.request.get(`${base}/careers/${job.slug}`)).status()).toBe(404);
    expect((await page.request.get(`${base}/careers/${job.slug}/jobs/${job.roleId}`)).status()).toBe(404);

    // they reach nothing: every address, and signing in again, lands on the declined screen; the API has nothing for them
    const declined = page.getByRole("heading", { name: "We can't offer access right now" });
    for (const address of ["/", "/roles", `/roles/${job.roleId}`, "/talent", "/setup"]) {
      await gotoSettled(page, address);
      await expect(async () => {
        if (/\/login/.test(page.url())) await signIn(page, owner);
        await expect(declined).toBeVisible({ timeout: 5_000 });
      }, address).toPass({ timeout: 60_000 });
    }
    expect((await page.request.get(`${base}/api/v1/roles`)).status()).toBeGreaterThanOrEqual(400);
    await expectAccessible(page, "the declined screen after access was taken away");

    // a second press from a page left behind changes nothing
    const again = await nadine.page.request.post(`${base}/api/v1/admin/customers/${(await (await nadine.page.request.get(`${base}/api/v1/admin/customers`, { headers: { "x-admin-reason": "e2e: find the company" } })).json() as Array<{ id: string; name: string }>).find((c) => c.name === company)!.id}/access`, { data: { decision: "remove", confirm: true }, headers: { "x-admin-reason": "e2e: second press" } });
    expect(again.status()).toBe(409);

    // ---- Accept is the undo: everyone back, with their job, and the notice says so ----------------------------------------
    await gotoSettled(nadine.page, "/admin/customers");
    await nadine.page.getByRole("button", { name: /^Declined \d/ }).click();
    const declinedRow = nadine.page.getByRole("row", { name: new RegExp(company) });
    await declinedRow.getByRole("button", { name: `Open ${company}` }).click();
    await drawer.getByRole("button", { name: `Accept ${company}` }).click();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(toast(nadine.page, `${company} has access again.`)).toBeVisible({ timeout: 30_000 });
    await nadine.context.close();

    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(`${base}/careers/${job.slug}/jobs/${job.roleId}`)).status()).toBe(200);
    await page.goto(`/roles/${job.roleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(job.title, { timeout: 30_000 });
    await page.goto("/updates");
    await expect(page.getByRole("listitem").filter({ hasText: "Your access is back" })).toHaveCount(1, { timeout: 30_000 });
  });
});
