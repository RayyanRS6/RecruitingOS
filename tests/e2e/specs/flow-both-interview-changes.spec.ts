import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, createCompanyThroughTheForm, emailsTo, exactlyOneEmail, expectAccessible, expectNoEmail, linkIn, liveJobThroughTheApi, openTheDecision, openThePanel,
  setADateAndTime, signIn, skipWithoutFakeSignIn, waitForEmail, type Applicant,
} from "./helpers";

/**
 * When a booked interview changes, on both sides, in a real browser. The team moves it with a reason and later cancels
 * it: one email each, with the reason, and the calendar files that follow. The candidate asks for a different time twice
 * (the time stands until a person sets a new one, and the team hears each time), then cancels and asks for new times: the
 * team sees them under Cancelled and sets a new date and time, and the email says so. They did not come: a person sets a
 * new time. Our interviewer did not come: the same round again, and the email says sorry. Every email is read by its
 * words. The applicants apply through the API: the interview is the subject here.
 */
const run = Date.now().toString(36);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });
const person = (first: string, last: string, tag: string): Applicant => ({ first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`, resume: PERSONAS.strong.resume });

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Cove Dental ${tag}`;
  await signIn(page, { email: `owner+${tag}@cove.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  const job = await liveJobThroughTheApi(page.request, base);
  const role = (await (await page.request.get(`${base}/api/v1/roles/${job.roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ title: string }> } } } };
  return { company, round: role.currentPacket.packet.interviews.plan[0].title, ...job };
}

/** Booked from the panel, by address (one interviewer: two people need two times); returns the booking email. */
async function bookIt(page: Page, base: string, roleId: string, who: Applicant, daysAhead: number, time = "10:30") {
  const panel = await openThePanel(page, roleId, `${who.first} ${who.last}`);
  await panel.getByRole("button", { name: /^Stage: / }).click();
  await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
  await setADateAndTime(panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: who.first, daysAhead, time, place: "Address", address: "9 Cove Road, Tustin" });
  await expect(toast(page, /Booked\./)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  return waitForEmail(page.request, base, { to: who.email, subject: /^Your interview: / });
}

