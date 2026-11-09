import { expect, test, type Page } from "@playwright/test";
import {
  HYGIENIST_JOB, PERSONAS, applyThroughTheForm, approvalCard, approveOnTheJobPage, buildJobThroughTheBuilder, decideInPanel, emailsTo, exactlyOneEmail, expectAccessible,
  expectNoEmail, fillTheCompanyForm, gotoSettled, linkIn, openThePanel, recordTookPlace, sendTheAiInterview, setADateAndTime, signIn, signInAsNadine, skipWithoutFakeSignIn,
  waitForEmail, waitForTheAiInterview, type Applicant,
} from "./helpers";

/**
 * The whole hire, both flows in order on one job, in a real browser through the real screens: the owner's words of
 * 6 November 2026, "please test it thoroughly so the complete process of making a job hiring and then the complete process
 * of applying test both these flows", and "nadine sets date and time from the shortlisted candidates and he/she will get
 * the mail". Nothing here is built through the API: the owner asks for access and Nadine accepts it, the job is written in
 * the job builder and approved on its page, two people apply through the link the owner shares and take the AI interview,
 * the owner reads them best first, shortlists one, sets a date and time, records the interview, the offer and the hire,
 * closes the job and tells the other one. Every email is read by its words, right after the press that sends it, and the
 * ones that must not go are checked too: nothing about the offer or the hire to the person hired, nothing to the other
 * before Send.
 *
 * The owner asks for access, as on production, so this needs a server in SIGNUP_MODE=approval (the "approval" run of the
 * flows job in .github/workflows/ci.yml); in any other run it is skipped, with the reason on the report.
 */
const run = Date.now().toString(36);
const ITS_QUEUE = "recruiters@its.localhost";
/** Longer than one 30-second look of the waiting screen. */
const A_LOOK = 45_000;
/** A decision or closing message waits out its 30-second Undo window before it leaves. */
const AFTER_UNDO = 90_000;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

