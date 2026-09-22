import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn } from "./helpers";

/**
 * Founder instruction of 21 September 2026, item 1: the customer ends a recruiter's access from Setup. The button is
 * only for owners and admins, it asks for confirmation and a reason, the recruiter loses access at once, and the
 * customer's own history records it. Driven through the real page, not the API.
 */
const run = Date.now().toString(36);

test("the owner sees who has access, must confirm with a reason, and the access ends at once", async ({ page, browser, baseURL }) => {
  await signIn(page, { email: `owner+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Dental ${run}`);
  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

  // the owner asks for a recruiter's help; an ITS administrator picks it up in their own browser
  const esc = (await (await page.request.post(`${baseURL}/api/v1/escalations`, { data: { kind: "review", roleId: seeded.roleId, question: "Is our shortlist any good?" } })).json()) as { id: string };
  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  await signIn(staffPage, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
  expect((await staffPage.request.post(`${baseURL}/api/v1/escalations/${esc.id}/claim`)).ok()).toBeTruthy();
  expect((await staffPage.request.post(`${baseURL}/api/v1/auth/switch`, { data: { companyId: (await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json() as { id: string }).id } })).ok()).toBeTruthy();
  expect((await staffPage.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}`)).status()).toBe(200);

  // the owner sees the grant and ends it: confirmation first, a reason of at least five characters, then the button
  await page.goto("/setup");
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "ITS recruiter access" }) });
  await expect(card.getByText("Admin", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  const end = card.getByRole("button", { name: "End this recruiter's access" });
  await expect(end).toBeVisible();
  await end.click();
  const reason = card.getByLabel("Why you are ending it (the recruiter sees this)");
  await expect(reason).toBeVisible();
  const confirm = card.getByRole("button", { name: "End access now" });
  await expect(confirm).toBeDisabled();
  await reason.fill("no");
  await expect(confirm).toBeDisabled();
  await expectAccessible(page, "revoke confirmation");
  await reason.fill("We found what we needed, thank you.");
  await expect(confirm).toBeEnabled();
  await card.getByRole("button", { name: "Keep it" }).click();
  await expect(reason).toBeHidden();
  await end.click();
  await card.getByLabel("Why you are ending it (the recruiter sees this)").fill("We found what we needed, thank you.");
  await card.getByRole("button", { name: "End access now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Access ended/ })).toBeVisible();
  await expect(card.getByText("No recruiter has access right now.")).toBeVisible();

  // the recruiter's very next request is refused; the history names the person, the time and the reason
  expect((await staffPage.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}`)).status()).toBe(403);
  await card.getByText(/Access history/).click();
  await expect(card.getByText(/Access ended by your team · by Dana Whitfield · We found what we needed, thank you\./)).toBeVisible();
  await expectAccessible(page, "setup after revocation");
  await staff.close();
});
