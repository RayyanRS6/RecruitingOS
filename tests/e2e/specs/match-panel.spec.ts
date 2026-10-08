import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The match score on the candidate panel and the plain skills editor in a real browser (Wave F; founder decision B2):
 * the Overview shows "Against your must-haves" with the score worked out from the reading, what it rests on, the bars
 * and the promise that a person decides; the role page tags each skill Essential, Important or Helpful and opens the
 * editor at the skills or at the must-haves, also from a `?edit=` link. Everything is synthetic.
 */
const run = Date.now().toString(36);

test.describe("the match score and the skills editor", () => {
  skipWithoutFakeSignIn();
  test("the panel's match card, the role page's importance tags, and the editor opened at a section", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@match.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Match Dental ${run}`);
    const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

    // the score is worked out from the reading, which comes in shortly after they apply
    const list = (await (await page.request.get(`${baseURL}/api/v1/roles/${seeded.roleId}/applications`)).json()) as Array<{ id: string; candidate: { email: string | null } | null }>;
    const id = list.find((a) => a.candidate?.email === seeded.candidateEmail.toLowerCase())!.id;
    const seen: { score: number | null } = { score: null };
    await expect.poll(async () => {
      const d = (await (await page.request.get(`${baseURL}/api/v1/applications/${id}`)).json()) as { matchScore?: { score: number | null } | null };
      seen.score = d.matchScore?.score ?? null;
      return !!d.matchScore;
    }, { timeout: 60_000, message: "the reading the match score is worked out from" }).toBe(true);
    const score = seen.score;

    // The panel's Overview: the score, what it rests on, the breakdown, and that a person decides
    await page.goto(`/roles/${seeded.roleId}/talent?open=${id}`);
    const maria = page.getByRole("dialog", { name: "Maria Reyes" });
    await expect(maria.getByRole("heading", { name: "Against your must-haves" })).toBeVisible({ timeout: 30_000 });
    await expect(maria.getByText("A match score worked out from checked evidence, with the breakdown shown. A person always decides.")).toBeVisible();
    if (score !== null) {
      // in the card and in the panel's header, which keeps it in sight on every section
      await expect(maria.getByText(`Match score ${score} out of 100`)).toHaveCount(2);
      await expect(maria.getByText(/^Based on /)).toBeVisible();
      await expect(maria.getByRole("list", { name: /^Requirements/ }).or(maria.locator(".sbars-more > summary"))).not.toHaveCount(0);
      const folded = maria.locator(".sbars-more > summary");
      if (await folded.count()) {
        await folded.click();
        await expect(maria.getByRole("list", { name: /at full marks$/ })).toBeVisible();
      }
      const words = maria.locator(".sbar-detail summary", { hasText: "see their words" }).first();
      if (await words.count()) {
        await words.click();
        await expect(maria.locator(".sbar-detail details[open] blockquote").first()).toBeVisible();
      }
    } else {
      await expect(maria.getByText(/^Nothing to score yet/)).toBeVisible();
    }
    await expectAccessible(page, "the candidate panel with the match card");
    // "Something wrong?" asks first, saying what an ITS recruiter would see and for how long; Cancel sends nothing
    const flag = maria.getByRole("combobox", { name: "Something wrong with this assessment?" }).first();
    if (await flag.count()) {
      await flag.selectOption("false_positive");
      const confirm = page.getByRole("dialog", { name: "Ask an ITS recruiter to check this reading?" });
      await expect(confirm.getByText(/Once they pick it up they see this candidate and the role they applied for/)).toBeVisible();
      await expectAccessible(page, "the flag's confirmation");
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(confirm).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(maria).toHaveCount(0);

    // The role page: each skill says how much it counts, and the editor opens at the skills
    await page.goto(`/roles/${seeded.roleId}?tab=evaluation`);
    const look = page.locator("section.card", { has: page.getByRole("heading", { name: "What we look for" }) });
    await expect(look.getByText(/^(Essential|Important|Helpful)$/).first()).toBeVisible({ timeout: 30_000 });
    await expect(look.getByText(/must-haves count the most, then Essential skills/)).toBeVisible();
    await look.getByRole("button", { name: "Change the skills or how much each counts" }).click();
    const editor = page.getByRole("dialog", { name: "Edit the role" });
    const skills = editor.getByRole("group", { name: /^Skills we look for/ });
    await expect(skills).toBeVisible();
    await expect(skills.getByRole("textbox", { name: "1. Skill" })).toBeFocused();
    const counts = skills.getByRole("group", { name: /^How much .+ counts$/ }).first();
    await counts.getByRole("button", { name: "Helpful" }).click();
    await expect(counts.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
    await expect(skills.getByText("Counts a little.").first()).toBeVisible();
    await expectAccessible(page, "the role editor's skills");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    // A link to the must-haves (the "stricter than needed" prompt) opens the editor there, and saves nothing by itself
    await page.goto(`/roles/${seeded.roleId}?tab=requirements&edit=must-haves`);
    const again = page.getByRole("dialog", { name: "Edit the role" });
    await expect(again).toBeVisible({ timeout: 30_000 });
    await expect(again.getByRole("group", { name: /^Must-haves/ }).getByRole("textbox", { name: "1. What they must bring" })).toBeFocused();
    await expect(again.getByText(/They count the most in each applicant's match score/)).toBeVisible();
  });
});
