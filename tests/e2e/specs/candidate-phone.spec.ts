import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn, statusPathFromEmail, useOneVisitFlow } from "./helpers";

/**
 * The candidate's own journey on a phone (docs/spec/20 items 2 and 3; docs/readiness/20 section D; plan Wave E): the job
 * page, the application form with its transparency block and the affirmative acknowledgment, then in the same visit the
 * screening conversation (its introduction, the person choice, one question at a time with taps and a skip, check your
 * answers, send) and later the scheduling page, every one rendered on the phone project, checked with axe and for
 * sideways scrolling. The owner's
 * side (the company, the role, the interview approval, declared hours) is seeded through the API with the browser's own
 * session so the journey stays on the candidate pages. Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);

async function noHorizontalOverflow(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on this viewport`).toBeLessThanOrEqual(innerWidth + 1);
}

/** An approved, open role and the owner's declared interview hours, through the API. */
async function seedOpenRole(request: APIRequestContext, base: string) {
  const s = (await (await request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json()) as { session: { id: string } };
  const { roleId } = (await (await request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
  expect((await request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } })).ok()).toBeTruthy();
  const role = (await (await request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> }; interviews: { plan: Array<{ key: string }> } } } };
  const company = (await (await request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string };
  const me = (await (await request.get(`${base}/api/v1/auth/me`)).json()) as { user: { id: string } };
  expect((await request.put(`${base}/api/v1/me/availability`, { data: { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 } })).ok()).toBeTruthy();
  return { roleId, slug: company.slug, ownerId: me.user.id, eligibility: role.currentPacket.packet.requirements.eligibility, firstRound: role.currentPacket.packet.interviews.plan[0].key };
}

type BoardPosting = { channel: string; isBoard: boolean; link: { url: string; visits: number } | null };
const SOURCE_OF_CHANNEL: Record<string, string> = { linkedin_basic: "linkedin", indeed: "indeed", ziprecruiter: "ziprecruiter" };

/** A board's own tracked apply link, the one its posting package carries (docs/spec/20 items 7 and 9), once publishing has made it. */
async function boardLink(request: APIRequestContext, base: string, roleId: string, channel?: string): Promise<{ channel: string; url: string; visits: number }> {
  let found: BoardPosting | undefined;
  await expect.poll(async () => {
    const d = (await (await request.get(`${base}/api/v1/roles/${roleId}/postings`)).json()) as { postings: BoardPosting[] };
    found = d.postings.find((p) => p.isBoard && p.link && SOURCE_OF_CHANNEL[p.channel] && (!channel || p.channel === channel));
    return !!found;
  }, { timeout: 60_000, message: "a board posting with its own tracked apply link" }).toBe(true);
  return { channel: found!.channel, url: found!.link!.url, visits: found!.link!.visits };
}

