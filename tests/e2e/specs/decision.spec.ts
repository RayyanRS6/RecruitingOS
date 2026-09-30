import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The loop after an interview in a real browser (audit findings F6 and J13): the owner approves an interview, the
 * candidate books a time, the owner records that it took place from the interview sheet, follows the deep link to
 * the candidate's sheet, and records the decision there. Every page visited is checked against WCAG 2.1 AA with axe.
 * Everything is synthetic; every provider is a fake. Mirrors journey.spec.ts step for step up to the booking.
 */
const run = Date.now().toString(36);

test.describe("decision after an interview", () => {
  skipWithoutFakeSignIn();
  test("record the outcome on the interview sheet, then the decision on the candidate sheet through the deep link", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Dental ${run}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // the owner declares availability so times can be offered from her hours
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "My availability for interviews" })).toBeVisible();
    await page.getByRole("button", { name: "Save availability" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Availability saved/ })).toBeVisible();

    // the owner opens the candidate and approves an interview
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const sheet = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Interview", exact: true }).click();
    await expect(sheet.getByRole("heading", { name: "Approve an interview" })).toBeVisible();
    await sheet.getByRole("checkbox").first().check();
    await sheet.getByRole("button", { name: "Approve and offer times" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Interview approved/ })).toBeVisible();

    // the candidate picks a time from the status page
    await page.goto(seeded.statusPath);
    await expect(page.getByRole("link", { name: "Choose a time" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Choose a time" }).click();
    await expect(page.getByRole("heading", { name: /Pick a time/ })).toBeVisible();
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: "Confirm this time" }).click();
    await expect(page.getByRole("heading", { name: /confirmed|Booking your time/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible({ timeout: 30_000 });

    // the owner records that the interview took place; the candidate moves to "Interview done: decision needed"
    await page.goto("/interviews");
    await expect(page.getByRole("cell", { name: /Maria Reyes/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Open" }).first().click();
    const ivSheet = page.getByRole("dialog");
    await expect(ivSheet.getByRole("heading", { name: "Did it take place?" })).toBeVisible();
    await expectAccessible(page, "interview sheet before the outcome");
    await ivSheet.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Recorded/ })).toBeVisible();
    await expect(ivSheet.getByRole("heading", { name: "After the interview" })).toBeVisible();
    await expect(ivSheet.getByText("Nobody has recorded a decision yet")).toBeVisible();
    await expectAccessible(page, "interview sheet after the outcome");

    // "Record the decision" is the deep link: it opens the candidate's sheet directly, with the decision card on top
    await ivSheet.getByRole("link", { name: "Record the decision" }).click();
    await expect(page).toHaveURL(/\/talent\?open=/);
    const candidate = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(candidate).toBeVisible({ timeout: 30_000 });
    await expect(candidate.getByRole("heading", { name: "How did the interview go?" })).toBeVisible();
    await expect(candidate.getByText("Interview done: decision needed").first()).toBeVisible();
    await expectAccessible(page, "candidate sheet with the decision card");
    await candidate.getByRole("button", { name: "Finalist", exact: true }).click();
    await candidate.getByLabel(/What stood out/).fill("Calm, precise, asked good questions.");
    await candidate.getByRole("button", { name: "Confirm finalist" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Marked as a finalist/ })).toBeVisible();
    await expect(candidate.getByText("Finalist").first()).toBeVisible();
    await expect(candidate.getByRole("heading", { name: "How did the interview go?" })).toHaveCount(0);
    await expect(candidate.getByText(/Decision after the interview: finalist/)).toBeVisible();

    // closing the sheet clears the deep link from the address
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/open=/);

    // the interview sheet now shows the recorded decision and its note
    await page.goto("/interviews");
    await expect(page.getByRole("cell", { name: /Maria Reyes/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "Finalist", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page.getByRole("dialog").getByText("Decision: Finalist")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/Calm, precise/)).toBeVisible();
    await expectAccessible(page, "interview sheet with the decision");
  });
});
