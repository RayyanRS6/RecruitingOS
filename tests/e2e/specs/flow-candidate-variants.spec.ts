import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  PERSONAS, createCompanyThroughTheForm, emailsTo, exactlyOneEmail, expectAccessible, linkIn, liveJobThroughTheApi, openThePanel, sendTheAiInterview, signIn, skipWithoutFakeSignIn,
  waitForEmail, waitForTheAiInterview,
} from "./helpers";

/**
 * The other ways an application goes, each on the candidate's own pages in a real browser, each with the one email it
 * sends read by its words: no résumé (four short questions, and the AI interview as for anyone); a must-have answered No
 * (held for a person, told only that it was received, and "Keep them in" with a reason sends the AI interview); sending
 * without the AI interview; a person instead; doing it later; the same address applying again after sending; and the
 * sixth applicant on Free, whose page and email never say anything about a plan.
 */
const run = Date.now().toString(36);
const toast = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });
/** No plan or upgrade word on a candidate page or in their email (the plans work's rule). */
const PLAN_WORDS = /\b(plans?|upgrade|upgraded|locked)\b/i;

async function aCompanyWithAJob(page: Page, base: string, tag: string) {
  const company = `Variant Dental ${tag}`;
  await signIn(page, { email: `owner+${tag}@variant.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, company);
  return { company, ...(await liveJobThroughTheApi(page.request, base)) };
}

/**
 * The form, filled by hand: name and address, no résumé unless given, every question Yes unless `answerNo` (the first one
 * No). A résumé is read and the form comes back as "Check your details", except on a job past its plan's limit (`unread`),
 * where nothing reads it (the plans of 5 November 2026, Rule 2): the file goes with the form and the details are typed.
 * `beforeSend` looks at the form just before Send.
 */
async function fillTheForm(browser: Browser, base: string, jobUrl: string, who: { first: string; last: string; email: string }, opts: { resume?: string; unread?: boolean; noResume?: boolean; answerNo?: boolean; beforeSend?: (cand: Page) => Promise<void> } = {}) {
  const context = await browser.newContext({ baseURL: base });
  const cand = await context.newPage();
  await cand.goto(jobUrl);
  await cand.getByRole("link", { name: "Apply now" }).last().click();
  await cand.waitForURL(/\/apply$/);
  if (opts.resume) {
    await cand.locator('input[name="resume"]').setInputFiles({ name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(`${who.first} ${who.last}\n${who.email}\n${opts.resume}\n`) });
    if (!opts.unread) await expect(cand.getByRole("heading", { name: "Check your details" })).toBeVisible({ timeout: 60_000 });
  }
  if (!opts.resume || opts.unread) {
    await cand.getByLabel("First name").fill(who.first);
    await cand.getByLabel("Last name").fill(who.last);
    await cand.getByLabel("Email").fill(who.email);
  }
  if (opts.noResume) {
    await cand.getByText("No resume? Answer four short questions instead").click();
    await cand.getByLabel("Your most recent job or work").fill("Registered Dental Hygienist at Coastal Family Dentistry since 2019.");
    await cand.getByLabel("Skills, licenses or tools that fit this job").fill("Active CA RDH license, Dentrix, periodontal charting.");
  }
  const questions = cand.locator("section.quick");
  let first = true;
  for (const group of await questions.locator("li fieldset").all()) {
    const answer = opts.answerNo && first ? "no" : "yes";
    first = false;
    const radio = group.locator(`input[type="radio"][value="${answer}"]`);
    if (await radio.count()) await radio.check();
    else if (!(await group.locator("input:checked").count())) await group.locator('input[type="checkbox"], input[type="radio"]').first().check();
  }
  await cand.getByRole("checkbox", { name: /I have read the full notice above/ }).check();
  if (opts.beforeSend) await opts.beforeSend(cand);
  await cand.getByRole("button", { name: "Send my application" }).click();
  return { context, cand };
}

test.describe("the other ways an application goes", () => {
  skipWithoutFakeSignIn();

  test("no résumé: four short questions, and the AI interview follows as for anyone", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}a`);
    const who = { first: "Nia", last: "Bell", email: `nia.bell+${run}@example.com` };
    const { context, cand } = await fillTheForm(browser, base, job.jobUrl, who, { noResume: true });
    await waitForTheAiInterview(cand);
    await expect(cand.getByText("Your application is sent.")).toBeVisible();
    await waitForEmail(page.request, base, { to: who.email, subject: `Thank you for applying: your next step for ${job.title} at ${job.company}`, says: ["Start your AI interview:"] });
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Nia Bell" })).toBeVisible({ timeout: 30_000 });
    await context.close();
  });

  test("a must-have answered No: held for a person, told only that it was received; Keep them in, with a reason, sends the AI interview", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}b`);
    const who = { first: "Omar", last: "Reed", email: `omar.reed+${run}@example.com` };
    const { context, cand } = await fillTheForm(browser, base, job.jobUrl, who, { resume: PERSONAS.possible.resume, answerNo: true });
    // the receipt: check your email, people decide; nothing about the answer
    await expect(cand.getByRole("heading", { level: 1, name: "Thanks for applying" })).toBeVisible({ timeout: 150_000 });
    await expect(cand.getByText(/^Check your email\./)).toBeVisible();
    await expect(cand.locator("body")).not.toContainText(/eligib|must-have|not (meet|qualif)/i);
    await expectAccessible(cand, "the receipt after a must-have answered No");
    await waitForEmail(page.request, base, { to: who.email, subject: `Thank you for applying: ${job.title} at ${job.company}`, says: ["We received your application."] });
    // the team: held on the answer; Keep them in needs a reason, then the AI interview link goes by itself
    const panel = await openThePanel(page, job.roleId, "Omar Reed");
    const held = panel.locator(".card", { has: page.getByRole("heading", { name: "Held on an eligibility answer" }) });
    await expect(held).toBeVisible({ timeout: 30_000 });
    const keep = held.getByRole("button", { name: "Keep them in" });
    await expect(keep).toBeDisabled();
    await held.getByLabel("Why keep them in?").fill("He renewed his license last week; the answer was a slip.");
    await keep.click();
    await expect(toast(page, /^Kept in\./)).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: who.email, subject: `Your next step: a short AI interview for ${job.title}`, says: ["Not doing the interview never stops your application."], timeout: 90_000 });
    await context.close();
  });

  test("from the AI interview's introduction: send without it, a person instead, or later, each with its own words and email", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}c`);
    const people = {
      without: { first: "Pia", last: "Lund", email: `pia.lund+${run}@example.com` },
      person: { first: "Raj", last: "Iyer", email: `raj.iyer+${run}@example.com` },
      later: { first: "Sue", last: "Tran", email: `sue.tran+${run}@example.com` },
    };
    const opened = await Promise.all(Object.values(people).map((who) => fillTheForm(browser, base, job.jobUrl, who, { resume: PERSONAS.possible.resume })));
    await Promise.all(opened.map((o) => waitForTheAiInterview(o.cand)));
    const [without, person, later] = opened.map((o) => o.cand);

    // send without the conversation: it goes to the team, who hear it once
    await without.getByRole("link", { name: "I'd rather talk to a person" }).click();
    await expect(without.getByRole("heading", { level: 1, name: "Talk to a person instead" })).toBeVisible();
    await without.getByRole("button", { name: "Send without the conversation" }).click();
    await expect(without.getByRole("heading", { name: "Your application is with the hiring team" })).toBeVisible({ timeout: 30_000 });
    await page.goto("/updates");
    await expect(page.getByRole("listitem").filter({ hasText: "Pia Lund sent their application without the AI interview" })).toHaveCount(1, { timeout: 30_000 });

    // a person instead: the page and the email say a person will be in touch
    await person.getByRole("link", { name: "I'd rather talk to a person" }).click();
    await person.getByRole("button", { name: "Have a person contact me" }).click();
    await expect(person.getByRole("heading", { name: "A person will be in touch" })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: people.person.email, subject: `A person will contact you about ${job.title}`, says: ["A person working with the hiring team will contact you"] });

    // later: the link by email, never on the page
    await later.getByRole("button", { name: "Do this later" }).click();
    await expect(later.getByRole("heading", { level: 1, name: "Your link is on its way" })).toBeVisible({ timeout: 30_000 });
    await waitForEmail(page.request, base, { to: people.later.email, subject: `Your AI interview for ${job.title}, for when you are ready`, says: ["Answer whenever it suits you"] });
    await expectAccessible(later, "the AI interview, for later");
    await Promise.all(opened.map((o) => o.context.close()));
  });

  test("the same address applying again after sending its answers: the same pages and AI interview, a check by email when it ends, and nothing joins her application", async ({ page, browser, baseURL }) => {
    test.setTimeout(540_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}d`);
    const who = { first: "Tess", last: "Moore", email: `tess.moore+${run}@example.com` };
    const first = await fillTheForm(browser, base, job.jobUrl, who, { resume: PERSONAS.strong.resume });
    await waitForTheAiInterview(first.cand);
    await sendTheAiInterview(first.cand, PERSONAS.strong.says);
    await first.context.close();
    // again, from a fresh browser, as anyone could: the same waiting room and the same AI interview as for anyone (Q14),
    // and nothing says this address is known
    const again = await fillTheForm(browser, base, job.jobUrl, who, { resume: PERSONAS.strong.resume });
    await waitForTheAiInterview(again.cand);
    await expect(again.cand.locator("body")).not.toContainText(/already applied|we know this address/i);
    await sendTheAiInterview(again.cand, PERSONAS.strong.says);
    await again.context.close();
    // when it ends, the address on file is asked before anything is added (Q14 x Q15)
    const check = await waitForEmail(page.request, base, {
      to: who.email,
      subject: `Please confirm: your application for ${job.title}`,
      says: [`You already have an application for the ${job.title} position at ${job.company}.`, "someone using this email address answered the screening questions for it. Nothing has been changed.", "If that was you, confirm here to add those answers to your application:", "If it was not you, you do not need to do anything: nothing is added, and what was typed is deleted after seven days."],
    });
    await exactlyOneEmail(page.request, base, { to: who.email, subject: /^Please confirm/ });
    // nothing joined: still one Tess on the list
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Tess Moore" })).toHaveCount(1, { timeout: 30_000 });
    // she opens the link (opening changes nothing) and presses the button: her answers were already sent, so nothing is added
    const mine = await browser.newContext({ baseURL: base });
    const confirm = await mine.newPage();
    await confirm.goto(linkIn(check, "/c/confirm-answers/"));
    await expect(confirm.getByRole("heading", { level: 1, name: "Add these answers to your application?" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(confirm, "confirming a repeat application's answers");
    await confirm.getByRole("button", { name: "Add these answers to my application" }).click();
    await expect(confirm.getByRole("heading", { level: 1, name: "Nothing was added" })).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText("Your application already has answers to these questions, or it has moved on, so it stays as it was.")).toBeVisible();
    await mine.close();
    await page.goto(`/roles/${job.roleId}/talent`);
    await expect(page.locator(".talent-row").filter({ hasText: "Tess Moore" })).toHaveCount(1, { timeout: 30_000 });
  });

  test("the sixth applicant on Free: the honest receipt and email, and never a word about a plan", async ({ page, browser, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const job = await aCompanyWithAJob(page, base, `${run}e`);
    // five through the API (not the subject here), as five people applying
    const role = (await (await page.request.get(`${base}/api/v1/roles/${job.roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    for (const name of ["Ann Abbott", "Bo Burke", "Cy Cruz", "Di Dale", "Ed Eaton"]) {
      const [firstName, lastName] = name.split(" ");
      const multipart: Record<string, string> = { firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}+${run}@example.com`, noResume: "Five years as a hygienist in Irvine.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
      for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
      expect((await page.request.post(`${base}/careers/${job.slug}/jobs/${job.roleId}/apply`, { multipart, maxRedirects: 0 })).status()).toBe(302);
    }
    const who = { first: "Fay", last: "Foster", email: `fay.foster+${run}@example.com` };
    // the form: nothing reads her résumé, the line before Send says the job is busy, and no word about a plan
    const { context, cand } = await fillTheForm(browser, base, job.jobUrl, who, {
      resume: PERSONAS.strong.resume,
      unread: true,
      beforeSend: async (form) => {
        await expect(form.getByRole("button", { name: /^Read (my|this) resume/ })).toHaveCount(0);
        await expect(form.getByText(`Many people have applied for this job. ${job.company} may not be able to review every application.`)).toBeVisible();
        await expect(form.getByRole("listitem").filter({ hasText: `People at ${job.company} make every hiring decision.` })).toBeVisible();
        await expect(form.locator("main")).not.toContainText(PLAN_WORDS);
        await expectAccessible(form, "the form on a job past its limit");
      },
    });
    await expect(cand.getByRole("heading", { level: 1, name: "Thanks for applying" })).toBeVisible({ timeout: 150_000 });
    await expect(cand.getByText(/^Check your email\./)).toBeVisible();
    await expect(cand.getByText("People make every decision.")).toBeVisible();
    await expect(cand.locator("main")).not.toContainText(PLAN_WORDS);
    await expectAccessible(cand, "the receipt on a job past its limit");
    const sent = await waitForEmail(page.request, base, { to: who.email, subject: `Thank you for applying: ${job.title} at ${job.company}`, says: ["We received your application."] });
    expect(sent.text).not.toMatch(PLAN_WORDS);
    await exactlyOneEmail(page.request, base, { to: who.email, subject: /^Thank you for applying/ });
    // no AI interview for her
    expect((await emailsTo(page.request, base, who.email)).map((m) => m.subject)).toEqual([sent.subject]);
    await context.close();
  });
});
