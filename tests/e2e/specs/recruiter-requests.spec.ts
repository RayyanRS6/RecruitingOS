import { expect, test } from "@playwright/test";
import { createCompanyThroughTheForm, expectAccessible, seedRoleAndApplicant, signIn, skipWithoutFakeSignIn } from "./helpers";

/**
 * The recruiter loop on Today (plan items B4 to B7), driven through the real pages. The form shows the reply-by time
 * before anything is sent and says what "Urgent" does; "Your recruiter requests" lists the request with its state, who
 * picked it up and the full answer; "This didn't solve it" reopens it with fresh access; a notice's link opens the
 * request; and in Setup, loosening an AI rule asks first while the planned rules fold under "Coming later".
 */
const run = Date.now().toString(36);
skipWithoutFakeSignIn();

test("ask, read the full answer on Today, and reopen it when it did not solve the problem", async ({ page, browser, baseURL }) => {
  await signIn(page, { email: `owner+${run}@loop.test`, name: "Dana Whitfield", provider: "google" });
  await createCompanyThroughTheForm(page, `Loop Dental ${run}`);
  const seeded = await seedRoleAndApplicant(page.request, baseURL!, "Maria", "Reyes");

  // the sheet from the top of Today: the reply-by time before sending, and what urgent does
  await page.goto("/");
  await page.getByRole("button", { name: "Bring in a recruiter" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Bring in a recruiter" });
  await expect(sheet.getByTestId("reply-by-estimate")).toContainText("If you send it now, a recruiter will respond by");
  await expect(sheet.getByText("Urgent requests go to the front of the ITS queue. The reply-by time stays the same.")).toBeVisible();
  await sheet.getByRole("button", { name: "Ask ITS to run this hire" }).click();
  await expect(sheet.getByText(/An ITS recruiter will contact you to agree how they would run this hire/)).toBeVisible();
  await sheet.getByRole("button", { name: "Help me decide" }).click();
  await sheet.getByLabel("Which hire is this about?").selectOption(seeded.roleId);
  await sheet.getByRole("group", { name: "How urgent is it?" }).getByRole("button", { name: "Urgent" }).click();
  await sheet.getByLabel("In one line, what do you need?").fill("Should we interview Maria for the evening shift?");
  await expectAccessible(page, "bring in a recruiter");
  await sheet.getByRole("button", { name: "Send to a recruiter" }).click();
  await expect(sheet.getByText(/It is marked urgent, so it goes to the front of the ITS queue/)).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();

  // the list on Today: waiting, urgent, with its reply-by time
  const requests = page.locator("#recruiter-requests");
  await expect(requests.getByRole("heading", { name: "Your recruiter requests" })).toBeVisible({ timeout: 30_000 });
  await expect(requests.getByText("Waiting for a recruiter")).toBeVisible();
  await expect(requests.getByText("Urgent", { exact: true })).toBeVisible();
  await expect(requests.getByText(/You asked · Reply by /)).toBeVisible();
  const [mine] = (await (await page.request.get(`${baseURL}/api/v1/escalations/mine`)).json()) as Array<{ id: string }>;

  // an ITS administrator picks it up and answers at length in their own browser
  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  await signIn(staffPage, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
  expect((await staffPage.request.post(`${baseURL}/api/v1/escalations/${mine.id}/claim`)).ok()).toBeTruthy();
  // the queue page (Wave S6): the "Yours" pill from the address, the actions at the top, and the console link for an administrator
  await staffPage.goto(`/recruiter/queue/${mine.id}?show=yours`);
  await expect(staffPage.getByRole("button", { name: /^Yours \d+$/ })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(staffPage.getByRole("button", { name: "Release" })).toBeVisible();
  await expect(staffPage.getByRole("link", { name: "See this customer in the console" })).toHaveAttribute("href", /^\/admin\/customers\?open=/);
  await expectAccessible(staffPage, "recruiter queue request");
  const answer = `Yes. ${"Her evening clinic experience fits this role well. ".repeat(8)}Interview her this week.`;
  expect((await staffPage.request.post(`${baseURL}/api/v1/escalations/${mine.id}/resolve`, { data: { resolution: answer, minutesSpent: 15 } })).ok()).toBeTruthy();

  // the full answer on Today, and who gave it
  await page.reload();
  await expect(requests.getByText("Answered", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(requests.getByText(answer)).toBeVisible();
  await expect(requests.getByText(/Picked up by Admin \(ITS recruiter\)/)).toBeVisible();

  // "This didn't solve it": a reason first, then fresh access and a new reply-by time
  await requests.getByRole("button", { name: "This didn't solve it" }).click();
  const reopen = requests.getByRole("button", { name: "Reopen the request" });
  await expect(reopen).toBeDisabled();
  await requests.getByLabel("What is still missing?").fill("She can only start in March. Does that change your advice?");
  await expectAccessible(page, "reopen a recruiter request");
  await reopen.click();
  await expect(requests.getByText(/^Reopened\. Admin \(ITS recruiter\) has it again and will respond by /)).toBeVisible();

  // a notice's link opens the request with its whole conversation
  await page.goto(`/?request=${mine.id}`);
  await expect(page.getByRole("list", { name: "The conversation" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Dana Whitfield reopened it/)).toBeVisible();
  await expectAccessible(page, "recruiter requests");
  await staff.close();
});

test("loosening an AI rule asks first; the planned rules fold under Coming later", async ({ page }) => {
  await signIn(page, { email: `rules+${run}@loop.test`, name: "Rae Owner", provider: "google" });
  await createCompanyThroughTheForm(page, `Rules Dental ${run}`);
  await page.goto("/setup?tab=rules"); // the Settings page's Hiring rules tab
  const rules = page.locator(".card", { has: page.getByRole("heading", { name: "What the AI may do on its own" }) });
  // a rule a setting still changes ("Do it and tell me" by default); the AI interview's invitation is no longer one (R20-4)
  const recommend = rules.getByRole("group", { name: "Recommend who to interview" });
  await expect(recommend).toBeVisible({ timeout: 30_000 });
  await recommend.getByRole("button", { name: "Do it", exact: true }).click();
  await expect(rules.getByText(/From now on it goes ahead without waiting for a person to approve it, and you are not told each time/)).toBeVisible();
  await expectAccessible(page, "loosening confirmation");
  await rules.getByRole("button", { name: "Keep it as it is" }).click();
  await expect(rules.getByRole("button", { name: "Yes, change it" })).toHaveCount(0);
  await expect(recommend.getByRole("button", { name: "Do it and tell me" })).toHaveAttribute("aria-pressed", "true");
  // tightening saves at once
  await recommend.getByRole("button", { name: "Ask me first" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // planned rules are listed, not offered; "always a person" rows stay in view
  await expect(rules.getByText(/^Coming later \(\d+\)$/)).toBeVisible();
  await expect(rules.getByRole("group", { name: "Send an offer" })).toHaveCount(0);
  await expect(rules.getByText("Negotiate an offer")).toBeVisible();
  // work the product does the same way for everyone says what it does, with no choice that would change nothing: the AI
  // interview every applicant gets, and how it runs, among them
  await expect(rules.getByRole("group", { name: "Invite every applicant to the AI interview" })).toHaveCount(0);
  await expect(rules.getByRole("group", { name: "Invite an applicant to the screening chat" })).toHaveCount(0);
  await expect(rules.getByRole("group", { name: "Run the AI interview" })).toHaveCount(0);
  await rules.getByText(/^What it always does the same way \(\d+\)$/).click();
  await expect(rules.getByText("Invite every applicant to the AI interview")).toBeVisible();
  await expect(rules.getByText(/Every applicant is invited to a short AI interview as soon as their résumé is read/)).toBeVisible();
  await expect(rules.getByText(/The AI interview runs with each applicant in their own time/)).toBeVisible();
  await expect(rules.getByText("Book interviews on calendars")).toBeVisible();
});
