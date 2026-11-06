import { expect, test, type Browser, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn, usePlan } from "./helpers";

/**
 * Approving a remote job with no benefits, in a real browser with the fake AI provider. The owner, 6 November 2026: "where
 * can I approve this job it says waiting for approval?" Every other spec seeds a job in California, where the law asks only
 * for the pay range, so none of them ever saw the box a remote job gets: a card titled "Approve this job" with no Approve.
 * Approve is now always at the top of the card, greyed with its reason when it cannot be pressed for real. The one thing
 * the law asks that a person fixes by typing is a field right there: type, Save, Approve, with no leaving the page and no wait.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

const REMOTE_JOB = "I need a bookkeeper in Irvine, fully remote, $60,000 to $70,000 a year, full time. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
const ON_SITE_JOB = "I need a bookkeeper in Irvine, $60,000 to $70,000 a year, full time, in the office. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
const WORDS = "Health and dental cover, 401(k), paid time off.";
const LAW = "The law in Colorado, Illinois, Maryland, Minnesota, New Jersey and Washington asks for a short description of the benefits on the job ad, and this remote job could be done there.";

const cardOn = (page: Page, title: string | RegExp = "Approve this job") => page.locator(".card", { has: page.getByRole("heading", { name: title }) });
const saved = (page: Page) => page.getByRole("status").filter({ hasText: "Benefits saved." });

/** The job's setup where the job itself is not what the test is about, with the browser's own session. */
async function draftThroughTheApi(page: Page, base: string, message: string): Promise<string> {
  const s = await (await page.request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: message } })).json() as { session: { id: string } };
  const made = await page.request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`);
  expect(made.ok(), await made.text()).toBeTruthy();
  return (await made.json() as { roleId: string }).roleId;
}

async function expectNoSidewaysScrolling(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

/** Someone the owner invited, signed in through the invitation's own page in a browser of their own. */
async function joinTheTeam(owner: Page, browser: Browser, base: string, person: { email: string; name: string; role: "owner" | "hiring_manager" }): Promise<Page> {
  const invited = await owner.request.post(`${base}/api/v1/companies/current/invites`, { data: person });
  expect(invited.ok(), await invited.text()).toBeTruthy();
  const { devLink } = await invited.json() as { devLink: string };
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  await page.goto(devLink);
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(page.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(person.email);
  await page.getByLabel("Name").fill(person.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/api/"));
  await page.waitForLoadState("networkidle");
  return page;
}

test("a remote job from the owner's first words to its public page: greyed Approve, type, Save, Approve", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  await signIn(page, { email: `remote+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Remote ${run}`);

  // the job is built as an owner builds one: the box on Home, the job builder, Ask for approval
  await page.getByRole("textbox", { name: "Who are you hiring?" }).fill(REMOTE_JOB);
  await page.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });
  const write = page.getByRole("button", { name: "Write the draft" });
  await expect(write).toBeVisible({ timeout: 60_000 });
  await write.click();
  await expect(page.getByRole("status").filter({ hasText: "The draft is written." })).toBeVisible({ timeout: 90_000 });
  const ask = page.getByRole("button", { name: "Ask for approval" });
  await expect(ask).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await ask.click();
  await expect(page).toHaveURL(/\/roles\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  const roleId = new URL(page.url()).pathname.split("/").pop()!;

  // Approve is there, at the top, greyed; what holds it is the box right under it, in the law's own words
  const card = cardOn(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const approve = card.getByRole("button", { name: "Approve and publish" });
  await expect(approve).toBeVisible();
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(approve).toHaveAccessibleDescription("What the law asks of this job ad");
  await expect(card.getByText("Before this job can go live")).toBeVisible();
  const field = card.getByLabel("A short description of the benefits");
  await expect(field).toBeVisible();
  await expect(card.getByText(LAW, { exact: true })).toBeVisible();
  expect((await approve.boundingBox())!.y).toBeLessThan((await field.boundingBox())!.y);
  // the old ways out are gone; the company-wide way is one small link
  await expect(card.getByText(/Describe the benefits/)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Or only for this job" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Use for every job" })).toHaveAttribute("href", "/setup#setup-company");
  // what the software will do by itself stays in sight
  await expect(card.getByText(/^Once it is live:/)).toBeVisible();
  await expectAccessible(page, "approval card held by the law");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "approval card held by the law, in the dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // pressed while greyed it goes to the field, and approves nothing (Playwright treats aria-disabled as not enabled, so force)
  const approvals: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/v1/roles/${roleId}/approve`)) approvals.push(r.url()); });
  await approve.click({ force: true });
  await expect(field).toBeFocused();
  expect(approvals).toEqual([]);
  // the server would have said no anyway
  const refused = await page.request.post(`${baseURL}/api/v1/roles/${roleId}/approve`, { data: { version: 1 } });
  expect(refused.status()).toBe(409);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("legal_check");

  // type, Save: the same page, no spinner, and Approve wakes with the keyboard's place on it
  const save = card.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await field.fill(WORDS);
  await save.click();
  await expect(saved(page)).toBeVisible({ timeout: 30_000 });
  await expect(approve).not.toHaveAttribute("aria-disabled", "true");
  await expect(approve).toBeFocused();
  expect(new URL(page.url()).pathname).toBe(`/roles/${roleId}`);
  await expect(page.getByText("Getting the approval ready")).toHaveCount(0);
  await expect(card.getByText("Before this job can go live")).toHaveCount(0);
  await expect(field).toHaveCount(0);
  await card.getByText(/^What the law asks of this job ad is in order/).click();
  await expect(card.getByText("The job ad describes the benefits.")).toBeVisible();
  await expectAccessible(page, "approval card with the benefits written");
  // the version waiting took the words: no new version
  const after = await (await page.request.get(`${baseURL}/api/v1/roles/${roleId}`)).json() as { packetVersions: unknown[]; currentPacket: { packet: { compensation: { benefitsSummary?: string } } } };
  expect(after.packetVersions).toHaveLength(1);
  expect(after.currentPacket.packet.compensation.benefitsSummary).toBe(WORDS);

  // Approve: the calm confirmation, and the job page says what the law asked for
  await approve.click();
  const done = page.getByRole("dialog", { name: "Your job is approved" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await done.getByRole("button", { name: "Go to your role" }).click();
  await expect(card).toBeHidden({ timeout: 30_000 });
  const { slug } = await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json() as { slug: string };
  await expect.poll(async () => (await page.request.get(`${baseURL}/careers/${slug}/jobs/${roleId}`)).status(), { timeout: 30_000 }).toBe(200);
  await page.goto(`/careers/${slug}/jobs/${roleId}`);
  await expect(page.getByRole("heading", { name: "Benefits" })).toBeVisible();
  await expect(page.getByText(WORDS)).toBeVisible();
  // and who wrote them is on the job's Activity
  await page.goto(`/roles/${roleId}?tab=activity`);
  await expect(page.getByText("Version 1 edited: Benefits written on the approval card")).toBeVisible({ timeout: 30_000 });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

  test("Approve before the field, no sideways scrolling, room for a finger, and a press saves words already typed", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    await signIn(page, { email: `remote-phone+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Remote Phone ${run}`);
    const roleId = await draftThroughTheApi(page, baseURL!, REMOTE_JOB);
    await page.goto(`/roles/${roleId}`);
    const card = cardOn(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const approve = card.getByRole("button", { name: "Approve and publish" });
    const field = card.getByLabel("A short description of the benefits");
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    expect((await approve.boundingBox())!.y).toBeLessThan((await field.boundingBox())!.y);
    await expectNoSidewaysScrolling(page);
    await expectAccessible(page, "approval card on a phone");
    for (const [name, control] of [["Approve", approve], ["the field", field], ["Save", card.getByRole("button", { name: "Save", exact: true })], ["Use for every job", card.getByRole("link", { name: "Use for every job" })]] as const) expect((await control.boundingBox())!.height, name).toBeGreaterThanOrEqual(40);

    // one letter is not a description: the press goes to the field and nothing is sent
    await field.fill("x");
    await approve.click({ force: true });
    await expect(field).toBeFocused();
    await expect(saved(page)).toHaveCount(0);
    // with words typed, pressing Approve saves them; it does not approve yet
    await field.fill(WORDS);
    await approve.click({ force: true });
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await expect(field).toHaveCount(0);
    await expectNoSidewaysScrolling(page);
    await expect(page.getByRole("dialog", { name: "Your job is approved" })).toHaveCount(0);
    await approve.click();
    await expect(page.getByRole("dialog", { name: "Your job is approved" })).toBeVisible({ timeout: 30_000 });
  });
});

test("two owners and a hiring manager: whoever started it is told why and can still fill it in, and someone else says yes", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  await signIn(page, { email: `started+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Two Owners ${run}`);
  const company = await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json() as { id: string };
  await usePlan(browser, baseURL!, company.id, "pro");
  const olive = await joinTheTeam(page, browser, baseURL!, { email: `olive+${run}@brightline.test`, name: "Olive Owner", role: "owner" });
  const hank = await joinTheTeam(page, browser, baseURL!, { email: `hank+${run}@brightline.test`, name: "Hank Manager", role: "hiring_manager" });
  const roleId = await draftThroughTheApi(page, baseURL!, REMOTE_JOB);

  // who started it: greyed, the reason directly under the title and read with the button; a press does nothing
  await page.goto(`/roles/${roleId}`);
  const mine = cardOn(page);
  await expect(mine).toBeVisible({ timeout: 30_000 });
  const myApprove = mine.getByRole("button", { name: "Approve and publish" });
  await expect(myApprove).toHaveAttribute("aria-disabled", "true");
  const why = mine.getByText(/^You started this role, so another owner, admin or hiring manager needs to approve it\./);
  await expect(why).toBeVisible();
  await expect(myApprove).toHaveAccessibleDescription(/^You started this role/);
  expect((await why.boundingBox())!.y).toBeLessThan((await mine.getByText("Before this job can go live").boundingBox())!.y);
  const approvals: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/approve")) approvals.push(r.url()); });
  await myApprove.click({ force: true });
  await expect(myApprove).toBeFocused();
  expect(approvals).toEqual([]);
  await expect(mine.getByLabel("A short description of the benefits")).toBeVisible();
  await expect(mine.getByRole("link", { name: "Use for every job" })).toBeVisible();
  await expectAccessible(page, "approval card when someone else decides");

  // a hiring manager: the same field, no company-wide link (only owners and admins change the company), and they may decide
  await hank.goto(`/roles/${roleId}`);
  const hanks = cardOn(hank);
  await expect(hanks).toBeVisible({ timeout: 30_000 });
  await expect(hanks.getByRole("link", { name: "Use for every job" })).toHaveCount(0);
  await expect(hanks.getByRole("link", { name: /Settings/ })).toHaveCount(0);
  await hanks.getByLabel("A short description of the benefits").fill(WORDS);
  await hanks.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved(hank)).toBeVisible({ timeout: 30_000 });
  const hanksApprove = hanks.getByRole("button", { name: "Approve and publish" });
  await expect(hanksApprove).not.toHaveAttribute("aria-disabled", "true");

  // the owner who started it, left on the old page: a second Save is refused calmly and the page catches up
  await mine.getByLabel("A short description of the benefits").fill("Other words.");
  await mine.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "This version already describes the benefits." })).toBeVisible({ timeout: 30_000 });
  await expect(mine.getByLabel("A short description of the benefits")).toHaveCount(0, { timeout: 30_000 });
  await expect(myApprove).toHaveAttribute("aria-disabled", "true");
  await expect(why).toBeVisible();

  // the other owner, who did nothing but open it: Approve is live, and it opens the job
  await olive.goto(`/roles/${roleId}`);
  const olives = cardOn(olive);
  await expect(olives).toBeVisible({ timeout: 30_000 });
  const oliveApprove = olives.getByRole("button", { name: "Approve and publish" });
  await expect(oliveApprove).not.toHaveAttribute("aria-disabled", "true");
  await oliveApprove.click();
  await expect(olive.getByRole("dialog", { name: "Your job is approved" })).toBeVisible({ timeout: 30_000 });
  await olive.context().close();
  await hank.context().close();
});

