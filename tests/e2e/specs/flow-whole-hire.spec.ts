import { expect, test, type Page } from "@playwright/test";
import {
  PERSONAS, applyThroughTheForm, candidateRow, candidateTabs, createCompanyThroughTheForm, doTheAiInterview, emailsTo, exactlyOneEmail, expectAccessible, gotoSettled, namesInOrder, openThePanel,
  publishedJobThroughTheApi, scoreOn, signIn, signInAsAdmin, skipWithoutFakeSignIn, statusPathFromEmail, waitForEmail, waitForLink, type Applicant,
} from "./helpers";

/**
 * The whole hire on one job, in a real browser through the real screens. Three people apply. The owner reads them
 * ranked by resume score, best first; shortlists the first, which emails her the AI interview; and marks the last Not
 * selected, privately. The shortlisted candidate opens the emailed link, does the AI interview and presses Send my
 * answers; only then does anything of it reach the team. The owner reads the interview score and hires her, and emails
 * the decision to the one not selected, after reading the email as it will go. The platform administrator then opens
 * the company and sees its job as counts, with nobody named. Each email is found right after the press that sends it.
 *
 * The job is made through the API (flow-owner-build-publish-share.spec.ts walks the builder).
 */
const run = Date.now().toString(36);
/** A decision email waits out its Undo window before it leaves. */
const AFTER_UNDO = 90_000;

