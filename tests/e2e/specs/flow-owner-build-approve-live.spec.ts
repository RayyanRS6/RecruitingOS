import { expect, test, type Locator } from "@playwright/test";
import { approvalCard, createCompanyThroughTheForm, emailsTo, expectAccessible, outbox, signIn, skipWithoutFakeSignIn } from "./helpers";

/** The open set of question cards: the first answer on each (a radio, a checkbox or a team chip), Next, and Send on the last. */
async function answerEveryCard(card: Locator) {
  const total = Number((await card.getByText(/^\d of \d$/).textContent())!.split(" of ")[1]);
  for (let i = 0; i < total; i++) {
    const first = card.locator("input[type=radio], input[type=checkbox]").first();
    if (await first.count()) await first.check({ force: true });
    await card.getByRole("button", { name: i === total - 1 ? "Send" : "Next", exact: true }).click();
  }
}

/**
 * Making a job, the owner's whole way, in a real browser with the stand-in AI (the owner, 6 November 2026: "the complete
 * process of making a job hiring"): Start a hire, the owner's own words, the assistant's question cards answered one at a
 * time, Write the draft, Ask for approval, the job's page with Approve at the top of its card, the calm confirmation that
 * says where it is going, Live on the job, on the Jobs list and on Home, and the public job page with the pay. Nothing here
 * emails a candidate, and on the Free plan nothing asks ITS to post it on a board.
 */
const run = Date.now().toString(36);

test.describe("making a job", () => {
  skipWithoutFakeSignIn();

  test("Start a hire, the cards, Write the draft, Ask for approval, Approve and publish, and the job is live everywhere it should be", async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const base = baseURL!;
    const company = `Northgate Dental ${run}`;
    await signIn(page, { email: `owner+${run}@northgate.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, company);

    // Start a hire, from the frame: the builder's first screen
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Start a hire" }).click();
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Describe the role, or paste a job ad" }).fill("I need a registered dental hygienist in Tustin, full time, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });

    // the assistant's cards, one question at a time; the first answer on each, then Send
    const ask = page.getByRole("button", { name: "Ask for approval" });
    await expect(ask).toHaveAttribute("aria-disabled", "true");
    const card = page.getByRole("region", { name: "Questions from the assistant" });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expectAccessible(page, "the job builder's questions");
    const answers = page.locator(".answers", { hasText: "Your answers" });
    await answerEveryCard(card);
    await expect(answers.first()).toBeVisible({ timeout: 60_000 });

    // Write the draft: the job as candidates will read it
    const write = page.getByRole("button", { name: "Write the draft" });
    await expect(write).toBeVisible({ timeout: 60_000 });
    await write.click();
    await expect(page.getByRole("status").filter({ hasText: "The draft is written." })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("heading", { name: "What you'll do" })).toBeVisible();

    // what the draft still leaves open (who interviews, who decides) comes as more cards, answered the same way; the draft
    // then says it is behind the answers and offers "Write it again with them". Ask for approval waits for all of it. Each
    // pass takes whichever of those the page offers, as a person would.
    const again = page.getByRole("button", { name: "Write it again with them" });
    await expect(async () => {
      if ((await ask.getAttribute("aria-disabled")) === "true") {
        if (await again.isVisible()) {
          await again.click();
          await expect(again).toBeHidden({ timeout: 90_000 });
        } else if (await card.getByText(/^\d of \d$/).isVisible()) {
          const sent = await answers.count();
          await answerEveryCard(card);
          await expect(answers).toHaveCount(sent + 1, { timeout: 60_000 });
        }
      }
      expect(await ask.getAttribute("aria-disabled"), "Ask for approval is ready").not.toBe("true");
    }).toPass({ timeout: 300_000, intervals: [2_000] });

    // Ask for approval: the job's page, with Approve at the top of its card, live for the owner who may decide
    await expect(ask).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await ask.click();
    await expect(page).toHaveURL(/\/roles\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    const roleId = new URL(page.url()).pathname.split("/").pop()!;
    const approval = approvalCard(page);
    await expect(approval).toBeVisible({ timeout: 60_000 });
    const approve = approval.getByRole("button", { name: "Approve and publish" });
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    // Approve sits above everything else on the card
    expect((await approve.boundingBox())!.y).toBeLessThan((await approval.getByText(/^Once it is live:/).boundingBox())!.y);
    await expect(page.locator(".pill", { hasText: /^Waiting for approval$/ }).first()).toBeVisible();
    await expectAccessible(page, "the job's page waiting for approval");
    await approve.click();

    // the calm confirmation: where it is going, each place ticked only once checked; then back to the job
    const done = page.getByRole("dialog", { name: "Your job is approved" });
    await expect(done).toBeVisible({ timeout: 30_000 });
    const where = done.getByRole("region", { name: "Where it is going" });
    await expect(where.getByText("Your careers page", { exact: true })).toBeVisible();
    await expect(where.getByText("Google", { exact: true })).toBeVisible();
    await expectAccessible(page, "your job is approved");
    await done.getByRole("button", { name: "Go to your job" }).click();
    await expect(done).toBeHidden({ timeout: 30_000 });
    await expect(page.locator(".pill", { hasText: /^Live$/ }).first()).toBeVisible({ timeout: 30_000 });

    // Live on the Jobs list and on Home, which offers sharing it
    await page.goto("/roles");
    const title = (await (await page.request.get(`${base}/api/v1/roles/${roleId}`)).json() as { currentPacket: { packet: { identity: { title: string } } } }).currentPacket.packet.identity.title;
    await expect(page.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `${title} is live. Share it now` })).toBeVisible({ timeout: 30_000 });

    // the public job page: the title, the pay, and Apply now
    const { slug } = await (await page.request.get(`${base}/api/v1/companies/current`)).json() as { slug: string };
    await expect.poll(async () => (await page.request.get(`${base}/careers/${slug}/jobs/${roleId}`)).status(), { timeout: 30_000 }).toBe(200);
    await page.goto(`/careers/${slug}/jobs/${roleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    await expect(page.getByRole("listitem").filter({ hasText: "Pay: $45–$55 an hour" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Apply now" }).last()).toBeVisible();
    await expectAccessible(page, "the public job page");

    // nobody but the team heard of it, and on Free nothing asked ITS to post it on a board
    const sent = await outbox(page.request, base);
    expect(sent.filter((m) => m.subject.startsWith("[post_job]") && m.text.includes(company)).map((m) => m.subject)).toEqual([]);
    expect((await emailsTo(page.request, base, "recruiters@its.localhost")).filter((m) => m.text.includes(company)).map((m) => m.subject)).toEqual([]);
  });
});
