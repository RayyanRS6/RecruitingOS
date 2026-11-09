import { expect, test, type Page } from "@playwright/test";
import { PERSONAS, createCompanyThroughTheForm, emailsTo, exactlyOneEmail, expectAccessible, linkIn, liveJobThroughTheApi, resumeOf, signIn, skipWithoutFakeSignIn, waitForEmail, type Applicant } from "./helpers";

/**
 * The whole application, as a candidate goes through it, in a real browser (the owner, 6 November 2026: "then the complete
 * process of applying"): the careers page, the job page, the form with the résumé first and the notices in view, the
 * waiting room, the AI interview's introduction, the chat, Review & send with one answer changed, Send, and then the status
 * page from the one email they get: the steps, what happens next, the score once it is worked out (never a number from
 * the résumé alone while the interview is being scored), and their answers as sent. The required notices (the AI notice,
 * people make every decision) are checked on each page that carries them. The job is the owner's, drafted through the API:
 * it is not the subject here. Runs on a desk (project "flows") and on a phone (project "flows-phone").
 */
const run = Date.now().toString(36);

async function noSidewaysScrolling(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways`).toBeLessThanOrEqual(innerWidth + 1);
}

test.describe("the whole application", () => {
  skipWithoutFakeSignIn();

  test("careers page to Send, one email, and the status page with the score and the answers as sent", async ({ page: cand, browser, baseURL }, info) => {
    test.setTimeout(480_000);
    const base = baseURL!;
    const tag = `${run}${info.project.name === "flows-phone" ? "p" : "d"}`;
    const company = `Coastal Care ${tag}`;
    // the owner, at a desk in a browser of their own; the candidate is this project's page (a desk, or a phone)
    const context = await browser.newContext({ baseURL: base });
    const owner = await context.newPage();
    await signIn(owner, { email: `owner+${tag}@coastalcare.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(owner, company);
    const job = await liveJobThroughTheApi(owner.request, base);
    // the questions every applicant answers (the owner's, set on the job's Scoring tab)
    const questions = await owner.request.put(`${base}/api/v1/roles/${job.roleId}/company-questions`, {
      data: { baseVersion: 1, quick: [{ kind: "choice", question: "Which shift suits you best?", options: ["Mornings", "Afternoons", "Either"] }], written: [{ question: "Tell us about a time you helped a nervous patient.", lookFor: "A real patient: what they noticed, what they did, how it ended." }] },
    });
    expect(questions.status(), await questions.text()).toBe(200);
    const page = owner;

    const maria: Applicant = { first: "Maria", last: "Reyes", email: `maria.reyes+${tag}@example.com`, resume: PERSONAS.strong.resume };
    try {
      // ---- the careers page and the job page --------------------------------------------------------------------------
      await cand.goto(`/careers/${job.slug}`);
      await expect(cand.getByRole("heading", { level: 1 })).toContainText(company);
      await cand.getByRole("link", { name: new RegExp(job.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
      await cand.waitForURL(new RegExp(`/careers/${job.slug}/jobs/${job.roleId}$`));
      await expect(cand.getByRole("heading", { level: 1 })).toContainText(job.title);
      await expect(cand.getByRole("listitem").filter({ hasText: "Pay: $45–$55 an hour" })).toBeVisible();
      await noSidewaysScrolling(cand, "the job page");
      await cand.getByRole("link", { name: "Apply now" }).last().click();

      // ---- the form: the résumé first, read at once; the notices in view; nothing ticked for them -------------------------
      await cand.waitForURL(new RegExp(`/careers/${job.slug}/jobs/${job.roleId}/apply$`));
      await expect(cand.getByRole("heading", { name: "Start with your resume" })).toBeVisible();
      const before = cand.locator("section", { has: cand.getByRole("heading", { name: "Before you send" }) });
      await expect(before.getByText(`People at ${company} make every hiring decision.`, { exact: true })).toBeVisible();
      await expect(before.getByText("You can ask for a person at any time.", { exact: true })).toBeVisible();
      await expect(before.getByRole("link", { name: "Read how we handle your information" }).first()).toHaveAttribute("href", "/privacy");
      const acknowledgment = cand.getByRole("checkbox", { name: /I have read the full notice above and I understand that people, not software, make the hiring decisions\./ });
      await expect(acknowledgment).not.toBeChecked();
      await expectAccessible(cand, "the apply form");
      await cand.locator('input[name="resume"]').setInputFiles({ name: "maria-reyes.txt", mimeType: "text/plain", buffer: Buffer.from(resumeOf(maria)) });
      await expect(cand.getByRole("heading", { name: "Check your details" })).toBeVisible({ timeout: 60_000 });
      await expect(cand.getByLabel("First name")).toHaveValue("Maria");
      await expect(cand.getByLabel("Last name")).toHaveValue("Reyes");
      await expect(cand.getByLabel("Email")).toHaveValue(maria.email);
      await expect(cand.getByText("From your resume — check it").first()).toBeVisible();
      const quick = cand.locator("section.quick");
      await quick.getByRole("group", { name: /Which shift suits you best\?/ }).getByText("Mornings", { exact: true }).click();
      for (const group of await quick.locator("li fieldset").all()) {
        if (await group.locator("input:checked").count()) continue;
        const yes = group.locator('input[type="radio"][value="yes"]');
        if (await yes.count()) await yes.check();
        else await group.locator('input[type="checkbox"]').first().check();
      }
      await expect(quick.locator("#q-count")).toHaveText(/^(\d+) of \1 answered/);
      // the full notice is one fold away, every word of it
      await before.getByText("Read the full notice", { exact: true }).click();
      await expect(before.getByText(new RegExp(`${company} runs this hiring process and is the employer\\.`))).toBeVisible();
      await acknowledgment.check();
      await noSidewaysScrolling(cand, "the apply form");
      await cand.getByRole("button", { name: "Send my application" }).click();

      // ---- the waiting room opens the AI interview's introduction by itself ----------------------------------------------
      await cand.waitForURL(/\/c\/screen\/[A-Za-z0-9_-]+$/, { timeout: 150_000 });
      await expect(cand.getByText("Your application is sent.")).toBeVisible();
      await expect(cand.getByText(new RegExp(`This conversation is with ${company}'s AI assistant, a software program, not a person\\.`))).toBeVisible();
      await expect(cand.getByText(/It is a conversation, not a test\./)).toBeVisible();
      await expect(cand.getByRole("button", { name: "Do this later" })).toBeVisible();
      await expect(cand.getByRole("link", { name: "I'd rather talk to a person" })).toBeVisible();
      await expectAccessible(cand, "the AI interview's introduction");

      // the one email, by its words: their next step, how it works, how long the link lasts, and their own page
      const ack = await waitForEmail(page.request, base, {
        to: maria.email,
        subject: `Thank you for applying: your next step for ${job.title} at ${company}`,
        says: ["Hi Maria,", `Thank you for applying for the ${job.title} position at ${company}. We have your application.`, "Start your AI interview:", "How it works:", "You can skip any question.", "The link stays open for 5 days, and we send you one reminder.", "Not doing the interview never stops your application", "People on the hiring team read every application and make every decision.", "Check where things stand at any time:", `This message was sent by the hiring team at ${company} with help from an AI recruiting assistant.`],
      });
      // its AI interview link is the page they are on
      expect(linkIn(ack, "/c/screen/")).toBe(new URL(cand.url()).pathname);
      const statusPath = linkIn(ack, "/c/status/");

      // ---- the chat, one question at a time, in their own words -------------------------------------------------------------
      await cand.getByRole("button", { name: "Start" }).click();
      await expect(cand.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible({ timeout: 30_000 });
      await expect(cand.getByRole("navigation", { name: "Your application" })).toContainText(/\d+ of \d+ required · /);
      await expect(cand.getByRole("button", { name: "Skip this question" }).first()).toBeVisible();
      await expectAccessible(cand, "the chat");
      const chatEnd = cand.getByRole("button", { name: "Review and send" });
      const says = PERSONAS.strong.says;
      for (let i = 0; i < 30; i++) {
        if (await chatEnd.isVisible()) break;
        const asked = (await cand.locator("li.msg.assistant.now").textContent()) ?? "";
        if (await cand.getByRole("button", { name: "Yes", exact: true }).isVisible()) {
          await cand.getByRole("button", { name: /licen[cs]e/i.test(asked) ? says.licence : "Yes", exact: true }).click();
        } else if (await cand.getByLabel("From", { exact: true }).isVisible()) {
          await cand.getByLabel("From", { exact: true }).fill("50");
          await cand.getByLabel("To (optional)", { exact: true }).fill("54");
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else if (await cand.getByLabel("The earliest day you could start").isVisible()) {
          await cand.getByLabel("The earliest day you could start").fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else if (await cand.getByRole("group", { name: "Tick every day you can work" }).isVisible()) {
          await cand.getByLabel("Monday").check();
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else {
          await cand.getByLabel(/^Your reply/).fill(/licen[cs]e/i.test(asked) ? says.licenceWords : /nervous|patient|difficult|time when|a time/i.test(asked) ? says.story : says.work);
          await cand.getByRole("button", { name: "Send", exact: true }).click();
        }
      }
      await expect(cand.getByText("Your chat is complete.")).toBeVisible({ timeout: 30_000 });
      // nothing has gone to the team yet: the page says so until Send
      await expect(cand.getByText(/Your replies go to .+ only when you press Send/)).toBeVisible();

      // ---- Review & send: the answers written up from their replies; one changed by hand; Send ---------------------------
      await chatEnd.click();
      await expect(cand.getByRole("heading", { level: 1, name: "Check what you're sending" })).toBeVisible({ timeout: 60_000 });
      await expect(cand.getByText(/Which shift suits you best\? Mornings/).first()).toBeVisible();
      const fromChat = cand.locator("section.send-part", { has: cand.getByRole("heading", { name: "From your chat" }) });
      const nervous = fromChat.locator("li.answer", { hasText: "Tell us about a time you helped a nervous patient." });
      await expect(nervous).toBeVisible();
      // the owner's private note on what a good answer shows never reaches the candidate
      await expect(cand.getByText(/A real patient: what they noticed/)).toHaveCount(0);
      const changed = "A nervous patient was shaking before a deep cleaning. I explained each step and we agreed a hand signal to pause; she finished and rebooked with me.";
      await nervous.getByRole("link", { name: /^(Edit|Change)/ }).click();
      await cand.getByLabel(/^Your answer/).fill(changed);
      await cand.getByRole("button", { name: "Save this answer" }).click();
      await expect(cand.getByText("Your answer is changed.")).toBeVisible();
      await expect(nervous.locator("p.pre")).toHaveText(changed);
      await expectAccessible(cand, "check what you're sending");
      await noSidewaysScrolling(cand, "check what you're sending");
      await cand.getByRole("button", { name: "Send my answers" }).click();
      await expect(cand.getByRole("heading", { level: 1, name: "Thanks, your answers are sent" })).toBeVisible({ timeout: 60_000 });
      await expectAccessible(cand, "answers sent");

      // ---- the status page, from the link in the email -----------------------------------------------------------------------
      await cand.goto(statusPath);
      await expect(cand.locator('ol.track [aria-current="step"]')).toHaveText("Review", { timeout: 30_000 });
      await expect(cand.getByText("Thanks for completing the AI interview. The team is reviewing your answers.")).toBeVisible();
      await expect(cand.getByText(`People on the hiring team at ${company} make every decision about your application.`)).toBeVisible();
      await cand.getByText("How AI is used", { exact: true }).click();
      await expect(cand.getByText(/who is interviewed, hired or turned down is always a person's decision/)).toBeVisible();
      // the score: worked out once the AI interview is scored, and never a number from the résumé alone in the meantime
      const score = cand.locator("section#score");
      await expect.poll(async () => {
        await cand.goto(statusPath);
        if (await score.getByText("Your match score is ready").isVisible()) return "ready";
        await expect(score.locator(".score-num")).toHaveCount(0);
        return (await score.getByRole("heading").textContent()) ?? "";
      }, { timeout: 120_000, intervals: [2_000], message: "the match score on the status page" }).toBe("ready");
      await expect(score.locator(".score-num")).toHaveText(/^\d{1,3}\/100$/);
      await expect(score.getByText(/^From your résumé and your AI interview\./)).toBeVisible();
      await expect(score.getByText(/A person makes every decision: the score never decides anything on its own\./)).toBeVisible();
      // their answers exactly as sent, the one they changed marked as theirs
      const answers = cand.locator("section#answers");
      await expect(answers.getByText(changed).first()).toBeVisible();
      await expect(answers.getByText("Changed by you").first()).toBeVisible();
      // what they were sent, as a conversation; still only the one email
      await expect(cand.getByRole("heading", { level: 2, name: "Messages about your application" })).toBeVisible();
      await expect(cand.locator("ol.thread li.msg.team").first()).toContainText(/Thank you for applying/);
      await expectAccessible(cand, "the status page");
      await noSidewaysScrolling(cand, "the status page");
      await exactlyOneEmail(page.request, base, { to: maria.email, subject: /^Thank you for applying/ });
      expect((await emailsTo(page.request, base, maria.email)).map((m) => m.subject)).toEqual([ack.subject]);
    } finally {
      await context.close();
    }
  });
});
