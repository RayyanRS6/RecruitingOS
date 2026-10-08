import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Panels opened from panels (Wave DS, docs/07 Drawer): a candidate's drawer with "Bring in a recruiter" opened from
 * inside it. Escape closes the top one first, the page behind never scrolls while either is open, and the page scrolls
 * again however they close, including both at once when the person presses Back. Everything is synthetic.
 */
const run = Date.now().toString(36);

test.describe("a sheet opened from a candidate's drawer", () => {
  skipWithoutFakeSignIn();
  test("Escape closes the top panel first, and the page scrolls again once both are gone, Back included", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@panels.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Panels Dental ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");
    const pageScroll = () => page.evaluate(() => document.body.style.overflow);

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const maria = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(maria).toBeVisible();
    await maria.getByRole("button", { name: "Bring in a recruiter" }).first().click();
    const ask = page.getByRole("dialog", { name: "Bring in a recruiter" });
    await expect(ask).toBeVisible();
    expect(await pageScroll()).toBe("hidden");

    // Escape: the sheet on top closes, the candidate stays open, and the page behind still does not scroll
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(maria).toBeVisible();
    expect(await pageScroll()).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(maria).toHaveCount(0);
    expect(await pageScroll()).toBe("");

    // Both open, then Back: the page goes away with both panels at once, and the next page scrolls
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    await maria.getByRole("button", { name: "Bring in a recruiter" }).first().click();
    await expect(ask).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)\.$/ })).toBeVisible({ timeout: 30_000 });
    await expect.poll(pageScroll).toBe("");
  });
});
