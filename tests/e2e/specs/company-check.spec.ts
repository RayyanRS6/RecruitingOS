import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The one-time ITS check (founder decision B7) and the getting-started card (plan B2), through the real pages. The e2e
 * server confirms new companies at once (COMPANY_CHECK=auto in playwright.config.ts) so the other journeys have public
 * pages; here an ITS administrator takes the confirmation back from the console and gives it again, and the careers page
 * and the owner's Today follow.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("getting started guides a new owner; taking the ITS confirmation back puts the careers page offline and Today says why", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `owner+${run}@checked.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Checked Dental ${run}`);

  // Today leads with the steps an owner can do, each saying why it matters
  const setup = page.locator(".card", { has: page.getByRole("heading", { name: "Getting started" }) });
  await expect(setup).toBeVisible({ timeout: 30_000 });
  await expect(setup.getByText("Start your first role")).toBeVisible();
  await expect(setup.getByRole("link", { name: "Start a hire" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Draft it with an ITS recruiter" })).toBeVisible();
  await expect(setup.getByText("Give ITS access to your job boards")).toBeVisible();
  await expectAccessible(page, "today with getting started");
  // drafting with a recruiter opens the request form first: what they would see is on screen, and nothing is sent yet
  await setup.getByRole("button", { name: "Draft it with an ITS recruiter" }).click();
  const ask = page.getByRole("dialog", { name: "Bring in a recruiter" });
  await expect(ask.getByText(/The recruiter will see all of your hiring/)).toBeVisible();
  await expect(ask.getByTestId("recruiter-request-allowance")).toBeVisible();
  await expectAccessible(page, "first role request form");
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  // "I've reviewed them" ticks the AI rules step and says what it did
  await setup.getByRole("button", { name: "I've reviewed them" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Marked as reviewed/ })).toBeVisible();
  await expect(setup.getByRole("button", { name: "I've reviewed them" })).toBeHidden({ timeout: 30_000 });

  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Rosa", "Diaz");
  expect((await page.request.get(`${baseURL}/careers/${seeded.slug}`)).status()).toBe(200);

  // an ITS administrator takes the confirmation back from the console: a reason, then a second press
  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
  await admin.goto("/admin");
  const row = admin.getByRole("row", { name: new RegExp(`Checked Dental ${run}`) });
  await expect(row.getByText("confirmed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await row.getByRole("button", { name: "Check", exact: true }).click();
  const sheet = admin.getByRole("dialog", { name: `ITS check: Checked Dental ${run}` });
  const takeBack = sheet.getByRole("button", { name: "Take back the confirmation" });
  await expect(takeBack).toBeDisabled();
  await sheet.getByLabel("Why you are taking it back").fill("The website does not match the company.");
  await expectAccessible(admin, "company check sheet");
  await takeBack.click();
  await sheet.getByRole("button", { name: "Yes, take it back" }).click();
  await expect(admin.getByRole("status").filter({ hasText: /is no longer confirmed/ })).toBeVisible();

  // nothing of the company is public, and the owner's Today says why and what waits
  expect((await page.request.get(`${baseURL}/careers/${seeded.slug}`)).status()).toBe(404);
  expect((await page.request.get(`${baseURL}/careers/${seeded.slug}/jobs/${seeded.roleId}`)).status()).toBe(404);
  await page.goto("/");
  await expect(page.getByText(/ITS is checking your company again/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Waiting for ITS")).toBeVisible();
  await expectAccessible(page, "today while ITS confirms the company");
  // the role's Posting tab says why nothing of it is public, and Setup says the careers page is offline
  await page.goto(`/roles/${seeded.roleId}?tab=posting`);
  await expect(page.getByText(/Nothing of this role is public until ITS confirms your company/)).toBeVisible({ timeout: 30_000 });
  await page.goto("/setup#setup-company");
  await expect(page.locator("#setup-company").getByText(/Offline until ITS confirms your company/)).toBeVisible({ timeout: 30_000 });

  // confirmed again: the pages are back
  await sheet.getByLabel("How you checked the company").fill("Spoke with the owner; the website was updated.");
  await sheet.getByRole("button", { name: "Confirm the company" }).click();
  await sheet.getByRole("button", { name: "Yes, confirm it" }).click();
  await expect(admin.getByRole("status").filter({ hasText: /is confirmed/ })).toBeVisible();
  expect((await page.request.get(`${baseURL}/careers/${seeded.slug}`)).status()).toBe(200);
  await staff.close();
});
