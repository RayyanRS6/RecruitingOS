import { expect, test, type Page } from "@playwright/test";
import {
  HYGIENIST_JOB, PERSONAS, applyThroughTheForm, createCompanyThroughTheForm, emailsTo, expectAccessible, linkIn, liveJobThroughTheApi, sendTheAiInterview, signIn, skipWithoutFakeSignIn,
  waitForEmail, waitForTheAiInterview, type Applicant,
} from "./helpers";

/**
 * Reading, sorting and shortlisting, with the company's settings as they come (the owner, 6 November 2026: "why everyone
 * has the score of 100??? should it not rank the candidate according to their CV/resume against the Job description? we
 * should be able to sort the candidates no???"). Three hygienists apply through the job's own pages and take the AI
 * interview: one shows everything, one shows the license and only part of the rest, one says in her own words that she
 * holds no license. Nobody is moved by the assistant: all three wait in New, each with one notice that they finished. The
 * list opens on everyone, best first, with one word beside each number; the only control that says Sort sorts. A person
 * shortlists one and longlists another from their rows, privately: nobody is emailed and their own pages say nothing. The
 * board shows both as sorted. The stand-in AI proves the order, not the numbers a real model gives.
 */
const run = Date.now().toString(36);

const toast = (page: Page, words: RegExp) => page.getByRole("status").filter({ hasText: words });

