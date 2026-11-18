import { expect, test, type Locator, type Page } from "@playwright/test";
import { exactlyOneEmail, expectAccessible, fillTheCompanyForm, gotoSettled, noSidewaysScroll, publishedJobThroughTheApi, said, signIn, signInAsAdmin, skipWithoutFakeSignIn, waitForEmail } from "./helpers";

/**
 * The one gate, from end to end in a real browser. Someone signs in, gives the company's details and presses Send my
 * request; every address they open lands on the same screen; a platform administrator sees them under "Waiting for
 * approval" on the admin dashboard and accepts or declines with a second press; and the waiting screen moves on by
 * itself. Accept makes the company live at once. A declined company can be accepted after all, and an accepted one can
 * have its access taken away and given back. Everything is synthetic; every provider is a stand-in.
 *
 * The sign-up mode is the server's, so this spec needs a server of its own: SIGNUP_MODE=approval in the environment
 * (playwright.config.ts hands it to the server). In any other run it is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);
const asker = (who: string) => ({ email: `${who}+${run}@asker.test`, name: "Sam Asker", provider: "google" }) as const;
/** Longer than one 30-second look of the waiting screen, so a look is sure to have happened. */
const A_LOOK = 45_000;

/** Sends the company's details through the API with this browser's session: the screens are what is being proved, not the form again. */
async function askThroughTheApi(page: Page, base: string, company: string, over: Record<string, unknown> = {}) {
  const r = await page.request.post(`${base}/api/v1/companies`, { data: { name: company, ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", website: "https://asker.example", locations: [{ city: "Austin", region: "TX", country: "US" }], ...over } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string };
}

const requestRow = (page: Page, company: string) => page.locator(".card", { has: page.getByRole("heading", { name: "Waiting for approval" }) }).getByRole("listitem").filter({ hasText: company });
const companyInTheTable = (page: Page, company: string) => page.getByRole("row").filter({ has: page.getByRole("button", { name: company, exact: true }) });
const tallEnough = async (control: Locator, name: string) => {
  const box = await control.boundingBox();
  expect(box?.height ?? 0, `${name} is a 40px target`).toBeGreaterThanOrEqual(40);
};

test.describe("a company asks for access", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.SIGNUP_MODE !== "approval", "needs a server of its own in SIGNUP_MODE=approval");

  test("the company signs up, waits on one screen from every address, is accepted by the administrator and lands on Home", async ({ page, browser, baseURL }) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const company = `Harbor Dental ${run}`;
    const me = asker("first");
    const scriptErrors: string[] = [];
    page.on("pageerror", (e) => scriptErrors.push(e.message));

    // The company's details, with the main button saying what it does
    await signIn(page, me);
    await page.waitForURL("**/setup/company");
    await expect(page.getByRole("heading", { name: "Tell us about your company" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create my hiring workspace" })).toHaveCount(0);
    await fillTheCompanyForm(page, company, me.name);
    await expectAccessible(page, "the company form by approval");
    await page.getByRole("button", { name: "Send my request" }).click();

    // The page stays: told on the screen, focus on the new title, and the email line once the email really left
    const waiting = page.getByRole("heading", { name: "Your request has been sent" });
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/setup\/company$/);
    await expect(waiting).toBeFocused();
    await expect(page.getByText("Please wait for approval.")).toBeVisible();
    await expect(page.getByText(company)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expectAccessible(page, "the waiting screen");
    await waitForEmail(page.request, base, { to: me.email, subject: "Your request has been sent", says: [company] });
    await exactlyOneEmail(page.request, base, { to: me.email, subject: "Your request has been sent" });
    await expect(page.getByText(`We sent a copy to ${me.email}, and we will email you when it is decided.`)).toBeVisible({ timeout: A_LOOK });

    // Reloading, any signed-in address (an old one too), and signing out and in again all land here, with no loop
    await page.reload();
    await expect(waiting).toBeVisible();
    for (const address of ["/", "/roles", "/roles/new", "/talent", "/setup", "/updates", "/people", "/admin", "/admin/customers", "/login"]) {
      await gotoSettled(page, address);
      await page.waitForURL("**/setup/company", { timeout: 60_000 });
      await expect(waiting, address).toBeVisible({ timeout: 30_000 });
    }
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await signIn(page, me);
    await page.waitForURL("**/setup/company");
    await expect(waiting).toBeVisible();
    // nothing else opens: the API has no company for them
    expect((await page.request.get(`${base}/api/v1/roles`)).status()).toBeGreaterThanOrEqual(400);

    // The administrator lands on Companies, with the request under "Waiting for approval": who, where, how long
    const admin = await signInAsAdmin(browser);
    await gotoSettled(admin.page, "/admin");
    await expect(admin.page.getByRole("heading", { level: 1, name: "Companies" })).toBeVisible({ timeout: 30_000 });
    const row = requestRow(admin.page, company);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(`${me.email} · ${me.name} · Tustin, CA · Waiting since today`);
    await expectAccessible(admin.page, "Companies with a request waiting");

    // A press swaps the buttons for the question, on the row; No takes it back, and focus follows
    await row.getByRole("button", { name: `Decline ${company}`, exact: true }).click();
    await expect(row.getByText(`Decline ${company}?`)).toBeVisible();
    await expect(row.getByRole("button", { name: `Yes, decline ${company}` })).toBeFocused();
    await expect(row.getByRole("button", { name: `Accept ${company}`, exact: true })).toHaveCount(0);
    await expectAccessible(admin.page, "the request's second press");
    await row.getByRole("button", { name: `No, do not decline ${company}` }).click();
    await expect(row.getByRole("button", { name: `Decline ${company}`, exact: true })).toBeFocused();

    // An error is said in a toast and the row stays; so is no answer at all
    const access = "**/api/v1/admin/customers/*/access";
    await admin.page.route(access, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }) }));
    await row.getByRole("button", { name: `Accept ${company}`, exact: true }).click();
    await row.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(said(admin.page, "Something went wrong on our side.")).toBeVisible();
    await expect(row.getByRole("button", { name: `Accept ${company}`, exact: true })).toBeVisible();
    await admin.page.unroute(access);
    await admin.page.route(access, (r) => r.abort());
    await row.getByRole("button", { name: `Accept ${company}`, exact: true }).click();
    await row.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(said(admin.page, "Could not record that. Try again.")).toBeVisible();
    await expect(row.getByRole("button", { name: `Accept ${company}`, exact: true })).toBeVisible();
    await admin.page.unroute(access);

    // Accept, then Yes: the row leaves, and the company is Active in the list, with its page
    await row.getByRole("button", { name: `Accept ${company}`, exact: true }).click();
    await expect(row.getByText(`Accept ${company}?`)).toBeVisible();
    await row.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    const listed = companyInTheTable(admin.page, company);
    await expect(listed.getByText("Active", { exact: true })).toBeVisible({ timeout: 30_000 });
    await listed.getByRole("button", { name: company, exact: true }).click();
    const drawer = admin.page.getByRole("dialog", { name: company });
    await expect(drawer.getByText("Active", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Take away access from ${company}`, exact: true })).toBeVisible();
    await expect(drawer.getByText("No jobs yet.")).toBeVisible();
    await expectAccessible(admin.page, "an accepted company's page");
    await admin.context.close();

    // The waiting screen goes Home by itself, with no reload and no script error, and the owner hears it by email, once
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    expect(scriptErrors).toEqual([]);
    await waitForEmail(page.request, base, { to: me.email, subject: "Your request was approved", says: [company] });
    await exactlyOneEmail(page.request, base, { to: me.email, subject: "Your request was approved" });
  });

  test("declined, then accepted after all; access taken away, then given back: the owner's screens follow each time", async ({ page, browser, baseURL }) => {
    test.setTimeout(600_000);
    const base = baseURL!;
    const company = `Lakeside Dental ${run}`;
    const me = asker("second");
    await signIn(page, me);
    await page.waitForURL("**/setup/company");
    await askThroughTheApi(page, base, company);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your request has been sent" })).toBeVisible({ timeout: 30_000 });

    // Decline: the row leaves, and the waiting screen moves to the declined one by itself
    const admin = await signInAsAdmin(browser);
    await gotoSettled(admin.page, "/admin");
    const row = requestRow(admin.page, company);
    await row.getByRole("button", { name: `Decline ${company}`, exact: true }).click();
    await row.getByRole("button", { name: `Yes, decline ${company}` }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    const declined = page.getByRole("heading", { name: "We can't offer access right now" });
    await expect(declined).toBeVisible({ timeout: A_LOOK });
    await expect(page.getByText("Questions?")).toBeVisible();
    await expect(page.getByText(/sent a copy|will email/)).toHaveCount(0);
    await expectAccessible(page, "the declined screen");
    await waitForEmail(page.request, base, { to: me.email, subject: "We can't offer access right now", says: [company] });
    await exactlyOneEmail(page.request, base, { to: me.email, subject: "We can't offer access right now" });
    for (const address of ["/", "/admin", "/login"]) {
      await gotoSettled(page, address);
      await page.waitForURL("**/setup/company", { timeout: 60_000 });
      await expect(declined, address).toBeVisible({ timeout: 30_000 });
    }

    // The Declined filter holds it; its page says when and by whom, and Accept is the undo
    await admin.page.getByRole("button", { name: /^Declined \d+$/ }).click();
    const listed = companyInTheTable(admin.page, company);
    await expect(listed.getByText("Declined", { exact: true })).toBeVisible({ timeout: 30_000 });
    await listed.getByRole("button", { name: company, exact: true }).click();
    const drawer = admin.page.getByRole("dialog", { name: company });
    await expect(drawer.getByText(/ by Admin$/)).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Decline ${company}`, exact: true })).toHaveCount(0);
    await expectAccessible(admin.page, "a declined company's page");
    const accept = drawer.getByRole("button", { name: `Accept ${company}`, exact: true });
    const takeAway = drawer.getByRole("button", { name: `Take away access from ${company}`, exact: true });
    await accept.click();
    await expect(drawer.getByText(`Accept ${company}?`)).toBeVisible();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(takeAway).toBeVisible({ timeout: 30_000 });

    // The declined screen goes Home by itself; the owner gets to work: a published job, public
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    const job = await publishedJobThroughTheApi(page.request, base);
    expect((await page.request.get(`${base}/careers/${job.slug}`)).status()).toBe(200);

    // Take away access: asked once more, then the owner reaches nothing and the company's pages are offline
    await takeAway.click();
    await expect(drawer.getByText(`Take away access from ${company}?`)).toBeVisible();
    await expectAccessible(admin.page, "taking access away, the second press");
    await drawer.getByRole("button", { name: `Yes, take away access from ${company}` }).click();
    await expect(accept).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(`${base}/careers/${job.slug}`)).status()).toBe(404);
    expect((await page.request.get(job.jobUrl)).status()).toBe(404);
    // every address, and signing in again, lands on the declined screen; the API has nothing for them
    for (const address of ["/", "/roles", `/roles/${job.roleId}`, "/talent", "/setup"]) {
      await gotoSettled(page, address);
      await expect(async () => {
        if (/\/login/.test(page.url())) await signIn(page, me);
        await expect(declined).toBeVisible({ timeout: 5_000 });
      }, address).toPass({ timeout: 60_000 });
    }
    expect((await page.request.get(`${base}/api/v1/roles`)).status()).toBeGreaterThanOrEqual(400);

    // Accept is the undo: everyone is back, with their job
    await accept.click();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(takeAway).toBeVisible({ timeout: 30_000 });
    await admin.context.close();
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(job.jobUrl)).status()).toBe(200);
    await page.goto(`/roles/${job.roleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(job.title, { timeout: 30_000 });
  });

  test("the waiting screen's look never breaks the page: an expired sign-in, no network or a page that is not JSON, and it still goes Home", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    const company = `Patient Dental ${run}`;
    const scriptErrors: string[] = [];
    page.on("pageerror", (e) => scriptErrors.push(e.message));
    await page.clock.install();
    await signIn(page, asker("patient"));
    const { id } = await askThroughTheApi(page, baseURL!, company);
    await gotoSettled(page, "/setup/company");
    const waiting = page.getByRole("heading", { name: "Your request has been sent" });
    await expect(waiting).toBeVisible({ timeout: 30_000 });

    const looks: string[] = [];
    const breakIt = async (how: "expired" | "no network" | "not json") => {
      await page.route("**/api/v1/auth/me", (r) => (how === "no network" ? r.abort() : how === "expired" ? r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "Not signed in." } }) }) : r.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" })));
      const seen = page.waitForRequest("**/api/v1/auth/me");
      await page.clock.fastForward(31_000);
      looks.push((await seen).url());
      await expect(waiting, how).toBeVisible();
      await page.unroute("**/api/v1/auth/me");
    };
    await breakIt("expired");
    await breakIt("no network");
    await breakIt("not json");
    expect(looks).toHaveLength(3);
    expect(scriptErrors).toEqual([]);

    // accepted meanwhile, and the next look that gets through goes Home by itself
    const admin = await signInAsAdmin(browser);
    const accepted = await admin.page.request.post(`${baseURL}/api/v1/admin/customers/${id}/access`, { data: { decision: "accept", from: "requested", confirm: true }, headers: { "x-admin-reason": "e2e: accepted" } });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    await admin.context.close();
    await page.clock.fastForward(31_000);
    await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
    expect(scriptErrors).toEqual([]);
  });

  test("a very long name, website and person: nothing moves sideways on a 360px phone, and the buttons stay 40px targets", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const phone = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
    const company = `Long${"n".repeat(112)}${run.slice(0, 4)}`;
    const person = `Sam${"s".repeat(110)}`;
    const website = `https://${"w".repeat(60)}.example/${"p".repeat(120)}`;

    const askerContext = await browser.newContext(phone);
    const page = await askerContext.newPage();
    await signIn(page, asker("long"));
    await page.waitForURL("**/setup/company");
    await noSidewaysScroll(page, "the company form");
    await askThroughTheApi(page, baseURL!, company, { ownerName: person, website });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your request has been sent" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(company)).toBeVisible();
    await noSidewaysScroll(page, "the waiting screen");
    await tallEnough(page.getByRole("button", { name: "Sign out" }), "Sign out");

    // the request's row: the page never scrolls sideways, before or after the first press
    const admin = await signInAsAdmin(browser, phone);
    await gotoSettled(admin.page, "/admin");
    const row = requestRow(admin.page, company);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(admin.page, "Companies");
    const accept = row.getByRole("button", { name: `Accept ${company}`, exact: true });
    await tallEnough(accept, "Accept");
    await tallEnough(row.getByRole("button", { name: `Decline ${company}`, exact: true }), "Decline");
    await accept.click();
    await expect(row.getByText(`Accept ${company}?`)).toBeVisible();
    await noSidewaysScroll(admin.page, "the request's second press");
    await tallEnough(row.getByRole("button", { name: `Yes, accept ${company}` }), "Yes");
    await tallEnough(row.getByRole("button", { name: `No, do not accept ${company}` }), "No");
    await row.getByRole("button", { name: `No, do not accept ${company}` }).click();

    // the company's page: the long name, person and website break inside it
    await row.getByRole("button", { name: company, exact: true }).click();
    const drawer = admin.page.getByRole("dialog", { name: company });
    await expect(drawer.getByRole("button", { name: `Accept ${company}`, exact: true })).toBeVisible();
    await expect(drawer.getByText(person)).toBeVisible();
    expect(await drawer.evaluate((d) => d.scrollWidth - d.clientWidth), "the company's page scrolls sideways").toBeLessThanOrEqual(1);
    await noSidewaysScroll(admin.page, "the company's page");
    await tallEnough(drawer.getByRole("button", { name: `Decline ${company}`, exact: true }), "the page's Decline");
    await drawer.getByRole("button", { name: `Accept ${company}`, exact: true }).click();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    // the answer's long words stay on the screen
    const answer = admin.page.locator(".toast");
    await expect(answer).toBeVisible({ timeout: 30_000 });
    const box = await answer.boundingBox();
    expect((box?.x ?? -1) + (box?.width ?? 999), "the toast stays on the screen").toBeLessThanOrEqual(360);
    await expect(drawer.getByRole("button", { name: `Take away access from ${company}`, exact: true })).toBeVisible({ timeout: 30_000 });
    await admin.context.close();
    await askerContext.close();
  });
});
