import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn, statusPathFromEmail } from "./helpers";

/**
 * The candidate's own journey on a phone (docs/spec/20 items 2 and 3; docs/readiness/20 section D): the job page, the
 * application form with its transparency block and the affirmative acknowledgment, the screening conversation and the
 * scheduling page, every one rendered on the phone project, checked with axe and for sideways scrolling. The owner's
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
  test("job page, application with the acknowledgment, screening conversation and scheduling, all accessible on a phone", async ({ page, baseURL }) => {
    test.setTimeout(300_000);
    await signIn(page, { email: `owner+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Phone ${run}`);
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
    await expect(page.getByText("$45–$55 an hour").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Before you send" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Read how we handle your information" })).toHaveAttribute("href", "/privacy");
    const acknowledgment = page.getByRole("checkbox", { name: /I have read the notice above/ });
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
    await expect(page.getByRole("checkbox", { name: /I have read the notice above/ })).toHaveAttribute("aria-invalid", "true");
    for (const rule of seeded.eligibility) {
      const field = page.locator(`[name="elig_${rule.key}"]`).first();
      if ((await field.evaluate((el) => el.tagName)) === "SELECT") await expect(field).toHaveValue("yes");
    }
    await expectAccessible(page, "apply form with the acknowledgment missing");

    // ticking the box sends it; the receipt says to check email, with the address masked, and never shows the status link
    await page.getByRole("checkbox", { name: /I have read the notice above/ }).check();
    await page.getByRole("button", { name: "Send my application" }).click();
    await page.waitForURL(new RegExp(`/careers/${seeded.slug}/jobs/${seeded.roleId}/applied$`));
    await expect(page.getByRole("heading", { level: 1, name: "Thanks for applying" })).toBeVisible();
    await expect(page.getByText("m***@example.com")).toBeVisible();
    // the same words stay true for someone who applied before (their reminder goes at most once a day)
    await expect(page.getByText(/look in our earlier emails too/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Send my link again" })).toHaveAttribute("href", "/c/link-request");
    await expectAccessible(page, "receipt");
    await noHorizontalOverflow(page, "receipt");
    // "Lost your link?" is reachable from the receipt and accessible on a phone
    await page.getByRole("link", { name: "Send my link again" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Lost your link?" })).toBeVisible();
    await expectAccessible(page, "lost your link");
    await noHorizontalOverflow(page, "lost your link");

    // the status page opens from the emailed link, without a login
    const statusPath = await statusPathFromEmail(page.request, baseURL!, seeded.roleId, email);
    await page.goto(statusPath);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // the candidate's own steps (plan A1), the current one marked; the team's stage names and private marks never show
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveCount(1);
    await expect(page.locator('ol.track [aria-current="step"]')).toHaveText(/^(Received|Under review)$/);
    await expect(page.getByText(/who is interviewed, hired or turned down is always a person's decision/)).toBeVisible();
    await expectAccessible(page, "status page");
    await noHorizontalOverflow(page, "status page");
    // withdrawing is an outlined secondary button here too, not the near-black main action
    await expect(page.getByRole("button", { name: "Withdraw my application" })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    // "Future roles" is one click either way, and the page says which way it stands (Wave 0 item 0.11)
    await page.getByRole("button", { name: "Don't keep me for future roles" }).click();
    await expect(page.getByText(/you asked us not to keep your details for future roles/)).toBeVisible();
    await expectAccessible(page, "status page after opting out of future roles");
    await page.getByRole("button", { name: "Keep me for future roles again" }).click();
    await expect(page.getByRole("button", { name: "Don't keep me for future roles" })).toBeVisible();

    // the screening conversation (policy: invited automatically after triage), one question at a time
    await page.goto(statusPath);
    const startScreen = page.getByRole("link", { name: /screening conversation/ });
    await expect(startScreen).toBeVisible({ timeout: 60_000 });
    await startScreen.click();
    await expect(page.getByRole("heading", { name: /A few questions/ })).toBeVisible();
    await expectAccessible(page, "screen page");
    await noHorizontalOverflow(page, "screen page");
    await page.getByLabel("Your answer").fill("I have been a hygienist for six years and hold an active California RDH license.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(/1 of \d+ answered/)).toBeVisible();
    await expectAccessible(page, "screen page after an answer");

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
  });
});
