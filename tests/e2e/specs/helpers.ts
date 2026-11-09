import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** True when the run targets a deployed address (E2E_BASE_URL) rather than the local shell with fake providers. */
export const REMOTE_TARGET = !!process.env.E2E_BASE_URL?.trim();

/**
 * Call at the top of a file or a describe group whose specs sign in through the fake identity page: a deployment has
 * the real identity provider, so those journeys cannot run there and are skipped with the reason on the report.
 */
export function skipWithoutFakeSignIn() {
  test.skip(REMOTE_TARGET, "signs in through the fake identity page, which a deployed address does not have (E2E_BASE_URL is set)");
}

/**
 * page.goto that tries once more when the app's own navigation cancelled it (net::ERR_ABORTED): right after a staff
 * sign-in the landing page may still send the person on while the dev server compiles the next page (seen on CI).
 */
export async function gotoSettled(page: Page, path: string) {
  try {
    await page.goto(path);
  } catch (e) {
    if (!String(e).includes("ERR_ABORTED")) throw e;
    await page.waitForLoadState("networkidle");
    await page.goto(path);
  }
}

/** WCAG 2.1 A and AA plus best-practice rules; every violation fails the test with its nodes listed. */
export async function expectAccessible(page: Page, name: string) {
  // Let entrances finish first: axe measures colours as drawn, and a dialog still fading in reads as low contrast.
  // Endless animations (loading placeholders, the Live dot) never finish, so they are left out. A list that arrives
  // after a tab click starts its own entrances once its request returns, so wait for the network too, then again.
  const entrances = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await entrances();
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await entrances();
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
  // The first page may still send the person on (staff go to the queue): a page.goto made before that settles is aborted.
  await page.waitForLoadState("networkidle");
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
 * ITS switches the one-visit flow on for a company (plan Wave E, founder decision B1). Since 20 October 2026 (R20-12)
 * nothing reads the setting: every applicant takes the same path, so this only writes it. Done through the admin API,
 * signed in as the e2e administrator in a browser context of its own, so the owner's session is untouched.
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
 * ITS puts a company on another plan (founder decision F8): a new company is on Free, which has room for one job ever,
 * so a journey that publishes a role and then starts another needs more room. Through the admin API, as above, which
 * takes the plans the console offers.
 */
export async function usePlan(browser: Browser, base: string, companyId: string, planKey: "basic" | "pro" | "ultra") {
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
  // Since 20 Oct 2026 (R20-12) every applicant lands on the waiting room, which opens their own AI interview once it
  // exists (the résumé read, and at least 40 to 90 seconds for every address alike, Q14): followed here as the page's script does. The status link travels
  // only by email (Wave 0 item 0.1), and the applicant here does not start the interview, so they are under "No AI interview yet" (R20-7).
  const location = applied.headers().location ?? "";
  expect(location, "the apply form sends the applicant to the waiting room").toBe(`/careers/${company.slug}/jobs/${roleId}/applied`);
  let conversationPath: string | null = null;
  await expect.poll(async () => {
    const to = (await request.get(`${base}${location}`, { maxRedirects: 0 })).headers().location ?? "";
    conversationPath = /^\/c\/screen\/[A-Za-z0-9_-]+$/.test(to) ? to : null;
    return conversationPath;
  }, { timeout: 150_000, message: "the waiting room opening the AI interview" }).not.toBeNull();
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
    const ack = sent.find((m) => m.to.toLowerCase() === email.toLowerCase() && m.subject.startsWith("Thank you for applying"));
    path = ack?.text.match(/\/c\/status\/[A-Za-z0-9_-]+/)?.[0] ?? "";
    return path;
  }, { timeout: 60_000, message: "the acknowledgment email with the status link" }).not.toBe("");
  return path;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The whole flows (the owner, 6 November 2026: "please test it thoroughly so the complete process of making a job      */
/* hiring and then the complete process of applying test both these flows"). Each email is read by its words, right     */
/* after the press that sends it, from the development outbox.                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One email as the fake adapter recorded it (packages/integrations/src/types.ts, OutboundEmail). */
export type SentEmail = { to: string; from: string; subject: string; text: string; at: string; attachments?: Array<{ filename: string; contentType: string; contentBase64: string }> };
type Words = string | RegExp;
const matches = (value: string, w: Words) => (typeof w === "string" ? value.includes(w) : w.test(value));
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What the fake email adapter sent, newest first. The server keeps the last 50 only (apps/api/src/app.ts), across every
 * spec that ran on it, so read it right after the press that sends, never at the end of a long journey.
 */
export async function outbox(request: APIRequestContext, base: string): Promise<SentEmail[]> {
  const r = await request.get(`${base}/dev/outbox`);
  expect(r.ok(), "the development outbox (the fake email adapter) answers").toBeTruthy();
  return (await r.json()) as SentEmail[];
}

/** Every email to one address whose subject matches, newest first. */
export async function emailsTo(request: APIRequestContext, base: string, to: string, subject?: Words): Promise<SentEmail[]> {
  return (await outbox(request, base)).filter((m) => sameAddress(m.to, to) && (subject === undefined || matches(m.subject, subject)));
}

/**
 * Waits for the email to `to` whose subject matches (decision and closing messages leave after their 30-second Undo
 * window, so allow 90 seconds for those), then checks every one of `says` is in its text. Returns it.
 */
export async function waitForEmail(request: APIRequestContext, base: string, input: { to: string; subject: Words; says?: Words[]; timeout?: number }): Promise<SentEmail> {
  let found: SentEmail | undefined;
  await expect.poll(async () => {
    found = (await emailsTo(request, base, input.to, input.subject))[0];
    return !!found;
  }, { timeout: input.timeout ?? 60_000, intervals: [500, 1_000, 2_000], message: `an email to ${input.to} with the subject ${String(input.subject)}` }).toBe(true);
  for (const w of input.says ?? []) {
    if (typeof w === "string") expect(found!.text, `the email "${found!.subject}" to ${input.to}`).toContain(w);
    else expect(found!.text, `the email "${found!.subject}" to ${input.to}`).toMatch(w);
  }
  return found!;
}

/** Exactly one email to `to` with a subject that matches, now. */
export async function exactlyOneEmail(request: APIRequestContext, base: string, input: { to: string; subject: Words }): Promise<SentEmail> {
  const all = await emailsTo(request, base, input.to, input.subject);
  expect(all.map((m) => m.subject), `emails to ${input.to} with the subject ${String(input.subject)}`).toHaveLength(1);
  return all[0];
}

/**
 * No email to `to` (with a subject that matches, when one is given) after waiting `ms`: long enough for the inline worker
 * to have sent anything the last press queued. A message held for its Undo window takes 30 seconds; pass more for those.
 */
export async function expectNoEmail(request: APIRequestContext, base: string, input: { to: string; subject?: Words; ms?: number }) {
  await new Promise((r) => setTimeout(r, input.ms ?? 5_000));
  const all = await emailsTo(request, base, input.to, input.subject);
  expect(all.map((m) => m.subject), `no email to ${input.to}${input.subject ? ` with the subject ${String(input.subject)}` : ""}`).toEqual([]);
}

/** The email's link that starts with `path` (e.g. "/c/status/"), as a path on this server. */
export function linkIn(email: SentEmail, path: string): string {
  const m = email.text.match(new RegExp(`https?://[^\\s]+(${path.replace(/[/]/g, "\\/")}[^\\s]*)`));
  expect(m, `a link to ${path} in "${email.subject}"`).not.toBeNull();
  return m![1].replace(/[).,]+$/, "");
}

