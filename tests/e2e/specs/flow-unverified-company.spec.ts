import { expect, test, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, createCompanyThroughTheForm, emailsTo, expectAccessible, expectNoEmail, gotoSettled, liveJobThroughTheApi, openThePanel, setADateAndTime, signIn,
  signInAsNadine, skipWithoutFakeSignIn, waitForEmail, type Applicant,
} from "./helpers";

/**
 * While ITS has not confirmed the company (founder decision B7), in a real browser: the company's pages are offline and
 * candidate emails wait. A person can still book an interview, and every screen says the truth: the button says Book, not
 * "Book and email", the line before the press and the toast after it say the email waits for ITS, the Interviews list and
 * the sheet say so, and nothing reaches the candidate. When ITS confirms the company again, the booking's email goes, once,
 * and the screens move on. The e2e server confirms new companies at once (COMPANY_CHECK=auto), so here an administrator
 * takes the confirmation back from the console, as company-check.spec.ts does, and gives it again.
 */
const run = Date.now().toString(36);
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

test.describe("a company ITS has not confirmed", () => {
  skipWithoutFakeSignIn();

  test("a booking while the check is taken back: Book, the email waits and every screen says so; confirmed again, it goes once", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const company = `Unconfirmed Dental ${run}`;
    await signIn(page, { email: `owner+${run}@unconfirmed.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    const job = await liveJobThroughTheApi(page.request, base);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };
    await applicantThroughTheApi(page.request, base, job, ana);

    // ITS takes the confirmation back
    const nadine = await signInAsNadine(browser);
    await gotoSettled(nadine.page, "/admin/customers");
    await nadine.page.getByRole("row", { name: new RegExp(company) }).getByRole("button", { name: `Open ${company}` }).click();
    const drawer = nadine.page.getByRole("dialog", { name: company });
    await drawer.getByRole("tab", { name: "ITS check" }).click();
    await drawer.getByLabel("Why you are taking it back").fill("The website does not match the company.");
    await drawer.getByRole("button", { name: "Take back the confirmation" }).click();
    await drawer.getByRole("button", { name: "Yes, take it back" }).click();
    await expect(toast(nadine.page, /is no longer confirmed/)).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(`${base}/careers/${job.slug}/jobs/${job.roleId}`)).status()).toBe(404);

    // the form says before the press that the email waits, and its button does not promise an email
    const panel = await openThePanel(page, job.roleId, "Ana Holt");
    await panel.getByRole("button", { name: /^Stage: / }).click();
    await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
    await expect(form.getByRole("button", { name: "Book", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("button", { name: /email Ana/ })).toHaveCount(0);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await form.getByLabel("Date", { exact: true }).fill(day);
    await form.getByLabel(/^Time \(/).fill("10:30");
    await expect(form.getByText("The email to Ana waits for ITS to confirm your company.")).toBeVisible();
    await expectAccessible(page, "setting a time while the email waits for ITS");
    await setADateAndTime(form, { first: "Ana", daysAhead: 3, time: "10:30", place: "By phone" });
    await expect(toast(page, /Booked\..*Ana has not been told: the email waits for ITS to confirm your company\./)).toBeVisible({ timeout: 30_000 });
    await expectNoEmail(page.request, base, { to: ana.email, subject: /^Your interview: /, ms: 5_000 });

    // Interviews and the sheet say the same
    await page.goto("/interviews");
    const row = page.getByRole("row").filter({ hasText: "Ana Holt" });
    await expect(row).toContainText("Scheduled", { timeout: 30_000 });
    await expect(row).toContainText("Email waits for the ITS check");
    await expect(row).not.toContainText("Waiting on the candidate");
    await row.getByRole("link", { name: "Open", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Ana has not been told: the email waits for ITS to confirm your company.")).toBeVisible({ timeout: 30_000 });

    // ITS confirms the company again: the booking's email goes, once, and the screens move on
    await drawer.getByLabel("How you checked the company").fill("Spoke with the owner; the website was updated.");
    await drawer.getByRole("button", { name: "Confirm the company" }).click();
    await drawer.getByRole("button", { name: "Yes, confirm it" }).click();
    await expect(toast(nadine.page, /is confirmed/)).toBeVisible({ timeout: 30_000 });
    await nadine.context.close();
    await waitForEmail(page.request, base, { to: ana.email, subject: /^Your interview: /, says: ["Hi Ana,", `Good news: ${company} would like to interview you for the ${job.title} position.`, `By phone: ${company} will call you. Reply with the best number to reach you.`] });
    await expect.poll(async () => (await emailsTo(page.request, base, ana.email, /^Your interview: /)).length, { timeout: 10_000 }).toBe(1);
    await expect(async () => {
      await page.goto("/interviews");
      await expect(page.getByRole("row").filter({ hasText: "Ana Holt" })).not.toContainText("Email waits for the ITS check", { timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    expect((await page.request.get(`${base}/careers/${job.slug}/jobs/${job.roleId}`)).status()).toBe(200);
  });
});
