import { expect, test, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, applyThroughTheForm, createCompanyThroughTheForm, emailsTo, expectAccessible, liveJobThroughTheApi, openThePanel, setADateAndTime, signIn,
  skipWithoutFakeSignIn, waitForEmail, waitForTheAiInterview, type Applicant,
} from "./helpers";

/**
 * A candidate's own choices, on their own pages, in a real browser: withdrawing (only with the box ticked; their booked
 * interview is called off; the team hears it and the row says "Withdrew", never "Not moving forward"), asking for a copy of
 * their information from their status page, getting a new link when one was shared by mistake (the old one stops opening),
 * and "Lost your link?". The AI interview's own WITHDRAW asks first, and "No, keep my application" keeps it. Every email is
 * read by its words.
 */
const run = Date.now().toString(36);
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Brookside Dental ${tag}`;
  await signIn(page, { email: `owner+${tag}@brookside.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  return { company, ...(await liveJobThroughTheApi(page.request, base)) };
}

test.describe("a candidate's own choices", () => {
  skipWithoutFakeSignIn();

  test("withdraw from the status page with a booked time; ask for a copy; a new link; Lost your link?", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}a@example.com`, resume: PERSONAS.strong.resume };
    const { statusPath } = await applicantThroughTheApi(page.request, base, job, ana);
    // a booked time, set by the owner
    const panel = await openThePanel(page, job.roleId, "Ana Holt");
    await panel.getByRole("button", { name: /^Stage: / }).click();
    await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await setADateAndTime(panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: "Ana", daysAhead: 3, time: "10:00", place: "By phone" });
    await expect(toast(page, /Booked\./)).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: ana.email, subject: /^Your interview: / });

    const context = await browser.newContext({ baseURL: base });
    const cand = await context.newPage();

    // ask for a copy of her information, from her own page: verified by the link, confirmed by email
    await cand.goto(statusPath);
    await cand.getByText("Ask for a copy, a fix, deletion, or a person's review", { exact: true }).click();
    await cand.getByLabel("What would you like?").selectOption("access");
    await cand.getByRole("button", { name: "Send request" }).click();
    await expect(cand.getByText("We have your request.")).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: ana.email, subject: /^We received your request \([0-9a-f]{8}\)$/, says: ["We received your request for a copy of the information we hold about you", "Because it came through your own status link, no further verification is needed.", "We will complete it by"] });

    // withdrawing needs the box ticked: sent without it, the page comes back with the choice open and nothing changed
    await cand.goto(statusPath);
    await cand.getByText("No longer interested?", { exact: true }).click();
    await cand.getByRole("checkbox", { name: "Yes, withdraw my application." }).evaluate((el) => el.removeAttribute("required"));
    await cand.getByRole("button", { name: "Withdraw my application" }).click();
    await expect(cand.getByRole("button", { name: "Withdraw my application" })).toBeVisible({ timeout: 30_000 });
    await expect(cand.getByText("Your application is withdrawn.")).toHaveCount(0);
    await cand.getByRole("checkbox", { name: "Yes, withdraw my application." }).check();
    await cand.getByRole("button", { name: "Withdraw my application" }).click();
    await expect(cand.getByText("Your application is withdrawn.")).toBeVisible({ timeout: 30_000 });
    await expect(cand.getByText("You withdrew this application. Thank you for your time.")).toBeVisible();
    await expectAccessible(cand, "the status page after withdrawing");
    // her booked time is off, and she is told so; the withdrawal is confirmed
    await waitForEmail(page.request, base, { to: ana.email, subject: /^Cancelled: /, says: ["Hi Ana,", "is cancelled"] });
    await waitForEmail(page.request, base, { to: ana.email, subject: /^Your request is complete \([0-9a-f]{8}\)$/, says: ["Your request for withdrawal of your application is complete."] });

    // the team: the notice, the row's word, and the interview no longer coming up
    await page.goto("/updates");
    await expect(page.getByRole("listitem").filter({ hasText: "Ana Holt withdrew" })).toHaveCount(1, { timeout: 30_000 });
    await page.goto(`/roles/${job.roleId}/talent`);
    const row = page.locator(".talent-row").filter({ hasText: "Ana Holt" });
    await expect(row).toContainText("Withdrew", { timeout: 30_000 });
    await expect(row).not.toContainText("Not moving forward");
    await page.goto("/interviews");
    await expect(page.getByRole("row").filter({ hasText: "Ana Holt" }).filter({ hasText: "Scheduled" })).toHaveCount(0, { timeout: 30_000 });

    // a link shared by mistake: a new one by email, and the old one no longer opens
    await cand.goto(statusPath);
    await cand.getByText("Shared this link by mistake?", { exact: true }).click();
    await cand.getByRole("button", { name: "Get a new link" }).click();
    const fresh = await waitForEmail(page.request, base, { to: ana.email, subject: `Your new application link: ${job.company}` });
    const newPath = fresh.text.match(/\/c\/status\/[A-Za-z0-9_-]+/)?.[0];
    expect(newPath).toBeTruthy();
    expect(newPath).not.toBe(statusPath);
    expect((await cand.request.get(`${base}${statusPath}`)).status()).toBeGreaterThanOrEqual(400);
    expect((await cand.request.get(`${base}${newPath}`)).status()).toBe(200);

    // Lost your link? It goes again to the address on file, by email only
    await cand.goto("/c/link-request");
    await expect(cand.getByRole("heading", { level: 1, name: "Lost your link?" })).toBeVisible();
    await cand.getByLabel("Your email address").fill(ana.email);
    await cand.getByRole("button", { name: "Email me my link" }).click();
    await expect(cand.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: ana.email, subject: `Your application link: ${job.company}`, says: ["You asked us to send your application link again."] });
    expect((await emailsTo(page.request, base, ana.email, `Your application link: ${job.company}`))[0].text).toContain(newPath!);
    await context.close();
  });

  test("the AI interview's own WITHDRAW asks first: No keeps the application, Yes withdraws it", async ({ page, browser, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const ben: Applicant = { first: "Ben", last: "Ortiz", email: `ben.ortiz+${run}b@example.com`, resume: PERSONAS.possible.resume };
    const b = await applyThroughTheForm(browser, base, job.jobUrl, ben);
    await waitForTheAiInterview(b.page);
    await b.page.getByRole("button", { name: "Start" }).click();
    await expect(b.page.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible({ timeout: 30_000 });
    const say = async (words: string) => {
      const typed = b.page.getByLabel(/^Your reply/);
      // a question answered with a tap keeps the candidate's own words one click away
      if (!(await typed.isVisible())) await b.page.getByText("Answer in your own words instead", { exact: true }).click();
      await typed.fill(words);
      await typed.locator("xpath=ancestor::form").getByRole("button", { name: "Send", exact: true }).click();
    };
    await say("WITHDRAW");
    await expect(b.page.getByText("Do you want to withdraw your application?")).toBeVisible({ timeout: 30_000 });
    await expectAccessible(b.page, "the chat asking before a withdrawal");
    await b.page.getByRole("button", { name: "No, keep my application" }).click();
    await expect(b.page.getByText("Do you want to withdraw your application?")).toHaveCount(0, { timeout: 30_000 });
    await expect(b.page.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible();
    await say("WITHDRAW");
    await b.page.getByRole("button", { name: "Yes, withdraw my application" }).click();
    await expect(b.page.getByRole("heading", { name: "Your application is withdrawn" })).toBeVisible({ timeout: 30_000 });
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Ben Ortiz" })).toContainText("Withdrew", { timeout: 30_000 });
    await b.context.close();
  });
});
