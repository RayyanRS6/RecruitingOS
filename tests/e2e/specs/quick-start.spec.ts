import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, gotoSettled, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The quick start for a new job (Wave S2 K2, Wave S3) in a real browser with the fake AI: /roles/new offers the quick
 * questions; ten small steps, one question each with "Step N of 10"; the review lists every answer with its Edit; "Write
 * the job post" hands everything to the job builder, which shows the title and the pay. A step and the review are
 * checked against WCAG 2.1 AA with axe.
 */
const run = Date.now().toString(36);

async function step(page: Page, n: number, question: string) {
  await expect(page.getByText(new RegExp(`^Step ${n} of 10`))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true }).click();

test.describe("the quick start", () => {
  skipWithoutFakeSignIn();

  test("ten quick questions, a review, then the job builder with the title and the pay", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, { email: `quick+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Quick ${run}`);

    await gotoSettled(page, "/roles/new");
    await expect(page.getByRole("heading", { level: 1, name: "Who are you hiring?" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Start the quick questions" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?way=quick/);

    // 1. the title
    await step(page, 1, "What is the job title?");
    await page.getByLabel("Job title").fill("Dental assistant");
    await expectAccessible(page, "quick start, first step");
    await next(page);

    // 2. the kind of job
    await step(page, 2, "What kind of job is it?");
    await page.getByRole("radio", { name: "Full time" }).check({ force: true });
    await next(page);

    // 3. where
    await step(page, 3, "Where will they work?");
    await page.getByRole("radio", { name: "On site" }).check({ force: true });
    await page.getByLabel("Where is the job?").fill("Austin, TX");
    await next(page);

    // 4. experience, and anyone with less
    await step(page, 4, "How much experience do they need?");
    await page.getByRole("radio", { name: "1+ year" }).check({ force: true });
    await page.getByRole("radio", { name: "Still consider them" }).check({ force: true });
    await next(page);

    // 5. pay, by the hour
    await step(page, 5, "What does it pay?");
    await page.getByRole("button", { name: "By the hour" }).click();
    await page.getByLabel(/^Lowest/).fill("20");
    await page.getByLabel(/^Highest/).fill("24");
    await expectAccessible(page, "quick start, pay step");
    await next(page);

    // 6. no closing date
    await step(page, 6, "When do applications close?");
    await page.getByRole("checkbox", { name: "No closing date" }).check({ force: true });
    await next(page);

    // 7. two must-haves of their own (Enter in the box adds the words)
    await step(page, 7, "Which skills are a must?");
    const must = page.getByRole("textbox", { name: "Add a must-have" });
    await must.fill("Dentrix experience");
    await must.press("Enter");
    await must.fill("X-ray certificate");
    await must.press("Enter");
    const added = page.getByRole("list", { name: "Added by you" });
    await expect(added).toContainText("Dentrix experience");
    await expect(added).toContainText("X-ray certificate");
    await next(page);

    // 8. no deal-breakers
    await step(page, 8, "What rules someone out?");
    await page.getByRole("checkbox", { name: "None" }).check({ force: true });
    await next(page);

    // 9. the suggested questions stay as they are
    await step(page, 9, "What should every applicant answer?");
    await expect(page.getByRole("group", { name: "What should every applicant answer?" }).getByRole("checkbox").first()).toBeChecked();
    await next(page);

    // 10. the review: one row a step, each with its Edit
    await step(page, 10, "Check your answers");
    const answers = page.getByRole("list", { name: "Your answers" });
    await expect(answers).toContainText("Dental assistant");
    await expect(answers).toContainText("Full time");
    await expect(answers).toContainText("On site · Austin, TX");
    await expect(answers).toContainText("1+ year · anyone with less is still considered");
    await expect(answers).toContainText(/\$20\s*(–|-|to)\s*\$24/);
    await expect(answers).toContainText("No closing date");
    await expect(answers).toContainText("Dentrix experience");
    await expect(answers).toContainText("X-ray certificate");
    await expect(answers).toContainText("None");
    await expect(answers).toContainText(/\d+ on the form/);
    await expect(answers.getByRole("button", { name: /^Edit / })).toHaveCount(9);
    await expectAccessible(page, "quick start review");

    // Write the job post: the job builder opens on the new draft with the title and the pay
    await page.getByRole("button", { name: "Write the job post" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 90_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Dental assistant/i, { timeout: 60_000 });
    await expect(page.getByText(/\$20\s*(–|-|to)\s*\$24/).first()).toBeVisible({ timeout: 60_000 });
  });
});
