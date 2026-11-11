import { expect, test } from "@playwright/test";
import { approvalCard, createCompanyThroughTheForm, expectAccessible, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * A job the law holds, the other way out (the owner, 6 November 2026: "where can I approve this job it says waiting for
 * approval?"). approve-remote.spec.ts walks the field on the card itself; this walks what it does not: Home's card says
 * what is missing and leads to the job, Approve is there and says why it waits, "Use for every job" lands on the company's
 * Benefits in Settings, and once the company describes its benefits the job's Approve wakes with nothing more to type, and
 * the public page shows them. The job is drafted through the API: the builder is approve-remote's and journey's subject.
 */
const run = Date.now().toString(36);
const REMOTE_JOB = "I need a bookkeeper in Irvine, fully remote, $60,000 to $70,000 a year, full time. It's growth. Ceiling $72,000. I decide. Must-haves: QuickBooks. Just draft it.";
const WORDS = "Medical and dental cover, 401(k) with a match, three weeks of paid time off.";

test.describe("a job the law holds", () => {
  skipWithoutFakeSignIn();

  test("Home says what is missing, Approve says why it waits, the company's benefits in Settings wake it, and the public page shows them", async ({ page, baseURL }) => {
    test.setTimeout(300_000);
    const base = baseURL!;
    await signIn(page, { email: `owner+${run}@remotehold.test`, name: "Dana Whitfield", provider: "google" });
    await createCompanyThroughTheForm(page, `Remote Hold Books ${run}`);
    const s = (await (await page.request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: REMOTE_JOB } })).json()) as { session: { id: string } };
    const made = await page.request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(made.ok(), await made.text()).toBeTruthy();
    const { roleId } = (await made.json()) as { roleId: string };
    const title = ((await (await page.request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { identity: { title: string } } } }).currentPacket.packet.identity.title;

    // Home: the approval waiting, with the way in that says what it is
    await page.goto("/");
    await expect(page.getByRole("heading", { name: `Approve the job: ${title}` })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("link", { name: "See what is missing" }).click();
    await expect(page).toHaveURL(new RegExp(`/roles/${roleId}$`));

    // the card: Approve is there, greyed, and the box right under it says what the law asks
    const card = approvalCard(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const approve = card.getByRole("button", { name: "Approve and publish" });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(card.getByText("Before this job can go live")).toBeVisible();
    await expect(page.locator(".pill", { hasText: /^Waiting for approval$/ }).first()).toBeVisible();

    // "Use for every job": the company's own Benefits, in Settings, at once and before Edit
    await card.getByRole("link", { name: "Use for every job" }).click();
    await expect(page).toHaveURL(/\/setup#setup-company$/);
    const company = page.locator("#setup-company");
    await expect(company.getByText("Benefits", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(company.getByText("not set").first()).toBeVisible();
    await company.getByRole("button", { name: "Edit" }).click();
    await company.getByLabel("Benefits summary").fill(WORDS);
    await expectAccessible(page, "the company's benefits");
    await company.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Saved: benefits summary\./ })).toBeVisible({ timeout: 30_000 });
    await expect(company.getByText(WORDS)).toBeVisible();

    // back on the job: nothing left to type, Approve is live, and it opens the job
    await page.goto(`/roles/${roleId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(approve).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await expect(card.getByText("Before this job can go live")).toHaveCount(0);
    await expect(card.getByLabel("A short description of the benefits")).toHaveCount(0);
    await approve.click();
    const done = page.getByRole("dialog", { name: "Your job is approved" });
    await expect(done).toBeVisible({ timeout: 30_000 });
    await done.getByRole("button", { name: "Go to your job" }).click();
    await expect(page.locator(".pill", { hasText: /^Live$/ }).first()).toBeVisible({ timeout: 30_000 });

    // the public page carries the company's words
    const { slug } = (await (await page.request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string };
    await expect.poll(async () => (await page.request.get(`${base}/careers/${slug}/jobs/${roleId}`)).status(), { timeout: 30_000 }).toBe(200);
    await page.goto(`/careers/${slug}/jobs/${roleId}`);
    await expect(page.getByRole("heading", { name: "Benefits" })).toBeVisible();
    await expect(page.getByText(WORDS)).toBeVisible();
  });
});
