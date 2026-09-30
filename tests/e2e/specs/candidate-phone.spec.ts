import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn } from "./helpers";

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
    await page.getByRole("link", { name: "Apply now" }).click();

    // the form: the transparency block and the privacy link are on the page; the acknowledgment starts unchecked
    await expect(page.getByRole("heading", { name: "Apply", exact: true })).toBeVisible();
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
    await page.getByLabel(/No resume\?/).fill("Registered Dental Hygienist at Coastal Family Dentistry since 2019. Active CA RDH license, Dentrix, periodontal charting.");
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

    // ticking the box sends it; the status page confirms without a login
    await page.getByRole("checkbox", { name: /I have read the notice above/ }).check();
    await page.getByRole("button", { name: "Send my application" }).click();
    await page.waitForURL(/\/c\/status\//);
    await expect(page.getByText(/Your application is in/)).toBeVisible();
    await expectAccessible(page, "status page");
    await noHorizontalOverflow(page, "status page");
    const statusPath = new URL(page.url()).pathname;

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
    const applications = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}/applications`)).json()) as Array<{ id: string }>;
    expect(applications.length).toBe(1);
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
    await expect(page.getByText(/What to prepare/)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "status page with a booked interview");
  });
});
