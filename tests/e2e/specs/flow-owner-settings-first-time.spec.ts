import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, exactlyOneEmail, expectAccessible, signIn, skipWithoutFakeSignIn, waitForEmail } from "./helpers";

/**
 * A new owner's first look at Settings, from Home's Getting started, in a real browser. The steps say why each matters and
 * never ask for interview hours (6 November 2026: a person sets each interview's date and time, so hours are optional), and
 * the hours card never looks saved when nothing is. Company details are added from the step, which then shows as done. A
 * teammate is invited from the step: the invitation's email is read by its words, and the invited person joins through
 * its link in a browser of their own. The Free plan's two people are then full, and the page says so before anyone types.
 */
const run = Date.now().toString(36);

test.describe("Settings, the first time", () => {
  skipWithoutFakeSignIn();

  test("Getting started without an hours step; company details done from it; a teammate invited and joining; Free's seats full", async ({ page, browser, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;
    const company = `Firstlook Dental ${run}`;
    const owner = { email: `dana+${run}@firstlook.test`, name: "Dana Whitfield", provider: "google" } as const;
    await signIn(page, owner);
    await createCompanyThroughTheForm(page, company);

    // Getting started: the steps an owner can do, each with why; none asks for interview hours
    const setup = page.locator(".card", { has: page.getByRole("heading", { name: "Getting started" }) });
    await expect(setup).toBeVisible({ timeout: 30_000 });
    await expect(setup.getByText("Add your website, careers-page introduction and benefits")).toBeVisible();
    await expect(setup.getByText("Still to add: your website, a careers-page introduction, a benefits summary.")).toBeVisible();
    await expect(setup.getByText("Invite your team")).toBeVisible();
    await expect(setup.getByText("Start your first role")).toBeVisible();
    await expect(setup.getByText(/when you can interview|your hours|availability/i)).toHaveCount(0);

    // the hours card is there for whoever wants it, and never looks saved when nothing is
    await page.goto("/setup#setup-availability");
    const hours = page.locator("#setup-availability");
    await expect(hours.getByRole("heading", { name: "My availability for interviews" })).toBeVisible({ timeout: 30_000 });
    await expect(hours.getByText("Not saved yet")).toBeVisible();
    await hours.getByRole("button", { name: "Save availability" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Availability saved/ })).toBeVisible({ timeout: 30_000 });
    await expect(hours.getByText("Not saved yet")).toHaveCount(0);

    // company details from the step: it lands on the card, and the step is done afterwards
    await page.goto("/");
    await setup.getByRole("link", { name: "Open company details" }).click();
    await expect(page).toHaveURL(/\/setup#setup-company$/);
    const details = page.locator("#setup-company");
    await details.getByRole("button", { name: "Edit" }).click();
    await details.getByLabel("Website").fill("firstlook.example");
    await details.getByLabel("Careers page introduction").fill("A family practice in Tustin since 1998.");
    await details.getByLabel("Benefits summary").fill("Health and dental cover, paid time off.");
    await expectAccessible(page, "editing the company's details");
    await details.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Saved: / })).toBeVisible({ timeout: 30_000 });
    await page.goto("/");
    await expect(setup.getByText("Still to add:")).toHaveCount(0, { timeout: 30_000 });
    await setup.getByText(/^Done \(\d+\)$/).click();
    await expect(setup.getByText("Add your website, careers-page introduction and benefits")).toBeVisible();

    // a teammate, invited from the step: the email's words, then they join through its link in a browser of their own
    await setup.getByRole("link", { name: "Invite people" }).click();
    await expect(page).toHaveURL(/\/setup#setup-team$/);
    const team = page.locator("#setup-team");
    const wes = { email: `wes+${run}@firstlook.test`, name: "Wes Park" };
    await team.getByLabel("Invite by email").fill(wes.email);
    await team.getByLabel("Name (optional)").fill(wes.name);
    await team.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Invited\./ })).toBeVisible({ timeout: 30_000 });
    await expect(team.getByLabel("Invitation link")).toHaveValue(/^https?:\/\/\S+$/);
    const invite = await waitForEmail(page.request, base, {
      to: wes.email,
      subject: `Dana Whitfield invited you to ${company} on Recruiting OS`,
      says: ["Hi Wes Park,", `Dana Whitfield invited you to ${company}'s hiring workspace on Recruiting OS`, "Accept the invitation:", "The link works for seven days.", `using this address (${wes.email})`],
    });
    await exactlyOneEmail(page.request, base, { to: wes.email, subject: /invited you to/ });
    const accept = invite.text.match(/Accept the invitation:\n(https?:\/\/\S+)/)?.[1];
    expect(accept, "the invitation's link").toBeTruthy();
    const context = await browser.newContext({ baseURL: base });
    const joining = await context.newPage();
    await joining.goto(new URL(accept!).pathname + new URL(accept!).search);
    await joining.getByRole("link", { name: "Continue with Google" }).click();
    await expect(joining.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
    await joining.getByRole("textbox", { name: "Email" }).fill(wes.email);
    await joining.getByLabel("Name").fill(wes.name);
    await joining.getByRole("button", { name: "Continue" }).click();
    await joining.waitForURL((u) => !u.pathname.startsWith("/api/"), { timeout: 60_000 });
    await expect(joining.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    expect(((await (await joining.request.get(`${base}/api/v1/companies/current`)).json()) as { name: string }).name).toBe(company);
    await context.close();

    // Free has room for two people: the team card says so before anyone types, and Invite waits
    await page.goto("/setup#setup-team");
    await expect(team.getByText("Wes Park")).toBeVisible({ timeout: 30_000 });
    await expect(team.getByText("Your plan includes 2 people. Upgrade to add more.")).toBeVisible({ timeout: 30_000 });
    await expect(team.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
    await expectAccessible(page, "a full team on Free");
  });
});
