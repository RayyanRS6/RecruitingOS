import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The loop after an interview in a real browser (audit findings F6 and J13): the owner sets the date and time herself
 * (6 November 2026: no calendar and no declared hours needed, and one press books it), the candidate's page shows it
 * booked, the owner records that it took place from the interview sheet, follows the deep link to the candidate's sheet,
 * and records the decision there; then (plan Wave H) writes a private team note, records the offer made outside the app,
 * the candidate's yes on the one-sheet hire, and closes the role from it. Every page visited is checked against WCAG 2.1
 * AA with axe. Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);

test.describe("decision after an interview", () => {
  skipWithoutFakeSignIn();
  // the waiting room opens every interview after 40 to 90 seconds at least (Q14), so seeding an applicant takes longer
  test.slow();
  test("record the outcome on the interview sheet, then the decision on the candidate sheet through the deep link", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Dental ${run}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // the owner opens the candidate and moves them to Interviewing, which opens "Set a date and time": nobody has
    // declared hours or connected a calendar, and none is needed
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const sheet = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /^Stage: / }).click();
    await sheet.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await expect(sheet.getByRole("heading", { name: "Set a date and time" })).toBeVisible();
    // greyed with its reason until the day and time are chosen; the time is on the company's clock, named beside it
    await expect(sheet.getByText("Choose a date and a time.", { exact: true })).toBeVisible();
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await sheet.getByLabel("Date", { exact: true }).fill(day);
    await sheet.getByLabel(/^Time \(/).fill("10:30");
    await expect(sheet.getByText(/ at 10:30 AM, America\//)).toBeVisible();
    // an optional personal line for the invitation (Q28), checked like any other
    await sheet.getByText("Add a personal line (optional)", { exact: true }).click();
    await sheet.getByLabel("A personal line for the invitation (optional)").fill("We enjoyed reading about your work.");
    await expectAccessible(page, "set a date and time with a personal line");
    await sheet.getByRole("button", { name: /^Book( and email Maria)?$/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /Booked\./ })).toBeVisible();

    // the candidate's own page has it booked: nothing for them to pick
    await page.goto(seeded.statusPath);
    await expect(page.getByText(/Your interview is booked/).first()).toBeVisible({ timeout: 30_000 });

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
    await expect(candidate.getByText("Close the job now and tell them")).toBeVisible();
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
