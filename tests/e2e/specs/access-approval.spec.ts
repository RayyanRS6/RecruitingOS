import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { expectAccessible, gotoSettled, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * First sign-in asks for approval (the owner's request of 6 November 2026), from end to end in a real browser. Someone signs
 * in, fills in the usual form and presses Send my request; every address they open lands on the same screen; an
 * administrator sees them at the very top of the Console's Overview and accepts or declines with a second press; and the
 * waiting screen moves on by itself. Everything is synthetic; every provider is a fake.
 *
 * The sign-up mode is the server's, so this spec needs a server of its own: SIGNUP_MODE=approval in the environment
 * (playwright.config.ts hands it to the server), as the last end-to-end step of .github/workflows/ci.yml has it. In any
 * other run it is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);
const ADMIN = { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true } as const;
const asker = (who: string) => ({ email: `${who}+${run}@asker.test`, name: "Sam Asker", provider: "google" }) as const;
const ADDRESSES = ["/", "/roles", "/roles/new", "/talent", "/interviews", "/setup", "/updates", "/people", "/recruiter/queue", "/admin", "/admin/customers", "/login"];
/** Longer than one 30-second look, so a look is sure to have happened. */
const A_LOOK = 45_000;

async function fillTheForm(page: Page, company: string) {
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("Your name").fill("Sam Asker");
  await page.getByLabel("What kind of business").selectOption("dental");
  await page.getByLabel("How many employees").selectOption("1-19");
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("State").fill("TX");
  await page.getByLabel("Time zone").selectOption("America/Chicago");
  await page.getByLabel("Website (optional)").fill("https://asker.example");
}

/** Sends the company form through the API with this browser's session: the screens are what is being proved, not the form again. */
async function askThroughTheApi(page: Page, base: string, company: string, over: Record<string, unknown> = {}) {
  const r = await page.request.post(`${base}/api/v1/companies`, { data: { name: company, ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", website: "https://asker.example", locations: [{ city: "Austin", region: "TX", country: "US" }], ...over } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; accessRequest: { status: string } };
}

/** An administrator in a browser of their own, so nobody's session is touched. */
async function anAdministrator(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, ADMIN);
  return { context, page };
}

const needsAttention = (page: Page) => page.locator(".card", { has: page.getByRole("heading", { name: "Needs attention" }) });
const requestRow = (page: Page, company: string) => needsAttention(page).getByRole("listitem").filter({ hasText: `${company} is asking for access` });
const toastSaying = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });
const noSidewaysScroll = async (page: Page, name: string) => {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways`).toBeLessThanOrEqual(innerWidth + 1);
};
const tallEnough = async (control: Locator, name: string) => {
  const box = await control.boundingBox();
  expect(box?.height ?? 0, `${name} is a 40px target`).toBeGreaterThanOrEqual(40);
};

test.describe("first sign-in asks for approval", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.SIGNUP_MODE !== "approval", "needs a server of its own in SIGNUP_MODE=approval");

  test("ask, wait, be declined, be accepted: every address lands on the same screen, and the screen moves on by itself", async ({ page, browser, baseURL }) => {
    test.setTimeout(480_000);
    const company = `Harbor Dental ${run}`;
    const me = asker("sam");
    const scriptErrors: string[] = [];
    page.on("pageerror", (e) => scriptErrors.push(e.message));

    // The usual form, with the main button saying what it does
    await signIn(page, me);
    await page.waitForURL("**/setup/company");
    await expect(page.getByRole("heading", { name: "Tell us about your company" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create my hiring workspace" })).toHaveCount(0);
    await fillTheForm(page, company);
    await expectAccessible(page, "the company form by approval");
    await page.getByRole("button", { name: "Send my request" }).click();

    // The page stays: told on the screen, with the email line because the email really left, and focus on the new title
    const waiting = page.getByRole("heading", { name: "Your request has been sent" });
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/setup\/company$/);
    await expect(waiting).toBeFocused();
    await expect(page.getByText("Please wait for approval.")).toBeVisible();
    await expect(page.getByText(company)).toBeVisible();
    await expect(page.getByText(`We sent a copy to ${me.email}, and we will email you when it is decided.`)).toBeVisible();
    await expect(page.getByText("Keep this page open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expectAccessible(page, "the waiting screen");

    // Reloading, any signed-in address, and signing out and in again all land here, with no error and no loop
    await page.reload();
    await expect(waiting).toBeVisible();
    for (const address of ADDRESSES) {
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
    expect((await page.request.get(`${baseURL}/api/v1/roles`)).status()).toBeGreaterThanOrEqual(400);

    // Nadine sees them at the very top of Needs attention: who, what, where, the website as a safe link, and how long
    const { context: staff, page: admin } = await anAdministrator(browser);
    await gotoSettled(admin, "/admin");
    const row = requestRow(admin, company);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(needsAttention(admin).getByRole("listitem").first()).toContainText("is asking for access");
    await expect(row).toContainText(`${me.email} · Sam Asker · Dental practice or group · 1-19 employees · Austin, TX · https://asker.example`);
    await expect(row).toContainText("Waiting since today");
    const website = row.getByRole("link", { name: /asker\.example/ });
    await expect(website).toHaveAttribute("href", "https://asker.example/");
    await expect(website).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(website).toHaveAttribute("target", "_blank");
    await expectAccessible(admin, "the Overview with a request");

    // A press swaps the buttons for the question, on the row; No takes it back, and focus follows
    await row.getByRole("button", { name: `Decline ${company}` }).click();
    await expect(row.getByText(`Decline ${company}?`)).toBeVisible();
    await expect(row.getByRole("button", { name: `Yes, decline ${company}` })).toBeFocused();
    await expect(row.getByRole("button", { name: `Accept ${company}` })).toHaveCount(0);
    await expectAccessible(admin, "the row's second press");
    await row.getByRole("button", { name: `No, do not decline ${company}` }).click();
    await expect(row.getByRole("button", { name: `Decline ${company}` })).toBeFocused();

    // An error shows as a toast and the row stays
    await admin.route("**/api/v1/admin/customers/*/access", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "server_error", message: "Something went wrong on our side." } }) }));
    await row.getByRole("button", { name: `Decline ${company}` }).click();
    await row.getByRole("button", { name: `Yes, decline ${company}` }).click();
    await expect(toastSaying(admin, "Something went wrong on our side.")).toBeVisible();
    await expect(row.getByRole("button", { name: `Decline ${company}` })).toBeVisible();
    // and no answer at all, the same
    await admin.unroute("**/api/v1/admin/customers/*/access");
    await admin.route("**/api/v1/admin/customers/*/access", (r) => r.abort());
    await row.getByRole("button", { name: `Decline ${company}` }).click();
    await row.getByRole("button", { name: `Yes, decline ${company}` }).click();
    await expect(toastSaying(admin, "Could not record that. Try again.")).toBeVisible();
    await expect(row.getByRole("button", { name: `Decline ${company}` })).toBeVisible();
    await admin.unroute("**/api/v1/admin/customers/*/access");

    // Decline: a toast, and the row leaves; the waiting screen moves to the declined one by itself, with no reload
    await row.getByRole("button", { name: `Decline ${company}` }).click();
    await row.getByRole("button", { name: `Yes, decline ${company}` }).click();
    await expect(toastSaying(admin, `${company} was declined.`)).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveCount(0);
    const declined = page.getByRole("heading", { name: "We can't offer access right now" });
    await expect(declined).toBeVisible({ timeout: A_LOOK });
    await expect(page.getByText("Questions?")).toBeVisible();
    await expect(page.getByRole("link", { name: /@/ })).toHaveAttribute("href", /^mailto:/);
    await expect(page.getByText(/sent a copy|will email/)).toHaveCount(0);
    await expectAccessible(page, "the declined screen");
    // the same from anywhere, and after signing in again
    for (const address of ["/", "/admin", "/login"]) {
      await gotoSettled(page, address);
      await page.waitForURL("**/setup/company", { timeout: 60_000 });
      await expect(declined, address).toBeVisible({ timeout: 30_000 });
    }
    await page.reload();
    await expect(declined).toBeVisible();

    // The Declined pill holds them; the drawer says when and by whom, and Accept is the undo
    await gotoSettled(admin, "/admin/customers");
    const onAll = admin.getByRole("row", { name: new RegExp(company) });
    await expect(admin.getByRole("button", { name: /^Declined \d/ })).toBeVisible({ timeout: 30_000 });
    await expect(onAll).toHaveCount(0);
    await admin.getByRole("button", { name: /^Declined \d/ }).click();
    const declinedRow = admin.getByRole("row", { name: new RegExp(company) });
    await expect(declinedRow.getByText("Declined", { exact: true })).toBeVisible();
    await declinedRow.getByRole("button", { name: `Open ${company}` }).click();
    const drawer = admin.getByRole("dialog", { name: company });
    await expect(drawer.getByRole("tab", { name: "ITS check", selected: true })).toBeVisible();
    await expect(drawer.getByText(/ by Admin$/)).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Decline ${company}` })).toHaveCount(0);
    await expect(drawer.getByRole("tab", { name: "Plan" })).toHaveCount(0);
    await expectAccessible(admin, "a declined company's drawer");
    await drawer.getByRole("button", { name: `Accept ${company}` }).click();
    await expect(drawer.getByText(`Accept ${company}?`)).toBeVisible();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(toastSaying(admin, `${company} was accepted.`)).toBeVisible({ timeout: 30_000 });
    // an ordinary customer now: confirmed, with every tab; one approval, not two
    await expect(drawer.getByRole("tab", { name: "Plan" })).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByRole("button", { name: "Take back the confirmation" })).toBeVisible();
    await staff.close();

    // The screen goes Home by itself, with no reload and no script error, on the Free plan
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    const current = (await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json()) as { planKey: string; settings: { verifiedAt?: string } };
    expect(current.planKey).toBe("free");
    expect(current.settings.verifiedAt).toBeTruthy();
    expect(scriptErrors).toEqual([]);
  });

  test("two administrators: whoever comes second gets a calm answer and the row refreshes", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    const accepted = `Second Press Dental ${run}`;
    const taken = `Taken Dental ${run}`;
    await signIn(page, asker("second"));
    await askThroughTheApi(page, baseURL!, accepted);
    const elsewhere = await browser.newContext();
    const other = await elsewhere.newPage();
    await signIn(other, asker("taken"));
    await askThroughTheApi(other, baseURL!, taken);

    // both consoles have both rows on screen
    const first = await anAdministrator(browser);
    const second = await anAdministrator(browser);
    for (const admin of [first.page, second.page]) {
      await gotoSettled(admin, "/admin");
      await expect(requestRow(admin, accepted)).toBeVisible({ timeout: 30_000 });
      await expect(requestRow(admin, taken)).toBeVisible();
    }
    // Accept twice: the second press changes nothing and says so, and its row leaves
    for (const [admin, words] of [[first.page, `${accepted} was accepted.`], [second.page, `${accepted} already has access. Nothing changed.`]] as const) {
      const row = requestRow(admin, accepted);
      await row.getByRole("button", { name: `Accept ${accepted}` }).click();
      await row.getByRole("button", { name: `Yes, accept ${accepted}` }).click();
      await expect(toastSaying(admin, words)).toBeVisible({ timeout: 30_000 });
      await expect(row).toHaveCount(0);
    }
    // Declining what another has just accepted: refused, calmly, and the row leaves all the same
    const row = requestRow(first.page, taken);
    await row.getByRole("button", { name: `Accept ${taken}` }).click();
    await row.getByRole("button", { name: `Yes, accept ${taken}` }).click();
    await expect(toastSaying(first.page, `${taken} was accepted.`)).toBeVisible({ timeout: 30_000 });
    const stale = requestRow(second.page, taken);
    await stale.getByRole("button", { name: `Decline ${taken}` }).click();
    await stale.getByRole("button", { name: `Yes, decline ${taken}` }).click();
    await expect(toastSaying(second.page, `${taken} already has access, so it cannot be declined now.`)).toBeVisible({ timeout: 30_000 });
    await expect(stale).toHaveCount(0);
    // the row that left took focus with it: it went to the list, not to the page
    await expect.poll(() => second.page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await Promise.all([first.context.close(), second.context.close(), elsewhere.close()]);
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
    const { context: staff, page: admin } = await anAdministrator(browser);
    const accepted = await admin.request.post(`${baseURL}/api/v1/admin/customers/${id}/access`, { data: { decision: "accept", from: "requested", confirm: true }, headers: { "x-admin-reason": "e2e: accepted" } });
    expect(accepted.ok(), await accepted.text()).toBeTruthy();
    await staff.close();
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
    await noSidewaysScroll(page, "the form");
    const { id } = await askThroughTheApi(page, baseURL!, company, { ownerName: person, website });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your request has been sent" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(company)).toBeVisible();
    await noSidewaysScroll(page, "the waiting screen");
    await tallEnough(page.getByRole("button", { name: "Sign out" }), "Sign out");

    const { context: staff, page: admin } = await anAdministrator(browser, phone);
    await gotoSettled(admin, "/admin");
    const row = requestRow(admin, company);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole("link", { name: /example/ })).toBeVisible();
    await noSidewaysScroll(admin, "the Overview");
    const accept = row.getByRole("button", { name: `Accept ${company}` });
    await tallEnough(accept, "Accept");
    await tallEnough(row.getByRole("button", { name: `Decline ${company}` }), "Decline");
    await accept.click();
    await expect(row.getByText(`Accept ${company}?`)).toBeVisible();
    await noSidewaysScroll(admin, "the Overview's second press");
    await tallEnough(row.getByRole("button", { name: `Yes, accept ${company}` }), "Yes");
    await tallEnough(row.getByRole("button", { name: `No, do not accept ${company}` }), "No");
    await row.getByRole("button", { name: `No, do not accept ${company}` }).click();

    // the list: the page itself never scrolls sideways, and the long name stays in its own column
    await gotoSettled(admin, "/admin/customers?show=waiting");
    const listed = admin.getByRole("row", { name: new RegExp(company) });
    await expect(listed).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(admin, "the Customers page");
    const name = listed.getByRole("button", { name: company, exact: true });
    expect((await name.boundingBox())?.width ?? 999, "the long name stays in its column").toBeLessThanOrEqual(240);

    // the drawer
    await listed.getByRole("button", { name: `Review ${company}` }).click();
    const drawer = admin.getByRole("dialog", { name: company });
    await expect(drawer.getByRole("button", { name: `Accept ${company}` })).toBeVisible();
    const drawerWide = await drawer.evaluate((d) => d.scrollWidth - d.clientWidth);
    expect(drawerWide, "the drawer scrolls sideways").toBeLessThanOrEqual(1);
    await noSidewaysScroll(admin, "the drawer");
    await tallEnough(drawer.getByRole("button", { name: `Decline ${company}` }), "the drawer's Decline");
    await drawer.getByRole("button", { name: `Accept ${company}` }).click();
    await drawer.getByRole("button", { name: `Yes, accept ${company}` }).click();
    // the toast's long words stay on the screen
    const said = toastSaying(admin, "was accepted.");
    await expect(said).toBeVisible({ timeout: 30_000 });
    const box = await said.locator(".toast").boundingBox();
    expect((box?.x ?? -1) + (box?.width ?? 999), "the toast stays on the screen").toBeLessThanOrEqual(360);
    expect((await (await admin.request.get(`${baseURL}/api/v1/admin/customers`, { headers: { "x-admin-reason": "e2e: long values" } })).json() as Array<{ id: string; accessRequest: unknown }>).find((c) => c.id === id)?.accessRequest).toBeNull();
    await staff.close();
    await askerContext.close();
  });
});
