import { expect, test } from "@playwright/test";
import {
  PERSONAS, applyThroughTheForm, candidateRow, createCompanyThroughTheForm, emailsTo, expectAccessible, gotoSettled, openThePanel, publishedJobThroughTheApi, said, signIn, signInAsAdmin,
  skipWithoutFakeSignIn, type Applicant,
} from "./helpers";

/**
 * The plans from end to end, in a real browser. A new company is on Free, whose one job takes applications without
 * limit and shows the team the first five: the sixth is one locked card, with no name on the page or in what the page
 * reads, and the sixth applicant never reads a word about a plan. Upgrade asks ITS: the sheet compares the plans and
 * charges nothing. The administrator sees the request on the dashboard and changes the plan, and the card opens. With
 * its one job used, Free's job builder says so before anyone types. Everything is synthetic.
 */
const run = Date.now().toString(36);
const FIRST_FIVE = ["Ana Alvarez", "Ben Brooks", "Cara Cole", "Dev Dutta", "Eve Ellis"];
const SIXTH = "Fay Foster";
const applicant = (name: string): Applicant => {
  const [first, last] = name.split(" ");
  return { first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${run}@example.com`, resume: PERSONAS.possible.resume };
};

test.describe("a Free company past its plan", () => {
  skipWithoutFakeSignIn();

  test("six applicants: five to read and one locked card; Upgrade asks ITS; the administrator changes the plan; the card opens", async ({ page, browser, baseURL }) => {
    test.setTimeout(600_000);
    const base = baseURL!;
    const company = `Free Dental ${run}`;
    await signIn(page, { email: `dana+${run}@plans.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    const current = (await (await page.request.get(`${base}/api/v1/companies/current`)).json()) as { plan: { key: string } };
    expect(current.plan.key).toBe("free");
    const job = await publishedJobThroughTheApi(page.request, base);

    // Six people apply, one after another: every one of them gets through, and the sixth reads nothing about a plan
    for (const name of [...FIRST_FIVE, SIXTH]) {
      const who = applicant(name);
      const applied = await applyThroughTheForm(browser, base, job.jobUrl, who);
      if (name === SIXTH) {
        await expect(applied.page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(applied.page.getByText(/\b(plan|upgrade|locked)\b/i)).toHaveCount(0);
      }
      await applied.context.close();
    }
    await expect.poll(async () => (await emailsTo(page.request, base, applicant(SIXTH).email)).length, { timeout: 60_000, message: "the sixth applicant's receipt by email" }).toBeGreaterThan(0);
    for (const m of await emailsTo(page.request, base, applicant(SIXTH).email)) expect(`${m.subject}\n${m.text}`).not.toMatch(/\b(plan|upgrade|locked)\b/i);

    // The team reads five, and one card says there is a sixth; the job's own tab counts everyone
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 6$/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".candidate-row")).toHaveCount(5, { timeout: 30_000 });
    for (const name of FIRST_FIVE) await expect(candidateRow(page, name)).toBeVisible();
    const card = page.getByRole("list", { name: "Locked candidates" }).locator(".locked-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByText("Locked", { exact: true })).toBeVisible();
    await expect(card.getByText(/Upgrade to view more candidates\./)).toBeVisible();
    // no name, on the page or in what the page reads
    await expect(page.getByText(SIXTH)).toHaveCount(0);
    expect(await (await page.request.get(`${base}/api/v1/roles/${job.roleId}/applications?tab=new`)).text()).not.toContain("Foster");
    await expectAccessible(page, "candidates with a locked card");

    // Upgrade: the plans side by side, the next one up chosen; a plain line that nothing is charged
    await card.getByRole("button", { name: "Upgrade" }).click();
    const sheet = page.getByRole("dialog", { name: "Upgrade" });
    await expect(sheet.getByText("Your plan", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    await expect(sheet.getByRole("radio", { name: /^Basic/ })).toBeChecked();
    await expect(sheet.getByText("No card is charged. ITS will contact you, and nothing changes until then.")).toBeVisible();
    await sheet.getByRole("radio", { name: /^Pro/ }).check();
    await expectAccessible(page, "the upgrade sheet");
    await sheet.getByLabel("A note for ITS (optional)").fill("We hire more from next month.");
    await sheet.getByRole("button", { name: "Ask ITS to upgrade" }).click();
    await expect(sheet.getByText(/^Request sent on .+ No card is charged\. ITS will contact you, and nothing changes until then\./)).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    // with the request sent, the day it went stands in the button's place: nothing more to press
    await expect(card.getByText(/^Request sent on /)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("button", { name: "Upgrade" })).toHaveCount(0);

    // The administrator: "Asked to upgrade" leads to the company; a plan, a reason, then a second press
    const admin = await signInAsAdmin(browser);
    await gotoSettled(admin.page, "/admin");
    const asked = admin.page.locator(".card", { has: admin.page.getByRole("heading", { name: "Asked to upgrade" }) }).getByRole("listitem").filter({ hasText: company });
    await expect(asked).toContainText("We would like to move to the Pro plan.", { timeout: 30_000 });
    await expect(asked).toContainText("We hire more from next month.");
    await asked.getByRole("link", { name: `Open ${company}` }).click();
    const drawer = admin.page.getByRole("dialog", { name: company });
    await expect(drawer.getByText("Asked to upgrade", { exact: true })).toBeVisible({ timeout: 30_000 });
    await drawer.getByRole("button", { name: "Change plan" }).click();
    const pick = drawer.getByLabel("Plan", { exact: true });
    await expect(pick).toHaveValue("free", { timeout: 30_000 });
    await pick.selectOption("pro");
    await drawer.getByLabel(/^Why/).fill("The customer asked for Pro.");
    await expectAccessible(admin.page, "changing a plan on the admin dashboard");
    await drawer.getByRole("button", { name: "Change plan" }).click();
    await expect(drawer.getByText(`Put ${company} on Pro?`)).toBeVisible();
    await drawer.getByRole("button", { name: "Yes, change it" }).click();
    await expect(said(admin.page, `${company} is on Pro now.`)).toBeVisible({ timeout: 30_000 });
    await expect(said(admin.page, /1 locked applicant opens now\./)).toBeVisible();
    await expect(drawer.getByText("Asked to upgrade", { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await admin.context.close();

    // The card opens: six to read, nobody locked, and the sixth has a name and a panel
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".candidate-row")).toHaveCount(6, { timeout: 30_000 });
    await expect(page.locator(".locked-card")).toHaveCount(0);
    const panel = await openThePanel(page, SIXTH);
    await expect(panel.getByRole("heading", { name: "Resume match" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the candidate who was locked");
    await page.keyboard.press("Escape");

    // The change reached the team, and Settings says the new plan
    await page.goto("/updates");
    await expect(page.getByRole("list", { name: "Updates" }).getByRole("listitem").filter({ hasText: "Your plan is now Pro" })).toHaveCount(1, { timeout: 30_000 });
    await page.goto("/setup#setup-plan");
    await expect(page.locator("#setup-plan strong").first()).toHaveText("Pro", { timeout: 30_000 });
  });

  test("Free's one job is used: Home and the job builder say so before anyone types, with Upgrade", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    await signIn(page, { email: `owner+${run}@roomless.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Roomless Dental ${run}`);
    await publishedJobThroughTheApi(page.request, baseURL!);
    const room = page.locator(".alert").filter({ has: page.getByRole("button", { name: "Upgrade" }) });
    for (const address of ["/", "/roles/new"]) {
      await page.goto(address);
      await expect(room, address).toContainText("Your Free plan includes one job. Upgrade to post more.", { timeout: 30_000 });
      await expect(page.getByRole("textbox", { name: "Describe the job, or paste a job ad" })).toBeDisabled();
    }
    await expectAccessible(page, "the job builder with no room on Free");
    // Upgrade asks ITS, in the one upgrade sheet, and charges nothing
    await room.getByRole("button", { name: "Upgrade" }).click();
    await expect(page.getByRole("dialog", { name: "Upgrade" }).getByText("No card is charged. ITS will contact you, and nothing changes until then.")).toBeVisible({ timeout: 30_000 });
  });
});
