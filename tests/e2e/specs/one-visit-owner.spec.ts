import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, gotoSettled, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Applying and the AI interview, from the team's side (plan Wave E; founder decision B1; R20-7): an applicant who has
 * not sent the AI interview sits under "No AI interview yet", the strip's first column, never waiting on the owner; the
 * candidate panel and the role report say so; and since 20 October 2026 (R20-12) ITS no longer
 * switches how people apply: the console says everyone applies the same way, the form and then the AI interview. The
 * candidate's own side (the introduction, the conversation, checking the answers) is in candidate-phone.spec.ts.
 * Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("no AI interview yet on the list, the panel and the report; ITS sees one way to apply for everyone", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `owner+${run}@onevisit.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `One Visit Dental ${run}`);
  // every company now: the waiting room after the form opens the AI interview's introduction (R20-12)
  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");
  expect(seeded.conversationPath).toMatch(/^\/c\/screen\//);

  // The list: in the strip's first column, with its chips, never as waiting on you
  await page.goto(`/roles/${seeded.roleId}/talent`);
  // one applicant on the job's Candidates tab, under "No AI interview yet" (Wave S1: the header shows the job's facts)
  await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 1$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Waiting on you/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^No AI interview yet 1$/ }).click();
  await expect(page.getByRole("button", { name: /^Not started 1$/ })).toBeVisible();
  const row = page.locator(".talent-row", { has: page.getByRole("button", { name: "Maria Reyes" }) });
  // the row's chip ("Invited Oct 21 · link open until Oct 26"), not the stage button's "Invited (not started)"
  await expect(row.getByText(/^Invited [A-Z][a-z]{2} \d{1,2}\b/)).toBeVisible();
  await expect(row.getByText(/Waiting on you/)).toHaveCount(0);
  await expectAccessible(page, "talent with someone under No AI interview yet");

  // The panel says what is going on, and that nothing waits on the owner yet
  await page.getByRole("button", { name: "Maria Reyes" }).click();
  const panel = page.getByRole("dialog", { name: "Maria Reyes" });
  // her answers are hidden until she sends them (founder decision of 9 October 2026)
  await expect(panel.getByText(/AI interview not sent yet: their answers appear here once they send them\. Nothing about Maria waits on you until then\./)).toBeVisible({ timeout: 30_000 });
  // the Overview's "AI interview" card: where she stands, and the team's choices
  await expect(panel.getByRole("button", { name: "Send a reminder" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Not moving forward" }).first()).toBeVisible();
  await panel.getByRole("tab", { name: /^AI interview/ }).click();
  await expect(panel.getByText("AI interview not sent yet", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("AI interview not sent yet: their answers appear here once they send them.", { exact: true })).toBeVisible();
  await expectAccessible(page, "candidate panel while the AI interview is not sent yet");
  await page.keyboard.press("Escape");

  // The role report: how the AI interview goes, counts only, with the way back to the column
  await page.goto(`/roles/${seeded.roleId}?tab=report`);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "The AI interview" }) });
  await expect(card.getByText("Offered the conversation")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("AI interview open now", { exact: true })).toBeVisible();
  await expectAccessible(page, "role report with the AI interview");
  await card.getByRole("link", { name: "See who has no AI interview yet" }).click();
  await expect(page.getByRole("tab", { name: /^No AI interview yet 1$/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

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
