import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, emailsWithLink, expectAccessible, said, signIn, skipWithoutFakeSignIn, waitForLink } from "./helpers";

/**
 * Settings, one page with four sections, in a real browser: Company (the details changed and saved), Team (a teammate
 * invited as Member, who joins through the emailed link in a browser of their own and then reads Settings without
 * being able to change the company or the team), Plan, and Email updates (each person's one switch, remembered), which
 * leads to every earlier update. Everything is synthetic; every provider is a stand-in.
 */
const run = Date.now().toString(36);

test.describe("Settings", () => {
  skipWithoutFakeSignIn();

  test("four sections on one page; the company's details saved; an invitation as Member; the email switch", async ({ page, browser, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;
    const company = `Firstlook Dental ${run}`;
    const owner = { email: `dana+${run}@firstlook.test`, name: "Dana Whitfield", provider: "google" } as const;
    const wes = { email: `wes+${run}@firstlook.test`, name: "Wes Park" };
    await signIn(page, owner);
    await createCompanyThroughTheForm(page, company, owner.name);

    // one page, four sections, in this order
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await expect(page.locator("main h2")).toHaveText(["Company", "Team", "Plan", "Email updates"], { timeout: 30_000 });
    await expectAccessible(page, "Settings");

    // ---- Company: the details, changed and saved ------------------------------------------------------------------------
    const details = page.locator("#setup-company");
    await expect(details.locator("dl.glance")).toContainText(company);
    await expect(details.locator("dl.glance")).toContainText("Tustin, CA");
    await expect(details.getByLabel("Careers page")).toHaveValue(/\/careers\/[a-z0-9-]+$/);
    await details.getByRole("button", { name: "Edit", exact: true }).first().click();
    await details.getByLabel("Website", { exact: true }).fill("firstlook.example");
    await details.getByLabel("Benefits", { exact: true }).fill("Health and dental cover, paid time off.");
    await expectAccessible(page, "editing the company's details");
    await details.getByRole("button", { name: "Save", exact: true }).click();
    await expect(said(page, "Saved.")).toBeVisible({ timeout: 30_000 });
    await expect(details.locator("dl.glance")).toContainText("firstlook.example");
    await expect(details.locator("dl.glance")).toContainText("Health and dental cover, paid time off.");

    // ---- Team: the owner, and an invitation as Member -----------------------------------------------------------------------
    const team = page.locator("#setup-team");
    const people = team.getByRole("list", { name: "People on the team" });
    await expect(people.getByRole("listitem").filter({ hasText: owner.email })).toContainText("Owner");
    await expect(people.getByRole("listitem").filter({ hasText: owner.email })).toContainText("(you)");
    await team.getByLabel("Email", { exact: true }).fill(wes.email);
    await team.getByLabel("Name (optional)").fill(wes.name);
    await expect(team.getByLabel("Role", { exact: true }).locator("option:checked")).toHaveText("Member");
    await team.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(said(page, "Invited.")).toBeVisible({ timeout: 30_000 });
    const invited = team.getByRole("listitem").filter({ hasText: wes.name });
    await expect(invited).toContainText("Member");
    await expect(invited).toContainText(/Link works until /);
    await expect(team.getByLabel("Invitation link")).toHaveValue(/^https?:\/\/\S+$/);
    await expectAccessible(page, "Settings with an invitation waiting");

    // the invitation's email, and joining through its link in a browser of their own
    const invitation = await waitForLink(page.request, base, { to: wes.email, path: "/api/v1/auth/invite" });
    expect(invitation.email.text).toContain(company);
    expect(await emailsWithLink(page.request, base, wes.email, "/api/v1/auth/invite")).toHaveLength(1);
    const context = await browser.newContext({ baseURL: base });
    const joining = await context.newPage();
    await joining.goto(invitation.path);
    await joining.getByRole("link", { name: "Continue with Google" }).click();
    await expect(joining.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
    await joining.getByRole("textbox", { name: "Email" }).fill(wes.email);
    await joining.getByLabel("Name").fill(wes.name);
    await joining.getByRole("button", { name: "Continue" }).click();
    await joining.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
    await expect(joining.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });

    // a member reads all four sections, and changes neither the company nor the team
    await joining.goto("/setup");
    await expect(joining.locator("main h2")).toHaveText(["Company", "Team", "Plan", "Email updates"], { timeout: 30_000 });
    await expect(joining.locator("#setup-company").locator("dl.glance")).toContainText(company);
    await expect(joining.locator("#setup-company").getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    const theirTeam = joining.locator("#setup-team");
    await expect(theirTeam.getByRole("list", { name: "People on the team" }).getByRole("listitem").filter({ hasText: wes.email })).toContainText("Member");
    await expect(theirTeam.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
    await expect(theirTeam.getByRole("combobox")).toHaveCount(0);
    await expect(theirTeam.getByRole("button", { name: "Leave this company" })).toBeVisible();
    await expectAccessible(joining, "Settings as a member");
    await context.close();

    // the owner sees them on the team as Member, and no invitation is left waiting
    await page.reload();
    await expect(team.getByRole("combobox", { name: `Role of ${wes.name}` })).toHaveValue("hiring_manager", { timeout: 30_000 });
    await expect(team.getByRole("combobox", { name: `Role of ${wes.name}` }).locator("option:checked")).toHaveText("Member");
    await expect(team.getByText("Invited, not yet in")).toHaveCount(0);

    // ---- Plan: the plan by name ----------------------------------------------------------------------------------------------
    await expect(page.locator("#setup-plan strong").first()).not.toBeEmpty();

    // ---- Email updates: one switch, said and remembered ------------------------------------------------------------------------
    const updates = page.locator("#setup-notifications");
    const emailMe = updates.getByRole("checkbox", { name: /^Email me updates/ });
    await expect(updates).toContainText(`To ${owner.email}`);
    await expect(updates).toContainText("Notices about your account, your plan and your team are always emailed.");
    const was = await emailMe.isChecked();
    await emailMe.click();
    await expect(said(page, was ? "Emails off." : "Emails on.")).toBeVisible({ timeout: 30_000 });
    await expect(emailMe).toBeChecked({ checked: !was });
    await page.reload();
    await expect(emailMe).toBeChecked({ checked: !was, timeout: 30_000 });
    await emailMe.click();
    await expect(said(page, was ? "Emails on." : "Emails off.")).toBeVisible({ timeout: 30_000 });
    await expect(emailMe).toBeChecked({ checked: was });

    // every earlier update is one link away, and leads back
    await updates.getByRole("link", { name: "All updates" }).click();
    await expect(page).toHaveURL(/\/updates$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Updates");
    await expect(page.getByRole("list", { name: "Updates" }).or(page.getByRole("heading", { name: "No updates yet" }))).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "Updates");
    const unread = page.getByRole("group", { name: "Which updates to show" }).getByRole("button", { name: /^Unread/ });
    await unread.click();
    await expect(unread).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "Email updates" }).click();
    await expect(page).toHaveURL(/\/setup#setup-notifications$/);
  });
});
