import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn, useOneVisitFlow } from "./helpers";

/**
 * Applying and the screening conversation in one visit, from the team's side (plan Wave E; founder decision B1): an
 * applicant who has not finished the conversation is "Still applying", counted beside the stage strip and never waiting
 * on the owner; the candidate panel and the role report say so; and only ITS can switch a company's default, or one
 * role, between "apply and talk in one visit" and "form now, conversation later", with a reason each time. The
 * candidate's own side (the introduction, the conversation, checking the answers) is in candidate-phone.spec.ts.
 * Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("still applying on the list, the panel and the report; ITS switches the company and a role back and forth", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `owner+${run}@onevisit.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `One Visit Dental ${run}`);
  // a pilot company: ITS switches the one-visit flow on (a company without a setting takes the later path)
  const companyId = ((await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json()) as { id: string }).id;
  await useOneVisitFlow(browser, baseURL!, companyId);
  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");
  // a new role follows the pilot's one-visit flow: the form led straight to the conversation's introduction
  expect(seeded.conversationPath).toMatch(/^\/c\/screen\//);

  // The list: counted beside the strip, shown only when asked, never as waiting on you
  await page.goto(`/roles/${seeded.roleId}/talent`);
  await expect(page.getByText("1 applicant · 1 still applying")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Waiting on you/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Still applying 1$/ }).click();
  const row = page.locator(".talent-row", { has: page.getByRole("button", { name: "Maria Reyes" }) });
  await expect(row.getByText("Still applying", { exact: true })).toBeVisible();
  await expect(row.getByText(/Waiting on you/)).toHaveCount(0);
  await expectAccessible(page, "talent with someone still applying");

  // The panel says what is going on, and that nothing waits on the owner yet
  await page.getByRole("button", { name: "Maria Reyes" }).click();
  const panel = page.getByRole("dialog", { name: "Maria Reyes" });
  // her answers are hidden until she sends them (founder decision of 9 October 2026)
  await expect(panel.getByText(/Still applying: their answers appear here once they send them\. Nothing about Maria waits on you until then\./)).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("tab", { name: /^Screen/ }).click();
  await expect(panel.getByText("Still applying", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Still applying: their answers appear here once they send them.", { exact: true })).toBeVisible();
  await expectAccessible(page, "candidate panel while they are still applying");
  await page.keyboard.press("Escape");

  // The role report: how the conversation goes, counts only, with the way back to the people still applying
  await page.goto(`/roles/${seeded.roleId}?tab=report`);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "The screening conversation" }) });
  await expect(card.getByText("Offered the conversation")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Still applying now", { exact: true })).toBeVisible();
  await expectAccessible(page, "role report with the screening conversation");
  await card.getByRole("link", { name: "See who is still applying" }).click();
  await expect(page.getByRole("button", { name: /^Still applying 1$/ })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // The owner never sees the ITS switch
  await page.goto(`/roles/${seeded.roleId}?tab=posting`);
  await expect(page.getByRole("heading", { name: "Where it is posted" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "How people apply (ITS only)" })).toHaveCount(0);

  // ITS: the company's default, then one role of its own, each with a reason
  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
  await admin.goto("/admin");
  const company = admin.getByRole("row", { name: new RegExp(`One Visit Dental ${run}`) });
  await expect(company.getByText("Apply and talk in one visit")).toBeVisible({ timeout: 30_000 });
  await company.getByRole("button", { name: "Change" }).click();
  const sheet = admin.getByRole("dialog", { name: `How people apply: One Visit Dental ${run}` });
  await sheet.getByRole("button", { name: "Form now, conversation later" }).click();
  const saveDefault = sheet.getByRole("button", { name: "Save the default" });
  await expect(saveDefault).toBeDisabled();
  await sheet.getByLabel("Why (required, kept with the change)").first().fill("The owner wants to read every form first.");
  await expectAccessible(admin, "how people apply sheet");
  await saveDefault.click();
  await expect(admin.getByRole("status").filter({ hasText: /form now, conversation later by default/ })).toBeVisible();

  // the role follows the default until it is given its own setting
  const roleChoice = sheet.getByLabel("Applicants to this role");
  await expect(roleChoice).toHaveValue("default", { timeout: 30_000 });
  await expect(roleChoice.locator("option[value=default]")).toHaveText("The company's default (form now, conversation later)", { timeout: 30_000 });
  await roleChoice.selectOption("one_visit");
  await sheet.getByLabel("Why (required, kept with the change)").last().fill("Pilot role keeps the one-visit flow.");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: /Saved: apply and talk in one visit/ })).toBeVisible();
  await staff.close();
});
