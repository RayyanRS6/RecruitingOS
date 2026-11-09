import { expect, test } from "@playwright/test";
import { PERSONAS, applyThroughTheForm, createCompanyThroughTheForm, emailsTo, expectAccessible, liveJobThroughTheApi, outbox, signIn, skipWithoutFakeSignIn, waitForTheAiInterview, type Applicant } from "./helpers";

/**
 * Sharing a live job and posting it on a board from the company's own account, on the Free plan (the team posts; ITS posts
 * only on plans with ITS time), in a real browser. A place gets a tracked link of its own; someone applies through it, the
 * visit is counted and the applicant's row says where they came from. Home's "One step" card leads to the board's steps;
 * the public address of the posting is recorded and checked. Closing the job leaves the board still showing it, so Home
 * says "Still posted on Indeed" until it is ticked off. Nothing here emails ITS on Free.
 */
const run = Date.now().toString(36);

test.describe("sharing a job and posting it on a board", () => {
  skipWithoutFakeSignIn();

  test("a tracked link counts its visit and names the source; Home's One step leads to the board; closing leaves it to tick off", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const company = `Sharewell Dental ${run}`;
    await signIn(page, { email: `owner+${run}@sharewell.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    const job = await liveJobThroughTheApi(page.request, base);

    // a referral gets its own link, with its visits
    const share = page.locator("#share");
    const places = share.getByRole("list", { name: "Places with a link of their own" });
    /**
     * The Share tab, loaded afresh and settled, with the fold of places open (opened once the tab has drawn its links, as a
     * person would). The page already on the job is reloaded: going to the same address with only "#share" again would
     * not load it (the browser just scrolls), and the counts would be the ones drawn before.
     */
    const openThePlaces = async () => {
      if (new URL(page.url()).pathname === `/roles/${job.roleId}`) await page.reload();
      else await page.goto(`/roles/${job.roleId}?tab=posting#share`);
      await expect(share.locator("code").first()).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        if (!(await places.isVisible())) await share.getByText("Links for a referral, a school or a group", { exact: true }).click();
        await expect(places).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
    };
    await openThePlaces();
    await places.getByRole("listitem").first().getByRole("button", { name: "Make a link to copy" }).click();
    const referral = places.getByRole("listitem").first();
    await expect(referral.getByText("0 visits")).toBeVisible({ timeout: 30_000 });
    const link = ((await referral.locator("code").textContent()) ?? "").trim();
    expect(link).toMatch(/^https?:\/\/[^/]+\/a\/[a-z0-9]{12}$/);
    await expectAccessible(page, "the Share tab with a referral link");

    // someone applies through it, in a browser of their own: the visit counts, and their row says where they came from
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };
    const a = await applyThroughTheForm(browser, base, new URL(link).pathname, ana);
    await waitForTheAiInterview(a.page);
    await a.context.close();
    await openThePlaces();
    await expect(places.getByRole("listitem").first().getByText("1 visit")).toBeVisible({ timeout: 30_000 });
    await page.goto(`/roles/${job.roleId}/talent`);
    const row = page.locator(".talent-row").filter({ hasText: "Ana Holt" });
    await expect(row).toContainText(/referral/i, { timeout: 30_000 });
    await expect(row).not.toContainText("careers page");

    // Home's one step: post it on Indeed from the company's own account, with the steps and the board's own apply link
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `${job.title}: post it on Indeed from your own account` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "See instructions" }).click();
    await expect(page).toHaveURL(new RegExp(`/roles/${job.roleId}\\?tab=posting$`));
    const indeed = page.locator(".card", { has: page.getByRole("heading", { name: "Indeed" }) });
    await expect(indeed.getByText("Ready to post")).toBeVisible({ timeout: 30_000 });
    await expect(indeed.getByText("Posted by your team from your own account")).toBeVisible();
    await expect(indeed.locator("code").filter({ hasText: /\/a\/[a-z0-9]{12}$/ })).toBeVisible();
    // the public address, recorded and checked
    await indeed.getByLabel("Record the public address of the posting").fill("https://www.indeed.com/viewjob?jk=a1b2c3d4e5");
    await indeed.getByRole("button", { name: "Record the public URL" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Address recorded. Checking the link now." })).toBeVisible({ timeout: 30_000 });
    // once nothing waits on the team the boards' fold starts closed, so it is opened to read the card
    await expect(async () => {
      await page.reload();
      const steps = page.getByText(/^Each board and page, step by step/);
      await expect(steps).toBeVisible({ timeout: 30_000 });
      const card = page.locator(".card", { has: page.getByRole("heading", { name: "Indeed" }) });
      if (!(await card.isVisible())) await steps.click();
      await expect(card.getByText("Live and verified")).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `${job.title}: post it on Indeed from your own account` })).toHaveCount(0, { timeout: 30_000 });

    // the job closes; Indeed still shows it, so Home says so until it is ticked off on the Share tab
    await page.goto(`/roles/${job.roleId}`);
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Close the job" }).click();
    const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Close this job" }) });
    await card.getByLabel("Outcome").selectOption("no_hire");
    await card.getByRole("button", { name: "Confirm and close the job" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Role closed/ })).toBeVisible({ timeout: 30_000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Still posted on Indeed" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Open the Share tab" }).click();
    const removed = page.getByRole("checkbox", { name: /^Removed from this board/ });
    await expect(removed).toBeVisible({ timeout: 30_000 });
    // the box ticks once the server has recorded it (it shows what is recorded, not the click), with the day it was confirmed
    await removed.click();
    await expect(page.getByRole("status").filter({ hasText: "Recorded: removed from Indeed." })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("checkbox", { name: /^Removed from this board \(confirmed / })).toBeChecked({ timeout: 30_000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Still posted on Indeed" })).toHaveCount(0);

    // on Free nothing went to the ITS queue about this job
    expect((await outbox(page.request, base)).filter((m) => m.subject.startsWith("[post_job]") && m.subject.includes(company))).toEqual([]);
    expect((await emailsTo(page.request, base, "recruiters@its.localhost")).filter((m) => m.text.includes(company))).toEqual([]);
  });
});
