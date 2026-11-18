import { expect, test } from "@playwright/test";
import {
  PERSONAS, applicationForm, createCompanyThroughTheForm, doTheAiInterview, expectAccessible, expectTheReceipt, fillTheApplication, noSidewaysScroll, publishedJobThroughTheApi, signIn,
  skipWithoutFakeSignIn, statusPathFromEmail, waitForLink, type Applicant,
} from "./helpers";

/**
 * The candidate's own journey on a phone, where candidates are: the job page opened from an Indeed post's Apply link,
 * the application form, the receipt, the status page from their email and "Lost your link?"; then, once the team has
 * shortlisted them, the AI interview from its emailed link: its first page, the chat, their answers to check, and
 * "Thanks, your answers are sent". Every page is checked with axe and for sideways scrolling on the phone. The owner's
 * side (the company, the job, the shortlist) is done through the API in a browser of its own, so the journey stays on
 * the candidate's pages. Everything is synthetic; every provider is a stand-in.
 */
const run = Date.now().toString(36);

test.describe("candidate journey on a phone", () => {
  skipWithoutFakeSignIn();

  test("job page, application, receipt and status page; then the AI interview from its emailed link, all accessible on a phone", async ({ page, browser, baseURL }) => {
    test.setTimeout(600_000);
    const base = baseURL!;
    const desk = await browser.newContext({ baseURL: base });
    const owner = await desk.newPage();
    await signIn(owner, { email: `owner+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(owner, `Brightline Phone ${run}`);
    const job = await publishedJobThroughTheApi(owner.request, base);
    const maria: Applicant = { first: "Maria", last: "Reyes", email: `maria.reyes+${run}@example.com`, resume: PERSONAS.strong.resume };

    try {
      // ---- the job page: the employer named, the structured data present, Apply always on the screen ----------------------
      await page.goto(`${job.jobUrl}?src=indeed`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(job.title);
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
      await expectAccessible(page, "the job page");
      await noSidewaysScroll(page, "the job page");
      const applyNow = page.getByRole("link", { name: "Apply now" }).last();
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(applyNow).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 3)));
      await expect(applyNow).toBeInViewport();
      await applyNow.click();

      // ---- the form, Send, and the receipt --------------------------------------------------------------------------------------
      await page.waitForURL(new RegExp(`/careers/${job.slug}/jobs/${job.roleId}/apply\\?src=indeed$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(applicationForm(page).getByRole("checkbox", { name: /I have read the full notice above/ })).not.toBeChecked();
      await expectAccessible(page, "the application form");
      await noSidewaysScroll(page, "the application form");
      await fillTheApplication(page, maria);
      await noSidewaysScroll(page, "the application form, filled in");
      await applicationForm(page).getByRole("button", { name: "Send my application" }).click();
      await expectTheReceipt(page);
      await expectAccessible(page, "the receipt");
      await noSidewaysScroll(page, "the receipt");

      // ---- their own status page, from the email, and the way back to it ----------------------------------------------------------
      const statusPath = await statusPathFromEmail(owner.request, base, maria.email);
      await page.goto(statusPath);
      const steps = page.getByRole("list", { name: "Where your application is" });
      await expect(steps).toContainText("Under review", { timeout: 30_000 });
      await expect(steps).not.toContainText("AI interview");
      await expectAccessible(page, "the status page");
      await noSidewaysScroll(page, "the status page");
      await page.goto("/c/link-request");
      await expect(page.getByRole("heading", { level: 1, name: "Lost your link?" })).toBeVisible();
      await expectAccessible(page, "Lost your link?");
      await noSidewaysScroll(page, "Lost your link?");

      // ---- the team shortlists them once the resume is read: the AI interview comes by email ---------------------------------------
      const list = `${base}/api/v1/roles/${job.roleId}/applications?tab=new`;
      type Row = { id: string; actions: Array<{ action: string; allowed: boolean }> };
      let row: Row | undefined;
      await expect.poll(async () => {
        row = ((await (await owner.request.get(list)).json()) as { rows: Row[] }).rows[0];
        return row?.actions.find((a) => a.action === "shortlist")?.allowed ?? false;
      }, { timeout: 180_000, intervals: [2_000], message: "the resume read, so Shortlist may be pressed" }).toBe(true);
      const shortlisted = await owner.request.post(`${base}/api/v1/applications/${row!.id}/actions`, { data: { action: "shortlist" } });
      expect(shortlisted.ok(), await shortlisted.text()).toBeTruthy();
      const invitation = await waitForLink(owner.request, base, { to: maria.email, path: "/c/screen/" });

      // the status page now has the AI interview as a step, with the way to it
      await page.goto(statusPath);
      await expect(steps).toContainText("AI interview", { timeout: 30_000 });
      await expect(page.locator('a[href*="/c/screen/"]').first()).toBeVisible();
      await expectAccessible(page, "the status page, shortlisted");
      await noSidewaysScroll(page, "the status page, shortlisted");

      // ---- the AI interview: its first page, the chat, their answers, sent ---------------------------------------------------------
      await page.goto(invitation.path);
      await expect(page.getByText(/AI assistant/).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("I'd rather talk to a person").first()).toBeVisible();
      await expectAccessible(page, "the AI interview's first page");
      await noSidewaysScroll(page, "the AI interview's first page");
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await expect.poll(async () => (await page.getByLabel(/^Your reply/).isVisible()) || (await page.getByRole("button", { name: "Yes", exact: true }).isVisible()), { timeout: 60_000, message: "the AI interview's first question" }).toBe(true);
      await expect(page.getByText(/only when you press Send my answers/).first()).toBeVisible();
      await expectAccessible(page, "the AI interview's chat");
      await noSidewaysScroll(page, "the AI interview's chat");
      await doTheAiInterview(page, PERSONAS.strong.says, "the chat");
      await expectAccessible(page, "the AI interview, answers sent");
      await noSidewaysScroll(page, "the AI interview, answers sent");

      // the team has it now: she is under Interviewed
      await expect.poll(async () => ((await (await owner.request.get(`${base}/api/v1/roles/${job.roleId}/applications?tab=interviewed`)).json()) as { rows: Row[] }).rows.length, { timeout: 60_000, message: "the candidate under Interviewed" }).toBe(1);
    } finally {
      await desk.close();
    }
  });
});
