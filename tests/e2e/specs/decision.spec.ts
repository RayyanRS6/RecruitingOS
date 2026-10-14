import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The loop after an interview in a real browser (audit findings F6 and J13): the owner approves an interview, the
 * candidate books a time, the owner records that it took place from the interview sheet, follows the deep link to
 * the candidate's sheet, and records the decision there; then (plan Wave H) writes a private team note, records the
 * offer made outside the app, the candidate's yes on the one-sheet hire, and closes the role from it. Every page visited
 * is checked against WCAG 2.1 AA with axe.
 * Everything is synthetic; every provider is a fake. Mirrors journey.spec.ts step for step up to the booking.
 */
const run = Date.now().toString(36);

test.describe("decision after an interview", () => {
  skipWithoutFakeSignIn();
  test("record the outcome on the interview sheet, then the decision on the candidate sheet through the deep link", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Dental ${run}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // the owner declares availability so times can be offered from her hours
    await page.goto("/setup?tab=notifications");
    await expect(page.getByRole("heading", { name: "My availability for interviews" })).toBeVisible();
    await page.getByRole("button", { name: "Save availability" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Availability saved/ })).toBeVisible();

    // the owner opens the candidate and moves them to Interviewing, which opens the interview approval
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const sheet = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^Stage: / }).click();
    await sheet.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await expect(sheet.getByRole("heading", { name: "Approve an interview" })).toBeVisible();
    await sheet.getByRole("checkbox").first().check();
    // an optional personal line for the invitation (Q28), checked like any other
    await sheet.getByText("Add a personal line (optional)", { exact: true }).click();
    await sheet.getByLabel("A personal line for the invitation (optional)").fill("We enjoyed reading about your work.");
    await expectAccessible(page, "interview approval with a personal line");
    await sheet.getByRole("button", { name: "Approve and offer times" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Interview approved/ })).toBeVisible();

    // the candidate picks a time from the status page
    await page.goto(seeded.statusPath);
    await expect(page.getByRole("link", { name: "Choose a time" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Choose a time" }).click();
    await expect(page.getByRole("heading", { name: /Pick a time/ })).toBeVisible();
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: "Confirm this time" }).click();
    await expect(page.getByRole("heading", { name: /confirmed|Booking your time/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible({ timeout: 30_000 });

    // the owner records that the interview took place; the candidate moves to "Interview done: decision needed"
    await page.goto("/interviews");
    await expect(page.getByRole("cell", { name: /Maria Reyes/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Open", exact: true }).first().click();
    const ivSheet = page.getByRole("dialog");
    await expect(ivSheet.getByRole("heading", { name: "Did it take place?" })).toBeVisible();
    await expectAccessible(page, "interview sheet before the outcome");
    await ivSheet.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Recorded/ })).toBeVisible();
    await expect(ivSheet.getByRole("heading", { name: "After the interview" })).toBeVisible();
    await expect(ivSheet.getByText("Nobody has recorded a decision yet")).toBeVisible();
    await expectAccessible(page, "interview sheet after the outcome");

    // "Record the decision" is the deep link: it opens the candidate's sheet directly, with the decision card on top
    const decide = ivSheet.getByRole("link", { name: "Record the decision" });
    await expect(decide).toHaveAttribute("href", /\/talent\?open=/);
    // the sheet re-renders once the outcome is saved; a click that lands mid-render is tried again until the page changes
    await expect(async () => {
      if (!/\/talent\?open=/.test(page.url())) await decide.click({ timeout: 5_000 });
      await expect(page).toHaveURL(/\/talent\?open=/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    const candidate = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(candidate).toBeVisible({ timeout: 30_000 });
    await expect(candidate.getByRole("heading", { name: "How did the interview go?" })).toBeVisible();
    // the stage button says where they are on the strip
    await expect(candidate.getByRole("button", { name: /^Stage: Interviewing/ })).toBeVisible();
    await expectAccessible(page, "candidate panel with the decision card");
    await candidate.getByRole("button", { name: "Finalist", exact: true }).click();
    await candidate.getByLabel(/What stood out/).fill("Calm, precise, asked good questions.");
    await candidate.getByRole("button", { name: "Confirm finalist" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Marked as a finalist/ })).toBeVisible();
    await expect(candidate.getByText(/Finalist/).first()).toBeVisible();
    await expect(candidate.getByRole("heading", { name: "How did the interview go?" })).toHaveCount(0);
    // the whole story is on the History tab, with who did each thing (Wave S1: the Overview links there)
    await candidate.getByRole("tab", { name: "History" }).click();
    await expect(page).toHaveURL(/tab=history/);
    await expect(candidate.getByText(/Decision after the interview: finalist/).first()).toBeVisible();
    await expect(candidate.getByText("Dana Whitfield").first()).toBeVisible();
    await expectAccessible(page, "candidate panel history");

    // a private team note (founder decision Q24): the reminder, a starter, saved as it is typed; never the candidate's
    await candidate.getByRole("tab", { name: "Notes" }).click();
    await expect(candidate.getByText(/Stick to job-related facts/).first()).toBeVisible({ timeout: 30_000 });
    await candidate.getByRole("group", { name: "Start from" }).getByRole("button", { name: "After the interview" }).click();
    const noteBox = candidate.getByLabel("Your note on Maria");
    await expect(noteBox).toHaveValue(/^After the interview: How did it go\?/);
    await noteBox.fill("After the interview: How did it go? What did you see and hear?\nExplained perio charting clearly and calmly.");
    await expect(candidate.getByText(/^Saved at /)).toBeVisible({ timeout: 15_000 });
    await expectAccessible(page, "candidate panel notes");

    // a finalist's next step: the offer is made outside the app and recorded here (Q29); nothing goes to the candidate
    await candidate.getByRole("tab", { name: "Overview" }).click();
    await expect(candidate.getByRole("heading", { name: "Maria is a finalist: what next?" })).toBeVisible({ timeout: 30_000 });
    // Offer on the stage button opens the same record-only step (plan H2)
    await candidate.getByRole("button", { name: /^Stage: / }).click();
    await candidate.getByRole("menuitemradio", { name: /^Offer/ }).click();
    await expect(candidate.getByRole("heading", { name: "Offer made" })).toBeVisible();
    await candidate.locator("section.card", { has: page.getByRole("heading", { name: "Offer made" }) }).getByText("Why", { exact: true }).click();
    await expect(candidate.getByText(/The app never writes, sends or changes an offer/)).toBeVisible();
    await candidate.getByLabel(/^Private note/).fill("Start after her notice period.");
    await expectAccessible(page, "candidate panel offer made");
    await candidate.getByRole("button", { name: "Record the offer" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Offer recorded\..*Nothing was sent to Maria/ })).toBeVisible();
    // waiting on the candidate's answer: the Offer stage on the strip, Accepted or Declined on the panel
    await expect(candidate.getByRole("heading", { name: "Waiting on Maria's answer" })).toBeVisible({ timeout: 30_000 });
    await expect(candidate.getByRole("button", { name: /^Stage: Offer/ })).toBeVisible();
    await candidate.getByRole("button", { name: "They accepted" }).click();
    // the hire sheet, on one card: the start date, a confirmation, then what to do with the role
    await expect(candidate.getByRole("heading", { name: "Hire Maria Reyes" })).toBeVisible();
    const start = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    await candidate.getByLabel("Start date (agreed with them)").fill(start);
    await candidate.getByRole("button", { name: "Continue" }).click();
    await expect(candidate.getByText(/^Record the hire of Maria Reyes, starting /)).toBeVisible();
    await expectAccessible(page, "candidate panel hire sheet");
    await candidate.getByRole("button", { name: "Yes, record the hire" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Maria Reyes is hired\./ })).toBeVisible();
    // nobody else is in the running here: the sheet offers to close the role now, and nobody is told anything by it
    await expect(candidate.getByRole("heading", { name: "Maria Reyes is hired: what about the role?" })).toBeVisible({ timeout: 30_000 });
    await expect(candidate.getByText("Close the role now and tell them")).toBeVisible();
    await candidate.getByRole("button", { name: "Close it now" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Role closed as filled\./ })).toBeVisible();
    await expect(candidate.getByRole("button", { name: /^Stage: Hired/ })).toBeVisible({ timeout: 30_000 });

    // closing the sheet clears the deep link from the address
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/open=/);

    // the interview sheet now shows the recorded decision and its note, and your own private note beside it
    await page.goto("/interviews");
    await expect(page.getByRole("cell", { name: /Maria Reyes/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "Finalist", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open", exact: true }).first().click();
    await expect(page.getByRole("dialog").getByText("Decision: Finalist")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/Calm, precise/)).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel("Your note on Maria")).toHaveValue(/Explained perio charting/);
    await expectAccessible(page, "interview sheet with the decision");
  });
});