test.describe("the whole hire", () => {
  skipWithoutFakeSignIn();

  test("ranked by score, one shortlisted, interviewed by the AI and hired, one not selected and told; the administrator sees the job as counts", async ({ page, browser, baseURL }) => {
    test.setTimeout(1_200_000);
    const base = baseURL!;
    const company = `Harbor Smiles ${run}`;
    await signIn(page, { email: `owner+${run}@harborsmiles.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    const job = await publishedJobThroughTheApi(page.request, base);
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };
    const ben: Applicant = { first: "Ben", last: "Ortiz", email: `ben.ortiz+${run}@example.com`, resume: PERSONAS.possible.resume };
    const cal: Applicant = { first: "Cal", last: "Avery", email: `cal.avery+${run}@example.com`, resume: PERSONAS.weak.resume };
    const [anaName, benName, calName] = [ana, ben, cal].map((who) => `${who.first} ${who.last}`);

    // ---- 1. Three people apply, the weakest resume first, so the order on the list is the score's and not the day's ----------
    const c = await applyThroughTheForm(browser, base, job.jobUrl, cal);
    await c.context.close();
    const b = await applyThroughTheForm(browser, base, job.jobUrl, ben);
    await b.context.close();
    const a = await applyThroughTheForm(browser, base, job.jobUrl, ana);
    const calStatus = await statusPathFromEmail(page.request, base, cal.email);
    for (const who of [ana, ben, cal]) expect((await emailsTo(page.request, base, who.email)).length, `${who.first} got one email, the receipt`).toBe(1);

    // ---- 2. The owner reads them, ranked by resume score, best first -------------------------------------------------------------
    await page.goto(`/roles/${job.roleId}/talent`);
    const resume: Record<string, number> = {};
    for (const name of [anaName, benName, calName]) resume[name] = await scoreOn(candidateRow(page, name), "Resume match");
    await expect(candidateTabs(page).getByRole("tab", { name: /^New 3$/ })).toBeVisible();
    const order = await namesInOrder(page);
    expect(order, "everyone is listed once").toHaveLength(3);
    expect(order.map((name) => resume[name]), "the list is in the score's order, highest first").toEqual([...order.map((name) => resume[name])].sort((x, y) => y - x));
    expect(order[0], "everything the job asks for is shown on her resume").toBe(anaName);
    expect(order[2], "his resume says he does not hold the license").toBe(calName);
    expect(resume[anaName]).toBeGreaterThan(resume[calName]);
    await expect(candidateRow(page, anaName).locator(".score-band")).toHaveText(/^(Very high|High|Medium|Low)$/);
    await expectAccessible(page, "the candidates, ranked");

    // the panel says why: every requirement with its finding
    const first = await openThePanel(page, anaName);
    await expect(first.getByRole("heading", { name: "Resume match" })).toBeVisible();
    await expect(first.getByRole("list", { name: "Requirements" }).getByRole("listitem").first()).toBeVisible({ timeout: 30_000 });
    await expect(first.getByText("Not sent.")).toBeVisible();
    await expectAccessible(page, "the candidate panel with the resume match");
    await page.keyboard.press("Escape");

    // ---- 3. Shortlist Ana: the AI interview goes to her by email, and to nobody else ---------------------------------------------
    await candidateRow(page, anaName).getByRole("button", { name: `Shortlist: ${anaName}` }).click();
    await expect(candidateTabs(page).getByRole("tab", { name: /^Shortlisted 1$/ })).toBeVisible({ timeout: 30_000 });
    await expect(candidateTabs(page).getByRole("tab", { name: /^New 2$/ })).toBeVisible();
    const invitation = await waitForLink(page.request, base, { to: ana.email, path: "/c/screen/" });
    expect(invitation.path).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    await candidateTabs(page).getByRole("tab", { name: /^Shortlisted 1$/ }).click();
    await expect(candidateRow(page, anaName)).toContainText("AI interview sent", { timeout: 30_000 });
    await expect(candidateRow(page, anaName)).toContainText(/Link open until /);

    // ---- 4. Mark Cal Not selected: private, nobody is emailed -----------------------------------------------------------------------
    await candidateTabs(page).getByRole("tab", { name: /^New 2$/ }).click();
    await candidateRow(page, calName).getByRole("button", { name: `More for ${calName}` }).click();
    await page.getByRole("menuitem", { name: "Not selected" }).click();
    await expect(candidateTabs(page).getByRole("tab", { name: /^Not selected 1$/ })).toBeVisible({ timeout: 30_000 });
    await expect(candidateTabs(page).getByRole("tab", { name: /^New 1$/ })).toBeVisible();
    await page.waitForTimeout(3_000);
    for (const who of [ben, cal]) expect((await emailsTo(page.request, base, who.email)).length, `nothing more went to ${who.first}`).toBe(1);
    // his own page says nothing of a decision nobody has told him
    await a.page.goto(calStatus);
    const calSteps = a.page.getByRole("list", { name: "Where your application is" });
    await expect(calSteps).toContainText("Under review", { timeout: 30_000 });
    await expect(calSteps).not.toContainText("Decision");

    // ---- 5. Ana opens the emailed link, does the AI interview and sends it ------------------------------------------------------------
    await a.page.goto(invitation.path);
    await expect(a.page.getByText(/AI assistant/).first()).toBeVisible({ timeout: 30_000 });
    await expect(a.page.getByText(/when you press Send my answers/).first()).toBeVisible();
    await expectAccessible(a.page, "the AI interview's first page");
    // before she sends, nothing of it is with the team
    const before = await openThePanelOn(page, job.roleId, "shortlisted", anaName);
    await expect(before.getByText(/^AI interview \d+ out of 100$/)).toHaveCount(0);
    await expect(before.getByText(/^Their answers/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await doTheAiInterview(a.page, PERSONAS.strong.says);
    await expectAccessible(a.page, "the AI interview, answers sent");
    await a.context.close();

    // ---- 6. The owner sees the interview score, and hires her; nothing is emailed for a hire ------------------------------------------
    await page.goto("/");
    await expect(page.getByRole("link", { name: "1 finished the AI interview" })).toHaveAttribute("href", new RegExp(`/roles/${job.roleId}/talent\\?tab=interviewed$`), { timeout: 60_000 });
    const panel = await openThePanelOn(page, job.roleId, "interviewed", anaName);
    await expect(candidateTabs(page).getByRole("tab", { name: /^Interviewed 1$/ })).toBeVisible();
    const interview = await scoreOn(candidateRow(page, anaName), "AI interview");
    expect(interview).toBeGreaterThanOrEqual(0);
    expect(interview).toBeLessThanOrEqual(100);
    await expect(panel.getByText("AI interview done")).toBeVisible({ timeout: 30_000 });
    expect(await scoreOn(panel, "AI interview")).toBe(interview);
    await expect(panel.getByRole("list", { name: "Interview questions" }).getByRole("listitem").first()).toBeVisible();
    await expect(panel.getByText(/^Their answers \(\d+\)$/)).toBeVisible();
    await expectAccessible(page, "the candidate panel with the AI interview's result");
    const sentToAna = (await emailsTo(page.request, base, ana.email)).length;
    await panel.getByRole("button", { name: `Hire: ${anaName}` }).click();
    await expect(candidateTabs(page).getByRole("tab", { name: /^Hired 1$/ })).toBeVisible({ timeout: 30_000 });
    await expect(candidateTabs(page).getByRole("tab", { name: /^Interviewed 0$/ })).toBeVisible();
    await page.waitForTimeout(3_000);
    expect((await emailsTo(page.request, base, ana.email)).length, "a hire emails nobody").toBe(sentToAna);
    await page.keyboard.press("Escape");

    // ---- 7. Email the decision to Cal: the email is read first, then sent, and it leaves after its Undo window ----------------------
    await page.goto(`/roles/${job.roleId}/talent?tab=not_selected`);
    await expect(candidateRow(page, calName)).toContainText("Not told yet", { timeout: 30_000 });
    await candidateRow(page, calName).getByRole("button", { name: `Email the decision: ${calName}` }).click();
    const told = page.getByRole("dialog", { name: calName });
    await expect(told.getByText(`Private: ${cal.first} has not been told.`)).toBeVisible({ timeout: 30_000 });
    const email = told.locator(".card", { has: page.getByRole("heading", { name: "Email the decision" }) });
    await expect(email.locator("dt", { hasText: "To" }).locator("xpath=following-sibling::dd[1]")).toHaveText(cal.email, { timeout: 30_000 });
    const subject = ((await email.locator("dt", { hasText: "Subject" }).locator("xpath=following-sibling::dd[1]").textContent()) ?? "").trim();
    expect(subject.length).toBeGreaterThan(0);
    await expectAccessible(page, "the decision email, before it is sent");
    await email.getByRole("button", { name: "Send the email" }).click();
    await expect(told.getByText(/Decision email on its way|Told by email/).first()).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: cal.email, subject, timeout: AFTER_UNDO });
    await exactlyOneEmail(page.request, base, { to: cal.email, subject });
    await page.goto(`/roles/${job.roleId}/talent?tab=not_selected`);
    await expect(candidateRow(page, calName)).toContainText("Told by email", { timeout: 30_000 });
    // now his own page says there is a decision; Ben, still new, heard nothing more
    const calPage = await browser.newPage({ baseURL: base });
    await calPage.goto(calStatus);
    await expect(calPage.getByRole("list", { name: "Where your application is" })).toContainText("Decision", { timeout: 30_000 });
    await calPage.close();
    expect((await emailsTo(page.request, base, ben.email)).length).toBe(1);

    // ---- 8. The administrator opens the company: its job, as counts, with nobody named ---------------------------------------------
    const admin = await signInAsAdmin(browser);
    await gotoSettled(admin.page, "/admin");
    const listed = admin.page.getByRole("row").filter({ has: admin.page.getByRole("button", { name: company, exact: true }) });
    await expect(listed).toContainText("1 of 1 open", { timeout: 30_000 });
    await listed.getByRole("button", { name: company, exact: true }).click();
    await expect(admin.page).toHaveURL(/\/admin\?open=[0-9a-f-]+$/);
    const drawer = admin.page.getByRole("dialog", { name: company });
    const jobRow = drawer.getByRole("region", { name: `Jobs of ${company}` }).getByRole("row").filter({ hasText: job.title });
    await expect(jobRow).toBeVisible({ timeout: 30_000 });
    await expect(jobRow.getByText("Open", { exact: true })).toBeVisible();
    // Applicants, Shortlisted, Interviewed, Hired: the people in each place now
    await expect(jobRow.getByRole("cell").nth(1)).toHaveText("3");
    await expect(jobRow.getByRole("cell").nth(2)).toHaveText("0");
    await expect(jobRow.getByRole("cell").nth(3)).toHaveText("0");
    await expect(jobRow.getByRole("cell").nth(4)).toHaveText("1");
    await expect(jobRow.getByRole("link", { name: /^View job page/ })).toHaveAttribute("href", new RegExp(`/careers/${job.slug}/jobs/${job.roleId}$`));
    for (const who of [ana, ben, cal]) await expect(drawer).not.toContainText(who.last);
    await expectAccessible(admin.page, "a company's page with its job");
    // the administrator reads counts only: nothing of a candidate, on the page or in what the page reads
    const companyId = new URL(admin.page.url()).searchParams.get("open")!;
    const read = await (await admin.page.request.get(`${base}/api/v1/admin/customers/${companyId}/jobs`, { headers: { "x-admin-reason": "e2e: counts only" } })).text();
    for (const who of [ana, ben, cal]) expect(read).not.toContain(who.last);
    expect((await admin.page.request.get(`${base}/api/v1/roles/${job.roleId}/applications`)).status()).toBeGreaterThanOrEqual(400);
    await admin.context.close();
  });
});

/** A tab of the job's Candidates list with one person's panel open, once that person is under the tab (the list is asked for again until they are). */
async function openThePanelOn(page: Page, roleId: string, tab: "shortlisted" | "interviewed", name: string) {
  await expect(async () => {
    await page.goto(`/roles/${roleId}/talent?tab=${tab}`);
    await expect(candidateRow(page, name)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  return openThePanel(page, name);
}
