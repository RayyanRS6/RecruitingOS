import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Closing a role in a real browser (founder decisions B6 and Q30; plan G4): the close card names who is still in
 * process before anything is closed; closing moves them to the talent pool privately; then one courteous closing
 * message, seen first, goes to all of them with a single Send, each with their own name. Everything is synthetic; every
 * provider is a fake.
 */
const run = Date.now().toString(36);

test.describe("closing a role", () => {
  skipWithoutFakeSignIn();
  test("the close card lists who is still in process, then one closing message tells them all with a single Send", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@closing.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Closing Dental ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // a second applicant on the same role
    const role = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const multipart: Record<string, string> = { firstName: "Luis", lastName: "Ortega", email: `luis.ortega+${run}@example.com`, noResume: "Five years as a hygienist in Tustin.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
    expect((await page.request.post(`${baseURL}/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`, { multipart, maxRedirects: 0 })).status()).toBe(302);

    // the close card names who is still in process; nothing is closed on the first click
    await page.goto(`/roles/${seeded.roleId}`);
    // closing sits in the job's More menu (Wave S1)
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Close the job" }).click();
    const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Close this job" }) });
    await expect(card).toBeVisible();
    const still = card.getByRole("list", { name: "Still in process" });
    await expect(still.getByText("Maria Reyes")).toBeVisible({ timeout: 30_000 });
    await expect(still.getByText("Luis Ortega")).toBeVisible();
    await expect(card.getByText(/These 2 people move to your talent pool, privately/)).toBeVisible();
    await expectAccessible(page, "role page with the close card");
    await card.getByLabel("Outcome").selectOption("no_hire");
    await card.getByRole("button", { name: "Confirm and close the job" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Role closed; the outcome is recorded with your name\..*nobody is told yet\. Send the closing message when you are ready\./ })).toBeVisible();

    // the one closing message: who gets it, the words once with each person's own name, and a single Send
    const closing = page.locator("section.card").filter({ has: page.getByRole("heading", { name: /^Tell the people .+ left in process$/ }) });
    await expect(closing).toBeVisible({ timeout: 30_000 });
    await expect(closing.getByRole("list", { name: "Who gets the closing message" }).getByText("Maria Reyes")).toBeVisible();
    await expect(closing.getByText("What each of them gets, with their own name")).toBeVisible();
    await expect(closing.getByText(/\[first name\]/).first()).toBeVisible();
    await expectAccessible(page, "role page with the closing message");
    await closing.getByRole("button", { name: "Send to 2 people" }).click();
    // each message waits out its Undo window (plan G9): "Undo all" is offered on the toast
    const sent = page.getByRole("status").filter({ hasText: /2 closing messages on their way\./ });
    await expect(sent).toBeVisible();
    await expect(sent.getByRole("button", { name: "Undo all" })).toBeVisible();
    await expect(closing).toHaveCount(0);

    // nobody is left untold: once the close card is put away, the closing message has nothing more to send
    await page.locator(".card", { has: page.getByRole("heading", { name: "2 closing messages on their way." }) }).getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "More for this job" }).click();
    await page.getByRole("menuitem", { name: "Send the closing message" }).click();
    await expect(page.getByText("Everyone the role left in your talent pool has been told already.")).toBeVisible({ timeout: 30_000 });
  });
});
