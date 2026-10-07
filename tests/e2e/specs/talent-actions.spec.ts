import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The candidate panel's choices in a real browser (plan items 0.5, 0.6, A4 and A9; founder decisions B3 and B6): a hold
 * from the stage button asks for the day it ends and is private; Not moving forward is private, says before the click
 * that nothing is sent, and the candidate hears only when someone presses Send on the decision message, after seeing
 * it; "Decline now" on an eligibility hold asks for the same confirmation. Everything is synthetic; every provider is a fake.
 */
const run = Date.now().toString(36);

test.describe("the candidate panel's choices", () => {
  skipWithoutFakeSignIn();
  test("hold with a date, a private decline, the decision message sent after a preview, and the eligibility 'Decline now'", async ({ page, baseURL }) => {
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

    // On hold: the stage button opens the hold step, which asks for the day they come back; the toast says it was private
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    const maria = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(maria).toBeVisible();
    await maria.getByRole("button", { name: /^Stage: / }).click();
    await maria.getByRole("menuitemradio", { name: /^On hold/ }).click();
    await expect(maria.getByRole("heading", { name: "Put on hold" })).toBeVisible();
    await expect(maria.getByLabel("Bring them back on")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await maria.getByLabel(/^Note/).first().fill("Waiting to hear about the second chair");
    await maria.getByRole("button", { name: "Put on hold" }).click();
    await expect(page.getByRole("status").filter({ hasText: /On hold until .+The candidate was not told\./ })).toBeVisible();
    await expect(maria.getByRole("button", { name: /^Stage: On hold/ })).toBeVisible({ timeout: 30_000 });

    // Not moving forward: the step says nothing is sent now, before anything happens
    await maria.getByRole("button", { name: /^Stage: / }).click();
    await maria.getByRole("menuitemradio", { name: /^Not moving forward/ }).click();
    await expect(maria.getByRole("heading", { name: "Not moving forward" })).toBeVisible();
    await expect(maria.getByText(/It is private: nothing is sent to the candidate now\./)).toBeVisible();
    await expectAccessible(page, "candidate panel with the private decline step");
    await maria.getByRole("button", { name: "Confirm: not moving forward" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Moved to Not moving forward\..*Private: the candidate was not told\./ })).toBeVisible();

    // Telling them is a separate act: the exact message first, then Send
    await expect(maria.getByRole("heading", { name: "Maria has not been told yet" })).toBeVisible({ timeout: 30_000 });
    await maria.getByRole("button", { name: "Send message" }).click();
    await expect(maria.getByText(/Your application to/)).toBeVisible({ timeout: 30_000 });
    await expect(maria.getByText(/It goes as soon as you press Send\./)).toBeVisible();
    await expectAccessible(page, "candidate panel with the decision message preview");
    await maria.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Decision message sent\./ })).toBeVisible();
    await expect(maria.getByRole("heading", { name: "Maria has not been told yet" })).toHaveCount(0, { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(page).not.toHaveURL(/open=/);

    // "Decline now" on the eligibility hold opens the same confirmation; nothing happens on the first click
    await expect(page.getByRole("button", { name: "Ana Holt" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Check eligibility").first()).toBeVisible();
    await page.getByRole("button", { name: "Ana Holt" }).click();
    const ana = page.getByRole("dialog", { name: "Ana Holt" });
    await expect(ana.getByRole("heading", { name: "Held on an eligibility answer" })).toBeVisible({ timeout: 30_000 });
    await expect(ana.getByText(/Policy: send a courteous message/)).toHaveCount(0);
    // one decline path for an eligibility hold (plan A2): the stage button's Not moving forward points to this card
    await ana.getByRole("button", { name: /^Stage: / }).click();
    await expect(ana.getByRole("menuitemradio", { name: /^Not moving forward/ })).toHaveAttribute("aria-disabled", "true");
    await ana.getByRole("button", { name: /^Stage: / }).click();
    await ana.getByRole("button", { name: "Decline now" }).click();
    await expect(ana.getByText(/their answers did not show/)).toBeVisible();
    await expectAccessible(page, "candidate panel with the eligibility decline confirm step");
    await ana.getByRole("button", { name: "Confirm decline" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Moved to Not moving forward\./ })).toBeVisible();
    await expect(ana.getByRole("heading", { name: "Declined on an eligibility answer" })).toBeVisible({ timeout: 30_000 });
    await expect(ana.getByRole("heading", { name: "Ana has not been told yet" })).toBeVisible();
  });

  test("'Stop this screen' takes back a screening invitation the candidate has not started, after a confirmation (plan A7)", async ({ page, baseURL }) => {
    await page.goto("/login");
    await signIn(page, { email: `dana+stop${run}@talentactions.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Stop Screen Dental ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Sofia", "Lind");
    await page.goto(`/roles/${seeded.roleId}/talent`);
    await page.getByRole("tab", { name: /^All/ }).click();
    await expect(page.getByRole("button", { name: "Sofia Lind" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Sofia Lind" }).click();
    const sofia = page.getByRole("dialog", { name: "Sofia Lind" });
    await sofia.getByRole("tab", { name: "Screen" }).click();
    await expect(sofia.getByRole("button", { name: "Stop this screen" })).toBeVisible({ timeout: 30_000 });
    await sofia.getByRole("button", { name: "Stop this screen" }).click();
    // nothing happens on the first click: the confirmation says what the candidate gets
    await expect(sofia.getByText(/they get a short, polite note saying the screen is no longer needed/)).toBeVisible();
    await expectAccessible(page, "candidate panel with the stop-screen confirmation");
    await sofia.getByRole("button", { name: "Yes, stop it" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Screen invitation stopped\./ })).toBeVisible();
    await expect(sofia.getByRole("button", { name: "Stop this screen" })).toHaveCount(0, { timeout: 30_000 });
  });
});
