import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn, statusPathFromEmail, useOneVisitFlow } from "./helpers";

/**
 * The Kanvis-style application (Wave S7; scratchpad spec-s7-apply-flow.md steps 1 to 11), in a real browser with every
 * provider faked: the owner sets the questions every applicant answers; a candidate applies with a resume, sees their
 * details filled in from it, answers the company's quick questions, has the chat, checks the answers written up from
 * their own replies on Review & send, changes one and sends; the application record shows the steps and (the ITS
 * switch is on by default) the match score with its breakdown; and the owner then reads the written-up answers in the
 * candidate panel. Every candidate page is checked with axe at desktop width and at a phone's width.
 */
const run = Date.now().toString(36);

/** The resume the candidate chooses: plain text, synthetic. */
const RESUME = (email: string) => `Maria Reyes\n${email}\n(949) 555-0123\nTustin, CA\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nActive CA RDH license 554433\nBLS certified\nDentrix, periodontal charting, scaling and root planing\n`;

/** axe at the page's own width, then at a phone's width with no sideways scrolling, then back. */
async function accessibleAtBothWidths(page: Page, name: string) {
  await expectAccessible(page, name);
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAccessible(page, `${name} (phone width)`);
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on a phone`).toBeLessThanOrEqual(innerWidth + 1);
  if (size) await page.setViewportSize(size);
}

test.describe("the Kanvis-style application", () => {
  skipWithoutFakeSignIn();
  test("resume first, the company's questions, the chat, Review & send, the record with the score, and the owner's view", async ({ page, browser, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;

    // ---- the owner: a company, a live job, and the questions every applicant answers -----------------------------
    await signIn(page, { email: `owner+kv${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Apply ${run}`);
    const companyId = ((await (await page.request.get(`${base}/api/v1/companies/current`)).json()) as { id: string }).id;
    await useOneVisitFlow(browser, base, companyId);
    const s = (await (await page.request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json()) as { session: { id: string } };
    const { roleId } = (await (await page.request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
    expect((await page.request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } })).ok()).toBeTruthy();
    const slug = ((await (await page.request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string }).slug;
    const saved = await page.request.put(`${base}/api/v1/roles/${roleId}/company-questions`, {
      data: {
        baseVersion: 1,
        quick: [
          { kind: "choice", question: "Which shift suits you best?", options: ["Mornings", "Afternoons", "Either"] },
          { kind: "number", question: "How many years have you worked as a hygienist?", unit: "years", min: 0, max: 50 },
        ],
        written: [{ question: "Tell us about a time you helped a nervous patient.", lookFor: "A real patient: what they noticed, what they did, how it ended." }],
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    expect(((await saved.json()) as { outcome: string }).outcome).toBe("approved_current");

    // the owner's card on the job's Scoring tab lists them
    await page.goto(`/roles/${roleId}?tab=scoring`);
    await expect(page.getByRole("heading", { name: "Questions every applicant answers" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Which shift suits you best?").first()).toBeVisible();

    // ---- the candidate, in a browser of their own ---------------------------------------------------------------
    const candidateContext = await browser.newContext({ baseURL: base });
    const cand = await candidateContext.newPage();
    const email = `maria.reyes.kv+${run}@example.com`;
    // the answer she rewrites on Review & send, which the owner then reads
    const changed = "A nervous patient was shaking before a deep cleaning. I explained each step and we agreed a hand signal to pause; she finished and rebooked with me.";
    try {
      // the job page leads to the form, which starts with the resume
      await cand.goto(`/careers/${slug}/jobs/${roleId}`);
      await expect(cand.getByRole("heading", { level: 1 })).toBeVisible();
      await cand.getByRole("link", { name: "Apply now" }).last().click();
      await cand.waitForURL(new RegExp(`/careers/${slug}/jobs/${roleId}/apply$`));
      await expect(cand.getByRole("navigation", { name: "Your application" }).locator('[aria-current="step"]')).toHaveText("Details");
      await expect(cand.getByRole("heading", { name: "Start with your resume" })).toBeVisible();
      await accessibleAtBothWidths(cand, "apply form");

      // choosing the resume reads it at once, and the same form comes back as "Check your details"
      await cand.locator('input[name="resume"]').setInputFiles({ name: "maria-reyes.txt", mimeType: "text/plain", buffer: Buffer.from(RESUME(email)) });
      await expect(cand.getByRole("heading", { name: "Check your details" })).toBeVisible({ timeout: 60_000 });
      await expect(cand.getByLabel("First name")).toHaveValue("Maria");
      await expect(cand.getByLabel("Last name")).toHaveValue("Reyes");
      await expect(cand.getByLabel("Email")).toHaveValue(email);
      await expect(cand.getByText("From your resume — check it").first()).toBeVisible();
      await accessibleAtBothWidths(cand, "check your details");

      // "Questions from <Company>": numbered, with a count; the company's own questions answered with taps and a number
      const questions = cand.locator("section.quick");
      await expect(questions.getByRole("heading", { name: /^Questions from / })).toBeVisible();
      await expect(questions.locator("#q-count")).toHaveText(/^\d+ of \d+ answered/);
      await questions.getByRole("group", { name: /Which shift suits you best\?/ }).getByText("Mornings", { exact: true }).click();
      await questions.getByLabel(/How many years have you worked as a hygienist\?/).fill("6");
      // the job's own questions: Yes (or the first day) where nothing is chosen yet (the resume may have suggested one)
      for (const group of await questions.locator("li fieldset").all()) {
        if (await group.locator("input:checked").count()) continue;
        const yes = group.locator('input[type="radio"][value="yes"]');
        if (await yes.count()) await yes.check();
        else await group.locator('input[type="checkbox"]').first().check();
      }
      await expect(questions.locator("#q-count")).toHaveText(/^(\d+) of \1 answered/);
      await cand.getByRole("checkbox", { name: /I have read the full notice above/ }).check();
      await cand.getByRole("button", { name: "Send my application" }).click();

      // the chat's introduction, then the chat: the counter in the steps header, never the questions themselves
      await cand.waitForURL(/\/c\/screen\/[A-Za-z0-9_-]+$/);
      await expect(cand.getByText("Your application is sent.")).toBeVisible();
      await accessibleAtBothWidths(cand, "chat introduction");
      await cand.getByRole("button", { name: "Start" }).click();
      await expect(cand.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible();
      await expect(cand.getByText(/Your replies go to .+ only when you press Send/)).toBeVisible();
      await expect(cand.getByRole("navigation", { name: "Your application" })).toContainText(/\d+ of \d+ required · /);
      await accessibleAtBothWidths(cand, "the chat");
      const chatEnd = cand.getByRole("button", { name: "Review and send" });
      for (let i = 0; i < 24; i++) {
        if (await chatEnd.isVisible()) break;
        const asked = (await cand.locator("li.msg.assistant.now").textContent()) ?? "";
        if (await cand.getByRole("button", { name: "Yes", exact: true }).isVisible()) {
          await cand.getByRole("button", { name: "Yes", exact: true }).click();
        } else if (await cand.getByLabel("From").isVisible()) {
          await cand.getByLabel("From").fill("50");
          await cand.getByLabel("To (optional)").fill("54");
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else if (await cand.getByLabel("The earliest day you could start").isVisible()) {
          await cand.getByLabel("The earliest day you could start").fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else if (await cand.getByRole("group", { name: "Tick every day you can work" }).isVisible()) {
          await cand.getByLabel("Monday").check();
          await cand.getByRole("button", { name: "Send", exact: true }).first().click();
        } else {
          const words = /nervous patient/i.test(asked)
            ? "A patient at Coastal was shaking before a deep cleaning, so I explained each step first and agreed a hand signal to pause; she finished the visit and rebooked with me."
            : "At Coastal Family Dentistry I see about nine patients a day, chart in Dentrix and do scaling and root planing with an active California RDH license.";
          await cand.getByLabel(/^Your reply/).fill(words);
          await cand.getByRole("button", { name: "Send", exact: true }).click();
        }
      }
      await expect(cand.getByText("Your chat is complete.")).toBeVisible();
      await accessibleAtBothWidths(cand, "the chat's end");

      // Review & send: the details from the form, then each answer written up from her own replies, with Edit
      await chatEnd.click();
      await expect(cand.getByRole("heading", { level: 1, name: "Check what you're sending" })).toBeVisible({ timeout: 60_000 });
      await expect(cand.getByRole("navigation", { name: "Your application" }).locator('[aria-current="step"]')).toHaveText("Review & send");
      await expect(cand.getByRole("heading", { name: /^Your details for / })).toBeVisible();
      await expect(cand.getByText(/Which shift suits you best\? Mornings/).first()).toBeVisible();
      const fromChat = cand.locator("section.send-part", { has: cand.getByRole("heading", { name: "From your chat" }) });
      const nervous = fromChat.locator("li.answer", { hasText: "Tell us about a time you helped a nervous patient." });
      await expect(nervous.locator("p.pre")).toContainText(/hand signal/);
      // the company's private "what a good answer shows" never reaches the candidate
      await expect(cand.getByText(/A real patient: what they noticed/)).toHaveCount(0);
      await accessibleAtBothWidths(cand, "check what you're sending");
      await nervous.getByRole("link", { name: /^(Edit|Change)/ }).click();
      await cand.getByLabel(/^Your answer/).fill(changed);
      await accessibleAtBothWidths(cand, "change a written-up answer");
      await cand.getByRole("button", { name: "Save this answer" }).click();
      await expect(cand.getByText("Your answer is changed.")).toBeVisible();
      await expect(nervous.locator(".pill", { hasText: /^Changed$/ })).toBeVisible();
      await expect(nervous.locator("p.pre")).toHaveText(changed);
      await cand.getByRole("button", { name: "Send my answers" }).click();
      await expect(cand.getByRole("heading", { level: 1, name: "Thanks, your answers are sent" })).toBeVisible();
      await accessibleAtBothWidths(cand, "answers sent");

      // ---- the application record, from the emailed link ----------------------------------------------------------
      const statusPath = await statusPathFromEmail(page.request, base, email);
      await cand.goto(statusPath);
      await expect(cand.locator('ol.track [aria-current="step"]')).toHaveCount(1);
      await expect(cand.getByRole("navigation", { name: "On this page" })).toBeVisible();
      // the score is worked out once the chat's scorecard is written: "Check again" until it is ready
      await expect.poll(async () => {
        await cand.goto(statusPath);
        return cand.getByText("Your match score is ready").isVisible();
      }, { timeout: 90_000, intervals: [2_000], message: "the match score on the application record" }).toBe(true);
      const score = cand.locator("section#score");
      await expect(score.locator(".score-num")).toHaveText(/^\d{1,3}\/100$/);
      await expect(score.locator("ul.bars > li").first()).toBeVisible();
      await expect(score.getByText(/sees this score with your application and your chat\./)).toBeVisible();
      await expect(score.getByText(/their private notes are never shared with you/)).toBeVisible();
      // "Your answers": exactly what was sent, the change she made marked as hers
      const answers = cand.locator("section#answers");
      await expect(answers.getByText(changed).first()).toBeVisible();
      await expect(answers.getByText("Changed by you").first()).toBeVisible();
      await accessibleAtBothWidths(cand, "application record");
    } finally {
      await candidateContext.close();
    }

    // ---- the owner reads the written-up answers in the candidate panel -------------------------------------------
    const list = (await (await page.request.get(`${base}/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; candidate: { email: string | null } | null }>;
    const id = list.find((a) => a.candidate?.email === email.toLowerCase())!.id;
    await page.goto(`/roles/${roleId}/talent?open=${id}`);
    const maria = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(maria).toBeVisible({ timeout: 30_000 });
    await maria.getByRole("tab", { name: "Screening chat" }).click();
    const written = maria.getByRole("region", { name: "Answers to your questions" });
    await expect(written).toBeVisible({ timeout: 30_000 });
    await expect(written.getByText("Tell us about a time you helped a nervous patient.").first()).toBeVisible();
    await expect(written.getByText(changed).first()).toBeVisible();
    await expectAccessible(page, "the candidate panel with the written-up answers");
  });
});
