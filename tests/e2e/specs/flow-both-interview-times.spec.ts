import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, createCompanyThroughTheForm, exactlyOneEmail, expectAccessible, expectNoEmail, linkIn, liveJobThroughTheApi, openThePanel, saveMyHours, setADateAndTime,
  signIn, skipWithoutFakeSignIn, waitForEmail, type Applicant,
} from "./helpers";

/**
 * Setting interview times, on both sides, in a real browser (the owner, 6 November 2026: "nadine can send and offer times?
 * but the times cannot be set by nadine? shouldnt the process be like nadine sets date and time ... and he/she will get the
 * mail???"). An interview with no time, as the owner's own was, says so on the list, the panel and the sheet, waits on a
 * person, and one press books it. With hours saved, the old way is still there through its fold: times by email, the
 * candidate picks, a confirmation with the calendar file; or a person books one of the offered times for them. Two people
 * at the same time: the clash is named, and Book anyway books it. Every email is read by its words. The applicants apply
 * through the API: the interview is the subject here, not the application.
 */
const run = Date.now().toString(36);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Seaside Dental ${tag}`;
  await signIn(page, { email: `owner+${tag}@seaside.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  const job = await liveJobThroughTheApi(page.request, base);
  return { company, ...job };
}

const person = (first: string, last: string, tag: string, resume: string = PERSONAS.strong.resume): Applicant => ({ first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`, resume });

/** The interviews list's row for someone: its word and its note. */
const interviewRow = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

/**
 * Whether someone is under "Waiting on you" on the job's Candidates list. The chip is there only while anyone waits, so
 * no chip means nobody does.
 */
async function waitsOnYou(page: Page, roleId: string, name: string): Promise<boolean> {
  await page.goto(`/roles/${roleId}/talent`);
  await expect(page.locator(".talent-row").first()).toBeVisible({ timeout: 30_000 });
  const chip = page.getByRole("button", { name: /^Waiting on you/ });
  if (!(await chip.count())) return false;
  await chip.click();
  await expect(page.getByRole("button", { name: /^Waiting on you/, pressed: true })).toBeVisible();
  return (await page.locator(".talent-row").filter({ hasText: name }).count()) > 0;
}

/**
 * The owner's stuck interview, built the way it was built before 6 November 2026 (not the subject here): "Approve and
 * offer times" with nobody's hours or calendar, so nothing could ever be offered.
 */
async function anInterviewWithNoTime(request: APIRequestContext, base: string, roleId: string, applicationId: string) {
  const role = (await (await request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
  const me = (await (await request.get(`${base}/api/v1/auth/me`)).json()) as { user: { id: string } };
  const made = await request.post(`${base}/api/v1/applications/${applicationId}/interviews`, { data: { roundKey: role.currentPacket.packet.interviews.plan[0].key, interviewerUserIds: [me.user.id], linkSource: "calendar" } });
  expect(made.status(), await made.text()).toBe(201);
}

test.describe("setting interview times", () => {
  skipWithoutFakeSignIn();

  test("an interview with no time, as the owner's was: the list, the panel and the sheet say so, it waits on a person, and one press books it", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const ana = person("Ana", "Holt", `${run}a`);
    const seeded = await applicantThroughTheApi(page.request, base, job, ana);
    await anInterviewWithNoTime(page.request, base, job.roleId, seeded.applicationId);

    // Interviews: one true word, never "Waiting on the candidate" or "Preparing times" for times nobody offered
    await page.goto("/interviews");
    const row = interviewRow(page, "Ana Holt");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText("No time yet", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row).not.toContainText(/Waiting on the candidate|Preparing times/);
    // it waits on a person: Waiting on you lists her
    expect(await waitsOnYou(page, job.roleId, "Ana Holt"), "an interview with no time waits on a person").toBe(true);

    // the sheet has the form on it
    await page.goto("/interviews");
    await row.getByRole("link", { name: "Open", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.locator(".card", { has: page.getByRole("heading", { name: "Set the date and time" }) })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the sheet of an interview with no time");

    // the panel: a card that says what is missing, with the one button; the press books this same interview
    const panel = await openThePanel(page, job.roleId, "Ana Holt");
    const card = panel.locator(".card", { has: page.getByRole("heading", { name: /^The .+ has no time yet$/ }) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("link", { name: "Open the interview" })).toHaveAttribute("href", /^\/interviews\/[0-9a-f-]{36}$/);
    await card.getByRole("button", { name: "Set a date and time" }).click();
    await expect(card.getByLabel("Time (America/Los_Angeles)")).toBeVisible();
    await expectAccessible(page, "the panel's card for an interview with no time");
    await setADateAndTime(card, { first: "Ana", daysAhead: 5, time: "14:00", place: "By phone" });
    await expect(toast(page, /Booked\..*The email to Ana is on its way\./)).toBeVisible({ timeout: 30_000 });

    // one email, the booking, with the phone line; nothing ever asked her to pick
    const booked = await waitForEmail(page.request, base, {
      to: ana.email,
      subject: new RegExp(`^Your interview: .+ at ${escape(job.company)}, .+ (AM|PM)`),
      // she gave no phone number on the form, so the email asks for one rather than naming a number
      says: ["Hi Ana,", `Good news: ${job.company} would like to interview you for the ${job.title} position.`, "When: ", "How long: ", `By phone: ${job.company} will call you. Reply with the best number to reach you.`, "Need a different time?", "Need an adjustment, such as captions or a phone call instead of video?"],
    });
    expect(booked.attachments?.map((x) => x.filename)).toEqual(["interview.ics"]);
    await exactlyOneEmail(page.request, base, { to: ana.email, subject: /^Your interview: / });
    await expectNoEmail(page.request, base, { to: ana.email, subject: /^Pick a time/, ms: 1_000 });

    // booked: Scheduled on the list, and nothing waits on anyone any more
    await page.goto("/interviews");
    await expect(row.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await waitsOnYou(page, job.roleId, "Ana Holt"), "a booked interview waits on nobody").toBe(false);
    // her own page has it booked
    await page.goto(seeded.statusPath);
    await expect(page.getByText("Your interview is booked. The details are below and in your email.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/ · By phone/)).toBeVisible();
  });

  test("with hours saved, the old way through its fold: times by email and the candidate picks; or a person books an offered time for them", async ({ page, browser, baseURL }) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const ben = person("Ben", "Ortiz", `${run}b`, PERSONAS.possible.resume);
    const cleo = person("Cleo", "Park", `${run}b`, PERSONAS.possible.resume);
    const forBen = await applicantThroughTheApi(page.request, base, job, ben);
    await applicantThroughTheApi(page.request, base, job, cleo);
    await saveMyHours(page);

    // Ben: the stage menu's Interviewing opens Set a date and time; with hours, the old way is one fold under it
    for (const who of [ben, cleo]) {
      const panel = await openThePanel(page, job.roleId, `${who.first} ${who.last}`);
      await panel.getByRole("button", { name: /^Stage: / }).click();
      await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
      const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
      await expect(form).toBeVisible();
      await form.getByText("Or let them pick from your free times", { exact: true }).click();
      await expect(form.getByText(`${who.first} gets times from the interviewers' hours by email and picks one.`)).toBeVisible();
      await form.getByRole("button", { name: "Offer times to pick from" }).click();
      await expect(toast(page, /Times are being worked out\./)).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
    }

    // the times email, by its words
    const times = await waitForEmail(page.request, base, {
      to: ben.email,
      subject: `Pick a time for your interview: ${job.title} at ${job.company}`,
      says: ["Hi Ben,", `Good news: ${job.company} would like to interview you for the ${job.title} position.`, "Pick a time that works for you (times shown in", "Choose here: ", "If none of these work, the same page lets you tell us what does."],
    });
    await exactlyOneEmail(page.request, base, { to: ben.email, subject: /^Pick a time/ });
    // on the list: waiting on the candidate, with how many times went; Waiting on you leaves them out
    await page.goto("/interviews");
    await expect(interviewRow(page, "Ben Ortiz").getByText("Waiting on the candidate", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(interviewRow(page, "Ben Ortiz")).toContainText(/\d+ times? offered/);
    expect(await waitsOnYou(page, job.roleId, "Ben Ortiz"), "times that reached him wait on him, not on the team").toBe(false);

    // Ben picks from the link in his email, in a browser of his own
    const context = await browser.newContext({ baseURL: base });
    const cand = await context.newPage();
    await cand.goto(linkIn(times, "/c/schedule/"));
    await expect(cand.getByRole("heading", { name: /Pick a time/ })).toBeVisible({ timeout: 30_000 });
    await cand.getByRole("radio").first().check();
    await cand.getByRole("button", { name: "Confirm this time" }).click();
    await expect(cand.getByRole("heading", { name: /confirmed|Booking your time/ })).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await cand.reload();
      await expect(cand.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    const confirmed = await waitForEmail(page.request, base, {
      to: ben.email,
      subject: new RegExp(`^Confirmed: .+ at ${escape(job.company)}, `),
      says: ["Hi Ben,", `You are confirmed: `, `for the ${job.title} position at ${job.company}.`, "What to prepare:", "A calendar invitation is attached. Need to change it?", "Need an adjustment, such as captions or a phone call instead of video?"],
    });
    expect(confirmed.attachments?.map((x) => [x.filename, x.contentType])).toEqual([["interview.ics", "text/calendar; method=REQUEST"]]);
    await exactlyOneEmail(page.request, base, { to: ben.email, subject: /^Confirmed: / });
    await waitForEmail(page.request, base, { to: `owner+${run}b@seaside.test`, subject: `Interview booked: Ben Ortiz for ${job.title}`, says: ["/interviews/"] });
    await page.goto("/interviews");
    await expect(interviewRow(page, "Ben Ortiz").getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.goto(forBen.statusPath);
    await expect(page.getByText("Your interview is booked. The details are below and in your email.")).toBeVisible({ timeout: 30_000 });
    await context.close();

    // Cleo agreed a time by phone: a person books one of the offered times for her, and she gets the confirmation. She was
    // offered the time Ben has just taken: booking that one for her is refused at once, in words, and nothing moves (found
    // by this walk, 10 November 2026: it said "Booking that time for them" and never booked).
    await page.goto("/interviews");
    const bensTime = (await interviewRow(page, "Ben Ortiz").locator("td").nth(2).innerText()).split("\n")[0].trim();
    await interviewRow(page, "Cleo Park").getByRole("link", { name: "Open", exact: true }).click();
    const sheet = page.getByRole("dialog");
    const offered = sheet.locator(".card", { has: page.getByRole("heading", { name: "Times offered to the candidate" }) });
    await expect(offered).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the sheet with times offered");
    const taken = offered.locator("li").filter({ hasText: bensTime });
    await expect(taken, `Cleo was offered Ben's time, ${bensTime}`).toHaveCount(1);
    const offeredCount = await offered.locator("li").count();
    await taken.getByRole("button", { name: "Book this for them" }).click();
    await expect(toast(page, "That time is no longer free: an interviewer was booked for another interview then. Choose another time.")).toBeVisible({ timeout: 30_000 });
    await expectNoEmail(page.request, base, { to: cleo.email, subject: /^Confirmed: /, ms: 3_000 });
    await expect(offered.locator("li"), "her times are still offered, as they were").toHaveCount(offeredCount);
    // the last of her times, well away from Ben's, books
    await offered.locator("li").filter({ hasNotText: bensTime }).last().getByRole("button", { name: "Book this for them" }).click();
    await expect(toast(page, /Booked on the candidate's behalf\.|Booking that time for them\./)).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: cleo.email, subject: new RegExp(`^Confirmed: .+ at ${escape(job.company)}, `), says: ["Hi Cleo,", "You are confirmed: ", "What to prepare:"] });
    await exactlyOneEmail(page.request, base, { to: cleo.email, subject: /^Confirmed: / });
    await page.goto("/interviews");
    await expect(interviewRow(page, "Cleo Park").getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test("two people at the same time: the clash is named before anything is booked, and Book anyway books it", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}c`);
    const dev = person("Dev", "Dutta", `${run}c`);
    const eve = person("Eve", "Ellis", `${run}c`);
    await applicantThroughTheApi(page.request, base, job, dev);
    await applicantThroughTheApi(page.request, base, job, eve);

    for (const [who, clash] of [[dev, false], [eve, true]] as const) {
      const panel = await openThePanel(page, job.roleId, `${who.first} ${who.last}`);
      await panel.getByRole("button", { name: /^Stage: / }).click();
      await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
      const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
      await expect(form).toBeVisible();
      await setADateAndTime(form, { first: who.first, daysAhead: 6, time: "09:00", place: "Video link", clash });
      if (clash) {
        const named = form.getByText(/^Dana( Whitfield)? already has an interview at that time\.$/);
        await expect(named).toBeVisible({ timeout: 30_000 });
        await expect(toast(page, /Booked\./)).toHaveCount(0);
        await expectNoEmail(page.request, base, { to: who.email, subject: /^Your interview: /, ms: 2_000 });
        await expectAccessible(page, "the clash, named");
        await form.getByRole("button", { name: "Book anyway" }).click();
      }
      await expect(toast(page, new RegExp(`Booked\\..*The email to ${who.first} is on its way\\.`))).toBeVisible({ timeout: 30_000 });
      await waitForEmail(page.request, base, { to: who.email, subject: new RegExp(`^Your interview: .+ at ${escape(job.company)}, `), says: [`Hi ${who.first},`, "Need a different time?"] });
      await page.keyboard.press("Escape");
    }
    await page.goto("/interviews");
    for (const name of ["Dev Dutta", "Eve Ellis"]) await expect(interviewRow(page, name).getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
