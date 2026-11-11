import { expect, test, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, createCompanyThroughTheForm, emailsTo, exactlyOneEmail, expectAccessible, expectNoEmail, liveJobThroughTheApi, openTheDecision, openThePanel,
  recordTookPlace, setADateAndTime, signIn, skipWithoutFakeSignIn, waitForEmail, type Applicant,
} from "./helpers";

/**
 * Declining and telling, on both sides, in a real browser (founder decision B6: a decision is private until a person
 * tells them). Declining someone with a booked time names the interview first; they are told at once only that it is off,
 * and their page says nothing of the decision. Taking the decision back works in place. Declined again, one Send tells
 * them after the Undo window, in the words that fit: "after reviewing your background" before any interview, "thank you for
 * taking the time to meet the team" after one. Closing a job with someone still in process and pressing "Not now" leaves
 * them on Home as not told. The applicants apply through the API: the decisions are the subject here.
 */
const run = Date.now().toString(36);
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });
const person = (first: string, last: string, tag: string): Applicant => ({ first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`, resume: PERSONAS.possible.resume });

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Harborline Dental ${tag}`;
  await signIn(page, { email: `owner+${tag}@harborline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  return { company, ...(await liveJobThroughTheApi(page.request, base)) };
}

/** Stage, then Not moving forward, on the panel: the step with its notice, a reason, and the confirmation. */
async function declineFromThePanel(page: Page, panel: ReturnType<Page["getByRole"]>) {
  await panel.getByRole("button", { name: /^Stage: / }).click();
  await panel.getByRole("menuitemradio", { name: /^Not moving forward/ }).click();
  const step = panel.locator(".card", { has: page.getByRole("heading", { name: "Not moving forward" }) });
  await expect(step).toBeVisible();
  return step;
}

/** "{first} has not been told yet": Send message, the exact words, Send. Returns the preview's text. */
async function sendTheDecision(page: Page, panel: ReturnType<Page["getByRole"]>, first: string) {
  const tell = panel.locator(".card", { has: page.getByRole("heading", { name: `${first} has not been told yet` }) });
  await expect(tell).toBeVisible({ timeout: 30_000 });
  await expect(tell.getByText(`Your decision is private: nothing has been sent to ${first}.`)).toBeVisible();
  await tell.getByRole("button", { name: "Send message" }).click();
  const preview = tell.locator(".message-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const words = (await preview.textContent()) ?? "";
  await expectAccessible(page, "the decision message before it goes");
  await tell.getByRole("button", { name: /^Send/ }).last().click();
  return words;
}

test.describe("declining and telling", () => {
  skipWithoutFakeSignIn();

  test("a booked time: the notice names it, she is told only that it is off, taking it back works, and one Send tells her after the Undo window", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const ana = person("Ana", "Holt", `${run}a`);
    const { statusPath } = await applicantThroughTheApi(page.request, base, job, ana);

    // a booked time
    let panel = await openThePanel(page, job.roleId, "Ana Holt");
    await panel.getByRole("button", { name: /^Stage: / }).click();
    await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
    await setADateAndTime(form, { first: "Ana", daysAhead: 3, time: "15:00", place: "Address", address: "5 Harbor Way, Tustin" });
    await expect(toast(page, /Booked\./)).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: ana.email, subject: /^Your interview: / });

    // decline: before the press, the step says what is private, which interview is called off, and that she is told it is off
    const step = await declineFromThePanel(page, panel);
    await expect(step.getByText("Private: the decision is not sent now. Their interview is called off, and they get a short note saying so.")).toBeVisible();
    await step.getByText("What happens next", { exact: true }).click();
    await expect(step.getByText(/This cancels the .+ on .+, and the candidate is told now, in a short note that gives no reason, that it is off\./)).toBeVisible();
    await expectAccessible(page, "declining someone with a booked time");
    await step.getByRole("button", { name: "Confirm: not moving forward" }).click();
    await expect(toast(page, /Moved to Not moving forward\..*Their interview is cancelled, and they were sent a short note now saying only that it is off\./)).toBeVisible({ timeout: 30_000 });

    // the note: the interview is off, and nothing more; her page says nothing of the decision
    const off = await waitForEmail(page.request, base, { to: ana.email, subject: /^Cancelled: /, says: ["Hi Ana,", "is cancelled, so there is no need to attend."] });
    expect(off.text).not.toMatch(/not (be )?moving forward|decided/i);
    expect(off.attachments?.map((x) => [x.filename, x.contentType])).toEqual([["cancel.ics", "text/calendar; method=CANCEL"]]);
    await page.goto(statusPath);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(/not moving forward|decided not to/i);

    // taken back, in place: she is where she was, and nothing about it was ever sent
    panel = await openThePanel(page, job.roleId, "Ana Holt");
    const tell = panel.locator(".card", { has: page.getByRole("heading", { name: "Ana has not been told yet" }) });
    await expect(tell).toBeVisible({ timeout: 30_000 });
    await tell.getByRole("button", { name: "Take back this decision" }).click();
    await tell.getByRole("button", { name: "Yes, take it back" }).click();
    await expect(toast(page, /^Decision taken back/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: /^Stage: Not moving forward/ })).toHaveCount(0, { timeout: 30_000 });

    // declined again, and told with one Send: the words before any interview, after the Undo window
    const again = await declineFromThePanel(page, panel);
    // the interview is already off, so the notice has nothing more to call off
    await expect(again.getByText("Private: nothing is sent to them now.")).toBeVisible();
    await again.getByRole("button", { name: "Confirm: not moving forward" }).click();
    await expect(toast(page, /Moved to Not moving forward\./)).toBeVisible({ timeout: 30_000 });
    const words = await sendTheDecision(page, panel, "Ana");
    expect(words).toContain("After reviewing your background against what this role needs, the team has decided not to move forward at this time.");
    await expect(toast(page, /Ana|decision message/i).first()).toBeVisible({ timeout: 30_000 });
    // nothing inside the Undo window; then the message, by its words, once
    await expectNoEmail(page.request, base, { to: ana.email, subject: `Your application to ${job.company}`, ms: 3_000 });
    await waitForEmail(page.request, base, {
      to: ana.email,
      subject: `Your application to ${job.company}`,
      says: ["Hi Ana,", `Thank you for your interest in the ${job.title} position at ${job.company}.`, "After reviewing your background against what this role needs, the team has decided not to move forward at this time.", "We would like to keep your information for future openings", `This message was sent by the hiring team at ${job.company} with help from an AI recruiting assistant.`],
      timeout: 90_000,
    });
    await exactlyOneEmail(page.request, base, { to: ana.email, subject: `Your application to ${job.company}` });
    // she was told the interview was off once, and the decision does not tell her again
    expect((await emailsTo(page.request, base, ana.email, /^Your application to/))[0].text).not.toContain("is cancelled");
    await exactlyOneEmail(page.request, base, { to: ana.email, subject: /^Cancelled: / });
    // her page now says it
    await page.goto(statusPath);
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText("Decision", { timeout: 30_000 });
  });

  test("after an interview the message thanks them for meeting the team; a job closed with someone in process and Not now stays on Home as not told", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const ben = person("Ben", "Ortiz", `${run}b`);
    const cleo = person("Cleo", "Park", `${run}b`);
    await applicantThroughTheApi(page.request, base, job, ben);
    await applicantThroughTheApi(page.request, base, job, cleo);

    // Ben is interviewed, and the decision after it is not moving forward
    let panel = await openThePanel(page, job.roleId, "Ben Ortiz");
    await panel.getByRole("button", { name: /^Stage: / }).click();
    await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
    await setADateAndTime(panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: "Ben", daysAhead: 2, time: "13:00", place: "By phone" });
    await expect(toast(page, /Booked\./)).toBeVisible({ timeout: 30_000 });
    const sheet = await recordTookPlace(page, "Ben Ortiz");
    panel = await openTheDecision(page, sheet, "Ben Ortiz");
    await panel.getByRole("button", { name: "Not moving forward", exact: true }).click();
    await panel.getByRole("button", { name: "Confirm: not moving forward" }).click();
    await expect(toast(page, /Recorded: not moving forward\./)).toBeVisible({ timeout: 30_000 });
    const words = await sendTheDecision(page, panel, "Ben");
    expect(words).toContain(`Thank you for taking the time to meet the team at ${job.company}.`);
    await waitForEmail(page.request, base, { to: ben.email, subject: `Your application to ${job.company}`, says: ["Hi Ben,", `Thank you for taking the time to meet the team at ${job.company}. After the interviews, the team has decided not to move forward with your application for this role.`], timeout: 90_000 });

    // the job closes with Cleo still in process; Not now leaves her on Home as not told
    await page.keyboard.press("Escape");
    await page.goto(`/roles/${job.roleId}`);
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Close the job" }).click();
    const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Close this job" }) });
    await expect(card.getByRole("list", { name: "Still in process" }).getByText("Cleo Park")).toBeVisible({ timeout: 30_000 });
    await card.getByLabel("Outcome").selectOption("no_hire");
    await card.getByRole("button", { name: "Confirm and close the job" }).click();
    const closing = page.locator("section.card").filter({ has: page.getByRole("heading", { name: /^Tell the people .+ left in process$/ }) });
    await expect(closing).toBeVisible({ timeout: 30_000 });
    await expect(closing.getByText(/^Not now leaves them on your Home page as not told yet\./)).toBeVisible();
    await closing.getByRole("button", { name: "Not now" }).click();
    await expect(closing).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `1 person has not been told your decision yet (${job.title})` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Send the closing message" })).toBeVisible();
    await expectNoEmail(page.request, base, { to: cleo.email, subject: `Your application to ${job.company}`, ms: 1_000 });
  });
});