/** The interview's sheet from the Interviews list. */
async function openTheSheet(page: Page, name: string, status: string | RegExp = "Scheduled") {
  await page.goto("/interviews");
  const row = page.getByRole("row").filter({ hasText: name }).filter({ hasText: status });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("link", { name: "Open", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Interviewers", { exact: true })).toBeVisible({ timeout: 30_000 });
  return sheet;
}

async function asTheCandidate(browser: Browser, base: string) {
  const context = await browser.newContext({ baseURL: base });
  return { context, page: await context.newPage() };
}

test.describe("when a booked interview changes", () => {
  skipWithoutFakeSignIn();

  test("the team moves it with a reason, then cancels it: one email each, with the reason and the calendar file", async ({ page, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const ana = person("Ana", "Holt", `${run}a`);
    const { statusPath } = await applicantThroughTheApi(page.request, base, job, ana);
    await bookIt(page, base, job.roleId, ana, 3);

    // Move it: the form opens on the booked time; a new day and time, a reason she reads
    let sheet = await openTheSheet(page, "Ana Holt");
    const change = sheet.locator(".card", { has: page.getByRole("heading", { name: "Change it" }) });
    await change.getByRole("button", { name: "Move it" }).click();
    await expect(change.getByLabel(/^Time \(/)).toHaveValue("10:30");
    await change.getByLabel("Reason (optional, Ana sees it)").fill("The dentist is away that morning.");
    await setADateAndTime(change, { first: "Ana", daysAhead: 4, time: "14:00" });
    await expect(toast(page, /Moved\..*The email to Ana is on its way\./)).toBeVisible({ timeout: 30_000 });
    const moved = await waitForEmail(page.request, base, {
      to: ana.email,
      subject: new RegExp(`^New time for your interview: ${escape(job.round)} at ${escape(job.company)}, .+ 2:00 PM P[SD]T$`),
      says: ["Hi Ana,", `${job.company} has moved your `, `${job.company} said: "The dentist is away that morning."`, "Where: 9 Cove Road, Tustin", "A calendar invitation is attached. Need a different time?"],
    });
    expect(moved.attachments?.map((x) => [x.filename, x.contentType])).toEqual([["interview.ics", "text/calendar; method=REQUEST"]]);
    await exactlyOneEmail(page.request, base, { to: ana.email, subject: /^New time for your interview/ });
    // one email, not a cancellation and a new invitation
    await expectNoEmail(page.request, base, { to: ana.email, subject: /^Cancelled:/, ms: 1_000 });
    await page.goto(statusPath);
    await expect(page.getByText(/2:00 PM/).first()).toBeVisible({ timeout: 30_000 });

    // the team cancels with a reason she reads
    sheet = await openTheSheet(page, "Ana Holt");
    const again = sheet.locator(".card", { has: page.getByRole("heading", { name: "Change it" }) });
    await again.getByRole("button", { name: "Cancel interview" }).click();
    await again.getByLabel("Reason (the candidate sees it)").fill("The dentist is unwell this week.");
    await expectAccessible(page, "cancelling an interview with a reason");
    await again.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(toast(page, /Interview cancelled\..*The candidate was sent a cancellation\./)).toBeVisible({ timeout: 30_000 });
    const cancelled = await waitForEmail(page.request, base, {
      to: ana.email,
      subject: `Cancelled: ${job.round} at ${job.company}`,
      says: ["Hi Ana,", `${job.company} had to cancel your interview (${job.round}): The dentist is unwell this week. They will be in touch about next steps.`],
    });
    expect(cancelled.attachments?.map((x) => [x.filename, x.contentType])).toEqual([["cancel.ics", "text/calendar; method=CANCEL"]]);
    // the sheet offers to set it up again, with a person's date and time
    await expect(page.getByRole("dialog").getByRole("link", { name: "Set a new date and time" })).toBeVisible({ timeout: 30_000 });
  });

  test("the candidate asks for a different time twice, then cancels and asks for new times; a person sets the new time", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const ben = person("Ben", "Ortiz", `${run}b`);
    await applicantThroughTheApi(page.request, base, job, ben);
    const booked = await bookIt(page, base, job.roleId, ben, 3);
    const cand = await asTheCandidate(browser, base);
    const confirmed = linkIn(booked, "/c/schedule/");

    // twice: "Ask for a different time"; the time stands, and the team hears each time with what suits him
    for (const [i, note] of ["Mornings next week, please.", "Any afternoon after the 20th."].entries()) {
      await cand.page.goto(confirmed);
      await expect(cand.page.getByRole("heading", { level: 1, name: "Your interview is booked" })).toBeVisible({ timeout: 30_000 });
      await expect(cand.page.getByText("We will tell the team. This time stands until you hear from them.")).toBeVisible();
      await cand.page.getByLabel("What suits you better? (optional)").fill(note);
      await cand.page.getByRole("button", { name: "Ask for a different time" }).click();
      await expect(cand.page.getByText("We told the team.")).toBeVisible({ timeout: 30_000 });
      await expect(cand.page.getByText("This time stands until you hear from them.").first()).toBeVisible();
      await page.goto("/updates");
      await expect(page.getByRole("listitem").filter({ hasText: "Ben Ortiz asked for a different time" })).toHaveCount(i + 1, { timeout: 30_000 });
      await expect(page.getByRole("listitem").filter({ hasText: note })).toHaveCount(1);
    }
    // a third time is not offered; the page says a person will arrange it
    await cand.page.goto(confirmed);
    await expect(cand.page.getByText("You have asked for a different time twice. Reply to any of our emails and a person will arrange a time with you.")).toBeVisible({ timeout: 30_000 });
    await expect(cand.page.getByRole("button", { name: "Ask for a different time" })).toHaveCount(0);
    // the time still stands on Interviews, and the sheet counts both
    const sheet = await openTheSheet(page, "Ben Ortiz");
    await expect(sheet.getByText("2 of 2", { exact: true })).toBeVisible();
    await expectNoEmail(page.request, base, { to: ben.email, subject: /^(New time|Cancelled)/, ms: 1_000 });

    // he cancels, asking for new times later; nobody has hours, so the page promises a person, not a day
    await cand.page.getByText("I need to cancel", { exact: true }).click();
    await cand.page.getByRole("radio", { name: "Send me new times later" }).check();
    await cand.page.getByRole("checkbox", { name: "Yes, cancel this interview." }).check();
    await cand.page.getByRole("button", { name: "Cancel the interview" }).click();
    await expect(cand.page.getByRole("heading", { level: 1, name: "Your interview is cancelled" })).toBeVisible({ timeout: 30_000 });
    await expect(cand.page.getByText(/Someone from the team will be in touch about them\./)).toBeVisible();
    await waitForEmail(page.request, base, { to: ben.email, subject: `Cancelled: ${job.round} at ${job.company}`, says: ["Hi Ben,", `As requested, your interview (${job.round}) at ${job.company} is cancelled.`, "You asked for new times, so someone from the team will be in touch about them."] });

    // the team: under Cancelled, with the reason and Set a date and time first
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.getByRole("tablist", { name: "Stages" }).getByRole("tab", { name: /^Cancelled 1$/ })).toBeVisible({ timeout: 30_000 });
    const panel = await openThePanel(page, job.roleId, "Ben Ortiz");
    const card = panel.locator(".card", { has: page.getByRole("heading", { name: "Ben cancelled and asked for new times" }) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "someone under Cancelled");
    await card.getByRole("button", { name: "Set a date and time" }).click();
    const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
    await setADateAndTime(form, { first: "Ben", daysAhead: 6, time: "09:00", place: "Address", address: "9 Cove Road, Tustin" });
    await expect(toast(page, /Booked\..*The email to Ben is on its way\./)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await emailsTo(page.request, base, ben.email, /^Your interview: /)).length, { timeout: 60_000 }).toBe(2);
    const newer = (await emailsTo(page.request, base, ben.email, /^Your interview: /))[0];
    expect(newer.text).toContain(`${job.company} has set a new time for your `);
    expect(newer.subject).toMatch(/ 9:00 AM P[SD]T$/);
    await cand.context.close();
  });

  test("no-shows: they did not come and a person sets a new time; our interviewer did not come, and the same round again says sorry", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}c`);
    const cleo = person("Cleo", "Park", `${run}c`);
    const dev = person("Dev", "Dutta", `${run}c`);
    await applicantThroughTheApi(page.request, base, job, cleo);
    await applicantThroughTheApi(page.request, base, job, dev);
    await bookIt(page, base, job.roleId, cleo, 2, "10:30");
    await bookIt(page, base, job.roleId, dev, 2, "13:30");

    // Cleo did not come: under Cancelled, nothing goes to her by itself, and a person sets a new time
    let sheet = await openTheSheet(page, "Cleo Park");
    await sheet.getByRole("button", { name: "Candidate did not show" }).click();
    await expect(toast(page, /^Recorded\./)).toBeVisible({ timeout: 30_000 });
    await expectNoEmail(page.request, base, { to: cleo.email, subject: /^(Cancelled|New)/, ms: 2_000 });
    let panel = await openThePanel(page, job.roleId, "Cleo Park");
    const noShow = panel.locator(".card", { has: page.getByRole("heading", { name: "Cleo did not come to the interview" }) });
    await expect(noShow).toBeVisible({ timeout: 30_000 });
    await expect(noShow.getByText(/they did not come\. Nothing goes to them automatically\./)).toBeVisible();
    await noShow.getByRole("button", { name: "Set a date and time" }).click();
    await setADateAndTime(panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: "Cleo", daysAhead: 5, time: "11:00", place: "Address", address: "9 Cove Road, Tustin" });
    await expect(toast(page, /Booked\..*The email to Cleo is on its way\./)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await emailsTo(page.request, base, cleo.email, /^Your interview: /)).length, { timeout: 60_000 }).toBe(2);
    expect((await emailsTo(page.request, base, cleo.email, /^Your interview: /))[0].subject).toMatch(/ 11:00 AM P[SD]T$/);

    // our interviewer did not come: the decision card puts the same round again first, and the email apologises
    sheet = await openTheSheet(page, "Dev Dutta");
    await sheet.getByRole("button", { name: "We did not show" }).click();
    await expect(toast(page, /^Recorded\./)).toBeVisible({ timeout: 30_000 });
    panel = await openTheDecision(page, sheet, "Dev Dutta");
    const decision = panel.locator(".card", { has: page.getByRole("heading", { name: "How did the interview go?" }) });
    await expect(decision.getByText("Our interviewer missed it. The new invitation says sorry.")).toBeVisible({ timeout: 30_000 });
    await decision.getByRole("button", { name: "Set the same round again" }).click();
    await setADateAndTime(panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) }), { first: "Dev", daysAhead: 5, time: "15:30", place: "Address", address: "9 Cove Road, Tustin" });
    await expect(toast(page, /Booked\..*The email to Dev is on its way\./)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await emailsTo(page.request, base, dev.email, /^Your interview: /)).length, { timeout: 60_000 }).toBe(2);
    const sorry = (await emailsTo(page.request, base, dev.email, /^Your interview: /))[0];
    expect(sorry.text).toContain(`We are sorry: the interviewer from ${job.company} could not join your last interview for the ${job.title} position.`);
  });
});
