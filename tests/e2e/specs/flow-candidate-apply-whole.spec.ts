import { expect, test } from "@playwright/test";
import {
  PERSONAS, applicationForm, candidateRow, candidateTabs, createCompanyThroughTheForm, emailsTo, expectAccessible, expectTheReceipt, fillTheApplication, noSidewaysScroll, openThePanel,
  publishedJobThroughTheApi, signIn, skipWithoutFakeSignIn, waitForLink, type Applicant,
} from "./helpers";

/**
 * The whole application, as a candidate goes through it, in a real browser: the job page opened from a LinkedIn
 * post's Apply link (`?src=linkedin`), the plain form (who they are, the resume, the job's screening questions, the
 * notice with its tick), Send, the receipt, the one email with their own status link, and the status page. Nothing
 * about applying is an AI interview: that comes by email only if the team shortlists them. The team then reads where
 * they came from and what they answered. A second application to the same job from the same address creates nothing
 * and emails the status link again. The job is the owner's, made through the API: it is not the subject here. Runs on
 * a desk (project "flows") and on a phone (project "flows-phone").
 */
const run = Date.now().toString(36);

/** The job's screening questions, one of each kind, set through the one editor's own request. */
const QUESTIONS = [
  { kind: "yes_no", question: "Do you hold an active CA RDH license?" },
  { kind: "choice", question: "Which shift suits you best?", options: ["Mornings", "Afternoons", "Either"] },
  { kind: "number", question: "How many patients a day are you used to seeing?", unit: "patients" },
] as const;
const ANSWERS: Record<string, string> = { [QUESTIONS[0].question]: "Yes", [QUESTIONS[1].question]: "Mornings", [QUESTIONS[2].question]: "9" };

