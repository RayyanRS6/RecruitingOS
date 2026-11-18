import { expect, test, type Locator, type Page } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, noSidewaysScroll, said, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Making a job, the owner's whole way, in a real browser with the stand-in assistant: one sentence in Home's box, the
 * assistant's follow-up cards answered one at a time, "Write the job", "Publish job", and the job's Share tab with the
 * Apply link and the LinkedIn and Indeed posts, each carrying its own Apply link. Nobody approves the job: publishing
 * opens it at once, and its job page is public. A phone shows the conversation and the job one at a time.
 */
const run = Date.now().toString(36);
/** One sentence, as the box's own example reads; the assistant asks for what it leaves out. */
const IDEA = "A dental assistant for our Tustin office, full time, $24 to $28 an hour";
/** Everything a job needs, in words, for when something is still needed and no card asks for it. */
const THE_REST = "The job title is Dental Assistant. It is on site in Tustin, CA, full time, Monday to Friday, 8 to 5. The pay is $24 to $28 an hour. Must-have: X-ray certification.";

/** What a card that only takes typing is answered with, by what its question asks about. */
function wordsFor(prompt: string): string {
  if (/title|call the (job|role)/i.test(prompt)) return "Dental Assistant";
  if (/on.?site|remote|hybrid/i.test(prompt)) return "On site";
  if (/full.?time|part.?time/i.test(prompt)) return "Full time";
  if (/where|location|city|office/i.test(prompt)) return "Tustin, CA";
  if (/benefit/i.test(prompt)) return "Health and dental cover, paid time off.";
  if (/must|need|require|licen[cs]e|certif|experience/i.test(prompt)) return "X-ray certification";
  return "Monday to Friday, 8 to 5";
}

/**
 * The open cards, one at a time: the pay set by the hour, on site where the card offers it, else the first answer
 * offered or a few plain words; Next, and Send on the last. A card about deal-breakers is passed over.
 */
async function answerTheDeck(card: Locator) {
  for (let i = 0; i < 6; i++) {
    const prompt = ((await card.locator(".qcard-prompt").textContent()) ?? "").trim();
    const pay = card.getByRole("group", { name: "How the job is paid" });
    const options = card.locator("label.option-row");
    if (await pay.count()) {
      await pay.getByRole("button", { name: "By the hour" }).click();
      await card.getByLabel(/^Lowest/).fill("24");
      await card.getByLabel(/^Highest/).fill("28");
    } else if (/deal.?breaker/i.test(prompt)) {
      // left alone: a deal-breaker would become one more must-have
    } else if (await options.count()) {
      const onSite = options.filter({ hasText: /on.?site/i });
      await ((await onSite.count()) ? onSite : options).first().locator("input").check({ force: true });
    } else {
      await card.getByPlaceholder("Type your answer").or(card.getByPlaceholder("Add your own…")).first().fill(wordsFor(prompt));
    }
    const send = card.getByRole("button", { name: "Send", exact: true });
    if (await send.count()) return send.click();
    await card.getByRole("button", { name: "Next", exact: true }).click();
  }
}

/** The builder's one main button, in its header: "Write the job", then "Publish job". */
const mainButton = (page: Page, name: string) => page.locator(".builder > header").getByRole("button", { name, exact: true });
const ready = async (button: Locator) => (await button.isEnabled()) && (await button.getAttribute("aria-disabled")) !== "true";

/** Answers whatever the assistant asks until "Write the job" may be pressed: its cards as they come, or the rest in words when no card is open. */
async function answerUntilTheJobCanBeWritten(page: Page) {
  const write = mainButton(page, "Write the job");
  const card = page.getByRole("region", { name: "Questions from the assistant" });
  await expect(async () => {
    if (await page.getByText(/^Thinking/).count()) throw new Error("the assistant is still thinking");
    if (await ready(write)) return;
    if (await card.isVisible()) await answerTheDeck(card);
    else {
      await page.getByRole("textbox", { name: "Message to the assistant" }).fill(THE_REST);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    }
    throw new Error("answered; looking again");
  }).toPass({ timeout: 300_000, intervals: [2_000] });
}

/** What may still hold publishing once the job is written, dealt with as a person would: the job written again when an answer changed it, and flagged wording kept with a reason. */
async function clearWhatHoldsPublishing(page: Page) {
  const publish = mainButton(page, "Publish job");
  const flagged = page.getByRole("region", { name: "Wording to check before publishing" });
  await expect(async () => {
    if (await ready(publish)) return;
    const again = page.getByRole("button", { name: "Write the job again" });
    if (await again.count()) await again.first().click();
    else if (await flagged.count()) {
      await flagged.getByRole("button", { name: "Keep it…" }).first().click();
      await flagged.getByLabel("Why keep it").fill("The job needs it as written.");
      await flagged.getByRole("button", { name: "Keep it, with this reason" }).click();
    }
    const waitsFor = page.locator(".alert", { hasText: "Before you can publish" });
    throw new Error(`Publish job is not ready yet: ${(await waitsFor.count()) ? await waitsFor.first().innerText() : "no reason is shown"}`);
  }).toPass({ timeout: 180_000, intervals: [2_000] });
}