test.describe("candidate journey on a phone", () => {
  skipWithoutFakeSignIn();
  test("job page, application with the acknowledgment, screening conversation and scheduling, all accessible on a phone", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    await signIn(page, { email: `owner+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Phone ${run}`);
    // a pilot company: ITS switches on the conversation in the same visit as the form (plan Wave E, founder decision B1)
    const companyId = ((await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json()) as { id: string }).id;
    await useOneVisitFlow(browser, baseURL!, companyId);
    const seeded = await seedOpenRole(page.request, baseURL!);
    const email = `maria.reyes+${run}@example.com`;

    // the job page: the employer named, the structured data present, the apply button leading to the form
    await page.goto(`/careers/${seeded.slug}/jobs/${seeded.roleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
    await expectAccessible(page, "job page");
    await noHorizontalOverflow(page, "job page");
    // the job page has two Apply buttons (plan D10): one by the title, hidden under 900px, and the sticky one; the last is
    // the one that stays on screen on any width
    const applyNow = page.getByRole("link", { name: "Apply now" }).last();
    await expect(applyNow).toBeVisible();
    // the Apply button stays on a phone's screen while the job is read, and the job's facts are pills that name themselves to a screen reader
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(applyNow).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 3)));
    await expect(applyNow).toBeInViewport();
    await expect(page.getByRole("listitem").filter({ hasText: "Pay: $45–$55 an hour" })).toBeVisible();

    // the candidate arrives the way a board sends them: the tracked apply link from the board's posting package is served
    // by the deployed app (never Next.js's not-found page), counts the visit and lands on the form with the source remembered
    const board = await boardLink(page.request, baseURL!, seeded.roleId);
    const tracked = new URL(board.url);
    expect(tracked.pathname).toMatch(/^\/a\/[a-z0-9]{12}$/);
    await page.goto(tracked.pathname);
    await page.waitForURL(new RegExp(`/careers/${seeded.slug}/jobs/${seeded.roleId}/apply$`));

    // the form: the job's facts on top, the transparency block and the privacy link on the page; the acknowledgment starts unchecked
    await expect(page.getByRole("heading", { level: 1, name: /^Apply: / })).toBeVisible();
    // Wave S7: the steps header (Details is the step), the résumé first, and the company's questions numbered under their own heading
    await expect(page.getByRole("navigation", { name: "Your application" }).locator('[aria-current="step"]')).toHaveText("Details");
    await expect(page.getByRole("heading", { name: "Start with your resume" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Questions from / })).toBeVisible();
    await expect(page.getByText("$45–$55 an hour").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Before you send" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Read how we handle your information" }).first()).toHaveAttribute("href", "/privacy");
    const acknowledgment = page.getByRole("checkbox", { name: /I have read the full notice above/ });
    await expect(acknowledgment).not.toBeChecked();
    await expectAccessible(page, "apply form");
    await noHorizontalOverflow(page, "apply form");
    await page.getByLabel("First name").fill("Maria");
    await page.getByLabel("Last name").fill("Reyes");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(/Where are you based/).fill("Tustin, CA");
    // no resume: four short guided questions behind a disclosure (plan D10); one answer is enough
    await page.getByText("No resume? Answer four short questions instead").click();
    await page.getByLabel("Your most recent job or work").fill("Registered Dental Hygienist at Coastal Family Dentistry since 2019.");
    await page.getByLabel("Skills, licenses or tools that fit this job").fill("Active CA RDH license, Dentrix, periodontal charting.");
    for (const rule of seeded.eligibility) {
      const field = page.locator(`[name="elig_${rule.key}"]`).first();
      if ((await field.evaluate((el) => el.tagName)) === "SELECT") await field.selectOption("yes");
      else await page.locator(`[name="elig_${rule.key}"]`).first().check();
    }

    // without the acknowledgment the form comes back with everything kept and the box marked; the browser's own check is bypassed the way a script or an old browser would
    await acknowledgment.evaluate((el) => el.removeAttribute("required"));
    await page.getByRole("button", { name: "Send my application" }).click();
    await expect(page.getByRole("alert")).toContainText(/confirm you have read the notice/);
    await expect(page.getByLabel("First name")).toHaveValue("Maria");
    await expect(page.getByLabel("Email")).toHaveValue(email);
    await expect(page.getByRole("checkbox", { name: /I have read the full notice above/ })).toHaveAttribute("aria-invalid", "true");
    for (const rule of seeded.eligibility) {
      const field = page.locator(`[name="elig_${rule.key}"]`).first();
      if ((await field.evaluate((el) => el.tagName)) === "SELECT") await expect(field).toHaveValue("yes");
    }
    await expectAccessible(page, "apply form with the acknowledgment missing");

    // ticking the box sends it; the waiting room (20 Oct 2026, R20-12) opens the AI interview's introduction by itself once
    // the résumé is read, which says the application went through and where its link went (masked), never the status link
    await page.getByRole("checkbox", { name: /I have read the full notice above/ }).check();
    await page.getByRole("button", { name: "Send my application" }).click();
    await page.waitForURL(/\/c\/screen\/[A-Za-z0-9_-]+$/, { timeout: 150_000 });
    await expect(page.getByText(/This conversation is with .+'s AI assistant, a software program, not a person\./)).toBeVisible();
    await expect(page.getByText("Your application is sent.")).toBeVisible();
    await expect(page.getByText(/m\*\*\*@example\.com/)).toBeVisible();
    await expect(page.locator('a[href^="/c/status/"]')).toHaveCount(0);
    // the fixed introduction (E2): what it is, a conversation and not a test, how long, and three ways on
    await expect(page.getByRole("heading", { level: 1, name: /^A few questions about the / })).toBeVisible();
    await expect(page.getByText(/It is a conversation, not a test\./)).toBeVisible();
    await expect(page.getByText(/About \d+ questions and \d+ minutes, one question at a time\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Do this later" })).toBeVisible();
    // on the web a person is one press away: the page says so, never the email wording "Reply HUMAN" (polish list)
    await page.getByText("More about this conversation", { exact: true }).click();
    await expect(page.getByText("Would you rather talk to a person? Press \"I'd rather talk to a person\" at any time.")).toBeVisible();
    await expect(page.getByText(/Reply HUMAN at any time|This message was sent by/)).toHaveCount(0);
    await expectAccessible(page, "conversation introduction");
    await noHorizontalOverflow(page, "conversation introduction");
    // "I'd rather talk to a person": two equal choices, and a way back without choosing (E3)
    await page.getByRole("link", { name: "I'd rather talk to a person" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Talk to a person instead" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send without the conversation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Have a person contact me" })).toBeVisible();
    await expectAccessible(page, "person choice");
    await noHorizontalOverflow(page, "person choice");
    await page.getByRole("link", { name: "Back to the conversation" }).click();

    // Start, from the keyboard: the chat at once (Wave S7), the message to answer in large type, the counter in the
    // steps header (never the questions themselves), and the quiet skip
    await page.getByRole("button", { name: "Start" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Your application" })).toContainText(/\d+ of \d+ required · /);
    await expect(page.getByRole("list", { name: "Your chat" }).locator("li.msg.assistant.now")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip this question" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "I'd rather talk to a person" })).toBeVisible();
    await expectAccessible(page, "first question");
    await noHorizontalOverflow(page, "first question");
    // every question: a tap where one is offered (E12), words otherwise, and the example question skipped (E11)
    const chatEnd = page.getByRole("button", { name: "Review and send" });
    for (let i = 0; i < 24; i++) {
      if (await chatEnd.isVisible()) break;
      // the whole chat is one thread: Maria's own replies beside the assistant's lines (polish list)
      if (i === 2) {
        const thread = page.getByRole("list", { name: "Your chat" });
        await expect(thread.locator("li.msg.assistant").first()).toBeVisible();
        expect(await thread.locator("li.msg.candidate").count()).toBeGreaterThanOrEqual(1);
        await expectAccessible(page, "the chat so far");
        await noHorizontalOverflow(page, "the chat so far");
      }
      const asked = (await page.locator("li.msg.assistant.now").textContent()) ?? "";
      if (/difficult moment/i.test(asked)) {
        await page.getByRole("button", { name: "Skip this question" }).first().click();
      } else if (await page.getByRole("button", { name: "Yes", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "Yes", exact: true }).click();
      } else if (await page.getByLabel("From").isVisible()) {
        await page.getByLabel("From").fill("50");
        await page.getByLabel("To (optional)").fill("54");
        await page.getByRole("button", { name: "Send", exact: true }).first().click();
      } else if (await page.getByLabel("The earliest day you could start").isVisible()) {
        await page.getByLabel("The earliest day you could start").fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
        await page.getByRole("button", { name: "Send", exact: true }).first().click();
      } else if (await page.getByRole("group", { name: "Tick every day you can work" }).isVisible()) {
        await page.getByLabel("Monday").check();
        await page.getByRole("button", { name: "Send", exact: true }).first().click();
      } else {
        await page.getByLabel(/^Your reply/).fill("I have been a hygienist for six years, see about nine patients a day in Dentrix, and hold an active California RDH license.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      }
      if (i === 1) await expectAccessible(page, "a later question");
    }
    // the chat's end, then Review & send (Wave S7): the answers written up from her replies, the skipped one marked;
    // answer it from here, then send
    await expect(page.getByText("Your chat is complete.")).toBeVisible();
    await expectAccessible(page, "the chat's end");
    await chatEnd.click();
    await expect(page.getByRole("heading", { level: 1, name: "Check what you're sending" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("li.answer .pill", { hasText: /^Skipped$/ }).first()).toBeVisible();
    await expectAccessible(page, "check what you're sending");
    await noHorizontalOverflow(page, "check what you're sending");
    await page.getByRole("link", { name: /^Answer it/ }).first().click();
    await page.getByLabel(/^Your answer/).fill("A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me.");
    await page.getByRole("button", { name: "Save this answer" }).click();
    await expect(page.getByText("Your answer is changed.")).toBeVisible();
    await expect(page.locator("li.answer .pill", { hasText: /^Changed$/ }).first()).toBeVisible();
    await page.getByRole("button", { name: "Send my answers" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Thanks, your answers are sent" })).toBeVisible();
    await expectAccessible(page, "answers sent");
    await noHorizontalOverflow(page, "answers sent");

    // "Lost your link?" stays reachable and accessible on a phone
    await page.goto("/c/link-request");
    await expect(page.getByRole("heading", { level: 1, name: "Lost your link?" })).toBeVisible();
    await expectAccessible(page, "lost your link");
    await noHorizontalOverflow(page, "lost your link");

    // the status page opens from the emailed link, without a login
    const statusPath = await statusPathFromEmail(page.request, baseURL!, email);
    await page.goto(statusPath);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // the candidate's own steps (plan A1; the Wave S2 progress line Applied, Screening chat, Review, Interview, Decision),
    // the current one marked; the team's stage names and private marks never show
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveCount(1);
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText(/^(Applied|AI interview|Review)$/);
    await page.getByText("How AI is used", { exact: true }).first().click();
    await expect(page.getByText(/who is interviewed, hired or turned down is always a person's decision/)).toBeVisible();
    await expectAccessible(page, "status page");
    await noHorizontalOverflow(page, "status page");
    // withdrawing is an outlined secondary button here too (the surface fill, --surface #fefcfb), not the plum main action
    // (under "No longer interested?")
    await page.getByText("No longer interested?", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Withdraw my application" })).toHaveCSS("background-color", "rgb(254, 252, 251)");
    // the messages read as a conversation (plan G7): what we sent, oldest first, and no reply box (replies go by email)
    await expect(page.getByRole("heading", { level: 2, name: "Messages about your application" })).toBeVisible();
    await expect(page.locator("ol.thread li.msg.team").first()).toContainText(/Thank you for applying/);
    await page.getByText("Ask for a copy, a fix, deletion, or a person's review", { exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveCount(1); // the privacy request's details, nothing else
    // "Future roles" is one click either way, lands back at the choice (where the decision messages link) and says it was saved (Wave 0 item 0.11, Q30)
    await page.getByRole("button", { name: "Don't keep me for future roles" }).click();
    await page.waitForURL(/\?pool=out#future-roles$/);
    await expect(page.locator("#future-roles")).toBeInViewport();
    await expect(page.locator("#future-roles").getByRole("status")).toHaveText("Saved.");
    await expect(page.getByText(/you asked us not to keep your details for future roles/)).toBeVisible();
    await expectAccessible(page, "status page after opting out of future roles");
    await page.getByRole("button", { name: "Keep me for future roles again" }).click();
    await page.waitForURL(/\?pool=in#future-roles$/);
    await expect(page.getByRole("button", { name: "Don't keep me for future roles" })).toBeVisible();

    // the owner approves an interview through the API; the candidate picks a time on the phone
    const applications = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}/applications`)).json()) as Array<{ id: string; source: string }>;
    expect(applications.length).toBe(1);
    // the application is credited to the board whose link was followed, and the link counted the visit
    expect(applications[0].source).toBe(SOURCE_OF_CHANNEL[board.channel]);
    expect((await boardLink(page.request, baseURL!, seeded.roleId, board.channel)).visits).toBeGreaterThan(board.visits);
    const approved = await page.request.post(`${baseURL}/api/v1/applications/${applications[0].id}/interviews`, { data: { roundKey: seeded.firstRound, interviewerUserIds: [seeded.ownerId], linkSource: "calendar" } });
    expect(approved.status(), await approved.text()).toBe(201);
    await page.goto(statusPath);
    const chooseTime = page.getByRole("link", { name: "Choose a time" });
    await expect(chooseTime).toBeVisible({ timeout: 60_000 });
    await chooseTime.click();
    await expect(page.getByRole("heading", { name: /Pick a time/ })).toBeVisible();
    await expectAccessible(page, "schedule page");
    await noHorizontalOverflow(page, "schedule page");
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: "Confirm this time" }).click();
    await expect(page.getByRole("heading", { name: /confirmed|Booking your time/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible({ timeout: 60_000 });
    await expectAccessible(page, "schedule confirmed");
    await noHorizontalOverflow(page, "schedule confirmed");

    // back on the status page the booked interview says what to prepare
    await page.goto(statusPath);
    // the status card's label, not the confirmation message further down that also mentions it
    await expect(page.getByText("What to prepare:", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText("Interview");
    await expectAccessible(page, "status page with a booked interview");

    // she cancels from the phone, by keyboard, choosing what she would like next (founder decision 2A); the page after it
    // says what happens next, and a refresh never cancels twice (it is a page of its own)
    await page.getByRole("link", { name: "Details, calendar file, reschedule or cancel" }).click();
    await expect(page.getByRole("heading", { name: /You.re confirmed/ })).toBeVisible();
    await page.getByText("I need to cancel", { exact: true }).click();
    await expect(page.getByRole("group", { name: "If you cancel, what would you like next?" })).toBeVisible();
    const newTimes = page.getByRole("radio", { name: "Send me new times later" });
    await newTimes.focus();
    await page.keyboard.press("Space");
    await expect(newTimes).toBeChecked();
    await page.getByRole("checkbox", { name: "Yes, cancel this interview." }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Cancel the interview" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/c\/schedule\/[A-Za-z0-9_-]+\/cancelled$/);
    await expect(page.getByRole("heading", { level: 1, name: "Your interview is cancelled" })).toBeVisible();
    await expect(page.getByText(/We will email you new times on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, unless the team gets in touch first\.|Someone from the team will be in touch about them\./)).toBeVisible();
    await expectAccessible(page, "interview cancelled");
    await noHorizontalOverflow(page, "interview cancelled");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Your interview is cancelled" })).toBeVisible();
  });

  // Wave S7 (spec steps 2 to 4): choosing the résumé reads it at once (the worker checks it, scans it and reads it), and
  // the same form comes back as "Check your details", every filled value marked for checking, on a phone.
  test("the résumé first: choosing it reads it, and the form comes back as Check your details with each filled value marked", async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    await signIn(page, { email: `owner+cv${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Resume ${run}`);
    const companyId = ((await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json()) as { id: string }).id;
    await useOneVisitFlow(browser, baseURL!, companyId);
    const seeded = await seedOpenRole(page.request, baseURL!);
    await page.goto(`/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`);
    await expect(page.getByRole("heading", { name: "Start with your resume" })).toBeVisible();
    await page.locator('input[name="resume"]').setInputFiles({ name: "maria-reyes.txt", mimeType: "text/plain", buffer: Buffer.from(`Maria Reyes\nmaria.reyes.cv+${run}@example.com\n(949) 555-0123\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nActive CA RDH license 554433\nBLS certified\nDentrix, periodontal charting\n`) });
    await expect(page.getByRole("heading", { name: "Check your details" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/We read maria-reyes\.txt and filled in your details below\./)).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveValue("Maria");
    await expect(page.getByLabel("Last name")).toHaveValue("Reyes");
    await expect(page.getByText("From your resume — check it").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Your application" }).locator('[aria-current="step"]')).toHaveText("Details");
    await expectAccessible(page, "check your details");
    await noHorizontalOverflow(page, "check your details");
  });
});
