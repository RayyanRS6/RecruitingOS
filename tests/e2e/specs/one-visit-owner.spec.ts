import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, gotoSettled, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Applying and the screening conversation in one visit, from the team's side (plan Wave E; founder decision B1): an
 * applicant who has not finished the conversation is "Still applying", counted beside the stage strip and never waiting
 * on the owner; the candidate panel and the role report say so; and since 20 October 2026 (R20-12) ITS no longer
 * switches how people apply: the console says everyone applies the same way, the form and then the AI interview. The
 * candidate's own side (the introduction, the conversation, checking the answers) is in candidate-phone.spec.ts.
 * Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("still applying on the list, the panel and the report; ITS sees one way to apply for everyone", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `owner+${run}@onevisit.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `One Visit Dental ${run}`);
  // every company now: the waiting room after the form opens the AI interview's introduction (R20-12)
  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");
  expect(seeded.conversationPath).toMatch(/^\/c\/screen\//);

  // The list: counted beside the strip, shown only when asked, never as waiting on you
  await page.goto(`/roles/${seeded.roleId}/talent`);
  // one applicant on the job's Candidates tab, and one still applying beside the strip (Wave S1: the header shows the job's facts)
  await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 1$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Still applying 1$/ })).toBeVisible();
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
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "The screening chat" }) });
  await expect(card.getByText("Offered the conversation")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Still applying now", { exact: true })).toBeVisible();
  await expectAccessible(page, "role report with the screening chat");
  await card.getByRole("link", { name: "See who is still applying" }).click();
  await expect(page.getByRole("button", { name: /^Still applying 1$/ })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // The owner never sees the ITS switch
  await page.goto(`/roles/${seeded.roleId}?tab=posting`);
  await expect(page.getByRole("heading", { name: "Where it is posted" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "How people apply (ITS only)" })).toHaveCount(0);

  // ITS: the console's Customers says how people apply, the same for every company, with nothing to switch
  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
  await gotoSettled(admin, "/admin/customers");
  const company = admin.getByRole("row", { name: new RegExp(`One Visit Dental ${run}`) });
  await company.getByRole("button", { name: `Open One Visit Dental ${run}` }).click({ timeout: 30_000 });
  const sheet = admin.getByRole("dialog", { name: `One Visit Dental ${run}` });
  await expect(sheet.getByText("The same for everyone: the form, then the AI interview")).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole("button", { name: "Change how people apply" })).toHaveCount(0);
  await sheet.getByRole("tab", { name: "How people apply" }).click();
  await expect(sheet.getByText(/^Every applicant: a short form, then the AI interview once their résumé is read\./)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save the default" })).toHaveCount(0);
  await expectAccessible(admin, "how people apply tab");
  await staff.close();
});