test("a change that makes a live job remote: Approve this version, the first press goes to the wording, the next to the benefits", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `remote-live+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Remote Live ${run}`);
  const roleId = await draftThroughTheApi(page, baseURL!, ON_SITE_JOB);
  type Role = { status: string; currentPacket: { packet: { identity: { remotePolicy: string }; description: { publicJobDescription: string } } } };
  const role = async () => await (await page.request.get(`${baseURL}/api/v1/roles/${roleId}`)).json() as Role;
  await expect.poll(async () => (await page.request.post(`${baseURL}/api/v1/roles/${roleId}/approve`, { data: { version: 1 } })).status(), { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await role()).status, { timeout: 30_000 }).toBe("open");
  const packet = (await role()).currentPacket.packet;
  packet.identity.remotePolicy = "remote";
  packet.description.publicJobDescription = `${packet.description.publicJobDescription} No employment gaps.`;
  expect((await page.request.post(`${baseURL}/api/v1/roles/${roleId}/packets`, { data: { packet, changeSummary: "Fully remote now" } })).ok()).toBeTruthy();

  await page.goto(`/roles/${roleId}`);
  const card = cardOn(page, /^Approve version 2 of /);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const approve = card.getByRole("button", { name: "Approve this version" });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(card.getByText(/keeps running on version 1/)).toBeVisible();
  await expect(card.getByText(/^What changed: Fully remote now/)).toBeVisible();
  await expectAccessible(page, "a live job's change held by its wording and the law");

  // the wording comes first, as the server refuses it first
  await approve.click({ force: true });
  await expect(card.getByRole("button", { name: "Change the wording" })).toBeFocused();
  await card.getByRole("button", { name: "Keep it…" }).click();
  await card.getByLabel(/Why keep it/).fill("We only mean recent hands-on practice, nothing else.");
  await card.getByRole("button", { name: "Keep it, with this reason" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Kept, with your reason." })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/kept it on/)).toBeVisible({ timeout: 30_000 });

  // then the law: the same box, and Approve wakes for the same version
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await approve.click({ force: true });
  const field = card.getByLabel("A short description of the benefits");
  await expect(field).toBeFocused();
  // Enter saves, as in any form
  await field.fill(WORDS);
  await field.press("Enter");
  await expect(saved(page)).toBeVisible({ timeout: 30_000 });
  await expect(approve).not.toHaveAttribute("aria-disabled", "true");
  await approve.click();
  await expect(page.getByRole("dialog", { name: "Your change is approved" })).toBeVisible({ timeout: 30_000 });
});