/** The administrator the e2e server bootstraps (BOOTSTRAP_ADMIN_EMAILS): Nadine at ITS, signed in with Microsoft and a second factor, in a browser of her own. */
export const NADINE = { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true } as const;

export async function signInAsNadine(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, NADINE);
  return { context, page };
}

/** The company form as a new owner fills it in (the fields of apps/web/src/pages/CompanySetup.tsx), up to the button. */
export async function fillTheCompanyForm(page: Page, company: string, owner = "Sam Asker") {
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("Your name").fill(owner);
  await page.getByLabel("What kind of business").selectOption("dental");
  await page.getByLabel("How many employees").selectOption("1-19");
  await page.getByLabel("City").fill("Tustin");
  await page.getByLabel("State").fill("CA");
  await page.getByLabel("Time zone").selectOption("America/Los_Angeles");
  await page.getByLabel("Website (optional)").fill("https://asker.example");
}

/**
 * The job built the way an owner builds one, from Home: the "Who are you hiring?" box, the job builder's "Write the draft",
 * and "Ask for approval". `words` ends "Just draft it." so the stand-in writes the draft at once. Returns the job's id;
 * the page is left on the job's page.
 */
export async function buildJobThroughTheBuilder(page: Page, words: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Who are you hiring?" }).fill(words);
  await page.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/roles\/new\?session=[0-9a-f-]+$/, { timeout: 60_000 });
  const write = page.getByRole("button", { name: "Write the draft" });
  await expect(write).toBeVisible({ timeout: 60_000 });
  await write.click();
  await expect(page.getByRole("status").filter({ hasText: "The draft is written." })).toBeVisible({ timeout: 90_000 });
  const ask = page.getByRole("button", { name: "Ask for approval" });
  await expect(ask).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await ask.click();
  await expect(page).toHaveURL(/\/roles\/[0-9a-f-]{36}$/, { timeout: 90_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/**
 * A live job through the API with the owner's own session, for a spec whose subject is not the job: drafted from `words`
 * and approved. Returns its id, the company's slug and the job's public address.
 */
export async function liveJobThroughTheApi(request: APIRequestContext, base: string, words = HYGIENIST_JOB): Promise<{ roleId: string; slug: string; jobUrl: string; title: string }> {
  const s = (await (await request.post(`${base}/api/v1/intake/sessions`, { data: { initialMessage: words } })).json()) as { session: { id: string } };
  const made = await request.post(`${base}/api/v1/intake/sessions/${s.session.id}/compile`);
  expect(made.ok(), await made.text()).toBeTruthy();
  const { roleId } = (await made.json()) as { roleId: string };
  const approved = await request.post(`${base}/api/v1/roles/${roleId}/approve`, { data: { version: 1, note: "Looks right." } });
  expect(approved.ok(), await approved.text()).toBeTruthy();
  const { slug } = (await (await request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string };
  const role = (await (await request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { identity: { title: string } } } };
  await expect.poll(async () => (await request.get(`${base}/careers/${slug}/jobs/${roleId}`)).status(), { timeout: 30_000, message: "the job's public page" }).toBe(200);
  return { roleId, slug, jobUrl: `${base}/careers/${slug}/jobs/${roleId}`, title: role.currentPacket.packet.identity.title };
}

/**
 * An applicant through the API, for a spec whose subject is not the application: every eligibility question answered Yes,
 * then the waiting room followed until their AI interview exists, as seedRoleAndApplicant does. They do not take it.
 * Returns their status page path, from the email they got, and their application's id.
 */
export async function applicantThroughTheApi(request: APIRequestContext, base: string, job: { roleId: string; slug: string }, who: Applicant): Promise<{ statusPath: string; applicationId: string }> {
  const role = (await (await request.get(`${base}/api/v1/roles/${job.roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    firstName: who.first, lastName: who.last, email: who.email, locationText: "Tustin, CA",
    resume: { name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(resumeOf(who)) },
    noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01",
    acknowledged: "yes",
  };
  for (const rule of role.currentPacket.packet.requirements.eligibility) multipart[`elig_${rule.key}`] = "yes";
  const applied = await request.post(`${base}/careers/${job.slug}/jobs/${job.roleId}/apply`, { multipart, maxRedirects: 0 });
  expect(applied.status()).toBe(302);
  const location = applied.headers().location ?? "";
  await expect.poll(async () => /^\/c\/screen\/[A-Za-z0-9_-]+$/.test((await request.get(`${base}${location}`, { maxRedirects: 0 })).headers().location ?? ""), { timeout: 150_000, message: "the waiting room opening the AI interview" }).toBe(true);
  const statusPath = await statusPathFromEmail(request, base, who.email);
  const list = (await (await request.get(`${base}/api/v1/roles/${job.roleId}/applications`)).json()) as Array<{ id: string; candidate: { email: string | null } | null }>;
  const applicationId = list.find((a) => a.candidate?.email?.toLowerCase() === who.email.toLowerCase())?.id;
  expect(applicationId, `${who.first}'s application`).toBeTruthy();
  return { statusPath, applicationId: applicationId! };
}

/** The job's approval card (RolePlan.tsx): "Approve this job" at the top of the job's page. */
export const approvalCard = (page: Page, title: string | RegExp = "Approve this job") => page.locator(".card", { has: page.getByRole("heading", { name: title }) });

/** Approve and publish on the job's page, the calm confirmation, and back to the job, which is then live. */
export async function approveOnTheJobPage(page: Page) {
  const card = approvalCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const approve = card.getByRole("button", { name: "Approve and publish" });
  await expect(approve).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await approve.click();
  const done = page.getByRole("dialog", { name: "Your job is approved" });
  await expect(done).toBeVisible({ timeout: 30_000 });
  await done.getByRole("button", { name: "Go to your job" }).click();
  await expect(done).toBeHidden({ timeout: 30_000 });
}

/** Declared interview hours, Monday to Friday 9 to 5, saved in Settings as a person does (optional since 6 November 2026). */
export async function saveMyHours(page: Page) {
  await page.goto("/setup#setup-availability");
  await expect(page.getByRole("heading", { name: "My availability for interviews" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Save availability" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Availability saved/ })).toBeVisible({ timeout: 30_000 });
}

/** Someone applying: their résumé's first line is their name, then their address, as a real résumé starts. */
export type Applicant = { first: string; last: string; email: string; resume: string };

export function resumeOf(who: Applicant): string {
  return `${who.first} ${who.last}\n${who.email}\n(714) 555-01${String(who.first.length).padStart(2, "0")}\nTustin, CA\n${who.resume}\n`;
}

/**
 * Applying through the job's own pages, in a browser of their own as candidates are: the job page (or the link someone
 * shared), Apply now, the résumé first and "Check your details" filled in from it, every question of the job answered
 * Yes (or its first choice) where the résumé chose nothing, the notice read and ticked, and Send my application. The page
 * is left on the waiting room; `waitForTheAiInterview` follows it to the AI interview.
 */
export async function applyThroughTheForm(browser: Browser, base: string, jobUrl: string, who: Applicant): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: base });
  const cand = await context.newPage();
  await cand.goto(jobUrl);
  await expect(cand.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  // a board's or a place's tracked link lands on the form itself; the job's own address on the job page
  if (!/\/apply$/.test(new URL(cand.url()).pathname)) await cand.getByRole("link", { name: "Apply now" }).last().click();
  await cand.waitForURL(/\/careers\/[^/]+\/jobs\/[0-9a-f-]+\/apply$/, { timeout: 30_000 });
  await expect(cand.getByRole("heading", { name: "Start with your resume" })).toBeVisible();
  await cand.locator('input[name="resume"]').setInputFiles({ name: `${who.first.toLowerCase()}-${who.last.toLowerCase()}.txt`, mimeType: "text/plain", buffer: Buffer.from(resumeOf(who)) });
  await expect(cand.getByRole("heading", { name: "Check your details" })).toBeVisible({ timeout: 60_000 });
  await expect(cand.getByLabel("First name")).toHaveValue(who.first);
  await expect(cand.getByLabel("Last name")).toHaveValue(who.last);
  await expect(cand.getByLabel("Email")).toHaveValue(who.email);
  const questions = cand.locator("section.quick");
  for (const group of await questions.locator("li fieldset").all()) {
    if (await group.locator("input:checked").count()) continue;
    const yes = group.locator('input[type="radio"][value="yes"]');
    if (await yes.count()) await yes.check();
    else if (await group.locator('input[type="radio"]').count()) await group.locator('input[type="radio"]').first().check();
    else await group.locator('input[type="checkbox"]').first().check();
  }
  for (const number of await questions.locator('input[type="number"]').all()) if (!(await number.inputValue())) await number.fill("5");
  await cand.getByRole("checkbox", { name: /I have read the full notice above/ }).check();
  await cand.getByRole("button", { name: "Send my application" }).click();
  return { context, page: cand };
}

/** The waiting room opens the AI interview by itself once the résumé is read (40 to 90 seconds for every address alike, Q14). */
export async function waitForTheAiInterview(cand: Page) {
  await cand.waitForURL(/\/c\/screen\/[A-Za-z0-9_-]+$/, { timeout: 150_000 });
}

/**
 * What someone says in the AI interview: `licence` answers a yes-or-no question about the license, `licenceWords` a question
 * about it in words; `story` a question about a time something happened, `work` everything else.
 */
export type Says = { licence: "Yes" | "No"; licenceWords: string; work: string; story: string };

/**
 * The AI interview on the candidate's own pages, from its introduction to Send: a tap where the page offers one, their
 * own words otherwise (the stand-in model answers each turn), then Review & send as it stands.
 */
export async function sendTheAiInterview(cand: Page, says: Says) {
  await expect(cand.getByText("Your application is sent.")).toBeVisible({ timeout: 30_000 });
  await cand.getByRole("button", { name: "Start" }).click();
  await expect(cand.getByRole("heading", { level: 1, name: /^Your chat about the / })).toBeVisible({ timeout: 30_000 });
  const chatEnd = cand.getByRole("button", { name: "Review and send" });
  for (let i = 0; i < 30; i++) {
    if (await chatEnd.isVisible()) break;
    const asked = (await cand.locator("li.msg.assistant.now").textContent()) ?? "";
    const aboutLicence = /licen[cs]e/i.test(asked);
    if (await cand.getByRole("button", { name: "Yes", exact: true }).isVisible()) {
      await cand.getByRole("button", { name: aboutLicence ? says.licence : "Yes", exact: true }).click();
    } else if (await cand.getByLabel("From", { exact: true }).isVisible()) {
      await cand.getByLabel("From", { exact: true }).fill("50");
      await cand.getByLabel("To (optional)", { exact: true }).fill("54");
      await cand.getByRole("button", { name: "Send", exact: true }).first().click();
    } else if (await cand.getByLabel("The earliest day you could start").isVisible()) {
      await cand.getByLabel("The earliest day you could start").fill(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
      await cand.getByRole("button", { name: "Send", exact: true }).first().click();
    } else if (await cand.getByRole("group", { name: "Tick every day you can work" }).isVisible()) {
      await cand.getByLabel("Monday").check();
      await cand.getByRole("button", { name: "Send", exact: true }).first().click();
    } else {
      await cand.getByLabel(/^Your reply/).fill(aboutLicence ? says.licenceWords : /nervous|patient|difficult|time when|a time/i.test(asked) ? says.story : says.work);
      await cand.getByRole("button", { name: "Send", exact: true }).click();
    }
  }
  await expect(cand.getByText("Your chat is complete.")).toBeVisible({ timeout: 30_000 });
  await chatEnd.click();
  await expect(cand.getByRole("heading", { level: 1, name: "Check what you're sending" })).toBeVisible({ timeout: 60_000 });
  await cand.getByRole("button", { name: "Send my answers" }).click();
  await expect(cand.getByRole("heading", { level: 1, name: "Thanks, your answers are sent" })).toBeVisible({ timeout: 60_000 });
}

/**
 * Three hygienists the stand-in reads three ways against a role whose must-haves are an active CA RDH license and
 * periodontal charting (FAKE_SAMPLE_RESUMES in packages/agents/src/fake-handlers.ts): everything shown, the license with the
 * rest only partly shown, and no license in their own words. Each tells the same story in the AI interview.
 */
export const HYGIENIST_JOB = "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license, periodontal charting. Just draft it.";
export const PERSONAS = {
  strong: {
    resume: "Registered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active\nPeriodontal charting, scaling and root planing, Dentrix\nThorough, gentle clinical care to high standards\nPatient communication: explains findings plainly and builds trust\nKeeps to time without cutting corners\nShows up consistently and communicates early",
    says: {
      licence: "Yes",
      licenceWords: "Yes, I hold an active CA RDH license and have since 2019.",
      work: "At Harbor Dental I see about nine patients a day: periodontal charting, scaling and root planing, all charted in Dentrix.",
      story: "A nervous patient was shaking before a deep cleaning, so I explained each step plainly and we agreed a hand signal to pause; she finished and rebooked with me.",
    },
  },
  possible: {
    resume: "Dental Hygienist at Coastal Smiles 2022 - present\nRDH license CA active\nCharting in Dentrix, patient reminders",
    says: {
      licence: "Yes",
      licenceWords: "Yes, I hold an active CA RDH license.",
      work: "At Coastal Smiles since 2022 I chart in Dentrix and send the patient reminders for about eight patients a day.",
      story: "A patient was worried about the cost of a cleaning, so I walked her through it with the front desk before we started and she stayed.",
    },
  },
  weak: {
    resume: "Dental Hygienist at Pacific Dental 2010 - 2020\nI do not hold a CA RDH license\nPeriodontal charting, Dentrix",
    says: {
      licence: "No",
      licenceWords: "No, I do not hold a CA RDH license.",
      work: "At Pacific Dental from 2010 to 2020 I did periodontal charting in Dentrix for about eight patients a day.",
      story: "A patient at Pacific Dental was anxious about a long visit, so I explained each step first and she came back for the next one.",
    },
  },
} as const satisfies Record<string, { resume: string; says: Says }>;

/** The candidate's panel on the job's Candidates page, opened from their row as an owner opens it. */
export async function openThePanel(page: Page, roleId: string, name: string) {
  await page.goto(`/roles/${roleId}/talent`);
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("dialog", { name });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * "Set a date and time" as a person fills it in, on the panel or the interview's sheet: the day (`daysAhead` from today),
 * the time on the company's clock, and Book. Returns the toast that says what happened to the email.
 */
export async function setADateAndTime(form: Locator, input: { first: string; daysAhead?: number; time?: string; place?: "Video link" | "Address" | "By phone"; address?: string; clash?: boolean }) {
  const day = new Date(Date.now() + (input.daysAhead ?? 3) * 86_400_000).toISOString().slice(0, 10);
  await form.getByLabel("Date", { exact: true }).fill(day);
  await form.getByLabel(/^Time \(/).fill(input.time ?? "10:30");
  if (input.place) await form.getByRole("radio", { name: input.place }).check();
  if (input.address) await form.getByRole("textbox", { name: "Address" }).fill(input.address);
  // the press books it: a new interview (POST /applications/:id/interviews) or this one (POST /interviews/:id/set-time)
  const page = form.page();
  const booked = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/v1\/(applications\/[^/]+\/interviews|interviews\/[^/]+\/set-time)$/.test(new URL(r.url()).pathname), { timeout: 30_000 }).catch(() => null);
  const errors: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === "error") errors.push(m.text()); };
  const onError = (e: Error) => errors.push(e.message);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  const button = form.getByRole("button", { name: new RegExp(`^(Book|Move)( and email ${input.first})?$`) });
  await button.click();
  const answer = await booked;
  page.off("console", onConsole);
  page.off("pageerror", onError);
  if (!answer) {
    // nothing went: say what the form and the page said, so a failure names its cause
    const said = await page.getByRole("status").allTextContents();
    const lines = await form.locator("p").allTextContents();
    throw new Error(`Book sent nothing. Its aria-disabled is ${await button.getAttribute("aria-disabled")}; the form says: ${lines.join(" | ")}; the page says: ${said.join(" | ")}; script errors: ${errors.join(" | ") || "none"}`);
  }
  if (input.clash) expect(answer.status(), "an interviewer already booked then").toBe(409);
  else expect(answer.status(), `Book: ${await answer.text()}`).toBeLessThan(400);
  return day;
}

/** The interview's sheet from the Interviews page: "Did it take place?" Yes, as the person who was there records it. */
export async function recordTookPlace(page: Page, candidateName: string, round?: string | RegExp) {
  await page.goto("/interviews");
  const row = page.getByRole("row").filter({ hasText: candidateName }).filter(round ? { hasText: round } : {}).filter({ hasText: "Scheduled" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("link", { name: "Open", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Did it take place?" })).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Recorded/ })).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole("heading", { name: "After the interview" })).toBeVisible({ timeout: 30_000 });
  return sheet;
}

/** The decision after an interview, on the candidate's panel: Finalist (or another), with what stood out. */
export async function decideInPanel(panel: Locator, decision: "Finalist" | "Next round", note = "Calm, precise, asked good questions.") {
  await expect(panel.getByRole("heading", { name: "How did the interview go?" })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: decision, exact: true }).click();
  // "Next round" is recorded on the press and opens the next round's date and time; Finalist asks what stood out first
  if (decision === "Next round") return;
  await panel.getByLabel(/What stood out/).fill(note);
  await panel.getByRole("button", { name: "Confirm finalist" }).click();
}

/** From the interview's sheet on Interviews to the candidate's panel through "Record the decision" (the sheet re-renders once the outcome is saved, so a press that lands mid-render is tried again). */
export async function openTheDecision(page: Page, sheet: Locator, name: string): Promise<Locator> {
  const decide = sheet.getByRole("link", { name: "Record the decision" });
  await expect(async () => {
    if (!/\/talent\?open=/.test(page.url())) await decide.click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/talent\?open=/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  const panel = page.getByRole("dialog", { name });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}
