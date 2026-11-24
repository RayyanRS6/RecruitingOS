import { expect, test, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Dropdowns you can read. In dark mode on Windows the open list of a native select showed near-white words on a light
 * list unless the options themselves are coloured. Both stylesheets (the kit's, packages/ui/src/styles.css, and the
 * candidate pages' own sheet) colour the options with the theme's surface and ink, so the list reads whichever colour
 * the system paints it. Checked here by the computed style of every option on the page, in dark mode, on the
 * application's pages and on a candidate page. The arrow is the kit's own (owner, 24 November 2026: the native one
 * touched the control's edge): drawn on the select with room on its right, never left bare.
 */
test.use({ colorScheme: "dark" });

type Reading = { dark: boolean; ink: string; surface: string; selects: number; wrong: string[] };

/** Every select on the page: each option drawn in the theme's ink on its surface, and its drawn arrow given room on the right. */
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
      const look = getComputedStyle(s);
      // the browser's own arrow is gone (appearance none, or the customisable select), so ours must be there, clear of the words
      if (look.appearance !== "auto" && (look.backgroundImage === "none" || Number.parseFloat(look.paddingRight) < 40)) wrong.push(`${label}: no drawn arrow with room on its right`);
      if (look.appearance === "auto" || look.appearance === "menulist") wrong.push(`${label}: the native arrow, which touches the edge`);
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

  test("the company form and Settings: every option reads, and each dropdown's arrow is drawn with room", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, { email: `dropdowns+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });

    // the company form: what kind of business, how many employees, the time zone
    await page.waitForURL("**/setup/company");
    await expect(page.getByLabel("Time zone")).toBeVisible({ timeout: 30_000 });
    expectReadable(await readSelects(page), "the company form", 3);
    await createCompanyThroughTheForm(page, `Brightline Dropdowns ${run}`);

    // Settings: the role of an invitation, and the company's time zone and size once its details are being changed
    await page.goto("/setup");
    await expect(page.locator("#setup-team").getByLabel("Role", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator("#setup-company").getByRole("button", { name: "Edit", exact: true }).first().click();
    await expect(page.locator("#setup-company").getByLabel("Time zone")).toBeVisible();
    expectReadable(await readSelects(page), "Settings", 3);
  });
});
