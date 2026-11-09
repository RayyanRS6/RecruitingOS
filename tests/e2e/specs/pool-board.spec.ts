import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PERSONAS, createCompanyThroughTheForm, expectAccessible, sendTheAiInterview, signIn, skipWithoutFakeSignIn, statusPathFromEmail } from "./helpers";

async function noHorizontalOverflow(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on this viewport`).toBeLessThanOrEqual(innerWidth + 1);
}

/**
 * The pool board in a real browser (plan F6-F10; founder decisions B2, B4, B5, B6): three applicants to a hygienist role
 * whose must-haves are an active CA RDH license and periodontal charting, read three ways by the fake model (the same
 * résumés as FAKE_SAMPLE_RESUMES in packages/agents/src/fake-handlers.ts): everything shown, the license with the rest
 * only partly shown, and no license, plainly in their own words (a lapsed one reads "not known yet" since Wave S5's
 * licence rule, so it would no longer be a missing must-have). Since 20 October 2026 (R20-7, R20-9) nobody is placed
 * on the board until their AI interview is sent and scored, so each of them takes it on the candidate's own pages,
 * telling the same story as their résumé, and sends it. Today's card leads to Review and apply; the board sorts them
 * into Shortlist, Longlist and Not moving forward with the reasons; the one-click questions answer from the checked
 * findings; applying files everyone privately and the candidate's own page shows none of it; on a phone the columns
 * stack. Everything is synthetic.
 */
const run = Date.now().toString(36);
/** The résumés, and what each says in the AI interview: the same story in their own words (helpers.ts, PERSONAS). */
type Persona = keyof typeof PERSONAS;

/**
 * A hygienist role with two must-haves, approved, and three applicants who each answer every eligibility question "yes",
 * each in a browser of their own, as candidates are. Each takes the AI interview from the waiting room and sends it, and
 * the board places them once it is scored.
 */
async function seedPool(request: APIRequestContext, browser: Browser, base: string) {
  const s = (await (await request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license, periodontal charting. Just draft it." } })).json()) as { session: { id: string } };
  const { roleId } = (await (await request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
  expect((await request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } })).ok()).toBeTruthy();
  const role = (await (await request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
  const company = (await (await request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string };
  const people = [["Ana", "Holt", "strong"], ["Ben", "Ortiz", "possible"], ["Cleo", "Park", "weak"]] as const;
  const emails: Record<string, string> = {};
  const candidates: Array<{ page: Page; persona: Persona; waitingRoom: string }> = [];
  const contexts = await Promise.all(people.map(() => browser.newContext({ baseURL: base })));
  try {
    for (const [i, [first, last, persona]] of people.entries()) {
      const email = `${first.toLowerCase()}.${last.toLowerCase()}+${run}@example.com`;
      emails[first] = email;
      const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
        firstName: first, lastName: last, email, locationText: "Tustin, CA",
        resume: { name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(`${first} ${last}, RDH\n${PERSONAS[persona].resume}`) },
        noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01",
        acknowledged: "yes",
      };
      for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
      const applied = await contexts[i].request.post(`${base}/careers/${company.slug}/jobs/${roleId}/apply`, { multipart, maxRedirects: 0 });
      expect(applied.status()).toBe(302);
      const waitingRoom = applied.headers().location ?? "";
      expect(waitingRoom, "the apply form sends the applicant to the waiting room").toBe(`/careers/${company.slug}/jobs/${roleId}/applied`);
      candidates.push({ page: await contexts[i].newPage(), persona, waitingRoom });
    }
    // Every one of them read and invited to the AI interview (the worker runs the readings). Until they send it they wait
    // in the board's read-only lane "No AI interview yet" (R20-7), never placed and never suggested.
    type Row = { id: string; aiInterview: { state: string } | null };
    await expect.poll(async () => ((await (await request.get(`${base}/api/v1/roles/${roleId}/applications`)).json()) as Row[]).filter((r) => r.aiInterview?.state === "invited").length, { timeout: 90_000 }).toBe(3);
    const lane = (await (await request.get(`${base}/api/v1/roles/${roleId}/board`)).json()) as { noAiInterview: unknown[]; summary: { toSort: number } };
    expect(lane.noAiInterview).toHaveLength(3);
    expect(lane.summary.toSort).toBe(0);
    // Each waiting room opens its own AI interview by itself (R20-12: 40 to 90 seconds for every address alike).
    await Promise.all(candidates.map(async (c) => {
      await c.page.goto(c.waitingRoom);
      await c.page.waitForURL(/\/c\/screen\/[A-Za-z0-9_-]+$/, { timeout: 150_000 });
    }));
    for (const c of candidates) await sendTheAiInterview(c.page, PERSONAS[c.persona].says);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
  // Sent and scored: the board places all three, and nobody is left in the lane.
  type Board = { noAiInterview: unknown[]; summary: { toSort: number } };
  await expect.poll(async () => {
    const b = (await (await request.get(`${base}/api/v1/roles/${roleId}/board`)).json()) as Board;
    return b.noAiInterview.length === 0 ? b.summary.toSort : -1;
  }, { timeout: 120_000, message: "the three AI interviews scored and on the board" }).toBeGreaterThanOrEqual(3);
  return { roleId, emails };
}

test.describe("the pool board", () => {
  skipWithoutFakeSignIn();
  test("Home's pool row, the board, the one-click questions, Review and apply, privately, and the board on a phone", async ({ page, browser, baseURL }) => {
    // three AI interviews taken and sent on the candidates' own pages before the board has anyone to sort
    test.setTimeout(600_000);
    await page.goto("/login");
    await signIn(page, { email: `dana+${run}@board.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Board Dental ${run}`);
    const { roleId, emails } = await seedPool(page.request, browser, baseURL!);

    // The list opens on everyone, best first: each row has its match score, and the only control that says Sort sorts (the
    // owner, 6 Nov 2026); the Board / List switch is the way to the board
    await page.goto(`/roles/${roleId}/talent`);
    await expect(page.getByRole("region", { name: "Board or list" }).getByRole("button", { name: "List", exact: true, pressed: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Sort the pool" })).toHaveCount(0);
    await expect(page.locator(".talent-row .score-slot .score").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".talent-row")).toHaveCount(3);
    await expect(page.locator(".talent-row .talent-name").first()).toHaveText("Ana Holt");
    await expect(page.getByRole("button", { name: /^Waiting on you/, pressed: false })).toBeVisible();
    // the order is a dropdown chip (Wave S6): it opens on Score, its list ticks the order in force, and choosing one sorts by it
    await page.getByRole("button", { name: "Sort: Score" }).click();
    await expect(page.locator('[role="menuitemradio"][aria-checked="true"] svg')).toHaveCount(1);
    await page.getByRole("menuitemradio", { name: /^Name/ }).click();
    await expect(page.getByRole("button", { name: "Sort: Name" })).toBeVisible();
    await page.getByRole("button", { name: "Sort: Name" }).click();
    await page.getByRole("menuitemradio", { name: /^Score/ }).click();
    await expect(page.getByRole("button", { name: "Sort: Score" })).toBeVisible();
    await expectAccessible(page, "talent list with the Board / List switch");

    // The board: three columns in our words, the summary, a card per person with the reason
    await page.getByRole("region", { name: "Board or list" }).getByRole("button", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(/view=board/);
    await expect(page.getByRole("button", { name: "Board", exact: true, pressed: true })).toBeVisible();
    // no sentence in the bar (founder, 23 Oct 2026): what the board does, and that nothing is sent, is Refresh's title
    await expect(page.getByRole("region", { name: "Board or list" }).getByRole("button", { name: "Refresh" })).toHaveAttribute("title", /Nothing moves until you apply it, and nothing is sent to anyone\.$/, { timeout: 30_000 });
    await expect(page.getByText(/^To sort: \d+ shortlist · \d+ longlist · \d+ not moving forward( · \d+ already sorted or decided)?$/)).toBeVisible({ timeout: 30_000 });
    for (const column of ["Shortlist", "Longlist", "Not moving forward"]) await expect(page.getByRole("heading", { level: 3, name: new RegExp(`^${column} \\d+$`) })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What the pool looks like" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Suggested next steps" })).toBeVisible();
    // Cleo's own words say she holds no license: the one red chip, and Not moving forward
    const cleoCard = page.locator(".board-card").filter({ hasText: "Cleo Park" });
    await expect(cleoCard.locator(".chip.critical")).toHaveText(/^Missing must-have: /);
    await expect(page.locator(".board-col[data-column='not_moving_forward']")).toContainText("Cleo Park");
    // one verdict word beside the number
    const anaCard = page.locator(".board-card").filter({ hasText: "Ana Holt" });
    await expect(anaCard.locator(".board-card-score")).toContainText(/Strong match · \d+/);
    await expect(cleoCard.locator(".board-card-score")).toContainText(/Missing a must-have · \d+/);
    // each card says what its score rests on, and the reading's own confidence sits apart, beside Strong or Potential only
    await expect(cleoCard.locator(".board-card-facts")).toContainText(/Must-haves: \d+ of \d+ shown/);
    await expect(cleoCard.locator(".board-card-facts")).toContainText("From the résumé and the AI interview");
    await expect(anaCard.getByText(/^(High|Medium|Low) confidence$/)).toBeVisible();
    await expect(cleoCard.getByText(/^(High|Medium|Low) confidence$/)).toHaveCount(0);
    await expectAccessible(page, "the pool board");

    // "Have a recruiter check this" opens the request filled in; nothing is sent until Send
    await page.getByRole("button", { name: "Have a recruiter check this" }).click();
    const ask = page.getByRole("dialog", { name: "Bring in a recruiter" });
    await expect(ask.getByRole("button", { name: "Review these candidates", pressed: true })).toBeVisible();
    await expect(ask.getByLabel("Anything specific?")).toHaveValue(/check how the board sorted/);
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);

    // Ask about this pool: one click, an answer from the checked findings, the people as chips, what it looked at
    await page.getByRole("button", { name: "Ask about this pool" }).click();
    const panel = page.getByRole("dialog", { name: "Ask about this pool" });
    // where answers come from under the title, then the questions; no box, and no line about the box (23 Oct 2026)
    await expect(panel.getByText("Answers come from the checked findings already on file.")).toBeVisible();
    await expect(panel.getByText(/Typing your own question/)).toHaveCount(0);
    await expect(panel.locator("textarea")).toHaveCount(0);
    await panel.getByRole("button", { name: "Who is missing a must-have, and why?" }).click();
    await expect(panel.getByText(/^Looked at: \d+ (person|people)/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: /Cleo Park/ })).toBeVisible();
    await expectAccessible(page, "ask about this pool");
    await panel.getByRole("button", { name: /^Show this person on the board$/ }).click();
    await expect(panel).toHaveCount(0);
    const only = page.getByRole("button", { name: /^Showing only the people from/ });
    await expect(only).toBeVisible();
    await expect(page.locator(".board-card")).toHaveCount(1);
    await only.click();

    // Home: the pool row leads straight to Review and apply
    await page.goto("/");
    const card = page.locator(".card").filter({ hasText: /people to sort for/ });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("Nothing moves until you apply it, and nobody is emailed.")).toBeVisible();
    await card.getByRole("link", { name: "Review and apply" }).click();
    await expect(page).toHaveURL(/view=board&review=1/);

    // Review and apply: three groups, the confident ticked, a reason from their own evidence, the private footer
    const review = page.getByRole("dialog", { name: "Review and apply" });
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.getByText("Private: nobody is emailed now.")).toBeVisible();
    // where each group goes is its heading's title, and "untick anyone" the Apply button's (founder, 23 Oct 2026)
    await expect(review.getByRole("heading", { level: 3, name: "Not moving forward" })).toHaveAttribute("title", /^Filed privately; nobody is emailed now\. If nobody tells them within 5 working days, the standard message goes by itself/);
    await expect(review.getByRole("button", { name: /^Apply \d+ decisions?$/ })).toHaveAttribute("title", "Untick anyone you want to decide yourself. Unticked people stay where they are.");
    await expect(review.getByRole("checkbox", { name: "Cleo Park" })).toBeChecked();
    await expect(review.getByLabel("Reason for Cleo Park (change it if you disagree)")).toBeVisible();
    // the day-5 safety net stays on screen in the footer while anyone not moving forward is ticked (founder decision D-03)
    await expect(review.getByText(/^Not moving forward: if nobody tells them within 5 working days, the standard message goes by itself/)).toBeVisible();
    await expect(review.getByText(/From their evidence: Missing must-have/)).toBeVisible();
    await expectAccessible(page, "review and apply");
    // everyone in, Ben too if the board left him unticked
    const ben = review.getByRole("checkbox", { name: "Ben Ortiz" });
    if (await ben.isEnabled()) await ben.check();
    const counter = review.getByRole("status").filter({ hasText: /decisions? ready/ });
    await expect(counter).toContainText(/^\d+ decisions? ready \(\d+ shortlist · \d+ longlist · \d+ not moving forward\)$/);
    const ready = Number((await counter.textContent())?.match(/^(\d+)/)?.[1] ?? "0");
    expect(ready).toBeGreaterThanOrEqual(2);
    await review.getByRole("button", { name: `Apply ${ready} decision${ready === 1 ? "" : "s"}` }).click();
    await expect(page.getByRole("status").filter({ hasText: new RegExp(`Applied ${ready} decisions?.*Filed privately\\. Nobody was emailed\\.`) })).toBeVisible({ timeout: 30_000 });
    await expect(review).toHaveCount(0);
    await expect(page).not.toHaveURL(/review=1/);
    await expect(page.locator(".board-card").filter({ hasText: "Cleo Park" }).getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Private: Cleo is not moving forward and has not been told; her own status page says nothing about it
    const list = (await (await page.request.get(`${baseURL}/api/v1/roles/${roleId}/applications`)).json()) as Array<{ candidate: { name: string } | null; ownerStage: string; toldState: string | null }>;
    expect(list.find((a) => a.candidate?.name === "Cleo Park")).toMatchObject({ ownerStage: "not_moving_forward", toldState: "not_told" });
    const statusPath = await statusPathFromEmail(page.request, baseURL!, emails.Cleo);
    await page.goto(statusPath);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(/not moving forward|shortlist|longlist/i);

    // On a phone the columns stack and nothing scrolls sideways
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/roles/${roleId}/talent?view=board`);
    await expect(page.getByRole("heading", { name: "What the pool looks like" })).toBeVisible({ timeout: 30_000 });
    const [first, second] = await Promise.all([page.locator(".board-col").nth(0).boundingBox(), page.locator(".board-col").nth(1).boundingBox()]);
    expect(second!.y).toBeGreaterThan(first!.y);
    await noHorizontalOverflow(page, "the pool board on a phone");
    await expectAccessible(page, "the pool board on a phone");
  });
});
