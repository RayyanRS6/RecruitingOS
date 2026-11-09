import { expect, test, type Page } from "@playwright/test";
import {
  PERSONAS, applicantThroughTheApi, createCompanyThroughTheForm, decideInPanel, emailsTo, expectAccessible, expectNoEmail, liveJobThroughTheApi, openTheDecision, openThePanel, recordTookPlace,
  setADateAndTime, signIn, skipWithoutFakeSignIn, waitForEmail, type Applicant,
} from "./helpers";

/**
 * After the interviews, in a real browser: deciding, the offer, the hire and closing the job, as an owner does them and as
 * the candidates see them. Two rounds and then Finalist, which the list says; the offer recorded with nothing sent, and the
 * candidate's own page saying it; "They declined", with the job still open. A hire while another interview is still to
 * come calls that interview off quietly; once the new hire has started, Home keeps asking to close the job, and closing it
 * opens on Filled, then tells the others with one Send after the Undo window. The applicants apply through the API: the
 * decisions are the subject here.
 */
const run = Date.now().toString(36);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });
const person = (first: string, last: string, tag: string): Applicant => ({ first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${tag}@example.com`, resume: PERSONAS.strong.resume });

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Bayview Dental ${tag}`;
  const owner = `owner+${tag}@bayview.test`;
  await signIn(page, { email: owner, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  const job = await liveJobThroughTheApi(page.request, base);
  // the job's two rounds, as the stand-in drafts them for a hygienist: a conversation, then a working interview
  const role = (await (await page.request.get(`${base}/api/v1/roles/${job.roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string; title: string }> } } } };
  const rounds = role.currentPacket.packet.interviews.plan;
  expect(rounds.map((r) => r.key)).toEqual(["owner", "working"]);
  return { company, owner, rounds, ...job };
}

/** From the panel's stage menu: Interviewing opens Set a date and time; book it. */
async function bookFromThePanel(page: Page, roleId: string, who: Applicant, daysAhead: number) {
  const panel = await openThePanel(page, roleId, `${who.first} ${who.last}`);
  await panel.getByRole("button", { name: /^Stage: / }).click();
  await panel.getByRole("menuitemradio", { name: /^Interviewing/ }).click();
  const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
  await expect(form).toBeVisible();
  await setADateAndTime(form, { first: who.first, daysAhead, time: "11:00", place: "Address", address: "200 Bay Street, Tustin" });
  await expect(toast(page, /Booked\./)).toBeVisible({ timeout: 30_000 });
  return panel;
}

test.describe("deciding, the offer, the hire and closing the job", () => {
  skipWithoutFakeSignIn();

  test("two rounds, then Finalist on the list; the offer recorded with nothing sent; they declined it, and the job stays open", async ({ page, baseURL }) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const ana = person("Ana", "Holt", `${run}a`);
    const { statusPath } = await applicantThroughTheApi(page.request, base, job, ana);

    // round one, booked, held, and Next round, which opens the second round's date and time
    await bookFromThePanel(page, job.roleId, ana, 2);
    let sheet = await recordTookPlace(page, "Ana Holt");
    let panel = await openTheDecision(page, sheet, "Ana Holt");
    await decideInPanel(panel, "Next round");
    await expect(toast(page, /Next round\./)).toBeVisible({ timeout: 30_000 });
    const second = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
    await expect(second).toBeVisible({ timeout: 30_000 });
    await expect(second.getByLabel("Round")).toHaveValue("working");
    await setADateAndTime(second, { first: "Ana", daysAhead: 4, time: "09:30", place: "Address", address: "200 Bay Street, Tustin" });
    await expect(toast(page, /Booked\..*The email to Ana is on its way\./)).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: ana.email, subject: new RegExp(`^Your interview: ${escape(job.rounds[1].title)} at ${escape(job.company)}, `), says: ["Hi Ana,", "Where: 200 Bay Street, Tustin"] });

    // round two held; Finalist
    sheet = await recordTookPlace(page, "Ana Holt", job.rounds[1].title);
    panel = await openTheDecision(page, sheet, "Ana Holt");
    await decideInPanel(panel, "Finalist");
    await expect(toast(page, /Marked as a finalist\./)).toBeVisible({ timeout: 30_000 });
    // the list says Finalist, not just Interviewing
    await page.keyboard.press("Escape");
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Ana Holt" }).getByText("Finalist", { exact: true })).toBeVisible({ timeout: 30_000 });
    // her own page: after a real interview, the step stays Interview (never back to Review), and never the word Finalist
    await page.goto(statusPath);
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText("Interview", { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(/finalist/i);

    // the offer, recorded: nothing is sent to her, and her page says the team made her an offer
    panel = await openThePanel(page, job.roleId, "Ana Holt");
    await expect(panel.getByRole("heading", { name: "Ana is a finalist: what next?" })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: /^Stage: / }).click();
    await panel.getByRole("menuitemradio", { name: /^Offer/ }).click();
    await panel.getByRole("button", { name: "Record the offer" }).click();
    await expect(toast(page, /Offer recorded\..*Nothing was sent to Ana/)).toBeVisible({ timeout: 30_000 });
    await page.goto(statusPath);
    await expect(page.getByText(/^The team has made you an offer\. They will go through it with you directly\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText("Decision");

    // they declined it: recorded, nothing sent, her page says so, and the job stays open for someone else
    panel = await openThePanel(page, job.roleId, "Ana Holt");
    await panel.getByRole("button", { name: "They declined" }).click();
    await expect(panel.getByText("Record that Ana declined the offer? It is recorded with your name; nothing is sent to them.")).toBeVisible();
    await panel.getByRole("button", { name: "Yes, record it" }).click();
    await expect(toast(page, /Recorded: they declined the offer\..*Nothing was sent to them\./)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Ana Holt" })).toContainText("Declined the offer", { timeout: 30_000 });
    await page.goto(statusPath);
    await expect(page.getByText("You turned down the offer. Thank you for your time with us.")).toBeVisible({ timeout: 30_000 });
    await page.goto(`/roles/${job.roleId}`);
    await expect(page.locator(".pill", { hasText: /^Live$/ }).first()).toBeVisible({ timeout: 30_000 });
    // in all of it, Ana got her two booking emails and nothing about the decision, the offer or her answer
    expect((await emailsTo(page.request, base, ana.email)).map((m) => m.subject.replace(/^(Your interview: .+?), .*$/, "$1")).sort()).toEqual([`Thank you for applying: your next step for ${job.title} at ${job.company}`, `Your interview: ${job.rounds[0].title} at ${job.company}`, `Your interview: ${job.rounds[1].title} at ${job.company}`].sort());
  });

  test("a hire with an interview still to come calls it off quietly; Home asks to close the job; closing opens on Filled and tells the other one", async ({ page, baseURL }) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const ben = person("Ben", "Ortiz", `${run}b`);
    const cleo = person("Cleo", "Park", `${run}b`);
    const forBen = await applicantThroughTheApi(page.request, base, job, ben);
    const forCleo = await applicantThroughTheApi(page.request, base, job, cleo);

    // Ben has an interview booked; they agreed the job by phone before it, so the owner records the hire from More
    const panel = await bookFromThePanel(page, job.roleId, ben, 3);
    await waitForEmail(page.request, base, { to: ben.email, subject: /^Your interview: / });
    await panel.getByRole("button", { name: "More choices" }).click();
    await page.getByRole("menuitem", { name: "Record an outcome" }).click();
    await expect(panel.getByRole("heading", { name: "Record what happened" })).toBeVisible();
    await panel.getByRole("button", { name: "Open the hire sheet" }).click();
    const hire = panel.locator(".card", { has: page.getByRole("heading", { name: "Hire Ben Ortiz" }) });
    await expect(hire).toBeVisible();
    // the sheet names the interview it calls off, and says nothing goes to Ben
    await expect(hire.getByText(new RegExp(`^Recorded with your name\\. Nothing is sent to Ben\\. The ${escape(job.rounds[0].title)} on .+ is called off, and the interviewers are told\\.$`))).toBeVisible();
    // he started yesterday: a hire recorded after the start
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await hire.getByLabel("Start date (agreed with them)").fill(yesterday);
    await hire.getByRole("button", { name: "Continue" }).click();
    await hire.getByRole("button", { name: "Yes, record the hire" }).click();
    await expect(toast(page, /Ben Ortiz is hired\..*Their interview still to come is called off; the interviewers were told\./)).toBeVisible({ timeout: 30_000 });
    // Cleo applied and is still in process: leave the job open for now; Home will keep asking
    const after = panel.locator(".card", { has: page.getByRole("heading", { name: "Ben Ortiz is hired: what about the role?" }) });
    await expect(after.getByText(/^Ben started on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/)).toBeVisible({ timeout: 30_000 });
    await expect(after.getByText(/The 1 person still in process moves to your talent pool/)).toBeVisible();
    await expect(after.getByText("Leave the role open for now. Nobody is told anything. Ben has already started, so Home asks you to close the role until you do.")).toBeVisible();
    await after.getByRole("button", { name: "Leave it open" }).click();
    await expect(toast(page, /The role stays open\..*Home asks you to close it until you do\./)).toBeVisible({ timeout: 30_000 });

    // the interview is off: not coming up any more, and Ben was sent nothing about it or the hire
    await page.goto("/interviews");
    await expect(page.getByRole("row").filter({ hasText: "Ben Ortiz" }).filter({ hasText: "Scheduled" })).toHaveCount(0, { timeout: 30_000 });
    await expectNoEmail(page.request, base, { to: ben.email, subject: /^(Cancelled|Your application)/, ms: 3_000 });
    await page.goto(forBen.statusPath);
    await expect(page.getByText("You are on the team.")).toBeVisible({ timeout: 30_000 });

    // Home keeps asking while the job is open after the hire has started
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `Close this job? ${job.title}` })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "Home asking to close the job");
    await page.getByRole("link", { name: "Close the job" }).click();
    const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Close this job" }) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    // it opens on Filled after a hire here; More's Close does the same
    await expect(card.getByLabel("Outcome")).toHaveValue("filled");
    await page.goto(`/roles/${job.roleId}`);
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Close the job" }).click();
    await expect(card.getByLabel("Outcome")).toHaveValue("filled", { timeout: 30_000 });
    await expect(card.getByRole("list", { name: "Still in process" }).getByText("Cleo Park")).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Confirm and close the job" }).click();
    const closing = page.locator("section.card").filter({ has: page.getByRole("heading", { name: /^Tell the people .+ left in process$/ }) });
    await expect(closing).toBeVisible({ timeout: 30_000 });
    await closing.getByRole("button", { name: "Send to 1 person" }).click();
    const sent = toast(page, /1 closing message on its way\./);
    await expect(sent).toBeVisible({ timeout: 30_000 });
    await expect(sent.getByRole("button", { name: "Undo all" })).toBeVisible();
    // nothing to Cleo inside the Undo window; then the closing message, by its words
    await expectNoEmail(page.request, base, { to: cleo.email, subject: `Your application to ${job.company}`, ms: 2_000 });
    await waitForEmail(page.request, base, {
      to: cleo.email,
      subject: `Your application to ${job.company}`,
      says: ["Hi Cleo,", `${job.company} has closed this position, so your application for this role will not go any further.`, "We would like to keep your information for future openings", `This message was sent by the hiring team at ${job.company} with help from an AI recruiting assistant.`],
      timeout: 90_000,
    });
    await page.goto(forCleo.statusPath);
    await expect(page.getByText(/has closed this position/).first()).toBeVisible({ timeout: 30_000 });
    // Home stops asking once it is closed
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: `Close this job? ${job.title}` })).toHaveCount(0);
  });
});