test.describe("the whole hire", () => {
  skipWithoutFakeSignIn();
  test.skip(process.env.SIGNUP_MODE !== "approval", "the owner asks for access, as on production: needs a server of its own in SIGNUP_MODE=approval");

  test("ask for access, build and approve a job, two people apply through its link, one is interviewed, offered and hired, and the other is told", async ({ page, browser, baseURL }) => {
    test.setTimeout(1_200_000);
    const base = baseURL!;
    const company = `Harbor Smiles ${run}`;
    const owner = { email: `dana.whitfield+${run}@harborsmiles.test`, name: "Dana Whitfield", provider: "google" } as const;
    const ana: Applicant = { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume };
    const ben: Applicant = { first: "Ben", last: "Ortiz", email: `ben.ortiz+${run}@example.com`, resume: PERSONAS.possible.resume };

    // ---- 1. The owner asks for access, and Nadine accepts it ------------------------------------------------------------
    await signIn(page, owner);
    await page.waitForURL("**/setup/company");
    await expect(page.getByRole("heading", { name: "Tell us about your company" })).toBeVisible();
    await fillTheCompanyForm(page, company, owner.name);
    await page.getByRole("button", { name: "Send my request" }).click();
    await expect(page.getByRole("heading", { name: "Your request has been sent" })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: owner.email, subject: "Your request has been sent", says: [`Your request for ${company} has been sent.`, "Please wait for approval. ITS reviews each company, usually within one business day, and we will email you when it is decided."] });
    await exactlyOneEmail(page.request, base, { to: owner.email, subject: "Your request has been sent" });
    await waitForEmail(page.request, base, { to: ITS_QUEUE, subject: `[access request] ${company} is asking for access`, says: ["Someone is asking for access.", `Company: ${company}`, `Person: ${owner.name} <${owner.email}>`, "Accept or decline it in the admin console, on the Overview:"] });

    const nadine = await signInAsNadine(browser);
    await gotoSettled(nadine.page, "/admin");
    const request = nadine.page.locator(".card", { has: nadine.page.getByRole("heading", { name: "Needs attention" }) }).getByRole("listitem").filter({ hasText: `${company} is asking for access` });
    await expect(request).toBeVisible({ timeout: 30_000 });
    await request.getByRole("button", { name: `Accept ${company}` }).click();
    await request.getByRole("button", { name: `Yes, accept ${company}` }).click();
    await expect(toast(nadine.page, `${company} was accepted.`)).toBeVisible({ timeout: 30_000 });
    await nadine.context.close();

    // the waiting screen goes Home by itself, and the owner hears it by email
    await page.waitForURL((u) => u.pathname === "/", { timeout: A_LOOK });
    await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: owner.email, subject: "Your request was approved", says: ["Your request was approved.", `Company: ${company}`, "Candidate names and details are never put in emails"] });
    await exactlyOneEmail(page.request, base, { to: owner.email, subject: "Your request was approved" });

    // ---- 2. The job: Home's box, the job builder, Ask for approval; Home's card; Approve on the job's page ---------------
    const roleId = await buildJobThroughTheBuilder(page, HYGIENIST_JOB);
    const title = await page.getByRole("heading", { level: 1 }).first().textContent().then((t) => (t ?? "").trim());
    expect(title).toMatch(/Hygienist/i);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `Approve the job: ${title}` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Review and approve" }).click();
    await expect(page).toHaveURL(new RegExp(`/roles/${roleId}$`));
    await expect(approvalCard(page)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the job's approval card");
    await approveOnTheJobPage(page);
    await expect(page.locator(".pill", { hasText: /^Live$/ }).first()).toBeVisible({ timeout: 30_000 });

    // Home says it is live and leads to sharing it; the job's address is what the owner shares
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `${title} is live. Share it now` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "Share the job" }).click();
    await expect(page).toHaveURL(new RegExp(`/roles/${roleId}\\?tab=posting#share$`));
    const address = page.locator("#share .share-link code");
    await expect(address).toBeVisible({ timeout: 30_000 });
    const jobUrl = ((await address.getAttribute("title")) ?? "").trim();
    expect(jobUrl).toMatch(new RegExp(`/careers/[a-z0-9-]+/jobs/${roleId}$`));

    // ---- 3. Two people apply through the shared link and take the AI interview, each in a browser of their own ------------
    const a = await applyThroughTheForm(browser, base, jobUrl, ana);
    const b = await applyThroughTheForm(browser, base, jobUrl, ben);
    await Promise.all([waitForTheAiInterview(a.page), waitForTheAiInterview(b.page)]);
    for (const who of [ana, ben]) {
      const ack = await waitForEmail(page.request, base, {
        to: who.email,
        subject: `Thank you for applying: your next step for ${title} at ${company}`,
        says: [`Hi ${who.first},`, "Start your AI interview:", "How it works:", "The link stays open for 5 days", "People on the hiring team read every application and make every decision.", "Check where things stand at any time:"],
      });
      expect(linkIn(ack, "/c/status/")).toMatch(/^\/c\/status\/[A-Za-z0-9_-]+$/);
      await exactlyOneEmail(page.request, base, { to: who.email, subject: /^Thank you for applying/ });
    }
    const anaStatus = linkIn(await waitForEmail(page.request, base, { to: ana.email, subject: /^Thank you for applying/ }), "/c/status/");
    const benStatus = linkIn(await waitForEmail(page.request, base, { to: ben.email, subject: /^Thank you for applying/ }), "/c/status/");
    await sendTheAiInterview(a.page, PERSONAS.strong.says);
    await sendTheAiInterview(b.page, PERSONAS.possible.says);
    // sending the answers sends no email
    await expectNoEmail(page.request, base, { to: ana.email, subject: /^(?!Thank you for applying)/, ms: 2_000 });

    // ---- 4. The owner reads them: everyone, best first, each in New with their score -----------------------------------------
    await page.goto(`/roles/${roleId}/talent`);
    const rows = page.locator(".talent-row");
    await expect(async () => {
      await page.reload();
      await expect(rows).toHaveCount(2, { timeout: 5_000 });
      await expect(page.locator(".talent-row .score-slot .score")).toHaveCount(2, { timeout: 5_000 });
    }).toPass({ timeout: 180_000, intervals: [3_000] });
    await expect(page.getByRole("button", { name: "Sort: Score" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Waiting on you/, pressed: true })).toHaveCount(0);
    await expect(rows.nth(0).locator(".talent-name")).toHaveText("Ana Holt");
    await expect(rows.nth(1).locator(".talent-name")).toHaveText("Ben Ortiz");
    const strip = page.getByRole("tablist", { name: "Stages" });
    await expect(strip.getByRole("tab", { name: /^New 2$/ })).toBeVisible();
    const anaScore = Number(await rows.nth(0).locator(".score-slot .score").textContent().then((t) => (t ?? "").match(/\d+/)?.[0] ?? "-1"));
    const benScore = Number(await rows.nth(1).locator(".score-slot .score").textContent().then((t) => (t ?? "").match(/\d+/)?.[0] ?? "-1"));
    expect(anaScore, "the stronger résumé and interview score higher").toBeGreaterThan(benScore);
    await expectAccessible(page, "the list, best first");

    // the owner heard once about each of them, with a way to their page
    await page.goto("/updates");
    for (const who of [ana, ben]) {
      const notice = page.getByRole("listitem").filter({ hasText: `${who.first} ${who.last} finished the AI interview` });
      await expect(notice).toHaveCount(1, { timeout: 30_000 });
      await expect(notice.getByRole("link", { name: "Review" })).toHaveAttribute("href", new RegExp(`/roles/${roleId}/talent\\?open=`));
    }

    // ---- 5. Shortlist Ana from her row: private, nobody is emailed -------------------------------------------------------------
    await page.goto(`/roles/${roleId}/talent`);
    const anaRow = page.locator(".talent-row").filter({ hasText: "Ana Holt" });
    await anaRow.getByRole("button", { name: /^Stage: .+\. Move to another stage$/ }).click();
    await page.getByRole("menuitemradio", { name: /^Shortlist/ }).click();
    await expect(toast(page, /Moved to Shortlist\..*Private: the candidate was not told\./)).toBeVisible({ timeout: 30_000 });
    await expect(strip.getByRole("tab", { name: /^Shortlist 1$/ })).toBeVisible({ timeout: 30_000 });
    await expectNoEmail(page.request, base, { to: ana.email, subject: /^(?!Thank you for applying)/, ms: 2_000 });

    // ---- 6. On her panel the main button is Set a date and time; one press books it and she gets one email -------------------
    const panel = await openThePanel(page, roleId, "Ana Holt");
    const ready = panel.locator(".card", { has: page.getByRole("heading", { name: "Ready to interview" }) });
    await expect(ready).toBeVisible({ timeout: 30_000 });
    await expect(ready.getByText("Ana is on your shortlist.")).toBeVisible();
    await ready.getByRole("button", { name: "Set a date and time" }).click();
    const form = panel.locator(".card", { has: page.getByRole("heading", { name: "Set a date and time" }) });
    await expect(form).toBeVisible();
    await expect(form.getByText("With Dana Whitfield", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(form.getByLabel("Time (America/Los_Angeles)")).toBeVisible();
    // nobody has hours or a calendar here, and none is needed: the old way is not offered
    await expect(form.getByText("Or let them pick from your free times")).toHaveCount(0);
    await expectAccessible(page, "set a date and time");
    await setADateAndTime(form, { first: "Ana", daysAhead: 4, time: "10:30", place: "Address", address: "120 Main Street, Tustin" });
    await expect(toast(page, /Booked\..*The email to Ana is on its way\./)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: /^Stage: Interviewing/ })).toBeVisible({ timeout: 30_000 });
    // "Where things stand": the round, then the same word as on Interviews, then when
    await expect(panel.locator("p").filter({ hasText: / · Scheduled · [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 10:30 AM$/ })).toBeVisible({ timeout: 30_000 });

    const booked = await waitForEmail(page.request, base, {
      to: ana.email,
      subject: new RegExp(`^Your interview: .+ at ${escape(company)}, `),
      says: ["Hi Ana,", `Good news: ${company} would like to interview you for the ${title} position.`, /When: .+ (AM|PM)/, "Where: 120 Main Street, Tustin", "Who: Dana", "What to prepare:", "A calendar invitation is attached. Need a different time?", "Need an adjustment, such as captions or a phone call instead of video? Tell us on the same page, or reply to this email."],
    });
    expect(booked.attachments?.map((x) => [x.filename, x.contentType])).toEqual([["interview.ics", "text/calendar; method=REQUEST"]]);
    expect(Buffer.from(booked.attachments![0].contentBase64, "base64").toString()).toContain("LOCATION:120 Main Street\\, Tustin");
    await exactlyOneEmail(page.request, base, { to: ana.email, subject: /^Your interview: / });
    // the interviewer (the owner, who pressed) hears too, by name
    await waitForEmail(page.request, base, { to: owner.email, subject: `Interview booked: Ana Holt for ${title}`, says: ["120 Main Street, Tustin", "/interviews/"] });

    // her own page has it booked, from the link in her email
    await a.page.goto(linkIn(booked, "/c/schedule/"));
    await expect(a.page.getByRole("heading", { level: 1, name: "Your interview is booked" })).toBeVisible({ timeout: 30_000 });
    await a.page.goto(anaStatus);
    await expect(a.page.getByText("Your interview is booked. The details are below and in your email.")).toBeVisible({ timeout: 30_000 });
    await expect(a.page.locator('ol.track [aria-current="step"]')).toHaveText("Interview");

    // on Interviews it is booked, not waiting on anyone
    await page.goto("/interviews");
    const ivRow = page.getByRole("row").filter({ hasText: "Ana Holt" });
    await expect(ivRow).toBeVisible({ timeout: 30_000 });
    await expect(ivRow.getByText("Scheduled", { exact: true })).toBeVisible();

    // ---- 7. The interview took place; Finalist; the offer; the hire -------------------------------------------------------------
    const sheet = await recordTookPlace(page, "Ana Holt");
    const decide = sheet.getByRole("link", { name: "Record the decision" });
    await expect(async () => {
      if (!/\/talent\?open=/.test(page.url())) await decide.click({ timeout: 5_000 });
      await expect(page).toHaveURL(/\/talent\?open=/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    const anaPanel = page.getByRole("dialog", { name: "Ana Holt" });
    await decideInPanel(anaPanel, "Finalist");
    await expect(toast(page, /Marked as a finalist/)).toBeVisible({ timeout: 30_000 });
    await expect(anaPanel.getByRole("heading", { name: "Ana is a finalist: what next?" })).toBeVisible({ timeout: 30_000 });
    await anaPanel.getByRole("button", { name: /^Stage: / }).click();
    await anaPanel.getByRole("menuitemradio", { name: /^Offer/ }).click();
    await expect(anaPanel.getByRole("heading", { name: "Offer made" })).toBeVisible();
    await anaPanel.getByRole("button", { name: "Record the offer" }).click();
    await expect(toast(page, /Offer recorded\..*Nothing was sent to Ana/)).toBeVisible({ timeout: 30_000 });
    await a.page.goto(anaStatus);
    await expect(a.page.getByText(/^The team has made you an offer\./)).toBeVisible({ timeout: 30_000 });
    await expect(anaPanel.getByRole("heading", { name: "Waiting on Ana's answer" })).toBeVisible({ timeout: 30_000 });
    await anaPanel.getByRole("button", { name: "They accepted" }).click();
    await expect(anaPanel.getByRole("heading", { name: "Hire Ana Holt" })).toBeVisible();
    await anaPanel.getByLabel("Start date (agreed with them)").fill(new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10));
    await anaPanel.getByRole("button", { name: "Continue" }).click();
    await anaPanel.getByRole("button", { name: "Yes, record the hire" }).click();
    await expect(toast(page, /Ana Holt is hired\./)).toBeVisible({ timeout: 30_000 });

    // what about the job: close it now and tell the one still in process (Ben applied, never interviewed, so he is not a
    // backup to keep warm), or leave it open; the closing message names him before anything goes
    const after = anaPanel.locator(".card", { has: page.getByRole("heading", { name: "Ana Holt is hired: what about the role?" }) });
    await expect(after).toBeVisible({ timeout: 30_000 });
    await expect(after.getByText(/^Ana starts on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/)).toBeVisible();
    await expect(after.getByText(/^Close the role as filled\. The 1 person still in process moves to your talent pool, privately: nobody is told at once, and you see the closing message before it goes\./)).toBeVisible();
    await expect(after.getByRole("button", { name: "Leave it open" })).toBeVisible();
    await expectAccessible(page, "the hire's next step");
    await after.getByRole("button", { name: "Close it now" }).click();
    await expect(toast(page, /Role closed as filled\./)).toBeVisible({ timeout: 30_000 });
    const closing = anaPanel.locator(".card", { has: page.getByRole("heading", { name: `Tell the people ${title} left in process` }) });
    await expect(closing).toBeVisible({ timeout: 30_000 });
    await expect(closing.getByRole("list", { name: "Who gets the closing message" }).getByText("Ben Ortiz")).toBeVisible();
    // nothing has gone to Ben yet, and his own page says nothing of it
    await expectNoEmail(page.request, base, { to: ben.email, subject: `Your application to ${company}`, ms: 1_000 });
    await b.page.goto(benStatus);
    await expect(b.page.getByText(/has closed this position/)).toHaveCount(0);
    await closing.getByRole("button", { name: "Send to 1 person" }).click();
    await expect(toast(page, /1 closing message on its way\./)).toBeVisible({ timeout: 30_000 });

    // ---- 8. What each of them got, and what they see -----------------------------------------------------------------------------
    // the one closing message (founder decision Q30), in its own words whatever the close's outcome
    await waitForEmail(page.request, base, {
      to: ben.email,
      subject: `Your application to ${company}`,
      says: ["Hi Ben,", `Thank you for your interest in the ${title} position at ${company}.`, `${company} has closed this position, so your application for this role will not go any further.`, "We would like to keep your information for future openings", `This message was sent by the hiring team at ${company} with help from an AI recruiting assistant.`],
      timeout: AFTER_UNDO,
    });
    await exactlyOneEmail(page.request, base, { to: ben.email, subject: `Your application to ${company}` });
    await b.page.goto(benStatus);
    await expect(b.page.getByText(new RegExp(`${escape(company)} has closed this position`)).first()).toBeVisible({ timeout: 30_000 });
    // Ana got the thank-you and the booking, and nothing about the offer or the hire
    expect((await emailsTo(page.request, base, ana.email)).map((m) => m.subject).sort()).toEqual([`Thank you for applying: your next step for ${title} at ${company}`, booked.subject].sort());
    await a.page.goto(anaStatus);
    await expect(a.page.getByText("You are on the team.")).toBeVisible({ timeout: 30_000 });

    // the job is closed, and its list says who was hired and who was told
    await page.keyboard.press("Escape");
    await page.goto(`/roles/${roleId}`);
    await expect(page.locator(".pill", { hasText: /^Closed$/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.goto(`/roles/${roleId}/talent`);
    await strip.getByRole("tab", { name: /^All/ }).click();
    await expect(page.locator(".talent-row").filter({ hasText: "Ana Holt" })).toContainText("Hired", { timeout: 30_000 });
    await a.context.close();
    await b.context.close();
  });
});
