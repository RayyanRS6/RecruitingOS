import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** WCAG 2.1 A and AA plus best-practice rules; every violation fails the test with its nodes listed. */
export async function expectAccessible(page: Page, name: string) {
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
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("Your name").fill("Dana Whitfield");
  await page.getByLabel("What kind of business").selectOption("dental");
  await page.getByLabel("How many employees").selectOption("20-49");
  await page.getByLabel("City").fill("Tustin");
  await page.getByRole("button", { name: /Create|Continue|Save/ }).click();
  await page.waitForURL((u) => u.pathname === "/");
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
  const statusPath = applied.headers().location!;
  return { roleId, slug: company.slug, statusPath, candidateEmail: multipart.email as string };
}