test.describe("making a job", () => {
  skipWithoutFakeSignIn();

  test("one sentence, the follow-up cards, Write the job, Publish job, and the Share tab with the Apply link and two posts", async ({ page, baseURL }) => {
    test.setTimeout(600_000);
    await signIn(page, { email: `owner+${run}@northgate.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Northgate Dental ${run}`);

    // Home's box: one sentence, and the builder opens on the new draft; the address names the draft, never the words
    await expect(page.getByRole("heading", { name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Describe the job, or paste a job ad" }).fill(IDEA);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });
    expect(page.url()).not.toContain("dental");
    await expect(page.locator(".builder > header .pill", { hasText: /^Draft$/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("You are talking with an AI assistant. It drafts; you decide. Nothing is posted until you publish the job.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversation with the assistant" }).getByText(IDEA)).toBeVisible();
    await expectAccessible(page, "the job builder");

    // the follow-up cards, one question at a time, until everything the job needs is in
    await answerUntilTheJobCanBeWritten(page);
    await expect(page.getByRole("heading", { name: "Still needed" })).toHaveCount(0);

    // Write the job: the job as candidates and the team will read it, with one Edit
    await mainButton(page, "Write the job").click();
    await expect(said(page, "The job is written.")).toBeVisible({ timeout: 120_000 });
    const job = page.getByRole("region", { name: "Job", exact: true });
    await expect(job.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect(job.getByRole("link", { name: /See the job page/ })).toHaveAttribute("href", /\/api\/v1\/intake\/sessions\/[0-9a-f-]+\/preview\/page$/);
    await clearWhatHoldsPublishing(page);
    await expectAccessible(page, "the written job, ready to publish");

    // Publish job: the job opens at once, on its Share tab
    await mainButton(page, "Publish job").click();
    await expect(said(page, "Job published.")).toBeVisible({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/roles\/[0-9a-f-]{36}\?tab=share$/, { timeout: 30_000 });
    const roleId = new URL(page.url()).pathname.split("/").pop()!;
    const title = ((await page.getByRole("heading", { level: 1 }).first().textContent()) ?? "").trim();
    expect(title).toMatch(/assistant/i);
    await expect(page.locator(".pill", { hasText: /^Open$/ }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Job sections" }).getByRole("link", { name: "Share" })).toHaveAttribute("aria-current", "page");

    // the Apply link is the job page's address, and Copy copies it
    const applyLink = page.getByLabel("Apply link", { exact: true });
    await expect(applyLink).toHaveValue(new RegExp(`/careers/[a-z0-9-]+/jobs/${roleId}$`), { timeout: 30_000 });
    const jobUrl = await applyLink.inputValue();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy: Apply link", exact: true }).click();
    await expect(said(page, "Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(jobUrl);

    // the two posts, written in the background, each with the Apply link it carries
    for (const [label, source] of [["LinkedIn post", "linkedin"], ["Indeed post", "indeed"]] as const) {
      const card = page.locator(".card", { has: page.getByRole("heading", { name: label, exact: true }) });
      const post = card.getByLabel("Post", { exact: true });
      await expect(post, label).not.toHaveValue("", { timeout: 120_000 });
      expect(await post.inputValue(), `the ${label} carries its Apply link`).toContain(`${jobUrl}?src=${source}`);
      await expect(card.getByLabel(`Apply link for the ${label}`)).toHaveValue(`${jobUrl}?src=${source}`);
      await expect(card.getByRole("button", { name: `Copy the ${label}` })).toBeEnabled();
      await expect(card.getByRole("button", { name: "Write again" })).toBeEnabled({ timeout: 30_000 });
    }
    await expectAccessible(page, "the Share tab");

    // open on the Jobs list and on Home, and public: the job page says the job and takes applications
    await page.goto("/roles");
    await expect(page.getByRole("list", { name: "Your jobs" }).getByRole("listitem").filter({ hasText: title }).getByText("Open", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.goto("/");
    await expect(page.getByRole("list", { name: "Your jobs" }).getByRole("link", { name: title })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await page.request.get(jobUrl)).status(), { timeout: 30_000, message: "the job's public page" }).toBe(200);
    expect(jobUrl.startsWith(baseURL!)).toBe(true);
    await page.goto(jobUrl);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    await expect(page.getByRole("link", { name: "Apply now" }).last()).toBeVisible();
    await expectAccessible(page, "the public job page");
  });

  test("on a phone, the conversation and the job one at a time with a switch, and no sideways scrolling", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, { email: `owner-phone+${run}@northgate.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Northgate Phone ${run}`);
    await page.goto("/roles/new");
    await expect(page.getByRole("heading", { level: 1, name: "Who are you hiring?" })).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page, "the job builder's first page on a phone");
    await page.getByRole("textbox", { name: "Describe the job, or paste a job ad" }).fill(IDEA);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page).toHaveURL(/\/roles\/new\?session=/, { timeout: 60_000 });
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    await show.getByRole("button", { name: "Job", exact: true }).click();
    await expect(page.getByRole("region", { name: "Job", exact: true })).toBeVisible();
    await expectAccessible(page, "the job builder on a phone");
    await noSidewaysScroll(page, "the job builder on a phone");
  });
});
