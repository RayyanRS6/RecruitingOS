import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The job builder (plan Wave C) in a real browser, with the fake AI provider: Today's "Who are you hiring?" box hands
 * the words to /roles/new; the assistant asks with tap-to-answer cards docked under the conversation and the picks come
 * back as one summary message; the draft fills in beside it with who sees each part; "Write the draft" shows its steps;
 * "Ask for approval" stays greyed, saying what is missing, until it is ready, then creates the role. A phone shows one
 * pane at a time with a switch. Every screen is checked against WCAG 2.1 AA with axe.
 */
const run = Date.now().toString(36);

test.describe("the job builder", () => {
  skipWithoutFakeSignIn();

  test("from Today's box to a role waiting for approval", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, { email: `builder+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Builder ${run}`);

    // Today: the box hands the words over; the address names the draft, never the words
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Who are you hiring?" }).fill("I need a dental hygienist in Irvine. Full time. $45 to $55 an hour.");
    await page.getByRole("button", { name: "Start drafting" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });
    expect(page.url()).not.toContain("hygienist");

    // the header: drafting, the title, a Draft pill, and Ask for approval greyed with what is missing
    await expect(page.getByText(/^Drafting · Brightline Builder/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hygienist/i);
    const ask = page.getByRole("button", { name: "Ask for approval" });
    await expect(ask).toHaveAttribute("aria-disabled", "true");
    await ask.focus();
    await expect(page.getByRole("tooltip")).toContainText("Before you can ask for approval:");
    await expectAccessible(page, "job builder with question cards");

    // the cards: one question at a time, "1 of N", Next, and Send on the last
    const card = page.getByRole("region", { name: "Questions from the assistant" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/1 of \d/);
    await expect(card.getByText("Why we ask")).toBeVisible();
    const total = Number((await card.getByText(/^\d of \d$/).textContent())!.split(" of ")[1]);
    for (let i = 0; i < total; i++) {
      // tick the first answer offered on each card (a radio, a checkbox or a team chip)
      const first = card.locator("input[type=radio], input[type=checkbox]").first();
      if (await first.count()) await first.check({ force: true });
      await card.getByRole("button", { name: i === total - 1 ? "Send" : "Next" }).click();
    }
    // the picks come back as one summary message, then the assistant's next turn
    await expect(page.getByText("Your answers").first()).toBeVisible({ timeout: 60_000 });

    // the draft beside the conversation: what we know, who sees each part
    await expect(page.getByText("What we know")).toBeVisible();
    await expect(page.getByText("Candidates see this").first()).toBeVisible();
    await expect(page.getByText("Only your team sees this").first()).toBeVisible();
    // the must-haves are not on the job page: the panel says what they are used for instead
    await expect(page.getByText("Used to review applications; not on the job page").first()).toBeVisible();

    // Edit: name who has the final say from the team, quietly
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Who has the final say").selectOption({ label: "Dana Whitfield" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible({ timeout: 30_000 });

    // write the draft: the steps are shown as they happen, then the job reads as a candidate will see it
    const write = page.getByRole("button", { name: "Write the draft" });
    if (await write.isVisible()) {
      await write.click();
      await expect(page.getByRole("status").filter({ hasText: "The draft is written." })).toBeVisible({ timeout: 90_000 });
    }
    await expect(page.getByRole("heading", { name: "What you'll do" })).toBeVisible();
    // with the draft written, the message box asks for changes (close any questions still docked there first)
    const closeCards = page.getByRole("button", { name: "Close the questions" });
    if (await closeCards.isVisible()) await closeCards.click();
    await expect(page.getByRole("textbox", { name: "Ask for a change to the draft" })).toHaveAttribute("placeholder", /Ask me to change anything/);
    // a change by chat is shown field by field first, and saved only on Confirm
    await page.getByRole("textbox", { name: "Ask for a change to the draft" }).fill("Add a must-have: Dentrix experience");
    await page.getByRole("button", { name: "Send" }).click();
    const proposal = page.getByRole("region", { name: "Proposed change" });
    await expect(proposal).toContainText("Dentrix experience", { timeout: 60_000 });
    await expect(proposal).toContainText("Confirming changes the draft.");
    await expectAccessible(page, "a proposed change");
    await proposal.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Change saved." })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "See what candidates will see" }).click();
    await expect(page.getByRole("dialog", { name: "What candidates will see" })).toBeVisible();
    await expectAccessible(page, "candidate view of the draft");
    await page.keyboard.press("Escape");

    // ready: Ask for approval creates the role and opens it
    await expect(ask).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await ask.click();
    await expect(page).toHaveURL(/\/roles\/[0-9a-f-]{36}$/, { timeout: 90_000 });
    await expect(page.getByRole("status").filter({ hasText: "Sent for approval." })).toBeVisible();
  });

  test("on a phone, one pane at a time with a switch, and no sideways scrolling", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, { email: `builder-phone+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Phone ${run}`);
    await page.goto("/roles/new");
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    // quick starts only for roles the dental guide knows; a tap fills the box and sends nothing
    await page.getByRole("button", { name: "Dental assistant" }).click();
    const box = page.getByRole("textbox", { name: "Describe the role, or paste a job ad" });
    await expect(box).toHaveValue(/dental assistant/i);
    // on a touch screen Enter is a new line; the button sends
    await box.fill("I'm hiring a dental assistant in Irvine, $24 to $28 an hour");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=/, { timeout: 60_000 });
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-pressed", "true");
    await show.getByRole("button", { name: "Draft" }).click();
    await expect(page.getByRole("region", { name: "Draft" })).toBeVisible();
    await expectAccessible(page, "job builder on a phone");
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  });

  test("Start a hire picks up the draft in progress, and 'Start a different role' begins another", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, { email: `builder-resume+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Brightline Resume ${run}`);
    await page.goto("/roles/new");
    await page.getByRole("textbox", { name: "Describe the role, or paste a job ad" }).fill("I need a front desk coordinator in Irvine.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=/, { timeout: 60_000 });
    const draftUrl = page.url();
    // Today lists it as a draft in progress, and Start a hire resumes it
    await page.goto("/");
    await expect(page.getByText(/^Draft in progress/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Start a hire" }).click();
    await expect(page).toHaveURL(draftUrl, { timeout: 30_000 });
    await page.getByRole("button", { name: "More for this draft" }).click();
    await page.getByRole("menuitem", { name: "Start a different role" }).click();
    await expect(page).toHaveURL(/\/roles\/new\?new=1$/);
    await expect(page.getByRole("heading", { name: "Your drafts in progress" })).toBeVisible();
  });
});
