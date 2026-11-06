import { expect, test, type APIRequestContext } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, gotoSettled, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The plans of 5 November 2026 from end to end, in a real browser. A new company is on Free, whose job takes applications
 * without limit and shows the team the first five: the sixth is one locked card, with no name on the page or in what the page
 * reads. Upgrade asks ITS: the sheet compares the plans, charges nothing and opens nothing of the company's hiring. ITS sees
 * the request on the customer's row and changes the plan in the console, and the card opens. Everything is synthetic; every
 * provider is a fake.
 */
const run = Date.now().toString(36);
const COMPANY = `Free Dental ${run}`;
const FIRST_FIVE = ["Ana Alvarez", "Ben Brooks", "Cara Cole", "Dev Dutta", "Eve Ellis"];
const SIXTH = "Fay Foster";

/** A job the public can apply to, through the API with the owner's own session, as seedRoleAndApplicant starts one. */
async function publishedRole(request: APIRequestContext, base: string) {
  const s = await (await request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json() as { session: { id: string } };
  const { roleId } = await (await request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string };
  expect((await request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } })).ok()).toBeTruthy();
  const role = await (await request.get(`${base}/api/v1/roles/${roleId}`)).json() as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
  return { roleId, rules: role.currentPacket.packet.requirements.eligibility };
}

test.describe("a Free company past its five candidates", () => {
  skipWithoutFakeSignIn();
  test("six applicants: five to read and one locked card; Upgrade asks ITS; ITS changes the plan; the card opens", async ({ page, browser, baseURL }) => {
    test.setTimeout(300_000);
    await signIn(page, { email: `dana+${run}@plans.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, COMPANY);
    const company = await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json() as { slug: string; planKey: string };
    expect(company.planKey).toBe("free");

    // Six people apply, one after another: every one of them gets through; nothing on the careers page knows of a limit
    const { roleId, rules } = await publishedRole(page.request, baseURL!);
    for (const name of [...FIRST_FIVE, SIXTH]) {
      const [firstName, lastName] = name.split(" ");
      const multipart: Record<string, string> = { firstName, lastName, email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}+${run}@example.com`, noResume: "Five years as a registered dental hygienist in Irvine.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
      for (const rule of rules) multipart[`elig_${rule.key}`] = "yes";
      const applied = await page.request.post(`${baseURL}/careers/${company.slug}/jobs/${roleId}/apply`, { multipart, maxRedirects: 0 });
      expect(applied.status(), name).toBe(302);
    }

    // The team reads five, and one card says there is a sixth; the job's own tab counts everyone
    await page.goto(`/roles/${roleId}/talent`);
    await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 6$/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tablist", { name: "Stages" }).getByRole("tab", { name: /^All/ }).click();
    await expect(page.locator(".talent-row")).toHaveCount(5, { timeout: 30_000 });
    for (const name of FIRST_FIVE) await expect(page.getByRole("button", { name })).toBeVisible();
    const card = page.locator(".locked-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByText("Locked", { exact: true })).toBeVisible();
    await expect(card.getByText(/Upgrade to view more candidates\./)).toBeVisible();
    // no name, on the page or in what the page reads
    await expect(page.getByText(SIXTH)).toHaveCount(0);
    const read = await (await page.request.get(`${baseURL}/api/v1/roles/${roleId}/applications?counts=1`)).text();
    expect(read).not.toContain("Foster");
    await expectAccessible(page, "candidates with a locked card");

    // Upgrade: the plans side by side, the next one up chosen; a plain line that nothing is charged; nothing about access
    await card.getByRole("button", { name: "Upgrade" }).click();
    const sheet = page.getByRole("dialog", { name: "Upgrade" });
    await expect(sheet.getByText("Your plan")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    await expect(sheet.getByRole("radio", { name: /^Basic/ })).toBeChecked();
    await expect(sheet.getByText("No card is charged. ITS will contact you, and nothing changes until then.")).toBeVisible();
    await expect(sheet.getByText(/will see/)).toHaveCount(0);
    await sheet.getByRole("radio", { name: /^Pro/ }).check();
    await expectAccessible(page, "the upgrade sheet");
    await sheet.getByLabel("A note for ITS (optional)").fill("We hire more from next month.");
    await sheet.getByRole("button", { name: "Ask ITS to upgrade" }).click();
    await expect(sheet.getByText(/^ITS will respond by .+No card is charged, and nothing changes until then\./)).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();

    // Asking again says softly that ITS has it, and offers nothing more to press
    await card.getByRole("button", { name: "Upgrade" }).click();
    await expect(sheet.getByText("ITS has your request.")).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("button", { name: "Ask ITS to upgrade" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // ITS: the customer's row says it asked and how many are locked; the plan's price and limits; a reason, then a second press
    const staff = await browser.newContext();
    const admin = await staff.newPage();
    await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
    await gotoSettled(admin, "/admin/customers");
    const row = admin.getByRole("row", { name: new RegExp(COMPANY) });
    await expect(row.getByText("Asked to upgrade")).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText("1 locked")).toBeVisible();
    await row.getByRole("button", { name: `Open ${COMPANY}` }).click();
    const drawer = admin.getByRole("dialog", { name: COMPANY });
    await drawer.getByRole("tab", { name: "Plan" }).click();
    const pick = drawer.getByRole("combobox", { name: "Plan" });
    await expect(pick).toHaveValue("free", { timeout: 30_000 });
    await pick.selectOption("pro");
    await expect(drawer.getByText(/\$149 a month/)).toBeVisible();
    await drawer.getByLabel(/^Why/).fill("The customer asked for Pro.");
    await expectAccessible(admin, "change plan in the console");
    await drawer.getByRole("button", { name: "Change plan" }).click();
    await drawer.getByRole("button", { name: "Yes, change it" }).click();
    await expect(admin.getByRole("status").filter({ hasText: /1 locked candidate opens now\./ })).toBeVisible({ timeout: 30_000 });
    await staff.close();

    // The card opens: six to read, nobody locked, and the sixth has a name and a panel
    await page.goto(`/roles/${roleId}/talent`);
    await page.getByRole("tablist", { name: "Stages" }).getByRole("tab", { name: /^All/ }).click();
    await expect(page.locator(".talent-row")).toHaveCount(6, { timeout: 30_000 });
    await expect(page.locator(".locked-card")).toHaveCount(0);
    await page.getByRole("button", { name: SIXTH }).click();
    const panel = page.getByRole("dialog", { name: SIXTH });
    await expect(panel.getByRole("button", { name: /^Stage: / })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "the candidate who was locked");

    // ITS's answer reached the team: it closed their request, and Settings says the new plan
    await page.goto("/");
    const requests = page.getByRole("list", { name: "Your recruiter requests" });
    await expect(requests.getByText("Your plan", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(requests.getByText("Your company is on the Pro plan now.")).toBeVisible();
    await page.getByText(/^Recent activity/).click();
    await expect(page.getByText("Your plan is now Pro")).toBeVisible();
    await page.goto("/setup#setup-company");
    await expect(page.locator("#setup-company").getByText("Pro", { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
