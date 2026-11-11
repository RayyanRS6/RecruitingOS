import { expect, test, type Page } from "@playwright/test";
import { PERSONAS, applyThroughTheForm, createCompanyThroughTheForm, expectAccessible, liveJobThroughTheApi, openThePanel, setADateAndTime, signIn, skipWithoutFakeSignIn, waitForTheAiInterview, type Applicant } from "./helpers";

/**
 * When email to candidates does not arrive (the dead ends' rank 1: every candidate step after the first page lives in an
 * email, and on the live site every email failed while Settings said otherwise). This runs on a server whose email never
 * arrives (E2E_EMAIL_PROVIDER=postmark with no token: every send fails at once), so nothing can be read from an outbox, and
 * everything is asserted on the owner's screens, as an owner would find out: Home's card naming who to phone, the
 * candidate's page opened from it, the message marked as not delivered, the notice that opens that candidate, Settings
 * saying candidate email is not being sent, a booked interview that says its email could not be delivered, a decision
 * message that fails going back to "not told yet", and an invitation that says its email failed and offers its link.
 *
 * The candidate's own pages still work: they apply and reach their AI interview without any email. In any other run (the
 * fake email adapter) this is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

test.describe("when email does not arrive", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.E2E_EMAIL_PROVIDER !== "postmark", "needs a server whose email never arrives: E2E_EMAIL_PROVIDER=postmark with no token");

  test("Home names who to phone, the candidate's page and the notice say it, Settings is honest, a booking and a decision say they did not arrive, and an invitation offers its link", async ({ page, browser, baseURL }) => {
    test.setTimeout(600_000);
    const base = baseURL!;
    const company = `Quiet Mail Dental ${run}`;
    await signIn(page, { email: `owner+${run}@quietmail.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    const job = await liveJobThroughTheApi(page.request, base);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };

    // she applies and reaches her AI interview on the page itself: no email is needed for that
    const a = await applyThroughTheForm(browser, base, job.jobUrl, ana);
    await waitForTheAiInterview(a.page);
    await expect(a.page.getByText("Your application is sent.")).toBeVisible();
    await a.context.close();

    // Home: the email that did not arrive, with who to phone and how, in view
    await expect(async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: /^1 email to candidates did not arrive$/ })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await expect(page.getByText("Phone them, or write to them yourself.")).toBeVisible();
    const who = page.getByRole("list", { name: "Who did not get an email" });
    await expect(who.getByRole("link", { name: "Ana Holt" })).toBeVisible();
    await expect(who.getByText(ana.email)).toBeVisible();
    await expect(who.getByRole("link", { name: /714/ })).toHaveAttribute("href", /^tel:\+?1?7145550103$/);
    await expect(who.getByText(job.title)).toBeVisible();
    await expectAccessible(page, "Home with an email that did not arrive");

    // her name opens her page, where the message says it was not delivered
    await who.getByRole("link", { name: "Ana Holt" }).click();
    const panel = page.getByRole("dialog", { name: "Ana Holt" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("tab", { name: /^Messages/ }).click();
    await expect(panel.getByText("Could not be delivered").first()).toBeVisible({ timeout: 30_000 });

    // the notice says the same in plain words and opens her
    await page.goto("/updates");
    const notice = page.getByRole("listitem").filter({ hasText: "An email to Ana Holt did not arrive" });
    await expect(notice).toHaveCount(1, { timeout: 30_000 });
    await expect(notice).toContainText("could not be delivered. Phone them, or write to them another way.");
    await expect(notice).not.toContainText(/postmark|token|not configured/i);
    await notice.getByRole("link", { name: "Open Ana Holt" }).click();
    await expect(page.getByRole("dialog", { name: "Ana Holt" })).toBeVisible({ timeout: 30_000 });

    // Settings never says candidate email works when it does not
    await page.goto("/setup?tab=security");
    const services = page.locator("#setup-services");
    const emailRow = services.getByRole("row").filter({ hasText: "Postmark" });
    await expect(emailRow).toContainText("Not connected", { timeout: 30_000 });
    await expect(emailRow).toContainText("candidate email is not being sent");
    await expect(services).not.toContainText("dedicated ITS domain");

    // a booked time: the press is honest (on its way, never "sent"), and once it fails the panel and the sheet say so
    const p = await openThePanel(page, job.roleId, "Ana Holt");
    await p.getByRole("button", { name: /^Stage: / }).click();
    await p.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await setADateAndTime(p.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: "Ana", daysAhead: 3, time: "10:00", place: "By phone" });
    await expect(toast(page, /Booked\..*The email to Ana is on its way\./)).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await page.goto("/interviews");
      await expect(page.getByRole("row").filter({ hasText: "Ana Holt" })).toContainText("Email not delivered", { timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await page.getByRole("row").filter({ hasText: "Ana Holt" }).getByRole("link", { name: "Open", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("The email to Ana could not be delivered. Tell them yourself.")).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "an interview whose email could not be delivered");

    // a decision message that cannot arrive goes back to "not told yet", so nobody thinks she was told
    const q = await openThePanel(page, job.roleId, "Ana Holt");
    await q.getByRole("button", { name: /^Stage: / }).click();
    await q.getByRole("menuitemradio", { name: /^Not moving forward/ }).click();
    await q.getByRole("button", { name: "Confirm: not moving forward" }).click();
    await expect(toast(page, /Moved to Not moving forward\./)).toBeVisible({ timeout: 30_000 });
    const tell = q.locator(".card", { has: page.getByRole("heading", { name: "Ana has not been told yet" }) });
    await tell.getByRole("button", { name: "Send message" }).click();
    await tell.getByRole("button", { name: /^Send/ }).last().click();
    // after the Undo window it is tried, fails, and the card is back
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("dialog", { name: "Ana Holt" }).getByRole("heading", { name: "Ana has not been told yet" })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [5_000] });

    // an invitation whose email failed says so on its row, and its link can be copied to send by hand
    await page.goto("/setup?tab=team");
    const team = page.locator("#setup-team");
    await team.getByLabel("Invite by email").fill(`wes+${run}@quietmail.test`);
    await team.getByLabel("Name (optional)").fill("Wes Park");
    await team.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(toast(page, /^Invited\./)).toBeVisible({ timeout: 30_000 });
    await expect(team.getByLabel("Invitation link")).toHaveValue(/^https?:\/\/\S+$/);
    await expect(async () => {
      await page.reload();
      await expect(page.locator("#setup-team").getByText("Email failed", { exact: true })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await expect(page.locator("#setup-team").getByRole("button", { name: "Copy invitation link" })).toBeVisible();
    await expectAccessible(page, "an invitation whose email failed");
  });
});
