import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * Approving and publishing (plan Wave D) in a real browser, with the fake AI provider: the approval card opens the job
 * page preview in a new tab, says where the job goes and what starts on its own once it is live; approving opens a calm
 * confirmation that lists where the job is going, each place ticking only once it was checked, with "Share it now"; the
 * Posting tab shares the job and sets the closing date; Today's opening-day card and the empty applicant list offer
 * sharing; Setup has the company's logo and "about" text. Every screen is checked against WCAG 2.1 AA with axe.
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("approve a role, see where it is going, share it and give it a closing date", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await signIn(page, { email: `publish+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Publish ${run}`);

  // a role waiting for approval, drafted through the API with the browser's own session
  const s = await (await page.request.post(`${baseURL}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json() as { session: { id: string } };
  const { roleId } = await (await page.request.post(`${baseURL}/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string };

  // the approval card: the preview opens in a new tab, where the job goes, and what starts on its own once it is live
  await page.goto(`/roles/${roleId}`);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "Approve this role packet" }) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const preview = card.getByRole("link", { name: /Preview the job page/ });
  await expect(preview).toHaveAttribute("target", "_blank");
  await expect(preview).toHaveAttribute("href", new RegExp(`/api/v1/roles/${roleId}/preview\\?version=1$`));
  await expect(card.getByText(/Once approved it goes to your careers page, Google/)).toBeVisible();
  await expect(card.getByText(/^Once it is live:/)).toBeVisible();
  await expect(card.getByRole("link", { name: "Change these rules" })).toHaveAttribute("href", "/setup#setup-rules");
  await expectAccessible(page, "approval card");

  // approving opens the confirmation: where the job is going, nothing ticked before it was checked
  // the must-haves are on the job page, and the card says so (plan D10)
  await expect(card.getByText(/The job page lists what you are looking for:/)).toBeVisible();
  await card.getByRole("button", { name: "Approve and publish" }).click();
  const done = page.getByRole("dialog", { name: "Your job is approved" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  const where = done.getByRole("region", { name: "Where it is going" });
  await expect(where.getByText("Your careers page")).toBeVisible();
  await expect(where.getByText("Google", { exact: true })).toBeVisible();
  await expect(where.getByText(/Checking it is up|Up and checked|Getting it ready/).first()).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "after approval");
  // "Share it now" opens the share block at the top; the buttons are plain links or buttons, nothing from the networks loads
  await done.getByRole("button", { name: "Share it now" }).click();
  const shareGroup = done.getByRole("group", { name: "Share the job" });
  await expect(shareGroup).toBeVisible();
  await expect(shareGroup.getByText("WhatsApp")).toBeVisible();
  await expect(page.locator("script[src*='facebook'], script[src*='linkedin'], script[src*='twitter'], iframe")).toHaveCount(0);
  await done.getByRole("button", { name: "Go to your role" }).click();
  await expect(done).toBeHidden();

  // the Posting tab: the share block, the boards, and the closing date
  await page.goto(`/roles/${roleId}?tab=posting#share`);
  await expect(page.locator("#share").getByRole("heading", { name: "Share it" })).toBeVisible({ timeout: 30_000 });
  // a ready-made place gets its own link to copy
  await page.locator("#share").getByRole("button", { name: "Make a link to copy" }).first().click();
  await expect(page.locator("#share").getByText(/visits?$/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Where it is posted" })).toBeVisible();
  const closing = page.locator("#closing-date");
  const lastDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await closing.getByLabel("Last day to apply").fill(lastDay);
  await closing.getByRole("button", { name: "Save the date" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Applications close at the end of/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Apply by /).first()).toBeVisible();
  await expectAccessible(page, "posting tab with sharing and the closing date");

  // Today: the opening-day card offers to share the new job
  await page.goto("/");
  const today = page.locator(".card", { hasText: "is live. Share it now" });
  await expect(today).toBeVisible({ timeout: 30_000 });
  await expect(today.getByRole("link", { name: "Share the job" })).toHaveAttribute("href", `/roles/${roleId}?tab=posting#share`);

  // nobody has applied yet: the empty list is where to share it from
  await page.goto(`/roles/${roleId}/talent`);
  await expect(page.getByRole("heading", { name: "Nobody has applied yet" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("group", { name: "Share the job" })).toBeVisible();
  await expectAccessible(page, "empty applicant list with sharing");
});

test("Setup: the logo and the 'about the company' text, and who posts on the job boards", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, { email: `profile+${run}@brightline.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Brightline Profile ${run}`);
  await page.goto("/setup#setup-profile");
  const profile = page.locator("#setup-profile");
  await expect(profile.getByRole("heading", { name: "How candidates see you" })).toBeVisible({ timeout: 30_000 });
  // the logo is a picture uploaded here, never a typed address
  await expect(profile.getByLabel("Choose a picture")).toHaveAttribute("type", "file");
  await expect(page.getByText("Logo address (https)")).toHaveCount(0);
  // the assistant drafts the "about" text; nothing shows until a person approves it
  await profile.getByRole("button", { name: "Write it yourself" }).click();
  await profile.getByLabel("What candidates read about the company").fill("We are a family dental practice in Tustin, caring for our neighbours since 1998.");
  await expect(profile.getByRole("button", { name: "Approve and show it" })).toBeVisible();
  // who candidates write to before they apply: the ITS inbox until the company sets its own address
  await expect(profile.getByRole("heading", { name: "Who candidates can write to before they apply" })).toBeVisible();
  await expect(profile.getByText(/This is the ITS inbox that answers for your company/)).toBeVisible({ timeout: 30_000 });
  await profile.getByRole("button", { name: "Set your own contact" }).click();
  await profile.getByLabel("Email address").fill(`jobs+${run}@brightline.test`);
  await profile.getByRole("button", { name: "Save the contact" }).click();
  await expect(profile.getByText(`Candidates see: jobs+${run}@brightline.test. Your own address, set here.`)).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "company profile");
  const boards = page.locator("#setup-boards");
  await expect(boards.getByRole("button", { name: "ITS posts them for us" })).toHaveAttribute("aria-pressed", "true");
  await expect(boards.getByLabel("We have our own paid ZipRecruiter plan")).not.toBeChecked();
});
