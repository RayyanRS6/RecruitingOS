import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/** True when the run targets a deployed address (E2E_BASE_URL) rather than the local shell with fake providers. */
export const REMOTE_TARGET = !!process.env.E2E_BASE_URL?.trim();

/**
 * Call at the top of a file or a describe group whose specs sign in through the fake identity page: a deployment has
 * the real identity provider, so those journeys cannot run there and are skipped with the reason on the report.
 */
export function skipWithoutFakeSignIn() {
  test.skip(REMOTE_TARGET, "signs in through the fake identity page, which a deployed address does not have (E2E_BASE_URL is set)");
}

/** WCAG 2.1 A and AA plus best-practice rules; every violation fails the test with its nodes listed. */
export async function expectAccessible(page: Page, name: string) {
  // Let entrances finish first: axe measures colours as drawn, and a dialog still fading in reads as low contrast.
  // Endless animations (loading placeholders, the Live dot) never finish, so they are left out.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).disableRules(["region"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${n.html.slice(0, 120)}`).join("\n  ")}`).join("\n");
  if (results.violations.length) throw new Error(`accessibility violations on ${name}:\n${summary}`);
}

/**
 * Microsoft sign-in through the fake consent page with the second factor unchecked. For an ITS staff address this ends on
 * the authenticator page under /api/v1/auth/mfa (22 September 2026), which is why it does not wait for an app URL.
 */
export async function signInWithoutSecondFactor(page: Page, input: { email: string; name: string }) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Microsoft" }).click();
  await expect(page.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(input.email);
  await page.getByLabel("Name").fill(input.name);
  const mfa = page.getByLabel("Second factor verified (TOTP)");
  if (await mfa.isChecked()) await mfa.uncheck();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/api\/v1\/auth\/mfa/);
}

/** Signs in through the fake identity provider's consent page, exactly as a person would with Google or Microsoft. A staff address needs aal2 here; use signInWithoutSecondFactor for the authenticator step. */
export async function signIn(page: Page, input: { email: string; name: string; provider: "google" | "azure"; aal2?: boolean }) {
  await page.goto("/login");
  await page.getByRole("link", { name: `Continue with ${input.provider === "azure" ? "Microsoft" : "Google"}` }).click();
  await expect(page.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(input.email);
  await page.getByLabel("Name").fill(input.name);
  const mfa = page.getByLabel("Second factor verified (TOTP)");
  if (input.aal2 === false && (await mfa.isChecked())) await mfa.uncheck();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/api/"));
}

export async function createCompanyThroughTheForm(page: Page, name: string) {
  await page.waitForURL("**/setup/company");
  await expectAccessible(page, "company setup");
  // someone who signed in with the wrong account can leave from here
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("Your name").fill("Dana Whitfield");
  await page.getByLabel("What kind of business").selectOption("dental");
  await page.getByLabel("How many employees").selectOption("20-49");
  await page.getByLabel("City").fill("Tustin");
  // State and size start empty, and the time zone starts from the browser's own (empty when it is not a US zone).
  await page.getByLabel("State").fill("CA");
  await page.getByLabel("Time zone").selectOption("America/Los_Angeles");
  await page.getByRole("button", { name: /Create|Continue|Save/ }).click();
  await page.waitForURL((u) => u.pathname === "/");
}

/**
 * ITS switches the one-visit flow on for a company (plan Wave E, founder decision B1): a company without a setting takes
 * "form now, conversation later", and pilots are switched on by ITS. Done through the admin API, signed in as the e2e
 * administrator in a browser context of its own, so the owner's session is untouched.
 */
export async function useOneVisitFlow(browser: Browser, base: string, companyId: string) {
  const staff = await browser.newContext();
  try {
    const admin = await staff.newPage();
    await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
    const r = await admin.request.post(`${base}/api/v1/admin/customers/${companyId}/apply-flow`, { data: { applyFlow: "one_visit", reason: "A pilot company for the one-visit flow." }, headers: { "x-admin-reason": "e2e: pilot company" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally {
    await staff.close();
  }
}

/**
 * ITS puts a company on another plan (founder decision F8): a new company is on the trial, which has room for one role
 * at a time, so a journey that publishes a role and then starts another needs more room. Through the admin API, as above.
 */
export async function usePlan(browser: Browser, base: string, companyId: string, planKey: "core" | "growth" | "company") {
  const staff = await browser.newContext();
  try {
    const admin = await staff.newPage();
    await signIn(admin, { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true });
    const r = await admin.request.post(`${base}/api/v1/admin/customers/${companyId}/plan`, { data: { planKey, reason: "e2e: room for a second role" }, headers: { "x-admin-reason": "e2e: plan for the journey" } });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally {
    await staff.close();
  }
}

/** The heavy data setup goes through the API with the browser's own session cookie; the journey stays in the browser. */
export async function seedRoleAndApplicant(request: APIRequestContext, base: string, first: string, last: string) {
  const s = await (await request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." } })).json() as { session: { id: string } };
  const { roleId } = await (await request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string };
  expect((await request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } })).ok()).toBeTruthy();
  const role = await (await request.get(`${base}/api/v1/roles/${roleId}`)).json() as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
  const company = await (await request.get(`${base}/api/v1/companies/current`)).json() as { slug: string };
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase()}+${Date.now().toString(36)}@example.com`, locationText: "Tustin, CA",
    resume: { name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present`) },
    noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01",
    acknowledged: "yes",
  };
  for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
  const applied = await request.post(`${base}/careers/${company.slug}/jobs/${roleId}/apply`, { multipart, maxRedirects: 0 });
  expect(applied.status()).toBe(302);
  // On a role that applies and talks in one visit (plan E1; a pilot ITS switched on with `useOneVisitFlow`), passing the
  // yes/no questions leads straight to the screening conversation's introduction; a role on the later path lands on the
  // receipt. Either way the status link travels only by email (Wave 0 item 0.1), and the applicant here does not start
  // the conversation, so on a one-visit role they are "Still applying".
  const location = applied.headers().location ?? "";
  expect(location === `/careers/${company.slug}/jobs/${roleId}/applied` || /^\/c\/screen\/[A-Za-z0-9_-]+$/.test(location), `the apply form sent the applicant to ${location}`).toBe(true);
  const conversationPath = location.startsWith("/c/screen/") ? location : null;
  const candidateEmail = multipart.email as string;
  const statusPath = await statusPathFromEmail(request, base, candidateEmail);
  return { roleId, slug: company.slug, statusPath, candidateEmail, conversationPath };
}

/**
 * The status page path from the acknowledgment email as the candidate received it, read from the development outbox
 * (`/dev/outbox`, the fake email adapter) once the worker has sent it. The apply form never returns the link itself,
 * and the owner's copy of the message shows `/c/status/[link]` instead of the candidate's token.
 */
export async function statusPathFromEmail(request: APIRequestContext, base: string, email: string): Promise<string> {
  let path = "";
  await expect.poll(async () => {
    const sent = (await (await request.get(`${base}/dev/outbox`)).json()) as Array<{ to: string; subject: string; text: string }>;
    const ack = sent.find((m) => m.to.toLowerCase() === email.toLowerCase() && m.subject.startsWith("We received your application"));
    path = ack?.text.match(/\/c\/status\/[A-Za-z0-9_-]+/)?.[0] ?? "";
    return path;
  }, { timeout: 60_000, message: "the acknowledgment email with the status link" }).not.toBe("");
  return path;
}
