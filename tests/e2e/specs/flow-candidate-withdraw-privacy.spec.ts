import { expect, test } from "@playwright/test";
import {
  PERSONAS, applyThroughTheForm, candidateRow, createCompanyThroughTheForm, emailsTo, emailsWithLink, expectAccessible, linkIn, publishedJobThroughTheApi, signIn, skipWithoutFakeSignIn,
  statusPathFromEmail, type Applicant,
} from "./helpers";

/**
 * A candidate's own choices, on their own status page, in a real browser: asking for a copy of their information,
 * withdrawing (only with the box ticked; the team hears it, the row says "Withdrew" and nothing more can be done with
 * them), getting a new link when one was shared by mistake (the old one stops opening), and "Lost your link?". The
 * words on those pages are the candidate pages' own.
 */
const run = Date.now().toString(36);

test.describe("a candidate's own choices", () => {
  skipWithoutFakeSignIn();

  test("ask for a copy; withdraw from the status page; a new link; Lost your link?", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    await signIn(page, { email: `owner+${run}@brookside.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brookside Dental ${run}`);
    const job = await publishedJobThroughTheApi(page.request, base);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };
    const { context, page: cand } = await applyThroughTheForm(browser, base, job.jobUrl, ana);
    const statusPath = await statusPathFromEmail(page.request, base, ana.email);

    // ask for a copy of her information, from her own page: confirmed on the page and by email
    await cand.goto(statusPath);
    await cand.getByText("Ask for a copy, a fix, deletion, or a person's review", { exact: true }).click();
    await cand.getByLabel("What would you like?").selectOption("access");
    await cand.getByRole("button", { name: "Send request" }).click();
    await expect(cand.getByText("We have your request.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await emailsTo(page.request, base, ana.email, /request/i)).length, { timeout: 60_000, message: "the email that confirms her request" }).toBeGreaterThan(0);

    // withdrawing needs the box ticked: sent without it, the page comes back with nothing changed
    await cand.goto(statusPath);
    await cand.getByText("No longer interested?", { exact: true }).click();
    const sure = cand.getByRole("checkbox", { name: "Yes, withdraw my application." });
    await sure.evaluate((el) => el.removeAttribute("required"));
    await cand.getByRole("button", { name: "Withdraw my application" }).click();
    await expect(cand.getByRole("button", { name: "Withdraw my application" })).toBeVisible({ timeout: 30_000 });
    await expect(cand.getByText("Your application is withdrawn.")).toHaveCount(0);
    await cand.getByRole("checkbox", { name: "Yes, withdraw my application." }).check();
    await cand.getByRole("button", { name: "Withdraw my application" }).click();
    await expect(cand.getByText("Your application is withdrawn.")).toBeVisible({ timeout: 30_000 });
    await expectAccessible(cand, "the status page after withdrawing");

    // the team: listed under Not selected as Withdrew, with nothing left to press, and an update that says so
    await page.goto(`/roles/${job.roleId}/talent?tab=not_selected`);
    const row = candidateRow(page, "Ana Holt");
    await expect(row).toContainText("Withdrew", { timeout: 30_000 });
    await expect(row.getByRole("button", { name: /^(Shortlist|Hire|Not selected|Email the decision|Undo|More)/ })).toHaveCount(0);
    await page.goto("/updates");
    await expect(page.getByRole("list", { name: "Updates" }).getByRole("listitem").filter({ hasText: /withdrew/i })).toHaveCount(1, { timeout: 30_000 });

    // a link shared by mistake: a new one by email, and the old one no longer opens
    await cand.goto(statusPath);
    await cand.getByText("Shared this link by mistake?", { exact: true }).click();
    await cand.getByRole("button", { name: "Get a new link" }).click();
    let fresh = "";
    await expect.poll(async () => {
      fresh = (await emailsWithLink(page.request, base, ana.email, "/c/status/")).map((m) => linkIn(m, "/c/status/")).find((path) => path !== statusPath) ?? "";
      return fresh;
    }, { timeout: 60_000, message: "the email with her new link" }).not.toBe("");
    expect((await cand.request.get(`${base}${statusPath}`)).status()).toBeGreaterThanOrEqual(400);
    expect((await cand.request.get(`${base}${fresh}`)).status()).toBe(200);

    // Lost your link? It goes again to the address on file, by email only
    const carryingIt = async () => (await emailsWithLink(page.request, base, ana.email, fresh)).length;
    const before = await carryingIt();
    await cand.goto("/c/link-request");
    await expect(cand.getByRole("heading", { level: 1, name: "Lost your link?" })).toBeVisible();
    await cand.getByLabel("Your email address").fill(ana.email);
    await cand.getByRole("button", { name: "Email me my link" }).click();
    await expect(cand.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible({ timeout: 30_000 });
    await expect(cand.locator('a[href^="/c/status/"]')).toHaveCount(0);
    await expect.poll(carryingIt, { timeout: 60_000, message: "her link, emailed again" }).toBeGreaterThan(before);
    await context.close();
  });
});
