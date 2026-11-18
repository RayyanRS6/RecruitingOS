import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/** True when the run targets a deployed address (E2E_BASE_URL) rather than the local shell with stand-in providers. */
export const REMOTE_TARGET = !!process.env.E2E_BASE_URL?.trim();

/**
 * Call at the top of a file or a describe group whose specs sign in through the fake identity page: a deployment has
 * the real identity provider, so those journeys cannot run there and are skipped with the reason on the report.
 */
export function skipWithoutFakeSignIn() {
  test.skip(REMOTE_TARGET, "signs in through the fake identity page, which a deployed address does not have (E2E_BASE_URL is set)");
}

/**
 * page.goto that tries once more when the app's own navigation cancelled it (net::ERR_ABORTED): right after a sign-in
 * the landing page may still send the person on while the dev server compiles the next page (seen on CI).
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
  // Endless animations (loading placeholders, the Open dot) never finish, so they are left out. A list that arrives
  // after a tab click starts its own entrances once its request returns, so wait for the network too, then again.
  const entrances = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await entrances();
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await entrances();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).disableRules(["region"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${n.html.slice(0, 120)}`).join("\n  ")}`).join("\n");
  if (results.violations.length) throw new Error(`accessibility violations on ${name}:\n${summary}`);
}

/** The page itself never scrolls sideways on this viewport. */
export async function noSidewaysScroll(page: Page, name: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${name} scrolls sideways on this viewport`).toBeLessThanOrEqual(innerWidth + 1);
}

/** What the page said: a toast, or a status line or an alert on the page, with these words. */
export const said = (page: Page, words: string | RegExp) => page.getByRole("status").filter({ hasText: words });

/* ------------------------------------------------------------------------------------------------------------------ */
/* Signing in, and a company                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Microsoft sign-in through the fake consent page with the second factor unchecked. For a staff address this ends on
 * the authenticator page under /api/v1/auth/mfa, which is why it does not wait for an app URL.
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
  // The first page may still send the person on (an administrator goes to the admin dashboard): a page.goto made before that settles is aborted.
  await page.waitForLoadState("networkidle");
}

/** The platform administrator the e2e server bootstraps (BOOTSTRAP_ADMIN_EMAILS): signed in with Microsoft and a second factor. */
export const ADMIN = { email: "admin-e2e@identifiedtalent.com", name: "Admin", provider: "azure", aal2: true } as const;

/** The administrator in a browser of their own, so nobody else's session is touched. */
export async function signInAsAdmin(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, ADMIN);
  return { context, page };
}

/** The time zone of every company these specs create (the company form's Pacific time). */
export const COMPANY_ZONE = "America/Los_Angeles";

/** The company form as a new owner fills it in (the fields of apps/web/src/pages/CompanySetup.tsx), up to the button. */
export async function fillTheCompanyForm(page: Page, company: string, owner = "Dana Whitfield") {
  await page.getByLabel("Company name").fill(company);
  await page.getByLabel("Your name").fill(owner);
  await page.getByLabel("What kind of business").selectOption("dental");
  await page.getByLabel("How many employees").selectOption("1-19");
  await page.getByLabel("City").fill("Tustin");
  // State and size start empty, and the time zone starts from the browser's own (empty when it is not a US zone).
  await page.getByLabel("State").fill("CA");
  await page.getByLabel("Time zone").selectOption(COMPANY_ZONE);
  await page.getByLabel("Website (optional)").fill("https://harborsmiles.example");
}

/**
 * A new company, straight from the company form: with open sign-up the workspace opens at once and the owner lands on
 * Home. A server that asks for approval (SIGNUP_MODE=approval) is access-approval.spec.ts's subject, so anything that
 * needs a company this way is skipped there, with the reason on the report.
 */
export async function createCompanyThroughTheForm(page: Page, name: string, owner = "Dana Whitfield") {
  test.skip(process.env.SIGNUP_MODE === "approval", "opens its company straight from the company form, which needs a server with open sign-up");
  await page.waitForURL("**/setup/company");
  await expect(page.getByRole("heading", { name: "Tell us about your company" })).toBeVisible({ timeout: 30_000 });
  // someone who signed in with the wrong account can leave from here
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await fillTheCompanyForm(page, name, owner);
  await page.getByRole("button", { name: "Create my hiring workspace" }).click();
  await page.waitForURL((u) => u.pathname === "/");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Email, read from the development outbox by its words and its links                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One email as the fake adapter recorded it (packages/integrations/src/types.ts, OutboundEmail). */
export type SentEmail = { to: string; from: string; subject: string; text: string; at: string };
type Words = string | RegExp;
const matches = (value: string, w: Words) => (typeof w === "string" ? value.includes(w) : w.test(value));
const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What the fake email adapter sent, newest first. The server keeps the last 50 only, across every spec that ran on it,
 * so read it right after the press that sends, never at the end of a long journey.
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
 * Waits for the email to `to` whose subject matches (a decision email leaves after its Undo window, so allow 90 seconds
 * for one), then checks every one of `says` is in its text. Returns it.
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

/** The email's link that starts with `path` (e.g. "/c/status/"), as a path on this server. */
export function linkIn(email: SentEmail, path: string): string {
  const m = email.text.match(new RegExp(`https?://[^\\s]+(${path.replace(/[/]/g, "\\/")}[^\\s]*)`));
  expect(m, `a link to ${path} in "${email.subject}"`).not.toBeNull();
  return m![1].replace(/[).,]+$/, "");
}