test.describe("the whole application", () => {
  skipWithoutFakeSignIn();

  test("from a post's Apply link to Send, the receipt, one email and the status page; applying again creates nothing", async ({ page: cand, browser, baseURL }, info) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const tag = `${run}${info.project.name === "flows-phone" ? "p" : "d"}`;
    const company = `Coastal Care ${tag}`;
    // the owner, at a desk in a browser of their own; the candidate is this project's page (a desk, or a phone)
    const context = await browser.newContext({ baseURL: base });
    const owner = await context.newPage();
    await signIn(owner, { email: `owner+${tag}@coastalcare.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(owner, company);
    const job = await publishedJobThroughTheApi(owner.request, base);
    const { version } = (await (await owner.request.get(`${base}/api/v1/roles/${job.roleId}`)).json()) as { version: number };
    const saved = await owner.request.patch(`${base}/api/v1/roles/${job.roleId}/packet`, { data: { baseVersion: version, formQuestions: QUESTIONS } });
    expect(saved.ok(), await saved.text()).toBeTruthy();

    const maria: Applicant = { first: "Maria", last: "Reyes", email: `maria.reyes+${tag}@example.com`, resume: PERSONAS.strong.resume };
    const name = `${maria.first} ${maria.last}`;
    try {
      // ---- the job page, from the post's Apply link: the whole job, what to expect, and Apply ---------------------------
      await cand.goto(`${job.jobUrl}?src=linkedin`);
      await expect(cand.getByRole("heading", { level: 1 })).toContainText(job.title);
      await expect(cand.getByRole("heading", { name: "What to expect" })).toBeVisible();
      await expectAccessible(cand, "the job page");
      await noSidewaysScroll(cand, "the job page");
      await cand.getByRole("link", { name: "Apply now" }).last().click();

      // ---- the form: where they came from travels with it; nothing is ticked for them --------------------------------------
      await cand.waitForURL(new RegExp(`/careers/${job.slug}/jobs/${job.roleId}/apply\\?src=linkedin$`));
      const acknowledgment = applicationForm(cand).getByRole("checkbox", { name: /I have read the full notice above/ });
      await expect(acknowledgment).not.toBeChecked();
      await expect(cand.getByRole("link", { name: /how we handle your information/i }).first()).toHaveAttribute("href", "/privacy");
      await expectAccessible(cand, "the application form");
      await noSidewaysScroll(cand, "the application form");
      await fillTheApplication(cand, maria, ANSWERS);

      // sent without the tick (as a script or an old browser would), the form comes back saying so, with what was typed kept
      await acknowledgment.uncheck();
      await acknowledgment.evaluate((el) => el.removeAttribute("required"));
      await applicationForm(cand).getByRole("button", { name: "Send my application" }).click();
      await expect(cand.getByRole("alert").filter({ hasText: /confirm you have read the notice/ }).first()).toBeVisible({ timeout: 30_000 });
      await expect(applicationForm(cand).getByLabel("First name")).toHaveValue(maria.first);
      await expect(applicationForm(cand).getByRole("checkbox", { name: /I have read the full notice above/ })).not.toBeChecked();
      await expectAccessible(cand, "the application form with the tick missing");

      // ---- with the tick: Send, and the receipt ---------------------------------------------------------------------------------
      await fillTheApplication(cand, maria, ANSWERS);
      await applicationForm(cand).getByRole("button", { name: "Send my application" }).click();
      await expectTheReceipt(cand);
      await expectAccessible(cand, "the receipt");
      await noSidewaysScroll(cand, "the receipt");

      // ---- one email: their own status link, and no AI interview -----------------------------------------------------------------
      const first = await waitForLink(owner.request, base, { to: maria.email, path: "/c/status/" });
      expect(first.path).toMatch(/^\/c\/status\/[A-Za-z0-9_-]+$/);
      expect(first.email.text).not.toContain("/c/screen/");
      expect((await emailsTo(owner.request, base, maria.email)).map((m) => m.subject)).toEqual([first.email.subject]);

      // ---- the status page: where the application is, never a score ---------------------------------------------------------------
      await cand.goto(first.path);
      const steps = cand.getByRole("list", { name: "Where your application is" });
      await expect(steps).toContainText("Received", { timeout: 30_000 });
      await expect(steps).toContainText("Under review");
      await expect(cand.getByText(/\d{1,3}\s?\/\s?100/)).toHaveCount(0);
      await expect(cand.getByText(/make every (hiring )?decision/i).first()).toBeVisible();
      await expectAccessible(cand, "the status page");
      await noSidewaysScroll(cand, "the status page");

      // ---- the team reads them: one person, where they came from, and what they answered -------------------------------------------
      await owner.goto(`/roles/${job.roleId}/talent`);
      await expect(candidateRow(owner, name)).toBeVisible({ timeout: 60_000 });
      await expect(candidateTabs(owner).getByRole("tab", { name: /^New 1$/ })).toBeVisible();
      const panel = await openThePanel(owner, name);
      await expect(panel.locator("dt", { hasText: "Came from" }).locator("xpath=following-sibling::dd[1]")).toHaveText("LinkedIn", { timeout: 30_000 });
      const answered = panel.getByRole("list", { name: "Screening answers" });
      for (const [question, answer] of Object.entries(ANSWERS)) await expect(answered.getByRole("listitem").filter({ hasText: question })).toContainText(answer);
      await expect(panel.getByRole("link", { name: maria.email })).toHaveAttribute("href", `mailto:${maria.email}`);
      await expectAccessible(owner, "the candidate panel of a new applicant");
      await owner.keyboard.press("Escape");

      // ---- applying again from the same address creates nothing, and the status link is emailed again ------------------------------
      await cand.goto(job.jobUrl);
      await cand.getByRole("link", { name: "Apply now" }).last().click();
      await fillTheApplication(cand, maria, ANSWERS);
      await applicationForm(cand).getByRole("button", { name: "Send my application" }).click();
      await cand.waitForLoadState("load");
      await waitForLink(owner.request, base, { to: maria.email, path: "/c/status/", count: 2 });
      await owner.goto(`/roles/${job.roleId}/talent`);
      await expect(owner.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 1$/ })).toBeVisible({ timeout: 30_000 });
      await expect(owner.locator(".candidate-row")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
