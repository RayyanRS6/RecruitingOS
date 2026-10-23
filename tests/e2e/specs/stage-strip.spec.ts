import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn, useOneVisitFlow } from "./helpers";

async function noHorizontalOverflow(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on this viewport`).toBeLessThanOrEqual(innerWidth + 1);
}

/**
 * The Candidates page's stage strip and the candidate panel in a real browser (Wave A; founder decision B3): the strip
 * counts everyone at each stage and filters by a click; a row's stage button moves someone to the shortlist in one
 * click, privately, and the candidate's own status page never shows it; the panel keeps its place in the address,
 * steps to the next and previous person, and never throws away text that was not sent. Everything is synthetic.
 */
const run = Date.now().toString(36);

test.describe("the stage strip and the candidate panel", () => {
  skipWithoutFakeSignIn();
  test("strip counts, a private shortlist from the row, the panel's address, next and previous, and the unsent-text guard", async ({ page, browser, baseURL }) => {
    test.setTimeout(240_000);
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@strip.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Strip Dental ${run}`);
    // every applicant gets the AI interview, so the applicants below are under "No AI interview yet" (R20-7)
    const companyId = ((await (await page.request.get(`${baseURL}/api/v1/companies/current`)).json()) as { id: string }).id;
    await useOneVisitFlow(browser, baseURL!, companyId);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");
    // a second applicant to the same role, answering every eligibility question "yes"
    const role = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const multipart: Record<string, string> = { firstName: "Luis", lastName: "Ortega", email: `luis.ortega+${run}@example.com`, noResume: "Five years as a registered dental hygienist in Irvine.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" };
    for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
    expect((await page.request.post(`${baseURL}/careers/${seeded.slug}/jobs/${seeded.roleId}/apply`, { multipart, maxRedirects: 0 })).status()).toBe(302);

    // The page: the job, its status and how many applied; the strip counts everyone
    await page.goto(`/roles/${seeded.roleId}/talent`);
    // the job's title heads the page (no "Job · company" eyebrow above it since the fewer-words cut of 23 Oct 2026)
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hygienist/i, { timeout: 30_000 });
    // how many applied: the count on the job's Candidates tab (Wave S1: the header's line is the job's facts)
    await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 2$/ })).toBeVisible({ timeout: 30_000 });
    const strip = page.getByRole("tablist", { name: "Stages" });
    await strip.getByRole("tab", { name: /^All/ }).click();
    await expect(strip.getByRole("tab", { name: /^All 2$/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Maria Reyes" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Luis Ortega" })).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, "talent with the stage strip");

    // Both were invited to the AI interview and have not sent it (R20-7): they sit in the strip's first column, "No AI
    // interview yet", with its chips and one calm line, and never as waiting on you
    await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: /^Candidates 2$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Waiting on you/ })).toHaveCount(0);
    await strip.getByRole("tab", { name: /^No AI interview yet 2$/ }).click();
    await expect(page.locator(".talent-row")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /^Not started \d$/ })).toBeVisible();
    await expect(page.getByText(/Nothing here waits on you/)).toBeVisible();
    await expectAccessible(page, "talent showing the column No AI interview yet");
    await strip.getByRole("tab", { name: /^All/ }).click();

    // Shortlist from the row: one click, private
    await page.getByRole("button", { name: /^Stage: .+\. Move to another stage$/ }).first().click();
    await expect(page.getByRole("menuitemradio", { name: /^Offer/ })).toHaveAttribute("aria-disabled", "true");
    await expectAccessible(page, "the stage button's menu");
    await page.getByRole("menuitemradio", { name: /^Shortlist/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /Moved to Shortlist\..*Private: the candidate was not told\./ })).toBeVisible();
    await expect(strip.getByRole("tab", { name: /^Shortlist 1$/ })).toBeVisible({ timeout: 30_000 });
    await strip.getByRole("tab", { name: /^Shortlist/ }).click();
    await expect(page.locator(".talent-row")).toHaveCount(1);
    const shortlisted = (await page.locator(".talent-row .talent-name").first().textContent()) ?? "";
    await strip.getByRole("tab", { name: /^All/ }).click();

    // Search narrows the list; clearing it brings everyone back
    await page.getByRole("searchbox", { name: "Search candidates" }).fill("ortega");
    await expect(page.locator(".talent-row")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search candidates" }).fill("");
    await expect(page.locator(".talent-row")).toHaveCount(2);

    // The candidate never sees the team's marks on their status page
    if (shortlisted === "Maria Reyes") {
      await page.goto(seeded.statusPath);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("body")).not.toContainText(/shortlist/i);
      await page.goto(`/roles/${seeded.roleId}/talent`);
      await strip.getByRole("tab", { name: /^All/ }).click();
    }

    // The panel: next and previous through the list, with where you are
    await page.getByRole("button", { name: "Maria Reyes" }).click();
    let panel = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/open=/);
    await expect(panel.getByText(/^[12] of 2$/)).toBeVisible();
    await expectAccessible(page, "candidate panel");
    const next = panel.getByRole("button", { name: /Next candidate/ });
    const goingDown = await next.isEnabled();
    await (goingDown ? next : panel.getByRole("button", { name: /Previous candidate/ })).click();
    panel = page.getByRole("dialog", { name: "Luis Ortega" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press(goingDown ? "Alt+ArrowUp" : "Alt+ArrowDown");
    panel = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Text that was not sent is never thrown away without asking
    await panel.getByRole("button", { name: "Email", exact: true }).click();
    await expect(panel.getByRole("tab", { name: /^Messages/ })).toHaveAttribute("aria-selected", "true");
    await panel.getByRole("textbox", { name: "Message" }).fill("Hi Maria, are you free on Thursday?");
    await page.keyboard.press("Escape");
    await expect(panel.getByText("You have text here that is not sent or saved. Leave it?")).toBeVisible();
    await panel.getByRole("button", { name: "Keep writing" }).click();
    await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Hi Maria, are you free on Thursday?");
    // switching sections keeps it too
    await panel.getByRole("tab", { name: /^History/ }).click();
    await panel.getByRole("tab", { name: /^Messages/ }).click();
    await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Hi Maria, are you free on Thursday?");
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Discard it and go on" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/open=/);

    // The address opens the panel at a section
    const list = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}/applications`)).json()) as Array<{ id: string; candidate: { name: string } | null }>;
    const mariaId = list.find((a) => a.candidate?.name === "Maria Reyes")!.id;
    await page.goto(`/roles/${seeded.roleId}/talent?open=${mariaId}&tab=history`);
    panel = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(panel.getByRole("tab", { name: /^History/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(panel.getByRole("heading", { name: "What happened" })).toBeVisible();
    await expectAccessible(page, "candidate panel history from the address");
    await noHorizontalOverflow(page, "candidate panel");
  });
});