/** Every email to `to` that carries a link under `path` ("/c/status/", "/c/screen/"), newest first. Told apart by the link, never by the subject's words. */
export async function emailsWithLink(request: APIRequestContext, base: string, to: string, path: string): Promise<SentEmail[]> {
  return (await emailsTo(request, base, to)).filter((m) => m.text.includes(path));
}

/** Waits until `count` emails with a link under `path` have reached `to`, and returns the newest with its link as a path on this server. */
export async function waitForLink(request: APIRequestContext, base: string, input: { to: string; path: string; count?: number; timeout?: number }): Promise<{ email: SentEmail; path: string }> {
  let found: SentEmail[] = [];
  await expect.poll(async () => {
    found = await emailsWithLink(request, base, input.to, input.path);
    return found.length;
  }, { timeout: input.timeout ?? 60_000, intervals: [500, 1_000, 2_000], message: `an email to ${input.to} with a link to ${input.path}` }).toBeGreaterThanOrEqual(input.count ?? 1);
  return { email: found[0], path: linkIn(found[0], input.path) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A published job, through the API                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A job in one sentence that names every essential (title, place, work arrangement, type, schedule, pay, must-haves),
 * so the stand-in assistant has little left to ask. Its two must-haves are the ones PERSONAS's resumes are read against.
 */
export const HYGIENIST_JOB = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";

type Card = { id: string; field: string; mode: "single" | "multi" | "free" | "pay"; prompt: string; options: Array<{ label: string; value: string }>; allowOwn: boolean };
type Draft = { id: string; questions: Card[]; flags: Array<{ id: string; kept?: unknown }>; readiness: { mayDraft: boolean; draftBlocker: string | null } };

/** What a card is answered with when it offers nothing to tick, by the fact it asks for. */
const OWN_WORDS: Record<string, string> = {
  title: "Registered Dental Hygienist",
  location: "Tustin, CA",
  remote_policy: "On site",
  employment_type: "Full time",
  schedule: "Monday to Friday, 8 to 5",
  compensation_basis: "By the hour",
  must_haves: "Active CA RDH license",
  benefits: "Health and dental cover, paid time off.",
};

/**
 * One card answered as the owner of HYGIENIST_JOB would: the pay as stated, the two must-haves in the sentence's own
 * words (never one the assistant suggests, so the resumes are read against those two), on site, else the first answer
 * offered or a few plain words. Deal-breakers are left alone.
 */
function cardAnswer(card: Card): Record<string, unknown> {
  const skipped = { questionId: card.id, selected: [], own: [], skipped: true };
  if (card.mode === "pay") return { questionId: card.id, selected: [], own: [], skipped: false, pay: { basis: "hourly", min: 45, max: 55 } };
  if (card.field === "deal_breakers") return skipped;
  if (card.field === "must_haves" && card.allowOwn) return { questionId: card.id, selected: [], own: ["active CA RDH license", "periodontal charting"], skipped: false };
  const offered = card.options.find((o) => /on.?site/i.test(o.label)) ?? card.options[0];
  if (offered && card.mode !== "free") return { questionId: card.id, selected: [offered.value], own: [], skipped: false };
  const words = OWN_WORDS[card.field];
  return words ? { questionId: card.id, selected: [], own: [words], skipped: false } : skipped;
}

/**
 * A published job through the API with the owner's own session, for a spec whose subject is not the job builder: the
 * draft started from `words`, the assistant's cards answered until the job may be written, written, any flagged wording
 * kept with a reason, and published. Returns its id, the company's address word and the job's public address.
 */
export async function publishedJobThroughTheApi(request: APIRequestContext, base: string, words = HYGIENIST_JOB): Promise<{ roleId: string; slug: string; jobUrl: string; title: string }> {
  const sessions = `${base}/api/v1/intake/sessions`;
  const started = await request.post(sessions, { data: { initialMessage: words } });
  expect(started.ok(), await started.text()).toBeTruthy();
  let draft = ((await started.json()) as { session: Draft }).session;
  for (let round = 0; round < 8 && !draft.readiness.mayDraft; round++) {
    // with no card open, the owner says the rest in words
    const turn = draft.questions.length
      ? await request.post(`${sessions}/${draft.id}/answers`, { data: { answers: draft.questions.map(cardAnswer) } })
      : await request.post(`${sessions}/${draft.id}/messages`, { data: { message: "It is on site in Tustin, CA, full time, Monday to Friday, 8 to 5. The pay is $45 to $55 an hour. Must-have: active CA RDH license." } });
    expect(turn.ok(), await turn.text()).toBeTruthy();
    draft = ((await turn.json()) as { session: Draft }).session;
  }
  expect(draft.readiness.mayDraft, `the job can be written (${draft.readiness.draftBlocker ?? "nothing is missing"})`).toBe(true);
  const written = await request.post(`${sessions}/${draft.id}/draft`);
  expect(written.ok(), await written.text()).toBeTruthy();
  draft = ((await written.json()) as { session: Draft }).session;
  for (const flag of draft.flags.filter((f) => !f.kept)) {
    const kept = await request.post(`${sessions}/${draft.id}/flags/keep`, { data: { flagId: flag.id, reason: "The job needs it as written." } });
    expect(kept.ok(), await kept.text()).toBeTruthy();
  }
  const published = await request.post(`${sessions}/${draft.id}/publish`);
  expect(published.status(), await published.text()).toBe(201);
  const { roleId } = (await published.json()) as { roleId: string };
  const { slug } = (await (await request.get(`${base}/api/v1/companies/current`)).json()) as { slug: string };
  const { title } = (await (await request.get(`${base}/api/v1/roles/${roleId}`)).json()) as { title: string };
  const jobUrl = `${base}/careers/${slug}/jobs/${roleId}`;
  await expect.poll(async () => (await request.get(jobUrl)).status(), { timeout: 30_000, message: "the job's public page" }).toBe(200);
  return { roleId, slug, jobUrl, title };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The candidate's pages. They are the API's own (apps/api/src/pages), so every word they are found by is kept in this  */
/* part: "Apply now" on the job page; on the form "First name", "Last name", "Email", the one file field, each question */
/* as a group named by its words (or a field labelled by them), the acknowledgment "I have read the full notice above"  */
/* and "Send my application"; the receipt "Thanks, we have your application"; and in the AI interview "Start", the box  */
/* "Your reply" with "Send", the taps "Yes" and "No", "Send my answers" and "Thanks, your answers are sent".            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Someone applying: their resume's first line is their name, then how to reach them, as a real resume starts. */
export type Applicant = { first: string; last: string; email: string; resume: string };

export function resumeOf(who: Applicant): string {
  return `${who.first} ${who.last}\n${who.email}\n(714) 555-01${String(who.first.length).padStart(2, "0")}\nTustin, CA\n${who.resume}\n`;
}

/** What someone says in the AI interview: `licence` answers a yes-or-no tap about the license, `licenceWords` a question about it in words; `story` a question about a time something happened, `work` everything else. */
export type Says = { licence: "Yes" | "No"; licenceWords: string; work: string; story: string };

/**
 * Three hygienists the stand-in reads three ways against HYGIENIST_JOB's must-haves (an active CA RDH license and
 * periodontal charting): everything shown, the license with the rest only partly shown, and no license in their own
 * words.
 */
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

/** The application form on the page: the one with "Send my application". */
export const applicationForm = (cand: Page) => cand.locator("form").filter({ has: cand.getByRole("button", { name: "Send my application" }) });

/** One screening question answered by its own words: a tap on the answer where the question is a group of choices, else the field's value. */
async function answerAQuestion(form: Locator, question: string, answer: string) {
  const group = form.getByRole("group", { name: question });
  if (await group.count()) return group.first().getByText(answer, { exact: true }).first().click();
  const field = form.getByLabel(question);
  if ((await field.evaluate((el) => el.tagName)) === "SELECT") await field.selectOption({ label: answer });
  else await field.fill(answer);
}

/**
 * The application form as a candidate fills it in, up to the Send button: who they are, the resume file, the job's
 * screening questions (`answers`, by each question's own words; any question not named there gets Yes, its first
 * choice, or 5), and the notice ticked. Nothing here is sent.
 */
export async function fillTheApplication(cand: Page, who: Applicant, answers: Record<string, string> = {}) {
  const form = applicationForm(cand);
  await form.getByLabel("First name").fill(who.first);
  await form.getByLabel("Last name").fill(who.last);
  await form.getByLabel("Email", { exact: true }).fill(who.email);
  await form.locator('input[type="file"]').setInputFiles({ name: `${who.first.toLowerCase()}-${who.last.toLowerCase()}.txt`, mimeType: "text/plain", buffer: Buffer.from(resumeOf(who)) });
  for (const [question, answer] of Object.entries(answers)) await answerAQuestion(form, question, answer);
  for (const group of await form.locator("fieldset").filter({ has: cand.locator('input[type="radio"]') }).all()) {
    if (await group.locator("input:checked").count()) continue;
    const yes = group.locator('input[type="radio"][value="yes"]');
    if (await yes.count()) await yes.first().check();
    else await group.locator('input[type="radio"]').first().check();
  }
  for (const number of await form.locator('input[type="number"]').all()) if (!(await number.inputValue())) await number.fill("5");
  for (const select of await form.locator("select").all()) if (!(await select.inputValue())) await select.selectOption({ index: 1 });
  await form.getByRole("checkbox", { name: /I have read the full notice above/ }).check();
}

/** Where a candidate lands after Send: the receipt's address. */
const RECEIPT_ADDRESS = /\/careers\/[^/]+\/jobs\/[0-9a-f-]+\/applied$/;

/** The receipt a candidate lands on after Send, by its words. */
export async function expectTheReceipt(cand: Page) {
  await cand.waitForURL(RECEIPT_ADDRESS, { timeout: 60_000 });
  await expect(cand.getByRole("heading", { level: 1 })).toContainText("Thanks, we have your application");
}

/**
 * Applying through the job's own pages, in a browser of their own as candidates are: the job page at `jobUrl` (an
 * Apply link from a post carries `?src=`), Apply now, the form, Send, and the receipt's address. The browser says it
 * is an ordinary desktop Chrome, as a person's does.
 */
export async function applyThroughTheForm(browser: Browser, base: string, jobUrl: string, who: Applicant, answers: Record<string, string> = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: base, userAgent: devices["Desktop Chrome"].userAgent });
  const cand = await context.newPage();
  await cand.goto(jobUrl);
  await expect(cand.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await cand.getByRole("link", { name: "Apply now" }).last().click();
  await cand.waitForURL(/\/careers\/[^/]+\/jobs\/[0-9a-f-]+\/apply(\?|$)/, { timeout: 30_000 });
  await fillTheApplication(cand, who, answers);
  await applicationForm(cand).getByRole("button", { name: "Send my application" }).click();
  await cand.waitForURL(RECEIPT_ADDRESS, { timeout: 60_000 });
  return { context, page: cand };
}

/** The candidate's own status page path, from the one email they get after applying. The link travels only by email. */
export async function statusPathFromEmail(request: APIRequestContext, base: string, email: string): Promise<string> {
  return (await waitForLink(request, base, { to: email, path: "/c/status/" })).path;
}

/**
 * The AI interview on the candidate's own pages, from its first page to "Thanks, your answers are sent": Start, then
 * each question as it comes (a tap where the page offers Yes and No, their own words otherwise; the stand-in asks the
 * next), then their answers to check, and Send my answers. Nothing reaches the company before that press. `from`: a
 * caller that pressed Start itself (to look at the chat first) carries on from the chat.
 */
export async function doTheAiInterview(cand: Page, says: Says, from: "the first page" | "the chat" = "the first page") {
  if (from === "the first page") await cand.getByRole("button", { name: "Start", exact: true }).click();
  const sendAll = cand.getByRole("button", { name: "Send my answers" });
  const reply = cand.getByLabel(/^Your reply/);
  const tap = cand.getByRole("button", { name: "Yes", exact: true });
  // a pay question takes two figures; days and a start date have boxes of their own, with the person's own words one click away
  const payFrom = cand.getByLabel("From", { exact: true });
  const ownWords = cand.getByText("Answer in your own words instead", { exact: true });
  const onward = cand.getByRole("button", { name: /^(Review and send|Check your answers)$/ }).or(cand.getByRole("link", { name: /^(Review and send|Check your answers)$/ })).first();
  const messages = cand.locator("li.msg.assistant");
  for (let turn = 0; turn < 40; turn++) {
    // whichever comes next: a question to answer, the way on to their answers, or the answers with Send
    await expect.poll(async () => (await sendAll.isVisible()) || (await reply.isVisible()) || (await tap.isVisible()) || (await ownWords.isVisible()) || (await onward.isVisible()), { timeout: 60_000, message: "the AI interview's next step" }).toBe(true);
    if (await sendAll.isVisible()) break;
    if (await onward.isVisible()) {
      await onward.click();
    } else {
      // the question being asked is the assistant's newest message
      const asked = (await messages.count()) ? ((await messages.last().textContent()) ?? "").trim() : "";
      const aboutLicence = /licen[cs]e/i.test(asked);
      if (await tap.isVisible()) await cand.getByRole("button", { name: aboutLicence ? says.licence : "Yes", exact: true }).click();
      else if (await payFrom.isVisible()) {
        // the pay they are looking for, inside the range the job posts
        await payFrom.fill("48");
        await cand.getByLabel("To (optional)", { exact: true }).fill("52");
        await payFrom.locator("xpath=ancestor::form").getByRole("button", { name: "Send", exact: true }).click();
      } else {
        // days to tick or a date to pick: this candidate answers in their own words instead
        if (!(await reply.isVisible())) await ownWords.click();
        await reply.fill(aboutLicence ? says.licenceWords : /nervous|patient|difficult|time when|a time/i.test(asked) ? says.story : says.work);
        await reply.locator("xpath=ancestor::form").getByRole("button", { name: "Send", exact: true }).click();
      }
    }
    await cand.waitForLoadState("load");
  }
  await expect(sendAll).toBeVisible();
  await sendAll.click();
  await expect(cand.getByRole("heading", { level: 1, name: "Thanks, your answers are sent" })).toBeVisible({ timeout: 60_000 });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A job's Candidates list, as the team reads it                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The tabs over a job's candidates, each named with its count ("New 2"). */
export const candidateTabs = (page: Page) => page.getByRole("tablist", { name: "Candidates by stage" });

/** One person's row on the list (candidate-row is the page's own hook for tests). */
export const candidateRow = (page: Page, name: string) => page.locator(".candidate-row").filter({ has: page.getByRole("button", { name, exact: true }) });

/** The names on the list, top to bottom: the order the server ranks them in. */
export async function namesInOrder(page: Page): Promise<string[]> {
  return (await page.locator(".candidate-row .candidate-name").allTextContents()).map((n) => n.trim());
}

/** The number on a score badge inside `where` ("Resume match 91 out of 100", "AI interview 80 out of 100"); it waits until the score is worked out. */
export async function scoreOn(where: Locator, label: "Resume match" | "AI interview", timeout = 180_000): Promise<number> {
  const badge = where.getByText(new RegExp(`^${label} \\d+ out of 100$`)).first();
  await expect(badge, `${label}: a number`).toBeAttached({ timeout });
  return Number(((await badge.textContent()) ?? "").match(/(\d+) out of 100/)?.[1]);
}

/** The candidate's panel, opened from their row as someone on the team opens it. */
export async function openThePanel(page: Page, name: string): Promise<Locator> {
  await candidateRow(page, name).getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("dialog", { name });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}
