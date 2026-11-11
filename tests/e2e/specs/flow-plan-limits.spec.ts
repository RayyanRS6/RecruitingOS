import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, liveJobThroughTheApi, signIn, skipWithoutFakeSignIn, usePlan } from "./helpers";

/**
 * A plan with no room for another job, in a real browser (the plans of 5 November 2026; the dead ends' rank 13). On Free,
 * one job ever: the job builder says so before anyone types, with Upgrade, and lists no jobs, since closing one would not
 * help. On Basic, three places: when one is held by a job still waiting for approval, the builder names it with a link,
 * its page has Close in More (it used to have none), closing gives the place back, and a new job can be started at once.
 * The jobs are drafted through the API: the plan's room is the subject here, not the builder.
 */
const run = Date.now().toString(36);

test.describe("a plan with no room for another job", () => {
  skipWithoutFakeSignIn();

  test("Free's one job: the builder says so before anyone types, with Upgrade and no list of jobs", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const base = baseURL!;
    await signIn(page, { email: `owner+${run}a@roomless.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Roomless Dental ${run}`);
    await liveJobThroughTheApi(page.request, base);
    await page.goto("/roles/new?new=1");
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    const room = page.locator(".alert").filter({ has: page.getByRole("button", { name: "Upgrade" }) });
    await expect(room).toBeVisible({ timeout: 30_000 });
    await expect(room.getByRole("listitem")).toHaveCount(0);
    await expectAccessible(page, "the job builder with no room on Free");
    // Upgrade asks ITS, in the one upgrade sheet, and charges nothing
    await room.getByRole("button", { name: "Upgrade" }).click();
    const sheet = page.getByRole("dialog", { name: "Upgrade" });
    await expect(sheet.getByText("No card is charged. ITS will contact you, and nothing changes until then.")).toBeVisible({ timeout: 30_000 });
  });

  test("Basic's three places, one held by a job waiting for approval: its page has Close, closing gives the place back, and a new job starts", async ({ page, browser, baseURL }) => {
    test.setTimeout(360_000);
    const base = baseURL!;
    await signIn(page, { email: `owner+${run}b@threeplaces.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Three Places Dental ${run}`);
    const company = (await (await page.request.get(`${base}/api/v1/companies/current`)).json()) as { id: string };
    await usePlan(browser, base, company.id, "basic");
    await liveJobThroughTheApi(page.request, base, "I need a dental assistant in Tustin, $24 to $28 an hour, full time. It's growth. Ceiling $29. I decide. Must-haves: X-ray certification. Just draft it.");
    await liveJobThroughTheApi(page.request, base, "I need a front desk coordinator in Tustin, $22 to $26 an hour, full time. It's a replacement. Ceiling $27. I decide. Must-haves: Dentrix. Just draft it.");
    // the third: drafted and waiting for approval
    const s = (await (await page.request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json()) as { session: { id: string } };
    const made = await page.request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(made.ok(), await made.text()).toBeTruthy();
    const { roleId: waitingId } = (await made.json()) as { roleId: string };

    // the builder names the three, the waiting one saying so, each a link to it
    await page.goto("/roles/new?new=1");
    const room = page.locator(".alert").filter({ has: page.getByRole("listitem") });
    await expect(room).toBeVisible({ timeout: 30_000 });
    await expect(room.getByRole("listitem")).toHaveCount(3);
    const waiting = room.getByRole("listitem").filter({ hasText: "(waiting for approval)" });
    await expect(waiting).toHaveCount(1);
    await waiting.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/roles/${waitingId}$`));

    // its page: More has Close, which opens on Cancelled for a job never live
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Close the job" }).click();
    const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Close this job" }) });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByLabel("Outcome")).toHaveValue("role_cancelled");
    await expectAccessible(page, "closing a job waiting for approval");
    await card.getByRole("button", { name: "Confirm and close the job" }).click();
    await expect(page.getByRole("status").filter({ hasText: /closed/i }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".pill", { hasText: /^Closed$/ }).first()).toBeVisible({ timeout: 30_000 });

    // the place is back: the builder takes a new job at once
    await page.goto("/roles/new?new=1");
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".alert").filter({ has: page.getByRole("listitem") })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Describe the role, or paste a job ad" }).fill("I need a sterilization technician in Tustin, $20 an hour.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });
  });
});
