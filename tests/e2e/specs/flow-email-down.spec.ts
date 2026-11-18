import { expect, test } from "@playwright/test";
import { PERSONAS, applyThroughTheForm, candidateRow, createCompanyThroughTheForm, expectAccessible, publishedJobThroughTheApi, said, scoreOn, signIn, skipWithoutFakeSignIn, type Applicant } from "./helpers";

/**
 * When email does not arrive. This runs on a server whose email never arrives (E2E_EMAIL_PROVIDER=postmark with no
 * token: every send fails at once), so nothing can be read from an outbox and everything is asserted on the screens.
 * A candidate still applies and reaches the receipt, and the team still reads them: neither needs an email. An
 * invitation to a teammate says its email did not arrive and offers its link to send by hand. In any other run (the
 * fake email adapter) this is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);

test.describe("when email does not arrive", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.E2E_EMAIL_PROVIDER !== "postmark", "needs a server whose email never arrives: E2E_EMAIL_PROVIDER=postmark with no token");

  test("a candidate still applies and is read by the team; an invitation says its email did not arrive and offers its link", async ({ page, browser, baseURL }) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    await signIn(page, { email: `owner+${run}@quietmail.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Quiet Mail Dental ${run}`);
    const job = await publishedJobThroughTheApi(page.request, base);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };

    // she applies and reads the receipt on the page itself; the team reads her resume's score
    const a = await applyThroughTheForm(browser, base, job.jobUrl, ana);
    await expect(a.page.getByRole("heading", { level: 1 })).toContainText("Thanks, we have your application");
    await a.context.close();
    await page.goto(`/roles/${job.roleId}/talent`);
    expect(await scoreOn(candidateRow(page, "Ana Holt"), "Resume match")).toBeGreaterThanOrEqual(0);

    // an invitation: the link is on the page at once, to copy and send by hand
    const wes = { email: `wes+${run}@quietmail.test`, name: "Wes Park" };
    await page.goto("/setup#setup-team");
    const team = page.locator("#setup-team");
    await team.getByLabel("Email", { exact: true }).fill(wes.email);
    await team.getByLabel("Name (optional)").fill(wes.name);
    await team.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(said(page, "Invited.")).toBeVisible({ timeout: 30_000 });
    await expect(team.getByLabel("Invitation link")).toHaveValue(/^https?:\/\/\S+$/);
    await expect(team.getByRole("button", { name: `Copy the invitation link for ${wes.email}` })).toBeVisible();

    // once the send has failed, the invitation's row says so, and Send again offers the link again
    const invited = page.locator("#setup-team").getByRole("listitem").filter({ hasText: wes.name });
    await expect(async () => {
      await page.reload();
      await expect(invited).toContainText("Email did not arrive", { timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await expect(team.getByLabel("Invitation link")).toHaveCount(0);
    await invited.getByRole("button", { name: `Send the invitation to ${wes.email} again` }).click();
    await expect(team.getByLabel("Invitation link")).toHaveValue(/^https?:\/\/\S+$/, { timeout: 30_000 });
    await expectAccessible(page, "an invitation whose email did not arrive");
  });
});