test.describe("reading, sorting and shortlisting", () => {
  skipWithoutFakeSignIn();

  test("three AI interviews with the settings as they come: all in New, best first, one word each, a private shortlist and longlist", async ({ page, browser, baseURL }) => {
    test.setTimeout(900_000);
    const base = baseURL!;
    const company = `Pacific Smiles ${run}`;
    await signIn(page, { email: `owner+${run}@pacificsmiles.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);
    // the rule for who is suggested for an interview is as the company found it: nobody here pressed anything in Settings
    const job = await liveJobThroughTheApi(page.request, base, HYGIENIST_JOB);

    const people: Array<Applicant & { says: (typeof PERSONAS)[keyof typeof PERSONAS]["says"] }> = [
      { first: "Ana", last: "Holt", email: `ana.holt+${run}@example.com`, resume: PERSONAS.strong.resume, says: PERSONAS.strong.says },
      { first: "Ben", last: "Ortiz", email: `ben.ortiz+${run}@example.com`, resume: PERSONAS.possible.resume, says: PERSONAS.possible.says },
      { first: "Cleo", last: "Park", email: `cleo.park+${run}@example.com`, resume: PERSONAS.weak.resume, says: PERSONAS.weak.says },
    ];
    const applied = [];
    for (const who of people) applied.push(await applyThroughTheForm(browser, base, job.jobUrl, who));
    await Promise.all(applied.map((a) => waitForTheAiInterview(a.page)));
    for (const [i, who] of people.entries()) await sendTheAiInterview(applied[i].page, who.says);
    const statusOf: Record<string, string> = {};
    for (const who of people) statusOf[who.first] = linkIn(await waitForEmail(page.request, base, { to: who.email, subject: /^Thank you for applying/ }), "/c/status/");

    // ---- the list opens on everyone, best first, each with a number and one word ------------------------------------------
    await page.goto(`/roles/${job.roleId}/talent`);
    const rows = page.locator(".talent-row");
    await expect(async () => {
      await page.reload();
      await expect(rows).toHaveCount(3, { timeout: 5_000 });
      await expect(page.locator(".talent-row .score-slot .score")).toHaveCount(3, { timeout: 5_000 });
    }).toPass({ timeout: 180_000, intervals: [3_000] });
    await expect(rows.locator(".talent-name")).toHaveText(["Ana Holt", "Ben Ortiz", "Cleo Park"]);
    const scores = await rows.locator(".score-slot .score").allTextContents();
    const numbers = scores.map((s) => Number(s.match(/\d+/)?.[0] ?? "-1"));
    expect(numbers[0], `scores ${scores.join(", ")}`).toBeGreaterThan(numbers[1]);
    expect(numbers[1], `scores ${scores.join(", ")}`).toBeGreaterThan(numbers[2]);
    // not everyone reads 100 any more, and a missing must-have holds the number down
    expect(numbers[2]).toBeLessThan(55);
    await expect(rows.nth(0)).toContainText("Strong match");
    await expect(rows.nth(2)).toContainText("Missing a must-have");
    // one verdict word beside each number: never two
    for (const [i, word] of [[0, "Strong match"], [2, "Missing a must-have"]] as const) {
      const text = (await rows.nth(i).textContent()) ?? "";
      for (const other of ["Strong match", "Potential match", "Missing a must-have", "Not enough evidence"].filter((w) => w !== word)) expect(text, `row ${i + 1}`).not.toContain(other);
    }
    const strip = page.getByRole("tablist", { name: "Stages" });
    await expect(strip.getByRole("tab", { name: /^New 3$/ })).toBeVisible();
    await expect(strip.getByRole("tab", { name: /^Interviewing [1-9]/ })).toHaveCount(0);
    // the only control that says Sort sorts: no "Sort the pool" button, and the order is Score
    await expect(page.getByRole("button", { name: "Sort the pool" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sort: Score" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Waiting on you/, pressed: false })).toBeVisible();
    await expectAccessible(page, "the list, best first");

    // Waiting on you filters, and does not change the order; off again, everyone is back
    await page.getByRole("button", { name: /^Waiting on you/ }).click();
    await expect(page.getByRole("button", { name: /^Waiting on you/, pressed: true })).toBeVisible();
    await expect(rows.locator(".talent-name").first()).toHaveText("Ana Holt");
    await page.getByRole("button", { name: /^Waiting on you/ }).click();
    await expect(rows).toHaveCount(3);

    // each of them finished, and the owner heard once about each
    await page.goto("/updates");
    for (const who of people) {
      const notice = page.getByRole("listitem").filter({ hasText: `${who.first} ${who.last} finished the AI interview` });
      await expect(notice).toHaveCount(1, { timeout: 30_000 });
      await expect(notice.getByRole("link", { name: "Review" })).toBeVisible();
    }
    // Home counts the strong one as ready (the day's line, under Recent activity)
    await page.goto("/");
    await page.getByText(/^Recent activity/).first().click();
    await expect(page.getByText(/ · 1 strong candidate ready · /)).toBeVisible({ timeout: 30_000 });

    // ---- a private shortlist and longlist from the rows ------------------------------------------------------------------
    await page.goto(`/roles/${job.roleId}/talent`);
    for (const [name, mark] of [["Ana Holt", "Shortlist"], ["Ben Ortiz", "Longlist"]] as const) {
      await page.locator(".talent-row").filter({ hasText: name }).getByRole("button", { name: /^Stage: .+\. Move to another stage$/ }).click();
      await page.getByRole("menuitemradio", { name: new RegExp(`^${mark}`) }).click();
      await expect(toast(page, new RegExp(`Moved to ${mark}\\..*Private: the candidate was not told\\.`))).toBeVisible({ timeout: 30_000 });
    }
    await expect(strip.getByRole("tab", { name: /^Shortlist 1$/ })).toBeVisible({ timeout: 30_000 });
    await expect(strip.getByRole("tab", { name: /^Longlist 1$/ })).toBeVisible();
    await expect(strip.getByRole("tab", { name: /^New 1$/ })).toBeVisible();

    // the board shows both as sorted, and Cleo still to sort, with her reason
    await page.getByRole("region", { name: "Board or list" }).getByRole("button", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(/view=board/);
    await expect(page.getByText(/^To sort: .* · 2 already sorted or decided/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".board-card").filter({ hasText: "Ana Holt" }).getByText("Done", { exact: true })).toBeVisible();
    await expect(page.locator(".board-card").filter({ hasText: "Ben Ortiz" }).getByText("Done", { exact: true })).toBeVisible();
    await expect(page.locator(".board-card").filter({ hasText: "Cleo Park" }).locator(".chip.critical")).toHaveText(/^Missing must-have: /);
    await expectAccessible(page, "the board after sorting by hand");

    // nobody was emailed about any of it, and their own pages say nothing about a shortlist or a longlist
    for (const who of people) expect((await emailsTo(page.request, base, who.email)).map((m) => m.subject)).toEqual([`Thank you for applying: your next step for ${job.title} at ${company}`]);
    for (const who of people) {
      await applied[0].page.goto(statusOf[who.first]);
      await expect(applied[0].page.getByText("Thanks for completing the AI interview. The team is reviewing your answers.")).toBeVisible({ timeout: 30_000 });
      await expect(applied[0].page.locator("body")).not.toContainText(/shortlist|longlist|not moving forward/i);
    }
    for (const a of applied) await a.context.close();
  });
});
