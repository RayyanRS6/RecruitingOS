import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Dropdowns you can read (Wave S6, 15 October 2026). In dark mode on Windows the open list of a native select showed the
 * near-white words on a light list. Both stylesheets (packages/ui/src/tokens.css and the candidate pages' sheet in
 * apps/api/src/pages/layout.tsx) now colour the options themselves with the theme's surface and ink, so the list reads
 * whichever colour the system paints it. Checked here by the computed style of every option on the page, in dark mode,
 * on the application's pages and on the candidate pages; the native arrow is left as it is.
 */
test.use({ colorScheme: "dark" });

type Reading = { dark: boolean; ink: string; surface: string; selects: number; wrong: string[] };

/** Every select on the page: each option drawn in the theme's ink on its surface, and no select's native arrow replaced. */
async function readSelects(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ink)";
    probe.style.backgroundColor = "var(--surface)";
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const selects = [...document.querySelectorAll("select")];
    const wrong: string[] = [];
    for (const s of selects) {
      const label = s.id || s.getAttribute("aria-label") || s.getAttribute("name") || "a select";
      if (getComputedStyle(s).appearance === "none") wrong.push(`${label}: its native arrow was replaced`);
      for (const o of [...s.options]) {
        const cs = getComputedStyle(o);
        if (cs.color !== ink || cs.backgroundColor !== surface) wrong.push(`${label} › ${o.text}: ${cs.color} on ${cs.backgroundColor}`);
      }
    }
    return { dark: matchMedia("(prefers-color-scheme: dark)").matches, ink, surface, selects: selects.length, wrong };
  });
}

/** The sum of an rgb() colour's three channels: low for the dark surface, high for the light ink. */
const brightness = (rgb: string) => (rgb.match(/\d+/g) ?? []).slice(0, 3).reduce((sum, n) => sum + Number(n), 0);

function expectReadable(reading: Reading, where: string, atLeast: number) {
  expect(reading.dark, `${where} is not in dark mode`).toBe(true);
  // the dark theme's tokens are in force: a near-black surface and near-white ink
  expect(brightness(reading.surface), `${where}: surface ${reading.surface}`).toBeLessThan(150);
  expect(brightness(reading.ink), `${where}: ink ${reading.ink}`).toBeGreaterThan(600);
  expect(reading.selects, `${where}: dropdowns on the page`).toBeGreaterThanOrEqual(atLeast);
  expect(reading.wrong, `${where}: options that would be hard to read`).toEqual([]);
}

test("a candidate page's dropdown reads in dark mode: the privacy request form's kind", async ({ page }) => {
  await page.goto("/c/privacy-request");
  await expect(page.locator("select#kind")).toBeVisible();
  expectReadable(await readSelects(page), "the privacy request form", 1);
});

test.describe("the application's dropdowns in dark mode", () => {
  skipWithoutFakeSignIn();
  const run = Date.now().toString(36);

  test("company form, Jobs and a job page preview: every option reads, the native arrow stays", async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    await signIn(page, { email: `dropdowns+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });

    // the company form: what kind of business, how many employees, the time zone (all three are .select)
    await page.waitForURL("**/setup/company");
    await expect(page.getByLabel("Time zone")).toBeVisible({ timeout: 30_000 });
    expectReadable(await readSelects(page), "the company form", 3);
    await createCompanyThroughTheForm(page, `Brightline Dropdowns ${run}`);

    // a job waiting for approval, drafted through the API with the browser's own session
    const s = (await (await page.request.post(`${baseURL}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json()) as { session: { id: string } };
    const { roleId } = (await (await page.request.post(`${baseURL}/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };

    // Jobs: the sort (a select today; once it is a menu, its current choice shows a tick)
    await page.goto("/roles");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jobs", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    expectReadable(await readSelects(page), "Jobs", 0);
    if (!(await page.getByRole("combobox", { name: "Sort jobs" }).count())) {
      const sort = page.getByRole("button", { name: /^Sort/ }).first();
      if (await sort.count()) {
        await sort.click();
        const current = page.locator('[role="menuitemradio"][aria-checked="true"]');
        await expect(current).toHaveCount(1);
        await expect(current.locator("svg")).toHaveCount(1);
        await page.keyboard.press("Escape");
      }
    }

    // the job page preview: the candidate pages' sheet, the apply form's yes/no questions
    await page.goto(`/api/v1/roles/${roleId}/preview?version=1`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    expectReadable(await readSelects(page), "the job page preview", 0);
  });
});
