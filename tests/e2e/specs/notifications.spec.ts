import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Email alerts and earlier updates (plan B3): an owner chooses in Setup how often each group of updates reaches them by
 * email (saved on click, with a toast that says what it did), sees the updates that are always emailed, and finds every
 * earlier update from Today on a page of its own where each can be marked read or unread. Everything is synthetic.
 */
const run = Date.now().toString(36);

test.describe("email alerts and earlier updates", () => {
  skipWithoutFakeSignIn();
  // the waiting room opens every interview after 40 to 90 seconds at least (Q14), so seeding an applicant takes longer
  test.slow();
  test("an owner chooses which updates are emailed, and finds every earlier update from Today", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@alerts.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Alerts Dental ${run}`);
    await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // Setup's Email alerts card: candidates come in the morning summary until the owner chooses otherwise
    await page.goto("/setup#setup-notifications");
    const card = page.locator("#setup-notifications");
    await expect(card.getByRole("heading", { name: "Email alerts" })).toBeVisible({ timeout: 30_000 });
    const candidates = card.getByRole("group", { name: "Emails about Candidates" });
    await expect(candidates.getByRole("button", { name: "Daily summary" })).toHaveAttribute("aria-pressed", "true");
    await candidates.getByRole("button", { name: "As it happens" }).click();
    await expect(page.getByText("Candidates: emailed as it happens.")).toBeVisible();
    await expect(candidates.getByRole("button", { name: "As it happens" })).toHaveAttribute("aria-pressed", "true");
    await expect(card).toContainText("Always emailed at once");
    await expect(card).toContainText("A candidate asks to talk to a person");
    await expectAccessible(page, "setup email alerts");
    // back to the usual settings in one click
    await card.getByRole("button", { name: "Go back to the usual settings" }).click();
    await expect(candidates.getByRole("button", { name: "Daily summary" })).toHaveAttribute("aria-pressed", "true");

    // Today leads to every earlier update
    await page.goto("/");
    await page.waitForLoadState("networkidle"); // Today still loading its cards can swap the link under the click
    await page.getByRole("link", { name: "See earlier updates" }).first().click();
    await expect(page).toHaveURL(/\/updates$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Updates");
    await expectAccessible(page, "updates");
    // The seeded applicant usually produced updates by now; when the worker has not run yet the page says there are none.
    const rows = page.getByRole("list", { name: "Updates" }).getByRole("listitem");
    await expect(rows.first().or(page.getByText("No updates yet"))).toBeVisible({ timeout: 30_000 }); // loaded, either way
    if (await rows.count()) {
      const first = rows.first();
      const toggle = first.getByRole("button", { name: /^Mark (read|unread):/ });
      const before = (await toggle.textContent())?.trim();
      await toggle.click();
      await expect(first.getByRole("button", { name: /^Mark (read|unread):/ })).not.toHaveText(before ?? "");
    } else {
      await expect(page.getByText("No updates yet")).toBeVisible();
    }
    await page.getByRole("button", { name: /^Unread/ }).click();
    await expect(page.getByRole("button", { name: /^Unread/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "Email alerts" }).click();
    await expect(page).toHaveURL(/\/setup#setup-notifications$/);
  });
});
