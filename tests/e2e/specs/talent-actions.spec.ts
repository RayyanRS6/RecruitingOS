import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The candidate sheet's choices in a real browser (plan items 0.5 and 0.6; founder decision B6): every toast says
 * exactly whether the candidate was told, the decline step says before the click what the candidate will get, and
 * "Decline now" on an eligibility hold asks for the same confirmation instead of declining on the first click.
 * Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);

test.describe("the candidate sheet's choices", () => {
  skipWithoutFakeSignIn();
  test("hold, decline with its confirm step, and the eligibility 'Decline now' confirmation", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@talentactions.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Talent Actions Dental ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // a second applicant answers "no" to the licence question and is held for the owner
    const role = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string; type: string }> } } } };
    const rules = role.currentPacket.packet.requirements.eligibility;
    const license = rules.find((r) => r.type === "license") ?? rules[0];
    const multipart: Record<string, string> = { firstName: "Ana", lastName: "Holt", email: `ana.holt+${run}@example.com`, noResume: "Three years as a dental assistant; studying for my hygiene license.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const rule of rules) multipart[`elig_${rule.key}`] = rule.key === license.key ? "no" : "yes";
    expect((await page.request.post(`${baseURL}/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`, { multipart, maxRedirects: 0 })).status()).toBe(302);

    // Hold: saved, and the toast says the candidate was not told
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const maria = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(maria).toBeVisible();
    await maria.getByRole("button", { name: "Hold", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. The candidate was not told." })).toBeVisible();

    // Decline: the confirm step says what the candidate gets before anything happens
    await maria.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(maria.getByText(/Declining is your decision and is recorded with your reason\. The candidate gets a short, courteous email\./)).toBeVisible();
    await expectAccessible(page, "candidate sheet with the decline confirm step");
    await maria.getByRole("button", { name: "Confirm decline" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Declined. A short, courteous message to the candidate is on its way." })).toBeVisible();
    await page.keyboard.press("Escape");

    // "Decline now" on the eligibility hold opens the same confirmation; nothing happens on the first click
    await expect(page.getByRole("button", { name: "Ana Holt" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Ana Holt" }).click();
    const ana = page.getByRole("dialog", { name: "Ana Holt" });
    await expect(ana.getByRole("heading", { name: "Held on an eligibility answer" })).toBeVisible({ timeout: 30_000 });
    await expect(ana.getByText(/Policy: send a courteous message/)).toHaveCount(0);
    await ana.getByRole("button", { name: "Decline now" }).click();
    await expect(ana.getByText(/their answers did not show/)).toBeVisible();
    await expect(ana.getByText("Doesn't meet eligibility").first()).toBeVisible();
    await expectAccessible(page, "candidate sheet with the eligibility decline confirm step");
    await ana.getByRole("button", { name: "Confirm decline" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Declined\. A short, courteous message to the candidate is on its way\.$/ })).toBeVisible();
    await expect(ana.getByRole("heading", { name: "Declined on an eligibility answer" })).toBeVisible({ timeout: 30_000 });
  });
});
