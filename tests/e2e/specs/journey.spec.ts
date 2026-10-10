import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, signInWithoutSecondFactor, skipWithoutFakeSignIn, usePlan } from "./helpers";

/**
 * The release-1 journey in a real browser: sign in, set up the company, publish a role, receive an applicant, declare
 * availability, approve an interview, pick a time as the candidate, confirm, see it on the Interviews page, reschedule.
 * Every page visited is checked against WCAG 2.1 AA with axe. Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);

test.describe("owner and candidate journey", () => {
  skipWithoutFakeSignIn();
  test("from sign-in to a booked interview and a reschedule", async ({ page, baseURL, browser }) => {
    await page.goto("/login");
    await expectAccessible(page, "login");
    await signIn(page, { email: `dana+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Dental ${run}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page, "home");

    // the trial has room for one role at a time; this journey publishes one and then drafts another
    const company = await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json() as { id: string };
    await usePlan(browser, baseURL!, company.id, "growth");
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // the job builder (/roles/new): the first message starts the draft, and the conversation announces each new reply
    // to screen readers (a polite live region)
    await page.goto("/roles/new?new=1");
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "job builder");
    await page.getByRole("textbox", { name: "Describe the role, or paste a job ad" }).fill("I need a bookkeeper in Los Angeles, $60,000 to $70,000, in the office.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=/, { timeout: 30_000 });
    const announcer = page.getByTestId("intake-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveAttribute("role", "status");
    await expect(announcer).not.toHaveText("", { timeout: 30_000 });
    await expect(announcer).not.toHaveText("The assistant is thinking.", { timeout: 30_000 });
    // what is announced is exactly the newest reply on the page, and it changes with the next reply
    const firstReply = (await announcer.textContent())!.trim();
    expect(firstReply.length).toBeGreaterThan(10);
    await expect(page.locator("main")).toContainText(firstReply);
    await expectAccessible(page, "job builder conversation");
    // typed words instead of the question cards: "Or type your own answer…" puts the message box back
    const typeInstead = page.getByRole("button", { name: "Or type your own answer…" });
    if (await typeInstead.isVisible()) await typeInstead.click();
    await page.getByRole("textbox", { name: "Message to the assistant" }).fill("Ceiling $72,000. I decide. Must-haves: QuickBooks.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(announcer).not.toHaveText(firstReply, { timeout: 30_000 });
    await expect(announcer).not.toHaveText("The assistant is thinking.", { timeout: 30_000 });
    const secondReply = (await announcer.textContent())!.trim();
    expect(secondReply).not.toBe(firstReply);
    await expect(page.locator("main")).toContainText(secondReply);

    // the public job page and the application form are the candidate's first contact
    await page.goto(`/careers/${seeded.slug}/jobs/${seeded.roleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page, "job page");
    await page.goto(`/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`);
    await expectAccessible(page, "apply form");

    // the owner declares availability in Setup; the recruiter-access card is there with nothing to end
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "My availability for interviews" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "ITS recruiter access" })).toBeVisible();
    await expect(page.getByText("No recruiter has access right now.")).toBeVisible();
    await expectAccessible(page, "setup");
    await page.getByRole("button", { name: "Save availability" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Availability saved/ })).toBeVisible();

    // the owner opens the candidate and approves an interview
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "talent");
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const sheet = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(sheet).toBeVisible();
    await expectAccessible(page, "candidate panel");
    await sheet.getByRole("button", { name: /^Stage: / }).click();
    await sheet.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await expect(sheet.getByRole("heading", { name: "Approve an interview" })).toBeVisible();
    await sheet.getByRole("checkbox").first().check();
    await sheet.getByRole("button", { name: "Approve and offer times" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Interview approved/ })).toBeVisible();

    // the candidate follows the status page to pick a time in their own zone
    await page.goto(seeded.statusPath);
    await expect(page.getByRole("link", { name: "Choose a time" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "candidate status");
    await page.getByRole("link", { name: "Choose a time" }).click();
    await expect(page.getByRole("heading", { name: /Pick a time/ })).toBeVisible();
    await page.getByLabel("Show times in").selectOption("America/New_York");
    await page.getByRole("button", { name: "Show times" }).click(); // no inline script under the content-security policy: a real button
    await expect(page.getByText(/EDT|EST/).first()).toBeVisible();
    await expectAccessible(page, "pick a time");
    // keyboard only: tab to the first slot, space to choose, then confirm
    await page.getByRole("radio").first().focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("radio").first()).toBeChecked();
    await page.getByLabel(/Anything that would make the interview easier/).fill("Captions on, please.");
    await page.getByRole("button", { name: "Confirm this time" }).click();
    await expect(page.getByRole("heading", { name: /confirmed|Booking your time/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "confirmed");
    const ics = await page.request.get(page.url().replace(/\/confirmed.*$/, "/ics"));
    expect(ics.headers()["content-type"]).toContain("text/calendar");

    // the owner sees it scheduled, reads the accommodation note, and reschedules
    await page.goto("/interviews");
    await expect(page.getByRole("cell", { name: /Maria Reyes/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Scheduled").first()).toBeVisible();
    await expectAccessible(page, "interviews");
    await page.getByRole("link", { name: "Open", exact: true }).first().click();
    const ivSheet = page.getByRole("dialog");
    await expect(ivSheet.getByText(/Captions on/)).toBeVisible();
    await expectAccessible(page, "interview sheet");
    await ivSheet.getByLabel(/Reason/).fill("Interviewer is travelling.");
    await ivSheet.getByRole("button", { name: "Offer new times" }).click();
    await expect(page.getByRole("status").filter({ hasText: /New times are going out/ })).toBeVisible();
    await page.goto(seeded.statusPath);
    await expect(page.getByRole("link", { name: "Choose a time" })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("staff sign-in policy in the browser", () => {
  skipWithoutFakeSignIn();
  test("Google is refused for staff with plain guidance; Microsoft without a second factor continues on the authenticator page; with it, staff land on the queue", async ({ page }) => {
    await signIn(page, { email: `nadine+${run}@identifiedtalent.com`, name: "Nadine", provider: "google" });
    await expect(page.getByRole("alert").filter({ hasText: /Microsoft 365/ })).toBeVisible();
    await expectAccessible(page, "login error");
    // Since 22 September a staff sign-in without a second factor is not refused: it continues on the authenticator page.
    await signInWithoutSecondFactor(page, { email: `nadine+${run}@identifiedtalent.com`, name: "Nadine" });
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
    expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
    await page.getByRole("button", { name: "Cancel and return to sign-in" }).click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, { email: `nadine+${run}@identifiedtalent.com`, name: "Nadine", provider: "azure", aal2: true });
    await expect(page).not.toHaveURL(/\/login/);
    const me = await (await page.request.get("/api/v1/auth/me")).json() as { auth: { provider: string; aal: string; mfaVerifiedAt: string | null } };
    expect(me.auth).toMatchObject({ provider: "azure", aal: "aal2" });
    expect(me.auth.mfaVerifiedAt).toBeTruthy();
    // a platform role is granted by an administrator, never by the sign-in itself: a new staff account starts without one
    await page.waitForLoadState("networkidle"); // the first page may still be redirecting
    await expectAccessible(page, "first page after staff sign-in");
  });
});