test("a pay range the law cannot read stays a real edit: 'Edit the pay' opens the editor at the pay", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await signIn(page, { email: `remote-pay+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Remote Pay ${run}`);
  const roleId = await draftThroughTheApi(page, baseURL!, ON_SITE_JOB);
  const { currentPacket } = await (await page.request.get(`${baseURL}/api/v1/roles/${roleId}`)).json() as { currentPacket: { packet: { identity: { locations: unknown[] }; compensation: { min: number } } } };
  currentPacket.packet.identity.locations = [{ city: "Irvine", region: "CA", country: "US" }];
  currentPacket.packet.compensation.min = 0;
  expect((await page.request.post(`${baseURL}/api/v1/roles/${roleId}/packets`, { data: { packet: currentPacket.packet, changeSummary: "No pay yet" } })).ok()).toBeTruthy();
  await page.goto(`/roles/${roleId}`);
  const card = cardOn(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Approve and publish" })).toHaveAttribute("aria-disabled", "true");
  await expect(card.getByText(/^Pay range on the job ad\./)).toBeVisible();
  await card.getByRole("button", { name: "Edit the pay" }).click();
  const editor = page.getByRole("dialog", { name: "Edit the role" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Paid", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  // plain Edit opens it at the top, with nothing passed along as a section
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Paid", { exact: true })).not.toBeFocused();
});
